import {
  test,
  expect,
  chromium,
  type Browser,
  type Page,
} from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createSpeedGateServer } from '../../server/http-server';

let bridge: ReturnType<typeof createSpeedGateServer>,
  url: string,
  scratch: string;
test.beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'speedgate-http-tests-'));
  bridge = createSpeedGateServer({ staticDir: 'dist' });
  await new Promise<void>((done) => bridge.server.listen(0, '127.0.0.1', done));
  url = `http://127.0.0.1:${(bridge.server.address() as AddressInfo).port}`;
});
test.afterAll(async () => {
  await bridge?.close();
  await rm(scratch, { recursive: true, force: true });
});

async function connect(receiver: Page, sender: Page) {
  await receiver.goto(url);
  await sender.goto(url);
  await expect(receiver.getByLabel('Transfer transport')).toHaveValue('http');
  await expect(sender.getByLabel('Transfer transport')).toHaveValue('http');
  await receiver
    .getByRole('button', { name: 'Receive files', exact: true })
    .click();
  await receiver
    .getByRole('button', { name: 'Create a connection', exact: true })
    .click();
  const digits = receiver.getByLabel('Pairing code', { exact: true });
  await expect(digits).toBeVisible();
  const code = (await digits.innerText()).replace(/\s/g, '');
  await sender.getByLabel('Receiver’s six-digit code').fill(code);
  await sender.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(
    receiver.getByRole('button', { name: 'Approve sender', exact: true }),
  ).toBeEnabled();
  await expect(sender.getByText('Connected', { exact: true })).toHaveCount(0);
  await receiver
    .getByRole('button', { name: 'Approve sender', exact: true })
    .click();
  await expect(sender.getByText('Connected', { exact: true })).toBeVisible();
  await expect(receiver.getByText('Connected', { exact: true })).toBeVisible();
}
async function records(page: Page) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('pixelbridge-v1', 3);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    try {
      return await new Promise<
        {
          id: string;
          originalName: string;
          size: number;
          bytes: number;
          sha256: string;
          phase: string;
          modified: number;
        }[]
      >((resolve) => {
        const req = db.transaction('files').objectStore('files').getAll();
        req.onsuccess = () => resolve(req.result);
      });
    } finally {
      db.close();
    }
  });
}
async function storedHash(page: Page, id: string) {
  return page.evaluate(async (id) => {
    let file: Blob | undefined;
    try {
      const root = await (
        await navigator.storage.getDirectory()
      ).getDirectoryHandle('pixelbridge');
      file = await (await root.getFileHandle(id)).getFile();
    } catch {
      /* Compatibility backend. */
    }
    if (!file) {
      const db = await new Promise<IDBDatabase>((resolve) => {
        const req = indexedDB.open('pixelgate-staging-v1', 1);
        req.onsuccess = () => resolve(req.result);
      });
      const chunks = await new Promise<{ bytes: Blob | ArrayBuffer }[]>(
        (resolve) => {
          const req = db
            .transaction('chunks')
            .objectStore('chunks')
            .getAll(IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER]));
          req.onsuccess = () => resolve(req.result);
        },
      );
      db.close();
      file = new Blob(chunks.map((chunk) => chunk.bytes));
    }
    return {
      size: file.size,
      hash: Array.from(
        new Uint8Array(
          await crypto.subtle.digest('SHA-256', await file.arrayBuffer()),
        ),
        (byte) => byte.toString(16).padStart(2, '0'),
      ).join(''),
    };
  }, id);
}
async function pages(browser: Browser, browserName: string, indexed = false) {
  const receivingBrowser =
    browserName === 'chromium' ? browser : await chromium.launch();
  const receiving = await receivingBrowser.newContext();
  const sending = await browser.newContext();
  // HTTP must work without ICE, SCTP, PeerJS signaling, or a WebRTC implementation.
  for (const context of [receiving, sending])
    await context.addInitScript(() => {
      Object.defineProperty(window, 'RTCPeerConnection', { value: undefined });
    });
  if (indexed)
    await receiving.addInitScript(() => {
      if (!navigator.storage) return;
      Object.defineProperty(
        Object.getPrototypeOf(navigator.storage),
        'getDirectory',
        { value: undefined },
      );
    });
  const receiver = await receiving.newPage(),
    sender = await sending.newPage();
  const errors: string[] = [];
  for (const page of [receiver, sender])
    page.on('pageerror', (error) => errors.push(error.message));
  return {
    receiver,
    sender,
    errors,
    close: async () => {
      await receiving.close();
      await sending.close();
      if (receivingBrowser !== browser) await receivingBrowser.close();
    },
  };
}

for (const indexed of [false, true])
  test(`HTTP originals, metadata, empty files, duplicates and stored readback (${indexed ? 'IndexedDB' : 'OPFS'})`, async ({
    browser,
    browserName,
  }) => {
    const pair = await pages(browser, browserName, indexed);
    try {
      await connect(pair.receiver, pair.sender);
      const data = Buffer.alloc(32 * 1024 * 1024 + 111);
      for (let offset = 0; offset < data.length; offset++)
        data[offset] = offset % 251;
      const path = join(scratch, 'original-é.bin');
      await writeFile(path, data);
      const small = {
        name: 'photo-原本.jpg',
        mimeType: 'image/jpeg',
        buffer: Buffer.from([0xff, 0xd8, 0, 1, 2, 0xff, 0xd9]),
      };
      const empty = {
        name: 'empty.txt',
        mimeType: 'text/plain',
        buffer: Buffer.alloc(0),
      };
      await pair.sender
        .getByLabel('Choose files', { exact: true })
        .setInputFiles(path);
      await pair.sender
        .getByLabel('Choose files', { exact: true })
        .setInputFiles([small, empty]);
      await pair.sender
        .getByRole('button', { name: 'Send files', exact: true })
        .last()
        .click();
      await expect(pair.sender.locator('.file-status')).toHaveText(
        [
          'Browser copy verified',
          'Browser copy verified',
          'Browser copy verified',
        ],
        { timeout: 90_000 },
      );
      const saved = await records(pair.receiver);
      expect(saved).toHaveLength(3);
      const originals = new Map([
        ['original-é.bin', data],
        [small.name, small.buffer],
        [empty.name, empty.buffer],
      ]);
      for (const record of saved) {
        expect(record.modified).toBeGreaterThan(0);
        const source = originals.get(record.originalName)!;
        const stored = await storedHash(pair.receiver, record.id);
        expect(stored).toEqual({
          size: source.length,
          hash: createHash('sha256').update(source).digest('hex'),
        });
      }
      // Reconnect with the same receiver storage. A retained duplicate must pass
      // receiver readback before the sender may skip its payload.
      await connect(pair.receiver, pair.sender);
      let binaryBytes = 0;
      pair.sender.on('request', (request) => {
        if (request.headers()['x-speedgate-kind'] === '1')
          binaryBytes += request.postDataBuffer()?.length ?? 0;
      });
      await pair.sender
        .getByLabel('Choose files', { exact: true })
        .setInputFiles(path);
      await pair.sender
        .getByRole('button', { name: 'Send files', exact: true })
        .last()
        .click();
      await expect(pair.sender.locator('.file-status').first()).toHaveText(
        /Already|Duplicate|verified/i,
        { timeout: 60_000 },
      );
      expect(binaryBytes).toBe(0);
      expect(pair.errors).toEqual([]);
    } finally {
      await pair.close();
    }
  });

test('HTTP interrupted upload resumes from durable receiver bytes after refresh', async ({
  browser,
  browserName,
}) => {
  const pair = await pages(browser, browserName);
  const data = Buffer.alloc(48 * 1024 * 1024 + 23, 0x7b);
  const path = join(scratch, 'resume-original.bin');
  await writeFile(path, data);
  try {
    await connect(pair.receiver, pair.sender);
    await pair.sender.route('**/message?**', async (route) => {
      if (route.request().headers()['x-speedgate-kind'] === '1')
        await new Promise((done) => setTimeout(done, 40));
      await route.continue().catch(() => {});
    });
    await pair.sender
      .getByLabel('Choose files', { exact: true })
      .setInputFiles(path);
    await pair.sender
      .getByRole('button', { name: 'Send files', exact: true })
      .last()
      .click();
    await expect
      .poll(async () => (await records(pair.receiver))[0]?.bytes ?? 0)
      .toBeGreaterThanOrEqual(2 * 1024 * 1024);
    await pair.receiver.reload();
    await expect(pair.sender.getByRole('alert')).toContainText(
      /interrupted|Reconnect|lost/i,
      { timeout: 15_000 },
    );
    const checkpoint = (await records(pair.receiver))[0].bytes;
    expect(checkpoint).toBeGreaterThan(0);
    expect(checkpoint).toBeLessThan(data.length);
    await pair.sender.unroute('**/message?**');
    await connect(pair.receiver, pair.sender);
    let resumedAt: number | undefined;
    pair.receiver.on('request', (request) => {
      if (request.headers()['x-speedgate-kind'] === '0') {
        const message = request.postDataJSON();
        if (message?.type === 'ready') resumedAt = message.offset;
      }
    });
    await pair.sender
      .getByLabel('Choose files', { exact: true })
      .setInputFiles(path);
    await pair.sender
      .getByRole('button', { name: 'Send files', exact: true })
      .last()
      .click();
    await expect(pair.sender.locator('.file-status').first()).toHaveText(
      'Browser copy verified',
      { timeout: 90_000 },
    );
    expect(resumedAt).toBe(checkpoint);
    expect(
      await storedHash(pair.receiver, (await records(pair.receiver))[0].id),
    ).toEqual({
      size: data.length,
      hash: createHash('sha256').update(data).digest('hex'),
    });
    expect(pair.errors).toEqual([]);
  } finally {
    await pair.close();
  }
});

test('HTTP corrupted bytes fail SHA-256 verification', async ({
  browser,
  browserName,
}) => {
  const pair = await pages(browser, browserName);
  try {
    await connect(pair.receiver, pair.sender);
    let corrupted = false;
    await pair.sender.route('**/message?**', async (route) => {
      if (!corrupted && route.request().headers()['x-speedgate-kind'] === '1') {
        const data = route.request().postDataBuffer()!;
        data[0] ^= 0xff;
        corrupted = true;
        await route.continue({ postData: data });
      } else await route.continue();
    });
    await pair.sender
      .getByLabel('Choose files', { exact: true })
      .setInputFiles({
        name: 'corrupt.bin',
        mimeType: 'application/octet-stream',
        buffer: Buffer.alloc(2 * 1024 * 1024 + 23, 0x7b),
      });
    await pair.sender
      .getByRole('button', { name: 'Send files', exact: true })
      .last()
      .click();
    await expect(pair.sender.locator('.file-status').first()).toHaveText(
      'Needs retry',
    );
    expect(corrupted).toBe(true);
    expect(
      (await records(pair.receiver)).some(
        (record) => record.phase === 'verified',
      ),
    ).toBe(false);
    expect(pair.errors).toEqual([]);
  } finally {
    await pair.close();
  }
});

test('HTTP peer checks, pause/resume, cancellation, source status and byte-exact download', async ({
  browser,
  browserName,
}) => {
  const pair = await pages(browser, browserName);
  try {
    await connect(pair.receiver, pair.sender);
    for (const page of [pair.sender, pair.receiver])
      await page.getByText('Connection diagnostics', { exact: true }).click();
    await pair.sender.getByLabel('Payload connection limit').selectOption('4');
    await pair.receiver
      .getByRole('button', { name: 'Test peer link', exact: true })
      .click();
    await expect(pair.receiver.getByTestId('peer-speed-result')).toContainText(
      '1 HTTP stream',
      { timeout: 25_000 },
    );
    await expect(pair.sender.getByTestId('peer-speed-result')).toBeVisible();
    expect(await records(pair.receiver)).toHaveLength(0);
    const report = async (page: Page) =>
      JSON.parse(
        (await page
          .getByLabel('Connection report', { exact: true })
          .textContent())!,
      );
    expect((await report(pair.receiver)).transfer.deliveredBytes).toBe(0);
    expect((await report(pair.sender)).transfer.uploadedBytes).toBe(0);
    // Cancel a second diagnostic run with bytes in flight. Its tail must never
    // enter the original-file protocol or tear down a subsequent transfer.
    await pair.sender.route('**/message?**', async (route) => {
      if (route.request().headers()['x-speedgate-kind'] === '2')
        await new Promise((done) => setTimeout(done, 25));
      await route.continue().catch(() => {});
    });
    await pair.sender
      .getByRole('button', { name: 'Test peer link', exact: true })
      .click();
    await pair.sender
      .getByRole('button', { name: 'Stop speed test', exact: true })
      .click();
    await expect(
      pair.sender.getByRole('button', { name: 'Test peer link', exact: true }),
    ).toBeEnabled();
    await pair.sender.unrouteAll({ behavior: 'wait' });
    await pair.sender.getByLabel('Payload connection limit').selectOption('1');
    await pair.sender.route('**/message?**', async (route) => {
      if (route.request().headers()['x-speedgate-kind'] === '1')
        await new Promise((done) => setTimeout(done, 100));
      await route.continue().catch(() => {});
    });
    const payload = Buffer.alloc(32 * 1048576 + 23, 0x35);
    await pair.sender
      .getByLabel('Choose files', { exact: true })
      .setInputFiles({
        name: 'controls.bin',
        mimeType: 'application/octet-stream',
        buffer: payload,
      });
    await pair.sender
      .getByRole('button', { name: 'Send files', exact: true })
      .last()
      .click();
    await expect(
      pair.receiver.getByRole('button', { name: 'Pause', exact: true }),
    ).toBeEnabled();
    await pair.receiver
      .getByRole('button', { name: 'Pause', exact: true })
      .click();
    await expect(
      pair.sender.getByRole('button', { name: 'Resume', exact: true }),
    ).toBeVisible();
    await expect
      .poll(async () => (await report(pair.receiver)).transfer.source?.paused, {
        timeout: 10_000,
      })
      .toBe(true);
    await pair.receiver
      .getByRole('button', { name: 'Resume', exact: true })
      .click();
    await expect(
      pair.sender.getByRole('button', { name: 'Pause', exact: true }),
    ).toBeVisible();
    await pair.sender
      .getByRole('button', { name: 'Cancel current file', exact: true })
      .click();
    await expect(pair.sender.locator('.file-status').first()).toHaveText(
      'Cancelled',
    );
    await expect
      .poll(async () => (await records(pair.receiver))[0]?.phase)
      .toBe('cancelled');
    await pair.sender.unrouteAll({ behavior: 'wait' });
    // A fresh file through the same connection must remain usable after cancel.
    const original = Buffer.from('untouched original\0é\nend');
    await pair.sender
      .getByLabel('Choose files', { exact: true })
      .setInputFiles({
        name: 'after-cancel.txt',
        mimeType: 'text/plain',
        buffer: original,
      });
    await pair.sender
      .getByRole('button', { name: 'Send files', exact: true })
      .last()
      .click();
    await expect(pair.sender.locator('.file-status').last()).toHaveText(
      'Browser copy verified',
    );
    const downloading = pair.receiver.waitForEvent('download');
    await pair.receiver
      .getByRole('button', { name: 'Save after-cancel.txt', exact: true })
      .click();
    const download = await downloading;
    const { readFile } = await import('node:fs/promises');
    expect((await readFile((await download.path())!)).equals(original)).toBe(
      true,
    );
    const saved = (await records(pair.receiver)).find(
      (record) => record.originalName === 'after-cancel.txt',
    )!;
    expect(saved.sha256).toBe(
      createHash('sha256').update(original).digest('hex'),
    );
    expect(pair.errors).toEqual([]);
  } finally {
    await pair.close();
  }
});

test('HTTP large original streams through regular-profile storage and downloads byte-exactly', async ({
  browser,
  browserName,
}, testInfo) => {
  test.skip(
    browserName !== 'chromium',
    'One regular Chromium receiving profile; sender compatibility is covered separately.',
  );
  const mib = Number(process.env.SPEEDGATE_HTTP_LARGE_MIB || 400);
  expect(Number.isInteger(mib) && mib >= 64 && mib <= 8192).toBe(true);
  test.setTimeout(Math.max(120_000, mib * 150));
  const { open, stat, utimes } = await import('node:fs/promises');
  const name = `http-original-${mib}MiB.bin`,
    path = join(scratch, name);
  const original = await open(path, 'w');
  const hash = createHash('sha256');
  const block = Buffer.alloc(1048576, 0x7b);
  try {
    for (let index = 0; index < mib; index++) {
      block.writeUInt32BE(index, 0);
      block.writeUInt32BE(mib - index, block.length - 4);
      await original.write(block);
      hash.update(block);
    }
    const tail = Buffer.from('untouched-original-tail');
    await original.write(tail);
    hash.update(tail);
  } finally {
    await original.close();
  }
  const expected = hash.digest('hex');
  const modified = 1600000000;
  await utimes(path, modified, modified);
  const receiving = await chromium.launchPersistentContext(
    testInfo.outputPath('http-receiving-profile'),
    { headless: true },
  );
  const sending = await browser.newContext();
  for (const context of [receiving, sending])
    await context.addInitScript(() => {
      Object.defineProperty(window, 'RTCPeerConnection', { value: undefined });
    });
  const receiver = await receiving.newPage(),
    sender = await sending.newPage();
  try {
    await connect(receiver, sender);
    await sender
      .getByLabel('Choose files', { exact: true })
      .setInputFiles(path);
    await sender
      .getByRole('button', { name: 'Send files', exact: true })
      .last()
      .click();
    await expect(sender.locator('.file-status').first()).toHaveText(
      'Browser copy verified',
      { timeout: Math.max(90_000, mib * 100) },
    );
    const record = (await records(receiver))[0];
    expect(record.size).toBe((await stat(path)).size);
    expect(record.modified).toBe(modified * 1000);
    expect(record.sha256).toBe(expected);
    const downloading = receiver.waitForEvent('download');
    await receiver
      .getByRole('button', { name: `Save ${name}`, exact: true })
      .click();
    const download = await downloading,
      savedPath = (await download.path())!;
    expect(download.suggestedFilename()).toBe(name);
    expect((await stat(savedPath)).size).toBe(record.size);
    const source = await open(path, 'r'),
      saved = await open(savedPath, 'r');
    const a = Buffer.alloc(1048576),
      b = Buffer.alloc(1048576);
    try {
      for (let position = 0; position < record.size; position += a.length) {
        const length = Math.min(a.length, record.size - position);
        const [left, right] = await Promise.all([
          source.read(a, 0, length, position),
          saved.read(b, 0, length, position),
        ]);
        expect(left.bytesRead).toBe(length);
        expect(right.bytesRead).toBe(length);
        expect(a.subarray(0, length).equals(b.subarray(0, length))).toBe(true);
      }
    } finally {
      await source.close();
      await saved.close();
    }
  } finally {
    await receiving.close();
    await sending.close();
    await rm(testInfo.outputPath('http-receiving-profile'), {
      recursive: true,
      force: true,
    });
  }
});

test('WebRTC copy/paste link keeps browser-only mode when opened on a running HTTP helper', async ({
  browser,
  browserName,
}) => {
  test.skip(
    browserName !== 'chromium',
    'One real dual-mode interoperability check.',
  );
  const receiving = await browser.newContext(),
    sending = await browser.newContext();
  for (const context of [receiving, sending])
    await context.addInitScript(() => {
      const Native = window.RTCPeerConnection;
      window.RTCPeerConnection = new Proxy(Native, {
        construct(target, args, newTarget) {
          return Reflect.construct(
            target,
            [{ ...args[0], iceServers: [] }, ...args.slice(1)],
            newTarget,
          );
        },
      });
    });
  const receiver = await receiving.newPage(),
    sender = await sending.newPage();
  try {
    await receiver.goto(url);
    await expect(receiver.getByLabel('Transfer transport')).toHaveValue('http');
    await receiver.getByLabel('Transfer transport').selectOption('webrtc');
    await receiver
      .getByRole('button', { name: 'Receive files', exact: true })
      .click();
    await receiver
      .getByRole('button', { name: 'Use copy/paste pairing', exact: true })
      .click();
    await receiver
      .getByRole('button', { name: 'Create a connection', exact: true })
      .click();
    const link = receiver.getByLabel('Receiver link', { exact: true });
    await expect(link).toBeVisible();
    const address = await link.inputValue();
    expect(new URL(address).searchParams.get('transport')).toBe('webrtc');
    await sender.goto(address);
    await expect(sender.getByLabel('Transfer transport')).toHaveValue('webrtc');
    await sender
      .getByRole('button', { name: 'Prepare sender response', exact: true })
      .click();
    const response = sender.getByLabel('Sender response', { exact: true });
    await expect(response).toBeVisible();
    await receiver
      .getByLabel('2. Paste the sender response', { exact: true })
      .fill(await response.inputValue());
    await receiver
      .getByRole('button', { name: 'Approve sender', exact: true })
      .click();
    await expect(sender.getByText('Connected', { exact: true })).toBeVisible();
    let helperPayloadRequests = 0;
    sender.on('request', (request) => {
      if (request.url().includes('/message?')) helperPayloadRequests++;
    });
    await sender.getByLabel('Choose files', { exact: true }).setInputFiles({
      name: 'browser-only.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('browser-only original'),
    });
    await sender
      .getByRole('button', { name: 'Send files', exact: true })
      .last()
      .click();
    await expect(sender.locator('.file-status').first()).toHaveText(
      'Browser copy verified',
    );
    expect(helperPayloadRequests).toBe(0);
  } finally {
    await receiving.close();
    await sending.close();
  }
});

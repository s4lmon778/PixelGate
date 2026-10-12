import { test, expect, chromium } from '@playwright/test';
import { createHash } from 'node:crypto';

test('Pixel report distinguishes a held source read and sender pause, then verifies the original', async ({
  browser,
  browserName,
}) => {
  const receiverBrowser =
    browserName === 'webkit'
      ? await chromium.launch({
          args: ['--disable-features=WebRtcHideLocalIpsWithMdns'],
        })
      : browser;
  const receiving = await receiverBrowser.newContext();
  const sending = await browser.newContext();
  try {
    const receiver = await receiving.newPage();
    const sender = await sending.newPage();
    const errors: string[] = [];
    for (const page of [receiver, sender])
      page.on('pageerror', (error) => errors.push(error.message));
    await receiver.goto('./');
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
    await expect(link).toBeVisible({ timeout: 20000 });
    await sender.goto(await link.inputValue());
    await sender
      .getByRole('button', { name: 'Prepare sender response', exact: true })
      .click();
    const response = sender.getByLabel('Sender response', { exact: true });
    await expect(response).toBeVisible({ timeout: 20000 });
    await receiver
      .getByLabel('2. Paste the sender response', { exact: true })
      .fill(await response.inputValue());
    await receiver
      .getByRole('button', { name: 'Approve sender', exact: true })
      .click();
    await expect(sender.getByText('Connected', { exact: true })).toBeVisible({
      timeout: 45000,
    });
    const payload = Buffer.alloc(3 * 1024 * 1024 + 111, 39);
    for (let offset = 0; offset + 4 < payload.length; offset += 16384)
      payload.writeUInt32BE(offset / 16384, offset);
    const hash = createHash('sha256').update(payload).digest('hex');
    await sender.getByLabel('Choose files', { exact: true }).setInputFiles({
      name: 'held-source.bin',
      mimeType: 'application/octet-stream',
      buffer: payload,
    });
    await sender.evaluate(() => {
      const original = Blob.prototype.arrayBuffer;
      let reads = 0;
      Blob.prototype.arrayBuffer = async function () {
        if (this.size === 1024 * 1024 && ++reads === 2)
          await new Promise<void>((resolve) =>
            Object.assign(window, { releaseSource: resolve }),
          );
        return original.call(this);
      };
    });
    await sender
      .getByRole('button', { name: 'Send files', exact: true })
      .last()
      .click();
    const readReport = async () =>
      JSON.parse(
        (await receiver
          .getByLabel('Connection report', { exact: true })
          .textContent()) || '{}',
      );
    await expect
      .poll(async () => (await readReport()).transfer?.source?.stage, {
        timeout: 15000,
      })
      .toBe('reading-source');
    const held = await readReport();
    expect(held.receiving.stage).toBe('waiting-for-bytes');
    expect(held.transfer.source).toMatchObject({
      paused: false,
      visibility: 'visible',
    });
    expect(held.transfer.source.sampleAgeMs).toBeLessThan(6000);
    expect(JSON.stringify(held.transfer.source)).not.toContain(
      'held-source.bin',
    );
    await sender.getByRole('button', { name: 'Pause', exact: true }).click();
    await expect
      .poll(async () => (await readReport()).transfer?.source?.paused, {
        timeout: 15000,
      })
      .toBe(true);
    await sender.evaluate(() =>
      (window as unknown as { releaseSource: () => void }).releaseSource(),
    );
    await sender.getByRole('button', { name: 'Resume', exact: true }).click();
    await expect(sender.locator('.file-status').first()).toHaveText(
      'Browser copy verified',
      { timeout: 60000 },
    );
    await expect
      .poll(async () => (await readReport()).transfer?.source?.paused, {
        timeout: 15000,
      })
      .toBe(false);
    await expect
      .poll(async () => (await readReport()).transfer?.source?.batch?.phase, {
        timeout: 15000,
      })
      .toBe('verified');
    const timing = (await readReport()).transfer.source.batch;
    expect(timing).toMatchObject({
      requestedFiles: 1,
      requestedBytes: payload.length,
      payloadBytesSent: payload.length,
      resumedBytes: 0,
      skippedBytes: 0,
      verifiedFiles: 1,
      skippedFiles: 0,
    });
    expect(timing.wallElapsedMs).toBeGreaterThan(1000);
    const stored = await receiver.evaluate(async (backend: string) => {
      const open = indexedDB.open('pixelbridge-v1', 3);
      const db = await new Promise<IDBDatabase>((resolve) => {
        open.onsuccess = () => resolve(open.result);
      });
      const request = db.transaction('files').objectStore('files').getAll();
      const records = await new Promise<{ id: string }[]>((resolve) => {
        request.onsuccess = () => resolve(request.result);
      });
      db.close();
      let file: Blob;
      if (backend === 'opfs') {
        const root = await navigator.storage.getDirectory();
        const directory = await root.getDirectoryHandle('pixelbridge');
        file = await (await directory.getFileHandle(records[0].id)).getFile();
      } else {
        const opening = indexedDB.open('pixelgate-staging-v1', 1);
        const staging = await new Promise<IDBDatabase>((resolve) => {
          opening.onsuccess = () => resolve(opening.result);
        });
        const request = staging
          .transaction('chunks')
          .objectStore('chunks')
          .getAll(
            IDBKeyRange.bound(
              [records[0].id, 0],
              [records[0].id, Number.MAX_SAFE_INTEGER],
            ),
          );
        const chunks = await new Promise<{ bytes: Blob }[]>((resolve) => {
          request.onsuccess = () => resolve(request.result);
        });
        file = new Blob(chunks.map((chunk) => chunk.bytes));
        staging.close();
      }
      const digest = await crypto.subtle.digest(
        'SHA-256',
        await file.arrayBuffer(),
      );
      return Array.from(new Uint8Array(digest), (value) =>
        value.toString(16).padStart(2, '0'),
      ).join('');
    }, held.storageMode);
    expect(stored).toBe(hash);
    expect(errors).toEqual([]);
    await receiver.reload();
    expect((await readReport()).transfer.source.batch).toEqual(timing);
  } finally {
    await sending.close();
    await receiving.close();
    if (receiverBrowser !== browser) await receiverBrowser.close();
  }
});

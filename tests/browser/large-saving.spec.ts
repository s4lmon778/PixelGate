import { test, expect, chromium } from '@playwright/test';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';

for (const backend of ['opfs', 'indexeddb']) {
  test(`400 MiB original transfers through ${backend}, bypasses Android share limits, and downloads byte-exactly`, async ({
    browser,
    browserName,
  }, testInfo) => {
    test.skip(
      browserName !== 'chromium',
      'One large-file engine validation; this is not physical Pixel certification.',
    );
    test.setTimeout(240000);
    const folder = testInfo.outputPath('large-file');
    await mkdir(folder, { recursive: true });
    const path = `${folder}/original-400MiB.mp4`;
    const source = await open(path, 'w');
    const hash = createHash('sha256');
    const block = Buffer.alloc(1024 * 1024, 0x7b);
    try {
      for (let i = 0; i < 400; i++) {
        block.writeUInt32BE(i, 0);
        block.writeUInt32BE(400 - i, block.length - 4);
        for (let frame = 1; frame < 64; frame++)
          block.writeUInt32BE(i * 64 + frame, frame * 16 * 1024);
        await source.write(block);
        hash.update(block);
      }
      const tail = Buffer.from('untouched-original-tail');
      await source.write(tail);
      hash.update(tail);
    } finally {
      await source.close();
    }
    const expected = hash.digest('hex');
    const contextOptions = {
      userAgent:
        'Mozilla/5.0 (Linux; Android 13; Pixel) AppleWebKit/537.36 Chrome/106.0.0.0 Mobile Safari/537.36',
    };
    // The directory-write surrogate is OPFS, sharing this origin's quota with
    // staging. Use a normal profile: Incognito caps this artificial combination
    // below 800 MiB, while a user-selected device folder is outside that quota.
    const receiving = await chromium.launchPersistentContext(
      testInfo.outputPath('receiving-profile'),
      {
        ...contextOptions,
        headless: true,
        executablePath: process.env.PIXELGATE_TEST_CHROMIUM_EXECUTABLE,
        args: ['--disable-features=WebRtcHideLocalIpsWithMdns'],
      },
    );
    if (backend === 'indexeddb')
      await receiving.addInitScript(() => {
        Reflect.set(
          window,
          'testDirectory',
          navigator.storage.getDirectory.bind(navigator.storage),
        );
        Object.defineProperty(
          Object.getPrototypeOf(navigator.storage),
          'getDirectory',
          { configurable: true, value: undefined },
        );
      });
    const sending = await browser.newContext();
    await receiving.addInitScript(() => {
      Object.assign(window, { shareCalls: 0 });
      // Exercise real streamed directory writes/readback. This substitutes only
      // the native Android picker, which needs a physical-device acceptance test.
      Object.defineProperty(window, 'showDirectoryPicker', {
        configurable: true,
        value: async () =>
          (
            await (
              Reflect.get(window, 'testDirectory') ??
              navigator.storage.getDirectory.bind(navigator.storage)
            )()
          ).getDirectoryHandle('pixelgate-test-photos', { create: true }),
      });
      Object.defineProperty(Navigator.prototype, 'canShare', {
        configurable: true,
        value: () => true,
      });
      Object.defineProperty(Navigator.prototype, 'share', {
        configurable: true,
        value: () => {
          (window as unknown as { shareCalls: number }).shareCalls++;
          return Promise.reject(
            new DOMException('Too large', 'NotAllowedError'),
          );
        },
      });
    });
    try {
      const receiver = await receiving.newPage(),
        sender = await sending.newPage();
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
      await sender
        .getByLabel('Choose files', { exact: true })
        .setInputFiles(path);
      const start = Date.now();
      await sender
        .getByRole('button', { name: 'Send files', exact: true })
        .last()
        .click();
      await expect
        .poll(
          async () => {
            const status = await receiver
              .locator('.file-status')
              .first()
              .textContent()
              .catch(() => null);
            if (status === 'Needs retry')
              throw new Error(
                JSON.stringify({
                  body: await receiver
                    .locator('.file-list')
                    .innerText()
                    .catch(() => receiver.locator('body').innerText()),
                }),
              );
            return status;
          },
          { timeout: 120000 },
        )
        .toBe('Browser copy verified');
      console.log(
        `400 MiB source hash + transfer + readback: ${Date.now() - start} ms`,
      );
      await receiver
        .getByRole('button', { name: 'Save to app or location', exact: true })
        .click();
      const dialog = receiver.getByRole('dialog', {
        name: 'Save to an app or location',
      });
      await dialog
        .getByRole('button', { name: 'Prepare selected files', exact: true })
        .click();
      await expect(dialog.getByRole('status')).toContainText('50 MiB', {
        timeout: 60000,
      });
      await expect(
        dialog.getByRole('button', {
          name: 'Choose app or save location',
          exact: true,
        }),
      ).toHaveCount(0);
      await expect(
        dialog.getByRole('button', {
          name: 'Download verified files',
          exact: true,
        }),
      ).toBeEnabled();
      await dialog
        .getByText('Save large videos and collections to Google Photos', {
          exact: true,
        })
        .click();
      await expect(dialog).toContainText('Back up device folders');
      await receiver.setViewportSize({ width: 390, height: 844 });
      expect(
        await receiver.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await receiver.screenshot({
        path: testInfo.outputPath('android-large-save.png'),
      });
      const downloadEvent = receiver.waitForEvent('download');
      await dialog
        .getByRole('button', { name: 'Download verified files', exact: true })
        .click();
      const download = await downloadEvent;
      const downloaded = await download.path();
      expect(downloaded).toBeTruthy();
      const exportedHash = createHash('sha256');
      for await (const bytes of createReadStream(downloaded!))
        exportedHash.update(bytes);
      expect(exportedHash.digest('hex')).toBe(expected);
      expect(download.suggestedFilename()).toBe('original-400MiB.mp4');
      expect(
        await receiver.evaluate(
          () => (window as unknown as { shareCalls: number }).shareCalls,
        ),
      ).toBe(0);
      await expect(dialog.getByRole('status')).toContainText(
        'Verification pending',
      );
      await dialog
        .getByRole('button', { name: 'Close save options', exact: true })
        .click();
      await receiver
        .getByRole('button', { name: 'Save to Photos folder', exact: true })
        .click();
      await expect(
        receiver.getByRole('button', {
          name: 'Save to Photos folder',
          exact: true,
        }),
      ).toBeEnabled({ timeout: 60000 });
      const savingProblem = await receiver.getByRole('alert').allTextContents();
      expect(savingProblem).toEqual([]);
      await expect(receiver.locator('.file-status').first()).toHaveText(
        'Destination verified',
        { timeout: 60000 },
      );
      await expect(
        receiver.getByRole('button', {
          name: 'Save to Photos folder',
          exact: true,
        }),
      ).toBeEnabled();
      const destinationDownload = receiver.waitForEvent('download');
      await receiver.evaluate(async () => {
        const root = await (
          await (
            Reflect.get(window, 'testDirectory') ??
            navigator.storage.getDirectory.bind(navigator.storage)
          )()
        ).getDirectoryHandle('pixelgate-test-photos');
        const file = await (
          await root.getFileHandle('original-400MiB.mp4')
        ).getFile();
        const link = document.createElement('a');
        link.href = URL.createObjectURL(file);
        link.download = file.name;
        link.click();
      });
      const destinationPath = await (await destinationDownload).path();
      const destinationHash = createHash('sha256');
      for await (const bytes of createReadStream(destinationPath!))
        destinationHash.update(bytes);
      expect(destinationHash.digest('hex')).toBe(expected);
      const later = Buffer.alloc(128 * 1024 + 7, 0x46);
      const laterHash = createHash('sha256').update(later).digest('hex');
      await sender
        .getByLabel('Choose files', { exact: true })
        .setInputFiles({
          name: 'later-original.jpg',
          mimeType: 'image/jpeg',
          buffer: later,
        });
      await sender
        .getByRole('button', { name: 'Send files', exact: true })
        .last()
        .click();
      // The selected Photos folder is reused without another export action.
      await expect
        .poll(
          async () =>
            receiver.evaluate(async () => {
              try {
                const root = await (
                  await (
                    Reflect.get(window, 'testDirectory') ??
                    navigator.storage.getDirectory.bind(navigator.storage)
                  )()
                ).getDirectoryHandle('pixelgate-test-photos');
                const file = await (
                  await root.getFileHandle('later-original.jpg')
                ).getFile();
                return Array.from(
                  new Uint8Array(
                    await crypto.subtle.digest(
                      'SHA-256',
                      await file.arrayBuffer(),
                    ),
                  ),
                  (byte) => byte.toString(16).padStart(2, '0'),
                ).join('');
              } catch {
                return '';
              }
            }),
          { timeout: 30000 },
        )
        .toBe(laterHash);
      expect(errors).toEqual([]);
    } finally {
      await sending.close();
      await receiving.close();
    }
  });
}

test('125 selected originals stay queued across native handoffs and fifty-file download batches', async ({
  page,
  browserName,
}) => {
  test.skip(
    browserName === 'webkit',
    'Existing nonpersistent WebKit Blob fixture boundary.',
  );
  await page.addInitScript(() => {
    Object.assign(window, { handedOff: [] as string[][] });
    Object.defineProperty(navigator, 'userAgent', {
      configurable: true,
      value:
        'Mozilla/5.0 (Linux; Android 10; Pixel XL) AppleWebKit/537.36 Chrome/138.0.0.0 Mobile Safari/537.36',
    });
    if (typeof Reflect.get(window, 'showDirectoryPicker') === 'function')
      Object.defineProperty(window, 'showDirectoryPicker', {
        configurable: true,
        value: async () =>
          (await navigator.storage.getDirectory()).getDirectoryHandle(
            'pixelgate-test-photos',
            { create: true },
          ),
      });
    Object.defineProperty(Navigator.prototype, 'canShare', {
      configurable: true,
      value: ({ files }: ShareData) => !!files?.length && files.length <= 10,
    });
    Object.defineProperty(Navigator.prototype, 'share', {
      configurable: true,
      value: async ({ files }: ShareData) => {
        if (!navigator.userActivation.isActive)
          throw new Error('Fresh tap required');
        (window as unknown as { handedOff: string[][] }).handedOff.push(
          files!.map((file) => file.name),
        );
      },
    });
  });
  await page.goto('./');
  await expect(
    page.getByRole('button', { name: 'Receive files', exact: true }),
  ).toBeVisible();
  await page.evaluate(async () => {
    const connect = (name: string, version: number) =>
      new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(name, version);
        request.onupgradeneeded = () => {
          request.result.createObjectStore('files', { keyPath: 'id' });
          request.result.createObjectStore('chunks', {
            keyPath: ['fileId', 'offset'],
          });
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    const original = new TextEncoder().encode(
      'Untouched synthetic photo bytes',
    );
    const sha256 = Array.from(
      new Uint8Array(await crypto.subtle.digest('SHA-256', original)),
      (byte) => byte.toString(16).padStart(2, '0'),
    ).join('');
    const records = Array.from({ length: 125 }, (_, i) => ({
      id: (i + 1).toString(16).padStart(64, '0'),
      sessionId: 'many-files',
      relativePath: `photo-${i}.jpg`,
      originalName: `photo-${i}.jpg`,
      size: original.length,
      sha256,
      mimeType: 'image/jpeg',
      modified: 1000,
      bytes: original.length,
      phase: 'verified',
      scope: 'browser',
      updated: 1000 + i,
      localRole: 'receive',
    }));
    const db = await connect('pixelbridge-v1', 3);
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(['files', 'history'], 'readwrite');
      for (const record of records) {
        tx.objectStore('files').put(record);
        tx.objectStore('history').put({
          ...record,
          historyKey: `receive:many-files:${record.id}`,
        });
      }
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error);
    });
    db.close();
    const staging = await connect('pixelgate-staging-v1', 1);
    await new Promise<void>((resolve, reject) => {
      const tx = staging.transaction(['files', 'chunks'], 'readwrite');
      for (const record of records) {
        tx.objectStore('files').put({ id: record.id, size: record.size });
        tx.objectStore('chunks').put({
          fileId: record.id,
          offset: 0,
          bytes: new Blob([original]),
        });
      }
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error);
    });
    staging.close();
  });
  await page.reload();
  await page
    .getByRole('button', { name: 'Receive files', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Save to app or location', exact: true })
    .click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('125 selected');
  await expect(dialog.getByRole('checkbox')).toHaveCount(50);
  await expect(dialog.getByRole('checkbox').last()).toBeEnabled();
  await dialog
    .getByRole('button', { name: 'Prepare selected files', exact: true })
    .click();
  await expect(
    dialog.getByRole('button', {
      name: 'Choose app or save location',
      exact: true,
    }),
  ).toBeEnabled();
  for (let i = 0; i < 5; i++) {
    await dialog
      .getByRole('button', { name: 'Choose app or save location', exact: true })
      .click();
    await expect(dialog).toContainText(`${125 - (i + 1) * 10} selected`);
  }
  const batches = await page.evaluate(
    () => (window as unknown as { handedOff: string[][] }).handedOff,
  );
  expect(batches.map((batch) => batch.length)).toEqual([10, 10, 10, 10, 10]);
  expect(new Set(batches.flat()).size).toBe(50);
  await dialog
    .getByRole('button', { name: 'Prepare selected files', exact: true })
    .click();
  await expect(
    dialog.getByRole('button', {
      name: 'Download verified files',
      exact: true,
    }),
  ).toBeEnabled();
  const downloads: Promise<string | null>[] = [];
  page.on('download', (download) => downloads.push(download.path()));
  await dialog
    .getByRole('button', { name: 'Download all 75 selected', exact: true })
    .click();
  await expect(dialog).toContainText('0 selected', { timeout: 25000 });
  await expect.poll(() => downloads.length).toBe(75);
  expect((await Promise.all(downloads)).every(Boolean)).toBe(true);
  await expect(
    dialog.getByRole('button', { name: 'Select next batch', exact: true }),
  ).toBeDisabled();
  const originalHash = createHash('sha256')
    .update('Untouched synthetic photo bytes')
    .digest('hex');
  for (const path of await Promise.all(downloads)) {
    const hash = createHash('sha256');
    for await (const bytes of createReadStream(path!)) hash.update(bytes);
    expect(hash.digest('hex')).toBe(originalHash);
  }
  if (browserName === 'chromium') {
    await dialog
      .getByRole('button', { name: 'Close save options', exact: true })
      .click();
    await page
      .getByRole('button', { name: 'Save to Photos folder', exact: true })
      .click();
    await expect(
      page.getByRole('button', { name: 'Save to Photos folder', exact: true }),
    ).toBeEnabled({ timeout: 30000 });
    const saved = await page.evaluate(async () => {
      const root = await (
        await navigator.storage.getDirectory()
      ).getDirectoryHandle('pixelgate-test-photos');
      const hashes: string[] = [];
      for (let i = 0; i < 125; i++) {
        const file = await (
          await root.getFileHandle(`photo-${i}.jpg`)
        ).getFile();
        hashes.push(
          Array.from(
            new Uint8Array(
              await crypto.subtle.digest('SHA-256', await file.arrayBuffer()),
            ),
            (byte) => byte.toString(16).padStart(2, '0'),
          ).join(''),
        );
      }
      return hashes;
    });
    expect(saved).toHaveLength(125);
    expect(saved.every((hash) => hash === originalHash)).toBe(true);
    await expect(
      page.getByRole('status').filter({ hasText: 'Photos folder:' }),
    ).toContainText('Future received files save here automatically');
  }
});

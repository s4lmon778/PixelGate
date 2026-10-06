import { test, expect, chromium } from '@playwright/test';
import { createHash } from 'node:crypto';
import jsQR from 'jsqr';
import { PNG } from 'pngjs';
import type { Locator } from '@playwright/test';

async function scanQr(image: Locator) {
  await expect(image).toBeVisible();
  await image.evaluate((element: HTMLImageElement) => element.decode());
  const pixels = PNG.sync.read(await image.screenshot());
  const decoded = jsQR(
    new Uint8ClampedArray(pixels.data),
    pixels.width,
    pixels.height,
  );
  expect(
    decoded,
    'QR must decode independently at its displayed size',
  ).not.toBeNull();
  return decoded!.data;
}

test('real peer transfer, readback, manual export verification, and reconnect', async ({
  browser,
}, testInfo) => {
  // WebKit's nonpersistent test contexts do not expose durable OPFS on macOS.
  // Exercise it as a sender to a Chromium receiver with explicit LAN candidates;
  // cross-engine mDNS discovery is unreliable in these headless macOS contexts.
  const receiverBrowser =
    testInfo.project.name === 'webkit'
      ? await chromium.launch({
          args: ['--disable-features=WebRtcHideLocalIpsWithMdns'],
        })
      : browser;
  const receiverContext = await receiverBrowser.newContext();
  const senderContext = await browser.newContext();
  const receiver = await receiverContext.newPage();
  const sender = await senderContext.newPage();
  const pageErrors: string[] = [];
  for (const page of [receiver, sender])
    page.on('pageerror', (e) => pageErrors.push(e.message));
  const requests: { url: string; method: string; body: string | null }[] = [];
  for (const page of [receiver, sender])
    page.on('request', (r) =>
      requests.push({ url: r.url(), method: r.method(), body: r.postData() }),
    );
  await receiver.goto('./');
  await sender.goto('./');
  await receiver
    .getByRole('button', { name: 'Receive files', exact: true })
    .click();
  await receiver
    .getByRole('button', { name: 'Create a connection', exact: true })
    .click();
  await expect(
    receiver.getByLabel('Receiver link', { exact: true }),
  ).toBeVisible({ timeout: 20000 });
  const expectedLink = await receiver
    .getByLabel('Receiver link', { exact: true })
    .inputValue();
  const pairLink = await scanQr(
    receiver.getByAltText('Scan this receiver link', { exact: true }),
  );
  expect(pairLink).toBe(expectedLink);
  await receiver
    .getByRole('button', { name: 'Enlarge QR code', exact: true })
    .click();
  expect(
    await scanQr(
      receiver.getByAltText('Enlarged receiver QR code', { exact: true }),
    ),
  ).toBe(pairLink);
  await receiver
    .getByRole('button', { name: 'Close QR code', exact: true })
    .click();
  await receiver.setViewportSize({ width: 390, height: 844 });
  expect(
    await scanQr(
      receiver.getByAltText('Scan this receiver link', { exact: true }),
    ),
  ).toBe(pairLink);
  expect(
    await receiver.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await receiver.setViewportSize({ width: 1440, height: 1000 });
  // Links keep signaling in the URL fragment, which is not sent to the host.
  await sender.goto(pairLink);
  await sender
    .getByRole('button', { name: 'Prepare sender response', exact: true })
    .click();
  await expect(
    sender.getByLabel('Sender response', { exact: true }),
  ).toBeVisible({ timeout: 20000 });
  const response = await sender
    .getByLabel('Sender response', { exact: true })
    .inputValue();
  await receiver
    .getByLabel('2. Paste the sender response', { exact: true })
    .fill('pg1.invalid');
  await receiver.getByRole('button', { name: 'Approve sender' }).click();
  await expect(receiver.getByRole('alert')).toContainText(
    'Invalid pairing data',
  );
  await receiver
    .getByLabel('2. Paste the sender response', { exact: true })
    .fill(response);
  await receiver.getByRole('button', { name: 'Approve sender' }).click();
  await expect(sender.getByText('Connected', { exact: true })).toBeVisible({
    timeout: 45000,
  });
  await expect(receiver.getByText('Connected', { exact: true })).toBeVisible({
    timeout: 45000,
  });
  const bytes = Buffer.alloc(2 * 1024 * 1024 + 111);
  for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
  const expected = createHash('sha256').update(bytes).digest('hex');
  await sender.locator('input[aria-label="Choose files"]').setInputFiles({
    name: 'été-original.MOV',
    mimeType: 'video/quicktime',
    buffer: bytes,
  });
  await sender
    .getByRole('button', { name: 'Send files', exact: true })
    .last()
    .click();
  await expect(receiver.locator('.file-status').first()).toHaveText(
    'Browser copy verified',
    { timeout: 60000 },
  );
  await expect(sender.locator('.file-status').first()).toHaveText(
    'Browser copy verified',
  );
  const stored = await receiver.evaluate(async () => {
    const d = await new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open('pixelbridge-v1', 3);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    const records = await new Promise<{ id: string; sha256: string }[]>(
      (resolve) => {
        const r = d.transaction('files').objectStore('files').getAll();
        r.onsuccess = () => resolve(r.result);
      },
    );
    const file = await (
      await (
        await navigator.storage.getDirectory()
      ).getDirectoryHandle('pixelbridge')
    ).getFileHandle(records[0].id);
    const digest = await crypto.subtle.digest(
      'SHA-256',
      await (await file.getFile()).arrayBuffer(),
    );
    return {
      sha: records[0].sha256,
      independent: [...new Uint8Array(digest)]
        .map((x) => x.toString(16).padStart(2, '0'))
        .join(''),
    };
  });
  expect(stored.sha).toBe(expected);
  expect(stored.independent).toBe(expected);
  const downloadEvent = receiver.waitForEvent('download');
  await receiver
    .getByRole('button', { name: 'Export verified batch', exact: true })
    .click();
  const download = await downloadEvent;
  expect(download.suggestedFilename()).toBe('été-original.MOV');
  await receiver.getByRole('button', { name: 'History', exact: true }).click();
  await expect(receiver.locator('.file-status').first()).toHaveText(
    'Download verification pending',
  );
  await receiver
    .locator('input[aria-label="Verify saved copies"]')
    .setInputFiles({
      name: 'été-original.MOV',
      mimeType: 'video/quicktime',
      buffer: bytes,
    });
  await expect(receiver.locator('.file-status').first()).toHaveText(
    'Exported copy verified',
  );
  const damaged = Buffer.from(bytes);
  damaged[10] ^= 1;
  await receiver
    .locator('input[aria-label="Verify saved copies"]')
    .setInputFiles({
      name: 'damaged.MOV',
      mimeType: 'video/quicktime',
      buffer: damaged,
    });
  await expect(receiver.getByRole('alert')).toContainText(
    'failed integrity verification',
  );
  // Static hosting receives no signaling requests, filenames, hashes, or media.
  const all = JSON.stringify(requests);
  expect(all).not.toContain(expected);
  expect(all).not.toContain('été-original');
  expect(all).not.toContain(response);
  expect(
    requests.every(
      (r) =>
        r.method === 'GET' &&
        r.body === null &&
        !r.url.includes('/api/') &&
        !r.url.includes('pg1.'),
    ),
  ).toBe(true);
  await receiver.getByRole('button', { name: 'Transfer', exact: true }).click();
  await receiver.getByRole('button', { name: 'Revoke connection' }).click();
  await receiver.reload();
  await receiver.getByRole('button', { name: 'History', exact: true }).click();
  await expect(receiver.locator('.file-status').first()).toHaveText(
    'Exported copy verified',
  );
  expect(pageErrors).toEqual([]);
  await receiverContext.close();
  await senderContext.close();
  if (receiverBrowser !== browser) await receiverBrowser.close();
});

test('responsive screen exposes primary actions with no overflow', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('./');
  await expect(
    page.getByRole('button', { name: 'Receive files', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Choose files', exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: 'test-results/pixelgate-mobile.png',
    fullPage: true,
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({
    path: 'test-results/pixelgate-desktop.png',
    fullPage: true,
  });
});

test('text enlargement keeps controls and page width usable', async ({
  page,
}) => {
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto('./');
    await page.evaluate(() => {
      document.documentElement.style.fontSize = '32px';
    });
    await expect(
      page.getByRole('button', { name: 'Choose files', exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  }
});

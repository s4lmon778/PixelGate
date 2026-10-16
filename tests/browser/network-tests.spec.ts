import { test, expect, chromium } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isolateHostIce } from './host-only';

test('internet check is opt-in, bounded, labelled separately, cancellable, and does not open a file picker', async ({
  page,
}) => {
  const requests: number[] = [];
  await page.route('https://speed.cloudflare.com/__down?*', async (route) => {
    expect(route.request().method()).toBe('GET');
    expect(route.request().headers().referer).toBeUndefined();
    const bytes = Number(
      new URL(route.request().url()).searchParams.get('bytes'),
    );
    requests.push(bytes);
    await route.fulfill({
      status: 200,
      headers: { 'access-control-allow-origin': '*' },
      contentType: 'application/octet-stream',
      body: Buffer.alloc(bytes, 29),
    });
  });
  await page.goto('./');
  await page.getByText('Connection diagnostics', { exact: true }).click();
  expect(requests).toEqual([]);
  const checks = page.getByRole('region', {
    name: 'Network speed checks',
    exact: true,
  });
  await expect(
    checks.getByRole('button', { name: 'Test peer link', exact: true }),
  ).toBeDisabled();
  await checks
    .getByRole('button', { name: 'Test internet download', exact: true })
    .click();
  await expect(checks.getByTestId('internet-speed-result')).toContainText(
    'Mbps',
  );
  expect(requests.sort((a, b) => a - b)).toEqual([262144, 4194304, 4194304]);
  await expect(checks).toContainText('Neither measures the Wi-Fi radio');
  const baseline = await checks
    .getByTestId('internet-speed-result')
    .textContent();
  let release: (() => void) | undefined;
  await page.route('https://speed.cloudflare.com/__down?*', async (route) => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    await route.abort().catch(() => {});
  });
  await checks
    .getByRole('button', { name: 'Test internet download', exact: true })
    .click();
  await checks
    .getByRole('button', { name: 'Stop speed test', exact: true })
    .click();
  release?.();
  await expect(checks.getByRole('status')).toContainText('cancelled');
  await expect(checks.getByTestId('internet-speed-result')).toHaveText(
    baseline!,
  );
});

for (const phones of [false, true])
  test(`receiver can measure the peer link without staging files, then transfer and save an untouched original${phones ? ' on phone profiles' : ''}`, async ({
    browser,
    browserName,
  }) => {
    test.setTimeout(120000);
    const receiverBrowser =
      browserName === 'webkit'
        ? await chromium.launch({
            args: ['--disable-features=WebRtcHideLocalIpsWithMdns'],
          })
        : browser;
    const receiving = await receiverBrowser.newContext(
      phones
        ? { userAgent: 'Mozilla/5.0 (Linux; Android 9; Pixel XL) Mobile' }
        : {},
    );
    const sending = await browser.newContext(
      phones ? { userAgent: 'Mozilla/5.0 (iPhone) Mobile' } : {},
    );
    await isolateHostIce(receiving);
    await isolateHostIce(sending);
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
      await sender.getByText('Connection diagnostics', { exact: true }).click();
      await receiver
        .getByText('Connection diagnostics', { exact: true })
        .click();
      const report = async (page: typeof sender) =>
        JSON.parse(
          (await page
            .getByLabel('Connection report', { exact: true })
            .textContent()) || '{}',
        );
      await expect
        .poll(async () => (await report(sender)).transfer?.connections, {
          timeout: 20000,
        })
        .toBe(phones ? 5 : 14);
      await sender
        .getByLabel('Payload connection limit', { exact: true })
        .selectOption('5');
      await receiver
        .getByRole('button', { name: 'Test peer link', exact: true })
        .click();
      await expect(receiver.getByTestId('peer-speed-result')).toContainText(
        '5 connections',
        { timeout: 20000 },
      );
      await expect(sender.getByTestId('peer-speed-result')).toBeVisible();
      for (const page of [sender, receiver]) {
        const r = await report(page);
        expect(r.transfer.linkTest.result.bytes).toBe(8 * 1048576);
        expect(r.transfer.deliveredBytes).toBe(0);
        const fileCount = await page.evaluate(async () => {
          const db = await new Promise<IDBDatabase>((resolve) => {
            const opening = indexedDB.open('pixelbridge-v1', 3);
            opening.onsuccess = () => resolve(opening.result);
          });
          const count = await new Promise<number>((resolve) => {
            const request = db
              .transaction('files')
              .objectStore('files')
              .count();
            request.onsuccess = () => resolve(request.result);
          });
          db.close();
          return count;
        });
        expect(fileCount).toBe(0);
      }
      // A phone starts with five real connections, then expands only on request.
      await expect(
        sender
          .getByLabel('Payload connection limit')
          .locator('option[value=auto]'),
      ).toHaveText(`Automatic · up to ${phones ? 5 : 14}`);
      // A second idle test must work immediately, with the newly selected limit.
      await sender
        .getByLabel('Payload connection limit', { exact: true })
        .selectOption('7');
      await expect
        .poll(async () => (await report(sender)).transfer?.connections, {
          timeout: 20000,
        })
        .toBe(phones ? 7 : 14);
      await sender
        .getByRole('button', { name: 'Test peer link', exact: true })
        .click();
      await expect(receiver.getByTestId('peer-speed-result')).toContainText(
        '7 connections',
        { timeout: 20000 },
      );
      await expect(sender.getByTestId('peer-speed-result')).toContainText(
        '7 connections',
      );
      await sender
        .getByLabel('Payload connection limit', { exact: true })
        .selectOption('5');
      if (phones) {
        await sender.getByLabel('Payload connection limit').selectOption('14');
        await expect
          .poll(async () => (await report(sender)).transfer?.connections, {
            timeout: 20000,
          })
          .toBe(14);
        await sender
          .getByRole('button', { name: 'Test peer link', exact: true })
          .click();
        await expect(receiver.getByTestId('peer-speed-result')).toContainText(
          '14 connections',
          { timeout: 20000 },
        );
        await sender
          .getByLabel('Payload connection limit')
          .selectOption('auto');
      }
      // A remote file start stops an in-flight internet check before payload work.
      let releaseDownload: (() => void) | undefined;
      await receiver.route(
        'https://speed.cloudflare.com/__down?*',
        async (route) => {
          await new Promise<void>((resolve) => {
            releaseDownload = resolve;
          });
          await route.abort().catch(() => {});
        },
      );
      await receiver
        .getByRole('button', { name: 'Test internet download', exact: true })
        .click();
      await expect(
        receiver.getByRole('button', { name: 'Stop speed test', exact: true }),
      ).toBeVisible();
      await expect.poll(() => !!releaseDownload).toBe(true);
      const payload = Buffer.alloc(2 * 1048576 + 41, 39);
      for (let i = 0; i + 4 < payload.length; i += 16384)
        payload.writeUInt32BE(i / 16384, i);
      const expected = createHash('sha256').update(payload).digest('hex');
      await sender.getByLabel('Choose files', { exact: true }).setInputFiles({
        name: 'after-network-test.bin',
        mimeType: 'application/octet-stream',
        buffer: payload,
      });
      await sender
        .getByRole('button', { name: 'Send files', exact: true })
        .last()
        .click();
      await expect(
        receiver
          .getByRole('region', { name: 'Network speed checks', exact: true })
          .getByRole('status'),
      ).toContainText('cancelled');
      releaseDownload?.();
      await expect(sender.locator('.file-status').first()).toHaveText(
        'Browser copy verified',
        { timeout: 60000 },
      );
      await expect
        .poll(async () => (await report(receiver)).receiving?.durableBytes)
        .toBe(payload.length);
      const download = receiver.waitForEvent('download');
      await receiver
        .getByRole('button', {
          name: 'Save after-network-test.bin',
          exact: true,
        })
        .click();
      const saved = await download;
      expect(
        createHash('sha256')
          .update(await readFile((await saved.path())!))
          .digest('hex'),
      ).toBe(expected);
      const r = await report(sender);
      expect(r.sending.stageTimes).toHaveProperty('waiting-for-ack');
      expect(r.transfer.payloadConnectionLimit).toBe(5);
      expect(r.transfer.activePayloadConnections).toBeLessThanOrEqual(5);
      expect(errors).toEqual([]);
    } finally {
      await sending.close();
      await receiving.close();
      if (receiverBrowser !== browser) await receiverBrowser.close();
    }
  });

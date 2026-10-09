import { test, expect, chromium, firefox, webkit } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import jsQR from 'jsqr';
import { PNG } from 'pngjs';
import type { Locator } from '@playwright/test';
import { PeerServer } from 'peer';
import WebSocket from 'ws';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import packageInfo from '../../package.json' with { type: 'json' };

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

for (const mode of [
  'automatic',
  'blocked',
  'explicit',
  'early',
  'indexeddb',
  'safari-receiver',
])
  test(
    mode === 'blocked'
      ? 'six-digit pairing with blocked discovery fails without transferring bytes'
      : `six-digit pairing${mode === 'explicit' ? ' with explicit LAN fallback' : mode === 'early' ? ' with candidates before answer' : mode === 'indexeddb' ? ' with compatibility storage' : mode === 'safari-receiver' ? ' into WebKit compatibility storage' : ''} requires approval, transfers verified bytes, and consumes the code`,
    async ({ browserName }) => {
      const safariReceiver = mode === 'safari-receiver';
      test.skip(
        safariReceiver && browserName !== 'webkit',
        'One actual WebKit receiving scenario.',
      );
      const explicitLan = mode === 'explicit';
      const blockedLan = mode === 'blocked' || mode === 'explicit';
      test.skip(
        mode === 'blocked' && browserName !== 'chromium',
        'One negative control is sufficient for the injected route failure.',
      );
      test.skip(
        !['automatic', 'indexeddb', 'safari-receiver'].includes(mode) &&
          Boolean(process.env.PIXELGATE_TEST_PUBLIC_SIGNALING),
        'Local discovery failure is injected only in the isolated fixture.',
      );
      const lanAddress = Object.values(networkInterfaces())
        .flat()
        .find((entry) => entry?.family === 'IPv4' && !entry.internal)?.address;
      if (explicitLan)
        expect(
          lanAddress,
          'A LAN interface is required for the fallback fixture',
        ).toBeTruthy();
      const publicSignaling = Boolean(
        process.env.PIXELGATE_TEST_PUBLIC_SIGNALING,
      );
      const server = publicSignaling
        ? undefined
        : await new Promise<Server>((resolve) =>
            PeerServer(
              { host: '127.0.0.1', port: 0, allow_discovery: false },
              resolve,
            ),
          );
      const port = (server?.address() as AddressInfo | undefined)?.port;
      // Use native privacy defaults even though the older manual-pairing suite
      // uses explicit LAN candidates for its headless fixtures.
      const senderBrowser = await { chromium, firefox, webkit }[
        safariReceiver ? 'chromium' : browserName
      ].launch(
        browserName === 'chromium' &&
          process.env.PIXELGATE_TEST_CHROMIUM_EXECUTABLE
          ? { executablePath: process.env.PIXELGATE_TEST_CHROMIUM_EXECUTABLE }
          : mode === 'indexeddb' && !publicSignaling
            ? browserName === 'chromium'
              ? { args: ['--disable-features=WebRtcHideLocalIpsWithMdns'] }
              : browserName === 'firefox'
                ? {
                    firefoxUserPrefs: {
                      'media.peerconnection.ice.obfuscate_host_addresses': false,
                    },
                  }
                : {}
            : {},
      );
      const receiverBrowser = safariReceiver
        ? await webkit.launch()
        : browserName === 'webkit'
          ? await chromium.launch()
          : senderBrowser;
      const receiverContext = await receiverBrowser.newContext();
      const senderContext = await senderBrowser.newContext();
      if (
        mode === 'indexeddb' &&
        !process.env.PIXELGATE_TEST_CHROMIUM_EXECUTABLE
      )
        await receiverContext.addInitScript(() => {
          Object.defineProperty(
            Object.getPrototypeOf(navigator.storage),
            'getDirectory',
            {
              value: undefined,
            },
          );
        });
      const sockets = new Set<WebSocket>();
      const signals: string[] = [];
      const connections: string[] = [];
      let holdRoutes = !publicSignaling;
      const delayedRoutes: { type: string; forward: () => void }[] = [];
      for (const context of [receiverContext, senderContext]) {
        if (blockedLan)
          await context.addInitScript(() => {
            const Original = window.RTCPeerConnection;
            window.RTCPeerConnection = class extends Original {
              constructor(config?: RTCConfiguration) {
                super({ ...config, iceServers: [] });
              }
            };
          });
        if (publicSignaling) {
          context.on('page', (page) =>
            page.on('websocket', (socket) => {
              connections.push(socket.url());
              socket.on('framesent', ({ payload }) =>
                signals.push(String(payload)),
              );
              socket.on('framereceived', ({ payload }) =>
                signals.push(String(payload)),
              );
            }),
          );
          continue;
        }
        await context.routeWebSocket('wss://0.peerjs.com/**', (route) => {
          const remote = new WebSocket(
            route.url().replace('wss://0.peerjs.com', `ws://127.0.0.1:${port}`),
          );
          sockets.add(remote);
          const pending: (string | Buffer)[] = [];
          connections.push(route.url());
          route.onMessage((original) => {
            let message: string | Buffer = original;
            if (blockedLan) {
              const value = JSON.parse(String(original));
              const obscure = (candidate: string) =>
                candidate.replace(
                  /(candidate:[^\s]+ 1 (?:[Uu][Dd][Pp]|[Tt][Cc][Pp]) \d+ )[^\s]+( \d+ typ host)/g,
                  '$1pixelgate-unresolvable.local$2',
                );
              if (value.payload?.candidate?.candidate)
                value.payload.candidate.candidate = obscure(
                  value.payload.candidate.candidate,
                );
              if (value.payload?.sdp?.sdp)
                value.payload.sdp.sdp = obscure(value.payload.sdp.sdp);
              message = JSON.stringify(value);
            }
            signals.push(String(message));
            const forward = () => {
              if (remote.readyState === WebSocket.OPEN) remote.send(message);
              else pending.push(message);
            };
            const type = JSON.parse(String(message)).type;
            if (holdRoutes && ['ANSWER', 'CANDIDATE'].includes(type))
              delayedRoutes.push({ type, forward });
            else forward();
          });
          remote.on('open', () => {
            for (const message of pending) remote.send(message);
          });
          remote.on('message', (message) => {
            signals.push(String(message));
            route.send(message.toString());
          });
          remote.on('error', () => route.close());
          route.onClose(() => remote.close());
        });
      }
      try {
        const receiver = await receiverContext.newPage(),
          sender = await senderContext.newPage();
        await receiver.goto('./');
        await sender.goto('./');
        await receiver
          .getByRole('button', { name: 'Receive files', exact: true })
          .click();
        if (explicitLan) {
          await receiver
            .getByText('Advanced network settings', { exact: true })
            .click();
          await receiver
            .getByLabel('Sender’s local IPv4 (optional)', { exact: true })
            .fill(lanAddress!);
          await receiver.locator('.connection-panel').screenshot({
            path: `test-results/pixelgate-lan-${browserName}.png`,
            mask: [
              receiver.getByLabel('Sender’s local IPv4 (optional)', {
                exact: true,
              }),
            ],
          });
        }
        await receiver
          .getByRole('button', { name: 'Create a connection', exact: true })
          .click();
        if (mode === 'indexeddb' || safariReceiver) {
          await receiver
            .getByText('How storage works', { exact: true })
            .click();
          await expect(
            receiver.getByLabel('Compatibility storage', { exact: true }),
          ).toBeVisible();
        }
        const displayedCode = receiver.getByLabel('Pairing code', {
          exact: true,
        });
        await expect(displayedCode).toBeVisible({ timeout: 20000 });
        const code = (await displayedCode.innerText()).replace(/\s/g, '');
        expect(code).toMatch(/^\d{6}$/);
        const link = await scanQr(
          receiver.getByAltText('Scan this receiver link', { exact: true }),
        );
        expect(new URL(link).hash).toBe(`#connect=${code}`);
        await expect(
          receiver.getByLabel('2. Paste the sender response', { exact: true }),
        ).toHaveCount(0);
        await expect(
          receiver.getByRole('button', { name: 'Approve sender', exact: true }),
        ).toBeDisabled();
        await sender.setViewportSize({ width: 390, height: 844 });
        await sender
          .getByLabel('Receiver’s six-digit code', { exact: true })
          .fill(code);
        await sender
          .getByRole('button', { name: 'Connect', exact: true })
          .click();
        await expect(
          receiver.getByRole('button', { name: 'Approve sender', exact: true }),
        ).toBeEnabled({ timeout: 30000 });
        await receiver
          .getByText('Connection diagnostics', { exact: true })
          .click();
        const routeReport = await receiver
          .getByLabel('Connection report', { exact: true })
          .innerText();
        const route = JSON.parse(routeReport);
        expect(route.version).toBe(packageInfo.version);
        expect(route.localCandidates).toHaveProperty('host');
        expect(routeReport).not.toMatch(
          /a=candidate:|\.local|(?:\d{1,3}\.){3}\d{1,3}/,
        );
        expect(routeReport).not.toContain(code);
        await receiver.locator('.route-diagnostics').screenshot({
          path: 'test-results/pixelgate-route-report.png',
        });
        await receiver
          .getByText('Connection diagnostics', { exact: true })
          .click();
        await expect(
          sender.getByText('Connected', { exact: true }),
        ).toHaveCount(0);
        await expect(
          sender.getByLabel('Sender response', { exact: true }),
        ).toHaveCount(0);
        expect(
          await sender.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBe(true);
        const bytes = Buffer.alloc(1024 * 1024 + 37, 0x7b);
        const hash = createHash('sha256').update(bytes).digest('hex');
        await sender.locator('input[aria-label="Choose files"]').setInputFiles({
          name: 'code-transfer-é.bin',
          mimeType: 'application/octet-stream',
          buffer: bytes,
        });
        await expect(
          sender
            .getByRole('button', { name: 'Send files', exact: true })
            .last(),
        ).toBeDisabled();
        await receiver.locator('.connection-panel').screenshot({
          path: 'test-results/pixelgate-code-receiver.png',
        });
        await receiver
          .getByRole('button', { name: 'Approve sender', exact: true })
          .click();
        if (!publicSignaling) {
          // Consent must work before WebRTC finishes; no transfer is activated yet.
          await expect(
            receiver.getByText('2. Sender approved', { exact: true }),
          ).toBeVisible();
          await expect(
            receiver.getByText('Connected', { exact: true }),
          ).toHaveCount(0);
          await expect(
            sender.getByText('Connected', { exact: true }),
          ).toHaveCount(0);
          holdRoutes = false;
          if (mode === 'early') {
            for (const route of delayedRoutes.filter(
              (route) => route.type === 'CANDIDATE',
            ))
              route.forward();
            await sender
              .getByText('Connection diagnostics', { exact: true })
              .click();
            if (process.env.PIXELGATE_EXPECT_EARLY_FAILURE) {
              await expect(sender.getByRole('alert')).toContainText(
                'Pairing failed',
                { timeout: 10000 },
              );
              const failed = JSON.parse(
                await sender
                  .getByLabel('Connection report', { exact: true })
                  .innerText(),
              );
              expect(failed.remoteDescription).toBe(false);
              expect(failed.signaling).toBe('have-local-offer');
              await expect(
                sender.getByText('Connected', { exact: true }),
              ).toHaveCount(0);
              await expect(receiver.locator('.file-status')).toHaveCount(0);
              return;
            }
            await expect(
              sender.getByLabel('Connection report', { exact: true }),
            ).toContainText(/"queued": [1-9]/, { timeout: 10000 });
            const pendingReport = JSON.parse(
              await sender
                .getByLabel('Connection report', { exact: true })
                .innerText(),
            );
            expect(pendingReport.remoteDescription).toBe(false);
            await expect(sender.getByRole('alert')).toHaveCount(0);
            await sender
              .getByText('Connection diagnostics', { exact: true })
              .click();
            for (const route of delayedRoutes.filter(
              (route) => route.type === 'ANSWER',
            ))
              route.forward();
          } else for (const route of delayedRoutes) route.forward();
          delayedRoutes.length = 0;
        }
        if (mode === 'blocked') {
          await expect(receiver.getByRole('alert')).toContainText(
            /direct route/,
            { timeout: 60000 },
          );
          await expect(receiver.getByRole('alert')).toContainText(
            'networks may block local discovery or connections between devices',
          );
          await expect(
            sender.getByText('Connected', { exact: true }),
          ).toHaveCount(0);
          await expect(receiver.locator('.file-status')).toHaveCount(0);
          expect(signals.join('')).not.toContain('code-transfer-é');
          expect(signals.join('')).not.toContain(hash);
          return;
        }
        await expect(
          sender.getByText('Connected', { exact: true }),
        ).toBeVisible({ timeout: 45000 });
        await sender
          .getByRole('button', { name: 'Send files', exact: true })
          .last()
          .click();
        await expect(receiver.locator('.file-status').first()).toHaveText(
          'Browser copy verified',
          { timeout: 60000 },
        );
        const actualHash = await receiver.evaluate(
          async (indexed) => {
            if (indexed) {
              const d = await new Promise<IDBDatabase>((resolve, reject) => {
                const request = indexedDB.open('pixelgate-staging-v1', 1);
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => reject(request.error);
              });
              const chunks = await new Promise<{ bytes: Blob }[]>(
                (resolve, reject) => {
                  const request = d
                    .transaction('chunks')
                    .objectStore('chunks')
                    .getAll();
                  request.onsuccess = () => resolve(request.result);
                  request.onerror = () => reject(request.error);
                },
              );
              d.close();
              const stored = new Blob(chunks.map((chunk) => chunk.bytes));
              return [
                ...new Uint8Array(
                  await crypto.subtle.digest(
                    'SHA-256',
                    await stored.arrayBuffer(),
                  ),
                ),
              ]
                .map((byte) => byte.toString(16).padStart(2, '0'))
                .join('');
            }
            const directory = await (
              await navigator.storage.getDirectory()
            ).getDirectoryHandle('pixelbridge');
            const entries = (
              directory as FileSystemDirectoryHandle & {
                entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
              }
            ).entries();
            for await (const [name, handle] of entries) {
              if (handle.kind !== 'file' || name.startsWith('probe-')) continue;
              const bytes = await (
                await (handle as FileSystemFileHandle).getFile()
              ).arrayBuffer();
              return [
                ...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
              ]
                .map((byte) => byte.toString(16).padStart(2, '0'))
                .join('');
            }
          },
          mode === 'indexeddb' || safariReceiver,
        );
        expect(actualHash).toBe(hash);
        if (mode === 'indexeddb' || safariReceiver) {
          const event = receiver.waitForEvent('download');
          await receiver
            .getByRole('button', { name: 'Export verified batch', exact: true })
            .click();
          const downloaded = await event;
          // macOS/WebKit downloads may normalize a Unicode filename to NFD.
          expect(downloaded.suggestedFilename().normalize('NFC')).toBe(
            'code-transfer-é.bin',
          );
          expect(
            createHash('sha256')
              .update(await readFile((await downloaded.path())!))
              .digest('hex'),
          ).toBe(hash);
          await receiver
            .getByRole('button', { name: 'History', exact: true })
            .click();
          await expect(receiver.locator('.file-status').first()).toHaveText(
            'Download verification pending',
          );
          await receiver
            .locator('input[aria-label="Verify saved copies"]')
            .setInputFiles({
              name: 'exported.bin',
              mimeType: 'application/octet-stream',
              buffer: bytes,
            });
          await expect(receiver.locator('.file-status').first()).toHaveText(
            'Exported copy verified',
          );
          await receiver
            .getByRole('button', { name: 'Transfer', exact: true })
            .click();
          await receiver.evaluate(async () => {
            const d = await new Promise<IDBDatabase>((resolve) => {
              const r = indexedDB.open('pixelgate-staging-v1', 1);
              r.onsuccess = () => resolve(r.result);
            });
            const chunk = await new Promise<{
              fileId: string;
              offset: number;
              bytes: Blob | ArrayBuffer;
            }>((resolve) => {
              const r = d
                .transaction('chunks')
                .objectStore('chunks')
                .openCursor();
              r.onsuccess = () => resolve(r.result!.value);
            });
            const damaged = new Uint8Array(
              await new Blob([chunk.bytes]).arrayBuffer(),
            );
            damaged[0] ^= 1;
            chunk.bytes =
              chunk.bytes instanceof ArrayBuffer
                ? damaged.buffer
                : new Blob([damaged]);
            await new Promise<void>((resolve, reject) => {
              const tx = d.transaction('chunks', 'readwrite');
              tx.objectStore('chunks').put(chunk);
              tx.oncomplete = () => resolve();
              tx.onabort = () => reject(tx.error);
            });
            d.close();
          });
          await receiver
            .getByRole('button', {
              name: 'Save code-transfer-é.bin',
              exact: true,
            })
            .click();
          await expect(receiver.getByRole('alert')).toContainText(
            'unavailable or failed verification',
          );
        }
        if (mode === 'early' && browserName === 'chromium') {
          await receiver
            .getByText('Connection diagnostics', { exact: true })
            .click();
          const completed = JSON.parse(
            await receiver
              .getByLabel('Connection report', { exact: true })
              .innerText(),
          );
          expect(completed.candidateDelivery.added).toBeGreaterThan(0);
          await receiver
            .locator('.connection-panel')
            .screenshot({ path: 'docs/assets/connection-fixed.png' });
          await receiver
            .getByText('Connection diagnostics', { exact: true })
            .click();
        }

        if (explicitLan) {
          await receiver
            .getByText('Connection diagnostics', { exact: true })
            .click();
          const report = await receiver
            .getByLabel('Connection report', { exact: true })
            .innerText();
          expect(JSON.parse(report).lanCandidatesAdded).toBeGreaterThan(0);
          expect(report).not.toContain(lanAddress!);
          expect(signals.join('')).not.toContain(lanAddress!);
        }
        expect(signals.join('')).not.toContain(hash);
        expect(signals.join('')).not.toContain('code-transfer-é');
        expect(signals.every((message) => message.length < 32768)).toBe(true);
        expect(signals.some((message) => message.includes('CANDIDATE'))).toBe(
          true,
        );
        // Try the consumed code from a new sender; it must not create another session.
        const retry = await senderContext.newPage();
        await retry.goto('./');
        await retry
          .getByLabel('Receiver’s six-digit code', { exact: true })
          .fill(code);
        await retry
          .getByRole('button', { name: 'Connect', exact: true })
          .click();
        await expect(retry.getByRole('alert')).toContainText('unavailable', {
          timeout: 15000,
        });
        expect(connections).toHaveLength(3);
        await receiver
          .getByRole('button', { name: 'Revoke connection', exact: true })
          .click();
        if (mode === 'indexeddb' || safariReceiver) {
          await receiver.reload();
          await receiver
            .getByRole('button', { name: 'History', exact: true })
            .click();
          await expect(receiver.locator('.file-status').first()).toHaveText(
            'Exported copy verified',
          );
          // Clearing a verified exported batch must remove every stored chunk.
          receiver.once('dialog', (dialog) => void dialog.accept());
          await receiver
            .getByRole('button', {
              name: 'Clear verified staging',
              exact: true,
            })
            .click();
          await expect(receiver.locator('.alert[role="status"]')).toContainText(
            '1 staged copies cleared',
          );
          const remaining = await receiver.evaluate(async () => {
            const d = await new Promise<IDBDatabase>((resolve) => {
              const r = indexedDB.open('pixelgate-staging-v1', 1);
              r.onsuccess = () => resolve(r.result);
            });
            return new Promise<number>((resolve) => {
              const tx = d.transaction('chunks');
              const r = tx.objectStore('chunks').count();
              tx.oncomplete = () => {
                d.close();
                resolve(r.result);
              };
            });
          });
          expect(remaining).toBe(0);
        }
      } finally {
        await receiverContext.close();
        await senderContext.close();
        if (receiverBrowser !== senderBrowser) await receiverBrowser.close();
        await senderBrowser.close();
        for (const socket of sockets) socket.terminate();
        if (server)
          await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  );

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
    .getByRole('button', { name: 'Use copy/paste pairing', exact: true })
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
  const bytes = Buffer.alloc(8 * 1024 * 1024 + 111);
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
  await page
    .getByRole('button', { name: 'Receive files', exact: true })
    .click();
  await page.getByText('Advanced network settings', { exact: true }).click();
  await expect(
    page.getByLabel('Sender’s local IPv4 (optional)', { exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
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
    await page
      .getByRole('button', { name: 'Receive files', exact: true })
      .click();
    await page.getByText('Advanced network settings', { exact: true }).click();
    await expect(
      page.getByLabel('Sender’s local IPv4 (optional)', { exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  }
});

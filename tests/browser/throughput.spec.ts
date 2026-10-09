import { test, expect, chromium } from '@playwright/test';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';

test('parallel connections hide ACK latency, survive lane loss, and verify stored bytes', async ({
  browser,
  browserName,
}, testInfo) => {
  test.skip(
    browserName !== 'chromium' && !process.env.PIXELGATE_TEST_ALL_ENGINES,
    'Additional engines run in the explicit performance comparison.',
  );
  test.setTimeout(300000);
  const baseline = process.env.PIXELGATE_TEST_BASELINE_URL;
  const slowLink = Boolean(process.env.PIXELGATE_TEST_SLOW_LINK);
  const adaptivePaths = Boolean(process.env.PIXELGATE_TEST_ADAPTIVE_PATHS);
  const mixedPeers = Boolean(process.env.PIXELGATE_TEST_MIXED_PEERS);
  const measurements: { mode: string; milliseconds: number; bytes: number }[] =
    [];
  const payload = Buffer.alloc(
    Number(
      process.env.PIXELGATE_TEST_MIB ||
        (adaptivePaths ? 16 : slowLink ? 4 : baseline ? 32 : 8),
    ) *
      1024 *
      1024 +
      111,
    0x7b,
  );
  // Distinguish every transport frame so reordered/duplicated bytes cannot pass
  // simply because most of the benchmark payload repeats the same pattern.
  for (let offset = 0; offset + 4 <= payload.length; offset += 16 * 1024)
    payload.writeUInt32BE(offset / (16 * 1024), offset);
  const expected = createHash('sha256').update(payload).digest('hex');
  const payloadPath = testInfo.outputPath('throughput.bin');
  await writeFile(payloadPath, payload);
  const modes = mixedPeers
    ? ['mixed-receiver-local', 'mixed-sender-local', 'new-peers-local']
    : adaptivePaths
      ? [
          'baseline-paths-symmetric-local',
          'pipeline-paths-symmetric-local',
          'baseline-paths-asymmetric-local',
          'pipeline-paths-asymmetric-local',
          'baseline-paths-moderate-local',
          'pipeline-paths-moderate-local',
          'baseline-paths-recovery-local',
          'pipeline-paths-recovery-local',
          'baseline-paths-shared-local',
          'pipeline-paths-shared-local',
        ]
      : slowLink
        ? ['baseline-slow-link-local', 'pipeline-slow-link-local']
        : baseline
          ? [
              'baseline-local',
              'pipeline-local',
              'baseline-receipt-delay',
              'pipeline-receipt-delay',
              'baseline-ack-delay',
              'pipeline-ack-delay',
              'baseline-slow-lane',
              'pipeline-slow-lane',
              'baseline-lost-packet',
              'pipeline-lost-packet',
              'baseline-read-delay-local',
              'pipeline-read-delay-local',
            ]
          : [
              'legacy',
              'pipeline',
              'closed-lane',
              'unavailable-lanes',
              'legacy-local',
              'pipeline-local',
              'lost-packet',
              'slow-lane',
              'previous-release',
            ];
  const selectedModes = process.env.PIXELGATE_TEST_COMPARE_MODES
    ? process.env.PIXELGATE_TEST_COMPARE_MODES.split(',')
    : process.env.PIXELGATE_TEST_PATH_MODE
      ? modes.filter((mode) =>
          mode.includes(process.env.PIXELGATE_TEST_PATH_MODE!),
        )
      : modes;
  expect(selectedModes.length).toBeGreaterThan(0);
  const receivingBrowser =
    browserName === 'webkit'
      ? await chromium.launch({
          args: ['--disable-features=WebRtcHideLocalIpsWithMdns'],
        })
      : browser;
  try {
    for (const mode of selectedModes) {
      const receiving = await receivingBrowser.newContext();
      const sending = await browser.newContext();
      try {
        await receiving.addInitScript(
          ({ mode }) => {
            const metrics = {
              started: 0,
              bytes: 0,
              acks: [] as { offset: number; ms: number; received: number }[],
            };
            Object.assign(window, { receiveMetrics: metrics });
            const observed = new WeakSet<RTCDataChannel>();
            const original = RTCDataChannel.prototype.send;
            RTCDataChannel.prototype.send = function (data) {
              if (!observed.has(this)) {
                observed.add(this);
                this.addEventListener('message', ({ data }) => {
                  if (typeof data !== 'string') {
                    metrics.started ||= performance.now();
                    metrics.bytes += data.byteLength;
                  }
                });
              }
              if (typeof data === 'string') {
                const message = JSON.parse(data);
                if (mode.startsWith('legacy') && message.type === 'hello') {
                  delete message.stripedTransport;
                  data = JSON.stringify(message);
                }
                if (mode === 'previous-release' && message.type === 'hello') {
                  delete message.stripedReceipts;
                  delete message.stripedLanes;
                  data = JSON.stringify(message);
                }
                if (mode.startsWith('legacy') && message.type === 'ready') {
                  delete message.receiveWindowBytes;
                  data = JSON.stringify(message);
                }
                if (message.type === 'ack') {
                  metrics.acks.push({
                    offset: message.offset,
                    ms: performance.now() - metrics.started,
                    received: metrics.bytes,
                  });
                  const reply = data;
                  setTimeout(
                    () => {
                      if (this.readyState === 'open')
                        Reflect.apply(original, this, [reply]);
                    },
                    mode.endsWith('local') ? 0 : 150,
                  );
                  return;
                }
                if (
                  (mode.endsWith('receipt-delay') || mode.includes('rtt-')) &&
                  ['pg-striped-receipt', 'pg-striped-ack'].includes(
                    message.type,
                  )
                ) {
                  const reply = data;
                  setTimeout(
                    () => {
                      if (this.readyState === 'open')
                        Reflect.apply(original, this, [reply]);
                    },
                    mode.includes('rtt-') ? Number(mode.split('rtt-')[1]) : 80,
                  );
                  return;
                }
              }
              Reflect.apply(original, this, [data]);
            };
          },
          { mode },
        );
        await sending.addInitScript(
          ({ mode, faultBytes }) => {
            if (mode.includes('read-delay')) {
              const read = Blob.prototype.arrayBuffer;
              Blob.prototype.arrayBuffer = async function () {
                (
                  window as unknown as {
                    transferMetrics: { sourceReads: number };
                  }
                ).transferMetrics.sourceReads++;
                await new Promise((resolve) => setTimeout(resolve, 50));
                return read.call(this);
              };
            }
            if (mode === 'unavailable-lanes') {
              const create = RTCPeerConnection.prototype.createDataChannel;
              RTCPeerConnection.prototype.createDataChannel = function (
                label,
                options,
              ) {
                if (label === 'pixelgate-bulk-v1')
                  throw new DOMException(
                    'Injected unavailable lane',
                    'NotSupportedError',
                  );
                return create.call(this, label, options);
              };
            }
            const metrics = {
              started: 0,
              milliseconds: 0,
              bytes: 0,
              lastSend: 0,
              gaps: [] as number[],
              lowEvents: [] as number[],
              lanes: {} as Record<string, number>,
              droppedLane: false,
              sourceReads: 0,
              maximumPayloadFrameBytes: 0,
              binaryMessages: 0,
              queued: 0,
              queueSum: 0,
              queueSamples: 0,
            };
            let nextDelivery = 0;
            let delivered = 0;
            const pathQueues = new Map<
              RTCDataChannel,
              { next: number; index: number }
            >();
            const observed = new WeakSet<RTCDataChannel>();
            const delayedLanes = new WeakSet<RTCDataChannel>();
            let assignedDelayedLane = false;
            Object.assign(window, { transferMetrics: metrics });
            const original = RTCDataChannel.prototype.send;
            RTCDataChannel.prototype.send = function (data) {
              if (typeof data !== 'string') {
                if (
                  mode.endsWith('lost-packet') &&
                  this.label === 'pixelgate-bulk-v1' &&
                  metrics.bytes > (faultBytes || 1024 * 1024) &&
                  !metrics.droppedLane
                ) {
                  metrics.droppedLane = true;
                  return; // A vanished packet must be recovered by the application.
                }
                if (
                  mode === 'closed-lane' &&
                  this.label === 'pixelgate-bulk-v1' &&
                  metrics.bytes > (faultBytes || 1024 * 1024) &&
                  !metrics.droppedLane
                ) {
                  metrics.droppedLane = true;
                  this.close();
                  return;
                }
                if (!observed.has(this)) {
                  observed.add(this);
                  this.addEventListener('bufferedamountlow', () =>
                    metrics.lowEvents.push(performance.now() - metrics.started),
                  );
                }
                const now = performance.now();
                if (metrics.lastSend && now - metrics.lastSend > 40)
                  metrics.gaps.push(now - metrics.lastSend);
                metrics.lastSend = now;
                metrics.started ||= performance.now();
                const size = data instanceof Blob ? data.size : data.byteLength;
                const bytes =
                  data instanceof ArrayBuffer
                    ? data
                    : ArrayBuffer.isView(data)
                      ? data.buffer
                      : undefined;
                const striped =
                  bytes &&
                  size > 8 &&
                  new DataView(
                    bytes,
                    ArrayBuffer.isView(data) ? data.byteOffset : 0,
                  ).getUint32(0) === 0x50475331;
                metrics.bytes += size - (striped ? 8 : 0);
                metrics.maximumPayloadFrameBytes = Math.max(
                  metrics.maximumPayloadFrameBytes,
                  size - (striped ? 8 : 0),
                );
                metrics.binaryMessages++;
                metrics.lanes[this.label] =
                  (metrics.lanes[this.label] ?? 0) + size;
              } else {
                const message = JSON.parse(data);
                if (mode === 'previous-release' && message.type === 'hello') {
                  delete message.stripedReceipts;
                  delete message.stripedLanes;
                  data = JSON.stringify(message);
                }
                if (
                  message.type === 'finish' ||
                  (message.type === 'pg-striped-control' &&
                    JSON.parse(message.value).type === 'finish')
                )
                  metrics.milliseconds = performance.now() - metrics.started;
              }
              if (
                mode.endsWith('slow-lane') &&
                metrics.bytes > faultBytes &&
                typeof data !== 'string' &&
                this.label === 'pixelgate-bulk-v1'
              ) {
                if (!assignedDelayedLane) {
                  assignedDelayedLane = true;
                  delayedLanes.add(this);
                }
                if (delayedLanes.has(this)) {
                  const wire = data;
                  setTimeout(() => {
                    if (this.readyState === 'open')
                      Reflect.apply(original, this, [wire]);
                  }, 1500);
                  return;
                }
              }
              if (mode.includes('slow-link') && typeof data !== 'string') {
                const size = data instanceof Blob ? data.size : data.byteLength;
                const now = performance.now();
                const at = Math.max(now, nextDelivery);
                nextDelivery = at + (size / (256 * 1024)) * 1000;
                metrics.queued += size;
                setTimeout(() => {
                  metrics.queued -= size;
                  delivered += size;
                  if (delivered > 1024 * 1024) {
                    metrics.queueSum += metrics.queued;
                    metrics.queueSamples++;
                  }
                  if (this.readyState === 'open')
                    Reflect.apply(original, this, [data]);
                }, at - now);
                return;
              }
              if (mode.includes('paths-') && typeof data !== 'string') {
                let path = pathQueues.get(this);
                if (!path) {
                  path = { next: 0, index: pathQueues.size };
                  pathQueues.set(this, path);
                }
                const size = data instanceof Blob ? data.size : data.byteLength;
                const now = performance.now();
                const elapsed = now - metrics.started;
                const asymmetric =
                  mode.includes('asymmetric') ||
                  (mode.includes('recovery') && elapsed < 2000);
                const moderate = mode.includes('moderate') && path.index === 1;
                const slow = asymmetric && path.index === 1;
                const rate = moderate
                  ? 400 * 1024
                  : slow
                    ? 256 * 1024
                    : 1024 * 1024;
                const latency = slow ? 120 : 15;
                const shared = mode.includes('shared');
                const at =
                  Math.max(now, shared ? nextDelivery : path.next) +
                  (size / rate) * 1000;
                if (shared) nextDelivery = at;
                else path.next = at;
                metrics.queued += size;
                setTimeout(
                  () => {
                    metrics.queued -= size;
                    delivered += size;
                    if (delivered > 1024 * 1024) {
                      metrics.queueSum += metrics.queued;
                      metrics.queueSamples++;
                    }
                    if (this.readyState === 'open')
                      Reflect.apply(original, this, [data]);
                  },
                  at + latency - now,
                );
                return;
              }
              Reflect.apply(original, this, [data]);
            };
          },
          {
            mode,
            faultBytes:
              Number(process.env.PIXELGATE_TEST_FAULT_MIB || 0) * 1024 * 1024,
          },
        );
        const receiver = await receiving.newPage();
        const sender = await sending.newPage();
        await receiver.goto(
          baseline &&
            (mode.startsWith('baseline-') || mode === 'mixed-receiver-local')
            ? baseline
            : './',
        );
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
        const senderLink = await link.inputValue();
        if (mixedPeers) {
          const pairing = new URL(senderLink);
          const landing = new URL(
            mode === 'mixed-sender-local'
              ? baseline!
              : testInfo.project.use.baseURL!,
          );
          landing.search = pairing.search;
          landing.hash = pairing.hash;
          await sender.goto(landing.href);
        } else await sender.goto(senderLink);
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
        await expect(
          sender.getByText('Connected', { exact: true }),
        ).toBeVisible({
          timeout: 45000,
        });
        await sender
          .getByLabel('Choose files', { exact: true })
          .setInputFiles(payloadPath);
        await sender
          .getByRole('button', { name: 'Send files', exact: true })
          .last()
          .click();
        await expect(sender.locator('.file-status').first())
          .toHaveText('Browser copy verified', { timeout: 60000 })
          .catch(async (error) => {
            console.log(
              JSON.stringify({
                failedMode: mode,
                senderAlerts: await sender.getByRole('alert').allTextContents(),
                receiverAlerts: await receiver
                  .getByRole('alert')
                  .allTextContents(),
                senderFiles: await sender.locator('.file-list').innerText(),
                receiverFiles: await receiver.locator('.file-list').innerText(),
                senderReport: await sender
                  .getByLabel('Connection report', { exact: true })
                  .textContent()
                  .catch(() => null),
                receiverReport: await receiver
                  .getByLabel('Connection report', { exact: true })
                  .textContent()
                  .catch(() => null),
                metrics: await sender.evaluate(() =>
                  Reflect.get(window, 'transferMetrics'),
                ),
              }),
            );
            throw error;
          });
        const metrics = await sender.evaluate(
          () =>
            (
              window as unknown as {
                transferMetrics: {
                  milliseconds: number;
                  bytes: number;
                  droppedLane: boolean;
                  lanes: Record<string, number>;
                  queueSum: number;
                  queueSamples: number;
                  sourceReads: number;
                  maximumPayloadFrameBytes: number;
                  binaryMessages: number;
                };
              }
            ).transferMetrics,
        );
        const report = await sender
          .getByLabel('Connection report', { exact: true })
          .textContent()
          .catch(() => null);
        const transport = report ? JSON.parse(report).transfer : undefined;
        console.log(
          JSON.stringify({
            mode,
            milliseconds: metrics.milliseconds,
            lanes: metrics.lanes,
            averageQueuedBytes: metrics.queueSum / (metrics.queueSamples || 1),
            sourceReads: metrics.sourceReads,
            transport,
            maximumPayloadFrameBytes: metrics.maximumPayloadFrameBytes,
            binaryMessages: metrics.binaryMessages,
          }),
        );
        if (mode === 'closed-lane' || mode.endsWith('lost-packet')) {
          expect(metrics.droppedLane).toBe(true);
          expect(metrics.bytes).toBeGreaterThanOrEqual(payload.length);
        } else if (mode.endsWith('slow-lane'))
          expect(metrics.bytes).toBeGreaterThanOrEqual(payload.length);
        else if (mode.includes('paths-'))
          expect(metrics.bytes).toBeGreaterThanOrEqual(payload.length);
        else if (transport?.replayedPackets) {
          // Natural transport recovery can replay retained frames as well.
          // At most three retries per packet; the independent stored hash below
          // is the byte-integrity assertion, not a ban on legitimate replays.
          expect(metrics.bytes).toBeGreaterThanOrEqual(payload.length);
          expect(metrics.bytes).toBeLessThanOrEqual(payload.length * 4);
        } else expect(metrics.bytes).toBe(payload.length);
        if (!mode.startsWith('legacy') && mode !== 'unavailable-lanes')
          expect(metrics.lanes['pixelgate-bulk-v1'], mode).toBeGreaterThan(0);
        if (mode.includes('read-delay')) expect(metrics.sourceReads).toBe(33);
        if (mode === 'unavailable-lanes')
          expect(metrics.lanes['pixelgate-bulk-v1']).toBeUndefined();
        expect(metrics.milliseconds).toBeGreaterThan(0);
        if (mixedPeers)
          expect(metrics.maximumPayloadFrameBytes).toBe(
            mode === 'new-peers-local'
              ? 64 * 1024 - 8
              : Number(
                  process.env.PIXELGATE_TEST_BASELINE_FRAME_BYTES || 16 * 1024,
                ),
          );
        const receiverMetrics = await receiver.evaluate(
          () =>
            (window as unknown as { receiveMetrics: object }).receiveMetrics,
        );
        measurements.push({
          mode,
          ...metrics,
          ...{ receiverMetrics, transport },
        });
        const storedHash = await receiver.evaluate(async () => {
          const root = await (
            await navigator.storage.getDirectory()
          ).getDirectoryHandle('pixelbridge');
          const database = await new Promise<IDBDatabase>((resolve) => {
            const request = indexedDB.open('pixelbridge-v1', 3);
            request.onsuccess = () => resolve(request.result);
          });
          const records = await new Promise<{ id: string }[]>((resolve) => {
            const request = database
              .transaction('files')
              .objectStore('files')
              .getAll();
            request.onsuccess = () => resolve(request.result);
          });
          database.close();
          const file = await (
            await root.getFileHandle(records[0].id)
          ).getFile();
          const hash = await crypto.subtle.digest(
            'SHA-256',
            await file.arrayBuffer(),
          );
          return Array.from(new Uint8Array(hash), (byte) =>
            byte.toString(16).padStart(2, '0'),
          ).join('');
        });
        expect(storedHash).toBe(expected);
        if (mode === 'pipeline-local') {
          await sender
            .getByRole('button', { name: 'Disconnect', exact: true })
            .click();
          await expect(
            sender.getByText('Not connected', { exact: true }),
          ).toBeVisible();
          const saved = await sender
            .getByLabel('Connection report', { exact: true })
            .textContent();
          expect(saved).not.toContain('throughput.bin');
          expect(saved).not.toContain(expected);
          const withoutBrowserVersion = JSON.parse(saved!);
          delete withoutBrowserVersion.browser;
          expect(JSON.stringify(withoutBrowserVersion)).not.toMatch(
            /(?:\d{1,3}\.){3}\d{1,3}/,
          );
          expect(JSON.parse(saved!).transfer.connections).toBe(5);
          await sender
            .getByRole('button', { name: 'Clear queue', exact: true })
            .click();
          await expect(
            sender.getByLabel('Connection report', { exact: true }),
          ).toHaveText(saved!);
          await sender.reload();
          await expect(
            sender.getByLabel('Connection report', { exact: true }),
          ).toHaveText(saved!);
          await sender
            .getByText('Connection diagnostics', { exact: true })
            .click();
          await sender.setViewportSize({ width: 320, height: 700 });
          await sender.addStyleTag({ content: 'html { font-size: 200%; }' });
          expect(
            await sender.evaluate(
              () => document.documentElement.scrollWidth <= innerWidth,
            ),
          ).toBe(true);
          await sender
            .getByRole('button', { name: 'Clear saved report', exact: true })
            .click();
          await sender.reload();
          await expect(
            sender.getByLabel('Connection report', { exact: true }),
          ).toHaveCount(0);
        }
      } finally {
        await sending.close();
        await receiving.close();
      }
    }
  } finally {
    if (receivingBrowser !== browser) await receivingBrowser.close();
  }
  const measurementsPath = testInfo.outputPath('checkpoint-throughput.json');
  await writeFile(measurementsPath, JSON.stringify(measurements, null, 2));
  await testInfo.attach('checkpoint-throughput.json', {
    path: measurementsPath,
    contentType: 'application/json',
  });
  if (baseline) {
    if (process.env.PIXELGATE_TEST_COMPARE_MODES) {
      for (let index = 0; index < measurements.length; index += 2)
        expect(measurements[index + 1].milliseconds).toBeLessThan(
          measurements[index].milliseconds * 1.25,
        );
      return;
    }
    if (mixedPeers) return;
    if (adaptivePaths) {
      for (let index = 0; index < measurements.length; index += 2)
        expect(measurements[index + 1].milliseconds).toBeLessThan(
          measurements[index].milliseconds * 1.1,
        );
      return;
    }
    if (slowLink) {
      const baselineMetrics = measurements[0] as (typeof measurements)[0] & {
        queueSum: number;
        queueSamples: number;
      };
      const candidateMetrics = measurements[1] as (typeof measurements)[0] & {
        queueSum: number;
        queueSamples: number;
      };
      expect(
        candidateMetrics.queueSum / candidateMetrics.queueSamples,
      ).toBeLessThan(
        (baselineMetrics.queueSum / baselineMetrics.queueSamples) * 0.75,
      );
      expect(measurements[1].milliseconds).toBeLessThan(
        measurements[0].milliseconds * 1.1,
      );
      return;
    }
    expect(measurements[3].milliseconds).toBeLessThan(
      measurements[2].milliseconds * 0.75,
    );
    for (const index of [0, 4, 6, 8, 10])
      expect(measurements[index + 1].milliseconds).toBeLessThan(
        measurements[index].milliseconds * 1.25,
      );
    return;
  }
  if (process.env.PIXELGATE_TEST_COMPARE_MODES) return;
  expect(measurements[1].milliseconds).toBeLessThan(
    measurements[0].milliseconds * 0.75,
  );
  expect(measurements[5].milliseconds).toBeLessThan(
    measurements[4].milliseconds * 1.25,
  );
});

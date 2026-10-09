import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';

test('parallel connections hide ACK latency, survive lane loss, and verify stored bytes', async ({
  browser,
  browserName,
}, testInfo) => {
  test.skip(browserName !== 'chromium', 'One controlled latency comparison.');
  test.setTimeout(300000);
  const baseline = process.env.PIXELGATE_TEST_BASELINE_URL;
  const slowLink = Boolean(process.env.PIXELGATE_TEST_SLOW_LINK);
  const measurements: { mode: string; milliseconds: number; bytes: number }[] =
    [];
  const payload = Buffer.alloc(
    (slowLink ? 4 : baseline ? 32 : 8) * 1024 * 1024 + 111,
    0x7b,
  );
  // Distinguish every transport frame so reordered/duplicated bytes cannot pass
  // simply because most of the benchmark payload repeats the same pattern.
  for (let offset = 0; offset + 4 <= payload.length; offset += 16 * 1024)
    payload.writeUInt32BE(offset / (16 * 1024), offset);
  const expected = createHash('sha256').update(payload).digest('hex');
  const modes = slowLink
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
  for (const mode of modes) {
    const receiving = await browser.newContext();
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
                mode.endsWith('receipt-delay') &&
                ['pg-striped-receipt', 'pg-striped-ack'].includes(message.type)
              ) {
                const reply = data;
                setTimeout(() => {
                  if (this.readyState === 'open')
                    Reflect.apply(original, this, [reply]);
                }, 80);
                return;
              }
            }
            Reflect.apply(original, this, [data]);
          };
        },
        { mode },
      );
      await sending.addInitScript(
        ({ mode }) => {
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
            queued: 0,
            queueSum: 0,
            queueSamples: 0,
          };
          let nextDelivery = 0;
          let delivered = 0;
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
                metrics.bytes > 1024 * 1024 &&
                !metrics.droppedLane
              ) {
                metrics.droppedLane = true;
                return; // A vanished packet must be recovered by the application.
              }
              if (
                mode === 'closed-lane' &&
                this.label === 'pixelgate-bulk-v1' &&
                metrics.bytes > 1024 * 1024 &&
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
            Reflect.apply(original, this, [data]);
          };
        },
        { mode },
      );
      const receiver = await receiving.newPage();
      const sender = await sending.newPage();
      await receiver.goto(
        baseline && mode.startsWith('baseline-') ? baseline : './',
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
      await sender.getByLabel('Choose files', { exact: true }).setInputFiles({
        name: 'throughput.bin',
        mimeType: 'application/octet-stream',
        buffer: payload,
      });
      await sender
        .getByRole('button', { name: 'Send files', exact: true })
        .last()
        .click();
      await expect(sender.locator('.file-status').first()).toHaveText(
        'Browser copy verified',
        { timeout: 60000 },
      );
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
              };
            }
          ).transferMetrics,
      );
      console.log(
        JSON.stringify({
          mode,
          milliseconds: metrics.milliseconds,
          lanes: metrics.lanes,
          averageQueuedBytes: metrics.queueSum / (metrics.queueSamples || 1),
          sourceReads: metrics.sourceReads,
        }),
      );
      if (mode === 'closed-lane' || mode.endsWith('lost-packet')) {
        expect(metrics.droppedLane).toBe(true);
        expect(metrics.bytes).toBeGreaterThanOrEqual(payload.length);
      } else if (mode.endsWith('slow-lane'))
        expect(metrics.bytes).toBeGreaterThanOrEqual(payload.length);
      else expect(metrics.bytes).toBe(payload.length);
      if (!mode.startsWith('legacy') && mode !== 'unavailable-lanes')
        expect(metrics.lanes['pixelgate-bulk-v1'], mode).toBeGreaterThan(0);
      if (mode.includes('read-delay')) expect(metrics.sourceReads).toBe(33);
      if (mode === 'unavailable-lanes')
        expect(metrics.lanes['pixelgate-bulk-v1']).toBeUndefined();
      expect(metrics.milliseconds).toBeGreaterThan(0);
      const receiverMetrics = await receiver.evaluate(
        () => (window as unknown as { receiveMetrics: object }).receiveMetrics,
      );
      measurements.push({ mode, ...metrics, ...{ receiverMetrics } });
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
        const file = await (await root.getFileHandle(records[0].id)).getFile();
        const hash = await crypto.subtle.digest(
          'SHA-256',
          await file.arrayBuffer(),
        );
        return Array.from(new Uint8Array(hash), (byte) =>
          byte.toString(16).padStart(2, '0'),
        ).join('');
      });
      expect(storedHash).toBe(expected);
    } finally {
      await sending.close();
      await receiving.close();
    }
  }
  const measurementsPath = testInfo.outputPath('checkpoint-throughput.json');
  await writeFile(measurementsPath, JSON.stringify(measurements, null, 2));
  await testInfo.attach('checkpoint-throughput.json', {
    path: measurementsPath,
    contentType: 'application/json',
  });
  if (baseline) {
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
  expect(measurements[1].milliseconds).toBeLessThan(
    measurements[0].milliseconds * 0.75,
  );
  expect(measurements[5].milliseconds).toBeLessThan(
    measurements[4].milliseconds * 1.25,
  );
});

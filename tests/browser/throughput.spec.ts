import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';

test('parallel connections hide ACK latency, survive lane loss, and verify stored bytes', async ({
  browser,
  browserName,
}, testInfo) => {
  test.skip(browserName !== 'chromium', 'One controlled latency comparison.');
  const measurements: { mode: string; milliseconds: number; bytes: number }[] =
    [];
  const payload = Buffer.alloc(8 * 1024 * 1024 + 111, 0x7b);
  const expected = createHash('sha256').update(payload).digest('hex');
  for (const mode of [
    'legacy',
    'pipeline',
    'closed-lane',
    'unavailable-lanes',
    'legacy-local',
    'pipeline-local',
  ]) {
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
            }
            Reflect.apply(original, this, [data]);
          };
        },
        { mode },
      );
      await sending.addInitScript(
        ({ mode }) => {
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
          };
          const observed = new WeakSet<RTCDataChannel>();
          Object.assign(window, { transferMetrics: metrics });
          const original = RTCDataChannel.prototype.send;
          RTCDataChannel.prototype.send = function (data) {
            if (typeof data !== 'string') {
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
              if (
                message.type === 'finish' ||
                (message.type === 'pg-striped-control' &&
                  JSON.parse(message.value).type === 'finish')
              )
                metrics.milliseconds = performance.now() - metrics.started;
            }
            Reflect.apply(original, this, [data]);
          };
        },
        { mode },
      );
      const receiver = await receiving.newPage();
      const sender = await sending.newPage();
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
              };
            }
          ).transferMetrics,
      );
      if (mode === 'closed-lane') {
        expect(metrics.droppedLane).toBe(true);
        expect(metrics.bytes).toBeGreaterThanOrEqual(payload.length);
      } else expect(metrics.bytes).toBe(payload.length);
      if (['pipeline', 'pipeline-local', 'closed-lane'].includes(mode))
        expect(metrics.lanes['pixelgate-bulk-v1']).toBeGreaterThan(0);
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
  expect(measurements[1].milliseconds).toBeLessThan(
    measurements[0].milliseconds * 0.75,
  );
  expect(measurements[5].milliseconds).toBeLessThan(
    measurements[4].milliseconds * 1.25,
  );
});

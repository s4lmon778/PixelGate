import { createSocket } from 'node:dgram';
import { createHash } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, webkit, expect } from '@playwright/test';

// Synthetic bytes in isolated contexts; this is a native UDP latency model,
// not a physical iPhone/Pixel Wi-Fi benchmark.
const latency = Number(process.env.PIXELGATE_NATIVE_ONE_WAY_MS || 0);
const variant = process.env.PIXELGATE_NATIVE_LABEL || 'candidate';
const storageDelay = Number(process.env.PIXELGATE_NATIVE_STORAGE_DELAY_MS || 0);
const trial = process.env.PIXELGATE_NATIVE_TRIAL || '1';
const bytes =
  Number(process.env.PIXELGATE_NATIVE_MIB || 32) * 1024 * 1024 + 111;
const url = process.env.PIXELGATE_NATIVE_URL || 'http://127.0.0.1:8787/';
const parsedURL = new URL(url);
if (
  parsedURL.protocol !== 'http:' ||
  !['127.0.0.1', 'localhost'].includes(parsedURL.hostname) ||
  parsedURL.username ||
  parsedURL.password
)
  throw new Error(
    'Serve the preserved build on localhost for this isolated proxy model.',
  );
if (
  !Number.isSafeInteger(bytes) ||
  bytes < 1024 * 1024 ||
  bytes > 512 * 1024 * 1024 + 111 ||
  !Number.isInteger(latency) ||
  latency < 0 ||
  latency > 1000 ||
  !Number.isInteger(storageDelay) ||
  storageDelay < 0 ||
  storageDelay > 1000
)
  throw new Error('Invalid benchmark bounds: 1–512 MiB and 0–1000 ms delays.');
const root = await mkdtemp(join(tmpdir(), 'pixelgate-native-transfer-'));
const payload = Buffer.alloc(bytes, 0x7b);
for (let offset = 0; offset + 4 < bytes; offset += 16384)
  payload.writeUInt32BE(offset / 16384, offset);
const expected = createHash('sha256').update(payload).digest('hex');
await writeFile(root + '/proxy-source.bin', payload);
const pairs = [];
const hostAddress = Object.values(networkInterfaces())
  .flat()
  .find((value) => value?.family === 'IPv4' && !value.internal)?.address;
const timers = new Set();
const stats = { packets: 0, bytes: 0, queuedBytes: 0, maxQueuedBytes: 0 };
for (let index = 0; index < 10; index++) {
  const sockets = [createSocket('udp4'), createSocket('udp4')];
  for (const socket of sockets)
    await new Promise((resolve) => socket.bind(0, '127.0.0.1', resolve));
  const pair = { sockets, targets: [undefined, undefined] };
  sockets.forEach((socket, side) =>
    socket.on('message', (packet) => {
      const target = pair.targets[side];
      if (!target) return;
      stats.packets++;
      stats.bytes += packet.length;
      stats.queuedBytes += packet.length;
      stats.maxQueuedBytes = Math.max(stats.maxQueuedBytes, stats.queuedBytes);
      const timer = setTimeout(() => {
        timers.delete(timer);
        stats.queuedBytes -= packet.length;
        sockets[1 - side].send(packet, target.port, target.address);
      }, latency);
      timers.add(timer);
    }),
  );
  pairs.push(pair);
}
const sendingBrowser = await webkit.launch();
const receiving = await chromium.launchPersistentContext(
  join(root, 'receiver-profile'),
  {
    executablePath: process.env.PIXELGATE_NATIVE_RECEIVER_EXECUTABLE,
    args: ['--disable-features=WebRtcHideLocalIpsWithMdns'],
  },
);
const sending = await sendingBrowser.newContext();
for (const page of receiving.pages()) await page.close();
try {
  if (storageDelay > 0) {
    await receiving.addInitScript(() =>
      Object.defineProperty(navigator.storage, 'getDirectory', {
        value: undefined,
      }),
    );
    await receiving.route('**/assets/staging.worker-*.js', async (route) => {
      const response = await route.fetch();
      const prefix =
        "const completion=Object.getOwnPropertyDescriptor(IDBTransaction.prototype,'oncomplete'); Object.defineProperty(IDBTransaction.prototype,'oncomplete',{...completion,set(callback){completion.set.call(this,event=>setTimeout(()=>callback.call(this,event)," +
        storageDelay +
        '));}});';
      await route.fulfill({ response, body: prefix + (await response.text()) });
    });
  }
  for (const [context, side] of [
    [sending, 0],
    [receiving, 1],
  ]) {
    await context.exposeBinding(
      'proxyEndpoint',
      (_source, index, address, port) => {
        if (!pairs[index]) throw new Error('Too many test connections');
        pairs[index].targets[side] ??= {
          address: address.endsWith('.local')
            ? pairs[index].targets[1]?.address || hostAddress
            : address,
          port,
        };
      },
    );
    await context.addInitScript(
      ({ ports }) => {
        let next = 0;
        const Native = window.RTCPeerConnection;
        const ids = new WeakMap();
        const selected = new Map();
        window.proxyDebug = { candidates: [], states: [] };
        function rewrite(candidate, index) {
          const fields = candidate.trim().split(/\s+/);
          window.proxyDebug.candidates.push({
            index,
            protocol: fields[2],
            type: fields[7],
            addressKind: fields[4]?.endsWith('.local')
              ? 'mdns'
              : fields[4]?.includes(':')
                ? 'ipv6'
                : 'ipv4',
          });
          if (
            fields[2]?.toLowerCase() !== 'udp' ||
            fields[7] !== 'host' ||
            !(
              /^\d+\.\d+\.\d+\.\d+$/.test(fields[4]) ||
              fields[4].endsWith('.local')
            )
          )
            return;
          if (!selected.has(index)) {
            selected.set(index, {
              address: fields[4],
              port: Number(fields[5]),
            });
            window.proxyEndpoint(index, fields[4], Number(fields[5]));
          }
          const target = selected.get(index);
          if (target.address !== fields[4] || target.port !== Number(fields[5]))
            return;
          fields[4] = '127.0.0.1';
          fields[5] = String(ports[index]);
          return fields.join(' ');
        }
        const local = Object.getOwnPropertyDescriptor(
          Native.prototype,
          'localDescription',
        );
        const ice = Object.getOwnPropertyDescriptor(
          Native.prototype,
          'onicecandidate',
        );
        function id(pc) {
          if (!ids.has(pc)) {
            ids.set(pc, next++);
            pc.addEventListener('iceconnectionstatechange', () =>
              window.proxyDebug.states.push({
                index: ids.get(pc),
                state: pc.iceConnectionState,
              }),
            );
          }
          return ids.get(pc);
        }
        window.installProxy = () => {
          Object.defineProperty(Native.prototype, 'localDescription', {
            ...local,
            get() {
              const value = local.get.call(this);
              if (!value) return null;
              const sdp = value.sdp
                .split('\r\n')
                .flatMap((line) => {
                  if (!line.startsWith('a=candidate:')) return [line];
                  const candidate = rewrite(line.slice(2), id(this));
                  return candidate ? ['a=' + candidate] : [];
                })
                .join('\r\n');
              return new RTCSessionDescription({ type: value.type, sdp });
            },
          });
          Object.defineProperty(Native.prototype, 'onicecandidate', {
            ...ice,
            set(callback) {
              const index = id(this);
              window.proxyDebug.states.push({ index, state: 'handler-set' });
              ice.set.call(
                this,
                callback
                  ? (event) => {
                      if (!event.candidate) return callback.call(this, event);
                      const candidate = rewrite(
                        event.candidate.candidate,
                        index,
                      );
                      if (candidate)
                        callback.call(this, {
                          candidate: new RTCIceCandidate({
                            ...event.candidate.toJSON(),
                            candidate,
                          }),
                        });
                    }
                  : null,
              );
            },
          });
        };
        window.installProxy();
        const metrics = { started: 0, milliseconds: 0, bytes: 0 };
        window.nativeMetrics = metrics;
        const send = RTCDataChannel.prototype.send;
        RTCDataChannel.prototype.send = function (data) {
          if (typeof data !== 'string') {
            metrics.started ||= performance.now();
            metrics.bytes += data.byteLength;
          } else {
            const message = JSON.parse(data);
            if (
              message.type === 'finish' ||
              (message.type === 'pg-striped-control' &&
                JSON.parse(message.value).type === 'finish')
            )
              metrics.milliseconds = performance.now() - metrics.started;
          }
          return Reflect.apply(send, this, [data]);
        };
      },
      { ports: pairs.map((pair) => pair.sockets[side].address().port) },
    );
  }
  const receiver = await receiving.newPage(),
    sender = await sending.newPage();
  const errors = [];
  for (const page of [receiver, sender])
    page.on('pageerror', (error) => errors.push(error.message));
  await receiver.goto(url);
  await receiver.evaluate(() => window.installProxy());
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
  await sender.evaluate(() => window.installProxy());
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
    .setInputFiles(root + '/proxy-source.bin');
  const start = Date.now();
  await sender
    .getByRole('button', { name: 'Send files', exact: true })
    .last()
    .click();
  await sender.waitForFunction(
    () =>
      ['Browser copy verified', 'Needs retry'].includes(
        document.querySelector('.file-status')?.textContent,
      ),
    undefined,
    { timeout: 180000 },
  );
  await expect(sender.locator('.file-status').first()).toHaveText(
    'Browser copy verified',
    { timeout: 1000 },
  );
  const endToEndMs = Date.now() - start;
  const storedHash = await receiver.evaluate(async () => {
    const db = await new Promise((resolve) => {
      const r = indexedDB.open('pixelbridge-v1', 3);
      r.onsuccess = () => resolve(r.result);
    });
    const records = await new Promise((resolve) => {
      const r = db.transaction('files').objectStore('files').getAll();
      r.onsuccess = () => resolve(r.result);
    });
    db.close();
    let file;
    if (navigator.storage.getDirectory) {
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle('pixelbridge');
      file = await (await dir.getFileHandle(records[0].id)).getFile();
    } else {
      const staging = await new Promise((resolve) => {
        const r = indexedDB.open('pixelgate-staging-v1', 1);
        r.onsuccess = () => resolve(r.result);
      });
      const chunks = await new Promise((resolve) => {
        const r = staging
          .transaction('chunks')
          .objectStore('chunks')
          .getAll(
            IDBKeyRange.bound(
              [records[0].id, 0],
              [records[0].id, Number.MAX_SAFE_INTEGER],
            ),
          );
        r.onsuccess = () => resolve(r.result);
      });
      file = new Blob(chunks.map((chunk) => chunk.bytes));
      staging.close();
    }
    const hash = await crypto.subtle.digest(
      'SHA-256',
      await file.arrayBuffer(),
    );
    return Array.from(new Uint8Array(hash), (value) =>
      value.toString(16).padStart(2, '0'),
    ).join('');
  });
  expect(storedHash).toBe(expected);
  expect(errors).toEqual([]);
  const report = JSON.parse(
    await sender.getByLabel('Connection report', { exact: true }).textContent(),
  );
  const receivingReport = JSON.parse(
    await receiver
      .getByLabel('Connection report', { exact: true })
      .textContent(),
  );
  const result = {
    variant,
    latency,
    storageDelay,
    trial,
    bytes,
    endToEndMs,
    receivingReport,
    metrics: await sender.evaluate(() => window.nativeMetrics),
    stats,
    report,
    hashMatched: true,
    connectionsProxied: pairs.filter((pair) => pair.targets.every(Boolean))
      .length,
  };
  expect(result.connectionsProxied).toBe(report.transfer.connections);
  expect(result.stats.bytes).toBeGreaterThanOrEqual(bytes);
  const resultPath =
    process.env.PIXELGATE_NATIVE_RESULT || join(root, 'result.json');
  await writeFile(resultPath, JSON.stringify(result, null, 2) + '\n');
  console.log('Benchmark record: ' + resultPath);
  console.log(
    JSON.stringify({
      variant,
      latency,
      bytes,
      endToEndMs,
      milliseconds: result.metrics.milliseconds,
      connections: report.transfer.connections,
      connectionsProxied: result.connectionsProxied,
      stats,
      hashMatched: true,
      targets: pairs.map((pair) => pair.targets.map(Boolean)),
      senderIndices: await sender.evaluate(() => [
        ...new Set(window.proxyDebug.candidates.map((row) => row.index)),
      ]),
      senderStates: await sender.evaluate(() => window.proxyDebug.states),
      receiverIndices: await receiver.evaluate(() => [
        ...new Set(window.proxyDebug.candidates.map((row) => row.index)),
      ]),
    }),
  );
} catch (error) {
  console.log(
    JSON.stringify({
      stats,
      targets: pairs.map((pair) => pair.targets.map(Boolean)),
      senderDebug: await sending.pages()[0].evaluate(() => window.proxyDebug),
      receiverDebug: await receiving
        .pages()[0]
        .evaluate(() => window.proxyDebug),
      senderAlerts: await sending
        .pages()[0]
        .getByRole('alert')
        .allTextContents(),
      receiverAlerts: await receiving
        .pages()[0]
        .getByRole('alert')
        .allTextContents(),
      senderReport: await sending
        .pages()[0]
        .getByLabel('Connection report', { exact: true })
        .textContent()
        .catch(() => null),
      receiverReport: await receiving
        .pages()[0]
        .getByLabel('Connection report', { exact: true })
        .textContent()
        .catch(() => null),
      senderFiles: await sending
        .pages()[0]
        .locator('.file-list')
        .innerText()
        .catch(() => null),
      receiverFiles: await receiving
        .pages()[0]
        .locator('.file-list')
        .innerText()
        .catch(() => null),
      metrics: await sending
        .pages()[0]
        .evaluate(() => window.nativeMetrics)
        .catch(() => null),
    }),
  );
  throw error;
} finally {
  await sending.close();
  await receiving.close();
  await sendingBrowser.close();
  for (const timer of timers) clearTimeout(timer);
  for (const pair of pairs) for (const socket of pair.sockets) socket.close();
  await rm(join(root, 'proxy-source.bin'), { force: true });
  await rm(join(root, 'receiver-profile'), { recursive: true, force: true });
}

import { createSocket } from 'node:dgram';
import { createHash } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, webkit, expect } from '@playwright/test';

// Synthetic bytes in isolated contexts; this is a native UDP latency model,
// not a physical iPhone/Pixel Wi-Fi benchmark.
const lossPermille = Number(process.env.PIXELGATE_NATIVE_LOSS_PERMILLE || 0);
if (!Number.isInteger(lossPermille) || lossPermille < 0 || lossPermille > 100)
  throw new Error('Loss must be 0–100 per mille.');
const lossSeed = Number(process.env.PIXELGATE_NATIVE_LOSS_SEED || 7);
if (!Number.isInteger(lossSeed) || lossSeed < 0 || lossSeed > 0xffffffff)
  throw new Error('Invalid loss seed.');
let randomState = lossSeed >>> 0;
const sourceCPU = Number(process.env.PIXELGATE_NATIVE_SOURCE_CPU || 1);
const receiverCPU = Number(process.env.PIXELGATE_NATIVE_RECEIVER_CPU || 1);
if (!Number.isInteger(receiverCPU) || receiverCPU < 1 || receiverCPU > 20)
  throw new Error('Invalid receiver CPU model.');
if (!Number.isInteger(sourceCPU) || sourceCPU < 1 || sourceCPU > 20)
  throw new Error('Source CPU model must be an integer from 1 to 20.');
const latency = Number(process.env.PIXELGATE_NATIVE_ONE_WAY_MS || 0);
const slowPathCount = Number(process.env.PIXELGATE_NATIVE_SLOW_PATHS || 0);
const slowPathStart = Number(process.env.PIXELGATE_NATIVE_SLOW_PATH_START || 1);
const slowPathMs = Number(process.env.PIXELGATE_NATIVE_SLOW_PATH_MS || 0);
if (
  !Number.isInteger(slowPathCount) ||
  slowPathCount < 0 ||
  slowPathCount > 13 ||
  !Number.isInteger(slowPathStart) ||
  slowPathStart < 0 ||
  slowPathStart + slowPathCount > 14 ||
  !Number.isInteger(slowPathMs) ||
  slowPathMs < 0 ||
  slowPathMs > 1000
)
  throw new Error('Invalid asymmetric-path delay.');
const linkBytesPerSecond = Number(
  process.env.PIXELGATE_NATIVE_LINK_BYTES_PER_SECOND || 0,
);
if (
  !Number.isSafeInteger(linkBytesPerSecond) ||
  linkBytesPerSecond < 0 ||
  (linkBytesPerSecond > 0 &&
    (linkBytesPerSecond < 1024 * 1024 ||
      linkBytesPerSecond > 1024 * 1024 * 1024))
)
  throw new Error('Shared link must be zero or 1 MiB/s–1 GiB/s.');
let transmissionAt = 0;
const variant = process.env.PIXELGATE_NATIVE_LABEL || 'candidate';
const receiverEngine =
  process.env.PIXELGATE_NATIVE_RECEIVER_ENGINE || 'chromium';
if (receiverEngine === 'webkit' && receiverCPU > 1)
  throw new Error('Receiver CPU model requires Chromium.');
if (!['chromium', 'webkit'].includes(receiverEngine))
  throw new Error('Receiver engine must be chromium or webkit.');
if (
  receiverEngine === 'webkit' &&
  process.env.PIXELGATE_NATIVE_RECEIVER_EXECUTABLE
)
  throw new Error('Custom receiver executable is supported only for Chromium.');
const storageDelay = Number(process.env.PIXELGATE_NATIVE_STORAGE_DELAY_MS || 0);
const sourceDelay = Number(
  process.env.PIXELGATE_NATIVE_SOURCE_READ_DELAY_MS || 0,
);
if (!Number.isInteger(sourceDelay) || sourceDelay < 0 || sourceDelay > 1000)
  throw new Error('Invalid source delay');
const trial = process.env.PIXELGATE_NATIVE_TRIAL || '1';
const direct = process.env.PIXELGATE_NATIVE_DIRECT === '1';
if (direct && (latency || slowPathMs || lossPermille || linkBytesPerSecond))
  throw new Error(
    'Direct mode bypasses proxy latency, loss and link capacity; set all to zero.',
  );
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
const stats = {
  packets: 0,
  bytes: 0,
  queuedBytes: 0,
  maxQueuedBytes: 0,
  droppedPackets: 0,
  droppedBytes: 0,
  applicationPackets: 0,
  lossPermille,
};
for (let index = 0; index < 16; index++) {
  const sockets = [createSocket('udp4'), createSocket('udp4')];
  for (const socket of sockets)
    await new Promise((resolve) => socket.bind(0, '127.0.0.1', resolve));
  const pair = { sockets, targets: [undefined, undefined] };
  sockets.forEach((socket, side) =>
    socket.on('message', (packet, sender) => {
      // A guessed mDNS endpoint may differ from the native socket reaching this
      // fixture. Learn its IPv4 endpoint from STUN on the mapped proxy socket.
      // The proxy is loopback-only; this never changes product ICE behavior.
      const origin = pair.targets[1 - side];
      if (
        origin &&
        !origin.applicationBound &&
        packet.length >= 20 &&
        packet.readUInt32BE(4) === 0x2112a442
      ) {
        origin.address = sender.address;
        origin.port = sender.port;
      }
      // Pin the endpoint once DTLS starts. Later checks from an unselected
      // local candidate must not redirect an established synthetic route.
      if (origin && packet.length >= 13 && packet[0] >= 20 && packet[0] <= 63) {
        origin.address = sender.address;
        origin.port = sender.port;
        origin.applicationBound = true;
      }
      const target = pair.targets[side];
      if (!target) return;
      stats.packets++;
      stats.bytes += packet.length;
      if (packet[0] === 23) {
        stats.applicationPackets++;
        randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
        if (randomState / 4294967296 < lossPermille / 1000) {
          stats.droppedPackets++;
          stats.droppedBytes += packet.length;
          return;
        }
      }
      stats.queuedBytes += packet.length;
      stats.maxQueuedBytes = Math.max(stats.maxQueuedBytes, stats.queuedBytes);
      // All connections share this synthetic medium, including return
      // traffic. This is a capacity model, not an additional physical route.
      const now = performance.now();
      if (linkBytesPerSecond)
        transmissionAt =
          Math.max(now, transmissionAt) +
          (packet.length * 1000) / linkBytesPerSecond;
      const timer = setTimeout(
        () => {
          timers.delete(timer);
          stats.queuedBytes -= packet.length;
          sockets[1 - side].send(packet, target.port, target.address);
        },
        latency +
          (index >= slowPathStart && index < slowPathStart + slowPathCount
            ? slowPathMs
            : 0) +
          (linkBytesPerSecond ? transmissionAt - now : 0),
      );
      timers.add(timer);
    }),
  );
  pairs.push(pair);
}
const sendingBrowser = await (sourceCPU > 1 ? chromium : webkit).launch();
const receivingBrowser =
  receiverEngine === 'webkit' ? await webkit.launch() : undefined;
const receiving = receivingBrowser
  ? await receivingBrowser.newContext()
  : await chromium.launchPersistentContext(join(root, 'receiver-profile'), {
      executablePath: process.env.PIXELGATE_NATIVE_RECEIVER_EXECUTABLE,
      args: ['--disable-features=WebRtcHideLocalIpsWithMdns'],
    });
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
      ({ ports, source, sourceDelay, direct, hostAddress }) => {
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
          fields[4] = direct ? hostAddress : '127.0.0.1';
          fields[5] = direct ? String(target.port) : String(ports[index]);
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
        const metrics = {
          started: 0,
          milliseconds: 0,
          bytes: 0,
          sourceReads: 0,
        };
        if (source) {
          const read = Blob.prototype.arrayBuffer;
          Blob.prototype.arrayBuffer = async function () {
            if (this.size >= 1024 * 1024) {
              metrics.sourceReads++;
              if (sourceDelay)
                await new Promise((resolve) =>
                  setTimeout(resolve, sourceDelay),
                );
            }
            return read.call(this);
          };
        }
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
      {
        ports: pairs.map((pair) => pair.sockets[side].address().port),
        source: side === 0,
        sourceDelay,
        direct,
        hostAddress,
      },
    );
  }
  const receiver = await receiving.newPage(),
    sender = await sending.newPage();
  if (receiverCPU > 1) {
    const cdp = await receiving.newCDPSession(receiver);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: receiverCPU });
  }
  if (sourceCPU > 1) {
    const cdp = await sending.newCDPSession(sender);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: sourceCPU });
  }
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
  if (process.env.PIXELGATE_NATIVE_PAYLOAD_LIMIT) {
    if (!['5', '7'].includes(process.env.PIXELGATE_NATIVE_PAYLOAD_LIMIT))
      throw new Error('Invalid payload limit model.');
    await sender.getByText('Connection diagnostics', { exact: true }).click();
    await sender
      .getByLabel('Payload connection limit', { exact: true })
      .selectOption(process.env.PIXELGATE_NATIVE_PAYLOAD_LIMIT);
  }
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
      [
        'Browser copy verified',
        'Needs retry',
        'Paused',
        'Cancelled',
        'Failed',
      ].includes(document.querySelector('.file-status')?.textContent),
    undefined,
    { timeout: 180000 },
  );
  await expect(sender.locator('.file-status').first()).toHaveText(
    'Browser copy verified',
    { timeout: 1000 },
  );
  const endToEndMs = Date.now() - start;
  const storageMode = JSON.parse(
    await receiver
      .getByLabel('Connection report', { exact: true })
      .textContent(),
  ).storageMode;
  const storedHash = await receiver.evaluate(async (backend) => {
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
    if (backend === 'opfs') {
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
  }, storageMode);
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
    receiverEngine,
    latency,
    slowPathCount,
    slowPathStart,
    slowPathMs,
    linkBytesPerSecond,
    lossSeed,
    storageDelay,
    sourceDelay,
    sourceCPU,
    receiverCPU,
    direct,
    trial,
    bytes,
    endToEndMs,
    receivingReport,
    metrics: await sender.evaluate(() => window.nativeMetrics),
    stats,
    report,
    hashMatched: true,
    connectionsMapped: pairs.filter((pair) => pair.targets.every(Boolean))
      .length,
    connectionsProxied: direct
      ? 0
      : pairs.filter((pair) => pair.targets.every(Boolean)).length,
  };
  expect(result.connectionsMapped).toBe(report.transfer.connections);
  if (!direct) expect(result.stats.bytes).toBeGreaterThanOrEqual(bytes);
  else expect(result.stats.bytes).toBe(0);
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
  const failure = {
    stats,
    targets: pairs.map((pair) => pair.targets.map(Boolean)),
    senderDebug: await sending.pages()[0].evaluate(() => window.proxyDebug),
    receiverDebug: await receiving.pages()[0].evaluate(() => window.proxyDebug),
    senderAlerts: await sending.pages()[0].getByRole('alert').allTextContents(),
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
  };
  if (process.env.PIXELGATE_NATIVE_RESULT)
    await writeFile(
      process.env.PIXELGATE_NATIVE_RESULT + '.failure.json',
      JSON.stringify(failure, null, 2) + '\n',
    );
  console.log(JSON.stringify(failure));
  throw error;
} finally {
  await sending.close();
  await receiving.close();
  await receivingBrowser?.close();
  await sendingBrowser.close();
  for (const timer of timers) clearTimeout(timer);
  for (const pair of pairs) for (const socket of pair.sockets) socket.close();
  await rm(join(root, 'proxy-source.bin'), { force: true });
  await rm(join(root, 'receiver-profile'), { recursive: true, force: true });
}

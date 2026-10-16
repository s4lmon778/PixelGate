import { chromium } from '@playwright/test';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir, platform, arch, cpus } from 'node:os';
import { join, resolve } from 'node:path';
import { createSpeedGateServer } from '../server/http-server.ts';

// Real browser engines and the full application protocol, over loopback.
// This is deliberately NOT an iPhone/Pixel Wi-Fi bandwidth prediction.
const run = promisify(execFile);
const baselineDir = process.env.SPEEDGATE_BASELINE_DIST;
if (!baselineDir)
  throw new Error(
    'Set SPEEDGATE_BASELINE_DIST to a build of the preserved original revision.',
  );
const mib = Number(process.env.SPEEDGATE_BENCH_MIB || 128);
const repetitions = Number(process.env.SPEEDGATE_BENCH_REPETITIONS || 3);
if (
  !Number.isInteger(mib) ||
  mib < 32 ||
  mib > 512 ||
  !Number.isInteger(repetitions) ||
  repetitions < 1 ||
  repetitions > 10
)
  throw new Error('Use 32–512 MiB and 1–10 repetitions.');
const scratch = await mkdtemp(join(tmpdir(), 'speedgate-http-comparison-'));
const output = resolve(
  process.env.SPEEDGATE_BENCH_OUTPUT ||
    'docs/benchmarks/2026-10-15-http-comparison.json',
);
const tlsKey = process.env.SPEEDGATE_BENCH_TLS_KEY;
const tlsCert = process.env.SPEEDGATE_BENCH_TLS_CERT;
if (!!tlsKey !== !!tlsCert) throw new Error('Supply both benchmark TLS paths.');
const tls = tlsKey
  ? { key: await readFile(tlsKey), cert: await readFile(tlsCert) }
  : {};
const bridges = [];
const results = [];
let browserServer;
async function serve(directory) {
  const bridge = createSpeedGateServer({ staticDir: directory, ...tls });
  bridges.push(bridge);
  await new Promise((done) => bridge.server.listen(0, '127.0.0.1', done));
  return `${tlsKey ? 'https' : 'http'}://127.0.0.1:${bridge.server.address().port}/`;
}
async function fixture(name, bytes, seed) {
  const path = join(scratch, name),
    handle = await open(path, 'w');
  const block = Buffer.alloc(1024 * 1024);
  for (let index = 0; index < block.length; index++)
    block[index] = (index + seed) % 251;
  const hash = createHash('sha256');
  try {
    for (let offset = 0; offset < bytes; offset += block.length) {
      const data = block.subarray(0, Math.min(block.length, bytes - offset));
      await handle.write(data);
      hash.update(data);
    }
  } finally {
    await handle.close();
  }
  return { path, name, bytes, sha256: hash.digest('hex') };
}
function cpuSeconds(text) {
  const pieces = text.split(':').map(Number);
  return pieces.reduce((total, value) => total * 60 + value, 0);
}
async function processSample(root) {
  const { stdout } = await run('ps', ['-axo', 'pid=,ppid=,time=,rss=']);
  const entries = stdout
    .trim()
    .split('\n')
    .map((line) => {
      const [pid, parent, time, rss] = line.trim().split(/\s+/);
      return {
        pid: Number(pid),
        parent: Number(parent),
        cpu: cpuSeconds(time),
        rss: Number(rss) * 1024,
      };
    });
  const included = new Set(Array.isArray(root) ? root : [root]);
  for (let pass = 0; pass < entries.length; pass++) {
    let changed = false;
    for (const entry of entries)
      if (included.has(entry.parent) && !included.has(entry.pid)) {
        included.add(entry.pid);
        changed = true;
      }
    if (!changed) break;
  }
  const children = entries.filter((entry) => included.has(entry.pid));
  return {
    cpuSeconds: children.reduce((sum, entry) => sum + entry.cpu, 0),
    rssBytes: children.reduce((sum, entry) => sum + entry.rss, 0),
    processes: children.length,
  };
}
async function stored(page) {
  return page.evaluate(async () => {
    const db = await new Promise((done, reject) => {
      const req = indexedDB.open('pixelbridge-v1', 3);
      req.onsuccess = () => done(req.result);
      req.onerror = () => reject(req.error);
    });
    const files = await new Promise((done) => {
      const req = db.transaction('files').objectStore('files').getAll();
      req.onsuccess = () => done(req.result);
    });
    db.close();
    return files;
  });
}
async function independentHash(page, id) {
  return page.evaluate(async (id) => {
    const dir = await (
      await navigator.storage.getDirectory()
    ).getDirectoryHandle('pixelbridge');
    const file = await (await dir.getFileHandle(id)).getFile();
    return {
      size: file.size,
      sha256: Array.from(
        new Uint8Array(
          await crypto.subtle.digest('SHA-256', await file.arrayBuffer()),
        ),
        (byte) => byte.toString(16).padStart(2, '0'),
      ).join(''),
    };
  }, id);
}
async function connect(receiver, sender, url, variant) {
  await receiver.goto(url);
  await sender.goto(url);
  if (variant === 'http') {
    await receiver.getByLabel('Transfer transport').selectOption('http');
    await sender.getByLabel('Transfer transport').selectOption('http');
  }
  await receiver
    .getByRole('button', { name: 'Receive files', exact: true })
    .click();
  if (variant === 'webrtc')
    await receiver
      .getByRole('button', { name: 'Use copy/paste pairing', exact: true })
      .click();
  await receiver
    .getByRole('button', { name: 'Create a connection', exact: true })
    .click();
  if (variant === 'http') {
    await receiver.getByLabel('Pairing code', { exact: true }).waitFor();
    await sender
      .getByLabel('Receiver’s six-digit code')
      .fill(
        (
          await receiver.getByLabel('Pairing code', { exact: true }).innerText()
        ).replace(/\s/g, ''),
      );
    await sender.getByRole('button', { name: 'Connect', exact: true }).click();
  } else {
    await receiver.getByLabel('Receiver link', { exact: true }).waitFor();
    await sender.goto(
      await receiver.getByLabel('Receiver link', { exact: true }).inputValue(),
    );
    await sender
      .getByRole('button', { name: 'Prepare sender response', exact: true })
      .click();
    await sender.getByLabel('Sender response', { exact: true }).waitFor();
    await receiver
      .getByLabel('2. Paste the sender response', { exact: true })
      .fill(
        await sender
          .getByLabel('Sender response', { exact: true })
          .inputValue(),
      );
  }
  await receiver
    .getByRole('button', { name: 'Approve sender', exact: true })
    .click();
  await sender
    .getByText('Connected', { exact: true })
    .waitFor({ timeout: 30_000 });
  await receiver
    .getByText('Connected', { exact: true })
    .waitFor({ timeout: 30_000 });
}
try {
  const urls = { webrtc: await serve(baselineDir), http: await serve('dist') };
  const datasets = [
    {
      name: 'large-file',
      files: [await fixture('large-original.bin', mib * 1024 * 1024 + 111, 1)],
    },
    {
      name: 'photo-batch',
      files: await Promise.all(
        Array.from({ length: 32 }, (_, index) =>
          fixture(
            `photo-${index.toString().padStart(3, '0')}.jpg`,
            (mib * 1024 * 1024) / 32,
            index + 2,
          ),
        ),
      ),
    },
  ];
  for (const dataset of datasets)
    for (let trial = 1; trial <= repetitions; trial++)
      for (const variant of trial % 2
        ? ['webrtc', 'http']
        : ['http', 'webrtc']) {
        browserServer = await chromium.launchServer({
          args: ['--disable-features=WebRtcHideLocalIpsWithMdns'],
        });
        const browser = await chromium.connect(browserServer.wsEndpoint());
        const receiving = await chromium.launchPersistentContext(
            join(scratch, `receiver-${dataset.name}-${trial}-${variant}`),
            {
              headless: true,
              ignoreHTTPSErrors: !!tlsKey,
              args: ['--disable-features=WebRtcHideLocalIpsWithMdns'],
            },
          ),
          sending = await browser.newContext({ ignoreHTTPSErrors: !!tlsKey });
        for (const context of [receiving, sending])
          await context.addInitScript(() => {
            const Native = window.RTCPeerConnection;
            window.RTCPeerConnection = new Proxy(Native, {
              construct(target, args, newTarget) {
                return Reflect.construct(
                  target,
                  [{ ...args[0], iceServers: [] }, ...args.slice(1)],
                  newTarget,
                );
              },
            });
          });
        const receiver = await receiving.newPage(),
          sender = await sending.newPage();
        let timer,
          sampling = false,
          peakRSS = 0,
          lastSample;
        const nodeCPU = process.cpuUsage();
        try {
          await connect(receiver, sender, urls[variant], variant);
          await sender
            .getByLabel('Choose files', { exact: true })
            .setInputFiles(dataset.files.map((file) => file.path));
          const cdp = await receiving.browser().newBrowserCDPSession();
          const processInfo = await cdp.send('SystemInfo.getProcessInfo');
          const receiverPID = Number(
            processInfo.processInfo.find((entry) => entry.type === 'browser')
              .id,
          );
          const root = [browserServer.process().pid, receiverPID];
          await cdp.detach();
          const before = await processSample(root);
          peakRSS = before.rssBytes;
          const bridgeBefore = process.cpuUsage();
          let bridgePeakRSS = process.memoryUsage().rss;
          timer = setInterval(async () => {
            if (sampling) return;
            sampling = true;
            try {
              const sample = await processSample(root);
              peakRSS = Math.max(peakRSS, sample.rssBytes);
              lastSample = sample;
              bridgePeakRSS = Math.max(
                bridgePeakRSS,
                process.memoryUsage().rss,
              );
            } finally {
              sampling = false;
            }
          }, 250);
          const started = performance.now();
          await sender
            .getByRole('button', { name: 'Send files', exact: true })
            .last()
            .click();
          await sender.waitForFunction(
            (count) => {
              const elements = [...document.querySelectorAll('.file-status')];
              if (
                elements.some((element) =>
                  /Needs retry|Cancelled|Failed/.test(element.textContent),
                )
              )
                throw new Error(
                  'Transfer failed: ' +
                    elements.map((element) => element.textContent).join(', '),
                );
              return (
                elements.length === count &&
                elements.every(
                  (element) => element.textContent === 'Browser copy verified',
                )
              );
            },
            dataset.files.length,
            { timeout: 180_000 },
          );
          const milliseconds = performance.now() - started;
          clearInterval(timer);
          timer = undefined;
          while (sampling) await new Promise((done) => setTimeout(done, 10));
          const after = await processSample(root);
          peakRSS = Math.max(peakRSS, after.rssBytes);
          const bridgeCPU = process.cpuUsage(bridgeBefore);
          const records = await stored(receiver);
          if (records.length !== dataset.files.length)
            throw new Error('Missing receiver records.');
          for (const file of dataset.files) {
            const record = records.find(
              (record) => record.originalName === file.name,
            );
            const actual = await independentHash(receiver, record.id);
            if (
              record.phase !== 'verified' ||
              actual.size !== file.bytes ||
              actual.sha256 !== file.sha256
            )
              throw new Error(
                'Independent stored-byte integrity check failed.',
              );
          }
          const bytes = dataset.files.reduce(
            (sum, file) => sum + file.bytes,
            0,
          );
          const report = await sender
            .getByLabel('Connection report', { exact: true })
            .textContent()
            .catch(() => null);
          const result = {
            variant,
            dataset: dataset.name,
            trial,
            files: dataset.files.length,
            bytes,
            milliseconds,
            endToEndMBps: bytes / milliseconds / 1000,
            browserCPUSeconds: Math.max(
              0,
              after.cpuSeconds - before.cpuSeconds,
            ),
            browserCPUPercent: Math.max(
              0,
              ((after.cpuSeconds - before.cpuSeconds) * 100_000) / milliseconds,
            ),
            browserBaselineRSSBytes: before.rssBytes,
            browserPeakRSSBytes: peakRSS,
            browserPeakRSSIncreaseBytes: Math.max(0, peakRSS - before.rssBytes),
            bridgeAndHarnessCPUSeconds:
              (bridgeCPU.user + bridgeCPU.system) / 1_000_000,
            bridgeAndHarnessPeakRSSBytes: bridgePeakRSS,
            receiverStoredHashesMatched: true,
            report: report ? JSON.parse(report) : null,
            samplesObserved: !!lastSample,
          };
          results.push(result);
          console.log(
            JSON.stringify({
              variant,
              dataset: dataset.name,
              trial,
              MBps: result.endToEndMBps,
              browserCPUSeconds: result.browserCPUSeconds,
              peakRSSMiB: result.browserPeakRSSBytes / 1048576,
              integrity: true,
            }),
          );
        } catch (error) {
          results.push({
            variant,
            dataset: dataset.name,
            trial,
            failure: error.message,
            sender: await sender.getByRole('alert').allTextContents(),
            receiver: await receiver.getByRole('alert').allTextContents(),
            senderReport: await sender
              .getByLabel('Connection report', { exact: true })
              .textContent()
              .catch(() => null),
            receiverReport: await receiver
              .getByLabel('Connection report', { exact: true })
              .textContent()
              .catch(() => null),
            nodeCPU: process.cpuUsage(nodeCPU),
          });
          throw error;
        } finally {
          clearInterval(timer);
          await receiving.close();
          await sending.close();
          await browser.close();
          await browserServer.close();
          browserServer = undefined;
        }
      }
} finally {
  if (browserServer) await browserServer.close();
  await writeFile(
    output,
    JSON.stringify(
      {
        recordedAt: new Date().toISOString(),
        environment: {
          platform: platform(),
          arch: arch(),
          cpu: cpus()[0]?.model,
          logicalCPUs: cpus().length,
          node: process.version,
        },
        tls: !!tlsKey,
        tlsTrust: tlsKey
          ? 'Self-signed test certificate accepted only by isolated Playwright contexts; TLS encryption remains active.'
          : 'No TLS',
        scope:
          'Single Mac, real Chromium with a fresh persistent receiver profile per trial, loopback HTTP(S) versus original WebRTC. Includes source hashing, storage and verification. Browser RSS is sum of process RSS and may double-count shared pages; 250 ms samples may miss short peaks. CPU from ps cumulative time, includes browser children, may miss processes that exit between samples. Bridge/harness metrics include Playwright orchestration and ps sampling. No claim about physical Wi-Fi, iOS or Pixel throughput.',
        baselineRevision:
          process.env.SPEEDGATE_BASELINE_REVISION || 'unspecified',
        repetitions,
        mib,
        results,
      },
      null,
      2,
    ) + '\n',
  );
  for (const bridge of bridges) await bridge.close();
  await rm(scratch, { recursive: true, force: true });
}

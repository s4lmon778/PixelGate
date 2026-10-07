import { chromium, expect } from '@playwright/test';
import WebSocket from 'ws';
import { Worker } from 'node:worker_threads';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// Real transfer in fresh profiles and an isolated local broker. Nothing is staged
// in a user's browser, and the displayed demo code is never publicly registered.
const root = fileURLToPath(new URL('..', import.meta.url));
const scratch = await mkdtemp(join(tmpdir(), 'pixelgate-quick-start-'));
const sockets = new Set();
const signals = [];
let broker, browser;
const scenes = [];
try {
  // PeerServer owns recurring maintenance timers. A separate worker lets cleanup
  // terminate those timers without relying on private library internals.
  broker = new Worker(
    `const { parentPort } = require('node:worker_threads');
     import('peer').then(({ PeerServer }) => {
       PeerServer({ host: '127.0.0.1', port: 0, allow_discovery: false },
         server => parentPort.postMessage(server.address().port));
     });`,
    { eval: true },
  );
  const port = await new Promise((resolve, reject) => {
    broker.once('message', resolve);
    broker.once('error', reject);
  });
  browser = await chromium.launch({
    args: ['--disable-features=WebRtcHideLocalIpsWithMdns'],
  });
  const contexts = await Promise.all(
    [0, 1].map(() =>
      browser.newContext({
        viewport: { width: 1440, height: 1100 },
        colorScheme: 'light',
      }),
    ),
  );
  for (const context of contexts) {
    await context.addInitScript(() => {
      const Original = window.RTCPeerConnection;
      window.RTCPeerConnection = class extends Original {
        constructor(config) {
          super({ ...config, iceServers: [] });
        }
      };
    });
    await context.routeWebSocket('wss://0.peerjs.com/**', (route) => {
      const remote = new WebSocket(
        route.url().replace('wss://0.peerjs.com', `ws://127.0.0.1:${port}`),
      );
      sockets.add(remote);
      const pending = [];
      route.onMessage((message) => {
        signals.push(String(message));
        if (remote.readyState === WebSocket.OPEN) remote.send(message);
        else pending.push(message);
      });
      remote.on('open', () =>
        pending.forEach((message) => remote.send(message)),
      );
      remote.on('message', (message) => {
        signals.push(String(message));
        route.send(message.toString());
      });
      remote.on('error', () => route.close());
      route.onClose(() => remote.close());
    });
  }
  const [receiver, sender] = await Promise.all(
    contexts.map((c) => c.newPage()),
  );
  await Promise.all([
    receiver.goto('http://127.0.0.1:8787/'),
    sender.goto('http://127.0.0.1:8787/'),
  ]);
  async function shot(
    page,
    step,
    role,
    title,
    detail,
    focus,
    click,
    seconds = 2.2,
  ) {
    await focus.scrollIntoViewIfNeeded();
    const box = await focus.boundingBox();
    const point = click ? await click.boundingBox() : undefined;
    scenes.push({
      step,
      role,
      title,
      detail,
      box,
      point,
      seconds,
      png: (await page.screenshot()).toString('base64'),
    });
  }
  const button = (page, name) =>
    page.getByRole('button', { name, exact: true });
  await button(receiver, 'Receive files').click();
  await shot(
    receiver,
    1,
    'Receiver',
    'Create a receiver code',
    'Open PixelGate on both devices. Choose Receive files on the destination.',
    receiver.locator('.pairing-start'),
    button(receiver, 'Create a connection'),
  );
  await button(receiver, 'Create a connection').click();
  const codeDisplay = receiver.getByLabel('Pairing code', { exact: true });
  await expect(codeDisplay).toBeVisible({ timeout: 20000 });
  const code = (await codeDisplay.innerText()).replace(/\s/g, '');
  expect(code).toMatch(/^\d{6}$/);
  await shot(
    receiver,
    1,
    'Receiver',
    'Share this code or QR link',
    'Use the fresh code shown on YOUR receiver. The code in this demo is inactive.',
    receiver.locator('.qr-row'),
    undefined,
  );

  await sender
    .getByLabel('Receiver’s six-digit code', { exact: true })
    .fill(code);
  await shot(
    sender,
    2,
    'Sender',
    'Enter the code, then Connect',
    'On the sending device, enter the receiver’s six digits. QR scanning works too.',
    sender.locator('.pairing-start'),
    button(sender, 'Connect'),
    2.6,
  );
  await button(sender, 'Connect').click();
  await expect(button(receiver, 'Approve sender')).toBeEnabled({
    timeout: 30000,
  });
  await shot(
    receiver,
    3,
    'Receiver',
    'Approve your sender',
    'Approve the request from your intended device before any files can arrive.',
    receiver.locator('.approval'),
    button(receiver, 'Approve sender'),
    2.6,
  );
  await button(receiver, 'Approve sender').click();
  await expect(sender.getByText('Connected', { exact: true })).toBeVisible({
    timeout: 45000,
  });
  await expect(receiver.getByText('Connected', { exact: true })).toBeVisible();

  const sample = {
    name: 'PixelGate-demo.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from(
      'PixelGate quick-start demo — unchanged bytes.\n'.repeat(3000),
    ),
  };
  const sourceHash = createHash('sha256').update(sample.buffer).digest('hex');
  await shot(
    sender,
    4,
    'Sender',
    'Choose files or folders',
    'Select the files you want to send. This walkthrough uses a synthetic text file.',
    sender.locator('.drop-zone'),
    button(sender, 'Choose files'),
  );
  const chooser = sender.waitForEvent('filechooser');
  await button(sender, 'Choose files').click();
  await (await chooser).setFiles(sample);
  await expect(sender.locator('.file-row')).toHaveCount(1);
  const send = button(sender, 'Send files').last();
  await expect(send).toBeEnabled();
  await shot(
    sender,
    4,
    'Sender',
    'Send the selected files',
    'Keep both browsers open. Enable Keep screen awake where supported.',
    sender.locator('.send-footer'),
    send,
  );
  await send.click();
  await expect(receiver.locator('.file-status').first()).toHaveText(
    'Browser copy verified',
    { timeout: 60000 },
  );
  expect(signals.join('')).not.toContain(sample.name);
  expect(signals.join('')).not.toContain(sourceHash);

  await shot(
    receiver,
    5,
    'Receiver',
    'Save the verified copies',
    'Choose a folder where supported, or open Save to app or location.',
    receiver.locator('.app-save .save-actions'),
    button(receiver, 'Save to app or location'),
  );
  await button(receiver, 'Save to app or location').click();
  await shot(
    receiver,
    5,
    'Receiver',
    'Prepare your selected batch',
    'PixelGate rereads and hashes the browser copies before offering them for saving.',
    receiver.locator('.save-dialog'),
    button(receiver, 'Prepare selected files'),
  );
  await button(receiver, 'Prepare selected files').click();
  await expect(button(receiver, 'Download verified files')).toBeVisible();
  await shot(
    receiver,
    5,
    'Receiver',
    'Download or use your device’s save sheet',
    'Downloads are shown here. Available app and folder choices depend on the device.',
    receiver.locator('.save-dialog'),
    button(receiver, 'Download verified files'),
  );
  const downloadEvent = receiver.waitForEvent('download');
  await button(receiver, 'Download verified files').click();
  const download = await downloadEvent;
  const savedPath = await download.path();
  expect(
    createHash('sha256')
      .update(await readFile(savedPath))
      .digest('hex'),
  ).toBe(sourceHash);
  await button(receiver, 'Close save options').click();
  await expect(receiver.locator('.file-status').first()).toHaveText(
    'Download verification pending',
  );

  await shot(
    receiver,
    6,
    'Receiver',
    'Verify the saved copy',
    'Reselect the downloaded or app-saved file to check its final bytes.',
    receiver.locator('.batch-actions'),
    button(receiver, 'Verify saved copies'),
  );
  const verifyChooser = receiver.waitForEvent('filechooser');
  await button(receiver, 'Verify saved copies').click();
  await (await verifyChooser).setFiles(savedPath);
  await expect(receiver.locator('.file-status').first()).toHaveText(
    'Exported copy verified',
  );
  await shot(
    receiver,
    6,
    'Receiver',
    'The exported copy is verified',
    'Direct folder mode verifies its destination automatically. Downloads need this check.',
    receiver.locator('.file-status').first(),
    undefined,
  );
  await shot(
    receiver,
    6,
    'Receiver',
    'Clear staging for your next batch',
    'Clear verified staging removes eligible browser copies. Your saved files stay.',
    receiver.locator('.batch-actions'),
    button(receiver, 'Clear verified staging'),
  );
  receiver.once('dialog', (dialog) => void dialog.accept());
  await button(receiver, 'Clear verified staging').click();
  await expect(receiver.locator('.alert[role="status"]')).toContainText(
    '1 staged copies cleared',
  );
  await shot(
    receiver,
    6,
    'Receiver',
    'Ready for the next batch',
    'Your saved copy and transfer record remain. Repeat with the next batch.',
    receiver.locator('.alert[role="status"]'),
    undefined,
    1.8,
  );

  const studio = await browser.newPage({
    viewport: { width: 960, height: 640 },
  });
  await studio.setContent(
    '<canvas width="960" height="640" style="display:block"></canvas><style>body{margin:0}</style>',
  );
  await studio.evaluate(async (shots) => {
    const loaded = await Promise.all(
      shots.map(async (s) => {
        const image = new Image();
        image.src = `data:image/png;base64,${s.png}`;
        await image.decode();
        return { ...s, image };
      }),
    );
    const canvas = document.querySelector('canvas'),
      ctx = canvas.getContext('2d');
    const viewport = { x: 24, y: 122, width: 912, height: 416 };
    const clamp = (v, a, b) => Math.max(a, Math.min(v, b));
    const ease = (t) => t * t * (3 - 2 * t);
    window.paint = (index, progress) => {
      const s = loaded[index],
        r = s.box,
        ratio = viewport.width / viewport.height;
      const zoom = ease(clamp(progress / 0.36, 0, 1));
      const closeWidth = clamp(
        Math.max(520, r.width * 1.3, r.height * ratio * 1.3),
        520,
        1440,
      );
      const sw = 1440 + (closeWidth - 1440) * zoom,
        sh = sw / ratio;
      const cx = 720 + (r.x + r.width / 2 - 720) * zoom;
      const cy = 550 + (r.y + r.height / 2 - 550) * zoom;
      const sx = clamp(cx - sw / 2, 0, s.image.width - sw);
      const sy = clamp(cy - sh / 2, 0, s.image.height - sh);
      ctx.fillStyle = '#f4f7fb';
      ctx.fillRect(0, 0, 960, 640);
      ctx.fillStyle = '#0878ec';
      [
        [24, 22],
        [36, 22],
        [24, 34],
        [36, 34],
      ].forEach(([x, y], i) => {
        ctx.globalAlpha = 1 - i * 0.16;
        ctx.fillRect(x, y, 9, 9);
      });
      ctx.globalAlpha = 1;
      ctx.font = 'bold 15px Arial';
      ctx.fillText('PIXELGATE · QUICK START', 58, 37);
      ctx.fillStyle = s.role === 'Receiver' ? '#e8f5ed' : '#e7f1ff';
      ctx.beginPath();
      ctx.roundRect(790, 17, 146, 34, 17);
      ctx.fill();
      ctx.fillStyle = s.role === 'Receiver' ? '#21623f' : '#0878ec';
      ctx.textAlign = 'center';
      ctx.fillText(`${s.role} device`, 863, 39);
      ctx.textAlign = 'left';
      ctx.fillStyle = '#0878ec';
      ctx.beginPath();
      ctx.arc(42, 82, 18, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 18px Arial';
      ctx.textAlign = 'center';
      ctx.fillText(String(s.step), 42, 88);
      ctx.textAlign = 'left';
      ctx.fillStyle = '#1d2c3f';
      ctx.font = 'bold 23px Arial';
      ctx.fillText(s.title, 72, 90);
      ctx.save();
      ctx.beginPath();
      ctx.roundRect(
        viewport.x,
        viewport.y,
        viewport.width,
        viewport.height,
        14,
      );
      ctx.clip();
      ctx.drawImage(
        s.image,
        sx,
        sy,
        sw,
        sh,
        viewport.x,
        viewport.y,
        viewport.width,
        viewport.height,
      );
      if (s.point && progress > 0.4 && progress < 0.88) {
        const x =
          viewport.x +
          ((s.point.x + s.point.width / 2 - sx) * viewport.width) / sw;
        const y =
          viewport.y +
          ((s.point.y + s.point.height / 2 - sy) * viewport.height) / sh;
        const pulse = (progress - 0.4) / 0.48;
        ctx.fillStyle = '#0878ec';
        ctx.globalAlpha = 0.14;
        ctx.beginPath();
        ctx.arc(x, y, 14 + 20 * pulse, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 0.8;
        ctx.strokeStyle = '#0878ec';
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.arc(x, y, 11 + 10 * pulse, 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
      ctx.restore();
      ctx.strokeStyle = '#d9e2ee';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect(
        viewport.x,
        viewport.y,
        viewport.width,
        viewport.height,
        14,
      );
      ctx.stroke();
      ctx.fillStyle = '#52677f';
      ctx.font = '18px Arial';
      const words = s.detail.split(' ');
      let line = '',
        y = 574;
      for (const word of words) {
        const next = line ? `${line} ${word}` : word;
        if (ctx.measureText(next).width > 900) {
          ctx.fillText(line, 24, y);
          y += 25;
          line = word;
        } else line = next;
      }
      ctx.fillText(line, 24, y);
      for (let i = 0; i < 6; i++) {
        ctx.fillStyle = i < s.step ? '#0878ec' : '#d9e2ee';
        ctx.beginPath();
        ctx.roundRect(24 + i * 154, 624, 142, 4, 2);
        ctx.fill();
      }
    };
  }, scenes);
  let count = 0;
  const fps = 20;
  for (let index = 0; index < scenes.length; index++) {
    const frames = Math.round(scenes[index].seconds * fps);
    for (let i = 0; i < frames; i++) {
      await studio.evaluate(
        ({ index, progress }) => window.paint(index, progress),
        { index, progress: i / (frames - 1) },
      );
      const data = await studio
        .locator('canvas')
        .evaluate((canvas) => canvas.toDataURL('image/png').split(',')[1]);
      await writeFile(
        join(scratch, `${String(count++).padStart(4, '0')}.png`),
        Buffer.from(data, 'base64'),
      );
    }
  }
  function encode(args) {
    const result = spawnSync(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-framerate',
        String(fps),
        '-i',
        join(scratch, '%04d.png'),
        ...args,
      ],
      { encoding: 'utf8' },
    );
    if (result.status !== 0)
      throw new Error(result.stderr || 'FFmpeg is required.');
  }
  encode([
    '-vf',
    'format=yuv420p',
    '-c:v',
    'libx264',
    '-crf',
    '20',
    '-preset',
    'medium',
    '-movflags',
    '+faststart',
    join(root, 'docs/assets/quick-start.mp4'),
  ]);
  encode([
    '-filter_complex',
    '[0:v]fps=10,split[a][b];[a]palettegen=max_colors=192:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle',
    '-loop',
    '0',
    join(root, 'docs/assets/quick-start.gif'),
  ]);
  console.log(
    `Recorded ${scenes.length} real workflow views; rendered ${count} camera frames. Download SHA-256 matches the independent source hash; saved-copy verification and staging cleanup completed.`,
  );
} finally {
  try {
    await browser?.close();
  } finally {
    for (const socket of sockets) socket.terminate();
    await broker?.terminate();
    await rm(scratch, { recursive: true, force: true });
  }
}

import { chromium, expect } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// Record a fresh, empty browser profile: no rooms, personal files, or saved history.
const root = fileURLToPath(new URL('..', import.meta.url));
const frames = await mkdtemp(join(tmpdir(), 'pixelgate-readme-'));
let browser;
try {
  browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: 1280, height: 900 },
    colorScheme: 'light',
  });
  await page.goto('http://127.0.0.1:8787/');
  const awake = page.getByRole('switch', { name: 'Keep screen awake' });
  await expect(awake).toBeVisible();
  const card = await page.locator('.awake-card').boundingBox();
  const main = await page.locator('.main-wrap').boundingBox();
  const clip = {
    x: Math.floor(main.x),
    y: 0,
    width: Math.floor(main.width),
    height: Math.ceil(card.y + card.height + 20),
  };
  let frame = 0;
  async function capture(count) {
    for (let i = 0; i < count; i++) {
      const started = Date.now();
      await page.screenshot({
        path: join(frames, `${String(frame++).padStart(4, '0')}.png`),
        clip,
      });
      await new Promise((resolve) =>
        setTimeout(resolve, Math.max(0, 100 - (Date.now() - started))),
      );
    }
  }
  await capture(12);
  await awake.click();
  await capture(12);
  await awake.click();
  await capture(12);
  await page.getByRole('button', { name: 'Appearance', exact: true }).click();
  await capture(12);
  await page.getByRole('menuitemradio', { name: 'Dark', exact: true }).click();
  await capture(20);
  await page.getByRole('button', { name: 'Appearance', exact: true }).click();
  await capture(12);
  await page.getByRole('menuitemradio', { name: 'Light', exact: true }).click();
  await capture(16);

  const result = spawnSync(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-framerate',
      '10',
      '-i',
      join(frames, '%04d.png'),
      '-filter_complex',
      '[0:v]scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=160:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle',
      '-loop',
      '0',
      join(root, 'docs/assets/controls-demo.gif'),
    ],
    { encoding: 'utf8' },
  );
  if (result.status !== 0)
    throw new Error(result.stderr || 'FFmpeg is required to encode the demo.');
  console.log(`Recorded ${frame} frames of real UI controls.`);
} finally {
  try {
    await browser?.close();
  } finally {
    await rm(frames, { recursive: true, force: true });
  }
}

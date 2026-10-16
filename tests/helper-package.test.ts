import { it, expect } from 'vitest';
import { mkdtemp, writeFile, readFile, mkdir, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { unzipSync } from 'fflate';

it('packages a helper that runs outside the checkout without node_modules or a TypeScript loader', async () => {
  const root = await mkdtemp(join(tmpdir(), 'speedgate-helper-package-'));
  try {
    const assets = join(root, 'assets'),
      output = join(root, 'helper.zip');
    await mkdir(assets);
    await writeFile(
      join(assets, 'index.html'),
      '<title>SpeedGate fixture</title>',
    );
    const packaged = spawnSync(
      process.execPath,
      ['scripts/package-helper.mjs', '--assets', assets, '--out', output],
      { encoding: 'utf8' },
    );
    expect(packaged.status, packaged.stderr).toBe(0);
    const files = unzipSync(new Uint8Array(await readFile(output)));
    expect(
      Object.keys(files).some(
        (name) => name.includes('node_modules') || name.endsWith('.ts'),
      ),
    ).toBe(false);
    for (const [name, bytes] of Object.entries(files)) {
      const path = join(root, name);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, bytes);
    }
    const script = `const { createSpeedGateServer } = await import('./server/http-server.mjs');
const bridge = createSpeedGateServer({ staticDir: 'dist' });
try {
  await new Promise(done => bridge.server.listen(0, '127.0.0.1', done));
  const url = 'http://127.0.0.1:' + bridge.server.address().port;
  const info = await (await fetch(url + '/api/speedgate/v1/info')).json();
  if (info.protocol !== 'speedgate-http-v1') throw new Error('Wrong API.');
  if (!(await (await fetch(url)).text()).includes('SpeedGate fixture')) throw new Error('Missing bundled app.');
} finally { await bridge.close(); }`;
    const booted = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', script],
      { cwd: join(root, 'SpeedGate-helper'), encoding: 'utf8' },
    );
    expect(booted.status, booted.stderr).toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

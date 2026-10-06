import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
let temp: string, root: string, remote: string;
function run(args: string[], cwd = root) {
  const result = spawnSync(args[0], args.slice(1), { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}
function deploy() {
  return spawnSync(process.execPath, ['scripts/deploy-pages.mjs'], {
    cwd: root,
    encoding: 'utf8',
  });
}
beforeEach(() => {
  temp = mkdtempSync(join(tmpdir(), 'pixelgate-publish-test-'));
  root = join(temp, 'project');
  remote = join(temp, 'remote.git');
  mkdirSync(root);
  mkdirSync(join(root, 'scripts'));
  run(['git', 'init', '--bare', remote], temp);
  run(['git', 'init', '-b', 'main']);
  run(['git', 'config', 'user.name', 'PixelGate Test']);
  run(['git', 'config', 'user.email', 'test@example.invalid']);
  run(['git', 'remote', 'add', 'origin', remote]);
  cpSync(
    new URL('../scripts/deploy-pages.mjs', import.meta.url),
    join(root, 'scripts/deploy-pages.mjs'),
  );
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({
      version: '0.2.0',
      type: 'module',
      scripts: { build: 'node scripts/build.mjs' },
    }),
  );
  writeFileSync(
    join(root, 'scripts/build.mjs'),
    "import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';mkdirSync('dist',{recursive:true});writeFileSync('dist/index.html',readFileSync('source.txt'));\n",
  );
  writeFileSync(join(root, '.gitignore'), 'dist/\n');
  writeFileSync(join(root, 'source.txt'), 'first build');
  run(['git', 'add', '.']);
  run(['git', 'commit', '-m', 'Source']);
});
afterEach(() => rmSync(temp, { recursive: true, force: true }));
describe('GitHub Pages publisher with isolated local remotes', () => {
  it('creates an initial deploy branch and records the actual source commit', () => {
    const source = run(['git', 'rev-parse', 'HEAD']);
    const result = deploy();
    expect(result.status).toBe(0);
    expect(
      run(['git', '--git-dir', remote, 'show', 'gh-pages:index.html']),
    ).toBe('first build');
    expect(
      JSON.parse(
        run(['git', '--git-dir', remote, 'show', 'gh-pages:build.json']),
      ).source_commit,
    ).toBe(source);
    expect(run(['git', 'branch', '--show-current'])).toBe('main');
  });
  it('updates without rewriting deployment history', () => {
    expect(deploy().status).toBe(0);
    const first = run(['git', '--git-dir', remote, 'rev-parse', 'gh-pages']);
    writeFileSync(join(root, 'source.txt'), 'second build');
    run(['git', 'add', 'source.txt']);
    run(['git', 'commit', '-m', 'Update']);
    expect(deploy().status).toBe(0);
    expect(run(['git', '--git-dir', remote, 'rev-parse', 'gh-pages^'])).toBe(
      first,
    );
    expect(
      run(['git', '--git-dir', remote, 'show', 'gh-pages:index.html']),
    ).toBe('second build');
  });
  it('refuses uncommitted source without publishing', () => {
    writeFileSync(join(root, 'source.txt'), 'uncommitted');
    const result = deploy();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Commit source changes');
    expect(
      run([
        'git',
        '--git-dir',
        remote,
        'for-each-ref',
        '--format=%(refname)',
        'refs/heads',
      ]),
    ).toBe('');
    expect(readFileSync(join(root, 'source.txt'), 'utf8')).toBe('uncommitted');
  });
});

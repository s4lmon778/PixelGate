import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
function run(args, cwd = root) {
  const result = spawnSync(args[0], args.slice(1), {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0)
    throw new Error(
      result.stderr || result.stdout || `Command failed: ${args[0]}`,
    );
  return result.stdout.trim();
}
run(['npm', 'run', 'build']);
const remote = run(['git', 'remote', 'get-url', 'origin']);
const author = {
  name: run(['git', 'config', 'user.name']),
  email: run(['git', 'config', 'user.email']),
};
const source = run(['git', 'rev-parse', 'HEAD']);
if (run(['git', 'status', '--porcelain', '--untracked-files=normal']))
  throw new Error('Commit source changes before publishing.');
const temp = mkdtempSync(join(tmpdir(), 'pixelgate-pages-'));
try {
  run(['git', 'init', '-b', 'gh-pages'], temp);
  run(['git', 'config', 'user.name', author.name], temp);
  run(['git', 'config', 'user.email', author.email], temp);
  run(['git', 'remote', 'add', 'origin', remote], temp);
  const previous = run(
    ['git', 'ls-remote', '--heads', 'origin', 'gh-pages'],
    temp,
  );
  if (previous) {
    run(['git', 'fetch', '--depth=1', 'origin', 'gh-pages'], temp);
    run(['git', 'checkout', '-B', 'gh-pages', 'FETCH_HEAD'], temp);
  }
  for (const entry of readdirSync(temp))
    if (entry !== '.git')
      rmSync(join(temp, entry), { recursive: true, force: true });
  for (const entry of readdirSync(join(root, 'dist')))
    cpSync(join(root, 'dist', entry), join(temp, entry), { recursive: true });
  writeFileSync(join(temp, '.nojekyll'), '');
  writeFileSync(
    join(temp, 'build.json'),
    JSON.stringify({
      source_commit: source,
      version: JSON.parse(
        run(['node', '-p', 'JSON.stringify(require("./package.json"))']),
      ).version,
    }) + '\n',
  );
  if (!existsSync(join(temp, 'index.html')))
    throw new Error('Static entrypoint is missing.');
  run(['git', 'add', '.'], temp);
  if (run(['git', 'status', '--porcelain'], temp))
    run(
      ['git', 'commit', '-m', `Deploy PixelGate from ${source.slice(0, 7)}`],
      temp,
    );
  console.log(run(['git', 'push', 'origin', 'gh-pages'], temp));
  console.log(
    'Published compiled assets to gh-pages. Check GitHub Pages for deployment status.',
  );
} finally {
  rmSync(temp, { recursive: true, force: true });
}

import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync, strToU8 } from 'fflate';
import ts from 'typescript';

// Build-time dependencies only. The extracted helper imports Node built-ins and
// serves the already bundled browser assets; it needs no npm install at runtime.
const root = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
function option(flag, fallback) {
  const index = args.indexOf(flag);
  if (index < 0) return fallback;
  if (!args[index + 1] || args[index + 1].startsWith('--'))
    throw new Error(`Missing ${flag} value.`);
  return resolve(args[index + 1]);
}
const { version } = JSON.parse(
  await readFile(join(root, 'package.json'), 'utf8'),
);
const assets = option('--assets', join(root, 'dist'));
const output = option(
  '--out',
  join(root, 'release', `SpeedGate-helper-${version}.zip`),
);
const prefix = 'SpeedGate-helper/';
const files = {};
async function addAssets(directory, relative = '') {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name),
      name = relative + entry.name;
    if (entry.isDirectory()) await addAssets(path, name + '/');
    else if (entry.isFile())
      files[prefix + 'dist/' + name] = new Uint8Array(await readFile(path));
    else throw new Error('Helper assets must be regular files or directories.');
  }
}
await addAssets(assets);
if (!files[prefix + 'dist/index.html'])
  throw new Error('Build the app before packaging the helper.');
const server = await readFile(join(root, 'server/http-server.ts'), 'utf8');
files[prefix + 'server/http-server.mjs'] = strToU8(
  ts.transpileModule(server, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
    },
  }).outputText,
);
const launcher = (
  await readFile(join(root, 'scripts/serve-lan.mjs'), 'utf8')
).replace("'../server/http-server.ts'", "'../server/http-server.mjs'");
if (launcher.includes("'../server/http-server.ts'"))
  throw new Error('Helper launcher still references TypeScript.');
files[prefix + 'scripts/serve-lan.mjs'] = strToU8(launcher);
files[prefix + 'LICENSE'] = new Uint8Array(
  await readFile(join(root, 'LICENSE')),
);
files[prefix + 'third-party-notices.txt'] = new Uint8Array(
  await readFile(join(root, 'public/third-party-notices.txt')),
);
files[prefix + 'README.txt'] = strToU8(
  `SpeedGate ${version} — temporary LAN helper\n\nRequires an existing Node.js 22.13+ runtime. No npm install is required in this\nextracted folder. No app is installed on either phone.\n\nOn a PC/Mac or a provisioned Android Node environment, extract this ZIP and run:\n\n  SPEEDGATE_TLS_KEY=/path/key.pem SPEEDGATE_TLS_CERT=/path/chain.pem node scripts/serve-lan.mjs\n\nBoth browsers must trust the certificate and open the SAME printed HTTPS\naddress. The certificate must cover that hostname/IP. A downloaded helper\ncannot run itself from a browser, and a browser cannot listen for TCP uploads.\n\nWithout TLS, node scripts/serve-lan.mjs binds localhost for development only.\nStop with Ctrl+C when done. Files are forwarded, never saved on the helper's\ndisk. The helper terminates HTTPS and can see file bytes and metadata in memory.\nReceiver staging, receipts and resumability stay in the receiving browser.\nChanging origin does not migrate existing browser data. Save old copies first.\n\nBrowser-only iPhone-to-Pixel use continues through WebRTC on the public site.\nHTTP/TCP is optional and its physical-device speed is not yet established.\nFor full configuration and trust details see docs/HTTP-TRANSPORT.md in the source.\n`,
);
await mkdir(dirname(output), { recursive: true });
await writeFile(output, zipSync(files, { level: 6 }));
console.log(output);

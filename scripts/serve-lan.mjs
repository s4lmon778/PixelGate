import { readFile } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createSpeedGateServer } from '../server/http-server.ts';

const key = process.env.SPEEDGATE_TLS_KEY;
const cert = process.env.SPEEDGATE_TLS_CERT;
if (!!key !== !!cert)
  throw new Error('Set both SPEEDGATE_TLS_KEY and SPEEDGATE_TLS_CERT.');
const port = Number(process.env.SPEEDGATE_PORT || 8787);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error('Invalid SPEEDGATE_PORT.');
const host = process.env.SPEEDGATE_HOST || (key ? '0.0.0.0' : '127.0.0.1');
const bridge = createSpeedGateServer({
  staticDir: fileURLToPath(new URL('../dist', import.meta.url)),
  key: key ? await readFile(key) : undefined,
  cert: cert ? await readFile(cert) : undefined,
  allowedHosts: (process.env.SPEEDGATE_ALLOWED_HOSTS || '')
    .split(',')
    .filter(Boolean),
});
await new Promise((done) => bridge.server.listen(port, host, done));
console.log(
  `SpeedGate HTTP/TCP bridge: ${key ? 'https' : 'http'}://localhost:${port}`,
);
if (key)
  for (const entry of Object.values(networkInterfaces()).flat()) {
    if (entry?.family === 'IPv4' && !entry.internal)
      console.log(
        `LAN: https://${entry.address}:${port} (certificate must cover this address and be trusted by both devices)`,
      );
  }
else
  console.log(
    'Loopback development only. Configure trusted TLS for LAN devices; see docs/HTTP-TRANSPORT.md.',
  );
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, async () => {
    await bridge.close();
    process.exit(0);
  });

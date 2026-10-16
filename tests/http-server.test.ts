import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { request as rawRequest } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSpeedGateServer } from '../server/http-server';

let bridge: ReturnType<typeof createSpeedGateServer>,
  base: string,
  root: string;
let abort: AbortController;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'speedgate-server-test-'));
  await writeFile(join(root, 'index.html'), '<title>SpeedGate</title>');
  bridge = createSpeedGateServer({ staticDir: root, pairingTTL: 1000 });
  await new Promise<void>((done) => bridge.server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${(bridge.server.address() as AddressInfo).port}/api/speedgate/v1`;
  abort = new AbortController();
});
afterEach(async () => {
  abort.abort();
  await bridge.close();
  await rm(root, { recursive: true, force: true });
});
type Credentials = { id: string; code: string; token: string };
async function pair() {
  const receiver = (await (
    await fetch(base + '/rooms', {
      method: 'POST',
      body: JSON.stringify({ role: 'receive' }),
    })
  ).json()) as Credentials;
  const sender = (await (
    await fetch(base + '/rooms', {
      method: 'POST',
      body: JSON.stringify({ role: 'send', code: receiver.code }),
    })
  ).json()) as Credentials;
  return { receiver, sender };
}
function request(who: Credentials, action: string, init: RequestInit = {}) {
  return fetch(`${base}/rooms/${who.id}/${action}`, {
    ...init,
    signal: abort.signal,
    headers: { Authorization: `Bearer ${who.token}`, ...init.headers },
  });
}
function post(
  who: Credentials,
  sequence: number,
  data: string | Uint8Array<ArrayBuffer>,
) {
  return request(who, `message?sequence=${sequence}`, {
    method: 'POST',
    headers: { 'X-SpeedGate-Kind': typeof data === 'string' ? '0' : '1' },
    body: data,
  });
}
async function readFrames(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  count: number,
) {
  let buffer = Buffer.alloc(0);
  const frames: { kind: number; data: Buffer }[] = [];
  while (frames.length < count) {
    const next = await reader.read();
    if (next.done) throw new Error('Stream truncated.');
    buffer = Buffer.concat([buffer, next.value]);
    while (buffer.length >= 5 && buffer.length >= 5 + buffer.readUInt32BE(1)) {
      const size = buffer.readUInt32BE(1);
      frames.push({ kind: buffer[0], data: buffer.subarray(5, 5 + size) });
      buffer = buffer.subarray(5 + size);
    }
  }
  return frames;
}
describe('local HTTP/TCP streaming and approval', () => {
  it('requires high-entropy role tokens and receiver consent, and consumes the code', async () => {
    const { receiver, sender } = await pair();
    expect((await request({ ...sender, token: 'wrong' }, 'state')).status).toBe(
      403,
    );
    expect((await request(sender, 'stream')).status).toBe(403);
    expect((await request(sender, 'approve', { method: 'POST' })).status).toBe(
      409,
    );
    expect((await request(receiver, 'state')).status).toBe(200);
    expect(
      (await request(receiver, 'approve', { method: 'POST' })).status,
    ).toBe(204);
    expect(
      (
        await fetch(base + '/rooms', {
          method: 'POST',
          body: JSON.stringify({ role: 'send', code: receiver.code }),
        })
      ).status,
    ).toBe(404);
  });
  it('streams out-of-order concurrent POSTs in sequence without altering binary bytes', async () => {
    const { receiver, sender } = await pair();
    await request(receiver, 'approve', { method: 'POST' });
    const stream = (await request(receiver, 'stream')).body!.getReader();
    const binary = new Uint8Array(1024 * 1024);
    for (let index = 0; index < binary.length; index++)
      binary[index] = index % 251;
    const later = post(sender, 1, binary);
    const first = post(sender, 0, '{"type":"hello"}');
    const frames = await readFrames(stream, 2);
    expect((await first).status).toBe(204);
    expect((await later).status).toBe(204);
    expect(frames[0].kind).toBe(0);
    expect(frames[0].data.toString()).toBe('{"type":"hello"}');
    expect(frames[1].kind).toBe(1);
    expect(frames[1].data.equals(binary)).toBe(true);
    expect((await post(sender, 0, 'replay')).status).toBe(409);
  });
  it('bounds body sizes, sequence gaps, duplicate streams and cross-origin access', async () => {
    const { receiver, sender } = await pair();
    await request(receiver, 'approve', { method: 'POST' });
    await request(receiver, 'stream');
    expect((await request(receiver, 'stream')).status).toBe(409);
    expect((await post(sender, 8, 'gap')).status).toBe(409);
    expect(
      (await post(sender, 0, new Uint8Array(1024 * 1024 + 1))).status,
    ).toBe(413);
    expect(
      (
        await fetch(base + '/info', {
          headers: { Origin: 'https://evil.invalid' },
        })
      ).status,
    ).toBe(403);
    const forgedHost = await new Promise((done, reject) => {
      rawRequest(
        base + '/info',
        { headers: { Host: 'evil.invalid' } },
        (response) => {
          response.resume();
          done(response.statusCode);
        },
      )
        .on('error', reject)
        .end();
    });
    expect(forgedHost).toBe(403);
  });
  it('revokes both endpoints and rejects unfinished uploads when a stream is interrupted', async () => {
    const { receiver, sender } = await pair();
    await request(receiver, 'approve', { method: 'POST' });
    const stream = (await request(receiver, 'stream')).body!.getReader();
    const waiting = post(sender, 1, 'not-yet-deliverable').catch(
      () => undefined,
    );
    await stream.cancel();
    await new Promise((done) => setTimeout(done, 50));
    expect((await request(sender, 'state')).status).toBe(404);
    await waiting;
  });
  it('expires unused codes and retains the static browser app', async () => {
    const { receiver } = await pair();
    await new Promise((done) => setTimeout(done, 1050));
    expect([404, 410]).toContain((await request(receiver, 'state')).status);
    const response = await fetch(base.replace('/api/speedgate/v1', '/'));
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('SpeedGate');
    expect(
      (await fetch(base.replace('/api/speedgate/v1', '/%2e%2e/package.json')))
        .status,
    ).not.toBe(200);
  });
});

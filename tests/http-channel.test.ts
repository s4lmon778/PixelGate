import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpChannel } from '../lib/bridge/http-channel';
import { CHECKPOINT_BYTES } from '../lib/bridge/model';

const credentials = {
  id: '00000000-0000-0000-0000-000000000000',
  token: 'test',
};
const channels: HttpChannel[] = [];
const make = () => {
  const channel = new HttpChannel(credentials, 'send');
  channels.push(channel);
  return channel;
};
afterEach(() => {
  for (const channel of channels.splice(0)) channel.close();
  vi.unstubAllGlobals();
});
const ok = () => new Response(null, { status: 204 });
function frame(kind: number, payload: Uint8Array) {
  const bytes = new Uint8Array(5 + payload.length);
  bytes[0] = kind;
  new DataView(bytes.buffer).setUint32(1, payload.length);
  bytes.set(payload, 5);
  return bytes;
}
describe('browser HTTP stream adapter', () => {
  it('snapshots reused buffers and limits concurrent requests without replaying them', async () => {
    const posted: RequestInit[] = [],
      complete: (() => void)[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((_url, init: RequestInit) => {
        if (!String(_url).includes('/message?')) return Promise.resolve(ok());
        posted.push(init);
        return new Promise<Response>((resolve) =>
          complete.push(() => resolve(ok())),
        );
      }),
    );
    const channel = make();
    const source = new Uint8Array(CHECKPOINT_BYTES).fill(3);
    channel.send(source);
    source.fill(4);
    channel.send(source);
    source.fill(5);
    channel.send(source);
    expect(posted).toHaveLength(2);
    expect((posted[0].body as Uint8Array)[0]).toBe(3);
    expect((posted[1].body as Uint8Array)[0]).toBe(4);
    expect(channel.bufferedAmount).toBe(3 * CHECKPOINT_BYTES);
    complete.shift()!();
    await vi.waitFor(() => expect(posted).toHaveLength(3));
    expect((posted[2].body as Uint8Array)[0]).toBe(5);
    complete.splice(0).forEach((done) => done());
    await vi.waitFor(() => expect(channel.bufferedAmount).toBe(0));
    expect(channel.snapshot().uploadedBytes).toBe(3 * CHECKPOINT_BYTES);
  });
  it('reassembles headers and binary bodies split across arbitrary stream reads', async () => {
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        stream = controller;
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn((url) =>
        Promise.resolve(
          String(url).endsWith('/stream') ? new Response(body) : ok(),
        ),
      ),
    );
    const channel = make();
    const messages: unknown[] = [];
    channel.onmessage = (event) => messages.push(event.data);
    await channel.open();
    const control = frame(
      0,
      new TextEncoder().encode('{"type":"hello","version":1}'),
    );
    const original = new Uint8Array(CHECKPOINT_BYTES + 0).fill(0xa7);
    const binary = frame(1, original);
    const wire = new Uint8Array(control.length + binary.length);
    wire.set(control);
    wire.set(binary, control.length);
    for (let offset = 0; offset < wire.length; offset += 7919)
      stream.enqueue(wire.subarray(offset, offset + 7919));
    await vi.waitFor(() => expect(messages).toHaveLength(2));
    expect(messages[0]).toBe('{"type":"hello","version":1}');
    expect(new Uint8Array(messages[1] as ArrayBuffer)).toEqual(original);
    expect(channel.snapshot().deliveredBytes).toBe(original.length);
  });
  it('drops cancelled diagnostic tails while preserving original bytes with the same magic', async () => {
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    vi.stubGlobal(
      'fetch',
      vi.fn((url) =>
        Promise.resolve(
          String(url).endsWith('/stream')
            ? new Response(
                new ReadableStream({
                  start(controller) {
                    stream = controller;
                  },
                }),
              )
            : ok(),
        ),
      ),
    );
    const channel = make(),
      messages: unknown[] = [];
    channel.onmessage = (event) => messages.push(event.data);
    await channel.open();
    const diagnostic = new Uint8Array(16 * 1024 + 12);
    new DataView(diagnostic.buffer).setUint32(0, 0x50475431);
    stream.enqueue(frame(2, diagnostic));
    stream.enqueue(frame(1, diagnostic));
    await vi.waitFor(() => expect(messages).toHaveLength(1));
    expect(new Uint8Array(messages[0] as ArrayBuffer)).toEqual(diagnostic);
    expect(channel.snapshot().deliveredBytes).toBe(diagnostic.length);
    expect(channel.readyState).toBe('open');
  });
  it('fails closed on an oversized incoming frame before allocating its body', async () => {
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    vi.stubGlobal(
      'fetch',
      vi.fn((url) =>
        Promise.resolve(
          String(url).endsWith('/stream')
            ? new Response(
                new ReadableStream({
                  start(controller) {
                    stream = controller;
                  },
                }),
              )
            : ok(),
        ),
      ),
    );
    const channel = make();
    await channel.open();
    const header = new Uint8Array(5);
    header[0] = 1;
    new DataView(header.buffer).setUint32(1, 0xffffffff);
    stream.enqueue(header);
    await vi.waitFor(() => expect(channel.readyState).toBe('closed'));
    expect(channel.snapshot().deliveredBytes).toBe(0);
  });
  it('closes on an uncertain POST failure without automatically retrying bytes', async () => {
    let posts = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn((url) => {
        if (String(url).includes('/message?')) {
          posts++;
          return Promise.reject(new Error('reset'));
        }
        return Promise.resolve(ok());
      }),
    );
    const channel = make();
    channel.send(new Uint8Array(32));
    await vi.waitFor(() => expect(channel.readyState).toBe('closed'));
    expect(posts).toBe(1);
    expect(() => channel.send(new Uint8Array(32))).toThrow(/closed/);
  });
  it('only allows bounded concurrency while idle and rejects excess outbound frames', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(ok())),
    );
    const channel = make();
    for (const value of [0, 5, 1.5, Infinity])
      expect(() => channel.setPayloadLimit(value)).toThrow();
    channel.setPayloadLimit(4);
    expect(channel.snapshot().parallelRequests).toBe(4);
    expect(() => channel.send(new Uint8Array(CHECKPOINT_BYTES + 1))).toThrow(
      /window/,
    );
    channel.send('{"type":"start"}');
    expect(() => channel.setPayloadLimit(1)).toThrow(/Finish/);
  });
});

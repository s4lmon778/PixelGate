import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CodeConnection,
  newPairingCode,
  pairingCode,
} from '../lib/bridge/code-connection';
import { PAIR_TTL } from '../lib/bridge/pairing';

const state = vi.hoisted(() => ({
  peers: [] as (EventEmitter & {
    id: string;
    options: Record<string, unknown>;
    destroyed: boolean;
    disconnected: boolean;
    connect: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
  })[],
  collisions: 0,
  dataFactory: undefined as undefined | (() => unknown),
}));
vi.mock('peerjs', async () => {
  const { EventEmitter } = await import('node:events');
  class FakePeer extends EventEmitter {
    destroyed = false;
    disconnected = false;
    connect = vi.fn((id: string, options: Record<string, unknown>) => {
      void id;
      void options;
      return state.dataFactory!();
    });
    disconnect = vi.fn(() => {
      this.disconnected = true;
      this.emit('disconnected');
    });
    destroy = vi.fn(() => {
      this.destroyed = true;
      this.disconnect();
    });
    constructor(
      public id: string,
      public options: Record<string, unknown>,
    ) {
      super();
      state.peers.push(this);
      Promise.resolve().then(() => {
        if (state.collisions > 0) {
          state.collisions--;
          this.emit(
            'error',
            Object.assign(new Error('taken'), { type: 'unavailable-id' }),
          );
        } else this.emit('open', id);
      });
    }
  }
  return { Peer: FakePeer, SerializationType: { None: 'raw' } };
});

class Data extends EventEmitter {
  label = 'pixelbridge-v1';
  serialization = 'raw';
  reliable = true;
  metadata = { protocol: 'pixelgate-code-v1', nonce: crypto.randomUUID() };
  dataChannel = {
    ordered: true,
    maxRetransmits: null,
    maxPacketLifeTime: null,
    readyState: 'open',
    send: vi.fn(),
    onmessage: undefined as undefined | ((event: { data: unknown }) => void),
  };
  handleMessage = vi.fn().mockResolvedValue(undefined);
  close = vi.fn(() => this.emit('close'));
}
const events = () => ({
  room: vi.fn(),
  status: vi.fn(),
  connected: vi.fn(),
  error: vi.fn(),
});
beforeEach(() => {
  vi.useFakeTimers();
  state.peers.length = 0;
  state.collisions = 0;
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('six-digit code pairing', () => {
  it('rejects invalid LAN input before registering a code', async () => {
    const c = new CodeConnection('receive', events(), '192.168.1.2:4000');
    await expect(c.start()).rejects.toThrow('Wi-Fi IPv4');
    expect(state.peers).toHaveLength(0);
    await c.stop();
  });
  it('tries a local address without signaling it or bypassing consent, then stops polling', async () => {
    const e = events();
    const address = '192.168.1.20';
    const c = new CodeConnection('receive', e, address);
    await c.start();
    const pc = Object.assign(new EventTarget(), {
      signalingState: 'stable',
      iceConnectionState: 'checking',
      iceGatheringState: 'complete',
      connectionState: 'connecting',
      localDescription: undefined,
      remoteDescription: {
        sdp: 'm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=mid:data\r\na=candidate:1 1 udp 2122260223 sender.local 50000 typ host\r\n',
      },
      addIceCandidate: vi.fn().mockResolvedValue(undefined),
      getStats: vi.fn().mockResolvedValue(new Map()),
    });
    const data = Object.assign(new Data(), { peerConnection: pc });
    state.peers[0].emit('connection', data);
    await vi.advanceTimersByTimeAsync(250);
    expect(pc.addIceCandidate).toHaveBeenCalledOnce();
    expect(e.connected).not.toHaveBeenCalled();
    expect(data.dataChannel.send).not.toHaveBeenCalled();
    expect(JSON.stringify(state.peers[0].options)).not.toContain(address);
    data.emit('open');
    expect(e.connected).not.toHaveBeenCalled();
    await c.approve();
    expect(e.connected).toHaveBeenCalledOnce();
    expect(c.room?.diagnostics?.lanCandidatesAdded).toBe(1);
    expect(JSON.stringify(c.room)).not.toContain(address);
    expect(vi.getTimerCount()).toBe(0);
    await c.stop();
  });
  it('accepts six digits, leading zeroes, spaced input, and short fragment links', () => {
    for (const input of [
      '001234',
      '001 234',
      '001-234',
      'https://example.org/PixelGate/#connect=001234',
    ])
      expect(pairingCode(input)).toBe('001234');
    for (const input of [
      '',
      '12345',
      '1234567',
      'abc123',
      'https://example.org/#connect=pg1.fake',
    ])
      expect(() => pairingCode(input)).toThrow('six-digit');
  });
  it('uses unbiased cryptographic sampling and preserves leading zeroes', () => {
    const values = [4294967295, 42];
    vi.spyOn(crypto, 'getRandomValues').mockImplementation((array) => {
      (array as Uint32Array)[0] = values.shift()!;
      return array;
    });
    expect(newPairingCode()).toBe('000042');
    expect(values).toHaveLength(0);
  });
  it('retries occupied IDs within a bounded namespace without enabling TURN', async () => {
    state.collisions = 2;
    const c = new CodeConnection('receive', events());
    await c.start();
    expect(c.room!.code).toMatch(/^\d{6}$/);
    expect(state.peers).toHaveLength(3);
    expect(state.peers[0].destroyed).toBe(true);
    expect(state.peers[2].options.config).toEqual({
      iceServers: [
        { urls: 'stun:stun.cloudflare.com:3478' },
        { urls: 'stun:stun.l.google.com:19302' },
      ],
    });
    await c.stop();
  });
  it('fails after eight collisions rather than endlessly registering IDs', async () => {
    state.collisions = 8;
    await expect(
      new CodeConnection('receive', events()).start(),
    ).rejects.toThrow('taken');
    expect(state.peers).toHaveLength(8);
    expect(state.peers.every((peer) => peer.destroyed)).toBe(true);
  });
  it('blocks files until approval, accepts one sender, and consumes the code', async () => {
    const e = events(),
      c = new CodeConnection('receive', e);
    await c.start();
    await expect(c.approve()).rejects.toThrow('Wait');
    const data = new Data();
    state.peers[0].emit('connection', data);
    data.emit('open');
    expect(c.room!.pending).toBe(true);
    expect(e.connected).not.toHaveBeenCalled();
    e.connected.mockImplementation(() =>
      data.dataChannel.send(JSON.stringify({ type: 'hello', version: 1 })),
    );
    const second = new Data();
    state.peers[0].emit('connection', second);
    expect(second.close).toHaveBeenCalled();
    await c.approve();
    expect(e.connected).toHaveBeenCalledOnce();
    expect(JSON.parse(data.dataChannel.send.mock.calls[0][0])).toEqual({
      type: 'pixelgate-approved',
      version: 1,
      nonce: data.metadata.nonce,
    });
    expect(state.peers[0].disconnected).toBe(true);
    expect(JSON.parse(data.dataChannel.send.mock.calls[1][0]).type).toBe(
      'hello',
    );
    expect(state.peers[0].destroyed).toBe(false);
    await expect(c.approve()).rejects.toThrow('already approved');
    await vi.advanceTimersByTimeAsync(PAIR_TTL + 1);
    expect(e.error).not.toHaveBeenCalled();
    await c.stop();
  });
  it('allows consent when the sender request arrives, before the route opens', async () => {
    const e = events(),
      c = new CodeConnection('receive', e);
    await c.start();
    const data = new Data();
    data.dataChannel.readyState = 'connecting';
    state.peers[0].emit('connection', data);
    expect(c.room!.pending).toBe(true);
    await c.approve();
    expect(c.room!.approvalGranted).toBe(true);
    expect(e.status).toHaveBeenLastCalledWith(
      'Sender approved · connecting directly…',
    );
    expect(e.connected).not.toHaveBeenCalled();
    expect(data.dataChannel.send).not.toHaveBeenCalled();
    await expect(c.approve()).rejects.toThrow('already approved');
    data.dataChannel.readyState = 'open';
    data.emit('open');
    expect(e.connected).toHaveBeenCalledOnce();
    expect(JSON.parse(data.dataChannel.send.mock.calls[0][0]).type).toBe(
      'pixelgate-approved',
    );
    expect(state.peers[0].disconnected).toBe(true);
    await c.stop();
  });
  it('expires approved requests whose direct channel never opens and clears stale approval', async () => {
    const e = events(),
      c = new CodeConnection('receive', e);
    await c.start();
    const data = new Data();
    state.peers[0].emit('connection', data);
    await c.approve();
    await vi.advanceTimersByTimeAsync(45001);
    expect(c.room).toMatchObject({
      pending: false,
      approvalGranted: false,
      failed: true,
    });
    expect(e.connected).not.toHaveBeenCalled();
    expect(data.dataChannel.send).not.toHaveBeenCalled();
    await expect(c.approve()).rejects.toThrow('Wait');
  });
  it('rejects pre-approval media instead of attaching a file receiver', async () => {
    const e = events(),
      c = new CodeConnection('receive', e);
    await c.start();
    const data = new Data();
    state.peers[0].emit('connection', data);
    data.emit('open');
    data.dataChannel.onmessage!({ data: new ArrayBuffer(16) });
    expect(e.connected).not.toHaveBeenCalled();
    expect(e.error.mock.calls[0][0].message).toContain(
      'before receiver approval',
    );
    expect(state.peers[0].destroyed).toBe(true);
  });
  it('expires and revokes active codes immediately', async () => {
    const e = events(),
      c = new CodeConnection('receive', e);
    await c.start();
    await vi.advanceTimersByTimeAsync(PAIR_TTL + 1);
    expect(e.error.mock.calls[0][0].message).toContain('expired');
    expect(state.peers[0].destroyed).toBe(true);
    await expect(c.approve()).rejects.toThrow('Wait');
    const revoked = new CodeConnection('receive', events());
    await revoked.start();
    await revoked.stop();
    const data = new Data();
    state.peers[1].emit('connection', data);
    expect(data.close).toHaveBeenCalled();
  });
  it('requires an approval bound to this sender’s connection nonce', async () => {
    const data = new Data();
    state.dataFactory = () => data;
    const e = events(),
      c = new CodeConnection('send', e);
    await c.start('000042');
    data.emit('open');
    const options = state.peers[0].connect.mock.calls[0];
    expect(options[0]).toBe('pixelgate-v2-000042');
    expect(options[1]).toMatchObject({ reliable: true, serialization: 'raw' });
    expect(e.connected).not.toHaveBeenCalled();
    data.dataChannel.onmessage!({
      data: JSON.stringify({
        type: 'pixelgate-approved',
        version: 1,
        nonce: crypto.randomUUID(),
      }),
    });
    expect(e.connected).not.toHaveBeenCalled();
    expect(state.peers[0].destroyed).toBe(true);
  });
  it('activates the sender only after matching approval and releases its signaling socket', async () => {
    const data = new Data();
    state.dataFactory = () => data;
    const e = events(),
      c = new CodeConnection('send', e);
    await c.start('123456');
    data.emit('open');
    const nonce = state.peers[0].connect.mock.calls[0][1].metadata.nonce;
    data.dataChannel.onmessage!({
      data: JSON.stringify({ type: 'pixelgate-approved', version: 1, nonce }),
    });
    expect(e.connected).toHaveBeenCalledOnce();
    expect(state.peers[0].disconnected).toBe(true);
    expect(state.peers[0].destroyed).toBe(false);
    await c.stop();
  });
  it('bounds unsuccessful direct connection attempts', async () => {
    state.dataFactory = () => new Data();
    const e = events(),
      c = new CodeConnection('send', e);
    await c.start('123456');
    await vi.advanceTimersByTimeAsync(45001);
    expect(e.error.mock.calls[0][0].message).toContain('direct route');
    expect(state.peers[0].destroyed).toBe(true);
  });
});

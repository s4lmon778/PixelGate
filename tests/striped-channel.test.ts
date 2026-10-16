import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StripedChannel } from '../lib/bridge/striped-channel';
import {
  FRAME_BYTES,
  LEGACY_TRANSFER_WINDOW_BYTES,
  CHECKPOINT_BYTES,
  STRIPED_FRAME_BYTES,
  TRANSFER_WINDOW_BYTES,
} from '../lib/bridge/model';

class Channel extends EventTarget {
  label = 'pixelgate-bulk-v1';
  ordered = true;
  maxRetransmits = null;
  maxPacketLifeTime = null;
  binaryType = 'arraybuffer';
  readyState = 'open';
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  onmessage?: (event: MessageEvent) => void;
  sent: (string | ArrayBuffer)[] = [];
  send(data: string | ArrayBuffer) {
    this.sent.push(data);
    this.bufferedAmount +=
      typeof data === 'string' ? data.length : data.byteLength;
  }
  receive(data: string | ArrayBuffer) {
    this.onmessage?.(new MessageEvent('message', { data }));
  }
  close() {
    if (this.readyState === 'closed') return;
    this.readyState = 'closed';
    this.dispatchEvent(new Event('close'));
  }
  native() {
    return this as unknown as RTCDataChannel;
  }
}
class Peer extends EventTarget {
  static peers: Peer[] = [];
  channel = new Channel();
  localDescription?: RTCSessionDescriptionInit;
  remoteDescription?: RTCSessionDescriptionInit;
  signalingState = 'stable';
  connectionState = 'new';
  candidates: RTCIceCandidateInit[] = [];
  async addIceCandidate(candidate: RTCIceCandidateInit) {
    this.candidates.push(candidate);
  }
  constructor() {
    super();
    Peer.peers.push(this);
    this.channel.readyState = 'connecting';
  }
  createDataChannel(_label: string, options: RTCDataChannelInit) {
    this.channel.ordered = options.ordered ?? true;
    return this.channel.native();
  }
  async createOffer() {
    return {
      type: 'offer' as const,
      sdp: 'v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n',
    };
  }
  async setLocalDescription(description: RTCSessionDescriptionInit) {
    this.localDescription = description;
  }
  close() {
    this.channel.close();
    this.signalingState = 'closed';
  }
}
function frame(sequence: number, bytes = new Uint8Array([sequence])) {
  const data = new Uint8Array(bytes.length + 8);
  const view = new DataView(data.buffer);
  view.setUint32(0, 0x50475331);
  view.setUint32(4, sequence);
  data.set(bytes, 8);
  return data.buffer;
}
function receiver() {
  const primary = new Channel();
  const transport = new StripedChannel(primary.native(), 'receive');
  const received: (string | number[])[] = [];
  transport.onmessage = ({ data }) =>
    received.push(
      typeof data === 'string' ? data : Array.from(new Uint8Array(data)),
    );
  primary.receive(
    JSON.stringify({ type: 'hello', version: 1, stripedTransport: 1 }),
  );
  return { primary, transport, received };
}
const opened: StripedChannel[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  Peer.peers = [];
  vi.stubGlobal('RTCPeerConnection', Peer);
});
afterEach(() => {
  for (const channel of opened.splice(0)) channel.close();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
describe('parallel transport compatibility, ordering, and fallback', () => {
  it.each([false, true])(
    'preserves arbitrary raw-file bytes resembling a probe header with probe support=%s',
    (supported) => {
      const primary = new Channel();
      const transport = new StripedChannel(primary.native(), 'receive');
      opened.push(transport);
      const delivered: unknown[] = [];
      transport.onmessage = (event) => delivered.push(event.data);
      primary.receive(
        JSON.stringify({
          type: 'hello',
          version: 1,
          ...(supported ? { peerLinkTest: 1 } : {}),
        }),
      );
      primary.receive(JSON.stringify({ type: 'start', file: {} }));
      const bytes = new Uint8Array(FRAME_BYTES + 12);
      new DataView(bytes.buffer).setUint32(0, 0x50475431);
      primary.receive(bytes.buffer);
      expect(delivered.at(-1)).toBe(bytes.buffer);
      expect(transport.snapshot().deliveredBytes).toBe(bytes.length);
      expect(primary.readyState).toBe('open');
    },
  );
  it('can limit the active payload pool without closing connections and rejects changing it during a file', async () => {
    const primary = new Channel();
    const transport = new StripedChannel(primary.native(), 'send');
    opened.push(transport);
    primary.receive(
      JSON.stringify({
        type: 'hello',
        version: 1,
        stripedTransport: 1,
        stripedReceipts: 1,
        stripedLanes: 13,
      }),
    );
    await vi.advanceTimersByTimeAsync(0);
    for (const peer of Peer.peers) {
      peer.channel.readyState = 'open';
      peer.channel.dispatchEvent(new Event('open'));
    }
    transport.setPayloadLimit(5);
    expect(transport.snapshot()).toMatchObject({
      connections: 14,
      activePayloadConnections: 5,
      payloadConnectionLimit: 5,
    });
    transport.send(JSON.stringify({ type: 'start', file: {} }));
    expect(() => transport.setPayloadLimit(7)).toThrow('Finish the transfer');
    primary.receive(
      JSON.stringify({ type: 'pg-striped-receipt', received: [0] }),
    );
    primary.receive(JSON.stringify({ type: 'result' }));
    transport.setPayloadLimit(7);
    expect(transport.snapshot().activePayloadConnections).toBe(7);
    expect(() => transport.setPayloadLimit(6)).toThrow('Invalid');
  });
  it('shares sender status only with a capable peer, at bounded intervals and without file credit', () => {
    let clock = 100;
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
    const primary = new Channel();
    const transport = new StripedChannel(primary.native(), 'send');
    opened.push(transport);
    const state = {
      stage: 'reading-source',
      stageElapsedMs: 100,
      paused: false,
      visibility: 'visible' as const,
    };
    primary.receive(JSON.stringify({ type: 'hello', version: 1 }));
    transport.publishSourceStatus(state);
    expect(primary.sent).toEqual([]);
    primary.receive(
      JSON.stringify({ type: 'hello', version: 1, sourceStatus: 1 }),
    );
    transport.publishSourceStatus(state);
    expect(primary.sent).toHaveLength(1);
    expect(JSON.parse(primary.sent[0] as string)).toMatchObject({
      type: 'pg-source-status',
      status: { ...state, connections: 1, unreceivedBytes: 0 },
    });
    expect((primary.sent[0] as string).length).toBeLessThan(1024);
    transport.publishSourceStatus(state);
    expect(primary.sent).toHaveLength(1);
    clock += 2000;
    primary.bufferedAmount = 65537;
    transport.publishSourceStatus(state);
    expect(primary.sent).toHaveLength(1);
    primary.bufferedAmount = 0;
    transport.publishSourceStatus({
      ...state,
      paused: true,
      visibility: 'hidden',
    });
    expect(primary.sent).toHaveLength(2);
    expect(transport.snapshot().unreceivedBytes).toBe(0);
    clock += 2000;
    const send = vi.spyOn(primary, 'send').mockImplementationOnce(() => {
      throw new Error('diagnostic send failure');
    });
    expect(() => transport.publishSourceStatus(state)).not.toThrow();
    expect(primary.readyState).toBe('open');
    send.mockRestore();
    vi.restoreAllMocks();
  });
  it('retains bounded sender samples separately from ordered bytes and labels stale reports', () => {
    let clock = 100;
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
    const { primary, transport, received } = receiver();
    opened.push(transport);
    const status = {
      stage: 'waiting-for-ack',
      stageElapsedMs: 23000,
      paused: false,
      visibility: 'visible',
      connections: 5,
      unreceivedBytes: 0,
      oldestUnreceivedMs: 0,
      receiptDelayMs: 20,
      queuedDelayMs: 0,
      replayedPackets: 3,
      sendBufferBytes: 262144,
      sendFrameBytes: 16384,
      deprioritizedConnections: 0,
    };
    const wire = JSON.stringify({ type: 'pg-source-status', status });
    primary.receive(wire);
    expect(transport.snapshot().source).toBeUndefined();
    primary.receive(
      JSON.stringify({ type: 'hello', version: 1, sourceStatus: 1 }),
    );
    const before = received.length;
    primary.receive(wire);
    expect(received).toHaveLength(before);
    expect(transport.snapshot().source).toEqual({ ...status, sampleAgeMs: 0 });
    clock += 25000;
    primary.receive(
      JSON.stringify({
        type: 'pg-source-status',
        status: { ...status, connections: -1 },
      }),
    );
    expect(transport.snapshot().source?.sampleAgeMs).toBe(25000);
    expect(primary.readyState).toBe('open');
    primary.close();
    expect(transport.snapshot().source).toBeUndefined();
    vi.restoreAllMocks();
  });
  it.each([
    ['Mozilla/5.0 (iPhone) Mobile', 4],
    ['Mozilla/5.0 (Linux; Android 9; Pixel XL) Mobile', 4],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 13],
  ])(
    'advertises and negotiates a matching local connection budget for %s',
    async (userAgent, limit) => {
      vi.stubGlobal('navigator', { userAgent, maxTouchPoints: 0 });
      const primary = new Channel();
      const transport = new StripedChannel(primary.native(), 'send');
      opened.push(transport);
      transport.send(JSON.stringify({ type: 'hello', version: 1 }));
      expect(JSON.parse(primary.sent[0] as string).stripedLanes).toBe(13);
      primary.receive(
        JSON.stringify({
          type: 'hello',
          version: 1,
          stripedTransport: 1,
          stripedReceipts: 1,
          stripedLanes: 13,
        }),
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(Peer.peers).toHaveLength(limit);
      expect(transport.snapshot().payloadConnectionLimit).toBe(limit + 1);
      transport.setPayloadLimit(14);
      await vi.advanceTimersByTimeAsync(0);
      expect(Peer.peers).toHaveLength(13);
      transport.setPayloadLimit(5);
      expect(transport.snapshot().payloadConnectionLimit).toBe(5);
      expect(transport.readyState).toBe('open');
    },
  );
  it('keeps file preparation bounded when native offer creation never settles', async () => {
    const offer = vi
      .spyOn(Peer.prototype, 'createOffer')
      .mockImplementation(() => new Promise(() => {}));
    try {
      const primary = new Channel();
      const transport = new StripedChannel(primary.native(), 'send');
      opened.push(transport);
      primary.receive(
        JSON.stringify({
          type: 'hello',
          version: 1,
          stripedTransport: 1,
          stripedReceipts: 1,
          stripedLanes: 13,
        }),
      );
      const prepared = transport.prepare();
      await vi.advanceTimersByTimeAsync(501);
      await expect(prepared).resolves.toBeUndefined();
      expect(transport.readyState).toBe('open');
    } finally {
      offer.mockRestore();
    }
  });
  it('starts a computer sender with five connections when its peer identifies as a phone', async () => {
    const primary = new Channel();
    const transport = new StripedChannel(primary.native(), 'send');
    opened.push(transport);
    primary.receive(
      JSON.stringify({
        type: 'hello',
        version: 1,
        deviceKind: 'phone',
        stripedTransport: 1,
        stripedReceipts: 1,
        stripedLanes: 13,
      }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(Peer.peers).toHaveLength(4);
    expect(transport.defaultPayloadConnections).toBe(5);
    expect(transport.maximumPayloadConnections).toBe(14);
  });
  it('exchanges broad device kinds in existing hellos without changing legacy transfer behavior', () => {
    const primary = new Channel();
    const transport = new StripedChannel(primary.native(), 'receive');
    opened.push(transport);
    vi.stubGlobal('navigator', {
      userAgent: 'Mozilla/5.0 (iPhone) Mobile',
      maxTouchPoints: 5,
    });
    transport.send(JSON.stringify({ type: 'hello', version: 1 }));
    const hello = JSON.parse(primary.sent[0] as string);
    expect(hello.deviceKind).toBe('phone');
    expect(JSON.stringify(hello)).not.toContain('Mozilla');
    const received: unknown[] = [];
    transport.addEventListener('peer-device', (event) =>
      received.push((event as CustomEvent).detail),
    );
    primary.receive(
      JSON.stringify({ type: 'hello', version: 1, deviceKind: 'computer' }),
    );
    primary.receive(JSON.stringify({ type: 'hello', version: 1 }));
    primary.receive(
      JSON.stringify({ type: 'hello', version: 1, deviceKind: '<img>' }),
    );
    expect(received).toEqual(['computer', null, null]);
    expect(primary.readyState).toBe('open');
  });
  it('keeps received-byte totals in diagnostics after a bulk lane closes', () => {
    const { primary, transport } = receiver();
    opened.push(transport);
    primary.receive(JSON.stringify({ type: 'pg-lane', index: 0 }));
    const peer = Peer.peers[0];
    peer.channel.readyState = 'open';
    (
      peer as unknown as {
        ondatachannel: (event: { channel: RTCDataChannel }) => void;
      }
    ).ondatachannel({ channel: peer.channel.native() });
    primary.receive(JSON.stringify({ type: 'pg-striped-start' }));
    peer.channel.receive(frame(0, new Uint8Array(16)));
    primary.receive(frame(1, new Uint8Array(8)));
    peer.channel.close();
    const report = transport.snapshot();
    expect(report.connections).toBe(1);
    expect(report.deliveredBytes).toBe(24);
    expect(
      report.paths?.reduce((sum, path) => sum + path.receivedBytes, 0),
    ).toBe(40);
  });
  it('measures actual received wire bytes and distinguishes a reorder stall from delivered bytes', async () => {
    const { primary, transport } = receiver();
    opened.push(transport);
    primary.receive(JSON.stringify({ type: 'pg-striped-start' }));
    primary.receive(frame(1, new Uint8Array(16)));
    expect(transport.snapshot()).toMatchObject({
      measurement: 'receiver-wire-bytes',
      deliveredBytes: 0,
      reorderedBytes: 16,
      paths: [{ path: 1, receivedBytes: 24 }],
    });
    primary.receive(frame(0, new Uint8Array(8)));
    primary.receive(frame(0, new Uint8Array(8)));
    expect(transport.snapshot()).toMatchObject({
      deliveredBytes: 24,
      reorderedBytes: 0,
      paths: [{ path: 1, receivedBytes: 56 }],
    });
  });
  it('recovers the last packet without a later receipt, and keeps retrying with backoff after three lost copies', async () => {
    vi.spyOn(performance, 'now').mockImplementation(() => Date.now());
    const primary = new Channel();
    const transport = new StripedChannel(primary.native(), 'send');
    opened.push(transport);
    primary.receive(
      JSON.stringify({
        type: 'hello',
        version: 1,
        stripedTransport: 1,
        stripedReceipts: 1,
        stripedLanes: 4,
      }),
    );
    await vi.advanceTimersByTimeAsync(0);
    for (const peer of Peer.peers) {
      peer.channel.readyState = 'open';
      peer.channel.dispatchEvent(new Event('open'));
    }
    transport.send(new Uint8Array([42]).buffer);
    const all = [primary, ...Peer.peers.map((peer) => peer.channel)];
    await vi.advanceTimersByTimeAsync(1900);
    expect(transport.snapshot().replayedPackets).toBe(0);
    for (const channel of all) channel.bufferedAmount = 0;
    await vi.advanceTimersByTimeAsync(29000);
    expect(transport.snapshot().replayedPackets).toBeGreaterThan(3);
    expect(transport.snapshot().replayedPackets).toBeLessThan(8);
    expect(transport.snapshot().unreceivedBytes).toBe(9);
    primary.receive(
      JSON.stringify({ type: 'pg-striped-receipt', received: [0] }),
    );
    expect(transport.snapshot().unreceivedBytes).toBe(0);
    const replays = transport.snapshot().replayedPackets;
    await vi.advanceTimersByTimeAsync(30000);
    expect(transport.snapshot().replayedPackets).toBe(replays);
    vi.restoreAllMocks();
  });
  it('snapshots each native buffer once per burst and stops at sender credit', async () => {
    const primary = new Channel();
    const transport = new StripedChannel(primary.native(), 'send');
    opened.push(transport);
    primary.receive(
      JSON.stringify({
        type: 'hello',
        version: 1,
        stripedTransport: 1,
        stripedReceipts: 1,
        stripedLanes: 4,
        stripedFrameBytes: STRIPED_FRAME_BYTES,
      }),
    );
    await vi.advanceTimersByTimeAsync(0);
    const all = [primary, ...Peer.peers.map((peer) => peer.channel)];
    for (const channel of all) channel.readyState = 'open';
    const native = all.map(() => 0);
    const reads = all.map(() => 0);
    for (const [index, channel] of all.entries()) {
      Object.defineProperty(channel, 'bufferedAmount', {
        get: () => {
          reads[index]++;
          return native[index];
        },
      });
      channel.send = (wire) => {
        channel.sent.push(wire);
        native[index] +=
          typeof wire === 'string' ? wire.length : wire.byteLength;
      };
    }
    const input = new Uint8Array(CHECKPOINT_BYTES);
    for (let i = 0; i < input.length; i++) input[i] = i % 251;
    let sent = 0;
    while (sent < input.length) {
      reads.fill(0);
      const count = transport.sendBurst(input.subarray(sent));
      expect(reads).toEqual([1, 1, 1, 1, 1]);
      if (!count) break;
      sent += count;
    }
    expect(sent).toBeGreaterThan(512 * 1024 - FRAME_BYTES);
    expect(sent).toBeLessThanOrEqual(512 * 1024 + FRAME_BYTES);
    const frames = all
      .flatMap((channel) => channel.sent)
      .filter((wire): wire is ArrayBuffer => wire instanceof ArrayBuffer)
      .sort(
        (a, b) => new DataView(a).getUint32(4) - new DataView(b).getUint32(4),
      );
    const actual = new Uint8Array(sent);
    let offset = 0;
    for (const wire of frames) {
      actual.set(new Uint8Array(wire, 8), offset);
      offset += wire.byteLength - 8;
    }
    expect(actual).toEqual(input.subarray(0, sent));
    expect(native.every((bytes) => bytes > 0)).toBe(true);
    expect(transport.snapshot().unreceivedBytes).toBeLessThanOrEqual(
      512 * 1024 + FRAME_BYTES + 8,
    );
    // Native drain alone cannot release unreceived bytes.
    native.fill(0);
    expect(transport.sendBurst(input.subarray(sent))).toBe(0);
    primary.receive(
      JSON.stringify({ type: 'pg-striped-ack', sequence: frames.length }),
    );
    expect(transport.sendBurst(input.subarray(sent))).toBeGreaterThan(0);
  });
  it('refreshes a burst path when native state closes before its event, then rediscovers it next burst', async () => {
    const primary = new Channel();
    const transport = new StripedChannel(primary.native(), 'send');
    opened.push(transport);
    primary.receive(
      JSON.stringify({
        type: 'hello',
        version: 1,
        stripedTransport: 1,
        stripedReceipts: 1,
        stripedLanes: 4,
      }),
    );
    await vi.advanceTimersByTimeAsync(0);
    for (const peer of Peer.peers) peer.channel.readyState = 'open';
    const unavailable = Peer.peers[1].channel;
    let closed = false;
    for (const channel of [
      primary,
      ...Peer.peers.map((peer) => peer.channel),
    ]) {
      channel.send = (wire) => {
        if (channel === unavailable && channel.readyState !== 'open')
          throw new Error('Closed native path');
        Channel.prototype.send.call(channel, wire);
        if (wire instanceof ArrayBuffer && !closed) {
          unavailable.readyState = 'closed';
          closed = true; // Deliberately no close event yet.
        }
      };
    }
    expect(transport.sendBurst(new Uint8Array(64 * 1024))).toBe(64 * 1024);
    expect(unavailable.sent).toEqual([]);
    unavailable.readyState = 'open';
    expect(transport.sendBurst(new Uint8Array(64 * 1024))).toBe(64 * 1024);
    expect(unavailable.sent.some((wire) => wire instanceof ArrayBuffer)).toBe(
      true,
    );
    expect(primary.readyState).toBe('open');
  });
  it('drops a native buffer snapshot after send throws', async () => {
    const primary = new Channel();
    const transport = new StripedChannel(primary.native(), 'send');
    opened.push(transport);
    primary.send = () => {
      throw new Error('Native send failed');
    };
    expect(() => transport.sendBurst(new Uint8Array(100))).toThrow(
      'Native send failed',
    );
    primary.send = Channel.prototype.send;
    primary.bufferedAmount = CHECKPOINT_BYTES;
    expect(transport.sendBurst(new Uint8Array(100))).toBe(0);
    primary.bufferedAmount = 0;
    expect(transport.sendBurst(new Uint8Array(100))).toBe(100);
  });
  it('limits synchronous burst work when native sending is slow', () => {
    let clock = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
    const primary = new Channel();
    const transport = new StripedChannel(primary.native(), 'send');
    opened.push(transport);
    primary.send = (wire) => {
      clock += 9;
      Channel.prototype.send.call(primary, wire);
    };
    expect(transport.sendBurst(new Uint8Array(CHECKPOINT_BYTES))).toBe(
      FRAME_BYTES,
    );
    expect(primary.sent).toHaveLength(1);
    vi.restoreAllMocks();
  });
  it('accepts larger messages only after mutual receipt/frame negotiation', () => {
    const primary = new Channel();
    const transport = new StripedChannel(primary.native(), 'receive');
    opened.push(transport);
    const received: Uint8Array[] = [];
    transport.onmessage = ({ data }) => {
      if (data instanceof Uint8Array) received.push(data);
    };
    primary.receive(
      JSON.stringify({
        type: 'hello',
        version: 1,
        stripedTransport: 1,
        stripedReceipts: 1,
        stripedFrameBytes: STRIPED_FRAME_BYTES,
      }),
    );
    expect(transport.frameBytes).toBe(STRIPED_FRAME_BYTES);
    primary.receive(JSON.stringify({ type: 'pg-striped-start' }));
    const wire = frame(0, new Uint8Array(STRIPED_FRAME_BYTES).fill(19));
    primary.receive(wire);
    expect(received[0].buffer).toBe(wire);
    expect(received[0].byteOffset).toBe(8);
    expect(received[0].byteLength).toBe(STRIPED_FRAME_BYTES);
    expect(new Uint8Array(received[0]).every((byte) => byte === 19)).toBe(true);
    primary.receive(frame(1, new Uint8Array(STRIPED_FRAME_BYTES + 1)));
    expect(primary.readyState).toBe('closed');
  });
  it('retains 16 KiB frames for a receipt-capable older client', () => {
    const primary = new Channel();
    const transport = new StripedChannel(primary.native(), 'receive');
    opened.push(transport);
    primary.receive(
      JSON.stringify({
        type: 'hello',
        version: 1,
        stripedTransport: 1,
        stripedReceipts: 1,
      }),
    );
    expect(transport.frameBytes).toBe(FRAME_BYTES);
    primary.receive(JSON.stringify({ type: 'pg-striped-start' }));
    primary.receive(frame(0, new Uint8Array(FRAME_BYTES + 1)));
    expect(primary.readyState).toBe('closed');
  });
  it('tries the user-supplied local address on a bulk peer without exporting it', async () => {
    const primary = new Channel();
    const transport = new StripedChannel(
      primary.native(),
      'receive',
      '192.168.1.15',
    );
    opened.push(transport);
    primary.receive(
      JSON.stringify({ type: 'hello', version: 1, stripedTransport: 1 }),
    );
    primary.receive(
      JSON.stringify({
        type: 'pg-lane',
        index: 0,
        candidate: {
          candidate: 'candidate:x 1 udp 2122260223 hidden.local 12345 typ host',
          sdpMid: '0',
          sdpMLineIndex: 0,
        },
      }),
    );
    const peer = Peer.peers[0];
    peer.remoteDescription = {
      type: 'offer',
      sdp: 'v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=mid:0\r\na=candidate:x 1 udp 2122260223 hidden.local 12345 typ host\r\n',
    };
    await vi.advanceTimersByTimeAsync(250);
    expect(peer.candidates).toContainEqual({
      candidate: 'candidate:x 1 udp 2122260223 192.168.1.15 12345 typ host',
      sdpMid: '0',
      sdpMLineIndex: 0,
    });
    expect(JSON.stringify(transport.snapshot())).not.toContain('192.168.1.15');
    expect(JSON.stringify(primary.sent)).not.toContain('192.168.1.15');
    transport.close();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('retains raw frames when the other client lacks capability support', () => {
    const primary = new Channel(),
      transport = new StripedChannel(primary.native(), 'send');
    opened.push(transport);
    primary.receive(JSON.stringify({ type: 'hello', version: 1 }));
    const bytes = new Uint8Array([2, 5, 9]).buffer;
    transport.send(bytes);
    expect(primary.sent).toEqual([bytes]);
    expect(Peer.peers).toHaveLength(0);
  });
  it('reassembles displaced frames and controls once, including packets before the switch', () => {
    const { primary, transport, received } = receiver();
    opened.push(transport);
    const start = JSON.stringify({ type: 'start', file: {} });
    primary.receive(start);
    primary.receive(
      JSON.stringify({
        type: 'pg-striped-control',
        sequence: 2,
        value: '{"type":"cancel"}',
      }),
    );
    primary.receive(JSON.stringify({ type: 'pg-striped-start' }));
    primary.receive(frame(1, new Uint8Array([4, 9])));
    expect(received).toEqual([
      JSON.stringify({ type: 'hello', version: 1, stripedTransport: 1 }),
      start,
    ]);
    primary.receive(frame(0, new Uint8Array([8])));
    primary.receive(frame(1, new Uint8Array([4, 9])));
    expect(received.slice(2)).toEqual([[8], [4, 9], '{"type":"cancel"}']);
    expect(primary.readyState).toBe('open');
  });
  it('rejects sequence gaps beyond the bounded reassembly window', () => {
    const { primary, transport } = receiver();
    opened.push(transport);
    primary.receive(JSON.stringify({ type: 'pg-striped-start' }));
    primary.receive(frame(TRANSFER_WINDOW_BYTES / FRAME_BYTES + 33));
    expect(primary.readyState).toBe('closed');
  });
  it.each([new ArrayBuffer(8), frame(0, new Uint8Array(FRAME_BYTES + 1))])(
    'rejects invalid frame size',
    (bytes) => {
      const { primary, transport } = receiver();
      opened.push(transport);
      primary.receive(JSON.stringify({ type: 'pg-striped-start' }));
      primary.receive(bytes);
      expect(primary.readyState).toBe('closed');
    },
  );
  it('opens independent connections and retransmits unreceived frames when one closes', async () => {
    const primary = new Channel(),
      transport = new StripedChannel(primary.native(), 'send');
    opened.push(transport);
    transport.bufferedAmountLowThreshold = 32768;
    primary.receive(
      JSON.stringify({ type: 'hello', version: 1, stripedTransport: 1 }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(Peer.peers).toHaveLength(2);
    for (const peer of Peer.peers) {
      peer.channel.readyState = 'open';
      peer.channel.dispatchEvent(new Event('open'));
    }
    const bytes = new Uint8Array([8, 7, 6]).buffer;
    transport.send(bytes);
    const lane = Peer.peers.find((peer) => peer.channel.sent.length)!;
    expect(lane).toBeDefined();
    const packet = lane.channel.sent[0];
    expect(lane.channel.bufferedAmountLowThreshold).toBeLessThan(32768 / 2);
    lane.channel.close();
    expect(primary.sent).toContain(packet);
    expect(transport.readyState).toBe('open');
    const before = primary.sent.length;
    primary.receive(JSON.stringify({ type: 'pg-striped-ack', sequence: 0 }));
    expect(primary.sent).toHaveLength(before);
  });
  it('continues on the primary when extra connections are unavailable', async () => {
    vi.stubGlobal(
      'RTCPeerConnection',
      class {
        constructor() {
          throw new Error('Connection limit');
        }
      },
    );
    const primary = new Channel(),
      transport = new StripedChannel(primary.native(), 'send');
    opened.push(transport);
    primary.receive(
      JSON.stringify({ type: 'hello', version: 1, stripedTransport: 1 }),
    );
    await vi.advanceTimersByTimeAsync(0);
    transport.send(new Uint8Array([1]).buffer);
    expect(primary.readyState).toBe('open');
    expect(primary.sent).toHaveLength(1);
  });
  it('rejects transport acknowledgments for unsent packets', () => {
    const primary = new Channel(),
      transport = new StripedChannel(primary.native(), 'send');
    opened.push(transport);
    primary.receive(JSON.stringify({ type: 'pg-striped-ack', sequence: 0 }));
    expect(primary.readyState).toBe('closed');
  });
  it('bounds the number of additional connections from negotiation inputs', () => {
    const { primary, transport } = receiver();
    opened.push(transport);
    for (let index = 2; index < 100; index++)
      primary.receive(JSON.stringify({ type: 'pg-lane', index }));
    expect(Peer.peers).toHaveLength(0);
    expect(primary.readyState).toBe('open');
  });
  it('uses bounded unordered bulk lanes only with the new mutually supported receipts', async () => {
    const primary = new Channel(),
      transport = new StripedChannel(primary.native(), 'send');
    opened.push(transport);
    primary.receive(
      JSON.stringify({
        type: 'hello',
        version: 1,
        stripedTransport: 1,
        stripedReceipts: 1,
        stripedLanes: 99,
      }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(Peer.peers).toHaveLength(13);
    for (const peer of Peer.peers) {
      expect(peer.channel.ordered).toBe(false);
      peer.channel.readyState = 'open';
      peer.channel.dispatchEvent(new Event('open'));
    }
    const all = [primary, ...Peer.peers.map((peer) => peer.channel)];
    for (let i = 0; i < 70; i++) {
      for (const channel of all) channel.bufferedAmount = 0;
      transport.send(new Uint8Array([i]).buffer);
    }
    for (const channel of all)
      expect(
        channel.sent.filter((data) => data instanceof ArrayBuffer),
      ).toHaveLength(5);
    expect(transport.snapshot()).toMatchObject({
      connections: 14,
      selectiveReceipts: true,
      unreceivedBytes: 630,
    });
    primary.receive(
      JSON.stringify({ type: 'pg-striped-receipt', received: [0, 1, 2, 3] }),
    );
    expect(transport.snapshot().unreceivedBytes).toBe(594);
    expect(transport.sendBufferBytes).toBe(512 * 1024);
  });
  it.each<[number | undefined, number]>([
    [undefined, 2],
    [4, 4],
    [6, 6],
    [13, 13],
    [99, 13],
  ])(
    'negotiates peer bulk limit %s as %i without changing aggregate credit',
    async (advertised, expected) => {
      const primary = new Channel();
      const transport = new StripedChannel(primary.native(), 'send');
      opened.push(transport);
      primary.receive(
        JSON.stringify({
          type: 'hello',
          version: 1,
          stripedTransport: 1,
          stripedReceipts: 1,
          stripedLanes: advertised,
        }),
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(Peer.peers).toHaveLength(expected);
      for (const peer of Peer.peers) {
        peer.channel.readyState = 'open';
        peer.channel.dispatchEvent(new Event('open'));
      }
      transport.send(new Uint8Array(FRAME_BYTES));
      expect(transport.snapshot().connections).toBe(expected + 1);
      expect(transport.sendBufferBytes).toBe(512 * 1024);
      expect(transport.receiveWindowBytes).toBe(CHECKPOINT_BYTES);
      Peer.peers.at(-1)!.channel.close();
      expect(transport.snapshot().connections).toBe(expected);
      primary.receive(
        JSON.stringify({ type: 'pg-striped-receipt', received: [0] }),
      );
      expect(transport.snapshot().unreceivedBytes).toBe(0);
    },
  );
  it.each([false, true])(
    'serializes native offers and stops setup after close=%s',
    async (close) => {
      let finishOffer!: (value: { type: 'offer'; sdp: string }) => void;
      vi.spyOn(Peer.prototype, 'createOffer').mockImplementationOnce(
        () => new Promise((resolve) => (finishOffer = resolve)),
      );
      const primary = new Channel();
      const transport = new StripedChannel(primary.native(), 'send');
      opened.push(transport);
      primary.receive(
        JSON.stringify({
          type: 'hello',
          version: 1,
          stripedTransport: 1,
          stripedReceipts: 1,
          stripedLanes: 13,
        }),
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(Peer.peers).toHaveLength(1);
      if (close) transport.close();
      finishOffer({
        type: 'offer',
        sdp: 'v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n',
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(Peer.peers).toHaveLength(close ? 1 : 13);
      const offers = primary.sent.filter(
        (wire) =>
          typeof wire === 'string' &&
          JSON.parse(wire).description !== undefined,
      );
      expect(offers).toHaveLength(close ? 0 : 13);
    },
  );
  it.each([40, 80, 81, 200])(
    'keeps fourteen connections but bounds active paths at learned delay %i ms',
    async (delay) => {
      let clock = 100;
      vi.spyOn(performance, 'now').mockImplementation(() => clock);
      const primary = new Channel();
      const transport = new StripedChannel(primary.native(), 'send');
      opened.push(transport);
      primary.receive(
        JSON.stringify({
          type: 'hello',
          version: 1,
          stripedTransport: 1,
          stripedReceipts: 1,
          stripedLanes: 13,
        }),
      );
      await vi.advanceTimersByTimeAsync(0);
      const channels = [primary, ...Peer.peers.map((peer) => peer.channel)];
      for (const channel of channels) {
        channel.readyState = 'open';
        channel.dispatchEvent(new Event('open'));
      }
      for (let index = 0; index < 14; index++) {
        for (const channel of channels) channel.bufferedAmount = 0;
        transport.send(new Uint8Array(FRAME_BYTES));
      }
      clock += delay;
      primary.receive(
        JSON.stringify({
          type: 'pg-striped-receipt',
          received: Array.from({ length: 14 }, (_, index) => index),
        }),
      );
      const active = delay > 80 ? 7 : 14;
      expect(transport.snapshot()).toMatchObject({
        connections: 14,
        activePayloadConnections: active,
        unreceivedBytes: 0,
      });
      for (let index = 0; index < 14; index++) {
        for (const channel of channels) channel.bufferedAmount = 0;
        transport.send(new Uint8Array(FRAME_BYTES));
      }
      for (const [index, channel] of channels.entries()) {
        const sent = channel.sent.filter((wire) => wire instanceof ArrayBuffer);
        expect(sent).toHaveLength(active === 14 ? 2 : index < 7 ? 3 : 1);
      }
      clock += delay;
      primary.receive(
        JSON.stringify({
          type: 'pg-striped-receipt',
          received: Array.from({ length: 14 }, (_, index) => index + 14),
        }),
      );
      expect(transport.snapshot().unreceivedBytes).toBe(0);
    },
  );
  it('repairs a pending packet from a path no longer selected on a distant route', async () => {
    let clock = 100;
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
    const primary = new Channel();
    const transport = new StripedChannel(primary.native(), 'send');
    opened.push(transport);
    primary.receive(
      JSON.stringify({
        type: 'hello',
        version: 1,
        stripedTransport: 1,
        stripedReceipts: 1,
        stripedLanes: 13,
      }),
    );
    await vi.advanceTimersByTimeAsync(0);
    const channels = [primary, ...Peer.peers.map((peer) => peer.channel)];
    for (const channel of channels) {
      channel.readyState = 'open';
      channel.dispatchEvent(new Event('open'));
    }
    for (let index = 0; index < 14; index++) {
      for (const channel of channels) channel.bufferedAmount = 0;
      transport.send(new Uint8Array(FRAME_BYTES));
    }
    const original = channels[13].sent.find(
      (wire) => wire instanceof ArrayBuffer,
    )! as ArrayBuffer;
    const missing = new DataView(original).getUint32(4);
    clock += 200;
    primary.receive(
      JSON.stringify({
        type: 'pg-striped-receipt',
        received: Array.from({ length: 14 }, (_, index) => index).filter(
          (sequence) => sequence !== missing,
        ),
      }),
    );
    expect(transport.snapshot().activePayloadConnections).toBe(7);
    for (const channel of channels) channel.bufferedAmount = 0;
    clock = 800;
    await vi.advanceTimersByTimeAsync(100);
    expect(
      channels
        .slice(0, 7)
        .flatMap((channel) =>
          channel.sent.filter(
            (wire) =>
              wire instanceof ArrayBuffer &&
              new DataView(wire).getUint32(4) === missing,
          ),
        ),
    ).toHaveLength(1);
    expect(
      channels[13].sent.filter((wire) => wire instanceof ArrayBuffer),
    ).toHaveLength(1);
    primary.receive(
      JSON.stringify({ type: 'pg-striped-receipt', received: [missing] }),
    );
    expect(transport.snapshot().unreceivedBytes).toBe(0);
  });
  it('grows a bounded delivery window only after receipts and restores conservative pacing on delayed delivery', async () => {
    let clock = 100;
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
    const primary = new Channel();
    const transport = new StripedChannel(primary.native(), 'send');
    opened.push(transport);
    expect(transport.pacingDelayMs).toBe(4);
    primary.receive(
      JSON.stringify({
        type: 'hello',
        version: 1,
        stripedTransport: 1,
        stripedReceipts: 1,
        stripedLanes: 4,
      }),
    );
    await vi.advanceTimersByTimeAsync(0);
    for (const peer of Peer.peers) {
      peer.channel.readyState = 'open';
      peer.channel.dispatchEvent(new Event('open'));
    }
    expect(transport.sendBufferBytes).toBe(64 * 1024);
    for (let sequence = 0; sequence < 512; sequence += 16) {
      for (let j = 0; j < 16; j++)
        transport.send(new Uint8Array(FRAME_BYTES).buffer);
      clock += 10;
      primary.receive(
        JSON.stringify({
          type: 'pg-striped-receipt',
          received: Array.from({ length: 16 }, (_, i) => sequence + i),
        }),
      );
      for (const channel of [
        primary,
        ...Peer.peers.map((peer) => peer.channel),
      ])
        channel.bufferedAmount = 0;
      expect(transport.sendBufferBytes).toBeLessThanOrEqual(
        2 * CHECKPOINT_BYTES,
      );
    }
    expect(transport.sendBufferBytes).toBe(2 * CHECKPOINT_BYTES);
    expect(transport.burstBytes).toBe(256 * 1024);
    expect(transport.pacingDelayMs).toBe(0);
    for (let i = 0; i < 16; i++)
      transport.send(new Uint8Array(FRAME_BYTES).buffer);
    clock += 300;
    primary.receive(
      JSON.stringify({
        type: 'pg-striped-receipt',
        received: Array.from({ length: 16 }, (_, i) => 512 + i),
      }),
    );
    expect(transport.sendBufferBytes).toBe(256 * 1024);
    expect(transport.pacingDelayMs).toBe(4);
    expect(transport.snapshot().unreceivedBytes).toBe(0);
    for (let i = 0; i < 16; i++)
      transport.send(new Uint8Array(FRAME_BYTES).buffer);
    clock += 1000;
    primary.receive(
      JSON.stringify({
        type: 'pg-striped-receipt',
        received: Array.from({ length: 16 }, (_, i) => 528 + i),
      }),
    );
    expect(transport.sendBufferBytes).toBe(128 * 1024);
    expect(transport.pacingDelayMs).toBe(4);
    vi.restoreAllMocks();
  });
  it('keeps healthy paths supplied when one path queues, but backs off when several do', async () => {
    let clock = 100;
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
    const primary = new Channel();
    const transport = new StripedChannel(primary.native(), 'send');
    opened.push(transport);
    primary.receive(
      JSON.stringify({
        type: 'hello',
        version: 1,
        stripedTransport: 1,
        stripedReceipts: 1,
        stripedLanes: 4,
        stripedFrameBytes: STRIPED_FRAME_BYTES,
      }),
    );
    await vi.advanceTimersByTimeAsync(0);
    for (const peer of Peer.peers) {
      peer.channel.readyState = 'open';
      peer.channel.dispatchEvent(new Event('open'));
    }
    const channels = [primary, ...Peer.peers.map((peer) => peer.channel)];
    const receipt = (received: number[]) =>
      primary.receive(JSON.stringify({ type: 'pg-striped-receipt', received }));
    for (let sequence = 0; sequence < 800; sequence += 16) {
      for (const channel of channels) channel.bufferedAmount = 0;
      for (let i = 0; i < 16; i++)
        transport.send(new Uint8Array(FRAME_BYTES).buffer);
      clock += 20;
      receipt(Array.from({ length: 16 }, (_, i) => sequence + i));
    }
    const delayed = channels[4];
    const batch = (first: number, slow: Channel[]) => {
      for (const channel of channels) {
        channel.sent = [];
        channel.bufferedAmount = 0;
      }
      for (let i = 0; i < 16; i++)
        transport.send(new Uint8Array(FRAME_BYTES).buffer);
      const ids = (paths: Channel[]) =>
        paths
          .flatMap((channel) =>
            channel.sent
              .filter(
                (wire): wire is ArrayBuffer => wire instanceof ArrayBuffer,
              )
              .map((wire) => new DataView(wire).getUint32(4)),
          )
          .filter((id) => id >= first);
      clock += 20;
      receipt(ids(channels.filter((channel) => !slow.includes(channel))));
      clock += 1000;
      receipt(ids(slow));
    };
    batch(800, [delayed]);
    expect(transport.snapshot().queuedDelayMs).toBeGreaterThan(750);
    expect(transport.sendBufferBytes).toBe(
      LEGACY_TRANSFER_WINDOW_BYTES - 64 * 1024,
    );
    expect(transport.pacingDelayMs).toBe(0);
    batch(816, [delayed, channels[3]]);
    expect(transport.sendBufferBytes).toBe(128 * 1024);
    expect(transport.pacingDelayMs).toBe(4);
    expect(transport.snapshot().unreceivedBytes).toBe(0);
    vi.restoreAllMocks();
  });
  it.each([2, 20, 800])(
    'keeps healthy siblings running after a path stalls at %i ms baseline latency',
    async (latency) => {
      vi.spyOn(performance, 'now').mockImplementation(() => Date.now());
      const primary = new Channel();
      const transport = new StripedChannel(primary.native(), 'send');
      opened.push(transport);
      primary.receive(
        JSON.stringify({
          type: 'hello',
          version: 1,
          stripedTransport: 1,
          stripedReceipts: 1,
          stripedLanes: 4,
          stripedFrameBytes: STRIPED_FRAME_BYTES,
        }),
      );
      await vi.advanceTimersByTimeAsync(0);
      for (const peer of Peer.peers) {
        peer.channel.readyState = 'open';
        peer.channel.dispatchEvent(new Event('open'));
      }
      const all = [primary, ...Peer.peers.map((peer) => peer.channel)];
      for (let sequence = 0; sequence < 640; sequence += 16) {
        for (const channel of all) channel.bufferedAmount = 0;
        for (let i = 0; i < 16; i++)
          transport.send(new Uint8Array(FRAME_BYTES).buffer);
        await vi.advanceTimersByTimeAsync(latency);
        primary.receive(
          JSON.stringify({
            type: 'pg-striped-receipt',
            received: Array.from({ length: 16 }, (_, i) => sequence + i),
          }),
        );
      }
      expect(transport.sendBufferBytes).toBe(
        LEGACY_TRANSFER_WINDOW_BYTES - 64 * 1024,
      );
      expect(transport.pacingDelayMs).toBe(0);
      expect(transport.sendFrameBytes).toBe(
        latency <= 40 ? STRIPED_FRAME_BYTES : FRAME_BYTES,
      );
      for (const channel of all) channel.bufferedAmount = 0;
      for (let i = 0; i < 4; i++)
        transport.send(new Uint8Array(FRAME_BYTES).buffer);
      await vi.advanceTimersByTimeAsync(latency);
      primary.receive(
        JSON.stringify({
          type: 'pg-striped-receipt',
          received: [640, 642, 643],
        }),
      );
      await vi.advanceTimersByTimeAsync(
        Math.max(latency < 8 ? 400 : 300, latency * 3),
      );
      const quickRecovery = latency >= 8 && latency <= 40;
      expect(transport.snapshot().deprioritizedConnections).toBe(
        quickRecovery ? 0 : 1,
      );
      // A deliberately unacknowledged repair gets another bounded attempt.
      expect(transport.snapshot().replayedPackets).toBe(quickRecovery ? 2 : 1);
      expect(transport.sendBufferBytes).toBe(
        LEGACY_TRANSFER_WINDOW_BYTES - 64 * 1024,
      );
      expect(transport.pacingDelayMs).toBe(0);
      expect(transport.sendFrameBytes).toBe(
        latency <= 40 ? STRIPED_FRAME_BYTES : FRAME_BYTES,
      );
      primary.receive(
        JSON.stringify({ type: 'pg-striped-receipt', received: [641] }),
      );
      expect(transport.snapshot().unreceivedBytes).toBe(0);
      vi.restoreAllMocks();
    },
  );
  it('fills a larger warmed window within receiver credit and reduces it when lanes close', async () => {
    let clock = 100;
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
    const primary = new Channel();
    const transport = new StripedChannel(primary.native(), 'send');
    opened.push(transport);
    primary.receive(
      JSON.stringify({
        type: 'hello',
        version: 1,
        stripedTransport: 1,
        stripedReceipts: 1,
        stripedLanes: 4,
        stripedFrameBytes: STRIPED_FRAME_BYTES,
      }),
    );
    await vi.advanceTimersByTimeAsync(0);
    for (const peer of Peer.peers) {
      peer.channel.readyState = 'open';
      peer.channel.dispatchEvent(new Event('open'));
    }
    const all = [primary, ...Peer.peers.map((peer) => peer.channel)];
    for (let sequence = 0; sequence < 2560; sequence += 16) {
      for (const channel of all) channel.bufferedAmount = 0;
      for (let i = 0; i < 16; i++)
        transport.send(new Uint8Array(FRAME_BYTES).buffer);
      clock += 500;
      primary.receive(
        JSON.stringify({
          type: 'pg-striped-receipt',
          received: Array.from({ length: 16 }, (_, i) => sequence + i),
        }),
      );
    }
    expect(transport.sendBufferBytes).toBe(
      LEGACY_TRANSFER_WINDOW_BYTES - 64 * 1024,
    );
    expect(transport.burstBytes).toBe(512 * 1024);
    expect(transport.pacingDelayMs).toBe(0);
    // Even the largest allowed frame leaves space for transport control.
    expect(
      transport.sendBufferBytes + STRIPED_FRAME_BYTES + 8,
    ).toBeLessThanOrEqual(TRANSFER_WINDOW_BYTES);
    Peer.peers[0].channel.close();
    Peer.peers[1].channel.close();
    expect(transport.sendBufferBytes).toBe(3 * CHECKPOINT_BYTES);
    expect(transport.snapshot().unreceivedBytes).toBe(0);
    for (const channel of all) channel.bufferedAmount = 0;
    for (let i = 0; i < 16; i++)
      transport.send(new Uint8Array(FRAME_BYTES).buffer);
    clock += 620;
    primary.receive(
      JSON.stringify({
        type: 'pg-striped-receipt',
        received: Array.from({ length: 16 }, (_, i) => 2560 + i),
      }),
    );
    // Small-frame delivery must not keep the largest warmed window/burst.
    expect(transport.snapshot().queuedDelayMs).toBeGreaterThan(100);
    expect(transport.snapshot().queuedDelayMs).toBeLessThan(150);
    expect(transport.sendFrameBytes).toBe(FRAME_BYTES);
    expect(transport.sendBufferBytes).toBe(2 * CHECKPOINT_BYTES);
    expect(transport.burstBytes).toBe(256 * 1024);
    vi.restoreAllMocks();
  });
  it('bounds each quick repair pass and waits when aggregate native queues exceed credit', async () => {
    vi.spyOn(performance, 'now').mockImplementation(() => Date.now());
    const primary = new Channel();
    const transport = new StripedChannel(primary.native(), 'send');
    opened.push(transport);
    primary.receive(
      JSON.stringify({
        type: 'hello',
        version: 1,
        stripedTransport: 1,
        stripedReceipts: 1,
        stripedLanes: 4,
      }),
    );
    await vi.advanceTimersByTimeAsync(0);
    for (const peer of Peer.peers) {
      peer.channel.readyState = 'open';
      peer.channel.dispatchEvent(new Event('open'));
    }
    const all = [primary, ...Peer.peers.map((peer) => peer.channel)];
    for (let sequence = 0; sequence < 12; sequence++)
      transport.send(new Uint8Array(FRAME_BYTES));
    for (const channel of all) channel.bufferedAmount = 0;
    await vi.advanceTimersByTimeAsync(20);
    // One later receipt proves a gap and establishes a nearby path baseline.
    primary.receive(
      JSON.stringify({ type: 'pg-striped-receipt', received: [11] }),
    );
    await vi.advanceTimersByTimeAsync(100);
    expect(transport.snapshot().replayedPackets).toBe(8);
    expect(all.reduce((sum, channel) => sum + channel.bufferedAmount, 0)).toBe(
      8 * (FRAME_BYTES + 8),
    );
    primary.bufferedAmount = transport.sendBufferBytes + 1;
    await vi.advanceTimersByTimeAsync(100);
    expect(transport.snapshot().replayedPackets).toBe(8);
    for (const channel of all) channel.bufferedAmount = 0;
    primary.receive(
      JSON.stringify({
        type: 'pg-striped-receipt',
        received: Array.from({ length: 11 }, (_, i) => i),
      }),
    );
    expect(transport.snapshot().unreceivedBytes).toBe(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(transport.snapshot().replayedPackets).toBe(8);
    vi.restoreAllMocks();
  });
  it.each([
    [200, 220],
    [2000, 500],
  ])(
    'allows a path with a %i ms late receipt bounded grace before replay at %i ms',
    async (lateReceipt, grace) => {
      let clock = 0;
      vi.spyOn(performance, 'now').mockImplementation(() => clock);
      const primary = new Channel();
      const transport = new StripedChannel(primary.native(), 'send');
      opened.push(transport);
      primary.receive(
        JSON.stringify({
          type: 'hello',
          version: 1,
          stripedTransport: 1,
          stripedReceipts: 1,
          stripedLanes: 4,
        }),
      );
      await vi.advanceTimersByTimeAsync(0);
      for (const peer of Peer.peers) {
        peer.channel.readyState = 'open';
        peer.channel.dispatchEvent(new Event('open'));
      }
      const all = [primary, ...Peer.peers.map((peer) => peer.channel)];
      const send = () => {
        for (let i = 0; i < 5; i++) transport.send(new Uint8Array(FRAME_BYTES));
        for (const channel of all) channel.bufferedAmount = 0;
      };
      const receipt = (received: number[]) =>
        primary.receive(
          JSON.stringify({ type: 'pg-striped-receipt', received }),
        );
      send();
      clock = 20;
      receipt([0, 1, 2, 3, 4]);
      send();
      clock = 40;
      receipt([6, 7, 8, 9]);
      clock = 20 + lateReceipt;
      receipt([5]);
      send();
      clock += 20;
      receipt([11, 12, 13, 14]);
      const sentAt = 20 + lateReceipt;
      clock = sentAt + 100;
      await vi.advanceTimersByTimeAsync(20);
      // Faster peers proved a gap, but the original path has not exceeded its
      // own learned delay yet. No extra copy or retained credit is created.
      expect(transport.snapshot().replayedPackets).toBe(0);
      expect(transport.snapshot().unreceivedBytes).toBe(FRAME_BYTES + 8);
      clock = sentAt + grace;
      await vi.advanceTimersByTimeAsync(20);
      expect(transport.snapshot().replayedPackets).toBe(1);
      expect(
        all
          .slice(1)
          .some((channel) =>
            channel.sent.some(
              (data) =>
                data instanceof ArrayBuffer &&
                new DataView(data).getUint32(4) === 10,
            ),
          ),
      ).toBe(true);
      receipt([10]);
      expect(transport.snapshot().unreceivedBytes).toBe(0);
      clock += 5000;
      await vi.advanceTimersByTimeAsync(20);
      expect(transport.snapshot().replayedPackets).toBe(1);
      vi.restoreAllMocks();
    },
  );
  it('selectively receipts displaced packets without delivering them before the missing prefix', async () => {
    const primary = new Channel(),
      transport = new StripedChannel(primary.native(), 'receive');
    opened.push(transport);
    const received = vi.fn();
    transport.onmessage = received;
    primary.receive(
      JSON.stringify({
        type: 'hello',
        version: 1,
        stripedTransport: 1,
        stripedReceipts: 1,
        stripedLanes: 4,
      }),
    );
    primary.receive(JSON.stringify({ type: 'pg-striped-start' }));
    received.mockClear();
    for (const sequence of [1, 2, 3, 4]) primary.receive(frame(sequence));
    expect(received).not.toHaveBeenCalled();
    expect(
      primary.sent.map((data) =>
        typeof data === 'string' ? JSON.parse(data) : null,
      ),
    ).toContainEqual({ type: 'pg-striped-receipt', received: [1, 2, 3, 4] });
    primary.receive(frame(0));
    expect(received).toHaveBeenCalledTimes(5);
    primary.receive(frame(1));
    expect(received).toHaveBeenCalledTimes(5);
    await vi.advanceTimersByTimeAsync(25);
    expect(transport.readyState).toBe('open');
  });
  it('recovers a missing packet through another lane with bounded retries, then releases the retained bytes', async () => {
    vi.spyOn(performance, 'now').mockImplementation(() => Date.now());
    const primary = new Channel(),
      transport = new StripedChannel(primary.native(), 'send');
    opened.push(transport);
    primary.receive(
      JSON.stringify({
        type: 'hello',
        version: 1,
        stripedTransport: 1,
        stripedReceipts: 1,
        stripedLanes: 4,
      }),
    );
    await vi.advanceTimersByTimeAsync(0);
    for (const peer of Peer.peers) {
      peer.channel.readyState = 'open';
      peer.channel.dispatchEvent(new Event('open'));
    }
    const all = [primary, ...Peer.peers.map((peer) => peer.channel)];
    for (let i = 0; i < 4; i++) {
      for (const channel of all) channel.bufferedAmount = 0;
      transport.send(new Uint8Array([i]).buffer);
    }
    const original = all.find((channel) =>
      channel.sent.some(
        (data) =>
          data instanceof ArrayBuffer && new DataView(data).getUint32(4) === 1,
      ),
    )!;
    primary.receive(
      JSON.stringify({ type: 'pg-striped-receipt', received: [0, 2, 3] }),
    );
    await vi.advanceTimersByTimeAsync(240);
    expect(transport.snapshot().replayedPackets).toBe(0);
    await vi.advanceTimersByTimeAsync(160);
    expect(transport.snapshot().replayedPackets).toBe(1);
    expect(
      all.some(
        (channel) =>
          channel !== original &&
          channel.sent.some(
            (data) =>
              data instanceof ArrayBuffer &&
              new DataView(data).getUint32(4) === 1,
          ),
      ),
    ).toBe(true);
    primary.receive(
      JSON.stringify({ type: 'pg-striped-receipt', received: [1] }),
    );
    expect(transport.snapshot().unreceivedBytes).toBe(0);
    await vi.advanceTimersByTimeAsync(5000);
    expect(transport.snapshot().replayedPackets).toBe(1);
    primary.close();
    expect(vi.getTimerCount()).toBe(0);
    vi.restoreAllMocks();
  });
  it.each([[10], Array(17).fill(0), [NaN], [-1]])(
    'rejects forged or unbounded selective receipts: %s',
    (received) => {
      const primary = new Channel(),
        transport = new StripedChannel(primary.native(), 'send');
      opened.push(transport);
      primary.receive(
        JSON.stringify({
          type: 'hello',
          version: 1,
          stripedTransport: 1,
          stripedReceipts: 1,
        }),
      );
      primary.receive(JSON.stringify({ type: 'pg-striped-receipt', received }));
      expect(primary.readyState).toBe('closed');
    },
  );
});

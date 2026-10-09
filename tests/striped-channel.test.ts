import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StripedChannel } from '../lib/bridge/striped-channel';
import { FRAME_BYTES, TRANSFER_WINDOW_BYTES } from '../lib/bridge/model';

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
  constructor() {
    super();
    Peer.peers.push(this);
    this.channel.readyState = 'connecting';
  }
  createDataChannel() {
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
});

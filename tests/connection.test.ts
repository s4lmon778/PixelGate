import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Connection } from '../lib/bridge/connection';
import { decodePair, encodePair, PAIR_TTL } from '../lib/bridge/pairing';
const sdp =
  'v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=fingerprint:sha-256 AA:BB\r\na=candidate:1 1 UDP 1 127.0.0.1 1234 typ host\r\n';
class Peer extends EventTarget {
  localDescription?: RTCSessionDescriptionInit;
  remoteDescription?: RTCSessionDescriptionInit;
  iceGatheringState = 'complete';
  closed = false;
  getStats = vi.fn().mockResolvedValue(new Map());
  channel = {
    label: 'pixelbridge-v1',
    ordered: true,
    maxRetransmits: null,
    maxPacketLifeTime: null,
    close: vi.fn(),
    onopen: undefined as (() => void) | undefined,
  };
  createDataChannel() {
    return this.channel;
  }
  createOffer = async () => ({ type: 'offer', sdp });
  createAnswer = async () => ({ type: 'answer', sdp });
  setLocalDescription = async (d: RTCSessionDescriptionInit) => {
    this.localDescription = d;
  };
  setRemoteDescription = async (d: RTCSessionDescriptionInit) => {
    this.remoteDescription = d;
  };
  close() {
    this.closed = true;
  }
}
const events = () => ({
  room: vi.fn(),
  status: vi.fn(),
  connected: vi.fn(),
  error: vi.fn(),
});
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('RTCPeerConnection', Peer);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
function response(c: Connection, id = c.room!.id) {
  return encodePair({
    version: 1,
    id,
    expires: c.room!.expires,
    description: { type: 'answer', sdp },
  });
}
describe('explicit approval and revocation', () => {
  it('creates a receiver offer and does not accept a peer until approval', async () => {
    const e = events(),
      c = new Connection('receive', e);
    await c.start();
    expect(decodePair(c.room!.offer!, 'offer').id).toBe(c.room!.id);
    expect((c.pc as unknown as Peer).remoteDescription).toBeUndefined();
    expect(e.connected).not.toHaveBeenCalled();
    await c.stop();
  });
  it('rejects responses from another receiver session', async () => {
    const c = new Connection('receive', events());
    await c.start();
    await expect(c.approve(response(c, crypto.randomUUID()))).rejects.toThrow(
      'another receiver',
    );
    expect((c.pc as unknown as Peer).remoteDescription).toBeUndefined();
    await c.stop();
  });
  it('accepts one sender only', async () => {
    const c = new Connection('receive', events());
    await c.start();
    await c.approve(response(c));
    await expect(c.approve(response(c))).rejects.toThrow('already approved');
    await c.stop();
  });
  it('expires a pending receiver and closes its peer', async () => {
    const e = events(),
      c = new Connection('receive', e);
    await c.start();
    await vi.advanceTimersByTimeAsync(PAIR_TTL + 1);
    expect((c.pc as unknown as Peer).closed).toBe(true);
    expect(e.error.mock.calls[0][0].message).toContain('expired');
  });
  it('revokes immediately and refuses later approval', async () => {
    const c = new Connection('receive', events());
    await c.start();
    const answer = response(c);
    await c.stop();
    expect((c.pc as unknown as Peer).closed).toBe(true);
    await expect(c.approve(answer)).rejects.toThrow('Create a receiver');
  });
  it('prepares a matching answer without a network signaling service', async () => {
    const receiver = new Connection('receive', events());
    await receiver.start();
    const sender = new Connection('send', events());
    await sender.start(receiver.room!.offer);
    const answer = decodePair(sender.room!.response!, 'answer');
    expect(answer.id).toBe(receiver.room!.id);
    await receiver.approve(sender.room!.response!);
    await receiver.stop();
    await sender.stop();
  });
});

import { describe, expect, it } from 'vitest';
import { strToU8, zlibSync } from 'fflate';
import {
  decodePair,
  encodePair,
  PAIR_TTL,
  type PairSignal,
} from '../lib/bridge/pairing';
const now = Date.now();
const signal: PairSignal = {
  version: 1,
  id: crypto.randomUUID(),
  expires: now + PAIR_TTL,
  description: {
    type: 'offer',
    sdp: 'v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=fingerprint:sha-256 AA:BB\r\n',
  },
};
describe('serverless pairing envelopes', () => {
  it('round-trips complete descriptions without media metadata', () => {
    const token = encodePair(signal);
    expect(decodePair(token, 'offer', now)).toEqual(signal);
    expect(token.length).toBeLessThan(500);
  });
  it('accepts fragment links on project subpaths', () => {
    const token = encodePair(signal);
    expect(
      decodePair(
        `https://example.org/PixelGate/#connect=${token}`,
        'offer',
        now,
      ),
    ).toEqual(signal);
  });
  it('rejects expired links', () => {
    expect(() =>
      decodePair(encodePair({ ...signal, expires: now - 1 }), 'offer', now),
    ).toThrow('expired');
  });
  it('rejects response/offer confusion', () => {
    expect(() => decodePair(encodePair(signal), 'answer', now)).toThrow();
  });
  it('rejects extra metadata', () => {
    expect(() =>
      decodePair(
        encodePair({ ...signal, filename: 'private.JPG' } as PairSignal),
        'offer',
        now,
      ),
    ).toThrow('Unexpected');
  });
  it('rejects camera/microphone SDP', () => {
    expect(() =>
      decodePair(
        encodePair({
          ...signal,
          description: {
            type: 'offer',
            sdp: signal.description.sdp + 'm=audio 9 RTP/AVP 0\r\n',
          },
        }),
        'offer',
        now,
      ),
    ).toThrow();
  });
  it('bounds both encoded and decompressed input', () => {
    expect(() => decodePair('pg1.' + 'a'.repeat(17000), 'offer', now)).toThrow(
      'large',
    );
    const bytes = zlibSync(strToU8(' '.repeat(2 * 1024 * 1024)));
    const token = 'pg1.' + Buffer.from(bytes).toString('base64url');
    expect(() => decodePair(token, 'offer', now)).toThrow('large');
  });
  it('rejects malformed and distant future expiry', () => {
    expect(() => decodePair('pg1.broken', 'offer', now)).toThrow('Invalid');
    expect(() =>
      decodePair(
        encodePair({ ...signal, expires: now + 24 * 60 * 60 * 1000 }),
        'offer',
        now,
      ),
    ).toThrow('expiry');
  });
});

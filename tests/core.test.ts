import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { createSHA256 } from 'hash-wasm';
import { collisionName, safePath, validateRecord } from '../lib/bridge/model';
import { report } from '../lib/bridge/report';
import { ApiError, onlyKeys, validateSignal } from '../lib/pairing-validation';

describe('integrity and manifests', () => {
  it('matches an independent SHA-256 across chunk boundaries', async () => {
    const bytes = Buffer.alloc(2 * 1024 * 1024 + 123);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
    const hash = await createSHA256();
    hash.init();
    for (let i = 0; i < bytes.length; i += 16384)
      hash.update(bytes.subarray(i, i + 16384));
    expect(hash.digest('hex')).toBe(
      createHash('sha256').update(bytes).digest('hex'),
    );
  });
  it('detects corruption', async () => {
    const hash = await createSHA256();
    hash.init();
    hash.update(new Uint8Array([1, 2, 3]));
    const original = hash.digest();
    hash.init();
    hash.update(new Uint8Array([1, 2, 4]));
    expect(hash.digest()).not.toBe(original);
  });
  it.each([
    '../IMG.JPG',
    'a/../IMG.JPG',
    '/IMG.JPG',
    'a\\IMG.JPG',
    'C:/IMG.JPG',
    'a//b',
    './a',
    'a\u0000.jpg',
    'a/',
  ])('rejects unsafe paths: %s', (path) =>
    expect(() => safePath(path)).toThrow(),
  );
  it('preserves nested Unicode names', () =>
    expect(safePath('旅行/été/照片.HEIC')).toBe('旅行/été/照片.HEIC'));
  it('handles 10,000 paths and file sizes over 4 GB without 32-bit truncation', () => {
    const paths = Array.from({ length: 10000 }, (_, i) =>
      safePath(`2024/${i}.MOV`),
    );
    expect(new Set(paths).size).toBe(10000);
    const record = validateRecord({
      id: 'a'.repeat(64),
      sha256: 'b'.repeat(64),
      relativePath: '4K.MOV',
      size: 5 * 1024 ** 3,
      sessionId: 'test',
      mimeType: 'video/quicktime',
      modified: 0,
    });
    expect(record.size).toBe(5368709120);
  });
  it('does not trust incoming verified state', () => {
    expect(
      validateRecord({
        id: 'a'.repeat(64),
        sha256: 'b'.repeat(64),
        relativePath: 'IMG.JPG',
        size: 1,
        sessionId: 'test',
        mimeType: 'image/jpeg',
        modified: 0,
        scope: 'destination',
        phase: 'verified',
      }).scope,
    ).toBe('none');
  });
  it('preserves conflicting filenames', () => {
    expect(collisionName('IMG.HEIC', 2)).toBe('IMG (2).HEIC');
    expect(collisionName('file', 3)).toBe('file (3)');
  });
  it('exports verification scope and neutralizes spreadsheet formulas', () => {
    const records = [
      {
        ...validateRecord({
          id: 'a'.repeat(64),
          sha256: 'b'.repeat(64),
          relativePath: '=SUM(1).jpg',
          size: 1,
          sessionId: 'test',
          mimeType: 'image/jpeg',
          modified: 0,
        }),
        phase: 'verified' as const,
        scope: 'browser' as const,
        downloaded: true,
      },
    ];
    expect(report(records, 'csv')).toContain('"\'=SUM(1).jpg"');
    expect(report(records, 'json')).toContain('verification pending');
    expect(report(records, 'txt')).toContain('browser');
  });
});
describe('signaling privacy boundary', () => {
  const signal = {
    type: 'offer',
    sdp: 'v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n',
  };
  it('accepts only data-channel descriptions', () =>
    expect(validateSignal(signal, 'offer')).toBe(JSON.stringify(signal)));
  it.each([
    { ...signal, filename: 'IMG.JPG' },
    { ...signal, sdp: signal.sdp + 'm=video 9 RTP/AVP 96' },
    { ...signal, sdp: 'v=0' + 'x'.repeat(30000) },
    { type: 'answer', sdp: signal.sdp },
  ])(
    'rejects extra metadata, media tracks, oversized or wrong signals',
    (value) => expect(() => validateSignal(value, 'offer')).toThrow(ApiError),
  );
  it('rejects upload metadata in pairing requests', () =>
    expect(() =>
      onlyKeys({ code: '12345678', sha256: 'secret' }, ['code']),
    ).toThrow());
});

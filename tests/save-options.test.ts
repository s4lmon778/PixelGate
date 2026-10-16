import { describe, expect, it } from 'vitest';
import {
  androidChromeLink,
  downloadType,
  nativeShareBatch,
  ANDROID_SHARE_FILE_BYTES,
} from '../lib/bridge/save-options';

describe('local save options', () => {
  it('opens only the HTTPS app page in Chrome without pairing or query data', () => {
    const link = androidChromeLink(
      'https://example.com/PixelGate/?secret=private#code=123456',
      'Android',
      '0.3.9',
    );
    expect(link).toBe(
      'intent://example.com/PixelGate/?v=0.3.9#Intent;scheme=https;package=com.android.chrome;S.browser_fallback_url=https%3A%2F%2Fexample.com%2FPixelGate%2F%3Fv%3D0.3.9;end',
    );
    expect(link).not.toContain('123456');
    expect(link).not.toContain('secret');
  });
  it.each([
    'http://localhost/',
    'blob:https://example.com/id',
    'javascript:alert(1)',
    'invalid',
  ])('does not create an Android intent for %s', (url) => {
    expect(androidChromeLink(url, 'Android', '0.3.9')).toBeUndefined();
  });
  it('does not offer Android app links on other devices', () => {
    expect(
      androidChromeLink('https://example.com/', 'iPhone', '0.3.9'),
    ).toBeUndefined();
  });
  it('retains valid picker MIME types and infers common media types when missing', () => {
    expect(downloadType('旅行.JPG', '')).toBe('image/jpeg');
    expect(downloadType('旅行.MOV', 'application/octet-stream')).toBe(
      'video/quicktime',
    );
    expect(downloadType('x.jpg', 'IMAGE/HEIC')).toBe('image/heic');
    expect(downloadType('x.png', 'bad\r\ncontent')).toBe('image/png');
    expect(downloadType('x.unknown', '')).toBe('application/octet-stream');
  });
  it('limits each native handoff to ten while keeping the full collection available', () => {
    const files = Array.from(
      { length: 125 },
      (_, i) =>
        new File(['original'], `photo-${i}.jpg`, { type: 'image/jpeg' }),
    );
    const batch = nativeShareBatch(files, 'Android Chrome', () => true);
    expect(batch).toEqual(files.slice(0, 10));
    expect(files).toHaveLength(125);
  });
  it('routes a 400 MiB Android original to downloads even when canShare says true', () => {
    const large = new File(['original'], 'video.mp4', { type: 'video/mp4' });
    Object.defineProperty(large, 'size', { value: 400 * 1024 * 1024 });
    const boundary = new File(['original'], 'boundary.mp4', {
      type: 'video/mp4',
    });
    Object.defineProperty(boundary, 'size', {
      value: ANDROID_SHARE_FILE_BYTES,
    });
    expect(
      nativeShareBatch([large, boundary], 'Android Chrome', () => true),
    ).toEqual([boundary]);
    expect(nativeShareBatch([large], 'iPhone Safari', () => true)).toEqual([
      large,
    ]);
  });
  it('splits combined payload limits and leaves unsupported media untouched for downloads', () => {
    const files = ['a.jpg', 'b.jpg', 'c.mov', 'd.jpg', 'e.jpg'].map(
      (name) => new File(['original'], name),
    );
    const batch = nativeShareBatch(
      files,
      'Android',
      ({ files }) =>
        files!.length <= 2 &&
        files!.every((file) => !file.name.endsWith('.mov')),
    );
    expect(batch).toEqual(files.slice(0, 2));
    expect(files[2].name).toBe('c.mov');
    expect(
      nativeShareBatch(files, 'Android', () => {
        throw new Error('unsupported');
      }),
    ).toEqual([]);
  });
});

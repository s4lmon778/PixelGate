import { describe, expect, it } from 'vitest';
import { androidChromeLink, downloadType } from '../lib/bridge/save-options';

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
});

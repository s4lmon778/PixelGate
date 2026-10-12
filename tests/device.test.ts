import { expect, it } from 'vitest';
import { deviceKind, peerDevice } from '../lib/bridge/device';

it('recognizes phones, tablets with desktop browsing, and computers', () => {
  expect(
    deviceKind('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)', 5),
  ).toBe('phone');
  expect(
    deviceKind(
      'Mozilla/5.0 (Linux; Android 9; Pixel XL) Chrome/101 Mobile Safari/537.36',
      5,
    ),
  ).toBe('phone');
  expect(
    deviceKind('Mozilla/5.0 (Linux; Android 13) Chrome/101 Safari/537.36', 5),
  ).toBe('tablet');
  expect(deviceKind('Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X)', 5)).toBe(
    'tablet',
  );
  expect(
    deviceKind(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) Safari/605.1.15',
      5,
    ),
  ).toBe('tablet');
  expect(
    deviceKind(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) Safari/605.1.15',
      0,
    ),
  ).toBe('computer');
  expect(deviceKind('Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 10)).toBe(
    'computer',
  );
});

it('accepts only known peer categories and leaves old or invalid peers unspecified', () => {
  for (const kind of ['phone', 'tablet', 'computer'])
    expect(peerDevice(kind)).toBe(kind);
  for (const value of [undefined, null, {}, '<script>', 'Phone', 1])
    expect(peerDevice(value)).toBeUndefined();
});

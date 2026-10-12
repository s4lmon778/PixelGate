import { expect, it } from 'vitest';
import { TransferClock } from '../lib/bridge/transfer-clock';

it('excludes pairing and preparation, and counts only bytes beyond the resumed prefix', () => {
  const clock = new TransferClock();
  expect(clock.rate(0, 30000)).toBe(0);
  clock.start(1024, 60000);
  clock.start(0, 65000);
  expect(clock.elapsed(62000)).toBe(2);
  expect(clock.rate(5120, 62000)).toBe(2048);
});

it('excludes pauses, freezes completion, and resets for the next batch', () => {
  const clock = new TransferClock();
  clock.start(0, 0);
  clock.pause(2000);
  clock.pause(3000);
  expect(clock.elapsed(12000)).toBe(2);
  expect(clock.rate(4000, 12000)).toBe(0);
  clock.resume(12000);
  clock.finish(14000);
  expect(clock.elapsed(100000)).toBe(4);
  expect(clock.rate(8000, 100000)).toBe(2000);
  clock.start(8000, 100000);
  expect(clock.rate(10000, 101000)).toBe(2000);
  clock.reset();
  expect(clock.elapsed(200000)).toBe(0);
});

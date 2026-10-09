import { describe, expect, it } from 'vitest';
import { PathScheduler } from '../lib/bridge/path-scheduler';
import { FRAME_BYTES } from '../lib/bridge/model';

function learn(
  scheduler: PathScheduler<string>,
  path: string,
  duration: number,
) {
  for (let i = 0; i < 3; i++) {
    const now = i * duration;
    scheduler.sent(path, now, i ? FRAME_BYTES : 0);
    scheduler.received(path, 4 * FRAME_BYTES, now, now + duration);
  }
}

describe('delivery-aware scheduling', () => {
  it('balances equal paths and retains the original fallback with insufficient observations', () => {
    const scheduler = new PathScheduler<string>();
    const paths = ['a', 'b'];
    expect(scheduler.choose(paths, () => 0, 0)).toBe('a');
    expect(scheduler.choose(paths, () => 0, 0)).toBe('b');
    for (const path of paths) learn(scheduler, path, 100);
    const selected = Array.from({ length: 20 }, () =>
      scheduler.choose(paths, () => 0, 400),
    );
    expect(selected.filter((path) => path === 'a')).toHaveLength(10);
    expect(scheduler.snapshot(paths).scheduling).toBe('balanced');
    expect(
      scheduler.choose(paths, (path) => (path === 'a' ? 10000 : 1), 400),
    ).toBe('b');
  });
  it('prefers the faster delivery path while still filling its available capacity', () => {
    const scheduler = new PathScheduler<string>();
    learn(scheduler, 'fast', 100);
    learn(scheduler, 'slow', 400);
    expect(scheduler.choose(['fast', 'slow'], () => 0, 1300)).toBe('fast');
    expect(
      scheduler.choose(
        ['fast', 'slow'],
        (path) => (path === 'fast' ? 32 * FRAME_BYTES : 0),
        1300,
      ),
    ).toBe('slow');
    expect(scheduler.snapshot(['fast', 'slow']).scheduling).toBe('adaptive');
  });
  it('probes an idle slow path within a bounded budget and learns recovery', () => {
    const scheduler = new PathScheduler<string>();
    learn(scheduler, 'fast', 100);
    learn(scheduler, 'slow', 400);
    let probes = 0;
    for (let i = 0; i < 20; i++) {
      const path = scheduler.choose(['fast', 'slow'], () => 0, 1500);
      scheduler.sent(path, 1500, 0);
      if (path === 'slow') probes++;
    }
    expect(probes).toBe(1);
    for (let now = 1600; now < 3600; now += 100) {
      scheduler.sent('slow', now, FRAME_BYTES);
      scheduler.received('slow', 4 * FRAME_BYTES, now, now + 100);
    }
    expect(
      scheduler.choose(
        ['fast', 'slow'],
        (path) => (path === 'fast' ? 2 * FRAME_BYTES : 0),
        3600,
      ),
    ).toBe('slow');
  });
  it('does not count long source-idle gaps as path throughput deterioration', () => {
    const scheduler = new PathScheduler<string>();
    learn(scheduler, 'path', 100);
    const before = scheduler.snapshot(['path']).paths[0].deliveryBytesPerSecond;
    scheduler.sent('path', 60000, 0);
    scheduler.received('path', 4 * FRAME_BYTES, 60000, 60100);
    expect(scheduler.snapshot(['path']).paths[0].deliveryBytesPerSecond).toBe(
      before,
    );
    scheduler.clear();
    expect(scheduler.snapshot(['path']).paths[0].receivedBytes).toBe(0);
  });
});

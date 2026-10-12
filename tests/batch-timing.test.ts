import { describe, expect, it } from 'vitest';
import { BatchTiming } from '../lib/bridge/batch-timing';

describe('actual send-to-verified batch timing', () => {
  it('includes preparation and pauses, freezes at completion and resets on another batch', () => {
    let clock = 100;
    const timing = new BatchTiming(() => clock);
    expect(timing.snapshot()).toBeUndefined();
    timing.begin(1, 200);
    clock += 500; // Preparation contributes to wall time.
    timing.sent(200);
    clock += 1000; // A deliberate pause also contributes.
    expect(timing.snapshot()?.wallElapsedMs).toBe(1500);
    timing.finish(1, 0);
    clock += 10000;
    timing.finish(1, 0);
    timing.sent(100);
    expect(timing.snapshot()).toMatchObject({
      phase: 'verified',
      wallElapsedMs: 1500,
      payloadBytesSent: 200,
    });
    timing.begin(1, 50);
    expect(timing.snapshot()).toMatchObject({
      phase: 'running',
      wallElapsedMs: 0,
      payloadBytesSent: 0,
    });
  });
  it('separates resumed prefixes and already-existing copies from new payload', () => {
    const timing = new BatchTiming(() => 100);
    timing.begin(2, 100);
    timing.resumed(40);
    timing.sent(40);
    timing.skipped(20);
    timing.finish(1, 1);
    expect(timing.snapshot()).toMatchObject({
      phase: 'verified',
      payloadBytesSent: 40,
      resumedBytes: 40,
      skippedBytes: 20,
      verifiedFiles: 1,
      skippedFiles: 1,
    });
  });
  it('never labels a failed or partial attempt as a complete measured transfer', () => {
    const timing = new BatchTiming(() => 100);
    timing.begin(1, 100);
    timing.sent(40);
    timing.finish(0, 0);
    expect(timing.snapshot()?.phase).toBe('incomplete');
    timing.finish(1, 0);
    expect(timing.snapshot()?.phase).toBe('incomplete');
  });
});

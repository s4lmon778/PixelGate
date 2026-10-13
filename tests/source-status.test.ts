import { describe, expect, it } from 'vitest';
import { sourceStatus } from '../lib/bridge/source-status';

const sample = {
  stage: 'network-backpressure',
  stageElapsedMs: 21000,
  paused: false,
  visibility: 'visible',
  connections: 5,
  unreceivedBytes: 262144,
  oldestUnreceivedMs: 21000,
  receiptDelayMs: 20,
  queuedDelayMs: 100,
  replayedPackets: 3,
  sendBufferBytes: 262144,
  sendFrameBytes: 16384,
  deprioritizedConnections: 1,
};

describe('paired sender status', () => {
  it('retains only states and counts, never arbitrary source metadata', () => {
    expect(
      sourceStatus({
        ...sample,
        filename: 'private.mp4',
        address: 'private-address',
        token: 'pairing-token',
        bytes: [1, 2, 3],
      }),
    ).toEqual(sample);
  });
  it('retains bounded read timing counters without forwarding nested source metadata', () => {
    const reads = {
      calls: 100,
      bytes: 400 * 1024 * 1024,
      lastMs: 50,
      averageMs: 50,
      maximumMs: 60,
      waitedMs: 200,
      maximumWaitMs: 50,
    };
    expect(
      sourceStatus({
        ...sample,
        sourceReads: {
          ...reads,
          filename: 'private.mov',
          address: 'private-address',
        },
      }),
    ).toEqual({ ...sample, sourceReads: reads });
    expect(
      sourceStatus({ ...sample, sourceReads: { ...reads, maximumWaitMs: -1 } }),
    ).toBeUndefined();
  });
  it('validates completion counts and preserves timing without forwarding file identities', () => {
    const batch = {
      phase: 'verified',
      wallElapsedMs: 2000,
      requestedFiles: 1,
      requestedBytes: 100,
      payloadBytesSent: 100,
      resumedBytes: 0,
      skippedBytes: 0,
      verifiedFiles: 1,
      skippedFiles: 0,
    };
    expect(
      sourceStatus({ ...sample, batch: { ...batch, filename: 'private.mp4' } }),
    ).toEqual({ ...sample, batch });
    expect(
      sourceStatus({ ...sample, batch: { ...batch, payloadBytesSent: 0 } }),
    ).toBeUndefined();
    expect(
      sourceStatus({ ...sample, batch: { ...batch, skippedFiles: 2 } }),
    ).toBeUndefined();
    expect(
      sourceStatus({ ...sample, batch: { ...batch, wallElapsedMs: -1 } }),
    ).toBeUndefined();
  });
  it.each([
    null,
    {},
    { ...sample, stage: 'private-filename' },
    { ...sample, visibility: 'private-address' },
    { ...sample, paused: 'false' },
    { ...sample, connections: 8 },
    { ...sample, deprioritizedConnections: 8 },
    { ...sample, unreceivedBytes: -1 },
    { ...sample, oldestUnreceivedMs: Infinity },
    { ...sample, receiptDelayMs: NaN },
    { ...sample, queuedDelayMs: 0.5 },
    { ...sample, sendBufferBytes: Number.MAX_SAFE_INTEGER + 1 },
    { ...sample, replayedPackets: undefined },
  ])('ignores invalid optional telemetry without trusting it: %j', (value) => {
    expect(sourceStatus(value)).toBeUndefined();
  });
  it('preserves status for all seven supported connections', () => {
    expect(
      sourceStatus({ ...sample, connections: 7, deprioritizedConnections: 7 }),
    ).toMatchObject({ connections: 7, deprioritizedConnections: 7 });
  });
});

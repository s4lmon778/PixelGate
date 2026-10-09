import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  RouteProbe,
  routeFailureMessage,
  type RouteDiagnostics,
} from '../lib/bridge/route-diagnostics';

afterEach(() => vi.useRealTimers());
function connection() {
  return Object.assign(new EventTarget(), {
    signalingState: 'stable',
    iceConnectionState: 'checking',
    connectionState: 'connecting',
    iceGatheringState: 'complete',
    localDescription: {
      sdp: 'a=candidate:1 1 udp 1 192.168.1.43 3478 typ host\na=candidate:2 1 udp 1 203.0.113.7 9090 typ srflx',
    },
    remoteDescription: {
      sdp: 'a=candidate:3 1 udp 1 private-device.local 5070 typ host',
    },
    getStats: vi.fn().mockResolvedValue(
      new Map([
        [
          'pair',
          {
            type: 'candidate-pair',
            state: 'in-progress',
            localCandidateId: 'sensitive-id',
          },
        ],
        [
          'candidate',
          { type: 'local-candidate', address: '192.168.1.43', port: 3478 },
        ],
      ]),
    ),
  });
}
describe('local route diagnostics', () => {
  it('records route counts without retaining addresses, SDP, or identifiers', async () => {
    vi.useFakeTimers();
    const pc = connection(),
      update = vi.fn();
    const probe = new RouteProbe(
      pc as unknown as RTCPeerConnection,
      () => undefined,
      update,
    );
    pc.dispatchEvent(
      Object.assign(new Event('icecandidateerror'), {
        url: 'stun:stun.cloudflare.com:3478',
        errorCode: 701,
        errorText: '192.168.1.43: cannot reach private-device.local',
        address: '192.168.1.43',
      }),
    );
    await vi.advanceTimersByTimeAsync(2000);
    const report = probe.snapshot();
    expect(report).toMatchObject({
      localCandidates: { host: 1, srflx: 1, prflx: 0, relay: 0 },
      remoteCandidates: { host: 1, srflx: 0, prflx: 0, relay: 0 },
      remoteMdns: 1,
      localMdns: 0,
      elapsedSeconds: 2,
      candidatePairs: { 'in-progress': 1 },
      stunErrors: [{ service: 'Cloudflare STUN', code: 701 }],
    });
    for (const secret of [
      '192.168.1.43',
      '203.0.113.7',
      'private-device.local',
      'sensitive-id',
      'a=candidate:',
    ])
      expect(JSON.stringify(report)).not.toContain(secret);
    probe.stop();
    const count = update.mock.calls.length;
    pc.dispatchEvent(new Event('icecandidateerror'));
    await vi.advanceTimersByTimeAsync(10000);
    expect(update).toHaveBeenCalledTimes(count);
  });
  it('bounds errors and retains the last state when browser statistics reject', async () => {
    vi.useFakeTimers();
    const pc = connection();
    pc.getStats.mockRejectedValue(new Error('closed'));
    const probe = new RouteProbe(
      pc as unknown as RTCPeerConnection,
      () => undefined,
      vi.fn(),
    );
    for (let i = 0; i < 100; i++)
      pc.dispatchEvent(
        Object.assign(new Event('icecandidateerror'), {
          url: 'stun:stun.l.google.com:19302',
          errorCode: 701,
        }),
      );
    await vi.advanceTimersByTimeAsync(2000);
    expect(probe.snapshot().stunErrors).toHaveLength(16);
    probe.stop();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('reports selected route latency and byte rates without exposing candidate addresses or IDs', async () => {
    vi.useFakeTimers();
    const pc = connection();
    const stats = (timestamp: number, sent: number, received: number) =>
      new Map<string, object>([
        [
          'transport',
          { type: 'transport', selectedCandidatePairId: 'private-pair' },
        ],
        [
          'private-pair',
          {
            type: 'candidate-pair',
            state: 'succeeded',
            timestamp,
            localCandidateId: 'private-local',
            remoteCandidateId: 'private-remote',
            bytesSent: sent,
            bytesReceived: received,
            currentRoundTripTime: 0.015,
          },
        ],
        [
          'private-local',
          {
            type: 'local-candidate',
            candidateType: 'host',
            protocol: 'udp',
            address: '192.168.1.43',
            port: 5000,
          },
        ],
        [
          'private-remote',
          {
            type: 'remote-candidate',
            candidateType: 'srflx',
            address: '203.0.113.7',
            port: 6000,
          },
        ],
      ]);
    pc.getStats
      .mockResolvedValueOnce(stats(2000, 20000, 10000))
      .mockResolvedValueOnce(stats(4000, 420000, 210000));
    const probe = new RouteProbe(
      pc as unknown as RTCPeerConnection,
      () => undefined,
      vi.fn(),
    );
    await vi.advanceTimersByTimeAsync(4000);
    expect(probe.snapshot().selectedRoute).toEqual({
      localType: 'host',
      remoteType: 'srflx',
      protocol: 'udp',
      roundTripMs: 15,
      sentBytesPerSecond: 200000,
      receivedBytesPerSecond: 100000,
    });
    for (const secret of [
      '192.168.1.43',
      '203.0.113.7',
      'private-local',
      'private-pair',
      '5000',
      '6000',
    ])
      expect(JSON.stringify(probe.snapshot())).not.toContain(secret);
    probe.stop();
  });
});

describe('route failure explanations', () => {
  const failed: RouteDiagnostics = {
    elapsedSeconds: 45,
    signaling: 'stable',
    ice: 'disconnected',
    gathering: 'complete',
    connection: 'failed',
    channel: 'not-created',
    localDescription: true,
    remoteDescription: true,
    localCandidates: { host: 1, srflx: 0, prflx: 0, relay: 0 },
    remoteCandidates: { host: 1, srflx: 1, prflx: 0, relay: 0 },
    localMdns: 1,
    remoteMdns: 1,
    lanCandidatesAdded: 0,
    candidateDelivery: {
      received: 2,
      queued: 1,
      added: 2,
      rejected: 0,
      errors: {},
    },
    statsReads: 22,
    statsErrors: 0,
    candidatePairs: {},
    stunErrors: [
      { service: 'Cloudflare STUN', code: 701 },
      { service: 'Google STUN', code: 701 },
    ],
  };

  it('explains the reported Wi-Fi failure without asserting a specific network policy', () => {
    const message = routeFailureMessage(failed);
    expect(message).toContain('Pairing succeeded');
    expect(message).toContain('could not reach either configured STUN');
    expect(message).toContain('networks may block');
    expect(message).not.toContain('is blocked');
  });

  it('distinguishes an absent answer from a failure after description exchange', () => {
    const message = routeFailureMessage({
      ...failed,
      signaling: 'have-local-offer',
      remoteDescription: false,
    });
    expect(message).toContain('setup is incomplete');
    expect(message).not.toContain('Pairing succeeded');
    expect(message).not.toContain('networks may block');
  });

  it('reports rejected candidates rather than attributing them to network isolation', () => {
    const message = routeFailureMessage({
      ...failed,
      candidateDelivery: {
        ...failed.candidateDelivery!,
        rejected: 1,
        errors: { OperationError: 1 },
      },
    });
    expect(message).toContain('browser rejected');
    expect(message).not.toContain('networks may block');
  });

  it('does not infer total STUN failure from partial failures or a gathered public route', () => {
    for (const report of [
      { ...failed, stunErrors: failed.stunErrors.slice(0, 1) },
      {
        ...failed,
        localCandidates: { ...failed.localCandidates, srflx: 1 },
      },
      undefined,
    ]) {
      const message = routeFailureMessage(report);
      expect(message).not.toContain('could not reach either');
      expect(message).toContain('no direct route opened');
    }
  });
});

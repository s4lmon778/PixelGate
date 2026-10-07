import { afterEach, describe, expect, it, vi } from 'vitest';
import { RouteProbe } from '../lib/bridge/route-diagnostics';

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
});

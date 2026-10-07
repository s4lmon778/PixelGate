import { afterEach, describe, expect, it, vi } from 'vitest';
import { CandidateInbox } from '../lib/bridge/candidate-inbox';

const candidate = {
  candidate: 'candidate:1 1 UDP 2122260223 private-device.local 50000 typ host',
  sdpMid: '0',
  sdpMLineIndex: 0,
  usernameFragment: 'secret',
};
function connection() {
  return Object.assign(new EventTarget(), {
    signalingState: 'have-local-offer',
    remoteDescription: null as null | { type: string },
    addIceCandidate: vi.fn().mockResolvedValue(undefined),
  });
}
const pc = (value: ReturnType<typeof connection>) =>
  value as unknown as RTCPeerConnection;
afterEach(() => vi.restoreAllMocks());
describe('ordered ICE candidate delivery', () => {
  it('queues candidates before an answer and flushes them in order without duplicates', async () => {
    const value = connection(),
      inbox = new CandidateInbox(pc(value));
    inbox.receive(candidate);
    inbox.receive(candidate);
    inbox.receive({
      ...candidate,
      candidate: candidate.candidate.replace('50000', '50001'),
    });
    expect(value.addIceCandidate).not.toHaveBeenCalled();
    expect(inbox.snapshot()).toMatchObject({
      received: 3,
      queued: 2,
      added: 0,
      rejected: 0,
    });
    value.remoteDescription = { type: 'answer' };
    value.signalingState = 'stable';
    value.dispatchEvent(new Event('signalingstatechange'));
    await vi.waitFor(() =>
      expect(value.addIceCandidate).toHaveBeenCalledTimes(2),
    );
    expect(value.addIceCandidate.mock.calls[0][0].candidate).toContain('50000');
    expect(value.addIceCandidate.mock.calls[1][0].candidate).toContain('50001');
    expect(inbox.snapshot().added).toBe(2);
    for (const secret of ['private-device.local', 'secret', '50000'])
      expect(JSON.stringify(inbox.snapshot())).not.toContain(secret);
    inbox.stop();
  });
  it('continues after one rejected route and exposes only bounded error categories', async () => {
    const value = connection();
    value.remoteDescription = { type: 'offer' };
    value.addIceCandidate.mockRejectedValueOnce(
      Object.assign(new Error('192.168.1.20 rejected secret SDP'), {
        name: 'OperationError',
      }),
    );
    const inbox = new CandidateInbox(pc(value));
    inbox.receive(candidate);
    inbox.receive({
      ...candidate,
      candidate: candidate.candidate.replace('50000', '50001'),
    });
    await vi.waitFor(() => expect(inbox.snapshot().added).toBe(1));
    expect(inbox.snapshot()).toMatchObject({
      rejected: 1,
      errors: { OperationError: 1 },
    });
    expect(JSON.stringify(inbox.snapshot())).not.toMatch(/192\.168|secret|SDP/);
    inbox.stop();
  });
  it('bounds payloads and lifetime candidate counts before applying anything', async () => {
    const value = connection(),
      inbox = new CandidateInbox(pc(value));
    for (const bad of [
      null,
      [],
      {},
      { candidate: 'x'.repeat(2049) },
      { ...candidate, sdpMid: 'x'.repeat(65) },
      { ...candidate, sdpMLineIndex: -1 },
      { ...candidate, sdpMid: null, sdpMLineIndex: null },
      { ...candidate, usernameFragment: 'x'.repeat(257) },
    ])
      inbox.receive(bad);
    for (let i = 0; i < 1000; i++)
      inbox.receive({
        ...candidate,
        candidate: candidate.candidate.replace('50000', String(51000 + i)),
      });
    expect(inbox.snapshot().received).toBe(128);
    expect(inbox.snapshot().rejected).toBe(128);
    value.remoteDescription = { type: 'answer' };
    value.dispatchEvent(new Event('signalingstatechange'));
    await vi.waitFor(() =>
      expect(value.addIceCandidate).toHaveBeenCalledTimes(64),
    );
    inbox.stop();
  });
  it('drops queued and in-flight work on revocation', async () => {
    const value = connection(),
      inbox = new CandidateInbox(pc(value));
    inbox.receive(candidate);
    inbox.stop();
    value.remoteDescription = { type: 'answer' };
    value.dispatchEvent(new Event('signalingstatechange'));
    expect(value.addIceCandidate).not.toHaveBeenCalled();
    let finish!: () => void;
    value.addIceCandidate.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const pending = new CandidateInbox(pc(value));
    pending.receive(candidate);
    pending.receive({
      ...candidate,
      candidate: candidate.candidate.replace('50000', '50001'),
    });
    pending.stop();
    finish();
    await Promise.resolve();
    await Promise.resolve();
    expect(value.addIceCandidate).toHaveBeenCalledTimes(1);
    expect(pending.snapshot().added).toBe(0);
  });
});

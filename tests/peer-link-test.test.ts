import { describe, it, expect, vi } from 'vitest';
import {
  LINK_TEST_BYTES,
  LINK_TEST_MAGIC,
  PeerLinkTest,
} from '../lib/bridge/peer-link-test';

function pair() {
  let frames = 0;
  const receiving = { readyState: 'open', bufferedAmount: 0 } as RTCDataChannel;
  const sending = {
    readyState: 'open',
    bufferedAmount: 0,
    send: (data: Uint8Array) => {
      frames++;
      const copy = data.slice().buffer;
      queueMicrotask(() => {
        receiver.receiveBytes(copy, receiving);
        receiver.receiveBytes(copy, receiving);
      });
    },
  } as unknown as RTCDataChannel;
  const sender = new PeerLinkTest(
    'send',
    () => [sending],
    (value) =>
      queueMicrotask(() =>
        receiver.receiveControl(value as Record<string, unknown>),
      ),
    () => {},
  );
  const receiver = new PeerLinkTest(
    'receive',
    () => [receiving],
    (value) =>
      queueMicrotask(() =>
        sender.receiveControl(value as Record<string, unknown>),
      ),
    () => {},
  );
  for (const test of [sender, receiver]) {
    test.supported = true;
    test.allowed = () => true;
  }
  return { sender, receiver, frames: () => frames };
}
describe('isolated peer link test', () => {
  it.each(['send', 'receive'])(
    'can be requested by the %s role, counts unique bytes, and releases the test',
    async (role) => {
      const p = pair();
      (role === 'send' ? p.sender : p.receiver).start();
      await expect
        .poll(() => p.sender.snapshot().result?.bytes)
        .toBe(LINK_TEST_BYTES);
      expect(p.receiver.snapshot().result?.bytes).toBe(LINK_TEST_BYTES);
      expect(p.frames()).toBe(512);
      expect(p.receiver.snapshot().result?.connections).toBe(1);
      expect(p.sender.snapshot().running).toBe(false);
      expect(p.receiver.snapshot().running).toBe(false);
    },
  );
  it('allows another idle test immediately after completion', async () => {
    const p = pair();
    p.receiver.start();
    await expect.poll(() => p.sender.snapshot().running).toBe(false);
    // Wait for the first result rather than the pre-handshake idle state.
    await expect
      .poll(() => p.sender.snapshot().result?.bytes)
      .toBe(LINK_TEST_BYTES);
    p.receiver.start();
    await expect.poll(() => p.frames()).toBe(1024);
    await expect.poll(() => p.sender.snapshot().running).toBe(false);
    expect(p.receiver.snapshot().running).toBe(false);
  });
  it('requires peer support and refuses a remotely requested test while busy', async () => {
    const p = pair();
    p.sender.supported = false;
    expect(() => p.sender.start()).toThrow('Update both devices');
    p.sender.supported = true;
    p.sender.allowed = () => false;
    p.receiver.start();
    await expect.poll(() => p.receiver.snapshot().running).toBe(false);
    expect(p.receiver.snapshot().status).toContain('busy');
    expect(p.frames()).toBe(0);
  });
  it('rejects forged IDs/results and late data, and expires a test without altering file transport', async () => {
    vi.useFakeTimers();
    const controls: Record<string, unknown>[] = [];
    const test = new PeerLinkTest(
      'receive',
      () => [],
      (value) => controls.push(value as Record<string, unknown>),
      () => {},
    );
    test.supported = true;
    test.allowed = () => true;
    try {
      test.receiveControl({ action: 'begin', id: -1 });
      expect(test.snapshot().running).toBe(false);
      test.start();
      const id = controls[0].id as number;
      const frame = new ArrayBuffer(16384 + 12);
      const header = new DataView(frame);
      header.setUint32(0, LINK_TEST_MAGIC);
      header.setUint32(4, id);
      header.setUint32(8, 0xffffffff);
      test.receiveBytes(frame, {} as RTCDataChannel);
      test.receiveControl({
        action: 'result',
        id,
        bytes: LINK_TEST_BYTES,
        milliseconds: 1,
        connections: 1,
      });
      expect(test.snapshot().result).toBeUndefined();
      await vi.advanceTimersByTimeAsync(15000);
      expect(test.snapshot().running).toBe(false);
      expect(test.snapshot().status).toContain('timed out');
      header.setUint32(8, 0);
      test.receiveBytes(frame, {} as RTCDataChannel);
      expect(test.snapshot().result).toBeUndefined();
    } finally {
      test.cancel();
      vi.useRealTimers();
    }
  });
  it('cancels both endpoints while waiting without emitting payload', async () => {
    const p = pair();
    p.receiver.start();
    p.receiver.cancel();
    await new Promise((resolve) => setTimeout(resolve, 10));
    p.sender.cancel();
    expect(p.frames()).toBe(0);
    expect(p.receiver.snapshot().running).toBe(false);
  });
});

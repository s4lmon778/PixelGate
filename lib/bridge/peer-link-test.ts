import { SendPacer } from './send-pacer';

export const LINK_TEST_MAGIC = 0x50475431;
export const LINK_TEST_BYTES = 8 * 1024 * 1024;
const FRAME = 16 * 1024;
const HEADER = 12;
const CREDIT = 512 * 1024;
const TIMEOUT = 15000;
type Result = {
  measuredAt: string;
  bytes: number;
  milliseconds: number;
  bytesPerSecond: number;
  connections: number;
};
export type LinkTestSnapshot = {
  supported: boolean;
  running: boolean;
  status: string;
  result?: Result;
};
type Run = {
  id: number;
  bytes: number;
  acknowledged: number;
  started: number;
  firstByte: number;
  lastByte: number;
  seen: Uint8Array;
  connections: number;
  paths: Set<RTCDataChannel>;
  pumping: boolean;
};

/** A bounded, opt-in transport measurement. No file protocol or storage calls. */
export class PeerLinkTest {
  supported = false;
  allowed: () => boolean = () => false;
  private run?: Run;
  private timer?: ReturnType<typeof setTimeout>;
  private status = 'Not tested';
  private result?: Result;
  private closed = new Set<number>();
  constructor(
    private role: 'send' | 'receive',
    private paths: () => RTCDataChannel[],
    private control: (message: object) => void,
    private changed: () => void,
  ) {}
  snapshot(): LinkTestSnapshot {
    return {
      supported: this.supported,
      running: !!this.run,
      status: this.status,
      ...(this.result ? { result: this.result } : {}),
    };
  }
  private message(action: string, fields: object = {}) {
    this.control({ type: 'pg-link-test', action, id: this.run?.id, ...fields });
  }
  private begin(id: number) {
    this.run = {
      id,
      bytes: 0,
      acknowledged: 0,
      started: performance.now(),
      firstByte: 0,
      lastByte: 0,
      seen: new Uint8Array(LINK_TEST_BYTES / FRAME),
      connections: 0,
      paths: new Set(),
      pumping: false,
    };
    this.status = 'Testing peer link…';
    this.timer = setTimeout(
      () => this.cancel('Peer test timed out; no file data was changed.'),
      TIMEOUT,
    );
    this.changed();
  }
  start() {
    if (!this.supported)
      throw new Error('Update both devices to run a peer-link test.');
    if (this.run || !this.allowed())
      throw new Error(
        'Finish the active transfer or saving operation before testing.',
      );
    const id = crypto.getRandomValues(new Uint32Array(1))[0] || 1;
    this.begin(id);
    try {
      this.message(this.role === 'send' ? 'begin' : 'request');
    } catch {
      this.cancel('Peer link is unavailable.');
    }
  }
  cancel(status = 'Peer test cancelled.', notify = true) {
    if (!this.run) return;
    if (notify) {
      try {
        this.message('cancel');
      } catch {
        /* A closed link cannot receive cancellation. */
      }
    }
    this.finish(status);
  }
  private finish(status: string) {
    clearTimeout(this.timer);
    if (this.run) this.closed.add(this.run.id);
    if (this.closed.size > 8)
      this.closed.delete(this.closed.values().next().value!);
    this.run = undefined;
    this.status = status;
    this.changed();
  }
  receiveControl(value: Record<string, unknown>) {
    if (
      !this.supported ||
      !Number.isSafeInteger(value.id) ||
      (value.id as number) < 1 ||
      (value.id as number) > 0xffffffff
    )
      return;
    const id = value.id as number;
    if (this.closed.has(id)) return;
    if (value.action === 'request' && this.role === 'send') {
      if (this.run || !this.allowed()) {
        this.control({ type: 'pg-link-test', action: 'busy', id });
        return;
      }
      this.begin(id);
      this.message('begin');
      return;
    }
    if (value.action === 'begin' && this.role === 'receive') {
      if ((!this.run && !this.allowed()) || (this.run && this.run.id !== id)) {
        this.control({ type: 'pg-link-test', action: 'busy', id });
        return;
      }
      if (!this.run) {
        this.begin(id);
      }
      if (this.run!.bytes) return;
      this.message('ready');
      return;
    }
    const run = this.run;
    if (!run || run.id !== id) return;
    if (value.action === 'ready' && this.role === 'send' && !run.pumping) {
      run.pumping = true;
      void this.pump(run);
    } else if (
      value.action === 'progress' &&
      this.role === 'send' &&
      Number.isSafeInteger(value.bytes) &&
      (value.bytes as number) >= run.acknowledged &&
      (value.bytes as number) <= Math.max(0, run.bytes)
    ) {
      run.acknowledged = value.bytes as number;
    } else if (value.action === 'result' && this.role === 'send') {
      if (
        value.bytes !== LINK_TEST_BYTES ||
        run.bytes !== LINK_TEST_BYTES ||
        !Number.isFinite(value.milliseconds) ||
        (value.milliseconds as number) < 1 ||
        (value.milliseconds as number) > TIMEOUT ||
        !Number.isInteger(value.connections) ||
        (value.connections as number) < 1 ||
        (value.connections as number) > 14
      )
        return;
      this.result = {
        measuredAt: new Date().toISOString(),
        bytes: LINK_TEST_BYTES,
        milliseconds: Math.round(value.milliseconds as number),
        bytesPerSecond: Math.round(
          (LINK_TEST_BYTES * 1000) / (value.milliseconds as number),
        ),
        connections: value.connections as number,
      };
      this.finish('Peer test complete');
    } else if (value.action === 'cancel' || value.action === 'busy')
      this.cancel(
        value.action === 'busy'
          ? 'The other device is busy. Finish its transfer or save first.'
          : 'Peer test cancelled.',
        false,
      );
  }
  receiveBytes(data: ArrayBuffer, path: RTCDataChannel) {
    const run = this.run;
    if (
      !this.supported ||
      this.role !== 'receive' ||
      !run ||
      data.byteLength !== FRAME + HEADER
    )
      return;
    const view = new DataView(data);
    if (view.getUint32(0) !== LINK_TEST_MAGIC || view.getUint32(4) !== run.id)
      return;
    const sequence = view.getUint32(8);
    if (sequence >= run.seen.length || run.seen[sequence]) return;
    run.seen[sequence] = 1;
    const now = performance.now();
    if (!run.bytes) run.firstByte = now;
    run.lastByte = now;
    run.paths.add(path);
    run.bytes += FRAME;
    if (run.bytes % (128 * 1024) === 0)
      this.message('progress', { bytes: run.bytes });
    if (run.bytes === LINK_TEST_BYTES) {
      const milliseconds = Math.max(1, run.lastByte - run.firstByte);
      this.result = {
        measuredAt: new Date().toISOString(),
        bytes: run.bytes,
        milliseconds: Math.round(milliseconds),
        bytesPerSecond: Math.round((run.bytes * 1000) / milliseconds),
        connections: run.paths.size,
      };
      this.message('result', {
        bytes: run.bytes,
        milliseconds,
        connections: run.paths.size,
      });
      this.finish('Peer test complete');
    }
  }
  private async pump(run: Run) {
    const pacer = new SendPacer();
    const frame = new Uint8Array(FRAME + HEADER);
    crypto.getRandomValues(frame);
    const view = new DataView(frame.buffer);
    view.setUint32(0, LINK_TEST_MAGIC);
    view.setUint32(4, run.id);
    run.bytes = 0;
    let turn = 0;
    try {
      while (this.run === run && run.bytes < LINK_TEST_BYTES) {
        const paths = this.paths().filter((path) => path.readyState === 'open');
        if (!paths.length) throw new Error('Peer link is unavailable.');
        const buffers = new Map(
          paths.map((path) => [path, path.bufferedAmount]),
        );
        let queued = [...buffers.values()].reduce((a, b) => a + b, 0);
        let sent = 0;
        const began = performance.now();
        while (
          run.bytes < LINK_TEST_BYTES &&
          queued < CREDIT &&
          run.bytes - run.acknowledged < 2 * CREDIT &&
          sent < 128 * 1024 &&
          performance.now() - began < 8
        ) {
          const path = paths.reduce(
            (a, b) => (buffers.get(a)! <= buffers.get(b)! ? a : b),
            paths[turn++ % paths.length],
          );
          view.setUint32(8, run.bytes / FRAME);
          path.send(frame);
          buffers.set(path, buffers.get(path)! + frame.byteLength);
          queued += frame.byteLength;
          run.bytes += FRAME;
          sent += FRAME;
        }
        await pacer.yield(sent ? 0 : 10);
      }
    } catch {
      this.cancel('Peer test interrupted; files were not changed.');
    } finally {
      pacer.close();
    }
  }
}

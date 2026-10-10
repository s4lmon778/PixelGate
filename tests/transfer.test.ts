import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import {
  CHECKPOINT_BYTES,
  FRAME_BYTES,
  TRANSFER_WINDOW_BYTES,
  type Control,
  type RecordFile,
  type QueuedFile,
} from '../lib/bridge/model';
const state = vi.hoisted(() => ({
  files: new Map<string, RecordFile>(),
  bytes: new Map<string, Uint8Array>(),
  corrupt: false,
  destination: false,
  opens: [] as number[],
  beforeWrite: undefined as (() => Promise<void>) | undefined,
  failPutAtBytes: undefined as number | undefined,
  writtenBuffers: [] as ArrayBuffer[],
}));
vi.mock('../lib/bridge/database', () => ({
  local: {
    get: async (id: string) => state.files.get(id),
    put: async (r: RecordFile) => {
      if (r.phase === 'transferring' && r.bytes === state.failPutAtBytes) {
        state.failPutAtBytes = undefined;
        throw new Error('Checkpoint metadata failed');
      }
      state.files.set(r.id, { ...r });
    },
    putSender: async () => {},
    session: async () => {},
  },
}));
vi.mock('../lib/bridge/hash', () => ({
  hashFile: async (f: Blob) =>
    createHash('sha256')
      .update(new Uint8Array(await f.arrayBuffer()))
      .digest('hex'),
  identity: async (h: string, p: string) =>
    createHash('sha256').update(`${h}\n${p}`).digest('hex'),
}));
vi.mock('../lib/bridge/storage', () => ({
  StagingWriter: class {
    id = '';
    open = async (id: string, offset: number) => {
      this.id = id;
      state.opens.push(offset);
      state.bytes.set(
        id,
        (state.bytes.get(id) ?? new Uint8Array()).slice(0, offset),
      );
    };
    write = async (offset: number, data: ArrayBuffer) => {
      await state.beforeWrite?.();
      state.writtenBuffers.push(data);
      // Match the actual worker's ownership transfer: detach the caller buffer.
      const block = new Uint8Array(structuredClone(data, { transfer: [data] }));
      const old = state.bytes.get(this.id)!;
      const bytes = new Uint8Array(offset + block.length);
      bytes.set(old);
      bytes.set(block, offset);
      if (state.corrupt) bytes[0] ^= 1;
      state.bytes.set(this.id, bytes);
    };
    close = async () => {};
    dispose = async () => {};
  },
  capacity: async () => {},
  removeStaged: async (id: string) => state.bytes.delete(id),
  stagedFile: async (id: string) => {
    if (!state.bytes.has(id)) throw new Error('Missing copy');
    return new File([new Uint8Array(state.bytes.get(id)!).buffer], 'staged');
  },
  storedCopyValid: async (r: RecordFile) =>
    state.bytes.has(r.id) &&
    createHash('sha256').update(state.bytes.get(r.id)!).digest('hex') ===
      r.sha256,
  saveToFolder: async () => {
    throw new Error('No test folder');
  },
  existingDestination: async (_root: unknown, r: RecordFile) =>
    state.destination
      ? { ...r, bytes: r.size, phase: 'duplicate', scope: 'destination' }
      : undefined,
}));
import { Sender, Receiver } from '../lib/bridge/transfer';
class Channel {
  readyState = 'open';
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  binaryType = 'arraybuffer';
  onmessage?: (e: { data: unknown }) => void;
  peer!: Channel;
  listeners = new Map<string, (() => void)[]>();
  transform?: (message: Control) => Control;
  binarySent = 0;
  send(value: string | Uint8Array) {
    if (typeof value === 'string' && this.transform)
      value = JSON.stringify(this.transform(JSON.parse(value)));
    if (typeof value !== 'string') this.binarySent += value.byteLength;
    const data = typeof value === 'string' ? value : value.slice().buffer;
    queueMicrotask(() => {
      if (this.peer.readyState === 'open') this.peer.onmessage?.({ data });
    });
  }
  addEventListener(type: string, fn: () => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  emit(type: string) {
    for (const fn of this.listeners.get(type) ?? []) fn();
  }
  close() {
    for (const c of [this, this.peer]) {
      if (c.readyState === 'closed') continue;
      c.readyState = 'closed';
      for (const fn of c.listeners.get('close') ?? []) fn();
    }
  }
}
function peers(
  update: (r: RecordFile) => void = () => {},
  folder?: FileSystemDirectoryHandle,
) {
  const a = new Channel(),
    b = new Channel();
  a.peer = b;
  b.peer = a;
  const errors: Error[] = [];
  const receiver = new Receiver(
    b as unknown as RTCDataChannel,
    () => folder,
    update,
    (e) => errors.push(e),
  );
  const sender = new Sender(a as unknown as RTCDataChannel, () => {});
  return { a, b, sender, receiver, errors };
}
function queue(size = 2 * 1024 * 1024 + 123): QueuedFile[] {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i++) bytes[i] = i % 251;
  return [
    {
      key: 'one',
      path: 'nested/été.MOV',
      file: new File([bytes], 'été.MOV', { lastModified: 1 }),
      phase: 'pending',
    },
  ];
}
beforeEach(() => {
  state.files.clear();
  state.bytes.clear();
  state.opens = [];
  state.corrupt = false;
  state.destination = false;
  state.beforeWrite = undefined;
  state.failPutAtBytes = undefined;
  state.writtenBuffers = [];
});
describe('receiver-owned verification and checkpoints', () => {
  it('receives offset views without headers and survives detached checkpoint buffers', async () => {
    const p = peers(),
      q = queue();
    const original = p.a.send.bind(p.a);
    p.a.send = (value) => {
      if (typeof value === 'string') return original(value);
      p.a.binarySent += value.byteLength;
      const wire = new Uint8Array(value.byteLength + 16).fill(0xff);
      wire.set(value, 8);
      queueMicrotask(() => {
        if (p.b.readyState === 'open')
          p.b.onmessage?.({
            data: new Uint8Array(wire.buffer, 8, value.byteLength),
          });
      });
    };
    await p.sender.run(q, 'offset-views');
    expect(q[0].phase).toBe('verified');
    expect(state.writtenBuffers).toHaveLength(3);
    expect(
      state.writtenBuffers.every((buffer) => buffer.byteLength === 0),
    ).toBe(true);
    expect(new Set(state.writtenBuffers).size).toBe(3);
    expect(
      createHash('sha256')
        .update(state.bytes.get(q[0].record!.id)!)
        .digest('hex'),
    ).toBe(q[0].record!.sha256);
    await p.receiver.close();
  });
  it('contains a failed read-ahead and continues the next file with byte verification', async () => {
    const p = peers(),
      q = queue();
    const slice = q[0].file.slice.bind(q[0].file);
    vi.spyOn(q[0].file, 'slice').mockImplementation((start, end) => {
      const blob = slice(start, end);
      if (start === CHECKPOINT_BYTES)
        vi.spyOn(blob, 'arrayBuffer').mockRejectedValue(
          new Error('Source read failed'),
        );
      return blob;
    });
    const following = queue(1001)[0];
    following.path = 'following.bin';
    q.push(following);
    await p.sender.run(q, 'read-ahead-error');
    expect(q[0].phase).toBe('failed');
    expect(q[0].error).toBe('Source read failed');
    expect(following.phase).toBe('verified');
    expect(
      createHash('sha256')
        .update(state.bytes.get(following.record!.id)!)
        .digest('hex'),
    ).toBe(following.record!.sha256);
    await p.receiver.close();
  });
  it('truncates a written tail after checkpoint metadata fails', async () => {
    state.failPutAtBytes = 2 * CHECKPOINT_BYTES;
    const p = peers(),
      q = queue(TRANSFER_WINDOW_BYTES + 123);
    await p.sender.run(q, 'manifest-error');
    await p.receiver.close();
    expect(q[0].phase).toBe('failed');
    expect(state.files.get(q[0].record!.id)?.bytes).toBe(CHECKPOINT_BYTES);
    expect(state.bytes.get(q[0].record!.id)?.length).toBe(2 * CHECKPOINT_BYTES);
    expect(p.errors).toHaveLength(1);
    const resumed = peers();
    await resumed.sender.run(q, 'manifest-resume');
    expect(state.opens).toEqual([0, CHECKPOINT_BYTES]);
    expect(q[0].phase).toBe('verified');
    expect(
      createHash('sha256')
        .update(state.bytes.get(q[0].record!.id)!)
        .digest('hex'),
    ).toBe(q[0].record!.sha256);
    await resumed.receiver.close();
  });
  it('retains the durable prefix after a storage error with later checkpoints in flight', async () => {
    let writes = 0;
    state.beforeWrite = async () => {
      if (++writes === 2)
        throw new DOMException('Storage is full', 'QuotaExceededError');
    };
    const p = peers(),
      q = queue(TRANSFER_WINDOW_BYTES + 123);
    await p.sender.run(q, 'quota');
    await p.receiver.close();
    expect(q[0].phase).toBe('failed');
    expect(q[0].record?.bytes).toBe(CHECKPOINT_BYTES);
    expect(state.files.get(q[0].record!.id)?.bytes).toBe(CHECKPOINT_BYTES);
    expect(p.errors).toHaveLength(1);
    state.beforeWrite = undefined;
    const resumed = peers();
    await resumed.sender.run(q, 'quota-resume');
    expect(state.opens).toEqual([0, CHECKPOINT_BYTES]);
    expect(q[0].phase).toBe('verified');
    expect(
      createHash('sha256')
        .update(state.bytes.get(q[0].record!.id)!)
        .digest('hex'),
    ).toBe(q[0].record!.sha256);
    await resumed.receiver.close();
  });
  it('fills only the advertised window while storage stalls, then verifies every byte', async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    state.beforeWrite = () => blocked;
    const p = peers(),
      q = queue(TRANSFER_WINDOW_BYTES + CHECKPOINT_BYTES + 123);
    const run = p.sender.run(q, 'pipeline');
    try {
      await vi.waitFor(() =>
        expect(p.a.binarySent).toBe(TRANSFER_WINDOW_BYTES),
      );
      expect(q[0].record?.bytes).toBe(0);
      expect(state.files.get(q[0].record!.id)?.bytes).toBe(0);
      expect(p.errors).toEqual([]);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(p.a.binarySent).toBe(TRANSFER_WINDOW_BYTES);
    } finally {
      release();
    }
    await run;
    expect(q[0].phase).toBe('verified');
    expect(p.a.binarySent).toBe(q[0].file.size);
    expect(
      createHash('sha256')
        .update(state.bytes.get(q[0].record!.id)!)
        .digest('hex'),
    ).toBe(q[0].record!.sha256);
    await p.receiver.close();
  });
  it('keeps one checkpoint in flight with an older receiver', async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    state.beforeWrite = () => blocked;
    const p = peers(),
      q = queue(CHECKPOINT_BYTES + 123);
    p.b.transform = (message) => {
      if (message.type === 'ready') delete message.receiveWindowBytes;
      return message;
    };
    const run = p.sender.run(q, 'legacy');
    try {
      await vi.waitFor(() => expect(p.a.binarySent).toBe(CHECKPOINT_BYTES));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(p.a.binarySent).toBe(CHECKPOINT_BYTES);
      expect(q[0].record?.bytes).toBe(0);
    } finally {
      release();
    }
    await run;
    expect(q[0].phase).toBe('verified');
    await p.receiver.close();
  });
  it.each([
    0,
    CHECKPOINT_BYTES + 1,
    TRANSFER_WINDOW_BYTES + CHECKPOINT_BYTES,
    Infinity,
  ])(
    'rejects an invalid receive window of %s before sending payload',
    async (windowBytes) => {
      const p = peers(),
        q = queue(100);
      p.b.transform = (message) =>
        message.type === 'ready'
          ? { ...message, receiveWindowBytes: windowBytes }
          : message;
      await p.sender.run(q, 'invalid-window');
      expect(q[0].phase).toBe('failed');
      expect(q[0].error).toContain('invalid transfer window');
      expect(p.a.binarySent).toBe(0);
      await p.receiver.close();
    },
  );
  it('rejects an ACK that skips an outstanding durable checkpoint', async () => {
    const p = peers(),
      q = queue(CHECKPOINT_BYTES + 123);
    p.b.transform = (message) =>
      message.type === 'ack'
        ? { ...message, offset: message.offset + 1 }
        : message;
    await p.sender.run(q, 'invalid-ack');
    expect(q[0].phase).toBe('failed');
    expect(q[0].error).toContain('checkpoint does not match');
    expect(q[0].record?.bytes).toBe(0);
    await p.receiver.close();
  });
  it('refills on bufferedamountlow without waiting for a polling timer', async () => {
    const p = peers(),
      q = queue(100);
    p.a.bufferedAmount = CHECKPOINT_BYTES;
    const run = p.sender.run(q, 'backpressure');
    await vi.waitFor(() => expect(q[0].record?.phase).toBe('transferring'));
    expect(p.a.binarySent).toBe(0);
    p.a.bufferedAmount = p.a.bufferedAmountLowThreshold;
    p.a.emit('bufferedamountlow');
    await run;
    expect(q[0].phase).toBe('verified');
    await p.receiver.close();
  });
  it.each(['cancel', 'close'] as const)(
    'wakes a blocked sender on %s',
    async (action) => {
      const p = peers(),
        q = queue(100);
      p.a.bufferedAmount = CHECKPOINT_BYTES;
      const run = p.sender.run(q, 'blocked');
      await vi.waitFor(() => expect(q[0].record?.phase).toBe('transferring'));
      if (action === 'cancel') p.sender.cancel();
      else p.a.close();
      await run;
      expect(q[0].phase).toBe(action === 'cancel' ? 'cancelled' : 'paused');
      expect(p.a.binarySent).toBe(0);
      await p.receiver.close();
    },
  );
  it.each(['buffer', 'view'] as const)(
    'rejects receiver queue overflow with bounded %s payload memory',
    async (kind) => {
      let release!: () => void;
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      state.beforeWrite = () => blocked;
      const p = peers(),
        q = queue(TRANSFER_WINDOW_BYTES + FRAME_BYTES);
      const record = await p.sender.prepare(q[0], 'overflow');
      p.a.send(JSON.stringify({ type: 'start', file: record }));
      await vi.waitFor(() => expect(state.opens).toEqual([0]));
      for (let i = 0; i <= TRANSFER_WINDOW_BYTES / FRAME_BYTES; i++) {
        if (kind === 'view')
          p.b.onmessage?.({
            data: new Uint8Array(new ArrayBuffer(FRAME_BYTES + 8), 8),
          });
        else p.a.send(new Uint8Array(FRAME_BYTES));
      }
      try {
        await vi.waitFor(() => expect(p.a.readyState).toBe('closed'));
        expect(p.errors[0].message).toContain('receiving buffer');
      } finally {
        release();
      }
      await p.receiver.close();
    },
  );
  it('acknowledges reread destination copies without staging or retransmission', async () => {
    state.destination = true;
    const p = peers(() => {}, {} as FileSystemDirectoryHandle),
      q = queue(100);
    await p.sender.run(q, 'saved');
    expect(q[0].phase).toBe('duplicate');
    expect(q[0].record?.scope).toBe('destination');
    expect(state.opens).toEqual([]);
    expect(state.bytes.size).toBe(0);
    await p.receiver.close();
  });
  it('transfers raw bytes and independently verifies the complete stored copy', async () => {
    const p = peers(),
      q = queue();
    await p.sender.run(q, 'session');
    expect(q[0].phase).toBe('verified');
    expect(q[0].record?.scope).toBe('browser');
    expect(state.bytes.get(q[0].record!.id)).toEqual(
      new Uint8Array(await q[0].file.arrayBuffer()),
    );
    expect(p.errors).toHaveLength(0);
    await p.receiver.close();
  });
  it('rejects a source that changes after preparation', async () => {
    const a = new Channel(),
      b = new Channel();
    a.peer = b;
    b.peer = a;
    const receiver = new Receiver(
      b as unknown as RTCDataChannel,
      () => undefined,
      () => {},
      () => {},
    );
    let replaced = false;
    const sender = new Sender(a as unknown as RTCDataChannel, (q) => {
      if (q.phase === 'transferring' && !replaced) {
        replaced = true;
        q.file = new File([new Uint8Array([9, 9, 9])], 'changed.MOV');
      }
    });
    const q = queue(3);
    await sender.run(q, 'changed');
    expect(q[0].phase).toBe('failed');
    expect(state.bytes.size).toBe(0);
    await receiver.close();
  });
  it('handles empty files without inventing a checkpoint', async () => {
    const p = peers(),
      q = queue(0);
    await p.sender.run(q, 'empty');
    expect(q[0].phase).toBe('verified');
    expect(q[0].record?.bytes).toBe(0);
    await p.receiver.close();
  });
  it('rejects corrupt stored bytes and removes the partial copy', async () => {
    state.corrupt = true;
    const p = peers(),
      q = queue(100);
    await p.sender.run(q, 'bad');
    expect(q[0].phase).toBe('failed');
    expect(q[0].record?.scope).toBe('none');
    expect(state.bytes.size).toBe(0);
    await p.receiver.close();
  });
  it('resumes after disconnection from the last committed checkpoint', async () => {
    let first = true;
    const p = peers((r) => {
      if (first && r.bytes === 1024 * 1024) {
        first = false;
        p.a.close();
      }
    });
    const q = queue();
    await p.sender.run(q, 'interrupted');
    await p.receiver.close();
    expect(q[0].phase).toBe('paused');
    expect(state.files.get(q[0].record!.id)?.bytes).toBe(1024 * 1024);
    // Simulate unacknowledged bytes that reached storage before a crash.
    const id = q[0].record!.id;
    const tail = new Uint8Array(1024 * 1024 + 100);
    tail.set(state.bytes.get(id)!);
    state.bytes.set(id, tail);
    const resumed = peers();
    await resumed.sender.run(q, 'resumed');
    expect(state.opens).toEqual([0, 1024 * 1024]);
    expect(q[0].phase).toBe('verified');
    expect(state.bytes.get(id)).toEqual(
      new Uint8Array(await q[0].file.arrayBuffer()),
    );
    await resumed.receiver.close();
  });
  it('retransfers when a historical verified copy no longer exists', async () => {
    const p = peers(),
      q = queue(100);
    await p.sender.run(q, 'first');
    await p.receiver.close();
    state.bytes.clear();
    q[0].phase = 'pending';
    const next = peers();
    await next.sender.run(q, 'second');
    expect(q[0].phase).toBe('verified');
    expect(state.opens).toEqual([0, 0]);
    await next.receiver.close();
  });
  it('skips duplicates only after rereading retained bytes', async () => {
    const p = peers(),
      q = queue(100);
    await p.sender.run(q, 'first');
    await p.receiver.close();
    q[0].phase = 'pending';
    const next = peers();
    await next.sender.run(q, 'second');
    expect(q[0].phase).toBe('duplicate');
    expect(state.opens).toEqual([0]);
    await next.receiver.close();
  });
});

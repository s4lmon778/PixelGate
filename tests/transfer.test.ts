import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import type { RecordFile, QueuedFile } from '../lib/bridge/model';
const state = vi.hoisted(() => ({
  files: new Map<string, RecordFile>(),
  bytes: new Map<string, Uint8Array>(),
  corrupt: false,
  destination: false,
  opens: [] as number[],
}));
vi.mock('../lib/bridge/database', () => ({
  local: {
    get: async (id: string) => state.files.get(id),
    put: async (r: RecordFile) => state.files.set(r.id, { ...r }),
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
      const block = new Uint8Array(data);
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
  binaryType = 'arraybuffer';
  onmessage?: (e: { data: unknown }) => void;
  peer!: Channel;
  listeners = new Map<string, (() => void)[]>();
  send(value: string | Uint8Array) {
    const data = typeof value === 'string' ? value : value.slice().buffer;
    queueMicrotask(() => {
      if (this.peer.readyState === 'open') this.peer.onmessage?.({ data });
    });
  }
  addEventListener(type: string, fn: () => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
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
});
describe('receiver-owned verification and checkpoints', () => {
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

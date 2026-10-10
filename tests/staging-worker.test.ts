import { beforeEach, expect, it, vi } from 'vitest';

vi.mock('../lib/bridge/indexed-staging', () => ({
  openIndexed: vi.fn(),
  writeIndexed: vi.fn(),
  writeIndexedBatch: vi.fn(),
}));

let size: number;
let reply: (data: { ok?: boolean; error?: string }) => void;
const access = {
  write: vi.fn<(bytes: Uint8Array, options: { at: number }) => number>(),
  getSize: (): number | Promise<number> => size,
  truncate: (length: number): void | Promise<void> => {
    size = length;
  },
  flush: vi.fn<() => void | Promise<void>>(),
  close: vi.fn<() => void | Promise<void>>(),
};
const scope = {
  onmessage: undefined as ((event: { data: object }) => void) | undefined,
  postMessage: (data: { ok?: boolean; error?: string }) => reply(data),
};
let sequence = 0;
const call = (action: string, extra: object = {}) =>
  new Promise<{ ok?: boolean; error?: string }>((resolve) => {
    reply = resolve;
    scope.onmessage!({
      data: { id: ++sequence, action, backend: 'opfs', ...extra },
    });
  });

beforeEach(async () => {
  vi.resetModules();
  size = 0;
  sequence = 0;
  access.getSize = () => size;
  access.truncate = (length) => {
    size = length;
  };
  access.flush.mockReset();
  access.close.mockReset();
  access.write.mockReset().mockImplementation((bytes, { at }) => {
    size = at + bytes.length;
    return bytes.length;
  });
  vi.stubGlobal('self', scope);
  vi.stubGlobal('navigator', {
    storage: {
      getDirectory: async () => ({
        getDirectoryHandle: async () => ({
          getFileHandle: async () => ({
            createSyncAccessHandle: async () => access,
          }),
        }),
      }),
    },
  });
  await import('../lib/bridge/staging.worker');
  expect(await call('open', { fileId: 'test', offset: 0 })).toEqual({
    id: 1,
    ok: true,
  });
});

it.each([0, -8, 4294967288, Number.NaN, 0.5, 18])(
  'rejects an invalid native write count (%s) before confirming the checkpoint',
  async (count) => {
    expect(
      (await call('write', { offset: 0, bytes: new Uint8Array(32).buffer })).ok,
    ).toBe(true);
    access.write.mockImplementationOnce(() => count);
    const result = await call('write', {
      offset: 32,
      bytes: new Uint8Array(17).buffer,
    });
    expect(result.ok).toBeUndefined();
    expect(result.error).toContain('rejected this checkpoint');
    expect(size).toBe(32);
    expect(access.close).toHaveBeenCalledOnce();
    expect(access.flush).toHaveBeenCalledTimes(2);
  },
);

it('handles valid short writes at advancing offsets and checks final stored length', async () => {
  access.write.mockImplementation((bytes, { at }) => {
    const count = Math.min(3, bytes.length);
    size = at + count;
    return count;
  });
  expect(
    (await call('write', { offset: 0, bytes: new Uint8Array(8).buffer })).ok,
  ).toBe(true);
  expect(access.write.mock.calls.map(([, options]) => options.at)).toEqual([
    0, 3, 6,
  ]);
  expect(size).toBe(8);
});

it('flushes a contiguous batch once, validates its final size, and rejects unbounded batches', async () => {
  const blocks = [
    new Uint8Array(1024 * 1024).buffer,
    new Uint8Array(23).buffer,
  ];
  access.flush.mockClear();
  expect((await call('write-batch', { offset: 0, blocks })).ok).toBe(true);
  expect(size).toBe(1024 * 1024 + 23);
  expect(access.flush).toHaveBeenCalledOnce();
  expect(access.write.mock.calls.map(([, options]) => options.at)).toEqual([
    0,
    1024 * 1024,
  ]);
  const bad = await call('write-batch', {
    offset: size,
    blocks: Array(5).fill(blocks[0]),
  });
  expect(bad.error).toContain('Invalid staging batch');
  expect(size).toBe(1024 * 1024 + 23);
});

it('rejects a successful count when the file did not grow to the checkpoint end', async () => {
  access.write.mockImplementationOnce((bytes) => bytes.length);
  const result = await call('write', {
    offset: 0,
    bytes: new Uint8Array(17).buffer,
  });
  expect(result.ok).toBeUndefined();
  expect(result.error).toContain('did not retain the complete checkpoint');
  expect(access.close).toHaveBeenCalledOnce();
});

it('awaits the older asynchronous access-handle methods before confirming a checkpoint', async () => {
  await call('close');
  access.getSize = async () => size;
  access.truncate = async (length) => {
    size = length;
  };
  access.flush.mockImplementation(async () => {});
  access.close.mockImplementation(async () => {});
  expect((await call('open', { fileId: 'legacy-access', offset: 0 })).ok).toBe(
    true,
  );
  expect(
    (await call('write', { offset: 0, bytes: new Uint8Array(17).buffer })).ok,
  ).toBe(true);
  expect((await call('close')).ok).toBe(true);
  expect(size).toBe(17);
});

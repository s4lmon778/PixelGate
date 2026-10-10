import { beforeEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  opfsError: 'UnknownError',
  indexedError: '',
  corrupt: false,
  bytes: new Uint8Array(),
  opens: [] as string[],
  terminated: 0,
  silent: false,
}));
vi.mock('../lib/bridge/staging.worker?worker', () => ({
  default: class {
    onmessage?: (event: { data: object }) => void;
    onerror?: () => void;
    postMessage(message: {
      id: number;
      backend: string;
      action: string;
      bytes?: ArrayBuffer;
    }) {
      if (state.silent) return;
      let name = '';
      if (message.action === 'open') {
        state.opens.push(message.backend);
        name =
          message.backend === 'opfs' ? state.opfsError : state.indexedError;
      }
      if (message.action === 'write') {
        state.bytes = new Uint8Array(message.bytes!);
        if (state.corrupt) state.bytes[10] ^= 1;
      }
      queueMicrotask(() =>
        this.onmessage?.({
          data: name
            ? {
                id: message.id,
                errorName: name,
                error: 'Injected storage failure',
              }
            : { id: message.id },
        }),
      );
    }
    terminate() {
      state.terminated++;
    }
  },
}));
vi.mock('../lib/bridge/indexed-staging', () => ({
  removeIndexed: async () => {},
  indexedFile: async () => new File([state.bytes], 'probe'),
}));
vi.mock('../lib/bridge/hash', () => ({ hashFile: async () => '' }));

beforeEach(() => {
  vi.resetModules();
  state.opfsError = 'UnknownError';
  state.indexedError = '';
  state.corrupt = false;
  state.bytes = new Uint8Array();
  state.opens = [];
  state.terminated = 0;
  state.silent = false;
  vi.stubGlobal('navigator', {
    storage: {
      getDirectory: async () => {
        throw new DOMException('Unknown transient reason', state.opfsError);
      },
    },
  });
});

it('rejects a hung storage write, terminates its worker, and refuses later writes', async () => {
  vi.useFakeTimers();
  try {
    const { StagingWriter } = await import('../lib/bridge/storage');
    const writer = new StagingWriter('indexeddb');
    state.silent = true;
    const write = writer.write(0, new Uint8Array(1024).buffer);
    const rejected = expect(write).rejects.toThrow(
      'last saved checkpoint is retained',
    );
    await vi.advanceTimersByTimeAsync(59999);
    expect(state.terminated).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
    expect(state.terminated).toBe(1);
    await expect(
      writer.write(1024, new Uint8Array(1024).buffer),
    ).rejects.toThrow('Local storage stopped responding');
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

it.each(['UnknownError', 'NotSupportedError', 'SecurityError'])(
  'recovers unavailable OPFS (%s), and still opens a real file in the selected backend',
  async (name) => {
    state.opfsError = name;
    const { prepareStaging, stagingBackend, StagingWriter } =
      await import('../lib/bridge/storage');
    expect(await prepareStaging()).toBe('indexeddb');
    expect(stagingBackend()).toBe('indexeddb');
    const writer = new StagingWriter();
    await writer.open('a'.repeat(64), 0);
    await writer.dispose();
    expect(state.opens).toEqual(['opfs', 'indexeddb', 'indexeddb']);
    expect(state.terminated).toBe(3);
  },
);

it.each(['QuotaExceededError', 'NoModificationAllowedError'])(
  'does not hide OPFS %s by switching storage',
  async (name) => {
    state.opfsError = name;
    const { prepareStaging } = await import('../lib/bridge/storage');
    await expect(prepareStaging()).rejects.toMatchObject({ name });
    expect(state.opens).toEqual(['opfs']);
    expect(state.terminated).toBe(1);
  },
);

it('blocks pairing with useful guidance if neither backend is usable', async () => {
  state.indexedError = 'SecurityError';
  const { prepareStaging } = await import('../lib/bridge/storage');
  await expect(prepareStaging()).rejects.toThrow(
    'regular (non-Private) browser tab',
  );
  expect(state.opens).toEqual(['opfs', 'indexeddb']);
  expect(state.terminated).toBe(2);
});

it('rejects corrupted compatibility probe bytes instead of claiming receiving is ready', async () => {
  state.corrupt = true;
  const { prepareStaging } = await import('../lib/bridge/storage');
  await expect(prepareStaging()).rejects.toThrow('readback failed');
  expect(state.terminated).toBe(2);
});

import { beforeEach, expect, it, vi } from 'vitest';
import type { RecordFile } from '../lib/bridge/model';

const state = vi.hoisted(() => ({
  records: new Map<string, RecordFile>(),
  opfs: new Set<string>(),
  indexed: new Set<string>(),
  fail: '',
}));
vi.mock('../lib/bridge/database', () => ({
  local: {
    receivedFiles: async () => [...state.records.values()],
    put: async (record: RecordFile) => state.records.set(record.id, record),
  },
}));
vi.mock('../lib/bridge/indexed-staging', () => ({
  removeIndexed: async (id: string) => state.indexed.delete(id),
  indexedStagingUsage: async () => ({
    bytes: [...state.indexed].reduce(
      (total, id) => total + (state.records.get(id)?.bytes ?? 0),
      0,
    ),
    files: state.indexed.size,
  }),
}));
import {
  canClearStaging,
  clearVerifiedStaging,
  offerPreparedDownload,
  stagingUsage,
} from '../lib/bridge/storage';

function record(char: string, extra: Partial<RecordFile> = {}): RecordFile {
  return {
    id: char.repeat(64),
    sessionId: 'cache-test',
    relativePath: `${char}.jpg`,
    originalName: `${char}.jpg`,
    size: 1024,
    sha256: 'f'.repeat(64),
    mimeType: 'image/jpeg',
    modified: 0,
    bytes: 1024,
    phase: 'verified',
    scope: 'browser',
    updated: 0,
    localRole: 'receive',
    ...extra,
  };
}
beforeEach(() => {
  state.records.clear();
  state.opfs.clear();
  state.indexed.clear();
  state.fail = '';
  vi.stubGlobal('navigator', {
    storage: {
      getDirectory: async () => ({
        getDirectoryHandle: async () => ({
          entries: async function* () {
            for (const id of state.opfs)
              yield [
                id,
                {
                  kind: 'file',
                  getFile: async () => ({
                    size: state.records.get(id)?.bytes ?? 0,
                  }),
                },
              ];
          },
          removeEntry: async (id: string) => {
            if (state.fail === id)
              throw new DOMException(
                'File is busy',
                'NoModificationAllowedError',
              );
            if (!state.opfs.delete(id))
              throw new DOMException('Missing', 'NotFoundError');
          },
        }),
      }),
    },
  });
});

it('counts actual bytes in both caches, including unfinished files, and drops after cleanup', async () => {
  const saved = record('a', { downloaded: true });
  const partial = record('b', { phase: 'paused', bytes: 512, scope: 'none' });
  state.records.set(saved.id, saved);
  state.records.set(partial.id, partial);
  state.opfs.add(saved.id);
  state.indexed.add(saved.id);
  state.indexed.add(partial.id);
  expect(await stagingUsage()).toEqual({ bytes: 2560, files: 3 });
  await clearVerifiedStaging();
  expect(await stagingUsage()).toEqual({ bytes: 512, files: 1 });
});

it('requires a save receipt or destination verification and excludes unfinished or already cleared files', () => {
  expect(canClearStaging(record('a'))).toBe(false);
  for (const extra of [
    { downloaded: true },
    { shared: true },
    { scope: 'destination' as const },
    { scope: 'exported' as const },
  ])
    expect(canClearStaging(record('a', extra))).toBe(true);
  for (const extra of [
    { phase: 'paused' as const },
    { phase: 'transferring' as const },
    { phase: 'verifying' as const },
    { phase: 'failed' as const },
    { localRole: 'send' as const },
    { stagingCleared: true },
  ])
    expect(canClearStaging(record('a', { downloaded: true, ...extra }))).toBe(
      false,
    );
});

it('deletes both durable backends, releases download URLs, and keeps verification scopes and receipts intact', async () => {
  vi.useFakeTimers();
  const revoke = vi.spyOn(URL, 'revokeObjectURL');
  vi.stubGlobal('document', { createElement: () => ({ click() {} }) });
  try {
    const saved = [
      record('a', { downloaded: true }),
      record('b', { shared: true }),
      record('c', { scope: 'destination' }),
    ];
    const partial = record('d', { phase: 'paused', bytes: 512, scope: 'none' });
    for (const r of [...saved, partial]) {
      state.records.set(r.id, r);
      state.opfs.add(r.id);
      state.indexed.add(r.id);
    }
    offerPreparedDownload(new File(['original'], 'a.jpg'), saved[0].id);
    const result = await clearVerifiedStaging();
    expect(result).toEqual({
      cleared: saved.map((r) => r.id),
      bytes: 3072,
      errors: [],
    });
    expect([...state.opfs]).toEqual([partial.id]);
    expect([...state.indexed]).toEqual([partial.id]);
    expect(state.records.get(partial.id)).toEqual(partial);
    for (const r of saved)
      expect(state.records.get(r.id)).toMatchObject({
        ...r,
        updated: expect.any(Number),
        stagingCleared: true,
      });
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    expect((await clearVerifiedStaging()).cleared).toEqual([]);
  } finally {
    revoke.mockRestore();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});

it('keeps a failed deletion retryable and continues clearing other saved copies', async () => {
  const blocked = record('a', { scope: 'exported' });
  const saved = record('b', { downloaded: true });
  for (const r of [blocked, saved]) {
    state.records.set(r.id, r);
    state.opfs.add(r.id);
    state.indexed.add(r.id);
  }
  state.fail = blocked.id;
  const result = await clearVerifiedStaging();
  expect(result.cleared).toEqual([saved.id]);
  expect(result.errors).toEqual(['a.jpg: File is busy']);
  expect(state.records.get(blocked.id)).toEqual(blocked);
  expect(state.opfs.has(blocked.id)).toBe(true);
  state.fail = '';
  expect((await clearVerifiedStaging()).cleared).toEqual([blocked.id]);
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import type { RecordFile } from '../lib/bridge/model';
const state = vi.hoisted(() => ({
  bytes: new Uint8Array([1, 2, 3]),
  stored: new Map<string, RecordFile>(),
}));
vi.mock('../lib/bridge/hash', () => ({
  hashFile: async (blob: Blob) =>
    createHash('sha256')
      .update(new Uint8Array(await blob.arrayBuffer()))
      .digest('hex'),
}));
vi.mock('../lib/bridge/database', () => ({
  local: { put: async (r: RecordFile) => state.stored.set(r.id, r) },
}));
import {
  existingDestination,
  saveToFolder,
  verifyExport,
  capacity,
  prepareSharedFiles,
} from '../lib/bridge/storage';
const sha = createHash('sha256')
  .update(new Uint8Array([1, 2, 3]))
  .digest('hex');
const record: RecordFile = {
  id: 'a'.repeat(64),
  sessionId: 'test',
  relativePath: '旅行/IMG.HEIC',
  originalName: 'IMG.HEIC',
  size: 3,
  sha256: sha,
  mimeType: 'image/heic',
  modified: 0,
  bytes: 3,
  phase: 'verified',
  scope: 'browser',
  updated: 0,
};
function filesystem() {
  const files = new Map<string, Uint8Array>();
  const writes: string[] = [];
  function dir(prefix = ''): FileSystemDirectoryHandle {
    return {
      getDirectoryHandle: async (name: string) => dir(prefix + name + '/'),
      getFileHandle: async (name: string, options?: { create?: boolean }) => {
        const key = prefix + name;
        if (!files.has(key)) {
          if (!options?.create)
            throw Object.assign(new Error(), { name: 'NotFoundError' });
          files.set(key, new Uint8Array());
        }
        return {
          getFile: async () =>
            new File([new Uint8Array(files.get(key)!).buffer], name),
          createWritable: async () => {
            writes.push(key);
            const buffers: Uint8Array[] = [];
            return {
              write: async (data: ArrayBuffer) =>
                buffers.push(new Uint8Array(data)),
              close: async () => {
                const bytes = new Uint8Array(
                  buffers.reduce((n, b) => n + b.length, 0),
                );
                let offset = 0;
                for (const b of buffers) {
                  bytes.set(b, offset);
                  offset += b.length;
                }
                files.set(key, bytes);
              },
              abort: async () => {},
            };
          },
        };
      },
    } as unknown as FileSystemDirectoryHandle;
  }
  return { files, writes, dir };
}
beforeEach(() => {
  state.bytes = new Uint8Array([1, 2, 3]);
  state.stored.clear();
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      storage: {
        getDirectory: async () => ({
          getDirectoryHandle: async () => ({
            getFileHandle: async () => ({
              getFile: async () => new File([state.bytes], 'staged'),
            }),
          }),
        }),
        estimate: async () => ({ quota: 100000000, usage: 0 }),
      },
    },
  });
});
describe('native app handoff preparation', () => {
  it('independently checks staged bytes and preserves Unicode names, MIME and modification time', async () => {
    const files = await prepareSharedFiles([record]);
    expect(files[0].name).toBe('IMG.HEIC');
    expect(files[0].type).toBe('image/heic');
    expect(files[0].lastModified).toBe(0);
    expect(
      createHash('sha256')
        .update(new Uint8Array(await files[0].arrayBuffer()))
        .digest('hex'),
    ).toBe(sha);
    expect(state.stored.size).toBe(0);
  });
  it('blocks corrupted or unverified copies and rejects unbounded batches', async () => {
    state.bytes = new Uint8Array([3, 2, 1]);
    await expect(prepareSharedFiles([record])).rejects.toThrow(
      'failed verification',
    );
    await expect(
      prepareSharedFiles([{ ...record, scope: 'none', phase: 'failed' }]),
    ).rejects.toThrow('Only verified');
    await expect(
      prepareSharedFiles(Array.from({ length: 21 }, () => record)),
    ).rejects.toThrow('between 1 and 20');
  });
  it('gives flattened folder collisions distinct names without changing any bytes', async () => {
    const records = ['a/旅行.jpg', 'b/旅行.jpg', 'c/旅行 (2).jpg'].map(
      (relativePath) => ({ ...record, relativePath }),
    );
    const files = await prepareSharedFiles(records);
    expect(new Set(files.map((f) => f.name)).size).toBe(3);
    for (const file of files)
      expect(new Uint8Array(await file.arrayBuffer())).toEqual(state.bytes);
  });
});
describe('stored and exported copies', () => {
  it('finds a verified destination without requiring retained staging', async () => {
    state.bytes = new Uint8Array();
    const fs = filesystem();
    fs.files.set('旅行/IMG.HEIC', new Uint8Array([1, 2, 3]));
    const result = await existingDestination(fs.dir(), record);
    expect(result?.scope).toBe('destination');
    expect(result?.bytes).toBe(3);
    expect(fs.writes).toHaveLength(0);
  });
  it('rereads numbered destination copies and refuses changed content', async () => {
    const fs = filesystem();
    fs.files.set('旅行/IMG.HEIC', new Uint8Array([9, 9, 9]));
    fs.files.set('旅行/IMG (2).HEIC', new Uint8Array([1, 2, 3]));
    expect((await existingDestination(fs.dir(), record))?.destinationPath).toBe(
      '旅行/IMG (2).HEIC',
    );
    fs.files.set('旅行/IMG (2).HEIC', new Uint8Array([4, 5, 6]));
    expect(await existingDestination(fs.dir(), record)).toBeUndefined();
  });
  it('rereads destination bytes and preserves Unicode folder structure', async () => {
    const fs = filesystem();
    const result = await saveToFolder(fs.dir(), record);
    expect(result.scope).toBe('destination');
    expect(fs.files.get('旅行/IMG.HEIC')).toEqual(new Uint8Array([1, 2, 3]));
  });
  it('skips identical content only after hashing its actual stored copy', async () => {
    const fs = filesystem();
    fs.files.set('旅行/IMG.HEIC', new Uint8Array([1, 2, 3]));
    expect((await saveToFolder(fs.dir(), record)).phase).toBe('duplicate');
    expect(fs.writes).toHaveLength(0);
  });
  it('does not overwrite conflicting content', async () => {
    const fs = filesystem();
    fs.files.set('旅行/IMG.HEIC', new Uint8Array([9, 9, 9]));
    expect((await saveToFolder(fs.dir(), record)).destinationPath).toBe(
      '旅行/IMG (2).HEIC',
    );
    expect(fs.files.get('旅行/IMG.HEIC')).toEqual(new Uint8Array([9, 9, 9]));
  });
  it('rejects corrupted staging before exposing a final file', async () => {
    state.bytes[1] = 99;
    const fs = filesystem();
    await expect(saveToFolder(fs.dir(), record)).rejects.toThrow(
      'Staged copy failed',
    );
    expect(fs.writes).toHaveLength(0);
  });
  it('leaves verification unchanged if permission is denied', async () => {
    const denied = {
      getDirectoryHandle: async () => {
        throw Object.assign(new Error('Permission denied'), {
          name: 'NotAllowedError',
        });
      },
    } as unknown as FileSystemDirectoryHandle;
    await expect(saveToFolder(denied, record)).rejects.toThrow(
      'Permission denied',
    );
    expect(record.scope).toBe('browser');
  });
  it('verifies reselected exports and rejects corruption', async () => {
    await expect(
      verifyExport(new File([new Uint8Array([1, 2, 4])], 'IMG.HEIC'), [record]),
    ).rejects.toThrow('failed integrity');
    expect(state.stored.size).toBe(0);
    expect(
      await verifyExport(
        new File([new Uint8Array([1, 2, 3])], 'renamed.HEIC'),
        [record],
      ),
    ).toBe(1);
    expect(state.stored.get(record.id)?.scope).toBe('exported');
  });
  it('pauses before quota exhaustion', async () => {
    navigator.storage.estimate = async () => ({ quota: 100, usage: 99 });
    await expect(capacity(10)).rejects.toThrow('Not enough browser storage');
  });
});

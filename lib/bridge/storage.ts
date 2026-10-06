import StorageWorker from './staging.worker?worker';
import { hashFile } from './hash';
import { collisionName, safePath, type RecordFile } from './model';
import { local } from './database';
export class StagingWriter {
  private worker = new StorageWorker();
  private seq = 0;
  private failed?: Error;
  private jobs = new Map<
    number,
    { resolve: () => void; reject: (e: Error) => void }
  >();
  constructor() {
    this.worker.onmessage = ({ data }) => {
      const j = this.jobs.get(data.id);
      if (!j) return;
      this.jobs.delete(data.id);
      if (data.error) j.reject(new Error(data.error));
      else j.resolve();
    };
    this.worker.onerror = () => {
      this.failed = new Error(
        'Browser storage worker failed. Reload to resume.',
      );
      for (const j of this.jobs.values()) j.reject(this.failed);
      this.jobs.clear();
    };
  }
  private call(
    action: string,
    extra: object = {},
    transfers: Transferable[] = [],
  ) {
    if (this.failed) return Promise.reject(this.failed);
    const id = ++this.seq;
    return new Promise<void>((resolve, reject) => {
      this.jobs.set(id, { resolve, reject });
      this.worker.postMessage({ id, action, ...extra }, transfers);
    });
  }
  open(fileId: string, offset: number) {
    return this.call('open', { fileId, offset });
  }
  write(offset: number, bytes: ArrayBuffer) {
    return this.call('write', { offset, bytes }, [bytes]);
  }
  close() {
    return this.call('close');
  }
  async dispose() {
    try {
      await this.close();
    } finally {
      this.worker.terminate();
    }
  }
}
export async function stagingDirectory() {
  return (await navigator.storage.getDirectory()).getDirectoryHandle(
    'pixelbridge',
    { create: true },
  );
}
export async function stagedFile(id: string) {
  return (await (await stagingDirectory()).getFileHandle(id)).getFile();
}
export async function removeStaged(id: string) {
  await (await stagingDirectory()).removeEntry(id).catch((e) => {
    if (e.name !== 'NotFoundError') throw e;
  });
}
export async function storedCopyValid(file: RecordFile) {
  try {
    const blob = await stagedFile(file.id);
    return blob.size === file.size && (await hashFile(blob)) === file.sha256;
  } catch {
    return false;
  }
}
export async function capacity(required: number) {
  const estimate = await navigator.storage.estimate();
  if (
    estimate.quota &&
    estimate.quota - (estimate.usage ?? 0) <
      required + Math.min(16 * 1024 * 1024, estimate.quota * 0.02)
  )
    throw new Error(
      'Not enough browser storage for this file. Save and clear a verified batch, then resume.',
    );
}
export async function existingDestination(
  root: FileSystemDirectoryHandle,
  record: RecordFile,
  preferredPath?: string,
): Promise<RecordFile | undefined> {
  const match = async (path: string) => {
    const parts = safePath(path).split('/');
    const name = parts.pop()!;
    let folder = root;
    try {
      for (const part of parts) folder = await folder.getDirectoryHandle(part);
      const file = await (await folder.getFileHandle(name)).getFile();
      return {
        present: true,
        matches:
          file.size === record.size && (await hashFile(file)) === record.sha256,
      };
    } catch (error) {
      if ((error as Error).name === 'NotFoundError')
        return { present: false, matches: false };
      throw error;
    }
  };
  const verified = (destinationPath: string): RecordFile => ({
    ...record,
    destinationPath,
    bytes: record.size,
    phase: 'duplicate',
    scope: 'destination',
    updated: Date.now(),
    error: undefined,
  });
  if (preferredPath && (await match(preferredPath)).matches)
    return verified(preferredPath);
  const parts = safePath(record.relativePath).split('/');
  const original = parts.pop()!;
  for (let n = 1; n <= 10000; n++) {
    const path = [...parts, collisionName(original, n)].join('/');
    const candidate = await match(path);
    if (candidate.matches) return verified(path);
    if (!candidate.present) return undefined;
  }
  return undefined;
}
export async function saveToFolder(
  root: FileSystemDirectoryHandle,
  record: RecordFile,
): Promise<RecordFile> {
  safePath(record.relativePath);
  const source = await stagedFile(record.id);
  if (source.size !== record.size || (await hashFile(source)) !== record.sha256)
    throw new Error(
      'Staged copy failed verification. Transfer this file again.',
    );
  const parts = record.relativePath.split('/');
  const original = parts.pop()!;
  let folder = root;
  for (const part of parts)
    folder = await folder.getDirectoryHandle(part, { create: true });
  for (let n = 1; n <= 10000; n++) {
    const name = collisionName(original, n);
    let existing: FileSystemFileHandle | undefined;
    try {
      existing = await folder.getFileHandle(name);
    } catch (e) {
      if ((e as Error).name !== 'NotFoundError') throw e;
    }
    const destinationPath = [...parts, name].join('/');
    if (existing) {
      const file = await existing.getFile();
      if (file.size === record.size && (await hashFile(file)) === record.sha256)
        return {
          ...record,
          destinationPath,
          phase: 'duplicate',
          scope: 'destination',
          updated: Date.now(),
          error: undefined,
        };
      continue;
    }
    const target = await folder.getFileHandle(name, { create: true });
    const writer = await target.createWritable();
    try {
      for (let offset = 0; offset < source.size; offset += 1024 * 1024)
        await writer.write(
          await source.slice(offset, offset + 1024 * 1024).arrayBuffer(),
        );
      await writer.close();
    } catch (error) {
      await writer.abort().catch(() => {});
      throw error;
    }
    const saved = await target.getFile();
    if (saved.size !== record.size || (await hashFile(saved)) !== record.sha256)
      throw new Error(
        'Saved destination failed verification. The staged copy is retained for retry.',
      );
    return {
      ...record,
      destinationPath,
      phase: 'verified',
      scope: 'destination',
      updated: Date.now(),
      error: undefined,
    };
  }
  throw new Error('Too many conflicting filenames. Choose another folder.');
}
export async function downloadStaged(record: RecordFile) {
  if (!(await storedCopyValid(record)))
    throw new Error('Staged copy is unavailable or failed verification.');
  const file = await stagedFile(record.id);
  const url = URL.createObjectURL(file);
  const link = document.createElement('a');
  link.href = url;
  link.download = record.originalName;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  await local.put({ ...record, downloaded: true, updated: Date.now() });
}
export async function verifyExport(file: File, records: RecordFile[]) {
  const candidates = records.filter(
    (r) => r.size === file.size && r.phase !== 'cancelled',
  );
  if (!candidates.length)
    throw new Error(`No transferred file matches ${file.name}.`);
  const sha = await hashFile(file);
  const matching = candidates.filter((r) => r.sha256 === sha);
  if (!matching.length)
    throw new Error(
      `${file.name}: exported copy failed integrity verification.`,
    );
  for (const record of matching)
    await local.put({
      ...record,
      scope: 'exported',
      phase: 'verified',
      updated: Date.now(),
      error: undefined,
    });
  return matching.length;
}

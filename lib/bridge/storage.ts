import StorageWorker from './staging.worker?worker';
import { hashFile } from './hash';
import {
  CHECKPOINT_BYTES,
  collisionName,
  isVerified,
  safePath,
  type RecordFile,
} from './model';
import { local } from './database';
import { indexedFile, removeIndexed } from './indexed-staging';
import { downloadType } from './save-options';

export type StagingBackend = 'opfs' | 'indexeddb';
let selectedBackend: StagingBackend | undefined;
function hasOpfs() {
  return typeof navigator.storage?.getDirectory === 'function';
}
function unavailableOpfs(error: unknown) {
  // Safari may expose OPFS but reject access in the current browser context.
  // Do not classify quota exhaustion or a busy/corrupt file as API absence.
  return ['NotSupportedError', 'UnknownError', 'SecurityError'].includes(
    (error as Error).name,
  );
}
export function stagingBackend(): StagingBackend {
  return selectedBackend ?? (hasOpfs() ? 'opfs' : 'indexeddb');
}

export class StagingWriter {
  private worker = new StorageWorker();
  private seq = 0;
  private failed?: Error;
  private preferredBackend: StagingBackend;
  private jobs = new Map<
    number,
    { resolve: () => void; reject: (e: Error) => void }
  >();
  constructor(private backend: StagingBackend = stagingBackend()) {
    this.preferredBackend = backend;
    this.worker.onmessage = ({ data }) => {
      const j = this.jobs.get(data.id);
      if (!j) return;
      this.jobs.delete(data.id);
      if (data.error)
        j.reject(
          Object.assign(new Error(data.error), {
            name: data.errorName || 'Error',
          }),
        );
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
      this.worker.postMessage(
        { id, action, backend: this.backend, ...extra },
        transfers,
      );
    });
  }
  async open(fileId: string, offset: number) {
    if (offset > 0) this.backend = (await locateStaged(fileId)).backend;
    else {
      this.backend = this.preferredBackend;
      if (this.backend === 'opfs') await removeIndexed(fileId);
      else if (hasOpfs()) await removeOpfs(fileId, true);
    }
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
  return (await locateStaged(id)).file;
}
async function opfsFile(id: string) {
  return (await (await stagingDirectory()).getFileHandle(id)).getFile();
}
async function locateStaged(id: string) {
  const preferred = stagingBackend();
  const modes: StagingBackend[] =
    preferred === 'opfs' ? ['opfs', 'indexeddb'] : ['indexeddb', 'opfs'];
  let opfsFailure: unknown;
  for (const backend of modes) {
    if (backend === 'opfs' && !hasOpfs()) continue;
    try {
      return {
        backend,
        file: await (backend === 'opfs' ? opfsFile(id) : indexedFile(id)),
      };
    } catch (error) {
      if (backend === 'opfs' && unavailableOpfs(error)) {
        opfsFailure = error;
        continue;
      }
      if (
        (error as Error).name !== 'NotFoundError' &&
        (error as Error).name !== 'NotSupportedError'
      )
        throw error;
    }
  }
  if (opfsFailure) throw opfsFailure;
  throw new DOMException('Staged file is missing.', 'NotFoundError');
}
async function removeOpfs(id: string, allowUnavailable = false) {
  try {
    await (await stagingDirectory()).removeEntry(id);
  } catch (error) {
    if (allowUnavailable && unavailableOpfs(error)) return;
    if (!['NotFoundError', 'NotSupportedError'].includes((error as Error).name))
      throw error;
  }
}
export async function removeStaged(id: string) {
  const removedIndexed = await removeIndexed(id);
  if (hasOpfs()) await removeOpfs(id, removedIndexed);
}
export async function prepareStaging(): Promise<StagingBackend> {
  const probe = `probe-${crypto.randomUUID()}`;
  const test = async (backend: StagingBackend) => {
    const writer = new StagingWriter(backend);
    let failure: unknown;
    try {
      await writer.open(probe, 0);
      const checkpoint = new Uint8Array(CHECKPOINT_BYTES);
      checkpoint[0] = 23;
      checkpoint[checkpoint.length - 1] = 90;
      await writer.write(0, checkpoint.buffer);
      await writer.close();
      const file =
        backend === 'opfs' ? await opfsFile(probe) : await indexedFile(probe);
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (
        bytes.length !== CHECKPOINT_BYTES ||
        bytes.some(
          (byte, i) =>
            byte !== (i === 0 ? 23 : i === bytes.length - 1 ? 90 : 0),
        )
      )
        throw new Error(
          'Local storage readback failed. Receiving cannot start.',
        );
    } catch (error) {
      failure = error;
    } finally {
      // Cleanup must not hide the original storage failure or prevent worker
      // disposal. A healthy probe also has to clean up successfully.
      try {
        await writer.dispose();
      } catch (error) {
        failure ??= error;
      }
      try {
        if (backend === 'indexeddb') await removeIndexed(probe);
        else await removeOpfs(probe);
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure) {
      if (backend === 'indexeddb') {
        const error = failure as Error;
        throw Object.assign(
          new Error(
            error.name === 'QuotaExceededError'
              ? 'Browser storage is full. Free device space or save and clear a verified batch, then retry.'
              : `Compatibility storage failed its write/read test. Try a regular (non-Private) browser tab, close other PixelGate tabs, and reload. Allow website storage and check device space. Existing staged files have not been cleared. (${error.name}: ${error.message})`,
          ),
          { name: error.name },
        );
      }
      throw failure;
    }
  };
  let backend = stagingBackend();
  try {
    await test(backend);
  } catch (error) {
    if (backend !== 'opfs' || !unavailableOpfs(error)) throw error;
    backend = 'indexeddb';
    await test(backend);
  }
  selectedBackend = backend;
  return backend;
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
  const estimate = await navigator.storage?.estimate?.();
  if (
    estimate?.quota &&
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
  offerPreparedDownload(
    new File([file], record.originalName, {
      type: downloadType(record.originalName, record.mimeType),
      lastModified: record.modified,
    }),
  );
  await local.put({ ...record, downloaded: true, updated: Date.now() });
}
export function offerPreparedDownload(file: File) {
  const url = URL.createObjectURL(file);
  const link = document.createElement('a');
  link.href = url;
  link.download = file.name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
// Prepare separately from the tap that opens the native share sheet. Hashing
// can outlive transient activation, especially on older phones and large files.
export async function prepareSharedFiles(
  records: RecordFile[],
): Promise<File[]> {
  if (!records.length || records.length > 20)
    throw new Error('Select between 1 and 20 files to save with another app.');
  const files: File[] = [];
  const names = new Set<string>();
  for (const record of records) {
    if (!isVerified(record))
      throw new Error('Only verified browser copies can be shared.');
    const name = safePath(record.relativePath).split('/').at(-1)!;
    let source: File;
    try {
      source = await stagedFile(record.id);
    } catch {
      throw new Error(
        `${name}: browser copy is unavailable. Receive this file again.`,
      );
    }
    if (
      source.size !== record.size ||
      (await hashFile(source)) !== record.sha256
    )
      throw new Error(
        `${name}: browser copy failed verification. Receive this file again.`,
      );
    let uniqueName = name;
    let suffix = 2;
    while (names.has(uniqueName)) uniqueName = collisionName(name, suffix++);
    names.add(uniqueName);
    files.push(
      new File([source], uniqueName, {
        type: downloadType(uniqueName, record.mimeType),
        lastModified: record.modified,
      }),
    );
  }
  return files;
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

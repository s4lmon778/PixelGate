import { CHECKPOINT_BYTES } from './model';

// Blob checkpoints stay in IndexedDB rather than accumulating byte arrays in
// the page. Kept separate from manifests so older records need no migration.
const DATABASE = 'pixelgate-staging-v1';
let opening: Promise<IDBDatabase> | undefined;
function db() {
  return (opening ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    let blocked = false;
    request.onupgradeneeded = () => {
      request.result.createObjectStore('files', { keyPath: 'id' });
      request.result.createObjectStore('chunks', {
        keyPath: ['fileId', 'offset'],
      });
    };
    request.onblocked = () => {
      blocked = true;
      opening = undefined;
      reject(new Error('Close older PixelGate tabs to open local storage.'));
    };
    request.onerror = () => {
      opening = undefined;
      reject(request.error);
    };
    request.onsuccess = () => {
      const result = request.result;
      if (blocked) {
        result.close();
        return;
      }
      result.onversionchange = () => {
        result.close();
        opening = undefined;
      };
      resolve(result);
    };
  }));
}
function checked(id: string, offset = 0) {
  if (!/^[a-zA-Z0-9-]{1,100}$/.test(id))
    throw new Error('Invalid staging identifier.');
  if (!Number.isSafeInteger(offset) || offset < 0)
    throw new Error('Invalid staging offset.');
}
function range(id: string) {
  return IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER]);
}
type Chunk = { fileId: string; offset: number; bytes: Blob };
function validChunk(chunk: Chunk, expected: number) {
  if (
    chunk.offset !== expected ||
    !(chunk.bytes instanceof Blob) ||
    chunk.bytes.size < 1 ||
    chunk.bytes.size > CHECKPOINT_BYTES
  )
    throw new Error(
      'Stored file has missing or invalid chunks. Retry this file.',
    );
}
function startTransaction(database: IDBDatabase, mode: IDBTransactionMode) {
  try {
    return database.transaction(
      ['files', 'chunks'],
      mode,
      mode === 'readwrite' ? { durability: 'strict' } : {},
    );
  } catch (error) {
    // Older engines may lack the optional durability argument.
    if (!(error instanceof TypeError)) throw error;
    return database.transaction(['files', 'chunks'], mode);
  }
}
async function transaction<T>(
  mode: IDBTransactionMode,
  run: (tx: IDBTransaction, result: (value: T) => void) => void,
): Promise<T> {
  const database = await db();
  return new Promise<T>((resolve, reject) => {
    const tx = startTransaction(database, mode);
    let value: T;
    let failure: unknown;
    tx.oncomplete = () => resolve(value);
    tx.onabort = () =>
      reject(failure ?? tx.error ?? new Error('Local storage write failed.'));
    tx.onerror = () => {
      /* Abort reports the original request failure. */
    };
    const guarded = () => {
      try {
        run(tx, (result) => {
          value = result;
        });
      } catch (error) {
        failure = error;
        tx.abort();
      }
    };
    // Request callbacks also need to preserve a useful error on abort.
    tx.addEventListener('error', () => {
      failure ??= tx.error;
    });
    guarded();
  });
}

// Catch errors inside callbacks: throwing from an IDB event would otherwise
// surface as an unrelated page error, rather than rejecting the transfer.
function callback(
  tx: IDBTransaction,
  run: () => void,
  fail: (error: unknown) => void,
) {
  return () => {
    try {
      run();
    } catch (error) {
      fail(error);
      tx.abort();
    }
  };
}

export async function openIndexed(id: string, offset: number) {
  checked(id, offset);
  // Resume reconciles the committed manifest offset, removing a byte tail that
  // was committed before the manifest transaction could finish.
  const database = await db();
  return new Promise<void>((resolve, reject) => {
    const tx = startTransaction(database, 'readwrite');
    let error: unknown;
    tx.oncomplete = () => resolve();
    tx.onabort = () =>
      reject(error ?? tx.error ?? new Error('Unable to open stored file.'));
    const fail = (value: unknown) => {
      error = value;
    };
    const files = tx.objectStore('files');
    const request = files.get(id);
    request.onsuccess = callback(
      tx,
      () => {
        if ((request.result?.size ?? 0) < offset)
          throw new Error('Partial file is missing bytes. Restart this file.');
        let expected = 0;
        const cursor = tx.objectStore('chunks').openCursor(range(id));
        cursor.onsuccess = callback(
          tx,
          () => {
            const item = cursor.result;
            if (!item) {
              if (expected !== offset)
                throw new Error(
                  'Partial file is missing bytes. Restart this file.',
                );
              files.put({ id, size: offset });
              return;
            }
            const chunk = item.value as Chunk;
            if (chunk.offset >= offset) item.delete();
            else {
              validChunk(chunk, expected);
              const end = Math.min(offset, chunk.offset + chunk.bytes.size);
              if (end < chunk.offset + chunk.bytes.size)
                item.update({
                  ...chunk,
                  bytes: chunk.bytes.slice(0, end - chunk.offset),
                });
              expected = end;
            }
            item.continue();
          },
          fail,
        );
      },
      fail,
    );
  });
}

export async function writeIndexed(
  id: string,
  offset: number,
  bytes: ArrayBuffer,
) {
  checked(id, offset);
  if (
    bytes.byteLength < 1 ||
    bytes.byteLength > CHECKPOINT_BYTES ||
    !Number.isSafeInteger(offset + bytes.byteLength)
  )
    throw new Error('Invalid staging checkpoint.');
  // Bytes and length commit atomically; acknowledgment waits for completion.
  const database = await db();
  return new Promise<void>((resolve, reject) => {
    const tx = startTransaction(database, 'readwrite');
    let error: unknown;
    tx.oncomplete = () => resolve();
    tx.onabort = () =>
      reject(error ?? tx.error ?? new Error('Unable to write stored file.'));
    const files = tx.objectStore('files');
    const request = files.get(id);
    request.onsuccess = callback(
      tx,
      () => {
        if (!request.result || request.result.size !== offset)
          throw new Error('Stored offset changed. Reconnect to resume.');
        tx.objectStore('chunks').put({
          fileId: id,
          offset,
          bytes: new Blob([bytes]),
        });
        files.put({ id, size: offset + bytes.byteLength });
      },
      (value) => {
        error = value;
      },
    );
  });
}

export async function indexedFile(id: string): Promise<File> {
  checked(id);
  const database = await db();
  return new Promise<File>((resolve, reject) => {
    const tx = startTransaction(database, 'readonly');
    let error: unknown;
    let file: File;
    tx.oncomplete = () => resolve(file);
    tx.onabort = () =>
      reject(error ?? tx.error ?? new Error('Unable to read stored file.'));
    const request = tx.objectStore('files').get(id);
    const fail = (value: unknown) => {
      error = value;
    };
    request.onsuccess = callback(
      tx,
      () => {
        if (!request.result)
          throw new DOMException('Stored file is missing.', 'NotFoundError');
        const size = request.result.size;
        if (!Number.isSafeInteger(size) || size < 0)
          throw new Error('Invalid stored file size.');
        const parts: Blob[] = [];
        let expected = 0;
        const cursor = tx.objectStore('chunks').openCursor(range(id));
        cursor.onsuccess = callback(
          tx,
          () => {
            const item = cursor.result;
            if (!item) {
              if (expected !== size)
                throw new Error(
                  'Stored file has missing bytes. Retry this file.',
                );
              // Construct from stored Blobs, not a file-sized ArrayBuffer. Hashing
              // still reads 1 MiB slices in the dedicated hash worker.
              file = new File(parts, id);
              return;
            }
            const chunk = item.value as Chunk;
            validChunk(chunk, expected);
            expected += chunk.bytes.size;
            if (expected > size)
              throw new Error(
                'Stored file has unexpected bytes. Retry this file.',
              );
            parts.push(chunk.bytes);
            item.continue();
          },
          fail,
        );
      },
      fail,
    );
  });
}

export async function removeIndexed(id: string) {
  checked(id);
  await transaction<void>('readwrite', (tx, result) => {
    tx.objectStore('chunks').delete(range(id));
    tx.objectStore('files').delete(id);
    result(undefined);
  });
}

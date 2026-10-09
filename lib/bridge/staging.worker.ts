import { openIndexed, writeIndexed } from './indexed-staging';

interface Access {
  write(data: Uint8Array, opts: { at: number }): number;
  flush(): void | Promise<void>;
  close(): void | Promise<void>;
  truncate(n: number): void | Promise<void>;
  getSize(): number | Promise<number>;
}
let handle: Access | undefined;
let indexedId: string | undefined;
let chain = Promise.resolve();
self.onmessage = ({ data }) => {
  chain = chain.then(async () => {
    try {
      if (data.action === 'open') {
        await handle?.close();
        handle = undefined;
        indexedId = undefined;
        if (data.backend === 'indexeddb') {
          await openIndexed(data.fileId, data.offset);
          indexedId = data.fileId;
        } else {
          if (!navigator.storage?.getDirectory)
            throw new DOMException(
              'File storage is unavailable.',
              'NotSupportedError',
            );
          const root = await navigator.storage.getDirectory();
          const dir = await root.getDirectoryHandle('pixelbridge', {
            create: true,
          });
          const file = await dir.getFileHandle(data.fileId, { create: true });
          if (
            typeof (file as unknown as { createSyncAccessHandle?: unknown })
              .createSyncAccessHandle !== 'function'
          )
            throw new DOMException(
              'Synchronous file storage is unavailable.',
              'NotSupportedError',
            );
          handle = await (
            file as unknown as { createSyncAccessHandle(): Promise<Access> }
          ).createSyncAccessHandle();
          if ((await handle.getSize()) < data.offset)
            throw new Error(
              'Partial file is missing bytes. Restart this file.',
            );
          await handle.truncate(data.offset);
          await handle.flush();
        }
      } else if (data.action === 'write') {
        if (indexedId) {
          await writeIndexed(indexedId, data.offset, data.bytes);
        } else {
          if (!handle) throw new Error('No staging file open.');
          const bytes = new Uint8Array(data.bytes);
          let written = 0;
          while (written < bytes.length) {
            const n = handle.write(bytes.subarray(written), {
              at: data.offset + written,
            });
            if (
              !Number.isSafeInteger(n) ||
              n <= 0 ||
              n > bytes.length - written
            )
              throw new Error(
                'Browser storage rejected this checkpoint. Save and clear verified files, or retry in a regular browser tab.',
              );
            written += n;
          }
          await handle.flush();
          if ((await handle.getSize()) !== data.offset + bytes.length)
            throw new Error(
              'Browser storage did not retain the complete checkpoint. Retry in a regular browser tab.',
            );
        }
      } else if (data.action === 'close') {
        await handle?.flush();
        await handle?.close();
        handle = undefined;
        indexedId = undefined;
      }
      self.postMessage({ id: data.id, ok: true });
    } catch (error) {
      try {
        await handle?.close();
      } catch {}
      handle = undefined;
      indexedId = undefined;
      const e = error as Error;
      self.postMessage({
        id: data.id,
        errorName: e.name,
        error:
          e.name === 'QuotaExceededError'
            ? 'Browser storage is full. Save and clear a verified batch, then resume.'
            : e.message,
      });
    }
  });
};

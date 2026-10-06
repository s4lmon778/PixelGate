interface Access {
  write(data: Uint8Array, opts: { at: number }): number;
  flush(): void;
  close(): void;
  truncate(n: number): void;
  getSize(): number;
}
let handle: Access | undefined;
let chain = Promise.resolve();
self.onmessage = ({ data }) => {
  chain = chain.then(async () => {
    try {
      if (data.action === 'open') {
        handle?.close();
        handle = undefined;
        const root = await navigator.storage.getDirectory();
        const dir = await root.getDirectoryHandle('pixelbridge', {
          create: true,
        });
        const file = await dir.getFileHandle(data.fileId, { create: true });
        handle = await (
          file as unknown as { createSyncAccessHandle(): Promise<Access> }
        ).createSyncAccessHandle();
        if (handle.getSize() < data.offset)
          throw new Error('Partial file is missing bytes. Restart this file.');
        handle.truncate(data.offset);
        handle.flush();
      } else if (data.action === 'write') {
        if (!handle) throw new Error('No staging file open.');
        const bytes = new Uint8Array(data.bytes);
        let written = 0;
        while (written < bytes.length) {
          const n = handle.write(bytes.subarray(written), {
            at: data.offset + written,
          });
          if (!n) throw new Error('Storage write stopped.');
          written += n;
        }
        handle.flush();
      } else if (data.action === 'close') {
        handle?.flush();
        handle?.close();
        handle = undefined;
      }
      self.postMessage({ id: data.id, ok: true });
    } catch (error) {
      try {
        handle?.close();
      } catch {}
      handle = undefined;
      const e = error as Error;
      self.postMessage({
        id: data.id,
        error:
          e.name === 'QuotaExceededError'
            ? 'Browser storage is full. Save and clear a verified batch, then resume.'
            : e.message,
      });
    }
  });
};

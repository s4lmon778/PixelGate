import { createSHA256 } from 'hash-wasm';
self.onmessage = async (event: MessageEvent<{ id: number; file: Blob }>) => {
  const { id, file } = event.data;
  try {
    const hash = await createSHA256();
    hash.init();
    for (let offset = 0; offset < file.size; offset += 1024 * 1024) {
      hash.update(
        new Uint8Array(
          await file.slice(offset, offset + 1024 * 1024).arrayBuffer(),
        ),
      );
      self.postMessage({
        id,
        progress: Math.min(file.size, offset + 1024 * 1024),
      });
    }
    self.postMessage({ id, hash: hash.digest('hex') });
  } catch {
    self.postMessage({
      id,
      error: 'Unable to read or hash this file. Reselect it and try again.',
    });
  }
};

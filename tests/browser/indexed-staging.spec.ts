import { test, expect } from '@playwright/test';
import { readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';

const workerAsset = readdirSync('dist/assets').find((name) =>
  name.startsWith('staging.worker-'),
)!;

test('strict multi-checkpoint commits roll back atomically and resume across refresh', async ({
  page,
}) => {
  await page.goto('./');
  const workerURL = new URL(`assets/${workerAsset}`, page.url()).href;
  await page.route(workerURL, async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      body:
        `
      const put = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function(value, ...args) {
        if (this.name === 'chunks' && (value.bytes?.size ?? value.bytes?.byteLength) === 7)
          throw new DOMException('Injected quota failure inside batch', 'QuotaExceededError');
        return Reflect.apply(put, this, [value, ...args]);
      };
    ` + (await response.text()),
    });
  });
  const result = await page.evaluate(async (url) => {
    const worker = new Worker(url);
    let sequence = 0;
    const call = (action: string, extra: object = {}) =>
      new Promise<{ error?: string }>((resolve) => {
        worker.onmessage = ({ data }) => resolve(data);
        worker.postMessage({
          id: ++sequence,
          action,
          backend: 'indexeddb',
          ...extra,
        });
      });
    const id = 'b'.repeat(64),
      checkpoint = 1024 * 1024;
    await call('open', { fileId: id, offset: 0 });
    await call('write', {
      offset: 0,
      bytes: new Uint8Array(checkpoint).fill(11).buffer,
    });
    const rejected = await call('write-batch', {
      offset: checkpoint,
      blocks: [
        new Uint8Array(checkpoint).fill(22).buffer,
        new Uint8Array(7).buffer,
      ],
    });
    const opened = indexedDB.open('pixelgate-staging-v1', 1);
    const db = await new Promise<IDBDatabase>((resolve) => {
      opened.onsuccess = () => resolve(opened.result);
    });
    const length = await new Promise<number>((resolve) => {
      const r = db.transaction('files').objectStore('files').get(id);
      r.onsuccess = () => resolve(r.result.size);
    });
    const chunks = await new Promise<number>((resolve) => {
      const r = db
        .transaction('chunks')
        .objectStore('chunks')
        .count(IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER]));
      r.onsuccess = () => resolve(r.result);
    });
    await call('open', { fileId: id, offset: checkpoint });
    const committed = await call('write-batch', {
      offset: checkpoint,
      blocks: [
        new Uint8Array(checkpoint).fill(22).buffer,
        new Uint8Array(checkpoint).fill(33).buffer,
        new Uint8Array(23).fill(44).buffer,
      ],
    });
    await call('close');
    db.close();
    worker.terminate();
    return { rejected, length, chunks, committed };
  }, workerURL);
  expect(result.rejected.error).toContain('storage is full');
  expect(result.length).toBe(1024 * 1024);
  expect(result.chunks).toBe(1);
  expect(result.committed.error).toBeUndefined();
  await page.reload();
  const resumed = await page.evaluate(async (url) => {
    const worker = new Worker(url);
    await new Promise<void>((resolve) => {
      worker.onmessage = ({ data }) => {
        if (data.error) throw new Error(data.error);
        resolve();
      };
      worker.postMessage({
        id: 1,
        action: 'open',
        backend: 'indexeddb',
        fileId: 'b'.repeat(64),
        offset: 3 * 1024 * 1024,
      });
    });
    worker.terminate();
    const db = await new Promise<IDBDatabase>((resolve) => {
      const r = indexedDB.open('pixelgate-staging-v1', 1);
      r.onsuccess = () => resolve(r.result);
    });
    const blocks = await new Promise<{ bytes: Blob | ArrayBuffer }[]>(
      (resolve) => {
        const r = db
          .transaction('chunks')
          .objectStore('chunks')
          .getAll(
            IDBKeyRange.bound(
              ['b'.repeat(64), 0],
              ['b'.repeat(64), Number.MAX_SAFE_INTEGER],
            ),
          );
        r.onsuccess = () => resolve(r.result);
      },
    );
    db.close();
    return Promise.all(
      blocks.map(async (block) => {
        const bytes = new Uint8Array(
          await new Blob([block.bytes]).arrayBuffer(),
        );
        return {
          length: bytes.length,
          marker: bytes[0],
          intact: bytes.every((byte) => byte === bytes[0]),
        };
      }),
    );
  }, workerURL);
  expect(resumed).toEqual(
    [11, 22, 33].map((marker) => ({
      length: 1024 * 1024,
      marker,
      intact: true,
    })),
  );
});

test('compatibility checkpoints survive refresh, reconcile tails, reject gaps, and roll back quota failures', async ({
  page,
}) => {
  await page.goto('./');
  const workerURL = new URL(`assets/${workerAsset}`, page.url()).href;
  // Inject quota failure into this isolated worker's chunk transaction only.
  // The application's ordinary storage mode and browser settings are untouched.
  await page.route(workerURL, async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      body:
        `
      const originalPut = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function(value, ...args) {
        if (this.name === 'chunks' && (value.bytes?.size ?? value.bytes?.byteLength) === 7)
          throw new DOMException('Injected quota exhaustion', 'QuotaExceededError');
        return Reflect.apply(originalPut, this, [value, ...args]);
      };
    ` + (await response.text()),
    });
  });
  const first = await page.evaluate(async (url) => {
    const worker = new Worker(url);
    let seq = 0;
    const call = (action: string, extra: object = {}) =>
      new Promise<{ error?: string }>((resolve) => {
        const id = ++seq;
        worker.onmessage = ({ data }) => resolve(data);
        worker.postMessage({ id, action, backend: 'indexeddb', ...extra });
      });
    const opened = await call('open', { fileId: 'a'.repeat(64), offset: 0 });
    const written = await call('write', {
      offset: 0,
      bytes: new Uint8Array(1024 * 1024).fill(0x7b).buffer,
    });
    const tail = await call('write', {
      offset: 1024 * 1024,
      bytes: new Uint8Array(17).fill(0x99).buffer,
    });
    await call('close');
    worker.terminate();
    return { opened, written, tail };
  }, workerURL);
  expect(first.opened.error).toBeUndefined();
  expect(first.written.error).toBeUndefined();
  expect(first.tail.error).toBeUndefined();
  await page.reload();
  const result = await page.evaluate(async (url) => {
    const worker = new Worker(url);
    let seq = 0;
    const call = (action: string, extra: object = {}) =>
      new Promise<{ error?: string; errorName?: string }>((resolve) => {
        const id = ++seq;
        worker.onmessage = ({ data }) => resolve(data);
        worker.postMessage({ id, action, backend: 'indexeddb', ...extra });
      });
    const id = 'a'.repeat(64);
    const opened = await call('open', { fileId: id, offset: 1024 * 1024 });
    const quota = await call('write', {
      offset: 1024 * 1024,
      bytes: new Uint8Array(7).buffer,
    });
    const database = await new Promise<IDBDatabase>((resolve) => {
      const request = indexedDB.open('pixelgate-staging-v1', 1);
      request.onsuccess = () => resolve(request.result);
    });
    const size = await new Promise<number>((resolve) => {
      const request = database
        .transaction('files')
        .objectStore('files')
        .get(id);
      request.onsuccess = () => resolve(request.result.size);
    });
    const reopened = await call('open', { fileId: id, offset: 1024 * 1024 });
    const written = await call('write', {
      offset: 1024 * 1024,
      bytes: new Uint8Array(37).fill(0x7b).buffer,
    });
    await call('close');
    const chunks = await new Promise<{ offset: number; bytes: Blob }[]>(
      (resolve) => {
        const request = database
          .transaction('chunks')
          .objectStore('chunks')
          .getAll();
        request.onsuccess = () => resolve(request.result);
      },
    );
    const bytes = await new Blob(
      chunks.map((chunk) => chunk.bytes),
    ).arrayBuffer();
    const sha = [
      ...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
    ]
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    // A corrupt/missing retained chunk cannot be accepted as a resume prefix.
    await new Promise<void>((resolve) => {
      const tx = database.transaction('chunks', 'readwrite');
      tx.objectStore('chunks').delete([id, 0]);
      tx.oncomplete = () => resolve();
    });
    const missing = await call('open', { fileId: id, offset: 1024 * 1024 });
    database.close();
    worker.terminate();
    return {
      opened,
      quota,
      size,
      reopened,
      written,
      sha,
      bytes: bytes.byteLength,
      missing,
    };
  }, workerURL);
  expect(result.opened.error).toBeUndefined();
  expect(result.quota.errorName).toBe('QuotaExceededError');
  expect(result.quota.error).toContain('Browser storage is full');
  expect(result.size).toBe(1024 * 1024);
  expect(result.reopened.error).toBeUndefined();
  expect(result.written.error).toBeUndefined();
  expect(result.bytes).toBe(1024 * 1024 + 37);
  expect(result.sha).toBe(
    createHash('sha256')
      .update(Buffer.alloc(1024 * 1024 + 37, 0x7b))
      .digest('hex'),
  );
  expect(result.missing.error).toContain('missing bytes');
});

test('unavailable compatibility storage blocks receiving before pairing', async ({
  page,
  browserName,
}) => {
  test.skip(
    browserName !== 'webkit',
    'Exercise explicit permission denial in the WebKit receiver context.',
  );
  await page.addInitScript(() => {
    Object.defineProperty(
      Object.getPrototypeOf(navigator.storage),
      'getDirectory',
      {
        value: undefined,
      },
    );
  });
  await page.route(`**/assets/${workerAsset}`, async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      body:
        `
      const originalPut = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function(value, ...args) {
        if (this.name === 'chunks') throw new DOMException('Storage denied', 'SecurityError');
        return Reflect.apply(originalPut, this, [value, ...args]);
      };
    ` + (await response.text()),
    });
  });
  await page.goto('./');
  expect(await page.evaluate(() => typeof navigator.storage.getDirectory)).toBe(
    'undefined',
  );
  await page
    .getByRole('button', { name: 'Receive files', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Create a connection', exact: true })
    .click();
  await expect(page.getByRole('alert')).toContainText(
    'Compatibility storage failed its write/read test',
  );
  await expect(page.getByLabel('Pairing code', { exact: true })).toHaveCount(0);
});

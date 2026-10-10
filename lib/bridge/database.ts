import type { RecordFile, Session } from './model';
let opening: Promise<IDBDatabase> | undefined;
function db() {
  return (opening ??= new Promise<IDBDatabase>((resolve, reject) => {
    const r = indexedDB.open('pixelbridge-v1', 3);
    r.onupgradeneeded = () => {
      if (!r.result.objectStoreNames.contains('files'))
        r.result.createObjectStore('files', { keyPath: 'id' });
      if (!r.result.objectStoreNames.contains('sentFiles'))
        r.result.createObjectStore('sentFiles', { keyPath: 'id' });
      const history = r.result.createObjectStore('history', {
        keyPath: 'historyKey',
      });
      // Retain existing local records when upgrading earlier preview databases.
      for (const storeName of ['files', 'sentFiles']) {
        const cursor = r.transaction!.objectStore(storeName).openCursor();
        cursor.onsuccess = () => {
          const item = cursor.result;
          if (!item) return;
          const f = item.value as RecordFile;
          const role = storeName === 'files' ? 'receive' : 'send';
          history.put({
            ...f,
            localRole: role,
            historyKey: `${role}:${f.sessionId}:${f.id}`,
          });
          item.continue();
        };
      }
      if (!r.result.objectStoreNames.contains('sessions'))
        r.result.createObjectStore('sessions', { keyPath: 'id' });
      if (!r.result.objectStoreNames.contains('settings'))
        r.result.createObjectStore('settings');
    };
    r.onblocked = () =>
      reject(
        new Error(
          'Close older PixelGate tabs and reload to upgrade local storage.',
        ),
      );
    r.onsuccess = () => {
      r.result.onversionchange = () => r.result.close();
      resolve(r.result);
    };
    r.onerror = () => reject(r.error);
  }));
}
async function operation<T>(
  store: string,
  mode: IDBTransactionMode,
  run: (s: IDBObjectStore) => IDBRequest<T>,
) {
  const d = await db();
  return new Promise<T>((resolve, reject) => {
    const tx = d.transaction(store, mode);
    const request = run(tx.objectStore(store));
    tx.oncomplete = () => resolve(request.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () =>
      reject(tx.error ?? new Error('Local storage transaction failed.'));
  });
}
async function save(file: RecordFile, role: 'send' | 'receive') {
  const d = await db();
  const value = { ...file, localRole: role };
  return new Promise<void>((resolve, reject) => {
    const tx = d.transaction(
      [role === 'send' ? 'sentFiles' : 'files', 'history'],
      'readwrite',
    );
    const timer = setTimeout(() => {
      reject(
        new Error(
          'Checkpoint storage stopped responding. Reload and reconnect to resume from the last saved checkpoint.',
        ),
      );
      try {
        tx.abort();
      } catch {
        /* A commit already in progress cannot be aborted. */
      }
    }, 60000);
    tx.oncomplete = () => {
      clearTimeout(timer);
      resolve();
    };
    tx.onerror = () => {
      clearTimeout(timer);
      reject(tx.error);
    };
    tx.onabort = () => {
      clearTimeout(timer);
      reject(tx.error ?? new Error('Local history write failed.'));
    };
    try {
      tx.objectStore(role === 'send' ? 'sentFiles' : 'files').put(value);
      tx.objectStore('history').put({
        ...value,
        historyKey: `${role}:${file.sessionId}:${file.id}`,
      });
    } catch (error) {
      clearTimeout(timer);
      reject(error);
      try {
        tx.abort();
      } catch {
        /* Already aborted or committing. */
      }
    }
  });
}
export const local = {
  files: () =>
    operation<RecordFile[]>('history', 'readonly', (s) => s.getAll()),
  receivedFiles: () =>
    operation<RecordFile[]>('files', 'readonly', (s) => s.getAll()),
  putSender: (file: RecordFile) => save(file, 'send'),
  get: (id: string) =>
    operation<RecordFile | undefined>('files', 'readonly', (s) => s.get(id)),
  put: (file: RecordFile) => save(file, 'receive'),
  remove: (id: string) => operation('files', 'readwrite', (s) => s.delete(id)),
  clearHistory: async (sessionId?: string) => {
    const d = await db();
    return new Promise<void>((resolve, reject) => {
      const tx = d.transaction('history', 'readwrite');
      const store = tx.objectStore('history');
      if (!sessionId) store.clear();
      else {
        const request = store.openCursor();
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) return;
          if ((cursor.value as RecordFile).sessionId === sessionId)
            cursor.delete();
          cursor.continue();
        };
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () =>
        reject(tx.error ?? new Error('Unable to clear transfer history.'));
    });
  },
  sessions: () =>
    operation<Session[]>('sessions', 'readonly', (s) => s.getAll()),
  session: (value: Session) =>
    operation('sessions', 'readwrite', (s) => s.put(value)),
  setting: <T>(key: string) =>
    operation<T | undefined>('settings', 'readonly', (s) => s.get(key)),
  set: (key: string, value: unknown) =>
    operation('settings', 'readwrite', (s) => s.put(value, key)),
};

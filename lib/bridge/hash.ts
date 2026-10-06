import HashWorker from './hash.worker?worker';
let worker: Worker | undefined;
let nextId = 0;
const jobs = new Map<
  number,
  {
    resolve: (s: string) => void;
    reject: (e: Error) => void;
    progress?: (n: number) => void;
  }
>();
export function hashFile(
  file: Blob,
  progress?: (n: number) => void,
): Promise<string> {
  if (!worker) {
    worker = new HashWorker();
    worker.onmessage = ({ data }) => {
      const job = jobs.get(data.id);
      if (!job) return;
      if (data.hash) {
        jobs.delete(data.id);
        job.resolve(data.hash);
      } else if (data.error) {
        jobs.delete(data.id);
        job.reject(new Error(data.error));
      } else job.progress?.(data.progress);
    };
    worker.onerror = () => {
      for (const job of jobs.values())
        job.reject(new Error('Hash worker unavailable. Reload and try again.'));
      jobs.clear();
      worker?.terminate();
      worker = undefined;
    };
  }
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    jobs.set(id, { resolve, reject, progress });
    worker!.postMessage({ id, file });
  });
}
export async function identity(sha256: string, path: string) {
  const hash = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`${sha256}\n${path}`),
  );
  return [...new Uint8Array(hash)]
    .map((x) => x.toString(16).padStart(2, '0'))
    .join('');
}

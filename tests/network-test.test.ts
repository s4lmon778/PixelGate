import { afterEach, describe, expect, it, vi } from 'vitest';
import { testInternetDownload } from '../lib/bridge/network-test';

afterEach(() => vi.unstubAllGlobals());
describe('bounded manual internet download', () => {
  it('streams only the expected dummy bytes without credentials/referrer and returns measured units', async () => {
    const requests: { url: string; options: RequestInit }[] = [];
    vi.stubGlobal('fetch', async (url: string, options: RequestInit) => {
      requests.push({ url, options });
      const size = Number(new URL(url).searchParams.get('bytes'));
      let remaining = size;
      return new Response(
        new ReadableStream({
          pull(controller) {
            if (!remaining) {
              controller.close();
              return;
            }
            const n = Math.min(65536, remaining);
            remaining -= n;
            controller.enqueue(new Uint8Array(n));
          },
        }),
      );
    });
    const progress: number[] = [];
    const result = await testInternetDownload(
      new AbortController().signal,
      (bytes) => progress.push(bytes),
    );
    expect(result.bytes).toBe(8 * 1048576);
    expect(requests).toHaveLength(3);
    for (const request of requests) {
      expect(new URL(request.url).origin).toBe('https://speed.cloudflare.com');
      expect(request.options).toMatchObject({
        cache: 'no-store',
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        redirect: 'error',
      });
    }
    expect(progress.at(-1)).toBe(result.bytes);
    expect(result.bytesPerSecond).toBeGreaterThan(0);
  });
  it('does not record a truncated or oversized provider response', async () => {
    vi.stubGlobal('fetch', async () => new Response(new Uint8Array([1])));
    await expect(
      testInternetDownload(new AbortController().signal, () => {}),
    ).rejects.toThrow('incomplete');
    vi.stubGlobal('fetch', async () => new Response(new Uint8Array(300000)));
    await expect(
      testInternetDownload(new AbortController().signal, () => {}),
    ).rejects.toThrow('Unexpected');
  });
  it('propagates cancellation and never records a partial result', async () => {
    const controller = new AbortController();
    vi.stubGlobal('fetch', async (_url: string, options: RequestInit) => {
      controller.abort();
      expect(options.signal?.aborted).toBe(true);
      throw new DOMException('Cancelled', 'AbortError');
    });
    await expect(
      testInternetDownload(controller.signal, () => {}),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});

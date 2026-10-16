export type InternetResult = {
  provider: 'Cloudflare';
  measuredAt: string;
  bytes: number;
  milliseconds: number;
  bytesPerSecond: number;
};
export function browserNetwork() {
  const network = (
    navigator as Navigator & {
      connection?: {
        type?: string;
        downlink?: number;
        rtt?: number;
        saveData?: boolean;
      };
    }
  ).connection;
  const types = [
    'wifi',
    'ethernet',
    'cellular',
    'bluetooth',
    'other',
    'unknown',
    'none',
    'wimax',
  ];
  return {
    online: navigator.onLine,
    ...(network && types.includes(network.type ?? '')
      ? { type: network.type }
      : {}),
    ...(Number.isFinite(network?.downlink) &&
    network!.downlink! > 0 &&
    network!.downlink! <= 1000000
      ? { estimatedDownlinkMbps: network!.downlink }
      : {}),
    ...(typeof network?.saveData === 'boolean'
      ? { saveData: network.saveData }
      : {}),
  };
}

/** Only dummy downloads, on an explicit tap. No SDK telemetry or file uploads. */
export async function testInternetDownload(
  signal: AbortSignal,
  progress: (bytes: number) => void,
): Promise<InternetResult> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) controller.abort();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, 15000);
  let bytes = 0;
  let lastProgress = 0;
  async function read(size: number, measured: boolean) {
    const response = await fetch(
      `https://speed.cloudflare.com/__down?bytes=${size}&speedgate=${crypto.randomUUID()}`,
      {
        signal: controller.signal,
        cache: 'no-store',
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        redirect: 'error',
      },
    );
    if (!response.ok || !response.body)
      throw new Error(
        'Internet speed test unavailable. The provider or this network may block it.',
      );
    const reader = response.body.getReader();
    let received = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (received > size)
          throw new Error('Unexpected speed-test response size.');
        if (measured) {
          bytes += value.byteLength;
          if (performance.now() - lastProgress > 250) {
            lastProgress = performance.now();
            progress(bytes);
          }
        }
      }
      if (received !== size)
        throw new Error('Internet speed-test download was incomplete.');
    } finally {
      await reader.cancel().catch(() => {});
    }
  }
  try {
    await read(256 * 1024, false);
    const start = performance.now();
    await Promise.all([
      read(4 * 1024 * 1024, true),
      read(4 * 1024 * 1024, true),
    ]);
    if (controller.signal.aborted)
      throw new DOMException('Cancelled', 'AbortError');
    const milliseconds = Math.max(1, performance.now() - start);
    progress(bytes);
    return {
      provider: 'Cloudflare',
      measuredAt: new Date().toISOString(),
      bytes,
      milliseconds: Math.round(milliseconds),
      bytesPerSecond: Math.round((bytes * 1000) / milliseconds),
    };
  } catch (error) {
    if (timedOut)
      throw new Error(
        'Internet speed test exceeded 15 seconds; no complete speed result was recorded.',
      );
    throw error;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
    controller.abort();
  }
}

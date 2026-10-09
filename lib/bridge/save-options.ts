// Launch only the current HTTPS app page, never a staged-file or blob URL.
// A different browser may have separate local storage, so files are not passed.
export function androidChromeLink(
  pageUrl: string,
  userAgent: string,
  version: string,
): string | undefined {
  if (!/Android/i.test(userAgent)) return;
  try {
    const url = new URL(pageUrl);
    if (url.protocol !== 'https:') return;
    url.hash = '';
    url.search = '';
    url.searchParams.set('v', version);
    return `intent://${url.host}${url.pathname}${url.search}#Intent;scheme=https;package=com.android.chrome;S.browser_fallback_url=${encodeURIComponent(url.href)};end`;
  } catch {
    return;
  }
}

const types: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  heic: 'image/heic',
  heif: 'image/heif',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  bmp: 'image/bmp',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  m4v: 'video/mp4',
  webm: 'video/webm',
  '3gp': 'video/3gpp',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  wav: 'audio/wav',
  pdf: 'application/pdf',
  txt: 'text/plain',
};
export function downloadType(name: string, supplied: string): string {
  const normalized = supplied.toLowerCase();
  if (
    normalized !== 'application/octet-stream' &&
    /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(normalized)
  )
    return normalized;
  return (
    types[name.split('.').at(-1)!.toLowerCase()] || 'application/octet-stream'
  );
}

// Chromium's native sharing implementation accepts at most ten files. On
// Android each BlobReceiver also rejects files larger than 50 MiB, even when
// canShare reports true. These limits apply to sharing, not file selection or
// verified downloads. Keep large originals intact and offer downloads instead.
export const SHARE_BATCH_FILES = 10;
export const DOWNLOAD_BATCH_FILES = 50;
export const ANDROID_SHARE_FILE_BYTES = 50 * 1024 * 1024;
export function nativeShareBatch(
  files: File[],
  userAgent: string,
  canShare?: (data: ShareData) => boolean,
): File[] {
  const accepts = (files: File[]) => {
    try {
      return canShare ? canShare({ files }) : true;
    } catch {
      return false;
    }
  };
  const batch = files
    .filter(
      (file) =>
        (!/Android/i.test(userAgent) ||
          file.size <= ANDROID_SHARE_FILE_BYTES) &&
        accepts([file]),
    )
    .slice(0, SHARE_BATCH_FILES);
  // A device can impose a smaller combined payload limit. Reduce the batch
  // without dropping files from the user's selection or download queue.
  while (batch.length && !accepts(batch)) batch.pop();
  return batch;
}

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

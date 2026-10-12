export type DeviceKind = 'phone' | 'tablet' | 'computer';

// Send only a broad device class to the connected peer, never its user agent.
export function deviceKind(
  userAgent = typeof navigator === 'undefined' ? '' : navigator.userAgent,
  touchPoints = typeof navigator === 'undefined' ? 0 : navigator.maxTouchPoints,
): DeviceKind {
  if (
    /iPad/i.test(userAgent) ||
    (/Macintosh/i.test(userAgent) && touchPoints > 1)
  )
    return 'tablet';
  if (/Android/i.test(userAgent))
    return /Mobile/i.test(userAgent) ? 'phone' : 'tablet';
  return /iPhone|iPod|Windows Phone/i.test(userAgent) ? 'phone' : 'computer';
}

export function peerDevice(value: unknown): DeviceKind | undefined {
  return value === 'phone' || value === 'tablet' || value === 'computer'
    ? value
    : undefined;
}

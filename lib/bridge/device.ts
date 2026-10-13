export type DeviceKind = 'phone' | 'tablet' | 'computer';

type DeviceHints = {
  mobile?: boolean;
  platform?: string;
  shortScreen?: number;
};

function browserHints(): DeviceHints {
  if (typeof navigator === 'undefined') return {};
  const hints = (
    navigator as Navigator & {
      userAgentData?: { mobile: boolean; platform: string };
    }
  ).userAgentData;
  return {
    mobile: hints?.mobile,
    platform: hints?.platform,
    shortScreen:
      typeof screen === 'undefined'
        ? undefined
        : Math.min(screen.width, screen.height),
  };
}

// Send only a broad device class to the connected peer, never its user agent.
export function deviceKind(
  userAgent = typeof navigator === 'undefined' ? '' : navigator.userAgent,
  touchPoints = typeof navigator === 'undefined' ? 0 : navigator.maxTouchPoints,
  hints: DeviceHints = browserHints(),
): DeviceKind {
  if (
    /iPad/i.test(userAgent) ||
    (/Macintosh/i.test(userAgent) && touchPoints > 1)
  )
    return 'tablet';
  if (/Android/i.test(userAgent) || hints.platform === 'Android')
    return /Mobile/i.test(userAgent) ||
      hints.mobile === true ||
      (touchPoints > 0 &&
        hints.shortScreen !== undefined &&
        hints.shortScreen < 600)
      ? 'phone'
      : 'tablet';
  return /iPhone|iPod|Windows Phone/i.test(userAgent) ? 'phone' : 'computer';
}

export function peerDevice(value: unknown): DeviceKind | undefined {
  return value === 'phone' || value === 'tablet' || value === 'computer'
    ? value
    : undefined;
}

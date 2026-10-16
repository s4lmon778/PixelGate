import type { BrowserContext } from '@playwright/test';

// Optional localhost isolation. Keep real native ICE, SCTP and data channels,
// while removing external STUN discovery from these same-host fixtures.
export async function isolateHostIce(context: BrowserContext) {
  if (
    (process.env.SPEEDGATE_TEST_HOST_ONLY ||
      process.env.PIXELGATE_TEST_HOST_ONLY) !== '1'
  )
    return;
  await context.addInitScript(() => {
    const Native = window.RTCPeerConnection;
    window.RTCPeerConnection = new Proxy(Native, {
      construct(target, args, newTarget) {
        return Reflect.construct(
          target,
          [{ ...args[0], iceServers: [] }, ...args.slice(1)],
          newTarget,
        );
      },
    });
  });
}

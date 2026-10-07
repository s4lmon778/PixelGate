import type { CandidateDelivery } from './candidate-inbox';
export type CandidateCounts = {
  host: number;
  srflx: number;
  prflx: number;
  relay: number;
};
export interface RouteDiagnostics {
  elapsedSeconds: number;
  signaling: string;
  ice: string;
  gathering: string;
  connection: string;
  channel: string;
  localDescription: boolean;
  remoteDescription: boolean;
  localCandidates: CandidateCounts;
  remoteCandidates: CandidateCounts;
  localMdns: number;
  remoteMdns: number;
  lanCandidatesAdded: number;
  candidateDelivery?: CandidateDelivery;
  statsReads: number;
  statsErrors: number;
  candidatePairs: Record<string, number>;
  stunErrors: { service: string; code: number }[];
}

// Interpret only observed negotiation facts. Browser reports cannot identify
// an SSID, campus policy, firewall rule, or the cause of failed discovery.
export function routeFailureMessage(report?: RouteDiagnostics) {
  if (report && (!report.localDescription || !report.remoteDescription))
    return 'Connection setup is incomplete: both devices’ connection descriptions were not installed. Keep both browsers open and create a fresh code.';
  if (report?.candidateDelivery?.rejected)
    return 'The browser rejected a network candidate and no direct route opened. Create a fresh code; connection diagnostics include the rejection category.';

  const stunUnavailable =
    report?.localCandidates.srflx === 0 &&
    ['Cloudflare STUN', 'Google STUN'].every((service) =>
      report.stunErrors.some(
        (error) => error.service === service && error.code === 701,
      ),
    );
  return (
    'Pairing succeeded, but no direct route opened. ' +
    (stunUnavailable
      ? 'This device could not reach either configured STUN service. '
      : '') +
    'Guest, campus, hotel, and workplace networks may block local discovery or connections between devices, even with the same Wi-Fi name. Try a trusted network that allows local connections, or ask the network administrator whether direct WebRTC traffic is allowed.'
  );
}

function candidates(sdp = '') {
  const counts: CandidateCounts = { host: 0, srflx: 0, prflx: 0, relay: 0 };
  let mdns = 0;
  for (const line of sdp.split('\n')) {
    if (!line.startsWith('a=candidate:')) continue;
    const kind = / typ (host|srflx|prflx|relay)(?:\s|$)/.exec(line)?.[1];
    if (kind) counts[kind as keyof CandidateCounts]++;
    if (line.includes('.local')) mdns++;
  }
  return { counts, mdns };
}

// Retain only route states and counts. Never retain SDP, addresses, tokens,
// filenames, hashes, or file data. Nothing is sent to a diagnostics service.
export class RouteProbe {
  private started = Date.now();
  private pairs: Record<string, number> = {};
  private errors: RouteDiagnostics['stunErrors'] = [];
  private timer?: ReturnType<typeof setInterval>;
  private stopped = false;
  private polling = false;
  private statsReads = 0;
  private statsErrors = 0;
  constructor(
    private pc: RTCPeerConnection,
    private channel: () => RTCDataChannel | undefined,
    private update: (report: RouteDiagnostics) => void,
    private lanCandidates: () => number = () => 0,
    private delivery: () => CandidateDelivery | undefined = () => undefined,
  ) {
    pc.addEventListener('icecandidateerror', this.error);
    this.timer = setInterval(() => void this.poll(), 2000);
    this.snapshot();
  }
  private error = (event: Event) => {
    const error = event as RTCPeerConnectionIceErrorEvent;
    const service = error.url?.includes('stun.cloudflare.com')
      ? 'Cloudflare STUN'
      : error.url?.includes('stun.l.google.com')
        ? 'Google STUN'
        : 'STUN';
    if (this.errors.length < 16)
      this.errors.push({ service, code: error.errorCode });
    this.snapshot();
  };
  private async poll() {
    if (this.stopped || this.polling) return;
    this.polling = true;
    try {
      const stats = await this.pc.getStats();
      if (!this.stopped) this.statsReads++;
      const pairs: Record<string, number> = {};
      stats.forEach((value) => {
        if (value.type === 'candidate-pair' && typeof value.state === 'string')
          pairs[value.state] = (pairs[value.state] ?? 0) + 1;
      });
      if (!this.stopped) this.pairs = pairs;
    } catch {
      if (!this.stopped) this.statsErrors++;
      /* Some browsers stop exposing stats after a failed route. */
    } finally {
      this.polling = false;
      if (!this.stopped) this.snapshot();
    }
  }
  snapshot() {
    const local = candidates(this.pc.localDescription?.sdp);
    const remote = candidates(this.pc.remoteDescription?.sdp);
    const report: RouteDiagnostics = {
      elapsedSeconds: Math.floor((Date.now() - this.started) / 1000),
      signaling: this.pc.signalingState,
      ice: this.pc.iceConnectionState,
      gathering: this.pc.iceGatheringState,
      connection: this.pc.connectionState,
      channel: this.channel()?.readyState ?? 'not-created',
      localDescription: !!this.pc.localDescription,
      remoteDescription: !!this.pc.remoteDescription,
      localCandidates: local.counts,
      remoteCandidates: remote.counts,
      localMdns: local.mdns,
      remoteMdns: remote.mdns,
      lanCandidatesAdded: this.lanCandidates(),
      candidateDelivery: this.delivery(),
      statsReads: this.statsReads,
      statsErrors: this.statsErrors,
      candidatePairs: { ...this.pairs },
      stunErrors: this.errors.map((error) => ({ ...error })),
    };
    this.update(report);
    return report;
  }
  stop() {
    if (this.stopped) return;
    this.snapshot();
    this.stopped = true;
    clearInterval(this.timer);
    this.pc.removeEventListener('icecandidateerror', this.error);
  }
}

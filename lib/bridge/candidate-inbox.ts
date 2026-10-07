export type CandidateDelivery = {
  received: number;
  queued: number;
  added: number;
  rejected: number;
  errors: Partial<
    Record<
      'InvalidStateError' | 'OperationError' | 'TypeError' | 'Other',
      number
    >
  >;
};

/** Trickle candidates can overtake their answer. Apply them only after SDP. */
export class CandidateInbox {
  private pending: RTCIceCandidateInit[] = [];
  private seen = new Set<string>();
  private stopped = false;
  private applying = false;
  private report: CandidateDelivery = {
    received: 0,
    queued: 0,
    added: 0,
    rejected: 0,
    errors: {},
  };
  constructor(private pc: RTCPeerConnection) {
    pc.addEventListener('signalingstatechange', this.ready);
  }
  receive(input: unknown) {
    if (this.stopped) return;
    this.report.received = Math.min(128, this.report.received + 1);
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      this.reject();
      return;
    }
    const value = input as RTCIceCandidateInit;
    if (
      typeof value.candidate !== 'string' ||
      value.candidate.length > 2048 ||
      !value.candidate.startsWith('candidate:') ||
      (value.sdpMid != null &&
        (typeof value.sdpMid !== 'string' || value.sdpMid.length > 64)) ||
      (value.sdpMLineIndex != null &&
        (!Number.isInteger(value.sdpMLineIndex) ||
          value.sdpMLineIndex < 0 ||
          value.sdpMLineIndex > 16)) ||
      (value.sdpMid == null && value.sdpMLineIndex == null) ||
      (value.usernameFragment != null &&
        (typeof value.usernameFragment !== 'string' ||
          value.usernameFragment.length > 256))
    ) {
      this.reject();
      return;
    }
    const candidate: RTCIceCandidateInit = {
      candidate: value.candidate,
      sdpMid: value.sdpMid ?? null,
      sdpMLineIndex: value.sdpMLineIndex ?? null,
      usernameFragment: value.usernameFragment ?? null,
    };
    const key = JSON.stringify(candidate);
    if (this.seen.has(key)) return;
    if (this.seen.size >= 64) {
      this.reject();
      return;
    }
    this.seen.add(key);
    this.pending.push(candidate);
    if (!this.pc.remoteDescription) this.report.queued++;
    this.ready();
  }
  private reject() {
    this.report.rejected = Math.min(128, this.report.rejected + 1);
  }
  ready = () => {
    void this.flush();
  };
  private async flush() {
    if (
      this.stopped ||
      this.applying ||
      !this.pc.remoteDescription ||
      this.pc.signalingState === 'closed'
    )
      return;
    this.applying = true;
    try {
      while (!this.stopped && this.pending.length) {
        const candidate = this.pending.shift()!;
        try {
          await this.pc.addIceCandidate(candidate);
          if (!this.stopped) this.report.added++;
        } catch (error) {
          if (this.stopped) break;
          this.reject();
          const name = error instanceof Error ? error.name : '';
          const kind =
            name === 'InvalidStateError' ||
            name === 'OperationError' ||
            name === 'TypeError'
              ? name
              : 'Other';
          this.report.errors[kind] = (this.report.errors[kind] ?? 0) + 1;
          // One unusable candidate must not prevent trying subsequent routes.
        }
      }
    } finally {
      this.applying = false;
    }
  }
  snapshot(): CandidateDelivery {
    return { ...this.report, errors: { ...this.report.errors } };
  }
  stop() {
    this.stopped = true;
    this.pc.removeEventListener('signalingstatechange', this.ready);
    this.pending.length = 0;
    this.seen.clear();
  }
}

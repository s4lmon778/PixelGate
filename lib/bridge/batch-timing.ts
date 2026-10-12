export type BatchTimingSnapshot = {
  phase: 'running' | 'verified' | 'incomplete';
  wallElapsedMs: number;
  requestedFiles: number;
  requestedBytes: number;
  payloadBytesSent: number;
  resumedBytes: number;
  skippedBytes: number;
  verifiedFiles: number;
  skippedFiles: number;
};

/** Send invocation through final verified outcome, including hashing and pauses. */
export class BatchTiming {
  private started?: number;
  private ended?: number;
  private values?: Omit<BatchTimingSnapshot, 'wallElapsedMs'>;
  constructor(private now = () => performance.now()) {}
  begin(requestedFiles: number, requestedBytes: number) {
    this.started = this.now();
    this.ended = undefined;
    this.values = {
      phase: 'running',
      requestedFiles,
      requestedBytes,
      payloadBytesSent: 0,
      resumedBytes: 0,
      skippedBytes: 0,
      verifiedFiles: 0,
      skippedFiles: 0,
    };
  }
  sent(bytes: number) {
    if (this.values?.phase === 'running') this.values.payloadBytesSent += bytes;
  }
  resumed(bytes: number) {
    if (this.values?.phase === 'running') this.values.resumedBytes += bytes;
  }
  skipped(bytes: number) {
    if (this.values?.phase === 'running') this.values.skippedBytes += bytes;
  }
  finish(verifiedFiles: number, skippedFiles: number) {
    if (this.values?.phase !== 'running') return;
    this.ended = this.now();
    this.values.verifiedFiles = verifiedFiles;
    this.values.skippedFiles = skippedFiles;
    this.values.phase =
      verifiedFiles + skippedFiles === this.values.requestedFiles &&
      this.values.payloadBytesSent +
        this.values.resumedBytes +
        this.values.skippedBytes ===
        this.values.requestedBytes
        ? 'verified'
        : 'incomplete';
  }
  snapshot(): BatchTimingSnapshot | undefined {
    if (!this.values || this.started === undefined) return;
    return {
      ...this.values,
      wallElapsedMs: Math.round(
        Math.max(0, (this.ended ?? this.now()) - this.started),
      ),
    };
  }
}

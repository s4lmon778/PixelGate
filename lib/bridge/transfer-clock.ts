/** Transfer time excludes pairing, source preparation, and intentional pauses. */
export class TransferClock {
  private startedAt?: number;
  private finishedAt?: number;
  private pausedAt?: number;
  private pausedMs = 0;
  private baseBytes = 0;

  reset() {
    this.startedAt = undefined;
    this.finishedAt = undefined;
    this.pausedAt = undefined;
    this.pausedMs = 0;
    this.baseBytes = 0;
  }
  start(bytes: number, now = performance.now()) {
    if (this.finishedAt !== undefined) this.reset();
    if (this.startedAt !== undefined) return;
    this.startedAt = now;
    this.baseBytes = bytes;
  }
  get active() {
    return this.startedAt !== undefined && this.finishedAt === undefined;
  }
  pause(now = performance.now()) {
    if (this.startedAt !== undefined && this.finishedAt === undefined)
      this.pausedAt ??= now;
  }
  resume(now = performance.now()) {
    if (this.pausedAt === undefined) return;
    this.pausedMs += now - this.pausedAt;
    this.pausedAt = undefined;
  }
  finish(now = performance.now()) {
    this.finishedAt ??= this.pausedAt ?? now;
  }
  elapsed(now = performance.now()) {
    if (this.startedAt === undefined) return 0;
    return (
      Math.max(
        0,
        (this.finishedAt ?? this.pausedAt ?? now) -
          this.startedAt -
          this.pausedMs,
      ) / 1000
    );
  }
  rate(bytes: number, now = performance.now()) {
    const elapsed = this.elapsed(now);
    return elapsed && this.pausedAt === undefined
      ? Math.max(0, bytes - this.baseBytes) / elapsed
      : 0;
  }
}

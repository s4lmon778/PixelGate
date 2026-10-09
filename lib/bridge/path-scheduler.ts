import { FRAME_BYTES } from './model';

type Observation = {
  started: number;
  delivered: number;
  rate: number;
  samples: number;
  lastReceipt: number;
  lastSent: number;
  minimumDelay: number;
  receivedBytes: number;
  delay: number;
  timelyBytes: number;
};

/** Learn delivery on existing browser-selected paths; never bind an interface. */
export class PathScheduler<T> {
  private observations = new Map<T, Observation>();
  private turn = 0;
  private decisions = 0;
  private adaptive = false;

  sent(path: T, now: number, outstanding: number) {
    let observation = this.observations.get(path);
    if (!observation) {
      observation = {
        started: now,
        delivered: 0,
        rate: 0,
        samples: 0,
        lastReceipt: now,
        lastSent: now,
        minimumDelay: Infinity,
        receivedBytes: 0,
        delay: 0,
        timelyBytes: 0,
      };
      this.observations.set(path, observation);
    }
    // Source reads/checkpoint waits are demand gaps, not a slower network.
    if (!outstanding && now - observation.lastReceipt > 100) {
      observation.started = now;
      observation.delivered = 0;
    }
    observation.lastSent = now;
  }

  received(path: T, bytes: number, sentAt: number, now: number) {
    const observation = this.observations.get(path);
    if (!observation) return;
    observation.receivedBytes += bytes;
    observation.delivered += bytes;
    observation.lastReceipt = now;
    observation.minimumDelay = Math.min(
      observation.minimumDelay,
      Math.max(1, now - sentAt),
    );
    const delay = Math.max(1, now - sentAt);
    observation.delay = observation.delay
      ? observation.delay * 0.5 + delay * 0.5
      : delay;
    // A long, stable RTT is not evidence of a growing queue. Compare delivery
    // with this path's own baseline, rather than a fixed 150 ms RTT ceiling.
    observation.timelyBytes =
      observation.delay - observation.minimumDelay <= 150
        ? observation.timelyBytes + bytes
        : 0;
    const elapsed = now - observation.started;
    // Receipt batches and timer noise must not become instantaneous bandwidth.
    if (elapsed < 100 || observation.delivered < 4 * FRAME_BYTES) return;
    const rate = (observation.delivered * 1000) / elapsed;
    observation.rate = observation.rate
      ? observation.rate * 0.75 + rate * 0.25
      : rate;
    observation.samples++;
    observation.started = now;
    observation.delivered = 0;
  }

  feedback(paths: T[]) {
    let queueDelay = 0;
    let timelyBytes = 0;
    for (const path of paths) {
      const observation = this.observations.get(path);
      if (!observation) continue;
      queueDelay = Math.max(
        queueDelay,
        observation.delay - observation.minimumDelay,
      );
      timelyBytes += observation.timelyBytes;
    }
    return { queueDelay, timelyBytes };
  }

  choose(
    paths: T[],
    queued: (path: T) => number,
    now: number,
    bytes = FRAME_BYTES,
  ) {
    const rotated = paths.map((_, i) => paths[(i + this.turn) % paths.length]);
    this.turn++;
    this.decisions++;
    const learned = paths.every((path) => {
      const observation = this.observations.get(path);
      return observation && observation.samples >= 2 && observation.rate > 0;
    });
    const rates = paths.map((path) => this.observations.get(path)?.rate ?? 0);
    const maximum = Math.max(...rates);
    const minimum = Math.min(...rates);
    // Equal/noisy paths keep the original least-outstanding rotating scheduler.
    this.adaptive = learned && maximum > minimum * 2;
    if (!this.adaptive)
      return rotated.reduce((best, path) =>
        queued(path) < queued(best) ? path : best,
      );

    // A small deterministic probe budget lets an idle/previously slow path
    // prove that it recovered. Never add a probe behind a queued packet.
    if (this.decisions % 20 === 0) {
      const stale = rotated.filter((path) => {
        const observation = this.observations.get(path)!;
        return !queued(path) && now - observation.lastSent >= 500;
      });
      if (stale.length)
        return stale.reduce((best, path) =>
          this.observations.get(path)!.lastSent <
          this.observations.get(best)!.lastSent
            ? path
            : best,
        );
    }
    const arrival = (path: T) => {
      const observation = this.observations.get(path)!;
      // Bound learned weights. Sparse traffic is not evidence of zero capacity.
      const rate = Math.max(maximum / 16, observation.rate);
      return observation.minimumDelay + ((queued(path) + bytes) * 1000) / rate;
    };
    return rotated.reduce((best, path) =>
      arrival(path) < arrival(best) * 0.95 ? path : best,
    );
  }

  snapshot(paths: T[]) {
    return {
      scheduling: this.adaptive ? 'adaptive' : 'balanced',
      paths: paths.map((path, index) => {
        const observation = this.observations.get(path);
        return {
          path: index + 1,
          receivedBytes: observation?.receivedBytes ?? 0,
          deliveryBytesPerSecond: Math.round(observation?.rate ?? 0),
          minimumReceiptDelayMs: Number.isFinite(observation?.minimumDelay)
            ? Math.round(observation!.minimumDelay)
            : undefined,
          samples: observation?.samples ?? 0,
          receiptDelayMs: observation
            ? Math.round(observation.delay)
            : undefined,
          queuedDelayMs: observation
            ? Math.round(observation.delay - observation.minimumDelay)
            : undefined,
        };
      }),
    };
  }

  clear() {
    this.observations.clear();
    this.adaptive = false;
    this.turn = 0;
    this.decisions = 0;
  }
}

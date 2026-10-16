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

  // Keep worst-path delay for diagnostics. With enough observed paths, the
  // sending policy may use the upper quartile so a minority backlog does not
  // starve every independent association. Broad queue growth still backs off.
  feedback(paths: T[], tolerateOutlier = false) {
    let queueDelay = 0;
    let timelyBytes = 0;
    const queues: number[] = [];
    for (const path of paths) {
      const observation = this.observations.get(path);
      if (!observation) continue;
      queueDelay = Math.max(
        queueDelay,
        observation.delay - observation.minimumDelay,
      );
      queues.push(Math.max(0, observation.delay - observation.minimumDelay));
      timelyBytes += observation.timelyBytes;
    }
    if (tolerateOutlier && queues.length >= 5) {
      queues.sort((a, b) => a - b);
      queueDelay = queues[Math.ceil(queues.length * 0.75) - 1];
    }
    return { queueDelay, timelyBytes };
  }

  receiptDelay(path: T) {
    return this.observations.get(path)?.delay ?? 0;
  }

  minimumReceiptDelay(paths: T[]) {
    const delays = paths
      .map((path) => this.observations.get(path)?.minimumDelay)
      .filter((delay): delay is number => Number.isFinite(delay))
      .sort((a, b) => a - b);
    // Use the lower median so one slow or unobserved path cannot dictate the
    // message size for its healthy siblings. Excluded paths stay excluded.
    return delays.length
      ? delays[Math.floor((delays.length - 1) / 2)]
      : undefined;
  }

  choose(
    paths: T[],
    queued: (path: T) => number,
    now: number,
    bytes = FRAME_BYTES,
  ) {
    // This runs for every file frame. Walk the rotating order without creating
    // temporary path/rate arrays or re-reading the winning path's queue.
    const count = paths.length;
    if (!count) throw new Error('No transfer paths available.');
    const start = this.turn++ % count;
    this.decisions++;
    let learned = true;
    let maximum = 0;
    let minimum = Infinity;
    for (const path of paths) {
      const observation = this.observations.get(path);
      const rate = observation?.rate ?? 0;
      learned &&= !!observation && observation.samples >= 2 && rate > 0;
      maximum = Math.max(maximum, rate);
      minimum = Math.min(minimum, rate);
    }
    // Equal/noisy paths keep the original least-outstanding rotating scheduler.
    this.adaptive = learned && maximum > minimum * 2;
    let best = paths[start];
    if (!this.adaptive) {
      let smallest = queued(best);
      for (let index = 1; index < count; index++) {
        const path = paths[(start + index) % count];
        const size = queued(path);
        if (size < smallest) {
          best = path;
          smallest = size;
        }
      }
      return best;
    }

    // Preserve the same deterministic idle-path probe budget and rotating ties.
    if (this.decisions % 20 === 0) {
      let stale: T | undefined;
      let earliest = Infinity;
      for (let index = 0; index < count; index++) {
        const path = paths[(start + index) % count];
        const observation = this.observations.get(path)!;
        if (
          !queued(path) &&
          now - observation.lastSent >= 500 &&
          observation.lastSent < earliest
        ) {
          stale = path;
          earliest = observation.lastSent;
        }
      }
      if (stale !== undefined) return stale;
    }
    const arrival = (path: T) => {
      const observation = this.observations.get(path)!;
      // Bound learned weights. Sparse traffic is not evidence of zero capacity.
      const rate = Math.max(maximum / 16, observation.rate);
      return observation.minimumDelay + ((queued(path) + bytes) * 1000) / rate;
    };
    let soonest = arrival(best);
    for (let index = 1; index < count; index++) {
      const path = paths[(start + index) % count];
      const time = arrival(path);
      if (time < soonest * 0.95) {
        best = path;
        soonest = time;
      }
    }
    return best;
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

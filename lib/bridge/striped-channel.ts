import { CandidateInbox } from './candidate-inbox';
import { PathScheduler } from './path-scheduler';
import { LINK_TEST_MAGIC, PeerLinkTest } from './peer-link-test';
import { LanRoute, lanAddress } from './lan-route';
import { deviceKind, peerDevice } from './device';
import {
  sourceStatus,
  type SourceState,
  type SourceStatus,
} from './source-status';
import { validateSignal } from '../pairing-validation';
import {
  CHECKPOINT_BYTES,
  FRAME_BYTES,
  LEGACY_TRANSFER_WINDOW_BYTES,
  MAX_BULK_LANES,
  STRIPED_FRAME_BYTES,
  TRANSFER_WINDOW_BYTES,
  VERSION,
} from './model';

export type TransferChannel = Pick<
  RTCDataChannel,
  | 'readyState'
  | 'bufferedAmount'
  | 'bufferedAmountLowThreshold'
  | 'onmessage'
  | 'send'
  | 'close'
  | 'addEventListener'
> & {
  prepare?: () => Promise<void>;
  receiveWindowBytes?: number;
  sendBufferBytes?: number;
  burstBytes?: number;
  pacingDelayMs?: number;
  frameBytes?: number;
  sendFrameBytes?: number;
  sendBurst?: (data: Uint8Array<ArrayBuffer>) => number;
};
const MAGIC = 0x50475331;
const LANES = 2;
const MAX_LANES = MAX_BULK_LANES;
type Lane = {
  pc: RTCPeerConnection;
  inbox: CandidateInbox;
  channel?: RTCDataChannel;
  timer: ReturnType<typeof setTimeout>;
  failed: boolean;
  signals: number;
  lanRoute?: LanRoute;
};
type Packet = {
  wire: string | ArrayBuffer;
  lane: RTCDataChannel;
  size: number;
  sentAt: number;
  retries: number;
};
type Payload = string | ArrayBuffer | Uint8Array<ArrayBuffer>;

/** Independent SCTP connections; restore the existing engine's ordered stream. */
export class StripedChannel extends EventTarget implements TransferChannel {
  readonly linkTest: PeerLinkTest;
  // Start phones with the five-connection budget from the recorded 0.3.28 run.
  // Keep the full protocol bound so explicit seven/fourteen-path tests still work.
  private readonly localPhone = deviceKind() === 'phone';
  private peerPhone = false;
  private offering = Promise.resolve();
  get defaultPayloadConnections() {
    return this.localPhone || this.peerPhone ? 5 : MAX_LANES + 1;
  }
  get maximumPayloadConnections() {
    return (this.negotiated ? this.laneCount : MAX_LANES) + 1;
  }
  private get targetLanes() {
    return Math.min(
      this.laneCount,
      (this.payloadLimit ?? this.defaultPayloadConnections) - 1,
    );
  }
  private payloadLimit?: number;
  private fileActive = false;
  get hasActiveFile() {
    return this.fileActive;
  }
  get canLimitPayload() {
    return this.role === 'send';
  }
  setPayloadLimit(limit?: number) {
    if (!this.canLimitPayload)
      throw new Error('Change the connection limit on the sending device.');
    if (limit !== undefined && ![5, 7, 14].includes(limit))
      throw new Error('Invalid payload connection limit.');
    if (
      this.fileActive ||
      this.pendingBytes ||
      this.linkTest.snapshot().running
    )
      throw new Error(
        'Finish the transfer or speed test before changing the connection limit.',
      );
    this.payloadLimit = limit;
    if (this.negotiated) void this.offerLanes();
    this.dispatchEvent(new Event('linktestchange'));
  }
  onmessage: RTCDataChannel['onmessage'] = null;
  private lanes = new Map<number, Lane>();
  private negotiated = false;
  private sending = false;
  private receiving = false;
  private outgoing = 0;
  private incoming = 0;
  private acknowledged = -1;
  private lastAck = -1;
  private pending = new Map<number, Packet>();
  private pendingBytes = 0;
  private outstanding = new Map<RTCDataChannel, number>();
  private reordered = new Map<number, Payload>();
  private reorderedBytes = 0;
  private threshold = 0;
  private stopped = false;
  private signaling = Promise.resolve();
  private selective = false;
  private laneCount = LANES;
  private negotiatedFrameBytes = FRAME_BYTES;
  private scheduler = new PathScheduler<RTCDataChannel>();
  private receipts: number[] = [];
  private receiptTimer?: ReturnType<typeof setTimeout>;
  private retryTimer?: ReturnType<typeof setInterval>;
  private delay = 0;
  private highestReceived = -1;
  private replayed = 0;
  private nextRecoveryAt = 0;
  private cooldown = new Map<RTCDataChannel, number>();
  private burstCandidates?: RTCDataChannel[];
  private burstBuffers?: Map<RTCDataChannel, number>;
  private burstBufferedBytes = 0;
  private incomingPaths = new Map<
    RTCDataChannel,
    { bytes: number; sampledBytes: number; sampledAt: number; rate: number }
  >();
  private deliveredBytes = 0;
  private lastDeliveryAt = 0;
  private sourceStatusEnabled = false;
  private lastSourceStatusSent = -Infinity;
  private lastSourceStatusReceived = -Infinity;
  private peerSourceStatus?: SourceStatus;
  constructor(
    private primary: RTCDataChannel,
    private role: 'send' | 'receive',
    private senderAddress = '',
  ) {
    super();
    this.linkTest = new PeerLinkTest(
      role,
      () => this.payloadCandidates(),
      (message) => this.write(this.primary, JSON.stringify(message)),
      () => this.dispatchEvent(new Event('linktestchange')),
    );
    this.senderAddress = role === 'receive' ? lanAddress(senderAddress) : '';
    primary.onmessage = ({ data }) => this.receive(data, false, primary);
    primary.addEventListener('bufferedamountlow', () =>
      this.dispatchEvent(new Event('bufferedamountlow')),
    );
    primary.addEventListener('close', () => {
      this.stopped = true;
      this.linkTest.cancel('Connection closed.', false);
      clearTimeout(this.receiptTimer);
      clearInterval(this.retryTimer);
      for (const lane of this.lanes.values()) this.dispose(lane);
      this.lanes.clear();
      this.pending.clear();
      this.pendingBytes = 0;
      this.outstanding.clear();
      this.reordered.clear();
      this.reorderedBytes = 0;
      this.receipts = [];
      this.cooldown.clear();
      this.scheduler.clear();
      this.peerSourceStatus = undefined;
      this.sourceStatusEnabled = false;
      this.senderAddress = '';
      this.dispatchEvent(new Event('close'));
    });
  }
  get readyState() {
    return this.primary.readyState;
  }
  get bufferedAmount() {
    const native =
      this.primary.bufferedAmount +
      [...this.lanes.values()].reduce(
        (total, lane) =>
          total + (lane.failed ? 0 : (lane.channel?.bufferedAmount ?? 0)),
        0,
      );
    // Browser bufferedAmount excludes SCTP/OS queues. New peers also bound
    // unreceived bytes, preventing a burst from disappearing into those queues.
    return this.selective && this.sending
      ? Math.max(native, this.pendingBytes)
      : native;
  }
  get bufferedAmountLowThreshold() {
    return this.threshold;
  }
  get receiveWindowBytes() {
    return this.receiving ? TRANSFER_WINDOW_BYTES : CHECKPOINT_BYTES;
  }
  get frameBytes() {
    return this.selective ? this.negotiatedFrameBytes : FRAME_BYTES;
  }
  get sendFrameBytes() {
    // Large messages reduce receiver work on nearby links. At longer native
    // delivery delays, smaller messages avoid expensive SCTP fragmentation.
    const { timelyBytes, queueDelay } = this.deliveryFeedback(true);
    const delay = this.scheduler.minimumReceiptDelay(this.healthyLanes());
    return timelyBytes >= CHECKPOINT_BYTES / 2 &&
      queueDelay <= 100 &&
      delay !== undefined &&
      delay <= 40
      ? this.frameBytes
      : FRAME_BYTES;
  }
  get sendBufferBytes() {
    if (!this.selective || !this.sending) return 64 * 1024;
    const { timelyBytes, queueDelay } = this.deliveryFeedback(true);
    if (queueDelay > 750) return 128 * 1024;
    if (queueDelay > 250) return 256 * 1024;
    if (queueDelay > 150) return 512 * 1024;
    if (
      this.frameBytes > FRAME_BYTES &&
      queueDelay <= 100 &&
      timelyBytes >= 8 * CHECKPOINT_BYTES
    )
      return Math.min(
        // Storage can overlap eight checkpoints without enlarging native queues.
        LEGACY_TRANSFER_WINDOW_BYTES - 64 * 1024,
        this.healthyLanes().length * CHECKPOINT_BYTES,
      );
    if (timelyBytes >= 4 * CHECKPOINT_BYTES) return 2 * CHECKPOINT_BYTES;
    if (timelyBytes >= 2 * CHECKPOINT_BYTES) return CHECKPOINT_BYTES;
    return 512 * 1024;
  }
  get pacingDelayMs() {
    // Transport receipts bound the hidden queues. Once delivery is established,
    // yield a browser task without imposing a timer delay on every healthy burst.
    const { timelyBytes, queueDelay } = this.deliveryFeedback(true);
    return this.selective &&
      this.sending &&
      timelyBytes >= CHECKPOINT_BYTES / 2 &&
      queueDelay <= 150
      ? 0
      : 4;
  }
  private deliveryFeedback(tolerateOutlier = false) {
    const paths = [this.primary, ...this.openLanes()];
    const healthy = this.healthyLanes();
    const feedback = this.scheduler.feedback(
      healthy.length ? healthy : paths,
      tolerateOutlier,
    );
    // A path already excluded from scheduling must not throttle its healthy
    // siblings. If all paths stall, retain feedback and restart conservatively.
    return healthy.length
      ? feedback
      : { timelyBytes: 0, queueDelay: Math.max(151, feedback.queueDelay) };
  }
  private healthyLanes() {
    return this.participatingLanes(
      [this.primary, ...this.openLanes()].filter(
        (channel) => (this.cooldown.get(channel) ?? 0) <= performance.now(),
      ),
    );
  }
  private participatingLanes(paths: RTCDataChannel[]) {
    // Splitting a bounded flight across too many distant SCTP associations
    // can underfill each one. Keep the wider pool for nearby routes.
    const delay = this.scheduler.minimumReceiptDelay(paths);
    const limit = Math.min(
      this.payloadLimit ?? this.defaultPayloadConnections,
      delay !== undefined && delay > 80 ? 7 : MAX_LANES + 1,
    );
    return paths.slice(0, limit);
  }
  get burstBytes() {
    const { timelyBytes, queueDelay } = this.deliveryFeedback(true);
    if (!this.selective || !this.sending || queueDelay > 150) return 64 * 1024;
    if (
      this.frameBytes > FRAME_BYTES &&
      queueDelay <= 100 &&
      timelyBytes >= 8 * CHECKPOINT_BYTES
    )
      return 512 * 1024;
    if (timelyBytes >= 2 * CHECKPOINT_BYTES) return 256 * 1024;
    if (timelyBytes >= CHECKPOINT_BYTES / 2) return 128 * 1024;
    return 64 * 1024;
  }
  snapshot() {
    const channels = [
      ...new Set([
        this.primary,
        ...[...this.lanes.values()].flatMap((lane) =>
          lane.channel ? [lane.channel] : [],
        ),
        ...this.incomingPaths.keys(),
      ]),
    ];
    const receivedPaths = channels.map((channel, index) => {
      const path = this.incomingPaths.get(channel);
      const now = performance.now();
      if (path && now - path.sampledAt >= 250) {
        path.rate =
          ((path.bytes - path.sampledBytes) * 1000) / (now - path.sampledAt);
        path.sampledAt = now;
        path.sampledBytes = path.bytes;
      }
      return {
        path: index + 1,
        receivedBytes: path?.bytes ?? 0,
        deliveryBytesPerSecond: Math.round(path?.rate ?? 0),
      };
    });
    const senderMeasurements = {
      activePayloadConnections: this.payloadCandidates().filter(
        (channel) => channel.readyState === 'open',
      ).length,
      payloadConnectionLimit:
        this.payloadLimit ?? this.defaultPayloadConnections,
      unreceivedBytes: this.pendingBytes,
      oldestUnreceivedMs: Math.round(
        Math.max(
          0,
          ...[...this.pending.values()].map(
            (packet) => performance.now() - packet.sentAt,
          ),
        ),
      ),
      receiptDelayMs: Math.round(this.delay),
      queuedDelayMs: Math.round(this.deliveryFeedback().queueDelay),
      replayedPackets: this.replayed,
      pacingBurstBytes: this.burstBytes,
      pacingDelayMs: this.pacingDelayMs,
      sendBufferBytes: this.sendBufferBytes,
      sendFrameBytes: this.sendFrameBytes,
      deprioritizedConnections: [...this.cooldown.values()].filter(
        (until) => until > performance.now(),
      ).length,
      ...this.scheduler.snapshot([this.primary, ...this.openLanes()]),
      measurement: 'sender-receipts' as const,
    };
    const outgoing: Partial<typeof senderMeasurements> =
      this.role === 'send' ? senderMeasurements : {};
    return {
      connections:
        (this.readyState === 'open' ? 1 : 0) + this.openLanes().length,
      mode: this.sending || this.receiving ? 'parallel' : 'single',
      selectiveReceipts: this.selective,
      reorderedBytes: this.reorderedBytes,
      deliveredBytes: this.deliveredBytes,
      deliveryIdleMs: this.lastDeliveryAt
        ? Math.round(performance.now() - this.lastDeliveryAt)
        : 0,
      ...outgoing,
      ...(this.role === 'receive'
        ? { paths: receivedPaths, measurement: 'receiver-wire-bytes' as const }
        : {}),
      frameBytes: this.frameBytes,
      ...(this.linkTest.snapshot().result || this.linkTest.snapshot().running
        ? { linkTest: this.linkTest.snapshot() }
        : {}),
      ...(this.role === 'receive' && this.peerSourceStatus
        ? {
            source: {
              ...this.peerSourceStatus,
              sampleAgeMs: Math.round(
                performance.now() - this.lastSourceStatusReceived,
              ),
            },
          }
        : {}),
    };
  }
  publishSourceStatus(state: SourceState, final = false) {
    const now = performance.now();
    if (
      this.role !== 'send' ||
      !this.sourceStatusEnabled ||
      this.stopped ||
      this.readyState !== 'open' ||
      (!final && now - this.lastSourceStatusSent < 2000) ||
      this.primary.bufferedAmount > 64 * 1024
    )
      return;
    const transfer = this.snapshot();
    const status = sourceStatus({ ...transfer, ...state });
    if (!status) return;
    try {
      // Optional metadata travels only over the approved direct connection.
      // It bypasses ordered file sequences and never consumes transfer credit.
      this.primary.send(JSON.stringify({ type: 'pg-source-status', status }));
      this.lastSourceStatusSent = now;
    } catch {
      // Optional diagnostics cannot abort or pause a file transfer.
    }
  }
  async prepare() {
    if (this.negotiated && this.role === 'send') void this.offerLanes();
    if (!this.negotiated || this.openLanes().length >= this.targetLanes) return;
    await new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        this.removeEventListener('laneschanged', changed);
        this.removeEventListener('close', finish);
        resolve();
      };
      const changed = () => {
        if (
          this.openLanes().length >= this.targetLanes ||
          this.stopped ||
          [...this.lanes.values()].some((lane) => lane.failed)
        )
          finish();
      };
      const timer = setTimeout(finish, 500);
      this.addEventListener('laneschanged', changed);
      this.addEventListener('close', finish);
      changed();
    });
  }
  set bufferedAmountLowThreshold(value: number) {
    this.threshold = value;
    // If the aggregate buffer is full, at least one lane must remain above
    // its own low watermark; otherwise no lane would ever wake the sender.
    this.primary.bufferedAmountLowThreshold = value / (this.laneCount + 1);
    for (const lane of this.lanes.values())
      if (lane.channel)
        lane.channel.bufferedAmountLowThreshold = value / (this.laneCount + 1);
  }
  /** Snapshot browser-reported buffers once per synchronous burst, then count every send.
   * Avoid per-frame getters and asynchronous dispatch. No receipt/browser task
   * can interleave this batch; the snapshot plus sends is conservative.
   */
  sendBurst(data: Uint8Array<ArrayBuffer>) {
    if (!data.byteLength) return 0;
    const paths = [this.primary, ...this.openLanes()];
    this.burstBuffers = new Map(
      paths.map((channel) => [channel, channel.bufferedAmount]),
    );
    try {
      this.burstBufferedBytes = [...this.burstBuffers.values()].reduce(
        (a, b) => a + b,
        0,
      );
      const credit = this.sendBufferBytes;
      const limit = this.burstBytes;
      const frameBytes = this.sendFrameBytes;
      // No receipt or signaling task can interleave this bounded synchronous burst.
      this.burstCandidates = this.payloadCandidates();
      const started = performance.now();
      let sent = 0;
      while (
        sent < data.byteLength &&
        sent < limit &&
        Math.max(
          this.burstBufferedBytes,
          this.selective ? this.pendingBytes : 0,
        ) <= credit
      ) {
        const frame = data.subarray(sent, sent + frameBytes);
        this.send(frame);
        sent += frame.byteLength;
        // Bound main-thread occupancy even on slow devices/native send calls.
        if (performance.now() - started >= 8) break;
      }
      return sent;
    } finally {
      // Never reuse a queue snapshot across an await, error, or browser task.
      this.burstBuffers = undefined;
      this.burstCandidates = undefined;
      this.burstBufferedBytes = 0;
    }
  }
  private write(
    channel: RTCDataChannel,
    wire: string | ArrayBuffer | Blob | ArrayBufferView<ArrayBuffer>,
  ) {
    Reflect.apply(channel.send, channel, [wire]);
    if (this.burstBuffers?.has(channel)) {
      const size =
        typeof wire === 'string'
          ? new TextEncoder().encode(wire).byteLength
          : wire instanceof Blob
            ? wire.size
            : wire.byteLength;
      this.burstBuffers.set(channel, this.burstBuffers.get(channel)! + size);
      this.burstBufferedBytes += size;
    }
  }
  send(data: string | Blob | ArrayBuffer | ArrayBufferView<ArrayBuffer>) {
    if (typeof data === 'string') {
      const value = JSON.parse(data);
      this.observeFileControl(value);
      if (value.type === 'hello')
        data = JSON.stringify({
          ...value,
          deviceKind: deviceKind(),
          stripedTransport: 1,
          stripedReceipts: 1,
          stripedLanes: MAX_LANES,
          stripedFrameBytes: STRIPED_FRAME_BYTES,
          sourceStatus: 1,
          peerLinkTest: 1,
        });
    }
    if (
      !this.sending &&
      this.role === 'send' &&
      this.negotiated &&
      this.openLanes().length > 0
    ) {
      this.write(this.primary, JSON.stringify({ type: 'pg-striped-start' }));
      this.sending = true;
      if (this.selective)
        this.retryTimer = setInterval(() => this.recoverGaps(), 20);
    }
    if (!this.sending) {
      this.write(this.primary, data);
      return;
    }
    if (this.outgoing >= 0xffffffff)
      throw new Error('Transfer stream limit reached. Reconnect to resume.');
    const sequence = this.outgoing++;
    let wire: string | ArrayBuffer;
    let channel = this.primary;
    if (typeof data === 'string')
      wire = JSON.stringify({
        type: 'pg-striped-control',
        sequence,
        value: data,
      });
    else {
      if (!(data instanceof ArrayBuffer) && !ArrayBuffer.isView(data))
        throw new Error('Unsupported transfer frame.');
      const bytes =
        data instanceof ArrayBuffer
          ? new Uint8Array(data)
          : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      if (bytes.length < 1 || bytes.length > this.frameBytes)
        throw new Error('Invalid transfer frame.');
      const frame = new Uint8Array(8 + bytes.length);
      const header = new DataView(frame.buffer);
      header.setUint32(0, MAGIC);
      header.setUint32(4, sequence);
      frame.set(bytes, 8);
      wire = frame.buffer;
      channel = this.chooseLane(undefined, bytes.length);
    }
    // Retain bounded unreceived packets for retransmission if a lane closes.
    const size = typeof wire === 'string' ? wire.length : wire.byteLength;
    if (
      this.pending.size >= TRANSFER_WINDOW_BYTES / FRAME_BYTES + 32 ||
      this.pendingBytes + size > TRANSFER_WINDOW_BYTES + 64 * 1024
    )
      throw new Error('Parallel transfer buffer exceeded.');
    this.pendingBytes += size;
    if (this.selective && typeof wire !== 'string') {
      this.scheduler.sent(
        channel,
        performance.now(),
        this.outstanding.get(channel) ?? 0,
      );
    }
    this.outstanding.set(channel, (this.outstanding.get(channel) ?? 0) + size);
    this.pending.set(sequence, {
      wire,
      lane: channel,
      size,
      sentAt: performance.now(),
      retries: 0,
    });
    this.write(channel, wire);
  }
  close() {
    this.primary.close();
  }
  private openLanes() {
    return [...this.lanes.values()].flatMap((lane) =>
      !lane.failed && lane.channel?.readyState === 'open' ? [lane.channel] : [],
    );
  }
  private payloadCandidates(exclude?: RTCDataChannel) {
    let available = [this.primary, ...this.openLanes()];
    if (exclude && available.length > 1)
      available = available.filter((channel) => channel !== exclude);
    const healthy = available.filter(
      (channel) => (this.cooldown.get(channel) ?? 0) <= performance.now(),
    );
    return this.participatingLanes(healthy.length ? healthy : available);
  }
  private chooseFrom(paths: RTCDataChannel[], bytes: number) {
    return this.scheduler.choose(
      paths,
      (channel) =>
        Math.max(
          this.burstBuffers?.get(channel) ?? channel.bufferedAmount,
          this.outstanding.get(channel) ?? 0,
        ),
      performance.now(),
      bytes,
    );
  }
  private chooseLane(exclude?: RTCDataChannel, bytes = FRAME_BYTES) {
    const cached = !exclude && this.burstCandidates;
    const lane = this.chooseFrom(
      cached || this.payloadCandidates(exclude),
      bytes,
    );
    // A native path can become unavailable before its close event is delivered.
    // Rebuild on that exceptional path; ordinary frames check one native state.
    if (cached && lane !== this.primary && lane.readyState !== 'open') {
      this.burstCandidates = this.payloadCandidates();
      return this.chooseFrom(this.burstCandidates, bytes);
    }
    return lane;
  }
  private received(sequence: number) {
    const packet = this.pending.get(sequence);
    if (!packet) return;
    const delay = performance.now() - packet.sentAt;
    // A replay's receipt may belong to either copy; do not attribute its speed.
    if (this.selective && typeof packet.wire !== 'string' && !packet.retries)
      this.scheduler.received(
        packet.lane,
        packet.size,
        packet.sentAt,
        performance.now(),
      );
    this.delay = this.delay ? this.delay * 0.8 + delay * 0.2 : delay;
    this.highestReceived = Math.max(this.highestReceived, sequence);
    this.pending.delete(sequence);
    this.pendingBytes -= packet.size;
    this.outstanding.set(
      packet.lane,
      (this.outstanding.get(packet.lane) ?? 0) - packet.size,
    );
  }
  private movePacket(packet: Packet, lane: RTCDataChannel) {
    this.outstanding.set(
      packet.lane,
      (this.outstanding.get(packet.lane) ?? 0) - packet.size,
    );
    this.outstanding.set(lane, (this.outstanding.get(lane) ?? 0) + packet.size);
    packet.lane = lane;
    packet.sentAt = performance.now();
    packet.retries++;
  }
  private recoverGaps() {
    if (this.stopped || this.readyState !== 'open' || !this.pending.size)
      return;
    const now = performance.now();
    const minimum = this.scheduler.minimumReceiptDelay(this.healthyLanes());
    // Very fast links routinely reorder striped bursts while browser tasks run.
    // Preserve their original recovery timing instead of duplicating healthy traffic.
    const nearby = minimum !== undefined && minimum >= 8 && minimum <= 40;
    if (now < this.nextRecoveryAt) return;
    this.nextRecoveryAt = now + (nearby ? 20 : 100);
    let count = 0;
    let native =
      this.primary.bufferedAmount +
      this.openLanes().reduce(
        (total, channel) => total + channel.bufferedAmount,
        0,
      );
    const credit = this.sendBufferBytes;
    const started = performance.now();
    for (const [sequence, packet] of this.pending) {
      if (native > credit || performance.now() - started >= 8) break;
      if (
        now - packet.sentAt <
        Math.min(
          10000,
          Math.max(
            sequence < this.highestReceived ? (nearby ? 50 : 250) : 2000,
            // Receipt batches from fast siblings must not make a slower path's
            // healthy packet look lost. Retain quick recovery and bound this
            // extra grace to 500 ms; tail recovery and backoff stay unchanged.
            nearby
              ? Math.max(
                  Math.min(250, this.delay * 2),
                  Math.min(500, this.scheduler.receiptDelay(packet.lane) * 2),
                )
              : this.delay * 3,
          ) *
            2 ** Math.min(packet.retries, 3),
        )
      )
        continue;
      // On nearby links, one lost packet is not proof that its entire path is
      // unusable. Keep all paths working while repairing gaps promptly. Preserve
      // the established cooldown on very fast/unobserved and longer-delay links.
      if (!nearby) this.cooldown.set(packet.lane, now + 5000);
      const lane = this.chooseLane(packet.lane);
      if (lane.bufferedAmount > this.sendBufferBytes) continue;
      try {
        this.write(lane, packet.wire);
        native +=
          typeof packet.wire === 'string'
            ? new TextEncoder().encode(packet.wire).byteLength
            : packet.wire.byteLength;
        this.movePacket(packet, lane);
        this.replayed++;
      } catch {
        this.close();
        return;
      }
      if (++count === 8) break;
    }
  }
  private receipt(sequence: number) {
    if (!this.selective) return;
    this.receipts.push(sequence);
    if (this.receipts.length >= 4) this.flushReceipts();
    else if (!this.receiptTimer)
      this.receiptTimer = setTimeout(() => this.flushReceipts(), 25);
  }
  private flushReceipts() {
    clearTimeout(this.receiptTimer);
    this.receiptTimer = undefined;
    if (this.stopped || !this.receipts.length) return;
    const received = this.receipts;
    this.receipts = [];
    if (this.readyState === 'open')
      this.primary.send(
        JSON.stringify({ type: 'pg-striped-receipt', received }),
      );
  }
  private deliver(data: Payload) {
    if (typeof data === 'string') this.observeFileControl(JSON.parse(data));
    if (typeof data !== 'string') {
      this.deliveredBytes += data.byteLength;
      this.lastDeliveryAt = performance.now();
    }
    this.onmessage?.call(this.primary, new MessageEvent('message', { data }));
  }
  private observeFileControl(value: { type?: string; duplicate?: boolean }) {
    if (value.type === 'start') {
      this.fileActive = true;
      this.linkTest.cancel('File transfer started.');
      this.dispatchEvent(new Event('file-transfer-start'));
    }
    if (
      ['result', 'cancel', 'error', 'complete'].includes(value.type ?? '') ||
      (value.type === 'ready' && value.duplicate)
    )
      this.fileActive = false;
  }
  private receive(data: unknown, bulk: boolean, channel: RTCDataChannel) {
    if (this.stopped) return;
    if (
      this.linkTest.supported &&
      (bulk || !this.fileActive || this.receiving) &&
      data instanceof ArrayBuffer &&
      data.byteLength >= 4 &&
      new DataView(data).getUint32(0) === LINK_TEST_MAGIC
    ) {
      try {
        this.linkTest.receiveBytes(data, channel);
      } catch {
        this.linkTest.cancel('Peer test interrupted.', false);
      }
      return;
    }
    if (data instanceof ArrayBuffer) {
      let path = this.incomingPaths.get(channel);
      if (!path) {
        path = {
          bytes: 0,
          sampledBytes: 0,
          sampledAt: performance.now(),
          rate: 0,
        };
        this.incomingPaths.set(channel, path);
      }
      path.bytes += data.byteLength;
    }
    try {
      if (typeof data === 'string') {
        if (data.length > 32000) throw new Error('Transfer control too large.');
        const value = JSON.parse(data);
        if (value.type === 'hello') {
          if (value.version === VERSION)
            this.peerPhone = peerDevice(value.deviceKind) === 'phone';
          this.linkTest.supported =
            value.version === VERSION && value.peerLinkTest === 1;
          this.dispatchEvent(new Event('linktestchange'));
          if (value.version === VERSION)
            this.sourceStatusEnabled = value.sourceStatus === 1;
          if (value.version === VERSION)
            this.dispatchEvent(
              new CustomEvent('peer-device', {
                detail: peerDevice(value.deviceKind),
              }),
            );
          if (
            !this.negotiated &&
            value.version === VERSION &&
            value.stripedTransport === 1
          ) {
            this.negotiated = true;
            this.selective = value.stripedReceipts === 1;
            this.negotiatedFrameBytes =
              Number.isSafeInteger(value.stripedFrameBytes) &&
              value.stripedFrameBytes >= FRAME_BYTES
                ? Math.min(STRIPED_FRAME_BYTES, value.stripedFrameBytes)
                : FRAME_BYTES;
            this.laneCount =
              Number.isInteger(value.stripedLanes) && value.stripedLanes >= 1
                ? Math.min(MAX_LANES, value.stripedLanes)
                : LANES;
            this.bufferedAmountLowThreshold = this.threshold;
            if (this.role === 'send') void this.offerLanes();
          }
          this.deliver(data);
        } else if (value.type === 'pg-link-test') {
          if (!bulk) this.linkTest.receiveControl(value);
        } else if (value.type === 'pg-source-status') {
          const now = performance.now();
          if (
            !bulk &&
            this.role === 'receive' &&
            this.sourceStatusEnabled &&
            now - this.lastSourceStatusReceived >= 1000
          ) {
            const status = sourceStatus(value.status);
            if (status) {
              this.peerSourceStatus = status;
              this.lastSourceStatusReceived = now;
              if (status.batch && status.batch.phase !== 'running')
                this.dispatchEvent(new Event('source-status'));
            }
          }
        } else if (value.type === 'pg-lane') {
          if (
            !this.negotiated ||
            !Number.isInteger(value.index) ||
            value.index < 0 ||
            value.index >= this.laneCount
          )
            return;
          let lane: Lane;
          try {
            lane = this.lane(value.index);
          } catch {
            return;
          }
          if (++lane.signals > 70 || lane.failed) return;
          this.signaling = this.signaling
            .then(() => this.signal(lane, value))
            .catch(() => this.failLane(lane));
        } else if (value.type === 'pg-striped-start') {
          if (!this.negotiated || this.role !== 'receive' || this.receiving)
            throw new Error('Invalid parallel transfer start.');
          this.receiving = true;
          this.flush();
        } else if (value.type === 'pg-striped-control') {
          if (typeof value.value !== 'string' || value.value.length > 12000)
            throw new Error('Invalid parallel control.');
          this.reorder(value.sequence, value.value);
        } else if (value.type === 'pg-striped-receipt') {
          if (
            !this.selective ||
            this.role !== 'send' ||
            !Array.isArray(value.received) ||
            value.received.length > 16 ||
            value.received.some(
              (sequence: unknown) =>
                !Number.isSafeInteger(sequence) ||
                (sequence as number) < 0 ||
                (sequence as number) >= this.outgoing,
            )
          )
            throw new Error('Invalid parallel receipt.');
          for (const sequence of value.received) this.received(sequence);
          this.dispatchEvent(new Event('bufferedamountlow'));
        } else if (value.type === 'pg-striped-ack') {
          if (
            !Number.isInteger(value.sequence) ||
            value.sequence < 0 ||
            value.sequence < this.acknowledged ||
            value.sequence >= this.outgoing
          )
            throw new Error('Invalid parallel acknowledgment.');
          this.acknowledged = value.sequence;
          for (const [sequence] of this.pending)
            if (sequence <= value.sequence) {
              this.received(sequence);
            }
          this.dispatchEvent(new Event('bufferedamountlow'));
        } else if (!bulk) this.deliver(data);
        else throw new Error('Unexpected bulk control.');
      } else if (data instanceof ArrayBuffer) {
        if (!bulk && !this.receiving) this.deliver(data);
        else {
          if (data.byteLength < 9 || data.byteLength > this.frameBytes + 8)
            throw new Error('Invalid parallel frame.');
          const header = new DataView(data);
          if (header.getUint32(0) !== MAGIC)
            throw new Error('Invalid parallel frame.');
          this.reorder(header.getUint32(4), new Uint8Array(data, 8));
        }
      } else throw new Error('Unexpected transfer data.');
    } catch {
      this.close();
    }
  }
  private reorder(sequence: number, data: Payload) {
    if (
      !this.negotiated ||
      this.role !== 'receive' ||
      !Number.isInteger(sequence) ||
      sequence < 0 ||
      sequence > 0xffffffff
    )
      throw new Error('Invalid parallel sequence.');
    if (sequence < this.incoming || this.reordered.has(sequence)) {
      this.receipt(sequence);
      return;
    }
    const size = typeof data === 'string' ? data.length : data.byteLength;
    if (
      sequence - this.incoming > TRANSFER_WINDOW_BYTES / FRAME_BYTES + 32 ||
      this.reordered.size >= TRANSFER_WINDOW_BYTES / FRAME_BYTES + 32 ||
      this.reorderedBytes + size >
        TRANSFER_WINDOW_BYTES + this.frameBytes + 32000
    )
      throw new Error('Parallel receive buffer exceeded.');
    this.reordered.set(sequence, data);
    this.reorderedBytes += size;
    this.receipt(sequence);
    this.flush();
  }
  private flush() {
    if (!this.receiving) return;
    let control = false;
    while (this.reordered.has(this.incoming)) {
      const data = this.reordered.get(this.incoming)!;
      this.reordered.delete(this.incoming++);
      this.reorderedBytes -=
        typeof data === 'string' ? data.length : data.byteLength;
      control ||= typeof data === 'string';
      this.deliver(data);
    }
    if (
      this.incoming - 1 > this.lastAck &&
      (control || this.incoming - 1 - this.lastAck >= 16)
    ) {
      this.lastAck = this.incoming - 1;
      this.primary.send(
        JSON.stringify({ type: 'pg-striped-ack', sequence: this.lastAck }),
      );
    }
  }
  private lane(index: number) {
    const existing = this.lanes.get(index);
    if (existing) return existing;
    const pc = new RTCPeerConnection({
      iceServers: [
        { urls: 'stun:stun.cloudflare.com:3478' },
        { urls: 'stun:stun.l.google.com:19302' },
      ],
    });
    const lane: Lane = {
      pc,
      inbox: new CandidateInbox(pc),
      timer: setTimeout(() => this.failLane(lane), 5000),
      failed: false,
      signals: 0,
      lanRoute: this.senderAddress
        ? new LanRoute(pc, this.senderAddress)
        : undefined,
    };
    this.lanes.set(index, lane);
    pc.onicecandidate = ({ candidate }) => {
      if (candidate && !lane.failed && this.readyState === 'open')
        this.primary.send(
          JSON.stringify({
            type: 'pg-lane',
            index,
            candidate: candidate.toJSON(),
          }),
        );
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') this.failLane(lane);
    };
    pc.ondatachannel = ({ channel }) => this.attach(lane, channel);
    return lane;
  }
  private attach(lane: Lane, channel: RTCDataChannel) {
    if (
      lane.failed ||
      lane.channel ||
      channel.label !== 'pixelgate-bulk-v1' ||
      channel.ordered !== !this.selective ||
      channel.maxRetransmits !== null ||
      channel.maxPacketLifeTime !== null
    ) {
      channel.close();
      return;
    }
    lane.channel = channel;
    channel.binaryType = 'arraybuffer';
    channel.bufferedAmountLowThreshold = this.threshold / (this.laneCount + 1);
    channel.onmessage = ({ data }) => this.receive(data, true, channel);
    channel.addEventListener('open', () => {
      clearTimeout(lane.timer);
      lane.lanRoute?.stop();
      this.dispatchEvent(new Event('laneschanged'));
    });
    channel.addEventListener('bufferedamountlow', () =>
      this.dispatchEvent(new Event('bufferedamountlow')),
    );
    channel.addEventListener('close', () => this.failLane(lane));
  }
  private offerLanes() {
    // Serialize setup, including optional expansion requested between files.
    this.offering = this.offering.then(async () => {
      for (let index = 0; index < this.targetLanes; index++) {
        if (this.stopped || this.readyState !== 'open') return;
        if (!this.lanes.has(index)) await this.offer(index);
      }
    });
    return this.offering;
  }
  private async offer(index: number) {
    let lane: Lane | undefined;
    try {
      lane = this.lane(index);
      this.attach(
        lane,
        lane.pc.createDataChannel('pixelgate-bulk-v1', {
          ordered: !this.selective,
        }),
      );
      await lane.pc.setLocalDescription(await lane.pc.createOffer());
      if (!lane.failed && this.readyState === 'open')
        this.primary.send(
          JSON.stringify({
            type: 'pg-lane',
            index,
            description: lane.pc.localDescription,
          }),
        );
    } catch {
      if (lane) this.failLane(lane);
    }
  }
  private async signal(
    lane: Lane,
    value: { index: number; candidate?: unknown; description?: unknown },
  ) {
    if (lane.failed || this.stopped) return;
    if (value.candidate) {
      lane.inbox.receive(value.candidate);
      return;
    }
    if (lane.pc.remoteDescription) return;
    const description = JSON.parse(
      validateSignal(
        value.description,
        this.role === 'receive' ? 'offer' : 'answer',
      ),
    );
    await lane.pc.setRemoteDescription(description);
    lane.inbox.ready();
    if (this.role === 'receive') {
      await lane.pc.setLocalDescription(await lane.pc.createAnswer());
      if (!lane.failed && this.readyState === 'open')
        this.primary.send(
          JSON.stringify({
            type: 'pg-lane',
            index: value.index,
            description: lane.pc.localDescription,
          }),
        );
    }
  }
  private dispose(lane: Lane) {
    clearTimeout(lane.timer);
    lane.lanRoute?.stop();
    lane.inbox.stop();
    lane.pc.close();
  }
  private failLane(lane: Lane) {
    if (lane.failed) return;
    lane.failed = true;
    this.dispose(lane);
    if (!this.stopped && this.readyState === 'open') {
      for (const packet of this.pending.values())
        if (packet.lane === lane.channel) {
          this.movePacket(packet, this.primary);
          this.replayed++;
          try {
            this.write(this.primary, packet.wire);
          } catch {
            this.close();
            return;
          }
        }
      this.dispatchEvent(new Event('bufferedamountlow'));
      this.dispatchEvent(new Event('laneschanged'));
    }
  }
}

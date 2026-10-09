import { CandidateInbox } from './candidate-inbox';
import { validateSignal } from '../pairing-validation';
import {
  CHECKPOINT_BYTES,
  FRAME_BYTES,
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
> & { prepare?: () => Promise<void>; receiveWindowBytes?: number };
const MAGIC = 0x50475331;
const LANES = 2;
type Lane = {
  pc: RTCPeerConnection;
  inbox: CandidateInbox;
  channel?: RTCDataChannel;
  timer: ReturnType<typeof setTimeout>;
  failed: boolean;
  signals: number;
};
type Packet = {
  wire: string | ArrayBuffer;
  lane: RTCDataChannel;
  size: number;
};

/** Independent SCTP connections; restore the existing engine's ordered stream. */
export class StripedChannel extends EventTarget implements TransferChannel {
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
  private reordered = new Map<number, string | ArrayBuffer>();
  private reorderedBytes = 0;
  private threshold = 0;
  private stopped = false;
  private signaling = Promise.resolve();
  constructor(
    private primary: RTCDataChannel,
    private role: 'send' | 'receive',
  ) {
    super();
    primary.onmessage = ({ data }) => this.receive(data, false);
    primary.addEventListener('bufferedamountlow', () =>
      this.dispatchEvent(new Event('bufferedamountlow')),
    );
    primary.addEventListener('close', () => {
      this.stopped = true;
      for (const lane of this.lanes.values()) this.dispose(lane);
      this.pending.clear();
      this.pendingBytes = 0;
      this.reordered.clear();
      this.dispatchEvent(new Event('close'));
    });
  }
  get readyState() {
    return this.primary.readyState;
  }
  get bufferedAmount() {
    return (
      this.primary.bufferedAmount +
      [...this.lanes.values()].reduce(
        (total, lane) =>
          total + (lane.failed ? 0 : (lane.channel?.bufferedAmount ?? 0)),
        0,
      )
    );
  }
  get bufferedAmountLowThreshold() {
    return this.threshold;
  }
  get receiveWindowBytes() {
    return this.receiving ? TRANSFER_WINDOW_BYTES : CHECKPOINT_BYTES;
  }
  async prepare() {
    if (!this.negotiated || this.openLanes().length === LANES) return;
    await new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        this.removeEventListener('laneschanged', changed);
        this.removeEventListener('close', finish);
        resolve();
      };
      const changed = () => {
        if (
          this.openLanes().length === LANES ||
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
    this.primary.bufferedAmountLowThreshold = value / (LANES + 1);
    for (const lane of this.lanes.values())
      if (lane.channel)
        lane.channel.bufferedAmountLowThreshold = value / (LANES + 1);
  }
  send(data: string | Blob | ArrayBuffer | ArrayBufferView<ArrayBuffer>) {
    if (typeof data === 'string') {
      const value = JSON.parse(data);
      if (value.type === 'hello')
        data = JSON.stringify({ ...value, stripedTransport: 1 });
    }
    if (
      !this.sending &&
      this.role === 'send' &&
      this.negotiated &&
      this.openLanes().length === LANES
    ) {
      this.primary.send(JSON.stringify({ type: 'pg-striped-start' }));
      this.sending = true;
    }
    if (!this.sending) {
      Reflect.apply(this.primary.send, this.primary, [data]);
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
      if (bytes.length < 1 || bytes.length > FRAME_BYTES)
        throw new Error('Invalid transfer frame.');
      const frame = new Uint8Array(8 + bytes.length);
      const header = new DataView(frame.buffer);
      header.setUint32(0, MAGIC);
      header.setUint32(4, sequence);
      frame.set(bytes, 8);
      wire = frame.buffer;
      const available = [this.primary, ...this.openLanes()];
      channel = available.reduce((best, current) =>
        current.bufferedAmount < best.bufferedAmount ? current : best,
      );
    }
    // Retain bounded unreceived packets for retransmission if a lane closes.
    const size = typeof wire === 'string' ? wire.length : wire.byteLength;
    if (
      this.pending.size >= TRANSFER_WINDOW_BYTES / FRAME_BYTES + 32 ||
      this.pendingBytes + size > TRANSFER_WINDOW_BYTES + 64000
    )
      throw new Error('Parallel transfer buffer exceeded.');
    this.pendingBytes += size;
    this.pending.set(sequence, {
      wire,
      lane: channel,
      size,
    });
    Reflect.apply(channel.send, channel, [wire]);
  }
  close() {
    this.primary.close();
  }
  private openLanes() {
    return [...this.lanes.values()].flatMap((lane) =>
      !lane.failed && lane.channel?.readyState === 'open' ? [lane.channel] : [],
    );
  }
  private deliver(data: string | ArrayBuffer) {
    this.onmessage?.call(this.primary, new MessageEvent('message', { data }));
  }
  private receive(data: unknown, bulk: boolean) {
    if (this.stopped) return;
    try {
      if (typeof data === 'string') {
        if (data.length > 32000) throw new Error('Transfer control too large.');
        const value = JSON.parse(data);
        if (value.type === 'hello') {
          if (
            !this.negotiated &&
            value.version === VERSION &&
            value.stripedTransport === 1
          ) {
            this.negotiated = true;
            if (this.role === 'send')
              for (let index = 0; index < LANES; index++)
                void this.offer(index);
          }
          this.deliver(data);
        } else if (value.type === 'pg-lane') {
          if (
            !this.negotiated ||
            !Number.isInteger(value.index) ||
            value.index < 0 ||
            value.index >= LANES
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
        } else if (value.type === 'pg-striped-ack') {
          if (
            !Number.isInteger(value.sequence) ||
            value.sequence < 0 ||
            value.sequence < this.acknowledged ||
            value.sequence >= this.outgoing
          )
            throw new Error('Invalid parallel acknowledgment.');
          this.acknowledged = value.sequence;
          for (const [sequence, packet] of this.pending)
            if (sequence <= value.sequence) {
              this.pending.delete(sequence);
              this.pendingBytes -= packet.size;
            }
        } else if (!bulk) this.deliver(data);
        else throw new Error('Unexpected bulk control.');
      } else if (data instanceof ArrayBuffer) {
        if (!bulk && !this.receiving) this.deliver(data);
        else {
          if (data.byteLength < 9 || data.byteLength > FRAME_BYTES + 8)
            throw new Error('Invalid parallel frame.');
          const header = new DataView(data);
          if (header.getUint32(0) !== MAGIC)
            throw new Error('Invalid parallel frame.');
          this.reorder(header.getUint32(4), data.slice(8));
        }
      } else throw new Error('Unexpected transfer data.');
    } catch {
      this.close();
    }
  }
  private reorder(sequence: number, data: string | ArrayBuffer) {
    if (
      !this.negotiated ||
      this.role !== 'receive' ||
      !Number.isInteger(sequence) ||
      sequence < 0 ||
      sequence > 0xffffffff
    )
      throw new Error('Invalid parallel sequence.');
    if (sequence < this.incoming || this.reordered.has(sequence)) return;
    const size = typeof data === 'string' ? data.length : data.byteLength;
    if (
      sequence - this.incoming > TRANSFER_WINDOW_BYTES / FRAME_BYTES + 32 ||
      this.reordered.size >= TRANSFER_WINDOW_BYTES / FRAME_BYTES + 32 ||
      this.reorderedBytes + size > TRANSFER_WINDOW_BYTES + 32000
    )
      throw new Error('Parallel receive buffer exceeded.');
    this.reordered.set(sequence, data);
    this.reorderedBytes += size;
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
      !channel.ordered ||
      channel.maxRetransmits !== null ||
      channel.maxPacketLifeTime !== null
    ) {
      channel.close();
      return;
    }
    lane.channel = channel;
    channel.binaryType = 'arraybuffer';
    channel.bufferedAmountLowThreshold = this.threshold / (LANES + 1);
    channel.onmessage = ({ data }) => this.receive(data, true);
    channel.addEventListener('open', () => {
      clearTimeout(lane.timer);
      this.dispatchEvent(new Event('laneschanged'));
    });
    channel.addEventListener('bufferedamountlow', () =>
      this.dispatchEvent(new Event('bufferedamountlow')),
    );
    channel.addEventListener('close', () => this.failLane(lane));
  }
  private async offer(index: number) {
    let lane: Lane | undefined;
    try {
      lane = this.lane(index);
      this.attach(
        lane,
        lane.pc.createDataChannel('pixelgate-bulk-v1', { ordered: true }),
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
          packet.lane = this.primary;
          try {
            Reflect.apply(this.primary.send, this.primary, [packet.wire]);
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

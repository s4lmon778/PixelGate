import type { TransferChannel } from './striped-channel';
import { CHECKPOINT_BYTES, TRANSFER_WINDOW_BYTES } from './model';
import { LINK_TEST_MAGIC, PeerLinkTest } from './peer-link-test';
import { deviceKind, peerDevice } from './device';
import {
  sourceStatus,
  type SourceState,
  type SourceStatus,
} from './source-status';

export const HTTP_API = '/api/speedgate/v1';
export type HttpCredentials = { id: string; token: string };
export async function httpRequest(
  path: string,
  credentials?: HttpCredentials,
  init: RequestInit = {},
) {
  const response = await fetch(HTTP_API + path, {
    ...init,
    cache: 'no-store',
    credentials: 'omit',
    redirect: 'error',
    headers: {
      ...(credentials ? { Authorization: `Bearer ${credentials.token}` } : {}),
      ...init.headers,
    },
  });
  if (!response.ok) {
    // Bound error text; a failed HTML/static host response isn't a protocol reply.
    throw new Error(
      `HTTP transfer failed (${response.status}). Reconnect to resume from the receiver’s saved checkpoint.`,
    );
  }
  return response;
}
export async function closeHttpRoom(credentials: HttpCredentials) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2500);
  try {
    await httpRequest(`/rooms/${credentials.id}/close`, credentials, {
      method: 'POST',
      signal: controller.signal,
    });
  } catch {
    /* Closing is best effort; the streaming connection also revokes the room. */
  } finally {
    clearTimeout(timer);
  }
}
type Packet = {
  sequence: number;
  body: string | Uint8Array<ArrayBuffer>;
  bytes: number;
  kind: number;
};

/** Reliable ordered protocol over bounded parallel binary HTTP POSTs and a streaming GET.
 * POST completion is network delivery only. The transfer engine's durable ACKs
 * remain the sole authority for progress, credit and interrupted-file recovery.
 */
export class HttpChannel extends EventTarget implements TransferChannel {
  readonly transport = 'http' as const;
  readonly linkTest: PeerLinkTest;
  onmessage: RTCDataChannel['onmessage'] = null;
  readyState: RTCDataChannelState = 'open';
  bufferedAmountLowThreshold = 32 * 1024;
  readonly frameBytes = CHECKPOINT_BYTES;
  readonly sendFrameBytes = CHECKPOINT_BYTES;
  readonly burstBytes = CHECKPOINT_BYTES;
  readonly pacingDelayMs = 0;
  private parallel = 2;
  private sequence = 0;
  private queue: Packet[] = [];
  private active = 0;
  private buffered = 0;
  private controller = new AbortController();
  private fileActive = false;
  private delivered = 0;
  private uploaded = 0;
  private lastDelivery = 0;
  private started = performance.now();
  private source?: SourceStatus;
  private sourceReceivedAt = 0;
  private lastSource = -Infinity;
  private device?: string;
  get peerKind() {
    return peerDevice(this.device);
  }
  constructor(
    private credentials: HttpCredentials,
    private role: 'send' | 'receive',
  ) {
    super();
    // Reuse the opt-in peer speed check over the HTTP stream, with its own
    // bounded credit. It does not invoke file storage or hash verification.
    this.linkTest = new PeerLinkTest(
      role,
      () => [this as unknown as RTCDataChannel],
      (message) => this.send(JSON.stringify(message)),
      () => this.dispatchEvent(new Event('linktestchange')),
    );
    this.linkTest.supported = true;
  }
  get bufferedAmount() {
    return this.buffered;
  }
  get sendBufferBytes() {
    return this.parallel * CHECKPOINT_BYTES;
  }
  get receiveWindowBytes() {
    return Math.min(TRANSFER_WINDOW_BYTES, 4 * CHECKPOINT_BYTES);
  }
  get hasActiveFile() {
    return this.fileActive;
  }
  get canLimitPayload() {
    return this.role === 'send';
  }
  setPayloadLimit(limit = 2) {
    if (
      !this.canLimitPayload ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 4
    )
      throw new Error('HTTP concurrency must be 1–4 on the sender.');
    if (this.fileActive || this.buffered || this.linkTest.snapshot().running)
      throw new Error(
        'Finish the transfer or speed test before changing concurrency.',
      );
    this.parallel = limit;
    this.dispatchEvent(new Event('linktestchange'));
  }
  snapshot() {
    return {
      transport: 'http-tcp',
      mode: 'http-stream',
      connections: 1,
      reorderedBytes: 0,
      deliveredBytes: this.delivered,
      uploadedBytes: this.uploaded,
      deliveryIdleMs: this.lastDelivery
        ? Math.round(performance.now() - this.lastDelivery)
        : 0,
      frameBytes: this.frameBytes,
      sendBufferBytes: this.sendBufferBytes,
      queuedBytes: this.buffered,
      parallelRequests: this.parallel,
      elapsedMs: Math.round(performance.now() - this.started),
      measurement:
        this.role === 'send' ? 'http-post-completion' : 'receiver-wire-bytes',
      linkTest: this.linkTest.snapshot(),
      ...(this.source
        ? {
            source: {
              stage: this.source.stage,
              stageElapsedMs: this.source.stageElapsedMs,
              paused: this.source.paused,
              visibility: this.source.visibility,
              sourceReads: this.source.sourceReads,
              batch: this.source.batch,
              stageTimes: this.source.stageTimes,
              networkQueuedBytes: this.source.unreceivedBytes,
              sendBufferBytes: this.source.sendBufferBytes,
              frameBytes: this.source.sendFrameBytes,
              measurement: 'http-request-queue',
              sampleAgeMs: Math.round(
                performance.now() - this.sourceReceivedAt,
              ),
            },
          }
        : {}),
    };
  }
  publishSourceStatus(state: SourceState, final = false) {
    if (
      this.role !== 'send' ||
      this.readyState !== 'open' ||
      (!final && performance.now() - this.lastSource < 2000)
    )
      return;
    const status = sourceStatus({
      ...state,
      connections: 1,
      unreceivedBytes: this.buffered,
      oldestUnreceivedMs: 0,
      receiptDelayMs: 0,
      queuedDelayMs: 0,
      replayedPackets: 0,
      sendBufferBytes: this.sendBufferBytes,
      sendFrameBytes: this.sendFrameBytes,
      deprioritizedConnections: 0,
    });
    if (!status) return;
    this.lastSource = performance.now();
    this.send(JSON.stringify({ type: 'sg-source-status', status }));
  }
  async open() {
    const response = await httpRequest(
      `/rooms/${this.credentials.id}/stream`,
      this.credentials,
      { signal: this.controller.signal },
    );
    if (!response.body)
      throw new Error(
        'This browser does not support streaming HTTP responses.',
      );
    // Caller installs the engine's handlers before consuming any hello frames.
    setTimeout(
      () => void this.read(response.body!).catch(() => this.close()),
      0,
    );
    this.send(JSON.stringify({ type: 'sg-device', device: deviceKind() }));
  }
  send(data: string | Blob | ArrayBuffer | ArrayBufferView<ArrayBuffer>) {
    if (this.readyState !== 'open')
      throw new Error('Connection closed. Reconnect to resume.');
    if (data instanceof Blob)
      throw new Error('HTTP transport requires bounded binary buffers.');
    const body =
      typeof data === 'string'
        ? data
        : data instanceof ArrayBuffer
          ? new Uint8Array(data.slice(0))
          : new Uint8Array(
              data.buffer,
              data.byteOffset,
              data.byteLength,
            ).slice();
    const bytes =
      typeof body === 'string'
        ? new TextEncoder().encode(body).byteLength
        : body.byteLength;
    // Diagnostic bytes have their own wire kind, so cancelled speed-test tails
    // cannot be mistaken for file bytes and originals never collide with magic.
    const kind =
      typeof body === 'string'
        ? 0
        : this.linkTest.snapshot().running &&
            body.byteLength === 16 * 1024 + 12 &&
            new DataView(
              body.buffer,
              body.byteOffset,
              body.byteLength,
            ).getUint32(0) === LINK_TEST_MAGIC
          ? 2
          : 1;
    if (
      bytes < 1 ||
      bytes > (kind === 0 ? 12000 : this.frameBytes) ||
      this.buffered + bytes > TRANSFER_WINDOW_BYTES + 128 * 1024 ||
      this.queue.length > 256
    )
      throw new Error('HTTP send window exceeded.');
    if (typeof data === 'string') {
      const message = JSON.parse(data);
      if (message.type === 'start') {
        this.fileActive = true;
        this.linkTest.cancel('A file transfer started.');
        this.dispatchEvent(new Event('file-transfer-start'));
      }
      if (['result', 'error', 'cancel', 'complete'].includes(message.type))
        this.fileActive = false;
    }
    this.buffered += bytes;
    this.queue.push({ sequence: this.sequence++, body, bytes, kind });
    this.pump();
  }
  private pump() {
    while (
      this.readyState === 'open' &&
      this.active < this.parallel &&
      this.queue.length
    ) {
      const packet = this.queue.shift()!;
      this.active++;
      // A stalled connection is failed, never retried blindly: replaying an
      // uncertain HTTP body could append duplicate bytes. Re-pairing resumes
      // from the receiver's committed offset instead.
      const timeout = setTimeout(() => this.close(), 120_000);
      void httpRequest(
        `/rooms/${this.credentials.id}/message?sequence=${packet.sequence}`,
        this.credentials,
        {
          method: 'POST',
          body: packet.body,
          signal: this.controller.signal,
          headers: {
            'Content-Type': packet.kind
              ? 'application/octet-stream'
              : 'application/json',
            'X-SpeedGate-Kind': String(packet.kind),
          },
        },
      )
        .then(() => {
          if (packet.kind === 1) this.uploaded += packet.bytes;
        })
        .catch(() => this.close())
        .finally(() => {
          clearTimeout(timeout);
          this.active--;
          this.buffered -= packet.bytes;
          if (this.readyState === 'open') {
            this.dispatchEvent(new Event('bufferedamountlow'));
            this.pump();
          }
        });
    }
  }
  private deliver(kind: number, bytes: Uint8Array<ArrayBuffer>) {
    if (kind === 0) {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      const message = JSON.parse(text);
      if (message.type === 'sg-device') {
        this.device = peerDevice(message.device);
        this.dispatchEvent(
          new CustomEvent('peer-device', { detail: this.device }),
        );
        return;
      }
      if (message.type === 'sg-source-status') {
        this.source = sourceStatus(message.status);
        this.sourceReceivedAt = performance.now();
        this.dispatchEvent(new Event('source-status'));
        return;
      }
      if (message.type === 'pg-link-test') {
        this.linkTest.receiveControl(message);
        return;
      }
      if (message.type === 'start') {
        this.fileActive = true;
        this.linkTest.cancel('A file transfer started.');
        this.dispatchEvent(new Event('file-transfer-start'));
      }
      if (['result', 'error', 'cancel', 'complete'].includes(message.type))
        this.fileActive = false;
      this.onmessage?.call(
        this as unknown as RTCDataChannel,
        new MessageEvent('message', { data: text }),
      );
    } else {
      if (kind === 2) {
        this.linkTest.receiveBytes(
          bytes.buffer,
          this as unknown as RTCDataChannel,
        );
        return;
      }
      this.delivered += bytes.byteLength;
      this.lastDelivery = performance.now();
      this.onmessage?.call(
        this as unknown as RTCDataChannel,
        new MessageEvent('message', { data: bytes.buffer }),
      );
    }
  }
  private async read(body: ReadableStream<Uint8Array>) {
    const reader = body.getReader();
    const header = new Uint8Array(5);
    let headerUsed = 0;
    let payload: Uint8Array<ArrayBuffer> | undefined,
      used = 0,
      kind = 0;
    try {
      while (this.readyState === 'open') {
        const { done, value } = await reader.read();
        if (done) throw new Error('HTTP stream ended.');
        let offset = 0;
        while (offset < value.length && this.readyState === 'open') {
          if (!payload) {
            const count = Math.min(5 - headerUsed, value.length - offset);
            header.set(value.subarray(offset, offset + count), headerUsed);
            headerUsed += count;
            offset += count;
            if (headerUsed !== 5) continue;
            kind = header[0];
            const size = new DataView(header.buffer).getUint32(1);
            if (
              ![0, 1, 2].includes(kind) ||
              !size ||
              size > (kind === 0 ? 12000 : this.frameBytes)
            )
              throw new Error('Invalid HTTP stream frame.');
            payload = new Uint8Array(size);
            used = 0;
          }
          const count = Math.min(payload.length - used, value.length - offset);
          payload.set(value.subarray(offset, offset + count), used);
          offset += count;
          used += count;
          if (used === payload.length) {
            this.deliver(kind, payload);
            payload = undefined;
            headerUsed = 0;
          }
        }
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
  close() {
    if (this.readyState === 'closed') return;
    this.readyState = 'closed';
    this.controller.abort();
    this.buffered -= this.queue.reduce(
      (total, packet) => total + packet.bytes,
      0,
    );
    this.queue = [];
    this.linkTest.cancel('Connection closed.', false);
    this.dispatchEvent(new Event('close'));
    void closeHttpRoom(this.credentials);
  }
}

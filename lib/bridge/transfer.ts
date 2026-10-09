import { local } from './database';
import { hashFile, identity } from './hash';
import type { TransferChannel } from './striped-channel';
import {
  CHECKPOINT_BYTES,
  FRAME_BYTES,
  TRANSFER_WINDOW_BYTES,
  VERSION,
  isVerified,
  safePath,
  validateRecord,
  type Control,
  type QueuedFile,
  type RecordFile,
} from './model';
import {
  StagingWriter,
  capacity,
  existingDestination,
  removeStaged,
  saveToFolder,
  stagedFile,
  storedCopyValid,
} from './storage';

function control(channel: TransferChannel, value: Control) {
  if (channel.readyState !== 'open')
    throw new Error('Connection lost. Reconnect to resume.');
  channel.send(JSON.stringify(value));
}
function parse(value: string): Control {
  if (value.length > 12000) throw new Error('Control message too large.');
  const data = JSON.parse(value);
  if (!data || typeof data !== 'object' || typeof data.type !== 'string')
    throw new Error('Invalid transfer message.');
  return data;
}
const SEND_BUFFER_BYTES = 64 * 1024;
const RESPONSE_TIMEOUT_MS = 30 * 60 * 1000;

export class Receiver {
  private writer = new StagingWriter();
  private active?: RecordFile;
  private buffer = new Uint8Array(CHECKPOINT_BYTES);
  private buffered = 0;
  private chain = Promise.resolve();
  private queued = 0;
  private queuedBytes = 0;
  private closed = false;
  private compatible = false;
  private failed = false;
  constructor(
    private channel: TransferChannel,
    private folder: () => FileSystemDirectoryHandle | undefined,
    private changed: (r: RecordFile) => void,
    private error: (e: Error) => void,
    private completed?: () => void,
  ) {
    channel.onmessage = (event) => {
      if (this.closed) return;
      const bytes =
        event.data instanceof ArrayBuffer ? event.data.byteLength : 0;
      if (
        this.queued + 1 > TRANSFER_WINDOW_BYTES / FRAME_BYTES + 32 ||
        this.queuedBytes + bytes > TRANSFER_WINDOW_BYTES
      ) {
        this.error(new Error('Sender exceeded the receiving buffer.'));
        channel.close();
        return;
      }
      this.queued++;
      this.queuedBytes += bytes;
      this.chain = this.chain
        .then(async () => {
          if (this.closed) return;
          try {
            if (typeof event.data === 'string')
              await this.message(parse(event.data));
            else await this.frame(event.data);
          } catch (error) {
            await this.fail(error as Error);
          }
        })
        .finally(() => {
          this.queued--;
          this.queuedBytes -= bytes;
        });
    };
    channel.addEventListener('close', () => {
      void this.close();
    });
    control(channel, { type: 'hello', version: VERSION });
  }
  private async update(record: RecordFile) {
    await local.put(record);
    this.active = record;
    this.changed(record);
  }
  private async message(message: Control) {
    if (message.type === 'hello') {
      if (message.version !== VERSION)
        throw new Error('Protocol version mismatch. Reload both devices.');
      this.compatible = true;
      return;
    }
    if (!this.compatible) throw new Error('Transfer handshake required.');
    if (message.type === 'start') {
      if (
        this.active &&
        ['transferring', 'verifying'].includes(this.active.phase)
      )
        throw new Error('Another file is already active.');
      this.failed = false;
      const manifest = validateRecord(message.file);
      if (
        manifest.id !== (await identity(manifest.sha256, manifest.relativePath))
      )
        throw new Error('File identity does not match its manifest.');
      this.active = manifest;
      const old = await local.get(manifest.id);
      await local.session({
        id: manifest.sessionId,
        created: Date.now(),
        role: 'receive',
      });
      const folder = this.folder();
      if (folder) {
        const destination = await existingDestination(
          folder,
          manifest,
          old?.destinationPath,
        );
        if (destination) {
          await this.update(destination);
          control(this.channel, {
            type: 'ready',
            id: destination.id,
            offset: destination.size,
            duplicate: true,
            scope: 'destination',
          });
          return;
        }
      }
      if (old && isVerified(old) && (await storedCopyValid(old))) {
        let result = { ...old, sessionId: manifest.sessionId };
        if (this.folder()) result = await saveToFolder(this.folder()!, result);
        else result = { ...result, scope: 'browser', phase: 'duplicate' };
        await this.update(result);
        control(this.channel, {
          type: 'ready',
          id: result.id,
          offset: result.size,
          duplicate: true,
          scope: result.scope,
        });
        return;
      }
      let offset =
        old && old.sha256 === manifest.sha256 && old.size === manifest.size
          ? old.bytes
          : 0;
      try {
        const blob = await stagedFile(manifest.id);
        if (blob.size < offset || offset > manifest.size) offset = 0;
      } catch {
        offset = 0;
      }
      await capacity(Math.max(0, manifest.size - offset));
      await this.writer.open(manifest.id, offset);
      this.buffered = 0;
      await this.update({ ...manifest, bytes: offset, phase: 'transferring' });
      control(this.channel, {
        type: 'ready',
        id: manifest.id,
        offset,
        receiveWindowBytes:
          this.channel.receiveWindowBytes ?? TRANSFER_WINDOW_BYTES,
      });
    } else if (message.type === 'finish') {
      const record = this.active;
      if (
        !record ||
        record.id !== message.id ||
        record.bytes !== record.size ||
        this.buffered
      )
        throw new Error('File is incomplete. Resume before verification.');
      await this.writer.close();
      await this.update({ ...record, phase: 'verifying' });
      const stored = await stagedFile(record.id);
      const sha = await hashFile(stored);
      if (stored.size !== record.size || sha !== record.sha256) {
        await removeStaged(record.id);
        await this.update({
          ...record,
          bytes: 0,
          phase: 'failed',
          scope: 'none',
          error: `Integrity verification failed. Expected ${record.sha256}; stored ${sha}. Retry required.`,
        });
        control(this.channel, {
          type: 'error',
          id: record.id,
          message:
            'Stored bytes failed integrity verification. Partial copy removed. Retry required.',
        });
        return;
      }
      let result: RecordFile = {
        ...record,
        phase: 'verified',
        scope: 'browser',
        updated: Date.now(),
        error: undefined,
      };
      if (this.folder()) {
        try {
          result = await saveToFolder(this.folder()!, result);
        } catch {
          result.error =
            'Browser copy verified. Folder saving failed; choose a folder and retry saving.';
        }
      }
      await this.update(result);
      control(this.channel, { type: 'result', file: result });
    } else if (message.type === 'complete') {
      this.completed?.();
    } else if (
      message.type === 'cancel' &&
      this.active &&
      (!message.id || message.id === this.active.id)
    ) {
      await this.writer.close();
      this.buffered = 0;
      await this.update({
        ...this.active,
        phase: 'cancelled',
        error: undefined,
      });
    }
  }
  private async frame(data: unknown) {
    // Discard the remainder of a failed pipeline until the next ordered start.
    // Report the storage error once, retaining the last durable resume offset.
    if (this.failed) return;
    const record = this.active;
    if (
      !(data instanceof ArrayBuffer) ||
      !record ||
      record.phase !== 'transferring'
    )
      throw new Error('Unexpected file bytes.');
    if (
      data.byteLength < 1 ||
      data.byteLength > FRAME_BYTES ||
      this.buffered + data.byteLength > CHECKPOINT_BYTES ||
      record.bytes + this.buffered + data.byteLength > record.size
    )
      throw new Error('Invalid file frame.');
    this.buffer.set(new Uint8Array(data), this.buffered);
    this.buffered += data.byteLength;
    if (
      this.buffered === CHECKPOINT_BYTES ||
      record.bytes + this.buffered === record.size
    ) {
      const length = this.buffered;
      await this.writer.write(
        record.bytes,
        this.buffer.slice(0, length).buffer,
      );
      this.buffered = 0;
      await this.update({
        ...record,
        bytes: record.bytes + length,
        updated: Date.now(),
      });
      control(this.channel, {
        type: 'ack',
        id: record.id,
        offset: record.bytes + length,
      });
    }
  }
  private async fail(error: Error) {
    if (this.failed) return;
    this.failed = true;
    try {
      await this.writer.close();
    } catch {}
    this.buffered = 0;
    if (this.active) {
      const record = {
        ...this.active,
        phase: 'paused' as const,
        error: error.message,
        updated: Date.now(),
      };
      await this.update(record).catch(() => {});
      if (this.channel.readyState === 'open')
        control(this.channel, {
          type: 'error',
          id: record.id,
          message: error.message,
        });
    }
    this.error(error);
  }
  pause() {
    if (this.channel.readyState === 'open')
      control(this.channel, { type: 'pause' });
  }
  resume() {
    if (this.channel.readyState === 'open')
      control(this.channel, { type: 'resume' });
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    await this.chain;
    await this.writer.dispose();
    if (
      this.active &&
      ['transferring', 'verifying'].includes(this.active.phase)
    )
      await this.update({
        ...this.active,
        phase: 'paused',
        updated: Date.now(),
        error: 'Connection interrupted. Reconnect to resume.',
      });
  }
}

export class Sender {
  paused = false;
  private cancelAll = false;
  private cancelFile = false;
  private current?: RecordFile;
  private inbox: Control[] = [];
  private compatible = false;
  private waiting = new Set<() => void>();
  constructor(
    private channel: TransferChannel,
    private changed: (q: QueuedFile) => void,
  ) {
    channel.bufferedAmountLowThreshold = SEND_BUFFER_BYTES / 2;
    channel.addEventListener('bufferedamountlow', this.wake);
    channel.addEventListener('close', this.wake);
    channel.onmessage = ({ data }) => {
      if (typeof data !== 'string') {
        channel.close();
        return;
      }
      try {
        const message = parse(data);
        if (message.type === 'hello') {
          this.compatible = message.version === VERSION;
          if (!this.compatible) channel.close();
        } else if (message.type === 'pause') this.paused = true;
        else if (message.type === 'resume') this.paused = false;
        else {
          if (this.inbox.length > 100) channel.close();
          else this.inbox.push(message);
        }
      } catch {
        channel.close();
      }
      this.wake();
    };
    control(channel, { type: 'hello', version: VERSION });
  }
  private wake = () => {
    for (const resolve of this.waiting) resolve();
  };
  private activity(timeout = RESPONSE_TIMEOUT_MS) {
    return new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.waiting.delete(done);
        resolve();
      };
      const timer = setTimeout(done, timeout);
      this.waiting.add(done);
    });
  }
  private check() {
    if (this.cancelAll || this.cancelFile)
      throw new Error('Transfer cancelled.');
    if (this.channel.readyState !== 'open')
      throw new Error(
        'Connection lost. Reconnect and reselect your files to resume.',
      );
    const index = this.inbox.findIndex(
      (message) => message.type === 'error' && message.id === this.current?.id,
    );
    if (index !== -1) {
      const message = this.inbox.splice(index, 1)[0] as Extract<
        Control,
        { type: 'error' }
      >;
      throw new Error(message.message);
    }
  }
  private async wait(
    type: 'ready' | 'ack' | 'result',
    id: string,
  ): Promise<Control> {
    const started = Date.now();
    while (true) {
      this.check();
      const i = this.inbox.findIndex(
        (m) =>
          ('id' in m &&
            m.id === id &&
            (m.type === type || m.type === 'error')) ||
          (type === 'result' && m.type === 'result' && m.file.id === id),
      );
      if (i !== -1) {
        const m = this.inbox.splice(i, 1)[0];
        if (m.type === 'error') throw new Error(m.message);
        return m;
      }
      const remaining = RESPONSE_TIMEOUT_MS - (Date.now() - started);
      if (remaining <= 0)
        throw new Error('Receiver did not respond. Reconnect to resume.');
      await this.activity(remaining);
    }
  }
  private async unpaused() {
    while (this.paused) {
      this.check();
      await this.activity();
    }
    this.check();
  }
  private async writable() {
    while (
      this.channel.bufferedAmount >
      (this.channel.sendBufferBytes ?? SEND_BUFFER_BYTES)
    ) {
      this.check();
      // Events refill the transport promptly. A sparse fallback also supports
      // browser engines that occasionally miss bufferedamountlow notifications.
      await this.activity(1000);
    }
    await this.unpaused();
  }
  async prepare(q: QueuedFile, sessionId: string): Promise<RecordFile> {
    q.phase = 'hashing';
    q.error = undefined;
    this.changed(q);
    try {
      safePath(q.path);
      const sha256 = await hashFile(q.file);
      const id = await identity(sha256, q.path);
      const record: RecordFile = {
        id,
        sessionId,
        sha256,
        relativePath: q.path,
        originalName: q.file.name,
        size: q.file.size,
        modified: q.file.lastModified,
        mimeType: q.file.type,
        bytes: 0,
        phase: 'ready',
        scope: 'none',
        updated: Date.now(),
      };
      q.record = record;
      q.phase = 'ready';
      this.changed(q);
      return record;
    } catch (error) {
      q.phase = 'failed';
      q.error = (error as Error).message;
      this.changed(q);
      throw error;
    }
  }
  async run(queue: QueuedFile[], sessionId: string) {
    this.cancelAll = false;
    await local.session({ id: sessionId, role: 'send', created: Date.now() });
    while (!this.compatible) {
      this.check();
      await this.activity();
    }
    const pending = queue.filter(
      (q) => !['verified', 'duplicate', 'cancelled'].includes(q.phase),
    );
    // Resolve preparation failures into data to avoid an unhandled prefetch rejection.
    const prepare = (q: QueuedFile) =>
      this.prepare(q, sessionId).then(
        (record) => ({ record }),
        (error) => ({ error }),
      );
    let next = pending[0] ? prepare(pending[0]) : undefined;
    for (let i = 0; i < pending.length; i++) {
      const q = pending[i];
      this.cancelFile = false;
      const prepared = await next!;
      next =
        pending[i + 1] && !this.cancelAll ? prepare(pending[i + 1]) : undefined;
      if (this.cancelAll) break;
      if ('error' in prepared) continue;
      const record = prepared.record;
      this.current = record;
      try {
        if (record.size >= 2 * CHECKPOINT_BYTES) await this.channel.prepare?.();
        await this.unpaused();
        q.phase = 'transferring';
        this.changed(q);
        control(this.channel, { type: 'start', file: record });
        const ready = (await this.wait('ready', record.id)) as Extract<
          Control,
          { type: 'ready' }
        >;
        // All old replies precede ready on an ordered channel. Drop them before
        // sending new bytes, including replies from a cancelled prior attempt.
        this.inbox = [];
        if (
          !Number.isSafeInteger(ready.offset) ||
          ready.offset < 0 ||
          ready.offset > record.size
        )
          throw new Error('Receiver sent an invalid resume offset.');
        if (ready.duplicate) {
          if (
            ready.offset !== record.size ||
            !['browser', 'destination'].includes(ready.scope ?? '')
          )
            throw new Error('Invalid duplicate acknowledgment.');
          q.record = {
            ...record,
            bytes: record.size,
            phase: 'duplicate',
            scope: ready.scope!,
            updated: Date.now(),
          };
          q.phase = 'duplicate';
        } else {
          const windowBytes =
            ready.receiveWindowBytes === undefined
              ? CHECKPOINT_BYTES
              : ready.receiveWindowBytes;
          if (
            !Number.isSafeInteger(windowBytes) ||
            windowBytes < CHECKPOINT_BYTES ||
            windowBytes > TRANSFER_WINDOW_BYTES ||
            windowBytes % CHECKPOINT_BYTES !== 0
          )
            throw new Error('Receiver sent an invalid transfer window.');
          let offset = ready.offset;
          const checkpoints: number[] = [];
          q.record = { ...record, bytes: offset, phase: 'transferring' };
          this.changed(q);
          const acknowledge = async () => {
            const ack = (await this.wait('ack', record.id)) as Extract<
              Control,
              { type: 'ack' }
            >;
            if (ack.offset !== checkpoints.shift())
              throw new Error(
                'Receiver checkpoint does not match. Reconnect to resume.',
              );
            // Progress and resume still reflect only receiver-persisted bytes.
            q.record = { ...record, bytes: ack.offset, phase: 'transferring' };
            this.changed(q);
          };
          while (offset < record.size) {
            await this.unpaused();
            while (
              checkpoints.length &&
              this.inbox.some(
                (m) =>
                  'id' in m &&
                  m.id === record.id &&
                  (m.type === 'ack' || m.type === 'error'),
              )
            )
              await acknowledge();
            if (checkpoints.length >= windowBytes / CHECKPOINT_BYTES) {
              await acknowledge();
              continue;
            }
            const end = Math.min(offset + CHECKPOINT_BYTES, record.size);
            const block = new Uint8Array(
              await q.file.slice(offset, end).arrayBuffer(),
            );
            if (block.length !== end - offset)
              throw new Error('Source file changed. Reselect it and retry.');
            const messageLimit = FRAME_BYTES;
            let burst = 0;
            for (let pos = 0; pos < block.length; pos += messageLimit) {
              await this.writable();
              this.channel.send(block.subarray(pos, pos + messageLimit));
              // bufferedAmount excludes some native SCTP/OS queues. Yield after
              // a small burst so both browsers can service packets and controls
              // instead of flooding those hidden buffers during slow start.
              burst += Math.min(messageLimit, block.length - pos);
              if (burst >= (this.channel.burstBytes ?? SEND_BUFFER_BYTES)) {
                await new Promise((resolve) => setTimeout(resolve, 4));
                burst = 0;
              }
            }
            offset = end;
            checkpoints.push(end);
          }
          while (checkpoints.length) await acknowledge();
          q.phase = 'verifying';
          this.changed(q);
          control(this.channel, { type: 'finish', id: record.id });
          const result = (await this.wait('result', record.id)) as Extract<
            Control,
            { type: 'result' }
          >;
          if (
            result.file.sha256 !== record.sha256 ||
            result.file.size !== record.size ||
            !isVerified(result.file)
          )
            throw new Error('Receiver verification response is invalid.');
          q.record = { ...result.file, sessionId };
          q.phase = result.file.phase;
        }
        await local.putSender(q.record!);
        this.changed(q);
      } catch (error) {
        q.phase =
          this.cancelFile || this.cancelAll
            ? 'cancelled'
            : this.channel.readyState !== 'open'
              ? 'paused'
              : 'failed';
        q.error = (error as Error).message;
        q.record = {
          ...(q.record ?? record),
          phase: q.phase,
          error: q.error,
          updated: Date.now(),
        };
        await local.putSender(q.record);
        this.changed(q);
        if (this.channel.readyState !== 'open') break;
      }
      this.current = undefined;
    }
    if (this.cancelAll) {
      await next;
      for (const q of pending)
        if (['pending', 'hashing', 'ready', 'paused'].includes(q.phase)) {
          q.phase = 'cancelled';
          if (q.record) {
            q.record = { ...q.record, phase: 'cancelled', updated: Date.now() };
            await local.putSender(q.record);
          }
          this.changed(q);
        }
    }
    if (this.channel.readyState === 'open' && !this.cancelAll)
      control(this.channel, { type: 'complete', sessionId });
  }
  pause() {
    this.paused = true;
    this.wake();
  }
  resume() {
    this.paused = false;
    this.wake();
  }
  cancel(currentOnly = false) {
    if (currentOnly) this.cancelFile = true;
    else this.cancelAll = true;
    this.wake();
    if (this.current && this.channel.readyState === 'open')
      control(this.channel, { type: 'cancel', id: this.current.id });
  }
}

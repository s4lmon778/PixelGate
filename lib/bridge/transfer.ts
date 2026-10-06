import { local } from './database';
import { hashFile, identity } from './hash';
import {
  CHECKPOINT_BYTES,
  FRAME_BYTES,
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

function control(channel: RTCDataChannel, value: Control) {
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
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class Receiver {
  private writer = new StagingWriter();
  private active?: RecordFile;
  private buffer = new Uint8Array(CHECKPOINT_BYTES);
  private buffered = 0;
  private chain = Promise.resolve();
  private queued = 0;
  private closed = false;
  private compatible = false;
  constructor(
    private channel: RTCDataChannel,
    private folder: () => FileSystemDirectoryHandle | undefined,
    private changed: (r: RecordFile) => void,
    private error: (e: Error) => void,
    private completed?: () => void,
  ) {
    channel.onmessage = (event) => {
      if (this.closed) return;
      if (++this.queued > 160) {
        this.error(new Error('Sender exceeded the receiving buffer.'));
        channel.close();
        return;
      }
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
        });
    };
    channel.addEventListener('close', () => {
      void this.close();
    });
    control(channel, { type: 'hello', version: VERSION });
  }
  private async update(record: RecordFile) {
    this.active = record;
    await local.put(record);
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
      control(this.channel, { type: 'ready', id: manifest.id, offset });
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
  constructor(
    private channel: RTCDataChannel,
    private changed: (q: QueuedFile) => void,
  ) {
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
    };
    control(channel, { type: 'hello', version: VERSION });
  }
  private check() {
    if (this.cancelAll || this.cancelFile)
      throw new Error('Transfer cancelled.');
    if (this.channel.readyState !== 'open')
      throw new Error(
        'Connection lost. Reconnect and reselect your files to resume.',
      );
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
      if (Date.now() - started > 30 * 60 * 1000)
        throw new Error('Receiver did not respond. Reconnect to resume.');
      await delay(20);
    }
  }
  private async unpaused() {
    while (this.paused) {
      this.check();
      await delay(100);
    }
    this.check();
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
      await delay(20);
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
          let offset = ready.offset;
          q.record = { ...record, bytes: offset, phase: 'transferring' };
          this.changed(q);
          while (offset < record.size) {
            await this.unpaused();
            const end = Math.min(offset + CHECKPOINT_BYTES, record.size);
            const block = new Uint8Array(
              await q.file.slice(offset, end).arrayBuffer(),
            );
            if (block.length !== end - offset)
              throw new Error('Source file changed. Reselect it and retry.');
            const messageLimit = FRAME_BYTES;
            for (let pos = 0; pos < block.length; pos += messageLimit) {
              this.check();
              while (this.channel.bufferedAmount > 512 * 1024) {
                this.check();
                await delay(10);
              }
              this.channel.send(block.subarray(pos, pos + messageLimit));
            }
            const ack = (await this.wait('ack', record.id)) as Extract<
              Control,
              { type: 'ack' }
            >;
            if (ack.offset !== end)
              throw new Error(
                'Receiver checkpoint does not match. Reconnect to resume.',
              );
            offset = end;
            q.record = { ...record, bytes: offset, phase: 'transferring' };
            this.changed(q);
          }
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
  }
  resume() {
    this.paused = false;
  }
  cancel(currentOnly = false) {
    if (currentOnly) this.cancelFile = true;
    else this.cancelAll = true;
    if (this.current && this.channel.readyState === 'open')
      control(this.channel, { type: 'cancel', id: this.current.id });
  }
}

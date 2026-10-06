export const VERSION = 1;
export const FRAME_BYTES = 16 * 1024;
export const CHECKPOINT_BYTES = 1024 * 1024;
export type Phase =
  | 'pending'
  | 'hashing'
  | 'ready'
  | 'transferring'
  | 'paused'
  | 'verifying'
  | 'verified'
  | 'failed'
  | 'cancelled'
  | 'duplicate';
export type Scope = 'none' | 'browser' | 'destination' | 'exported';
export interface RecordFile {
  id: string;
  sessionId: string;
  relativePath: string;
  originalName: string;
  size: number;
  sha256: string;
  mimeType: string;
  modified: number;
  bytes: number;
  phase: Phase;
  scope: Scope;
  updated: number;
  destinationPath?: string;
  error?: string;
  downloaded?: boolean;
  localRole?: 'send' | 'receive';
}
export interface Session {
  id: string;
  created: number;
  role: 'send' | 'receive';
}
export interface QueuedFile {
  key: string;
  file: File;
  path: string;
  record?: RecordFile;
  phase: Phase;
  error?: string;
}
export type Control =
  | { type: 'hello'; version: number }
  | { type: 'start'; file: RecordFile }
  | {
      type: 'ready';
      id: string;
      offset: number;
      duplicate?: boolean;
      scope?: Scope;
    }
  | { type: 'ack'; id: string; offset: number }
  | { type: 'finish'; id: string }
  | { type: 'result'; file: RecordFile }
  | { type: 'error'; id: string; message: string }
  | { type: 'pause' | 'resume' | 'cancel'; id?: string }
  | { type: 'complete'; sessionId: string };
export function safePath(value: string): string {
  if (
    !value ||
    value.length > 2048 ||
    value.startsWith('/') ||
    value.includes('\\') ||
    Array.from(value).some(
      (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
    )
  )
    throw new Error('Unsafe destination path.');
  const parts = value.split('/');
  if (
    parts.some(
      (p) => !p || p === '.' || p === '..' || p.includes(':') || p.length > 240,
    )
  )
    throw new Error('Unsafe destination path.');
  return value;
}
export function validateRecord(raw: unknown): RecordFile {
  if (!raw || typeof raw !== 'object')
    throw new Error('Invalid file manifest.');
  const f = raw as RecordFile;
  safePath(f.relativePath);
  if (
    !/^[a-f0-9]{64}$/.test(f.id) ||
    !/^[a-f0-9]{64}$/.test(f.sha256) ||
    !Number.isSafeInteger(f.size) ||
    f.size < 0 ||
    typeof f.sessionId !== 'string' ||
    f.sessionId.length > 80 ||
    typeof f.mimeType !== 'string' ||
    f.mimeType.length > 200 ||
    !Number.isFinite(f.modified)
  )
    throw new Error('Invalid file manifest.');
  return {
    ...f,
    originalName: f.relativePath.split('/').at(-1)!,
    bytes: 0,
    scope: 'none',
    phase: 'ready',
    localRole: 'receive',
    updated: Date.now(),
    error: undefined,
    downloaded: false,
    destinationPath: undefined,
  };
}
export function collisionName(name: string, n: number) {
  if (n === 1) return name;
  const i = name.lastIndexOf('.');
  return i > 0
    ? `${name.slice(0, i)} (${n})${name.slice(i)}`
    : `${name} (${n})`;
}
export function formatBytes(n: number) {
  if (!n) return '0 B';
  const i = Math.min(4, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i > 1 ? 1 : 0)} ${['B', 'KB', 'MB', 'GB', 'TB'][i]}`;
}
export function isVerified(f: RecordFile) {
  return ['verified', 'duplicate'].includes(f.phase) && f.scope !== 'none';
}

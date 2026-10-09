import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  clearConnectionReport,
  retainedConnectionReport,
  retainConnectionReport,
  type ConnectionReport,
} from '../lib/bridge/connection-report';

const key = 'pixelgate-last-connection-report';
const report: ConnectionReport = {
  version: '0.3.18',
  role: 'send',
  recordedAt: '2026-10-09T21:00:00Z',
  browser: 'Safari',
  storageMode: 'indexeddb',
  elapsedSeconds: 30,
  signaling: 'stable',
  ice: 'connected',
  gathering: 'complete',
  connection: 'connected',
  channel: 'open',
  localDescription: true,
  remoteDescription: true,
  localCandidates: { host: 1, srflx: 0, prflx: 0, relay: 0 },
  remoteCandidates: { host: 1, srflx: 0, prflx: 0, relay: 0 },
  localMdns: 1,
  remoteMdns: 0,
  lanCandidatesAdded: 0,
  statsReads: 15,
  statsErrors: 0,
  candidatePairs: { succeeded: 1 },
  stunErrors: [],
};
const entries = new Map<string, string>();
beforeEach(() => {
  entries.clear();
  vi.stubGlobal('localStorage', {
    getItem: (name: string) => entries.get(name) ?? null,
    setItem: (name: string, value: string) => entries.set(name, value),
    removeItem: (name: string) => entries.delete(name),
  });
});
afterEach(() => vi.unstubAllGlobals());

it('retains the latest report and clears only its own entry', () => {
  entries.set('unrelated-preference', 'keep');
  retainConnectionReport(report);
  expect(retainedConnectionReport()).toEqual(report);
  retainConnectionReport({ ...report, statsReads: 16 });
  expect(retainedConnectionReport()?.statsReads).toBe(16);
  clearConnectionReport();
  expect(retainedConnectionReport()).toBeUndefined();
  expect(entries.get('unrelated-preference')).toBe('keep');
});
it.each(['not json', 'null', '{"version":"0.3.18"}'])(
  'ignores an unusable retained entry: %s',
  (value) => {
    entries.set(key, value);
    expect(retainedConnectionReport()).toBeUndefined();
  },
);
it('bounds the UTF-8 size rather than only counting characters', () => {
  const oversized = { ...report, browser: '字'.repeat(6000) };
  retainConnectionReport(oversized);
  expect(entries.has(key)).toBe(false);
  entries.set(key, JSON.stringify(oversized));
  expect(retainedConnectionReport()).toBeUndefined();
});
it('allows live diagnostics when local storage is denied', () => {
  vi.stubGlobal('localStorage', {
    getItem: () => {
      throw new DOMException('Denied', 'SecurityError');
    },
    setItem: () => {
      throw new DOMException('Full', 'QuotaExceededError');
    },
    removeItem: () => {
      throw new DOMException('Denied', 'SecurityError');
    },
  });
  expect(() => retainConnectionReport(report)).not.toThrow();
  expect(retainedConnectionReport()).toBeUndefined();
  expect(() => clearConnectionReport()).not.toThrow();
});

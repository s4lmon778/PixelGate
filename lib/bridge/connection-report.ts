import type { RouteDiagnostics } from './route-diagnostics';
import type { StripedChannel } from './striped-channel';

export type ConnectionReport = RouteDiagnostics & {
  version: string;
  role: 'send' | 'receive';
  recordedAt: string;
  browser: string;
  storageMode: string;
  transfer?: ReturnType<StripedChannel['snapshot']>;
};
const KEY = 'pixelgate-last-connection-report';
const MAX_BYTES = 16 * 1024;

export function retainedConnectionReport(): ConnectionReport | undefined {
  try {
    const value = localStorage.getItem(KEY);
    if (
      !value ||
      value.length > MAX_BYTES ||
      new TextEncoder().encode(value).byteLength > MAX_BYTES
    )
      return;
    const report = JSON.parse(value);
    if (
      !/^\d+\.\d+\.\d+$/.test(report.version) ||
      !['send', 'receive'].includes(report.role) ||
      !Number.isFinite(Date.parse(report.recordedAt)) ||
      typeof report.browser !== 'string' ||
      typeof report.connection !== 'string' ||
      !Number.isFinite(report.statsReads)
    )
      return;
    return report;
  } catch {
    // Private sessions and denied storage still support live diagnostics.
    return;
  }
}

export function retainConnectionReport(report: ConnectionReport) {
  try {
    const value = JSON.stringify(report);
    if (new TextEncoder().encode(value).byteLength <= MAX_BYTES)
      localStorage.setItem(KEY, value);
  } catch {
    // Diagnostics persistence must never interfere with a file transfer.
  }
}

export function clearConnectionReport() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* Live reports remain usable. */
  }
}

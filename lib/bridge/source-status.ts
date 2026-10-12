import type { BatchTimingSnapshot } from './batch-timing';

const stages = new Set([
  'idle',
  'waiting-for-handshake',
  'preparing-source',
  'preparing-connections',
  'reading-source',
  'sending',
  'yielding-to-browser',
  'network-backpressure',
  'waiting-for-ready',
  'waiting-for-ack',
  'waiting-for-result',
]);

export type SourceReads = {
  calls: number;
  bytes: number;
  lastMs: number;
  averageMs: number;
  maximumMs: number;
  waitedMs?: number;
  maximumWaitMs?: number;
};
export type SourceState = {
  stage: string;
  stageElapsedMs: number;
  paused: boolean;
  visibility: 'visible' | 'hidden';
  sourceReads?: SourceReads;
  batch?: BatchTimingSnapshot;
};
export type SourceStatus = SourceState & {
  connections: number;
  unreceivedBytes: number;
  oldestUnreceivedMs: number;
  receiptDelayMs: number;
  queuedDelayMs: number;
  replayedPackets: number;
  sendBufferBytes: number;
  sendFrameBytes: number;
  deprioritizedConnections: number;
};

// Pick only bounded states and counts. Never forward arbitrary peer fields,
// addresses, filenames, identifiers, user agents, hashes or file bytes.
export function sourceStatus(value: unknown): SourceStatus | undefined {
  if (!value || typeof value !== 'object') return;
  const data = value as Record<string, unknown>;
  if (
    typeof data.stage !== 'string' ||
    !stages.has(data.stage) ||
    typeof data.paused !== 'boolean' ||
    !['visible', 'hidden'].includes(data.visibility as string)
  )
    return;
  const numbers = [
    'stageElapsedMs',
    'connections',
    'unreceivedBytes',
    'oldestUnreceivedMs',
    'receiptDelayMs',
    'queuedDelayMs',
    'replayedPackets',
    'sendBufferBytes',
    'sendFrameBytes',
    'deprioritizedConnections',
  ] as const;
  const counts = {} as Pick<SourceStatus, (typeof numbers)[number]>;
  for (const key of numbers) {
    const number = data[key];
    if (!Number.isSafeInteger(number) || (number as number) < 0) return;
    counts[key] = number as number;
  }
  if (counts.connections > 5 || counts.deprioritizedConnections > 5) return;
  let reads: SourceReads | undefined;
  if (data.sourceReads !== undefined) {
    if (!data.sourceReads || typeof data.sourceReads !== 'object') return;
    const input = data.sourceReads as Record<string, unknown>;
    reads = {} as SourceReads;
    for (const key of [
      'calls',
      'bytes',
      'lastMs',
      'averageMs',
      'maximumMs',
    ] as const) {
      if (!Number.isSafeInteger(input[key]) || (input[key] as number) < 0)
        return;
      reads[key] = input[key] as number;
    }
    for (const key of ['waitedMs', 'maximumWaitMs'] as const) {
      if (input[key] === undefined) continue;
      if (!Number.isSafeInteger(input[key]) || (input[key] as number) < 0)
        return;
      reads[key] = input[key] as number;
    }
  }
  let batch: BatchTimingSnapshot | undefined;
  if (data.batch !== undefined) {
    if (!data.batch || typeof data.batch !== 'object') return;
    const input = data.batch as Record<string, unknown>;
    if (!['running', 'verified', 'incomplete'].includes(input.phase as string))
      return;
    const counts = {} as Omit<BatchTimingSnapshot, 'phase'>;
    for (const key of [
      'wallElapsedMs',
      'requestedFiles',
      'requestedBytes',
      'payloadBytesSent',
      'resumedBytes',
      'skippedBytes',
      'verifiedFiles',
      'skippedFiles',
    ] as const) {
      if (!Number.isSafeInteger(input[key]) || (input[key] as number) < 0)
        return;
      counts[key] = input[key] as number;
    }
    if (
      counts.verifiedFiles + counts.skippedFiles > counts.requestedFiles ||
      counts.payloadBytesSent + counts.resumedBytes + counts.skippedBytes >
        counts.requestedBytes
    )
      return;
    if (
      input.phase === 'verified' &&
      (counts.verifiedFiles + counts.skippedFiles !== counts.requestedFiles ||
        counts.payloadBytesSent + counts.resumedBytes + counts.skippedBytes !==
          counts.requestedBytes)
    )
      return;
    batch = { phase: input.phase as BatchTimingSnapshot['phase'], ...counts };
  }
  return {
    stage: data.stage,
    paused: data.paused,
    visibility: data.visibility as SourceState['visibility'],
    ...counts,
    ...(reads ? { sourceReads: reads } : {}),
    ...(batch ? { batch } : {}),
  };
}

import { useState } from 'react';
import { ArrowDownToLine, Check, File, LoaderCircle, X } from 'lucide-react';
import {
  formatBytes,
  isVerified,
  type QueuedFile,
  type RecordFile,
} from '@/lib/bridge/model';

export const phaseLabel: Record<string, string> = {
  pending: 'Queued',
  hashing: 'Preparing',
  ready: 'Ready',
  transferring: 'Transferring',
  paused: 'Paused',
  verifying: 'Verifying',
  verified: 'Verified',
  failed: 'Needs retry',
  cancelled: 'Cancelled',
  duplicate: 'Already present',
};
export function verificationLabel(record: RecordFile) {
  if (!isVerified(record)) return phaseLabel[record.phase];
  if (record.scope === 'destination') return 'Destination verified';
  if (record.scope === 'exported') return 'Exported copy verified';
  if (record.shared) return 'App save verification pending';
  return record.downloaded
    ? 'Download verification pending'
    : 'Browser copy verified';
}

export function TransferFiles({
  records = [],
  queue,
  label,
  empty,
  selected,
  selectable,
  toggle,
  disabled = false,
  remove,
  save,
  showHashes = false,
}: {
  records?: RecordFile[];
  queue?: QueuedFile[];
  label: string;
  empty: string;
  selected?: Set<string>;
  selectable?: Set<string>;
  toggle?: (id: string, checked: boolean) => void;
  disabled?: boolean;
  remove?: (key: string) => void;
  save?: (record: RecordFile) => void;
  showHashes?: boolean;
}) {
  const [limit, setLimit] = useState(50);
  const items = queue ?? records;
  return (
    <div
      className="transfer-files file-list"
      role="region"
      aria-label={label}
      tabIndex={0}
      onScroll={(event) => {
        const list = event.currentTarget;
        if (list.scrollHeight - list.scrollTop - list.clientHeight < 160)
          setLimit((n) => Math.min(items.length, n + 50));
      }}
    >
      {!items.length && (
        <div className="file-empty">
          <File size={20} />
          <span>{empty}</span>
        </div>
      )}
      {items.slice(0, limit).map((item) => {
        const queued = 'key' in item ? item : undefined;
        const record = queued ? queued.record : (item as RecordFile);
        const id = queued?.key ?? record!.id;
        const path = queued?.path ?? record!.relativePath;
        const phase = queued?.phase ?? record!.phase;
        const size = queued?.file.size ?? record!.size;
        const checked = record && isVerified(record);
        const canSelect = selectable?.has(id) && toggle;
        const info = (
          <span className="file-info">
            <strong>{path}</strong>
            <small>
              {record && record.bytes < size
                ? `${formatBytes(record.bytes)} / `
                : ''}
              {formatBytes(size)}
              {showHashes && record ? ` · ${record.sha256.slice(0, 12)}…` : ''}
              {record?.stagingCleared ? ' · Cache cleared' : ''}
              {record?.error || queued?.error
                ? ` · ${record?.error || queued?.error}`
                : ''}
            </small>
          </span>
        );
        return (
          <div
            className="file-row"
            key={
              queued?.key ?? `${record!.localRole}:${record!.sessionId}:${id}`
            }
          >
            {canSelect ? (
              <label className="file-choice">
                <input
                  type="checkbox"
                  aria-label={`Select ${path}`}
                  checked={selected?.has(id) ?? false}
                  disabled={disabled}
                  onChange={(event) => toggle(id, event.target.checked)}
                />
                {info}
              </label>
            ) : (
              <>
                <span className="file-symbol">
                  <File size={19} />
                </span>
                {info}
              </>
            )}
            <span className={'file-status ' + phase}>
              {checked ? (
                <Check size={14} />
              ) : ['hashing', 'transferring', 'verifying'].includes(phase) ? (
                <LoaderCircle className="spin" size={14} />
              ) : null}
              {record ? verificationLabel(record) : phaseLabel[phase]}
            </span>
            {queued && remove && !['verified', 'duplicate'].includes(phase) && (
              <button
                className="icon-button"
                disabled={disabled}
                aria-label={`Remove ${path}`}
                onClick={() => remove(id)}
              >
                <X size={15} />
              </button>
            )}
            {!queued &&
              record &&
              save &&
              checked &&
              !record.stagingCleared &&
              record.localRole !== 'send' && (
                <button
                  className="icon-button"
                  aria-label={`Save ${record.originalName}`}
                  title="Save verified copy"
                  disabled={disabled}
                  onClick={() => save(record)}
                >
                  <ArrowDownToLine size={17} />
                </button>
              )}
          </div>
        );
      })}
      {items.length > limit && (
        <button
          className="text-button show-more"
          onClick={() => setLimit((n) => n + 100)}
        >
          Show more files ({items.length - limit})
        </button>
      )}
    </div>
  );
}

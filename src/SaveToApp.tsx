import { useRef, useState } from 'react';
import { Share2, X } from 'lucide-react';
import { formatBytes, isVerified, type RecordFile } from '@/lib/bridge/model';
import { local } from '@/lib/bridge/database';
import { prepareSharedFiles } from '@/lib/bridge/storage';

export function SaveToApp({
  records,
  disabled,
  changed,
}: {
  records: RecordFile[];
  disabled: boolean;
  changed: () => Promise<void>;
}) {
  const supported =
    typeof navigator.share === 'function' &&
    typeof navigator.canShare === 'function';
  const dialog = useRef<HTMLDialogElement>(null);
  const [choices, setChoices] = useState<RecordFile[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [limit, setLimit] = useState(50);
  const [prepared, setPrepared] = useState<File[]>();
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState('');
  const available = [
    ...new Map(
      records
        .filter(
          (r) =>
            isVerified(r) && r.localRole !== 'send' && r.scope === 'browser',
        )
        .map((r) => [r.id, r]),
    ).values(),
  ];

  async function prepare() {
    setWorking(true);
    setMessage('Rereading and checking the selected browser copies…');
    try {
      const files = await prepareSharedFiles(
        choices.filter((r) => selected.includes(r.id)),
      );
      if (!navigator.canShare({ files }))
        throw new Error(
          'This browser cannot share these files together. Choose fewer files or use downloads; some file types are not supported by the device’s share sheet.',
        );
      setPrepared(files);
      setMessage(
        `${files.length} files ready. Tap Choose app or save location to open your device’s options.`,
      );
    } catch (e) {
      setMessage(
        e instanceof Error
          ? e.message
          : 'Unable to prepare these files. Try downloads instead.',
      );
    } finally {
      setWorking(false);
    }
  }

  async function share() {
    if (!prepared || disabled) return;
    setWorking(true);
    let handedOff = false;
    // Invoke before any asynchronous work to preserve this tap’s activation.
    try {
      await navigator.share({ files: prepared });
      handedOff = true;
      const ids = selected.slice();
      setPrepared(undefined);
      setSelected([]);
      for (const id of ids) {
        const current = await local.get(id);
        if (current)
          await local.put({ ...current, shared: true, updated: Date.now() });
      }
      await changed();
      setChoices((previous) =>
        previous.map((r) => (ids.includes(r.id) ? { ...r, shared: true } : r)),
      );
      setMessage(
        'Handed to your device’s save/share sheet. Confirm the save in the selected app. Verification pending: reselect saved files using Verify saved copies. Browser copies are retained.',
      );
    } catch (e) {
      setMessage(
        handedOff
          ? 'Files were handed to the save/share sheet, but the local receipt could not be updated. Confirm the save in the selected app; verification is still pending.'
          : e instanceof Error && e.name === 'AbortError'
            ? 'Save/share sheet closed without a confirmed handoff. Browser copies are retained; you can try again.'
            : 'The device could not hand off these files. Try fewer files, a different app, or downloads. Browser copies are retained.',
      );
    } finally {
      setWorking(false);
    }
  }

  return (
    <div className="app-save">
      <button
        className="button"
        disabled={disabled || !supported || !available.length}
        onClick={() => {
          const pending = available.filter((r) => !r.shared);
          setChoices([...pending, ...available.filter((r) => r.shared)]);
          setSelected(
            (pending.length ? pending : available)
              .slice(0, 20)
              .map((r) => r.id),
          );
          setPrepared(undefined);
          setMessage('');
          setLimit(50);
          dialog.current?.showModal();
        }}
      >
        <Share2 size={16} />
        Save to app or location
      </button>
      <p className="hint">
        {supported
          ? 'After receiving, choose files and open your device’s save/share sheet. Available apps, photo-library actions, and folders depend on your device. Websites cannot choose a specific album automatically.'
          : 'This browser does not offer file sharing to apps. Use downloads or folder access where available.'}
      </p>
      <dialog
        className="save-dialog"
        aria-label="Save to an app or location"
        ref={dialog}
        onCancel={(e) => {
          if (working) e.preventDefault();
        }}
        onClose={() => {
          setPrepared(undefined);
        }}
      >
        <div className="section-head">
          <h2>Save to an app or location</h2>
          <button
            className="icon-button"
            aria-label="Close save options"
            disabled={working}
            onClick={() => dialog.current?.close()}
          >
            <X size={20} />
          </button>
        </div>
        <p>
          Select up to 20 files per batch. Your device chooses the available
          destinations. Sharing uses filenames, without their source folder
          structure.
        </p>
        <div className="share-files" aria-label="Files to save">
          {choices.slice(0, limit).map((r) => (
            <label key={r.id}>
              <input
                type="checkbox"
                checked={selected.includes(r.id)}
                disabled={
                  working ||
                  disabled ||
                  (!selected.includes(r.id) && selected.length >= 20)
                }
                onChange={(e) => {
                  setSelected((ids) =>
                    e.target.checked
                      ? [...ids, r.id]
                      : ids.filter((id) => id !== r.id),
                  );
                  setPrepared(undefined);
                  setMessage('');
                }}
              />
              <span>
                {r.relativePath}
                <small>
                  {formatBytes(r.size)}
                  {r.shared ? ' · Previously handed to save/share sheet' : ''}
                </small>
              </span>
            </label>
          ))}
        </div>
        {choices.length > limit && (
          <button
            className="text-button"
            disabled={working}
            onClick={() => setLimit((n) => n + 50)}
          >
            Show more files
          </button>
        )}
        <p>
          {selected.length} selected ·{' '}
          {formatBytes(
            choices
              .filter((r) => selected.includes(r.id))
              .reduce((n, r) => n + r.size, 0),
          )}
          . Large files may exceed the destination app’s limits.
        </p>
        <div className="button-row">
          {prepared ? (
            <button
              className="button primary"
              disabled={working || disabled}
              onClick={() => void share()}
            >
              <Share2 size={16} />
              Choose app or save location
            </button>
          ) : (
            <button
              className="button primary"
              disabled={working || disabled || !selected.length}
              onClick={() => void prepare()}
            >
              {working ? 'Checking files…' : 'Prepare selected files'}
            </button>
          )}
          <button
            className="button"
            disabled={working || disabled || !choices.some((r) => !r.shared)}
            onClick={() => {
              const pending = choices.filter((r) => !r.shared);
              setChoices([...pending, ...choices.filter((r) => r.shared)]);
              setSelected(pending.slice(0, 20).map((r) => r.id));
              setLimit(50);
              setPrepared(undefined);
              setMessage('');
            }}
          >
            Select next batch
          </button>
          <button
            className="button"
            disabled={working}
            onClick={() => {
              setSelected([]);
              setPrepared(undefined);
              setMessage('');
            }}
          >
            Clear selection
          </button>
        </div>
        {message && (
          <p className="share-status" role="status">
            {message}
          </p>
        )}
        <p className="hint">
          A handoff does not confirm a saved file or cloud backup. Apps may
          convert media. Reselect saved copies to check their final bytes before
          clearing staging.
        </p>
      </dialog>
    </div>
  );
}

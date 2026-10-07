import { useRef, useState } from 'react';
import { Download, Share2, X } from 'lucide-react';
import { formatBytes, isVerified, type RecordFile } from '@/lib/bridge/model';
import { local } from '@/lib/bridge/database';
import {
  offerPreparedDownload,
  prepareSharedFiles,
} from '@/lib/bridge/storage';
import { androidChromeLink } from '@/lib/bridge/save-options';
import { version } from '../package.json';

export function SaveToApp({
  records,
  disabled,
  changed,
}: {
  records: RecordFile[];
  disabled: boolean;
  changed: () => Promise<void>;
}) {
  const supported = typeof navigator.share === 'function';
  const chromeLink = androidChromeLink(
    location.href,
    navigator.userAgent,
    version,
  );
  const dialog = useRef<HTMLDialogElement>(null);
  const [choices, setChoices] = useState<RecordFile[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [limit, setLimit] = useState(50);
  const [prepared, setPrepared] = useState<File[]>();
  const [shareAllowed, setShareAllowed] = useState(false);
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
  const offered = (r: RecordFile) => !!(r.shared || r.downloaded);

  async function prepare() {
    setWorking(true);
    setMessage('Rereading and checking the selected browser copies…');
    try {
      const files = await prepareSharedFiles(
        choices.filter((r) => selected.includes(r.id)),
      );
      setPrepared(files);
      let allowed = supported;
      if (allowed && typeof navigator.canShare === 'function') {
        try {
          allowed = navigator.canShare({ files });
        } catch {
          allowed = false;
        }
      }
      setShareAllowed(allowed);
      setMessage(
        allowed
          ? `${files.length} files ready. Tap Choose app or save location to open your device’s options.`
          : supported
            ? 'This browser cannot share these files together. Download the verified files below, or choose fewer files to try sharing again.'
            : 'Files checked and ready to download. Open your browser’s Downloads list afterward to use the phone’s file manager or app options.',
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
    if (!prepared || disabled || !shareAllowed) return;
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

  async function download() {
    if (!prepared || disabled) return;
    setWorking(true);
    let offeredDownloads = false;
    try {
      // Start downloads during this user tap, after preparation verified each file.
      for (const file of prepared) offerPreparedDownload(file);
      offeredDownloads = true;
      const ids = selected.slice();
      setPrepared(undefined);
      setSelected([]);
      for (const id of ids) {
        const current = await local.get(id);
        if (current)
          await local.put({
            ...current,
            downloaded: true,
            updated: Date.now(),
          });
      }
      await changed();
      setChoices((previous) =>
        previous.map((r) =>
          ids.includes(r.id) ? { ...r, downloaded: true } : r,
        ),
      );
      setMessage(
        'Downloads requested. Allow multiple downloads if your browser asks, then check its Downloads list. Use the downloaded file’s Share or Move options to choose an available app or folder. Verification pending: use Verify saved copies to check the final files. Browser copies are retained.',
      );
    } catch {
      setMessage(
        offeredDownloads
          ? 'Downloads were requested, but the local receipt could not be updated. Check your Downloads list; saved-copy verification is pending.'
          : 'Downloads could not be started. Browser copies are retained; try again or download files individually.',
      );
    } finally {
      setWorking(false);
    }
  }

  return (
    <div className="app-save">
      <button
        className="button"
        disabled={disabled || !available.length}
        onClick={() => {
          const pending = available.filter((r) => !offered(r));
          setChoices([...pending, ...available.filter(offered)]);
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
          : 'File sharing is unavailable here. After receiving, this button prepares verified downloads. Your browser or file manager provides the available save and share options.'}
      </p>
      {!supported && chromeLink && (
        <div className="chrome-help">
          <a className="button" href={chromeLink}>
            Open in Chrome
          </a>
          <p className="hint">
            An embedded browser may lack file sharing. Try the full Chrome app
            before receiving. If it opens a different browser, its storage is
            separate; receive the files there again. Downloading here remains
            available.
          </p>
        </div>
      )}
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
          destinations. Exports use filenames, without their source folder
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
                  {r.downloaded ? ' · Download previously requested' : ''}
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
            <>
              {shareAllowed && (
                <button
                  className="button primary"
                  disabled={working || disabled}
                  onClick={() => void share()}
                >
                  <Share2 size={16} />
                  Choose app or save location
                </button>
              )}
              <button
                className={`button${shareAllowed ? '' : ' primary'}`}
                disabled={working || disabled}
                onClick={() => void download()}
              >
                <Download size={16} />
                Download verified files
              </button>
            </>
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
            disabled={working || disabled || !choices.some((r) => !offered(r))}
            onClick={() => {
              const pending = choices.filter((r) => !offered(r));
              setChoices([...pending, ...choices.filter(offered)]);
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

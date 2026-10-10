import { useRef, useState, type ReactNode } from 'react';
import { Download, Share2, X } from 'lucide-react';
import { formatBytes, isVerified, type RecordFile } from '@/lib/bridge/model';
import { local } from '@/lib/bridge/database';
import {
  offerPreparedDownload,
  prepareSharedFiles,
} from '@/lib/bridge/storage';
import {
  androidChromeLink,
  DOWNLOAD_BATCH_FILES,
  nativeShareBatch,
} from '@/lib/bridge/save-options';
import { version } from '../package.json';

export function SaveToApp({
  records,
  folderAccessAvailable,
  folderControl,
  folderHint,
  disabled,
  changed,
}: {
  records: RecordFile[];
  folderAccessAvailable: boolean;
  folderControl: ReactNode;
  folderHint: ReactNode;
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
  const selectedIds = new Set(selected);
  const [limit, setLimit] = useState(50);
  const [prepared, setPrepared] = useState<File[]>();
  const [preparedIds, setPreparedIds] = useState<string[]>([]);
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
  const android = /Android/i.test(navigator.userAgent);
  const shareFiles =
    supported && prepared
      ? nativeShareBatch(
          prepared,
          navigator.userAgent,
          typeof navigator.canShare === 'function'
            ? navigator.canShare.bind(navigator)
            : undefined,
        )
      : [];
  const shareAllowed = shareFiles.length > 0;

  // Complete only the offered subset. A large selection stays queued and each
  // share sheet is opened by a fresh tap, not a chain of synthetic gestures.
  function advance(ids: string[]) {
    const done = new Set(ids);
    setSelected((previous) => previous.filter((id) => !done.has(id)));
    if (prepared) {
      const remaining = prepared.filter((_, i) => !done.has(preparedIds[i]));
      setPrepared(remaining.length ? remaining : undefined);
      setPreparedIds(preparedIds.filter((id) => !done.has(id)));
    }
  }

  async function prepare() {
    setWorking(true);
    setMessage('Rereading and checking the selected browser copies…');
    try {
      const batch = choices
        .filter((r) => selectedIds.has(r.id))
        .slice(0, DOWNLOAD_BATCH_FILES);
      const files = await prepareSharedFiles(batch, (done, total) =>
        setMessage(`Checking file ${done} of ${total}…`),
      );
      setPrepared(files);
      setPreparedIds(batch.map((r) => r.id));
      const share = supported
        ? nativeShareBatch(
            files,
            navigator.userAgent,
            typeof navigator.canShare === 'function'
              ? navigator.canShare.bind(navigator)
              : undefined,
          )
        : [];
      setMessage(
        share.length
          ? `${files.length} files checked. The next app handoff contains ${share.length} files. Tap Choose app or save location, then choose Google Photos or another available app. ${selected.length - share.length} selected files will remain queued.`
          : android && files.some((file) => file.size > 50 * 1024 * 1024)
            ? 'Files over 50 MiB use verified downloads on Android. Download the original video below, then open Google Photos → Collections → On this device → Download. Your full-size browser copy is retained.'
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
      await navigator.share({ files: shareFiles });
      handedOff = true;
      const ids = preparedIds.filter((_, i) =>
        shareFiles.includes(prepared![i]),
      );
      advance(ids);
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
        `${ids.length} files handed to your device’s save/share sheet. Confirm the save in the selected app. ${selected.length - ids.length} selected files remain queued. Verification pending: reselect saved files using Verify saved copies. Browser copies are retained.`,
      );
    } catch (e) {
      setMessage(
        handedOff
          ? 'Files were handed to the save/share sheet, but the local receipt could not be updated. Confirm the save in the selected app; verification is still pending.'
          : e instanceof Error && e.name === 'AbortError'
            ? 'Save/share sheet closed without a confirmed handoff. Browser copies are retained; you can try again.'
            : 'The device could not hand off these files. Download the verified originals instead. On Android, open Google Photos → Collections → On this device → Download. Browser copies are retained.',
      );
    } finally {
      setWorking(false);
    }
  }

  async function download(entireSelection = false) {
    if (!prepared || disabled) return;
    setWorking(true);
    const target = entireSelection ? selected.length : prepared.length;
    const requested: string[] = [];
    let attempted = 0;
    let files = prepared;
    let ids = preparedIds.slice();
    try {
      while (files.length) {
        // Start the first download during this tap. Space subsequent requests
        // so browser throttles do not silently discard a burst of navigations.
        for (let i = 0; i < files.length; i++) {
          if (requested.length || i)
            await new Promise((resolve) => setTimeout(resolve, 200));
          offerPreparedDownload(files[i]);
          attempted++;
          setMessage(
            `${requested.length + i + 1} of ${target} downloads requested. Allow multiple downloads if your browser asks. Keep this tab open until the collection is requested.`,
          );
        }
        requested.push(...ids);
        advance(requested);
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
        const completedBatch = new Set(ids);
        setChoices((previous) =>
          previous.map((r) =>
            completedBatch.has(r.id) ? { ...r, downloaded: true } : r,
          ),
        );
        if (!entireSelection) break;
        const completed = new Set(requested);
        const batch = choices
          .filter((r) => selectedIds.has(r.id) && !completed.has(r.id))
          .slice(0, DOWNLOAD_BATCH_FILES);
        if (!batch.length) break;
        // Check only the next bounded batch. Previously requested File/Blob
        // references can be released while the rest of the collection queues.
        files = await prepareSharedFiles(batch, (done, total) =>
          setMessage(
            `${requested.length} downloads requested. Checking file ${done} of the next ${total}…`,
          ),
        );
        ids = batch.map((r) => r.id);
      }
      setMessage(
        `${requested.length} downloads requested; ${selected.length - requested.length} selected files remain queued. Allow multiple downloads if your browser asks, then check its Downloads list. ${android ? 'Open Google Photos → Collections → On this device → Download. In Photos settings → Backup → Back up device folders, enable Download if you want these files backed up. ' : 'Use the downloaded files’ Share or Move options to choose an available app or folder. '}Verification pending: use Verify saved copies to check the final files. Browser copies are retained.`,
      );
    } catch (error) {
      setMessage(
        `${attempted} downloads requested before the collection stopped. Check your Downloads list. Remaining files stay selected; browser copies are retained. ${error instanceof Error ? error.message : 'Try again or download files individually.'} Saved-copy verification is pending.`,
      );
    } finally {
      setWorking(false);
    }
  }

  return (
    <div className="app-save">
      <div className="save-actions">
        {folderControl}
        <button
          className="button"
          disabled={disabled || !available.length}
          onClick={() => {
            const pending = available.filter((r) => !offered(r));
            setChoices([...pending, ...available.filter(offered)]);
            setSelected(
              (pending.length ? pending : available).map((r) => r.id),
            );
            setPrepared(undefined);
            setMessage('');
            setLimit(50);
            dialog.current?.showModal();
          }}
        >
          <Share2 size={16} />
          <span>Save to app or location</span>
        </button>
      </div>
      {folderHint}
      {android && !folderAccessAvailable && (
        <p className="hint destination-hint">
          This browser cannot choose a Photos folder. For photos and videos,
          download verified originals, then open Google Photos → Collections →
          On this device → Download and enable that device folder’s backup.
          Update Chrome through the Play Store to version 132 or newer and
          reopen PixelGate to enable direct folder saving where supported.
        </p>
      )}
      <details className="help-details">
        <summary>Saving options</summary>
        {!folderAccessAvailable && (
          <p className="hint">
            Direct folder access is unavailable in this browser. Use your
            device’s save/share options or downloads.
            {android &&
              ' Chrome 132 or newer on Android supports folder access. Update Chrome through the Play Store, reopen PixelGate, and look for Save to Photos folder.'}
          </p>
        )}
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
      </details>
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
          Select your whole collection. App handoffs use batches of up to 10
          compatible files; verified downloads use batches of up to 50. Use
          Download all selected to continue through the whole collection
          automatically. Exports use filenames without source folders.
        </p>
        <button
          className="text-button"
          disabled={working || disabled}
          onClick={() => {
            setSelected(choices.map((r) => r.id));
            setPrepared(undefined);
            setMessage('');
          }}
        >
          Select all {choices.length} files
        </button>
        <div className="share-files" aria-label="Files to save">
          {choices.slice(0, limit).map((r) => (
            <label key={r.id}>
              <input
                type="checkbox"
                checked={selectedIds.has(r.id)}
                disabled={working || disabled}
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
              .filter((r) => selectedIds.has(r.id))
              .reduce((n, r) => n + r.size, 0),
          )}
          . {prepared?.length || 0} files checked for the next actions.
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
              {selected.length > prepared.length && (
                <button
                  className="button primary"
                  disabled={working || disabled}
                  onClick={() => void download(true)}
                >
                  <Download size={16} />
                  Download all {selected.length} selected
                </button>
              )}
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
              setSelected(pending.map((r) => r.id));
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
        {android && (
          <details className="help-details">
            <summary>
              Save large videos and collections to Google Photos
            </summary>
            <p className="hint">
              {folderAccessAvailable
                ? 'To skip downloading and moving files, close this dialog and use Save to Photos folder. Choose or create DCIM/PixelGate in internal storage and allow editing. All received originals are saved and verified in that folder; future transfers save there automatically in this tab. Enable PixelGate in Photos device-folder backup once. '
                : 'Chrome 132 or newer supports saving directly to a local Photos device folder. Update Chrome through the Play Store and use Save to Photos folder. If folder access is unavailable, use downloads: '}
              Download verified files, then open Google Photos → Collections →
              On this device → Download. To back up that folder, open Photos
              settings → Backup → Back up device folders and enable Download.
              Alternatively, use the phone’s Files app to move the downloaded
              media into DCIM/PixelGate. This works with videos larger than the
              browser’s 50 MiB sharing limit. Files remain unchanged; check
              playback and backup in Photos. Older Photos versions may label
              Collections as Library and the folder as Downloads.
            </p>
            <a
              href="https://support.google.com/photos/answer/6193313?co=GENIE.Platform%3DAndroid&hl=en"
              target="_blank"
              rel="noreferrer"
            >
              Google Photos folder backup guide
            </a>
          </details>
        )}
        {android && (
          <details className="help-details">
            <summary>Pixel albums, backup, and freeing phone space</summary>
            <ol className="hint">
              <li>
                Save the originals on this Pixel. Enable backup for the Download
                device folder once in Google Photos.
              </li>
              <li>
                Open Google Photos, confirm the intended account and backup
                quality, and wait for Backup complete. Select the media there
                and add it to your chosen album.
              </li>
              <li>
                Use Google Photos → profile → Free up space on this device when
                you want to remove backed-up phone copies. This does not enable
                unlimited backup or clear PixelGate’s separate browser copies.
              </li>
            </ol>
            <p className="hint">
              The original Pixel has unlimited Original quality backup. Pixel
              2–5 offer unlimited Storage saver backup under their model’s
              terms; Storage saver may compress media. Album selection does not
              change those terms. Google Photos also has its own file limits,
              including videos up to 10 GB and photos up to 200 MB or 200 MP.
            </p>
            <a
              href="https://support.google.com/pixelphone/answer/6220791?co=GENIE.Platform%3DAndroid&hl=en"
              target="_blank"
              rel="noreferrer"
            >
              Google’s Pixel backup quality rules
            </a>
          </details>
        )}
        <details className="help-details">
          <summary>About saved-copy verification</summary>
          <p className="hint">
            A handoff does not confirm a saved file or cloud backup. Apps may
            convert media. Reselect saved copies to check their final bytes
            before clearing staging.
          </p>
        </details>
      </dialog>
    </div>
  );
}

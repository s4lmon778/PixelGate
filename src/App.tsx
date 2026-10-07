import { useCallback, useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { QrImage } from './QrImage';
import { CodeInput } from './CodeInput';
import { KeepAwake } from './KeepAwake';
import { SaveToApp } from './SaveToApp';
import { ThemeMenu } from './ThemeMenu';
import { version } from '../package.json';
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Check,
  CheckCheck,
  ChevronDown,
  CircleHelp,
  Copy,
  File,
  Folder,
  History,
  Laptop,
  Link,
  LoaderCircle,
  LockKeyhole,
  Pause,
  Play,
  ShieldCheck,
  Smartphone,
  Square,
  Trash2,
  Wifi,
  X,
} from 'lucide-react';
import { Connection, type PairRoom } from '@/lib/bridge/connection';
import { CodeConnection } from '@/lib/bridge/code-connection';
import { pairingLink } from '@/lib/bridge/pairing';
import { local } from '@/lib/bridge/database';
import { Receiver, Sender } from '@/lib/bridge/transfer';
import { dropped, selected } from '@/lib/bridge/selection';
import {
  downloadStaged,
  removeStaged,
  saveToFolder,
  prepareStaging,
  stagingBackend,
  type StagingBackend,
  verifyExport,
} from '@/lib/bridge/storage';
import { downloadReport } from '@/lib/bridge/report';
import {
  formatBytes,
  isVerified,
  type QueuedFile,
  type RecordFile,
} from '@/lib/bridge/model';

type BrowserFolderWindow = Window & {
  showDirectoryPicker?: (options: {
    mode: 'readwrite';
    id: string;
  }) => Promise<FileSystemDirectoryHandle>;
};
const errorText = (e: unknown) =>
  e instanceof Error ? e.message : 'Something went wrong. Try again.';
const phaseLabel: Record<string, string> = {
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
function verificationLabel(r: RecordFile) {
  if (!isVerified(r)) return phaseLabel[r.phase];
  if (r.scope === 'destination') return 'Destination verified';
  if (r.scope === 'exported') return 'Exported copy verified';
  if (r.shared) return 'App save verification pending';
  return r.downloaded
    ? 'Download verification pending'
    : 'Browser copy verified';
}

export default function PixelGate() {
  const [view, setView] = useState<'transfer' | 'history' | 'guide'>(
    'transfer',
  );
  const [role, setRole] = useState<'send' | 'receive'>('send');
  const [pairingMode, setPairingMode] = useState<'code' | 'manual'>('code');
  const [status, setStatus] = useState('Not connected');
  const [connected, setConnected] = useState(false);
  const [room, setRoom] = useState<PairRoom>();
  const [code, setCode] = useState('');
  const [senderAddress, setSenderAddress] = useState('');
  const [response, setResponse] = useState('');
  const [qr, setQr] = useState<{
    offer: string;
    url?: string;
    modules?: number;
    error?: string;
  }>();
  const [busy, setBusy] = useState(false);
  const [running, setRunning] = useState(false);
  const [paused, setPaused] = useState(false);
  const [queue, setQueue] = useState<QueuedFile[]>([]);
  const [received, setReceived] = useState<RecordFile[]>([]);
  const [history, setHistory] = useState<RecordFile[]>([]);
  const [storedReceived, setStoredReceived] = useState<RecordFile[]>([]);
  const [notice, setNotice] = useState('');
  const [problem, setProblem] = useState('');
  const [folderName, setFolderName] = useState('Manual download');
  const [capacityLabel, setCapacityLabel] = useState('Checking…');
  const [storageMode, setStorageMode] =
    useState<StagingBackend>(stagingBackend);
  const [dragging, setDragging] = useState(false);
  const [visible, setVisible] = useState(50);
  const [historySession, setHistorySession] = useState('all');
  const [elapsed, setElapsed] = useState(0);
  const connection = useRef<Connection | CodeConnection | undefined>(undefined);
  const sender = useRef<Sender | undefined>(undefined);
  const receiver = useRef<Receiver | undefined>(undefined);
  const folder = useRef<FileSystemDirectoryHandle | undefined>(undefined);
  const currentQueue = useRef<QueuedFile[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const verifyInput = useRef<HTMLInputElement>(null);
  const qrDialog = useRef<HTMLDialogElement>(null);
  const receivedRecords = useRef(new Map<string, RecordFile>());
  const receiveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const session = useRef('');
  const startTime = useRef(0);
  const baseBytes = useRef(0);
  const releaseLock = useRef<(() => void) | undefined>(undefined);

  const refresh = useCallback(async () => {
    const [records, stored] = await Promise.all([
      local.files(),
      local.receivedFiles(),
    ]);
    setHistory(records.sort((a, b) => b.updated - a.updated));
    setStoredReceived(stored);
    const estimate = await navigator.storage?.estimate?.();
    setCapacityLabel(
      estimate?.quota
        ? `${formatBytes(Math.max(0, estimate.quota - (estimate.usage ?? 0)))} available`
        : 'Estimate unavailable',
    );
  }, []);
  useEffect(() => {
    session.current = crypto.randomUUID();
    const importPairing = () => {
      const params = new URLSearchParams(location.hash.slice(1));
      const pairing = params.get('connect');
      if (pairing && pairing.length <= 16004) {
        queueMicrotask(() => {
          setPairingMode(/^\d{6}$/.test(pairing) ? 'code' : 'manual');
          setCode(pairing);
        });
        historyReplace();
      }
    };
    importPairing();
    window.addEventListener('hashchange', importPairing);
    void Promise.resolve()
      .then(refresh)
      .catch((e) => setProblem(errorText(e)));
    return () => {
      window.removeEventListener('hashchange', importPairing);
      clearTimeout(receiveTimer.current);
      sender.current?.cancel();
      void receiver.current?.close();
      void connection.current?.stop();
      releaseLock.current?.();
    };
  }, [refresh]);
  useEffect(() => {
    if (folderInput.current)
      folderInput.current.setAttribute('webkitdirectory', '');
  }, [view, role]);
  const pairingOffer = room?.offer;
  useEffect(() => {
    if (!pairingOffer || role !== 'receive') return;
    let active = true;
    const offer = pairingOffer;
    const link = pairingLink(pairingOffer);
    QRCode.toString(link, {
      type: 'svg',
      width: 1024,
      errorCorrectionLevel: 'M',
      margin: 4,
      color: { dark: '#000000', light: '#ffffff' },
    })
      .then((svg) => {
        if (active)
          setQr({
            offer,
            modules:
              QRCode.create(link, { errorCorrectionLevel: 'M' }).modules.size +
              8,
            url: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`,
          });
      })
      .catch(() => {
        if (active)
          setQr({
            offer,
            error: 'QR code unavailable. Copy the receiver link instead.',
          });
      });
    return () => {
      active = false;
    };
  }, [pairingOffer, role]);
  useEffect(() => {
    if (!running && !connected) return;
    const tick = setInterval(
      () => setElapsed(Math.max(1, (Date.now() - startTime.current) / 1000)),
      1000,
    );
    const visible = () => {
      if (
        document.visibilityState === 'hidden' &&
        (running ||
          [...receivedRecords.current.values()].some((r) =>
            ['transferring', 'verifying'].includes(r.phase),
          ))
      ) {
        sender.current?.pause();
        receiver.current?.pause();
        setPaused(true);
        setNotice(
          'Browser was backgrounded. Return to this tab and resume; reconnect if necessary.',
        );
      }
    };
    document.addEventListener('visibilitychange', visible);
    return () => {
      clearInterval(tick);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [running, connected]);
  async function guarded(action: () => Promise<unknown>) {
    setProblem('');
    setNotice('');
    setBusy(true);
    try {
      await action();
    } catch (e) {
      setProblem(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function disconnect() {
    sender.current?.cancel();
    sender.current = undefined;
    await connection.current?.stop();
    await receiver.current?.close();
    receiver.current = undefined;
    connection.current = undefined;
    releaseLock.current?.();
    releaseLock.current = undefined;
    setConnected(false);
    setRoom(undefined);
    setQr(undefined);
    setResponse('');
    setSenderAddress('');
    setStatus('Not connected');
    setPaused(false);
  }
  async function preflight() {
    if (!isSecureContext || !window.RTCPeerConnection)
      throw new Error(
        'Open PixelGate over HTTPS in a browser with WebRTC support.',
      );
    setStorageMode(await prepareStaging());
    void navigator.storage?.persist?.().catch(() => {});
    if (navigator.locks) {
      await new Promise<void>((resolve, reject) => {
        navigator.locks
          .request(
            'pixelbridge-receiver',
            { ifAvailable: true },
            async (lock) => {
              if (!lock) {
                reject(
                  new Error(
                    'Another tab is already receiving. Close that receiver first.',
                  ),
                );
                return;
              }
              resolve();
              await new Promise<void>((done) => {
                releaseLock.current = done;
              });
            },
          )
          .catch(reject);
      });
    }
  }
  async function connect() {
    await disconnect();
    if (role === 'receive') await preflight();
    clearTimeout(receiveTimer.current);
    receiveTimer.current = undefined;
    receivedRecords.current.clear();
    setReceived([]);
    startTime.current = Date.now();
    const events: ConstructorParameters<typeof CodeConnection>[1] = {
      room: setRoom,
      status: setStatus,
      connected: (channel) => {
        setConnected(true);
        setPaused(false);
        if (role === 'send')
          sender.current = new Sender(channel, () =>
            setQueue([...currentQueue.current]),
          );
        else
          receiver.current = new Receiver(
            channel,
            () => folder.current,
            (record) => {
              receivedRecords.current.set(record.id, record);
              if (!receiveTimer.current)
                receiveTimer.current = setTimeout(() => {
                  setReceived([...receivedRecords.current.values()].reverse());
                  receiveTimer.current = undefined;
                }, 200);
            },
            (e) => {
              setProblem(e.message);
              void refresh().catch(() => {});
            },
            () => {
              void refresh().catch(() => {});
            },
          );
      },
      error: (e) => {
        setProblem(e.message);
        if (conn.channel?.readyState !== 'open') {
          setConnected(false);
          setStatus('Reconnect to continue');
        }
      },
    };
    const conn =
      pairingMode === 'code'
        ? new CodeConnection(role, events, senderAddress)
        : new Connection(role, events);
    connection.current = conn;
    try {
      await conn.start(code);
    } catch (e) {
      await conn.stop();
      releaseLock.current?.();
      releaseLock.current = undefined;
      setStatus('Not connected');
      throw e;
    }
  }
  async function selectFolder() {
    const picker = (window as BrowserFolderWindow).showDirectoryPicker;
    if (!picker) {
      setNotice(
        'Folder access is unavailable in this browser. Use Save to app or location if offered, or download verified copies.',
      );
      return;
    }
    let handle: FileSystemDirectoryHandle;
    try {
      handle = await picker.call(window, {
        mode: 'readwrite',
        id: 'pixelbridge-destination',
      });
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') return;
      throw e;
    }
    folder.current = handle;
    setFolderName(handle.name);
    await local.set('destination', handle);
  }
  async function addFiles(files: QueuedFile[]) {
    if (running)
      throw new Error(
        'Pause and finish the current queue before adding more files.',
      );
    const keys = new Set(
      currentQueue.current.map(
        (q) => `${q.path}:${q.file.size}:${q.file.lastModified}`,
      ),
    );
    const added = files.filter((f) => {
      const k = `${f.path}:${f.file.size}:${f.file.lastModified}`;
      if (keys.has(k)) return false;
      keys.add(k);
      return true;
    });
    currentQueue.current = [...currentQueue.current, ...added];
    setQueue([...currentQueue.current]);
    setNotice(
      `${added.length.toLocaleString()} file${added.length === 1 ? '' : 's'} added. Files are prepared locally before sending.`,
    );
  }
  async function send() {
    if (!sender.current || running) return;
    setRunning(true);
    setPaused(sender.current.paused);
    setProblem('');
    startTime.current = Date.now();
    baseBytes.current = currentQueue.current.reduce(
      (n, q) => n + (q.record?.bytes ?? 0),
      0,
    );
    setElapsed(1);
    try {
      await sender.current.run(currentQueue.current, session.current);
      await refresh();
    } catch (e) {
      setProblem(errorText(e));
    } finally {
      setRunning(false);
      setQueue([...currentQueue.current]);
    }
  }
  function togglePause() {
    if (paused) {
      sender.current?.resume();
      receiver.current?.resume();
      setPaused(false);
      setNotice('');
    } else {
      sender.current?.pause();
      receiver.current?.pause();
      setPaused(true);
    }
  }
  async function save(record: RecordFile) {
    if (folder.current) {
      const saved = await saveToFolder(folder.current, record);
      await local.put(saved);
      receivedRecords.current.set(saved.id, saved);
      setReceived([...receivedRecords.current.values()].reverse());
    } else {
      await downloadStaged(record);
      const updated = await local.get(record.id);
      if (updated) {
        receivedRecords.current.set(updated.id, updated);
        setReceived([...receivedRecords.current.values()].reverse());
      }
    }
    await refresh();
  }
  async function clearVerified() {
    if (
      !confirm(
        'Remove staged copies that have a verified destination or exported copy? This frees browser space. Destination files will remain.',
      )
    )
      return;
    let count = 0;
    for (const record of await local.receivedFiles())
      if (
        ['destination', 'exported'].includes(record.scope) &&
        isVerified(record)
      ) {
        await removeStaged(record.id);
        count++;
      }
    setNotice(`${count} staged copies cleared. Reports remain on this device.`);
    await refresh();
  }
  async function exportBatch() {
    const pending = (await local.receivedFiles()).filter(
      (r) =>
        isVerified(r) &&
        r.scope === 'browser' &&
        (folder.current || !r.downloaded) &&
        (view !== 'history' ||
          historySession === 'all' ||
          r.sessionId === historySession),
    );
    let count = 0;
    const errors: string[] = [];
    for (const record of pending.slice(0, 50)) {
      try {
        if (folder.current)
          await local.put(await saveToFolder(folder.current, record));
        else await downloadStaged(record);
        count++;
      } catch (error) {
        errors.push(`${record.originalName}: ${errorText(error)}`);
      }
    }
    if (errors.length) setProblem(errors.slice(0, 3).join(' · '));
    setNotice(
      `${count} copies ${folder.current ? 'saved and verified' : 'offered for download; allow multiple downloads, then reselect the saved files to verify them'}.${pending.length > 50 ? ' Run another batch for the remaining files.' : ''}`,
    );
    await refresh();
    const updated = await local.receivedFiles();
    for (const record of updated)
      if (receivedRecords.current.has(record.id))
        receivedRecords.current.set(record.id, record);
    setReceived([...receivedRecords.current.values()].reverse());
  }
  const records =
    role === 'receive'
      ? received
      : queue.flatMap((q) => (q.record ? [q.record] : []));
  const total =
    role === 'send'
      ? queue.reduce((n, q) => n + q.file.size, 0)
      : received.reduce((n, r) => n + r.size, 0);
  const bytes = records.reduce((n, r) => n + r.bytes, 0);
  const verified = records.filter(isVerified).length;
  const failed = records.filter((r) => r.phase === 'failed').length;
  const percent = total ? Math.min(100, Math.round((bytes / total) * 100)) : 0;
  const active =
    role === 'send'
      ? queue.find((q) =>
          ['hashing', 'transferring', 'verifying'].includes(q.phase),
        )?.path
      : received.find((r) => ['transferring', 'verifying'].includes(r.phase))
          ?.relativePath;
  const speed =
    elapsed && running ? Math.max(0, bytes - baseBytes.current) / elapsed : 0;
  const eta = speed ? Math.ceil((total - bytes) / speed) : 0;
  const historyRecords =
    historySession === 'all'
      ? history
      : history.filter((r) => r.sessionId === historySession);
  const sessions = [...new Set(history.map((r) => r.sessionId))];
  const list = view === 'history' ? historyRecords : records;
  const displayQueue = role === 'send' && view === 'transfer';

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <button
          className="brand"
          onClick={() => setView('transfer')}
          aria-label="PixelGate home"
        >
          <span className="brand-symbol">
            <i />
            <i />
            <i />
            <i />
          </span>
          PixelGate
        </button>
        <div className="workspace-label">YOUR WORKSPACE</div>
        <nav aria-label="Main navigation">
          <button
            className={view === 'transfer' ? 'nav-item selected' : 'nav-item'}
            aria-label="Transfer"
            aria-current={view === 'transfer' ? 'page' : undefined}
            title="Transfer"
            onClick={() => setView('transfer')}
          >
            <Link size={19} />
            Transfer
          </button>
          <button
            className={view === 'history' ? 'nav-item selected' : 'nav-item'}
            aria-current={view === 'history' ? 'page' : undefined}
            title="History"
            onClick={() => {
              setView('history');
              void guarded(refresh);
            }}
          >
            <History size={19} />
            History
          </button>
          <button
            className={view === 'guide' ? 'nav-item selected' : 'nav-item'}
            aria-current={view === 'guide' ? 'page' : undefined}
            title="How it works"
            onClick={() => setView('guide')}
          >
            <CircleHelp size={19} />
            How it works
          </button>
        </nav>
        <div className="sidebar-bottom">
          <LockKeyhole size={18} />
          <div>
            Private by design<small>Files stay between your devices.</small>
          </div>
        </div>
      </aside>
      <div className="main-wrap">
        <header className="topbar">
          <span className="breadcrumb">
            Workspace <span>/</span>{' '}
            {view === 'transfer'
              ? 'Transfer'
              : view === 'history'
                ? 'History'
                : 'How it works'}
          </span>
          <div className="topbar-actions">
            <span className="local-badge">
              <Wifi size={14} />
              Direct device transfer
            </span>
            <ThemeMenu />
          </div>
        </header>
        <main>
          <div className="page-heading">
            <div>
              <div className="eyebrow">
                {view === 'transfer' ? 'DEVICE TO DEVICE' : 'ON THIS DEVICE'}
              </div>
              <h1>
                {view === 'transfer'
                  ? 'Transfer files between devices'
                  : view === 'history'
                    ? 'Transfer history'
                    : 'A better way across.'}
              </h1>
              <p>
                {view === 'transfer'
                  ? 'Choose Send on one device and Receive on the other. Keep both browsers open.'
                  : view === 'history'
                    ? 'Your local record of transfers and integrity checks.'
                    : 'Original bytes, independently checked at the other end.'}
              </p>
            </div>
            <span className="integrity-pill">
              <ShieldCheck size={16} />
              SHA-256 verified copies
            </span>
          </div>
          {problem && (
            <div className="alert error" role="alert">
              <CircleHelp size={18} />
              <span>{problem}</span>
              <button aria-label="Dismiss error" onClick={() => setProblem('')}>
                <X size={16} />
              </button>
            </div>
          )}
          {notice && (
            <div className="alert" role="status">
              <span>{notice}</span>
              <button aria-label="Dismiss notice" onClick={() => setNotice('')}>
                <X size={16} />
              </button>
            </div>
          )}
          <KeepAwake active={!!room || connected || running} />
          {view === 'guide' ? (
            <div className="guide-grid">
              <section className="panel">
                <h2>From one browser to another</h2>
                <ol>
                  <li>
                    Open PixelGate on both devices. No account or installation
                    is required.
                  </li>
                  <li>
                    On the receiving device, choose Receive and create a
                    connection.
                  </li>
                  <li>
                    On the sender, enter the receiver’s six-digit code or scan
                    its QR code and choose Connect. Approve the sender on the
                    receiver. No response needs copying.
                  </li>
                  <li>
                    Select files or folders and send. Keep both browsers open on
                    the same trusted local network or hotspot.
                  </li>
                  <li>
                    Choose a destination folder where supported, or use Save to
                    app or location to open your device’s save/share sheet after
                    receiving. Downloads are also available. Reselect files
                    saved through downloads or apps to verify their final bytes.
                  </li>
                  <li>
                    If you use a photo library, document manager, or backup
                    service, import or sync the saved files there. Confirm any
                    backup in that service before removing source files.
                  </li>
                </ol>
              </section>
              <section className="panel">
                <h2>What “verified” means</h2>
                <p>
                  PixelGate hashes the source file, writes its untouched bytes,
                  then rereads the stored copy and compares SHA-256 hashes.
                </p>
                <p>
                  <strong>Browser copy verified:</strong> the copy inside this
                  browser matches the selected source.
                </p>
                <p>
                  <strong>Destination / exported copy verified:</strong>{' '}
                  PixelGate reread the actual saved file and confirmed its hash.
                </p>
                <p>
                  Downloads and files handed to another app stay pending until
                  checked. PixelGate does not verify backups made by other apps
                  or services.
                </p>
              </section>
              <section className="panel">
                <h2>Browser and network limits</h2>
                <p>
                  Guest, campus, hotel, and workplace Wi-Fi may allow internet
                  access while blocking local discovery or connections between
                  devices. Use the same exact network on both devices; matching
                  network names alone do not guarantee a direct route. PixelGate
                  cannot change network access rules.
                </p>
                <p>
                  Integrity covers the files supplied by your device’s picker.
                  Photo libraries and cloud services may provide exported or
                  converted copies rather than originals. Export unmodified
                  originals through the source app when you need them.
                </p>
                <p>
                  For example, Apple Photos originals, paired Live Photos, and
                  iCloud-original retrieval are not guaranteed by a browser
                  picker. PixelGate preserves the bytes it receives from the
                  picker without further conversion.
                </p>
                <p>
                  Folder saving depends on browser support and permission. Use
                  manual downloads if unavailable. Filesystem dates cannot
                  generally be preserved by browser writers; embedded metadata
                  remains unchanged.
                </p>
                <p>
                  Older browsers can use compatibility storage when newer file
                  APIs are unavailable. Received chunks stay in local browser
                  storage and are reread for verification. Start with small
                  batches on older or storage-constrained devices.
                </p>
              </section>
              <section className="panel">
                <h2>Recovery and storage</h2>
                <p>
                  Interrupted files stay in browser storage at durable
                  checkpoints. Reconnect, reselect the same source files, and
                  send again to resume. Changed content starts a separate
                  transfer.
                </p>
                <p>
                  Estimated staging space is this browser’s remaining allowance
                  for received copies. Estimates vary by browser, profile, and
                  device; this is not a guarantee of free disk space or a limit
                  on the total you can transfer. Each file must fit alongside
                  copies still staged here. Save or download, verify, then clear
                  staged copies in batches to reuse the space. Saving to a
                  folder also needs disk space for that destination copy.
                </p>
                <p>
                  Browser storage can be cleared by the browser or user. Leaving
                  the tab or locking the screen may suspend transfers. Keep
                  screen awake requests protection from automatic screen lock
                  where supported; it does not enable background transfers.
                </p>
                <p>
                  Six-digit codes expire after ten minutes and are released
                  after one approval. PeerJS exchanges connection details for
                  pairing; it receives no files, filenames, hashes, or history.
                  Copy/paste pairing is also available. No TURN relay is
                  configured; file bytes use the direct encrypted peer
                  connection.
                </p>
              </section>
            </div>
          ) : (
            <>
              {view === 'transfer' && (
                <div className="transfer-layout">
                  <div className="primary-column">
                    <section className="panel connection-panel">
                      <div className="section-head">
                        <h2>
                          <span className="step">01</span>Connect your devices
                        </h2>
                        <span
                          className={
                            'status-badge ' + (connected ? 'online' : '')
                          }
                        >
                          {connected ? (
                            <Check size={13} />
                          ) : (
                            <span className="status-dot" />
                          )}
                          {status}
                        </span>
                      </div>
                      <div className="role-selector" aria-label="Transfer mode">
                        <button
                          className={role === 'send' ? 'active' : ''}
                          aria-pressed={role === 'send'}
                          disabled={!!room || busy || running}
                          onClick={() => setRole('send')}
                        >
                          <ArrowUpFromLine size={18} />
                          Send files
                        </button>
                        <button
                          className={role === 'receive' ? 'active' : ''}
                          aria-pressed={role === 'receive'}
                          disabled={!!room || busy || running}
                          onClick={() => setRole('receive')}
                        >
                          <ArrowDownToLine size={18} />
                          Receive files
                        </button>
                      </div>
                      {!room ? (
                        <div className="pairing-start">
                          {role === 'send' ? (
                            <>
                              <label
                                htmlFor={
                                  pairingMode === 'code'
                                    ? 'pair-code'
                                    : 'pair-link'
                                }
                              >
                                {pairingMode === 'code'
                                  ? 'Receiver’s six-digit code'
                                  : 'Receiver’s pairing link'}
                              </label>
                              <div
                                className={
                                  'pairing-input' +
                                  (pairingMode === 'code'
                                    ? ' pairing-code-input'
                                    : '')
                                }
                              >
                                {pairingMode === 'code' ? (
                                  <CodeInput
                                    value={code}
                                    onChange={setCode}
                                    disabled={busy}
                                  />
                                ) : (
                                  <textarea
                                    id="pair-link"
                                    autoComplete="off"
                                    placeholder="Paste the receiver link here, or scan its QR code."
                                    maxLength={18048}
                                    value={code}
                                    onChange={(e) => setCode(e.target.value)}
                                  />
                                )}
                                <button
                                  className="button primary"
                                  disabled={
                                    busy ||
                                    (pairingMode === 'code'
                                      ? !/^\d{6}$/.test(code)
                                      : !code.trim())
                                  }
                                  onClick={() => void guarded(connect)}
                                >
                                  {busy ? (
                                    <LoaderCircle className="spin" size={16} />
                                  ) : (
                                    <Link size={16} />
                                  )}
                                  {pairingMode === 'code'
                                    ? 'Connect'
                                    : 'Prepare sender response'}
                                </button>
                              </div>
                              <p className="hint">
                                {pairingMode === 'code'
                                  ? 'On the other device, choose Receive files and create a connection. Enter its code here, then approve this sender on that device.'
                                  : 'On the other device, choose Receive files and Use copy/paste pairing. Create a connection there, then paste its receiver link here.'}
                              </p>
                            </>
                          ) : (
                            <>
                              <div className="receive-intro">
                                <Smartphone size={30} />
                                <div>
                                  <strong>
                                    This device will receive your files
                                  </strong>
                                  <p>
                                    Create a code below and enter it on the
                                    sending device. You’ll approve the sender
                                    before any files arrive.
                                  </p>
                                </div>
                              </div>
                              {pairingMode === 'code' && (
                                <details className="lan-fallback">
                                  <summary>Advanced network settings</summary>
                                  <p className="hint" id="lan-help">
                                    Connection details are collected
                                    automatically. For advanced diagnosis only,
                                    you can supply the sender’s local IPv4
                                    address before creating a code. Find it in
                                    that device’s network settings for its
                                    current Wi-Fi or wired connection. This can
                                    help when local device discovery fails; it
                                    cannot bypass a network that blocks devices.
                                  </p>
                                  <label
                                    className="pairing-label"
                                    htmlFor="sender-ip"
                                  >
                                    Sender’s local IPv4 (optional)
                                  </label>
                                  <input
                                    id="sender-ip"
                                    className="lan-address"
                                    type="text"
                                    inputMode="decimal"
                                    autoComplete="off"
                                    spellCheck={false}
                                    placeholder="192.168.1.20"
                                    maxLength={15}
                                    aria-describedby="lan-help"
                                    value={senderAddress}
                                    disabled={busy}
                                    onChange={(event) =>
                                      setSenderAddress(event.target.value)
                                    }
                                  />
                                  <p className="hint">
                                    Used only in this tab. No relay, microphone,
                                    or camera access.
                                  </p>
                                </details>
                              )}
                              <button
                                className="button primary"
                                disabled={busy}
                                onClick={() => void guarded(connect)}
                              >
                                {busy ? (
                                  <LoaderCircle className="spin" size={16} />
                                ) : (
                                  <Link size={16} />
                                )}
                                Create a connection
                              </button>
                            </>
                          )}
                        </div>
                      ) : (
                        <div className="paired-content">
                          {connected ? (
                            <div className="device-link">
                              <Laptop size={28} />
                              <div className="link-line">
                                <span />
                                <LockKeyhole size={15} />
                                <span />
                              </div>
                              <Smartphone size={28} />
                              <p>Encrypted connection established</p>
                            </div>
                          ) : role === 'receive' ? (
                            <>
                              <div className="qr-row">
                                {qr &&
                                  qr.offer === room.offer &&
                                  qr.url &&
                                  qr.modules && (
                                    <div
                                      className={
                                        'qr-code' +
                                        (room.code ? ' compact' : '')
                                      }
                                    >
                                      <QrImage
                                        src={qr.url}
                                        modules={qr.modules}
                                        alt="Scan this receiver link"
                                      />
                                      <button
                                        className="text-button"
                                        onClick={() =>
                                          qrDialog.current?.showModal()
                                        }
                                      >
                                        Enlarge QR code
                                      </button>
                                      <dialog
                                        className="qr-dialog"
                                        ref={qrDialog}
                                        aria-label="Receiver QR code"
                                      >
                                        <button
                                          className="text-button"
                                          onClick={() =>
                                            qrDialog.current?.close()
                                          }
                                        >
                                          <X size={18} />
                                          Close QR code
                                        </button>
                                        <QrImage
                                          src={qr.url}
                                          modules={qr.modules}
                                          alt="Enlarged receiver QR code"
                                        />
                                        <p>
                                          Scan with your sending device’s
                                          camera. Keep the whole white border in
                                          view.
                                        </p>
                                      </dialog>
                                    </div>
                                  )}
                                <div>
                                  <strong>
                                    {room.code
                                      ? '1. Enter this code on the sender'
                                      : '1. Share your receiver link'}
                                  </strong>
                                  {room.code && (
                                    <>
                                      <div
                                        className="code-slots code-display"
                                        aria-label="Pairing code"
                                      >
                                        {room.code
                                          .split('')
                                          .map((digit, index) => (
                                            <span key={index}>{digit}</span>
                                          ))}
                                      </div>
                                      <button
                                        className="text-button"
                                        onClick={() =>
                                          void guarded(async () => {
                                            await navigator.clipboard.writeText(
                                              room.code!,
                                            );
                                            setNotice(
                                              'Six-digit pairing code copied.',
                                            );
                                          })
                                        }
                                      >
                                        <Copy size={14} />
                                        Copy code
                                      </button>
                                    </>
                                  )}
                                  <p className="hint">
                                    Scan with your sending device’s camera.
                                    Enlarge the code if needed, or copy the
                                    link.
                                  </p>
                                  {qr &&
                                    qr.offer === room.offer &&
                                    qr.error && <p role="alert">{qr.error}</p>}
                                  <button
                                    className="text-button"
                                    onClick={() =>
                                      void guarded(async () => {
                                        await navigator.clipboard.writeText(
                                          pairingLink(room.offer!),
                                        );
                                        setNotice(
                                          'Receiver link copied. Share it only with your sending device.',
                                        );
                                      })
                                    }
                                  >
                                    <Copy size={14} />
                                    Copy receiver link
                                  </button>
                                  <p className="hint">
                                    Expires at{' '}
                                    {new Date(room.expires).toLocaleTimeString(
                                      [],
                                      { hour: '2-digit', minute: '2-digit' },
                                    )}
                                  </p>
                                </div>
                              </div>
                              {!room.code && (
                                <>
                                  <label
                                    className="pairing-label"
                                    htmlFor="receiver-link"
                                  >
                                    Receiver link
                                  </label>
                                  <textarea
                                    className="pairing-text"
                                    id="receiver-link"
                                    readOnly
                                    value={pairingLink(room.offer!)}
                                    onFocus={(e) => e.target.select()}
                                  />
                                </>
                              )}
                              {room.code ? (
                                <div className="approval">
                                  <strong>
                                    {room.failed
                                      ? '2. Connection failed'
                                      : room.approvalGranted
                                        ? '2. Sender approved'
                                        : room.pending
                                          ? '2. Approve your sender'
                                          : '2. Waiting for your sender'}
                                  </strong>
                                  <p className="hint">
                                    {room.failed
                                      ? 'This code is no longer active. Create a fresh code and enter it on your sender.'
                                      : room.approvalGranted
                                        ? 'Opening the direct connection. Keep both tabs open; files can start only after the connection is ready.'
                                        : room.pending
                                          ? 'Your sender’s request arrived. Approve only if you just tapped Connect on your sending device. Files cannot arrive before you approve.'
                                          : 'Open Send on the other device, enter the six digits above, then tap Connect; or scan the QR code and tap Connect.'}
                                  </p>
                                  <button
                                    className="button primary"
                                    disabled={busy || !room.pending}
                                    onClick={() =>
                                      void guarded(async () => {
                                        await connection.current?.approve('');
                                      })
                                    }
                                  >
                                    <Check size={16} />
                                    Approve sender
                                  </button>
                                  {room.failed && (
                                    <button
                                      className="button primary"
                                      disabled={busy}
                                      onClick={() => void guarded(connect)}
                                    >
                                      Create a new code
                                    </button>
                                  )}
                                  {room.pending && (
                                    <button
                                      className="text-button"
                                      disabled={busy}
                                      onClick={() => void guarded(disconnect)}
                                    >
                                      Decline sender
                                    </button>
                                  )}
                                </div>
                              ) : (
                                <div className="approval">
                                  <div>
                                    <label
                                      className="pairing-label"
                                      htmlFor="sender-response"
                                    >
                                      2. Paste the sender response
                                    </label>
                                    <p>
                                      Approve only the response from your
                                      sending device.
                                    </p>
                                  </div>
                                  <textarea
                                    className="pairing-text"
                                    id="sender-response"
                                    placeholder="Paste the response copied on the sender."
                                    maxLength={18048}
                                    value={response}
                                    onChange={(e) =>
                                      setResponse(e.target.value)
                                    }
                                  />
                                  <button
                                    className="button primary"
                                    disabled={busy || !response.trim()}
                                    onClick={() =>
                                      void guarded(async () => {
                                        await connection.current?.approve(
                                          response,
                                        );
                                      })
                                    }
                                  >
                                    <Check size={16} />
                                    Approve sender
                                  </button>
                                </div>
                              )}
                            </>
                          ) : room.code ? (
                            <div className="pairing-response">
                              <strong>
                                {room.failed
                                  ? 'Connection failed'
                                  : room.routeReady
                                    ? 'Waiting for receiver approval'
                                    : 'Connecting to receiver'}
                              </strong>
                              <p className="hint">
                                {room.failed
                                  ? 'Create a new code on the receiver, then reconnect with that code.'
                                  : 'Keep both tabs open. When your request appears on the receiver, choose Approve sender there. You don’t need to copy a response.'}
                              </p>
                            </div>
                          ) : (
                            <div className="pairing-response">
                              <strong>
                                Copy this response back to the receiver
                              </strong>
                              <p className="hint">
                                On the receiver, paste it into Sender response
                                and choose Approve sender. Keep this tab open.
                              </p>
                              <label
                                className="pairing-label"
                                htmlFor="copy-response"
                              >
                                Sender response
                              </label>
                              <textarea
                                className="pairing-text"
                                id="copy-response"
                                readOnly
                                value={room.response ?? ''}
                                onFocus={(e) => e.target.select()}
                              />
                              <button
                                className="button"
                                onClick={() =>
                                  void guarded(async () => {
                                    await navigator.clipboard.writeText(
                                      room.response!,
                                    );
                                    setNotice(
                                      'Sender response copied. Paste it on the receiver and approve.',
                                    );
                                  })
                                }
                              >
                                <Copy size={16} />
                                Copy sender response
                              </button>
                            </div>
                          )}
                          <button
                            className="text-button muted"
                            disabled={busy}
                            onClick={() => void guarded(disconnect)}
                          >
                            <X size={14} />
                            {role === 'receive'
                              ? 'Revoke connection'
                              : 'Disconnect'}
                          </button>
                        </div>
                      )}
                      {!room && (
                        <div className="pairing-options">
                          <button
                            className="text-button"
                            disabled={busy}
                            onClick={() => {
                              setPairingMode(
                                pairingMode === 'code' ? 'manual' : 'code',
                              );
                              setCode('');
                              setResponse('');
                            }}
                          >
                            {pairingMode === 'code'
                              ? 'Use copy/paste pairing'
                              : 'Use six-digit pairing'}
                          </button>
                          {pairingMode === 'code' && (
                            <p className="hint">
                              No account needed. Only connection details go
                              through the pairing service; your files transfer
                              directly.
                            </p>
                          )}
                        </div>
                      )}
                      {room?.diagnostics && (
                        <details className="route-diagnostics">
                          <summary>Connection diagnostics</summary>
                          <p className="hint">
                            Local connection states and route counts only. No IP
                            addresses, pairing codes, filenames, or file data.
                            This report is never uploaded automatically.
                          </p>
                          <pre aria-label="Connection report">
                            {JSON.stringify(
                              {
                                version,
                                role,
                                ...room.diagnostics,
                              },
                              null,
                              2,
                            )}
                          </pre>
                          <button
                            className="text-button"
                            onClick={() =>
                              void guarded(async () => {
                                await navigator.clipboard.writeText(
                                  JSON.stringify(
                                    {
                                      version,
                                      role,
                                      ...room.diagnostics,
                                    },
                                    null,
                                    2,
                                  ),
                                );
                                setNotice('Connection report copied.');
                              })
                            }
                          >
                            <Copy size={14} /> Copy connection report
                          </button>
                        </details>
                      )}
                    </section>
                    <section className="panel files-panel">
                      <div className="section-head">
                        <h2>
                          <span className="step">02</span>
                          {role === 'send'
                            ? 'Choose what to send'
                            : 'Receive and save'}
                        </h2>
                        <span className="hint">
                          {role === 'send'
                            ? `${queue.length.toLocaleString()} files selected`
                            : `${received.length.toLocaleString()} files received`}
                        </span>
                      </div>
                      {role === 'send' ? (
                        <>
                          <div
                            className={
                              'drop-zone ' + (dragging ? 'dragging' : '')
                            }
                            onDragOver={(e) => {
                              e.preventDefault();
                              setDragging(true);
                            }}
                            onDragLeave={() => setDragging(false)}
                            onDrop={(e) => {
                              e.preventDefault();
                              setDragging(false);
                              const data = e.dataTransfer.items;
                              void guarded(async () =>
                                addFiles(await dropped(data)),
                              );
                            }}
                          >
                            <span className="drop-icon">
                              <ArrowUpFromLine size={28} />
                            </span>
                            <h3>Drop files or folders here</h3>
                            <p>
                              Documents, photos, videos, archives, and other
                              files.
                            </p>
                            <div className="button-row">
                              <button
                                className="button"
                                disabled={running || busy}
                                onClick={() => fileInput.current?.click()}
                              >
                                <File size={15} />
                                Choose files
                              </button>
                              <button
                                className="button"
                                disabled={running || busy}
                                onClick={() => folderInput.current?.click()}
                              >
                                <Folder size={15} />
                                Choose folder
                              </button>
                            </div>
                            <span className="hint">
                              Untouched bytes. No compression or conversion.
                            </span>
                          </div>
                          <input
                            ref={fileInput}
                            type="file"
                            multiple
                            hidden
                            aria-label="Choose files"
                            onChange={(e) => {
                              const files = e.target.files;
                              if (files)
                                void guarded(() => addFiles(selected(files)));
                              e.target.value = '';
                            }}
                          />
                          <input
                            ref={folderInput}
                            type="file"
                            multiple
                            hidden
                            aria-label="Choose folder"
                            onChange={(e) => {
                              const files = e.target.files;
                              if (files)
                                void guarded(() => addFiles(selected(files)));
                              e.target.value = '';
                            }}
                          />
                          <div className="send-footer">
                            <div>
                              <strong>{formatBytes(total)}</strong>
                              <span className="hint">total selected</span>
                            </div>
                            <button
                              className="button primary"
                              disabled={
                                !connected ||
                                running ||
                                busy ||
                                !queue.some(
                                  (q) =>
                                    ![
                                      'verified',
                                      'duplicate',
                                      'cancelled',
                                    ].includes(q.phase),
                                )
                              }
                              onClick={() => void send()}
                            >
                              <ArrowUpFromLine size={16} />
                              {queue.some((q) =>
                                ['failed', 'paused'].includes(q.phase),
                              )
                                ? 'Retry / resume files'
                                : 'Send files'}
                            </button>
                          </div>
                        </>
                      ) : (
                        <>
                          <div
                            className="storage-card"
                            aria-label="Browser staging storage"
                          >
                            <div className="storage-heading">
                              <span>Estimated staging space</span>
                              <strong>{capacityLabel}</strong>
                            </div>
                            <details>
                              <summary>How storage works</summary>
                              <p>
                                Received files stay in this browser until you
                                save and clear their staged copies.
                              </p>
                              {storageMode === 'indexeddb' && (
                                <p
                                  className="hint"
                                  aria-label="Compatibility storage"
                                >
                                  Compatibility storage is active. Files are
                                  stored locally in chunks and verified before
                                  download. Save and verify copies before
                                  closing a temporary or Private browsing
                                  session. Use smaller batches if storage is
                                  limited.
                                </p>
                              )}
                              <p>
                                This is the browser’s estimated remaining
                                storage allowance for this site. Estimates vary
                                by browser, profile, and device. Actual free
                                disk space may be lower.
                              </p>
                              <p>
                                Each file must fit alongside copies still staged
                                here. For larger collections, work in batches:
                                save or download the files, verify the saved
                                copies, then choose Clear verified staging to
                                make room for the next batch.
                              </p>
                              <p>
                                Private browsing may discard staged files when
                                its session closes. Save and verify the files
                                before closing that session.
                              </p>
                              <p>
                                Folder saving also keeps a staged copy until you
                                clear it, so allow disk space for both copies.
                                This estimate does not measure your destination
                                folder’s free space.
                              </p>
                            </details>
                          </div>
                          <h3 className="saving-heading">
                            Save verified copies
                          </h3>
                          <div className="destination">
                            <span className="folder-icon">
                              <Folder size={24} />
                            </span>
                            <div>
                              <strong>{folderName}</strong>
                              <p>
                                {folder.current
                                  ? 'Saved files will be reread and verified.'
                                  : 'Browser copies are verified before downloading.'}
                              </p>
                            </div>
                          </div>
                          <SaveToApp
                            folderControl={
                              <button
                                className="button"
                                disabled={
                                  busy ||
                                  !!active ||
                                  typeof (window as BrowserFolderWindow)
                                    .showDirectoryPicker !== 'function'
                                }
                                onClick={() => void guarded(selectFolder)}
                              >
                                <Folder size={16} aria-hidden="true" />
                                <span>Choose folder</span>
                              </button>
                            }
                            folderHint={
                              typeof (window as BrowserFolderWindow)
                                .showDirectoryPicker === 'function' && (
                                <p className="hint destination-hint">
                                  Choose a folder before receiving to save and
                                  verify files there automatically, preserving
                                  their folder structure.
                                </p>
                              )
                            }
                            folderAccessAvailable={
                              typeof (window as BrowserFolderWindow)
                                .showDirectoryPicker === 'function'
                            }
                            records={storedReceived}
                            disabled={busy || !!active}
                            changed={async () => {
                              await refresh();
                              const updates = await local.receivedFiles();
                              for (const record of updates)
                                if (receivedRecords.current.has(record.id))
                                  receivedRecords.current.set(
                                    record.id,
                                    record,
                                  );
                              setReceived(
                                [...receivedRecords.current.values()].reverse(),
                              );
                            }}
                          />
                          {folder.current && (
                            <button
                              className="text-button"
                              disabled={busy || !!active}
                              onClick={() => {
                                folder.current = undefined;
                                setFolderName('Manual download');
                              }}
                            >
                              Use downloads
                            </button>
                          )}
                          <div className="receive-wait">
                            <ArrowDownToLine size={28} />
                            <strong>
                              {active
                                ? 'Receiving original bytes'
                                : connected
                                  ? 'Ready for your files'
                                  : 'Connect a sender to begin'}
                            </strong>
                            <p>
                              {active ||
                                'Files appear below as the sender starts transferring.'}
                            </p>
                          </div>
                          <div className="batch-actions">
                            <span className="batch-label">
                              Manage received copies
                            </span>
                            <div className="button-row">
                              <button
                                className="button"
                                disabled={
                                  busy || !!active || !storedReceived.length
                                }
                                onClick={() => void guarded(exportBatch)}
                              >
                                <ArrowDownToLine size={16} />
                                Export verified batch
                              </button>
                              <button
                                className="button"
                                disabled={busy || !storedReceived.length}
                                onClick={() => verifyInput.current?.click()}
                              >
                                <ShieldCheck size={16} />
                                Verify saved copies
                              </button>
                              <button
                                className="text-button"
                                disabled={busy || !!active}
                                onClick={() => void guarded(clearVerified)}
                              >
                                <Trash2 size={15} />
                                Clear verified staging
                              </button>
                            </div>
                          </div>
                        </>
                      )}
                    </section>
                  </div>
                  <aside className="details-column">
                    <section className="panel progress-panel">
                      <div className="section-head">
                        <h2>Transfer overview</h2>
                        <ShieldCheck size={18} />
                      </div>
                      <div className="progress-number">
                        {percent}
                        <span>%</span>
                      </div>
                      <div
                        className="progress-track"
                        role="progressbar"
                        aria-label="Bytes transferred"
                        aria-valuenow={percent}
                        aria-valuemin={0}
                        aria-valuemax={100}
                      >
                        <span style={{ width: `${percent}%` }} />
                      </div>
                      <div className="progress-meta">
                        <span>{formatBytes(bytes)} transferred</span>
                        <span>{formatBytes(total)}</span>
                      </div>
                      <div className="metric-row">
                        <span>Verified copies</span>
                        <strong className="accent-text">
                          {verified.toLocaleString()} <CheckCheck size={15} />
                        </strong>
                      </div>
                      <div className="metric-row">
                        <span>Needs retry</span>
                        <strong>{failed}</strong>
                      </div>
                      <div className="metric-row">
                        <span>Speed</span>
                        <strong>
                          {speed ? `${formatBytes(speed)}/s` : '—'}
                        </strong>
                      </div>
                      <div className="metric-row">
                        <span>Time remaining</span>
                        <strong>
                          {eta ? `${Math.ceil(eta / 60)} min` : '—'}
                        </strong>
                      </div>
                      {active && (
                        <div className="current-file">
                          <span className="hint">CURRENT FILE</span>
                          <strong>{active}</strong>
                        </div>
                      )}
                      {(running || (connected && role === 'receive')) && (
                        <div className="queue-controls">
                          <button className="button" onClick={togglePause}>
                            {paused ? <Play size={15} /> : <Pause size={15} />}{' '}
                            {paused ? 'Resume' : 'Pause'}
                          </button>
                          {running && (
                            <>
                              <button
                                className="icon-button"
                                aria-label="Cancel current file"
                                title="Cancel current file"
                                onClick={() => sender.current?.cancel(true)}
                              >
                                <X size={17} />
                              </button>
                              <button
                                className="icon-button"
                                aria-label="Cancel queue"
                                title="Cancel queue"
                                onClick={() => sender.current?.cancel()}
                              >
                                <Square size={15} />
                              </button>
                            </>
                          )}
                        </div>
                      )}
                    </section>
                    <section className="integrity-card">
                      <span className="shield-icon">
                        <ShieldCheck size={24} />
                      </span>
                      <h3>Every byte accounted for.</h3>
                      <p>
                        Source and stored copies are checked with SHA-256.
                        Verification can’t be turned off.
                      </p>
                      <div>
                        <LockKeyhole size={14} />
                        Encrypted in transit
                      </div>
                      <div>
                        <Check size={14} />
                        No cloud file storage
                      </div>
                    </section>
                    <p className="sidebar-note">
                      Keep both browsers open.
                      <br />
                      Screen lock may interrupt a transfer.
                    </p>
                  </aside>
                </div>
              )}
              <section className="panel queue-panel">
                <div className="section-head">
                  <h2>
                    {view === 'history'
                      ? 'Saved transfer records'
                      : 'File queue'}{' '}
                    <span className="count-tag">
                      {displayQueue ? queue.length : list.length}
                    </span>
                  </h2>
                  <div className="report-actions">
                    {view === 'history' && (
                      <button
                        className="text-button"
                        disabled={busy || !!active || !historyRecords.length}
                        onClick={() =>
                          void guarded(async () => {
                            if (
                              !window.confirm(
                                `Clear ${historyRecords.length} transfer history records${historySession === 'all' ? '' : ' in this session'}? Staged files, saved copies, and resume checkpoints will be kept.`,
                              )
                            )
                              return;
                            await local.clearHistory(
                              historySession === 'all'
                                ? undefined
                                : historySession,
                            );
                            setHistorySession('all');
                            await refresh();
                            setNotice(
                              'Transfer history cleared. Staged files, saved copies, and resume checkpoints were kept.',
                            );
                          })
                        }
                      >
                        <Trash2 size={15} />
                        Clear history
                      </button>
                    )}
                    {(['json', 'csv', 'txt'] as const).map((format) => (
                      <button
                        key={format}
                        className="text-button"
                        disabled={!list.length}
                        onClick={() => downloadReport(list, format)}
                      >
                        {format.toUpperCase()}
                      </button>
                    ))}
                    {displayQueue && queue.length > 0 && !running && (
                      <button
                        className="text-button"
                        onClick={() => {
                          currentQueue.current = [];
                          setQueue([]);
                        }}
                      >
                        Clear queue
                      </button>
                    )}
                  </div>
                </div>
                {view === 'history' && (
                  <div className="history-toolbar">
                    <label htmlFor="history-session">Session</label>
                    <select
                      id="history-session"
                      value={historySession}
                      onChange={(e) => setHistorySession(e.target.value)}
                    >
                      <option value="all">All sessions</option>
                      {sessions.map((id) => (
                        <option key={id} value={id}>
                          {new Date(
                            history.find((r) => r.sessionId === id)!.updated,
                          ).toLocaleString()}{' '}
                          · {id.slice(0, 8)}
                        </option>
                      ))}
                    </select>
                    <button
                      className="button"
                      disabled={busy}
                      onClick={() => verifyInput.current?.click()}
                    >
                      <ShieldCheck size={15} />
                      Verify exported files
                    </button>
                    <button
                      className="button"
                      disabled={busy || running || !!active}
                      onClick={() => void guarded(exportBatch)}
                    >
                      Export verified batch
                    </button>
                    <button
                      className="text-button"
                      disabled={busy || running || !!active}
                      onClick={() => void guarded(clearVerified)}
                    >
                      Clear verified staging
                    </button>
                  </div>
                )}
                {(displayQueue ? queue : list).length === 0 ? (
                  <div className="empty-state">
                    <File size={26} />
                    <strong>
                      {view === 'history'
                        ? 'No history records'
                        : 'Your queue is clear'}
                    </strong>
                    <span>
                      {view === 'history'
                        ? 'Verified copies and interrupted transfers will be recorded here.'
                        : role === 'send'
                          ? 'Choose files to get started.'
                          : 'Incoming files will appear here.'}
                    </span>
                  </div>
                ) : (
                  <div className="file-list">
                    {displayQueue
                      ? queue.slice(0, visible).map((q) => (
                          <div className="file-row" key={q.key}>
                            <span className="file-symbol">
                              <File size={19} />
                            </span>
                            <div className="file-info">
                              <strong>{q.path}</strong>
                              <small>
                                {q.record &&
                                [
                                  'transferring',
                                  'paused',
                                  'verifying',
                                ].includes(q.phase)
                                  ? `${formatBytes(q.record.bytes)} / `
                                  : ''}
                                {formatBytes(q.file.size)}
                                {q.error && ` · ${q.error}`}
                              </small>
                            </div>
                            <span className={'file-status ' + q.phase}>
                              {q.record && isVerified(q.record) ? (
                                <Check size={14} />
                              ) : [
                                  'hashing',
                                  'transferring',
                                  'verifying',
                                ].includes(q.phase) ? (
                                <LoaderCircle className="spin" size={14} />
                              ) : null}
                              {q.record && isVerified(q.record)
                                ? verificationLabel(q.record)
                                : phaseLabel[q.phase]}
                            </span>
                            {!running &&
                              !['verified', 'duplicate'].includes(q.phase) && (
                                <button
                                  className="icon-button"
                                  aria-label={`Remove ${q.path}`}
                                  onClick={() => {
                                    currentQueue.current =
                                      currentQueue.current.filter(
                                        (x) => x.key !== q.key,
                                      );
                                    setQueue([...currentQueue.current]);
                                  }}
                                >
                                  <X size={15} />
                                </button>
                              )}
                          </div>
                        ))
                      : list.slice(0, visible).map((r) => (
                          <div
                            className="file-row"
                            key={`${r.localRole}:${r.sessionId}:${r.id}`}
                          >
                            <span className="file-symbol">
                              <File size={19} />
                            </span>
                            <div className="file-info">
                              <strong>{r.relativePath}</strong>
                              <small>
                                {r.bytes < r.size
                                  ? `${formatBytes(r.bytes)} / `
                                  : ''}
                                {formatBytes(r.size)} · {r.sha256.slice(0, 12)}…
                                {r.error && ` · ${r.error}`}
                              </small>
                            </div>
                            <span className={'file-status ' + r.phase}>
                              {isVerified(r) && <Check size={14} />}
                              {verificationLabel(r)}
                            </span>
                            {isVerified(r) && r.localRole !== 'send' && (
                              <button
                                className="icon-button"
                                title={
                                  folder.current
                                    ? 'Save to folder'
                                    : 'Download verified browser copy'
                                }
                                aria-label={`Save ${r.originalName}`}
                                disabled={busy || !!active}
                                onClick={() => void guarded(() => save(r))}
                              >
                                <ArrowDownToLine size={17} />
                              </button>
                            )}
                          </div>
                        ))}
                  </div>
                )}
                {(displayQueue ? queue.length : list.length) > visible && (
                  <button
                    className="text-button show-more"
                    onClick={() => setVisible((v) => v + 100)}
                  >
                    Show more files <ChevronDown size={15} />
                  </button>
                )}
              </section>
              <input
                ref={verifyInput}
                type="file"
                multiple
                hidden
                aria-label="Verify saved copies"
                onChange={(e) => {
                  const files = Array.from(e.target.files ?? []);
                  e.target.value = '';
                  void guarded(async () => {
                    const records = await local.receivedFiles();
                    let count = 0;
                    for (const f of files)
                      count += await verifyExport(f, records);
                    setNotice(
                      `${count} exported copies verified against their source hashes.`,
                    );
                    await refresh();
                    const updated = await local.receivedFiles();
                    for (const r of updated)
                      receivedRecords.current.set(r.id, r);
                    setReceived(
                      [...receivedRecords.current.values()].reverse(),
                    );
                  });
                }}
              />
            </>
          )}
          <footer className="page-footer">
            <span>
              PixelGate {version} <span className="footer-divider">/</span>{' '}
              Original bytes. Verified copies.
            </span>
            <span>
              <a
                href="https://github.com/s4lmon778/PixelGate"
                target="_blank"
                rel="noreferrer"
              >
                Source on GitHub
              </a>{' '}
              · Confirm backups in your chosen app or service.
            </span>
          </footer>
        </main>
      </div>
    </div>
  );
}
function historyReplace() {
  window.history.replaceState(null, '', location.pathname);
}

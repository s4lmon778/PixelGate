import { useEffect, useState, useRef } from 'react';
import type { StripedChannel } from '@/lib/bridge/striped-channel';
import type { LinkTestSnapshot } from '@/lib/bridge/peer-link-test';
import {
  browserNetwork,
  testInternetDownload,
  type InternetResult,
} from '@/lib/bridge/network-test';

const rate = (bytes: number) =>
  `${(bytes / 1000000).toFixed(2)} MB/s · ${((bytes * 8) / 1000000).toFixed(1)} Mbps`;
export function NetworkDiagnostics({
  transport,
  disabled,
  fileBusy,
  internet,
  savedPeer,
  measured,
  busyChanged,
}: {
  transport?: StripedChannel;
  disabled: boolean;
  fileBusy: boolean;
  internet?: InternetResult;
  savedPeer?: LinkTestSnapshot;
  measured: (result: InternetResult) => void;
  busyChanged: (busy: boolean) => void;
}) {
  const [peer, setPeer] = useState(() => transport?.linkTest.snapshot());
  const [downloading, setDownloading] = useState(false);
  const [status, setStatus] = useState('');
  const [limit, setLimit] = useState('auto');
  const controller = useRef<AbortController | undefined>(undefined);
  const hint = browserNetwork();
  const snapshot = transport ? peer : savedPeer;
  useEffect(() => {
    const update = () => setPeer(transport?.linkTest.snapshot());
    const fileStarted = () => controller.current?.abort();
    setLimit('auto');
    update();
    transport?.addEventListener('linktestchange', update);
    transport?.addEventListener('file-transfer-start', fileStarted);
    return () => {
      transport?.removeEventListener('linktestchange', update);
      transport?.removeEventListener('file-transfer-start', fileStarted);
    };
  }, [transport]);
  useEffect(() => {
    busyChanged(downloading || !!peer?.running);
    return () => busyChanged(false);
  }, [downloading, peer?.running, busyChanged]);
  useEffect(() => {
    if (fileBusy) {
      controller.current?.abort();
      transport?.linkTest.cancel('A file operation started; test stopped.');
    }
  }, [fileBusy, transport]);
  useEffect(
    () => () => {
      controller.current?.abort();
    },
    [],
  );
  const busy = downloading || !!peer?.running;
  async function download() {
    const request = new AbortController();
    controller.current = request;
    setDownloading(true);
    setStatus('Testing internet download…');
    try {
      const result = await testInternetDownload(request.signal, (bytes) =>
        setStatus(
          `Testing internet download… ${(bytes / 1048576).toFixed(1)} / 8 MiB`,
        ),
      );
      measured(result);
      setStatus('Internet test complete');
    } catch (error) {
      setStatus(
        request.signal.aborted
          ? 'Internet test cancelled.'
          : error instanceof Error
            ? error.message
            : 'Internet test unavailable.',
      );
    } finally {
      if (controller.current === request) controller.current = undefined;
      setDownloading(false);
    }
  }
  return (
    <section className="network-tests" aria-label="Network speed checks">
      <strong>Network speed checks</strong>
      <p className="hint">
        Peer test sends 8 MiB from sender to receiver without file storage.
        Internet test downloads up to 8.25 MiB of dummy data from Cloudflare.
        Run while both devices are idle.
      </p>
      <div className="save-actions">
        <button
          className="text-button"
          disabled={
            disabled ||
            busy ||
            transport?.readyState !== 'open' ||
            !peer?.supported
          }
          onClick={() => {
            try {
              transport?.linkTest.start();
            } catch (error) {
              setStatus(
                error instanceof Error
                  ? error.message
                  : 'Peer test unavailable.',
              );
            }
          }}
        >
          Test peer link
        </button>
        <button
          className="text-button"
          disabled={disabled || busy}
          onClick={() => void download()}
        >
          Test internet download
        </button>
        {busy && (
          <button
            className="text-button"
            onClick={() => {
              controller.current?.abort();
              transport?.linkTest.cancel();
            }}
          >
            Stop speed test
          </button>
        )}
      </div>
      {transport?.canLimitPayload && (
        <label className="hint">
          Payload connection limit (this connection){' '}
          <select
            aria-label="Payload connection limit"
            value={limit}
            disabled={disabled || busy}
            onChange={(event) => {
              try {
                transport.setPayloadLimit(
                  event.target.value === 'auto'
                    ? undefined
                    : Number(event.target.value),
                );
                setLimit(event.target.value);
              } catch (error) {
                setStatus(
                  error instanceof Error
                    ? error.message
                    : 'Could not change the limit.',
                );
              }
            }}
          >
            <option value="auto">
              Automatic · up to{' '}
              {Math.min(
                transport.defaultPayloadConnections,
                transport.maximumPayloadConnections,
              )}
            </option>
            <option
              value="14"
              disabled={transport.maximumPayloadConnections < 14}
            >
              Up to 14
            </option>
            <option
              value="7"
              disabled={transport.maximumPayloadConnections < 7}
            >
              Up to 7
            </option>
            <option value="5">Up to 5</option>
          </select>
        </label>
      )}
      {transport && !peer?.supported && (
        <p className="hint">
          Update both devices to enable the peer-link test.
        </p>
      )}
      {hint.estimatedDownlinkMbps !== undefined && (
        <p className="hint">
          Browser estimate: {hint.estimatedDownlinkMbps} Mbps. This is not a
          measured Wi-Fi speed.
        </p>
      )}
      {snapshot?.result && (
        <p className="hint" data-testid="peer-speed-result">
          Last peer link, without storage:{' '}
          <strong>{rate(snapshot.result.bytesPerSecond)}</strong> ·{' '}
          {snapshot.result.connections} connections ·{' '}
          {new Date(snapshot.result.measuredAt).toLocaleString()}
          {snapshot.result.milliseconds < 250 ? ' · short sample' : ''}
        </p>
      )}
      {internet && (
        <p className="hint" data-testid="internet-speed-result">
          Last internet download:{' '}
          <strong>{rate(internet.bytesPerSecond)}</strong> ·{' '}
          {new Date(internet.measuredAt).toLocaleString()}
          {internet.milliseconds < 250 ? ' · short sample' : ''}
        </p>
      )}
      <p className="hint">
        Internet speed includes the ISP and test server. Peer speed includes
        WebRTC and browser processing. Neither measures the Wi-Fi radio’s
        maximum speed or proves the cause of a slowdown. No files or reports are
        uploaded.
      </p>
      <p className="hint" role="status">
        {busy && peer?.running ? peer.status : status || snapshot?.status}
      </p>
    </section>
  );
}

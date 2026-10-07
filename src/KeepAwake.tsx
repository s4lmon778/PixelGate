import { useEffect, useState } from 'react';
import { Sun } from 'lucide-react';

type Status = 'idle' | 'requesting' | 'active' | 'released' | 'unavailable';

export function KeepAwake({ active }: { active: boolean }) {
  const supported = typeof navigator.wakeLock?.request === 'function';
  const [enabled, setEnabled] = useState(() => {
    try {
      return localStorage.getItem('pixelgate-keep-awake') !== 'off';
    } catch {
      return true;
    }
  });
  const [status, setStatus] = useState<Status>('idle');
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    if (!supported || !enabled || !active) return;
    let disposed = false;
    let requesting = false;
    let lock: WakeLockSentinel | undefined;
    const request = async () => {
      if (
        disposed ||
        requesting ||
        (lock && !lock.released) ||
        document.visibilityState !== 'visible'
      )
        return;
      requesting = true;
      setStatus('requesting');
      try {
        const acquired = await navigator.wakeLock.request('screen');
        // A switch change or unmount can happen while the browser is asking.
        if (disposed) {
          await acquired.release();
          return;
        }
        lock = acquired;
        acquired.addEventListener('release', () => {
          if (!disposed) setStatus('released');
        });
        setStatus(acquired.released ? 'released' : 'active');
      } catch {
        if (!disposed) setStatus('unavailable');
      } finally {
        requesting = false;
      }
    };
    const visible = () => {
      void request();
    };
    void request();
    document.addEventListener('visibilitychange', visible);
    return () => {
      disposed = true;
      document.removeEventListener('visibilitychange', visible);
      void lock?.release().catch(() => {});
    };
  }, [active, enabled, supported, retry]);

  const message = !supported
    ? 'Unavailable in this browser. Set a longer screen timeout in your device settings for transfers.'
    : !enabled
      ? 'Off — your device’s normal screen timeout applies.'
      : !active
        ? 'Ready — starts when pairing begins.'
        : status === 'active'
          ? 'Active — this screen is staying awake.'
          : status === 'requesting'
            ? 'Requesting screen lock…'
            : 'Not active — the browser or device released or denied the screen lock. Keep this tab visible and check power-saving settings.';

  return (
    <section className="awake-card" aria-label="Screen awake controls">
      <div className="awake-heading">
        <Sun size={19} aria-hidden="true" />
        <strong id="awake-label">Keep screen awake</strong>
        <button
          type="button"
          role="switch"
          className="awake-switch"
          aria-labelledby="awake-label"
          aria-describedby="awake-status"
          aria-checked={supported && enabled}
          disabled={!supported}
          onClick={() => {
            const value = !enabled;
            setEnabled(value);
            try {
              localStorage.setItem(
                'pixelgate-keep-awake',
                value ? 'on' : 'off',
              );
            } catch {
              /* Optional preference. */
            }
          }}
        >
          <span className="awake-scene" aria-hidden="true">
            <svg className="awake-sky" viewBox="0 0 96 42" fill="none">
              <g className="awake-halo" fill="white">
                <circle cx="21" cy="21" r="59" opacity=".07" />
                <circle cx="21" cy="21" r="45" opacity=".1" />
                <circle cx="21" cy="21" r="31" opacity=".14" />
              </g>
              <g className="awake-clouds">
                <path
                  d="M27 44c0-8 9-14 16-10 1-10 12-15 20-9 3-8 13-10 20-4 0-8 6-13 13-12v35Z"
                  fill="#b5d9f1"
                />
                <path
                  d="M39 44c0-6 6-10 12-7 2-7 10-11 16-7 3-8 12-10 18-4 2-6 6-10 11-10v28Z"
                  fill="#e4f2fa"
                />
              </g>
              <g className="awake-stars" fill="#e3ebf5">
                <path d="m16 8 1.2 3.2 3.3 1.1-3.3 1.2-1.2 3.2-1.1-3.2-3.3-1.2 3.3-1.1ZM34 26l.9 2.4 2.4.9-2.4.8-.9 2.4-.8-2.4-2.4-.8 2.4-.9Z" />
                <circle cx="7" cy="23" r=".9" />
                <circle cx="24" cy="34" r=".9" />
                <circle cx="32" cy="10" r=".8" />
                <circle cx="43" cy="20" r=".8" />
              </g>
            </svg>
            <span className="awake-thumb">
              <svg
                className="awake-craters"
                viewBox="0 0 34 34"
                fill="currentColor"
              >
                <circle cx="11" cy="19" r="5.3" />
                <circle cx="19" cy="9" r="3.2" />
                <circle cx="25" cy="23" r="3.7" />
              </svg>
            </span>
          </span>
          <span className="awake-word" aria-hidden="true">
            {supported && enabled ? 'On' : 'Off'}
          </span>
        </button>
      </div>
      <p id="awake-status" role="status">
        {message}
      </p>
      {supported &&
        enabled &&
        active &&
        ['released', 'unavailable'].includes(status) && (
          <button
            className="text-button"
            onClick={() => setRetry((n) => n + 1)}
          >
            Try keeping awake again
          </button>
        )}
      <small>
        Enable on both devices. Uses more battery. Locking the screen or leaving
        the browser can still pause transfers.
      </small>
    </section>
  );
}

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
          <span />
          {supported && enabled ? 'On' : 'Off'}
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

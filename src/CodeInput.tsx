import { pairingCode } from '@/lib/bridge/code-connection';

export function CodeInput({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
}) {
  return (
    <div className="code-entry">
      <div className="code-slots" aria-hidden="true">
        {Array.from({ length: 6 }, (_, index) => (
          <span key={index}>{value[index] || '—'}</span>
        ))}
      </div>
      <input
        id="pair-code"
        aria-label="Receiver’s six-digit code"
        type="text"
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="[0-9]{6}"
        maxLength={6}
        value={value}
        disabled={disabled}
        onPaste={(event) => {
          try {
            const code = pairingCode(event.clipboardData.getData('text'));
            event.preventDefault();
            onChange(code);
          } catch {
            /* Let normal editing handle incomplete input. */
          }
        }}
        onChange={(event) =>
          onChange(event.target.value.replace(/\D/g, '').slice(0, 6))
        }
      />
    </div>
  );
}

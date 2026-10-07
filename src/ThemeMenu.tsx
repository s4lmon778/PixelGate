import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Monitor, Moon, Sun } from 'lucide-react';
import { readTheme, saveTheme, type Theme } from './theme';

const options = [
  { value: 'light', label: 'Light', Icon: Sun },
  { value: 'dark', label: 'Dark', Icon: Moon },
  { value: 'system', label: 'System', Icon: Monitor },
] as const;

export function ThemeMenu() {
  const [theme, setTheme] = useState<Theme>(readTheme);
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const Current = options.find((o) => o.value === theme)!.Icon;

  useEffect(() => {
    if (!open) return;
    menu.current
      ?.querySelector<HTMLButtonElement>('[aria-checked="true"]')
      ?.focus();
    const outside = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);

  function close() {
    setOpen(false);
    trigger.current?.focus();
  }
  return (
    <div className="theme-control" ref={root}>
      <button
        className="theme-trigger"
        ref={trigger}
        aria-label="Appearance"
        title="Light, dark, or system appearance"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? 'theme-menu' : undefined}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (['ArrowDown', 'ArrowUp'].includes(e.key)) {
            e.preventDefault();
            setOpen(true);
          }
        }}
      >
        <Current size={18} />
        <ChevronDown size={12} />
      </button>
      {open && (
        <div
          className="theme-menu"
          id="theme-menu"
          role="menu"
          aria-label="Color theme"
          ref={menu}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              close();
            } else if (e.key === 'Tab') setOpen(false);
            else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
              e.preventDefault();
              const items = [
                ...menu.current!.querySelectorAll<HTMLButtonElement>('button'),
              ];
              const at = items.indexOf(
                document.activeElement as HTMLButtonElement,
              );
              const next =
                e.key === 'Home'
                  ? 0
                  : e.key === 'End'
                    ? items.length - 1
                    : (at + (e.key === 'ArrowDown' ? 1 : -1) + items.length) %
                      items.length;
              items[next]?.focus();
            }
          }}
        >
          {options.map(({ value, label, Icon }) => (
            <button
              key={value}
              role="menuitemradio"
              aria-checked={theme === value}
              tabIndex={-1}
              onClick={() => {
                saveTheme(value);
                setTheme(value);
                close();
              }}
            >
              <Icon size={17} />
              <span>{label}</span>
              {theme === value && <Check size={15} />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

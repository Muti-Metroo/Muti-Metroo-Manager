import { useEffect, useRef } from 'react';

type AlertKind = 'success' | 'error';

interface AlertProps {
  kind: AlertKind;
  message: string;
  onClose: () => void;
  // Override the auto-close timeout. 0 disables auto-close. Defaults:
  // success 4s (long enough to read a short confirmation), error 8s
  // (gives time to read multi-line server messages like 409 dependent
  // host lists).
  autoCloseMs?: number;
}

const DEFAULT_AUTO_CLOSE: Record<AlertKind, number> = {
  success: 4000,
  error: 8000,
};

const ICON: Record<AlertKind, string> = {
  success: 'icon-[tabler--circle-check]',
  error: 'icon-[tabler--alert-triangle]',
};

export default function Alert({ kind, message, onClose, autoCloseMs }: AlertProps) {
  const ms = autoCloseMs ?? DEFAULT_AUTO_CLOSE[kind];

  // Read the latest onClose without making the timer effect depend on
  // it — parents commonly pass an inline arrow that changes identity
  // every render, which would otherwise reset the timer continuously.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (ms <= 0) return;
    const id = window.setTimeout(() => onCloseRef.current(), ms);
    return () => window.clearTimeout(id);
  }, [ms, message]);

  return (
    <div
      className={`alert alert-soft ${kind === 'error' ? 'alert-error' : 'alert-success'} mb-2 flex items-start gap-2`}
      role={kind === 'error' ? 'alert' : 'status'}
    >
      <span className={`${ICON[kind]} mt-0.5 size-4 shrink-0`} aria-hidden="true" />
      <span className="min-w-0 flex-1 break-words whitespace-pre-wrap">{message}</span>
      <button
        type="button"
        className="btn btn-text btn-xs btn-square -mt-0.5 -me-1"
        aria-label="Dismiss"
        onClick={onClose}
      >
        <span className="icon-[tabler--x] size-3.5" aria-hidden="true" />
      </button>
    </div>
  );
}

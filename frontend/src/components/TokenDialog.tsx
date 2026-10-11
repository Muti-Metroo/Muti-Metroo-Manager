import { useState } from 'react';
import type { TokenPersist } from '../api/client';
import { useModalDismiss } from '../hooks/useModalDismiss';
import DialogHeader from './DialogHeader';

interface TokenDialogProps {
  onSubmit: (token: string, persist: TokenPersist) => Promise<void>;
  // Optional overrides let the same dialog serve the manager's own login
  // gate (which exchanges the token for a session cookie and has no use for
  // the persist toggle) without duplicating the markup.
  title?: string;
  description?: string;
  showPersist?: boolean;
}

export default function TokenDialog({
  onSubmit,
  title = 'Authentication required',
  description = 'The Muti Metroo agent requires a bearer token. Enter the token to continue.',
  showPersist = true,
}: TokenDialogProps) {
  const [value, setValue] = useState('');
  const [persist, setPersist] = useState<TokenPersist>('session');
  const [error, setError] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [validating, setValidating] = useState(false);
  useModalDismiss();

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    setValue(e.target.value);
    setError(false);
    setErrorMessage('');
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = value.trim();
    if (!trimmed) {
      setError(true);
      return;
    }
    setError(false);
    setErrorMessage('');
    setValidating(true);
    try {
      await onSubmit(trimmed, persist);
    } catch {
      setError(true);
      setErrorMessage('Invalid token');
    } finally {
      setValidating(false);
    }
  }

  return (
    <div className="ui-overlay">
      <form
        className="ui-dialog max-w-md"
        name="muti-metroo-auth"
        role="dialog"
        aria-modal="true"
        aria-label="Authentication required"
        onSubmit={handleSubmit}
      >
        <DialogHeader title={title} icon="icon-[tabler--lock]" />
        <div className="ui-dialog-body space-y-3">
          <p className="text-muted">{description}</p>
          <input
            className={`input input-sm font-mono w-full${error ? ' is-invalid' : ''}`}
            type="password"
            name="token"
            placeholder="Bearer token"
            value={value}
            onChange={handleChange}
            disabled={validating}
            autoFocus
            autoComplete="current-password"
          />
          {showPersist && (
            <>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  className="checkbox checkbox-sm checkbox-primary"
                  checked={persist === 'long'}
                  onChange={e => setPersist(e.target.checked ? 'long' : 'session')}
                  disabled={validating}
                />
                <span>Remember on this device for 8 hours</span>
              </label>
              <p className="text-muted text-xs">
                Stored only in this browser. Use <strong>Sign out</strong> in the actions menu to
                clear it.
              </p>
            </>
          )}
          {errorMessage && (
            <p className="text-error" role="alert">
              {errorMessage}
            </p>
          )}
        </div>
        <div className="ui-dialog-footer">
          <button type="submit" className="btn btn-sm btn-primary" disabled={validating}>
            {validating ? 'Validating...' : 'Authenticate'}
          </button>
        </div>
      </form>
    </div>
  );
}

import { useRef, useState } from 'react';
import type { AppSettings } from '../api/types';
import { putSettings } from '../api/client';
import { validateHostPort } from '../util/validate';
import { ensureHttpScheme, hasHttpScheme } from '../util/url';
import { useModalDismiss } from '../hooks/useModalDismiss';
import DialogHeader from './DialogHeader';

interface SettingsDialogProps {
  initial: AppSettings;
  defaults: { apiAddress: string; socksAddress: string };
  onSave: (saved: AppSettings) => void;
  onClose: () => void;
}

// Validates the API-address field. Accepts bare host:port (Muti Metroo CLI
// treats as http) or http(s)://host[:port][/prefix] — mirrors
// ../Muti-Metroo/internal/apiclient/endpoint.go:Parse.
function apiEndpointError(value: string): string | null {
  const v = value.trim();
  if (!v) return null;
  if (hasHttpScheme(v)) {
    try {
      const u = new URL(v);
      if (!u.hostname) return 'Missing host';
      if (u.username || u.password) return 'Credentials are not allowed';
      if (u.search) return 'Query strings are not allowed';
      if (u.hash) return 'Fragments are not allowed';
      return null;
    } catch {
      return 'Invalid URL';
    }
  }
  if (v.includes('://')) return 'Only http and https schemes are supported';
  return validateHostPort(v);
}

// Validates the SOCKS5-address field; strict host:port, no scheme or path.
function socksAddressError(value: string): string | null {
  const v = value.trim();
  if (!v) return null;
  return validateHostPort(v);
}

// The CLI accepts bare host:port (treating it as http), but we store the
// canonical URL form so the scheme is unambiguous and matches whatever
// Muti Metroo Manager is currently reachable on. Called before PUT.
function canonicaliseApiAddress(value: string): string {
  return ensureHttpScheme(value, window.location.protocol);
}

export default function SettingsDialog({
  initial,
  defaults,
  onSave,
  onClose,
}: SettingsDialogProps) {
  const [api, setApi] = useState(initial.api_address);
  const [socks, setSocks] = useState(initial.socks_address);
  const [sounds, setSounds] = useState(initial.sounds_enabled);
  const soundsLocked = !!initial.sounds_locked;
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Only treat an overlay click as "close" when the press *started* on the
  // overlay — otherwise dragging a text selection from an input out past
  // the modal would dismiss the dialog mid-select.
  const mouseDownOnOverlay = useRef(false);
  useModalDismiss({ onClose: saving ? undefined : onClose });

  const apiError = apiEndpointError(api);
  const socksError = socksAddressError(socks);
  const canSubmit = apiError === null && socksError === null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) {
      setError(apiError ?? socksError);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const saved = await putSettings({
        api_address: canonicaliseApiAddress(api),
        socks_address: socks.trim(),
        sounds_enabled: soundsLocked ? false : sounds,
      });
      onSave(saved);
      onClose();
    } catch (err: any) {
      setError(err?.message || 'Failed to save settings');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className="ui-overlay"
      onMouseDown={e => {
        mouseDownOnOverlay.current = e.target === e.currentTarget;
      }}
      onClick={e => {
        if (mouseDownOnOverlay.current && e.target === e.currentTarget) onClose();
        mouseDownOnOverlay.current = false;
      }}
    >
      <form
        className="ui-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Muti Metroo Manager settings"
        onSubmit={handleSubmit}
      >
        <DialogHeader title="Muti Metroo Manager settings" icon="icon-[tabler--settings]" />
        <div className="ui-dialog-body space-y-4">
          <p className="text-muted">
            Override the advertised Muti Metroo agent API and SOCKS5 addresses shown by the UI.
            These are <strong>display-only</strong> — the manager still proxies to whichever agent
            URL was passed via <code className="bg-base-200 rounded px-1 font-mono">-agent</code>;
            this dialog does not change which agent the manager connects to.
          </p>

          <div className="space-y-1">
            <div className="flex items-baseline justify-between gap-2">
              <label htmlFor="settings-api" className="font-medium">
                Muti Metroo agent API address
              </label>
              <button
                type="button"
                className="btn btn-text btn-xs"
                onClick={() => {
                  setApi('');
                  setError(null);
                }}
                disabled={saving || api === ''}
                title={`Reset to ${defaults.apiAddress}`}
              >
                Reset to default
              </button>
            </div>
            <input
              id="settings-api"
              className={`input input-sm w-full font-mono${apiError ? ' is-invalid' : ''}`}
              type="text"
              placeholder={defaults.apiAddress}
              value={api}
              onChange={e => {
                setApi(e.target.value);
                setError(null);
              }}
              disabled={saving}
              autoFocus
              spellCheck={false}
            />
            <p className={`text-xs ${apiError ? 'text-error' : 'text-muted'}`}>
              {apiError ??
                'Used by the UI to label this Muti Metroo agent; does not change which agent the manager connects to.'}
            </p>
          </div>

          <div className="space-y-1">
            <div className="flex items-baseline justify-between gap-2">
              <label htmlFor="settings-socks" className="font-medium">
                SOCKS5 proxy address
              </label>
              <button
                type="button"
                className="btn btn-text btn-xs"
                onClick={() => {
                  setSocks('');
                  setError(null);
                }}
                disabled={saving || socks === ''}
                title={`Reset to ${defaults.socksAddress}`}
              >
                Reset to default
              </button>
            </div>
            <input
              id="settings-socks"
              className={`input input-sm w-full font-mono${socksError ? ' is-invalid' : ''}`}
              type="text"
              placeholder={defaults.socksAddress}
              value={socks}
              onChange={e => {
                setSocks(e.target.value);
                setError(null);
              }}
              disabled={saving}
              spellCheck={false}
            />
            <p className={`text-xs ${socksError ? 'text-error' : 'text-muted'}`}>
              {socksError ??
                'Where this agent accepts SOCKS proxy connections from outside (display only).'}
            </p>
          </div>

          <div className="space-y-1">
            <label className="flex items-center gap-2 font-medium">
              <input
                type="checkbox"
                className="checkbox checkbox-sm checkbox-primary"
                checked={sounds && !soundsLocked}
                onChange={e => {
                  setSounds(e.target.checked);
                  setError(null);
                }}
                disabled={saving || soundsLocked}
              />
              Sound effects
            </label>
            <p className="text-muted text-xs">
              {soundsLocked
                ? 'Disabled by server config (-no-sounds).'
                : 'Subtle audio cues when peers join, drop, or are clicked. Quiet by design.'}
            </p>
          </div>

          {error && (
            <p className="text-error" role="alert">
              {error}
            </p>
          )}
        </div>
        <div className="ui-dialog-footer">
          <button type="button" className="btn btn-sm btn-text" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button type="submit" className="btn btn-sm btn-primary" disabled={saving || !canSubmit}>
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </form>
    </div>
  );
}

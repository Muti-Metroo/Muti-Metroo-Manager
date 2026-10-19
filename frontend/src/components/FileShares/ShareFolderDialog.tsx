import { useRef, useState } from 'react';
import type { FileShare } from '../../api/types';
import { createShare } from '../../api/client';
import { isValidShareName, suggestShareName } from '../../util/fileShares';
import { useModalDismiss } from '../../hooks/useModalDismiss';
import DialogHeader from '../DialogHeader';
import ShareMountInfo from './ShareMountInfo';

interface ShareFolderDialogProps {
  agentId: string;
  agentLabel: string;
  remotePath: string;
  onClose: () => void;
}

/**
 * "Share this folder" from the file browser: creates a WebDAV share for
 * the current directory, then shows the one-time password and how to
 * mount it.
 */
export default function ShareFolderDialog({
  agentId,
  agentLabel,
  remotePath,
  onClose,
}: ShareFolderDialogProps) {
  const [name, setName] = useState(() => suggestShareName(remotePath));
  const [readOnly, setReadOnly] = useState(true);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{
    share: FileShare;
    password: string | null;
    loopbackOnly: boolean;
  } | null>(null);
  const mouseDownOnOverlay = useRef(false);
  useModalDismiss({ onClose: saving ? undefined : onClose });

  const nameError =
    name === '' || isValidShareName(name)
      ? null
      : 'Use 1-64 characters: a-z, 0-9, - or _, starting with a letter or digit.';
  const passwordError =
    password === '' || (password.length >= 8 && password.length <= 72)
      ? null
      : 'Use 8-72 characters, or leave empty to generate one.';
  const canSubmit = name !== '' && !nameError && !passwordError && !saving;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setSaving(true);
    setError(null);
    try {
      const res = await createShare({
        name,
        agent_id: agentId,
        remote_path: remotePath,
        read_only: readOnly,
        username: username.trim() || undefined,
        password: password || undefined,
      });
      setCreated({
        share: res.share,
        password: res.password ?? null,
        loopbackOnly: res.loopback_only,
      });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message.trim() : 'Failed to create share');
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
        // Never dismiss by a stray click once the one-time password is up.
        if (!created && !saving && mouseDownOnOverlay.current && e.target === e.currentTarget)
          onClose();
        mouseDownOnOverlay.current = false;
      }}
    >
      {created ? (
        <div
          className="ui-dialog max-w-2xl"
          role="dialog"
          aria-modal="true"
          aria-label="Share created"
        >
          <DialogHeader title="Share created" icon="icon-[tabler--share]" onClose={onClose} />
          <div className="ui-dialog-body">
            <ShareMountInfo
              share={created.share}
              password={created.password}
              loopbackOnly={created.loopbackOnly}
            />
          </div>
          <div className="ui-dialog-footer">
            <button type="button" className="btn btn-sm btn-primary" onClick={onClose}>
              Done
            </button>
          </div>
        </div>
      ) : (
        <form
          className="ui-dialog"
          role="dialog"
          aria-modal="true"
          aria-label="Share this folder"
          onSubmit={handleSubmit}
        >
          <DialogHeader
            title="Share this folder"
            icon="icon-[tabler--share]"
            onClose={onClose}
            closeDisabled={saving}
          />
          <div className="ui-dialog-body space-y-4">
            <p className="ui-hint">
              Muti Metroo Manager serves this folder over WebDAV so it can be mounted with Finder,
              Windows Explorer or Linux file managers. Every access goes through the agent&apos;s
              signed file-transfer API and stays inside its <code>file_transfer.allowed_paths</code>
              .
            </p>
            <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
              <span className="text-muted">Agent</span>
              <span className="truncate">{agentLabel}</span>
              <span className="text-muted">Folder</span>
              <span className="font-mono break-all">{remotePath}</span>
            </div>

            <div className="space-y-1">
              <label htmlFor="share-name" className="font-medium">
                Share name
              </label>
              <input
                id="share-name"
                className={`input input-sm w-full font-mono${nameError ? ' is-invalid' : ''}`}
                value={name}
                onChange={e => setName(e.target.value.toLowerCase())}
                disabled={saving}
                spellCheck={false}
                autoFocus
              />
              <p className={`text-xs ${nameError ? 'text-error' : 'text-muted'}`}>
                {nameError ?? `Mounted at /dav/${name || '...'}/`}
              </p>
            </div>

            <label className="flex items-center gap-2 font-medium">
              <input
                type="checkbox"
                className="checkbox checkbox-sm checkbox-primary"
                checked={readOnly}
                onChange={e => setReadOnly(e.target.checked)}
                disabled={saving}
              />
              Read-only
            </label>
            {!readOnly && (
              <p className="text-warning -mt-2 text-xs">
                Anyone with the share password can create, overwrite, rename and delete files in
                this folder.
              </p>
            )}

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <label htmlFor="share-user" className="font-medium">
                  User name
                </label>
                <input
                  id="share-user"
                  className="input input-sm w-full font-mono"
                  placeholder={name || 'share name'}
                  value={username}
                  onChange={e => setUsername(e.target.value)}
                  disabled={saving}
                  spellCheck={false}
                  autoComplete="off"
                />
              </div>
              <div className="space-y-1">
                <label htmlFor="share-pass" className="font-medium">
                  Password
                </label>
                <input
                  id="share-pass"
                  type="password"
                  className={`input input-sm w-full font-mono${passwordError ? ' is-invalid' : ''}`}
                  placeholder="generate"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  disabled={saving}
                  autoComplete="new-password"
                />
              </div>
            </div>
            <p className={`text-xs ${passwordError ? 'text-error' : 'text-muted'}`}>
              {passwordError ??
                'Leave the password empty to generate a strong one; it is shown once after creation.'}
            </p>

            {error && (
              <p className="ui-error" role="alert">
                {error}
              </p>
            )}
          </div>
          <div className="ui-dialog-footer">
            <button
              type="button"
              className="btn btn-sm btn-text"
              onClick={onClose}
              disabled={saving}
            >
              Cancel
            </button>
            <button type="submit" className="btn btn-sm btn-primary" disabled={!canSubmit}>
              {saving ? 'Creating...' : 'Create share'}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

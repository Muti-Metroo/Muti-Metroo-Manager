import { useCallback, useEffect, useRef, useState } from 'react';
import type { FileShare, TopologyAgentInfo } from '../../api/types';
import { deleteShare, listShares, updateShare } from '../../api/client';
import { currentLocation, mountUrl } from '../../util/fileShares';
import { agentLabel } from '../../util/useTopologyDiff';
import { useModalDismiss } from '../../hooks/useModalDismiss';
import ConfirmDialog from '../ConfirmDialog';
import DialogHeader from '../DialogHeader';
import ShareMountInfo, { CopyButton } from './ShareMountInfo';

interface FileSharesDialogProps {
  agents: TopologyAgentInfo[];
  onClose: () => void;
}

function shareAgentLabel(agents: TopologyAgentInfo[], id: string): string {
  const a = agents.find(x => x.id.toLowerCase() === id.toLowerCase());
  return a ? agentLabel(a) : id.slice(0, 12);
}

/** Lists the WebDAV file shares with their mount URLs and management actions. */
export default function FileSharesDialog({ agents, onClose }: FileSharesDialogProps) {
  const [shares, setShares] = useState<FileShare[] | null>(null);
  const [loopbackOnly, setLoopbackOnly] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  // The share whose mount details are expanded, plus a password that was
  // just rotated (shown once).
  const [expanded, setExpanded] = useState<{ id: number; password: string | null } | null>(null);
  const [deleting, setDeleting] = useState<FileShare | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const mouseDownOnOverlay = useRef(false);
  useModalDismiss({ onClose: deleting ? undefined : onClose });

  const load = useCallback(async () => {
    try {
      const res = await listShares();
      setShares(res.shares);
      setLoopbackOnly(res.loopback_only);
      setError(null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message.trim() : 'Failed to load shares');
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function patch(
    sh: FileShare,
    req: Parameters<typeof updateShare>[1],
  ): Promise<string | null | undefined> {
    setBusyId(sh.id);
    setError(null);
    try {
      const res = await updateShare(sh.id, req);
      setShares(prev => prev?.map(s => (s.id === sh.id ? res.share : s)) ?? null);
      return res.password ?? null;
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message.trim() : 'Update failed');
      return undefined;
    } finally {
      setBusyId(null);
    }
  }

  async function rotate(sh: FileShare) {
    const pw = await patch(sh, { rotate_password: true });
    if (pw) setExpanded({ id: sh.id, password: pw });
  }

  async function confirmDelete() {
    if (!deleting) return;
    setBusyId(deleting.id);
    setDeleteError(null);
    try {
      await deleteShare(deleting.id);
      setShares(prev => prev?.filter(s => s.id !== deleting.id) ?? null);
      if (expanded?.id === deleting.id) setExpanded(null);
      setDeleting(null);
    } catch (err: unknown) {
      setDeleteError(err instanceof Error ? err.message.trim() : 'Delete failed');
    } finally {
      setBusyId(null);
    }
  }

  const loc = currentLocation();

  return (
    <div
      className="ui-overlay"
      onMouseDown={e => {
        mouseDownOnOverlay.current = e.target === e.currentTarget;
      }}
      onClick={e => {
        if (!deleting && mouseDownOnOverlay.current && e.target === e.currentTarget) onClose();
        mouseDownOnOverlay.current = false;
      }}
    >
      <div className="ui-dialog max-w-4xl" role="dialog" aria-modal="true" aria-label="File shares">
        <DialogHeader title="File shares" icon="icon-[tabler--share]" onClose={onClose} />
        <div className="ui-dialog-body space-y-3">
          <p className="ui-hint">
            Agent folders served over WebDAV at <code>/dav/&lt;name&gt;/</code> on this Muti Metroo
            Manager. Create a share from an agent&apos;s Files tab with{' '}
            <strong>Share this folder</strong>.
          </p>
          {error && (
            <p className="ui-error" role="alert">
              {error}
            </p>
          )}
          {shares === null && !error && <p className="ui-loading">Loading...</p>}
          {shares !== null && shares.length === 0 && (
            <p className="ui-empty">No file shares yet.</p>
          )}
          {shares !== null && shares.length > 0 && (
            <ul className="space-y-2">
              {shares.map(sh => {
                const url = mountUrl(loc, sh.mount_path);
                const busy = busyId === sh.id;
                const open = expanded?.id === sh.id;
                return (
                  <li key={sh.id} className="rounded-box border-hairline border p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className={`badge badge-xs badge-soft ${sh.enabled ? 'badge-success' : 'badge-neutral'}`}
                      >
                        {sh.enabled ? 'Enabled' : 'Disabled'}
                      </span>
                      <span className="font-mono font-semibold">{sh.name}</span>
                      <span
                        className={`badge badge-xs badge-soft ${sh.read_only ? 'badge-info' : 'badge-warning'}`}
                      >
                        {sh.read_only ? 'Read-only' : 'Read-write'}
                      </span>
                      <span className="text-muted min-w-0 truncate text-xs">
                        {shareAgentLabel(agents, sh.agent_id)}:{' '}
                        <span className="font-mono">{sh.remote_path}</span>
                      </span>
                    </div>
                    <div className="mt-2 flex items-center gap-2">
                      <code className="bg-base-200 rounded-field min-w-0 flex-1 truncate px-2 py-1 font-mono text-xs">
                        {url}
                      </code>
                      <CopyButton text={url} />
                    </div>
                    <div className="mt-2 flex flex-wrap gap-1">
                      <button
                        type="button"
                        className="btn btn-xs btn-soft"
                        disabled={busy}
                        onClick={() => patch(sh, { enabled: !sh.enabled })}
                      >
                        {sh.enabled ? 'Disable' : 'Enable'}
                      </button>
                      <button
                        type="button"
                        className="btn btn-xs btn-soft"
                        disabled={busy}
                        onClick={() => patch(sh, { read_only: !sh.read_only })}
                        title={
                          sh.read_only
                            ? 'Allow clients to create, change and delete files'
                            : 'Refuse every change'
                        }
                      >
                        {sh.read_only ? 'Make read-write' : 'Make read-only'}
                      </button>
                      <button
                        type="button"
                        className="btn btn-xs btn-soft"
                        disabled={busy}
                        onClick={() => rotate(sh)}
                      >
                        Rotate password
                      </button>
                      <button
                        type="button"
                        className="btn btn-xs btn-soft"
                        onClick={() => setExpanded(open ? null : { id: sh.id, password: null })}
                        aria-expanded={open}
                      >
                        {open ? 'Hide mount help' : 'Mount help'}
                      </button>
                      <button
                        type="button"
                        className="btn btn-xs btn-soft btn-error ms-auto"
                        disabled={busy}
                        onClick={() => {
                          setDeleteError(null);
                          setDeleting(sh);
                        }}
                      >
                        Delete
                      </button>
                    </div>
                    {open && (
                      <div className="border-hairline mt-3 border-t pt-3">
                        <ShareMountInfo
                          share={sh}
                          password={expanded?.password}
                          loopbackOnly={loopbackOnly}
                        />
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        <div className="ui-dialog-footer">
          <button type="button" className="btn btn-sm btn-text" onClick={load}>
            Refresh
          </button>
          <button type="button" className="btn btn-sm btn-primary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
      {deleting && (
        <ConfirmDialog
          title="Delete file share"
          target={`/dav/${deleting.name}/`}
          message="Clients that mounted this share lose access. Files on the agent are not touched."
          confirmLabel="Delete"
          pendingLabel="Deleting..."
          loading={busyId === deleting.id}
          error={deleteError}
          onCancel={() => setDeleting(null)}
          onConfirm={confirmDelete}
        />
      )}
    </div>
  );
}

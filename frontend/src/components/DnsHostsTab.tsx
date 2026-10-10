import { useState, useEffect, useCallback } from 'react';
import type { MeshHost } from '../api/types';
import { manageMeshHosts, ApiError } from '../api/client';
import { matchSuffix } from '../util/meshSuffix';
import Alert from './Alert';
import ConfirmDialog from './ConfirmDialog';

interface DnsHostsTabProps {
  // Whether the locally-connected agent can sign management mutations.
  // null while unknown. When false, add/remove forms are hidden since the
  // server would reject them with an auth error. Mirrors RoutesTab.
  canSignManagement: boolean | null;
  // Sub-tab switcher exposed to the empty-state hint so the user can
  // jump to the TLDs sub-tab when no suffix is registered yet.
  onGoToTlds: () => void;
}

export default function DnsHostsTab({ canSignManagement, onGoToTlds }: DnsHostsTabProps) {
  const canMutate = canSignManagement !== false;

  const [hosts, setHosts] = useState<MeshHost[]>([]);
  const [suffixes, setSuffixes] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [unavailable, setUnavailable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const [newName, setNewName] = useState('');
  const [newIPv4, setNewIPv4] = useState('');
  const [newIPv6, setNewIPv6] = useState('');
  const [newComment, setNewComment] = useState('');

  const [actionLoading, setActionLoading] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);

  const fetchHosts = useCallback(async () => {
    setLoading(true);
    setError(null);
    setUnavailable(false);
    try {
      const resp = await manageMeshHosts({ action: 'list' });
      setHosts(resp.hosts || []);
      setSuffixes(resp.suffixes || []);
    } catch (err: any) {
      // 503 → mesh hosts not configured on this agent (older build or
      // disabled). Render an explanatory empty state instead of an error.
      if (err instanceof ApiError && err.status === 503) {
        setUnavailable(true);
      } else {
        setError(err?.message || 'Failed to fetch DNS entries');
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchHosts();
  }, [fetchHosts]);

  const trimmedName = newName.trim().toLowerCase();
  const trimmedIPv4 = newIPv4.trim();
  const trimmedIPv6 = newIPv6.trim();
  const matchedSuffix = trimmedName ? matchSuffix(trimmedName, suffixes) : null;
  const noSuffixesConfigured = !loading && !unavailable && suffixes.length === 0;
  const nameSuffixError =
    trimmedName && !matchedSuffix && suffixes.length > 0
      ? `Name must end with one of: ${suffixes.map(s => `.${s}`).join(', ')}.`
      : null;
  const canSubmit = !!matchedSuffix && (!!trimmedIPv4 || !!trimmedIPv6);

  const handleAdd = useCallback(async () => {
    if (!canSubmit) return;
    setActionLoading(true);
    setError(null);
    setSuccess(null);
    try {
      const req: { action: 'add'; name: string; ipv4?: string; ipv6?: string; comment?: string } = {
        action: 'add',
        name: trimmedName,
      };
      if (trimmedIPv4) req.ipv4 = trimmedIPv4;
      if (trimmedIPv6) req.ipv6 = trimmedIPv6;
      const c = newComment.trim();
      if (c) req.comment = c;
      const resp = await manageMeshHosts(req);
      setHosts(resp.hosts || []);
      setSuffixes(resp.suffixes || []);
      setSuccess(`Added ${trimmedName}`);
      setNewName('');
      setNewIPv4('');
      setNewIPv6('');
      setNewComment('');
    } catch (err: any) {
      setError(err?.message || 'Failed to add DNS entry');
    } finally {
      setActionLoading(false);
    }
  }, [canSubmit, trimmedName, trimmedIPv4, trimmedIPv6, newComment]);

  const handleRemove = useCallback(async (name: string) => {
    setActionLoading(true);
    setError(null);
    setSuccess(null);
    try {
      const resp = await manageMeshHosts({ action: 'remove', name });
      setHosts(resp.hosts || []);
      setSuffixes(resp.suffixes || []);
      setSuccess(`Removed ${name}`);
      setConfirmRemove(null);
    } catch (err: any) {
      // 403 → ErrProtected: config-seeded host. Surface a clearer message.
      if (err instanceof ApiError && err.status === 403) {
        setError(
          `${name} is config-seeded and cannot be removed via the UI. Edit the agent's YAML and restart.`,
        );
      } else {
        setError(err?.message || 'Failed to remove DNS entry');
      }
      setConfirmRemove(null);
    } finally {
      setActionLoading(false);
    }
  }, []);

  if (unavailable) {
    return (
      <div className="ui-empty">
        Mesh-host management is not configured on this agent. Update the agent or enable mesh-host
        support in its configuration to manage DNS-style host entries from here.
      </div>
    );
  }

  const placeholderTld = suffixes[0] || 'your-tld';

  return (
    <>
      <div className="ui-hint">
        Mesh hosts map DNS-style names (e.g. <code>target-11.{placeholderTld}</code>) to IPv4 / IPv6
        addresses. Mutiauk pulls this list and serves it from a local DNS resolver, so queries
        for matching names resolve to the configured IP and route through the mesh. This agent
        handles names ending with:{' '}
        {suffixes.length === 0 ? (
          <em>(none configured)</em>
        ) : (
          suffixes.map((s, i) => (
            <span key={s}>
              {i > 0 && ', '}
              <code>.{s}</code>
            </span>
          ))
        )}
        .
      </div>
      {!canMutate && (
        <div className="ui-hint">
          Read-only: the connected agent has no management signing key, so DNS entries cannot be
          added or removed.
        </div>
      )}
      {noSuffixesConfigured && canMutate && (
        <div className="ui-hint">
          No TLD suffixes are configured.{' '}
          <button type="button" className="link link-primary" onClick={onGoToTlds}>
            Open the TLDs sub-tab
          </button>{' '}
          to register one before adding hosts.
        </div>
      )}

      {canMutate && !noSuffixesConfigured && (
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <input
            type="text"
            className="input input-sm min-w-32 flex-1 font-mono"
            placeholder={`Hostname (e.g. target-11.${placeholderTld})`}
            value={newName}
            onChange={e => setNewName(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleAdd()}
            disabled={actionLoading}
          />
          <input
            type="text"
            className="input input-sm min-w-32 flex-1 font-mono"
            placeholder="IPv4 (e.g. 10.8.0.11)"
            value={newIPv4}
            onChange={e => setNewIPv4(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleAdd()}
            disabled={actionLoading}
          />
          <input
            type="text"
            className="input input-sm min-w-32 flex-1 font-mono"
            placeholder="IPv6 (optional)"
            value={newIPv6}
            onChange={e => setNewIPv6(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleAdd()}
            disabled={actionLoading}
          />
          <input
            type="text"
            className="input input-sm min-w-32 flex-1 font-mono"
            placeholder="Comment (optional)"
            value={newComment}
            onChange={e => setNewComment(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleAdd()}
            disabled={actionLoading}
          />
          <button
            className="btn btn-sm btn-primary btn-soft"
            onClick={handleAdd}
            disabled={actionLoading || !canSubmit}
          >
            Add
          </button>
        </div>
      )}

      {nameSuffixError && <div className="ui-hint">{nameSuffixError}</div>}
      {error && <Alert kind="error" message={error} onClose={() => setError(null)} />}
      {success && <Alert kind="success" message={success} onClose={() => setSuccess(null)} />}

      <div className="ui-table-frame">
        <table className="table table-sm table-pin-rows">
          <thead>
            <tr>
              <th>Host</th>
              <th>IPv4</th>
              <th>IPv6</th>
              <th>Comment</th>
              {canMutate && <th></th>}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={canMutate ? 5 : 4} className="ui-empty">
                  Loading…
                </td>
              </tr>
            ) : hosts.length === 0 ? (
              <tr>
                <td colSpan={canMutate ? 5 : 4} className="ui-empty">
                  No DNS entries
                </td>
              </tr>
            ) : (
              hosts.map(h => (
                <tr key={h.name}>
                  <td className="text-accent font-mono">{h.name}</td>
                  <td>{h.ipv4 || ''}</td>
                  <td>{h.ipv6 || ''}</td>
                  <td>{h.comment || ''}</td>
                  {canMutate && (
                    <td className="text-end">
                      <button
                        className="btn btn-xs btn-error btn-soft"
                        onClick={() => setConfirmRemove(h.name)}
                        disabled={actionLoading}
                      >
                        Remove
                      </button>
                    </td>
                  )}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {confirmRemove && (
        <ConfirmDialog
          title="Remove DNS entry"
          target={confirmRemove}
          message="Remove this entry from the mesh-host registry? Mutiauk resolvers will stop returning this address on their next poll."
          loading={actionLoading}
          onCancel={() => setConfirmRemove(null)}
          onConfirm={() => handleRemove(confirmRemove)}
        />
      )}
    </>
  );
}

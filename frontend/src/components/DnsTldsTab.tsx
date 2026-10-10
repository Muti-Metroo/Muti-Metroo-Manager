import { useState, useEffect, useCallback } from 'react';
import { manageMeshHostSuffixes, ApiError } from '../api/client';
import { normalizeSuffix } from '../util/meshSuffix';
import Alert from './Alert';
import ConfirmDialog from './ConfirmDialog';

interface DnsTldsTabProps {
  canSignManagement: boolean | null;
}

export default function DnsTldsTab({ canSignManagement }: DnsTldsTabProps) {
  const canMutate = canSignManagement !== false;

  const [suffixes, setSuffixes] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [unavailable, setUnavailable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const [newSuffix, setNewSuffix] = useState('');
  const [actionLoading, setActionLoading] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);

  const fetchSuffixes = useCallback(async () => {
    setLoading(true);
    setError(null);
    setUnavailable(false);
    try {
      const resp = await manageMeshHostSuffixes({ action: 'list' });
      setSuffixes(resp.suffixes || []);
    } catch (err: any) {
      if (err instanceof ApiError && err.status === 503) {
        setUnavailable(true);
      } else {
        setError(err?.message || 'Failed to fetch TLD suffixes');
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchSuffixes();
  }, [fetchSuffixes]);

  const validation = newSuffix.trim() ? normalizeSuffix(newSuffix) : null;
  const validationError = validation && !validation.ok ? validation.error : null;
  const canSubmit = !!validation && validation.ok;

  const handleAdd = useCallback(async () => {
    if (!validation || !validation.ok) return;
    setActionLoading(true);
    setError(null);
    setSuccess(null);
    try {
      const resp = await manageMeshHostSuffixes({ action: 'add', suffix: validation.value });
      setSuffixes(resp.suffixes || []);
      setSuccess(`Added .${validation.value}`);
      setNewSuffix('');
    } catch (err: any) {
      setError(err?.message || 'Failed to add TLD suffix');
    } finally {
      setActionLoading(false);
    }
  }, [validation]);

  const handleRemove = useCallback(async (suffix: string) => {
    setActionLoading(true);
    setError(null);
    setSuccess(null);
    try {
      const resp = await manageMeshHostSuffixes({ action: 'remove', suffix });
      setSuffixes(resp.suffixes || []);
      setSuccess(`Removed .${suffix}`);
      setConfirmRemove(null);
    } catch (err: any) {
      // 409 → suffix has registered hosts; the server lists them in the
      // error body. Show verbatim so the operator can see which hosts to
      // remove first.
      setError(err?.message || 'Failed to remove TLD suffix');
      setConfirmRemove(null);
    } finally {
      setActionLoading(false);
    }
  }, []);

  if (unavailable) {
    return (
      <div className="ui-empty">
        Mesh-host management is not configured on this agent. Update the agent or enable mesh-host
        support in its configuration to manage TLD suffixes from here.
      </div>
    );
  }

  return (
    <>
      <div className="ui-hint">
        TLD suffixes are the trailing labels every mesh-host name must end with (e.g.{' '}
        <code>.mesh</code>, <code>.muti-metroo.alt</code>). Single-label and multi-level suffixes are both
        valid. Removing a suffix that still has registered hosts is rejected — clear those hosts
        first.
      </div>
      {!canMutate && (
        <div className="ui-hint">
          Read-only: the connected agent has no management signing key, so TLD suffixes cannot be
          added or removed.
        </div>
      )}

      {canMutate && (
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <input
            type="text"
            className="input input-sm min-w-32 flex-1 font-mono"
            placeholder="TLD suffix (e.g. mesh or muti-metroo.alt)"
            value={newSuffix}
            onChange={e => setNewSuffix(e.target.value)}
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

      {validationError && <div className="ui-hint">{validationError}</div>}
      {error && <Alert kind="error" message={error} onClose={() => setError(null)} />}
      {success && <Alert kind="success" message={success} onClose={() => setSuccess(null)} />}

      <div className="ui-table-frame">
        <table className="table table-sm table-pin-rows">
          <thead>
            <tr>
              <th>TLD suffix</th>
              {canMutate && <th></th>}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={canMutate ? 2 : 1} className="ui-empty">
                  Loading…
                </td>
              </tr>
            ) : suffixes.length === 0 ? (
              <tr>
                <td colSpan={canMutate ? 2 : 1} className="ui-empty">
                  No TLD suffixes configured
                </td>
              </tr>
            ) : (
              suffixes.map(s => (
                <tr key={s}>
                  <td className="text-accent font-mono">.{s}</td>
                  {canMutate && (
                    <td className="text-end">
                      <button
                        className="btn btn-xs btn-error btn-soft"
                        onClick={() => setConfirmRemove(s)}
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
          title="Remove TLD suffix"
          target={`.${confirmRemove}`}
          message="Remove this suffix? Any hostnames registered under it must be removed first; otherwise this request will fail."
          loading={actionLoading}
          onCancel={() => setConfirmRemove(null)}
          onConfirm={() => handleRemove(confirmRemove)}
        />
      )}
    </>
  );
}

import { useState, useCallback, useMemo } from 'react';
import type { TopologyAgentInfo, ListenerEntry, PeerTransport } from '../../api/types';
import { PEER_TRANSPORTS, transportHasHttpPath } from '../../api/types';
import { manageAgentListeners } from '../../api/client';
import { normalizePath } from '../../util/peerAddress';
import { useAgentResource } from '../../hooks/useAgentResource';
import Alert from '../Alert';
import ConfirmDialog from '../ConfirmDialog';

interface ListenersTabProps {
  agent: TopologyAgentInfo;
  // Whether the locally-connected agent can sign listener-management mutations.
  // null while unknown. When false, the add form and remove buttons are hidden.
  canSignManagement: boolean | null;
  onListenersChanged: () => void;
}

export default function ListenersTab({
  agent,
  canSignManagement,
  onListenersChanged,
}: ListenersTabProps) {
  const canMutate = canSignManagement !== false;
  const {
    data: listeners,
    loading,
    error,
    setError,
    unavailable: unreachable,
    reload: fetchListeners,
  } = useAgentResource(
    () =>
      manageAgentListeners(agent.id, agent.is_local, { action: 'list' }).then(
        r => r.listeners || [],
      ),
    { initial: [] as ListenerEntry[], fallbackError: 'Failed to fetch listeners' },
    [agent.id, agent.is_local],
  );
  const [success, setSuccess] = useState<string | null>(null);
  const [newTransport, setNewTransport] = useState<PeerTransport>('quic');
  const [newAddress, setNewAddress] = useState('');
  const [newPath, setNewPath] = useState('');
  const [newPlaintext, setNewPlaintext] = useState(false);
  const [newAdvertise, setNewAdvertise] = useState('');
  const [actionLoading, setActionLoading] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);

  const hasHttpPath = transportHasHttpPath(newTransport);
  const isWs = newTransport === 'ws';

  const handleAdd = useCallback(async () => {
    const address = newAddress.trim();
    if (!address) return;
    const httpPath = hasHttpPath ? normalizePath(newPath.trim()) : '';
    const advertise = newAdvertise.trim();
    setActionLoading(true);
    setError(null);
    setSuccess(null);
    try {
      await manageAgentListeners(agent.id, agent.is_local, {
        action: 'add',
        transport: newTransport,
        address,
        ...(httpPath && { path: httpPath }),
        ...(isWs && newPlaintext && { plaintext: true }),
        ...(advertise && { advertise_address: advertise }),
      });
      setSuccess(`Listening on ${address} (${newTransport})`);
      setNewAddress('');
      setNewPath('');
      setNewPlaintext(false);
      setNewAdvertise('');
      await fetchListeners();
      onListenersChanged();
    } catch (err: any) {
      setError(err?.message || 'Failed to add listener');
    } finally {
      setActionLoading(false);
    }
  }, [
    agent.id,
    agent.is_local,
    newTransport,
    newAddress,
    newPath,
    newPlaintext,
    newAdvertise,
    hasHttpPath,
    isWs,
    fetchListeners,
    onListenersChanged,
  ]);

  const handleRemove = useCallback(
    async (address: string) => {
      setActionLoading(true);
      setError(null);
      setSuccess(null);
      try {
        await manageAgentListeners(agent.id, agent.is_local, { action: 'remove', address });
        setSuccess(`Removed listener ${address}`);
        setConfirmRemove(null);
        await fetchListeners();
        onListenersChanged();
      } catch (err: any) {
        setError(err?.message || 'Failed to remove listener');
      } finally {
        setActionLoading(false);
      }
    },
    [agent.id, agent.is_local, fetchListeners, onListenersChanged],
  );

  const sortedListeners = useMemo(() => {
    // Config listeners first, then dynamic; stable by address within each group.
    return [...listeners].sort(
      (a, b) => Number(a.dynamic) - Number(b.dynamic) || a.address.localeCompare(b.address),
    );
  }, [listeners]);

  if (unreachable) {
    return (
      <div className="routes-tab">
        <div className="ui-error">
          Agent is not reachable from the local node for listener management
        </div>
      </div>
    );
  }

  return (
    <div className="routes-tab">
      <div className="ui-hint">
        Open or close the transport sockets this agent binds to accept inbound peers — without
        editing its config. Config listeners are read-only here; only runtime-added ones can be
        removed. For ws/h2, set the HTTP path. Set an advertise address to publish a public dial
        target (e.g. a NAT/proxy front) to the mesh.
      </div>
      {!canMutate && (
        <div className="ui-hint">
          Read-only: the connected agent has no management signing key, so listeners cannot be added
          or removed.
        </div>
      )}
      {canMutate && (
        <div className="flex flex-col items-stretch gap-1.5">
          <div className="flex flex-wrap items-center gap-1.5">
            <select
              className="select select-sm font-mono w-20 shrink-0"
              value={newTransport}
              onChange={e => setNewTransport(e.target.value as PeerTransport)}
            >
              {PEER_TRANSPORTS.map(t => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
            <input
              type="text"
              className="input input-sm min-w-0 flex-1 font-mono"
              placeholder=":4433"
              value={newAddress}
              onChange={e => setNewAddress(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleAdd()}
              title="Bind address (e.g. :4433 or 127.0.0.1:3002)"
            />
          </div>
          {hasHttpPath && (
            <input
              type="text"
              className="input input-sm w-full font-mono"
              placeholder="/mesh"
              value={newPath}
              onChange={e => setNewPath(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleAdd()}
              title="HTTP path for ws/h2"
            />
          )}
          <input
            type="text"
            className="input input-sm w-full font-mono"
            placeholder="advertise host:port (optional)"
            value={newAdvertise}
            onChange={e => setNewAdvertise(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleAdd()}
            title="Public dial target to advertise to the mesh (optional)"
          />
          <div className="flex items-center gap-2">
            {isWs && (
              <label
                className="flex items-center gap-1.5"
                title="Bind without TLS (reverse-proxy deployments)"
              >
                <input
                  type="checkbox"
                  className="checkbox checkbox-sm checkbox-primary"
                  checked={newPlaintext}
                  onChange={e => setNewPlaintext(e.target.checked)}
                />
                <span>plaintext</span>
              </label>
            )}
            <button
              className="btn btn-sm btn-primary btn-soft"
              onClick={() => handleAdd()}
              disabled={actionLoading || !newAddress.trim() || (hasHttpPath && !newPath.trim())}
              title={
                hasHttpPath && !newPath.trim()
                  ? 'HTTP path is required for h2/ws listeners'
                  : undefined
              }
            >
              Add
            </button>
          </div>
        </div>
      )}

      {error && <Alert kind="error" message={error} onClose={() => setError(null)} />}
      {success && <Alert kind="success" message={success} onClose={() => setSuccess(null)} />}

      {loading ? (
        <div className="ui-loading">Loading listeners...</div>
      ) : sortedListeners.length === 0 ? (
        <div className="ui-empty">No listeners</div>
      ) : (
        <div className="routes-list">
          {sortedListeners.map(l => {
            const rowClass = ['routes-list-item', !l.dynamic && 'routes-list-item-static']
              .filter(Boolean)
              .join(' ');
            const hasMeta = !!(l.path || l.plaintext || l.advertise_address);
            return (
              // The transport chip is a sibling of the trailing badge, not a
              // child of the address column: nested inside it, the growing
              // address pushed it to the panel edge where it staggered above
              // the vertically-centred badge instead of lining up with it.
              <div key={l.address} className={rowClass}>
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <span className="peers-address">{l.address}</span>
                  {hasMeta && (
                    <div className="flex flex-wrap items-center gap-1.5">
                      {l.path && (
                        <span className="text-muted font-mono text-xs" title="HTTP path">
                          {l.path}
                        </span>
                      )}
                      {l.plaintext && (
                        <span className="ui-chip routes-badge-static" title="No TLS">
                          plaintext
                        </span>
                      )}
                      {l.advertise_address && (
                        <span
                          className="text-muted font-mono text-xs"
                          title="advertised dial target"
                        >
                          →&nbsp;{l.advertise_address}
                        </span>
                      )}
                    </div>
                  )}
                </div>
                <span className="ui-chip peers-transport">{l.transport}</span>
                {l.dynamic ? (
                  canMutate ? (
                    <button
                      className="btn btn-xs btn-error btn-soft"
                      onClick={() => setConfirmRemove(l.address)}
                      disabled={actionLoading}
                    >
                      Remove
                    </button>
                  ) : (
                    <span className="ui-chip routes-badge-static">dynamic</span>
                  )
                ) : (
                  <span className="ui-chip routes-badge-static">static</span>
                )}
              </div>
            );
          })}
        </div>
      )}

      {confirmRemove && (
        <ConfirmDialog
          title="Remove listener"
          target={confirmRemove}
          message="Stop accepting new inbound connections on this listener? Existing peer connections stay up, but peers won't be able to dial in here again until it's re-added."
          loading={actionLoading}
          onCancel={() => setConfirmRemove(null)}
          onConfirm={() => handleRemove(confirmRemove)}
        />
      )}
    </div>
  );
}

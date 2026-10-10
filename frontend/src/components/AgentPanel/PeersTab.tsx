import { useState, useEffect, useCallback, useMemo } from 'react';
import type { TopologyAgentInfo, PeerEntry, PeerTransport } from '../../api/types';
import { PEER_TRANSPORTS } from '../../api/types';
import { manageAgentPeers, probeAgentPeer, ApiError } from '../../api/client';
import { formatPeerAddress, normalizePath } from '../../util/peerAddress';
import Alert from '../Alert';
import ConfirmDialog from '../ConfirmDialog';

interface PeersTabProps {
  agent: TopologyAgentInfo;
  // Whether the locally-connected agent can sign peer-management mutations.
  // null while unknown. When false, the add form and remove buttons are hidden.
  canSignManagement: boolean | null;
  agentsById: Map<string, TopologyAgentInfo>;
  onPeersChanged: () => void;
}

function dirRank(p: PeerEntry): number {
  return p.direction === 'inbound' ? 1 : 0;
}

function renderPeerAction(
  p: PeerEntry,
  isInbound: boolean,
  actionLoading: boolean,
  canMutate: boolean,
  onRemove: (address: string) => void,
) {
  if (isInbound) {
    return (
      <span className="ui-chip routes-badge-inbound" title="Peer dialed into this agent">
        inbound
      </span>
    );
  }
  if (p.dynamic) {
    if (!canMutate) {
      return <span className="ui-chip routes-badge-static">dynamic</span>;
    }
    return (
      <button
        className="btn btn-xs btn-error btn-soft"
        onClick={() => onRemove(p.address)}
        disabled={actionLoading}
      >
        Remove
      </button>
    );
  }
  return <span className="ui-chip routes-badge-static">static</span>;
}

export default function PeersTab({
  agent,
  canSignManagement,
  agentsById,
  onPeersChanged,
}: PeersTabProps) {
  const canMutate = canSignManagement !== false;
  const [peers, setPeers] = useState<PeerEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [unreachable, setUnreachable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [newAddress, setNewAddress] = useState('');
  const [newTransport, setNewTransport] = useState<PeerTransport>('quic');
  const [newPath, setNewPath] = useState('');
  // Optional per-peer TCP keepalive override (Go duration). Empty inherits
  // the agent's global transport setting.
  const [newKeepAlive, setNewKeepAlive] = useState('');
  const [actionLoading, setActionLoading] = useState(false);
  const [probeError, setProbeError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);

  const hasHttpPath = newTransport === 'ws' || newTransport === 'h2';

  const fetchPeers = useCallback(async () => {
    setLoading(true);
    setError(null);
    setUnreachable(false);
    try {
      const resp = await manageAgentPeers(agent.id, agent.is_local, { action: 'list' });
      setPeers(resp.peers || []);
    } catch (err: any) {
      const msg = err?.message || '';
      if ((err instanceof ApiError && err.status === 502) || msg.includes('no route to agent')) {
        setUnreachable(true);
      } else {
        setError(msg || 'Failed to fetch peers');
      }
    } finally {
      setLoading(false);
    }
  }, [agent.id, agent.is_local]);

  useEffect(() => {
    fetchPeers();
  }, [fetchPeers]);

  const performAdd = useCallback(
    async (
      addAddress: string,
      transport: PeerTransport,
      keepAlive: string,
      probeSummary?: string,
    ) => {
      await manageAgentPeers(agent.id, agent.is_local, {
        action: 'add',
        address: addAddress,
        transport,
        ...(keepAlive && { tcp_keepalive: keepAlive }),
      });
      const base = `Dialing ${addAddress} (${transport})`;
      setSuccess(probeSummary ? `${base} — ${probeSummary}` : base);
      setNewAddress('');
      setNewPath('');
      setNewKeepAlive('');
      setProbeError(null);
      await fetchPeers();
      onPeersChanged();
    },
    [agent.id, agent.is_local, fetchPeers, onPeersChanged],
  );

  const handleAdd = useCallback(
    async (opts?: { skipProbe?: boolean }) => {
      const address = newAddress.trim();
      if (!address) return;
      const httpPath = hasHttpPath ? normalizePath(newPath.trim()) : '';
      setActionLoading(true);
      setError(null);
      setSuccess(null);
      try {
        let probeSummary: string | undefined;
        if (!opts?.skipProbe) {
          const probe = await probeAgentPeer(agent.id, agent.is_local, {
            address,
            transport: newTransport,
            ...(httpPath && { path: httpPath }),
          });
          if (!probe.success) {
            setProbeError(probe.error || 'peer did not answer');
            return;
          }
          setProbeError(null);
          const label = probe.remote_display_name || probe.remote_id?.slice(0, 8) || '';
          const rtt = probe.rtt_ms != null ? `${Math.round(probe.rtt_ms)}ms` : '';
          probeSummary = [label, rtt].filter(Boolean).join(', ');
        }
        await performAdd(
          formatPeerAddress(newTransport, address, httpPath),
          newTransport,
          newKeepAlive.trim(),
          probeSummary,
        );
      } catch (err: any) {
        setError(err?.message || 'Failed to add peer');
      } finally {
        setActionLoading(false);
      }
    },
    [
      agent.id,
      agent.is_local,
      newAddress,
      newTransport,
      newPath,
      newKeepAlive,
      hasHttpPath,
      performAdd,
    ],
  );

  const handleRemove = useCallback(
    async (address: string) => {
      setActionLoading(true);
      setError(null);
      setSuccess(null);
      try {
        await manageAgentPeers(agent.id, agent.is_local, { action: 'remove', address });
        setSuccess(`Removed peer ${address}`);
        setConfirmRemove(null);
        await fetchPeers();
        onPeersChanged();
      } catch (err: any) {
        setError(err.message || 'Failed to remove peer');
      } finally {
        setActionLoading(false);
      }
    },
    [agent.id, agent.is_local, fetchPeers, onPeersChanged],
  );

  const sortedPeers = useMemo(() => {
    // Outbound (configured or dynamic) first, then inbound; stable by address within each group.
    return [...peers].sort((a, b) => dirRank(a) - dirRank(b) || a.address.localeCompare(b.address));
  }, [peers]);

  if (unreachable) {
    return (
      <div className="routes-tab">
        <div className="ui-error">
          Agent is not reachable from the local node for peer management
        </div>
      </div>
    );
  }

  return (
    <div className="routes-tab">
      <div className="ui-hint">
        Tell this agent to dial another listening agent and add it to the mesh. Useful when a new
        exit or relay is reachable from this node but not from the one you're connected to. The
        address is probed first; on success the peer's identity is confirmed before the connection
        is added. For ws/h2, set the HTTP path if the remote listener uses something other than the
        default <code>/mesh</code>.
      </div>
      {!canMutate && (
        <div className="ui-hint">
          Read-only: the connected agent has no management signing key, so peers cannot be added or
          removed.
        </div>
      )}
      {canMutate && (
        <div className="routes-add-form">
          <input
            type="text"
            className="input input-sm min-w-40 flex-1 font-mono"
            placeholder="host:port"
            value={newAddress}
            onChange={e => {
              setNewAddress(e.target.value);
              setProbeError(null);
            }}
            onKeyDown={e => e.key === 'Enter' && handleAdd()}
          />
          <select
            className="select select-sm font-mono w-20 shrink-0"
            value={newTransport}
            onChange={e => {
              setNewTransport(e.target.value as PeerTransport);
              setProbeError(null);
            }}
          >
            {PEER_TRANSPORTS.map(t => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          {hasHttpPath && (
            <input
              type="text"
              className="input input-sm font-mono"
              placeholder="/mesh"
              value={newPath}
              onChange={e => {
                setNewPath(e.target.value);
                setProbeError(null);
              }}
              onKeyDown={e => e.key === 'Enter' && handleAdd()}
              title="HTTP path for ws/h2 (default: /mesh)"
            />
          )}
          <input
            type="text"
            className="input input-sm w-28 shrink-0 font-mono"
            placeholder="keepalive"
            value={newKeepAlive}
            onChange={e => setNewKeepAlive(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleAdd()}
            title="Optional per-peer TCP keepalive (Go duration, e.g. 30s). Empty inherits the agent's global setting."
            aria-label="TCP keepalive override"
          />
          <button
            className="btn btn-sm btn-primary btn-soft"
            onClick={() => handleAdd()}
            disabled={actionLoading || !newAddress.trim()}
          >
            Add
          </button>
          {probeError && (
            <button
              className="btn btn-sm btn-error btn-soft"
              onClick={() => handleAdd({ skipProbe: true })}
              disabled={actionLoading || !newAddress.trim()}
              title="Skip probe and add anyway"
            >
              Add anyway
            </button>
          )}
        </div>
      )}

      {probeError && <div className="ui-error">Probe failed: {probeError}</div>}
      {error && <Alert kind="error" message={error} onClose={() => setError(null)} />}
      {success && <Alert kind="success" message={success} onClose={() => setSuccess(null)} />}

      {loading ? (
        <div className="ui-loading">Loading peers...</div>
      ) : sortedPeers.length === 0 ? (
        <div className="ui-empty">No peers</div>
      ) : (
        <div className="routes-list">
          {sortedPeers.map(p => {
            const isInbound = p.direction === 'inbound';
            // Inbound addresses are ephemeral remote sockets; key by remote_id for stability across reconnects.
            const key = isInbound ? `in:${p.remote_id || p.address}` : `out:${p.address}`;
            const rowClass = [
              'routes-list-item',
              !p.dynamic && !isInbound && 'routes-list-item-static',
              isInbound && 'routes-list-item-inbound',
            ]
              .filter(Boolean)
              .join(' ');
            const peerInfo = p.remote_id ? agentsById.get(p.remote_id) : undefined;
            const primaryLabel = isInbound
              ? peerInfo?.display_name ||
                (p.remote_id ? `${p.remote_id.slice(0, 8)}…` : 'unknown peer')
              : p.address;
            const primaryTitle = isInbound
              ? p.address
                ? `from ${p.address}`
                : undefined
              : undefined;
            return (
              <div key={key} className={rowClass}>
                <span
                  className={`status status-sm ${p.connected ? 'status-success' : 'status-error'}`}
                  title={p.connected ? 'connected' : 'disconnected'}
                />
                <span className="peers-address" title={primaryTitle}>
                  {primaryLabel}
                </span>
                <span className="ui-chip peers-transport">{p.transport}</span>
                {p.connected && p.remote_id && !isInbound && (
                  <span className="peers-remote-id" title={`remote id: ${p.remote_id}`}>
                    {p.remote_id.slice(0, 8)}…
                  </span>
                )}
                {renderPeerAction(p, isInbound, actionLoading, canMutate, setConfirmRemove)}
              </div>
            );
          })}
        </div>
      )}

      {confirmRemove && (
        <ConfirmDialog
          title="Remove peer"
          target={confirmRemove}
          message="Drop the outbound connection to this peer? The mesh may lose reachability to whatever was only accessible through it."
          loading={actionLoading}
          onCancel={() => setConfirmRemove(null)}
          onConfirm={() => handleRemove(confirmRemove)}
        />
      )}
    </div>
  );
}

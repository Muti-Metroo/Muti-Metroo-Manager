import { useState, useEffect, useCallback, useMemo } from 'react';
import type { TopologyAgentInfo, RouteManageRequest, InterfaceAddr } from '../../api/types';
import { manageAgentRoutes, getAgentInterfaces, ApiError } from '../../api/client';
import { deriveSourceIpHints } from '../../api/agentSourceHints';
import Alert from '../Alert';
import ConfirmDialog from '../ConfirmDialog';
import RouteEditDialog from '../RouteEditDialog';

// Orders interface addresses for the source-IP picker: routable IPv4 first
// (the common pick), then routable IPv6, then loopback/link-local last.
function orderSourceIps(addrs: InterfaceAddr[]): string[] {
  const rank = (a: InterfaceAddr) => (a.global ? (a.family === 'ipv4' ? 0 : 1) : 2);
  return [...addrs].sort((a, b) => rank(a) - rank(b)).map(a => a.ip);
}

// Distinct interface names for the interface picker, ranked so NICs carrying a
// routable address come first and loopback-only ones last, matching the
// source-IP ordering. Stable within a rank (preserves the agent's order).
function orderInterfaceNames(addrs: InterfaceAddr[]): string[] {
  // Each NIC's sort key: routable (rank 0) before loopback-only (rank 1),
  // then the index of the earliest address that justifies that rank — so a
  // routable NIC sorts by its first global address, a loopback-only one by
  // its first appearance.
  const key = new Map<string, { rank: number; index: number }>();
  addrs.forEach((a, index) => {
    const rank = a.global ? 0 : 1;
    const prev = key.get(a.interface);
    if (!prev || rank < prev.rank) key.set(a.interface, { rank, index });
  });
  return [...key.keys()].sort((x, y) => {
    const a = key.get(x)!;
    const b = key.get(y)!;
    return a.rank - b.rank || a.index - b.index;
  });
}

interface RoutesTabProps {
  agent: TopologyAgentInfo;
  // Whether the locally-connected agent can sign management mutations.
  // null while unknown. When false, add/remove forms are hidden since the
  // server would reject them with an auth error.
  canSignManagement: boolean | null;
  onRoutesChanged: () => void;
}

interface RouteEntry {
  network: string;
  metric: number;
  comment?: string;
  source_ip?: string;
  interface?: string;
  dynamic?: boolean;
}

export default function RoutesTab({ agent, canSignManagement, onRoutesChanged }: RoutesTabProps) {
  const canMutate = canSignManagement !== false;
  const [routes, setRoutes] = useState<RouteEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [unreachable, setUnreachable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [newCidr, setNewCidr] = useState('');
  const [newMetric, setNewMetric] = useState('100');
  const [newComment, setNewComment] = useState('');
  const [actionLoading, setActionLoading] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [editRoute, setEditRoute] = useState<string | null>(null);
  // Real interface addresses fetched from the agent; null until first fetched.
  // Falls back to topology-derived hints when unavailable.
  const [interfaceAddrs, setInterfaceAddrs] = useState<InterfaceAddr[] | null>(null);

  const sourceIpHints = useMemo(() => {
    // Prefer the agent's actual interface addresses; the topology-derived
    // hints (limited, IPv4-only, capped) remain as a fallback and fill gaps.
    const fallback = deriveSourceIpHints(agent);
    return interfaceAddrs ? [...orderSourceIps(interfaceAddrs), ...fallback] : fallback;
  }, [agent, interfaceAddrs]);

  const interfaceSuggestions = useMemo(
    () => (interfaceAddrs ? orderInterfaceNames(interfaceAddrs) : []),
    [interfaceAddrs],
  );

  // Maps each known address to its interface name, so the dialog can warn when
  // a source IP is bound to a different NIC than the pinned interface.
  const ipToInterface = useMemo(() => {
    const m: Record<string, string> = {};
    for (const a of interfaceAddrs || []) m[a.ip] = a.interface;
    return m;
  }, [interfaceAddrs]);

  // Re-fetch when switching to a different agent.
  useEffect(() => {
    setInterfaceAddrs(null);
  }, [agent.id]);

  // Fetch the agent's interface addresses lazily, the first time an edit
  // dialog opens. Best-effort: on failure we silently keep the fallback hints.
  useEffect(() => {
    if (editRoute === null || interfaceAddrs !== null) return;
    let cancelled = false;
    getAgentInterfaces(agent.id, agent.is_local)
      .then(resp => {
        if (!cancelled) setInterfaceAddrs(resp.addresses || []);
      })
      .catch(() => {
        if (!cancelled) setInterfaceAddrs([]);
      });
    return () => {
      cancelled = true;
    };
  }, [editRoute, interfaceAddrs, agent.id, agent.is_local]);

  const fetchRoutes = useCallback(async () => {
    setLoading(true);
    setError(null);
    setUnreachable(false);
    try {
      const resp = await manageAgentRoutes(agent.id, agent.is_local, {
        action: 'list',
        scope: 'all',
      });
      setRoutes(resp.routes || []);
    } catch (err: any) {
      const msg = err?.message || '';
      if ((err instanceof ApiError && err.status === 502) || msg.includes('no route to agent')) {
        setUnreachable(true);
      } else {
        setError(msg || 'Failed to fetch routes');
      }
    } finally {
      setLoading(false);
    }
  }, [agent.id, agent.is_local]);

  useEffect(() => {
    fetchRoutes();
  }, [fetchRoutes]);

  const handleAdd = useCallback(async () => {
    if (!newCidr.trim()) return;
    setActionLoading(true);
    setError(null);
    setSuccess(null);
    try {
      const req: RouteManageRequest = {
        action: 'add',
        network: newCidr.trim(),
        metric: parseInt(newMetric) || 100,
      };
      const c = newComment.trim();
      if (c) req.comment = c;
      await manageAgentRoutes(agent.id, agent.is_local, req);
      setSuccess(`Added route ${newCidr.trim()}`);
      setNewCidr('');
      setNewComment('');
      await fetchRoutes();
      onRoutesChanged();
    } catch (err: any) {
      setError(err.message || 'Failed to add route');
    } finally {
      setActionLoading(false);
    }
  }, [agent.id, agent.is_local, newCidr, newMetric, newComment, fetchRoutes, onRoutesChanged]);

  const handleEditRoute = useCallback(
    async (
      network: string,
      changes: { comment?: string; sourceIp?: string; interface?: string },
    ) => {
      const ops: RouteManageRequest[] = [];
      if (changes.comment !== undefined)
        ops.push({ action: 'set_comment', network, comment: changes.comment });
      if (changes.sourceIp !== undefined)
        ops.push({ action: 'set_source_ip', network, source_ip: changes.sourceIp });
      if (changes.interface !== undefined)
        ops.push({ action: 'set_interface', network, interface: changes.interface });
      if (ops.length === 0) {
        setEditRoute(null);
        return;
      }
      setActionLoading(true);
      setError(null);
      setSuccess(null);
      try {
        for (const op of ops) {
          await manageAgentRoutes(agent.id, agent.is_local, op);
        }
        setSuccess(`Updated route ${network}`);
        setEditRoute(null);
        await fetchRoutes();
      } catch (err: any) {
        setError(err.message || 'Failed to update route');
      } finally {
        setActionLoading(false);
      }
    },
    [agent.id, agent.is_local, fetchRoutes],
  );

  const handleRemove = useCallback(
    async (network: string) => {
      setActionLoading(true);
      setError(null);
      setSuccess(null);
      try {
        await manageAgentRoutes(agent.id, agent.is_local, { action: 'remove', network });
        setSuccess(`Removed route ${network}`);
        setConfirmRemove(null);
        await fetchRoutes();
        onRoutesChanged();
      } catch (err: any) {
        setError(err.message || 'Failed to remove route');
      } finally {
        setActionLoading(false);
      }
    },
    [agent.id, agent.is_local, fetchRoutes, onRoutesChanged],
  );

  // Pre-0834122 agents return dynamic-only routes with no `dynamic`
  // flag; recover static routes from `agent.exit_routes` so the UI
  // still surfaces them (read-only).
  const displayRoutes = useMemo<RouteEntry[]>(() => {
    const hasDynamicFlag = routes.some(r => r.dynamic !== undefined);
    if (hasDynamicFlag) return routes;
    const dynamicNetworks = new Set(routes.map(r => r.network));
    const staticEntries: RouteEntry[] = (agent.exit_routes || [])
      .filter(cidr => !dynamicNetworks.has(cidr))
      .map(cidr => ({ network: cidr, metric: 0, dynamic: false }));
    return [...routes.map(r => ({ ...r, dynamic: true })), ...staticEntries];
  }, [routes, agent.exit_routes]);

  // When agent is unreachable, show static route info from topology
  if (unreachable) {
    const exitRoutes = agent.exit_routes || [];
    return (
      <div className="routes-tab">
        <div className="ui-error">
          Agent is not reachable from the local node for route management
        </div>
        {exitRoutes.length > 0 && (
          <div className="routes-static">
            <div className="routes-static-header">Advertised exit routes (read-only)</div>
            <div className="routes-list">
              {exitRoutes.map(cidr => (
                <div key={cidr} className="routes-list-item routes-list-item-static">
                  <span className="routes-network">{cidr}</span>
                  <span className="ui-chip routes-badge-static">static</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  }

  const hasAnyRoutes = displayRoutes.length > 0;

  return (
    <div className="routes-tab">
      <div className="ui-hint">
        Exit routes tell the mesh which IP ranges this agent can reach. Traffic destined for a
        matching CIDR is routed through this agent and forwarded to the real network. Lower metric =
        higher priority.
      </div>
      {!canMutate && (
        <div className="ui-hint">
          Read-only: the connected agent has no management signing key, so routes cannot be added or
          removed.
        </div>
      )}
      {canMutate && (
        <div className="routes-add-form">
          <input
            type="text"
            className="input input-sm min-w-40 flex-1 font-mono"
            placeholder="CIDR (e.g. 10.0.0.0/24)"
            value={newCidr}
            onChange={e => setNewCidr(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleAdd()}
          />
          <input
            type="number"
            className="input input-sm font-mono w-20 shrink-0"
            placeholder="Metric"
            value={newMetric}
            onChange={e => setNewMetric(e.target.value)}
          />
          <input
            type="text"
            className="input input-sm min-w-32 flex-1 font-mono"
            placeholder="Comment (optional)"
            value={newComment}
            onChange={e => setNewComment(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleAdd()}
          />
          <button
            className="btn btn-sm btn-primary btn-soft"
            onClick={handleAdd}
            disabled={actionLoading || !newCidr.trim()}
          >
            Add
          </button>
        </div>
      )}

      {/* Feedback */}
      {error && <Alert kind="error" message={error} onClose={() => setError(null)} />}
      {success && <Alert kind="success" message={success} onClose={() => setSuccess(null)} />}

      {/* Routes list */}
      {loading ? (
        <div className="ui-loading">Loading routes...</div>
      ) : !hasAnyRoutes ? (
        <div className="ui-empty">No routes configured</div>
      ) : (
        <div className="routes-list">
          {displayRoutes.map(route => {
            const isStatic = route.dynamic === false;
            return (
              <div
                key={route.network}
                className={`routes-list-item${isStatic ? ' routes-list-item-static' : ''}`}
              >
                <div className="routes-network-wrap">
                  <span className="routes-network">{route.network}</span>
                  {route.comment && <span className="routes-comment">{route.comment}</span>}
                  {route.source_ip && (
                    <span className="ui-chip routes-source-ip">src: {route.source_ip}</span>
                  )}
                  {route.interface && (
                    <span className="ui-chip routes-interface">iface: {route.interface}</span>
                  )}
                </div>
                <span className="routes-metric">metric {route.metric}</span>
                {canMutate ? (
                  <>
                    <button
                      className="btn btn-xs btn-primary btn-soft"
                      onClick={() => setEditRoute(route.network)}
                      disabled={actionLoading}
                    >
                      Edit
                    </button>
                    {isStatic ? (
                      <span className="ui-chip routes-badge-static">static</span>
                    ) : (
                      <button
                        className="btn btn-xs btn-error btn-soft"
                        onClick={() => setConfirmRemove(route.network)}
                        disabled={actionLoading}
                      >
                        Remove
                      </button>
                    )}
                  </>
                ) : (
                  <span className="ui-chip routes-badge-static">
                    {isStatic ? 'static' : 'dynamic'}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}

      {confirmRemove && (
        <ConfirmDialog
          title="Remove route"
          target={confirmRemove}
          message="Stop advertising this CIDR to the mesh? Traffic matching this route will no longer be sent through this agent."
          loading={actionLoading}
          onCancel={() => setConfirmRemove(null)}
          onConfirm={() => handleRemove(confirmRemove)}
        />
      )}

      {editRoute &&
        (() => {
          const r = displayRoutes.find(x => x.network === editRoute);
          return (
            <RouteEditDialog
              target={editRoute}
              initialComment={r?.comment || ''}
              initialSourceIp={r?.source_ip || ''}
              initialInterface={r?.interface || ''}
              sourceIpSuggestions={sourceIpHints}
              interfaceSuggestions={interfaceSuggestions}
              ipToInterface={ipToInterface}
              loading={actionLoading}
              onCancel={() => setEditRoute(null)}
              onSave={changes => handleEditRoute(editRoute, changes)}
            />
          );
        })()}
    </div>
  );
}

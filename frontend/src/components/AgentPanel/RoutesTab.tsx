import { useState, useEffect, useCallback, useMemo } from 'react';
import type { TopologyAgentInfo } from '../../api/types';
import { manageAgentRoutes } from '../../api/client';

interface RoutesTabProps {
  agent: TopologyAgentInfo;
  onRoutesChanged: () => void;
}

interface RouteEntry {
  network: string;
  metric: number;
}

export default function RoutesTab({ agent, onRoutesChanged }: RoutesTabProps) {
  const [routes, setRoutes] = useState<RouteEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [unreachable, setUnreachable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [newCidr, setNewCidr] = useState('');
  const [newMetric, setNewMetric] = useState('100');
  const [actionLoading, setActionLoading] = useState(false);

  const fetchRoutes = useCallback(async () => {
    setLoading(true);
    setError(null);
    setUnreachable(false);
    try {
      const resp = await manageAgentRoutes(agent.id, agent.is_local, { action: 'list' });
      setRoutes(resp.routes || []);
    } catch (err: any) {
      const msg = err.message || '';
      if (msg.includes('no route to agent') || msg.includes('502')) {
        setUnreachable(true);
      } else {
        setError(msg || 'Failed to fetch routes');
      }
    } finally {
      setLoading(false);
    }
  }, [agent.id]);

  useEffect(() => {
    fetchRoutes();
  }, [fetchRoutes]);

  const handleAdd = useCallback(async () => {
    if (!newCidr.trim()) return;
    setActionLoading(true);
    setError(null);
    setSuccess(null);
    try {
      await manageAgentRoutes(agent.id, agent.is_local, {
        action: 'add',
        network: newCidr.trim(),
        metric: parseInt(newMetric) || 100,
      });
      setSuccess(`Added route ${newCidr.trim()}`);
      setNewCidr('');
      await fetchRoutes();
      onRoutesChanged();
    } catch (err: any) {
      setError(err.message || 'Failed to add route');
    } finally {
      setActionLoading(false);
    }
  }, [agent.id, newCidr, newMetric, fetchRoutes, onRoutesChanged]);

  const handleRemove = useCallback(async (network: string) => {
    setActionLoading(true);
    setError(null);
    setSuccess(null);
    try {
      await manageAgentRoutes(agent.id, agent.is_local, { action: 'remove', network });
      setSuccess(`Removed route ${network}`);
      await fetchRoutes();
      onRoutesChanged();
    } catch (err: any) {
      setError(err.message || 'Failed to remove route');
    } finally {
      setActionLoading(false);
    }
  }, [agent.id, fetchRoutes, onRoutesChanged]);

  // Compute static routes: exit_routes that are NOT in the dynamic route list
  const staticRoutes = useMemo(() => {
    const dynamicNetworks = new Set(routes.map(r => r.network));
    return (agent.exit_routes || []).filter(cidr => !dynamicNetworks.has(cidr));
  }, [routes, agent.exit_routes]);

  // When agent is unreachable, show static route info from topology
  if (unreachable) {
    const exitRoutes = agent.exit_routes || [];
    return (
      <div className="routes-tab">
        <div className="tab-error">
          Agent is not reachable from the local node for route management
        </div>
        {exitRoutes.length > 0 && (
          <div className="routes-static">
            <div className="routes-static-header">Advertised exit routes (read-only)</div>
            <div className="routes-list">
              {exitRoutes.map(cidr => (
                <div key={cidr} className="routes-list-item routes-list-item-static">
                  <span className="routes-network">{cidr}</span>
                  <span className="routes-badge-static">static</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  }

  const hasAnyRoutes = routes.length > 0 || staticRoutes.length > 0;

  return (
    <div className="routes-tab">
      {/* Add route form */}
      <div className="routes-add-form">
        <input
          type="text"
          className="panel-input"
          placeholder="CIDR (e.g. 10.0.0.0/24)"
          value={newCidr}
          onChange={e => setNewCidr(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && handleAdd()}
        />
        <input
          type="number"
          className="panel-input panel-input-small"
          placeholder="Metric"
          value={newMetric}
          onChange={e => setNewMetric(e.target.value)}
        />
        <button className="panel-btn" onClick={handleAdd} disabled={actionLoading || !newCidr.trim()}>
          Add
        </button>
      </div>

      {/* Feedback */}
      {error && <div className="tab-error">{error}</div>}
      {success && <div className="tab-success">{success}</div>}

      {/* Routes list */}
      {loading ? (
        <div className="tab-loading">Loading routes...</div>
      ) : !hasAnyRoutes ? (
        <div className="tab-empty">No routes configured</div>
      ) : (
        <div className="routes-list">
          {routes.map(route => (
            <div key={route.network} className="routes-list-item">
              <span className="routes-network">{route.network}</span>
              <span className="routes-metric">metric {route.metric}</span>
              <button
                className="panel-btn panel-btn-danger"
                onClick={() => handleRemove(route.network)}
                disabled={actionLoading}
              >
                Remove
              </button>
            </div>
          ))}
          {staticRoutes.map(cidr => (
            <div key={cidr} className="routes-list-item routes-list-item-static">
              <span className="routes-network">{cidr}</span>
              <span className="routes-badge-static">static</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import type { TopologyAgentInfo, ForwardListenerEntry } from '../../api/types';
import { manageAgentForwards } from '../../api/client';

interface ForwardsTabProps {
  agent: TopologyAgentInfo;
  allForwardKeys: string[];
  onForwardsChanged: () => void;
}

export default function ForwardsTab({ agent, allForwardKeys, onForwardsChanged }: ForwardsTabProps) {
  const [listeners, setListeners] = useState<ForwardListenerEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [unreachable, setUnreachable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [newKey, setNewKey] = useState('');
  const [newAddress, setNewAddress] = useState('');
  const [newMaxConn, setNewMaxConn] = useState('');
  const [actionLoading, setActionLoading] = useState(false);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const comboboxRef = useRef<HTMLDivElement>(null);

  const fetchListeners = useCallback(async () => {
    setLoading(true);
    setError(null);
    setUnreachable(false);
    try {
      const resp = await manageAgentForwards(agent.id, agent.is_local, { action: 'list' });
      setListeners(resp.listeners || []);
    } catch (err: any) {
      const msg = err.message || '';
      if (msg.includes('no route to agent') || msg.includes('502')) {
        setUnreachable(true);
      } else {
        setError(msg || 'Failed to fetch listeners');
      }
    } finally {
      setLoading(false);
    }
  }, [agent.id]);

  useEffect(() => {
    fetchListeners();
  }, [fetchListeners]);

  const handleAdd = useCallback(async () => {
    const key = newKey.trim();
    let address = newAddress.trim();
    if (!key || !address) return;
    if (/^\d+$/.test(address)) address = ':' + address;
    setActionLoading(true);
    setError(null);
    setSuccess(null);
    try {
      const maxConn = parseInt(newMaxConn, 10);
      await manageAgentForwards(agent.id, agent.is_local, {
        action: 'add',
        key,
        address,
        ...(maxConn > 0 && { max_connections: maxConn }),
      });
      setSuccess(`Added listener "${key}" on ${address}`);
      setNewKey('');
      setNewAddress('');
      setNewMaxConn('');
      await fetchListeners();
      onForwardsChanged();
    } catch (err: any) {
      setError(err.message || 'Failed to add listener');
    } finally {
      setActionLoading(false);
    }
  }, [agent.id, newKey, newAddress, newMaxConn, fetchListeners, onForwardsChanged]);

  const handleRemove = useCallback(async (key: string) => {
    setActionLoading(true);
    setError(null);
    setSuccess(null);
    try {
      await manageAgentForwards(agent.id, agent.is_local, { action: 'remove', key });
      setSuccess(`Removed listener "${key}"`);
      await fetchListeners();
      onForwardsChanged();
    } catch (err: any) {
      setError(err.message || 'Failed to remove listener');
    } finally {
      setActionLoading(false);
    }
  }, [agent.id, fetchListeners, onForwardsChanged]);

  // Click-outside closes dropdown
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (comboboxRef.current && !comboboxRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const filteredKeys = useMemo(() => {
    const activeKeys = new Set([
      ...listeners.map(l => l.key),
      ...(agent.forward_listeners || []),
    ]);
    const query = newKey.trim().toLowerCase();
    return allForwardKeys.filter(k => !activeKeys.has(k) && (!query || k.toLowerCase().includes(query)));
  }, [allForwardKeys, listeners, agent.forward_listeners, newKey]);

  // Static listeners: keys from topology that aren't in the dynamic list
  const staticKeys = useMemo(() => {
    const dynamicKeys = new Set(listeners.map(l => l.key));
    return (agent.forward_listeners || []).filter(k => !dynamicKeys.has(k));
  }, [listeners, agent.forward_listeners]);

  // Unreachable fallback: show read-only keys from topology
  if (unreachable) {
    const keys = agent.forward_listeners || [];
    return (
      <div className="routes-tab">
        <div className="tab-error">
          Agent is not reachable from the local node for forward management
        </div>
        {keys.length > 0 && (
          <div className="routes-static">
            <div className="routes-static-header">Forward listeners (read-only)</div>
            <div className="routes-list">
              {keys.map(key => (
                <div key={key} className="routes-list-item routes-list-item-static">
                  <span className="forwards-key">{key}</span>
                  <span className="routes-badge-static">static</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  }

  const hasAny = listeners.length > 0 || staticKeys.length > 0;

  return (
    <div className="routes-tab">
      {/* Add listener form */}
      <div className="routes-add-form">
        <div className="combobox" ref={comboboxRef}>
          <input
            type="text"
            className="panel-input"
            placeholder="Key"
            value={newKey}
            onChange={e => { setNewKey(e.target.value); setDropdownOpen(true); }}
            onFocus={() => setDropdownOpen(true)}
            onKeyDown={e => {
              if (e.key === 'Enter') { setDropdownOpen(false); handleAdd(); }
              if (e.key === 'Escape') setDropdownOpen(false);
            }}
          />
          {dropdownOpen && (
            <div className="combobox-dropdown">
              {filteredKeys.length > 0 ? filteredKeys.map(k => (
                <div
                  key={k}
                  className="combobox-option"
                  onMouseDown={e => { e.preventDefault(); setNewKey(k); setDropdownOpen(false); }}
                >
                  {k}
                </div>
              )) : (
                <div className="combobox-empty">No matching keys</div>
              )}
            </div>
          )}
        </div>
        <input
          type="text"
          className="panel-input"
          placeholder="Address (e.g. :9090)"
          value={newAddress}
          onChange={e => setNewAddress(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && handleAdd()}
        />
        <input
          type="number"
          className="panel-input panel-input-small"
          placeholder="Max conn"
          value={newMaxConn}
          onChange={e => setNewMaxConn(e.target.value)}
        />
        <button className="panel-btn" onClick={handleAdd} disabled={actionLoading || !newKey.trim() || !newAddress.trim()}>
          Add
        </button>
      </div>

      {/* Feedback */}
      {error && <div className="tab-error">{error}</div>}
      {success && <div className="tab-success">{success}</div>}

      {/* Listeners list */}
      {loading ? (
        <div className="tab-loading">Loading listeners...</div>
      ) : !hasAny ? (
        <div className="tab-empty">No forward listeners configured</div>
      ) : (
        <div className="routes-list">
          {listeners.map(l => (
            <div key={l.key} className={`routes-list-item${!l.dynamic ? ' routes-list-item-static' : ''}`}>
              <span className="forwards-key">{l.key}</span>
              <span className="forwards-address">{l.address}</span>
              {l.max_connections > 0 && <span className="forwards-maxconn">max: {l.max_connections}</span>}
              {l.dynamic ? (
                <button
                  className="panel-btn panel-btn-danger"
                  onClick={() => handleRemove(l.key)}
                  disabled={actionLoading}
                >
                  Remove
                </button>
              ) : (
                <span className="routes-badge-static">static</span>
              )}
            </div>
          ))}
          {staticKeys.map(key => (
            <div key={key} className="routes-list-item routes-list-item-static">
              <span className="forwards-key">{key}</span>
              <span className="routes-badge-static">static</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

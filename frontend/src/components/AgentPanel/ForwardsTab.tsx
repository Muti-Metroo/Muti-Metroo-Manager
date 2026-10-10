import {
  useState,
  useEffect,
  useCallback,
  useMemo,
  useRef,
  type Dispatch,
  type SetStateAction,
  type ReactNode,
} from 'react';
import type {
  TopologyAgentInfo,
  ForwardListenerEntry,
  ForwardEndpointEntry,
} from '../../api/types';
import { isAttachedTarget } from '../../api/types';
import { manageAgentForwards, manageAgentForwardEndpoints, ApiError } from '../../api/client';
import Alert from '../Alert';
import Tabs from '../Tabs';
import ConfirmDialog from '../ConfirmDialog';

interface ForwardsTabProps {
  agent: TopologyAgentInfo;
  // Whether the locally-connected agent can sign listener/endpoint mutations.
  // null while unknown; when false the add form and remove buttons are hidden.
  canSignManagement: boolean | null;
  allForwardKeys: string[];
  onForwardsChanged: () => void;
}

function extractPort(addr: string): string | null {
  const m = /:(\d+)$/.exec(addr);
  return m ? m[1] : null;
}

function ListenerUsageHint({ items }: { items: ForwardListenerEntry[] }) {
  // Pick the first listener with a parseable port; users can adapt for the
  // rest. Port lookup avoids showing a stale placeholder when the agent has
  // assigned a concrete ephemeral port for a ":0" listener.
  const portItem = items.find(i => extractPort(i.address));
  const port = portItem ? extractPort(portItem.address) : null;
  const portRef = port ?? '<port>';
  return (
    <div className="ui-hint mb-0 space-y-1.5">
      <div className="text-base-content/80 font-semibold">Usage</div>
      <div>
        From any host that can reach <code>{'<agent-host>'}</code>, connect to the listener; it
        tunnels through the mesh to the endpoint&apos;s target.
      </div>
      <pre className="bg-base-300 rounded-field overflow-x-auto p-2 font-mono">
        <code>
          curl http://{'<agent-host>'}:{portRef}/
        </code>
      </pre>
      <div>
        For a TLS backend, preserve SNI by overriding DNS instead of pointing curl at the listener
        directly:
      </div>
      <pre className="bg-base-300 rounded-field overflow-x-auto p-2 font-mono">
        <code>
          curl --resolve example.com:{portRef}:{'<agent-host>'} https://example.com:{portRef}/
        </code>
      </pre>
    </div>
  );
}

interface ListenerForm {
  address: string;
}

interface EndpointForm {
  target: string;
}

type ForwardsView = 'listeners' | 'endpoints';

const FORWARD_VIEWS: { id: ForwardsView; label: string }[] = [
  { id: 'listeners', label: 'Listeners (ingress)' },
  { id: 'endpoints', label: 'Endpoints (exit)' },
];

export default function ForwardsTab({
  agent,
  canSignManagement,
  allForwardKeys,
  onForwardsChanged,
}: ForwardsTabProps) {
  const { id, is_local } = agent;
  const canMutate = canSignManagement !== false;
  const [view, setView] = useState<ForwardsView>('listeners');

  // Listener wiring
  const fetchListeners = useCallback(
    () => manageAgentForwards(id, is_local, { action: 'list' }).then(r => r.listeners || []),
    [id, is_local],
  );
  const addListener = useCallback(
    async (key: string, f: ListenerForm) => {
      let address = f.address.trim();
      if (/^\d+$/.test(address)) address = ':' + address;
      await manageAgentForwards(id, is_local, { action: 'add', key, address });
    },
    [id, is_local],
  );
  const removeListener = useCallback(
    (key: string) =>
      manageAgentForwards(id, is_local, { action: 'remove', key }).then(() => undefined),
    [id, is_local],
  );

  // Endpoint wiring
  const fetchEndpoints = useCallback(
    () =>
      manageAgentForwardEndpoints(id, is_local, { action: 'list' }).then(r => r.endpoints || []),
    [id, is_local],
  );
  const addEndpoint = useCallback(
    async (key: string, f: EndpointForm) => {
      await manageAgentForwardEndpoints(id, is_local, {
        action: 'add',
        key,
        target: f.target.trim(),
      });
    },
    [id, is_local],
  );
  const removeEndpoint = useCallback(
    (key: string) =>
      manageAgentForwardEndpoints(id, is_local, { action: 'remove', key }).then(() => undefined),
    [id, is_local],
  );

  return (
    <div className="routes-tab">
      <div className="ui-hint">
        Port forwards pair <b>listeners</b> and <b>endpoints</b> by routing key. A listener opens a
        local TCP port and tunnels connections through the mesh to an endpoint, which dials the real
        service. Any number of agents may run a listener for the same key — a client just connects
        to the nearest one.
        <div className="mt-1.5">
          Example: one agent advertises an endpoint <code>db</code> → <code>10.0.0.5:5432</code>.
          Every other agent runs a listener for <code>db</code> on <code>:5432</code>. Any client
          connects to <code>localhost:5432</code> on whichever agent is closest and reaches the same
          database through the mesh.
        </div>
      </div>

      {!canMutate && (
        <div className="ui-hint">
          Read-only: the connected agent has no management signing key, so forwards cannot be added
          or removed.
        </div>
      )}

      <Tabs size="sm" tabs={FORWARD_VIEWS} activeId={view} onChange={setView} />

      {view === 'listeners' && (
        <ForwardSection<ForwardListenerEntry, ListenerForm>
          itemLabel="listener"
          canMutate={canMutate}
          fetchItems={fetchListeners}
          addItem={addListener}
          removeItem={removeListener}
          staticKeys={agent.forward_listeners || []}
          allKeys={allForwardKeys}
          extraInitial={EMPTY_LISTENER_FORM}
          canSubmit={(_key, f) => !!f.address.trim()}
          renderExtraFields={(values, setValues, submit) => (
            <input
              type="text"
              className="input input-sm font-mono"
              placeholder="Address (e.g. :9090)"
              value={values.address}
              onChange={e => setValues(v => ({ ...v, address: e.target.value }))}
              onKeyDown={e => e.key === 'Enter' && submit()}
            />
          )}
          renderRow={l => (
            <>
              <span className="forwards-key">{l.key}</span>
              <span className="text-muted font-mono">{l.address}</span>
              {l.max_connections > 0 && (
                <span className="text-muted text-xs">max: {l.max_connections}</span>
              )}
            </>
          )}
          renderFooter={items => <ListenerUsageHint items={items} />}
          onChanged={onForwardsChanged}
        />
      )}

      {view === 'endpoints' && (
        <ForwardSection<ForwardEndpointEntry, EndpointForm>
          itemLabel="endpoint"
          canMutate={canMutate}
          fetchItems={fetchEndpoints}
          addItem={addEndpoint}
          removeItem={removeEndpoint}
          staticKeys={agent.forward_endpoints || []}
          allKeys={allForwardKeys}
          extraInitial={EMPTY_ENDPOINT_FORM}
          canSubmit={(_key, f) => !!f.target.trim()}
          renderExtraFields={(values, setValues, submit) => (
            <input
              type="text"
              className="input input-sm font-mono"
              placeholder="Target (e.g. 127.0.0.1:3000)"
              value={values.target}
              onChange={e => setValues(v => ({ ...v, target: e.target.value }))}
              onKeyDown={e => e.key === 'Enter' && submit()}
            />
          )}
          renderRow={ep => (
            <>
              <span className="forwards-key">{ep.key}</span>
              {isAttachedTarget(ep.target) ? (
                <span
                  className="ui-chip routes-badge-attached"
                  title="Ephemeral endpoint attached over the agent's expose stream"
                >
                  attached · expose
                </span>
              ) : (
                <span className="text-muted font-mono">{ep.target}</span>
              )}
            </>
          )}
          onChanged={onForwardsChanged}
        />
      )}
    </div>
  );
}

// Stable identities — passing inline object literals as defaults would reset
// the form on every parent render.
const EMPTY_LISTENER_FORM: ListenerForm = { address: '' };
const EMPTY_ENDPOINT_FORM: EndpointForm = { target: '' };

interface ForwardEntryBase {
  key: string;
  dynamic: boolean;
}

interface ForwardSectionProps<T extends ForwardEntryBase, V> {
  itemLabel: string;
  canMutate: boolean;
  fetchItems: () => Promise<T[]>;
  addItem: (key: string, extra: V) => Promise<void>;
  removeItem: (key: string) => Promise<void>;
  staticKeys: string[];
  allKeys: string[];
  extraInitial: V;
  renderExtraFields: (
    values: V,
    setValues: Dispatch<SetStateAction<V>>,
    submit: () => void,
  ) => ReactNode;
  renderRow: (item: T) => ReactNode;
  renderFooter?: (items: T[]) => ReactNode;
  canSubmit: (key: string, extra: V) => boolean;
  onChanged: () => void;
}

function ForwardSection<T extends ForwardEntryBase, V>({
  itemLabel,
  canMutate,
  fetchItems,
  addItem,
  removeItem,
  staticKeys,
  allKeys,
  extraInitial,
  renderExtraFields,
  renderRow,
  renderFooter,
  canSubmit,
  onChanged,
}: ForwardSectionProps<T, V>) {
  const [items, setItems] = useState<T[]>([]);
  const [loading, setLoading] = useState(true);
  const [unreachable, setUnreachable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [newKey, setNewKey] = useState('');
  const [extra, setExtra] = useState<V>(extraInitial);
  const [actionLoading, setActionLoading] = useState(false);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const comboboxRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setUnreachable(false);
    try {
      setItems(await fetchItems());
    } catch (err: any) {
      const msg = err?.message || '';
      if ((err instanceof ApiError && err.status === 502) || msg.includes('no route to agent')) {
        setUnreachable(true);
      } else {
        setError(msg || `Failed to fetch ${itemLabel}s`);
      }
    } finally {
      setLoading(false);
    }
  }, [fetchItems, itemLabel]);

  useEffect(() => {
    load();
  }, [load]);

  const handleAdd = useCallback(async () => {
    const key = newKey.trim();
    if (!key || !canSubmit(key, extra)) return;
    setActionLoading(true);
    setError(null);
    setSuccess(null);
    try {
      await addItem(key, extra);
      setSuccess(`Added ${itemLabel} "${key}"`);
      setNewKey('');
      setExtra(extraInitial);
      await load();
      onChanged();
    } catch (err: any) {
      setError(err.message || `Failed to add ${itemLabel}`);
    } finally {
      setActionLoading(false);
    }
  }, [newKey, extra, canSubmit, addItem, itemLabel, load, onChanged, extraInitial]);

  const handleRemove = useCallback(
    async (key: string) => {
      setActionLoading(true);
      setError(null);
      setSuccess(null);
      try {
        await removeItem(key);
        setSuccess(`Removed ${itemLabel} "${key}"`);
        setConfirmRemove(null);
        await load();
        onChanged();
      } catch (err: any) {
        setError(err.message || `Failed to remove ${itemLabel}`);
      } finally {
        setActionLoading(false);
      }
    },
    [removeItem, itemLabel, load, onChanged],
  );

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
    const activeKeys = new Set([...items.map(i => i.key), ...staticKeys]);
    const query = newKey.trim().toLowerCase();
    return allKeys.filter(k => !activeKeys.has(k) && (!query || k.toLowerCase().includes(query)));
  }, [allKeys, items, staticKeys, newKey]);

  const staticOnly = useMemo(() => {
    const dynamicKeys = new Set(items.map(i => i.key));
    return staticKeys.filter(k => !dynamicKeys.has(k));
  }, [items, staticKeys]);

  if (unreachable) {
    return (
      <div className="routes-tab">
        <div className="ui-error">
          Agent is not reachable from the local node for {itemLabel} management
        </div>
        {staticKeys.length > 0 && (
          <div className="routes-list">
            {staticKeys.map(key => (
              <div key={key} className="routes-list-item routes-list-item-static">
                <span className="forwards-key">{key}</span>
                <span className="ui-chip routes-badge-static">static</span>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  const submittable = !!newKey.trim() && canSubmit(newKey.trim(), extra);
  const hasAny = items.length > 0 || staticOnly.length > 0;

  return (
    <div className="flex flex-col gap-3">
      {canMutate && (
        <div className="routes-add-form">
          <div className="relative min-w-0 flex-1" ref={comboboxRef}>
            <input
              type="text"
              className="input input-sm w-full font-mono"
              placeholder="Key"
              value={newKey}
              onChange={e => {
                setNewKey(e.target.value);
                setDropdownOpen(true);
              }}
              onFocus={() => setDropdownOpen(true)}
              onKeyDown={e => {
                if (e.key === 'Enter') {
                  setDropdownOpen(false);
                  handleAdd();
                }
                if (e.key === 'Escape') setDropdownOpen(false);
              }}
            />
            {dropdownOpen && (
              <div className="ui-popover inset-x-0 top-full mt-1 max-h-56">
                {filteredKeys.length > 0 ? (
                  filteredKeys.map(k => (
                    <div
                      key={k}
                      className="rounded-field hover:bg-base-200 cursor-pointer px-2 py-1 font-mono"
                      onMouseDown={e => {
                        e.preventDefault();
                        setNewKey(k);
                        setDropdownOpen(false);
                      }}
                    >
                      {k}
                    </div>
                  ))
                ) : (
                  <div className="text-muted px-2 py-1 italic">No matching keys</div>
                )}
              </div>
            )}
          </div>
          {renderExtraFields(extra, setExtra, handleAdd)}
          <button
            className="btn btn-sm btn-primary btn-soft"
            onClick={handleAdd}
            disabled={actionLoading || !submittable}
          >
            Add
          </button>
        </div>
      )}

      {error && <Alert kind="error" message={error} onClose={() => setError(null)} />}
      {success && <Alert kind="success" message={success} onClose={() => setSuccess(null)} />}

      {loading ? (
        <div className="ui-loading">Loading {itemLabel}s...</div>
      ) : !hasAny ? (
        <div className="ui-empty">No {itemLabel}s configured</div>
      ) : (
        <div className="routes-list">
          {items.map(item => (
            <div
              key={item.key}
              className={`routes-list-item${!item.dynamic ? ' routes-list-item-static' : ''}`}
            >
              {renderRow(item)}
              {item.dynamic ? (
                canMutate ? (
                  <button
                    className="btn btn-xs btn-error btn-soft"
                    onClick={() => setConfirmRemove(item.key)}
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
          ))}
          {staticOnly.map(key => (
            <div key={key} className="routes-list-item routes-list-item-static">
              <span className="forwards-key">{key}</span>
              <span className="ui-chip routes-badge-static">static</span>
            </div>
          ))}
        </div>
      )}

      {!loading && hasAny && renderFooter?.(items)}

      {confirmRemove && (
        <ConfirmDialog
          title={`Remove ${itemLabel}`}
          target={confirmRemove}
          message={`Remove this ${itemLabel} from the agent? Clients relying on it will lose the forward until it's added back.`}
          loading={actionLoading}
          onCancel={() => setConfirmRemove(null)}
          onConfirm={() => handleRemove(confirmRemove)}
        />
      )}
    </div>
  );
}

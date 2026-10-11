import { useCallback, useEffect, useRef, useState } from 'react';
import type { TopologyAgentInfo, MeshTestResult, AgentMeta } from '../../api/types';
import { copyToClipboard } from '../../util/clipboard';
import { formatUptime } from '../../util/format';
import { putAgentMetadata } from '../../api/client';
import { AgentIcon, ICON_BY_KEY } from '../MetroMap/agentIcons';
import { normalizeNetworks, parseNetworks, type KnownNetwork } from '../../util/networks';
import NetworksField from './NetworksField';
import IconPicker from './IconPicker';

type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

interface InfoTabProps {
  agent: TopologyAgentInfo;
  meshResult: MeshTestResult | undefined;
  // Known only for the locally-connected agent (from dashboard stats).
  // null when unknown (non-local agent or dashboard not yet loaded).
  canSignManagement?: boolean | null;
  // Operator-configured SOCKS5 address. Used for the local agent's
  // display instead of the agent's self-reported socks5_addr so that
  // a centrally-deployed Muti Metroo Manager advertises a reachable address
  // rather than whatever the agent binds internally.
  socksAddress?: string;
  // Operator-set metadata persisted in muti-metroo-manager.db. Both fields default
  // to '' when no override is set.
  meta: AgentMeta;
  onMetaChange: (agentId: string, meta: AgentMeta) => void;
  // Networks that already exist anywhere in the mesh, for the typeahead.
  networks: KnownNetwork[];
}

function metaEqual(a: AgentMeta, b: AgentMeta): boolean {
  return a.note === b.note && a.icon === b.icon && a.networks === b.networks;
}

export default function InfoTab({
  agent,
  meshResult,
  canSignManagement,
  socksAddress,
  meta,
  onMetaChange,
  networks,
}: InfoTabProps) {
  const displaySocks = agent.is_local && socksAddress ? socksAddress : agent.socks5_addr;
  const [copyHint, setCopyHint] = useState('Click to copy');
  const [draft, setDraft] = useState<AgentMeta>(meta);
  // Raw text of the networks field; committed (normalized) into draft.networks
  // on blur so the user can type freely without mid-edit sanitizing.
  const [networksInput, setNetworksInput] = useState(meta.networks);
  const [status, setStatus] = useState<SaveStatus>('idle');
  const [pickerOpen, setPickerOpen] = useState(false);
  const statusTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSaved = useRef<AgentMeta>(meta);

  // Reset the draft whenever the persisted meta changes from outside
  // (another tab saved it, or the panel was reopened on a different agent).
  useEffect(() => {
    setDraft(meta);
    setNetworksInput(meta.networks);
    lastSaved.current = meta;
    setStatus('idle');
  }, [agent.id, meta]);

  // Capture the latest draft for the unmount-save effect so we don't
  // recreate the cleanup function every keystroke.
  const draftRef = useRef(draft);
  draftRef.current = draft;
  useEffect(
    () => () => {
      if (statusTimer.current) clearTimeout(statusTimer.current);
      if (!metaEqual(draftRef.current, lastSaved.current)) {
        // Panel is closing with unsaved changes; fire-and-forget so the value
        // isn't lost. Merge locally so the map indicator updates immediately.
        const pending = draftRef.current;
        putAgentMetadata(agent.id, pending)
          .then(() => onMetaChange(agent.id, pending))
          .catch(() => {});
      }
    },
    [agent.id, onMetaChange],
  );

  const persist = useCallback(
    async (next: AgentMeta) => {
      if (metaEqual(next, lastSaved.current)) return;
      setStatus('saving');
      try {
        const saved = await putAgentMetadata(agent.id, next);
        lastSaved.current = saved;
        onMetaChange(agent.id, saved);
        setStatus('saved');
        if (statusTimer.current) clearTimeout(statusTimer.current);
        statusTimer.current = setTimeout(() => setStatus('idle'), 1500);
      } catch {
        setStatus('error');
      }
    },
    [agent.id, onMetaChange],
  );

  const saveNote = useCallback(() => persist(draftRef.current), [persist]);

  // Commit the networks field: normalize the raw text, reflect it back into
  // the input and draft, and persist.
  const commitNetworks = useCallback(() => {
    const normalized = normalizeNetworks(networksInput);
    setNetworksInput(normalized);
    const next: AgentMeta = { ...draftRef.current, networks: normalized };
    setDraft(next);
    void persist(next);
  }, [networksInput, persist]);

  const setIcon = useCallback(
    (iconKey: string) => {
      // Icons commit immediately (no draft staging) — picker is one-click,
      // and a "save" button on a dropdown would feel wrong.
      const next: AgentMeta = { ...draftRef.current, icon: iconKey };
      setDraft(next);
      void persist(next);
    },
    [persist],
  );

  const handleCopy = useCallback(async () => {
    const ok = await copyToClipboard(agent.id || agent.short_id);
    setCopyHint(ok ? 'Copied!' : 'Copy failed');
    setTimeout(() => setCopyHint('Click to copy'), 1500);
  }, [agent]);

  const roles = agent.roles || ['transit'];
  const uptimeStr = formatUptime(agent.uptime_hours);

  const exitRoutes = agent.exit_routes || [];
  const domainRoutes = agent.domain_routes || [];
  const forwardListeners = agent.forward_listeners || [];
  const forwardEndpoints = agent.forward_endpoints || [];
  const networkChips = parseNetworks(normalizeNetworks(networksInput));

  const currentIconDef = draft.icon ? ICON_BY_KEY[draft.icon] : undefined;

  return (
    <div className="space-y-3">
      {/* Roles */}
      {roles.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {roles.map(role => (
            <span key={role} className={`ui-chip tooltip-role-badge ${role}`}>
              {role}
            </span>
          ))}
        </div>
      )}

      {/* Reachability */}
      {meshResult && (
        <div className="ui-section">
          <div className="ui-section-header">Reachability</div>
          <div className="px-3 py-2">
            {meshResult.reachable ? (
              <span className="text-success font-mono">
                OK ({meshResult.is_local ? 'local' : `${meshResult.response_time_ms}ms`})
              </span>
            ) : (
              <span className="text-error font-mono">
                FAILED: {meshResult.error || 'unreachable'}
              </span>
            )}
          </div>
        </div>
      )}

      {/* Details */}
      {(agent.hostname ||
        agent.os ||
        agent.arch ||
        agent.version ||
        uptimeStr ||
        agent.pid ||
        (agent.ip_addresses && agent.ip_addresses.length > 0)) && (
        <div className="ui-section">
          <div className="ui-section-header">Details</div>
          <dl className="ui-kv px-3 py-2">
            {agent.hostname && (
              <>
                <dt>Hostname</dt>
                <dd>{agent.hostname}</dd>
              </>
            )}
            {(agent.os || agent.arch) && (
              <>
                <dt>Platform</dt>
                <dd>{[agent.os, agent.arch].filter(Boolean).join('/')}</dd>
              </>
            )}
            {agent.version && (
              <>
                <dt>Version</dt>
                <dd>{agent.version}</dd>
              </>
            )}
            {uptimeStr && (
              <>
                <dt>Uptime</dt>
                <dd>{uptimeStr}</dd>
              </>
            )}
            {agent.pid && (
              <>
                <dt>PID</dt>
                <dd>{agent.pid}</dd>
              </>
            )}
            {agent.ip_addresses && agent.ip_addresses.length > 0 && (
              <>
                <dt>IPs</dt>
                <dd>{agent.ip_addresses.join(', ')}</dd>
              </>
            )}
          </dl>
        </div>
      )}

      {/* SOCKS4/5 */}
      {displaySocks && (
        <div className="ui-section">
          <div className="ui-section-header">SOCKS4/5 proxy</div>
          <div className="px-3 py-2 font-mono">{displaySocks}</div>
        </div>
      )}

      {/* Remote access */}
      <div className="ui-section">
        <div className="ui-section-header">Remote access</div>
        <dl className="ui-kv px-3 py-2">
          <dt>Shell</dt>
          <dd>
            {agent.shells && agent.shells.length > 0 ? (
              <span className="flex flex-wrap gap-1">
                {agent.shells.map(sh => (
                  <span key={sh} className="badge badge-sm badge-soft badge-primary font-mono">
                    {sh}
                  </span>
                ))}
              </span>
            ) : (
              <span className="text-muted italic">Not available</span>
            )}
          </dd>
          <dt>File transfer</dt>
          <dd>
            {agent.file_transfer_enabled ? (
              <span className="text-success">Enabled</span>
            ) : (
              <span className="text-muted italic">Not available</span>
            )}
          </dd>
          {agent.is_local && canSignManagement === false && (
            <>
              <dt>Signing key</dt>
              <dd className="text-warning font-sans">
                Not configured &mdash; shell, file transfer, and dynamic mutations are disabled
              </dd>
            </>
          )}
        </dl>
      </div>

      {/* CIDR routes */}
      {exitRoutes.length > 0 && (
        <div className="ui-section">
          <div className="ui-section-header">CIDR routes ({exitRoutes.length})</div>
          <div className="flex flex-wrap gap-1 px-3 py-2">
            {exitRoutes.map(cidr => (
              <span key={cidr} className="ui-chip tooltip-cidr">
                {cidr}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Domain routes */}
      {domainRoutes.length > 0 && (
        <div className="ui-section">
          <div className="ui-section-header">Domain routes ({domainRoutes.length})</div>
          <div className="flex flex-wrap gap-1 px-3 py-2">
            {domainRoutes.map(domain => (
              <span key={domain} className="ui-chip tooltip-domain">
                {domain}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Port forwards */}
      {(forwardListeners.length > 0 || forwardEndpoints.length > 0) && (
        <div className="ui-section">
          {forwardListeners.length > 0 && (
            <>
              <div className="ui-section-header">Port-forward listeners</div>
              <div className="flex flex-wrap gap-1 px-3 py-2">
                {forwardListeners.map(key => (
                  <span key={key} className="ui-chip tooltip-forward-key">
                    {key}
                  </span>
                ))}
              </div>
            </>
          )}
          {forwardEndpoints.length > 0 && (
            <>
              <div className="ui-section-header border-t">Port-forward endpoints</div>
              <div className="flex flex-wrap gap-1 px-3 py-2">
                {forwardEndpoints.map(key => (
                  <span key={key} className="ui-chip tooltip-forward-key">
                    {key}
                  </span>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {/* Map icon */}
      <div className="ui-section">
        <div className="ui-section-header">Map icon</div>
        <div className="flex items-center justify-between gap-2 px-3 py-2">
          <span className="flex items-center gap-2">
            {currentIconDef ? (
              <>
                <AgentIcon kind={currentIconDef.key} size={22} />
                <span>{currentIconDef.label}</span>
              </>
            ) : (
              <>
                <span
                  aria-hidden="true"
                  className="border-base-content/40 size-[22px] rounded-full border-2"
                />
                <span className="text-muted">Default circle</span>
              </>
            )}
          </span>
          <span className="flex gap-1">
            <button
              type="button"
              className="btn btn-xs btn-soft"
              onClick={() => setPickerOpen(true)}
            >
              Choose…
            </button>
            <button
              type="button"
              className="btn btn-xs btn-text"
              onClick={() => setIcon('')}
              disabled={!draft.icon}
            >
              Clear
            </button>
          </span>
        </div>
      </div>

      {/* Networks */}
      <div className="ui-section">
        <div className="ui-section-header">Networks</div>
        <div className="space-y-2 px-3 py-2">
          <NetworksField
            value={networksInput}
            onChange={setNetworksInput}
            onCommit={commitNetworks}
            known={networks}
          />
          {networkChips.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {networkChips.map(net => (
                <span key={net} className="badge badge-sm badge-soft badge-primary font-mono">
                  {net}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Notes */}
      <div className="ui-section">
        <div className="ui-section-header">
          <span>Notes</span>
          {status !== 'idle' && (
            <span
              className={status === 'error' ? 'text-error normal-case' : 'text-muted normal-case'}
            >
              {status === 'saving' && 'Saving…'}
              {status === 'saved' && 'Saved'}
              {status === 'error' && 'Save failed'}
            </span>
          )}
        </div>
        <div className="px-3 py-2">
          <textarea
            className="textarea textarea-sm w-full font-mono"
            rows={4}
            value={draft.note}
            onChange={e => setDraft(d => ({ ...d, note: e.target.value }))}
            onBlur={saveNote}
            onKeyDown={e => {
              if ((e.ctrlKey || e.metaKey) && e.key === 's') {
                e.preventDefault();
                saveNote();
              }
            }}
            placeholder="Free-form notes about this agent…"
            spellCheck={false}
            aria-label="Notes"
          />
        </div>
      </div>

      {/* Agent ID */}
      <button
        type="button"
        className="ui-section hover:bg-base-200 w-full px-3 py-2 text-start transition-colors"
        onClick={handleCopy}
        title="Copy agent ID"
      >
        <div className="text-muted text-xs">Agent ID</div>
        <div className="text-primary font-mono break-all">{agent.id || agent.short_id}</div>
        <div className={`text-xs ${copyHint === 'Copied!' ? 'text-success' : 'text-muted'}`}>
          {copyHint}
        </div>
      </button>

      {pickerOpen && (
        <IconPicker current={draft.icon} onPick={setIcon} onClose={() => setPickerOpen(false)} />
      )}
    </div>
  );
}

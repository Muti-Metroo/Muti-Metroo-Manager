import { useState, useEffect, useCallback, useRef, lazy, Suspense } from 'react';
import type {
  TopologyAgentInfo,
  MeshTestResult,
  AgentCapabilities,
  AgentMeta,
} from '../../api/types';
import { isWindowsAgent } from '../../api/types';
import { renameAgent } from '../../api/client';
import type { AgentPanelTab } from '../../router';
import Tabs from '../Tabs';
import InfoTab from './InfoTab';
import RoutesTab from './RoutesTab';
import ForwardsTab from './ForwardsTab';
import ConnectivityTab from './ConnectivityTab';
import FilesTab from './FilesTab';
import PingTab from './PingTab';
import { isModalOpen } from '../../hooks/useModalDismiss';
import type { KnownNetwork } from '../../util/networks';
import Alert from '../Alert';

// Lazy so @xterm (the heaviest dependency) ships in its own chunk and is
// only fetched when an operator actually opens the shell tab.
const ShellTab = lazy(() => import('./ShellTab'));

interface AgentPanelProps {
  agent: TopologyAgentInfo;
  isActive: boolean;
  // The active panel tab is owned by the URL state in App.tsx — all open
  // panels share the same value, so switching agents preserves the tab.
  activeTab: AgentPanelTab;
  onTabChange: (id: AgentPanelTab) => void;
  meshResult: MeshTestResult | undefined;
  capabilities: AgentCapabilities;
  // Whether the locally-connected agent can sign management operations.
  // null while unknown (initial dashboard fetch in flight); false disables
  // every tab that issues signed ops against any target.
  canSignManagement: boolean | null;
  // host:port of the Muti Metroo agent the web UI proxies through; used by
  // "Copy CLI" and the local-agent SOCKS5 display. Already resolved —
  // App substitutes window.location.host when the operator hasn't set
  // an override, so these are never empty.
  apiAddress: string;
  socksAddress: string;
  // Current persisted operator metadata for this agent ({note:'',icon:''} = none).
  meta: AgentMeta;
  // Merge callback into App's metadata map after a successful PUT.
  onMetaChange: (agentId: string, meta: AgentMeta) => void;
  // Networks that already exist anywhere in the mesh (InfoTab typeahead).
  networks: KnownNetwork[];
  allForwardKeys: string[];
  agentsById: Map<string, TopologyAgentInfo>;
  onCapabilityUpdate: (agentId: string, cap: Partial<AgentCapabilities>) => void;
  onMeshChanged: () => void;
  onClose: () => void;
  animate: boolean;
  // Called once the slide-in animation completes so the parent can mark
  // this agent as "already animated" and skip the animation if the panel
  // remounts or its display toggles back on later.
  onAnimated: (shortId: string) => void;
}

export default function AgentPanel({
  agent,
  isActive,
  activeTab,
  onTabChange,
  meshResult,
  capabilities,
  canSignManagement,
  apiAddress,
  socksAddress,
  meta,
  onMetaChange,
  networks,
  allForwardKeys,
  agentsById,
  onCapabilityUpdate,
  onMeshChanged,
  onClose,
  animate,
  onAnimated,
}: AgentPanelProps) {
  // Apply the slide-in class only for the duration of the animation, then
  // strip it. CSS animations replay every time an element transitions from
  // display:none to non-none — leaving the class on means any state churn
  // (selectedAgentId briefly null, openedAgentIds re-deriving) would
  // re-trigger the slide-in. Stripping after one play prevents that.
  const [showSlideIn, setShowSlideIn] = useState(animate);
  useEffect(() => {
    if (!showSlideIn) return;
    const id = window.setTimeout(() => {
      setShowSlideIn(false);
      onAnimated(agent.short_id);
    }, 250);
    return () => window.clearTimeout(id);
  }, [showSlideIn, onAnimated, agent.short_id]);

  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [overrideName, setOverrideName] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Drop optimistic override once poll data catches up
  useEffect(() => {
    if (overrideName !== null && agent.display_name === overrideName) {
      setOverrideName(null);
    }
  }, [agent.display_name, overrideName]);

  function startEditing() {
    const currentName = overrideName ?? agent.display_name ?? agent.short_id;
    setEditValue(currentName);
    setIsEditing(true);
    setRenameError(null);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
  }

  function cancelEditing() {
    setIsEditing(false);
    setEditValue('');
    setRenameError(null);
  }

  async function saveRename() {
    const trimmed = editValue.trim();
    if (!trimmed || saving) return;
    setSaving(true);
    setRenameError(null);
    try {
      await renameAgent(agent.id, agent.is_local, trimmed);
      setOverrideName(trimmed);
      setIsEditing(false);
    } catch (err) {
      setRenameError(err instanceof Error ? err.message : 'Rename failed');
    } finally {
      setSaving(false);
    }
  }

  useEffect(() => {
    if (!isActive) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key !== 'Escape') return;
      if (isModalOpen()) return;
      if (isEditing) {
        cancelEditing();
      } else {
        onClose();
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isActive, isEditing, onClose]);

  const handleCapUpdate = useCallback(
    (cap: Partial<AgentCapabilities>) => {
      onCapabilityUpdate(agent.short_id, cap);
    },
    [agent.short_id, onCapabilityUpdate],
  );

  const cannotSign = canSignManagement === false;
  const shellDisabled = capabilities.shell === false || agent.shell_enabled !== true || cannotSign;
  const filesDisabled =
    capabilities.fileTransfer === false || !agent.file_transfer_enabled || cannotSign;
  // Rename is a display_name.set mutation; requires the same signing capability
  // as routes/peers/forwards. Disabled unchanged when we haven't yet learned
  // the capability (null).

  // fullBleed: the tab paints to the pane edges and supplies its own padding
  // (the terminal, which must not have a gutter around its canvas).
  const tabs: {
    id: AgentPanelTab;
    label: string;
    disabled: boolean;
    fullBleed?: boolean;
  }[] = [
    { id: 'info', label: 'Info', disabled: false },
    { id: 'routes', label: 'Routes', disabled: false },
    { id: 'forwards', label: 'Forwards', disabled: false },
    { id: 'connectivity', label: 'Connectivity', disabled: false },
    { id: 'shell', label: 'Shell', disabled: shellDisabled, fullBleed: true },
    { id: 'files', label: 'Files', disabled: filesDisabled },
    {
      id: 'ping',
      label: 'Ping',
      disabled: capabilities.icmp === false || isWindowsAgent(agent) || agent.icmp_enabled !== true,
    },
  ];

  const fullBleed = tabs.some(t => t.id === activeTab && t.fullBleed);

  // Once the shell tab has been opened it stays mounted (hidden with
  // display:none when another tab is active) so switching panel tabs no
  // longer destroys the terminal session — the same pattern App uses for
  // agent switching. Shell sessions are operator-started, so an unvisited
  // shell tab costs nothing.
  const [shellVisited, setShellVisited] = useState(activeTab === 'shell');
  useEffect(() => {
    if (activeTab === 'shell') setShellVisited(true);
  }, [activeTab]);

  const displayName = overrideName ?? agent.display_name ?? agent.short_id;

  return (
    <aside
      className={`agent-panel${showSlideIn ? ' agent-panel-slide-in' : ''}`}
      style={isActive ? undefined : { display: 'none' }}
    >
      <div className="border-hairline flex flex-none items-center gap-2 border-b px-3 py-2">
        {isEditing ? (
          <div className="flex min-w-0 flex-1 items-center gap-1">
            <input
              ref={inputRef}
              className="input input-sm min-w-0 flex-1"
              value={editValue}
              onChange={e => setEditValue(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') saveRename();
              }}
              disabled={saving}
              aria-label="Agent display name"
            />
            <button
              type="button"
              className="btn btn-sm btn-square btn-primary"
              onClick={saveRename}
              disabled={saving || !editValue.trim()}
              title="Save"
              aria-label="Save name"
            >
              <span
                className={`size-4 ${saving ? 'icon-[tabler--loader-2] animate-spin' : 'icon-[tabler--check]'}`}
                aria-hidden="true"
              />
            </button>
          </div>
        ) : (
          <div className="flex min-w-0 flex-1 items-center gap-1.5">
            <h2 className="truncate text-sm font-semibold">{displayName}</h2>
            {!cannotSign && (
              <button
                type="button"
                className="btn btn-text btn-xs btn-square"
                onClick={startEditing}
                title="Rename"
                aria-label="Rename agent"
              >
                <span className="icon-[tabler--pencil] size-3.5" aria-hidden="true" />
              </button>
            )}
          </div>
        )}
        <button
          type="button"
          className="btn btn-text btn-sm btn-square"
          onClick={onClose}
          aria-label="Close panel"
        >
          <span className="icon-[tabler--x] size-4" aria-hidden="true" />
        </button>
      </div>
      {renameError && (
        <div className="mx-3 mt-2">
          <Alert
            kind="error"
            message={renameError}
            autoCloseMs={0}
            onClose={() => setRenameError(null)}
          />
        </div>
      )}
      <Tabs
        className="border-hairline flex-none border-b px-2"
        tabs={tabs}
        activeId={activeTab}
        onChange={onTabChange}
      />
      <div
        className={`flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain${
          fullBleed ? '' : ' p-3'
        }`}
      >
        {activeTab === 'info' && (
          <InfoTab
            agent={agent}
            meshResult={meshResult}
            canSignManagement={canSignManagement}
            socksAddress={socksAddress}
            meta={meta}
            onMetaChange={onMetaChange}
            networks={networks}
          />
        )}
        {activeTab === 'routes' && (
          <RoutesTab
            agent={agent}
            canSignManagement={canSignManagement}
            onRoutesChanged={onMeshChanged}
          />
        )}
        {activeTab === 'forwards' && (
          <ForwardsTab
            agent={agent}
            canSignManagement={canSignManagement}
            allForwardKeys={allForwardKeys}
            onForwardsChanged={onMeshChanged}
          />
        )}
        {activeTab === 'connectivity' && (
          <ConnectivityTab
            agent={agent}
            canSignManagement={canSignManagement}
            agentsById={agentsById}
            onMeshChanged={onMeshChanged}
          />
        )}
        {shellVisited && (
          // Wrapper carries the shell's full-bleed flex sizing and the
          // display:none hide; ShellTab itself never unmounts on tab switch.
          // isActive is gated on the tab being visible too, so ShellTab's
          // refit effect fires when the operator returns to the tab.
          <div
            className="flex min-h-0 flex-1 flex-col"
            style={activeTab === 'shell' ? undefined : { display: 'none' }}
          >
            <Suspense fallback={<div className="ui-loading p-3">Loading shell…</div>}>
              <ShellTab
                agent={agent}
                isActive={isActive && activeTab === 'shell'}
                disabled={shellDisabled}
                apiAddress={apiAddress}
                onDisabled={() => handleCapUpdate({ shell: false })}
              />
            </Suspense>
          </div>
        )}
        {activeTab === 'files' && (
          <FilesTab
            agent={agent}
            disabled={filesDisabled}
            onDisabled={() => handleCapUpdate({ fileTransfer: false })}
          />
        )}
        {activeTab === 'ping' && (
          <PingTab
            agent={agent}
            isActive={isActive}
            onDisabled={() => handleCapUpdate({ icmp: false })}
          />
        )}
      </div>
    </aside>
  );
}

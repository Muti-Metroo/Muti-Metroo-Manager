import { useState, useEffect, useCallback, useRef } from 'react';
import type { TopologyAgentInfo, MeshTestResult, AgentCapabilities } from '../../api/types';
import { isWindowsAgent } from '../../api/types';
import { renameAgent } from '../../api/client';
import InfoTab from './InfoTab';
import RoutesTab from './RoutesTab';
import ForwardsTab from './ForwardsTab';
import ShellTab from './ShellTab';
import FilesTab from './FilesTab';
import PingTab from './PingTab';

type TabId = 'info' | 'routes' | 'forwards' | 'shell' | 'files' | 'ping';

interface AgentPanelProps {
  agent: TopologyAgentInfo;
  isActive: boolean;
  meshResult: MeshTestResult | undefined;
  capabilities: AgentCapabilities;
  allForwardKeys: string[];
  onCapabilityUpdate: (agentId: string, cap: Partial<AgentCapabilities>) => void;
  onRoutesChanged: () => void;
  onClose: () => void;
  animate: boolean;
}

export default function AgentPanel({ agent, isActive, meshResult, capabilities, allForwardKeys, onCapabilityUpdate, onRoutesChanged, onClose, animate }: AgentPanelProps) {
  const [activeTab, setActiveTab] = useState<TabId>('info');
  const slideIn = useRef(animate);

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

  useEffect(() => {
    if (!renameError) return;
    const t = setTimeout(() => setRenameError(null), 3000);
    return () => clearTimeout(t);
  }, [renameError]);

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

  const tabs: { id: TabId; label: string; disabled: boolean }[] = [
    { id: 'info', label: 'Info', disabled: false },
    { id: 'routes', label: 'Routes', disabled: false },
    { id: 'forwards', label: 'Forwards', disabled: false },
    { id: 'shell', label: 'Shell', disabled: capabilities.shell === false || agent.shell_enabled !== true },
    { id: 'files', label: 'Files', disabled: capabilities.fileTransfer === false || !agent.file_transfer_enabled },
    { id: 'ping', label: 'Ping', disabled: capabilities.icmp === false || isWindowsAgent(agent) || agent.icmp_enabled !== true },
  ];

  const displayName = overrideName ?? agent.display_name ?? agent.short_id;

  return (
    <aside className={`agent-panel${slideIn.current ? ' agent-panel-slide-in' : ''}`} style={isActive ? undefined : { display: 'none' }}>
      <div className="agent-panel-header">
        {isEditing ? (
          <div className="agent-panel-title-row">
            <input
              ref={inputRef}
              className={`agent-panel-rename-input${saving ? ' saving' : ''}`}
              value={editValue}
              onChange={e => setEditValue(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') saveRename(); }}
              disabled={saving}
            />
            <button
              className="agent-panel-rename-save"
              onClick={saveRename}
              disabled={saving || !editValue.trim()}
              title="Save"
            >&#10003;</button>
          </div>
        ) : (
          <div className="agent-panel-title-row">
            <div className="agent-panel-title">{displayName}</div>
            <button className="agent-panel-rename-btn" onClick={startEditing} title="Rename">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/>
              </svg>
            </button>
          </div>
        )}
        <button className="agent-panel-close" onClick={onClose}>&times;</button>
      </div>
      {renameError && (
        <div className="agent-panel-rename-error">{renameError}</div>
      )}
      <div className="agent-panel-tabs">
        {tabs.map(tab => (
          <button
            key={tab.id}
            className={`agent-panel-tab${activeTab === tab.id ? ' active' : ''}${tab.disabled ? ' tab-disabled' : ''}`}
            onClick={() => !tab.disabled && setActiveTab(tab.id)}
            disabled={tab.disabled}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div className="agent-panel-content">
        {activeTab === 'info' && <InfoTab agent={agent} meshResult={meshResult} />}
        {activeTab === 'routes' && <RoutesTab agent={agent} onRoutesChanged={onRoutesChanged} />}
        {activeTab === 'forwards' && <ForwardsTab agent={agent} allForwardKeys={allForwardKeys} onForwardsChanged={onRoutesChanged} />}
        {activeTab === 'shell' && (
          <ShellTab
            agent={agent}
            isActive={isActive}
            disabled={capabilities.shell === false || agent.shell_enabled !== true}
            onDisabled={() => handleCapUpdate({ shell: false })}
          />
        )}
        {activeTab === 'files' && (
          <FilesTab
            agent={agent}
            disabled={capabilities.fileTransfer === false}
            onDisabled={() => handleCapUpdate({ fileTransfer: false })}
          />
        )}
        {activeTab === 'ping' && (
          <PingTab
            agent={agent}
            onDisabled={() => handleCapUpdate({ icmp: false })}
          />
        )}
      </div>
    </aside>
  );
}

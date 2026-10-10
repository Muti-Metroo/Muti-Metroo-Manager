import { useState, useEffect, useCallback, useMemo, useRef, useReducer } from 'react';
import type {
  DashboardResponse,
  TopologyResponse,
  TopologyAgentInfo,
  MeshTestResponse,
  SleepStatusResponse,
  AgentCapabilities,
  AppSettings,
  AgentMeta,
  AgentMetadataMap,
  NetworkNameMap,
  DownloadsManifest,
} from './api/types';
import { EMPTY_AGENT_META } from './api/types';
import {
  getDashboard,
  getTopology,
  getMeshTest,
  getSleepStatus,
  sleepCluster,
  wakeCluster,
  getSettings,
  getServerHealth,
  getAgentMetadata,
  getNetworks,
  putNetwork,
  getDownloadsManifest,
  setToken,
  clearToken,
  getToken,
} from './api/client';
import Header from './components/Header';
import MetroMap from './components/MetroMap/MetroMap';
import ActionsMenu from './components/ActionsMenu';
import RoutesPanel from './components/RoutesPanel';
import ForwardRouteTable from './components/ForwardRouteTable';
import Tabs from './components/Tabs';
import Footer from './components/Footer';
import AgentPanel from './components/AgentPanel/AgentPanel';
import AgentPanelDivider from './components/AgentPanelDivider';
import AgentSearch, { type AgentSearchHandle } from './components/AgentSearch';
import TestResultsModal from './components/TestResultsModal';
import TokenDialog from './components/TokenDialog';
import Alert from './components/Alert';
import SettingsDialog from './components/SettingsDialog';
import { ensureHttpScheme } from './util/url';
import { summarizeMeshHealth, type MeshHealth } from './util/meshHealth';
import { knownNetworks } from './util/networks';
import { useTopologyDiff, type TickerEventKind } from './util/useTopologyDiff';
import { usePanelWidth } from './util/usePanelWidth';
import { playSound, type SoundKind } from './util/sounds';
import ConfigWizard from './components/ConfigWizard/ConfigWizard';
import EntryConfigWizard from './components/EntryConfigWizard/EntryConfigWizard';
import DownloadsTab from './components/DownloadsTab';
import DnsTab from './components/DnsTab';
import { useUrlState, type MajorTab } from './router';
import { isModalOpen } from './hooks/useModalDismiss';

const POLL_INTERVAL = 5000;
const MESH_TEST_INTERVAL = 60000;
const SLEEP_POLL_INTERVAL = 10000;
const DEFAULT_CAPABILITIES: AgentCapabilities = { shell: null, fileTransfer: null, icmp: null };
const EMPTY_AGENTS: TopologyAgentInfo[] = [];

// Mesh health baked into the favicon, so a backgrounded tab still shows it.
// The colours mirror the success/warning/error theme tokens but are literals:
// a favicon is rasterised from this data URI outside the document, where CSS
// variables do not resolve. Built once at module load, there are only four.
const dotFavicon = (fill: string) =>
  'data:image/svg+xml,' +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="6" fill="#1c1815"/><circle cx="16" cy="16" r="6" fill="${fill}"/></svg>`,
  );

const FAVICON_BY_STATUS: Record<MeshHealth['status'], string> = {
  ok: dotFavicon('#6faa72'),
  degraded: dotFavicon('#d9a441'),
  down: dotFavicon('#d97066'),
  idle: dotFavicon('#9d968c'),
};

const MAIN_TABS: { id: MajorTab; label: string }[] = [
  { id: 'topology', label: 'Topology' },
  { id: 'routes', label: 'Routes' },
  { id: 'forwards', label: 'Port Forwarding' },
  { id: 'dns', label: 'DNS' },
  { id: 'downloads', label: 'Downloads' },
];

export default function App() {
  const [dashboard, setDashboard] = useState<DashboardResponse | null>(null);
  const [topology, setTopology] = useState<TopologyResponse | null>(null);
  const [meshTest, setMeshTest] = useState<MeshTestResponse | null>(null);
  const [meshTestAt, setMeshTestAt] = useState<Date | null>(null);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
  const [polling, setPolling] = useState(false);
  const [highlightedPath, setHighlightedPath] = useState<string[]>([]);
  const [testRunning, setTestRunning] = useState(false);
  const [testModal, setTestModal] = useState<{
    type: 'success' | 'error';
    data?: MeshTestResponse;
    error?: string;
  } | null>(null);
  const [authRequired, setAuthRequired] = useState(false);
  const [configWizardOpen, setConfigWizardOpen] = useState(false);
  const [entryWizardOpen, setEntryWizardOpen] = useState(false);

  // URL-driven UI state: major tab, sub-tab, selected agent, agent panel tab.
  // The router owns parsing/serialisation; this component drives state via
  // its setters and reads the parsed values like any other props.
  const {
    majorTab,
    subTab,
    agentId: urlAgentId,
    agentPanel,
    setMajorTab,
    setSubTab,
    setAgent,
    setAgentPanel,
  } = useUrlState();

  // Cached set of agents whose panels are currently mounted (active or
  // hidden). Driven by URL state but kept across navigation so panel state
  // (terminal buffer, file listing, etc.) survives switching agents.
  const [openedAgentIds, setOpenedAgentIds] = useState<Set<string>>(new Set());
  const searchRef = useRef<AgentSearchHandle>(null);
  const [sleepStatus, setSleepStatus] = useState<SleepStatusResponse | null>(null);
  const [sleepLoading, setSleepLoading] = useState(false);
  const [sleepError, setSleepError] = useState<string | null>(null);
  const [settings, setSettings] = useState<AppSettings>({
    api_address: '',
    socks_address: '',
    sounds_enabled: true,
  });
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Null = no bundle deployed (or not yet checked) → Downloads tab hidden.
  const [downloadsManifest, setDownloadsManifest] = useState<DownloadsManifest | null>(null);
  const [agentMeta, setAgentMeta] = useState<AgentMetadataMap>({});
  // Network display-name overrides ({id: name}); only renamed networks appear.
  // Membership itself rides on agentMeta.networks.
  const [networkNames, setNetworkNames] = useState<NetworkNameMap>({});
  const capabilityCacheRef = useRef<Map<string, AgentCapabilities>>(new Map());
  const [, bumpCapCache] = useReducer((n: number) => n + 1, 0);
  // Tracks which agent panels have already played their slide-in animation
  // so a brief unmount/remount or display:none→block toggle (e.g. caused by
  // a poll round-trip transiently dropping the agent from topology) doesn't
  // replay the animation. Cleared when the user actually closes the panel.
  const animatedAgentIdsRef = useRef<Set<string>>(new Set());
  const handleAgentAnimated = useCallback((shortId: string) => {
    animatedAgentIdsRef.current.add(shortId);
  }, []);

  const refresh = useCallback(async () => {
    setPolling(true);
    try {
      const [dash, topo] = await Promise.all([getDashboard(), getTopology()]);
      setDashboard(dash);
      setTopology(topo);
      setLastUpdate(new Date());
    } catch (err) {
      console.error('Failed to refresh dashboard:', err);
    } finally {
      setPolling(false);
    }
  }, []);

  const runMeshTest = useCallback(async () => {
    try {
      const results = await getMeshTest(false);
      setMeshTest(results);
      setMeshTestAt(new Date());
    } catch (err) {
      console.error('Failed to run mesh test:', err);
    }
  }, []);

  const refreshSleepStatus = useCallback(async () => {
    try {
      const status = await getSleepStatus();
      setSleepStatus(status);
    } catch {
      // Sleep endpoint may not exist - that's fine
    }
  }, []);

  // Initial load + polling
  useEffect(() => {
    refresh();
    const id = setInterval(refresh, POLL_INTERVAL);
    return () => clearInterval(id);
  }, [refresh]);

  // Settings are operator-set overrides for the advertised API / SOCKS
  // addresses. Fetched once on mount; the settings dialog refreshes this
  // state on save. Empty strings mean "use window.location.host".
  useEffect(() => {
    getSettings()
      .then(setSettings)
      .catch(() => {
        /* older server without this endpoint; falls back to defaults */
      });
  }, []);

  // Muti Metroo Manager's own binary version (the app serving this UI), shown in the
  // footer so operators can tell whether a deployment actually updated.
  const [appVersion, setAppVersion] = useState<string | null>(null);
  useEffect(() => {
    getServerHealth()
      .then(h => setAppVersion(h.version))
      .catch(() => {
        /* best-effort; footer just omits the version */
      });
  }, []);

  // Per-agent operator metadata (notes + icon), fetched once on mount.
  // InfoTab merges in updates as they're saved; no need to re-poll.
  useEffect(() => {
    getAgentMetadata()
      .then(setAgentMeta)
      .catch(() => {
        /* older server without this endpoint */
      });
  }, []);

  // Network display-name overrides, fetched once on mount. The box label
  // editor merges renames in as they're saved.
  useEffect(() => {
    getNetworks()
      .then(setNetworkNames)
      .catch(() => {
        /* older server without this endpoint */
      });
  }, []);

  // Rename a network box. The server returns the effective name (equal to
  // the identifier when the override was cleared) so we know whether to keep
  // or drop the override.
  const handleNetworkRename = useCallback((id: string, name: string) => {
    putNetwork(id, name)
      .then(({ name: effective }) => {
        setNetworkNames(prev => {
          if (effective === id) {
            if (!(id in prev)) return prev;
            const next = { ...prev };
            delete next[id];
            return next;
          }
          if (prev[id] === effective) return prev;
          return { ...prev, [id]: effective };
        });
      })
      .catch(() => {
        /* best-effort; the label keeps its previous value */
      });
  }, []);

  // Downloads bundle manifest. null when no bundle is deployed (server
  // returns 404 → the Downloads tab stays hidden). Fetched once on mount;
  // the bundle is mounted at server start and won't change at runtime.
  // `downloadsFetched` flips once the request settles so we can safely
  // redirect away from a /downloads URL when no bundle exists.
  const [downloadsFetched, setDownloadsFetched] = useState(false);
  useEffect(() => {
    getDownloadsManifest()
      .then(setDownloadsManifest)
      .catch(() => {
        /* older server without this endpoint */
      })
      .finally(() => setDownloadsFetched(true));
  }, []);

  const handleMetaChange = useCallback((agentId: string, meta: AgentMeta) => {
    setAgentMeta(prev => {
      const isEmpty = !meta.note && !meta.icon && !meta.networks;
      if (isEmpty) {
        if (!(agentId in prev)) return prev;
        const next = { ...prev };
        delete next[agentId];
        return next;
      }
      const existing = prev[agentId];
      if (
        existing &&
        existing.note === meta.note &&
        existing.icon === meta.icon &&
        existing.networks === meta.networks
      )
        return prev;
      return { ...prev, [agentId]: meta };
    });
  }, []);

  // Default API address mirrors the page's scheme so a user on an HTTPS
  // deployment doesn't get a CLI command that silently downgrades to
  // plain http. SOCKS5 is not an HTTP protocol, so its default stays
  // bare host:port regardless of page scheme.
  const defaultApiAddress = `${window.location.protocol}//${window.location.host}`;
  const defaultSocksAddress = window.location.host;
  const resolvedApi =
    ensureHttpScheme(settings.api_address, window.location.protocol) || defaultApiAddress;
  const resolvedSocks = settings.socks_address || defaultSocksAddress;

  // Mesh test polling
  useEffect(() => {
    runMeshTest();
    const id = setInterval(runMeshTest, MESH_TEST_INTERVAL);
    return () => clearInterval(id);
  }, [runMeshTest]);

  // Auto-clear the global sleep error banner after a few seconds; the
  // user can still dismiss earlier with the X. Matches the auto-close
  // behaviour used by tab-level alerts (Alert.tsx).
  useEffect(() => {
    if (!sleepError) return;
    const id = window.setTimeout(() => setSleepError(null), 8000);
    return () => window.clearTimeout(id);
  }, [sleepError]);

  // Sleep status polling
  useEffect(() => {
    refreshSleepStatus();
    const id = setInterval(refreshSleepStatus, SLEEP_POLL_INTERVAL);
    return () => clearInterval(id);
  }, [refreshSleepStatus]);

  // Listen for auth-required events from API client
  useEffect(() => {
    const handler = () => setAuthRequired(true);
    window.addEventListener('auth-required', handler);
    return () => window.removeEventListener('auth-required', handler);
  }, []);

  const handleTokenSubmit = useCallback(
    async (token: string, persist: 'session' | 'long' = 'session'): Promise<void> => {
      let authFailed = false;
      try {
        const resp = await fetch('/api/proxy/api/dashboard', {
          headers: { Authorization: `Bearer ${token}` },
        });
        authFailed = resp.status === 401;
      } catch {
        // Network error — can't validate, assume token is OK
      }
      if (authFailed) throw new Error('Invalid token');
      setToken(token, persist);
      setAuthRequired(false);
      refresh();
    },
    [refresh],
  );

  const handleSignOut = useCallback(() => {
    clearToken();
    setAuthRequired(true);
  }, []);

  const handleHighlight = useCallback((pathIds: string[]) => {
    setHighlightedPath(pathIds);
  }, []);

  const handleClearHighlight = useCallback(() => {
    setHighlightedPath([]);
  }, []);

  // Resolve the URL's agent id (which may be short or full) against the
  // current topology. selectedAgentId is the canonical short_id or null
  // while loading / when the agent is offline.
  const selectedAgentId = useMemo<string | null>(() => {
    if (!urlAgentId || !topology) return null;
    const lower = urlAgentId.toLowerCase();
    const hit = topology.agents.find(
      a => a.short_id.toLowerCase() === lower || a.id.toLowerCase() === lower,
    );
    return hit ? hit.short_id : null;
  }, [urlAgentId, topology]);

  const { width: panelWidth, setWidth: setPanelWidth, commit: commitPanelWidth } = usePanelWidth();

  const soundsActive = settings.sounds_enabled && !settings.sounds_locked;
  const playCue = useCallback(
    (kind: SoundKind) => {
      if (!soundsActive) return;
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
      playSound(kind);
    },
    [soundsActive],
  );

  const handleStationClick = useCallback(
    (agentId: string) => {
      playCue('click');
      if (selectedAgentId === agentId) setAgent(null);
      else setAgent(agentId);
    },
    [selectedAgentId, setAgent, playCue],
  );

  const handleClosePanel = useCallback(
    (agentId: string) => {
      animatedAgentIdsRef.current.delete(agentId);
      setOpenedAgentIds(prev => {
        if (!prev.has(agentId)) return prev;
        const next = new Set(prev);
        next.delete(agentId);
        return next;
      });
      if (selectedAgentId === agentId) setAgent(null);
    },
    [selectedAgentId, setAgent],
  );

  const handleSleep = useCallback(async () => {
    setSleepLoading(true);
    setSleepError(null);
    try {
      await sleepCluster();
      refreshSleepStatus();
    } catch (err) {
      setSleepError(err instanceof Error ? err.message : 'Failed to put mesh to sleep');
    } finally {
      setSleepLoading(false);
    }
  }, [refreshSleepStatus]);

  const handleWake = useCallback(async () => {
    setSleepLoading(true);
    setSleepError(null);
    try {
      await wakeCluster();
      refreshSleepStatus();
    } catch (err) {
      setSleepError(err instanceof Error ? err.message : 'Failed to wake mesh');
    } finally {
      setSleepLoading(false);
    }
  }, [refreshSleepStatus]);

  const handleRunTest = useCallback(async () => {
    setTestRunning(true);
    setTestModal(null);
    try {
      const results = await getMeshTest(true);
      setMeshTest(results);
      setMeshTestAt(new Date());
      setTestModal({ type: 'success', data: results });
    } catch (err) {
      setTestModal({
        type: 'error',
        error: err instanceof Error ? err.message : 'Mesh test failed',
      });
    } finally {
      setTestRunning(false);
    }
  }, []);

  const handleCloseConfigWizard = useCallback(() => setConfigWizardOpen(false), []);
  const handleCloseEntryWizard = useCallback(() => setEntryWizardOpen(false), []);
  const handleOpenConfigWizard = useCallback(() => setConfigWizardOpen(true), []);
  const handleOpenEntryWizard = useCallback(() => setEntryWizardOpen(true), []);

  const handleTabChange = useCallback(
    (id: string) => {
      setMajorTab(id as MajorTab);
    },
    [setMajorTab],
  );

  const handleCapabilityUpdate = useCallback((agentId: string, cap: Partial<AgentCapabilities>) => {
    const existing = capabilityCacheRef.current.get(agentId) || DEFAULT_CAPABILITIES;
    capabilityCacheRef.current.set(agentId, { ...existing, ...cap });
    bumpCapCache();
  }, []);

  const allForwardKeys = useMemo(() => {
    if (!topology) return [];
    const keys = new Set(
      topology.agents.flatMap(a => [
        ...(a.forward_listeners || []),
        ...(a.forward_endpoints || []),
      ]),
    );
    return Array.from(keys).sort();
  }, [topology]);

  const agentsById = useMemo(() => {
    const m = new Map<string, TopologyAgentInfo>();
    if (topology) for (const a of topology.agents) m.set(a.id, a);
    return m;
  }, [topology]);

  // Add the resolved agent to the cached set so its panel mounts.
  useEffect(() => {
    if (!selectedAgentId) return;
    setOpenedAgentIds(prev => {
      if (prev.has(selectedAgentId)) return prev;
      const next = new Set(prev);
      next.add(selectedAgentId);
      return next;
    });
  }, [selectedAgentId]);

  // Once topology resolves a non-canonical id (full id pasted into the
  // URL), rewrite the slug to short_id without polluting history.
  useEffect(() => {
    if (selectedAgentId && urlAgentId && urlAgentId !== selectedAgentId) {
      setAgent(selectedAgentId, { replace: true });
    }
  }, [selectedAgentId, urlAgentId, setAgent]);

  // Global hotkeys: `/` focuses the search, `Esc` closes the active panel.
  // Bail out when focus is in a form field or inside a terminal — we must
  // not steal keystrokes from the xterm shell. The search box only mounts
  // on the topology tab, so `/` switches tabs first when needed and defers
  // focus a frame to let the input render.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      const inEditable = target
        ? target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable ||
          target.closest('.xterm') != null
        : false;

      if (e.key === '/' && !inEditable) {
        e.preventDefault();
        if (majorTab !== 'topology') setMajorTab('topology');
        requestAnimationFrame(() => searchRef.current?.focus());
      } else if (e.key === 'Escape' && !inEditable && !isModalOpen()) {
        if (selectedAgentId) {
          e.preventDefault();
          setAgent(null);
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [selectedAgentId, majorTab, setMajorTab, setAgent]);

  // Drop opened agents that disappeared from topology, and clear the URL
  // agent slug if it no longer exists in the mesh (offline or stale URL).
  useEffect(() => {
    if (!topology) return;
    const liveIds = new Set(topology.agents.map(a => a.short_id));
    setOpenedAgentIds(prev => {
      const next = new Set([...prev].filter(id => liveIds.has(id)));
      return next.size === prev.size ? prev : next;
    });
    if (urlAgentId) {
      const lower = urlAgentId.toLowerCase();
      const stillThere = topology.agents.some(
        a => a.short_id.toLowerCase() === lower || a.id.toLowerCase() === lower,
      );
      if (!stillThere) setAgent(null, { replace: true });
    }
  }, [topology, urlAgentId, setAgent]);

  // Resolve opened agents from topology
  const openedAgents = useMemo(() => {
    if (!topology) return [];
    return topology.agents.filter(a => openedAgentIds.has(a.short_id));
  }, [topology, openedAgentIds]);

  // Hide the Downloads tab when no bundle is mounted on the server.
  const visibleTabs = useMemo(
    () => (downloadsManifest ? MAIN_TABS : MAIN_TABS.filter(t => t.id !== 'downloads')),
    [downloadsManifest],
  );

  const meshHealth = useMemo(() => summarizeMeshHealth(topology, meshTest), [topology, meshTest]);

  const { events: topologyEvents, newConnectionKeys } = useTopologyDiff(topology, meshTest);

  const lastEventIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (topologyEvents.length === 0) return;
    const latest = topologyEvents[topologyEvents.length - 1];
    if (latest.id === lastEventIdRef.current) return;
    const seen = lastEventIdRef.current;
    lastEventIdRef.current = latest.id;
    if (seen === null) return;
    const cueByKind: Partial<Record<TickerEventKind, SoundKind>> = {
      'peer-joined': 'chord',
      'peer-left': 'descend',
      'connection-down': 'descend',
      'mesh-test-degraded': 'alert',
      'mesh-test-recovered': 'chord',
    };
    const cue = cueByKind[latest.kind];
    if (cue) playCue(cue);
  }, [topologyEvents, playCue]);

  useEffect(() => {
    const link = document.querySelector<HTMLLinkElement>('link[rel="icon"][type="image/svg+xml"]');
    if (link) link.href = FAVICON_BY_STATUS[meshHealth.status];
  }, [meshHealth.status]);

  useEffect(() => {
    const { peerCount, unreachable } = meshHealth;
    if (peerCount === 0) {
      document.title = 'Muti Metroo Manager';
      return;
    }
    const peers = `${peerCount} peer${peerCount === 1 ? '' : 's'}`;
    const degraded = unreachable > 0 ? ` · ${unreachable} degraded` : '';
    document.title = `Muti Metroo · ${peers}${degraded}`;
  }, [meshHealth.peerCount, meshHealth.unreachable]);

  // Redirect away from /downloads via replaceState once we know the
  // bundle isn't deployed (so the user can't land on a tab that doesn't
  // render anything, and back-button doesn't trap them in a redirect loop).
  useEffect(() => {
    if (downloadsFetched && !downloadsManifest && majorTab === 'downloads') {
      setMajorTab('topology', { replace: true });
    }
  }, [downloadsFetched, downloadsManifest, majorTab, setMajorTab]);

  // Every network the mesh already knows about, for the InfoTab typeahead.
  // Derived from membership across all agents plus any network that only
  // exists because it was given a title.
  const networks = useMemo(() => knownNetworks(agentMeta, networkNames), [agentMeta, networkNames]);

  // Render-time fallback for the brief window before the redirect fires
  // (or when the manifest fetch is still in flight).
  const visibleActiveTab: MajorTab =
    majorTab === 'downloads' && !downloadsManifest ? 'topology' : majorTab;

  return (
    <div className="app-shell">
      {authRequired && <TokenDialog onSubmit={handleTokenSubmit} />}
      <Header agent={dashboard?.agent ?? null} />
      {sleepError && (
        <div className="mx-4 mt-2">
          <Alert
            kind="error"
            message={sleepError}
            autoCloseMs={0}
            onClose={() => setSleepError(null)}
          />
        </div>
      )}
      {sleepStatus?.state === 'SLEEPING' && !sleepLoading && (
        <div
          role="status"
          className="alert alert-warning alert-soft mx-4 mt-2 flex items-center gap-2"
        >
          <span className="icon-[tabler--zzz] size-4 shrink-0" aria-hidden="true" />
          <span>Mesh is sleeping, peer connections and tunnels are suspended</span>
        </div>
      )}
      {testModal && (
        <TestResultsModal
          type={testModal.type}
          data={testModal.data}
          error={testModal.error}
          onClose={() => setTestModal(null)}
        />
      )}
      {configWizardOpen && topology?.local_agent && (
        <ConfigWizard
          localAgent={topology.local_agent}
          agents={topology.agents}
          connections={topology.connections}
          onClose={handleCloseConfigWizard}
        />
      )}
      {entryWizardOpen && (
        <EntryConfigWizard
          agents={topology?.agents ?? EMPTY_AGENTS}
          socksAddress={resolvedSocks}
          onClose={handleCloseEntryWizard}
        />
      )}
      {settingsOpen && (
        <SettingsDialog
          initial={settings}
          defaults={{ apiAddress: defaultApiAddress, socksAddress: defaultSocksAddress }}
          onSave={setSettings}
          onClose={() => setSettingsOpen(false)}
        />
      )}
      <main className={`app-main${selectedAgentId ? ' panel-open' : ''}`}>
        <Tabs
          className="border-hairline border-b"
          tabs={visibleTabs}
          activeId={visibleActiveTab}
          onChange={handleTabChange}
          rightSlot={
            <ActionsMenu
              sleepStatus={sleepStatus}
              sleepLoading={sleepLoading}
              testing={testRunning}
              onSleep={handleSleep}
              onWake={handleWake}
              onRunTest={handleRunTest}
              onOpenAgentWizard={handleOpenConfigWizard}
              onOpenEntryWizard={handleOpenEntryWizard}
              onOpenSettings={() => setSettingsOpen(true)}
              onSignOut={getToken() ? handleSignOut : null}
            />
          }
        />
        {visibleActiveTab === 'topology' && (
          <MetroMap
            agents={topology?.agents ?? []}
            connections={topology?.connections ?? []}
            meshTestResults={meshTest}
            highlightedPath={highlightedPath}
            selectedAgentId={selectedAgentId}
            socksAddress={resolvedSocks}
            agentMeta={agentMeta}
            networkNames={networkNames}
            onNetworkRename={handleNetworkRename}
            newConnectionKeys={newConnectionKeys}
            onStationClick={handleStationClick}
            onOpenAgentWizard={topology?.local_agent ? handleOpenConfigWizard : undefined}
            onOpenEntryWizard={handleOpenEntryWizard}
            searchSlot={
              <AgentSearch
                ref={searchRef}
                agents={topology?.agents ?? EMPTY_AGENTS}
                agentMeta={agentMeta}
                onSelect={id => setAgent(id)}
              />
            }
          />
        )}
        {visibleActiveTab === 'routes' && (
          <RoutesPanel
            routes={dashboard?.routes ?? null}
            subTab={subTab === 'test' ? 'test' : 'active'}
            onSubTabChange={id => setSubTab(id)}
            onHighlight={handleHighlight}
            onClearHighlight={handleClearHighlight}
            onSelectAgent={id => setAgent(id, { panel: 'routes' })}
          />
        )}
        {visibleActiveTab === 'forwards' && (
          <ForwardRouteTable
            routes={dashboard?.forward_routes ?? null}
            agents={topology?.agents ?? EMPTY_AGENTS}
            onHighlight={handleHighlight}
            onClearHighlight={handleClearHighlight}
          />
        )}
        {visibleActiveTab === 'dns' && (
          <DnsTab
            subTab={subTab === 'tlds' ? 'tlds' : 'hosts'}
            onSubTabChange={id => setSubTab(id)}
            canSignManagement={dashboard?.stats?.can_sign_management ?? null}
          />
        )}
        {visibleActiveTab === 'downloads' && downloadsManifest && (
          <DownloadsTab
            manifest={downloadsManifest}
            onCreateConfig={cat => {
              if (cat === 'agent') handleOpenConfigWizard();
              else if (cat === 'entry') handleOpenEntryWizard();
            }}
          />
        )}
      </main>
      <Footer
        lastUpdate={lastUpdate}
        meshHealth={meshHealth}
        meshTestAt={meshTestAt}
        polling={polling}
        events={topologyEvents}
        appVersion={appVersion}
      />

      {openedAgents.map(agent => (
        <AgentPanel
          key={agent.short_id}
          agent={agent}
          isActive={selectedAgentId === agent.short_id}
          activeTab={agentPanel ?? 'info'}
          onTabChange={setAgentPanel}
          meshResult={meshTest?.results?.find(r => r.short_id === agent.short_id)}
          capabilities={capabilityCacheRef.current.get(agent.short_id) || DEFAULT_CAPABILITIES}
          canSignManagement={dashboard?.stats?.can_sign_management ?? null}
          apiAddress={resolvedApi}
          socksAddress={resolvedSocks}
          meta={agentMeta[agent.id] ?? EMPTY_AGENT_META}
          onMetaChange={handleMetaChange}
          networks={networks}
          allForwardKeys={allForwardKeys}
          agentsById={agentsById}
          onCapabilityUpdate={handleCapabilityUpdate}
          onMeshChanged={refresh}
          onClose={() => handleClosePanel(agent.short_id)}
          animate={openedAgents.length <= 1 && !animatedAgentIdsRef.current.has(agent.short_id)}
          onAnimated={handleAgentAnimated}
        />
      ))}

      {selectedAgentId && openedAgents.length > 0 && (
        <AgentPanelDivider
          width={panelWidth}
          onResize={setPanelWidth}
          onCommit={commitPanelWidth}
        />
      )}
    </div>
  );
}

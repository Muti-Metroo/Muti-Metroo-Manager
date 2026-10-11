import { useCallback, useEffect, useRef, useState } from 'react';

export type MajorTab = 'topology' | 'routes' | 'forwards' | 'dns' | 'downloads';
export type AgentPanelTab =
  'info' | 'routes' | 'forwards' | 'connectivity' | 'shell' | 'files' | 'ping';

const MAJOR_TABS: readonly MajorTab[] = ['topology', 'routes', 'forwards', 'dns', 'downloads'];
const AGENT_PANEL_TABS: readonly AgentPanelTab[] = [
  'info',
  'routes',
  'forwards',
  'connectivity',
  'shell',
  'files',
  'ping',
];

// Sub-tabs allowed under each major tab; empty means the second path
// segment is ignored. DEFAULT_SUB_TAB is what we land on when no segment
// is given (or the given one isn't allowed).
const SUB_TABS: Record<MajorTab, readonly string[]> = {
  topology: [],
  routes: ['active', 'test'],
  forwards: [],
  dns: ['hosts', 'tlds'],
  downloads: [],
};

const DEFAULT_SUB_TAB: Record<MajorTab, string | null> = {
  topology: null,
  routes: 'active',
  forwards: null,
  dns: 'hosts',
  downloads: null,
};

const DEFAULT_MAJOR: MajorTab = 'topology';

interface UrlState {
  majorTab: MajorTab;
  subTab: string | null;
  agentId: string | null;
  agentPanel: AgentPanelTab | null;
}

function isMajorTab(s: string): s is MajorTab {
  return (MAJOR_TABS as readonly string[]).includes(s);
}

function isAgentPanelTab(s: string): s is AgentPanelTab {
  return (AGENT_PANEL_TABS as readonly string[]).includes(s);
}

function parseUrl(loc: { pathname: string; search: string }): UrlState {
  const segs = loc.pathname.split('/').filter(Boolean);
  const major: MajorTab = segs.length > 0 && isMajorTab(segs[0]) ? segs[0] : DEFAULT_MAJOR;
  const allowed = SUB_TABS[major];
  const sub = segs.length >= 2 && allowed.includes(segs[1]) ? segs[1] : DEFAULT_SUB_TAB[major];

  const params = new URLSearchParams(loc.search);
  const rawAgent = params.get('agent');
  const rawPanel = params.get('panel');
  const agentId = rawAgent && /^[0-9a-f]+$/i.test(rawAgent) ? rawAgent.toLowerCase() : null;
  const agentPanel = agentId && rawPanel && isAgentPanelTab(rawPanel) ? rawPanel : null;

  return { majorTab: major, subTab: sub, agentId, agentPanel };
}

function buildUrl(state: UrlState): string {
  let path = '/' + state.majorTab;
  if (state.subTab) path += '/' + state.subTab;
  const params = new URLSearchParams();
  if (state.agentId) {
    params.set('agent', state.agentId);
    if (state.agentPanel) params.set('panel', state.agentPanel);
  }
  const q = params.toString();
  return path + (q ? '?' + q : '');
}

// Reads the URL on first paint, migrates legacy `#/agents/<id>` into the
// `?agent=` query param, and replaceStates to a canonical URL so e.g.
// "/" lands on "/topology" without creating a back-button entry.
function readInitialState(): UrlState {
  const legacy = window.location.hash.match(/^#\/agents\/([0-9a-fA-F]+)$/);
  let parsed = parseUrl(window.location);
  if (legacy) parsed = { ...parsed, agentId: legacy[1].toLowerCase() };

  const target = buildUrl(parsed);
  const current = window.location.pathname + window.location.search + window.location.hash;
  if (target !== current) {
    window.history.replaceState(null, '', target);
  }
  return parsed;
}

interface CommitOpts {
  // Defaults to false (pushState). Pass true for non-navigational
  // updates: canonicalising a slug, redirecting away from a now-hidden
  // tab, or clearing an agent that went offline.
  replace?: boolean;
}

interface SetAgentOpts extends CommitOpts {
  panel?: AgentPanelTab;
}

export interface UseUrlState extends UrlState {
  setMajorTab: (id: MajorTab, opts?: CommitOpts) => void;
  setSubTab: (id: string | null, opts?: CommitOpts) => void;
  // Open (id !== null) or close (id === null) the agent panel. Without
  // `panel`, keeps the current panel value or defaults to `info`.
  setAgent: (agentId: string | null, opts?: SetAgentOpts) => void;
  // Always replaceState — switching the agent-panel tab is a UI toggle,
  // not navigation.
  setAgentPanel: (panel: AgentPanelTab) => void;
}

export function useUrlState(): UseUrlState {
  const [state, setState] = useState<UrlState>(readInitialState);

  // Mirror state into a ref so the setters keep stable identities.
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    const handler = () => setState(parseUrl(window.location));
    window.addEventListener('popstate', handler);
    return () => window.removeEventListener('popstate', handler);
  }, []);

  const commit = useCallback((next: UrlState, replace: boolean) => {
    const target = buildUrl(next);
    const current = window.location.pathname + window.location.search;
    if (target !== current) {
      if (replace) window.history.replaceState(null, '', target);
      else window.history.pushState(null, '', target);
    }
    setState(next);
  }, []);

  const setMajorTab = useCallback(
    (id: MajorTab, opts?: CommitOpts) => {
      const prev = stateRef.current;
      if (prev.majorTab === id) return;
      commit(
        {
          majorTab: id,
          subTab: DEFAULT_SUB_TAB[id],
          agentId: prev.agentId,
          agentPanel: prev.agentPanel,
        },
        opts?.replace ?? false,
      );
    },
    [commit],
  );

  const setSubTab = useCallback(
    (id: string | null, opts?: CommitOpts) => {
      const prev = stateRef.current;
      if (prev.subTab === id) return;
      commit({ ...prev, subTab: id }, opts?.replace ?? false);
    },
    [commit],
  );

  const setAgent = useCallback(
    (agentId: string | null, opts?: SetAgentOpts) => {
      const prev = stateRef.current;
      const nextId = agentId ? agentId.toLowerCase() : null;
      const nextPanel: AgentPanelTab | null = nextId
        ? (opts?.panel ?? prev.agentPanel ?? 'info')
        : null;
      if (prev.agentId === nextId && prev.agentPanel === nextPanel) return;
      commit({ ...prev, agentId: nextId, agentPanel: nextPanel }, opts?.replace ?? false);
    },
    [commit],
  );

  const setAgentPanel = useCallback(
    (panel: AgentPanelTab) => {
      const prev = stateRef.current;
      if (!prev.agentId || prev.agentPanel === panel) return;
      commit({ ...prev, agentPanel: panel }, true);
    },
    [commit],
  );

  return { ...state, setMajorTab, setSubTab, setAgent, setAgentPanel };
}

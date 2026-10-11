import type {
  DashboardResponse,
  TopologyResponse,
  MeshTestResponse,
  SleepStatusResponse,
  RouteManageRequest,
  RouteManageResponse,
  InterfacesResponse,
  ForwardManageRequest,
  ForwardManageResponse,
  ForwardEndpointManageRequest,
  ForwardEndpointManageResponse,
  PeerManageRequest,
  PeerManageResponse,
  ListenerManageRequest,
  ListenerManageResponse,
  MeshHostManageRequest,
  MeshHostManageResponse,
  MeshHostSuffixManageRequest,
  MeshHostSuffixManageResponse,
  ProbeRequest,
  ProbeResponse,
  RouteTraceResult,
  FileBrowseEntry,
  FileBrowseListResponse,
  FileBrowseRootsResponse,
  SetupDefaultsResponse,
  HealthResponse,
  ServerHealth,
  AppSettings,
  AgentMeta,
  AgentMetadataMap,
  NetworkNameMap,
  PositionMap,
  DownloadsManifest,
} from './types';

const BASE = '';

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

// True when a proxied agent call failed because the manager couldn't
// reach the target agent at all (502 from the proxy, or the agent's
// "no route to agent" relay error) — the tabs render a dedicated
// unreachable banner for this instead of a generic error.
export function isUnreachableError(err: unknown): boolean {
  const msg = (err as { message?: string })?.message || '';
  return (err instanceof ApiError && err.status === 502) || msg.includes('no route to agent');
}

// --- Token management ---
//
// Two persistence levels are supported. The default ('session') keeps
// the token in sessionStorage so it survives F5 but is lost when the
// tab closes — the safest default for a shared workstation. The
// 'long' option stores `{token, expires_at}` in localStorage with a
// fixed TTL so an operator on a long shift doesn't have to re-paste
// the token after each refresh.
//
// On read we prefer the session copy when both exist (the operator
// having explicitly typed the token in this tab takes priority over
// whatever was previously remembered). Expired long-storage entries
// are deleted lazily on access.
const TOKEN_KEY = 'muti-metroo-token';
const TOKEN_LONG_KEY = 'muti-metroo-token-long';
const LONG_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours

export type TokenPersist = 'session' | 'long';

interface LongRecord {
  token: string;
  expires_at: number;
}

export function getToken(): string | null {
  const session = sessionStorage.getItem(TOKEN_KEY);
  if (session) return session;
  const raw = localStorage.getItem(TOKEN_LONG_KEY);
  if (!raw) return null;
  try {
    const rec = JSON.parse(raw) as Partial<LongRecord>;
    if (
      typeof rec?.token === 'string' &&
      typeof rec.expires_at === 'number' &&
      rec.expires_at > Date.now()
    ) {
      return rec.token;
    }
  } catch {
    /* fall through to cleanup */
  }
  localStorage.removeItem(TOKEN_LONG_KEY);
  return null;
}

export function setToken(token: string, persist: TokenPersist = 'session'): void {
  sessionStorage.setItem(TOKEN_KEY, token);
  if (persist === 'long') {
    const rec: LongRecord = { token, expires_at: Date.now() + LONG_TTL_MS };
    localStorage.setItem(TOKEN_LONG_KEY, JSON.stringify(rec));
  } else {
    // Switching back to session-only must drop any prior long copy so
    // a forgotten "remember 8h" on a previous run can't resurrect.
    localStorage.removeItem(TOKEN_LONG_KEY);
  }
}

export function clearToken(): void {
  sessionStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(TOKEN_LONG_KEY);
}

function authHeaders(): Record<string, string> {
  const t = getToken();
  return t ? { Authorization: `Bearer ${t}` } : {};
}

// --- Manager authentication ---
//
// The manager itself can require an access token for all /api/* routes
// (configured server-side via -auth-token-file / METROO_MANAGER_AUTH_TOKEN).
// Browser clients authenticate once via POST /api/auth/login, which sets an
// HttpOnly session cookie that same-origin fetch() and WebSocket upgrades
// then carry automatically — the token is never readable from JS.
//
// The manager marks its own 401s with `WWW-Authenticate: Bearer
// realm="muti-metroo-manager"` so they can be told apart from a 401 relayed
// from the agent through /api/proxy (which concerns the agent token above).
const MANAGER_AUTH_REALM = 'muti-metroo-manager';

function isManagerAuthResponse(status: number, wwwAuthenticate: string | null): boolean {
  return status === 401 && (wwwAuthenticate ?? '').includes(MANAGER_AUTH_REALM);
}

// Dispatched when the manager itself refuses a request with a manager-realm
// 401. App.tsx listens and shows the manager login gate.
function dispatchManagerAuthRequired(): void {
  window.dispatchEvent(new CustomEvent('manager-auth-required'));
}

// Exchanges the manager token for the session cookie. Throws ApiError(401)
// when the token is wrong.
export async function managerLogin(token: string): Promise<void> {
  const resp = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  if (!resp.ok) {
    throw new ApiError('Invalid manager token', resp.status);
  }
}

// Codes the agent returns when a privileged operation (shell, file transfer,
// dynamic config mutation) lacks a valid management-key signature. A 401
// carrying one of these in its body is NOT a bearer-token failure and must
// not trigger the global auth-required flow.
const RESOURCE_AUTH_CODES = new Set(['auth_required', 'invalid_credentials']);

async function fetchJSON<T>(url: string, method = 'GET', body?: unknown): Promise<T> {
  const opts: RequestInit = { method, headers: { ...authHeaders() } };
  if (body !== undefined) {
    (opts.headers as Record<string, string>)['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const resp = await fetch(`${BASE}${url}`, opts);
  if (resp.status === 401) {
    // The manager's own 401 (marked by its WWW-Authenticate realm) means the
    // manager session is missing/expired — prompt for the manager token, and
    // leave the agent token alone.
    if (isManagerAuthResponse(resp.status, resp.headers?.get?.('WWW-Authenticate') ?? null)) {
      dispatchManagerAuthRequired();
      throw new Error('Manager authentication required');
    }
    const text = await resp.text().catch(() => '');
    try {
      const obj = JSON.parse(text);
      if (obj && typeof obj === 'object' && RESOURCE_AUTH_CODES.has(obj.error_code)) {
        throw new ApiError(text, 401);
      }
    } catch (e) {
      if (e instanceof ApiError) throw e;
      // JSON parse failed — fall through to bearer-auth handling
    }
    clearToken();
    window.dispatchEvent(new CustomEvent('auth-required'));
    throw new Error('Authentication required');
  }
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    // Try to extract a human-readable message from JSON error bodies.
    // Muti Metroo uses `{"error": "..."}`; some older endpoints use
    // `{"message": "..."}`. Fall back to the raw text otherwise.
    let msg = text;
    try {
      const errObj = JSON.parse(text);
      if (typeof errObj.error === 'string') msg = errObj.error;
      else if (typeof errObj.message === 'string') msg = errObj.message;
    } catch {
      // Not JSON, use raw text
    }
    throw new ApiError(msg || `API error ${resp.status}: ${url}`, resp.status);
  }
  return resp.json();
}

export function getDashboard(): Promise<DashboardResponse> {
  return fetchJSON('/api/proxy/api/dashboard');
}

export function getTopology(): Promise<TopologyResponse> {
  return fetchJSON('/api/proxy/api/topology');
}

export function getHealth(): Promise<HealthResponse> {
  return fetchJSON('/api/proxy/healthz');
}

// Muti Metroo Manager's own health (not proxied) — used for the app version in the footer.
export function getServerHealth(): Promise<ServerHealth> {
  return fetchJSON('/healthz');
}

export function getSettings(): Promise<AppSettings> {
  return fetchJSON('/api/settings');
}

export function putSettings(settings: AppSettings): Promise<AppSettings> {
  return fetchJSON('/api/settings', 'PUT', settings);
}

export function getAgentMetadata(): Promise<AgentMetadataMap> {
  return fetchJSON('/api/agent-meta');
}

export function putAgentMetadata(agentId: string, meta: AgentMeta): Promise<AgentMeta> {
  return fetchJSON(`/api/agent-meta/${encodeURIComponent(agentId)}`, 'PUT', meta);
}

// Network display-name overrides ({id: name}); only renamed networks appear.
export function getNetworks(): Promise<NetworkNameMap> {
  return fetchJSON('/api/networks');
}

// Sets a network's display name. Returns the effective name — equal to the
// identifier when the override was cleared — so callers can drop it from
// their override map.
export function putNetwork(id: string, name: string): Promise<{ id: string; name: string }> {
  return fetchJSON(`/api/networks/${encodeURIComponent(id)}`, 'PUT', { name });
}

// Operator-placed map positions ({short_id: {x,y}}).
export function getPositions(): Promise<PositionMap> {
  return fetchJSON('/api/positions');
}

// Replace-all: the supplied map becomes the entire persisted set (an empty
// map clears it — the reset-view action).
export function putPositions(positions: PositionMap): Promise<{ count: number }> {
  return fetchJSON('/api/positions', 'PUT', positions);
}

// Returns null when no downloads bundle is mounted (server returns 404).
// All other failures bubble up so we don't silently hide a working
// bundle behind a transient network blip.
export async function getDownloadsManifest(): Promise<DownloadsManifest | null> {
  try {
    return await fetchJSON<DownloadsManifest>('/api/downloads/manifest');
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
}

export function downloadsFileURL(name: string): string {
  return `/api/downloads/file/${encodeURIComponent(name)}`;
}

export function getMeshTest(forceRefresh = false): Promise<MeshTestResponse> {
  return fetchJSON('/api/proxy/api/mesh-test', forceRefresh ? 'POST' : 'GET');
}

export function triggerRouteAdvertise(): Promise<unknown> {
  return fetchJSON('/api/proxy/routes/advertise', 'POST');
}

// Trace how the locally-connected agent would route a destination —
// IP literal, CIDR, or hostname. Backed by /route/trace on the agent.
export function traceLocalRoute(dest: string): Promise<RouteTraceResult> {
  return fetchJSON('/api/proxy/route/trace', 'POST', { dest });
}

// --- Agent management ---

export function manageAgentRoutes(
  agentId: string,
  isLocal: boolean,
  req: RouteManageRequest,
): Promise<RouteManageResponse> {
  // Local agent: use the unscoped endpoint, since /agents/{self}/routes/manage
  // would route through the mesh and an agent has no mesh route to itself.
  const path = isLocal ? '/api/proxy/routes/manage' : `/api/proxy/agents/${agentId}/routes/manage`;
  return fetchJSON(path, 'POST', req);
}

// Lists the IP addresses assigned to the agent's up interfaces, so the route
// source-IP picker can offer the host's full address set. The source-IP binds
// on this (exit) agent, so we query that agent's own interfaces.
export function getAgentInterfaces(agentId: string, isLocal: boolean): Promise<InterfacesResponse> {
  // Local agent: use the unscoped endpoint (see manageAgentRoutes).
  const path = isLocal ? '/api/proxy/api/interfaces' : `/api/proxy/agents/${agentId}/interfaces`;
  return fetchJSON(path);
}

export function manageAgentForwards(
  agentId: string,
  isLocal: boolean,
  req: ForwardManageRequest,
): Promise<ForwardManageResponse> {
  // Local agent: use the unscoped endpoint (see manageAgentRoutes).
  const path = isLocal
    ? '/api/proxy/forward/manage'
    : `/api/proxy/agents/${agentId}/forward/manage`;
  return fetchJSON(path, 'POST', req);
}

export function manageAgentForwardEndpoints(
  agentId: string,
  isLocal: boolean,
  req: ForwardEndpointManageRequest,
): Promise<ForwardEndpointManageResponse> {
  // Local agent: use the unscoped endpoint (see manageAgentRoutes).
  const path = isLocal
    ? '/api/proxy/forward/endpoints/manage'
    : `/api/proxy/agents/${agentId}/forward/endpoints/manage`;
  return fetchJSON(path, 'POST', req);
}

export function manageAgentPeers(
  agentId: string,
  isLocal: boolean,
  req: PeerManageRequest,
): Promise<PeerManageResponse> {
  // Local agent: use the unscoped endpoint (see manageAgentRoutes).
  const path = isLocal ? '/api/proxy/peers/manage' : `/api/proxy/agents/${agentId}/peers/manage`;
  return fetchJSON(path, 'POST', req);
}

export function manageAgentListeners(
  agentId: string,
  isLocal: boolean,
  req: ListenerManageRequest,
): Promise<ListenerManageResponse> {
  // Local agent: use the unscoped endpoint (see manageAgentRoutes).
  const path = isLocal
    ? '/api/proxy/listeners/manage'
    : `/api/proxy/agents/${agentId}/listeners/manage`;
  return fetchJSON(path, 'POST', req);
}

// Mesh-host registry is local-only on the agent — no per-agent variant.
export function manageMeshHosts(req: MeshHostManageRequest): Promise<MeshHostManageResponse> {
  return fetchJSON('/api/proxy/hosts/manage', 'POST', req);
}

export function manageMeshHostSuffixes(
  req: MeshHostSuffixManageRequest,
): Promise<MeshHostSuffixManageResponse> {
  return fetchJSON('/api/proxy/hosts/suffixes/manage', 'POST', req);
}

export function probeAgentPeer(
  agentId: string,
  isLocal: boolean,
  req: ProbeRequest,
): Promise<ProbeResponse> {
  const path = isLocal ? '/api/proxy/api/probe' : `/api/proxy/agents/${agentId}/probe`;
  return fetchJSON(path, 'POST', req);
}

export async function downloadFile(agentId: string, path: string): Promise<Blob> {
  const body: Record<string, unknown> = { path };
  const resp = await fetch(`${BASE}/api/proxy/agents/${agentId}/file/download`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(body),
  });
  if (resp.status === 401) {
    if (isManagerAuthResponse(resp.status, resp.headers?.get?.('WWW-Authenticate') ?? null)) {
      dispatchManagerAuthRequired();
      throw new Error('Manager authentication required');
    }
    clearToken();
    window.dispatchEvent(new CustomEvent('auth-required'));
    throw new Error('Authentication required');
  }
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(text || `Download failed: ${resp.status}`);
  }
  return resp.blob();
}

export async function uploadFile(
  agentId: string,
  file: File,
  remotePath: string,
  onProgress?: (loaded: number, total: number) => void,
  signal?: AbortSignal,
): Promise<{ status: string; message?: string }> {
  const form = new FormData();
  form.append('file', file);
  form.append('path', remotePath);
  const url = `${BASE}/api/proxy/agents/${agentId}/file/upload`;
  const headers = authHeaders();

  // Use XHR when progress tracking is needed
  if (onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', url);
      for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
      xhr.upload.onprogress = e => {
        if (e.lengthComputable) onProgress(e.loaded, e.total);
      };
      xhr.onload = () => {
        if (xhr.status === 401) {
          if (isManagerAuthResponse(xhr.status, xhr.getResponseHeader('WWW-Authenticate'))) {
            dispatchManagerAuthRequired();
            reject(new Error('Manager authentication required'));
            return;
          }
          clearToken();
          window.dispatchEvent(new CustomEvent('auth-required'));
          reject(new Error('Authentication required'));
          return;
        }
        if (xhr.status < 200 || xhr.status >= 300) {
          reject(new Error(xhr.responseText || `Upload failed: ${xhr.status}`));
          return;
        }
        try {
          resolve(JSON.parse(xhr.responseText));
        } catch {
          resolve({ status: 'ok' });
        }
      };
      xhr.onerror = () => reject(new Error('Upload failed: network error'));
      // Abort rejects with an AbortError so callers can distinguish a user
      // cancel from a genuine upload failure.
      xhr.onabort = () => reject(new DOMException('Upload aborted', 'AbortError'));
      if (signal) {
        if (signal.aborted) {
          xhr.abort();
          return;
        }
        signal.addEventListener('abort', () => xhr.abort(), { once: true });
      }
      xhr.send(form);
    });
  }

  const resp = await fetch(url, {
    method: 'POST',
    headers,
    body: form,
    signal: signal ?? null,
  });
  if (resp.status === 401) {
    if (isManagerAuthResponse(resp.status, resp.headers?.get?.('WWW-Authenticate') ?? null)) {
      dispatchManagerAuthRequired();
      throw new Error('Manager authentication required');
    }
    clearToken();
    window.dispatchEvent(new CustomEvent('auth-required'));
    throw new Error('Authentication required');
  }
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(text || `Upload failed: ${resp.status}`);
  }
  return resp.json();
}

// --- File browsing ---

export function browseFiles(agentId: string, action: 'roots'): Promise<FileBrowseRootsResponse>;
export function browseFiles(
  agentId: string,
  action: 'list',
  path?: string,
  offset?: number,
  limit?: number,
): Promise<FileBrowseListResponse>;
export function browseFiles(
  agentId: string,
  action: 'list' | 'roots',
  path?: string,
  offset?: number,
  limit?: number,
): Promise<FileBrowseListResponse | FileBrowseRootsResponse> {
  const body: Record<string, unknown> = { action };
  if (path !== undefined) body.path = path;
  if (offset !== undefined) body.offset = offset;
  if (limit !== undefined) body.limit = limit;
  return fetchJSON(`/api/proxy/agents/${agentId}/file/browse`, 'POST', body);
}

export function chmodFile(
  agentId: string,
  path: string,
  mode: string,
): Promise<{ entry?: FileBrowseEntry; error?: string }> {
  const body: Record<string, unknown> = { action: 'chmod', path, mode };
  return fetchJSON(`/api/proxy/agents/${agentId}/file/browse`, 'POST', body);
}

export function deleteFile(
  agentId: string,
  path: string,
  recursive: boolean,
): Promise<{ entry?: FileBrowseEntry; error?: string }> {
  const body: Record<string, unknown> = { action: 'delete', path, recursive };
  return fetchJSON(`/api/proxy/agents/${agentId}/file/browse`, 'POST', body);
}

export function getSleepStatus(): Promise<SleepStatusResponse> {
  return fetchJSON('/api/proxy/sleep/status');
}

export function sleepCluster(): Promise<unknown> {
  return fetchJSON('/api/proxy/sleep', 'POST');
}

export function wakeCluster(): Promise<unknown> {
  return fetchJSON('/api/proxy/wake', 'POST');
}

export function getShellWebSocketURL(agentId: string): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const base = `${proto}//${window.location.host}/api/proxy/agents/${agentId}/shell`;
  const token = getToken();
  return token ? `${base}?token=${encodeURIComponent(token)}` : base;
}

export function renameAgent(
  agentId: string,
  isLocal: boolean,
  name: string,
): Promise<{ status: string; name?: string }> {
  const path = isLocal
    ? '/api/proxy/display-name/manage'
    : `/api/proxy/agents/${agentId}/display-name/manage`;
  return fetchJSON(path, 'POST', { action: 'set', name });
}

export function getPingWebSocketURL(agentId: string): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const base = `${proto}//${window.location.host}/api/proxy/agents/${agentId}/icmp`;
  const token = getToken();
  return token ? `${base}?token=${encodeURIComponent(token)}` : base;
}

// Returns null when the agent is older and lacks /api/setup-defaults (404/403),
// so the config wizard can fall back to a fully-manual flow.
export async function getSetupDefaults(): Promise<SetupDefaultsResponse | null> {
  try {
    return await fetchJSON<SetupDefaultsResponse>('/api/proxy/api/setup-defaults');
  } catch (err) {
    if (err instanceof ApiError && (err.status === 404 || err.status === 403)) return null;
    throw err;
  }
}

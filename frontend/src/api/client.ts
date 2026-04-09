import type {
  DashboardResponse,
  TopologyResponse,
  MeshTestResponse,
  SleepStatusResponse,
  RouteManageRequest,
  RouteManageResponse,
  ForwardManageRequest,
  ForwardManageResponse,
  FileBrowseEntry,
  FileBrowseListResponse,
  FileBrowseRootsResponse,
} from './types';

const BASE = '';

// --- Token management (sessionStorage) ---
const TOKEN_KEY = 'muti-metroo-token';
export function getToken(): string | null { return sessionStorage.getItem(TOKEN_KEY); }
export function setToken(token: string): void { sessionStorage.setItem(TOKEN_KEY, token); }
export function clearToken(): void { sessionStorage.removeItem(TOKEN_KEY); }

function authHeaders(): Record<string, string> {
  const t = getToken();
  return t ? { Authorization: `Bearer ${t}` } : {};
}

async function fetchJSON<T>(url: string, method = 'GET', body?: unknown): Promise<T> {
  const opts: RequestInit = { method, headers: { ...authHeaders() } };
  if (body !== undefined) {
    (opts.headers as Record<string, string>)['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const resp = await fetch(`${BASE}${url}`, opts);
  if (resp.status === 401) {
    clearToken();
    window.dispatchEvent(new CustomEvent('auth-required'));
    throw new Error('Authentication required');
  }
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    // Try to extract message from JSON error responses
    let msg = text;
    try {
      const errObj = JSON.parse(text);
      if (errObj.message) msg = errObj.message;
    } catch {
      // Not JSON, use raw text
    }
    throw new Error(msg || `API error ${resp.status}: ${url}`);
  }
  return resp.json();
}

export function getDashboard(): Promise<DashboardResponse> {
  return fetchJSON('/api/proxy/api/dashboard');
}

export function getTopology(): Promise<TopologyResponse> {
  return fetchJSON('/api/proxy/api/topology');
}

export function getHealth(): Promise<unknown> {
  return fetchJSON('/api/proxy/healthz');
}

export function getMeshTest(forceRefresh = false): Promise<MeshTestResponse> {
  return fetchJSON('/api/proxy/api/mesh-test', forceRefresh ? 'POST' : 'GET');
}

export function triggerRouteAdvertise(): Promise<unknown> {
  return fetchJSON('/api/proxy/routes/advertise', 'POST');
}

// --- Agent management ---

export function manageAgentRoutes(agentId: string, isLocal: boolean, req: RouteManageRequest): Promise<RouteManageResponse> {
  // Local agent: use the unscoped endpoint, since /agents/{self}/routes/manage
  // would route through the mesh and an agent has no mesh route to itself.
  const path = isLocal
    ? '/api/proxy/routes/manage'
    : `/api/proxy/agents/${agentId}/routes/manage`;
  return fetchJSON(path, 'POST', req);
}

export function manageAgentForwards(agentId: string, isLocal: boolean, req: ForwardManageRequest): Promise<ForwardManageResponse> {
  // Local agent: use the unscoped endpoint (see manageAgentRoutes).
  const path = isLocal
    ? '/api/proxy/forward/manage'
    : `/api/proxy/agents/${agentId}/forward/manage`;
  return fetchJSON(path, 'POST', req);
}

export async function downloadFile(agentId: string, path: string): Promise<Blob> {
  const resp = await fetch(`${BASE}/api/proxy/agents/${agentId}/file/download`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ path }),
  });
  if (resp.status === 401) {
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
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress(e.loaded, e.total);
      };
      xhr.onload = () => {
        if (xhr.status === 401) {
          clearToken();
          window.dispatchEvent(new CustomEvent('auth-required'));
          reject(new Error('Authentication required'));
          return;
        }
        if (xhr.status < 200 || xhr.status >= 300) {
          reject(new Error(xhr.responseText || `Upload failed: ${xhr.status}`));
          return;
        }
        try { resolve(JSON.parse(xhr.responseText)); }
        catch { resolve({ status: 'ok' }); }
      };
      xhr.onerror = () => reject(new Error('Upload failed: network error'));
      xhr.send(form);
    });
  }

  const resp = await fetch(url, {
    method: 'POST',
    headers,
    body: form,
  });
  if (resp.status === 401) {
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

export function browseFiles(
  agentId: string,
  action: 'roots',
): Promise<FileBrowseRootsResponse>;
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
  return fetchJSON(`/api/proxy/agents/${agentId}/file/browse`, 'POST', {
    action: 'chmod',
    path,
    mode,
  });
}

export function deleteFile(
  agentId: string,
  path: string,
  recursive: boolean,
): Promise<{ entry?: FileBrowseEntry; error?: string }> {
  return fetchJSON(`/api/proxy/agents/${agentId}/file/browse`, 'POST', {
    action: 'delete',
    path,
    recursive,
  });
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
  agentId: string, isLocal: boolean, name: string,
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

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import {
  manageAgentPeers,
  probeAgentPeer,
  setToken,
  clearToken,
  manageMeshHostSuffixes,
} from '../client';

type FetchArgs = [string, RequestInit];

function mockFetch(response: { status: number; body: unknown }) {
  const fn = vi.fn(
    async () =>
      ({
        ok: response.status >= 200 && response.status < 300,
        status: response.status,
        async json() {
          return response.body;
        },
        async text() {
          return JSON.stringify(response.body);
        },
      }) as unknown as Response,
  );
  vi.stubGlobal('fetch', fn);
  return fn;
}

describe('manageAgentPeers', () => {
  beforeEach(() => {
    clearToken();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('calls the local endpoint when isLocal=true', async () => {
    const fn = mockFetch({ status: 200, body: { status: 'ok', peers: [] } });
    await manageAgentPeers('agent-xyz', true, { action: 'list' });
    const [url, init] = fn.mock.calls[0] as unknown as FetchArgs;
    expect(url).toBe('/api/proxy/peers/manage');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ action: 'list' });
  });

  it('calls the remote endpoint when isLocal=false', async () => {
    const fn = mockFetch({ status: 200, body: { status: 'ok', peers: [] } });
    await manageAgentPeers('agent-xyz', false, {
      action: 'add',
      address: 'f.example:4433',
      transport: 'quic',
    });
    const [url, init] = fn.mock.calls[0] as unknown as FetchArgs;
    expect(url).toBe('/api/proxy/agents/agent-xyz/peers/manage');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({
      action: 'add',
      address: 'f.example:4433',
      transport: 'quic',
    });
  });

  it('attaches Authorization header when token is set', async () => {
    setToken('secret-token');
    const fn = mockFetch({ status: 200, body: { status: 'ok' } });
    await manageAgentPeers('a', true, { action: 'list' });
    const [, init] = fn.mock.calls[0] as unknown as FetchArgs;
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer secret-token');
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('parses the JSON error message field on non-2xx', async () => {
    mockFetch({ status: 400, body: { status: 'error', message: 'address required' } });
    await expect(manageAgentPeers('a', true, { action: 'add' })).rejects.toThrow(
      'address required',
    );
  });

  it('returns the parsed peers array on success', async () => {
    mockFetch({
      status: 200,
      body: {
        status: 'ok',
        peers: [
          {
            address: 'f.example:4433',
            transport: 'quic',
            connected: true,
            persistent: true,
            dynamic: true,
          },
        ],
      },
    });
    const resp = await manageAgentPeers('a', true, { action: 'list' });
    expect(resp.status).toBe('ok');
    expect(resp.peers).toHaveLength(1);
    expect(resp.peers?.[0].address).toBe('f.example:4433');
  });
});

describe('manageMeshHostSuffixes', () => {
  beforeEach(() => {
    clearToken();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('POSTs to /api/proxy/hosts/suffixes/manage with the request body', async () => {
    const fn = mockFetch({ status: 200, body: { suffixes: ['mesh', 'muti-metroo.alt'] } });
    const resp = await manageMeshHostSuffixes({ action: 'add', suffix: 'muti-metroo.alt' });
    const [url, init] = fn.mock.calls[0] as unknown as FetchArgs;
    expect(url).toBe('/api/proxy/hosts/suffixes/manage');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ action: 'add', suffix: 'muti-metroo.alt' });
    expect(resp.suffixes).toEqual(['mesh', 'muti-metroo.alt']);
  });

  it('surfaces 409 suffix-in-use errors', async () => {
    mockFetch({
      status: 409,
      body: { error: 'suffix has registered hosts: mesh used by gateway.mesh, target-11.mesh' },
    });
    await expect(manageMeshHostSuffixes({ action: 'remove', suffix: 'mesh' })).rejects.toThrow(
      /registered hosts/,
    );
  });
});

describe('probeAgentPeer', () => {
  beforeEach(() => {
    clearToken();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('calls the local endpoint when isLocal=true', async () => {
    const fn = mockFetch({
      status: 200,
      body: { success: true, transport: 'quic', address: 'x:1', remote_id: 'abc', rtt_ms: 7 },
    });
    await probeAgentPeer('agent-xyz', true, { address: 'x:1', transport: 'quic' });
    const [url, init] = fn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/proxy/api/probe');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ address: 'x:1', transport: 'quic' });
  });

  it('calls the remote endpoint when isLocal=false', async () => {
    const fn = mockFetch({
      status: 200,
      body: { success: false, transport: 'quic', address: 'x:1', error: 'timeout' },
    });
    const resp = await probeAgentPeer('agent-xyz', false, { address: 'x:1', transport: 'quic' });
    const [url] = fn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/proxy/agents/agent-xyz/probe');
    expect(resp.success).toBe(false);
    expect(resp.error).toBe('timeout');
  });
});

describe('manager auth', () => {
  function mockFetchWithHeaders(response: { status: number; body: unknown; wwwAuth?: string }) {
    const fn = vi.fn(
      async () =>
        ({
          ok: response.status >= 200 && response.status < 300,
          status: response.status,
          headers: {
            get: (name: string) =>
              name === 'WWW-Authenticate' ? (response.wwwAuth ?? null) : null,
          },
          async json() {
            return response.body;
          },
          async text() {
            return JSON.stringify(response.body);
          },
        }) as unknown as Response,
    );
    vi.stubGlobal('fetch', fn);
    return fn;
  }

  beforeEach(() => {
    clearToken();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('dispatches manager-auth-required on a manager-realm 401 and keeps the agent token', async () => {
    setToken('agent-token');
    mockFetchWithHeaders({
      status: 401,
      body: { error: 'manager authentication required', error_code: 'manager_auth_required' },
      wwwAuth: 'Bearer realm="muti-metroo-manager"',
    });
    const events: string[] = [];
    window.addEventListener('manager-auth-required', () => events.push('manager'));
    window.addEventListener('auth-required', () => events.push('agent'));

    const { getSettings } = await import('../client');
    await expect(getSettings()).rejects.toThrow('Manager authentication required');
    expect(events).toEqual(['manager']);
    // The agent token must survive a manager 401 — it is a different credential.
    const { getToken } = await import('../client');
    expect(getToken()).toBe('agent-token');
  });

  it('dispatches auth-required on a plain 401 (agent-side) as before', async () => {
    setToken('agent-token');
    mockFetchWithHeaders({ status: 401, body: { error: 'unauthorized' } });
    const events: string[] = [];
    window.addEventListener('manager-auth-required', () => events.push('manager'));
    window.addEventListener('auth-required', () => events.push('agent'));

    const { getSettings } = await import('../client');
    await expect(getSettings()).rejects.toThrow('Authentication required');
    expect(events).toEqual(['agent']);
  });

  it('managerLogin POSTs the token and resolves on 204', async () => {
    const fn = mockFetchWithHeaders({ status: 204, body: null });
    const { managerLogin } = await import('../client');
    await managerLogin('manager-token');
    const [url, init] = fn.mock.calls[0] as unknown as FetchArgs;
    expect(url).toBe('/api/auth/login');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ token: 'manager-token' });
  });

  it('managerLogin rejects on 401', async () => {
    mockFetchWithHeaders({ status: 401, body: { error: 'nope' } });
    const { managerLogin } = await import('../client');
    await expect(managerLogin('wrong')).rejects.toThrow('Invalid manager token');
  });
});

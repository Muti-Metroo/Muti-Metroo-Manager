import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import RoutesTab from '../RoutesTab';
import { ApiError } from '../../../api/client';
import type { TopologyAgentInfo, RouteManageResponse } from '../../../api/types';

vi.mock('../../../api/client', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../api/client')>();
  return {
    ...actual,
    manageAgentRoutes: vi.fn(),
    getAgentInterfaces: vi.fn(),
  };
});

import { manageAgentRoutes } from '../../../api/client';

const mockedManage = vi.mocked(manageAgentRoutes);

function makeAgent(overrides: Partial<TopologyAgentInfo> = {}): TopologyAgentInfo {
  return {
    id: 'agent-1',
    short_id: 'agent-1',
    display_name: 'agent-1',
    is_local: true,
    is_connected: true,
    roles: [],
    hostname: '',
    os: 'linux',
    arch: 'amd64',
    version: '',
    uptime_hours: 0,
    ip_addresses: [],
    socks5_addr: '',
    udp_enabled: false,
    exit_routes: [],
    domain_routes: [],
    forward_listeners: [],
    forward_endpoints: [],
    ...overrides,
  };
}

function resolveList(routes: RouteManageResponse['routes']) {
  mockedManage.mockResolvedValueOnce({ status: 'ok', routes });
}

function renderTab() {
  return render(
    <RoutesTab agent={makeAgent()} canSignManagement={true} onRoutesChanged={() => {}} />,
  );
}

function addCalls() {
  return mockedManage.mock.calls.filter(c => (c[2] as { action: string }).action === 'add');
}

describe('RoutesTab', () => {
  beforeEach(() => {
    mockedManage.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('renders routes from the list response', async () => {
    resolveList([{ network: '10.0.0.0/24', metric: 100, dynamic: true }]);
    renderTab();
    expect(screen.getByText('Loading routes...')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('10.0.0.0/24')).toBeInTheDocument());
    expect(screen.getByText('metric 100')).toBeInTheDocument();
  });

  it('shows the unreachable banner when list fails with ApiError 502', async () => {
    mockedManage.mockRejectedValueOnce(new ApiError('Bad Gateway', 502));
    render(
      <RoutesTab
        agent={makeAgent({ is_local: false })}
        canSignManagement={true}
        onRoutesChanged={() => {}}
      />,
    );
    await waitFor(() =>
      expect(screen.getByText(/not reachable from the local node/i)).toBeInTheDocument(),
    );
  });

  it('rejects a malformed CIDR without calling the API', async () => {
    const user = userEvent.setup();
    resolveList([]);
    renderTab();
    await waitFor(() => expect(screen.getByText('No routes configured')).toBeInTheDocument());

    await user.type(screen.getByPlaceholderText(/CIDR/), '10.0.0.0');
    await user.click(screen.getByRole('button', { name: 'Add' }));

    await waitFor(() => expect(screen.getByText('CIDR must include /prefix')).toBeInTheDocument());
    expect(addCalls()).toHaveLength(0);
  });

  it('rejects an empty metric instead of silently defaulting to 100', async () => {
    const user = userEvent.setup();
    resolveList([]);
    renderTab();
    await waitFor(() => expect(screen.getByText('No routes configured')).toBeInTheDocument());

    await user.type(screen.getByPlaceholderText(/CIDR/), '10.0.0.0/24');
    await user.clear(screen.getByPlaceholderText('Metric'));
    await user.click(screen.getByRole('button', { name: 'Add' }));

    await waitFor(() =>
      expect(screen.getByText('Metric must be a non-negative integer')).toBeInTheDocument(),
    );
    expect(addCalls()).toHaveLength(0);
  });

  it('rejects a non-integer metric instead of truncating it', async () => {
    // number inputs accept decimal/exponential text like "1.5"; the old
    // parseInt(...) || 100 would have silently stored 1.
    const user = userEvent.setup();
    resolveList([]);
    renderTab();
    await waitFor(() => expect(screen.getByText('No routes configured')).toBeInTheDocument());

    await user.type(screen.getByPlaceholderText(/CIDR/), '10.0.0.0/24');
    await user.clear(screen.getByPlaceholderText('Metric'));
    await user.type(screen.getByPlaceholderText('Metric'), '1.5');
    await user.click(screen.getByRole('button', { name: 'Add' }));

    await waitFor(() =>
      expect(screen.getByText('Metric must be a non-negative integer')).toBeInTheDocument(),
    );
    expect(addCalls()).toHaveLength(0);
  });

  it('adds a route with the parsed metric and refetches', async () => {
    const user = userEvent.setup();
    resolveList([]);
    mockedManage.mockResolvedValueOnce({ status: 'ok' });
    resolveList([{ network: '10.0.0.0/24', metric: 50, dynamic: true }]);

    renderTab();
    await waitFor(() => expect(screen.getByText('No routes configured')).toBeInTheDocument());

    await user.type(screen.getByPlaceholderText(/CIDR/), '10.0.0.0/24');
    await user.clear(screen.getByPlaceholderText('Metric'));
    await user.type(screen.getByPlaceholderText('Metric'), '50');
    await user.click(screen.getByRole('button', { name: 'Add' }));

    await waitFor(() => expect(screen.getByText('10.0.0.0/24')).toBeInTheDocument());
    expect(addCalls()).toHaveLength(1);
    expect(addCalls()[0][2]).toEqual({ action: 'add', network: '10.0.0.0/24', metric: 50 });
  });
});

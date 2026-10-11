import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import PeersTab from '../PeersTab';
import { ApiError } from '../../../api/client';
import type { TopologyAgentInfo, PeerManageResponse } from '../../../api/types';

vi.mock('../../../api/client', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../api/client')>();
  return {
    ...actual,
    manageAgentPeers: vi.fn(),
    probeAgentPeer: vi.fn(),
  };
});

import { manageAgentPeers, probeAgentPeer } from '../../../api/client';

const mockedManage = vi.mocked(manageAgentPeers);
const mockedProbe = vi.mocked(probeAgentPeer);

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

function resolveList(peers: PeerManageResponse['peers']) {
  mockedManage.mockResolvedValueOnce({ status: 'ok', peers });
}

describe('PeersTab', () => {
  beforeEach(() => {
    mockedManage.mockReset();
    mockedProbe.mockReset();
    mockedProbe.mockResolvedValue({
      success: true,
      transport: 'quic',
      address: '',
      remote_id: '0123456789abcdef',
      remote_display_name: 'probed-peer',
      rtt_ms: 12,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('shows loading then renders peer rows from list response', async () => {
    resolveList([
      {
        address: '10.0.0.5:4433',
        transport: 'quic',
        connected: true,
        persistent: true,
        dynamic: true,
        remote_id: 'abcdef1234567890',
      },
      { address: 'relay:443', transport: 'ws', connected: false, persistent: true, dynamic: false },
    ]);

    render(
      <PeersTab
        agent={makeAgent()}
        canSignManagement={true}
        agentsById={new Map()}
        onPeersChanged={() => {}}
      />,
    );

    expect(screen.getByText('Loading peers...')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText('Loading peers...')).not.toBeInTheDocument());

    expect(screen.getByText('10.0.0.5:4433')).toBeInTheDocument();
    expect(screen.getByText('relay:443')).toBeInTheDocument();
    // Static (non-dynamic) row shows the "static" badge
    expect(screen.getByText('static')).toBeInTheDocument();
    // Only the dynamic row should have a Remove button
    expect(screen.getAllByRole('button', { name: 'Remove' })).toHaveLength(1);
  });

  it('shows empty-state when the list is empty', async () => {
    resolveList([]);
    render(
      <PeersTab
        agent={makeAgent()}
        canSignManagement={true}
        agentsById={new Map()}
        onPeersChanged={() => {}}
      />,
    );
    await waitFor(() => expect(screen.getByText('No peers')).toBeInTheDocument());
  });

  it('adds a peer with address + transport, then refetches', async () => {
    const onPeersChanged = vi.fn();
    const user = userEvent.setup();

    resolveList([]);
    mockedManage.mockResolvedValueOnce({ status: 'ok', message: 'adding' });
    resolveList([
      {
        address: 'f.example:4433',
        transport: 'quic',
        connected: true,
        persistent: true,
        dynamic: true,
      },
    ]);

    render(
      <PeersTab
        agent={makeAgent({ id: 'a-local', is_local: true })}
        canSignManagement={true}
        agentsById={new Map()}
        onPeersChanged={onPeersChanged}
      />,
    );
    await waitFor(() => expect(screen.getByText('No peers')).toBeInTheDocument());

    await user.type(screen.getByPlaceholderText('host:port'), 'f.example:4433');
    await user.click(screen.getByRole('button', { name: 'Add' }));

    await waitFor(() => expect(screen.getByText('f.example:4433')).toBeInTheDocument());

    const addCall = mockedManage.mock.calls.find(
      c => (c[2] as { action: string }).action === 'add',
    );
    expect(addCall).toBeDefined();
    expect(addCall![0]).toBe('a-local');
    expect(addCall![1]).toBe(true);
    expect(addCall![2]).toEqual({
      action: 'add',
      address: 'f.example:4433',
      transport: 'quic',
    });
    expect(onPeersChanged).toHaveBeenCalled();
  });

  it('constructs a wss URL for ws transport with a custom path', async () => {
    const user = userEvent.setup();
    resolveList([]);
    mockedManage.mockResolvedValueOnce({ status: 'ok' });
    resolveList([]);

    render(
      <PeersTab
        agent={makeAgent()}
        canSignManagement={true}
        agentsById={new Map()}
        onPeersChanged={() => {}}
      />,
    );
    await waitFor(() => expect(screen.getByText('No peers')).toBeInTheDocument());

    await user.type(screen.getByPlaceholderText('host:port'), 'h.example:4433');
    await user.selectOptions(screen.getByRole('combobox'), 'ws');
    await user.type(screen.getByPlaceholderText('/mesh'), 'custom/path');
    await user.click(screen.getByRole('button', { name: 'Add' }));

    const probeCall = mockedProbe.mock.calls[0];
    expect(probeCall[2]).toEqual({
      address: 'h.example:4433',
      transport: 'ws',
      path: '/custom/path',
    });

    const addCall = mockedManage.mock.calls.find(
      c => (c[2] as { action: string }).action === 'add',
    );
    expect(addCall![2]).toEqual({
      action: 'add',
      address: 'wss://h.example:4433/custom/path',
      transport: 'ws',
    });
  });

  it('removes a dynamic peer with the correct address', async () => {
    const user = userEvent.setup();
    resolveList([
      { address: 'peer:1234', transport: 'quic', connected: true, persistent: true, dynamic: true },
    ]);
    mockedManage.mockResolvedValueOnce({ status: 'ok' });
    resolveList([]);

    render(
      <PeersTab
        agent={makeAgent()}
        canSignManagement={true}
        agentsById={new Map()}
        onPeersChanged={() => {}}
      />,
    );
    await waitFor(() => expect(screen.getByText('peer:1234')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: 'Remove' }));
    // Confirmation dialog, click its confirm button to actually remove.
    // Scoped with `within` because the peer row carries a "Remove" button too.
    const dialog = await screen.findByRole('dialog', { name: 'Remove peer' });
    await user.click(within(dialog).getByRole('button', { name: 'Remove' }));

    await waitFor(() => expect(screen.getByText('No peers')).toBeInTheDocument());

    const removeCall = mockedManage.mock.calls.find(
      c => (c[2] as { action: string }).action === 'remove',
    );
    expect(removeCall![2]).toEqual({ action: 'remove', address: 'peer:1234' });
  });

  it('shows the unreachable banner when list fails with ApiError 502', async () => {
    mockedManage.mockRejectedValueOnce(new ApiError('Bad Gateway', 502));
    render(
      <PeersTab
        agent={makeAgent({ is_local: false })}
        canSignManagement={true}
        agentsById={new Map()}
        onPeersChanged={() => {}}
      />,
    );
    await waitFor(() =>
      expect(screen.getByText(/not reachable from the local node/i)).toBeInTheDocument(),
    );
  });

  it('shows the unreachable banner when agent reports "no route to agent"', async () => {
    mockedManage.mockRejectedValueOnce(new Error('no route to agent xyz'));
    render(
      <PeersTab
        agent={makeAgent({ is_local: false })}
        canSignManagement={true}
        agentsById={new Map()}
        onPeersChanged={() => {}}
      />,
    );
    await waitFor(() =>
      expect(screen.getByText(/not reachable from the local node/i)).toBeInTheDocument(),
    );
  });

  it('shows an error (not the unreachable banner) for generic failures', async () => {
    mockedManage.mockRejectedValueOnce(new Error('boom'));
    render(
      <PeersTab
        agent={makeAgent()}
        canSignManagement={true}
        agentsById={new Map()}
        onPeersChanged={() => {}}
      />,
    );
    await waitFor(() => expect(screen.getByText('boom')).toBeInTheDocument());
    expect(screen.queryByText(/not reachable/i)).not.toBeInTheDocument();
  });

  it('probes before add and includes probed identity in the success banner', async () => {
    const user = userEvent.setup();
    resolveList([]);
    mockedManage.mockResolvedValueOnce({ status: 'ok' });
    resolveList([
      {
        address: 'f.example:4433',
        transport: 'quic',
        connected: true,
        persistent: true,
        dynamic: true,
      },
    ]);

    render(
      <PeersTab
        agent={makeAgent()}
        canSignManagement={true}
        agentsById={new Map()}
        onPeersChanged={() => {}}
      />,
    );
    await waitFor(() => expect(screen.getByText('No peers')).toBeInTheDocument());

    await user.type(screen.getByPlaceholderText('host:port'), 'f.example:4433');
    await user.click(screen.getByRole('button', { name: 'Add' }));

    await waitFor(() =>
      expect(screen.getByText(/Dialing f\.example:4433 \(quic\)/)).toBeInTheDocument(),
    );
    expect(screen.getByText(/probed-peer/)).toBeInTheDocument();
    expect(screen.getByText(/12ms/)).toBeInTheDocument();

    const probeCall = mockedProbe.mock.calls[0];
    expect(probeCall[2]).toEqual({ address: 'f.example:4433', transport: 'quic' });
  });

  it('shows the probe failure and does not call add until "Add anyway" is clicked', async () => {
    const user = userEvent.setup();
    resolveList([]);
    mockedProbe.mockReset();
    mockedProbe.mockResolvedValueOnce({
      success: false,
      address: 'f.example:4433',
      transport: 'quic',
      error: 'handshake timeout',
    });
    mockedManage.mockResolvedValueOnce({ status: 'ok' });
    resolveList([]);

    render(
      <PeersTab
        agent={makeAgent()}
        canSignManagement={true}
        agentsById={new Map()}
        onPeersChanged={() => {}}
      />,
    );
    await waitFor(() => expect(screen.getByText('No peers')).toBeInTheDocument());

    await user.type(screen.getByPlaceholderText('host:port'), 'f.example:4433');
    await user.click(screen.getByRole('button', { name: 'Add' }));

    await waitFor(() =>
      expect(screen.getByText(/Probe failed: handshake timeout/)).toBeInTheDocument(),
    );
    expect(mockedManage.mock.calls.some(c => (c[2] as { action: string }).action === 'add')).toBe(
      false,
    );

    await user.click(screen.getByRole('button', { name: 'Add anyway' }));

    await waitFor(() => {
      const addCall = mockedManage.mock.calls.find(
        c => (c[2] as { action: string }).action === 'add',
      );
      expect(addCall).toBeDefined();
      expect(addCall![2]).toEqual({ action: 'add', address: 'f.example:4433', transport: 'quic' });
    });
    expect(mockedProbe).toHaveBeenCalledTimes(1);
  });

  it('clears the probe failure banner when the address is edited', async () => {
    const user = userEvent.setup();
    resolveList([]);
    mockedProbe.mockReset();
    mockedProbe.mockResolvedValueOnce({
      success: false,
      address: 'bad:1',
      transport: 'quic',
      error: 'dns lookup failed',
    });

    render(
      <PeersTab
        agent={makeAgent()}
        canSignManagement={true}
        agentsById={new Map()}
        onPeersChanged={() => {}}
      />,
    );
    await waitFor(() => expect(screen.getByText('No peers')).toBeInTheDocument());

    await user.type(screen.getByPlaceholderText('host:port'), 'bad:1');
    await user.click(screen.getByRole('button', { name: 'Add' }));

    await waitFor(() =>
      expect(screen.getByText(/Probe failed: dns lookup failed/)).toBeInTheDocument(),
    );
    expect(screen.getByRole('button', { name: 'Add anyway' })).toBeInTheDocument();

    await user.type(screen.getByPlaceholderText('host:port'), '2');
    expect(screen.queryByText(/Probe failed/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add anyway' })).not.toBeInTheDocument();
  });
});

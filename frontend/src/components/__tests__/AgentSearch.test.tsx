import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AgentSearch from '../AgentSearch';
import type { TopologyAgentInfo } from '../../api/types';

function agent(overrides: Partial<TopologyAgentInfo>): TopologyAgentInfo {
  return {
    id: '0000000000000000000000000000000a',
    short_id: '00000000',
    display_name: 'agent',
    is_local: false,
    is_connected: true,
    roles: [],
    hostname: '',
    os: 'linux',
    arch: 'amd64',
    version: 'dev',
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

const sampleAgents: TopologyAgentInfo[] = [
  agent({
    id: '1111111111111111111111111111aaaa',
    short_id: '11111111',
    display_name: 'gateway-eu',
    hostname: 'gw-fra',
  }),
  agent({
    id: '2222222222222222222222222222bbbb',
    short_id: '22222222',
    display_name: 'exit-us',
    hostname: 'us-east-1',
  }),
  agent({
    id: '3333333333333333333333333333cccc',
    short_id: '33333333',
    display_name: 'transit',
    hostname: 'transit-node',
  }),
];

// The search starts collapsed; a user expands it via the toggle button (or
// the `/` hotkey) before the input is reachable and the dropdown can render.
// This helper mirrors that flow so tests exercise the real interaction.
async function openSearch(
  user: ReturnType<typeof userEvent.setup>,
  agentMeta: Parameters<typeof AgentSearch>[0]['agentMeta'] = {},
  onSelect: (shortId: string) => void = vi.fn(),
) {
  render(<AgentSearch agents={sampleAgents} agentMeta={agentMeta} onSelect={onSelect} />);
  await user.click(screen.getByRole('button', { name: /search agents/i }));
  const input = screen.getByPlaceholderText(/search agents/i) as HTMLInputElement;
  // Expanding focuses and selects the input from a requestAnimationFrame
  // callback. Typing before that lands makes select() highlight the
  // characters already typed, so the next keystroke replaces them instead of
  // appending. A real user cannot type inside one frame; a test can, so wait
  // for focus to settle first.
  await waitFor(() => expect(input).toHaveFocus());
  return { input, onSelect };
}

// Types a query and waits for the dropdown to settle on the final keystroke.
// Asserting straight after `user.type` races React's async rendering: an
// intermediate prefix ("e" of "exit") matches more agents than the full query,
// so a query made at that moment sees the wrong list.
async function search(
  user: ReturnType<typeof userEvent.setup>,
  input: HTMLInputElement,
  query: string,
  expected: string[],
) {
  await user.type(input, query);
  await waitFor(() => {
    expect(screen.queryAllByRole('option').map(o => o.textContent)).toHaveLength(expected.length);
  });
  for (const name of expected) {
    expect(screen.getByText(name)).toBeInTheDocument();
  }
}

describe('AgentSearch', () => {
  it('opens the dropdown and lists matches as the user types', async () => {
    const user = userEvent.setup();
    const { input } = await openSearch(user);
    await search(user, input, 'exit', ['exit-us']);

    expect(screen.queryByText('gateway-eu')).not.toBeInTheDocument();
  });

  it('commits the highlighted match on Enter', async () => {
    const user = userEvent.setup();
    const { input, onSelect } = await openSearch(user);
    await search(user, input, 'gate', ['gateway-eu']);
    await user.keyboard('{Enter}');

    expect(onSelect).toHaveBeenCalledWith('11111111');
  });

  it('matches on short ID prefix', async () => {
    const user = userEvent.setup();
    const { input, onSelect } = await openSearch(user);
    await search(user, input, '3333', ['transit']);
    await user.keyboard('{Enter}');

    expect(onSelect).toHaveBeenCalledWith('33333333');
  });

  it('matches against notes content', async () => {
    const user = userEvent.setup();
    const agentMeta = {
      '2222222222222222222222222222bbbb': { note: 'primary exit', icon: '', networks: '' },
    };
    const { input, onSelect } = await openSearch(user, agentMeta);
    await search(user, input, 'primary', ['exit-us']);
    await user.keyboard('{Enter}');

    expect(onSelect).toHaveBeenCalledWith('22222222');
  });

  it('shows "No matches" when nothing matches', async () => {
    const user = userEvent.setup();
    const { input } = await openSearch(user);
    await user.type(input, 'zzz-unknown');

    await waitFor(() => expect(screen.getByText(/no matches/i)).toBeInTheDocument());
  });

  it('Escape clears a non-empty query', async () => {
    const user = userEvent.setup();
    const { input } = await openSearch(user);
    await search(user, input, 'gate', ['gateway-eu']);
    expect(input.value).toBe('gate');
    await user.keyboard('{Escape}');
    expect(input.value).toBe('');
  });
});

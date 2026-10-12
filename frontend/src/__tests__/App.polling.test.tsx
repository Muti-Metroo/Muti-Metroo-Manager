import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import App from '../App';
import * as client from '../api/client';
import type { DashboardResponse, TopologyResponse } from '../api/types';

vi.mock('../api/client', () => ({
  getDashboard: vi.fn(),
  getTopology: vi.fn(),
  getMeshTest: vi.fn(),
  getSleepStatus: vi.fn(),
  sleepCluster: vi.fn(),
  wakeCluster: vi.fn(),
  getSettings: vi.fn(),
  getServerHealth: vi.fn(),
  getAgentMetadata: vi.fn(),
  getNetworks: vi.fn(),
  putNetwork: vi.fn(),
  setToken: vi.fn(),
  clearToken: vi.fn(),
  getToken: vi.fn(() => null),
  managerLogin: vi.fn(),
}));

// The SVG metro map is irrelevant to polling and heavy under jsdom.
vi.mock('../components/MetroMap/MetroMap', () => ({ default: () => null }));

const dashboard = { agent: null } as unknown as DashboardResponse;
const topology = { agents: [], connections: [] } as unknown as TopologyResponse;

function deferred<T>(value: T): { promise: Promise<T>; resolve: () => void } {
  let resolvePromise!: () => void;
  const promise = new Promise<T>(resolve => {
    resolvePromise = () => resolve(value);
  });
  return { promise, resolve: resolvePromise };
}

describe('App dashboard polling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(client.getDashboard).mockResolvedValue(dashboard);
    vi.mocked(client.getTopology).mockResolvedValue(topology);
    vi.mocked(client.getMeshTest).mockResolvedValue({ results: [] } as never);
    vi.mocked(client.getSleepStatus).mockResolvedValue({ state: 'AWAKE' } as never);
    vi.mocked(client.getSettings).mockResolvedValue({
      api_address: '',
      socks_address: '',
      sounds_enabled: false,
    });
    vi.mocked(client.getServerHealth).mockResolvedValue({ version: 'test' } as never);
    vi.mocked(client.getAgentMetadata).mockResolvedValue({});
    vi.mocked(client.getNetworks).mockResolvedValue({});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('polls on the 5s interval', async () => {
    render(<App />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(client.getDashboard).toHaveBeenCalledTimes(1);

    // Advance one tick at a time so each refresh settles (microtasks flush
    // between act blocks) before the next tick fires.
    await act(async () => {
      vi.advanceTimersByTime(5_000);
      await Promise.resolve();
    });
    await act(async () => {
      vi.advanceTimersByTime(5_000);
      await Promise.resolve();
    });
    expect(client.getDashboard).toHaveBeenCalledTimes(3);
  });

  it('skips a tick while the previous refresh is still in flight', async () => {
    render(<App />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(client.getDashboard).toHaveBeenCalledTimes(1);

    // The next refresh hangs — simulating a round-trip slower than the
    // 5s poll interval.
    const slowDash = deferred(dashboard);
    const slowTopo = deferred(topology);
    vi.mocked(client.getDashboard).mockReturnValueOnce(slowDash.promise);
    vi.mocked(client.getTopology).mockReturnValueOnce(slowTopo.promise);

    await act(async () => {
      vi.advanceTimersByTime(5_000);
      await Promise.resolve();
    });
    expect(client.getDashboard).toHaveBeenCalledTimes(2);

    // Two more ticks fire while the slow refresh is unresolved: both must
    // be skipped, not queued or overlapped.
    await act(async () => {
      vi.advanceTimersByTime(10_000);
      await Promise.resolve();
    });
    expect(client.getDashboard).toHaveBeenCalledTimes(2);

    // Once it settles, polling resumes on the next tick.
    await act(async () => {
      slowDash.resolve();
      slowTopo.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      vi.advanceTimersByTime(5_000);
      await Promise.resolve();
    });
    expect(client.getDashboard).toHaveBeenCalledTimes(3);
  });
});

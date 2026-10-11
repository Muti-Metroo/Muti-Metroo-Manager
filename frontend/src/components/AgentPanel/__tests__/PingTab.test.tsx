import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import PingTab from '../PingTab';
import type { TopologyAgentInfo } from '../../../api/types';

// Minimal WebSocket stand-in: PingTab drives it through the on* handlers
// and send/close; each constructed instance is captured for the test.
class MockWebSocket {
  static instances: MockWebSocket[] = [];
  static OPEN = 1;
  readonly url: string;
  readyState = 0;
  sent: string[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(url: string, _protocols?: string | string[]) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
    this.readyState = 3;
  }

  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  receive(msg: unknown) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
}

const agent = { id: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4', short_id: 'a1b2' } as TopologyAgentInfo;

function startSession() {
  fireEvent.change(screen.getByLabelText('Ping target'), { target: { value: '8.8.8.8' } });
  fireEvent.click(screen.getByRole('button', { name: 'Start' }));
}

describe('PingTab session lifecycle', () => {
  beforeEach(() => {
    MockWebSocket.instances = [];
    vi.stubGlobal('WebSocket', MockWebSocket);
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('auto-stop timer from a finished session must not kill the next session', () => {
    render(<PingTab agent={agent} onDisabled={() => {}} />);

    // First session: connect, ack, exhaust the 10-ping count so the
    // auto-stop close timer (PING_TIMEOUT + 500ms) is scheduled.
    startSession();
    const first = MockWebSocket.instances[0];
    act(() => {
      first.open();
      first.receive({ type: 'init_ack', success: true });
      vi.advanceTimersByTime(10_000); // 10 pings at 1s intervals
    });
    expect(screen.getByText('Stopped')).toBeInTheDocument();

    // Operator stops and immediately starts a new session — inside the
    // stale timer's 6.5s grace window.
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    startSession();
    expect(MockWebSocket.instances).toHaveLength(2);
    const second = MockWebSocket.instances[1];
    act(() => {
      second.open();
      second.receive({ type: 'init_ack', success: true });
    });

    // Let the stale auto-stop timer fire.
    act(() => {
      vi.advanceTimersByTime(7_000);
    });

    // The new session's socket must survive and the session must stay up
    // (the target renders in both the status row and the Dest stat).
    expect(second.closed).toBe(false);
    expect(screen.getAllByText('8.8.8.8').length).toBeGreaterThan(0);
  });
});

import { useState, useEffect, useRef, useCallback } from 'react';
import type { TopologyAgentInfo } from '../../api/types';
import { getPingWebSocketURL } from '../../api/client';

interface PingResult {
  sequence: number;
  sendTime: number;
  rttMs: number | null;
  error?: string;
}

interface PingTabProps {
  agent: TopologyAgentInfo;
  // False while the whole agent panel is hidden (another agent selected).
  // The echo interval pauses so a backgrounded panel doesn't keep sending
  // 1 echo/s; the session resumes when the panel becomes visible again.
  isActive: boolean;
  onDisabled: () => void;
}

const MAX_RESULTS = 100;
const PING_INTERVAL = 1000;
const PING_TIMEOUT = 6000;
const COUNT_OPTIONS = [10, 25, 50, 0] as const; // 0 = unlimited

type PingStatus = 'idle' | 'connecting' | 'running' | 'stopped' | 'error';

// Status dot colour per session state. Written out rather than interpolated
// so Tailwind's scanner sees each class as a complete token.
const PING_STATUS_DOT: Record<PingStatus, string> = {
  idle: '',
  connecting: 'status-warning animate-pulse',
  running: 'status-success animate-pulse',
  stopped: '',
  error: 'status-error',
};

export default function PingTab({ agent, isActive, onDisabled }: PingTabProps) {
  const [targetInput, setTargetInput] = useState('');
  const [pingCount, setPingCount] = useState(10);
  const [infoOpen, setInfoOpen] = useState(false);
  const [activeTarget, setActiveTarget] = useState<string | null>(null);
  const [status, setStatus] = useState<PingStatus>('idle');
  const [errorMsg, setErrorMsg] = useState('');
  const [sourceIp, setSourceIp] = useState<string | null>(null);
  const [destIp, setDestIp] = useState<string | null>(null);
  const [results, setResults] = useState<PingResult[]>([]);

  const wsRef = useRef<WebSocket | null>(null);
  const seqRef = useRef(0);
  const countRef = useRef(pingCount);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const timeoutsRef = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stoppedRef = useRef(false);
  // Mirrors isActive for the WS message handlers, which close over the
  // session effect and would otherwise see a stale value.
  const isActiveRef = useRef(isActive);
  isActiveRef.current = isActive;
  // Set while the echo interval is paused because the panel is hidden.
  const pausedRef = useRef(false);
  // Restarts the echo interval after a pause; installed on init_ack.
  const startIntervalRef = useRef<(() => void) | null>(null);

  function clearSeqTimeout(seq: number): void {
    const tid = timeoutsRef.current.get(seq);
    if (tid != null) {
      clearTimeout(tid);
      timeoutsRef.current.delete(seq);
    }
  }

  const cleanup = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    startIntervalRef.current = null;
    pausedRef.current = false;
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
    for (const t of timeoutsRef.current.values()) clearTimeout(t);
    timeoutsRef.current.clear();
    if (wsRef.current) {
      wsRef.current.onopen = null;
      wsRef.current.onmessage = null;
      wsRef.current.onerror = null;
      wsRef.current.onclose = null;
      wsRef.current.close();
      wsRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (!activeTarget) return;

    stoppedRef.current = false;
    seqRef.current = 0;
    setResults([]);
    setErrorMsg('');
    setSourceIp(null);
    setDestIp(activeTarget);
    setStatus('connecting');

    const ws = new WebSocket(getPingWebSocketURL(agent.id), 'muti-metroo-icmp');
    wsRef.current = ws;

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'init', dest_ip: activeTarget }));
    };

    ws.onmessage = ev => {
      let msg: {
        type: string;
        success?: boolean;
        error?: string;
        sequence?: number;
        src_ip?: string;
      };
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }

      if (msg.type === 'init_ack') {
        if (msg.success) {
          setStatus('running');
          const tick = () => {
            seqRef.current += 1;
            const seq = seqRef.current;
            const now = Date.now();
            ws.send(JSON.stringify({ type: 'echo', sequence: seq, payload: '' }));
            setResults(prev => {
              const next = [{ sequence: seq, sendTime: now, rttMs: null }, ...prev];
              return next.length > MAX_RESULTS ? next.slice(0, MAX_RESULTS) : next;
            });
            const tid = setTimeout(() => {
              timeoutsRef.current.delete(seq);
              setResults(prev =>
                prev.map(r =>
                  r.sequence === seq && r.rttMs === null && !r.error
                    ? { ...r, error: 'timeout' }
                    : r,
                ),
              );
            }, PING_TIMEOUT);
            timeoutsRef.current.set(seq, tid);
            // Auto-stop after reaching count (0 = unlimited)
            if (countRef.current > 0 && seq >= countRef.current) {
              clearInterval(intervalRef.current!);
              intervalRef.current = null;
              stoppedRef.current = true;
              setStatus('stopped');
              // Close WS after allowing time for last replies. The timer
              // is tracked in closeTimerRef (cleared by cleanup) and the
              // identity check guards against a session the operator
              // started in the grace window — without both, the stale
              // timer would close the NEW session's socket.
              closeTimerRef.current = setTimeout(() => {
                closeTimerRef.current = null;
                if (wsRef.current !== ws) return;
                wsRef.current.close();
                wsRef.current = null;
                setActiveTarget(null);
              }, PING_TIMEOUT + 500);
            }
          };
          startIntervalRef.current = () => {
            if (intervalRef.current) clearInterval(intervalRef.current);
            intervalRef.current = setInterval(tick, PING_INTERVAL);
          };
          // Don't start ticking while the panel is hidden; the visibility
          // effect below starts the interval when it becomes visible.
          if (isActiveRef.current) {
            startIntervalRef.current();
          } else {
            pausedRef.current = true;
          }
        } else {
          const err = msg.error || 'Init failed';
          if (err.toLowerCase().includes('disabled')) {
            onDisabled();
          }
          setErrorMsg(err);
          setStatus('error');
          ws.close();
        }
        return;
      }

      if (msg.type === 'reply' && msg.sequence != null) {
        const seq = msg.sequence;
        clearSeqTimeout(seq);
        const now = Date.now();
        if (msg.src_ip) setSourceIp(prev => prev ?? msg.src_ip!);
        setResults(prev =>
          prev.map(r => (r.sequence === seq ? { ...r, rttMs: now - r.sendTime } : r)),
        );
        return;
      }

      if (msg.type === 'error' && msg.sequence != null) {
        const seq = msg.sequence;
        clearSeqTimeout(seq);
        setResults(prev =>
          prev.map(r => (r.sequence === seq ? { ...r, error: msg.error || 'error' } : r)),
        );
      }
    };

    ws.onerror = () => {
      if (!stoppedRef.current) {
        setStatus('error');
        setErrorMsg('WebSocket error');
      }
    };

    ws.onclose = () => {
      if (!stoppedRef.current) {
        setStatus(prev => {
          if (prev === 'running' || prev === 'connecting') {
            setErrorMsg('Connection closed');
            return 'error';
          }
          return prev;
        });
      }
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };

    return cleanup;
  }, [agent.id, activeTarget]); // eslint-disable-line react-hooks/exhaustive-deps

  // Pause the echo interval while the panel is hidden (operator switched to
  // another agent); resume when it becomes visible again. The WebSocket and
  // collected results stay alive — only the 1 echo/s send loop stops.
  useEffect(() => {
    if (isActive) {
      if (pausedRef.current && startIntervalRef.current) {
        pausedRef.current = false;
        startIntervalRef.current();
      }
      return;
    }
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
      pausedRef.current = true;
    }
  }, [isActive]);

  const handleStart = useCallback(() => {
    const target = targetInput.trim();
    if (!target) return;
    countRef.current = pingCount;
    setActiveTarget(target);
  }, [targetInput, pingCount]);

  const handleStop = useCallback(() => {
    stoppedRef.current = true;
    setActiveTarget(null);
    cleanup();
    setStatus('stopped');
  }, [cleanup]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !activeTarget) handleStart();
    },
    [activeTarget, handleStart],
  );

  const rtts = results.filter(r => r.rttMs !== null).map(r => r.rttMs!);
  const sent = results.filter(r => r.rttMs !== null || r.error).length;
  const received = rtts.length;
  const lossPercent = sent > 0 ? ((sent - received) / sent) * 100 : 0;
  const minRtt = rtts.length > 0 ? Math.min(...rtts) : 0;
  const maxRtt = rtts.length > 0 ? Math.max(...rtts) : 0;
  const avgRtt = rtts.length > 0 ? rtts.reduce((a, b) => a + b, 0) / rtts.length : 0;

  const isRunning = activeTarget !== null;
  const hasRtts = rtts.length > 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="ui-hint mb-0">
        Sends ICMP echo requests from this agent to a target IP through the mesh. The agent must
        have raw socket access (typically requires root or CAP_NET_RAW). Not available on Windows
        agents. Only IP addresses are supported, not hostnames.
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <input
          className="input input-sm min-w-40 flex-1 font-mono"
          type="text"
          placeholder="IP address (e.g. 8.8.8.8)"
          value={targetInput}
          onChange={e => setTargetInput(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={isRunning}
          aria-label="Ping target"
        />
        <select
          className="select select-sm w-20 shrink-0 font-mono"
          value={pingCount}
          onChange={e => setPingCount(Number(e.target.value))}
          disabled={isRunning}
          aria-label="Ping count"
        >
          {COUNT_OPTIONS.map(n => (
            <option key={n} value={n}>
              {n === 0 ? '\u221E' : n}
            </option>
          ))}
        </select>
        {isRunning ? (
          <button type="button" className="btn btn-sm btn-error" onClick={handleStop}>
            Stop
          </button>
        ) : (
          <button
            type="button"
            className="btn btn-sm btn-primary"
            onClick={handleStart}
            disabled={!targetInput.trim()}
          >
            Start
          </button>
        )}
      </div>

      <div>
        <button
          type="button"
          className="btn btn-xs btn-text"
          onClick={() => setInfoOpen(v => !v)}
          aria-expanded={infoOpen}
        >
          <span
            className={`icon-[tabler--chevron-right] size-3.5 transition-transform ${infoOpen ? 'rotate-90' : ''}`}
            aria-hidden="true"
          />
          Unprivileged ICMP
        </button>
        {infoOpen && (
          <div className="ui-hint mt-1.5 mb-0 space-y-1.5">
            <p>
              The agent uses unprivileged ICMP sockets (no root required). The kernel handles echo
              requests via UDP-based datagram sockets, which means:
            </p>
            <ul className="list-disc space-y-0.5 ps-5">
              <li>Only ICMP Echo (ping) is supported — no traceroute or other ICMP types</li>
              <li>The kernel assigns ICMP identifiers, not the agent</li>
              <li>
                Source IP in replies reflects the remote host, not the local outbound interface
              </li>
              <li>
                Requires <code className="font-mono">net.ipv4.ping_group_range</code> sysctl to
                include the agent&apos;s GID on Linux
              </li>
            </ul>
            <p>
              RTT is measured end-to-end from the manager through the mesh to the exit node and back
              , it includes mesh latency, not just network latency to the target.
            </p>
          </div>
        )}
      </div>

      {status !== 'idle' && (
        <div className="flex items-center gap-2">
          <span
            aria-hidden="true"
            className={`status status-sm shrink-0 ${PING_STATUS_DOT[status]}`}
          />
          <span className="font-mono">
            {status === 'connecting' && 'Connecting...'}
            {status === 'running' && activeTarget}
            {status === 'stopped' && 'Stopped'}
            {status === 'error' && (errorMsg || 'Error')}
          </span>
        </div>
      )}

      {sent > 0 && (
        <div className="space-y-2">
          {/* Counters are a few characters each, so they tile. */}
          <dl className="grid grid-cols-[repeat(auto-fit,minmax(4.5rem,1fr))] gap-2">
            {(
              [
                ['Min', hasRtts ? `${minRtt.toFixed(1)}ms` : '\u2014'],
                ['Avg', hasRtts ? `${avgRtt.toFixed(1)}ms` : '\u2014'],
                ['Max', hasRtts ? `${maxRtt.toFixed(1)}ms` : '\u2014'],
                ['Sent', String(sent)],
                ['Recv', String(received)],
                ['Loss', `${lossPercent.toFixed(0)}%`],
              ] as const
            ).map(([label, value]) => (
              <Stat
                key={label}
                label={label}
                value={value}
                tone={label === 'Loss' && lossPercent > 0 ? 'error' : undefined}
              />
            ))}
          </dl>

          {/* Addresses get their own wide row and are allowed to wrap: an
              IPv4 does not fit a counter tile, and an IPv6 fits nothing. */}
          {destIp && (
            <dl className="grid gap-2 sm:grid-cols-2">
              {(
                [
                  ['Source', sourceIp || '\u2014'],
                  ['Dest', destIp],
                ] as const
              ).map(([label, value]) => (
                <Stat key={label} label={label} value={value} wrap />
              ))}
            </dl>
          )}
        </div>
      )}

      {results.length > 0 && (
        <div className="ui-table-frame">
          <table className="table table-sm table-pin-rows">
            <thead>
              <tr>
                <th className="w-14 text-end">Seq</th>
                <th className="w-20 text-end">RTT</th>
                <th>Result</th>
              </tr>
            </thead>
            <tbody>
              {results.map(r => {
                const isOk = r.rttMs !== null && !r.error;
                const isTimeout = r.error === 'timeout';
                const isError = r.error && r.error !== 'timeout';
                const isPending = r.rttMs === null && !r.error;
                return (
                  <tr key={r.sequence} className={isPending ? 'opacity-60' : undefined}>
                    <td className="text-end font-mono">{r.sequence}</td>
                    <td className="text-end font-mono">
                      {r.rttMs != null ? `${r.rttMs.toFixed(1)}ms` : '\u2014'}
                    </td>
                    <td>
                      {isPending ? (
                        <span className="text-muted">...</span>
                      ) : (
                        <span className="flex items-center gap-1.5">
                          <span
                            aria-hidden="true"
                            className={`status status-sm ${isOk ? 'status-success' : 'status-error'}`}
                          />
                          {isOk ? 'reply' : isTimeout ? 'timeout' : r.error}
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** One labelled figure in the ping summary. */
function Stat({
  label,
  value,
  tone,
  // Addresses have to wrap; counters never need to.
  wrap,
}: {
  label: string;
  value: string;
  tone?: 'error';
  wrap?: boolean;
}) {
  return (
    <div className="ui-section px-2 py-1.5">
      <dt className="text-muted text-xs">{label}</dt>
      <dd
        className={`m-0 font-mono${tone === 'error' ? ' text-error' : ''}${wrap ? ' break-all' : ''}`}
      >
        {value}
      </dd>
    </div>
  );
}

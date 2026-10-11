import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import type { TopologyAgentInfo, ShellMeta } from '../../api/types';
import {
  MSG_META,
  MSG_STDIN,
  MSG_STDOUT,
  MSG_STDERR,
  MSG_RESIZE,
  MSG_ACK,
  MSG_EXIT,
  MSG_ERROR,
  ERR_SHELL_DISABLED,
} from '../../api/types';
import { getShellWebSocketURL } from '../../api/client';
import { mapManagementAuthError } from '../../util/authErrors';
import { copyToClipboard } from '../../util/clipboard';

interface ShellTabProps {
  agent: TopologyAgentInfo;
  isActive: boolean;
  disabled: boolean;
  // host:port of the Muti Metroo agent to include after `muti-metroo shell -a` in the
  // Copy CLI button. Always resolved by the parent to a non-empty string
  // (operator override or window.location.host).
  apiAddress: string;
  onDisabled: () => void;
}

function encodeShellFrame(msgType: number, payload: Uint8Array): ArrayBuffer {
  const buf = new ArrayBuffer(1 + payload.byteLength);
  const view = new Uint8Array(buf);
  view[0] = msgType;
  view.set(payload, 1);
  return buf;
}

function encodeMetaFrame(meta: ShellMeta): ArrayBuffer {
  const json = JSON.stringify(meta);
  const encoder = new TextEncoder();
  return encodeShellFrame(MSG_META, encoder.encode(json));
}

// Matches xterm.js auto-responses to terminal queries (CPR, DA1, DA2, DSR).
// Intercepted in onData to prevent echo loops with remote PTYs.
const TERM_AUTO_RESPONSE = /^\x1b\[[\?>]?[\d;]*[Rcn]$/;

// Host values the muti-metroo CLI already defaults to. Covers both the bare
// host:port form and the equivalent http:// URL form the CLI accepts
// as of Muti Metroo v4.1.0 — omitting the -a flag keeps copied commands
// short when the web UI runs on the user's own box.
const DEFAULT_CLI_HOSTS = new Set([
  'localhost:8080',
  '127.0.0.1:8080',
  '[::1]:8080',
  'http://localhost:8080',
  'http://127.0.0.1:8080',
  'http://[::1]:8080',
]);

function buildShellCliCommand(apiAddress: string, agentId: string, shell: string): string {
  const flag = apiAddress && !DEFAULT_CLI_HOSTS.has(apiAddress) ? ` -a ${apiAddress}` : '';
  return `muti-metroo shell${flag} --tty ${agentId} ${shell}`;
}

// Kept in step with --color-terminal in styles/app.css, which paints the
// frame around the canvas.
const TERMINAL_BG = '#14100d';

function encodeResizeFrame(rows: number, cols: number): ArrayBuffer {
  // Backend expects 4 raw bytes: rows (uint16 BE) + cols (uint16 BE)
  const payload = new Uint8Array(4);
  const dv = new DataView(payload.buffer);
  dv.setUint16(0, rows, false);
  dv.setUint16(2, cols, false);
  return encodeShellFrame(MSG_RESIZE, payload);
}

export default function ShellTab({
  agent,
  isActive,
  disabled,
  apiAddress,
  onDisabled,
}: ShellTabProps) {
  const termRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const connectedRef = useRef(false);
  const [status, setStatus] = useState<'connecting' | 'connected' | 'ended' | 'error'>(
    'connecting',
  );
  const [errorMsg, setErrorMsg] = useState('');
  const [activeShell, setActiveShell] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // Bumped by the Reconnect button to force the connection effect to re-run,
  // tearing down the old WebSocket + terminal and starting a fresh session
  // under the same activeShell. No auto-reconnect -- one click, one attempt.
  const [reconnectNonce, setReconnectNonce] = useState(0);

  // Refit terminal when panel becomes visible (display:none -> visible)
  useEffect(() => {
    if (!isActive || !fitAddonRef.current || !wsRef.current) return;
    // Use rAF to ensure the container has been laid out after display change
    const raf = requestAnimationFrame(() => {
      fitAddonRef.current?.fit();
      const dims = fitAddonRef.current?.proposeDimensions();
      if (dims && wsRef.current?.readyState === WebSocket.OPEN && connectedRef.current) {
        wsRef.current.send(encodeResizeFrame(dims.rows, dims.cols));
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [isActive]);

  useEffect(() => {
    if (disabled || !activeShell || !termRef.current) return;

    connectedRef.current = false;

    const terminal = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
      // xterm paints its own DOM and reads colours from JS, not CSS, so the
      // palette lives here rather than in the stylesheet. It is deliberately
      // fixed (not theme-switched): a terminal is a dark surface in both app
      // themes, and remapping ANSI colours under the operator mid-session
      // would misrepresent program output. TERMINAL_BG is shared with
      // .shell-terminal via the --color-terminal token in app.css.
      theme: {
        background: TERMINAL_BG,
        foreground: '#ece5dc',
        cursor: '#d0a36e',
        selectionBackground: 'rgba(208, 163, 110, 0.3)',
        black: TERMINAL_BG,
        red: '#d97066',
        green: '#6faa72',
        yellow: '#d9a441',
        blue: '#7aa7e0',
        magenta: '#b192d4',
        cyan: '#6fb3c4',
        white: '#ece5dc',
      },
    });

    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon();
    terminal.loadAddon(fitAddon);
    terminal.loadAddon(webLinksAddon);
    terminal.open(termRef.current);
    fitAddon.fit();

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    const wsURL = getShellWebSocketURL(agent.id);
    const ws = new WebSocket(wsURL);
    ws.binaryType = 'arraybuffer';
    wsRef.current = ws;

    const sendStdin = (data: string) => {
      if (ws.readyState === WebSocket.OPEN) {
        const encoder = new TextEncoder();
        ws.send(encodeShellFrame(MSG_STDIN, encoder.encode(data)));
      }
    };

    // Suppress terminal query auto-responses at the parser level to prevent
    // echo loops with remote BusyBox PTYs that have echo enabled.
    // DSR (ESC[6n]) is proxied via sendStdin for screen dimension detection.
    // DA1/DA2 are fully suppressed (unused by BusyBox).
    terminal.parser.registerCsiHandler({ final: 'n' }, params => {
      if (params[0] === 6 && connectedRef.current) {
        const row = terminal.buffer.active.cursorY + 1;
        const col = terminal.buffer.active.cursorX + 1;
        sendStdin(`\x1b[${row};${col}R`);
      }
      return true;
    });
    terminal.parser.registerCsiHandler({ final: 'c' }, () => true);
    terminal.parser.registerCsiHandler({ prefix: '>', final: 'c' }, () => true);
    // Suppress CPR echo -- discard ESC[row;colR echoed back by the PTY.
    terminal.parser.registerCsiHandler({ final: 'R' }, () => true);

    ws.onopen = () => {
      const dims = fitAddon.proposeDimensions();
      const meta: ShellMeta = {
        command: activeShell,
        tty: {
          rows: dims?.rows ?? 24,
          cols: dims?.cols ?? 80,
          term: 'xterm-256color',
        },
      };
      ws.send(encodeMetaFrame(meta));
    };

    ws.onmessage = (event: MessageEvent) => {
      if (typeof event.data === 'string') {
        try {
          const errObj = JSON.parse(event.data);
          const msg = errObj.message || event.data;
          if (msg.includes('SHELL_DISABLED') || errObj.code === ERR_SHELL_DISABLED) {
            onDisabled();
            setStatus('error');
            setErrorMsg('Shell is not enabled on this agent');
            return;
          }
          setStatus('error');
          setErrorMsg(mapManagementAuthError(errObj.code, msg) ?? msg);
        } catch {
          setStatus('error');
          setErrorMsg(mapManagementAuthError(undefined, event.data) ?? event.data);
        }
        return;
      }

      const data = new Uint8Array(event.data as ArrayBuffer);
      if (data.length < 1) return;

      const msgType = data[0];
      const payload = data.slice(1);

      switch (msgType) {
        case MSG_ACK:
          connectedRef.current = true;
          setStatus('connected');
          terminal.focus();
          break;
        case MSG_STDOUT:
        case MSG_STDERR:
          terminal.write(payload);
          break;
        case MSG_EXIT:
          setStatus('ended');
          terminal.write('\r\n\x1b[33m[Session ended]\x1b[0m\r\n');
          break;
        case MSG_ERROR: {
          const decoder = new TextDecoder();
          const errText = decoder.decode(payload);
          let errCode: unknown;
          let errMsg = errText;
          try {
            const errObj = JSON.parse(errText);
            errCode = errObj.code;
            errMsg = errObj.message ?? errText;
          } catch {
            // Plain-text error
          }
          if (errCode === ERR_SHELL_DISABLED || /SHELL_DISABLED/.test(errMsg)) {
            onDisabled();
            setStatus('error');
            setErrorMsg('Shell is not enabled on this agent');
            return;
          }
          setStatus('error');
          setErrorMsg(mapManagementAuthError(errCode, errMsg) ?? errMsg ?? 'Shell error');
          break;
        }
      }
    };

    ws.onerror = () => {
      setStatus('error');
      setErrorMsg('Shell is not available on this agent');
    };

    ws.onclose = () => {
      if (ws !== wsRef.current) return;
      if (!connectedRef.current) {
        setStatus(prev => (prev === 'error' ? prev : 'error'));
        setErrorMsg(prev => prev || 'Shell is not available on this agent');
      } else {
        setStatus('ended');
        terminal.write('\r\n\x1b[33m[Connection lost]\x1b[0m\r\n');
      }
    };

    // Forward user input to the remote shell, filtering out xterm.js
    // auto-responses to terminal queries to prevent echo-back garbage.
    const dataDisposable = terminal.onData((data: string) => {
      if (connectedRef.current && !TERM_AUTO_RESPONSE.test(data)) {
        sendStdin(data);
      }
    });

    // Trailing-edge debounce of the wire-side RESIZE while keeping local
    // fitAddon.fit() immediate. A continuous panel-divider drag at 60Hz
    // collapses to one WS frame per 100ms — important on high-RTT links
    // (hospitals, space stations) where 60 RESIZE frames + 60 TIOCSWINSZ
    // syscalls per second would saturate the channel. Final dims after the
    // drag settles are always flushed thanks to the trailing edge. (Shells
    // like BusyBox ash may not redraw the prompt until the next keypress —
    // that's shell-side behavior, not a missed RESIZE.)
    let pendingResizeTimer: ReturnType<typeof setTimeout> | null = null;
    let lastSentDims: { rows: number; cols: number } | null = null;
    const flushResize = () => {
      pendingResizeTimer = null;
      if (ws.readyState !== WebSocket.OPEN || !connectedRef.current) return;
      const dims = fitAddon.proposeDimensions();
      if (!dims) return;
      if (lastSentDims && lastSentDims.rows === dims.rows && lastSentDims.cols === dims.cols)
        return;
      lastSentDims = { rows: dims.rows, cols: dims.cols };
      ws.send(encodeResizeFrame(dims.rows, dims.cols));
    };
    const resizeObserver = new ResizeObserver(() => {
      fitAddon.fit();
      if (pendingResizeTimer != null) clearTimeout(pendingResizeTimer);
      pendingResizeTimer = setTimeout(flushResize, 100);
    });
    if (termRef.current) {
      resizeObserver.observe(termRef.current);
    }

    return () => {
      if (pendingResizeTimer != null) clearTimeout(pendingResizeTimer);
      dataDisposable.dispose();
      resizeObserver.disconnect();
      ws.close();
      terminal.dispose();
      terminalRef.current = null;
      wsRef.current = null;
      fitAddonRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onDisabled is intentionally
    // excluded: it's an inline arrow in the parent and would cause the effect to re-run
    // on every poll cycle, tearing down and recreating the WebSocket every 5s.
  }, [agent.id, disabled, activeShell, reconnectNonce]);

  const handleReconnect = () => {
    setStatus('connecting');
    setErrorMsg('');
    setReconnectNonce(n => n + 1);
  };

  // The shell tab is full-bleed (see AgentPanel), so the non-terminal states
  // supply their own padding.
  if (disabled) {
    return <div className="ui-disabled-msg p-3">Shell is not enabled on this agent</div>;
  }

  if (status === 'error' && activeShell !== null) {
    return (
      <div className="ui-disabled-msg space-y-3 p-3">
        <div className="text-error">{errorMsg}</div>
        <button type="button" className="btn btn-sm btn-primary" onClick={handleReconnect}>
          Reconnect
        </button>
      </div>
    );
  }

  const shells = agent.shells?.length ? agent.shells : ['sh'];

  // Shell picker — shown when no shell is active
  if (activeShell === null) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center p-3">
        <div className="ui-section w-full max-w-xs">
          <div className="ui-section-header">Select shell</div>
          <div className="flex flex-col gap-1.5 p-3">
            {shells.map(s => (
              <button
                key={s}
                type="button"
                className="btn btn-sm btn-soft btn-block justify-start font-mono"
                onClick={() => {
                  setStatus('connecting');
                  setErrorMsg('');
                  setActiveShell(s);
                }}
              >
                <span className="icon-[tabler--terminal-2] size-4" aria-hidden="true" />
                {s}
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  }

  // Active session
  let statusLabel: ReactNode;
  switch (status) {
    case 'connecting':
      statusLabel = <span className="text-warning">Connecting…</span>;
      break;
    case 'connected':
      statusLabel = <span className="text-success">Connected</span>;
      break;
    default:
      statusLabel = <span className="text-muted">Session ended</span>;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-hairline flex flex-none items-center gap-2 border-b px-3 py-1.5">
        {statusLabel}
        <div className="ms-auto flex items-center gap-1">
          {status === 'ended' && (
            <button type="button" className="btn btn-xs btn-primary" onClick={handleReconnect}>
              Reconnect
            </button>
          )}
          <button
            type="button"
            className="btn btn-xs btn-text"
            onClick={async () => {
              const ok = await copyToClipboard(
                buildShellCliCommand(apiAddress, agent.id, activeShell),
              );
              if (!ok) return;
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
          >
            <span
              className={`size-3.5 ${copied ? 'icon-[tabler--check]' : 'icon-[tabler--copy]'}`}
              aria-hidden="true"
            />
            {copied ? 'Copied!' : 'Copy CLI'}
          </button>
          <button
            type="button"
            className="btn btn-xs btn-text"
            onClick={() => setActiveShell(null)}
          >
            Close shell
          </button>
        </div>
      </div>
      <div className="shell-terminal" ref={termRef} />
    </div>
  );
}

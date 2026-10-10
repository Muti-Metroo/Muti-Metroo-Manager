import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { TopologyAgentInfo } from '../../api/types';
import { downloadBlob } from '../../util/download';
import { copyToClipboard } from '../../util/clipboard';
import { newLocalId } from '../../util/ids';
import { useModalDismiss } from '../../hooks/useModalDismiss';
import WizardShell from '../wizard/WizardShell';
import { Field } from '../wizard/Field';
import { initialEntryWizardState, ENTRY_STEPS } from './state';
import type { EntryWizardState, EntryRoute, EntrySocks5Transport } from './state';
import { buildEntryConfigYaml } from './yaml';
import {
  validateIPv4CIDR,
  validateSocks5Server,
  validateCIDR,
  validateAdminListen,
} from './validate';

interface EntryConfigWizardProps {
  agents: TopologyAgentInfo[];
  // Operator-configured default (from Muti Metroo Manager Settings). Used to seed
  // the SOCKS5 server so a central Muti Metroo Manager deployment doesn't hand out
  // configs pointing at 127.0.0.1.
  socksAddress?: string;
  onClose: () => void;
}

type Action =
  | { type: 'set'; patch: Partial<EntryWizardState> }
  | { type: 'addRoute'; route: EntryRoute }
  | { type: 'setRoute'; index: number; patch: Partial<EntryRoute> }
  | { type: 'removeRoute'; index: number };

const newRouteId = () => newLocalId('r');

function reducer(state: EntryWizardState, action: Action): EntryWizardState {
  switch (action.type) {
    case 'set':
      return { ...state, ...action.patch };
    case 'addRoute':
      return { ...state, routes: [...state.routes, action.route] };
    case 'setRoute': {
      const routes = state.routes.map((r, i) =>
        i === action.index ? { ...r, ...action.patch } : r,
      );
      return { ...state, routes };
    }
    case 'removeRoute':
      return { ...state, routes: state.routes.filter((_, i) => i !== action.index) };
  }
}

export default function EntryConfigWizard({
  agents,
  socksAddress,
  onClose,
}: EntryConfigWizardProps) {
  const [state, dispatch] = useReducer(reducer, { socksAddress }, initialEntryWizardState);
  const [stepIdx, setStepIdx] = useState(0);
  const [stepErrors, setStepErrors] = useState<Record<string, string>>({});
  const [downloaded, setDownloaded] = useState(false);
  const [copied, setCopied] = useState(false);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const currentStep = ENTRY_STEPS[Math.min(stepIdx, ENTRY_STEPS.length - 1)];

  useModalDismiss({ onClose });

  useEffect(
    () => () => {
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
    },
    [],
  );

  // For the local agent, prefer the operator-configured SOCKS5 override
  // (e.g. muti-metroo-manager.example.com:1080) over the bind address the agent
  // self-reports (which is often 0.0.0.0 and not externally reachable).
  const socks5Agents = useMemo(
    () =>
      agents
        .map(a => ({
          ...a,
          socks5_addr: a.is_local && socksAddress ? socksAddress : a.socks5_addr,
        }))
        .filter(a => a.socks5_addr && a.socks5_addr.trim()),
    [agents, socksAddress],
  );

  const validateCurrentStep = useCallback((): Record<string, string> => {
    const errs: Record<string, string> = {};
    switch (currentStep?.id) {
      case 'tun': {
        const v4 = validateIPv4CIDR(state.tunAddress);
        if (v4) errs.tunAddress = v4;
        break;
      }
      case 'socks5': {
        const s = validateSocks5Server(state.socks5Server);
        if (s) errs.socks5Server = s;
        if (state.socks5AuthEnabled) {
          if (!state.socks5Username.trim()) errs.socks5Username = 'Username required';
        }
        break;
      }
      case 'routes': {
        state.routes.forEach((r, i) => {
          if (!r.destination.trim()) {
            errs[`route_${i}`] = 'Destination required';
            return;
          }
          const c = validateCIDR(r.destination);
          if (c) errs[`route_${i}`] = c;
        });
        break;
      }
      case 'admin': {
        if (state.adminEnabled) {
          const a = validateAdminListen(state.adminListen);
          if (a) errs.adminListen = a;
        }
        break;
      }
    }
    return errs;
  }, [currentStep, state]);

  const goNext = useCallback(() => {
    const errs = validateCurrentStep();
    setStepErrors(errs);
    if (Object.keys(errs).length > 0) return;
    setStepIdx(i => Math.min(i + 1, ENTRY_STEPS.length - 1));
  }, [validateCurrentStep]);

  const goBack = useCallback(() => {
    setStepErrors({});
    setStepIdx(i => Math.max(i - 1, 0));
  }, []);

  const jumpTo = useCallback((i: number) => {
    setStepErrors({});
    setStepIdx(i);
  }, []);

  const onReviewStep = currentStep?.id === 'review';
  const yaml = useMemo(
    () => (onReviewStep ? buildEntryConfigYaml(state) : ''),
    [onReviewStep, state],
  );

  // Loopback dashboard URL shown on the review step. `adminListen` is already
  // in host:port form (IPv6 bracketed, e.g. [::1]:48088), so it's URL-ready.
  const adminUrl = useMemo(() => {
    const listen = state.adminListen.trim();
    return state.adminEnabled && listen ? `http://${listen}` : undefined;
  }, [state.adminEnabled, state.adminListen]);

  const handleDownload = useCallback(() => {
    const blob = new Blob([yaml], { type: 'text/yaml;charset=utf-8' });
    downloadBlob(blob, 'mutiauk.yaml');
    setDownloaded(true);
  }, [yaml]);

  const handleCopy = useCallback(async () => {
    if (!(await copyToClipboard(yaml))) return;
    setCopied(true);
    if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
    copiedTimerRef.current = setTimeout(() => setCopied(false), 1500);
  }, [yaml]);

  return (
    <WizardShell
      title="Generate Mutiauk config"
      steps={ENTRY_STEPS}
      stepIdx={stepIdx}
      onJumpTo={jumpTo}
      onBack={goBack}
      onNext={goNext}
      onClose={onClose}
    >
      {currentStep?.id === 'tun' && (
        <StepTun state={state} dispatch={dispatch} errors={stepErrors} />
      )}
      {currentStep?.id === 'socks5' && (
        <StepSocks5 state={state} dispatch={dispatch} errors={stepErrors} agents={socks5Agents} />
      )}
      {currentStep?.id === 'routes' && (
        <StepRoutes state={state} dispatch={dispatch} errors={stepErrors} />
      )}
      {currentStep?.id === 'admin' && (
        <StepAdmin state={state} dispatch={dispatch} errors={stepErrors} />
      )}
      {currentStep?.id === 'review' && (
        <StepReview
          yaml={yaml}
          adminUrl={adminUrl}
          onDownload={handleDownload}
          onCopy={handleCopy}
          downloaded={downloaded}
          copied={copied}
        />
      )}
    </WizardShell>
  );
}

// --- Step bodies ---

interface StepProps {
  state: EntryWizardState;
  dispatch: React.Dispatch<Action>;
  errors: Record<string, string>;
}

function StepTun({ state, dispatch, errors }: StepProps) {
  return (
    <>
      <h3 className="m-0 text-sm font-semibold">TUN interface</h3>
      <p className="text-muted m-0">
        Mutiauk creates a virtual network interface to capture traffic and forward it through a
        SOCKS5 proxy.
      </p>
      <Field
        label="IPv4 address (CIDR)"
        hint="e.g. 10.200.200.1/24. Pick a private range that doesn't collide with existing networks."
        error={errors.tunAddress}
      >
        <input
          className="input input-sm w-full font-mono"
          value={state.tunAddress}
          onChange={e => dispatch({ type: 'set', patch: { tunAddress: e.target.value } })}
          placeholder="10.200.200.1/24"
        />
      </Field>
    </>
  );
}

function StepSocks5({
  state,
  dispatch,
  errors,
  agents,
}: StepProps & { agents: TopologyAgentInfo[] }) {
  const selectedAgent = agents.find(a => a.socks5_addr === state.socks5Server);
  return (
    <>
      <h3 className="m-0 text-sm font-semibold">SOCKS5 proxy</h3>
      <p className="text-muted m-0">
        Entry forwards all captured traffic to a SOCKS5 endpoint exposed by a Muti Metroo agent. Pick an
        agent from the mesh, or enter an address manually.
      </p>

      {agents.length > 0 && (
        <Field
          label="Use SOCKS5 from mesh agent"
          hint="Selecting an agent fills in its SOCKS5 address below. You can still edit it."
        >
          <select
            className="select select-sm w-full font-mono"
            value={selectedAgent?.id ?? ''}
            onChange={e => {
              const a = agents.find(x => x.id === e.target.value);
              if (a) dispatch({ type: 'set', patch: { socks5Server: a.socks5_addr } });
            }}
          >
            <option value="">— pick an agent —</option>
            {agents.map(a => (
              <option key={a.id} value={a.id}>
                {a.display_name || a.short_id} ({a.socks5_addr})
              </option>
            ))}
          </select>
        </Field>
      )}

      <Field
        label="SOCKS5 server"
        hint="host:port (raw TCP) or ws[s]://host/path (WebSocket)."
        error={errors.socks5Server}
      >
        <input
          className="input input-sm w-full font-mono"
          value={state.socks5Server}
          onChange={e => dispatch({ type: 'set', patch: { socks5Server: e.target.value } })}
          placeholder="127.0.0.1:1080"
        />
      </Field>

      <Field
        label="Transport"
        hint="Pick TCP unless Entry has to traverse a network that only allows HTTP(S). WebSocket tunnels the SOCKS5 protocol inside a WebSocket upgrade — Muti Metroo-specific, not standard SOCKS5 — so the target agent must also be configured with WebSocket transport and the same path. Useful through corporate HTTPS proxies or CDN fronts; slightly higher latency than TCP."
      >
        <select
          className="select select-sm w-full font-mono"
          value={state.socks5Transport}
          onChange={e =>
            dispatch({
              type: 'set',
              patch: { socks5Transport: e.target.value as EntrySocks5Transport },
            })
          }
        >
          <option value="tcp">TCP (default)</option>
          <option value="websocket">WebSocket</option>
        </select>
      </Field>

      {state.socks5Transport === 'websocket' && (
        <Field
          label="WebSocket path"
          hint="Path on the agent's HTTP listener that accepts the WebSocket upgrade. Default /socks5. Must match the agent's socks5.ws_path config."
        >
          <input
            className="input input-sm w-full font-mono"
            value={state.socks5WSPath}
            onChange={e => dispatch({ type: 'set', patch: { socks5WSPath: e.target.value } })}
            placeholder="/socks5"
          />
        </Field>
      )}

      <label className="flex cursor-pointer items-start gap-2">
        <input
          type="checkbox"
          className="checkbox checkbox-sm checkbox-primary"
          checked={state.socks5AuthEnabled}
          onChange={e => dispatch({ type: 'set', patch: { socks5AuthEnabled: e.target.checked } })}
        />
        <span>SOCKS5 server requires authentication</span>
      </label>
      <div className="text-muted text-xs">
        Note: authentication is only supported with SOCKS5. SOCKS4/SOCKS4a connections do not use
        credentials.
      </div>

      {state.socks5AuthEnabled && (
        <>
          <Field label="Username" error={errors.socks5Username}>
            <input
              className="input input-sm w-full font-mono"
              value={state.socks5Username}
              onChange={e => dispatch({ type: 'set', patch: { socks5Username: e.target.value } })}
            />
          </Field>
          <Field label="Password">
            <input
              className="input input-sm w-full font-mono"
              type="password"
              autoComplete="new-password"
              value={state.socks5Password}
              onChange={e => dispatch({ type: 'set', patch: { socks5Password: e.target.value } })}
            />
          </Field>
        </>
      )}
    </>
  );
}

function StepRoutes({ state, dispatch, errors }: StepProps) {
  return (
    <>
      <h3 className="m-0 text-sm font-semibold">Routes</h3>
      <p className="text-muted m-0">
        Traffic destined for these CIDRs is captured by the TUN interface and forwarded through
        SOCKS5. Everything else uses your normal network stack.
      </p>

      <label className="flex cursor-pointer items-start gap-2">
        <input
          type="checkbox"
          className="checkbox checkbox-sm checkbox-primary"
          checked={state.autoroutesEnabled}
          onChange={e => dispatch({ type: 'set', patch: { autoroutesEnabled: e.target.checked } })}
        />
        <span>Fetch routes automatically from the mesh</span>
      </label>
      <div className="text-muted text-xs">
        Routes are pushed over the same SOCKS5 connection configured above — no separate dashboard
        URL or API token is needed. Add static routes below for destinations you want to capture
        regardless of what the mesh advertises.
      </div>

      <div className="flex items-center justify-between gap-2">
        <span className="font-semibold">Static routes</span>
      </div>

      {state.routes.length === 0 && (
        <div className="ui-empty">No routes yet. Add a row manually.</div>
      )}

      {state.routes.map((r, i) => (
        <div key={r._id} className="wizard-peer-row">
          <div className="flex items-center gap-1.5">
            <input
              type="checkbox"
              className="checkbox checkbox-sm checkbox-primary"
              checked={r.enabled}
              onChange={e =>
                dispatch({ type: 'setRoute', index: i, patch: { enabled: e.target.checked } })
              }
              title={r.enabled ? 'Enabled' : 'Disabled'}
            />
            <input
              className="input input-sm w-full font-mono"
              placeholder="10.0.0.0/8"
              value={r.destination}
              onChange={e =>
                dispatch({ type: 'setRoute', index: i, patch: { destination: e.target.value } })
              }
            />
            <button
              className="btn btn-sm btn-square btn-error btn-soft"
              type="button"
              onClick={() => dispatch({ type: 'removeRoute', index: i })}
              aria-label="Remove route"
              title="Remove route"
            >
              <span className="icon-[tabler--trash] size-3.5" aria-hidden="true" />
            </button>
          </div>
          <input
            className="input input-sm w-full font-mono"
            placeholder="comment (optional)"
            value={r.comment}
            onChange={e =>
              dispatch({ type: 'setRoute', index: i, patch: { comment: e.target.value } })
            }
          />
          {errors[`route_${i}`] && <div className="text-error text-xs">{errors[`route_${i}`]}</div>}
        </div>
      ))}

      <button
        className="btn btn-sm btn-primary btn-soft"
        type="button"
        onClick={() =>
          dispatch({
            type: 'addRoute',
            route: { _id: newRouteId(), destination: '', comment: '', enabled: true },
          })
        }
      >
        + Add route
      </button>
    </>
  );
}

function StepAdmin({ state, dispatch, errors }: StepProps) {
  return (
    <>
      <h3 className="m-0 text-sm font-semibold">Admin interface</h3>
      <p className="text-muted m-0">
        Mutiauk serves a local admin dashboard (daemon status, applied routes, exposed services)
        plus a JSON API. It is unauthenticated, so it must bind a loopback address and is never
        reachable from the network.
      </p>

      <label className="flex cursor-pointer items-start gap-2">
        <input
          type="checkbox"
          className="checkbox checkbox-sm checkbox-primary"
          checked={state.adminEnabled}
          onChange={e => dispatch({ type: 'set', patch: { adminEnabled: e.target.checked } })}
        />
        <span>Enable the local admin HTTP interface</span>
      </label>
      <div className="text-muted text-xs">
        Enabled by default. When on, browse to the listen address below on the host running Entry.
      </div>

      {state.adminEnabled && (
        <Field
          label="Listen address"
          hint="Loopback host:port only — e.g. 127.0.0.1:48088 or [::1]:48088. The interface is unauthenticated, so Mutiauk rejects non-loopback addresses."
          error={errors.adminListen}
        >
          <input
            className="input input-sm w-full font-mono"
            value={state.adminListen}
            onChange={e => dispatch({ type: 'set', patch: { adminListen: e.target.value } })}
            placeholder="127.0.0.1:48088"
          />
        </Field>
      )}
    </>
  );
}

function StepReview({
  yaml,
  adminUrl,
  onDownload,
  onCopy,
  downloaded,
  copied,
}: {
  yaml: string;
  adminUrl?: string;
  onDownload: () => void;
  onCopy: () => void;
  downloaded: boolean;
  copied: boolean;
}) {
  return (
    <>
      <h3 className="m-0 text-sm font-semibold">Review & download</h3>
      <p className="text-muted m-0">
        Save this to <code>/etc/mutiauk/config.yaml</code> on the target host, then run the
        binary directly or install it as a system service.
      </p>
      <div className="flex gap-2">
        <button className="btn btn-sm btn-primary" type="button" onClick={onDownload}>
          {downloaded ? 'Download again' : 'Download mutiauk.yaml'}
        </button>
        <button className="btn btn-sm btn-primary btn-soft" type="button" onClick={onCopy}>
          {copied ? 'Copied!' : 'Copy to clipboard'}
        </button>
      </div>
      <pre className="rounded-field border-hairline bg-base-200 m-0 max-h-[55vh] overflow-auto border p-3 font-mono text-xs leading-relaxed whitespace-pre">
        {yaml}
      </pre>
      <h4 className="mt-5 mb-1 text-xs font-semibold tracking-wide uppercase">Basic usage</h4>
      <p className="text-muted m-0">
        Drop the binary and config on the target host. Mutiauk creates a TUN interface (utun on
        macOS, Wintun on Windows), so it needs elevated privileges — root / CAP_NET_ADMIN on Linux
        and macOS, Administrator on Windows.
      </p>
      <pre className="rounded-field border-hairline bg-base-200 text-accent m-0 overflow-x-auto border p-3 font-mono text-xs leading-relaxed whitespace-pre">
        {[
          '# Linux / macOS — config at /etc/mutiauk/config.yaml',
          '# Run in the foreground (Ctrl+C to stop):',
          'sudo mutiauk daemon start -c /etc/mutiauk/config.yaml',
          '# Install as a service (systemd on Linux, launchd on macOS):',
          'sudo mutiauk -c /etc/mutiauk/config.yaml service install',
          '',
          '# Windows (run as Administrator) — config under %ProgramData%\\Mutiauk:',
          'mutiauk.exe daemon start -c "%ProgramData%\\Mutiauk\\config.yaml"',
          '# Install as a Windows service (SCM):',
          'mutiauk.exe -c "%ProgramData%\\Mutiauk\\config.yaml" service install',
        ].join('\n')}
      </pre>
      {adminUrl && (
        <p className="text-muted m-0">
          Once running, the local admin dashboard is at <code>{adminUrl}</code> (loopback only).
        </p>
      )}
    </>
  );
}

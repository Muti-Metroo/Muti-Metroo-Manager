import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import bcrypt from 'bcryptjs';
import type {
  PeerEntry,
  PeerTransport,
  SetupDefaultsResponse,
  TopologyAgentInfo,
  TopologyConnection,
} from '../../api/types';
import { PEER_TRANSPORTS, transportHasHttpPath } from '../../api/types';
import { getSetupDefaults, manageAgentPeers } from '../../api/client';
import { downloadBlob } from '../../util/download';
import { copyToClipboard } from '../../util/clipboard';
import { newLocalId } from '../../util/ids';
import { buildPeerCandidates, type PeerCandidate } from './peerCandidates';
import { useModalDismiss } from '../../hooks/useModalDismiss';
import WizardShell from '../wizard/WizardShell';
import { Field } from '../wizard/Field';
import { initialWizardState, ALL_STEPS } from './state';
import type { WizardState } from './state';
import { buildConfigYaml } from './yaml';
import {
  validateAdvertiseAddress,
  validateCIDR,
  validateHexKey,
  validateHostPort,
  validatePath,
  validatePem,
  validateX25519KeyPair,
  validateEd25519KeyPair,
} from '../../util/validate';

interface ConfigWizardProps {
  localAgent: TopologyAgentInfo;
  // Full topology — used to surface every mesh member that advertises
  // a dial-target listener, not just direct peers of the local agent.
  agents: readonly TopologyAgentInfo[];
  // Connection list, used to derive a true "alive in the mesh" flag —
  // `agent.is_connected` is local-centric and would mark every transit-
  // reachable agent as offline.
  connections: readonly TopologyConnection[];
  onClose: () => void;
}

type Action =
  | { type: 'set'; patch: Partial<WizardState> }
  | { type: 'setPeer'; index: number; patch: Partial<WizardState['peers'][number]> }
  | { type: 'addPeer'; peer: WizardState['peers'][number] }
  | { type: 'removePeer'; index: number }
  | { type: 'setExitRoute'; index: number; value: string }
  | { type: 'addExitRoute' }
  | { type: 'removeExitRoute'; index: number }
  | { type: 'seed'; seed: Partial<WizardState> };

function reducer(state: WizardState, action: Action): WizardState {
  switch (action.type) {
    case 'set':
      return { ...state, ...action.patch };
    case 'setPeer': {
      const peers = state.peers.map((p, i) => (i === action.index ? { ...p, ...action.patch } : p));
      return { ...state, peers };
    }
    case 'addPeer':
      return { ...state, peers: [...state.peers, action.peer] };
    case 'removePeer':
      return { ...state, peers: state.peers.filter((_, i) => i !== action.index) };
    case 'setExitRoute': {
      const exitRoutes = state.exitRoutes.map((r, i) => (i === action.index ? action.value : r));
      return { ...state, exitRoutes };
    }
    case 'addExitRoute':
      return { ...state, exitRoutes: [...state.exitRoutes, ''] };
    case 'removeExitRoute':
      return { ...state, exitRoutes: state.exitRoutes.filter((_, i) => i !== action.index) };
    case 'seed':
      return { ...state, ...action.seed };
  }
}

function blankPeer(): WizardState['peers'][number] {
  return { _id: newLocalId('peer'), transport: 'quic', address: '', path: '', expectedId: '' };
}

export default function ConfigWizard({
  localAgent,
  agents,
  connections,
  onClose,
}: ConfigWizardProps) {
  const [state, dispatch] = useReducer(reducer, null, initialWizardState);
  const [stepIdx, setStepIdx] = useState(0);
  const [defaults, setDefaults] = useState<SetupDefaultsResponse | null>(null);
  const [defaultsLoaded, setDefaultsLoaded] = useState(false);
  const [defaultsError, setDefaultsError] = useState<string | null>(null);
  const [outboundPeers, setOutboundPeers] = useState<PeerEntry[]>([]);
  const [peersError, setPeersError] = useState<string | null>(null);
  const [stepErrors, setStepErrors] = useState<Record<string, string>>({});
  const [downloaded, setDownloaded] = useState(false);
  const [copied, setCopied] = useState(false);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const currentStep = ALL_STEPS[Math.min(stepIdx, ALL_STEPS.length - 1)];

  useModalDismiss({ onClose });

  useEffect(() => {
    let cancelled = false;

    Promise.allSettled([
      getSetupDefaults(),
      manageAgentPeers(localAgent.id, localAgent.is_local, { action: 'list' }),
    ]).then(([defaultsResult, peersResult]) => {
      if (cancelled) return;

      if (defaultsResult.status === 'fulfilled') {
        const d = defaultsResult.value;
        setDefaults(d);
        if (d) {
          const seed: Partial<WizardState> = {};
          if (d.listener?.transport) {
            seed.listenerEnabled = true;
            seed.listenerTransport = d.listener.transport as PeerTransport;
            if (d.listener.address) seed.listenAddress = d.listener.address;
            if (d.listener.path) seed.listenPath = d.listener.path;
            seed.listenPlaintext = !!d.listener.plaintext;
          } else if (d.listener) {
            // Local agent has no listener configured — default to outbound-only.
            seed.listenerEnabled = false;
          }
          if (d.tls?.strict && d.tls.ca_pem) {
            seed.tlsMode = 'strict';
            seed.caPem = d.tls.ca_pem;
            seed.tlsStrict = true;
            seed.tlsMtls = !!d.tls.mtls;
          }
          if (d.management?.enabled && d.management.public_key) {
            seed.mgmtMode = 'public_only';
            seed.mgmtPublicKey = d.management.public_key;
            if (d.management.signing_public_key) {
              seed.mgmtSigningPublicKey = d.management.signing_public_key;
            }
          }
          // Don't auto-enable HTTP API on the new agent, but carry a token hash
          // through so it's ready if the operator toggles HTTP on.
          if (d.http?.token_hash) seed.httpTokenHash = d.http.token_hash;
          // Shell/file whitelists and allowed paths are OS-specific (e.g., Linux
          // paths won't match a Windows target), so we don't seed those.
          dispatch({ type: 'seed', seed });
        }
      } else {
        const err = defaultsResult.reason;
        setDefaultsError(
          err instanceof Error ? err.message : 'Could not load defaults from the local agent',
        );
      }
      setDefaultsLoaded(true);

      if (peersResult.status === 'fulfilled') {
        // Pass the full outbound peer list through to the candidate
        // builder; filtering by connectivity / direction lives there
        // alongside the topology-derived rules.
        const list = (peersResult.value.peers || []).filter(p => p.direction !== 'inbound');
        setOutboundPeers(list);
      } else {
        const err = peersResult.reason;
        setPeersError(err instanceof Error ? err.message : 'Could not load peer list');
      }
    });
    return () => {
      cancelled = true;
    };
  }, [localAgent.id, localAgent.is_local]);

  useEffect(
    () => () => {
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
    },
    [],
  );

  const validateCurrentStep = useCallback((): Record<string, string> => {
    const errs: Record<string, string> = {};
    switch (currentStep?.id) {
      case 'basic':
        break;
      case 'network': {
        if (state.listenerEnabled) {
          const addr = validateHostPort(state.listenAddress, { allowEmptyHost: true });
          if (addr) errs.listenAddress = addr;
          if (transportHasHttpPath(state.listenerTransport)) {
            const p = validatePath(state.listenPath);
            if (p) errs.listenPath = p;
          }
          if (state.advertiseEnabled) {
            const a = validateAdvertiseAddress(state.advertiseAddress);
            if (a) errs.advertiseAddress = a;
          }
        }
        break;
      }
      case 'tls':
        if (state.tlsMode === 'strict') {
          const ca = validatePem(state.caPem, 'CERTIFICATE');
          if (ca) errs.caPem = ca;
        }
        break;
      case 'peers':
        state.peers.forEach((p, i) => {
          if (!p.address.trim()) {
            errs[`peer_${i}_address`] = 'Address is required';
            return;
          }
          const a = validateHostPort(p.address);
          if (a) errs[`peer_${i}_address`] = a;
          if (transportHasHttpPath(p.transport) && p.path.trim()) {
            const pe = validatePath(p.path);
            if (pe) errs[`peer_${i}_path`] = pe;
          }
          if (p.expectedId.trim()) {
            const id = validateHexKey(p.expectedId, 64);
            if (id) errs[`peer_${i}_id`] = id;
          }
        });
        break;
      case 'socks5':
        if (state.socks5Enabled) {
          const a = validateHostPort(state.socks5Address);
          if (a) errs.socks5Address = a;
        }
        break;
      case 'exit':
        if (state.exitEnabled) {
          state.exitRoutes.forEach((r, i) => {
            if (!r.trim()) {
              errs[`route_${i}`] = 'CIDR is required';
              return;
            }
            const c = validateCIDR(r);
            if (c) errs[`route_${i}`] = c;
          });
          if (state.exitRoutes.length === 0) {
            errs.exitRoutes = 'Add at least one CIDR or disable exit';
          }
        }
        break;
      case 'monitoring':
        if (state.httpEnabled) {
          const a = validateHostPort(state.httpAddress, { allowEmptyHost: true });
          if (a) errs.httpAddress = a;
        }
        break;
      case 'management':
        if (state.mgmtMode === 'public_only' || state.mgmtMode === 'operator') {
          const pk = validateHexKey(state.mgmtPublicKey, 64);
          if (pk) errs.mgmtPublicKey = pk;
          if (state.mgmtSigningPublicKey.trim()) {
            const spk = validateHexKey(state.mgmtSigningPublicKey, 64);
            if (spk) errs.mgmtSigningPublicKey = spk;
          }
        }
        if (state.mgmtMode === 'operator') {
          const sk = validateHexKey(state.mgmtPrivateKey, 64);
          if (sk) {
            errs.mgmtPrivateKey = sk;
          } else if (!errs.mgmtPublicKey) {
            // Both keys parse as hex of the right length — make sure they
            // actually pair. The mesh assumes a single management keypair;
            // a mismatch here means this agent will be unable to decrypt
            // topology even though configuration looks valid on paper.
            const pair = validateX25519KeyPair(state.mgmtPrivateKey, state.mgmtPublicKey);
            if (pair) errs.mgmtPrivateKey = pair;
          }
          if (state.mgmtSigningPrivateKey.trim()) {
            const ssk = validateHexKey(state.mgmtSigningPrivateKey, 128);
            if (ssk) {
              errs.mgmtSigningPrivateKey = ssk;
            } else if (state.mgmtSigningPublicKey.trim() && !errs.mgmtSigningPublicKey) {
              const pair = validateEd25519KeyPair(
                state.mgmtSigningPrivateKey,
                state.mgmtSigningPublicKey,
              );
              if (pair) errs.mgmtSigningPrivateKey = pair;
            }
          }
          if (!state.mgmtAcknowledged) {
            errs.mgmtAcknowledged = 'Please acknowledge before continuing';
          }
        }
        break;
    }
    return errs;
  }, [currentStep, state]);

  const goNext = useCallback(() => {
    const errs = validateCurrentStep();
    setStepErrors(errs);
    if (Object.keys(errs).length > 0) return;
    setStepIdx(idx => Math.min(idx + 1, ALL_STEPS.length - 1));
  }, [validateCurrentStep]);

  const goBack = useCallback(() => {
    setStepErrors({});
    setStepIdx(idx => Math.max(idx - 1, 0));
  }, []);

  const jumpTo = useCallback((idx: number) => {
    setStepErrors({});
    setStepIdx(idx);
  }, []);

  const onReviewStep = currentStep?.id === 'review';
  const yaml = useMemo(() => (onReviewStep ? buildConfigYaml(state) : ''), [onReviewStep, state]);

  const handleDownload = useCallback(() => {
    const blob = new Blob([yaml], { type: 'text/yaml;charset=utf-8' });
    const slug =
      state.displayName
        .trim()
        .replace(/[^A-Za-z0-9_-]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'muti-metroo';
    downloadBlob(blob, `${slug}.yaml`);
    setDownloaded(true);
  }, [yaml, state.displayName]);

  const handleCopy = useCallback(async () => {
    if (!(await copyToClipboard(yaml))) return;
    setCopied(true);
    if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
    copiedTimerRef.current = setTimeout(() => setCopied(false), 1500);
  }, [yaml]);

  const usePeer = useCallback((c: PeerCandidate) => {
    dispatch({
      type: 'addPeer',
      peer: {
        _id: newLocalId('peer'),
        transport: c.transport,
        address: c.address,
        path: c.path,
        expectedId: c.expectedId,
      },
    });
  }, []);

  const availablePeers = useMemo(
    () => buildPeerCandidates(agents, outboundPeers, connections),
    [agents, outboundPeers, connections],
  );

  // Agent ids the operator has already added on the right side. Used to
  // disable the corresponding "Use" button so re-clicking can't add the
  // same agent twice.
  const selectedAgentIds = useMemo(
    () => new Set(state.peers.map(p => p.expectedId.trim().toLowerCase()).filter(Boolean)),
    [state.peers],
  );

  return (
    <WizardShell
      title="Generate Muti Metroo agent config"
      steps={ALL_STEPS}
      stepIdx={stepIdx}
      onJumpTo={jumpTo}
      onBack={goBack}
      onNext={goNext}
      onClose={onClose}
      banner={
        defaultsLoaded && !defaults ? (
          <div className="alert alert-warning alert-soft rounded-none border-x-0 border-t-0">
            {defaultsError
              ? `Could not load defaults from the local agent (${defaultsError}). Paste TLS and management key values manually where needed.`
              : 'This agent does not expose setup defaults. TLS and management key fields are not auto-seeded — paste them manually if your mesh uses them.'}
          </div>
        ) : null
      }
    >
      {currentStep?.id === 'basic' && (
        <StepBasic state={state} dispatch={dispatch} errors={stepErrors} />
      )}
      {currentStep?.id === 'network' && (
        <StepNetwork state={state} dispatch={dispatch} errors={stepErrors} />
      )}
      {currentStep?.id === 'tls' && (
        <StepTls state={state} dispatch={dispatch} errors={stepErrors} defaults={defaults} />
      )}
      {currentStep?.id === 'peers' && (
        <StepPeers
          state={state}
          dispatch={dispatch}
          errors={stepErrors}
          availablePeers={availablePeers}
          peersError={peersError}
          selectedAgentIds={selectedAgentIds}
          onUsePeer={usePeer}
        />
      )}
      {currentStep?.id === 'socks5' && (
        <StepSocks5 state={state} dispatch={dispatch} errors={stepErrors} />
      )}
      {currentStep?.id === 'exit' && (
        <StepExit state={state} dispatch={dispatch} errors={stepErrors} />
      )}
      {currentStep?.id === 'monitoring' && (
        <StepMonitoring state={state} dispatch={dispatch} errors={stepErrors} defaults={defaults} />
      )}
      {currentStep?.id === 'shell' && (
        <StepShell state={state} dispatch={dispatch} errors={stepErrors} />
      )}
      {currentStep?.id === 'files' && (
        <StepFiles state={state} dispatch={dispatch} errors={stepErrors} />
      )}
      {currentStep?.id === 'management' && (
        <StepManagement state={state} dispatch={dispatch} errors={stepErrors} defaults={defaults} />
      )}
      {currentStep?.id === 'review' && (
        <StepReview
          yaml={yaml}
          onDownload={handleDownload}
          onCopy={handleCopy}
          downloaded={downloaded}
          copied={copied}
        />
      )}
    </WizardShell>
  );
}

// --- Step components ---

interface StepProps {
  state: WizardState;
  dispatch: React.Dispatch<Action>;
  errors: Record<string, string>;
}

function StepBasic({ state, dispatch }: StepProps) {
  return (
    <>
      <h3 className="m-0 text-sm font-semibold">Basics</h3>
      <p className="text-muted m-0">
        This config is for a new agent you'll deploy. Its identity keypair is generated on first run
        — no private material is embedded here.
      </p>
      <Field
        label="Display name (optional)"
        hint="Shown in topology maps. Leave blank to use the agent ID."
      >
        <input
          className="input input-sm w-full font-mono"
          value={state.displayName}
          onChange={e => dispatch({ type: 'set', patch: { displayName: e.target.value } })}
          placeholder="e.g. edge-frankfurt"
        />
      </Field>
    </>
  );
}

function StepNetwork({ state, dispatch, errors }: StepProps) {
  const hasHttpPath = transportHasHttpPath(state.listenerTransport);
  return (
    <>
      <h3 className="m-0 text-sm font-semibold">Network</h3>
      <p className="text-muted m-0">
        Configure a listener if other agents should dial into this one. Pure outbound-only agents
        (field nodes that only dial their peers) can skip this.
      </p>
      <label className="flex cursor-pointer items-start gap-2">
        <input
          type="checkbox"
          className="checkbox checkbox-sm checkbox-primary"
          checked={state.listenerEnabled}
          onChange={e => dispatch({ type: 'set', patch: { listenerEnabled: e.target.checked } })}
        />
        <span>Listen for incoming connections</span>
      </label>
      {state.listenerEnabled && (
        <>
          <Field label="Transport">
            <select
              className="select select-sm w-full font-mono"
              value={state.listenerTransport}
              onChange={e =>
                dispatch({
                  type: 'set',
                  patch: { listenerTransport: e.target.value as PeerTransport },
                })
              }
            >
              {PEER_TRANSPORTS.map(t => (
                <option key={t} value={t}>
                  {t.toUpperCase()}
                </option>
              ))}
            </select>
          </Field>
          <Field
            label="Listen address"
            hint="host:port — use 0.0.0.0 for all interfaces."
            error={errors.listenAddress}
          >
            <input
              className="input input-sm w-full font-mono"
              value={state.listenAddress}
              onChange={e => dispatch({ type: 'set', patch: { listenAddress: e.target.value } })}
              placeholder="0.0.0.0:4433"
            />
          </Field>
          {hasHttpPath && (
            <Field
              label="HTTP path"
              hint="Path the listener accepts. Default /mesh; must match what peers dial."
              error={errors.listenPath}
            >
              <input
                className="input input-sm w-full font-mono"
                value={state.listenPath}
                onChange={e => dispatch({ type: 'set', patch: { listenPath: e.target.value } })}
                placeholder="/mesh"
              />
            </Field>
          )}
          <label className="flex cursor-pointer items-start gap-2">
            <input
              type="checkbox"
              className="checkbox checkbox-sm checkbox-primary"
              checked={state.advertiseEnabled}
              onChange={e =>
                dispatch({ type: 'set', patch: { advertiseEnabled: e.target.checked } })
              }
            />
            <span>Advertise this listener as a public dial target</span>
          </label>
          {state.advertiseEnabled && (
            <Field
              label="Public address"
              hint="host:port other agents will dial. Often differs from the listen address — e.g. listen on 0.0.0.0:4433 but advertise example.com:4433. Skip if this agent sits behind NAT you can't reach from outside."
              error={errors.advertiseAddress}
            >
              <input
                className="input input-sm w-full font-mono"
                value={state.advertiseAddress}
                onChange={e =>
                  dispatch({ type: 'set', patch: { advertiseAddress: e.target.value } })
                }
                placeholder="example.com:4433"
              />
            </Field>
          )}
        </>
      )}
    </>
  );
}

function StepTls({
  state,
  dispatch,
  errors,
  defaults,
}: StepProps & { defaults: SetupDefaultsResponse | null }) {
  const hasSeededCa = !!defaults?.tls?.ca_pem;
  return (
    <>
      <h3 className="m-0 text-sm font-semibold">TLS</h3>
      <p className="text-muted m-0">
        Muti Metroo adds an E2E encryption layer on top of TLS, so self-signed certs are secure.
        Strict TLS with a shared CA is optional hardening.
      </p>
      <div className="flex flex-col gap-2">
        <label className="flex cursor-pointer items-start gap-2">
          <input
            type="radio"
            className="radio radio-sm radio-primary"
            checked={state.tlsMode === 'self_signed'}
            onChange={() =>
              dispatch({
                type: 'set',
                patch: { tlsMode: 'self_signed', tlsStrict: false, tlsMtls: false },
              })
            }
          />
          <span>
            <strong>Self-signed</strong> — the new agent generates its own cert at startup. Easiest.
          </span>
        </label>
        <label className="flex cursor-pointer items-start gap-2">
          <input
            type="radio"
            className="radio radio-sm radio-primary"
            checked={state.tlsMode === 'strict'}
            onChange={() =>
              dispatch({ type: 'set', patch: { tlsMode: 'strict', tlsStrict: true } })
            }
          />
          <span>
            <strong>Strict TLS with a shared CA</strong> — peers must present CA-signed certs.
          </span>
        </label>
      </div>

      {state.tlsMode === 'strict' && (
        <>
          <Field
            label="CA certificate (PEM)"
            hint={
              hasSeededCa
                ? 'Seeded from the local agent — edit if you need a different CA.'
                : 'Paste the mesh CA certificate the new agent should trust.'
            }
            error={errors.caPem}
          >
            <textarea
              className="textarea textarea-sm w-full resize-y font-mono"
              rows={6}
              value={state.caPem}
              onChange={e => dispatch({ type: 'set', patch: { caPem: e.target.value } })}
              placeholder="-----BEGIN CERTIFICATE-----&#10;...&#10;-----END CERTIFICATE-----"
            />
          </Field>
          {hasSeededCa && state.caPem === defaults?.tls?.ca_pem && (
            <div className="badge badge-sm badge-soft badge-success self-start">
              Seeded from local agent
            </div>
          )}
        </>
      )}
    </>
  );
}

function StepPeers({
  state,
  dispatch,
  errors,
  availablePeers,
  peersError,
  selectedAgentIds,
  onUsePeer,
}: StepProps & {
  availablePeers: PeerCandidate[];
  peersError: string | null;
  selectedAgentIds: ReadonlySet<string>;
  onUsePeer: (c: PeerCandidate) => void;
}) {
  return (
    <>
      <h3 className="m-0 text-sm font-semibold">Peers</h3>
      <p className="text-muted m-0">
        Configure which agents the new node dials on startup. Pick a candidate from the left (every
        mesh member that advertises a dial-target listener, plus this agent's outbound peers), or
        add a row manually on the right.
      </p>
      <div className="wizard-peer-picker">
        <div className="flex min-w-0 flex-col gap-2">
          <div className="text-muted text-xs font-semibold tracking-wide uppercase">
            Available dial targets
          </div>
          {peersError && <div className="ui-error">{peersError}</div>}
          {!peersError && availablePeers.length === 0 && (
            <div className="ui-empty">
              No advertised listeners visible in the mesh, and no outbound peers on this agent.
            </div>
          )}
          {availablePeers.map(p => {
            const key = `${p.source}-${p.expectedId || p.address}-${p.transport}-${p.path}`;
            const idShort = p.expectedId ? p.expectedId.slice(0, 8) : '';
            const alreadySelected =
              !!p.expectedId && selectedAgentIds.has(p.expectedId.toLowerCase());
            const rowCls = ['wizard-peer-available-row'];
            if (!p.connected) rowCls.push('wizard-peer-available-row-offline');
            if (alreadySelected) rowCls.push('wizard-peer-available-row-selected');
            return (
              <div className={rowCls.join(' ')} key={key}>
                <div className="min-w-0 flex-1">
                  <div className="font-mono break-all">
                    {p.displayName ? `${p.displayName} — ` : ''}
                    {p.address}
                    {p.path}
                  </div>
                  <div className="text-muted flex flex-wrap items-center gap-1.5 text-xs">
                    <span>{p.transport}</span>
                    {idShort && <span>· {idShort}</span>}
                    {!p.connected && <span className="text-warning italic">offline</span>}
                  </div>
                </div>
                <button
                  className="btn btn-sm btn-primary btn-soft"
                  type="button"
                  onClick={() => onUsePeer(p)}
                  disabled={alreadySelected}
                >
                  {alreadySelected ? 'Added' : 'Use'}
                </button>
              </div>
            );
          })}
        </div>
        <div className="flex min-w-0 flex-col gap-2">
          <div className="text-muted text-xs font-semibold tracking-wide uppercase">
            Peers to include in the generated config
          </div>
          {state.peers.length === 0 && (
            <div className="ui-empty">
              No peers yet. Add one from the left, or start with an empty row.
            </div>
          )}
          {state.peers.map((p, i) => (
            <PeerRow
              key={p._id}
              peer={p}
              index={i}
              errors={errors}
              onChange={patch => dispatch({ type: 'setPeer', index: i, patch })}
              onRemove={() => dispatch({ type: 'removePeer', index: i })}
            />
          ))}
          <button
            className="btn btn-sm btn-primary btn-soft"
            type="button"
            onClick={() => dispatch({ type: 'addPeer', peer: blankPeer() })}
          >
            + Add empty peer row
          </button>
        </div>
      </div>
    </>
  );
}

function PeerRow({
  peer,
  index,
  errors,
  onChange,
  onRemove,
}: {
  peer: WizardState['peers'][number];
  index: number;
  errors: Record<string, string>;
  onChange: (patch: Partial<WizardState['peers'][number]>) => void;
  onRemove: () => void;
}) {
  const hasHttpPath = transportHasHttpPath(peer.transport);
  return (
    <div className="wizard-peer-row">
      <div className="flex items-center gap-1.5">
        <select
          className="select select-sm font-mono w-20 shrink-0"
          value={peer.transport}
          onChange={e => onChange({ transport: e.target.value as PeerTransport })}
        >
          {PEER_TRANSPORTS.map(t => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <input
          className="input input-sm w-full font-mono"
          placeholder="host:port"
          value={peer.address}
          onChange={e => onChange({ address: e.target.value })}
        />
        <button
          className="btn btn-sm btn-square btn-error btn-soft"
          type="button"
          onClick={onRemove}
          aria-label="Remove peer"
          title="Remove peer"
        >
          <span className="icon-[tabler--trash] size-3.5" aria-hidden="true" />
        </button>
      </div>
      {hasHttpPath && (
        <input
          className="input input-sm w-full font-mono"
          placeholder="/mesh (HTTP path)"
          value={peer.path}
          onChange={e => onChange({ path: e.target.value })}
        />
      )}
      <input
        className="input input-sm w-full font-mono"
        placeholder="expected agent id (64-char hex, optional)"
        value={peer.expectedId}
        onChange={e => onChange({ expectedId: e.target.value })}
      />
      {errors[`peer_${index}_address`] && (
        <div className="text-error text-xs">{errors[`peer_${index}_address`]}</div>
      )}
      {errors[`peer_${index}_path`] && (
        <div className="text-error text-xs">{errors[`peer_${index}_path`]}</div>
      )}
      {errors[`peer_${index}_id`] && (
        <div className="text-error text-xs">{errors[`peer_${index}_id`]}</div>
      )}
    </div>
  );
}

function StepSocks5({ state, dispatch, errors }: StepProps) {
  return (
    <>
      <h3 className="m-0 text-sm font-semibold">SOCKS4/5 proxy</h3>
      <p className="text-muted m-0">
        Clients connect here to send traffic into the mesh. Supports SOCKS4, SOCKS4a, and SOCKS5.
      </p>
      <label className="flex cursor-pointer items-start gap-2">
        <input
          type="checkbox"
          className="checkbox checkbox-sm checkbox-primary"
          checked={state.socks5Enabled}
          onChange={e => dispatch({ type: 'set', patch: { socks5Enabled: e.target.checked } })}
        />
        <span>Enable SOCKS4/5 listener</span>
      </label>
      {state.socks5Enabled && (
        <Field label="Listen address" error={errors.socks5Address}>
          <input
            className="input input-sm w-full font-mono"
            value={state.socks5Address}
            onChange={e => dispatch({ type: 'set', patch: { socks5Address: e.target.value } })}
            placeholder="127.0.0.1:1080"
          />
        </Field>
      )}
    </>
  );
}

function StepExit({ state, dispatch, errors }: StepProps) {
  return (
    <>
      <h3 className="m-0 text-sm font-semibold">Exit routes</h3>
      <p className="text-muted m-0">CIDR networks this node advertises as an exit destination.</p>
      <label className="flex cursor-pointer items-start gap-2">
        <input
          type="checkbox"
          className="checkbox checkbox-sm checkbox-primary"
          checked={state.exitEnabled}
          onChange={e => dispatch({ type: 'set', patch: { exitEnabled: e.target.checked } })}
        />
        <span>Enable exit</span>
      </label>
      {state.exitEnabled && (
        <>
          {state.exitRoutes.map((r, i) => (
            <div className="flex flex-wrap items-center gap-1.5" key={i}>
              <input
                className="input input-sm w-full font-mono"
                value={r}
                placeholder="10.0.0.0/8"
                onChange={e => dispatch({ type: 'setExitRoute', index: i, value: e.target.value })}
              />
              <button
                className="btn btn-sm btn-square btn-error btn-soft"
                type="button"
                onClick={() => dispatch({ type: 'removeExitRoute', index: i })}
                aria-label="Remove CIDR"
                title="Remove CIDR"
              >
                <span className="icon-[tabler--trash] size-3.5" aria-hidden="true" />
              </button>
              {errors[`route_${i}`] && (
                <div className="text-error text-xs">{errors[`route_${i}`]}</div>
              )}
            </div>
          ))}
          <button
            className="btn btn-sm btn-primary btn-soft"
            type="button"
            onClick={() => dispatch({ type: 'addExitRoute' })}
          >
            + Add CIDR
          </button>
          {errors.exitRoutes && <div className="ui-error">{errors.exitRoutes}</div>}
        </>
      )}
    </>
  );
}

function StepMonitoring({
  state,
  dispatch,
  errors,
  defaults,
}: StepProps & { defaults: SetupDefaultsResponse | null }) {
  const seededHash = defaults?.http?.token_hash || '';
  const tokenMatchesSeed = !!seededHash && state.httpTokenHash === seededHash;
  const [tokenPassword, setTokenPassword] = useState('');
  const [hashing, setHashing] = useState(false);

  const hashFromPassword = useCallback(async () => {
    const pwd = tokenPassword.trim();
    if (!pwd) return;
    setHashing(true);
    // bcryptjs is synchronous CPU work wrapped in an awaitable; yield a frame so
    // React flushes the "Hashing…" state before the 100–300ms block starts.
    await new Promise(requestAnimationFrame);
    const hash = await bcrypt.hash(pwd, 10);
    dispatch({ type: 'set', patch: { httpTokenHash: hash } });
    setTokenPassword('');
    setHashing(false);
  }, [tokenPassword, dispatch]);

  return (
    <>
      <h3 className="m-0 text-sm font-semibold">Monitoring & HTTP API</h3>
      <label className="flex cursor-pointer items-start gap-2">
        <input
          type="checkbox"
          className="checkbox checkbox-sm checkbox-primary"
          checked={state.httpEnabled}
          onChange={e => dispatch({ type: 'set', patch: { httpEnabled: e.target.checked } })}
        />
        <span>Enable HTTP management API</span>
      </label>
      {state.httpEnabled && (
        <>
          <Field label="HTTP listen address" error={errors.httpAddress}>
            <input
              className="input input-sm w-full font-mono"
              value={state.httpAddress}
              onChange={e => dispatch({ type: 'set', patch: { httpAddress: e.target.value } })}
              placeholder=":8080"
            />
          </Field>
          <Field
            label="Hash a bearer token"
            hint="Type the plaintext bearer token and click Hash. The bcrypt hash is computed in your browser and written to the field below; clients (muti-metroo CLI, Mutiauk) send the plaintext you typed here."
          >
            <div className="flex flex-wrap items-center gap-1.5">
              <input
                className="input input-sm w-full font-mono"
                type="password"
                value={tokenPassword}
                onChange={e => setTokenPassword(e.target.value)}
                placeholder="bearer token"
                autoComplete="new-password"
                onKeyDown={e =>
                  e.key === 'Enter' && !hashing && tokenPassword.trim() && hashFromPassword()
                }
              />
              <button
                type="button"
                className="btn btn-sm btn-primary btn-soft"
                onClick={hashFromPassword}
                disabled={hashing || !tokenPassword.trim()}
              >
                {hashing ? 'Hashing…' : 'Hash'}
              </button>
            </div>
          </Field>
          <Field
            label="API bearer token hash"
            hint={
              tokenMatchesSeed
                ? 'Seeded from local agent. Rotate here if you want the new agent to use a different token.'
                : 'bcrypt hash of the plaintext bearer token clients will send. Leave blank to disable authentication; use the field above or paste a hash from `muti-metroo hash`.'
            }
          >
            <input
              className="input input-sm w-full font-mono"
              value={state.httpTokenHash}
              onChange={e => dispatch({ type: 'set', patch: { httpTokenHash: e.target.value } })}
              placeholder="$2a$10$..."
            />
          </Field>
          {tokenMatchesSeed && (
            <div className="badge badge-sm badge-soft badge-success self-start">
              Seeded from local agent
            </div>
          )}
        </>
      )}
    </>
  );
}

function ToggleStep({
  heading,
  description,
  label,
  checked,
  onChange,
}: {
  heading: string;
  description: string;
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <>
      <h3 className="m-0 text-sm font-semibold">{heading}</h3>
      <p className="text-muted m-0">{description}</p>
      <label className="flex cursor-pointer items-start gap-2">
        <input
          type="checkbox"
          className="checkbox checkbox-sm checkbox-primary"
          checked={checked}
          onChange={e => onChange(e.target.checked)}
        />
        <span>{label}</span>
      </label>
    </>
  );
}

function StepShell({ state, dispatch }: StepProps) {
  return (
    <ToggleStep
      heading="Remote shell"
      description={
        'Enables the shell tab in Muti Metroo Manager for this agent. The generated config allows all commands ("*"); edit the whitelist in the downloaded YAML to restrict to specific binaries for the target platform.'
      }
      label="Enable remote shell"
      checked={state.shellEnabled}
      onChange={v => dispatch({ type: 'set', patch: { shellEnabled: v } })}
    />
  );
}

function StepFiles({ state, dispatch }: StepProps) {
  return (
    <ToggleStep
      heading="File transfer"
      description="Enables upload/download of files via Muti Metroo Manager. The generated config allows all paths; edit allowed_paths in the downloaded YAML to restrict access to paths valid on the target platform."
      label="Enable file transfer"
      checked={state.fileTransferEnabled}
      onChange={v => dispatch({ type: 'set', patch: { fileTransferEnabled: v } })}
    />
  );
}

function StepManagement({
  state,
  dispatch,
  errors,
  defaults,
}: StepProps & { defaults: SetupDefaultsResponse | null }) {
  const seededPub = defaults?.management?.public_key || '';
  const seededSigningPub = defaults?.management?.signing_public_key || '';
  const seededMatches = !!seededPub && state.mgmtPublicKey === seededPub;
  const seededSigningMatches =
    !!seededSigningPub && state.mgmtSigningPublicKey === seededSigningPub;
  return (
    <>
      <h3 className="m-0 text-sm font-semibold">Management key</h3>
      <p className="text-muted m-0">
        Two keypairs control the management surface. The encryption keypair hides topology from
        non-operators. The signing keypair authorises privileged operations (remote shell, file
        transfer, dynamic route/peer/forward mutations). Every node in the mesh should share the
        same public keys.
      </p>
      <div className="flex flex-col gap-2">
        <label className="flex cursor-pointer items-start gap-2">
          <input
            type="radio"
            className="radio radio-sm radio-primary"
            checked={state.mgmtMode === 'none'}
            onChange={() => dispatch({ type: 'set', patch: { mgmtMode: 'none' } })}
          />
          <span>None — no management encryption or signing</span>
        </label>
        <label className="flex cursor-pointer items-start gap-2">
          <input
            type="radio"
            className="radio radio-sm radio-primary"
            checked={state.mgmtMode === 'public_only'}
            onChange={() =>
              dispatch({
                type: 'set',
                patch: {
                  mgmtMode: 'public_only',
                  mgmtPublicKey: state.mgmtPublicKey || seededPub,
                  mgmtSigningPublicKey: state.mgmtSigningPublicKey || seededSigningPub,
                },
              })
            }
          />
          <span>
            <strong>Public keys only</strong> — field agent (can't decrypt topology, accepts signed
            requests)
          </span>
        </label>
        <label className="flex cursor-pointer items-start gap-2">
          <input
            type="radio"
            className="radio radio-sm radio-primary"
            checked={state.mgmtMode === 'operator'}
            onChange={() =>
              dispatch({
                type: 'set',
                patch: {
                  mgmtMode: 'operator',
                  mgmtPublicKey: state.mgmtPublicKey || seededPub,
                  mgmtSigningPublicKey: state.mgmtSigningPublicKey || seededSigningPub,
                },
              })
            }
          />
          <span>
            <strong>Operator</strong> — includes both private keys: decrypts topology and signs
            privileged requests
          </span>
        </label>
      </div>

      {(state.mgmtMode === 'public_only' || state.mgmtMode === 'operator') && (
        <>
          <Field
            label="Management public key (64 hex chars)"
            error={errors.mgmtPublicKey}
            hint={seededMatches ? undefined : 'Shared across all agents in the mesh.'}
          >
            <input
              className="input input-sm w-full font-mono"
              value={state.mgmtPublicKey}
              onChange={e => dispatch({ type: 'set', patch: { mgmtPublicKey: e.target.value } })}
              placeholder="64-character hex"
            />
          </Field>
          {seededMatches && (
            <div className="badge badge-sm badge-soft badge-success self-start">
              Seeded from local agent
            </div>
          )}

          <Field
            label="Management signing public key (64 hex chars)"
            error={errors.mgmtSigningPublicKey}
            hint={
              seededSigningMatches
                ? undefined
                : 'Ed25519 public half. Required to accept shell, file-transfer, and dynamic-mutation requests.'
            }
          >
            <input
              className="input input-sm w-full font-mono"
              value={state.mgmtSigningPublicKey}
              onChange={e =>
                dispatch({ type: 'set', patch: { mgmtSigningPublicKey: e.target.value } })
              }
              placeholder="64-character hex"
            />
          </Field>
          {seededSigningMatches && (
            <div className="badge badge-sm badge-soft badge-success self-start">
              Seeded from local agent
            </div>
          )}
        </>
      )}

      {state.mgmtMode === 'operator' && (
        <>
          <Field
            label="Management private key (64 hex chars)"
            error={errors.mgmtPrivateKey}
            hint="Paste manually — never auto-seeded. Operators only."
          >
            <input
              className="input input-sm w-full font-mono"
              value={state.mgmtPrivateKey}
              onChange={e => dispatch({ type: 'set', patch: { mgmtPrivateKey: e.target.value } })}
              placeholder="64-character hex"
              type="password"
              autoComplete="off"
              spellCheck={false}
            />
          </Field>

          <Field
            label="Management signing private key (128 hex chars)"
            error={errors.mgmtSigningPrivateKey}
            hint="Ed25519 private half. Paste manually — never auto-seeded. Authorises privileged operations."
          >
            <input
              className="input input-sm w-full font-mono"
              value={state.mgmtSigningPrivateKey}
              onChange={e =>
                dispatch({ type: 'set', patch: { mgmtSigningPrivateKey: e.target.value } })
              }
              placeholder="128-character hex"
              type="password"
              autoComplete="off"
              spellCheck={false}
            />
          </Field>

          <label className="flex cursor-pointer items-start gap-2">
            <input
              type="checkbox"
              className="checkbox checkbox-sm checkbox-primary"
              checked={state.mgmtAcknowledged}
              onChange={e =>
                dispatch({ type: 'set', patch: { mgmtAcknowledged: e.target.checked } })
              }
            />
            <span>
              I understand these keys grant topology-decryption access and sign privileged requests
              — only deploy them to trusted operator hosts.
            </span>
          </label>
          {errors.mgmtAcknowledged && (
            <div className="text-error text-xs">{errors.mgmtAcknowledged}</div>
          )}
        </>
      )}
    </>
  );
}

function StepReview({
  yaml,
  onDownload,
  onCopy,
  downloaded,
  copied,
}: {
  yaml: string;
  onDownload: () => void;
  onCopy: () => void;
  downloaded: boolean;
  copied: boolean;
}) {
  return (
    <>
      <h3 className="m-0 text-sm font-semibold">Review & download</h3>
      <p className="text-muted m-0">
        Review the generated YAML. Download it to deploy, or copy it to paste elsewhere.
      </p>
      <div className="flex gap-2">
        <button className="btn btn-sm btn-primary" type="button" onClick={onDownload}>
          {downloaded ? 'Download again' : 'Download config.yaml'}
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
        Drop the binary and config on the target host. The agent runs entirely in userspace, so no
        special privileges are needed for foreground use:
      </p>
      <pre className="rounded-field border-hairline bg-base-200 text-accent m-0 overflow-x-auto border p-3 font-mono text-xs leading-relaxed whitespace-pre">
        {[
          '# Run in the foreground (Ctrl+C to stop)',
          'muti-metroo run -c /path/to/config.yaml',
          '',
          '# Install as a system service — auto-starts and re-runs at boot.',
          '# Needs root (systemd on Linux, launchd on macOS, Windows Service on Windows):',
          'sudo muti-metroo service install -c /path/to/config.yaml',
          '',
          '# Linux non-root install via cron @reboot:',
          'muti-metroo service install --user -c /path/to/config.yaml',
          '',
          '# Windows DLL variant — runs via rundll32, no admin required.',
          '# Foreground:',
          'rundll32.exe C:\\path\\to\\muti-metroo.dll,Run C:\\path\\to\\config.yaml',
          '# Or install as a per-user autostart (Registry Run key):',
          'muti-metroo.exe service install --user --dll C:\\path\\to\\muti-metroo.dll -c C:\\path\\to\\config.yaml',
        ].join('\n')}
      </pre>
    </>
  );
}

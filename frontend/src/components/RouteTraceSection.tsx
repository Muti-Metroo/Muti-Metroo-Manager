import { useState, useCallback } from 'react';
import type {
  RouteTraceResult,
  RouteTraceCandidate,
  RouteTraceView,
  RouteTraceIP,
  RouteTraceDomain,
} from '../api/types';
import { traceLocalRoute, ApiError } from '../api/client';
import Alert from './Alert';

// Wide CIDRs the kernel won't accept on a TUN device — used as a fallback
// filter only when the agent's response doesn't yet carry an explicit `tun`
// view (older Muti Metroo builds). Matches what the TUN setup code skips when
// programming routes; once the agent ships per-context views this falls
// out of use.
const TUN_SKIP_PREFIXES = new Set(['0.0.0.0/0', '::/0']);

function pickWinner(ip: RouteTraceIP | undefined): RouteTraceCandidate | undefined {
  if (!ip || !ip.candidates) return undefined;
  return ip.candidates.find(c => c.winner);
}

// Best-effort SOCKS view derived from legacy fields. If the dest hit a
// domain pattern, that's the SOCKS winner regardless of resolved IPs
// (SOCKS resolves hostnames inside the agent before falling through to
// system DNS).
function deriveSocksView(r: RouteTraceResult): RouteTraceView {
  if (r.domain?.matched) {
    const winner: RouteTraceCandidate = {
      network: r.domain.pattern || '',
      prefix_len: 0,
      metric: r.domain.metric ?? 0,
      origin: r.domain.origin || '',
      origin_name: r.domain.origin_name,
      next_hop: r.domain.next_hop || '',
      next_hop_name: r.domain.next_hop_name,
      hop_count: r.domain.hop_count ?? 0,
      winner: true,
      reason: r.domain.is_wildcard ? 'wildcard' : 'exact',
    };
    return { resolution: 'domain', winner };
  }
  const firstIP = r.ips?.[0];
  const winner = pickWinner(firstIP);
  return {
    resolution: r.resolution || guessResolution(r),
    resolved_ips: r.ips?.map(i => i.ip),
    winner,
  };
}

// When the agent omits the top-level `resolution` field, infer from shape:
// dest equals an IP in `ips` → literal IP; ips present with hostname → system DNS.
function guessResolution(r: RouteTraceResult): RouteTraceView['resolution'] {
  if (!r.ips || r.ips.length === 0) return 'unresolved';
  if (r.hostname) return 'system';
  return 'ip';
}

// Best-effort TUN view: ignore domain match, walk resolved IPs, drop
// candidates the kernel would reject (default routes). Replaced by
// the agent's `tun` field once that ships.
function deriveTunView(r: RouteTraceResult): RouteTraceView {
  const firstIP = r.ips?.[0];
  if (!firstIP) {
    return { resolution: 'unresolved' };
  }
  const skipped = (firstIP.candidates || [])
    .filter(c => TUN_SKIP_PREFIXES.has(c.network))
    .map(c => ({ network: c.network, reason: 'prefix too wide for tun' }));
  const winner = (firstIP.candidates || []).filter(
    c => c.winner && !TUN_SKIP_PREFIXES.has(c.network),
  )[0];
  const baseResolution = r.resolution || guessResolution(r);
  const tunResolution =
    baseResolution === 'mesh' || baseResolution === 'domain'
      ? 'system' // TUN never sees mesh/domain — kernel resolves via system DNS
      : baseResolution;
  const note =
    !winner && skipped.length > 0
      ? `${skipped[0].network} is ignored by the TUN device — kernel will route via the system table.`
      : undefined;
  return {
    resolution: tunResolution,
    resolved_ips: r.ips?.map(i => i.ip),
    winner,
    skipped: skipped.length > 0 ? skipped : undefined,
    note,
  };
}

function CandidateLine({ c }: { c: RouteTraceCandidate }) {
  const nextHop = c.next_hop_name || c.next_hop || '?';
  const origin = c.origin_name || c.origin || '?';
  return (
    <div className="text-muted flex flex-wrap items-baseline gap-x-3 gap-y-1">
      <code className="text-primary font-mono font-medium">{c.network}</code>
      <span>
        via <strong className="text-base-content">{nextHop}</strong>
      </span>
      <span>
        → <strong className="text-base-content">{origin}</strong>
      </span>
      <span>metric {c.metric}</span>
      <span>
        {c.hop_count} hop{c.hop_count === 1 ? '' : 's'}
      </span>
    </div>
  );
}

function ViewCard({
  title,
  subtitle,
  view,
  emptyText,
}: {
  title: string;
  subtitle: string;
  view: RouteTraceView;
  emptyText: string;
}) {
  const hasWinner = !!view.winner;
  return (
    <div className="ui-section">
      <div className="ui-section-header">
        <span>{title}</span>
        <span
          className={`badge badge-sm badge-soft ${hasWinner ? 'badge-success' : 'badge-neutral'}`}
        >
          {hasWinner ? 'routed' : 'no route'}
        </span>
      </div>
      <div className="text-muted border-hairline border-b px-3 py-1.5 text-xs">{subtitle}</div>
      <div className="space-y-2 px-3 py-2">
        <div>
          Resolution: <code className="font-mono">{view.resolution}</code>
          {view.resolved_ips && view.resolved_ips.length > 0 && (
            <>
              {' '}
              → <code className="font-mono">{view.resolved_ips.join(', ')}</code>
            </>
          )}
        </div>
        {hasWinner ? (
          <CandidateLine c={view.winner!} />
        ) : (
          <div className="text-muted italic">{emptyText}</div>
        )}
        {view.note && <div className="text-warning text-xs">{view.note}</div>}
        {view.skipped && view.skipped.length > 0 && (
          <div className="text-muted flex flex-wrap items-baseline gap-x-2 text-xs">
            Skipped:
            {view.skipped.map((s, i) => (
              <span key={i}>
                <code className="font-mono">{s.network}</code> ({s.reason})
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function DomainCard({ domain }: { domain?: RouteTraceDomain }) {
  const matched = !!domain?.matched;
  return (
    <div className="ui-section">
      <div className="ui-section-header">
        <span>SOCKS domain pattern</span>
        <span
          className={`badge badge-sm badge-soft ${matched ? 'badge-success' : 'badge-neutral'}`}
        >
          {matched ? 'matched' : 'no match'}
        </span>
      </div>
      <div className="text-muted border-hairline border-b px-3 py-1.5 text-xs">
        SOCKS pattern table — wildcard/exact match against domain routes advertised across the mesh
      </div>
      <div className="space-y-2 px-3 py-2">
        {matched && domain ? (
          <>
            <div>
              Pattern: <code className="font-mono">{domain.pattern}</code>
              {domain.is_wildcard && <span className="text-muted"> (wildcard)</span>}
            </div>
            <CandidateLine
              c={{
                network: domain.pattern || '',
                prefix_len: 0,
                metric: domain.metric ?? 0,
                origin: domain.origin || '',
                origin_name: domain.origin_name,
                next_hop: domain.next_hop || '',
                next_hop_name: domain.next_hop_name,
                hop_count: domain.hop_count ?? 0,
                winner: true,
              }}
            />
          </>
        ) : (
          <div className="text-muted italic">
            Destination didn&apos;t match any registered domain pattern.
          </div>
        )}
      </div>
    </div>
  );
}

function AllCandidates({ result }: { result: RouteTraceResult }) {
  const [open, setOpen] = useState(false);
  const ips = result.ips || [];
  const total = ips.reduce((n, ip) => n + (ip.candidates?.length || 0), 0);
  if (total === 0) return null;
  return (
    <div className="mt-3">
      <button
        type="button"
        className="btn btn-sm btn-text"
        onClick={() => setOpen(v => !v)}
        aria-expanded={open}
      >
        <span
          className={`icon-[tabler--chevron-right] size-4 transition-transform ${open ? 'rotate-90' : ''}`}
          aria-hidden="true"
        />
        All candidates ({total})
      </button>
      {open && (
        <div className="mt-2 space-y-3">
          {ips.map((ip, i) => (
            <div key={i} className="ui-section p-3">
              <div className="mb-1.5 flex items-baseline gap-2">
                <code className="font-mono font-medium">{ip.ip}</code>
                {ip.no_match && <span className="text-muted text-xs">(no CIDR match)</span>}
              </div>
              {(ip.candidates || []).map((c, j) => (
                <div
                  key={j}
                  className={`flex flex-wrap items-baseline gap-2 py-0.5 ${c.winner ? 'font-medium' : ''}`}
                >
                  {c.winner && (
                    <span className="badge badge-xs badge-soft badge-success">winner</span>
                  )}
                  <CandidateLine c={c} />
                  {c.reason && <span className="text-muted text-xs">{c.reason}</span>}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function RouteTraceSection() {
  const [dest, setDest] = useState('');
  const [result, setResult] = useState<RouteTraceResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const runTrace = useCallback(async () => {
    const trimmed = dest.trim();
    if (!trimmed) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const r = await traceLocalRoute(trimmed);
      setResult(r);
    } catch (err: any) {
      if (err instanceof ApiError && err.status === 404) {
        setError(
          'Route trace is not available on this agent. Update the Muti Metroo agent to a build that exposes /route/trace.',
        );
      } else {
        setError(err?.message || 'Trace failed');
      }
    } finally {
      setLoading(false);
    }
  }, [dest]);

  const socksView = result ? (result.socks ?? deriveSocksView(result)) : null;
  const tunView = result ? (result.tun ?? deriveTunView(result)) : null;

  return (
    <section className="min-h-0 flex-1 overflow-y-auto">
      <div className="mb-3">
        <h3 className="text-sm font-semibold">Test routing</h3>
        <p className="text-muted text-xs">
          Trace how this agent would route a destination — by SOCKS5, by TUN, or via a registered
          mesh-host domain match.
        </p>
      </div>

      <div className="mb-3 flex gap-2">
        <input
          type="text"
          className="input input-sm min-w-0 flex-1 font-mono"
          placeholder="IP address or hostname (e.g. 10.8.0.11, target-11.mesh, example.com)"
          value={dest}
          onChange={e => setDest(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') runTrace();
          }}
          disabled={loading}
        />
        <button
          className="btn btn-sm btn-primary btn-soft"
          onClick={runTrace}
          disabled={loading || !dest.trim()}
        >
          {loading ? 'Tracing…' : 'Trace'}
        </button>
      </div>

      {error && <Alert kind="error" message={error} onClose={() => setError(null)} />}

      {result && (
        <>
          {result.error && <div className="ui-error mb-3">{result.error}</div>}

          <dl className="ui-kv mb-3">
            <dt>Destination</dt>
            <dd>{result.dest}</dd>
            {/* Only show Hostname when it actually differs from the verbatim
                destination — e.g. when the input had a port (kreata.ee:3000
                → kreata.ee) or got case-/trailing-dot-normalised. For plain
                "target-11.mesh"-style input the two are identical and the
                extra row is visual noise. */}
            {result.hostname && result.hostname.toLowerCase() !== result.dest.toLowerCase() && (
              <>
                <dt>Hostname</dt>
                <dd>{result.hostname}</dd>
              </>
            )}
            {result.resolution && (
              <>
                <dt>Resolved via</dt>
                <dd>{result.resolution}</dd>
              </>
            )}
          </dl>

          <div className="grid gap-3 lg:grid-cols-3">
            {socksView && (
              <ViewCard
                title="SOCKS"
                subtitle="SOCKS5 ingress — hostnames matched against the SOCKS domain-pattern table, or resolved via the mesh-host registry / system DNS"
                view={socksView}
                emptyText="No matching CIDR or domain route — SOCKS would refuse the connection."
              />
            )}
            {tunView && (
              <ViewCard
                title="TUN"
                subtitle="TUN device — kernel resolves names via system DNS, default routes are ignored"
                view={tunView}
                emptyText="No matching CIDR — kernel will route via the system table, not the TUN device."
              />
            )}
            <DomainCard domain={result.domain} />
          </div>

          <AllCandidates result={result} />
        </>
      )}
    </section>
  );
}

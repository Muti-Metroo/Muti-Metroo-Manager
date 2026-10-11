import { useMemo } from 'react';
import type { DashboardPortForwardRouteInfo, TopologyAgentInfo } from '../api/types';
import { isAttachedTarget } from '../api/types';

interface ForwardRouteTableProps {
  routes: DashboardPortForwardRouteInfo[] | null;
  agents: TopologyAgentInfo[];
  onHighlight: (pathIds: string[]) => void;
  onClearHighlight: () => void;
}

interface UnpairedRow {
  side: 'listener' | 'endpoint';
  key: string;
  agent: string;
  agentId: string;
}

export default function ForwardRouteTable({
  routes,
  agents,
  onHighlight,
  onClearHighlight,
}: ForwardRouteTableProps) {
  // Augment the paired-routes view with half-open forwards from topology so
  // that a listener-without-endpoint (or vice versa) is still visible. The
  // backend only emits the ingress×exit cross-product, which produces zero
  // rows when one side is missing.
  const unpaired = useMemo<UnpairedRow[]>(() => {
    const listenersByKey = new Map<string, { agent: string; agentId: string }[]>();
    const endpointsByKey = new Map<string, { agent: string; agentId: string }[]>();
    for (const a of agents) {
      const info = { agent: a.display_name || a.short_id, agentId: a.short_id };
      for (const k of a.forward_listeners || []) {
        const arr = listenersByKey.get(k) || [];
        arr.push(info);
        listenersByKey.set(k, arr);
      }
      for (const k of a.forward_endpoints || []) {
        const arr = endpointsByKey.get(k) || [];
        arr.push(info);
        endpointsByKey.set(k, arr);
      }
    }
    const rows: UnpairedRow[] = [];
    for (const [key, lst] of listenersByKey) {
      if (!endpointsByKey.has(key)) {
        for (const l of lst) rows.push({ side: 'listener', key, ...l });
      }
    }
    for (const [key, lst] of endpointsByKey) {
      if (!listenersByKey.has(key)) {
        for (const e of lst) rows.push({ side: 'endpoint', key, ...e });
      }
    }
    rows.sort((a, b) => a.key.localeCompare(b.key) || a.agent.localeCompare(b.agent));
    return rows;
  }, [agents]);

  // The agent's dashboard builder double-counts local listeners (they live in
  // both allNodeInfo[localID] and GetLocalNodeInfo()), which produces
  // identical duplicate rows for any local-listener pairing. Dedupe by the
  // tuple that identifies a unique route.
  const dedupedRoutes = useMemo(() => {
    if (!routes) return [];
    const seen = new Set<string>();
    const out: DashboardPortForwardRouteInfo[] = [];
    for (const r of routes) {
      const k = `${r.key}\x00${r.ingress_agent_id}\x00${r.listener_address}\x00${r.exit_agent_id}\x00${r.target}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(r);
    }
    return out;
  }, [routes]);

  const pairedCount = dedupedRoutes.length;
  const unpairedCount = unpaired.length;

  return (
    <section className="flex min-h-0 flex-1 flex-col p-4">
      <div className="ui-table-frame">
        <table className="table table-sm table-pin-rows">
          <thead>
            <tr>
              <th>Key</th>
              <th>Ingress</th>
              <th>Listener</th>
              <th>Exit</th>
              <th>Target</th>
              <th className="text-end">Hops</th>
            </tr>
          </thead>
          <tbody>
            {pairedCount === 0 && unpairedCount === 0 && (
              <tr>
                <td colSpan={6} className="ui-empty">
                  No port forwards
                </td>
              </tr>
            )}
            {dedupedRoutes.map((route, i) => (
              <tr
                key={`p-${i}`}
                className="hover:bg-base-200"
                onMouseEnter={() => onHighlight(route.path_ids || [])}
                onMouseLeave={onClearHighlight}
              >
                <td className="text-primary font-mono">{route.key}</td>
                <td title={route.ingress_agent_id}>{route.ingress_agent}</td>
                <td className="font-mono">{route.listener_address || '-'}</td>
                <td title={route.exit_agent_id}>{route.exit_agent}</td>
                <td>
                  {route.target ? (
                    isAttachedTarget(route.target) ? (
                      <span
                        className="badge badge-sm badge-soft badge-accent"
                        title="Ephemeral endpoint attached over the agent's expose stream"
                      >
                        attached · expose
                      </span>
                    ) : (
                      <span className="font-mono">{route.target}</span>
                    )
                  ) : (
                    '-'
                  )}
                </td>
                <td className="text-end font-mono" title={route.path_display?.join(' → ') || ''}>
                  {route.hop_count}
                </td>
              </tr>
            ))}
            {unpaired.map((row, i) => (
              <tr
                key={`u-${i}`}
                className="bg-warning/5"
                title={`${row.side === 'listener' ? 'No endpoint' : 'No listener'} advertised for key "${row.key}"`}
              >
                <td className="text-primary font-mono">{row.key}</td>
                <td title={row.side === 'listener' ? row.agentId : ''}>
                  {row.side === 'listener' ? (
                    row.agent
                  ) : (
                    <span className="text-warning italic">- no listener -</span>
                  )}
                </td>
                <td>-</td>
                <td title={row.side === 'endpoint' ? row.agentId : ''}>
                  {row.side === 'endpoint' ? (
                    row.agent
                  ) : (
                    <span className="text-warning italic">- no endpoint -</span>
                  )}
                </td>
                <td>-</td>
                <td className="text-end">-</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

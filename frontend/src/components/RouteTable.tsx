import type { DashboardRouteInfo } from '../api/types';

interface RouteTableProps {
  routes: DashboardRouteInfo[] | null;
  onHighlight: (pathIds: string[]) => void;
  onClearHighlight: () => void;
  // Open the exit node that defines the route, on its Routes tab.
  onSelectAgent: (agentId: string) => void;
}

export default function RouteTable({
  routes,
  onHighlight,
  onClearHighlight,
  onSelectAgent,
}: RouteTableProps) {
  return (
    <div className="ui-table-frame">
      <table className="table table-sm table-pin-rows">
        <thead>
          <tr>
            <th>Route</th>
            <th>Exit node</th>
            <th>Proto</th>
            <th className="text-end">Hops</th>
            <th>Comment</th>
          </tr>
        </thead>
        <tbody>
          {!routes || routes.length === 0 ? (
            <tr>
              <td colSpan={5} className="ui-empty">
                No routes
              </td>
            </tr>
          ) : (
            routes.map((route, i) => (
              <tr
                key={i}
                className="hover:bg-base-200 cursor-pointer"
                onMouseEnter={() => onHighlight(route.path_ids || [])}
                onMouseLeave={onClearHighlight}
                onClick={() => route.origin_id && onSelectAgent(route.origin_id)}
                title={route.origin ? `Open ${route.origin} routes` : undefined}
              >
                <td
                  className={`font-mono ${route.route_type === 'domain' ? 'text-accent' : 'text-base-content'}`}
                >
                  {route.route_type === 'domain' ? '@' : ''}
                  {route.network}
                </td>
                <td title={route.origin_id}>{route.origin}</td>
                <td>
                  <span className="flex gap-1">
                    {route.tcp && <span className="badge badge-sm badge-soft badge-info">TCP</span>}
                    {route.udp && (
                      <span className="badge badge-sm badge-soft badge-warning">UDP</span>
                    )}
                  </span>
                </td>
                <td className="text-end font-mono" title={route.path_display?.join(' → ') || ''}>
                  {route.hop_count}
                </td>
                <td className="text-muted">{route.comment || ''}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

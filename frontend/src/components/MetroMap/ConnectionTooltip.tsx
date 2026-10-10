import type { TopologyConnection } from '../../api/types';
import type { PositionedAgent } from './layout';

interface ConnectionTooltipProps {
  from: PositionedAgent | null;
  to: PositionedAgent | null;
  conn: TopologyConnection | null;
  position: { x: number; y: number };
}

const TRANSPORT_NAMES: Record<string, string> = {
  quic: 'QUIC',
  h2: 'HTTP/2',
  ws: 'WebSocket',
};

export default function ConnectionTooltip({ from, to, conn, position }: ConnectionTooltipProps) {
  if (!from || !to || !conn) return null;

  // Orient the tooltip so the dialer is on the left when the agent API
  // reports one. Topology from/to ordering is otherwise arbitrary.
  const dialerIsFrom = conn.dialer && conn.dialer === from.short_id;
  const dialerIsTo = conn.dialer && conn.dialer === to.short_id;
  const [left, right] = dialerIsTo ? [to, from] : [from, to];
  const leftName = left.display_name || left.short_id;
  const rightName = right.display_name || right.short_id;
  const directed = dialerIsFrom || dialerIsTo;

  return (
    <div className="connection-tooltip" style={{ left: position.x, top: position.y }}>
      <div className="connection-direction">
        <span>{leftName}</span>
        <span className="connection-arrow" aria-hidden="true">
          {directed ? '→' : '↔'}
        </span>
        <span>{rightName}</span>
      </div>
      {directed && (
        <div className="connection-role">
          {leftName} (dialer) connects to {rightName} (listener)
        </div>
      )}
      {conn.transport && (
        <div className="connection-transport">
          Transport: {TRANSPORT_NAMES[conn.transport] || conn.transport.toUpperCase()}
        </div>
      )}
      {conn.rtt_ms > 0 && <div className="connection-rtt">RTT: {conn.rtt_ms}ms</div>}
      {conn.unresponsive && (
        <div className="connection-rtt unresponsive">UNRESPONSIVE (RTT &gt; 60s)</div>
      )}
    </div>
  );
}

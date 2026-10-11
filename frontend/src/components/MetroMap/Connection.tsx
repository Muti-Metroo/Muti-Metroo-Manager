import { memo, useCallback, useMemo } from 'react';
import type { TopologyConnection } from '../../api/types';
import type { PositionedAgent } from './layout';
import { createMetroPath } from './layout';

interface ConnectionProps {
  from: PositionedAgent;
  to: PositionedAgent;
  conn: TopologyConnection;
  stationPositions: { x: number; y: number }[];
  highlightState: 'none' | 'highlighted' | 'dimmed';
  isNew?: boolean;
  onHover: (
    e: React.MouseEvent,
    from: PositionedAgent,
    to: PositionedAgent,
    conn: TopologyConnection,
  ) => void;
  onMove: (e: React.MouseEvent) => void;
  onLeave: () => void;
}

// Latency heat for a link, fed to metro.css as a custom property rather than
// as an inline `stroke`. An inline stroke would outrank the stylesheet, so the
// hover and path-highlight rules could never recolour the line.
function rttHeatColor(rtt_ms: number): string {
  if (rtt_ms < 50) return 'var(--color-success)';
  if (rtt_ms < 200) return 'var(--color-warning)';
  return 'var(--color-error)';
}

function Connection({
  from,
  to,
  conn,
  stationPositions,
  highlightState,
  isNew,
  onHover,
  onMove,
  onLeave,
}: ConnectionProps) {
  // Path is the hot spot: createMetroPath walks every other station for
  // collision routing, so O(connections × stations) per render without this.
  // stationPositions gets stable identity from MetroMap when nothing moved.
  const d = useMemo(
    () => createMetroPath(from.x, from.y, to.x, to.y, stationPositions),
    [from.x, from.y, to.x, to.y, stationPositions],
  );

  let connClass = 'connection';
  if (conn.unresponsive) connClass += ' unresponsive';
  if (isNew) connClass += ' is-new';
  // Path is canonicalised in createMetroPath to draw from smaller-coord to
  // larger-coord; reverse the dash flow when the dialer is at the path's
  // far end so the dots travel dialer → listener regardless of layout.
  if (conn.dialer) {
    const pathStartIsFrom = from.x < to.x || (from.x === to.x && from.y < to.y);
    const dialerIsPathStart = conn.dialer === (pathStartIsFrom ? from.short_id : to.short_id);
    if (!dialerIsPathStart) connClass += ' flow-reverse';
  }

  let groupClass = 'connection-group';
  if (highlightState === 'highlighted') groupClass += ' path-highlighted';
  if (highlightState === 'dimmed') groupClass += ' path-dimmed';

  const handleEnter = useCallback(
    (e: React.MouseEvent) => {
      onHover(e, from, to, conn);
    },
    [from, to, conn, onHover],
  );

  const pathStyle = useMemo(
    () =>
      conn.unresponsive
        ? undefined
        : ({ '--connection-heat': rttHeatColor(conn.rtt_ms) } as React.CSSProperties),
    [conn.unresponsive, conn.rtt_ms],
  );

  return (
    <g
      className={groupClass}
      data-from-id={from.short_id}
      data-to-id={to.short_id}
      onMouseEnter={handleEnter}
      onMouseMove={onMove}
      onMouseLeave={onLeave}
    >
      <path d={d} className="connection-hit" />
      <path d={d} className={connClass} style={pathStyle} />
    </g>
  );
}

export default memo(Connection);

import { useCallback } from 'react';
import type { MeshTestResult } from '../../api/types';
import type { PositionedAgent } from './layout';
import { AgentIconNode, ICON_BY_KEY } from './agentIcons';

const STATION_RADIUS = 14;
// Icon glyph diameter relative to the station radius. 2.4× makes the
// icon visually fill the halo envelope without crowding it.
const ICON_SCALE = 2.4;
// Padding between the icon glyph and the surrounding ring when an icon
// is set, in viewBox units.
const ICON_RING_PAD = 4;

interface StationProps {
  agent: PositionedAgent;
  meshResult: MeshTestResult | undefined;
  highlightState: 'none' | 'highlighted' | 'dimmed';
  selected: boolean;
  // Operator-picked icon key (see components/MetroMap/agentIcons.tsx).
  // Empty or unknown falls back to the default circle.
  iconKey: string;
  onHover: (agent: PositionedAgent, element: SVGGElement) => void;
  onLeave: () => void;
  // Keyboard activation. Pointer clicks go through MetroMap's pointer
  // capture (drag vs click discriminator); Enter/Space don't participate
  // in that flow, so the parent hands us a direct activate callback.
  onActivate: (agentId: string) => void;
}

export default function Station({
  agent,
  meshResult,
  highlightState,
  selected,
  iconKey,
  onHover,
  onLeave,
  onActivate,
}: StationProps) {
  const hasIcon = !!iconKey && iconKey in ICON_BY_KEY;
  const iconSize = STATION_RADIUS * ICON_SCALE;
  // The "remote indicator" ring is always shown around an agent. When
  // an icon is set the ring grows to contain it; otherwise it stays at
  // the default station radius and the inner hollow circle is the dot.
  const radius = hasIcon ? iconSize / 2 + ICON_RING_PAD : STATION_RADIUS;
  const labelOffset = radius + 8;

  let className = 'station';
  if (selected) className += ' selected';
  if (highlightState === 'highlighted') className += ' path-highlighted';
  if (highlightState === 'dimmed') className += ' path-dimmed';
  if (meshResult) {
    className += meshResult.reachable ? ' reachable' : ' unreachable';
  }
  if (hasIcon) className += ' has-icon';

  const handleMouseEnter = useCallback(
    (e: React.MouseEvent<SVGGElement>) => {
      onHover(agent, e.currentTarget);
    },
    [agent, onHover],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<SVGGElement>) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onActivate(agent.short_id);
      }
    },
    [agent.short_id, onActivate],
  );

  const handleFocus = useCallback(
    (e: React.FocusEvent<SVGGElement>) => {
      onHover(agent, e.currentTarget);
    },
    [agent, onHover],
  );

  const labelProps: Record<string, string | number> = {};
  switch (agent.labelPos) {
    case 'above':
      labelProps.y = -labelOffset;
      break;
    case 'below':
      labelProps.y = labelOffset + 8;
      break;
    case 'left':
      labelProps.x = -labelOffset;
      labelProps.y = 4;
      break;
    case 'right':
      labelProps.x = labelOffset;
      labelProps.y = 4;
      break;
  }

  const haloRadius = radius + 8;

  return (
    <g
      className={className}
      transform={`translate(${agent.x},${agent.y})`}
      data-agent-id={agent.short_id}
      tabIndex={0}
      role="button"
      aria-label={agent.display_name || agent.short_id}
      aria-pressed={selected}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={onLeave}
      onFocus={handleFocus}
      onBlur={onLeave}
      onKeyDown={handleKeyDown}
    >
      {selected && <circle className="station-halo" r={haloRadius} />}
      <circle className="station-outer" r={radius} />
      {hasIcon ? (
        <g className="station-icon">
          <AgentIconNode kind={iconKey} size={iconSize} />
        </g>
      ) : (
        <circle className="station-inner" r={radius - 4} />
      )}
      <text className={`station-label ${agent.labelPos}`} {...labelProps}>
        {agent.display_name || agent.short_id}
      </text>
    </g>
  );
}

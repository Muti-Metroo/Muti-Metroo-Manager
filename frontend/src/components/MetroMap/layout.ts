import type { TopologyAgentInfo, TopologyConnection } from '../../api/types';

export interface PositionedAgent extends TopologyAgentInfo {
  x: number;
  y: number;
  labelPos: 'above' | 'below' | 'left' | 'right';
}

const GRID_SIZE = 200;

/*
 * Station label geometry, in layout units.
 *
 * A station's drawn footprint is not the circle; it is the circle plus its
 * name. Anything that has to contain a station (the network boxes) needs
 * these, so they live here with the label placement rather than being guessed
 * at the call site.
 *
 * The numbers are measured against the rendered SVG with the .station-label
 * rule in styles/metro.css (JetBrains Mono 13px, whose advance is a flat
 * 0.6em): a 9-character name measures exactly 70.2 units wide, and a `below`
 * label's lower edge sits 51.6 units under the station centre. If that rule's
 * font-size changes, these have to change with it.
 */
const LABEL_FONT_SIZE = 13;

/**
 * Rendered width of monospace text, without measuring the DOM.
 *
 * JetBrains Mono (and every fallback in --font-mono) advances a flat 0.6em,
 * so width is purely a function of length and font size. Callers pass the
 * font-size their own CSS rule sets, keep them in step with styles/metro.css.
 */
export function monoTextWidth(text: string, fontSize: number): number {
  return text.length * fontSize * MONO_ADVANCE;
}

const MONO_ADVANCE = 0.6;

/** Centre → outer edge of a label placed above or below the station. */
export const LABEL_VERTICAL_REACH = 52;

// Left/right labels are anchored at the station's edge rather than centred on
// it (see Station.tsx), so they start this far out and then run their full
// width. The offset is the widest station: icon radius 20.8 + the 8-unit gap.
const LABEL_SIDE_OFFSET = 29;

/**
 * How far an agent's drawn footprint reaches from its centre, the distance a
 * containing box has to clear on every side.
 *
 * Placement matters: an above/below label is centred on the station and so
 * reaches half its width sideways, while a left/right label hangs off one
 * edge and reaches its whole width.
 */
export function labelReach(agent: PositionedAgent): number {
  const width = monoTextWidth(agent.display_name || agent.short_id, LABEL_FONT_SIZE);
  return agent.labelPos === 'left' || agent.labelPos === 'right'
    ? LABEL_SIDE_OFFSET + width
    : Math.max(LABEL_VERTICAL_REACH, width / 2);
}

/** short_id → label reach, for everything that has to size around labels. */
export function labelReaches(agents: PositionedAgent[]): Map<string, number> {
  return new Map(agents.map(a => [a.short_id, labelReach(a)]));
}

const DIRECTIONS = [
  { dx: 1, dy: 0 }, // East
  { dx: 1, dy: 1 }, // Southeast
  { dx: 1, dy: -1 }, // Northeast
  { dx: 0, dy: 1 }, // South
  { dx: 0, dy: -1 }, // North
  { dx: -1, dy: 0 }, // West
  { dx: -1, dy: 1 }, // Southwest
  { dx: -1, dy: -1 }, // Northwest
];

export function calculateTreeLayout(
  agents: TopologyAgentInfo[],
  connections: TopologyConnection[],
): PositionedAgent[] {
  if (agents.length === 0) return [];

  const localAgent = agents.find(a => a.is_local);
  if (!localAgent) return agents.map(a => ({ ...a, x: 0, y: 0, labelPos: 'above' as const }));

  // Build adjacency list
  const adjacency = new Map<string, Set<string>>();
  for (const agent of agents) {
    adjacency.set(agent.short_id, new Set());
  }
  for (const conn of connections) {
    adjacency.get(conn.from_agent)?.add(conn.to_agent);
    adjacency.get(conn.to_agent)?.add(conn.from_agent);
  }

  // BFS layout
  const positioned = new Set<string>();
  const positions = new Map<string, { x: number; y: number }>();
  const usedPositions = new Set<string>();

  positions.set(localAgent.short_id, { x: 0, y: 0 });
  positioned.add(localAgent.short_id);
  usedPositions.add('0,0');

  const queue = [{ id: localAgent.short_id, x: 0, y: 0 }];

  while (queue.length > 0) {
    const current = queue.shift()!;
    const neighbors = Array.from(adjacency.get(current.id) || []).sort();

    let dirIndex = 0;
    for (const neighborId of neighbors) {
      if (positioned.has(neighborId)) continue;

      let newX = 0,
        newY = 0;
      let found = false;

      for (let attempt = 0; attempt < DIRECTIONS.length; attempt++) {
        const dir = DIRECTIONS[(dirIndex + attempt) % DIRECTIONS.length];
        newX = current.x + dir.dx;
        newY = current.y + dir.dy;
        const posKey = `${newX},${newY}`;

        if (!usedPositions.has(posKey)) {
          usedPositions.add(posKey);
          found = true;
          break;
        }
      }

      if (!found) {
        for (let dx = 1; dx <= 3; dx++) {
          for (let dy = -2; dy <= 2; dy++) {
            newX = current.x + dx;
            newY = current.y + dy;
            const posKey = `${newX},${newY}`;
            if (!usedPositions.has(posKey)) {
              usedPositions.add(posKey);
              found = true;
              break;
            }
          }
          if (found) break;
        }
      }

      if (found) {
        positions.set(neighborId, { x: newX, y: newY });
        positioned.add(neighborId);
        queue.push({ id: neighborId, x: newX, y: newY });
      }

      dirIndex++;
    }
  }

  // Calculate bounds
  let minX = Infinity,
    maxX = -Infinity;
  let minY = Infinity,
    maxY = -Infinity;
  positions.forEach(pos => {
    minX = Math.min(minX, pos.x);
    maxX = Math.max(maxX, pos.x);
    minY = Math.min(minY, pos.y);
    maxY = Math.max(maxY, pos.y);
  });

  const centerOffsetX = (minX + maxX) / 2;
  const centerOffsetY = (minY + maxY) / 2;

  // Assign label positions
  const labelPositions = new Map<string, 'above' | 'below' | 'left' | 'right'>();
  for (const agent of agents) {
    const pos = positions.get(agent.short_id);
    if (!pos) {
      labelPositions.set(agent.short_id, 'above');
      continue;
    }

    const neighbors = adjacency.get(agent.short_id) || new Set();
    let hasAbove = false,
      hasBelow = false,
      hasLeft = false,
      hasRight = false;

    neighbors.forEach(nId => {
      const nPos = positions.get(nId);
      if (nPos) {
        if (nPos.y < pos.y) hasAbove = true;
        if (nPos.y > pos.y) hasBelow = true;
        if (nPos.x < pos.x) hasLeft = true;
        if (nPos.x > pos.x) hasRight = true;
      }
    });

    if (!hasAbove) labelPositions.set(agent.short_id, 'above');
    else if (!hasBelow) labelPositions.set(agent.short_id, 'below');
    else if (!hasLeft) labelPositions.set(agent.short_id, 'left');
    else if (!hasRight) labelPositions.set(agent.short_id, 'right');
    else labelPositions.set(agent.short_id, 'above');
  }

  return agents.map(agent => {
    const pos = positions.get(agent.short_id);
    return {
      ...agent,
      x: pos ? (pos.x - centerOffsetX) * GRID_SIZE : 0,
      y: pos ? (pos.y - centerOffsetY) * GRID_SIZE : 0,
      labelPos: labelPositions.get(agent.short_id) || 'above',
    };
  });
}

// ---- Metro path routing: 45° diagonal transitions ----

const CORNER_RADIUS = 20;
const COS45 = Math.SQRT1_2;
const COLLINEAR_OFFSET = 40;

type Point = { x: number; y: number };

/**
 * Build a two-segment metro path: a straight axis-aligned segment along the
 * longer axis, followed by a 45° diagonal into the destination, joined with
 * a rounded corner. The elbow sits at the destination end of the straight
 * run — which keeps it clear of the source's label, and keeps the output a
 * pure function of the endpoints so small drags produce small path changes.
 */
function buildTwoSegmentPath(x1: number, y1: number, x2: number, y2: number, r: number): string {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const absX = Math.abs(dx);
  const absY = Math.abs(dy);
  const sX = Math.sign(dx);
  const sY = Math.sign(dy);
  const horizontal = absX >= absY;
  const diag = horizontal ? absY : absX;
  const straightLen = (horizontal ? absX : absY) - diag;

  // Corner point where the straight and diagonal segments meet.
  const cx = horizontal ? x1 + straightLen * sX : x1;
  const cy = horizontal ? y1 : y1 + straightLen * sY;

  const er = Math.min(r, straightLen, diag);
  if (er < 2) {
    return `M${x1},${y1} L${cx},${cy} L${x2},${y2}`;
  }

  // Rounded corner: retract along the straight axis before the corner,
  // advance at 45° after it.
  const preX = horizontal ? cx - er * sX : cx;
  const preY = horizontal ? cy : cy - er * sY;
  const postX = cx + er * COS45 * sX;
  const postY = cy + er * COS45 * sY;

  return `M${x1},${y1} L${preX},${preY} Q${cx},${cy} ${postX},${postY} L${x2},${y2}`;
}

/** Straight line when unambiguous, chevron bypass when an intermediate station sits between endpoints. */
function buildCollinearPath(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  allStations: Point[],
): string {
  const dx = x2 - x1;
  const isVertical = Math.abs(dx) < 10;

  // Check for an intermediate station sitting between the two endpoints along the shared axis
  const hasIntermediate = allStations.some(s => {
    if (isVertical) {
      const minY = Math.min(y1, y2);
      const maxY = Math.max(y1, y2);
      return Math.abs(s.x - x1) < 10 && s.y > minY + 10 && s.y < maxY - 10;
    }
    const minX = Math.min(x1, x2);
    const maxX = Math.max(x1, x2);
    return Math.abs(s.y - y1) < 10 && s.x > minX + 10 && s.x < maxX - 10;
  });

  if (!hasIntermediate) return `M${x1},${y1} L${x2},${y2}`;

  // Chevron: diagonal out to offset apex, rounded corner, diagonal back
  const mx = (x1 + x2) / 2;
  const my = (y1 + y2) / 2;
  const apexX = isVertical ? mx + COLLINEAR_OFFSET : mx;
  const apexY = isVertical ? my : my + COLLINEAR_OFFSET;

  const armLen = Math.hypot(apexX - x1, apexY - y1);
  const er = Math.min(CORNER_RADIUS, armLen / 3);

  const nsX = (x1 - apexX) / armLen;
  const nsY = (y1 - apexY) / armLen;
  const endLen = Math.hypot(x2 - apexX, y2 - apexY);
  const neX = (x2 - apexX) / endLen;
  const neY = (y2 - apexY) / endLen;

  const preX = apexX + er * nsX;
  const preY = apexY + er * nsY;
  const postX = apexX + er * neX;
  const postY = apexY + er * neY;

  return `M${x1},${y1} L${preX},${preY} Q${apexX},${apexY} ${postX},${postY} L${x2},${y2}`;
}

export function createMetroPath(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  allStations: Point[] = [],
): string {
  // Canonicalize endpoint order so the path is a pure function of the
  // UNORDERED pair. The backend can report the same reciprocal link as
  // A→B one poll and B→A the next; without this sort, the two-segment
  // routing mirrors the elbow to the opposite end and the connector
  // visibly flips between polls.
  if (x1 > x2 || (x1 === x2 && y1 > y2)) {
    [x1, x2] = [x2, x1];
    [y1, y2] = [y2, y1];
  }

  const absX = Math.abs(x2 - x1);
  const absY = Math.abs(y2 - y1);

  // Aligned: straight line or chevron bypass when a third station sits
  // exactly on the connecting axis.
  if (absX < 10 || absY < 10) {
    return buildCollinearPath(x1, y1, x2, y2, allStations);
  }

  // Near-diagonal: straight 45° line.
  if (Math.abs(absX - absY) < 10) {
    return `M${x1},${y1} L${x2},${y2}`;
  }

  // General case: deterministic two-segment metro path. The shape depends
  // only on the two endpoints, so a drag produces a continuous deformation
  // instead of orientation flips.
  return buildTwoSegmentPath(x1, y1, x2, y2, CORNER_RADIUS);
}

export function hashTopology(
  agents: TopologyAgentInfo[],
  connections: TopologyConnection[],
): string {
  const agentIds = agents
    .map(a => a.short_id)
    .sort()
    .join(',');
  const connIds = connections
    .map(c => `${c.from_agent}-${c.to_agent}`)
    .sort()
    .join(',');
  return `${agentIds}|${connIds}`;
}

// Smallest viewBox the map will use, in layout units. Roughly a 16:9 frame
// around the content; see calculateViewBox for why there is a floor at all.
const MIN_VIEWBOX_WIDTH = 1150;
const MIN_VIEWBOX_HEIGHT = 650;

export function calculateViewBox(
  agents: PositionedAgent[],
  // Optional union rectangle of the network boxes, so a box near the edge of
  // the map isn't clipped by a viewBox sized to node centers alone.
  extraBounds?: { minX: number; minY: number; maxX: number; maxY: number } | null,
): string {
  if (agents.length === 0) return '0 0 1000 600';

  let minX = Infinity,
    maxX = -Infinity;
  let minY = Infinity,
    maxY = -Infinity;

  for (const agent of agents) {
    minX = Math.min(minX, agent.x);
    maxX = Math.max(maxX, agent.x);
    minY = Math.min(minY, agent.y);
    maxY = Math.max(maxY, agent.y);
  }

  if (extraBounds) {
    minX = Math.min(minX, extraBounds.minX);
    maxX = Math.max(maxX, extraBounds.maxX);
    minY = Math.min(minY, extraBounds.minY);
    maxY = Math.max(maxY, extraBounds.maxY);
  }

  const padding = 100;
  minX -= padding;
  maxX += padding;
  minY -= padding;
  maxY += padding;

  // Floor the viewBox so a sparse mesh does not get magnified to fill the
  // frame. The SVG scales its viewBox to the container, so without this a
  // two-node mesh in a full-height map renders station labels several times
  // their intended size. Expanding around the centre keeps the content
  // centred; a mesh larger than the floor is unaffected.
  const width = Math.max(maxX - minX, MIN_VIEWBOX_WIDTH);
  const height = Math.max(maxY - minY, MIN_VIEWBOX_HEIGHT);
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;

  return `${cx - width / 2} ${cy - height / 2} ${width} ${height}`;
}

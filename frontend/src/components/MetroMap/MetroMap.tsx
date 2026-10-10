import { useState, useCallback, useRef, useMemo, useEffect, type ReactNode } from 'react';
import type {
  TopologyAgentInfo,
  TopologyConnection,
  MeshTestResponse,
  MeshTestResult,
  AgentMetadataMap,
  NetworkNameMap,
} from '../../api/types';
import { calculateTreeLayout, calculateViewBox, hashTopology, labelReaches } from './layout';
import type { PositionedAgent } from './layout';
import {
  buildMembership,
  membershipHash,
  solveLayout,
  deriveBoxes,
  netGeometry,
  boxesBounds,
  clampAgentDrag,
  clampBoxDrag,
  snapPoint,
  SNAP_GRID,
  type Pt,
} from './networkLayout';
import Station from './Station';
import Connection from './Connection';
import NetworkBox from './NetworkBox';
import StationTooltip from './StationTooltip';
import ConnectionTooltip from './ConnectionTooltip';
import EmptyState from './EmptyState';
import { getPositions, putPositions } from '../../api/client';
import { connKey } from '../../util/useTopologyDiff';

const MIN_SCALE = 0.25;
const MAX_SCALE = 5;
const VIEW_STORAGE_KEY = 'muti-metroo-manager.map-view';
// Click vs drag discriminator, in client pixels. Below this, pointerup on a
// station fires the usual "open panel" click.
const DRAG_THRESHOLD_PX = 4;
// Wheel-zoom arming. A brief or light wheel burst (e.g. the user scrolling
// the page and the cursor passing over the map) falls through to the
// browser's default scroll; zoom only engages once the user has clearly
// committed to wheeling on the map. Requires both sustained time AND
// sustained delta so a single fast flick can't arm it.
const WHEEL_ARM_MIN_DURATION_MS = 120;
const WHEEL_ARM_MIN_DELTA = 180;
// Unarmed bursts reset quickly so two unrelated passes don't accumulate.
const WHEEL_UNARMED_TIMEOUT_MS = 200;
// Once armed, allow brief pauses (to see the zoom result) without disarming.
const WHEEL_ARMED_TIMEOUT_MS = 600;

interface StoredView {
  scale: number;
  tx: number;
  ty: number;
}

type PositionMap = Record<string, { x: number; y: number }>;

function readStoredView(): StoredView {
  try {
    const raw = localStorage.getItem(VIEW_STORAGE_KEY);
    if (!raw) return { scale: 1, tx: 0, ty: 0 };
    const parsed = JSON.parse(raw) as Partial<StoredView>;
    const scale =
      typeof parsed.scale === 'number' && isFinite(parsed.scale)
        ? Math.min(MAX_SCALE, Math.max(MIN_SCALE, parsed.scale))
        : 1;
    const tx = typeof parsed.tx === 'number' && isFinite(parsed.tx) ? parsed.tx : 0;
    const ty = typeof parsed.ty === 'number' && isFinite(parsed.ty) ? parsed.ty : 0;
    return { scale, tx, ty };
  } catch {
    return { scale: 1, tx: 0, ty: 0 };
  }
}

// Parse "x y w h" viewBox string into its four numeric components.
function parseViewBox(vb: string): { x: number; y: number; w: number; h: number } {
  const [x, y, w, h] = vb.split(/\s+/).map(Number);
  return { x, y, w, h };
}

interface MetroMapProps {
  agents: TopologyAgentInfo[];
  connections: TopologyConnection[];
  meshTestResults: MeshTestResponse | null;
  highlightedPath: string[];
  selectedAgentId: string | null;
  // Operator-configured SOCKS5 override; used in place of the local
  // agent's self-reported socks5_addr in hover tooltips.
  socksAddress: string;
  // Per-agent operator metadata (notes + icon) keyed by full agent id.
  // A non-empty note shows a badge / tooltip preview; an icon key swaps
  // the central station glyph for the picked icon.
  agentMeta: AgentMetadataMap;
  // Network display-name overrides ({id: name}); membership itself rides on
  // agentMeta.networks. Drives the network box labels.
  networkNames: NetworkNameMap;
  // Persist a renamed network box (fire-and-forget; owned by App).
  onNetworkRename: (id: string, name: string) => void;
  onStationClick: (agentId: string) => void;
  // Connection keys ("from->to") that appeared since the previous poll;
  // used to play the reveal animation.
  newConnectionKeys?: Set<string>;
  // Wizard openers for the "no peers yet" empty-state card. Optional so
  // standalone uses of the map still compile; when both omitted the card
  // falls back to an inert message.
  onOpenAgentWizard?: () => void;
  onOpenEntryWizard?: () => void;
  // Rendered as an absolutely-positioned overlay in the top-right corner
  // of the map container. Owned by the parent so the AgentSearch ref and
  // state stay in App and can be targeted by the global `/` hotkey.
  searchSlot?: ReactNode;
}

export default function MetroMap({
  agents,
  connections,
  meshTestResults,
  highlightedPath,
  selectedAgentId,
  socksAddress,
  agentMeta,
  networkNames,
  onNetworkRename,
  newConnectionKeys,
  onStationClick,
  onOpenAgentWizard,
  onOpenEntryWizard,
  searchSlot,
}: MetroMapProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);

  // Station tooltip state
  const [hoveredStation, setHoveredStation] = useState<PositionedAgent | null>(null);
  const [stationElement, setStationElement] = useState<SVGGElement | null>(null);
  const [tooltipHovered, setTooltipHovered] = useState(false);
  const tooltipHideTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Connection tooltip state
  const [connTooltip, setConnTooltip] = useState<{
    from: PositionedAgent;
    to: PositionedAgent;
    conn: TopologyConnection;
  } | null>(null);
  const [connTooltipPos, setConnTooltipPos] = useState({ x: 0, y: 0 });

  // Layout calculation (memoized by topology hash — only recomputes when
  // the shape of the mesh changes, not when display names or other metadata
  // update).
  const topoHash = useMemo(() => hashTopology(agents, connections), [agents, connections]);
  const layoutResult = useMemo(() => calculateTreeLayout(agents, connections), [topoHash]);

  // Committed operator-dragged overrides (short_id → x,y), persisted server-side
  // so the arrangement is shared and recovers on reconnect. Loaded once on
  // mount; updated only on drag COMMIT (pointerup) so the settle solver doesn't
  // re-run every pointermove.
  const [customPositions, setCustomPositions] = useState<PositionMap>({});
  useEffect(() => {
    getPositions()
      .then(setCustomPositions)
      .catch(() => {
        /* older server without this endpoint */
      });
  }, []);
  const customPositionsRef = useRef(customPositions);
  customPositionsRef.current = customPositions;

  // Ephemeral live position(s) during an active drag, overlaid on the settled
  // layout so the drag is smooth without a re-settle each frame.
  const [dragOverride, setDragOverride] = useState<PositionMap | null>(null);
  const dragOverrideRef = useRef(dragOverride);
  dragOverrideRef.current = dragOverride;
  // Which network's label is being edited inline.
  const [editingNetwork, setEditingNetwork] = useState<string | null>(null);

  // Network membership (netId ↔ short_id), rebuilt only when the set of
  // networks or their members changes — not on every poll or rename.
  const memHash = useMemo(() => membershipHash(agents, agentMeta), [agents, agentMeta]);
  const membership = useMemo(
    () => buildMembership(agents, agentMeta),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [memHash],
  );

  // Seed = BFS layout with committed overrides applied (the pins). The
  // constraint solver runs only when the mesh shape, membership, or committed
  // positions change (NOT during a live drag) — `customPositions` only changes
  // on drag commit / reset / initial load, never on a poll, so its identity is
  // already a correct memo key.
  const seedAgents = useMemo(
    () =>
      layoutResult.map(pa => {
        const o = customPositions[pa.short_id];
        return o ? { ...pa, x: o.x, y: o.y } : pa;
      }),
    [layoutResult, customPositions],
  );
  const pinned = useMemo(() => new Set(Object.keys(customPositions)), [customPositions]);
  const solved = useMemo(
    () => solveLayout(seedAgents, membership.byNet, pinned),
    [seedAgents, membership, pinned],
  );

  // Settled positions as a Map — the stable basis for drag clamping (does not
  // change during a drag, so cumulative deltas stay correct).
  const solvedPositions = useMemo(() => {
    const m = new Map<string, Pt>();
    for (const a of solved.positioned) m.set(a.short_id, { x: a.x, y: a.y });
    return m;
  }, [solved]);

  // Splice fresh metadata (renames/status) AND any live drag position over the
  // settled layout. Fresh metadata carries no x/y/labelPos, so the settled
  // geometry is preserved.
  const positionedAgents = useMemo(() => {
    const byId = new Map(agents.map(a => [a.short_id, a]));
    return solved.positioned.map(pa => {
      const fresh = byId.get(pa.short_id);
      const base = fresh ? { ...pa, ...fresh } : pa;
      const live = dragOverride?.[pa.short_id];
      return live ? { ...base, x: live.x, y: live.y } : base;
    });
  }, [solved, agents, dragOverride]);

  // Order, nesting depth and padding per network. Depends on membership and
  // names but not positions, so it survives every drag frame and every poll
  // that doesn't rename anything.
  const netGeom = useMemo(
    () => netGeometry(membership.byNet, labelReaches(layoutResult)),
    [membership, layoutResult],
  );

  // Boxes: the settled boxes normally; during a live drag, re-derived so they
  // track the moving members.
  const boxes = useMemo(() => {
    if (!dragOverride) return solved.boxes;
    const m = new Map<string, Pt>();
    for (const a of positionedAgents) m.set(a.short_id, { x: a.x, y: a.y });
    return deriveBoxes(m, membership.byNet, netGeom);
  }, [dragOverride, solved, positionedAgents, membership, netGeom]);

  const viewBox = useMemo(
    () => calculateViewBox(positionedAgents, boxesBounds(boxes)),
    [positionedAgents, boxes],
  );

  // Cover rectangle for the snap-grid overlay (shown only while dragging).
  // Sized to 3× the base viewBox so the grid still fills the frame under pan.
  const gridCover = useMemo(() => {
    const vb = parseViewBox(viewBox);
    return { x: vb.x - vb.w, y: vb.y - vb.h, w: vb.w * 3, h: vb.h * 3 };
  }, [viewBox]);

  // Live drag-clamp context: settled positions + membership. Assigned during
  // render (refs are safe to mutate here) so the pointer handlers stay stable.
  const dragCtxRef = useRef({
    positions: solvedPositions,
    byNet: membership.byNet,
    byNode: membership.byNode,
    geom: netGeom,
  });
  dragCtxRef.current = {
    positions: solvedPositions,
    byNet: membership.byNet,
    byNode: membership.byNode,
    geom: netGeom,
  };
  // Keyed on a content hash so polls that don't move any station return the
  // SAME array reference — lets Connection.memo() + its useMemo skip the
  // per-connection path recompute unless a station actually moved.
  const stationPositionsKey = useMemo(
    () => positionedAgents.map(a => `${a.x},${a.y}`).join('|'),
    [positionedAgents],
  );
  const stationPositions = useMemo(
    () => positionedAgents.map(a => ({ x: a.x, y: a.y })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [stationPositionsKey],
  );

  // Agent lookup map
  const agentMap = useMemo(() => {
    const m = new Map<string, PositionedAgent>();
    for (const a of positionedAgents) m.set(a.short_id, a);
    return m;
  }, [positionedAgents]);

  // Mesh test results lookup
  const meshResultMap = useMemo(() => {
    const m = new Map<string, MeshTestResult>();
    if (meshTestResults?.results) {
      for (const r of meshTestResults.results) {
        m.set(r.short_id, r);
      }
    }
    return m;
  }, [meshTestResults]);

  // Highlight state
  const pathSet = useMemo(() => new Set(highlightedPath), [highlightedPath]);
  const hasHighlight = highlightedPath.length > 0;

  type HighlightState = 'none' | 'highlighted' | 'dimmed';

  function getStationHighlight(agentId: string): HighlightState {
    if (!hasHighlight) return 'none';
    return pathSet.has(agentId) ? 'highlighted' : 'dimmed';
  }

  function getConnectionHighlight(fromId: string, toId: string): HighlightState {
    if (!hasHighlight) return 'none';
    for (let i = 0; i < highlightedPath.length - 1; i++) {
      if (
        (highlightedPath[i] === fromId && highlightedPath[i + 1] === toId) ||
        (highlightedPath[i] === toId && highlightedPath[i + 1] === fromId)
      ) {
        return 'highlighted';
      }
    }
    return 'dimmed';
  }

  // Station hover handlers
  const handleStationHover = useCallback((agent: PositionedAgent, el: SVGGElement) => {
    if (tooltipHideTimeoutRef.current) {
      clearTimeout(tooltipHideTimeoutRef.current);
      tooltipHideTimeoutRef.current = null;
    }
    setHoveredStation(agent);
    setStationElement(el);
  }, []);

  const handleStationLeave = useCallback(() => {
    tooltipHideTimeoutRef.current = setTimeout(() => {
      if (!tooltipHovered) {
        setHoveredStation(null);
        setStationElement(null);
      }
    }, 150);
  }, [tooltipHovered]);

  const handleTooltipMouseEnter = useCallback(() => {
    setTooltipHovered(true);
    if (tooltipHideTimeoutRef.current) {
      clearTimeout(tooltipHideTimeoutRef.current);
      tooltipHideTimeoutRef.current = null;
    }
  }, []);

  const handleTooltipMouseLeave = useCallback(() => {
    setTooltipHovered(false);
    setHoveredStation(null);
    setStationElement(null);
  }, []);

  // Connection hover handlers
  const handleConnHover = useCallback(
    (e: React.MouseEvent, from: PositionedAgent, to: PositionedAgent, conn: TopologyConnection) => {
      setConnTooltip({ from, to, conn });
      positionConnTooltip(e);
    },
    [],
  );

  const handleConnMove = useCallback((e: React.MouseEvent) => {
    positionConnTooltip(e);
  }, []);

  const handleConnLeave = useCallback(() => {
    setConnTooltip(null);
  }, []);

  function positionConnTooltip(e: React.MouseEvent): void {
    setConnTooltipPos({ x: e.clientX + 15, y: e.clientY + 15 });
  }

  // Sort agents by ID for deterministic render order
  const sortedAgents = useMemo(
    () => [...positionedAgents].sort((a, b) => a.short_id.localeCompare(b.short_id)),
    [positionedAgents],
  );

  // Pan/zoom state. tx/ty/scale apply to a wrapper <g> in viewBox units
  // (NOT pixels). The viewBox itself is recalculated whenever topology
  // changes; we let the user-applied transform float on top of it so a
  // newly-discovered agent doesn't yank the view. Seeded from localStorage
  // so a refresh preserves whatever the operator was looking at.
  const [scale, setScale] = useState(() => readStoredView().scale);
  const [tx, setTx] = useState(() => readStoredView().tx);
  const [ty, setTy] = useState(() => readStoredView().ty);
  const [panning, setPanning] = useState(false);
  type DragState =
    | {
        kind: 'pan';
        pointerId: number;
        startClientX: number;
        startClientY: number;
        startTx: number;
        startTy: number;
      }
    | {
        kind: 'station';
        pointerId: number;
        agentId: string;
        startClientX: number;
        startClientY: number;
        startAgentX: number;
        startAgentY: number;
        moved: boolean;
      }
    | {
        kind: 'box';
        pointerId: number;
        network: string;
        onLabel: boolean;
        startClientX: number;
        startClientY: number;
        startMembers: { id: string; x: number; y: number }[];
        moved: boolean;
      };
  const dragRef = useRef<DragState | null>(null);
  const isTransformed =
    scale !== 1 || tx !== 0 || ty !== 0 || Object.keys(customPositions).length > 0;

  // Live refs so the native wheel listener (attached once) can read the
  // latest values without reattaching on every state change. Assigned at
  // render time — refs are safe to mutate during render, and this drops
  // four otherwise-pointless sync effects.
  const scaleRef = useRef(scale);
  const txRef = useRef(tx);
  const tyRef = useRef(ty);
  const viewBoxRef = useRef(viewBox);
  scaleRef.current = scale;
  txRef.current = tx;
  tyRef.current = ty;
  viewBoxRef.current = viewBox;

  // Wheel zoom must run as a native non-passive listener — React attaches
  // `onWheel` as passive, so `preventDefault()` there is a no-op and the
  // page scrolls behind the map.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;

    const wheelState: {
      armed: boolean;
      firstTime: number;
      accumDelta: number;
      resetTimer: ReturnType<typeof setTimeout> | null;
    } = { armed: false, firstTime: 0, accumDelta: 0, resetTimer: null };

    const resetWheelState = () => {
      wheelState.armed = false;
      wheelState.firstTime = 0;
      wheelState.accumDelta = 0;
      wheelState.resetTimer = null;
    };

    const scheduleReset = (ms: number) => {
      if (wheelState.resetTimer) clearTimeout(wheelState.resetTimer);
      wheelState.resetTimer = setTimeout(resetWheelState, ms);
    };

    const onWheel = (e: WheelEvent) => {
      const now = performance.now();

      if (!wheelState.armed) {
        if (wheelState.firstTime === 0) wheelState.firstTime = now;
        wheelState.accumDelta += Math.abs(e.deltaY);
        const duration = now - wheelState.firstTime;
        const intentional =
          duration >= WHEEL_ARM_MIN_DURATION_MS && wheelState.accumDelta >= WHEEL_ARM_MIN_DELTA;

        scheduleReset(WHEEL_UNARMED_TIMEOUT_MS);

        // Not yet committed — fall through to the browser default (page scroll).
        if (!intentional) return;
        wheelState.armed = true;
      }

      e.preventDefault();

      scheduleReset(WHEEL_ARMED_TIMEOUT_MS);

      const rect = svg.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      const vb = parseViewBox(viewBoxRef.current);
      const cxVb = vb.x + ((e.clientX - rect.left) / rect.width) * vb.w;
      const cyVb = vb.y + ((e.clientY - rect.top) / rect.height) * vb.h;
      const curScale = scaleRef.current;
      const factor = 1 - e.deltaY * 0.001;
      const newScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, curScale * factor));
      if (newScale === curScale) return;
      const ratio = newScale / curScale;
      setTx(cxVb - (cxVb - txRef.current) * ratio);
      setTy(cyVb - (cyVb - tyRef.current) * ratio);
      setScale(newScale);
    };
    svg.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      svg.removeEventListener('wheel', onWheel);
      if (wheelState.resetTimer) clearTimeout(wheelState.resetTimer);
    };
  }, []);

  // Persist the current view to localStorage after it settles. A short
  // debounce coalesces the flood of pointermove updates during a drag.
  useEffect(() => {
    const timer = setTimeout(() => {
      try {
        if (scale === 1 && tx === 0 && ty === 0) {
          localStorage.removeItem(VIEW_STORAGE_KEY);
        } else {
          localStorage.setItem(VIEW_STORAGE_KEY, JSON.stringify({ scale, tx, ty }));
        }
      } catch {
        // storage unavailable — in-memory state is still consistent
      }
    }, 150);
    return () => clearTimeout(timer);
  }, [scale, tx, ty]);

  // Commit dragged positions to the server (called on pointerup, not per
  // frame). Merges the override into the committed set and re-solves.
  const commitPositions = useCallback((override: PositionMap) => {
    const next = { ...customPositionsRef.current, ...override };
    setCustomPositions(next);
    setDragOverride(null);
    putPositions(next).catch(() => {
      /* best-effort; in-memory state stays consistent */
    });
  }, []);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      if (e.button !== 0) return;
      const svg = svgRef.current;
      if (!svg) return;

      // Walk up from the hit target to find the enclosing station <g> (a click
      // on any inner circle or label) or network-box <g> (a grab on the border
      // or label). Track whether the box's label was the target so a click
      // there enters rename mode instead of dragging.
      let node: Element | null = e.target as Element | null;
      let stationG: SVGGElement | null = null;
      let boxG: SVGGElement | null = null;
      let onLabel = false;
      while (node && node !== svg) {
        if (node instanceof Element && node.hasAttribute('data-network-label')) onLabel = true;
        if (node instanceof SVGGElement) {
          if (node.hasAttribute('data-agent-id')) {
            stationG = node;
            break;
          }
          if (node.hasAttribute('data-network-id')) {
            boxG = node;
            break;
          }
        }
        node = node.parentElement;
      }

      if (stationG) {
        const agentId = stationG.getAttribute('data-agent-id');
        const agent = agentId ? agentMap.get(agentId) : null;
        if (!agent) return;
        svg.setPointerCapture(e.pointerId);
        dragRef.current = {
          kind: 'station',
          pointerId: e.pointerId,
          agentId: agent.short_id,
          startClientX: e.clientX,
          startClientY: e.clientY,
          startAgentX: agent.x,
          startAgentY: agent.y,
          moved: false,
        };
        return;
      }

      if (boxG) {
        const network = boxG.getAttribute('data-network-id');
        const members = network ? (dragCtxRef.current.byNet.get(network) ?? []) : [];
        if (!network || members.length === 0) return;
        const startMembers = members
          .map(id => {
            const p = dragCtxRef.current.positions.get(id);
            return p ? { id, x: p.x, y: p.y } : null;
          })
          .filter((m): m is { id: string; x: number; y: number } => m !== null);
        svg.setPointerCapture(e.pointerId);
        dragRef.current = {
          kind: 'box',
          pointerId: e.pointerId,
          network,
          onLabel,
          startClientX: e.clientX,
          startClientY: e.clientY,
          startMembers,
          moved: false,
        };
        return;
      }

      // Empty SVG space — map pan.
      if (e.target !== svg) return;
      svg.setPointerCapture(e.pointerId);
      dragRef.current = {
        kind: 'pan',
        pointerId: e.pointerId,
        startClientX: e.clientX,
        startClientY: e.clientY,
        startTx: tx,
        startTy: ty,
      };
      setPanning(true);
    },
    [agentMap, tx, ty],
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== e.pointerId) return;
      const svg = svgRef.current;
      if (!svg) return;
      const rect = svg.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      const vb = parseViewBox(viewBox);

      if (drag.kind === 'pan') {
        const dxVb = ((e.clientX - drag.startClientX) / rect.width) * vb.w;
        const dyVb = ((e.clientY - drag.startClientY) / rect.height) * vb.h;
        setTx(drag.startTx + dxVb);
        setTy(drag.startTy + dyVb);
        return;
      }

      // Station and box drags share the threshold check + unit conversion.
      const dxClient = e.clientX - drag.startClientX;
      const dyClient = e.clientY - drag.startClientY;
      if (!drag.moved) {
        if (Math.hypot(dxClient, dyClient) < DRAG_THRESHOLD_PX) return;
        drag.moved = true;
        // Dismiss any pending/visible tooltip so it doesn't stick to the
        // cursor while something is being repositioned.
        if (tooltipHideTimeoutRef.current) {
          clearTimeout(tooltipHideTimeoutRef.current);
          tooltipHideTimeoutRef.current = null;
        }
        setHoveredStation(null);
        setStationElement(null);
      }
      // client px → viewBox units → layout units (divide by scale, since the
      // content sits inside the pan/zoom transform group).
      const dxLayout = ((dxClient / rect.width) * vb.w) / scale;
      const dyLayout = ((dyClient / rect.height) * vb.h) / scale;
      const ctx = dragCtxRef.current;
      // Soft snap-to-grid, unless Alt/Option is held for fine positioning.
      const snap = !e.altKey;

      if (drag.kind === 'station') {
        // Keep the agent inside its networks and out of foreign boxes.
        const start = { x: drag.startAgentX, y: drag.startAgentY };
        let desired = { x: start.x + dxLayout, y: start.y + dyLayout };
        if (snap) desired = snapPoint(desired);
        const clamped = clampAgentDrag(drag.agentId, start, desired, ctx);
        setDragOverride({ [drag.agentId]: clamped });
        return;
      }

      // Box drag: rigid, collision-clamped translation of every member. Snap the
      // group's anchor (its members' top-left corner) so the whole box aligns.
      let delta = { x: dxLayout, y: dyLayout };
      if (snap) {
        let ax = Infinity;
        let ay = Infinity;
        for (const m of drag.startMembers) {
          ax = Math.min(ax, m.x);
          ay = Math.min(ay, m.y);
        }
        const target = snapPoint({ x: ax + dxLayout, y: ay + dyLayout });
        delta = { x: target.x - ax, y: target.y - ay };
      }
      const allowed = clampBoxDrag(drag.network, delta, ctx);
      const next: PositionMap = {};
      for (const m of drag.startMembers) {
        next[m.id] = { x: m.x + allowed.x, y: m.y + allowed.y };
      }
      setDragOverride(next);
    },
    [scale, viewBox],
  );

  const endDrag = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== e.pointerId) return;
      svgRef.current?.releasePointerCapture(e.pointerId);
      dragRef.current = null;
      if (drag.kind === 'pan') {
        setPanning(false);
        return;
      }
      if (drag.kind === 'station') {
        // No movement → treat as a click on the station and open its panel.
        if (!drag.moved) {
          onStationClick(drag.agentId);
          return;
        }
        const live = dragOverrideRef.current?.[drag.agentId];
        if (live) commitPositions({ [drag.agentId]: live });
        return;
      }
      // Box drag.
      if (!drag.moved) {
        // A click (no drag) on the label enters rename mode; elsewhere no-op.
        if (drag.onLabel) setEditingNetwork(drag.network);
        return;
      }
      if (dragOverrideRef.current) commitPositions(dragOverrideRef.current);
    },
    [onStationClick, commitPositions],
  );

  const resetView = useCallback(() => {
    setScale(1);
    setTx(0);
    setTy(0);
    setDragOverride(null);
    setCustomPositions({});
    putPositions({}).catch(() => {
      /* best-effort */
    });
  }, []);

  // Track the browser's actual fullscreen state — handles Esc, F11, and any
  // other path that exits fullscreen without our button being clicked.
  useEffect(() => {
    const onChange = () => setIsFullscreen(document.fullscreenElement === containerRef.current);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  const toggleFullscreen = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    if (document.fullscreenElement === el) {
      void document.exitFullscreen();
    } else {
      void el.requestFullscreen().catch(() => {
        // Browser denied (e.g. iframe sandbox, no user gesture) — silent.
      });
    }
  }, []);

  return (
    <section className="metro-section">
      <div ref={containerRef} className={`map-container${isFullscreen ? ' fullscreen' : ''}`}>
        <svg
          ref={svgRef}
          className={`metro-svg${panning ? ' dragging' : ''}`}
          viewBox={viewBox}
          preserveAspectRatio="xMidYMid meet"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        >
          <g transform={`translate(${tx} ${ty}) scale(${scale})`}>
            {dragOverride && (
              <g className="snap-grid" pointerEvents="none" aria-hidden="true">
                <defs>
                  <pattern
                    id="snap-grid-dots"
                    width={SNAP_GRID}
                    height={SNAP_GRID}
                    patternUnits="userSpaceOnUse"
                  >
                    <circle cx={0} cy={0} r={1.3} />
                  </pattern>
                </defs>
                <rect
                  x={gridCover.x}
                  y={gridCover.y}
                  width={gridCover.w}
                  height={gridCover.h}
                  fill="url(#snap-grid-dots)"
                />
              </g>
            )}
            <g className="network-boxes">
              {boxes.map(box => (
                <NetworkBox
                  key={box.id}
                  box={box}
                  name={networkNames[box.id] || box.id}
                  editing={editingNetwork === box.id}
                  onCommit={(id, name) => {
                    setEditingNetwork(null);
                    onNetworkRename(id, name);
                  }}
                  onCancel={() => setEditingNetwork(null)}
                />
              ))}
            </g>
            <g>
              {connections.map(conn => {
                const from = agentMap.get(conn.from_agent);
                const to = agentMap.get(conn.to_agent);
                if (!from || !to) return null;
                const isNew = newConnectionKeys?.has(connKey(conn)) ?? false;
                return (
                  <Connection
                    key={`${conn.from_agent}-${conn.to_agent}`}
                    from={from}
                    to={to}
                    conn={conn}
                    stationPositions={stationPositions}
                    highlightState={getConnectionHighlight(conn.from_agent, conn.to_agent)}
                    isNew={isNew}
                    onHover={handleConnHover}
                    onMove={handleConnMove}
                    onLeave={handleConnLeave}
                  />
                );
              })}
            </g>
            <g>
              {sortedAgents.map(agent => (
                <Station
                  key={agent.short_id}
                  agent={agent}
                  meshResult={meshResultMap.get(agent.short_id)}
                  highlightState={getStationHighlight(agent.short_id)}
                  selected={agent.short_id === selectedAgentId}
                  iconKey={agentMeta[agent.id]?.icon ?? ''}
                  onHover={handleStationHover}
                  onLeave={handleStationLeave}
                  onActivate={onStationClick}
                />
              ))}
            </g>
          </g>
        </svg>
        {isTransformed && (
          <button
            type="button"
            className="btn btn-xs btn-soft border-hairline bg-base-100 absolute top-3 left-3 z-10 border shadow"
            onClick={resetView}
            title="Reset view"
            aria-label="Reset map view"
          >
            Reset view
          </button>
        )}
        <button
          type="button"
          className="btn btn-xs btn-square btn-soft border-hairline bg-base-100 absolute bottom-3 left-3 z-10 border shadow"
          onClick={toggleFullscreen}
          title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
          aria-label={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
        >
          {isFullscreen ? (
            <svg
              width="14"
              height="14"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M10 2v4h4M6 14v-4H2M14 10h-4v4M2 6h4V2" />
            </svg>
          ) : (
            <svg
              width="14"
              height="14"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M2 6V2h4M14 6V2h-4M2 10v4h4M14 10v4h-4" />
            </svg>
          )}
        </button>
        {searchSlot && (
          <div className="absolute top-3 right-3 z-10 flex w-[min(20rem,60%)] justify-end">
            {searchSlot}
          </div>
        )}

        {!agents.some(a => !a.is_local) && (
          <EmptyState
            hasLocalAgent={agents.some(a => a.is_local)}
            onOpenAgentWizard={onOpenAgentWizard}
            onOpenEntryWizard={onOpenEntryWizard}
          />
        )}

        {/* Tooltips render inside the map container so they stay visible
            when the container itself is in browser fullscreen — the
            Fullscreen API only paints descendants of the fullscreened
            element. They are still position:fixed, so the DOM placement
            doesn't affect where they appear on screen. */}
        {hoveredStation && (
          <StationTooltip
            agent={hoveredStation}
            meshResult={meshResultMap.get(hoveredStation.short_id)}
            stationElement={stationElement}
            svgElement={svgRef.current}
            socksAddress={socksAddress}
            note={agentMeta[hoveredStation.id]?.note || ''}
            onMouseEnter={handleTooltipMouseEnter}
            onMouseLeave={handleTooltipMouseLeave}
            onClickAgent={onStationClick}
          />
        )}

        {connTooltip && (
          <ConnectionTooltip
            from={connTooltip.from}
            to={connTooltip.to}
            conn={connTooltip.conn}
            position={connTooltipPos}
          />
        )}
      </div>
    </section>
  );
}

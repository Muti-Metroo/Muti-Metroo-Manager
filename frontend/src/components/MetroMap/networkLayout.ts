// Network-box layout/constraint engine for the topology map.
//
// A network box is the axis-aligned bounding box of its member agents'
// centers, inflated by padding — it is always DERIVED from positions, never
// stored. The engine takes seed positions (the deterministic BFS layout with
// operator drags applied as pins) and:
//   1. settles non-pinned nodes with a few weak forces (cohesion pulls a
//      network's members together; separation avoids overlap; a soft nudge
//      pushes non-members out of boxes), then
//   2. runs a hard ejection pass that guarantees (best-effort) the core
//      invariant: no agent is drawn inside a box for a network it doesn't
//      belong to.
//
// Everything is deterministic (seeded from BFS; Jacobi accumulation is
// order-independent; ties broken by a hash of the id — never Math.random) so
// the same topology + membership always settles the same way.

import type { AgentMetadataMap, TopologyAgentInfo } from '../../api/types';
import { LABEL_VERTICAL_REACH, labelReaches, type PositionedAgent } from './layout';
import { parseNetworks } from '../../util/networks';

export interface Pt {
  x: number;
  y: number;
}

export interface NetworkBox {
  id: string; // network identifier
  members: string[]; // short_ids of present members
  x: number; // rect left  (layout coords)
  y: number; // rect top
  w: number;
  h: number;
  depth: number; // # of networks whose members are a strict subset (nesting rank)
  // True when a non-member could not be kept out of this box (geometrically
  // impossible overlap, or a pinned interloper) — rendered as a warning.
  violated: boolean;
}

export interface Membership {
  byNet: Map<string, string[]>; // netId -> sorted present member short_ids
  byNode: Map<string, Set<string>>; // short_id -> set of netIds
}

// --- Tunable constants (layout coordinate units; BFS grid spacing is 200) ---
// Padding around member centres. It has to clear the station's whole drawn
// footprint, not just its circle: LABEL_VERTICAL_REACH is the far edge of an
// above/below label, and a member with a long name widens it further (see
// padFor). BREATHING_ROOM keeps the label off the border rather than flush
// against it.
const BREATHING_ROOM = 8;
// Extra padding per nesting rank, so nested borders and their name tabs
// separate. Must stay above NetworkBox's labelH (LABEL_FONT_SIZE * 1.5), or a
// nested box's tab overlaps its parent's border.
const LEVEL_INSET = 28;
const CLEARANCE = 22; // a non-member must sit at least this far outside a box
const MIN_DIST = 60; // minimum center-to-center distance between two agents

const SETTLE_ITERS = 240;
const EJECT_ITERS = 80;
const STALL_LIMIT = 6; // consecutive non-improving ejection passes → give up (warn)
const EPS = 0.5; // settle convergence threshold (max per-iter move)
const MAX_STEP = 50; // per-iteration displacement cap during settle
const MAX_EJECT_STEP = 80;
const K_COH = 0.05; // cohesion strength
const K_SEP = 1.0; // separation strength
const K_EXC = 0.5; // soft-exclusion strength
const MARGIN = 1; // tiny overshoot when ejecting so the point clears the edge

// --- Soft snap-to-grid (manual alignment) ---
// Grid spacing and the sticky radius around each grid line, in layout units.
export const SNAP_GRID = 50;
const SNAP_RADIUS = 14;

// snapAxis pulls a value to the nearest grid line ONLY when within SNAP_RADIUS
// of it — sticky grid lines rather than a hard lattice. Between lines the value
// is left untouched, so fine positioning needs no modifier; holding Alt during
// a drag bypasses snapping entirely (handled in MetroMap).
export function snapAxis(v: number, grid = SNAP_GRID, radius = SNAP_RADIUS): number {
  const nearest = Math.round(v / grid) * grid;
  return Math.abs(v - nearest) <= radius ? nearest : v;
}

export function snapPoint(p: Pt): Pt {
  return { x: snapAxis(p.x), y: snapAxis(p.y) };
}

// hashUnit maps an id to a deterministic unit vector — used to break exact
// ties (coincident nodes, a point dead-center in a box) without randomness.
function hashUnit(id: string): Pt {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const theta = (((h >>> 0) % 3600) / 3600) * Math.PI * 2;
  return { x: Math.cos(theta), y: Math.sin(theta) };
}

// buildMembership derives, for the currently-present agents, the netId→members
// and short_id→netIds maps. Membership lives on agentMeta (keyed by full id);
// the map keys everything on short_id.
export function buildMembership(
  agents: TopologyAgentInfo[],
  agentMeta: AgentMetadataMap,
): Membership {
  const byNet = new Map<string, string[]>();
  const byNode = new Map<string, Set<string>>();
  for (const a of agents) {
    const nets = parseNetworks(agentMeta[a.id]?.networks ?? '');
    if (nets.length === 0) continue;
    const set = new Set<string>();
    for (const net of nets) {
      set.add(net);
      const list = byNet.get(net);
      if (list) list.push(a.short_id);
      else byNet.set(net, [a.short_id]);
    }
    byNode.set(a.short_id, set);
  }
  for (const list of byNet.values()) list.sort();
  return { byNet, byNode };
}

// membershipHash is a memo key that changes only when the set of networks or
// their members change — NOT when a display name or unrelated metadata does.
export function membershipHash(agents: TopologyAgentInfo[], agentMeta: AgentMetadataMap): string {
  const parts: string[] = [];
  for (const a of agents) {
    const nets = parseNetworks(agentMeta[a.id]?.networks ?? '');
    if (nets.length > 0) parts.push(`${a.short_id}:${nets.slice().sort().join(',')}`);
  }
  return parts.sort().join('|');
}

// --- Geometry helpers ---

/**
 * Everything about a set of networks that depends on membership and names but
 * NOT on positions: render order, nesting depth, and each network's padding.
 *
 * Computed once and threaded through, because the solver derives boxes up to
 * 321 times per solve and the drag clamps do so ~70 times per pointer frame -
 * recomputing values that cannot change during either is pure waste.
 */
export interface NetGeometry {
  /** Network ids in stable render order. */
  order: string[];
  depths: Map<string, number>;
  /** netId → box padding, label reach and nesting inset already included. */
  pads: Map<string, number>;
}

// A member whose label reaches further than the default pushes the border out
// on all four sides. That keeps the box symmetric and, more importantly, keeps
// the solver's notion of "inside" identical to the rectangle actually drawn.
export function netGeometry(
  byNet: Map<string, string[]>,
  reaches: Map<string, number>,
): NetGeometry {
  const order = [...byNet.keys()].sort((a, b) => a.localeCompare(b));
  const depths = depthMap(byNet);
  const pads = new Map<string, number>();
  for (const id of order) {
    let reach = LABEL_VERTICAL_REACH;
    for (const m of byNet.get(id) ?? []) reach = Math.max(reach, reaches.get(m) ?? 0);
    pads.set(id, reach + BREATHING_ROOM + (depths.get(id) ?? 0) * LEVEL_INSET);
  }
  return { order, depths, pads };
}

// AABB of the present members' centers, inflated by pad. Delegates to boundsOf
// (the point-array form) after resolving ids to points.
function boxOfMembers(
  members: string[],
  pos: Map<string, Pt>,
  pad: number,
): Pt & { w: number; h: number } {
  const pts: Pt[] = [];
  for (const m of members) {
    const p = pos.get(m);
    if (p) pts.push(p);
  }
  return boundsOf(pts, pad);
}

// insideInflated reports whether a point sits within `margin` of a box (i.e.
// inside it, or in the clearance ring around it).
function insideInflated(p: Pt, box: NetworkBox, margin: number): boolean {
  return (
    p.x > box.x - margin &&
    p.x < box.x + box.w + margin &&
    p.y > box.y - margin &&
    p.y < box.y + box.h + margin
  );
}

// shortestExit returns the minimum translation that moves p out of the box's
// inflated rectangle, choosing the nearest of the four edges.
function shortestExit(p: Pt, box: NetworkBox, margin: number): Pt {
  const left = box.x - margin;
  const right = box.x + box.w + margin;
  const top = box.y - margin;
  const bottom = box.y + box.h + margin;
  const dL = p.x - left; // push left
  const dR = right - p.x; // push right
  const dT = p.y - top; // push up
  const dB = bottom - p.y; // push down
  const min = Math.min(dL, dR, dT, dB);
  if (min === dL) return { x: -(dL + MARGIN), y: 0 };
  if (min === dR) return { x: dR + MARGIN, y: 0 };
  if (min === dT) return { x: 0, y: -(dT + MARGIN) };
  return { x: 0, y: dB + MARGIN };
}

// deriveBoxes computes the current box for every network with ≥1 present
// member. depth = number of networks whose member-set is a strict subset, so
// an outer (containing) box gets more padding and its border separates from
// nested ones.
export function deriveBoxes(
  pos: Map<string, Pt>,
  byNet: Map<string, string[]>,
  // Position-independent, so callers in a hot loop precompute it once.
  geom: NetGeometry,
): NetworkBox[] {
  const boxes: NetworkBox[] = [];
  for (const id of geom.order) {
    const members = (byNet.get(id) ?? []).filter(m => pos.has(m));
    if (members.length === 0) continue;
    const rect = boxOfMembers(members, pos, geom.pads.get(id) ?? 0);
    boxes.push(rectToBox(id, members, rect, geom.depths.get(id) ?? 0));
  }
  return boxes;
}

// depthMap ranks each network by nesting depth = number of networks whose
// member-set is a strict subset. Position-independent, so it's computed once
// per membership rather than per solver iteration.
function depthMap(byNet: Map<string, string[]>): Map<string, number> {
  const sets = new Map<string, Set<string>>();
  for (const [id, members] of byNet) sets.set(id, new Set(members));
  const out = new Map<string, number>();
  for (const [id, set] of sets) {
    let depth = 0;
    for (const [other, oset] of sets) {
      if (other !== id && isStrictSubset(oset, set)) depth++;
    }
    out.set(id, depth);
  }
  return out;
}

function isStrictSubset(a: Set<string>, b: Set<string>): boolean {
  if (a.size >= b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

// --- The solver ---

export interface SolveResult {
  positioned: PositionedAgent[];
  boxes: NetworkBox[];
}

// solveLayout takes the seed layout (BFS + operator drags) and returns settled
// positions plus the derived boxes. `pinned` short_ids (operator-dragged) are
// held fixed. With no networks defined this is an identity pass.
export function solveLayout(
  seed: PositionedAgent[],
  byNet: Map<string, string[]>,
  pinned: Set<string>,
): SolveResult {
  const pos = new Map<string, Pt>();
  for (const a of seed) pos.set(a.short_id, { x: a.x, y: a.y });
  // Derived once: neither membership nor names change while the solver runs,
  // and the boxes have to be sized for the labels the operator will see.
  const geom = netGeometry(byNet, labelReaches(seed));

  if (byNet.size > 0) {
    settle(pos, byNet, pinned, geom);
  }
  const boxes = byNet.size > 0 ? eject(pos, byNet, pinned, geom) : [];

  const positioned = seed.map(a => {
    const p = pos.get(a.short_id);
    return p ? { ...a, x: p.x, y: p.y } : a;
  });
  return { positioned, boxes };
}

function settle(
  pos: Map<string, Pt>,
  byNet: Map<string, string[]>,
  pinned: Set<string>,
  geom: NetGeometry,
): void {
  const ids = [...pos.keys()].sort();
  const nets = [...byNet.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const depths = depthMap(byNet); // position-independent — compute once

  for (let iter = 0; iter < SETTLE_ITERS; iter++) {
    const acc = newAcc();

    // Cohesion: pull each network's members toward their centroid.
    for (const [, members] of nets) {
      const present = members.filter(m => pos.has(m));
      if (present.length < 2) continue;
      let cx = 0,
        cy = 0;
      for (const m of present) {
        const p = pos.get(m)!;
        cx += p.x;
        cy += p.y;
      }
      cx /= present.length;
      cy /= present.length;
      for (const m of present) {
        const p = pos.get(m)!;
        addForce(acc, pinned, m, (cx - p.x) * K_COH, (cy - p.y) * K_COH);
      }
    }

    // Separation: keep agents from overlapping.
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = pos.get(ids[i])!;
        const b = pos.get(ids[j])!;
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let d = Math.hypot(dx, dy);
        if (d >= MIN_DIST) continue;
        if (d < 1e-6) {
          const u = hashUnit(ids[i] + ids[j]);
          dx = u.x;
          dy = u.y;
          d = 1;
        }
        const push = ((MIN_DIST - d) / 2) * K_SEP;
        const ux = dx / d;
        const uy = dy / d;
        addForce(acc, pinned, ids[i], -ux * push, -uy * push);
        addForce(acc, pinned, ids[j], ux * push, uy * push);
      }
    }

    // Soft exclusion: nudge non-members out of boxes (the hard guarantee is
    // the separate ejection pass).
    const boxes = deriveBoxes(pos, byNet, geom);
    for (const box of boxes) {
      const memberSet = new Set(box.members);
      for (const id of ids) {
        if (memberSet.has(id)) continue;
        const p = pos.get(id)!;
        if (insideInflated(p, box, CLEARANCE)) {
          const v = shortestExit(p, box, CLEARANCE);
          addForce(acc, pinned, id, v.x * K_EXC, v.y * K_EXC);
        }
      }
    }

    if (applyAcc(pos, acc, MAX_STEP) < EPS) break;
  }
}

function eject(
  pos: Map<string, Pt>,
  byNet: Map<string, string[]>,
  pinned: Set<string>,
  geom: NetGeometry,
): NetworkBox[] {
  const ids = [...pos.keys()].sort();
  const depths = depthMap(byNet); // position-independent — compute once
  const violatedNets = new Set<string>();
  let prevArea = Infinity;
  let stall = 0;

  for (let iter = 0; iter < EJECT_ITERS; iter++) {
    const boxes = deriveBoxes(pos, byNet, geom);
    const acc = newAcc();
    let violations = 0;
    let area = 0;

    for (const box of boxes) {
      const memberSet = new Set(box.members);
      const movableMembers = box.members.filter(m => !pinned.has(m));
      for (const id of ids) {
        if (memberSet.has(id)) continue;
        const p = pos.get(id)!;
        if (!insideInflated(p, box, CLEARANCE)) continue;
        violations++;
        const v = shortestExit(p, box, CLEARANCE);
        area += Math.hypot(v.x, v.y);
        if (!pinned.has(id)) {
          addForce(acc, pinned, id, v.x, v.y);
        } else if (movableMembers.length > 0) {
          // Can't move a pinned interloper — shift the box's movable members
          // the opposite way so the box slides off it.
          for (const m of movableMembers) {
            addForce(acc, pinned, m, -v.x / movableMembers.length, -v.y / movableMembers.length);
          }
        } else {
          violatedNets.add(box.id);
        }
      }
    }

    if (violations === 0) break;
    applyAcc(pos, acc, MAX_EJECT_STEP);

    // Monotone-progress guard: if the total violation isn't shrinking, the
    // configuration is (locally) unsatisfiable — stop instead of oscillating.
    if (area >= prevArea - 1e-3) {
      stall++;
      if (stall >= STALL_LIMIT) break;
    } else {
      stall = 0;
    }
    prevArea = area;
  }

  const boxes = deriveBoxes(pos, byNet, geom);
  for (const box of boxes) {
    if (violatedNets.has(box.id)) {
      box.violated = true;
      continue;
    }
    const memberSet = new Set(box.members);
    box.violated = ids.some(
      id => !memberSet.has(id) && insideInflated(pos.get(id)!, box, CLEARANCE),
    );
  }
  return boxes;
}

// Jacobi accumulator: sum all corrections for a node, apply the average once
// so the result is independent of iteration order.
interface Acc {
  x: Map<string, number>;
  y: Map<string, number>;
  n: Map<string, number>;
}
function newAcc(): Acc {
  return { x: new Map(), y: new Map(), n: new Map() };
}
function addForce(acc: Acc, pinned: Set<string>, id: string, vx: number, vy: number): void {
  if (pinned.has(id)) return;
  acc.x.set(id, (acc.x.get(id) ?? 0) + vx);
  acc.y.set(id, (acc.y.get(id) ?? 0) + vy);
  acc.n.set(id, (acc.n.get(id) ?? 0) + 1);
}
function applyAcc(pos: Map<string, Pt>, acc: Acc, maxStep: number): number {
  let maxMove = 0;
  for (const [id, n] of acc.n) {
    if (n === 0) continue;
    let mx = acc.x.get(id)! / n;
    let my = acc.y.get(id)! / n;
    const mag = Math.hypot(mx, my);
    if (mag > maxStep) {
      mx = (mx / mag) * maxStep;
      my = (my / mag) * maxStep;
    }
    const p = pos.get(id)!;
    pos.set(id, { x: p.x + mx, y: p.y + my });
    maxMove = Math.max(maxMove, Math.hypot(mx, my));
  }
  return maxMove;
}

// --- Drag-time clamping ---

export interface DragContext {
  positions: Map<string, Pt>; // settled positions of everyone (the dragged node included)
  byNet: Map<string, string[]>;
  byNode: Map<string, Set<string>>;
  // Precomputed per membership, so a drag is clamped against the same box
  // edge the operator can see, and without rebuilding it every frame.
  geom: NetGeometry;
}

const BISECT_STEPS = 24;

// clampAgentDrag returns the nearest allowed position to `desired` for a single
// dragged agent: it must stay OUTSIDE boxes it isn't a member of, must not grow
// its own boxes over a non-member, and must not overlap another agent.
export function clampAgentDrag(shortId: string, start: Pt, desired: Pt, ctx: DragContext): Pt {
  const depths = depthMap(ctx.byNet); // position-independent — compute once per drag frame
  const valid = (cand: Pt) => agentPositionValid(shortId, cand, ctx, depths);
  if (valid(desired)) return desired;

  // Try sliding along each axis (the familiar "slide along the wall" feel).
  let cand = start;
  for (const axis of ['x', 'y'] as const) {
    const step = { ...cand, [axis]: desired[axis] };
    if (valid(step)) cand = step;
  }
  if (cand.x !== start.x || cand.y !== start.y) return cand;

  // Fallback: bisect toward the boundary.
  return bisect(start, desired, valid);
}

function agentPositionValid(
  shortId: string,
  cand: Pt,
  ctx: DragContext,
  depths: Map<string, number>,
): boolean {
  const myNets = ctx.byNode.get(shortId) ?? new Set<string>();

  // (a) Stay outside boxes for networks this agent doesn't belong to.
  for (const [net, members] of ctx.byNet) {
    if (myNets.has(net)) continue;
    const present = members.filter(m => m !== shortId && ctx.positions.has(m));
    if (present.length === 0) continue;
    const box = asBox(net, present, ctx.positions, ctx.geom);
    if (insideInflated(cand, box, CLEARANCE)) return false;
  }

  // (b) Moving this agent must not grow one of ITS boxes over a non-member.
  for (const net of myNets) {
    const members = ctx.byNet.get(net) ?? [];
    const memberSet = new Set(members);
    // Bounds of this network with the dragged node at `cand` — computed inline
    // over its members (no full-positions clone).
    const pts: Pt[] = [];
    for (const m of members) {
      if (m === shortId) pts.push(cand);
      else {
        const p = ctx.positions.get(m);
        if (p) pts.push(p);
      }
    }
    if (pts.length === 0) continue;
    const depth = depths.get(net) ?? 0;
    const box = rectToBox(net, members, boundsOf(pts, ctx.geom.pads.get(net) ?? 0), depth);
    for (const [other, op] of ctx.positions) {
      if (other === shortId || memberSet.has(other)) continue;
      if (insideInflated(op, box, CLEARANCE)) return false;
    }
  }

  // (c) No overlap with another agent.
  for (const [other, op] of ctx.positions) {
    if (other === shortId) continue;
    if (Math.hypot(cand.x - op.x, cand.y - op.y) < MIN_DIST) return false;
  }
  return true;
}

// clampBoxDrag returns the maximal feasible fraction of `delta` for a rigid
// translation of an entire network's members: the box slides until it would
// engulf a non-member, then stops. Returns the allowed delta.
export function clampBoxDrag(netId: string, delta: Pt, ctx: DragContext): Pt {
  const members = (ctx.byNet.get(netId) ?? []).filter(m => ctx.positions.has(m));
  if (members.length === 0) return delta;
  const memberSet = new Set(members);
  const nonMembers: Pt[] = [];
  for (const [id, p] of ctx.positions) if (!memberSet.has(id)) nonMembers.push(p);
  const depth = depthMap(ctx.byNet).get(netId) ?? 0;

  const ok = (t: number) => {
    const moved = members.map(m => {
      const p = ctx.positions.get(m)!;
      return { x: p.x + delta.x * t, y: p.y + delta.y * t };
    });
    const box = rectToBox(netId, members, boundsOf(moved, ctx.geom.pads.get(netId) ?? 0), depth);
    return !nonMembers.some(nm => insideInflated(nm, box, CLEARANCE));
  };

  const t = maxFeasibleT(ok);
  return { x: delta.x * t, y: delta.y * t };
}

// maxFeasibleT returns the furthest fraction t ∈ [0,1] the box can slide before
// the FIRST contact with a non-member. Scans forward so a fast drag can't
// tunnel the box over an agent (feasibility along the sweep is not monotone —
// the box can pass over and off a point), then bisects for precision.
function maxFeasibleT(ok: (t: number) => boolean): number {
  if (!ok(0)) return 0; // already violating — don't move further in
  const SCAN = 48;
  let lastGood = 0;
  for (let i = 1; i <= SCAN; i++) {
    const t = i / SCAN;
    if (ok(t)) {
      lastGood = t;
      continue;
    }
    let lo = lastGood;
    let hi = t;
    for (let k = 0; k < BISECT_STEPS; k++) {
      const mid = (lo + hi) / 2;
      if (ok(mid)) lo = mid;
      else hi = mid;
    }
    return lo;
  }
  return 1;
}

// The box for one network, sized from the precomputed geometry so it matches
// the rectangle deriveBoxes draws.
function asBox(id: string, members: string[], pos: Map<string, Pt>, geom: NetGeometry): NetworkBox {
  return rectToBox(
    id,
    members,
    boxOfMembers(members, pos, geom.pads.get(id) ?? 0),
    geom.depths.get(id) ?? 0,
  );
}

function boundsOf(pts: Pt[], pad: number): Pt & { w: number; h: number } {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  if (!isFinite(minX)) return { x: 0, y: 0, w: 0, h: 0 };
  return { x: minX - pad, y: minY - pad, w: maxX - minX + 2 * pad, h: maxY - minY + 2 * pad };
}

function rectToBox(
  id: string,
  members: string[],
  rect: Pt & { w: number; h: number },
  depth: number,
): NetworkBox {
  return { id, members, x: rect.x, y: rect.y, w: rect.w, h: rect.h, depth, violated: false };
}

function bisect(start: Pt, desired: Pt, valid: (p: Pt) => boolean): Pt {
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < BISECT_STEPS; i++) {
    const mid = (lo + hi) / 2;
    const p = {
      x: start.x + (desired.x - start.x) * mid,
      y: start.y + (desired.y - start.y) * mid,
    };
    if (valid(p)) lo = mid;
    else hi = mid;
  }
  return { x: start.x + (desired.x - start.x) * lo, y: start.y + (desired.y - start.y) * lo };
}

// boxesBounds returns the union rectangle of all boxes (for viewBox padding),
// or null when there are none.
export function boxesBounds(
  boxes: NetworkBox[],
): { minX: number; minY: number; maxX: number; maxY: number } | null {
  if (boxes.length === 0) return null;
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const b of boxes) {
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.w);
    maxY = Math.max(maxY, b.y + b.h);
  }
  return { minX, minY, maxX, maxY };
}

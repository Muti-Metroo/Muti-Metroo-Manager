import { describe, it, expect } from 'vitest';
import { labelReach, type PositionedAgent } from '../layout';
import {
  solveLayout,
  deriveBoxes,
  netGeometry,
  clampBoxDrag,
  clampAgentDrag,
  snapAxis,
  type Pt,
} from '../networkLayout';

// The engine only reads short_id/x/y off a PositionedAgent, so a minimal cast
// keeps the fixtures readable.
const mk = (short_id: string, x: number, y: number): PositionedAgent =>
  ({ short_id, id: short_id, x, y, labelPos: 'above' }) as unknown as PositionedAgent;

// Most fixtures don't care about label widths; `reaches` defaults to empty,
// which falls back to the label-free vertical reach.
const boxes_ = (
  pos: Map<string, Pt>,
  byNet: Map<string, string[]>,
  reaches: Map<string, number> = new Map(),
) => deriveBoxes(pos, byNet, netGeometry(byNet, reaches));

const ctx_ = <T extends { byNet: Map<string, string[]> }>(c: T) => ({
  ...c,
  geom: netGeometry(c.byNet, new Map()),
});

const boxFor = (boxes: ReturnType<typeof deriveBoxes>, id: string) => boxes.find(b => b.id === id)!;
const centerInside = (p: Pt, b: { x: number; y: number; w: number; h: number }) =>
  p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h;

describe('solveLayout containment invariant', () => {
  it('ejects a non-member that starts inside a network box', () => {
    const seed = [mk('a1', 0, 0), mk('a2', 400, 0), mk('x1', 200, 0)];
    const byNet = new Map([['A', ['a1', 'a2']]]);
    const { boxes } = solveLayout(seed, byNet, new Set());
    // No box may contain a non-member -> not flagged violated.
    expect(boxFor(boxes, 'A').violated).toBe(false);
  });

  it('keeps members inside their own box and a bystander outside both', () => {
    const seed = [
      mk('a1', 0, 0),
      mk('a2', 100, 0),
      mk('b1', 600, 0),
      mk('b2', 700, 0),
      mk('x1', 350, 0),
    ];
    const byNet = new Map([
      ['A', ['a1', 'a2']],
      ['B', ['b1', 'b2']],
    ]);
    const { positioned, boxes } = solveLayout(seed, byNet, new Set());
    const pos = new Map(positioned.map(a => [a.short_id, { x: a.x, y: a.y } as Pt]));
    for (const m of ['a1', 'a2']) expect(centerInside(pos.get(m)!, boxFor(boxes, 'A'))).toBe(true);
    for (const m of ['b1', 'b2']) expect(centerInside(pos.get(m)!, boxFor(boxes, 'B'))).toBe(true);
    expect(boxFor(boxes, 'A').violated).toBe(false);
    expect(boxFor(boxes, 'B').violated).toBe(false);
  });

  it('is an identity pass when no networks are defined', () => {
    const seed = [mk('a1', 0, 0), mk('a2', 400, 0)];
    const { positioned, boxes } = solveLayout(seed, new Map(), new Set());
    expect(boxes).toEqual([]);
    expect(positioned.map(a => [a.x, a.y])).toEqual([
      [0, 0],
      [400, 0],
    ]);
  });

  it('is deterministic across runs', () => {
    const seed = [mk('a1', 0, 0), mk('a2', 300, 40), mk('x1', 150, 10)];
    const byNet = new Map([['A', ['a1', 'a2']]]);
    const r1 = solveLayout(seed, byNet, new Set());
    const r2 = solveLayout(seed, byNet, new Set());
    expect(r1.positioned.map(a => [a.x, a.y])).toEqual(r2.positioned.map(a => [a.x, a.y]));
  });
});

describe('deriveBoxes nesting depth', () => {
  it('gives a containing network a higher depth than its subset', () => {
    const pos = new Map<string, Pt>([
      ['n1', { x: 0, y: 0 }],
      ['n2', { x: 100, y: 0 }],
      ['n3', { x: 200, y: 0 }],
    ]);
    const byNet = new Map([
      ['A', ['n1', 'n2', 'n3']],
      ['B', ['n1', 'n2']],
    ]);
    const boxes = boxes_(pos, byNet);
    expect(boxFor(boxes, 'A').depth).toBe(1); // B ⊊ A
    expect(boxFor(boxes, 'B').depth).toBe(0);
    // The outer box encloses the inner one.
    const A = boxFor(boxes, 'A');
    const B = boxFor(boxes, 'B');
    expect(A.x).toBeLessThan(B.x);
    expect(A.x + A.w).toBeGreaterThan(B.x + B.w);
  });
});

describe('clampBoxDrag', () => {
  it('stops the box before it engulfs a non-member', () => {
    const ctx = {
      positions: new Map<string, Pt>([
        ['a1', { x: 0, y: 0 }],
        ['x1', { x: 300, y: 0 }],
      ]),
      byNet: new Map([['A', ['a1']]]),
      byNode: new Map([['a1', new Set(['A'])]]),
    };
    const allowed = clampBoxDrag('A', { x: 400, y: 0 }, ctx_(ctx));
    // Full drag (400) would push a1's box right edge past x1 at 300.
    expect(allowed.x).toBeLessThan(400);
    expect(allowed.x).toBeGreaterThan(150);
    // After the allowed move the box must clear x1.
    const box = boxes_(new Map([['a1', { x: allowed.x, y: 0 }]]), ctx.byNet)[0];
    expect(box.x + box.w).toBeLessThan(300);
  });
});

describe('box padding around labels', () => {
  // A station's label is drawn outside its circle and centred on it, so a box
  // padded only for the circle clips the name, the LAMP node's label used to
  // hang below its box's bottom edge.
  const pos = new Map<string, Pt>([['a1', { x: 0, y: 0 }]]);
  const byNet = new Map([['A', ['a1']]]);

  it('clears a below-label without any name information', () => {
    const box = boxes_(pos, byNet)[0];
    // 51.6 is where a `below` label's lower edge sits, measured off the SVG.
    expect(box.y + box.h).toBeGreaterThan(51.6);
    expect(box.y).toBeLessThan(-51.6);
  });

  // A left/right label hangs off the station's edge and runs its FULL width,
  // where an above/below label is centred and only reaches half of it. Sizing
  // side labels as if they were centred left them hanging out of the box.
  it('reserves more room for a side label than a centred one of the same name', () => {
    const name = 'edge-frankfurt-01';
    const centred = labelReach({
      short_id: 'a',
      display_name: name,
      labelPos: 'above',
    } as PositionedAgent);
    const side = labelReach({
      short_id: 'a',
      display_name: name,
      labelPos: 'left',
    } as PositionedAgent);

    expect(side).toBeGreaterThan(centred * 1.9);
    // Enough for the offset plus the whole label, not half of it.
    expect(side).toBeGreaterThan(name.length * 7.8);
  });

  it('widens for a member whose label is wider than that reach', () => {
    const narrow = boxes_(pos, byNet, new Map([['a1', 20]]))[0];
    const wide = boxes_(pos, byNet, new Map([['a1', 120]]))[0];

    // A short name changes nothing; a long one pushes every edge out far
    // enough to contain it.
    expect(narrow.w).toBe(boxes_(pos, byNet)[0].w);
    expect(wide.w / 2).toBeGreaterThan(120);
    expect(wide.h).toBe(wide.w); // stays symmetric around the member
  });
});

describe('snapAxis (soft grid)', () => {
  it('snaps to the nearest grid line when close, stays free in between', () => {
    // grid 50, radius 14
    expect(snapAxis(2)).toBe(0); // within radius of 0
    expect(snapAxis(48)).toBe(50); // within radius of 50
    expect(snapAxis(-48)).toBe(-50);
    expect(snapAxis(25)).toBe(25); // dead center — free
    expect(snapAxis(30)).toBe(30); // 20 from nearest line — free
    expect(snapAxis(100)).toBe(100); // already on a line
  });
});

describe('clampAgentDrag', () => {
  it('blocks a non-member from being dragged into a foreign box', () => {
    const ctx = {
      positions: new Map<string, Pt>([
        ['a1', { x: 0, y: 0 }],
        ['a2', { x: 200, y: 0 }],
        ['x1', { x: 100, y: 400 }],
      ]),
      byNet: new Map([['A', ['a1', 'a2']]]),
      byNode: new Map([
        ['a1', new Set(['A'])],
        ['a2', new Set(['A'])],
      ]),
    };
    // Drag x1 straight up into the middle of box A.
    const result = clampAgentDrag('x1', { x: 100, y: 400 }, { x: 100, y: 0 }, ctx_(ctx));
    const box = boxes_(ctx.positions, ctx.byNet)[0];
    // Its final position must remain outside box A.
    const inside =
      result.x >= box.x &&
      result.x <= box.x + box.w &&
      result.y >= box.y &&
      result.y <= box.y + box.h;
    expect(inside).toBe(false);
  });
});

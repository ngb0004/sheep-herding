import { Meadow, crossings, lineBlocked } from './meadow';
import { Patch, World } from './world';

/**
 * A simple herding "player" used for balance tests and ad clips.
 *
 * Each moment it either gathers (gets behind the sheep furthest from the
 * flock and pushes it back in) or drives (stands behind the flock on the line
 * to the next good patch). `chooseBadPatches` makes it aim for the worst patch,
 * for "fail" ad clips.
 */
export class Autopilot {
  private barkTimer = 0;

  constructor(private readonly chooseBadPatches = false) {}

  update(w: World, dt: number): void {
    let cx = 0, cy = 0, n = 0;
    for (const s of w.sheep) {
      if (s.state !== 'active') continue;
      cx += s.x;
      cy += s.y;
      n++;
    }
    if (n === 0) return;
    cx /= n;
    cy /= n;

    // Goal: the best patch in the next row, or the pen gate near the end.
    let gx = w.level.width / 2;
    let gy = cy + 12;
    const target = this.nextPatch(w, cy);
    if (target) {
      gx = target.x;
      gy = target.y;
    }
    if (cy > w.pen.funnelStart - 12) {
      gx = (w.pen.left + w.pen.right) / 2;
      gy = w.pen.bottom + 4;
    }

    // Gather the worst stray first: a sheep far from the flock, especially one behind it.
    const spread = 2.5 + Math.sqrt(n) * 0.45;
    let worst: { x: number; y: number } | null = null;
    let worstScore = 0;
    for (const s of w.sheep) {
      if (s.state !== 'active') continue;
      const d = Math.hypot(s.x - cx, s.y - cy);
      const behind = Math.max(0, cy - s.y);
      const score = d - spread + behind * 0.6;
      if (score > worstScore) {
        worstScore = score;
        worst = s;
      }
    }

    const presence = w.stats.presence;
    let tx: number;
    let ty: number;
    if (worst && worstScore > 3) {
      // Go round to the far side of the stray and push it toward the flock.
      const dx = worst.x - cx;
      const dy = worst.y - cy;
      const d = Math.hypot(dx, dy) || 1;
      tx = worst.x + (dx / d) * presence * 0.6;
      ty = worst.y + (dy / d) * presence * 0.6;
    } else {
      const dx = gx - cx;
      const dy = Math.max(4, gy - cy);
      const d = Math.hypot(dx, dy);
      const stand = presence * 0.35 + spread * 0.4;
      tx = cx - (dx / d) * stand;
      ty = cy - (dy / d) * stand;
    }

    w.target = {
      u: (tx - w.viewLeft()) / w.viewW,
      v: 1 - (ty - w.camY) / w.viewH,
    };

    this.barkTimer -= dt;
    if (this.barkTimer <= 0 && worst && worstScore > 6) {
      w.bark();
      this.barkTimer = 2.5;
    }
  }

  private nextPatch(w: World, cy: number): Patch | null {
    const ahead = w.patches.filter(
      (p) => p.y > cy + 1 && (p.kind === 'mult' || (p.kind === 'add' && !p.spent) || p.kind === 'thistle' || p.kind === 'bog'),
    );
    if (!ahead.length) return null;
    const rowY = ahead[0].y;
    const row = ahead.filter((p) => Math.abs(p.y - rowY) < 1);
    const value = (p: Patch) => (p.kind === 'mult' ? (p.value ?? 1) * 10 : p.kind === 'add' ? (p.value ?? 0) : -10);
    row.sort((a, b) => value(b) - value(a));
    const pick = this.chooseBadPatches ? row[row.length - 1] : row[0];
    // If the row has only bad patches, aim between them instead.
    if (value(pick) < 0 && !this.chooseBadPatches) return null;
    return pick;
  }
}

/**
 * Round-up herder: sweeps the flock toward the nearest grazing group so it
 * joins, rounds up strays, and drives everyone to the gate once the field is
 * clear (or the light is going).
 */
export class MeadowPilot {
  private barkTimer = 0;

  update(m: Meadow, dt: number): void {
    const c = m.flockCenter();
    const presence = m.stats.presence;
    const p = m.pen;
    const penX = (p.left + p.right) / 2;
    const penY = (p.bottom + p.top) / 2;

    // Nearest group still grazing out in the field.
    let stray: { x: number; y: number } | null = null;
    let strayD = Infinity;
    const from = c.n > 0 ? c : m.dog;
    for (const s of m.sheep) {
      if (s.state !== 'active' || s.gathered) continue;
      const d = Math.hypot(s.x - from.x, s.y - from.y);
      if (d < strayD) {
        strayD = d;
        stray = s;
      }
    }

    // Gathered sheep that drifted away from the flock.
    const spread = 1.2 + Math.sqrt(Math.max(1, c.n)) * 0.5;
    let lost: { x: number; y: number } | null = null;
    let lostD = 0;
    for (const s of m.sheep) {
      if (s.state !== 'active' || !s.gathered) continue;
      const d = Math.hypot(s.x - c.x, s.y - c.y) - spread;
      if (d > lostD) {
        lostD = d;
        lost = s;
      }
    }

    const toGate = Math.hypot(c.x - p.outsideX, c.y - p.outsideY);
    const homeTime = toGate / 2 + 10;
    let subject: { x: number; y: number } = c;
    let goal: { x: number; y: number };

    const gateGoal = m.def.snowball && c.n > 0 ? nextGate(m, c) : null;
    if (m.def.snowball && c.n > 0) {
      // Snowball: drive the flock up through the best gate ahead, then home.
      goal = gateGoal ?? { x: penX, y: penY };
    } else if (c.n === 0 && stray) {
      // Nothing gathered yet: start a flock by pushing the nearest group toward the gate.
      subject = stray;
      goal = { x: p.outsideX, y: p.outsideY };
    } else if (lost && lostD > 5 && m.timeLeft() > homeTime) {
      subject = lost;
      goal = c;
    } else if (stray && m.timeLeft() > homeTime + strayD / 2) {
      goal = stray;
    } else if (toGate > 2.5 && !(c.n > 0 && insideApproach(c, p))) {
      goal = { x: p.outsideX, y: p.outsideY };
    } else {
      goal = { x: penX, y: penY };
    }

    // Circle round to the gate side if the pen itself is in the way.
    const toOutside = goal.x === p.outsideX && goal.y === p.outsideY;
    if (toOutside && crossesBox(subject, goal, p)) {
      const out = 5;
      const corners =
        p.gate === 'east' || p.gate === 'west'
          ? [{ x: p.outsideX, y: p.bottom - out }, { x: p.outsideX, y: p.top + out }]
          : [{ x: p.left - out, y: p.outsideY }, { x: p.right + out, y: p.outsideY }];
      corners.sort((a, b) => Math.hypot(a.x - subject.x, a.y - subject.y) - Math.hypot(b.x - subject.x, b.y - subject.y));
      goal = corners[0];
    }

    // Route through a wall gap or bridge if the way is blocked.
    if (!m.def.snowball && lineBlocked(m.def, subject.x, subject.y, goal.x, goal.y)) {
      let best: { x: number; y: number } | null = null;
      let bestD = Infinity;
      for (const x of crossings(m.def)) {
        const dd = Math.hypot(x.x - subject.x, x.y - subject.y) + Math.hypot(goal.x - x.x, goal.y - x.y);
        if (dd < bestD) {
          bestD = dd;
          best = x;
        }
      }
      if (best) {
        // Line up on our side of the crossing, then go through it.
        const side = Math.sign(subject.y - best.y) || -1;
        const lined = Math.abs(subject.x - best.x) < 2.5 && Math.abs(subject.y - best.y) < 9;
        goal = lined ? { x: best.x, y: best.y - side * 6 } : { x: best.x, y: best.y + side * 5 };
      }
    }

    let dx = goal.x - subject.x;
    let dy = goal.y - subject.y;
    const d = Math.hypot(dx, dy) || 1;
    dx /= d;
    dy /= d;
    // Stand close behind the subject so it keeps moving at a good trot.
    const size = subject === c ? spread : 0.8;
    // A big snowball flock is pushed from its edge, not from a flock-width away.
    const stand = m.def.snowball ? presence * 0.3 + size * 0.45 : presence * 0.3 + size;
    let tx = subject.x - dx * stand;
    let ty = subject.y - dy * stand;
    let snowPush = false;
    if (m.def.snowball && subject === c) {
      // Steer by the body of sheep ahead of the dog (arrivals from behind
      // flow round him), pushing from its back edge.
      const gx = goal.x - m.dog.x;
      const gy = goal.y - m.dog.y;
      const gl = Math.hypot(gx, gy) || 1;
      let ax = 0, ay = 0, an = 0;
      for (const sh of m.sheep) {
        if (sh.state !== 'active' || !sh.gathered) continue;
        if (((sh.x - m.dog.x) * gx + (sh.y - m.dog.y) * gy) / gl < -1) continue;
        ax += sh.x;
        ay += sh.y;
        an++;
      }
      if (an > 0) {
        ax /= an;
        ay /= an;
        let bx = goal.x - ax;
        let by = goal.y - ay;
        const bl = Math.hypot(bx, by) || 1;
        bx /= bl;
        by /= bl;
        let rear = 0;
        for (const sh of m.sheep) {
          if (sh.state !== 'active' || !sh.gathered) continue;
          if (((sh.x - m.dog.x) * gx + (sh.y - m.dog.y) * gy) / gl < -1) continue;
          const along = (sh.x - ax) * bx + (sh.y - ay) * by;
          if (along < rear && along > -spread * 2.5) rear = along;
        }
        tx = ax + bx * (rear - presence * 0.45);
        ty = ay + by * (rear - presence * 0.45);
        snowPush = true;
      }
    }
    // Outrun: if the dog is on the wrong side, swing wide round the flock
    // instead of charging through it (and pushing it the wrong way).
    const ox = m.dog.x - subject.x;
    const oy = m.dog.y - subject.y;
    const od = Math.hypot(ox, oy) || 1;
    if (!snowPush && (ox * dx + oy * dy) / od > -0.5 && od < stand + presence * 2.5) {
      // Orbit just outside the flock's comfort zone, stepping round toward the back.
      const behind = Math.atan2(-dy, -dx);
      let a = Math.atan2(oy, ox);
      let diff = behind - a;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      a += Math.sign(diff) * Math.min(Math.abs(diff), 0.9);
      const r = size + presence * 1.05;
      tx = subject.x + Math.cos(a) * r;
      ty = subject.y + Math.sin(a) * r;
    }
    // Followed the sheep into the pen: walk back out of the gate first.
    if (m.dog.x > p.left && m.dog.x < p.right && m.dog.y > p.bottom && m.dog.y < p.top) {
      tx = p.outsideX;
      ty = p.outsideY;
    }
    m.target = {
      u: (tx - m.viewLeft()) / m.viewW,
      v: 1 - (ty - m.viewBottom()) / m.viewH,
    };

    this.barkTimer -= dt;
    if (this.barkTimer <= 0 && lost && lostD > 9 && !m.def.snowball) {
      m.bark();
      this.barkTimer = 3;
    }
  }
}

/**
 * Snowball route: the best gate in each row, every wall gap and bridge, in order
 * up the field. Returns the first waypoint the flock hasn't passed yet.
 */
function nextGate(m: Meadow, c: { x: number; y: number; n: number }): { x: number; y: number } | null {
  const pts: { x: number; y: number }[] = [];
  const rows = new Map<number, NonNullable<Meadow['def']['gates']>>();
  for (const g of m.def.gates ?? []) rows.set(g.y, [...(rows.get(g.y) ?? []), g]);
  for (const row of rows.values()) {
    // Multipliers win once the flock is big enough; early on a big '+' can be worth more.
    const value = (g: (typeof row)[number]) => (g.kind === 'x' ? Math.max(c.n, 20) * (g.n - 1) : g.n);
    const g = [...row].sort((a, b) => value(b) - value(a))[0];
    pts.push({ x: (g.x0 + g.x1) / 2, y: g.y });
  }
  for (const x of crossings(m.def)) pts.push(x);
  pts.sort((a, b) => a.y - b.y);
  const next = pts.find((p) => p.y > c.y - 1.5);
  return next ? { x: next.x, y: next.y + 6 } : null;
}

/** Is the point already in the lane between the gate's outside point and the pen? */
function insideApproach(c: { x: number; y: number }, p: Meadow['pen']): boolean {
  const half = (p.gateB - p.gateA) / 2;
  switch (p.gate) {
    case 'south':
      return c.y > p.outsideY && c.y < p.bottom + 1 && Math.abs(c.x - p.outsideX) < half;
    case 'north':
      return c.y < p.outsideY && c.y > p.top - 1 && Math.abs(c.x - p.outsideX) < half;
    case 'west':
      return c.x > p.outsideX && c.x < p.left + 1 && Math.abs(c.y - p.outsideY) < half;
    case 'east':
      return c.x < p.outsideX && c.x > p.right - 1 && Math.abs(c.y - p.outsideY) < half;
  }
}

/** Does the line a→b pass through the pen (grown by a margin)? */
function crossesBox(a: { x: number; y: number }, b: { x: number; y: number }, p: Meadow['pen']): boolean {
  const m = 1.5;
  const l = p.left - m, r = p.right + m, lo = p.bottom - m, hi = p.top + m;
  for (let i = 0; i <= 20; i++) {
    const t = i / 20;
    const x = a.x + (b.x - a.x) * t;
    const y = a.y + (b.y - a.y) * t;
    if (x > l && x < r && y > lo && y < hi) return true;
  }
  return false;
}

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

    if (c.n === 0 && stray) {
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
    if (lineBlocked(m.def, subject.x, subject.y, goal.x, goal.y)) {
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
    const stand = presence * 0.3 + size;
    let tx = subject.x - dx * stand;
    let ty = subject.y - dy * stand;
    // Outrun: if the dog is on the wrong side, swing wide round the flock
    // instead of charging through it (and pushing it the wrong way).
    const ox = m.dog.x - subject.x;
    const oy = m.dog.y - subject.y;
    const od = Math.hypot(ox, oy) || 1;
    if ((ox * dx + oy * dy) / od > -0.5 && od < stand + presence * 2.5) {
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
    m.target = {
      u: (tx - m.viewLeft()) / m.viewW,
      v: 1 - (ty - m.viewBottom()) / m.viewH,
    };

    this.barkTimer -= dt;
    if (this.barkTimer <= 0 && lost && lostD > 9) {
      m.bark();
      this.barkTimer = 3;
    }
  }
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

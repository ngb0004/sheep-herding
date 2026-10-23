import { DogStats } from './dog';
import { Rng, clamp, segmentT } from './math';

// ---------------------------------------------------------------- tuning

export const FLOCK = {
  sheepRadius: 0.42,
  lambRadius: 0.3,
  neighborRadius: 2.6,
  separationDist: 1.05,
  separation: 8,
  /** Sheep match their neighbours' movement, much more so when frightened. */
  alignment: 0.8,
  panicAlignment: 3.2,
  cohesion: 0.5,
  /** Frightened sheep bunch up (the "selfish herd"). */
  panicCohesion: 2.6,
  /**
   * Direction a pushed sheep runs: a blend of straight away from the dog and
   * away from the dog *through its neighbours*. The second part makes the
   * edges of the flock curl in instead of fanning out into an arc.
   */
  groupFleeWeight: 0.8,
  /**
   * Flight distance: sheep move away fast enough to keep the dog at the edge
   * of its presence. Speed = dog's approach speed + this × how far inside it is.
   * Walk in and they walk; sprint in and they run.
   */
  flightGain: 0.75,
  /** Sheep closer than this to each other count as one group that flees as a body. */
  groupLink: 2.2,
  /** How fast the flee pace fades once nothing is pushing (1/s). */
  paceDecay: 0.7,
  /** How quickly sheep take on their pushed velocity (1/s). */
  responsiveness: 4.5,
  /** Fright passes from sheep to sheep, losing this share per hop. */
  panicSpread: 0.86,
  panicDecay: 0.85,
  grazeSpeed: 0.5,
  walkSpeed: 1.2,
  runSpeed: 6.4,
  lambSpeedMult: 0.85,
  bogSpeedMult: 0.35,
  wander: 0.45,
  calmDamping: 1.8,
  /** Gathered sheep that drift from the flock want back in. */
  rejoin: 1.2,
  rejoinRange: 22,
  wallAvoidDist: 1.6,
  dogRadius: 0.5,
};

// ----------------------------------------------------------------- types

export type SheepState = 'active' | 'penned' | 'lost';

export interface Sheep {
  id: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  heading: number;
  /** How frightened right now, 0..1. Drives speed. */
  panic: number;
  /** Direction this sheep is fleeing; passed from neighbour to neighbour so the flock moves as a wave. */
  fx: number;
  fy: number;
  /** Pace this sheep is fleeing at, m/s; also passed through the flock. */
  fs: number;
  /** Lingering urge to keep moving after being driven, 0..1 (trail mode). */
  urge: number;
  lamb: boolean;
  state: SheepState;
  /** Part of the player's flock (round-up mode). Trail-mode sheep start gathered. */
  gathered: boolean;
  /** Patch ids this sheep (or the sheep it was cloned from) already used. */
  used: Set<number>;
  wander: number;
  scatter: number;
  /** Animation phase. */
  phase: number;
  inBog: boolean;
}

export interface Dog {
  x: number;
  y: number;
  vx: number;
  vy: number;
  heading: number;
  barkCooldown: number;
}

/** A wall. `thick` widens it (streams); default 0. */
export interface Segment {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  thick?: number;
}

export interface Obstacle {
  kind: 'rock' | 'bush' | 'tree';
  x: number;
  y: number;
  r: number;
}

export interface FlockContext {
  dog: Dog;
  stats: DogStats;
  segments: Segment[];
  obstacles: Obstacle[];
  rng: Rng;
  whistle: boolean;
  /** Centre of the gathered flock, for strays rejoining. */
  flockX: number;
  flockY: number;
  flockN: number;
  /** Mode-specific steering (trail drift, pen pull). Adds to acc. */
  extra?: (s: Sheep, acc: { x: number; y: number }, dt: number) => void;
  /** Mode-specific minimum top speed, e.g. trotting uphill in trail mode. */
  speedFloor?: (s: Sheep) => number;
}

export function makeSheep(id: number, x: number, y: number, rng: Rng, parent?: Sheep, lamb = false): Sheep {
  return {
    id,
    x,
    y,
    vx: parent ? parent.vx + rng.range(-1, 1) : 0,
    vy: parent ? parent.vy + rng.range(-1, 1) : 0,
    heading: parent ? parent.heading : rng.range(0, Math.PI * 2),
    panic: parent ? parent.panic : 0,
    fx: parent ? parent.fx : 0,
    fy: parent ? parent.fy : 0,
    fs: parent ? parent.fs : 0,
    urge: parent ? parent.urge : 0,
    lamb,
    state: 'active',
    gathered: parent ? parent.gathered : false,
    used: parent ? new Set(parent.used) : new Set(),
    wander: rng.range(0, Math.PI * 2),
    scatter: 0,
    phase: rng.range(0, 10),
    inBog: false,
  };
}

// ------------------------------------------------------------- flocking

interface Group {
  sx: number;
  sy: number;
  n: number;
  /** Distance from the dog to this group's nearest sheep. */
  near: number;
  /** Consensus flee direction and pace for the whole group. */
  dx: number;
  dy: number;
  pace: number;
}

/**
 * Steps every active sheep. Penned and lost sheep are left to the caller.
 *
 * Sheep that touch each other form a group, and each group reacts to the dog
 * as one body: it moves away along the line from the dog through its centre,
 * at a pace set by the dog's distance and approach speed. That is what makes
 * the flock feel like a ball you push and steer, instead of fanning out.
 */
export class FlockSim {
  private grid = new Map<number, number[]>();
  private pool: number[][] = [];
  private acc = { x: 0, y: 0 };
  private parent: Int32Array = new Int32Array(0);
  private groups = new Map<number, Group>();

  step(sheep: Sheep[], ctx: FlockContext, dt: number): void {
    const F = FLOCK;
    this.buildGrid(sheep);
    this.buildGroups(sheep, ctx);
    const cs = F.neighborRadius;
    const r2 = cs * cs;
    const dog = ctx.dog;
    const presence = ctx.stats.presence;
    const whistle = ctx.whistle ? 3 : 1;
    const count = sheep.length;

    for (let i = 0; i < count; i++) {
      const s = sheep[i];
      if (s.state !== 'active') continue;
      s.phase += dt * (2 + Math.hypot(s.vx, s.vy) * 2);
      const g = this.groups.get(this.find(i))!;

      // ---- neighbours
      let sepX = 0, sepY = 0, aliX = 0, aliY = 0, cohX = 0, cohY = 0, nUrge = 0, n = 0;
      const gx0 = Math.floor(s.x / cs);
      const gy0 = Math.floor(s.y / cs);
      for (let gx = gx0 - 1; gx <= gx0 + 1; gx++) {
        for (let gy = gy0 - 1; gy <= gy0 + 1; gy++) {
          const list = this.grid.get(cellKey(gx, gy));
          if (!list) continue;
          for (const j of list) {
            if (j === i) continue;
            const o = sheep[j];
            if (o.state !== 'active') continue;
            const dx = s.x - o.x;
            const dy = s.y - o.y;
            const d2 = dx * dx + dy * dy;
            if (d2 > r2 || d2 < 1e-6) continue;
            const d = Math.sqrt(d2);
            if (d < F.separationDist) {
              const k = (F.separationDist - d) / (F.separationDist * d);
              sepX += dx * k;
              sepY += dy * k;
            }
            aliX += o.vx;
            aliY += o.vy;
            cohX += o.x;
            cohY += o.y;
            nUrge += o.urge;
            n++;
          }
        }
      }
      if (n > 0) s.urge = Math.max(s.urge, (nUrge / n) * 0.9);

      const acc = this.acc;
      acc.x = sepX * F.separation;
      acc.y = sepY * F.separation;

      // ---- group consensus: flee as one body
      if (g.pace > 0) {
        s.fx = g.dx;
        s.fy = g.dy;
        s.fs = Math.max(s.fs, g.pace);
        s.panic = Math.max(s.panic, Math.min(1, g.pace / F.runSpeed + 0.3));
      } else {
        s.fs *= Math.max(0, 1 - F.paceDecay * dt);
      }
      const moving = s.fs > 0.3;
      if (moving) {
        acc.x += (s.fx * s.fs - s.vx) * F.responsiveness;
        acc.y += (s.fy * s.fs - s.vy) * F.responsiveness;
      } else if (n > 0) {
        acc.x += (aliX / n - s.vx) * F.alignment;
        acc.y += (aliY / n - s.vy) * F.alignment;
      }

      // ---- right next to the dog: get out of its way
      const ddx = s.x - dog.x;
      const ddy = s.y - dog.y;
      const dd = Math.hypot(ddx, ddy);
      const personal = Math.min(1.8, presence * 0.35);
      if (dd < personal && dd > 0.01) {
        const k = (1 - dd / personal) * 18;
        acc.x += (ddx / dd) * k;
        acc.y += (ddy / dd) * k;
      }

      // ---- stay together: tighter when on the move
      const p = Math.min(1, s.panic);
      const fright = Math.max(p, Math.min(1, s.fs / 3));
      if (n > 0) {
        const c = F.cohesion * whistle * (1 + F.panicCohesion * fright);
        acc.x += (cohX / n - s.x) * c;
        acc.y += (cohY / n - s.y) * c;
      }
      if (g.n > 1 && moving) {
        // Pull toward the group's centre so its edges don't trail off.
        const gcx = g.sx / g.n - s.x;
        const gcy = g.sy / g.n - s.y;
        const r = 0.6 + Math.sqrt(g.n) * 0.45;
        const gl = Math.hypot(gcx, gcy);
        if (gl > r) {
          acc.x += (gcx / gl) * (gl - r) * 2;
          acc.y += (gcy / gl) * (gl - r) * 2;
        }
      }

      // Gathered strays want back to the flock.
      if (s.gathered && ctx.flockN > 1) {
        const fx = ctx.flockX - s.x;
        const fy = ctx.flockY - s.y;
        const fd = Math.hypot(fx, fy);
        const flockR = 1 + Math.sqrt(ctx.flockN) * 0.45;
        if (fd > flockR && fd < F.rejoinRange) {
          const k = F.rejoin * Math.min(3, fd - flockR);
          acc.x += (fx / fd) * k;
          acc.y += (fy / fd) * k;
        }
      }

      // Grazing wander.
      s.wander += ctx.rng.range(-1.5, 1.5) * dt;
      const wanderK = F.wander * (1 - fright);
      acc.x += Math.cos(s.wander) * wanderK;
      acc.y += Math.sin(s.wander) * wanderK;

      ctx.extra?.(s, acc, dt);

      // Soft wall avoidance.
      for (const seg of ctx.segments) {
        const t = segmentT(s.x, s.y, seg.ax, seg.ay, seg.bx, seg.by);
        const px = seg.ax + (seg.bx - seg.ax) * t;
        const py = seg.ay + (seg.by - seg.ay) * t;
        const wx = s.x - px;
        const wy = s.y - py;
        const wd = Math.hypot(wx, wy) - (seg.thick ?? 0);
        if (wd < F.wallAvoidDist && wd > -1) {
          const k = (F.wallAvoidDist - wd) * 6;
          const l = Math.hypot(wx, wy) || 1;
          acc.x += (wx / l) * k;
          acc.y += (wy / l) * k;
        }
      }

      if (s.scatter > 0) {
        s.scatter -= dt;
        s.panic = 1;
      }

      let speedCap = Math.max(F.grazeSpeed, s.fs + 0.8);
      if (dd < personal) speedCap = Math.max(speedCap, F.runSpeed * 0.7);
      if (ctx.speedFloor) speedCap = Math.max(speedCap, ctx.speedFloor(s));
      if (s.scatter > 0) speedCap = Math.max(speedCap, 4);
      if (s.lamb) speedCap *= F.lambSpeedMult;
      if (s.inBog) speedCap *= F.bogSpeedMult;

      s.vx += acc.x * dt;
      s.vy += acc.y * dt;
      const sp = Math.hypot(s.vx, s.vy);
      if (sp > speedCap) {
        s.vx = (s.vx / sp) * speedCap;
        s.vy = (s.vy / sp) * speedCap;
      }
      if (!moving && p < 0.15) {
        const damp = Math.max(0, 1 - F.calmDamping * dt);
        s.vx *= damp;
        s.vy *= damp;
      }
      s.panic = Math.max(0, s.panic - F.panicDecay * dt);

      s.x += s.vx * dt;
      s.y += s.vy * dt;
      collideCircle(s, s.lamb ? F.lambRadius : F.sheepRadius, ctx.segments, ctx.obstacles);
      if (sp > 0.25) s.heading = turnToward(s.heading, Math.atan2(s.vy, s.vx), dt * 6);
    }
  }

  /** Union-find over touching sheep, then each group's response to the dog. */
  private buildGroups(sheep: Sheep[], ctx: FlockContext): void {
    const n = sheep.length;
    if (this.parent.length < n) this.parent = new Int32Array(Math.max(n, this.parent.length * 2));
    for (let i = 0; i < n; i++) this.parent[i] = i;
    const link = FLOCK.groupLink;
    const l2 = link * link;
    const cs = FLOCK.neighborRadius;
    for (let i = 0; i < n; i++) {
      const s = sheep[i];
      if (s.state !== 'active') continue;
      const gx0 = Math.floor(s.x / cs);
      const gy0 = Math.floor(s.y / cs);
      for (let gx = gx0 - 1; gx <= gx0 + 1; gx++) {
        for (let gy = gy0 - 1; gy <= gy0 + 1; gy++) {
          const list = this.grid.get(cellKey(gx, gy));
          if (!list) continue;
          for (const j of list) {
            if (j <= i) continue;
            const o = sheep[j];
            const dx = s.x - o.x;
            const dy = s.y - o.y;
            if (dx * dx + dy * dy < l2) this.union(i, j);
          }
        }
      }
    }

    this.groups.clear();
    const dog = ctx.dog;
    for (let i = 0; i < n; i++) {
      const s = sheep[i];
      if (s.state !== 'active') continue;
      const root = this.find(i);
      let g = this.groups.get(root);
      if (!g) {
        g = { sx: 0, sy: 0, n: 0, near: Infinity, dx: 0, dy: 0, pace: 0 };
        this.groups.set(root, g);
      }
      g.sx += s.x;
      g.sy += s.y;
      g.n++;
      g.near = Math.min(g.near, Math.hypot(s.x - dog.x, s.y - dog.y));
    }

    const F = FLOCK;
    const presence = ctx.stats.presence;
    for (const g of this.groups.values()) {
      if (g.near >= presence) continue;
      let dx = g.sx / g.n - dog.x;
      let dy = g.sy / g.n - dog.y;
      const d = Math.hypot(dx, dy) || 1;
      dx /= d;
      dy /= d;
      const approach = Math.max(0, dog.vx * dx + dog.vy * dy);
      g.dx = dx;
      g.dy = dy;
      g.pace = clamp(approach + F.flightGain * (presence - g.near), F.walkSpeed, F.runSpeed);
    }
  }

  private find(i: number): number {
    const p = this.parent;
    while (p[i] !== i) {
      p[i] = p[p[i]];
      i = p[i];
    }
    return i;
  }

  private union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent[ra] = rb;
  }

  private buildGrid(sheep: Sheep[]): void {
    for (const list of this.grid.values()) {
      list.length = 0;
      this.pool.push(list);
    }
    this.grid.clear();
    const cs = FLOCK.neighborRadius;
    for (let i = 0; i < sheep.length; i++) {
      const s = sheep[i];
      if (s.state !== 'active') continue;
      const key = cellKey(Math.floor(s.x / cs), Math.floor(s.y / cs));
      let list = this.grid.get(key);
      if (!list) {
        list = this.pool.pop() ?? [];
        this.grid.set(key, list);
      }
      list.push(i);
    }
  }
}

// ------------------------------------------------------------------ dog

/** Moves the dog toward a target with limited acceleration: this is the "lag". */
export function moveDog(d: Dog, tx: number, ty: number, stats: DogStats, boosted: boolean, dt: number) {
  const maxSpeed = stats.maxSpeed * (boosted ? 1.5 : 1);
  const accel = stats.accel * (boosted ? 1.6 : 1);
  const dx = tx - d.x;
  const dy = ty - d.y;
  const dist = Math.hypot(dx, dy);
  const arrive = Math.min(1, dist / 2.5);
  const desX = dist > 0.01 ? (dx / dist) * maxSpeed * arrive : 0;
  const desY = dist > 0.01 ? (dy / dist) * maxSpeed * arrive : 0;
  let sx = desX - d.vx;
  let sy = desY - d.vy;
  const sl = Math.hypot(sx, sy);
  const maxDv = accel * dt;
  if (sl > maxDv) {
    sx = (sx / sl) * maxDv;
    sy = (sy / sl) * maxDv;
  }
  d.vx += sx;
  d.vy += sy;
  d.x += d.vx * dt;
  d.y += d.vy * dt;
  if (Math.hypot(d.vx, d.vy) > 0.3) d.heading = Math.atan2(d.vy, d.vx);
  d.barkCooldown = Math.max(0, d.barkCooldown - dt);
}

/** Bark: shoves nearby sheep away from the dog (through the flock, like a push). */
export function barkAt(d: Dog, sheep: Sheep[], stats: DogStats): void {
  d.barkCooldown = stats.barkCooldown;
  for (const s of sheep) {
    if (s.state !== 'active') continue;
    const dx = s.x - d.x;
    const dy = s.y - d.y;
    const dist = Math.hypot(dx, dy);
    if (dist > stats.barkRadius || dist < 0.01) continue;
    const k = (1 - dist / stats.barkRadius) * stats.barkForce;
    s.vx += (dx / dist) * k;
    s.vy += (dy / dist) * k;
    s.fx = dx / dist;
    s.fy = dy / dist;
    s.fs = Math.max(s.fs, Math.min(FLOCK.runSpeed, k));
    s.panic = 1;
  }
}

// -------------------------------------------------------------- helpers

function cellKey(x: number, y: number): number {
  return (x + 2048) * 65536 + (y + 2048);
}

export function turnToward(a: number, b: number, maxStep: number): number {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + clamp(d, -maxStep, maxStep);
}

/** Pushes a moving circle out of walls (including thick ones) and obstacles. */
export function collideCircle(
  b: { x: number; y: number; vx: number; vy: number },
  r: number,
  segments: Segment[],
  obstacles: Obstacle[],
): void {
  for (const seg of segments) {
    const t = segmentT(b.x, b.y, seg.ax, seg.ay, seg.bx, seg.by);
    const px = seg.ax + (seg.bx - seg.ax) * t;
    const py = seg.ay + (seg.by - seg.ay) * t;
    const dx = b.x - px;
    const dy = b.y - py;
    const d = Math.hypot(dx, dy);
    const min = r + (seg.thick ?? 0);
    if (d < min && d > 1e-6) {
      const nx = dx / d;
      const ny = dy / d;
      b.x = px + nx * min;
      b.y = py + ny * min;
      const vn = b.vx * nx + b.vy * ny;
      if (vn < 0) {
        b.vx -= vn * nx;
        b.vy -= vn * ny;
      }
    }
  }
  for (const o of obstacles) {
    const dx = b.x - o.x;
    const dy = b.y - o.y;
    const min = o.r + r;
    const d2 = dx * dx + dy * dy;
    if (d2 < min * min && d2 > 1e-6) {
      const d = Math.sqrt(d2);
      const nx = dx / d;
      const ny = dy / d;
      b.x = o.x + nx * min;
      b.y = o.y + ny * min;
      const vn = b.vx * nx + b.vy * ny;
      if (vn < 0) {
        b.vx -= vn * nx;
        b.vy -= vn * ny;
      }
    }
  }
}

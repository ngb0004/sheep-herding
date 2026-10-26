import { DogStats } from './dog';
import { Dog, FLOCK, FlockSim, Obstacle, Segment, Sheep, barkAt, collideCircle, makeSheep, moveDog } from './flock';
import { MeadowDef, Side, StreamDef, totalSheep } from './meadowLevels';
import { Rng, clamp } from './math';

export type MeadowEvent =
  | { type: 'joined'; x: number; y: number; n: number }
  | { type: 'penned'; x: number; y: number }
  | { type: 'bark'; x: number; y: number; radius: number }
  | { type: 'warning' }
  | { type: 'done'; allPenned: boolean };

export interface PenBox {
  left: number;
  right: number;
  bottom: number;
  top: number;
  gate: Side;
  /** Gate opening along its wall, and a point just outside it. */
  gateA: number;
  gateB: number;
  outsideX: number;
  outsideY: number;
}

/**
 * Round-up mode: an open meadow with sheep scattered in grazing groups.
 * Sweep them into one flock and pen them before the sun goes down.
 * Pure simulation; coordinates in metres, y up the screen.
 */
export class Meadow {
  readonly def: MeadowDef;
  readonly stats: DogStats;
  readonly rng: Rng;
  readonly sheep: Sheep[] = [];
  readonly segments: Segment[];
  /** What the dog bumps into: fences, stone walls and the field edge. He can swim the river. */
  readonly dogSegments: Segment[];
  readonly obstacles: Obstacle[];
  readonly pen: PenBox;
  readonly dog: Dog;
  readonly events: MeadowEvent[] = [];
  readonly total: number;
  readonly limit: number;

  viewW = 20;
  viewH = 40;
  aspect: number;
  camX: number;
  camY: number;
  time = 0;
  phase: 'playing' | 'done' = 'playing';
  penned = 0;
  gathered = 0;
  allPenned = false;
  /** Present for renderer compatibility with trail mode. */
  boneTime = 0;
  whistleTime = 0;
  /** Where the player is pointing, as a fraction of the view (0..1, v = 0 at the top). */
  target = { u: 0.5, v: 0.75 };

  private flock = new FlockSim();
  private warned = false;
  private center = { x: 0, y: 0, n: 0 };

  constructor(def: MeadowDef, stats: DogStats, aspect = 2) {
    this.def = def;
    this.stats = stats;
    this.rng = new Rng(def.seed);
    this.aspect = aspect;
    this.viewH = this.viewW * aspect;
    this.limit = def.seconds;
    this.obstacles = def.obstacles;
    this.pen = penBox(def);
    this.dogSegments = [...boundary(def), ...penWalls(this.pen), ...def.walls.map(([ax, ay, bx, by]) => ({ ax, ay, bx, by }))];
    this.segments = [...this.dogSegments, ...def.streams.flatMap(streamSegments)];

    let id = 1;
    for (const g of def.groups) {
      for (let i = 0; i < g.n; i++) {
        const a = this.rng.range(0, Math.PI * 2);
        const r = Math.sqrt(this.rng.next()) * (0.8 + Math.sqrt(g.n) * 0.5);
        this.sheep.push(makeSheep(id++, g.x + Math.cos(a) * r, g.y + Math.sin(a) * r, this.rng));
      }
    }
    this.total = this.sheep.length;
    if (this.total !== totalSheep(def)) throw new Error('sheep count mismatch');

    this.dog = { x: def.dog.x, y: def.dog.y, vx: 0, vy: 0, heading: Math.PI / 2, barkCooldown: 0 };
    this.camX = def.dog.x;
    this.camY = def.dog.y + this.viewH * 0.25;
    this.clampCamera();
  }

  setViewAspect(aspect: number): void {
    this.aspect = aspect;
    this.viewH = this.viewW * aspect;
  }

  viewLeft(): number {
    return this.camX - this.viewW / 2;
  }

  viewBottom(): number {
    return this.camY - this.viewH / 2;
  }

  timeLeft(): number {
    return Math.max(0, this.limit - this.time);
  }

  activeCount(): number {
    return this.total - this.penned;
  }

  /** Centre of the gathered flock still out in the field. */
  flockCenter(): { x: number; y: number; n: number } {
    return this.center;
  }

  bark(): boolean {
    if (this.dog.barkCooldown > 0 || this.phase === 'done') return false;
    barkAt(this.dog, this.sheep, this.stats);
    this.events.push({ type: 'bark', x: this.dog.x, y: this.dog.y, radius: this.stats.barkRadius });
    return true;
  }

  step(dt: number): void {
    if (this.phase === 'done') return;
    this.time += dt;
    this.updateCenter();
    this.updateDog(dt);
    this.flock.step(this.sheep, {
      dog: this.dog,
      stats: this.stats,
      segments: this.segments,
      obstacles: this.obstacles,
      rng: this.rng,
      whistle: false,
      flockX: this.center.x,
      flockY: this.center.y,
      flockN: this.center.n,
    }, dt);
    this.updateGathering();
    this.updatePen(dt);
    this.updateCamera(dt);

    if (!this.warned && this.timeLeft() <= 15) {
      this.warned = true;
      this.events.push({ type: 'warning' });
    }
    if (this.penned === this.total || this.time >= this.limit) {
      this.allPenned = this.penned === this.total;
      this.phase = 'done';
      this.events.push({ type: 'done', allPenned: this.allPenned });
    }
  }

  private updateCenter(): void {
    let x = 0, y = 0, n = 0;
    for (const s of this.sheep) {
      if (s.state !== 'active' || !s.gathered) continue;
      x += s.x;
      y += s.y;
      n++;
    }
    this.center = n ? { x: x / n, y: y / n, n } : { x: this.dog.x, y: this.dog.y, n: 0 };
  }

  private updateDog(dt: number): void {
    const d = this.dog;
    const tx = this.viewLeft() + this.target.u * this.viewW;
    const ty = this.viewBottom() + (1 - this.target.v) * this.viewH;
    moveDog(d, tx, ty, this.stats, false, dt);
    collideCircle(d, FLOCK.dogRadius, this.dogSegments, this.obstacles);
    d.x = clamp(d.x, 0.6, this.def.width - 0.6);
    d.y = clamp(d.y, 0.6, this.def.height - 0.6);
  }

  /** Sheep the dog has moved (or that got swept up by the moving flock) join it. */
  private updateGathering(): void {
    let n = 0, x = 0, y = 0;
    for (const s of this.sheep) {
      if (s.state !== 'active' || s.gathered) continue;
      if (s.panic > 0.25 || s.fs > 0.6) {
        s.gathered = true;
        this.gathered++;
        n++;
        x += s.x;
        y += s.y;
      }
    }
    if (n > 0) this.events.push({ type: 'joined', x: x / n, y: y / n, n });
  }

  private updatePen(dt: number): void {
    const p = this.pen;
    for (const s of this.sheep) {
      if (s.state === 'penned') {
        // Penned sheep mill about inside.
        s.wander += this.rng.range(-1, 1) * dt;
        s.vx += (Math.cos(s.wander) * 0.4 - s.vx) * dt * 2;
        s.vy += (Math.sin(s.wander) * 0.4 - s.vy) * dt * 2;
        s.x = clamp(s.x + s.vx * dt, p.left + 0.6, p.right - 0.6);
        s.y = clamp(s.y + s.vy * dt, p.bottom + 0.6, p.top - 0.6);
        s.phase += dt * 2;
        continue;
      }
      if (s.state !== 'active') continue;
      if (s.x > p.left + 0.7 && s.x < p.right - 0.7 && s.y > p.bottom + 0.7 && s.y < p.top - 0.7) {
        s.state = 'penned';
        s.fs = 0;
        s.panic = 0;
        if (!s.gathered) {
          s.gathered = true;
          this.gathered++;
        }
        this.penned++;
        this.events.push({ type: 'penned', x: s.x, y: s.y });
      }
    }
  }

  private updateCamera(dt: number): void {
    const c = this.center;
    let fx = this.dog.x;
    let fy = this.dog.y;
    if (c.n > 0 && Math.hypot(c.x - fx, c.y - fy) < 28) {
      fx = fx * 0.55 + c.x * 0.45;
      fy = fy * 0.55 + c.y * 0.45;
    }
    // Keep a little more room ahead of the dog than behind it.
    fy += this.viewH * 0.08;
    const k = Math.min(1, dt * 2.5);
    this.camX += (fx - this.camX) * k;
    this.camY += (fy - this.camY) * k;

    // The dog always stays comfortably on screen, so steering toward an edge
    // carries the camera along instead of trapping the dog there.
    const bandX = this.viewW * 0.26;
    const bandY = this.viewH * 0.2;
    this.camX = clamp(this.camX, this.dog.x - bandX, this.dog.x + bandX);
    this.camY = clamp(this.camY, this.dog.y - bandY, this.dog.y + bandY);

    // Zoom out a little as the flock grows.
    const wantW = clamp(20 + Math.sqrt(this.gathered - this.penned + 1) * 0.8, 20, 30);
    this.viewW += (wantW - this.viewW) * Math.min(1, dt * 0.8);
    this.viewH = this.viewW * this.aspect;
    this.clampCamera();
  }

  private clampCamera(): void {
    const w = this.def.width;
    const h = this.def.height;
    // Enough room past the edges that the dog can always be kept near the middle.
    const mx = this.viewW * 0.26;
    // Extra room past the top edge so the flock never hides under the score bar.
    const top = Math.max(9, this.viewH * 0.32);
    this.camX = w + 2 * mx <= this.viewW ? w / 2 : clamp(this.camX, this.viewW / 2 - mx, w - this.viewW / 2 + mx);
    this.camY = h + mx + top <= this.viewH ? h / 2 + top / 2 : clamp(this.camY, this.viewH / 2 - mx, h - this.viewH / 2 + top);
  }
}

// ---------------------------------------------------------------- geometry

export function penBox(def: MeadowDef): PenBox {
  const p = def.pen;
  const left = p.x;
  const right = p.x + p.w;
  const bottom = p.y;
  const top = p.y + p.h;
  const horizontal = p.gate === 'south' || p.gate === 'north';
  const mid = horizontal ? (left + right) / 2 : (bottom + top) / 2;
  const gateA = mid - p.gateW / 2;
  const gateB = mid + p.gateW / 2;
  const out = 5;
  let outsideX = (left + right) / 2;
  let outsideY = (bottom + top) / 2;
  if (p.gate === 'south') outsideY = bottom - out;
  if (p.gate === 'north') outsideY = top + out;
  if (p.gate === 'west') outsideX = left - out;
  if (p.gate === 'east') outsideX = right + out;
  return { left, right, bottom, top, gate: p.gate, gateA, gateB, outsideX, outsideY };
}

function penWalls(p: PenBox): Segment[] {
  const segs: Segment[] = [];
  const side = (s: Side, ax: number, ay: number, bx: number, by: number) => {
    if (s !== p.gate) {
      segs.push({ ax, ay, bx, by });
      return;
    }
    if (ay === by) {
      segs.push({ ax, ay, bx: p.gateA, by }, { ax: p.gateB, ay, bx, by });
    } else {
      segs.push({ ax, ay, bx, by: p.gateA }, { ax, ay: p.gateB, bx, by });
    }
  };
  side('south', p.left, p.bottom, p.right, p.bottom);
  side('north', p.left, p.top, p.right, p.top);
  side('west', p.left, p.bottom, p.left, p.top);
  side('east', p.right, p.bottom, p.right, p.top);
  return segs;
}

function boundary(def: MeadowDef): Segment[] {
  const { width: w, height: h } = def;
  return [
    { ax: 0, ay: 0, bx: w, by: 0 },
    { ax: w, ay: 0, bx: w, by: h },
    { ax: w, ay: h, bx: 0, by: h },
    { ax: 0, ay: h, bx: 0, by: 0 },
  ];
}

/** Thick segments along the stream, with gaps where the bridges are. */
export function streamSegments(st: StreamDef): Segment[] {
  const out: Segment[] = [];
  const thick = st.width / 2;
  for (let i = 0; i + 1 < st.points.length; i++) {
    const [x1, y1] = st.points[i];
    const [x2, y2] = st.points[i + 1];
    // Split this piece around any bridge spans that cross it.
    let cuts: [number, number][] = [[0, 1]];
    for (const b of st.bridges) {
      const t0 = (b.x - b.w / 2 - x1) / (x2 - x1);
      const t1 = (b.x + b.w / 2 - x1) / (x2 - x1);
      const next: [number, number][] = [];
      for (const [a, z] of cuts) {
        if (t1 <= a || t0 >= z) {
          next.push([a, z]);
          continue;
        }
        if (t0 > a) next.push([a, t0]);
        if (t1 < z) next.push([t1, z]);
      }
      cuts = next;
    }
    for (const [a, z] of cuts) {
      out.push({ ax: x1 + (x2 - x1) * a, ay: y1 + (y2 - y1) * a, bx: x1 + (x2 - x1) * z, by: y1 + (y2 - y1) * z, thick });
    }
  }
  return out;
}

/** y of the stream's centre line at x (for drawing bridges). */
export function streamYAt(st: StreamDef, x: number): number {
  for (let i = 0; i + 1 < st.points.length; i++) {
    const [x1, y1] = st.points[i];
    const [x2, y2] = st.points[i + 1];
    if (x >= x1 && x <= x2) return y1 + ((y2 - y1) * (x - x1)) / (x2 - x1);
  }
  return st.points[st.points.length - 1][1];
}

/** Places where the flock can get past walls and streams: wall gaps and bridges. */
export function crossings(def: MeadowDef): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  for (const st of def.streams) for (const b of st.bridges) out.push({ x: b.x, y: streamYAt(st, b.x) });
  // Horizontal wall runs on the same line: the gaps between them.
  const byY = new Map<number, [number, number][]>();
  for (const [ax, ay, bx, by] of def.walls) {
    if (Math.abs(ay - by) > 0.01) continue;
    const list = byY.get(ay) ?? [];
    list.push([Math.min(ax, bx), Math.max(ax, bx)]);
    byY.set(ay, list);
  }
  for (const [y, runs] of byY) {
    runs.sort((a, b) => a[0] - b[0]);
    let x = 0;
    for (const [a, b] of runs) {
      if (a - x > 3) out.push({ x: (x + a) / 2, y });
      x = Math.max(x, b);
    }
    if (def.width - x > 3) out.push({ x: (x + def.width) / 2, y });
  }
  return out;
}

/** Does the straight line a→b cross a wall or stream (not counting the pen)? */
export function lineBlocked(def: MeadowDef, ax: number, ay: number, bx: number, by: number): boolean {
  const segs = [...def.walls.map(([x1, y1, x2, y2]) => ({ ax: x1, ay: y1, bx: x2, by: y2 })), ...def.streams.flatMap(streamSegments)];
  return segs.some((sg) => segmentsCross(ax, ay, bx, by, sg.ax, sg.ay, sg.bx, sg.by));
}

function segmentsCross(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number): boolean {
  const o = (px: number, py: number, qx: number, qy: number, rx: number, ry: number) => (qx - px) * (ry - py) - (qy - py) * (rx - px);
  const o1 = o(ax, ay, bx, by, cx, cy);
  const o2 = o(ax, ay, bx, by, dx, dy);
  const o3 = o(cx, cy, dx, dy, ax, ay);
  const o4 = o(cx, cy, dx, dy, bx, by);
  return o1 * o2 < 0 && o3 * o4 < 0;
}

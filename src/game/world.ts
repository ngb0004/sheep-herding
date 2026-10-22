import { DogStats } from './dog';
import { LevelDef, PatchDef, PenGeometry, penGeometry } from './levels';
import { Rng, clamp, segmentT } from './math';

// ---------------------------------------------------------------- tuning

export const TUNING = {
  sheepRadius: 0.42,
  lambRadius: 0.3,
  neighborRadius: 2.4,
  separationDist: 1.05,
  separation: 7,
  alignment: 1.1,
  cohesion: 0.7,
  /** Frightened sheep bunch up (the "selfish herd"), which is what makes herding work. */
  panicCohesion: 2.2,
  flee: 26,
  /** Sheep pick up some of their neighbours' panic, so the flock moves as one. */
  panicSpread: 0.65,
  panicDecay: 0.7,
  calmSpeed: 2.8,
  panicSpeed: 6.4,
  lambSpeedMult: 0.85,
  /** Sheep that were recently driven keep trotting uphill at about this speed... */
  drift: 2.3,
  /** ...but left alone they slow to a graze. */
  grazeDrift: 0.5,
  /** Strays want to get back to the flock... */
  rejoin: 1.6,
  /** ...and sheep follow the ones that are moving. */
  urgeSpread: 0.9,
  /** How long the urge to keep moving lasts after the dog's pressure (1/s decay). */
  urgeDecay: 0.25,
  wander: 0.7,
  calmDamping: 1.4,
  bogSpeedMult: 0.35,
  maxSheep: 1500,
  /** How far behind the bottom of the screen a sheep can fall before it is lost. */
  lostMargin: 1.5,
  /** At the pen, the level ends after this long without a new sheep going in... */
  stallSeconds: 6,
  /** ...or after this long in total. */
  finaleSeconds: 40,
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
  panic: number;
  /** Lingering urge to keep moving after being driven, 0..1. */
  urge: number;
  lamb: boolean;
  state: SheepState;
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

export interface Patch extends PatchDef {
  id: number;
  /** One-shot patches (lamb nests, dog pickups) that already fired. */
  spent: boolean;
  /** Sheep gained here recently, for the floating "+N" label. */
  gain: number;
  gainTimer: number;
}

export interface Segment {
  ax: number;
  ay: number;
  bx: number;
  by: number;
}

export type GameEvent =
  | { type: 'gain'; patch: Patch; amount: number; x: number; y: number }
  | { type: 'thistle'; x: number; y: number }
  | { type: 'lost'; x: number; y: number }
  | { type: 'penned'; x: number; y: number }
  | { type: 'bark'; x: number; y: number; radius: number }
  | { type: 'pickup'; kind: 'bone' | 'whistle'; x: number; y: number }
  | { type: 'finale' }
  | { type: 'done' };

export type Phase = 'herding' | 'finale' | 'done';

// ----------------------------------------------------------------- world

/**
 * One level of herding. Pure simulation: no DOM, no canvas. Coordinates are
 * metres, x across the field, y forward up the field.
 */
export class World {
  readonly level: LevelDef;
  readonly pen: PenGeometry;
  readonly stats: DogStats;
  readonly rng: Rng;
  readonly sheep: Sheep[] = [];
  readonly patches: Patch[];
  readonly segments: Segment[];
  readonly events: GameEvent[] = [];
  readonly dog: Dog;

  viewW: number;
  viewH: number;
  camX: number;
  camY: number;
  camSpeed = 0;
  time = 0;
  phase: Phase = 'herding';
  finaleTime = 0;
  /** Seconds since the last sheep went into the pen (during the finale). */
  stallTime = 0;
  penned = 0;
  lost = 0;
  boneTime = 0;
  whistleTime = 0;
  /** Where the player is pointing, as a fraction of the view (0..1, v = 0 at the top). */
  target = { u: 0.5, v: 0.86 };

  private nextId = 1;
  private grid = new Map<number, number[]>();
  private gridPool: number[][] = [];
  private centroid = { x: 0, y: 0, n: 0 };

  constructor(level: LevelDef, stats: DogStats, viewAspect = 2, seed = level.seed) {
    this.level = level;
    this.pen = penGeometry(level);
    this.stats = stats;
    this.rng = new Rng(seed);
    this.viewW = clamp(level.width + 3, 16, 22);
    this.viewH = this.viewW * viewAspect;
    this.camX = level.width / 2;
    this.camY = -this.viewH * 0.12;
    this.patches = level.patches
      .map((p, i) => ({ ...p, id: i + 1, spent: false, gain: 0, gainTimer: 0 }))
      .sort((a, b) => a.y - b.y);
    this.segments = buildWalls(level, this.pen);
    this.dog = { x: level.width / 2, y: this.camY + this.viewH * 0.14, vx: 0, vy: 0, heading: Math.PI / 2, barkCooldown: 0 };

    for (let i = 0; i < level.startSheep; i++) {
      const a = this.rng.range(0, Math.PI * 2);
      const r = Math.sqrt(this.rng.next()) * 3;
      this.addSheep(level.width / 2 + Math.cos(a) * r, 10 + Math.sin(a) * r);
    }
  }

  setViewAspect(aspect: number): void {
    this.viewH = this.viewW * aspect;
  }

  addSheep(x: number, y: number, parent?: Sheep, lamb = false): Sheep | null {
    if (this.aliveCount() >= TUNING.maxSheep) return null;
    const s: Sheep = {
      id: this.nextId++,
      x,
      y,
      vx: parent ? parent.vx + this.rng.range(-1, 1) : 0,
      vy: parent ? parent.vy + this.rng.range(-1, 1) : 0,
      heading: parent ? parent.heading : Math.PI / 2 + this.rng.range(-0.5, 0.5),
      panic: parent ? parent.panic : 0,
      urge: parent ? parent.urge : 0.6,
      lamb,
      state: 'active',
      used: parent ? new Set(parent.used) : new Set(),
      wander: this.rng.range(0, Math.PI * 2),
      scatter: 0,
      phase: this.rng.range(0, 10),
      inBog: false,
    };
    this.sheep.push(s);
    return s;
  }

  aliveCount(): number {
    return this.sheep.length - this.lost;
  }

  activeCount(): number {
    return this.sheep.length - this.lost - this.penned;
  }

  /** Bottom-left of the view in world coordinates. */
  viewLeft(): number {
    return this.camX - this.viewW / 2;
  }

  /** Camera end position: pen fully on screen near the top. */
  camEnd(): number {
    return this.pen.top + 3 - this.viewH;
  }

  progress(): number {
    return clamp(this.camY / Math.max(1, this.camEnd()), 0, 1);
  }

  bark(): boolean {
    if (this.dog.barkCooldown > 0 || this.phase === 'done') return false;
    const { barkRadius, barkForce, barkCooldown } = this.stats;
    this.dog.barkCooldown = barkCooldown;
    for (const s of this.sheep) {
      if (s.state !== 'active') continue;
      const dx = s.x - this.dog.x;
      const dy = s.y - this.dog.y;
      const d = Math.hypot(dx, dy);
      if (d > barkRadius || d < 0.01) continue;
      const k = (1 - d / barkRadius) * barkForce;
      s.vx += (dx / d) * k;
      s.vy += (dy / d) * k;
      s.panic = 1;
    }
    this.events.push({ type: 'bark', x: this.dog.x, y: this.dog.y, radius: barkRadius });
    return true;
  }

  step(dt: number): void {
    if (this.phase === 'done') return;
    this.time += dt;
    this.updateCentroid();
    this.updateCamera(dt);
    this.updateDog(dt);
    this.updateSheep(dt);
    this.updatePatches(dt);
    this.updatePhase(dt);
  }

  // ------------------------------------------------------------- camera

  private updateCentroid(): void {
    let x = 0;
    let y = 0;
    let n = 0;
    for (const s of this.sheep) {
      if (s.state !== 'active') continue;
      x += s.x;
      y += s.y;
      n++;
    }
    this.centroid = n > 0 ? { x: x / n, y: y / n, n } : { x: this.dog.x, y: this.dog.y, n: 0 };
  }

  private updateCamera(dt: number): void {
    const end = this.camEnd();
    if (this.phase === 'herding') {
      // Steady forward pace that frames the flock ~40% up the screen,
      // leaving the dog room behind it. It never stops, so stragglers fall off.
      const scroll = this.level.scroll;
      let speed = scroll;
      if (this.centroid.n > 0) speed += (this.centroid.y - (this.camY + this.viewH * 0.4)) * 0.5;
      speed = clamp(speed, scroll * 0.55, scroll * 3);
      this.camSpeed = speed;
      this.camY = Math.min(end, this.camY + speed * dt);
    } else {
      this.camSpeed = 0;
    }

    const w = this.level.width;
    let tx = w / 2;
    if (w + 2 > this.viewW) {
      const focus = this.centroid.x * 0.7 + this.dog.x * 0.3;
      tx = clamp(focus, this.viewW / 2 - 1, w - this.viewW / 2 + 1);
    }
    this.camX += (tx - this.camX) * Math.min(1, dt * 2.5);
  }

  // ---------------------------------------------------------------- dog

  private updateDog(dt: number): void {
    const d = this.dog;
    const boost = this.boneTime > 0 ? 1.5 : 1;
    const maxSpeed = this.stats.maxSpeed * boost;
    const accel = this.stats.accel * (this.boneTime > 0 ? 1.6 : 1);

    const tx = this.viewLeft() + this.target.u * this.viewW;
    const ty = this.camY + (1 - this.target.v) * this.viewH;
    const dx = tx - d.x;
    const dy = ty - d.y;
    const dist = Math.hypot(dx, dy);

    // Steer toward the finger with limited acceleration: this is the "lag".
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

    collideCircle(d, TUNING.dogRadius, this.segments, this.level.obstacles);
    // The dog stays on screen and out of the pen.
    const minY = this.camY + 0.6;
    const maxY = Math.min(this.camY + this.viewH - 0.6, this.pen.bottom - 0.6);
    if (d.y < minY) { d.y = minY; d.vy = Math.max(d.vy, 0); }
    if (d.y > maxY) { d.y = maxY; d.vy = Math.min(d.vy, 0); }

    const speed = Math.hypot(d.vx, d.vy);
    if (speed > 0.3) d.heading = Math.atan2(d.vy, d.vx);
    d.barkCooldown = Math.max(0, d.barkCooldown - dt);
    this.boneTime = Math.max(0, this.boneTime - dt);
    this.whistleTime = Math.max(0, this.whistleTime - dt);
  }

  // -------------------------------------------------------------- sheep

  private buildGrid(): void {
    for (const list of this.grid.values()) {
      list.length = 0;
      this.gridPool.push(list);
    }
    this.grid.clear();
    const cs = TUNING.neighborRadius;
    for (let i = 0; i < this.sheep.length; i++) {
      const s = this.sheep[i];
      if (s.state === 'lost') continue;
      const key = cellKey(Math.floor(s.x / cs), Math.floor(s.y / cs));
      let list = this.grid.get(key);
      if (!list) {
        list = this.gridPool.pop() ?? [];
        this.grid.set(key, list);
      }
      list.push(i);
    }
  }

  private updateSheep(dt: number): void {
    const T = TUNING;
    this.buildGrid();
    const cs = T.neighborRadius;
    const r2 = cs * cs;
    const dog = this.dog;
    const presence = this.stats.presence;
    const cohesion = T.cohesion * (this.whistleTime > 0 ? 4 : 1);
    const count = this.sheep.length;

    for (let i = 0; i < count; i++) {
      const s = this.sheep[i];
      if (s.state === 'lost') continue;
      s.phase += dt * (2 + Math.hypot(s.vx, s.vy) * 2);

      if (s.state === 'penned') {
        this.updatePenned(s, dt);
        continue;
      }

      // Neighbours.
      let sepX = 0, sepY = 0, aliX = 0, aliY = 0, cohX = 0, cohY = 0, nPanic = 0, nUrge = 0, n = 0;
      const cx = Math.floor(s.x / cs);
      const cy = Math.floor(s.y / cs);
      for (let gx = cx - 1; gx <= cx + 1; gx++) {
        for (let gy = cy - 1; gy <= cy + 1; gy++) {
          const list = this.grid.get(cellKey(gx, gy));
          if (!list) continue;
          for (const j of list) {
            if (j === i) continue;
            const o = this.sheep[j];
            if (o.state !== 'active') continue;
            const dx = s.x - o.x;
            const dy = s.y - o.y;
            const d2 = dx * dx + dy * dy;
            if (d2 > r2 || d2 < 1e-6) continue;
            const d = Math.sqrt(d2);
            if (d < T.separationDist) {
              const k = (T.separationDist - d) / (T.separationDist * d);
              sepX += dx * k;
              sepY += dy * k;
            }
            aliX += o.vx;
            aliY += o.vy;
            cohX += o.x;
            cohY += o.y;
            nPanic += o.panic;
            nUrge += o.urge;
            n++;
          }
        }
      }

      let ax = sepX * T.separation;
      let ay = sepY * T.separation;
      if (n > 0) {
        ax += (aliX / n - s.vx) * T.alignment;
        ay += (aliY / n - s.vy) * T.alignment;
        const c = cohesion * (1 + T.panicCohesion * Math.min(1, s.panic));
        ax += (cohX / n - s.x) * c;
        ay += (cohY / n - s.y) * c;
        s.panic = Math.max(s.panic, (nPanic / n) * T.panicSpread);
        s.urge = Math.max(s.urge, (nUrge / n) * T.urgeSpread);
      }

      // Pull back toward the whole flock when straying from it.
      const fdx = this.centroid.x - s.x;
      const fdy = this.centroid.y - s.y;
      const fd = Math.hypot(fdx, fdy);
      const flockR = 1 + Math.sqrt(this.centroid.n) * 0.35;
      if (fd > flockR) {
        const k = T.rejoin * Math.min(3, fd - flockR);
        ax += (fdx / fd) * k;
        ay += (fdy / fd) * k;
      }

      // The dog.
      const ddx = s.x - dog.x;
      const ddy = s.y - dog.y;
      const dd = Math.hypot(ddx, ddy);
      if (dd < presence && dd > 0.01) {
        const fear = 1 - dd / presence;
        const k = T.flee * fear;
        ax += (ddx / dd) * k;
        ay += (ddy / dd) * k;
        s.panic = Math.max(s.panic, Math.min(1, fear * 1.6));
      }

      // Wander, and trot uphill if recently driven.
      s.urge = Math.max(s.panic, s.urge - T.urgeDecay * dt);
      // Once funnelled toward the open gate, sheep follow each other in.
      if (s.y > this.pen.funnelStart) {
        s.urge = Math.max(s.urge, 0.8);
        ax += ((this.pen.left + this.pen.right) / 2 - s.x) * 0.6;
      }
      const drift = T.grazeDrift + (T.drift - T.grazeDrift) * Math.min(1, s.urge * 1.5);
      s.wander += this.rng.range(-1.5, 1.5) * dt;
      ax += Math.cos(s.wander) * T.wander;
      ay += Math.sin(s.wander) * T.wander + (drift - s.vy) * 0.8;

      // Wall and rock avoidance (soft), hard collision below.
      for (const seg of this.segments) {
        const t = segmentT(s.x, s.y, seg.ax, seg.ay, seg.bx, seg.by);
        const px = seg.ax + (seg.bx - seg.ax) * t;
        const py = seg.ay + (seg.by - seg.ay) * t;
        const wx = s.x - px;
        const wy = s.y - py;
        const wd = Math.hypot(wx, wy);
        if (wd < 1.6 && wd > 0.001) {
          const k = (1.6 - wd) * 6;
          ax += (wx / wd) * k;
          ay += (wy / wd) * k;
        }
      }

      if (s.scatter > 0) {
        s.scatter -= dt;
        s.panic = 1;
      }

      s.vx += ax * dt;
      s.vy += ay * dt;

      let maxSpeed = T.calmSpeed + (T.panicSpeed - T.calmSpeed) * Math.min(1, s.panic);
      if (s.lamb) maxSpeed *= T.lambSpeedMult;
      if (s.inBog) maxSpeed *= T.bogSpeedMult;
      const sp = Math.hypot(s.vx, s.vy);
      if (sp > maxSpeed) {
        s.vx = (s.vx / sp) * maxSpeed;
        s.vy = (s.vy / sp) * maxSpeed;
      }
      if (s.panic < 0.2) {
        // Calm sheep settle back into their trot instead of stopping dead.
        const damp = Math.max(0, 1 - T.calmDamping * dt);
        s.vx *= damp;
        s.vy = drift + (s.vy - drift) * damp;
      }
      s.panic = Math.max(0, s.panic - T.panicDecay * dt);

      s.x += s.vx * dt;
      s.y += s.vy * dt;
      collideCircle(s, s.lamb ? T.lambRadius : T.sheepRadius, this.segments, this.level.obstacles);
      if (sp > 0.25) s.heading = turnToward(s.heading, Math.atan2(s.vy, s.vx), dt * 6);

      // Into the pen?
      if (s.y > this.pen.bottom + 0.6 && s.x > this.pen.left && s.x < this.pen.right) {
        s.state = 'penned';
        s.panic = 0;
        this.penned++;
        this.stallTime = 0;
        this.events.push({ type: 'penned', x: s.x, y: s.y });
        continue;
      }

      // Fell off the back of the screen?
      if (s.y < this.camY - T.lostMargin) {
        s.state = 'lost';
        this.lost++;
        this.events.push({ type: 'lost', x: s.x, y: this.camY });
      }
    }
  }

  private updatePenned(s: Sheep, dt: number): void {
    s.wander += this.rng.range(-1, 1) * dt;
    s.vx += (Math.cos(s.wander) * 0.4 - s.vx) * dt * 2;
    s.vy += (Math.sin(s.wander) * 0.4 - s.vy) * dt * 2;
    s.x = clamp(s.x + s.vx * dt, this.pen.left + 0.5, this.pen.right - 0.5);
    s.y = clamp(s.y + s.vy * dt, this.pen.bottom + 0.7, this.pen.top - 0.5);
    if (Math.hypot(s.vx, s.vy) > 0.1) s.heading = turnToward(s.heading, Math.atan2(s.vy, s.vx), dt * 3);
  }

  // ------------------------------------------------------------ patches

  private updatePatches(dt: number): void {
    for (const p of this.patches) {
      if (p.gainTimer > 0) {
        p.gainTimer -= dt;
        if (p.gainTimer <= 0) p.gain = 0;
      }
    }

    // Dog pickups.
    for (const p of this.patches) {
      if (p.spent || (p.kind !== 'bone' && p.kind !== 'whistle')) continue;
      if (Math.abs(this.dog.x - p.x) < p.w / 2 + 0.4 && Math.abs(this.dog.y - p.y) < p.h / 2 + 0.4) {
        p.spent = true;
        if (p.kind === 'bone') this.boneTime = 3.5;
        else this.whistleTime = 4.5;
        this.events.push({ type: 'pickup', kind: p.kind, x: p.x, y: p.y });
      }
    }

    // Sheep patches. Only the sheep that actually walk over a patch are affected.
    const count = this.sheep.length;
    for (let i = 0; i < count; i++) {
      const s = this.sheep[i];
      if (s.state !== 'active') continue;
      s.inBog = false;
      for (const p of this.patches) {
        if (p.y - p.h / 2 > s.y + 1) break; // sorted by y
        if (p.y + p.h / 2 < s.y - 1) continue;
        if (Math.abs(s.x - p.x) > p.w / 2 || Math.abs(s.y - p.y) > p.h / 2) continue;
        this.applyPatch(s, p);
      }
    }
  }

  private applyPatch(s: Sheep, p: Patch): void {
    switch (p.kind) {
      case 'bog':
        s.inBog = true;
        return;
      case 'mult': {
        if (s.used.has(p.id)) return;
        s.used.add(p.id);
        let made = 0;
        for (let k = 1; k < (p.value ?? 1); k++) {
          const child = this.addSheep(s.x + this.rng.range(-0.6, 0.6), s.y + this.rng.range(-0.6, 0.6), s, s.lamb);
          if (child) made++;
        }
        if (made > 0) this.gained(p, made, s.x, s.y);
        return;
      }
      case 'add': {
        s.used.add(p.id);
        if (p.spent) return;
        p.spent = true;
        let made = 0;
        for (let k = 0; k < (p.value ?? 0); k++) {
          const lamb = this.addSheep(p.x + this.rng.range(-p.w / 3, p.w / 3), p.y + this.rng.range(-1, 1), s, true);
          if (lamb) made++;
        }
        if (made > 0) this.gained(p, made, p.x, p.y);
        return;
      }
      case 'thistle':
        if (s.used.has(p.id)) return;
        s.used.add(p.id);
        s.scatter = 1.1;
        s.panic = 1;
        {
          const a = this.rng.range(0, Math.PI * 2);
          s.vx = Math.cos(a) * 4;
          s.vy = Math.sin(a) * 4 - 1;
        }
        this.events.push({ type: 'thistle', x: s.x, y: s.y });
        return;
      default:
        return;
    }
  }

  private gained(p: Patch, amount: number, x: number, y: number): void {
    p.gain += amount;
    p.gainTimer = 1.4;
    this.events.push({ type: 'gain', patch: p, amount, x, y });
  }

  // -------------------------------------------------------------- phase

  private updatePhase(dt: number): void {
    const active = this.activeCount();
    if (this.phase === 'herding' && this.camY >= this.camEnd() - 0.01) {
      this.phase = 'finale';
      this.events.push({ type: 'finale' });
    }
    if (this.phase === 'finale') {
      this.finaleTime += dt;
      // The stall clock only runs once sheep have started going in.
      if (this.penned > 0) this.stallTime += dt;
    }
    const timeUp =
      this.phase === 'finale' && (this.finaleTime >= TUNING.finaleSeconds || this.stallTime >= TUNING.stallSeconds);
    if (active === 0 || timeUp) {
      // Anyone still out in the field when time runs out is lost.
      for (const s of this.sheep) {
        if (s.state === 'active') {
          s.state = 'lost';
          this.lost++;
        }
      }
      this.phase = 'done';
      this.events.push({ type: 'done' });
    }
  }
}

// ---------------------------------------------------------------- helpers

function cellKey(x: number, y: number): number {
  return (x + 512) * 65536 + (y + 512);
}

function turnToward(a: number, b: number, maxStep: number): number {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + clamp(d, -maxStep, maxStep);
}

function buildWalls(level: LevelDef, pen: PenGeometry): Segment[] {
  const w = level.width;
  const far = -10000;
  return [
    { ax: 0, ay: far, bx: 0, by: pen.funnelStart },
    { ax: 0, ay: pen.funnelStart, bx: pen.left, by: pen.bottom },
    { ax: pen.left, ay: pen.bottom, bx: pen.left, by: pen.top },
    { ax: pen.left, ay: pen.top, bx: pen.right, by: pen.top },
    { ax: pen.right, ay: pen.top, bx: pen.right, by: pen.bottom },
    { ax: pen.right, ay: pen.bottom, bx: w, by: pen.funnelStart },
    { ax: w, ay: pen.funnelStart, bx: w, by: far },
  ];
}

/** Pushes a moving circle out of walls and rocks. */
function collideCircle(
  b: { x: number; y: number; vx: number; vy: number },
  r: number,
  segments: Segment[],
  obstacles: LevelDef['obstacles'],
): void {
  for (const seg of segments) {
    const t = segmentT(b.x, b.y, seg.ax, seg.ay, seg.bx, seg.by);
    const px = seg.ax + (seg.bx - seg.ax) * t;
    const py = seg.ay + (seg.by - seg.ay) * t;
    const dx = b.x - px;
    const dy = b.y - py;
    const d = Math.hypot(dx, dy);
    if (d < r && d > 1e-6) {
      const nx = dx / d;
      const ny = dy / d;
      b.x = px + nx * r;
      b.y = py + ny * r;
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

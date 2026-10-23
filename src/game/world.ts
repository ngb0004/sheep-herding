import { DogStats } from './dog';
import { Dog, FLOCK, FlockSim, Segment, Sheep, barkAt, collideCircle, makeSheep, moveDog, turnToward } from './flock';
import { LevelDef, PatchDef, PenGeometry, penGeometry } from './levels';
import { Rng, clamp } from './math';

// ---------------------------------------------------------------- tuning

/** Trail-mode rules. Flocking itself lives in flock.ts and is shared with round-up mode. */
export const TUNING = {
  /** Sheep that were recently driven keep trotting uphill at about this speed... */
  drift: 2.0,
  /** ...and the urge to keep going fades this fast (1/s) once the dog lets up. */
  urgeDecay: 0.35,
  maxSheep: 1500,
  /** How far behind the bottom of the screen a sheep can fall before it is lost. */
  lostMargin: 1.5,
  /** At the pen, the level ends after this long without a new sheep going in... */
  stallSeconds: 6,
  /** ...or after this long in total. */
  finaleSeconds: 40,
};

// ----------------------------------------------------------------- types

export type { Dog, Segment, Sheep, SheepState } from './flock';

export interface Patch extends PatchDef {
  id: number;
  /** One-shot patches (lamb nests, dog pickups) that already fired. */
  spent: boolean;
  /** Sheep gained here recently, for the floating "+N" label. */
  gain: number;
  gainTimer: number;
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
  private flock = new FlockSim();
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
      const s = this.addSheep(level.width / 2 + Math.cos(a) * r, 10 + Math.sin(a) * r);
      if (s) {
        s.urge = 0.6;
        s.heading = Math.PI / 2;
      }
    }
  }

  setViewAspect(aspect: number): void {
    this.viewH = this.viewW * aspect;
  }

  addSheep(x: number, y: number, parent?: Sheep, lamb = false): Sheep | null {
    if (this.aliveCount() >= TUNING.maxSheep) return null;
    const s = makeSheep(this.nextId++, x, y, this.rng, parent, lamb);
    s.gathered = true;
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
    barkAt(this.dog, this.sheep, this.stats);
    this.events.push({ type: 'bark', x: this.dog.x, y: this.dog.y, radius: this.stats.barkRadius });
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
    const tx = this.viewLeft() + this.target.u * this.viewW;
    const ty = this.camY + (1 - this.target.v) * this.viewH;
    moveDog(d, tx, ty, this.stats, this.boneTime > 0, dt);
    collideCircle(d, FLOCK.dogRadius, this.segments, this.level.obstacles);
    // The dog stays on screen and out of the pen.
    const minY = this.camY + 0.6;
    const maxY = Math.min(this.camY + this.viewH - 0.6, this.pen.bottom - 0.6);
    if (d.y < minY) { d.y = minY; d.vy = Math.max(d.vy, 0); }
    if (d.y > maxY) { d.y = maxY; d.vy = Math.min(d.vy, 0); }
    this.boneTime = Math.max(0, this.boneTime - dt);
    this.whistleTime = Math.max(0, this.whistleTime - dt);
  }

  // -------------------------------------------------------------- sheep

  private updateSheep(dt: number): void {
    const pen = this.pen;
    const penMid = (pen.left + pen.right) / 2;
    this.flock.step(this.sheep, {
      dog: this.dog,
      stats: this.stats,
      segments: this.segments,
      obstacles: this.level.obstacles,
      rng: this.rng,
      whistle: this.whistleTime > 0,
      flockX: this.centroid.x,
      flockY: this.centroid.y,
      flockN: this.centroid.n,
      extra: (s, acc, dt) => {
        // Driven sheep keep trotting uphill for a while; left alone they slow to a graze.
        s.urge = Math.max(s.panic, s.urge - TUNING.urgeDecay * dt);
        // Once funnelled toward the open gate, sheep follow each other in.
        if (s.y > pen.funnelStart) {
          s.urge = Math.max(s.urge, 0.8);
          acc.x += (penMid - s.x) * 0.6;
        }
        const drift = TUNING.drift * Math.min(1, s.urge * 1.5);
        if (drift > 0.05) acc.y += (drift - s.vy) * 1.2;
      },
      speedFloor: (s) => TUNING.drift * Math.min(1, s.urge * 1.5),
    }, dt);

    for (const s of this.sheep) {
      if (s.state === 'penned') {
        this.updatePenned(s, dt);
        continue;
      }
      if (s.state !== 'active') continue;
      // Into the pen?
      if (s.y > pen.bottom + 0.6 && s.x > pen.left && s.x < pen.right) {
        s.state = 'penned';
        s.panic = 0;
        this.penned++;
        this.stallTime = 0;
        this.events.push({ type: 'penned', x: s.x, y: s.y });
        continue;
      }
      // Fell off the back of the screen?
      if (s.y < this.camY - TUNING.lostMargin) {
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

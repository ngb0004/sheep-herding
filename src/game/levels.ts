import { Rng, clamp } from './math';

export type PatchKind = 'mult' | 'add' | 'thistle' | 'bog' | 'bone' | 'whistle';

/** Rectangular area on the ground. x, y is the centre; y runs forward up the field. */
export interface PatchDef {
  kind: PatchKind;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Multiplier for 'mult', sheep added for 'add'. */
  value?: number;
}

export interface ObstacleDef {
  kind: 'rock' | 'bush';
  x: number;
  y: number;
  r: number;
}

export interface LevelDef {
  id: number;
  name: string;
  /** Field width between the stone walls, m. */
  width: number;
  /** Distance from the start line to the pen gate, m. */
  length: number;
  /** Camera drift up the field, m/s. */
  scroll: number;
  startSheep: number;
  patches: PatchDef[];
  obstacles: ObstacleDef[];
  seed: number;
}

export interface PenGeometry {
  left: number;
  right: number;
  /** Gate line (bottom of the pen). */
  bottom: number;
  top: number;
  /** Where the side walls start angling in towards the gate. */
  funnelStart: number;
}

export function penGeometry(level: LevelDef): PenGeometry {
  const w = Math.min(level.width * 0.55, 14);
  const cx = level.width / 2;
  return {
    left: cx - w / 2,
    right: cx + w / 2,
    bottom: level.length,
    top: level.length + 9,
    funnelStart: level.length - 16,
  };
}

const mult = (x: number, y: number, value: number, w = 6): PatchDef => ({ kind: 'mult', x, y, w, h: 3.2, value });
const add = (x: number, y: number, value: number, w = 5): PatchDef => ({ kind: 'add', x, y, w, h: 3, value });
const thistle = (x: number, y: number, w = 6): PatchDef => ({ kind: 'thistle', x, y, w, h: 3.2 });
const bog = (x: number, y: number, w = 6, h = 5): PatchDef => ({ kind: 'bog', x, y, w, h });
const bone = (x: number, y: number): PatchDef => ({ kind: 'bone', x, y, w: 1.6, h: 1.6 });
const whistle = (x: number, y: number): PatchDef => ({ kind: 'whistle', x, y, w: 1.6, h: 1.6 });
const rock = (x: number, y: number, r = 1.3): ObstacleDef => ({ kind: 'rock', x, y, r });
const bush = (x: number, y: number, r = 1.6): ObstacleDef => ({ kind: 'bush', x, y, r });

const HAND_MADE: LevelDef[] = [
  {
    id: 1,
    name: 'Green Hollow',
    width: 18,
    length: 170,
    scroll: 2.3,
    startSheep: 10,
    seed: 101,
    patches: [
      mult(9, 35, 2, 10),
      mult(5, 72, 3), thistle(13, 72),
      add(9, 102, 6),
      bog(5, 132), mult(13, 132, 2),
    ],
    obstacles: [rock(9, 55), bush(3, 118, 1.3)],
  },
  {
    id: 2,
    name: 'Clover Brae',
    width: 22,
    length: 230,
    scroll: 2.4,
    startSheep: 12,
    seed: 202,
    patches: [
      mult(6, 35, 2), add(16, 35, 5),
      bone(11, 55),
      thistle(5, 80), mult(11, 80, 3, 5), thistle(17, 80),
      bog(11, 112, 10, 6),
      mult(16, 145, 2), mult(6, 145, 3, 4),
      whistle(11, 168),
      add(11, 190, 8, 8),
    ],
    obstacles: [rock(11, 60), rock(4, 125), bush(18, 125), rock(11, 160, 1.1)],
  },
  {
    id: 3,
    name: 'Whispering Glen',
    width: 30,
    length: 280,
    scroll: 2.5,
    startSheep: 12,
    seed: 303,
    patches: [
      mult(8, 38, 2), thistle(22, 38),
      add(15, 70, 6),
      bog(8, 100, 8, 7), mult(22, 100, 3),
      bone(15, 120),
      mult(6, 150, 2, 5), thistle(15, 150, 5), mult(24, 150, 2, 5),
      whistle(15, 175),
      thistle(8, 205), mult(15, 205, 3, 5), thistle(22, 205),
      add(15, 240, 10, 8),
    ],
    obstacles: [rock(15, 52), bush(5, 82), bush(25, 82), rock(15, 135, 1.6), rock(7, 228), rock(23, 228)],
  },
];

/** Final sizes of the hand-made fields; they were laid out bigger and are scaled to fit. */
const HAND_MADE_SIZES: [number, number][] = [[14, 125], [17, 165], [22, 200]];

function scaled(level: LevelDef, [width, length]: [number, number]): LevelDef {
  const kx = width / level.width;
  const ky = length / level.length;
  return {
    ...level,
    width,
    length,
    patches: level.patches.map((p) => ({
      ...p,
      x: p.x * kx,
      y: p.y * ky,
      w: p.kind === 'bone' || p.kind === 'whistle' ? p.w : p.w * Math.max(kx, 0.9),
    })),
    obstacles: level.obstacles.map((o) => ({ ...o, x: o.x * kx, y: o.y * ky })),
  };
}

/** Hand-made levels first, then seeded procedural fields that keep getting bigger. */
export function getLevel(id: number): LevelDef {
  if (id <= HAND_MADE.length) return scaled(HAND_MADE[id - 1], HAND_MADE_SIZES[id - 1]);
  return generateLevel(id);
}

export function generateLevel(id: number): LevelDef {
  const rng = new Rng(id * 7919 + 13);
  const tier = id - HAND_MADE.length;
  const width = clamp(24 + tier * 2, 24, 40);
  const length = clamp(190 + tier * 10, 190, 300);
  const patches: PatchDef[] = [];
  const obstacles: ObstacleDef[] = [];
  let best = 12 + Math.floor(tier / 2);
  const startSheep = best;

  const lane = (i: number, lanes: number) => (width / lanes) * (i + 0.5);

  for (let y = 32; y < length - 28; y += rng.range(24, 32)) {
    const roll = rng.next();
    const lanes = width > 40 ? 4 : 3;
    // Switch to additive gains once a multiplier would blow past the sheep cap.
    const wanted = rng.next() < 0.35 ? 3 : 2;
    const multValue = best * wanted <= 1200 ? wanted : best * 2 <= 1200 ? 2 : 0;
    const goodLane = Math.floor(rng.next() * lanes);

    if (roll < 0.55) {
      // A choice row: one great patch, the rest bad or merely okay.
      for (let i = 0; i < lanes; i++) {
        const x = lane(i, lanes);
        if (i === goodLane) {
          patches.push(multValue ? mult(x, y, multValue, 5) : add(x, y, 20, 5));
        } else if (rng.next() < 0.6) {
          patches.push(thistle(x, y, 5));
        } else {
          patches.push(add(x, y, 3 + Math.floor(rng.next() * 4), 4));
        }
      }
      best = multValue ? best * multValue : best + 20;
    } else if (roll < 0.75) {
      // Bog strip with one dry gap.
      for (let i = 0; i < lanes; i++) {
        if (i !== goodLane) patches.push(bog(lane(i, lanes), y, width / lanes - 1, 6));
      }
      patches.push(add(lane(goodLane, lanes), y, 6, 4));
      best += 6;
    } else if (roll < 0.9) {
      if (best * 2 <= 1200) {
        patches.push(mult(rng.range(6, width - 6), y, 2, 7));
        best *= 2;
      } else {
        patches.push(add(rng.range(6, width - 6), y, 25, 7));
        best += 25;
      }
      obstacles.push(rock(rng.range(4, width - 4), y + 12, rng.range(1, 1.8)));
    } else {
      patches.push(rng.next() < 0.5 ? bone(rng.range(4, width - 4), y) : whistle(rng.range(4, width - 4), y));
      obstacles.push(bush(rng.range(4, width - 4), y + 8));
    }
    if (rng.next() < 0.5) obstacles.push(rock(rng.range(3, width - 3), y + rng.range(10, 18), rng.range(0.9, 1.6)));
  }

  return {
    id,
    name: PLACE_NAMES[(id - 1) % PLACE_NAMES.length] + (id > PLACE_NAMES.length ? ' ' + roman(Math.ceil(id / PLACE_NAMES.length)) : ''),
    width,
    length,
    scroll: clamp(2.55 + tier * 0.05, 2.55, 3.1),
    startSheep,
    patches,
    obstacles,
    seed: id * 977,
  };
}

const PLACE_NAMES = [
  'Green Hollow', 'Clover Brae', 'Whispering Glen', 'Lough Meadow', 'Kerry Heights', 'Moher Downs',
  'Connemara Run', 'Bramble Ridge', 'Burren Flats', 'Slieve Pasture', 'Wicklow Commons', 'Dingle Rise',
];

function roman(n: number): string {
  return ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'][n] ?? String(n);
}

/** Most sheep you could pen by hitting every best patch with the whole flock. */
export function maxSheep(level: LevelDef): number {
  return bestRun(level, 1);
}

/**
 * Sheep from a strong but realistic run: the right patch every row, caught by
 * `share` of the flock. Star targets are based on this, not the perfect run.
 */
export function bestRun(level: LevelDef, share: number): number {
  const rows = new Map<number, PatchDef[]>();
  for (const p of level.patches) {
    const key = Math.round(p.y);
    if (!rows.has(key)) rows.set(key, []);
    rows.get(key)!.push(p);
  }
  let n = level.startSheep;
  for (const key of [...rows.keys()].sort((a, b) => a - b)) {
    let best = n;
    for (const p of rows.get(key)!) {
      if (p.kind === 'mult') best = Math.max(best, n * (1 - share) + n * share * (p.value ?? 1));
      if (p.kind === 'add') best = Math.max(best, n + (p.value ?? 0));
    }
    n = best;
  }
  return Math.round(n);
}

/** Sheep needed for 1, 2 and 3 stars. */
export function starTargets(level: LevelDef): [number, number, number] {
  const good = bestRun(level, 0.7);
  return [Math.round(good * 0.3), Math.round(good * 0.55), Math.round(good * 0.8)];
}

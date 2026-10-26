import { Obstacle } from './flock';
import { Rng, clamp } from './math';

export type Side = 'north' | 'south' | 'east' | 'west';

export interface PenDef {
  /** Bottom-left corner. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Which side the gate opening is on. */
  gate: Side;
  gateW: number;
  /** Length of the funnel fences flaring out from the gate posts (0 = none). */
  wings?: number;
  /** How strongly sheep near the gate follow the leaders in, 0..1. Early meadows are forgiving. */
  draw?: number;
}

export interface StreamDef {
  /** Roughly left-to-right polyline along the middle of the water. */
  points: [number, number][];
  width: number;
  /** Bridges, as x ranges where the stream can be crossed. */
  bridges: { x: number; w: number }[];
}

/** An open-meadow round-up: gather the scattered sheep and pen them before sunset. */
export interface MeadowDef {
  id: number;
  name: string;
  width: number;
  height: number;
  /** Daylight, seconds. */
  seconds: number;
  seed: number;
  dog: { x: number; y: number };
  pen: PenDef;
  /** Little groups of grazing sheep scattered over the field. */
  groups: { x: number; y: number; n: number }[];
  /** Dry-stone walls as [x1, y1, x2, y2]. Leave gaps to pass through. */
  walls: [number, number, number, number][];
  streams: StreamDef[];
  obstacles: Obstacle[];
}

const tree = (x: number, y: number, r = 1.8): Obstacle => ({ kind: 'tree', x, y, r });
const rock = (x: number, y: number, r = 1.3): Obstacle => ({ kind: 'rock', x, y, r });
const bush = (x: number, y: number, r = 1.5): Obstacle => ({ kind: 'bush', x, y, r });

const HAND_MADE: MeadowDef[] = [
  {
    id: 1,
    name: 'Home Paddock',
    width: 56,
    height: 76,
    seconds: 75,
    seed: 11,
    dog: { x: 28, y: 5 },
    pen: { x: 21, y: 63, w: 14, h: 9, gate: 'south', gateW: 9, wings: 7, draw: 1 },
    groups: [
      { x: 28, y: 15, n: 6 },
      { x: 12, y: 32, n: 5 },
      { x: 44, y: 38, n: 6 },
      { x: 24, y: 50, n: 5 },
    ],
    walls: [],
    streams: [],
    obstacles: [tree(46, 18), rock(16, 56), bush(40, 56), tree(8, 66)],
  },
  {
    id: 2,
    name: 'Gorse Hill',
    width: 76,
    height: 96,
    seconds: 95,
    seed: 22,
    dog: { x: 10, y: 6 },
    pen: { x: 58, y: 80, w: 12, h: 10, gate: 'west', gateW: 8, wings: 6, draw: 0.75 },
    groups: [
      { x: 20, y: 18, n: 7 },
      { x: 58, y: 14, n: 6 },
      { x: 66, y: 36, n: 5 },
      { x: 14, y: 40, n: 6 },
      { x: 36, y: 68, n: 8 },
      { x: 16, y: 80, n: 6 },
    ],
    walls: [
      [0, 50, 32, 50],
      [44, 50, 76, 50],
    ],
    streams: [],
    obstacles: [bush(40, 28, 2), bush(44, 31, 1.6), rock(26, 60), tree(60, 60), bush(8, 62), tree(48, 86)],
  },
  {
    id: 3,
    name: 'River Field',
    width: 86,
    height: 106,
    seconds: 110,
    seed: 33,
    dog: { x: 44, y: 5 },
    pen: { x: 8, y: 90, w: 14, h: 10, gate: 'east', gateW: 7, wings: 5, draw: 0.55 },
    groups: [
      { x: 18, y: 14, n: 8 },
      { x: 68, y: 12, n: 7 },
      { x: 44, y: 30, n: 6 },
      { x: 76, y: 36, n: 6 },
      { x: 26, y: 72, n: 6 },
      { x: 60, y: 80, n: 7 },
    ],
    walls: [],
    streams: [
      {
        points: [[0, 50], [28, 56], [56, 49], [86, 55]],
        width: 4,
        bridges: [{ x: 66, w: 7 }],
      },
    ],
    obstacles: [tree(30, 22), rock(58, 24), bush(12, 40), tree(78, 70), rock(40, 84), bush(70, 94)],
  },
];

export function getMeadow(id: number): MeadowDef {
  if (id <= HAND_MADE.length) return HAND_MADE[id - 1];
  return generateMeadow(id);
}

/** Seeded procedural meadows that keep getting bigger and busier. */
export function generateMeadow(id: number): MeadowDef {
  const rng = new Rng(id * 4813 + 7);
  const tier = id - HAND_MADE.length;
  const width = clamp(80 + tier * 4, 80, 120);
  const height = clamp(100 + tier * 5, 100, 150);

  const sides: Side[] = ['south', 'east', 'west'];
  const gate = rng.pick(sides);
  const pw = 13;
  const ph = 10;
  const px = gate === 'east' ? 6 : gate === 'west' ? width - pw - 6 : rng.range(8, width - pw - 8);
  // Funnel wings and the follow-the-leader pull taper off as the meadows get harder.
  const pen: PenDef = {
    x: px, y: height - ph - 6, w: pw, h: ph, gate, gateW: 7,
    wings: clamp(5 - tier * 0.4, 0, 5),
    draw: clamp(0.5 - tier * 0.04, 0.15, 0.5),
  };

  const groups: MeadowDef['groups'] = [];
  const count = clamp(5 + Math.floor(tier / 2), 5, 10);
  for (let i = 0; i < count; i++) {
    for (let tries = 0; tries < 30; tries++) {
      const x = rng.range(8, width - 8);
      const y = rng.range(10, height - 22);
      const clash = groups.some((g) => Math.hypot(g.x - x, g.y - y) < 14);
      if (!clash) {
        groups.push({ x, y, n: 5 + Math.floor(rng.next() * (4 + tier / 2)) });
        break;
      }
    }
  }

  const walls: MeadowDef['walls'] = [];
  const streams: StreamDef[] = [];
  const midY = height * rng.range(0.4, 0.6);
  if (tier % 2 === 0) {
    const pts: [number, number][] = [];
    for (let i = 0; i <= 4; i++) pts.push([(width * i) / 4, midY + rng.range(-5, 5)]);
    streams.push({ points: pts, width: 4, bridges: [{ x: rng.range(12, width - 12), w: 7 }] });
  } else {
    const gap = rng.range(12, width - 12);
    walls.push([0, midY, gap - 5, midY], [gap + 5, midY, width, midY]);
  }

  const obstacles: Obstacle[] = [];
  for (let i = 0; i < 8 + tier; i++) {
    const kind = rng.pick(['tree', 'rock', 'bush'] as const);
    obstacles.push({ kind, x: rng.range(4, width - 4), y: rng.range(8, height - 4), r: kind === 'tree' ? 1.8 : rng.range(1, 1.7) });
  }

  return {
    id,
    name: NAMES[(id - 1) % NAMES.length],
    width,
    height,
    seconds: Math.round(95 + count * 6 + tier * 2),
    seed: id * 131,
    dog: { x: width / 2, y: 5 },
    pen,
    groups,
    walls,
    streams,
    obstacles,
  };
}

const NAMES = [
  'Home Paddock', 'Gorse Hill', 'River Field', 'Kerry Commons', 'Burren Rise', 'Wicklow Glen',
  'Dingle Downs', 'Connemara Flats', 'Moher Heights', 'Slieve Meadow', 'Bantry Fold', 'Achill Pasture',
];

export function totalSheep(def: MeadowDef): number {
  return def.groups.reduce((a, g) => a + g.n, 0);
}

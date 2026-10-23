import { describe, expect, it } from 'vitest';
import { DEFAULT_LEVELS, dogStats } from './dog';
import { Dog, FlockSim, Sheep, makeSheep } from './flock';
import { Rng } from './math';

const DT = 1 / 60;
const stats = dogStats(DEFAULT_LEVELS);

/** A loose ball of grazing sheep around (0, 0) on an open field. */
function flockOf(n: number, seed = 3): Sheep[] {
  const rng = new Rng(seed);
  const sheep: Sheep[] = [];
  for (let i = 0; i < n; i++) {
    const a = rng.range(0, Math.PI * 2);
    const r = Math.sqrt(rng.next()) * Math.sqrt(n) * 0.55;
    const s = makeSheep(i + 1, Math.cos(a) * r, Math.sin(a) * r, rng);
    s.gathered = true;
    sheep.push(s);
  }
  return sheep;
}

function centroid(sheep: Sheep[]) {
  let x = 0, y = 0;
  for (const s of sheep) { x += s.x; y += s.y; }
  return { x: x / sheep.length, y: y / sheep.length };
}

/** Width of the flock across the push direction (x), robust to outliers. */
function width(sheep: Sheep[]) {
  const xs = sheep.map((s) => s.x).sort((a, b) => a - b);
  return xs[Math.floor(xs.length * 0.9)] - xs[Math.floor(xs.length * 0.1)];
}

/**
 * A dog that walks steadily up the field (+y) behind the flock at `speed`,
 * starting a few metres behind its rear and aiming `offsetX` off-centre.
 */
function push(sheep: Sheep[], seconds: number, opts: { speed?: number; offsetX?: number } = {}) {
  const flock = new FlockSim();
  const rng = new Rng(9);
  const c0 = centroid(sheep);
  const rear = Math.min(...sheep.map((s) => s.y));
  const speed = opts.speed ?? 3.5;
  const dog: Dog = { x: c0.x + (opts.offsetX ?? 0), y: rear - 3, vx: 0, vy: speed, heading: Math.PI / 2, barkCooldown: 0 };
  for (let i = 0; i < seconds * 60; i++) {
    const c = centroid(sheep);
    // Keep station off-centre if asked, otherwise follow the flock's centre line.
    dog.vx = ((opts.offsetX !== undefined ? c.x + opts.offsetX : c.x) - dog.x) * 2;
    dog.x += dog.vx * DT;
    dog.y += dog.vy * DT;
    flock.step(sheep, { dog, stats, segments: [], obstacles: [], rng, whistle: false, flockX: c.x, flockY: c.y, flockN: sheep.length }, DT);
  }
  return dog;
}

describe('push feel', () => {
  it('pushing from behind moves the flock forward without bending it into an arc', () => {
    const sheep = flockOf(40);
    const w0 = width(sheep);
    const c0 = centroid(sheep);
    push(sheep, 4);
    const c1 = centroid(sheep);
    const w1 = width(sheep);
    expect(c1.y - c0.y).toBeGreaterThan(9); // it really moves, at the dog's pace
    expect(Math.abs(c1.x - c0.x)).toBeLessThan(2.5); // straight ahead
    expect(w1).toBeLessThan(w0 * 1.5 + 1); // no horseshoe
  });

  it('a hard push moves the flock faster than a gentle one', () => {
    const gentle = flockOf(30);
    const hard = flockOf(30);
    const g0 = centroid(gentle).y;
    const h0 = centroid(hard).y;
    push(gentle, 3, { speed: 1.5 });
    push(hard, 3, { speed: 5 });
    expect(centroid(hard).y - h0).toBeGreaterThan((centroid(gentle).y - g0) * 1.5);
  });

  it('pushing from the back-left steers the flock to the right', () => {
    const sheep = flockOf(30);
    const c0 = centroid(sheep);
    push(sheep, 3, { offsetX: -3 });
    expect(centroid(sheep).x - c0.x).toBeGreaterThan(1.5);
  });

  it('left alone, sheep only graze', () => {
    const sheep = flockOf(20);
    const flock = new FlockSim();
    const rng = new Rng(4);
    const dog: Dog = { x: 0, y: -60, vx: 0, vy: 0, heading: 0, barkCooldown: 0 };
    const c0 = centroid(sheep);
    for (let i = 0; i < 60 * 5; i++) {
      const c = centroid(sheep);
      flock.step(sheep, { dog, stats, segments: [], obstacles: [], rng, whistle: false, flockX: c.x, flockY: c.y, flockN: 20 }, DT);
    }
    const c1 = centroid(sheep);
    expect(Math.hypot(c1.x - c0.x, c1.y - c0.y)).toBeLessThan(2.5);
  });
});

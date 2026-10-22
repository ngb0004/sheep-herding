import { describe, expect, it } from 'vitest';
import { Autopilot } from './autopilot';
import { DEFAULT_LEVELS, DogLevels, dogStats } from './dog';
import { getLevel, maxSheep, starTargets } from './levels';

const SLOW = { timeout: 60_000 };
import { World } from './world';

/** Plays a level headlessly with the autopilot. Portrait phone aspect. */
export function playLevel(id: number, dog: DogLevels = DEFAULT_LEVELS, pilot: Autopilot | null = new Autopilot()) {
  const w = new World(getLevel(id), dogStats(dog), 844 / 390);
  const dt = 1 / 60;
  for (let i = 0; i < 60 * 300 && w.phase !== 'done'; i++) {
    pilot?.update(w, dt);
    w.step(dt);
  }
  const targets = starTargets(w.level);
  return {
    penned: w.penned,
    lost: w.lost,
    max: maxSheep(w.level),
    targets: starTargets(w.level).join('/'),
    stars: targets.filter((t) => w.penned >= t).length,
    seconds: Math.round(w.time),
  };
}

const MAXED: DogLevels = { speed: 10, agility: 10, presence: 10, bark: 10 };

describe('balance', SLOW, () => {
  it('a decent herder earns stars on the first fields with a starting dog', () => {
    const rows = [1, 2, 3, 4, 5, 6, 8].map((id) => ({ id, ...playLevel(id) }));
    console.table(rows);
    expect(rows[0].stars).toBeGreaterThanOrEqual(1);
    expect(rows[1].stars).toBeGreaterThanOrEqual(1);
  });

  it('a better dog pens more sheep', () => {
    const base = playLevel(4);
    const maxed = playLevel(4, MAXED);
    console.log('level 4 starting dog', base, 'maxed dog', maxed);
    expect(maxed.penned).toBeGreaterThan(base.penned);
  });

  it('doing nothing loses the flock', () => {
    const idle = playLevel(1, DEFAULT_LEVELS, null);
    console.log('idle', idle);
    expect(idle.stars).toBe(0);
  });
});

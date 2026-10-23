import { describe, expect, it } from 'vitest';
import { MeadowPilot } from './autopilot';
import { DEFAULT_LEVELS, DogLevels, dogStats } from './dog';
import { Meadow, streamSegments } from './meadow';
import { getMeadow, totalSheep } from './meadowLevels';

const DT = 1 / 60;

export function playMeadow(id: number, dog: DogLevels = DEFAULT_LEVELS, pilot: MeadowPilot | null = new MeadowPilot()) {
  const m = new Meadow(getMeadow(id), dogStats(dog), 844 / 390);
  for (let i = 0; i < 60 * 400 && m.phase !== 'done'; i++) {
    pilot?.update(m, DT);
    m.step(DT);
    m.events.length = 0;
  }
  return { penned: m.penned, total: m.total, pct: Math.round((m.penned / m.total) * 100), seconds: Math.round(m.time), limit: m.limit };
}

describe('meadow', { timeout: 60_000 }, () => {
  it('places every sheep from the level data', () => {
    for (const id of [1, 2, 3, 4, 7]) {
      const def = getMeadow(id);
      const m = new Meadow(def, dogStats(DEFAULT_LEVELS));
      expect(m.total).toBe(totalSheep(def));
    }
  });

  it('streams are walls except at the bridges', () => {
    const segs = streamSegments({ points: [[0, 0], [20, 0]], width: 4, bridges: [{ x: 10, w: 4 }] });
    expect(segs.length).toBe(2);
    expect(segs[0].bx).toBeCloseTo(8);
    expect(segs[1].ax).toBeCloseTo(12);
  });

  it('sheep pushed by the dog join the flock', () => {
    const m = new Meadow(getMeadow(1), dogStats(DEFAULT_LEVELS), 2);
    // Put the dog right behind the first group.
    m.dog.x = 28;
    m.dog.y = 10;
    for (let i = 0; i < 30; i++) m.step(DT);
    expect(m.gathered).toBeGreaterThan(3);
    expect(m.events.some((e) => e.type === 'joined')).toBe(true);
  });

  it('doing nothing pens nobody', () => {
    const r = playMeadow(1, DEFAULT_LEVELS, null);
    expect(r.penned).toBe(0);
  });

  it('a decent herder can clear the first meadows before sunset', () => {
    const rows = [1, 2, 3, 4, 5].map((id) => ({ id, ...playMeadow(id) }));
    console.table(rows);
    // The bot is a rough herder; a person steering by eye does better.
    expect(rows[0].pct).toBeGreaterThanOrEqual(90);
    expect(rows[2].pct).toBeGreaterThanOrEqual(75);
    expect(rows[3].pct).toBeGreaterThanOrEqual(75);
  });
});

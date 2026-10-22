import { describe, expect, it } from 'vitest';
import { DEFAULT_LEVELS, dogStats } from './dog';
import { LevelDef, getLevel, maxSheep, starTargets } from './levels';
import { World } from './world';

const DT = 1 / 60;

function emptyLevel(overrides: Partial<LevelDef> = {}): LevelDef {
  return {
    id: 99, name: 'Test', width: 20, length: 200, scroll: 0, startSheep: 0,
    patches: [], obstacles: [], seed: 1, ...overrides,
  };
}

function world(level: LevelDef, levels = DEFAULT_LEVELS) {
  return new World(level, dogStats(levels), 2);
}

describe('dog', () => {
  it('lags behind the finger and agility reduces the lag', () => {
    const slow = world(emptyLevel());
    const fast = world(emptyLevel(), { ...DEFAULT_LEVELS, agility: 10 });
    for (const w of [slow, fast]) {
      w.target = { u: 0.95, v: w.target.v }; // far to the right
      for (let i = 0; i < 6; i++) w.step(DT);
    }
    expect(Math.abs(slow.dog.vx)).toBeLessThan(dogStats(DEFAULT_LEVELS).accel * 6 * DT + 1e-6);
    expect(fast.dog.vx).toBeGreaterThan(slow.dog.vx * 2);
  });

  it('never runs faster than its top speed', () => {
    const w = world(emptyLevel());
    w.target = { u: 0.95, v: 0.1 };
    for (let i = 0; i < 300; i++) w.step(DT);
    expect(Math.hypot(w.dog.vx, w.dog.vy)).toBeLessThanOrEqual(dogStats(DEFAULT_LEVELS).maxSpeed + 1e-6);
  });
});

describe('sheep', () => {
  it('run away from the dog', () => {
    const w = world(emptyLevel());
    const s = w.addSheep(w.dog.x + 1.5, w.dog.y)!;
    w.target = { u: 0.5, v: 0.86 };
    for (let i = 0; i < 10; i++) w.step(DT);
    expect(s.vx).toBeGreaterThan(0.5);
  });

  it('are lost when they fall off the back of the screen', () => {
    const w = world(emptyLevel({ scroll: 30 }));
    w.addSheep(10, w.camY + 3);
    w.dog.x = 2;
    for (let i = 0; i < 60; i++) w.step(DT);
    expect(w.lost).toBe(1);
  });

  it('count as penned inside the pen and stay there', () => {
    const level = emptyLevel();
    const w = world(level);
    w.addSheep(10, level.length + 4);
    w.step(DT);
    expect(w.penned).toBe(1);
    for (let i = 0; i < 600; i++) w.step(DT);
    const s = w.sheep[0];
    expect(s.state).toBe('penned');
    expect(s.y).toBeGreaterThan(level.length);
  });
});

describe('patches', () => {
  it('multiply only the sheep that walk over them, once each', () => {
    const level = emptyLevel({ patches: [{ kind: 'mult', x: 5, y: 40, w: 4, h: 4, value: 3 }] });
    const w = world(level);
    for (let i = 0; i < 4; i++) w.addSheep(5, 40);   // on the patch
    for (let i = 0; i < 4; i++) w.addSheep(15, 40);  // beside it
    w.dog.x = 18; w.dog.y = 0;
    w.step(DT);
    expect(w.sheep.length).toBe(4 * 3 + 4);
    for (let i = 0; i < 30; i++) w.step(DT);
    expect(w.sheep.length).toBe(16); // copies don't re-trigger, sheep don't re-trigger
  });

  it('lamb nests fire once', () => {
    const level = emptyLevel({ patches: [{ kind: 'add', x: 5, y: 40, w: 4, h: 4, value: 5 }] });
    const w = world(level);
    w.addSheep(5, 40);
    w.addSheep(5.5, 40);
    w.step(DT);
    w.step(DT);
    expect(w.sheep.length).toBe(2 + 5);
    expect(w.sheep.filter((s) => s.lamb).length).toBe(5);
  });

  it('thistles scatter the sheep that cross them', () => {
    const level = emptyLevel({ patches: [{ kind: 'thistle', x: 5, y: 40, w: 4, h: 4 }] });
    const w = world(level);
    const s = w.addSheep(5, 40)!;
    w.step(DT);
    expect(s.panic).toBeGreaterThan(0.9);
    expect(Math.hypot(s.vx, s.vy)).toBeGreaterThan(3);
  });

  it('bone pickups boost the dog once', () => {
    const w = world(emptyLevel());
    w.patches.push({ kind: 'bone', x: w.dog.x, y: w.dog.y, w: 2, h: 2, id: 50, spent: false, gain: 0, gainTimer: 0 });
    w.step(DT);
    expect(w.boneTime).toBeGreaterThan(3);
    expect(w.events.some((e) => e.type === 'pickup')).toBe(true);
  });
});

describe('levels', () => {
  it('star targets come from the best possible flock', () => {
    const l1 = getLevel(1);
    // 10 -> x2 -> x3 -> +6 -> x2
    expect(maxSheep(l1)).toBe(((10 * 2 * 3) + 6) * 2);
    const [a, b, c] = starTargets(l1);
    expect(a).toBeLessThan(b);
    expect(b).toBeLessThan(c);
  });

  it('procedural levels keep growing and stay sane', () => {
    for (let id = 4; id <= 30; id++) {
      const l = getLevel(id);
      expect(l.width).toBeGreaterThanOrEqual(24);
      expect(maxSheep(l)).toBeLessThanOrEqual(1500);
      expect(l.patches.length).toBeGreaterThan(4);
    }
  });

  it('a whole level runs to the end without the dog doing anything', () => {
    const w = world(getLevel(1));
    for (let i = 0; i < 60 * 200 && w.phase !== 'done'; i++) w.step(DT);
    expect(w.phase).toBe('done');
    expect(w.penned + w.lost).toBe(w.sheep.length);
  });
});

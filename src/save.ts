import { DEFAULT_LEVELS, DogLevels } from './game/dog';

export interface SaveData {
  version: 1;
  wool: number;
  /** Highest level the player may start. */
  unlocked: number;
  /** Best stars per level id. */
  stars: Record<number, number>;
  best: Record<number, number>;
  /** Round-up (open meadow) progress, kept separately from trail mode. */
  meadowUnlocked: number;
  meadowStars: Record<number, number>;
  meadowBest: Record<number, number>;
  dog: DogLevels;
  sound: boolean;
}

const KEY = 'flock-rescue.save.v1';

export function freshSave(): SaveData {
  return {
    version: 1, wool: 0, unlocked: 1, stars: {}, best: {},
    meadowUnlocked: 1, meadowStars: {}, meadowBest: {},
    dog: { ...DEFAULT_LEVELS }, sound: true,
  };
}

export function loadSave(): SaveData {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return freshSave();
    const data = JSON.parse(raw) as SaveData;
    if (data.version !== 1) return freshSave();
    return { ...freshSave(), ...data, dog: { ...DEFAULT_LEVELS, ...data.dog } };
  } catch {
    return freshSave();
  }
}

export function writeSave(data: SaveData): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(data));
  } catch {
    /* private mode or storage blocked: progress just isn't kept */
  }
}

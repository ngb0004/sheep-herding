/** Upgradeable dog stats. Level 1 should already feel good, just not great. */
export type StatId = 'speed' | 'agility' | 'presence' | 'bark';

export const STAT_IDS: StatId[] = ['speed', 'agility', 'presence', 'bark'];
export const MAX_STAT_LEVEL = 10;

export interface DogLevels {
  speed: number;
  agility: number;
  presence: number;
  bark: number;
}

export interface DogStats {
  /** Top running speed, m/s. */
  maxSpeed: number;
  /** How hard the dog can change velocity, m/s². Low = laggy, wide turns. */
  accel: number;
  /** Distance at which sheep start moving away from the dog, m. */
  presence: number;
  barkRadius: number;
  barkCooldown: number;
  barkForce: number;
}

export const STAT_INFO: Record<StatId, { name: string; blurb: string; icon: string }> = {
  speed: { name: 'Speed', blurb: 'Top running speed. Catch runaway strays.', icon: '💨' },
  agility: { name: 'Agility', blurb: 'Turns and responds faster. Less lag, tighter cuts.', icon: '🌀' },
  presence: { name: 'Presence', blurb: 'Sheep feel your dog from further away.', icon: '👁️' },
  bark: { name: 'Bark', blurb: 'Bigger, stronger, more frequent bark.', icon: '📣' },
};

export function dogStats(l: DogLevels): DogStats {
  const s = l.speed - 1;
  const a = l.agility - 1;
  const p = l.presence - 1;
  const b = l.bark - 1;
  return {
    maxSpeed: 7 + s * 0.6,
    accel: 11 + a * 3.2,
    presence: 5 + p * 0.45,
    barkRadius: 6.5 + b * 0.6,
    barkCooldown: Math.max(2.5, 6 - b * 0.4),
    barkForce: 7 + b * 0.5,
  };
}

/** Wool cost to go from `level` to `level + 1`. */
export function upgradeCost(level: number): number {
  return Math.round(40 * Math.pow(1.55, level - 1));
}

export const DEFAULT_LEVELS: DogLevels = { speed: 1, agility: 1, presence: 1, bark: 1 };

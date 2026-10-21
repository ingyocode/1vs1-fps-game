export const GAME_TITLE = 'DUSK PROTOCOL';
export const GAME_SUBTITLE = '더스크 프로토콜';

export type TeamId = 0 | 1;

export const TEAMS: Record<TeamId, { name: string; nameKo: string; color: number; css: string }> = {
  0: { name: 'VANGUARD', nameKo: '뱅가드', color: 0x38d6ff, css: '#38d6ff' },
  1: { name: 'EMBER', nameKo: '엠버', color: 0xff6a3d, css: '#ff6a3d' },
};

export const PLAYER = {
  radius: 0.34,
  heightStand: 1.8,
  heightCrouch: 1.22,
  eyeStand: 1.64,
  eyeCrouch: 1.08,
  gravity: 21,
  jumpSpeed: 7.1,
  runSpeed: 6.3,
  walkMult: 0.5,
  crouchMult: 0.42,
  adsMult: 0.78,
  groundAccel: 10,
  airAccel: 1.8,
  airSpeedCap: 1.2,
  friction: 8,
  stepHeight: 0.46,
  maxHp: 100,
  maxArmor: 50,
} as const;

export const ECON = {
  start: 800,
  kill: 250,
  headshotBonus: 100,
  assist: 100,
  win: 1100,
  loss: 550,
  lossStep: 200,
  lossMaxSteps: 3,
  coinSmall: 100,
  coinBig: 350,
  max: 9000,
} as const;

export const TIMING = {
  draftPick: 16,
  buyFirst: 25,
  buy: 18,
  round: 100,
  roundEnd: 5.5,
  matchEnd: 16,
  bigCoinAt: 20,
} as const;

export const NET = {
  peerPrefix: 'duskproto-v1-',
  snapshotHz: 22,
  stateHz: 30,
  interpDelayMs: 110,
  pingIntervalMs: 2000,
} as const;

/** Damage multipliers by hit zone. Weapons may override the head multiplier. */
export type HitZone = 'head' | 'body' | 'legs';

export const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function makeRoomCode(len = 5): string {
  let s = '';
  for (let i = 0; i < len; i++) s += ROOM_ALPHABET[Math.floor(Math.random() * ROOM_ALPHABET.length)];
  return s;
}

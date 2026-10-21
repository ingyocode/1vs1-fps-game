import type { HitZone } from '../core/config';

export type WeaponId = 'knife' | 'pistol' | 'magnum' | 'smg' | 'shotgun' | 'rifle' | 'sniper';
export type WeaponSlot = 'primary' | 'secondary' | 'melee';

export interface WeaponDef {
  id: WeaponId;
  name: string;
  nameKo: string;
  category: string;
  slot: WeaponSlot;
  price: number;
  damage: number;
  headMult: number;
  legMult: number;
  pellets: number;
  rpm: number;
  auto: boolean;
  mag: number;
  reserve: number;
  reloadTime: number;
  /** Shotguns reload one shell at a time. */
  shellReload?: { start: number; perShell: number; end: number };
  equipTime: number;
  /** Full damage up to `start` metres, linearly falling to `minMult` at `end`. */
  falloff: { start: number; end: number; minMult: number };
  /** Fraction of damage that ignores armor. */
  armorPen: number;
  spread: { hip: number; ads: number; move: number; air: number; crouch: number; bloom: number; bloomMax: number; recover: number };
  recoil: { pattern: [number, number][]; tail: [number, number]; jitter: number; recover: number };
  moveSpeed: number;
  ads: { zoom: number; time: number; scope: boolean };
  bolt?: number;
  tracer: number;
  meleeRange?: number;
  /** 0..1 stat bars for the shop. */
  bars: { damage: number; rate: number; accuracy: number; mobility: number; range: number };
  killReward: number;
}

const riflePattern: [number, number][] = [
  [0.0, 0.0],
  [0.011, 0.0005],
  [0.013, -0.001],
  [0.015, 0.0015],
  [0.016, 0.002],
  [0.016, -0.0025],
  [0.014, -0.0045],
  [0.012, -0.005],
  [0.01, 0.0045],
  [0.008, 0.006],
  [0.006, 0.006],
  [0.005, -0.004],
];

export const WEAPONS: Record<WeaponId, WeaponDef> = {
  knife: {
    id: 'knife',
    name: 'Tanto Blade',
    nameKo: '탄토 나이프',
    category: '근접',
    slot: 'melee',
    price: 0,
    damage: 50,
    headMult: 1,
    legMult: 1,
    pellets: 1,
    rpm: 110,
    auto: true,
    mag: 0,
    reserve: 0,
    reloadTime: 0,
    equipTime: 0.35,
    falloff: { start: 3, end: 3, minMult: 1 },
    armorPen: 0.5,
    spread: { hip: 0, ads: 0, move: 0, air: 0, crouch: 1, bloom: 0, bloomMax: 0, recover: 1 },
    recoil: { pattern: [[0, 0]], tail: [0, 0], jitter: 0, recover: 10 },
    moveSpeed: 1.1,
    ads: { zoom: 1, time: 0.1, scope: false },
    tracer: 0,
    meleeRange: 2.3,
    bars: { damage: 0.5, rate: 0.4, accuracy: 1, mobility: 1, range: 0.05 },
    killReward: 500,
  },
  pistol: {
    id: 'pistol',
    name: 'P-9 Viper',
    nameKo: 'P-9 바이퍼',
    category: '권총',
    slot: 'secondary',
    price: 0,
    damage: 26,
    headMult: 3.8,
    legMult: 0.75,
    pellets: 1,
    rpm: 400,
    auto: false,
    mag: 12,
    reserve: 48,
    reloadTime: 1.55,
    equipTime: 0.45,
    falloff: { start: 15, end: 40, minMult: 0.78 },
    armorPen: 0.2,
    spread: { hip: 0.008, ads: 0.004, move: 0.028, air: 0.12, crouch: 0.85, bloom: 0.012, bloomMax: 0.05, recover: 0.09 },
    recoil: { pattern: [[0.012, 0]], tail: [0.012, 0], jitter: 0.004, recover: 0.4 },
    moveSpeed: 1.0,
    ads: { zoom: 1.15, time: 0.14, scope: false },
    tracer: 0xffd28a,
    bars: { damage: 0.3, rate: 0.55, accuracy: 0.65, mobility: 1, range: 0.4 },
    killReward: 300,
  },
  magnum: {
    id: 'magnum',
    name: 'HC-50 Magnum',
    nameKo: 'HC-50 매그넘',
    category: '권총',
    slot: 'secondary',
    price: 700,
    damage: 55,
    headMult: 3,
    legMult: 0.75,
    pellets: 1,
    rpm: 160,
    auto: false,
    mag: 7,
    reserve: 28,
    reloadTime: 2.0,
    equipTime: 0.55,
    falloff: { start: 20, end: 55, minMult: 0.75 },
    armorPen: 0.55,
    spread: { hip: 0.012, ads: 0.0025, move: 0.06, air: 0.16, crouch: 0.85, bloom: 0.035, bloomMax: 0.08, recover: 0.12 },
    recoil: { pattern: [[0.05, 0]], tail: [0.05, 0], jitter: 0.012, recover: 0.5 },
    moveSpeed: 0.97,
    ads: { zoom: 1.2, time: 0.16, scope: false },
    tracer: 0xffc070,
    bars: { damage: 0.7, rate: 0.25, accuracy: 0.6, mobility: 0.95, range: 0.65 },
    killReward: 250,
  },
  smg: {
    id: 'smg',
    name: 'Vespa SMG-9',
    nameKo: '베스파 SMG-9',
    category: '기관단총',
    slot: 'primary',
    price: 1300,
    damage: 22,
    headMult: 2.6,
    legMult: 0.8,
    pellets: 1,
    rpm: 860,
    auto: true,
    mag: 32,
    reserve: 128,
    reloadTime: 2.1,
    equipTime: 0.5,
    falloff: { start: 12, end: 32, minMult: 0.65 },
    armorPen: 0.3,
    spread: { hip: 0.02, ads: 0.011, move: 0.01, air: 0.09, crouch: 0.85, bloom: 0.004, bloomMax: 0.03, recover: 0.12 },
    recoil: {
      pattern: [
        [0, 0],
        [0.006, 0.0005],
        [0.007, -0.001],
        [0.007, 0.0015],
        [0.006, -0.0015],
      ],
      tail: [0.004, 0],
      jitter: 0.003,
      recover: 0.35,
    },
    moveSpeed: 1.0,
    ads: { zoom: 1.25, time: 0.16, scope: false },
    tracer: 0xffd28a,
    bars: { damage: 0.35, rate: 0.95, accuracy: 0.5, mobility: 0.95, range: 0.35 },
    killReward: 300,
  },
  shotgun: {
    id: 'shotgun',
    name: 'Breaker 12',
    nameKo: '브레이커 12',
    category: '산탄총',
    slot: 'primary',
    price: 1600,
    damage: 15,
    headMult: 1.6,
    legMult: 0.8,
    pellets: 9,
    rpm: 72,
    auto: false,
    mag: 6,
    reserve: 24,
    reloadTime: 0.5,
    shellReload: { start: 0.35, perShell: 0.42, end: 0.35 },
    equipTime: 0.6,
    falloff: { start: 6, end: 20, minMult: 0.25 },
    armorPen: 0.3,
    spread: { hip: 0.068, ads: 0.055, move: 0.008, air: 0.02, crouch: 0.95, bloom: 0, bloomMax: 0, recover: 0.2 },
    recoil: { pattern: [[0.06, 0]], tail: [0.06, 0], jitter: 0.012, recover: 0.45 },
    moveSpeed: 0.95,
    ads: { zoom: 1.1, time: 0.18, scope: false },
    tracer: 0xffb060,
    bars: { damage: 0.95, rate: 0.15, accuracy: 0.2, mobility: 0.9, range: 0.15 },
    killReward: 300,
  },
  rifle: {
    id: 'rifle',
    name: 'AR-7 Vanguard',
    nameKo: 'AR-7 뱅가드',
    category: '돌격소총',
    slot: 'primary',
    price: 2900,
    damage: 38,
    headMult: 4,
    legMult: 0.8,
    pellets: 1,
    rpm: 620,
    auto: true,
    mag: 25,
    reserve: 75,
    reloadTime: 2.4,
    equipTime: 0.65,
    falloff: { start: 30, end: 75, minMult: 0.85 },
    armorPen: 0.5,
    spread: { hip: 0.0065, ads: 0.0018, move: 0.065, air: 0.16, crouch: 0.8, bloom: 0.0055, bloomMax: 0.04, recover: 0.1 },
    recoil: { pattern: riflePattern, tail: [0.005, 0], jitter: 0.004, recover: 0.38 },
    moveSpeed: 0.92,
    ads: { zoom: 1.45, time: 0.2, scope: false },
    tracer: 0xffe0a0,
    bars: { damage: 0.75, rate: 0.75, accuracy: 0.85, mobility: 0.75, range: 0.85 },
    killReward: 250,
  },
  sniper: {
    id: 'sniper',
    name: 'Longbow .338',
    nameKo: '롱보우 .338',
    category: '저격소총',
    slot: 'primary',
    price: 4700,
    damage: 125,
    headMult: 2,
    legMult: 0.85,
    pellets: 1,
    rpm: 40,
    auto: false,
    mag: 5,
    reserve: 20,
    reloadTime: 3.0,
    equipTime: 0.9,
    falloff: { start: 120, end: 160, minMult: 1 },
    armorPen: 0.9,
    spread: { hip: 0.075, ads: 0.0004, move: 0.12, air: 0.25, crouch: 0.9, bloom: 0, bloomMax: 0, recover: 0.4 },
    recoil: { pattern: [[0.085, 0]], tail: [0.085, 0], jitter: 0.015, recover: 0.6 },
    moveSpeed: 0.84,
    ads: { zoom: 3.4, time: 0.24, scope: true },
    bolt: 1.25,
    tracer: 0xfff0c0,
    bars: { damage: 1, rate: 0.08, accuracy: 1, mobility: 0.55, range: 1 },
    killReward: 150,
  },
};

export const PRIMARY_IDS: WeaponId[] = ['smg', 'shotgun', 'rifle', 'sniper'];
export const SECONDARY_IDS: WeaponId[] = ['pistol', 'magnum'];

export const ARMOR_ITEMS = [
  { id: 'armorLight', name: '경량 방탄복', desc: '방어력 25', amount: 25, price: 400 },
  { id: 'armorHeavy', name: '중량 방탄복', desc: '방어력 50', amount: 50, price: 1000 },
] as const;
export type ArmorItemId = (typeof ARMOR_ITEMS)[number]['id'];

/** Distance-scaled damage for a single pellet, before armor. */
export function damageAt(def: WeaponDef, dist: number, zone: HitZone): number {
  const f = def.falloff;
  let mult = 1;
  if (dist > f.start) {
    const t = Math.min(1, (dist - f.start) / Math.max(0.001, f.end - f.start));
    mult = 1 + (f.minMult - 1) * t;
  }
  const zm = zone === 'head' ? def.headMult : zone === 'legs' ? def.legMult : 1;
  return def.damage * mult * zm;
}

/** Applies armor. Returns hp damage and armor consumed. */
export function applyArmor(dmg: number, armor: number, armorPen: number): { hp: number; armor: number } {
  if (armor <= 0) return { hp: dmg, armor: 0 };
  const absorbed = Math.min(armor, dmg * 0.5 * (1 - armorPen));
  return { hp: dmg - absorbed, armor: absorbed };
}

export function shotInterval(def: WeaponDef): number {
  return 60 / def.rpm;
}

export type AbilityId = 'flash' | 'smoke' | 'infinite' | 'dash' | 'heal' | 'recon' | 'barrier' | 'frag' | 'cloak' | 'adrenaline';
export type Rarity = 0 | 1 | 2 | 3;

export const ABILITY_IDS: AbilityId[] = ['flash', 'smoke', 'infinite', 'dash', 'heal', 'recon', 'barrier', 'frag', 'cloak', 'adrenaline'];

export const RARITIES: { key: string; name: string; nameEn: string; color: string; weight: number }[] = [
  { key: 'common', name: '일반', nameEn: 'COMMON', color: '#b9c4cf', weight: 52 },
  { key: 'rare', name: '희귀', nameEn: 'RARE', color: '#3aa8ff', weight: 30 },
  { key: 'epic', name: '영웅', nameEn: 'EPIC', color: '#b45cff', weight: 14 },
  { key: 'legendary', name: '전설', nameEn: 'LEGENDARY', color: '#ffb52e', weight: 4 },
];

/** Gold cost to raise an owned ability from rarity r to r+1 in the shop. */
export const UPGRADE_COST: Record<0 | 1 | 2, number> = { 0: 700, 1: 1200, 2: 2000 };

export type ThrowKind = 'flash' | 'smoke' | 'frag';

export interface OwnedAbility {
  id: AbilityId;
  rarity: Rarity;
}

export interface AbilityDef {
  id: AbilityId;
  name: string;
  nameEn: string;
  type: 'throw' | 'self' | 'deploy';
  tagline: string;
  /** Per-rarity numeric stats. */
  stats: Record<string, [number, number, number, number]>;
  describe(r: Rarity): string;
  statLines(r: Rarity): [string, string][];
}

const s = (a: number, b: number, c: number, d: number): [number, number, number, number] => [a, b, c, d];

export const ABILITIES: Record<AbilityId, AbilityDef> = {
  flash: {
    id: 'flash',
    name: '섬광탄',
    nameEn: 'FLASHBANG',
    type: 'throw',
    tagline: '시야를 하얗게 지워버리는 섬광 수류탄',
    stats: { charges: s(1, 2, 2, 3), blind: s(1.8, 2.2, 2.7, 3.4), radius: s(30, 32, 34, 38) },
    describe(r) {
      return `투척 후 0.8초 뒤 폭발. 바라보는 모든 플레이어를 최대 ${this.stats.blind[r]}초간 실명시킵니다.`;
    },
    statLines(r) {
      return [
        ['충전', `${this.stats.charges[r]}회`],
        ['실명', `${this.stats.blind[r]}초`],
        ['범위', `${this.stats.radius[r]}m`],
      ];
    },
  },
  smoke: {
    id: 'smoke',
    name: '연막탄',
    nameEn: 'SMOKE',
    type: 'throw',
    tagline: '시야를 차단하는 두터운 연막',
    stats: { charges: s(1, 1, 2, 2), radius: s(4.2, 4.8, 5.4, 6.2), duration: s(10, 12, 14, 18) },
    describe(r) {
      return `착지 지점에 반경 ${this.stats.radius[r]}m 연막을 ${this.stats.duration[r]}초간 전개합니다.`;
    },
    statLines(r) {
      return [
        ['충전', `${this.stats.charges[r]}회`],
        ['반경', `${this.stats.radius[r]}m`],
        ['지속', `${this.stats.duration[r]}초`],
      ];
    },
  },
  infinite: {
    id: 'infinite',
    name: '무한 탄창',
    nameEn: 'BOTTOMLESS MAG',
    type: 'self',
    tagline: '일정 시간 탄약이 줄지 않습니다',
    stats: { charges: s(1, 1, 1, 2), duration: s(5, 6.5, 8, 10), fireRate: s(1, 1, 1.08, 1.15) },
    describe(r) {
      const extra = this.stats.fireRate[r] > 1 ? ` 연사력 +${Math.round((this.stats.fireRate[r] - 1) * 100)}%.` : '';
      return `${this.stats.duration[r]}초간 탄약 소모와 재장전이 없습니다.${extra}`;
    },
    statLines(r) {
      return [
        ['충전', `${this.stats.charges[r]}회`],
        ['지속', `${this.stats.duration[r]}초`],
        ['연사 보너스', this.stats.fireRate[r] > 1 ? `+${Math.round((this.stats.fireRate[r] - 1) * 100)}%` : '-'],
      ];
    },
  },
  dash: {
    id: 'dash',
    name: '질풍 대시',
    nameEn: 'DASH',
    type: 'self',
    tagline: '이동 방향으로 순간 돌진',
    stats: { charges: s(1, 2, 2, 3), distance: s(6, 7, 8, 9), recharge: s(0, 14, 10, 7) },
    describe(r) {
      const rc = this.stats.recharge[r];
      return `이동 방향으로 ${this.stats.distance[r]}m 돌진합니다.${rc > 0 ? ` ${rc}초마다 1회 재충전.` : ''}`;
    },
    statLines(r) {
      const rc = this.stats.recharge[r];
      return [
        ['충전', `${this.stats.charges[r]}회`],
        ['거리', `${this.stats.distance[r]}m`],
        ['재충전', rc > 0 ? `${rc}초` : '없음'],
      ];
    },
  },
  heal: {
    id: 'heal',
    name: '나노 치유',
    nameEn: 'NANO HEAL',
    type: 'self',
    tagline: '나노봇이 상처를 빠르게 복구',
    stats: { charges: s(1, 1, 2, 2), amount: s(40, 50, 60, 75), armor: s(0, 0, 10, 25) },
    describe(r) {
      const a = this.stats.armor[r];
      return `3초에 걸쳐 체력 ${this.stats.amount[r]}을 회복합니다.${a > 0 ? ` 방어력 ${a} 추가.` : ''}`;
    },
    statLines(r) {
      return [
        ['충전', `${this.stats.charges[r]}회`],
        ['회복', `${this.stats.amount[r]}`],
        ['방어력', this.stats.armor[r] > 0 ? `+${this.stats.armor[r]}` : '-'],
      ];
    },
  },
  recon: {
    id: 'recon',
    name: '정찰 펄스',
    nameEn: 'RECON PULSE',
    type: 'self',
    tagline: '벽 너머의 적을 드러내는 음파',
    stats: { charges: s(1, 1, 2, 2), radius: s(26, 34, 42, 60), reveal: s(2.5, 3, 4, 5) },
    describe(r) {
      return `반경 ${this.stats.radius[r]}m 내 적의 위치를 아군 전체에게 ${this.stats.reveal[r]}초간 드러냅니다.`;
    },
    statLines(r) {
      return [
        ['충전', `${this.stats.charges[r]}회`],
        ['반경', `${this.stats.radius[r]}m`],
        ['노출', `${this.stats.reveal[r]}초`],
      ];
    },
  },
  barrier: {
    id: 'barrier',
    name: '에너지 방벽',
    nameEn: 'BARRIER',
    type: 'deploy',
    tagline: '총알을 막아내는 에너지 벽',
    stats: { charges: s(1, 1, 1, 2), hp: s(300, 450, 600, 900), duration: s(12, 16, 20, 25), width: s(3, 3.5, 4, 4.8) },
    describe(r) {
      return `전방에 폭 ${this.stats.width[r]}m, 내구도 ${this.stats.hp[r]}의 방벽을 ${this.stats.duration[r]}초간 설치합니다.`;
    },
    statLines(r) {
      return [
        ['충전', `${this.stats.charges[r]}회`],
        ['내구도', `${this.stats.hp[r]}`],
        ['지속', `${this.stats.duration[r]}초`],
      ];
    },
  },
  frag: {
    id: 'frag',
    name: '파편 수류탄',
    nameEn: 'FRAG',
    type: 'throw',
    tagline: '반경 내 적에게 큰 피해',
    stats: { charges: s(1, 1, 2, 2), damage: s(80, 95, 110, 130), radius: s(5, 5.5, 6, 7) },
    describe(r) {
      return `1.5초 후 폭발하여 반경 ${this.stats.radius[r]}m 내 최대 ${this.stats.damage[r]} 피해를 줍니다.`;
    },
    statLines(r) {
      return [
        ['충전', `${this.stats.charges[r]}회`],
        ['피해', `${this.stats.damage[r]}`],
        ['반경', `${this.stats.radius[r]}m`],
      ];
    },
  },
  cloak: {
    id: 'cloak',
    name: '광학 위장',
    nameEn: 'CLOAK',
    type: 'self',
    tagline: '빛을 굴절시켜 모습을 감춤',
    stats: { charges: s(1, 1, 2, 2), duration: s(3.5, 4.5, 5.5, 7) },
    describe(r) {
      return `${this.stats.duration[r]}초간 거의 투명해집니다. 사격 시 해제됩니다.`;
    },
    statLines(r) {
      return [
        ['충전', `${this.stats.charges[r]}회`],
        ['지속', `${this.stats.duration[r]}초`],
      ];
    },
  },
  adrenaline: {
    id: 'adrenaline',
    name: '아드레날린',
    nameEn: 'ADRENALINE',
    type: 'self',
    tagline: '이동·사격·재장전 속도 증가',
    stats: { charges: s(1, 1, 2, 2), duration: s(5, 6, 7.5, 9), speed: s(1.18, 1.22, 1.27, 1.33), fire: s(1.12, 1.16, 1.2, 1.25) },
    describe(r) {
      return `${this.stats.duration[r]}초간 이동 속도 +${Math.round((this.stats.speed[r] - 1) * 100)}%, 연사·재장전 +${Math.round((this.stats.fire[r] - 1) * 100)}%.`;
    },
    statLines(r) {
      return [
        ['충전', `${this.stats.charges[r]}회`],
        ['지속', `${this.stats.duration[r]}초`],
        ['이속', `+${Math.round((this.stats.speed[r] - 1) * 100)}%`],
      ];
    },
  },
};

export interface SynergyDef {
  id: string;
  a: AbilityId;
  b: AbilityId;
  name: string;
  desc: string;
}

export const SYNERGIES: SynergyDef[] = [
  { id: 'blindfog', a: 'flash', b: 'smoke', name: '눈부신 안개', desc: '연막탄이 터지는 순간 섬광을 함께 방출합니다.' },
  { id: 'toxic', a: 'smoke', b: 'frag', name: '독성 구름', desc: '내 연막 속의 적은 초당 12의 피해를 받습니다.' },
  { id: 'shadowstep', a: 'dash', b: 'cloak', name: '그림자 걸음', desc: '대시 직후 1.5초간 광학 위장 상태가 됩니다.' },
  { id: 'berserk', a: 'infinite', b: 'adrenaline', name: '광전사', desc: '둘 중 하나를 사용하면 다른 하나도 60% 지속시간으로 무료 발동합니다.' },
  { id: 'markflash', a: 'recon', b: 'flash', name: '표적 섬광', desc: '내 섬광에 실명된 적은 3초간 위치가 드러납니다.' },
  { id: 'regenwall', a: 'heal', b: 'barrier', name: '재생 방벽', desc: '내 방벽 주변 4m 안의 아군은 초당 10 체력을 회복합니다.' },
  { id: 'seeker', a: 'frag', b: 'recon', name: '추적 파편', desc: '파편 수류탄 폭발 지점 12m 내 적을 3초간 드러냅니다.' },
  { id: 'phantom', a: 'cloak', b: 'infinite', name: '유령 사격', desc: '무한 탄창 중에는 사격해도 광학 위장이 풀리지 않습니다.' },
  { id: 'secondwind', a: 'heal', b: 'adrenaline', name: '투지', desc: '나노 치유 사용 시 아드레날린이 3초간 무료 발동합니다.' },
];

export function activeSynergies(owned: readonly OwnedAbility[]): SynergyDef[] {
  const ids = new Set(owned.map((o) => o.id));
  return SYNERGIES.filter((sy) => ids.has(sy.a) && ids.has(sy.b));
}

export function hasSynergy(owned: readonly OwnedAbility[], id: string): boolean {
  return activeSynergies(owned).some((sy) => sy.id === id);
}

export function synergyPartners(id: AbilityId): { partner: AbilityId; syn: SynergyDef }[] {
  return SYNERGIES.filter((sy) => sy.a === id || sy.b === id).map((sy) => ({ partner: sy.a === id ? sy.b : sy.a, syn: sy }));
}

export interface DraftCard {
  ability: AbilityId;
  rarity: Rarity;
}

export function rollRarity(rnd: () => number = Math.random): Rarity {
  const total = RARITIES.reduce((a, r) => a + r.weight, 0);
  let x = rnd() * total;
  for (let i = 0; i < RARITIES.length; i++) {
    x -= RARITIES[i].weight;
    if (x <= 0) return i as Rarity;
  }
  return 0;
}

/** Three distinct cards, biased toward at least one synergy with what the player already owns. */
export function rollOffer(owned: readonly OwnedAbility[], rnd: () => number = Math.random): DraftCard[] {
  const pool = [...ABILITY_IDS];
  const chosen: AbilityId[] = [];
  if (owned.length > 0 && rnd() < 0.65) {
    const partners = owned.flatMap((o) => synergyPartners(o.id).map((p) => p.partner)).filter((p) => !owned.some((o) => o.id === p));
    if (partners.length) chosen.push(partners[Math.floor(rnd() * partners.length)]);
  }
  while (chosen.length < 3) {
    const id = pool[Math.floor(rnd() * pool.length)];
    if (!chosen.includes(id)) chosen.push(id);
  }
  // Shuffle so the synergy card is not always first.
  for (let i = chosen.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [chosen[i], chosen[j]] = [chosen[j], chosen[i]];
  }
  return chosen.map((ability) => ({ ability, rarity: rollRarity(rnd) }));
}

/** Adds a drafted card to an owned list. Duplicates evolve: rarity = max + 1. */
export function applyPick(owned: OwnedAbility[], card: DraftCard): { list: OwnedAbility[]; evolved: boolean } {
  const list = owned.map((o) => ({ ...o }));
  const existing = list.find((o) => o.id === card.ability);
  if (existing) {
    existing.rarity = Math.min(3, Math.max(existing.rarity, card.rarity) + 1) as Rarity;
    return { list, evolved: true };
  }
  list.push({ id: card.ability, rarity: card.rarity });
  return { list, evolved: false };
}

export function stat(id: AbilityId, key: string, r: Rarity): number {
  return ABILITIES[id].stats[key]?.[r] ?? 0;
}

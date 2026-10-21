export type AbilityId = 'flash' | 'smoke' | 'infinite' | 'dash' | 'heal' | 'recon' | 'barrier' | 'frag' | 'cloak' | 'adrenaline';
/** Upgrade step: 0 = Ⅰ (unlock), 1 = Ⅱ (enhanced), 2 = Ⅲ (awakened). */
export type Tier = 0 | 1 | 2;

export const ABILITY_IDS: AbilityId[] = ['flash', 'smoke', 'infinite', 'dash', 'heal', 'recon', 'barrier', 'frag', 'cloak', 'adrenaline'];

export const MAX_TIER: Tier = 2;
/** Ability keys (Q / E / F). */
export const MAX_SLOTS = 3;

export const TIERS: { roman: string; name: string; nameEn: string; color: string }[] = [
  { roman: 'Ⅰ', name: '기본', nameEn: 'CORE', color: '#3aa8ff' },
  { roman: 'Ⅱ', name: '강화', nameEn: 'ENHANCED', color: '#b45cff' },
  { roman: 'Ⅲ', name: '각성', nameEn: 'AWAKENED', color: '#ffb52e' },
];

/** Gold cost to raise an owned ability from tier t to t+1 in the shop. */
export const UPGRADE_COST: Record<0 | 1, number> = { 0: 1000, 1: 2400 };

/** Movement multiplier while concussed. */
export const SLOW_MULT = 0.65;
/** Extra damage taken while exposed by an awakened recon pulse. */
export const VULN_BONUS = 0.15;
/** Delay before an enhanced recon pulse echoes. */
export const ECHO_DELAY = 1.8;
/** How long an awakened cloak flickers visible after a shot. */
export const CLOAK_FLICKER = 0.6;
/** Poison added to the owner's smokes by the toxic synergy. */
export const TOXIC_SYN_DPS = 8;

export type ThrowKind = 'flash' | 'smoke' | 'frag';

export interface OwnedAbility {
  id: AbilityId;
  tier: Tier;
}

export interface TierInfo {
  /** Card title of this step. */
  title: string;
  /** What this step adds (shown on its upgrade card). */
  perks: string[];
}

export interface AbilityDef {
  id: AbilityId;
  name: string;
  nameEn: string;
  type: 'throw' | 'self' | 'deploy';
  tagline: string;
  /** Per-tier numeric stats. Every ability has `charges` and `recharge` (seconds per charge, 0 = none). */
  stats: Record<string, [number, number, number]>;
  tiers: [TierInfo, TierInfo, TierInfo];
  describe(t: Tier): string;
  statLines(t: Tier): [string, string][];
}

const s = (a: number, b: number, c: number): [number, number, number] => [a, b, c];
const pct = (x: number): number => Math.round(x * 100);
const charges = (st: AbilityDef['stats'], t: Tier): [string, string] => ['충전', `${st.charges[t]}회`];
const recharge = (st: AbilityDef['stats'], t: Tier): [string, string] => ['재충전', st.recharge[t] > 0 ? `${st.recharge[t]}초` : '없음'];

export const ABILITIES: Record<AbilityId, AbilityDef> = {
  flash: {
    id: 'flash',
    name: '섬광탄',
    nameEn: 'FLASHBANG',
    type: 'throw',
    tagline: '시야를 하얗게 지워버리는 섬광 수류탄',
    stats: { charges: s(1, 2, 2), recharge: s(0, 25, 18), blind: s(2, 2.4, 2.8), radius: s(30, 32, 34), fuse: s(0.82, 0.5, 0.5), suppress: s(0, 0, 4) },
    tiers: [
      { title: '섬광탄', perks: ['투척 0.8초 후 폭발해 바라보는 적을 실명'] },
      { title: '순간 섬광', perks: ['신관 0.5초 — 피할 틈 없는 팝 플래시', '충전 2회 · 25초마다 재충전'] },
      { title: '제압 섬광', perks: ['실명된 적은 4초간 능력 사용 불가 (제압)', '재충전 18초'] },
    ],
    describe(t) {
      const sup = this.stats.suppress[t];
      return `투척 ${this.stats.fuse[t]}초 후 폭발. 바라보는 적을 최대 ${this.stats.blind[t]}초간 실명시킵니다.${sup > 0 ? ` 실명된 적은 ${sup}초간 능력을 쓸 수 없습니다.` : ''}`;
    },
    statLines(t) {
      return [charges(this.stats, t), recharge(this.stats, t), ['실명', `${this.stats.blind[t]}초`]];
    },
  },
  smoke: {
    id: 'smoke',
    name: '연막탄',
    nameEn: 'SMOKE',
    type: 'throw',
    tagline: '시야를 차단하는 두터운 연막',
    stats: { charges: s(1, 2, 3), recharge: s(0, 22, 16), radius: s(4.4, 4.8, 5.2), duration: s(12, 14, 15), dps: s(0, 0, 10) },
    tiers: [
      { title: '연막탄', perks: ['착지 지점에 시야를 막는 연막 전개'] },
      { title: '신속 연막', perks: ['충전 2회 · 22초마다 재충전', '연막 반경·지속 증가'] },
      { title: '맹독 연막', perks: ['연막 속 적에게 초당 10 독 피해 (방어구 무시)', '충전 3회 · 재충전 16초'] },
    ],
    describe(t) {
      const dps = this.stats.dps[t];
      return `착지 지점에 반경 ${this.stats.radius[t]}m 연막을 ${this.stats.duration[t]}초간 전개합니다.${dps > 0 ? ` 연막 속의 적은 초당 ${dps}의 독 피해를 받습니다.` : ''}`;
    },
    statLines(t) {
      return [charges(this.stats, t), recharge(this.stats, t), ['지속', `${this.stats.duration[t]}초`]];
    },
  },
  infinite: {
    id: 'infinite',
    name: '무한 탄창',
    nameEn: 'BOTTOMLESS MAG',
    type: 'self',
    tagline: '일정 시간 탄약이 줄지 않습니다',
    stats: { charges: s(1, 1, 2), recharge: s(0, 35, 30), duration: s(5, 6.5, 8), fireRate: s(1, 1.1, 1.15), lifesteal: s(0, 0, 0.3) },
    tiers: [
      { title: '무한 탄창', perks: ['탄약 소모와 재장전 없음'] },
      { title: '과열 사격', perks: ['연사력 +10% · 지속 6.5초', '35초마다 재충전'] },
      { title: '흡혈 탄환', perks: ['적에게 준 피해의 30%만큼 체력 회복', '충전 2회 · 연사력 +15%'] },
    ],
    describe(t) {
      const fr = this.stats.fireRate[t];
      const ls = this.stats.lifesteal[t];
      return `${this.stats.duration[t]}초간 탄약 소모와 재장전이 없습니다.${fr > 1 ? ` 연사력 +${pct(fr - 1)}%.` : ''}${ls > 0 ? ` 적에게 준 피해의 ${pct(ls)}%를 체력으로 흡수합니다.` : ''}`;
    },
    statLines(t) {
      return [charges(this.stats, t), recharge(this.stats, t), ['지속', `${this.stats.duration[t]}초`]];
    },
  },
  dash: {
    id: 'dash',
    name: '질풍 대시',
    nameEn: 'DASH',
    type: 'self',
    tagline: '이동 방향으로 순간 돌진',
    stats: { charges: s(1, 2, 3), recharge: s(0, 12, 9), distance: s(6, 7, 8), aim: s(0, 0, 1) },
    tiers: [
      { title: '질풍 대시', perks: ['이동 방향으로 순간 돌진'] },
      { title: '연속 대시', perks: ['충전 2회 · 12초마다 재충전'] },
      { title: '칼바람', perks: ['처치 시 대시 1회 즉시 충전', '대시 후 1초간 이동 탄 퍼짐 없음', '충전 3회 · 재충전 9초'] },
    ],
    describe(t) {
      const rc = this.stats.recharge[t];
      return `이동 방향으로 ${this.stats.distance[t]}m 돌진합니다.${rc > 0 ? ` ${rc}초마다 1회 재충전.` : ''}${this.stats.aim[t] > 0 ? ' 처치 시 1회 충전되며, 대시 직후 1초간 이동 중에도 정확하게 사격합니다.' : ''}`;
    },
    statLines(t) {
      return [charges(this.stats, t), recharge(this.stats, t), ['거리', `${this.stats.distance[t]}m`]];
    },
  },
  heal: {
    id: 'heal',
    name: '나노 치유',
    nameEn: 'NANO HEAL',
    type: 'self',
    tagline: '나노봇이 상처를 빠르게 복구',
    stats: { charges: s(1, 1, 2), recharge: s(0, 30, 25), amount: s(40, 55, 70), armor: s(0, 15, 25), time: s(3, 2.5, 2), lastStand: s(0, 0, 1) },
    tiers: [
      { title: '나노 치유', perks: ['3초에 걸쳐 체력 회복'] },
      { title: '나노 장갑', perks: ['회복량 55 + 방어력 15', '30초마다 재충전'] },
      { title: '불사 프로토콜', perks: ['라운드당 1회, 헤드샷이 아닌 치명상을 체력 1로 버티고 자동 치유', '충전 2회 · 방어력 25'] },
    ],
    describe(t) {
      const a = this.stats.armor[t];
      return `${this.stats.time[t]}초에 걸쳐 체력 ${this.stats.amount[t]}을 회복합니다.${a > 0 ? ` 방어력 ${a} 추가.` : ''}${this.stats.lastStand[t] > 0 ? ' 라운드당 1회, 헤드샷이 아닌 치명상을 체력 1로 버티고 자동으로 치유합니다.' : ''}`;
    },
    statLines(t) {
      return [charges(this.stats, t), recharge(this.stats, t), ['회복', `${this.stats.amount[t]}`]];
    },
  },
  recon: {
    id: 'recon',
    name: '정찰 펄스',
    nameEn: 'RECON PULSE',
    type: 'self',
    tagline: '벽 너머의 적을 드러내는 음파',
    stats: { charges: s(1, 2, 2), recharge: s(0, 30, 24), radius: s(28, 36, 44), reveal: s(2.5, 3, 3.5), echo: s(0, 1, 1), vuln: s(0, 0, VULN_BONUS) },
    tiers: [
      { title: '정찰 펄스', perks: ['반경 내 적 위치를 아군 전체에게 노출'] },
      { title: '반향 펄스', perks: ['1.8초 뒤 같은 자리에서 한 번 더 탐지', '충전 2회 · 30초마다 재충전'] },
      { title: '약점 분석', perks: ['노출된 적은 받는 피해 +15%', '반경 44m · 재충전 24초'] },
    ],
    describe(t) {
      const v = this.stats.vuln[t];
      return `반경 ${this.stats.radius[t]}m 내 적의 위치를 아군 전체에게 ${this.stats.reveal[t]}초간 드러냅니다.${this.stats.echo[t] > 0 ? ` ${ECHO_DELAY}초 뒤 한 번 더 탐지합니다.` : ''}${v > 0 ? ` 노출된 적은 받는 피해가 ${pct(v)}% 증가합니다.` : ''}`;
    },
    statLines(t) {
      return [charges(this.stats, t), recharge(this.stats, t), ['반경', `${this.stats.radius[t]}m`]];
    },
  },
  barrier: {
    id: 'barrier',
    name: '에너지 방벽',
    nameEn: 'BARRIER',
    type: 'deploy',
    tagline: '총알을 막아내는 에너지 벽',
    stats: { charges: s(1, 1, 2), recharge: s(0, 30, 24), hp: s(350, 550, 650), duration: s(14, 18, 20), width: s(3, 3.8, 4.6), reflect: s(0, 0, 0.2) },
    tiers: [
      { title: '에너지 방벽', perks: ['전방에 총알을 막는 에너지 벽 설치'] },
      { title: '강화 방벽', perks: ['내구도 550 · 폭 3.8m', '30초마다 재충전'] },
      { title: '반사 방벽', perks: ['방벽을 쏜 적에게 피해의 20%를 되돌려줌', '충전 2회 · 폭 4.6m'] },
    ],
    describe(t) {
      const rf = this.stats.reflect[t];
      return `전방에 폭 ${this.stats.width[t]}m, 내구도 ${this.stats.hp[t]}의 방벽을 ${this.stats.duration[t]}초간 설치합니다.${rf > 0 ? ` 방벽을 쏜 적은 가한 피해의 ${pct(rf)}%를 돌려받습니다.` : ''}`;
    },
    statLines(t) {
      return [charges(this.stats, t), recharge(this.stats, t), ['내구도', `${this.stats.hp[t]}`]];
    },
  },
  frag: {
    id: 'frag',
    name: '파편 수류탄',
    nameEn: 'FRAG',
    type: 'throw',
    tagline: '반경 내 적에게 큰 피해',
    stats: {
      charges: s(1, 2, 2),
      recharge: s(0, 0, 0),
      damage: s(85, 95, 100),
      radius: s(5, 5.5, 6),
      slow: s(0, 2.5, 2.5),
      bomblets: s(0, 0, 4),
      subDamage: s(0, 0, 40),
      subRadius: s(0, 0, 3.2),
    },
    tiers: [
      { title: '파편 수류탄', perks: ['1.5초 후 폭발해 반경 내 적에게 큰 피해'] },
      { title: '진탕 파편', perks: ['맞은 적은 2.5초간 이동 속도 −35%', '충전 2회'] },
      { title: '집속탄', perks: ['폭발 시 자탄 4개가 흩어져 연쇄 폭발 (각 40)', '피해·반경 증가'] },
    ],
    describe(t) {
      const sl = this.stats.slow[t];
      const b = this.stats.bomblets[t];
      return `1.5초 후 폭발하여 반경 ${this.stats.radius[t]}m 내 최대 ${this.stats.damage[t]} 피해를 줍니다.${sl > 0 ? ` 맞은 적은 ${sl}초간 둔화됩니다.` : ''}${b > 0 ? ` 폭발 후 자탄 ${b}개가 흩어져 각각 최대 ${this.stats.subDamage[t]} 피해를 줍니다.` : ''}`;
    },
    statLines(t) {
      return [charges(this.stats, t), ['피해', `${this.stats.damage[t]}`], ['반경', `${this.stats.radius[t]}m`]];
    },
  },
  cloak: {
    id: 'cloak',
    name: '광학 위장',
    nameEn: 'CLOAK',
    type: 'self',
    tagline: '빛을 굴절시켜 모습을 감춤',
    stats: { charges: s(1, 2, 2), recharge: s(0, 0, 30), duration: s(3.5, 4.5, 6), silent: s(0, 1, 1), phantom: s(0, 0, 1) },
    tiers: [
      { title: '광학 위장', perks: ['거의 투명해짐 · 사격 시 해제'] },
      { title: '무음 위장', perks: ['위장 중 발소리가 나지 않음', '충전 2회 · 지속 4.5초'] },
      { title: '잔상', perks: ['사격해도 위장이 풀리지 않고 0.6초만 드러남', '지속 6초 · 30초마다 재충전'] },
    ],
    describe(t) {
      const tail = this.stats.phantom[t] > 0 ? ' 사격해도 위장이 풀리지 않고 잠시 드러납니다.' : ' 사격 시 해제됩니다.';
      return `${this.stats.duration[t]}초간 거의 투명해집니다.${this.stats.silent[t] > 0 ? ' 위장 중 발소리가 나지 않습니다.' : ''}${tail}`;
    },
    statLines(t) {
      return [charges(this.stats, t), recharge(this.stats, t), ['지속', `${this.stats.duration[t]}초`]];
    },
  },
  adrenaline: {
    id: 'adrenaline',
    name: '아드레날린',
    nameEn: 'ADRENALINE',
    type: 'self',
    tagline: '이동·사격·재장전 속도 증가',
    stats: {
      charges: s(1, 1, 2),
      recharge: s(0, 35, 30),
      duration: s(5, 6, 7),
      speed: s(1.18, 1.22, 1.26),
      fire: s(1.12, 1.16, 1.2),
      reload: s(0, 1, 1),
      killHeal: s(0, 0, 35),
    },
    tiers: [
      { title: '아드레날린', perks: ['이동·연사·재장전 속도 증가'] },
      { title: '투쟁 본능', perks: ['사용 즉시 현재 무기 재장전 완료', '35초마다 재충전'] },
      { title: '폭주', perks: ['지속 중 처치하면 지속시간 초기화 + 체력 35 회복', '충전 2회'] },
    ],
    describe(t) {
      const kh = this.stats.killHeal[t];
      return `${this.stats.duration[t]}초간 이동 속도 +${pct(this.stats.speed[t] - 1)}%, 연사·재장전 +${pct(this.stats.fire[t] - 1)}%.${this.stats.reload[t] > 0 ? ' 사용 즉시 재장전됩니다.' : ''}${kh > 0 ? ` 지속 중 처치하면 지속시간이 초기화되고 체력 ${kh}을 회복합니다.` : ''}`;
    },
    statLines(t) {
      return [charges(this.stats, t), recharge(this.stats, t), ['지속', `${this.stats.duration[t]}초`]];
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
  { id: 'toxic', a: 'smoke', b: 'frag', name: '독성 구름', desc: `내 연막이 적에게 초당 ${TOXIC_SYN_DPS}의 독 피해를 추가로 줍니다.` },
  { id: 'shadowstep', a: 'dash', b: 'cloak', name: '그림자 걸음', desc: '대시 직후 1.5초간 광학 위장 상태가 됩니다.' },
  { id: 'berserk', a: 'infinite', b: 'adrenaline', name: '광전사', desc: '둘 중 하나를 사용하면 다른 하나도 60% 지속시간으로 무료 발동합니다.' },
  { id: 'markflash', a: 'recon', b: 'flash', name: '표적 섬광', desc: '내 섬광에 실명된 적은 3초간 위치가 드러납니다.' },
  { id: 'regenwall', a: 'heal', b: 'barrier', name: '재생 방벽', desc: '내 방벽 주변 4m 안의 아군은 초당 10 체력을 회복합니다.' },
  { id: 'seeker', a: 'frag', b: 'recon', name: '추적 파편', desc: '파편 수류탄 폭발 지점 12m 내 적을 3초간 드러냅니다.' },
  { id: 'phantom', a: 'cloak', b: 'infinite', name: '유령 사격', desc: '무한 탄창 중에는 사격해도 위장이 풀리지 않고 잠시 드러나기만 합니다.' },
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

/** A draft card. tier 0 unlocks a new ability; tier 1 / 2 upgrades an owned one to that step. */
export interface DraftCard {
  ability: AbilityId;
  tier: Tier;
}

/**
 * Up to three distinct cards. Every owned ability that can still grow guarantees one
 * upgrade card, so a pick commits to a path; fresh cards lean toward synergy partners.
 */
export function rollOffer(owned: readonly OwnedAbility[], rnd: () => number = Math.random): DraftCard[] {
  const take = <T>(arr: T[]): T => arr.splice(Math.floor(rnd() * arr.length), 1)[0];
  const upgrades: DraftCard[] = owned.filter((o) => o.tier < MAX_TIER).map((o) => ({ ability: o.id, tier: (o.tier + 1) as Tier }));
  const fresh = owned.length < MAX_SLOTS ? ABILITY_IDS.filter((id) => !owned.some((o) => o.id === id)) : [];
  const cards: DraftCard[] = [];
  if (upgrades.length) cards.push(take(upgrades));
  const partners = fresh.filter((id) => owned.some((o) => synergyPartners(o.id).some((p) => p.partner === id)));
  if (partners.length && rnd() < 0.65) {
    const id = take(partners);
    fresh.splice(fresh.indexOf(id), 1);
    cards.push({ ability: id, tier: 0 });
  }
  while (cards.length < 3 && (upgrades.length || fresh.length)) {
    if (upgrades.length && (!fresh.length || rnd() < 0.35)) cards.push(take(upgrades));
    else cards.push({ ability: take(fresh), tier: 0 });
  }
  // Shuffle so the upgrade card is not always first.
  for (let i = cards.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [cards[i], cards[j]] = [cards[j], cards[i]];
  }
  return cards;
}

/** Adds a drafted card to an owned list: unlocks a new ability or advances an owned one by a step. */
export function applyPick(owned: readonly OwnedAbility[], card: DraftCard): OwnedAbility[] {
  const list = owned.map((o) => ({ ...o }));
  const existing = list.find((o) => o.id === card.ability);
  if (existing) existing.tier = Math.min(MAX_TIER, existing.tier + 1) as Tier;
  else if (list.length < MAX_SLOTS) list.push({ id: card.ability, tier: 0 });
  return list;
}

export function tierOf(owned: readonly OwnedAbility[], id: AbilityId): Tier | null {
  return owned.find((o) => o.id === id)?.tier ?? null;
}

export function stat(id: AbilityId, key: string, t: Tier): number {
  return ABILITIES[id].stats[key]?.[t] ?? 0;
}

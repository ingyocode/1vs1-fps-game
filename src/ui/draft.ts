import { h, clear, setText } from './dom';
import { ABILITY_ICONS } from './icons';
import { ABILITIES, BONUS_PICK_LOSSES, MAX_TIER, TIERS, activeSynergies, synergyPartners, type DraftCard, type OwnedAbility, type Tier } from '../game/abilities';
import type { AudioEngine } from '../audio/audio';

const TYPE_LABEL = { throw: '투척', self: '자가 강화', deploy: '설치' } as const;

export class DraftView {
  readonly root: HTMLElement;
  private cardsEl: HTMLElement;
  private titleEl: HTMLElement;
  private timerEl: HTMLElement;
  private ringEl: SVGCircleElement;
  private handEl: HTMLElement;
  private synEl: HTMLElement;
  private waitEl: HTMLElement;
  private cards: DraftCard[] = [];
  private picked = false;
  private bonus = false;
  private subEl: HTMLElement;
  private kickerEl: HTMLElement;
  private endsAt = 0;
  private total = 15;
  private keyHandler = (e: KeyboardEvent): void => {
    if (this.root.classList.contains('hidden') || this.picked) return;
    const i = ['Digit1', 'Digit2', 'Digit3'].indexOf(e.code);
    if (i >= 0 && i < this.cards.length) this.pick(i);
  };

  constructor(
    parent: HTMLElement,
    private audio: AudioEngine,
    private onPick: (index: number) => void,
  ) {
    this.titleEl = h('div', { class: 'draft-title' });
    this.kickerEl = h('div', { class: 'draft-kicker' }, 'ABILITY DRAFT');
    this.subEl = h('div', { class: 'draft-sub' });
    this.timerEl = h('div', { class: 'draft-timer-num' }, '15');
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('viewBox', '0 0 64 64');
    svg.classList.add('draft-ring');
    const bg = document.createElementNS(svgNS, 'circle');
    bg.setAttribute('cx', '32');
    bg.setAttribute('cy', '32');
    bg.setAttribute('r', '28');
    bg.setAttribute('class', 'ring-bg');
    this.ringEl = document.createElementNS(svgNS, 'circle');
    this.ringEl.setAttribute('cx', '32');
    this.ringEl.setAttribute('cy', '32');
    this.ringEl.setAttribute('r', '28');
    this.ringEl.setAttribute('class', 'ring-fg');
    svg.append(bg, this.ringEl);
    this.cardsEl = h('div', { class: 'draft-cards' });
    this.handEl = h('div', { class: 'draft-hand' });
    this.synEl = h('div', { class: 'draft-syn' });
    this.waitEl = h('div', { class: 'draft-wait hidden' }, '다른 플레이어의 선택을 기다리는 중…');
    this.root = h(
      'div',
      { id: 'draft', class: 'screen hidden' },
      h('div', { class: 'draft-bg' }),
      h(
        'div',
        { class: 'draft-head' },
        this.kickerEl,
        this.titleEl,
        this.subEl,
        h('div', { class: 'draft-timer' }, svg as unknown as HTMLElement, this.timerEl),
      ),
      this.cardsEl,
      this.waitEl,
      h('div', { class: 'draft-foot' }, h('div', { class: 'draft-label' }, '보유 능력'), this.handEl, this.synEl),
    );
    parent.append(this.root);
    window.addEventListener('keydown', this.keyHandler);
  }

  /** `bonus`: an extra card earned by losing rounds (shown over the buy phase). */
  show(pick: number, total: number, cards: DraftCard[], endsAtLocal: number, owned: OwnedAbility[], bonus = false): void {
    this.cards = cards;
    this.picked = false;
    this.bonus = bonus;
    this.endsAt = endsAtLocal;
    this.total = Math.max(1, (endsAtLocal - performance.now()) / 1000);
    this.root.classList.remove('hidden');
    this.root.classList.toggle('bonus', bonus);
    this.waitEl.classList.add('hidden');
    setText(this.kickerEl, bonus ? 'COMEBACK AUGMENT' : 'ABILITY DRAFT');
    setText(this.titleEl, bonus ? `추가 증강${total > 1 ? ` · 남은 ${total}장` : ''}` : `능력 선택 ${pick} / ${total}`);
    setText(
      this.subEl,
      bonus
        ? `라운드 ${BONUS_PICK_LOSSES}패 보상입니다. 구매 단계가 끝나기 전에 고르세요 — 시간이 지나면 무작위로 선택됩니다.`
        : '카드 한 장을 고르세요. 보유한 능력은 다음 단계 강화 카드로 등장하며 Ⅲ단계에서 각성합니다. 특정 조합은 시너지를 발동합니다.',
    );
    clear(this.cardsEl);
    cards.forEach((c, i) => this.cardsEl.append(this.renderCard(c, i, owned)));
    cards.forEach((c, i) => this.audio.cardReveal(c.tier + 1, 0.12 + i * 0.16));
    this.renderHand(owned);
  }

  private renderCard(c: DraftCard, i: number, owned: OwnedAbility[]): HTMLElement {
    const def = ABILITIES[c.ability];
    const tr = TIERS[c.tier];
    const step = def.tiers[c.tier];
    const upgrade = c.tier > 0;
    const stats = def.statLines(c.tier);
    const prev = upgrade ? def.statLines((c.tier - 1) as Tier) : null;
    const partners = synergyPartners(c.ability);
    const inner = h(
      'div',
      { class: 'card-inner' },
      h('div', { class: 'card-shine' }),
      h('div', { class: 'card-head' }, h('span', { class: 'rarity-tag' }, upgrade ? `${tr.roman} ${tr.name} · ${tr.nameEn}` : '신규 · NEW'), h('span', { class: 'type-tag' }, TYPE_LABEL[def.type])),
      h('div', { class: 'card-icon', html: ABILITY_ICONS[c.ability] }),
      h('div', { class: 'card-name' }, step.title),
      h('div', { class: 'card-en' }, upgrade ? `${def.name} 강화` : def.nameEn),
      h('div', { class: 'card-pips' }, ...TIERS.map((t, k) => h('i', { class: k < c.tier ? 'done' : k === c.tier ? 'now' : '', title: `${t.roman} ${def.tiers[k].title}` }))),
      upgrade ? h('div', { class: 'card-perks' }, ...step.perks.map((pk) => h('div', { class: 'perk' }, pk))) : h('div', { class: 'card-desc' }, def.describe(0)),
      h(
        'div',
        { class: 'card-stats' },
        ...stats.map(([k, v], j) => {
          const old = prev?.[j]?.[1];
          return h('div', { class: 'stat-row' }, h('span', {}, k), old !== undefined && old !== v ? h('b', {}, h('s', {}, old), ` → ${v}`) : h('b', {}, v));
        }),
      ),
      // A fresh card previews where the ability grows, so the pick can be planned.
      upgrade ? null : h('div', { class: 'card-path' }, def.tiers.slice(1, MAX_TIER + 1).map((t, k) => `${TIERS[k + 1].roman} ${t.title}`).join('  →  ')),
      h(
        'div',
        { class: 'card-syn' },
        ...partners.slice(0, 3).map((p) => {
          const on = owned.some((o) => o.id === p.partner);
          return h('div', { class: `syn-line ${on ? 'on' : ''}`, title: p.syn.desc }, h('span', { class: 'syn-ico', html: ABILITY_ICONS[p.partner] }), `${ABILITIES[p.partner].name} → ${p.syn.name}`);
        }),
      ),
      h('div', { class: 'card-key' }, String(i + 1)),
    );
    const card = h('div', { class: `card tier-${c.tier}${upgrade ? ' upgrade' : ''}`, style: `--rc:${tr.color}; --delay:${0.08 + i * 0.14}s` }, inner);
    card.addEventListener('mousemove', (e) => {
      const rect = card.getBoundingClientRect();
      const x = (e.clientX - rect.left) / rect.width - 0.5;
      const y = (e.clientY - rect.top) / rect.height - 0.5;
      inner.style.transform = `rotateY(${x * 14}deg) rotateX(${-y * 12}deg) translateZ(10px)`;
      inner.style.setProperty('--mx', `${(x + 0.5) * 100}%`);
      inner.style.setProperty('--my', `${(y + 0.5) * 100}%`);
    });
    card.addEventListener('mouseenter', () => this.audio.uiHover());
    card.addEventListener('mouseleave', () => {
      inner.style.transform = '';
    });
    card.addEventListener('click', () => this.pick(i));
    return card;
  }

  private renderHand(owned: OwnedAbility[]): void {
    clear(this.handEl);
    if (owned.length === 0) this.handEl.append(h('div', { class: 'hand-empty' }, '아직 없음'));
    for (const o of owned) {
      const tr = TIERS[o.tier];
      const def = ABILITIES[o.id];
      this.handEl.append(h('div', { class: 'hand-chip', style: `--rc:${tr.color}`, title: def.describe(o.tier) }, h('span', { class: 'hand-ico', html: ABILITY_ICONS[o.id] }), def.tiers[o.tier].title, h('em', {}, tr.roman)));
    }
    clear(this.synEl);
    for (const sy of activeSynergies(owned)) this.synEl.append(h('div', { class: 'syn-chip big', title: sy.desc }, `⟡ ${sy.name}`, h('span', {}, sy.desc)));
  }

  private pick(i: number): void {
    if (this.picked) return;
    this.picked = true;
    this.audio.cardPick();
    [...this.cardsEl.children].forEach((el, k) => el.classList.add(k === i ? 'picked' : 'rejected'));
    this.onPick(i);
  }

  waiting(owned: OwnedAbility[]): void {
    this.picked = true;
    this.waitEl.classList.remove('hidden');
    this.renderHand(owned);
  }

  hide(): void {
    this.root.classList.add('hidden');
    this.bonus = false;
  }

  /** A bonus card was chosen and the overlay is waiting to close. */
  get bonusPicked(): boolean {
    return this.bonus && this.picked;
  }

  get visible(): boolean {
    return !this.root.classList.contains('hidden');
  }

  update(): void {
    if (!this.visible) return;
    const left = Math.max(0, (this.endsAt - performance.now()) / 1000);
    setText(this.timerEl, String(Math.ceil(left)));
    const c = 2 * Math.PI * 28;
    this.ringEl.style.strokeDasharray = `${c}`;
    this.ringEl.style.strokeDashoffset = `${c * (1 - left / this.total)}`;
  }
}

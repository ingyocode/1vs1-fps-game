import { h, clear, setText } from './dom';
import { ABILITY_ICONS, ICONS, WEAPON_ICONS } from './icons';
import { ARMOR_ITEMS, PRIMARY_IDS, SECONDARY_IDS, WEAPONS, type WeaponId } from '../game/weapons';
import { ABILITIES, BONUS_PICK_LOSSES, MAX_TIER, TIERS, activeSynergies } from '../game/abilities';
import type { PlayerInfo } from '../net/protocol';
import type { AudioEngine } from '../audio/audio';

const BAR_LABELS: [keyof (typeof WEAPONS)['rifle']['bars'], string][] = [
  ['damage', '피해'],
  ['rate', '연사'],
  ['accuracy', '정확도'],
  ['mobility', '기동성'],
  ['range', '사거리'],
];

export class ShopView {
  readonly root: HTMLElement;
  private body: HTMLElement;
  private goldEl: HTMLElement;
  private timerEl: HTMLElement;
  private msgEl: HTMLElement;
  private lastKey = '';
  private range = false;
  open = false;

  constructor(
    parent: HTMLElement,
    private audio: AudioEngine,
    private onBuy: (item: string) => void,
    private onClose: () => void,
  ) {
    this.goldEl = h('div', { class: 'shop-gold' });
    this.timerEl = h('div', { class: 'shop-timer' });
    this.msgEl = h('div', { class: 'shop-msg' });
    this.body = h('div', { class: 'shop-body' });
    this.root = h(
      'div',
      { id: 'shop', class: 'hidden' },
      h(
        'div',
        { class: 'shop-panel' },
        h(
          'div',
          { class: 'shop-head' },
          h('div', {}, h('div', { class: 'shop-kicker' }, 'ARMORY'), h('div', { class: 'shop-title' }, '상점')),
          h('div', { class: 'shop-head-right' }, this.timerEl, this.goldEl, h('button', { class: 'icon-btn', onclick: () => this.onClose(), html: ICONS.close })),
        ),
        this.body,
        h('div', { class: 'shop-foot' }, this.msgEl, h('div', { class: 'shop-hint' }, h('span', { class: 'kbd' }, 'B'), ' 닫기 · 구매 단계가 끝나면 자동으로 닫힙니다')),
      ),
    );
    parent.append(this.root);
  }

  show(on: boolean): void {
    this.open = on;
    this.root.classList.toggle('hidden', !on);
    if (on) this.lastKey = '';
  }

  message(text: string, ok: boolean): void {
    this.msgEl.className = `shop-msg ${ok ? 'ok' : 'bad'}`;
    setText(this.msgEl, text);
  }

  /**
   * `losses` = rounds my team has lost (drives the bonus augment meter).
   * `range` = shooting range: everything is free and the timer means nothing.
   */
  update(me: PlayerInfo | undefined, timeLeft: number, losses: number, range = false): void {
    if (!this.open || !me) return;
    this.range = range;
    setText(this.goldEl, range ? '무료' : `${me.gold.toLocaleString()} G`);
    setText(this.timerEl, range ? '사격장' : `${Math.ceil(timeLeft)}초`);
    const key = JSON.stringify([me.gold, me.primary, me.secondary, me.armor, me.abilities, losses, range]);
    if (key === this.lastKey) return;
    this.lastKey = key;
    clear(this.body);
    this.body.append(
      this.section('주무기', PRIMARY_IDS.map((id) => this.weaponCard(id, me))),
      this.section('보조무기', SECONDARY_IDS.map((id) => this.weaponCard(id, me))),
      h(
        'div',
        { class: 'shop-row2' },
        this.section(
          '장비',
          ARMOR_ITEMS.map((a) => {
            const owned = me.armor >= a.amount;
            const afford = me.gold >= a.price;
            return h(
              'button',
              { class: `shop-item armor ${owned ? 'owned' : ''} ${!afford && !owned ? 'poor' : ''}`, onclick: () => this.buy(a.id), onmouseenter: () => this.audio.uiHover() },
              h('div', { class: 'si-icon armor-ico', html: ICONS.shield }),
              h('div', { class: 'si-name' }, a.name),
              h('div', { class: 'si-desc' }, a.desc),
              h('div', { class: 'si-price' }, owned ? '보유' : `${a.price} G`),
            );
          }),
        ),
        this.section('보유 능력', [
          ...(me.abilities.length
            ? me.abilities.map((ab) => {
                const def = ABILITIES[ab.id];
                const tr = TIERS[ab.tier];
                return h(
                  'div',
                  { class: `shop-item upgrade static ${ab.tier >= MAX_TIER ? 'owned' : ''}`, style: `--rc:${tr.color}`, title: def.describe(ab.tier) },
                  h('div', { class: 'si-icon', html: ABILITY_ICONS[ab.id] }),
                  h('div', { class: 'si-name' }, def.name),
                  h('div', { class: 'si-desc' }, h('em', { style: `color:${tr.color}` }, tr.roman), ` ${def.tiers[ab.tier].title}`),
                  h('div', { class: 'si-price' }, ab.tier >= MAX_TIER ? '각성' : tr.name),
                );
              })
            : [h('div', { class: 'shop-empty' }, '보유한 능력이 없습니다')]),
          this.bonusMeter(losses),
        ]),
      ),
    );
    const syn = activeSynergies(me.abilities);
    if (syn.length) this.body.append(h('div', { class: 'shop-syn' }, ...syn.map((s) => h('div', { class: 'syn-chip big' }, `⟡ ${s.name}`, h('span', {}, s.desc)))));
  }

  /** Abilities are never sold; losing rounds earns extra draft cards instead. */
  private bonusMeter(losses: number): HTMLElement {
    const into = losses % BONUS_PICK_LOSSES;
    const pips = Array.from({ length: BONUS_PICK_LOSSES }, (_, i) => h('i', { class: i < into ? 'on' : '' }));
    return h(
      'div',
      { class: 'shop-bonus' },
      h('div', { class: 'sb-title' }, '추가 증강'),
      h('div', { class: 'sb-pips' }, ...pips),
      h('div', { class: 'sb-text' }, `능력은 골드로 강화할 수 없습니다. 라운드를 ${BONUS_PICK_LOSSES}번 질 때마다 다음 구매 단계에서 증강 카드를 한 장 더 고릅니다${into ? ` (다음까지 ${BONUS_PICK_LOSSES - into}패)` : ''}.`),
    );
  }

  private section(title: string, items: HTMLElement[]): HTMLElement {
    return h('div', { class: 'shop-section' }, h('div', { class: 'shop-sec-title' }, title), h('div', { class: 'shop-grid' }, ...items));
  }

  private weaponCard(id: WeaponId, me: PlayerInfo): HTMLElement {
    const d = WEAPONS[id];
    const owned = me.primary === id || me.secondary === id;
    const afford = this.range || me.gold >= d.price;
    return h(
      'button',
      { class: `shop-item weapon ${owned ? 'owned' : ''} ${!afford && !owned ? 'poor' : ''}`, onclick: () => this.buy(id), onmouseenter: () => this.audio.uiHover() },
      h('div', { class: 'si-cat' }, d.category),
      h('div', { class: 'si-weapon', html: WEAPON_ICONS[id] }),
      h('div', { class: 'si-name' }, d.nameKo),
      h('div', { class: 'si-bars' }, ...BAR_LABELS.map(([k, label]) => h('div', { class: 'si-bar' }, h('span', {}, label), h('i', {}, h('b', { style: `width:${Math.round(d.bars[k] * 100)}%` }))))),
      h('div', { class: 'si-meta' }, `${d.mag || '∞'}발 · ${d.rpm}RPM`),
      h('div', { class: 'si-price' }, owned ? '보유 중' : d.price === 0 || this.range ? '무료' : `${d.price.toLocaleString()} G`),
    );
  }

  private buy(item: string): void {
    this.audio.uiClick();
    this.onBuy(item);
  }
}

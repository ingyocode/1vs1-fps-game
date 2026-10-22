import { h, setStyle, setText, toggleClass, clear } from './dom';
import { ABILITY_ICONS, ICONS, WEAPON_ICONS } from './icons';
import { ABILITIES, TIERS, type AbilityId, type SynergyDef, type Tier } from '../game/abilities';
import { WEAPONS, type WeaponId } from '../game/weapons';
import { TEAMS, type TeamId } from '../core/config';
import { KEY_LABEL, BINDINGS } from '../core/input';
import { escapeHtml, formatClock } from '../core/utils';
import type { RadarRect } from '../world/map';

export interface HudAbility {
  id: AbilityId;
  tier: Tier;
  charges: number;
  max: number;
  recharge: number;
  active: number;
}

export interface HudState {
  hp: number;
  armor: number;
  gold: number;
  alive: boolean;
  weapon: WeaponId;
  mag: number;
  reserve: number;
  infinite: boolean;
  reloading: number;
  inventory: { primary: WeaponId | null; secondary: WeaponId; current: WeaponId };
  abilities: HudAbility[];
  synergies: SynergyDef[];
  timer: number;
  /** Replaces the countdown (shooting range shows ∞). */
  clock?: string;
  phaseLabel: string;
  scores: [number, number];
  round: number;
  firstTo: number;
  myTeam: TeamId;
  roster: { id: string; team: TeamId; alive: boolean; self: boolean }[];
  spread: number;
  crosshair: boolean;
  scoped: boolean;
  ping: number;
  fps: number;
  showFps: boolean;
  spectating: string | null;
  buyPhase: boolean;
  adrenaline: number;
  cloak: number;
  /** Seconds left on debuffs (0 = none). */
  suppressed: number;
  slowed: number;
  vulnerable: number;
}

export interface NameTag {
  id: string;
  x: number;
  y: number;
  name: string;
  hp: number;
  enemy: boolean;
  team: TeamId;
  dist: number;
}

export interface RadarDot {
  x: number;
  z: number;
  kind: 'self' | 'ally' | 'enemy' | 'coin' | 'bigcoin' | 'smoke' | 'barrier' | 'dead';
  yaw?: number;
  r?: number;
  team?: TeamId;
}

export class Hud {
  readonly root: HTMLElement;
  private els: Record<string, HTMLElement> = {};
  private abilityEls: { root: HTMLElement; icon: HTMLElement; charges: HTMLElement; cd: HTMLElement; key: HTMLElement; active: HTMLElement }[] = [];
  private lastAbilityKey = '';
  private killfeed: HTMLElement;
  private dmgLayer: HTMLElement;
  private tagLayer: HTMLElement;
  private tags = new Map<string, HTMLElement>();
  private radarCanvas: HTMLCanvasElement;
  private radarCtx: CanvasRenderingContext2D;
  private radarBase: HTMLCanvasElement | null = null;
  private radarBounds = { minX: -37, maxX: 37, minZ: -22, maxZ: 22 };
  private hitTimer = 0;
  private rosterKey = '';
  private lastWeapon = '';
  private lastInv = '';
  private toastTimer = 0;

  constructor(parent: HTMLElement) {
    const E = this.els;
    this.root = h('div', { id: 'hud', class: 'hidden' });
    // Top bar
    E.score0 = h('div', { class: 'score-num team0' }, '0');
    E.score1 = h('div', { class: 'score-num team1' }, '0');
    E.pips0 = h('div', { class: 'pips team0' });
    E.pips1 = h('div', { class: 'pips team1' });
    E.timer = h('div', { class: 'timer' }, '0:00');
    E.phase = h('div', { class: 'phase-label' }, '');
    E.round = h('div', { class: 'round-label' }, '');
    const top = h(
      'div',
      { class: 'scorebar' },
      h('div', { class: 'score-side left' }, h('div', { class: 'team-name team0' }, TEAMS[0].name), E.score0, E.pips0),
      h('div', { class: 'score-center' }, E.timer, E.phase),
      h('div', { class: 'score-side right' }, E.pips1, E.score1, h('div', { class: 'team-name team1' }, TEAMS[1].name)),
    );
    this.root.append(h('div', { class: 'top-wrap' }, top, E.round));
    this.root.append(h('div', { class: 'toast-wrap' }, (E.toast = h('div', { class: 'toast' }))));

    // Radar
    this.radarCanvas = h('canvas', { class: 'radar', width: 264, height: 160 });
    this.radarCtx = this.radarCanvas.getContext('2d')!;
    this.root.append(h('div', { class: 'radar-wrap' }, this.radarCanvas));

    // Killfeed
    this.killfeed = h('div', { class: 'killfeed' });
    this.root.append(this.killfeed);

    // Crosshair & center elements
    E.cross = h('div', { class: 'crosshair' }, h('i', { class: 'ch-t' }), h('i', { class: 'ch-b' }), h('i', { class: 'ch-l' }), h('i', { class: 'ch-r' }), h('i', { class: 'ch-dot' }));
    E.hit = h('div', { class: 'hitmarker' }, h('i'), h('i'), h('i'), h('i'));
    this.dmgLayer = h('div', { class: 'dmg-layer' });
    E.scope = h('div', { class: 'scope hidden' }, h('div', { class: 'scope-ring' }), h('div', { class: 'scope-h' }), h('div', { class: 'scope-v' }), h('div', { class: 'scope-dot' }));
    this.tagLayer = h('div', { class: 'tag-layer' });
    this.root.append(this.tagLayer, E.scope, this.dmgLayer, E.cross, E.hit);

    // Banner
    E.banner = h('div', { class: 'banner hidden' }, (E.bannerTitle = h('div', { class: 'banner-title' })), (E.bannerSub = h('div', { class: 'banner-sub' })));
    this.root.append(E.banner);

    // Center info (death / spectate / buy hint)
    E.center = h('div', { class: 'center-info hidden' });
    this.root.append(E.center);
    E.buyHint = h('div', { class: 'buy-hint hidden' }, h('span', { class: 'kbd' }, 'B'), ' 상점 열기');
    this.root.append(E.buyHint);

    // Bottom left: vitals
    E.hpNum = h('div', { class: 'hp-num' }, '100');
    E.hpBar = h('div', { class: 'bar-fill' });
    E.hpBarGhost = h('div', { class: 'bar-ghost' });
    E.armorNum = h('div', { class: 'armor-num' }, '0');
    E.armorBar = h('div', { class: 'bar-fill armor' });
    E.gold = h('div', { class: 'gold-num' }, '0');
    E.goldPops = h('div', { class: 'gold-pops' });
    this.root.append(
      h(
        'div',
        { class: 'vitals' },
        h('div', { class: 'hp-row' }, h('div', { class: 'hp-icon' }, '+'), E.hpNum, h('div', { class: 'bar hp' }, E.hpBarGhost, E.hpBar)),
        h('div', { class: 'armor-row' }, h('div', { class: 'armor-icon', html: ICONS.shield }), E.armorNum, h('div', { class: 'bar armor' }, E.armorBar)),
        h('div', { class: 'gold-row' }, h('span', { class: 'coin-icon', html: ICONS.coin }), E.gold, E.goldPops),
      ),
    );

    // Bottom center: abilities
    E.abilities = h('div', { class: 'abilities' });
    E.synergy = h('div', { class: 'synergy-strip' });
    this.root.append(h('div', { class: 'abilities-wrap' }, E.synergy, E.abilities));

    // Bottom right: weapon
    E.weaponName = h('div', { class: 'weapon-name' });
    E.weaponIcon = h('div', { class: 'weapon-icon' });
    E.mag = h('div', { class: 'mag' }, '0');
    E.reserve = h('div', { class: 'reserve' }, '0');
    E.reload = h('div', { class: 'reload-bar' }, h('div', { class: 'reload-fill' }));
    E.inv = h('div', { class: 'inventory' });
    this.root.append(h('div', { class: 'weapon-panel' }, E.inv, h('div', { class: 'weapon-main' }, E.weaponIcon, h('div', { class: 'ammo' }, E.mag, h('span', { class: 'slash' }, '/'), E.reserve)), E.weaponName, E.reload));

    // Shooting range readout + floating damage numbers
    E.range = h('div', { class: 'range-panel hidden' });
    this.root.append(E.range);
    E.stats = h('div', { class: 'net-stats' });
    this.root.append(E.stats);
    E.effects = h('div', { class: 'status-effects' });
    this.root.append(E.effects);
    parent.append(this.root);
  }

  show(on: boolean): void {
    toggleClass(this.root, 'hidden', !on);
  }

  setRadarMap(rects: RadarRect[], bounds: { minX: number; maxX: number; minZ: number; maxZ: number }): void {
    this.radarBounds = { minX: bounds.minX - 1, maxX: bounds.maxX + 1, minZ: bounds.minZ - 1, maxZ: bounds.maxZ + 1 };
    const c = document.createElement('canvas');
    c.width = this.radarCanvas.width;
    c.height = this.radarCanvas.height;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = 'rgba(14,18,26,0.82)';
    ctx.fillRect(0, 0, c.width, c.height);
    // spawn tints
    for (const t of [0, 1] as TeamId[]) {
      const [x0, x1] = t === 0 ? [-36.4, -28] : [28, 36.4];
      const a = this.toRadar(x0, -7);
      const b = this.toRadar(x1, 7);
      ctx.fillStyle = t === 0 ? 'rgba(56,214,255,0.16)' : 'rgba(255,106,61,0.16)';
      ctx.fillRect(a[0], a[1], b[0] - a[0], b[1] - a[1]);
    }
    const sorted = [...rects].sort((p, q) => p.h - q.h);
    for (const r of sorted) {
      const a = this.toRadar(r.x0, r.z0);
      const b = this.toRadar(r.x1, r.z1);
      const k = Math.min(1, r.h / 7);
      ctx.fillStyle = `rgba(${120 + k * 70},${130 + k * 70},${145 + k * 70},${0.35 + k * 0.4})`;
      ctx.fillRect(a[0], a[1], Math.max(1, b[0] - a[0]), Math.max(1, b[1] - a[1]));
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.15)';
    ctx.strokeRect(0.5, 0.5, c.width - 1, c.height - 1);
    this.radarBase = c;
  }

  private toRadar(x: number, z: number): [number, number] {
    const b = this.radarBounds;
    const w = this.radarCanvas.width;
    const hgt = this.radarCanvas.height;
    return [((x - b.minX) / (b.maxX - b.minX)) * w, ((z - b.minZ) / (b.maxZ - b.minZ)) * hgt];
  }

  drawRadar(dots: RadarDot[]): void {
    const ctx = this.radarCtx;
    const c = this.radarCanvas;
    ctx.clearRect(0, 0, c.width, c.height);
    if (this.radarBase) ctx.drawImage(this.radarBase, 0, 0);
    const scale = c.width / (this.radarBounds.maxX - this.radarBounds.minX);
    for (const d of dots) {
      const [x, y] = this.toRadar(d.x, d.z);
      switch (d.kind) {
        case 'smoke':
          ctx.fillStyle = 'rgba(200,205,215,0.45)';
          ctx.beginPath();
          ctx.arc(x, y, (d.r ?? 4) * scale, 0, Math.PI * 2);
          ctx.fill();
          break;
        case 'coin':
        case 'bigcoin':
          ctx.fillStyle = '#ffc23a';
          ctx.beginPath();
          ctx.arc(x, y, d.kind === 'bigcoin' ? 4 : 2.2, 0, Math.PI * 2);
          ctx.fill();
          break;
        case 'barrier':
          ctx.strokeStyle = d.team === 0 ? '#38d6ff' : '#ff6a3d';
          ctx.lineWidth = 2;
          ctx.beginPath();
          if ((d.yaw ?? 0) === 0) {
            ctx.moveTo(x - (d.r ?? 2) * scale, y);
            ctx.lineTo(x + (d.r ?? 2) * scale, y);
          } else {
            ctx.moveTo(x, y - (d.r ?? 2) * scale);
            ctx.lineTo(x, y + (d.r ?? 2) * scale);
          }
          ctx.stroke();
          break;
        case 'dead':
          ctx.strokeStyle = 'rgba(255,255,255,0.5)';
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.moveTo(x - 3, y - 3);
          ctx.lineTo(x + 3, y + 3);
          ctx.moveTo(x + 3, y - 3);
          ctx.lineTo(x - 3, y + 3);
          ctx.stroke();
          break;
        default: {
          const color = d.kind === 'enemy' ? '#ff3a4a' : d.kind === 'self' ? '#ffffff' : d.team === 0 ? '#38d6ff' : '#ff6a3d';
          ctx.save();
          ctx.translate(x, y);
          if (d.yaw !== undefined) {
            ctx.rotate(-d.yaw);
            ctx.fillStyle = d.kind === 'self' ? 'rgba(255,255,255,0.14)' : 'rgba(255,255,255,0.06)';
            ctx.beginPath();
            ctx.moveTo(0, 0);
            ctx.arc(0, 0, 22, -Math.PI / 2 - 0.5, -Math.PI / 2 + 0.5);
            ctx.closePath();
            ctx.fill();
          }
          ctx.fillStyle = color;
          ctx.strokeStyle = 'rgba(0,0,0,0.7)';
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          if (d.kind === 'self' || d.kind === 'ally') {
            ctx.moveTo(0, -6);
            ctx.lineTo(4.2, 4.5);
            ctx.lineTo(0, 2.4);
            ctx.lineTo(-4.2, 4.5);
            ctx.closePath();
          } else ctx.arc(0, 0, 4, 0, Math.PI * 2);
          ctx.stroke();
          ctx.fill();
          ctx.restore();
        }
      }
    }
  }

  update(s: HudState, dt: number): void {
    const E = this.els;
    toggleClass(this.root, 'dead', !s.alive);
    setText(E.score0, String(s.scores[0]));
    setText(E.score1, String(s.scores[1]));
    setText(E.timer, s.clock ?? formatClock(s.timer));
    toggleClass(E.timer, 'urgent', s.timer <= 10 && s.phaseLabel === '전투');
    setText(E.phase, s.phaseLabel);
    setText(E.round, `ROUND ${s.round} · ${s.firstTo}선승`);
    const rk = JSON.stringify(s.roster);
    if (rk !== this.rosterKey) {
      this.rosterKey = rk;
      for (const t of [0, 1] as TeamId[]) {
        const el = t === 0 ? E.pips0 : E.pips1;
        clear(el);
        for (const r of s.roster.filter((x) => x.team === t)) el.append(h('div', { class: `pip ${r.alive ? 'alive' : 'dead'} ${r.self ? 'self' : ''}` }));
      }
      toggleClass(this.root, 'team1-me', s.myTeam === 1);
    }

    // Vitals
    setText(E.hpNum, String(Math.max(0, Math.ceil(s.hp))));
    setStyle(E.hpBar, 'width', `${Math.max(0, Math.min(100, s.hp))}%`);
    setStyle(E.hpBarGhost, 'width', `${Math.max(0, Math.min(100, s.hp))}%`);
    toggleClass(E.hpNum, 'low', s.hp <= 30);
    setText(E.armorNum, String(Math.round(s.armor)));
    setStyle(E.armorBar, 'width', `${Math.min(100, (s.armor / 50) * 100)}%`);
    setText(E.gold, s.gold.toLocaleString());

    // Weapon
    const def = WEAPONS[s.weapon];
    if (this.lastWeapon !== s.weapon) {
      this.lastWeapon = s.weapon;
      setText(E.weaponName, `${def.nameKo}  ·  ${def.category}`);
      E.weaponIcon.innerHTML = WEAPON_ICONS[s.weapon];
    }
    const melee = def.slot === 'melee';
    setText(E.mag, melee ? '—' : s.infinite ? '∞' : String(s.mag));
    setText(E.reserve, melee ? '' : String(s.reserve));
    toggleClass(E.mag, 'low', !melee && !s.infinite && s.mag <= Math.ceil(def.mag * 0.25));
    toggleClass(E.mag, 'infinite', s.infinite);
    toggleClass(E.reload, 'active', s.reloading > 0);
    setStyle(E.reload.firstElementChild as HTMLElement, 'width', `${s.reloading * 100}%`);
    const invKey = `${s.inventory.primary}|${s.inventory.secondary}|${s.inventory.current}`;
    if (invKey !== this.lastInv) {
      this.lastInv = invKey;
      clear(E.inv);
      const slots: [string, WeaponId | null][] = [
        ['1', s.inventory.primary],
        ['2', s.inventory.secondary],
        ['3', 'knife'],
      ];
      for (const [k, w] of slots) {
        E.inv.append(h('div', { class: `inv-slot ${w === s.inventory.current ? 'current' : ''} ${w ? '' : 'empty'}` }, h('span', { class: 'kbd small' }, k), w ? h('span', { class: 'inv-icon', html: WEAPON_ICONS[w] }) : h('span', { class: 'inv-empty' }, '—')));
      }
    }

    // Abilities
    const key = s.abilities.map((a) => `${a.id}${a.tier}`).join(',');
    if (key !== this.lastAbilityKey) {
      this.lastAbilityKey = key;
      this.buildAbilities(s.abilities);
      clear(E.synergy);
      for (const sy of s.synergies) E.synergy.append(h('div', { class: 'syn-chip', title: sy.desc }, '⟡ ', sy.name));
    }
    s.abilities.forEach((a, i) => {
      const el = this.abilityEls[i];
      if (!el) return;
      setText(el.charges, '●'.repeat(a.charges) + '○'.repeat(Math.max(0, a.max - a.charges)));
      toggleClass(el.root, 'empty', a.charges <= 0);
      setStyle(el.cd, 'height', `${a.recharge > 0 && a.charges < a.max ? (1 - a.recharge) * 100 : 0}%`);
      toggleClass(el.root, 'active', a.active > 0);
      setStyle(el.active, 'transform', `scaleX(${a.active})`);
    });
    toggleClass(E.abilities, 'suppressed', s.suppressed > 0);

    // Crosshair
    const gap = Math.round(s.spread);
    setStyle(E.cross, '--gap', `${gap}px`);
    toggleClass(E.cross, 'hidden', !s.crosshair || s.scoped || !s.alive);
    toggleClass(E.scope, 'hidden', !s.scoped);
    toggleClass(E.buyHint, 'hidden', !s.buyPhase);

    // Hitmarker decay
    if (this.hitTimer > 0) {
      this.hitTimer -= dt;
      if (this.hitTimer <= 0) E.hit.className = 'hitmarker';
    }
    if (this.toastTimer > 0) {
      this.toastTimer -= dt;
      if (this.toastTimer <= 0) E.toast.classList.remove('show');
    }

    // Status effects strip
    const fx: string[] = [];
    if (s.adrenaline > 0) fx.push(`<span class="fx adren">아드레날린 ${s.adrenaline.toFixed(1)}s</span>`);
    if (s.cloak > 0) fx.push(`<span class="fx cloak">광학 위장 ${s.cloak.toFixed(1)}s</span>`);
    if (s.infinite) fx.push('<span class="fx inf">무한 탄창</span>');
    if (s.suppressed > 0) fx.push(`<span class="fx bad">제압 ${s.suppressed.toFixed(1)}s</span>`);
    if (s.slowed > 0) fx.push(`<span class="fx bad">둔화 ${s.slowed.toFixed(1)}s</span>`);
    if (s.vulnerable > 0) fx.push(`<span class="fx bad">약점 노출 ${s.vulnerable.toFixed(1)}s</span>`);
    const fxHtml = fx.join('');
    if (E.effects.innerHTML !== fxHtml) E.effects.innerHTML = fxHtml;

    setText(E.stats, s.showFps ? `${Math.round(s.fps)} FPS · ${Math.round(s.ping)} ms` : '');
    if (s.spectating) {
      this.setCenter(`<div class="spec-label">관전 중</div><div class="spec-name">${escapeHtml(s.spectating)}</div><div class="spec-hint">클릭으로 대상 변경</div>`);
    }
  }

  private buildAbilities(list: HudAbility[]): void {
    const E = this.els;
    clear(E.abilities);
    this.abilityEls = [];
    const keys = [BINDINGS.ability1[0], BINDINGS.ability2[0], BINDINGS.ability3[0]];
    list.forEach((a, i) => {
      const tr = TIERS[a.tier];
      const def = ABILITIES[a.id];
      const icon = h('div', { class: 'ab-icon', html: ABILITY_ICONS[a.id] });
      const charges = h('div', { class: 'ab-charges' });
      const cd = h('div', { class: 'ab-cd' });
      const keyEl = h('div', { class: 'ab-key' }, KEY_LABEL[keys[i]] ?? keys[i]);
      const active = h('div', { class: 'ab-active' });
      const tierEl = h('div', { class: 'ab-tier' }, tr.roman);
      const root = h('div', { class: `ability tier-${a.tier}`, style: `--rc:${tr.color}`, title: `${def.name} ${tr.roman} · ${def.tiers[a.tier].title}\n${def.describe(a.tier)}` }, cd, icon, keyEl, tierEl, charges, active, h('div', { class: 'ab-name' }, def.tiers[a.tier].title));
      E.abilities.append(root);
      this.abilityEls.push({ root, icon, charges, cd, key: keyEl, active });
    });
  }

  setRangeMode(on: boolean): void {
    toggleClass(this.root, 'range', on);
    toggleClass(this.els.range, 'hidden', !on);
  }

  setRangeStats(rows: [string, string][]): void {
    const html = `<div class="rp-title">사격장 기록</div>${rows.map(([k, v]) => `<div class="rp-row"><span>${escapeHtml(k)}</span><b>${escapeHtml(v)}</b></div>`).join('')}`;
    if (this.els.range.innerHTML !== html) this.els.range.innerHTML = html;
  }

  /** Damage dealt, floating up from the screen point that was hit. */
  damageNumber(x: number, y: number, amount: number, zone: string): void {
    const el = h('div', { class: `dmg-num z-${zone}`, style: `left:${Math.round(x)}px; top:${Math.round(y)}px; --dx:${Math.round((Math.random() - 0.5) * 40)}px` }, String(amount));
    this.root.append(el);
    window.setTimeout(() => el.remove(), 950);
  }

  setCenter(html: string | null): void {
    const E = this.els;
    if (html === null) {
      E.center.classList.add('hidden');
      return;
    }
    E.center.classList.remove('hidden');
    if (E.center.innerHTML !== html) E.center.innerHTML = html;
  }

  /** `limb` = arm/leg hit (reduced damage), drawn dimmer. */
  hitmarker(head: boolean, kill: boolean, limb = false): void {
    const E = this.els;
    E.hit.className = `hitmarker show ${head ? 'head' : ''} ${kill ? 'kill' : ''} ${limb && !kill ? 'limb' : ''}`;
    void E.hit.offsetWidth;
    this.hitTimer = kill ? 0.45 : 0.2;
  }

  damageFrom(angle: number, amount: number): void {
    const el = h('div', { class: 'dmg-ind', style: `transform: rotate(${angle}rad); --a:${Math.min(1, 0.4 + amount / 60)}` }, h('i'));
    this.dmgLayer.append(el);
    window.setTimeout(() => el.remove(), 1300);
  }

  killfeedAdd(killer: { name: string; team: TeamId; self: boolean } | null, victim: { name: string; team: TeamId; self: boolean }, weaponIcon: string, head: boolean, assister: string | null): void {
    const row = h(
      'div',
      { class: `kf-row ${killer?.self || victim.self ? 'mine' : ''}` },
      killer ? h('span', { class: `kf-name team${killer.team}` }, killer.name) : null,
      assister ? h('span', { class: 'kf-assist' }, `+ ${assister}`) : null,
      h('span', { class: 'kf-weapon', html: weaponIcon }),
      head ? h('span', { class: 'kf-head', html: ICONS.head }) : null,
      h('span', { class: `kf-name team${victim.team}` }, victim.name),
    );
    this.killfeed.prepend(row);
    while (this.killfeed.children.length > 6) this.killfeed.lastElementChild?.remove();
    window.setTimeout(() => row.classList.add('fade'), 6500);
    window.setTimeout(() => row.remove(), 7200);
  }

  banner(title: string, sub: string, tone: 'win' | 'lose' | 'neutral' | 'team0' | 'team1' = 'neutral', duration = 2.6): void {
    const E = this.els;
    setText(E.bannerTitle, title);
    setText(E.bannerSub, sub);
    E.banner.className = `banner show ${tone}`;
    window.clearTimeout(Number(E.banner.dataset.timer ?? 0));
    E.banner.dataset.timer = String(window.setTimeout(() => (E.banner.className = `banner hidden ${tone}`), duration * 1000));
  }

  toast(text: string, kind: 'info' | 'warn' | 'good' = 'info', seconds = 2.4): void {
    const E = this.els;
    E.toast.className = `toast show ${kind}`;
    setText(E.toast, text);
    this.toastTimer = seconds;
  }

  /** Expanding sonar ring across the screen (recon pulse). */
  pulse(color: string): void {
    const el = h('div', { class: 'hud-pulse', style: `--pc:${color}` });
    this.root.append(el);
    window.setTimeout(() => el.remove(), 1300);
  }

  goldPop(amount: number, reason: string): void {
    const el = h('div', { class: 'gold-pop', style: `bottom:${this.els.goldPops.children.length * 24}px` }, `+${amount}`, h('span', {}, reason));
    this.els.goldPops.append(el);
    window.setTimeout(() => el.remove(), 2200);
  }

  setTags(tags: NameTag[]): void {
    const seen = new Set<string>();
    for (const t of tags) {
      seen.add(t.id);
      let el = this.tags.get(t.id);
      if (!el) {
        el = h('div', { class: 'name-tag' }, h('div', { class: 'nt-name' }), h('div', { class: 'nt-hp' }, h('i')));
        this.tagLayer.append(el);
        this.tags.set(t.id, el);
      }
      el.className = `name-tag ${t.enemy ? 'enemy' : `team${t.team}`}`;
      setStyle(el, 'transform', `translate(${Math.round(t.x)}px, ${Math.round(t.y)}px) translate(-50%, -100%) scale(${Math.max(0.65, Math.min(1, 14 / Math.max(1, t.dist)))})`);
      setText(el.firstElementChild as HTMLElement, t.name);
      setStyle((el.lastElementChild as HTMLElement).firstElementChild as HTMLElement, 'width', `${Math.max(0, t.hp)}%`);
    }
    for (const [id, el] of this.tags) {
      if (!seen.has(id)) {
        el.remove();
        this.tags.delete(id);
      }
    }
  }
}

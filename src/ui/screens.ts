import { h, clear, setText } from './dom';
import { ABILITY_ICONS, ICONS } from './icons';
import { RARITIES, ABILITIES } from '../game/abilities';
import { TEAMS, type TeamId } from '../core/config';
import type { PlayerInfo } from '../net/protocol';
import { escapeHtml } from '../core/utils';

export class LoadingScreen {
  readonly root: HTMLElement;
  private bar: HTMLElement;
  private label: HTMLElement;

  constructor(parent: HTMLElement) {
    this.bar = h('div', { class: 'load-fill' });
    this.label = h('div', { class: 'load-label' }, '초기화 중…');
    this.root = h(
      'div',
      { id: 'loading', class: 'screen' },
      h('div', { class: 'load-logo' }, h('div', { class: 'logo-mark' }), h('div', { class: 'logo-text' }, 'DUSK', h('span', {}, 'PROTOCOL'))),
      h('div', { class: 'load-bar' }, this.bar),
      this.label,
      h('div', { class: 'load-tip' }, '팁 · 같은 능력을 두 번 고르면 희귀도가 한 단계 진화합니다.'),
    );
    parent.append(this.root);
  }

  set(progress: number, label: string): void {
    this.bar.style.width = `${Math.round(progress * 100)}%`;
    setText(this.label, label);
  }

  hide(): void {
    this.root.classList.add('fade-out');
    window.setTimeout(() => this.root.remove(), 700);
  }
}

export class Scoreboard {
  readonly root: HTMLElement;
  private body: HTMLElement;
  private head: HTMLElement;

  constructor(parent: HTMLElement) {
    this.head = h('div', { class: 'sb-head' });
    this.body = h('div', { class: 'sb-body' });
    this.root = h('div', { id: 'scoreboard', class: 'hidden' }, h('div', { class: 'sb-panel' }, this.head, this.body));
    parent.append(this.root);
  }

  show(on: boolean): void {
    this.root.classList.toggle('hidden', !on);
  }

  private lastKey = '';

  update(list: PlayerInfo[], myId: string, scores: [number, number], round: number, mapName: string): void {
    // Rebuild only when something visible changed (called every frame while TAB is held).
    const key = JSON.stringify([list, scores, round]);
    if (key === this.lastKey) return;
    this.lastKey = key;
    clear(this.head);
    this.head.append(
      h('div', { class: 'sb-team team0' }, TEAMS[0].name, h('b', {}, String(scores[0]))),
      h('div', { class: 'sb-meta' }, h('div', {}, mapName), h('div', { class: 'sb-round' }, `ROUND ${round}`)),
      h('div', { class: 'sb-team team1' }, h('b', {}, String(scores[1])), TEAMS[1].name),
    );
    clear(this.body);
    for (const t of [0, 1] as TeamId[]) {
      const rows = list.filter((p) => p.team === t).sort((a, b) => b.kills - a.kills || b.damage - a.damage);
      this.body.append(
        h(
          'div',
          { class: `sb-table team${t}` },
          h('div', { class: 'sb-row sb-cols' }, h('span', {}, '플레이어'), h('span', {}, 'K'), h('span', {}, 'D'), h('span', {}, 'A'), h('span', {}, '피해'), h('span', {}, '골드'), h('span', {}, '능력'), h('span', {}, '핑')),
          ...rows.map((p) =>
            h(
              'div',
              { class: `sb-row ${p.id === myId ? 'me' : ''} ${p.alive ? '' : 'dead'}` },
              h('span', { class: 'sb-name' }, p.bot ? h('i', { class: 'tag-bot', html: ICONS.bot }) : null, p.name),
              h('span', {}, String(p.kills)),
              h('span', {}, String(p.deaths)),
              h('span', {}, String(p.assists)),
              h('span', {}, String(p.damage)),
              h('span', { class: 'sb-gold' }, p.gold.toLocaleString()),
              h('span', { class: 'sb-abs' }, ...p.abilities.map((a) => h('i', { class: 'sb-ab', style: `--rc:${RARITIES[a.rarity].color}`, title: `${ABILITIES[a.id].name} (${RARITIES[a.rarity].name})`, html: ABILITY_ICONS[a.id] }))),
              h('span', { class: 'sb-ping' }, p.bot ? 'BOT' : `${p.ping}`),
            ),
          ),
        ),
      );
    }
  }
}

export class ResultsView {
  readonly root: HTMLElement;
  private panel: HTMLElement;

  constructor(parent: HTMLElement) {
    this.panel = h('div', { class: 'results-panel' });
    this.root = h('div', { id: 'results', class: 'screen hidden' }, this.panel);
    parent.append(this.root);
  }

  show(winner: TeamId, myTeam: TeamId, scores: [number, number], list: PlayerInfo[], myId: string, secondsLeft: number): void {
    const won = winner === myTeam;
    clear(this.panel);
    const mvp = [...list].sort((a, b) => b.kills * 100 + b.damage - (a.kills * 100 + a.damage))[0];
    this.panel.append(
      h('div', { class: `res-kicker ${won ? 'win' : 'lose'}` }, won ? 'VICTORY' : 'DEFEAT'),
      h('div', { class: 'res-title' }, won ? '승리' : '패배'),
      h('div', { class: 'res-score' }, h('span', { class: 'team0' }, String(scores[0])), h('em', {}, ':'), h('span', { class: 'team1' }, String(scores[1]))),
      h('div', { class: 'res-winner', style: `color:${TEAMS[winner].css}` }, `${TEAMS[winner].name} 팀 승리`),
      mvp ? h('div', { class: 'res-mvp' }, h('span', {}, 'MVP'), h('b', {}, mvp.name), h('em', {}, `${mvp.kills}킬 · ${mvp.damage} 피해`)) : '',
      h(
        'div',
        { class: 'res-table' },
        ...list
          .sort((a, b) => a.team - b.team || b.kills - a.kills)
          .map((p) => h('div', { class: `res-row team${p.team} ${p.id === myId ? 'me' : ''}` }, h('span', {}, p.name), h('span', {}, `${p.kills} / ${p.deaths} / ${p.assists}`), h('span', {}, `${p.damage} 피해`))),
      ),
      h('div', { class: 'res-foot' }, `${Math.ceil(secondsLeft)}초 후 로비로 돌아갑니다`),
    );
    this.root.classList.remove('hidden');
  }

  hide(): void {
    this.root.classList.add('hidden');
  }
}

export class PauseMenu {
  readonly root: HTMLElement;

  constructor(parent: HTMLElement, onResume: () => void, onSettings: () => void, onControls: () => void, onLeave: () => void, private hostEnd: (() => void) | null = null) {
    this.root = h(
      'div',
      { id: 'pause', class: 'screen hidden' },
      h(
        'div',
        { class: 'pause-panel' },
        h('div', { class: 'pause-title' }, '일시정지'),
        h('div', { class: 'pause-sub' }, '온라인 경기는 계속 진행됩니다'),
        h('button', { class: 'btn primary', onclick: onResume }, '게임으로 돌아가기'),
        h('button', { class: 'btn', onclick: onSettings }, '설정'),
        h('button', { class: 'btn', onclick: onControls }, '조작법'),
        h(
          'button',
          {
            class: 'btn',
            onclick: () => {
              if (document.fullscreenElement) void document.exitFullscreen();
              else void document.documentElement.requestFullscreen?.().catch(() => undefined);
            },
          },
          '전체 화면 전환',
        ),
        (this.hostEndBtn = h('button', { class: 'btn', onclick: () => this.hostEnd?.() }, '경기 종료 (로비로)')),
        h('button', { class: 'btn danger', onclick: onLeave }, '나가기'),
      ),
    );
    parent.append(this.root);
  }

  private hostEndBtn: HTMLElement;

  setHostEnd(fn: (() => void) | null): void {
    this.hostEnd = fn;
    this.hostEndBtn.classList.toggle('hidden', !fn);
  }

  show(on: boolean): void {
    this.root.classList.toggle('hidden', !on);
  }

  get visible(): boolean {
    return !this.root.classList.contains('hidden');
  }
}

export class ChatBox {
  readonly root: HTMLElement;
  private log: HTMLElement;
  private input: HTMLInputElement;
  open = false;

  constructor(parent: HTMLElement, private onSend: (text: string) => void, private onClose: () => void) {
    this.log = h('div', { class: 'chat-log' });
    this.input = h('input', { class: 'chat-input hidden', maxlength: 120, placeholder: '메시지 입력 후 Enter' });
    this.input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        const t = this.input.value.trim();
        if (t) this.onSend(t);
        this.close();
      } else if (e.key === 'Escape') this.close();
    });
    this.root = h('div', { id: 'chat' }, this.log, this.input);
    parent.append(this.root);
  }

  openInput(): void {
    this.open = true;
    this.input.classList.remove('hidden');
    this.root.classList.add('active');
    this.input.value = '';
    window.setTimeout(() => this.input.focus(), 0);
  }

  close(): void {
    this.open = false;
    this.input.blur();
    this.input.classList.add('hidden');
    this.root.classList.remove('active');
    this.onClose();
  }

  add(name: string, text: string, team: TeamId | null, system = false): void {
    const row = h('div', { class: `chat-row ${system ? 'system' : ''}` });
    row.innerHTML = system ? `<span class="chat-sys">▸ ${escapeHtml(text)}</span>` : `<b class="team${team ?? 0}">${escapeHtml(name)}</b> ${escapeHtml(text)}`;
    this.log.append(row);
    while (this.log.children.length > 8) this.log.firstElementChild?.remove();
    window.setTimeout(() => row.classList.add('old'), 9000);
  }

  setVisible(on: boolean): void {
    this.root.classList.toggle('hidden', !on);
  }
}

/** Generic modal container used by menus and dialogs. */
export class Modal {
  readonly root: HTMLElement;
  private body: HTMLElement;
  private titleEl: HTMLElement;

  constructor(parent: HTMLElement) {
    this.titleEl = h('div', { class: 'modal-title' });
    this.body = h('div', { class: 'modal-body' });
    this.root = h(
      'div',
      { class: 'modal-wrap hidden' },
      h('div', { class: 'modal' }, h('div', { class: 'modal-head' }, this.titleEl, h('button', { class: 'icon-btn', onclick: () => this.close(), html: ICONS.close })), this.body),
    );
    this.root.addEventListener('mousedown', (e) => {
      if (e.target === this.root) this.close();
    });
    parent.append(this.root);
  }

  onClose: (() => void) | null = null;

  open(title: string, content: HTMLElement): void {
    setText(this.titleEl, title);
    clear(this.body);
    this.body.append(content);
    this.root.classList.remove('hidden');
  }

  close(): void {
    if (this.root.classList.contains('hidden')) return;
    this.root.classList.add('hidden');
    this.onClose?.();
  }

  get visible(): boolean {
    return !this.root.classList.contains('hidden');
  }
}

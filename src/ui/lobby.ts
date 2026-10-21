import { h, clear, setText } from './dom';
import { ICONS } from './icons';
import { TEAMS, type TeamId } from '../core/config';
import type { LobbyPlayer, MatchSettings } from '../net/protocol';
import type { AudioEngine } from '../audio/audio';

export interface LobbyActions {
  setTeam(t: TeamId): void;
  setSettings(s: MatchSettings): void;
  addBot(t: TeamId): void;
  kickBot(id: string): void;
  start(): void;
  leave(): void;
}

export class LobbyView {
  readonly root: HTMLElement;
  private codeEl: HTMLElement;
  private teamsEl: HTMLElement;
  private settingsEl: HTMLElement;
  private startBtn: HTMLButtonElement;
  private noteEl: HTMLElement;
  private code = '';

  constructor(
    parent: HTMLElement,
    private audio: AudioEngine,
    private actions: LobbyActions,
  ) {
    this.codeEl = h('div', { class: 'room-code' });
    this.teamsEl = h('div', { class: 'lobby-teams' });
    this.settingsEl = h('div', { class: 'lobby-settings' });
    this.noteEl = h('div', { class: 'lobby-note' });
    this.startBtn = h('button', { class: 'btn primary big', onclick: () => this.actions.start() }, '게임 시작');
    const copy = (text: string, label: string): void => {
      void navigator.clipboard?.writeText(text).then(
        () => this.flash(label),
        () => this.flash('복사 실패 — 직접 선택해 복사하세요'),
      );
    };
    this.root = h(
      'div',
      { id: 'lobby', class: 'screen hidden' },
      h(
        'div',
        { class: 'lobby-panel' },
        h(
          'div',
          { class: 'lobby-head' },
          h('div', {}, h('div', { class: 'lobby-kicker' }, 'MATCH LOBBY'), h('div', { class: 'lobby-title' }, '대기실')),
          h(
            'div',
            { class: 'room-box' },
            h('div', { class: 'room-label' }, '방 코드'),
            this.codeEl,
            h(
              'div',
              { class: 'room-actions' },
              h('button', { class: 'chip-btn', onclick: () => copy(this.code, '방 코드를 복사했습니다'), html: `${ICONS.copy}<span>코드 복사</span>` }),
              h('button', { class: 'chip-btn', onclick: () => copy(this.inviteUrl(), '초대 링크를 복사했습니다'), html: `${ICONS.link}<span>초대 링크</span>` }),
            ),
          ),
        ),
        this.teamsEl,
        this.settingsEl,
        h('div', { class: 'lobby-foot' }, h('button', { class: 'btn ghost', onclick: () => this.actions.leave(), html: `${ICONS.exit}<span>나가기</span>` }), this.noteEl, this.startBtn),
      ),
    );
    parent.append(this.root);
  }

  private inviteUrl(): string {
    const u = new URL(location.href);
    u.search = '';
    u.hash = '';
    u.searchParams.set('room', this.code);
    return u.toString();
  }

  private flash(text: string): void {
    setText(this.noteEl, text);
    this.noteEl.classList.add('flash');
    window.setTimeout(() => this.noteEl.classList.remove('flash'), 1600);
  }

  show(on: boolean): void {
    this.root.classList.toggle('hidden', !on);
  }

  render(code: string, players: LobbyPlayer[], s: MatchSettings, selfId: string, hostId: string, offline: boolean): void {
    this.code = code;
    setText(this.codeEl, offline ? 'OFFLINE' : code);
    this.root.classList.toggle('offline', offline);
    const isHost = selfId === hostId;
    const size = s.mode === '1v1' ? 1 : 2;
    clear(this.teamsEl);
    for (const t of [0, 1] as TeamId[]) {
      const members = players.filter((p) => p.team === t);
      const slots: HTMLElement[] = members.map((p) =>
        h(
          'div',
          { class: `slot filled ${p.id === selfId ? 'me' : ''}` },
          h('div', { class: 'slot-avatar' }, p.bot ? h('span', { html: ICONS.bot }) : (p.name[0] ?? '?').toUpperCase()),
          h('div', { class: 'slot-name' }, p.name, p.id === hostId ? h('span', { class: 'crown', html: ICONS.crown, title: '호스트' }) : null),
          h('div', { class: 'slot-tags' }, p.id === selfId ? h('span', { class: 'tag' }, 'YOU') : null, p.bot ? h('span', { class: 'tag bot' }, 'BOT') : null),
          isHost && p.bot ? h('button', { class: 'icon-btn small', title: '봇 제거', onclick: () => this.actions.kickBot(p.id), html: ICONS.close }) : null,
        ),
      );
      for (let i = members.length; i < size; i++) {
        slots.push(
          h(
            'div',
            { class: 'slot empty' },
            h('div', { class: 'slot-name' }, s.botFill ? '빈 자리 · 시작 시 봇으로 채움' : '빈 자리'),
            isHost ? h('button', { class: 'chip-btn', onclick: () => this.actions.addBot(t), html: `${ICONS.plus}<span>봇 추가</span>` }) : null,
          ),
        );
      }
      const me = players.find((p) => p.id === selfId);
      this.teamsEl.append(
        h(
          'div',
          { class: `team-col team${t}` },
          h('div', { class: 'team-head' }, h('span', { class: 'team-dot' }), h('b', {}, TEAMS[t].name), h('em', {}, `${members.length}/${size}`)),
          ...slots,
          me && me.team !== t ? h('button', { class: 'btn ghost small', onclick: () => this.actions.setTeam(t), html: `${ICONS.swap}<span>이 팀으로 이동</span>` }) : null,
        ),
      );
    }
    clear(this.settingsEl);
    const seg = <T extends string | number | boolean>(label: string, options: [T, string][], value: T, apply: (v: T) => MatchSettings): HTMLElement => {
      const g = h('div', { class: `seg ${isHost ? '' : 'disabled'}` });
      for (const [v, l] of options) {
        g.append(
          h(
            'button',
            {
              class: value === v ? 'on' : '',
              onclick: () => {
                if (!isHost) return;
                this.audio.uiClick();
                this.actions.setSettings(apply(v));
              },
            },
            l,
          ),
        );
      }
      return h('div', { class: 'seg-row' }, h('label', {}, label), g);
    };
    this.settingsEl.append(
      seg<'1v1' | '2v2'>('모드', [['1v1', '1 vs 1'], ['2v2', '2 vs 2']], s.mode, (v) => ({ ...s, mode: v })),
      seg<number>('세트', [[3, '5판 3선승'], [4, '7판 4선승'], [5, '9판 5선승']], s.firstTo, (v) => ({ ...s, firstTo: v })),
      seg<boolean>('빈 자리', [[true, '봇으로 채우기'], [false, '비워두기']], s.botFill, (v) => ({ ...s, botFill: v })),
      seg<number>('봇 난이도', [[0, '쉬움'], [1, '보통'], [2, '어려움']], s.botSkill, (v) => ({ ...s, botSkill: v as 0 | 1 | 2 })),
    );
    this.startBtn.classList.toggle('hidden', !isHost);
    if (!isHost) setText(this.noteEl, '호스트가 게임을 시작하기를 기다리는 중…');
    else if (!offline) setText(this.noteEl, '친구에게 방 코드나 초대 링크를 보내세요');
    else setText(this.noteEl, '');
  }
}

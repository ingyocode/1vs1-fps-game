import { h, setText } from './dom';
import { ICONS } from './icons';
import { settings, type Quality } from '../core/settings';
import { GAME_SUBTITLE } from '../core/config';
import type { AudioEngine } from '../audio/audio';
import type { Modal } from './screens';
import type { MatchSettings } from '../net/protocol';

export interface MenuActions {
  host(): void;
  join(code: string): void;
  practice(s: MatchSettings): void;
  /** Offline shooting range: aim training with every weapon. */
  range(): void;
}

export class MainMenu {
  readonly root: HTMLElement;
  private status: HTMLElement;
  private nameInput: HTMLInputElement;

  constructor(
    parent: HTMLElement,
    private modal: Modal,
    private audio: AudioEngine,
    private actions: MenuActions,
  ) {
    this.nameInput = h('input', { class: 'name-input', maxlength: 16, value: settings.value.playerName, spellcheck: 'false' });
    this.nameInput.addEventListener('change', () => settings.set('playerName', this.nameInput.value.trim().slice(0, 16) || settings.value.playerName));
    this.status = h('div', { class: 'menu-status' });
    const btn = (label: string, sub: string, icon: string, onClick: () => void, primary = false): HTMLElement =>
      h(
        'button',
        {
          class: `menu-btn ${primary ? 'primary' : ''}`,
          onclick: () => {
            this.audio.uiClick();
            onClick();
          },
          onmouseenter: () => this.audio.uiHover(),
        },
        h('span', { class: 'mb-icon', html: icon }),
        h('span', { class: 'mb-text' }, h('b', {}, label), h('em', {}, sub)),
        h('span', { class: 'mb-arrow' }, '›'),
      );
    this.root = h(
      'div',
      { id: 'menu', class: 'screen hidden' },
      h('div', { class: 'menu-vignette' }),
      h(
        'div',
        { class: 'menu-left' },
        h('div', { class: 'menu-logo' }, h('div', { class: 'logo-mark big' }), h('div', { class: 'logo-text big' }, 'DUSK', h('span', {}, 'PROTOCOL'))),
        h('div', { class: 'menu-tag' }, `${GAME_SUBTITLE} · 능력 드래프트 택티컬 FPS`),
        h('div', { class: 'menu-name' }, h('label', {}, '콜사인'), this.nameInput),
        h(
          'div',
          { class: 'menu-buttons' },
          btn('방 만들기', '친구를 초대해 1v1 / 2v2', ICONS.users, () => this.actions.host(), true),
          btn('방 참가', '초대 코드로 입장', ICONS.login, () => this.openJoin()),
          btn('봇과 연습', '오프라인 · 즉시 시작', ICONS.bot, () => this.openPractice()),
          btn('사격장', '에임 연습 · 모든 총기 무료', ICONS.target, () => {
            this.commitName();
            this.actions.range();
          }),
          btn('설정', '감도 · 화질 · 사운드', ICONS.gear, () => this.openSettings()),
          btn('조작법', '키 배치 안내', ICONS.keyboard, () => this.openControls()),
        ),
        this.status,
      ),
      h(
        'div',
        { class: 'menu-foot' },
        h('span', {}, 'WebRTC P2P · 서버 비용 0원'),
        h('span', {}, '·'),
        h('span', {}, 'Map: Harbor District'),
      ),
    );
    parent.append(this.root);
    if (window.matchMedia?.('(pointer: coarse)').matches && !window.matchMedia('(pointer: fine)').matches) {
      this.setStatus('이 게임은 키보드와 마우스가 있는 데스크톱 브라우저용입니다.', true);
    }
  }

  show(on: boolean): void {
    this.root.classList.toggle('hidden', !on);
    if (on) this.nameInput.value = settings.value.playerName;
  }

  setStatus(text: string, error = false): void {
    this.status.className = `menu-status ${error ? 'error' : ''}`;
    setText(this.status, text);
  }

  commitName(): void {
    const v = this.nameInput.value.trim().slice(0, 16);
    if (v) settings.set('playerName', v);
  }

  openJoin(prefill = ''): void {
    this.commitName();
    const input = h('input', { class: 'code-input', maxlength: 5, placeholder: 'ABCDE', value: prefill, spellcheck: 'false', autocomplete: 'off' });
    input.addEventListener('input', () => (input.value = input.value.toUpperCase().replace(/[^A-Z0-9]/g, '')));
    const go = (): void => {
      if (input.value.length < 4) return;
      this.modal.close();
      this.actions.join(input.value);
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') go();
    });
    this.modal.open(
      '방 참가',
      h('div', { class: 'dialog' }, h('p', { class: 'dialog-text' }, '호스트에게 받은 5자리 방 코드를 입력하세요.'), input, h('button', { class: 'btn primary wide', onclick: go }, '참가하기')),
    );
    window.setTimeout(() => input.focus(), 50);
  }

  openPractice(): void {
    this.commitName();
    const st: MatchSettings = { mode: '1v1', firstTo: 4, botFill: true, botSkill: 1 };
    const seg = <T extends string | number>(label: string, options: [T, string][], get: () => T, set: (v: T) => void): HTMLElement => {
      const row = h('div', { class: 'seg-row' }, h('label', {}, label));
      const group = h('div', { class: 'seg' });
      const render = (): void => {
        group.innerHTML = '';
        for (const [v, l] of options) {
          group.append(
            h(
              'button',
              {
                class: get() === v ? 'on' : '',
                onclick: () => {
                  set(v);
                  this.audio.uiClick();
                  render();
                },
              },
              l,
            ),
          );
        }
      };
      render();
      row.append(group);
      return row;
    };
    this.modal.open(
      '봇과 연습',
      h(
        'div',
        { class: 'dialog' },
        seg<'1v1' | '2v2'>('모드', [['1v1', '1 vs 1'], ['2v2', '2 vs 2']], () => st.mode, (v) => (st.mode = v)),
        seg<number>('승리 조건', [[3, '3선승'], [4, '4선승'], [5, '5선승']], () => st.firstTo, (v) => (st.firstTo = v)),
        seg<number>('봇 난이도', [[0, '쉬움'], [1, '보통'], [2, '어려움']], () => st.botSkill, (v) => (st.botSkill = v as 0 | 1 | 2)),
        h(
          'button',
          {
            class: 'btn primary wide',
            onclick: () => {
              this.modal.close();
              this.actions.practice({ ...st });
            },
          },
          '연습 시작',
        ),
      ),
    );
  }

  openSettings(): void {
    this.modal.open('설정', settingsPanel(this.audio));
  }

  openControls(): void {
    this.modal.open('조작법', controlsPanel());
  }
}

export function settingsPanel(audio: AudioEngine): HTMLElement {
  const s = settings.value;
  const slider = (label: string, key: 'sensitivity' | 'adsSensitivity' | 'fov' | 'masterVolume' | 'renderScale' | 'crosshairGap', min: number, max: number, step: number, fmt: (v: number) => string): HTMLElement => {
    const val = h('b', {}, fmt(s[key]));
    const input = h('input', { type: 'range', min, max, step, value: s[key] });
    input.addEventListener('input', () => {
      const v = Number(input.value);
      settings.set(key, v);
      setText(val, fmt(v));
    });
    return h('div', { class: 'set-row' }, h('label', {}, label), input, val);
  };
  const toggle = (label: string, key: 'showFps' | 'invertY' | 'adsToggle' | 'crosshairDynamic'): HTMLElement => {
    const b = h('button', { class: `toggle ${s[key] ? 'on' : ''}` }, h('i'));
    b.addEventListener('click', () => {
      settings.set(key, !settings.value[key]);
      b.classList.toggle('on', settings.value[key]);
      audio.uiClick();
    });
    return h('div', { class: 'set-row' }, h('label', {}, label), b);
  };
  const quality = h('div', { class: 'seg' });
  const renderQ = (): void => {
    quality.innerHTML = '';
    for (const [q, l] of [
      ['low', '낮음'],
      ['medium', '중간'],
      ['high', '높음'],
      ['ultra', '최고'],
    ] as [Quality, string][]) {
      quality.append(
        h(
          'button',
          {
            class: settings.value.quality === q ? 'on' : '',
            onclick: () => {
              settings.set('quality', q);
              audio.uiClick();
              renderQ();
            },
          },
          l,
        ),
      );
    }
  };
  renderQ();
  const color = h('input', { type: 'color', value: s.crosshairColor });
  color.addEventListener('input', () => settings.set('crosshairColor', color.value));
  const ice = h('textarea', { class: 'ice-input', rows: 3, placeholder: 'turn:turn.example.com:3478|username|password' });
  ice.value = s.iceServers;
  ice.addEventListener('change', () => settings.set('iceServers', ice.value));
  ice.addEventListener('keydown', (e) => e.stopPropagation());
  return h(
    'div',
    { class: 'settings' },
    h('div', { class: 'set-group' }, '조작'),
    slider('마우스 감도', 'sensitivity', 0.1, 4, 0.01, (v) => v.toFixed(2)),
    slider('조준 시 감도 배율', 'adsSensitivity', 0.3, 1.5, 0.01, (v) => v.toFixed(2)),
    toggle('상하 반전', 'invertY'),
    toggle('조준 토글 (끄면 누르고 있기)', 'adsToggle'),
    h('div', { class: 'set-group' }, '화면'),
    slider('시야각 (수평 FOV)', 'fov', 80, 120, 1, (v) => `${v}°`),
    h('div', { class: 'set-row' }, h('label', {}, '그래픽 품질'), quality),
    slider('렌더 스케일', 'renderScale', 0.5, 1, 0.05, (v) => `${Math.round(v * 100)}%`),
    toggle('FPS / 핑 표시', 'showFps'),
    h('div', { class: 'set-row' }, h('label', {}, '조준선 색상'), color),
    slider('조준선 간격', 'crosshairGap', 0, 12, 1, (v) => `${v}px`),
    toggle('동적 조준선 (탄 퍼짐 표시)', 'crosshairDynamic'),
    h('div', { class: 'set-group' }, '사운드'),
    slider('마스터 볼륨', 'masterVolume', 0, 1, 0.01, (v) => `${Math.round(v * 100)}%`),
    h('div', { class: 'set-group' }, '네트워크 (고급)'),
    h('p', { class: 'dialog-text small' }, '대칭형 NAT 등으로 P2P 연결이 실패하면 직접 운영하는 TURN 서버를 한 줄에 하나씩 입력할 수 있습니다. (기본값: 무료 공개 STUN만 사용)'),
    ice,
    h(
      'button',
      {
        class: 'btn ghost',
        onclick: () => {
          settings.reset();
          audio.uiClick();
        },
      },
      '기본값으로 초기화',
    ),
  );
}

export function controlsPanel(): HTMLElement {
  const rows: [string, string][] = [
    ['W A S D', '이동'],
    ['SPACE', '점프'],
    ['C', '앉기 (공중에서 앉기 점프)'],
    ['SHIFT', '걷기 (발소리 없음)'],
    ['마우스 좌클릭', '사격 / 나이프 베기'],
    ['마우스 우클릭', '정조준 / 저격 스코프 / 나이프 찌르기'],
    ['R', '재장전'],
    ['Y', '무기 살펴보기'],
    ['1 · 2 · 3 · 휠 · X', '주무기 · 보조무기 · 나이프 · 순환 · 이전 무기'],
    ['Q · E · F', '능력 슬롯 1 · 2 · 3'],
    ['B', '상점 (구매 단계)'],
    ['TAB', '점수판'],
    ['ENTER', '채팅'],
    ['ESC', '일시정지 / 메뉴'],
  ];
  return h(
    'div',
    { class: 'controls' },
    ...rows.map(([k, d]) => h('div', { class: 'ctl-row' }, h('span', { class: 'kbd' }, k), h('span', {}, d))),
    h(
      'div',
      { class: 'ctl-note' },
      '라운드는 상대 팀 전원을 처치하면 즉시 종료됩니다. 맵의 골드 코인, 처치·어시스트·라운드 결과로 골드를 모아 구매 단계에 무기·방어구를 구매하세요. 능력은 골드로 강화할 수 없고, 라운드를 2번 질 때마다 증강을 한 장 더 고릅니다. 헤드샷은 큰 추가 피해를, 팔·다리는 줄어든 피해를 줍니다.',
    ),
  );
}

import './styles/main.css';
import { GameRenderer } from './render/renderer';
import { cinematicCamera } from './render/cinematic';
import { createEnvironment, type Environment } from './render/environment';
import { createMaterials } from './render/materials';
import { buildMap, type GameMap } from './world/map';
import { Input } from './core/input';
import { settings } from './core/settings';
import { AudioEngine } from './audio/audio';
import { UI } from './ui/ui';
import { Net } from './net/network';
import { MatchHost } from './game/host';
import { GameClient } from './game/client';
import { warmupShaders } from './game/warmup';
import type { MatchSettings } from './net/protocol';
import type { TeamId } from './core/config';

class App {
  private renderer!: GameRenderer;
  private env!: Environment;
  private map!: GameMap;
  private audio = new AudioEngine();
  private input!: Input;
  private ui!: UI;
  private session: GameClient | null = null;
  private busy = false;
  private last = performance.now();
  private time = 0;
  private menuT = 0;
  private unlockedAt = 0;
  private pausedAt = 0;

  async boot(): Promise<void> {
    const viewport = document.getElementById('viewport')!;
    const uiRoot = document.getElementById('ui')!;
    this.renderer = new GameRenderer(viewport);
    this.input = new Input(this.renderer.canvas);
    this.ui = new UI(uiRoot, this.audio, {
      menu: {
        host: () => void this.hostGame(),
        join: (code) => void this.joinGame(code),
        practice: (s) => this.practice(s),
        range: () => this.range(),
      },
      lobby: {
        setTeam: (t: TeamId) => this.session?.net.toHost({ t: 'setTeam', team: t }),
        setSettings: (s: MatchSettings) => this.session?.net.toHost({ t: 'settings', settings: s }),
        addBot: (t: TeamId) => this.session?.net.toHost({ t: 'addBot', team: t }),
        kickBot: (id: string) => this.session?.net.toHost({ t: 'kickBot', id }),
        start: () => this.session?.net.toHost({ t: 'start' }),
        leave: () => this.leave(),
      },
      draftPick: (i) => this.session?.draftPick(i),
      buy: (item) => this.session?.buy(item),
      closeShop: () => {
        this.session?.toggleShop();
        this.input.requestLock();
      },
      sendChat: (t) => this.session?.sendChat(t),
      chatClosed: () => {
        if (this.session && this.inGamePhase()) this.input.requestLock();
      },
      resume: () => this.resume(),
      leave: () => this.leave(),
      endMatch: () => {
        this.session?.net.toHost({ t: 'toLobby' });
        this.setPaused(false);
      },
    });

    const load = this.ui.loading;
    load.set(0.02, '렌더러 준비 중…');
    await nextFrame();
    const q = settings.value.quality;
    this.renderer.setQuality(q, settings.value.renderScale);
    this.env = createEnvironment(this.renderer.renderer, this.renderer.scene, q);
    load.set(0.06, '머티리얼 생성 중…');
    const lib = await createMaterials((p) => load.set(0.06 + p * 0.74, '텍스처 생성 중…'));
    load.set(0.84, '항구 구역 건설 중…');
    await nextFrame();
    this.map = buildMap(lib);
    this.renderer.scene.add(this.map.root);
    load.set(0.92, '셰이더 컴파일 중…');
    await nextFrame();
    this.renderer.camera.position.set(0, 14, 24);
    this.renderer.camera.lookAt(0, 2, 0);
    // Match shaders first (characters, guns, effects), then the map with its final light set.
    await warmupShaders(this.renderer);
    await this.renderer.precompile(this.renderer.scene, this.renderer.camera);
    load.set(1, '완료');
    this.ui.hud.setRadarMap(this.map.radar, this.map.bounds);

    this.applySettings();
    settings.onChange(() => this.applySettings());
    this.bindGlobalInput();
    load.hide();
    this.ui.menu.show(true);

    const room = new URLSearchParams(location.search).get('room');
    if (room) this.ui.menu.openJoin(room.toUpperCase().slice(0, 5));

    requestAnimationFrame(this.frame);
    // Network keep-alive runs on a timer so it survives rAF throttling in background tabs.
    window.setInterval(() => this.session?.net.keepAlive(), 1000);
    (window as unknown as { __ready: boolean }).__ready = true;
    (window as unknown as { __app: App }).__app = this;
  }

  private applySettings(): void {
    const s = settings.value;
    this.renderer.setQuality(s.quality, s.renderScale);
    this.env.setQuality(s.quality);
    this.audio.setVolume(s.masterVolume);
  }

  /** Any phase of a running match (draft included), i.e. something a reload would throw away. */
  private inMatch(): boolean {
    const p = this.session?.phase;
    return p === 'draft' || p === 'buy' || p === 'live' || p === 'roundEnd' || p === 'matchEnd';
  }

  private inGamePhase(): boolean {
    const p = this.session?.phase;
    return p === 'buy' || p === 'live' || p === 'roundEnd';
  }

  private bindGlobalInput(): void {
    const unlockAudio = (): void => this.audio.resume();
    window.addEventListener('pointerdown', unlockAudio);
    window.addEventListener('keydown', unlockAudio);
    this.renderer.canvas.addEventListener('click', () => {
      if (this.session && this.inGamePhase() && !this.ui.needsCursor) this.input.requestLock();
    });
    this.ui.clickPrompt.addEventListener('click', () => {
      if (this.session && this.inGamePhase() && !this.ui.needsCursor) this.input.requestLock();
    });
    this.input.onLockChange((locked) => {
      if (!locked) this.unlockedAt = performance.now();
      if (!locked && this.session && this.inGamePhase() && !this.ui.needsCursor) this.setPaused(true);
      if (locked) this.setPaused(false);
    });
    window.addEventListener('keydown', (e) => {
      if (e.code !== 'Escape') return;
      // The Escape that released pointer lock must not immediately resume.
      if (performance.now() - this.unlockedAt < 350) return;
      if (this.ui.modal.visible) {
        this.ui.modal.close();
        return;
      }
      if (this.ui.shop.open) {
        this.session?.toggleShop();
        this.input.requestLock();
        return;
      }
      if (this.ui.pause.visible) {
        this.resume();
        return;
      }
      if (this.session && this.inGamePhase() && !this.input.locked && !this.ui.chat.open) this.setPaused(true);
    });
    // Leaving mid-match (reload, closing the tab, ⌘Q) asks first instead of dropping the game;
    // the session is only torn down once the page is really going away.
    window.addEventListener('beforeunload', (e) => {
      if (!this.session || !this.inMatch() || this.session.range) return;
      e.preventDefault();
      e.returnValue = '';
    });
    window.addEventListener('pagehide', () => this.session?.dispose());
  }

  private resume(): void {
    this.setPaused(false);
    this.input.requestLock();
  }

  /** Shows/hides the pause menu. Offline practice also freezes simulation time. */
  private setPaused(on: boolean): void {
    if (this.ui.pause.visible === on) return;
    this.ui.pause.show(on);
    if (on) this.pausedAt = performance.now();
    else if (this.pausedAt > 0) {
      if (this.session?.offline) this.session.shiftTime(performance.now() - this.pausedAt);
      this.pausedAt = 0;
    }
  }

  private async hostGame(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.ui.menu.commitName();
    this.ui.menu.setStatus('방을 만드는 중…');
    try {
      const net = await Net.createHost((s) => this.ui.menu.setStatus(s));
      const host = new MatchHost(net, this.map, settings.value.playerName);
      this.startSession(net, host, false);
      host.settings = { mode: '1v1', firstTo: 4, botFill: true, botSkill: 1 };
      host.sendLobby();
      this.ui.menu.setStatus('');
    } catch (e) {
      this.ui.menu.setStatus((e as Error).message, true);
    } finally {
      this.busy = false;
    }
  }

  private async joinGame(code: string): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.ui.menu.commitName();
    this.ui.menu.setStatus(`방 ${code}에 연결 중…`);
    try {
      const net = await Net.join(code, settings.value.playerName, (s) => this.ui.menu.setStatus(s));
      this.startSession(net, null, false);
      this.ui.menu.setStatus('');
    } catch (e) {
      this.ui.menu.setStatus((e as Error).message, true);
    } finally {
      this.busy = false;
    }
  }

  practice(s: MatchSettings): void {
    if (this.busy || this.session) return;
    const net = Net.offline();
    const host = new MatchHost(net, this.map, settings.value.playerName);
    host.settings = { ...s, botFill: true };
    this.startSession(net, host, true);
    host.fillBots();
    host.tryStart();
  }

  /** Offline shooting range on the warehouse lane. */
  range(): void {
    if (this.busy || this.session) return;
    const net = Net.offline();
    const host = new MatchHost(net, this.map, settings.value.playerName);
    this.startSession(net, host, true);
    host.startRange();
  }

  private startSession(net: Net, host: MatchHost | null, offline: boolean): void {
    this.session = new GameClient(
      { renderer: this.renderer, env: this.env, audio: this.audio, input: this.input, map: this.map, ui: this.ui, onLeave: (r) => this.leave(r) },
      net,
      host,
      offline,
    );
    this.ui.menu.show(false);
  }

  leave(reason?: string): void {
    if (!this.session) return;
    const s = this.session;
    this.session = null;
    s.dispose();
    this.input.exitLock();
    const ui = this.ui;
    ui.hud.show(false);
    ui.lobby.show(false);
    ui.draft.hide();
    ui.shop.show(false);
    ui.results.hide();
    this.setPaused(false);
    ui.scoreboard.show(false);
    ui.clickPrompt.classList.add('hidden');
    ui.menu.show(true);
    ui.menu.setStatus(reason ?? '', !!reason);
    this.audio.stopAmbient();
    this.renderer.vmVisible = false;
    const g = this.renderer.grade.uniforms;
    g.uFlash.value = g.uAfter.value = g.uDamage.value = g.uSmoke.value = g.uLowHp.value = g.uDeath.value = g.uTintAmt.value = 0;
  }

  private frame = (now: number): void => {
    requestAnimationFrame(this.frame);
    const dt = Math.min(0.05, Math.max(0, (now - this.last) / 1000));
    this.last = now;
    this.time += dt;
    if (this.session) {
      if (this.session.offline && this.ui.pause.visible) this.session.idle(dt);
      else this.session.update(dt);
    } else this.menuCamera(dt);
    this.map.update(this.time, dt);
    this.env.update(this.time, this.renderer.camera);
    this.renderer.render(this.time);
    this.input.endFrame();
  };

  private menuCamera(dt: number): void {
    this.menuT += dt;
    this.renderer.vmVisible = false;
    cinematicCamera(this.renderer.camera, this.menuT);
    this.renderer.setHorizontalFov(84);
  }
}

function nextFrame(): Promise<void> {
  return new Promise((r) => requestAnimationFrame(() => r()));
}

void new App().boot().catch((e: unknown) => {
  console.error(e);
  const el = document.getElementById('ui');
  if (el) el.innerHTML = `<div class="fatal">초기화 실패: ${(e as Error).message ?? e}<br/>WebGL2를 지원하는 최신 브라우저(Chrome/Edge/Firefox)에서 실행하세요.</div>`;
});

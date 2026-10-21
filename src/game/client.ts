import * as THREE from 'three';
import { NET, TEAMS, type TeamId } from '../core/config';
import type { Input } from '../core/input';
import { settings } from '../core/settings';
import { clamp, damp, dirFromYawPitch, lerp, wrapAngle, escapeHtml } from '../core/utils';
import type { Net } from '../net/network';
import {
  F,
  PROTOCOL_VERSION,
  WEAPON_INDEX,
  v3,
  type BarrierMsg,
  type HostMsg,
  type LobbyPlayer,
  type MatchSettings,
  type Phase,
  type PlayerInfo,
  type ShotHit,
  type ThrowMsg,
} from '../net/protocol';
import type { GameMap } from '../world/map';
import type { ColliderBox } from '../world/collision';
import type { GameRenderer } from '../render/renderer';
import type { Environment } from '../render/environment';
import { Effects } from '../render/effects';
import { SmokeSystem } from '../render/smoke';
import { energyWallMaterial } from '../render/shaders';
import type { AudioEngine } from '../audio/audio';
import type { UI } from '../ui/ui';
import type { HudAbility, NameTag, RadarDot } from '../ui/hud';
import { ABILITY_ICONS, WEAPON_ICONS } from '../ui/icons';
import { Avatar } from './avatar';
import { Hitbox } from './hitbox';
import { LocalPlayer, type PlayerHooks, type ShotResult, type TraceResult } from './player';
import { ViewModel } from './viewmodel';
import { ProjectileSystem, type Grenade } from './projectiles';
import { CoinField } from './coins';
import { WEAPONS, type WeaponDef, type WeaponId } from './weapons';
import { ABILITIES, activeSynergies, applyPick, hasSynergy, stat, type AbilityId, type DraftCard, type Rarity, type ThrowKind } from './abilities';
import type { MatchHost } from './host';
import { SUN_DIR } from '../render/environment';
import { cinematicCamera } from '../render/cinematic';

interface Snap {
  t: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  f: number;
  w: number;
}

class RemotePlayer {
  readonly avatar: Avatar;
  readonly hitbox = new Hitbox();
  readonly pos = new THREE.Vector3();
  readonly vel = new THREE.Vector3();
  yaw = 0;
  pitch = 0;
  flags = 0;
  w = 1;
  crouch = 0;
  buffer: Snap[] = [];
  private stepAcc = 0;
  private airT = 0;
  private wasGround = true;
  alive = true;
  private prevPos = new THREE.Vector3();

  constructor(
    readonly id: string,
    public team: TeamId,
    scene: THREE.Scene,
  ) {
    this.avatar = new Avatar(team, 'pistol');
    scene.add(this.avatar.root);
  }

  /** Snapshots older than this (host ms) predate the last teleport and are ignored. */
  minT = 0;

  push(s: Snap): void {
    if (s.t < this.minT) return;
    const last = this.buffer[this.buffer.length - 1];
    if (last && s.t <= last.t) return;
    this.buffer.push(s);
    if (this.buffer.length > 40) this.buffer.shift();
  }

  teleport(x: number, y: number, z: number, yaw: number): void {
    this.buffer = [];
    this.pos.set(x, y, z);
    this.prevPos.copy(this.pos);
    this.yaw = yaw;
    this.pitch = 0;
    this.vel.set(0, 0, 0);
  }

  /** Interpolates to `renderT` (host clock). Returns footstep/land events. */
  update(renderT: number, dt: number): { step: boolean; land: boolean; jump: boolean } {
    const b = this.buffer;
    if (b.length >= 2) {
      let i = b.length - 2;
      while (i > 0 && b[i].t > renderT) i--;
      const a = b[i];
      const c = b[i + 1];
      let k = (renderT - a.t) / Math.max(1, c.t - a.t);
      k = clamp(k, 0, 1.25);
      this.pos.set(lerp(a.x, c.x, k), lerp(a.y, c.y, k), lerp(a.z, c.z, k));
      this.yaw = a.yaw + wrapAngle(c.yaw - a.yaw) * Math.min(1, k);
      this.pitch = lerp(a.pitch, c.pitch, Math.min(1, k));
      const s = k < 0.5 ? a : c;
      this.flags = s.f;
      this.w = s.w;
      // drop history that is no longer needed
      while (b.length > 3 && b[1].t < renderT - 300) b.shift();
    } else if (b.length === 1) {
      const s = b[0];
      this.pos.set(s.x, s.y, s.z);
      this.yaw = s.yaw;
      this.pitch = s.pitch;
      this.flags = s.f;
      this.w = s.w;
    }
    if (dt > 0) this.vel.subVectors(this.pos, this.prevPos).divideScalar(dt);
    if (this.vel.length() > 40) this.vel.set(0, 0, 0);
    this.prevPos.copy(this.pos);
    this.crouch = damp(this.crouch, this.flags & F.crouch ? 1 : 0, 12, dt);
    this.hitbox.update(this.pos, this.yaw, this.crouch);

    const ground = (this.flags & F.ground) !== 0;
    const ev = { step: false, land: false, jump: false };
    const sp = Math.hypot(this.vel.x, this.vel.z);
    if (ground && sp > 3.6 && !(this.flags & F.crouch)) {
      this.stepAcc += sp * dt;
      if (this.stepAcc > 2.15) {
        this.stepAcc = 0;
        ev.step = true;
      }
    }
    if (!ground) this.airT += dt;
    if (ground && !this.wasGround && this.airT > 0.35) ev.land = true;
    if (!ground && this.wasGround && this.vel.y > 2) ev.jump = true;
    if (ground) this.airT = 0;
    this.wasGround = ground;
    return ev;
  }
}

interface BarrierVis {
  msg: BarrierMsg;
  group: THREE.Group;
  mat: THREE.ShaderMaterial;
  collider: ColliderBox;
  hp: number;
  hit: number;
  born: number;
  dying: number;
}

export interface ClientDeps {
  renderer: GameRenderer;
  env: Environment;
  audio: AudioEngine;
  input: Input;
  map: GameMap;
  ui: UI;
  onLeave(reason?: string): void;
}

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q = new THREE.Quaternion();

export class GameClient implements PlayerHooks {
  readonly selfId: string;
  phase: Phase = 'lobby';
  round = 0;
  scores: [number, number] = [0, 0];
  phaseEndsAt = 0;
  private clockOffset = 0;
  private clockSynced = false;
  rtt = 0;
  lobbyPlayers: LobbyPlayer[] = [];
  matchSettings: MatchSettings = { mode: '1v1', firstTo: 4, botFill: true, botSkill: 1 };
  hostId = '';
  readonly infos = new Map<string, PlayerInfo>();
  readonly remotes = new Map<string, RemotePlayer>();
  readonly local: LocalPlayer;
  private vm: ViewModel;
  private effects: Effects;
  private smoke: SmokeSystem;
  private projectiles: ProjectileSystem;
  private coins: CoinField;
  private barriers = new Map<string, BarrierVis>();
  private reveals = new Map<string, number>();
  private selfAvatar: Avatar;
  private spectating: string | null = null;
  private deathCam: { t: number; killer: string | null; pos: THREE.Vector3 } | null = null;
  private deathInfo = '';
  private stTimer = 0;
  private pingTimer = 0;
  private radarTimer = 0;
  private visibleEnemies = new Set<string>();
  private shake = 0;
  private damagePulse = 0;
  private time = 0;
  private coinRequests = new Map<number, number>();
  private throwSeq = 0;
  private fpsAcc = { frames: 0, t: 0, fps: 60 };
  private attractT = 0;
  private aimTarget: string | null = null;
  private dashFov = 0;
  private disposed = false;
  private shopAuto = true;
  private camPos = new THREE.Vector3();
  private sunCheckT = 0;
  private sunLevel = 1;
  private indoorLevel = 0;
  private resultsTimer: number | null = null;
  private draftCards: DraftCard[] = [];
  private stSeq = 0;
  private lastDraft: DraftCard | null = null;

  constructor(
    private deps: ClientDeps,
    readonly net: Net,
    readonly host: MatchHost | null,
    readonly offline: boolean,
  ) {
    this.selfId = net.selfId;
    const scene = deps.renderer.scene;
    this.local = new LocalPlayer(this);
    this.vm = new ViewModel(deps.renderer.vmScene, 0);
    deps.renderer.vmScene.environment = deps.env.envTexture;
    deps.renderer.vmScene.environmentIntensity = 0.6;
    this.effects = new Effects(scene);
    this.smoke = new SmokeSystem(scene);
    this.projectiles = new ProjectileSystem(scene, deps.map.world);
    this.coins = new CoinField(scene);
    this.selfAvatar = new Avatar(0, 'pistol');
    this.selfAvatar.root.visible = false;
    scene.add(this.selfAvatar.root);
    deps.ui.hud.setRadarMap(deps.map.radar, deps.map.bounds);
    net.handlers = {
      toHost: (from, msg) => this.host?.handle(from, msg),
      toClient: (msg) => this.handle(msg),
      peerJoined: (id, name) => this.host?.peerJoined(id, name),
      peerLeft: (id) => {
        if (this.host) this.host.peerLeft(id);
        else if (id === 'host') this.deps.onLeave('호스트와의 연결이 끊어졌습니다.');
      },
    };
    if (!net.isHost) net.toHost({ t: 'hello', name: settings.value.playerName, version: PROTOCOL_VERSION });
    this.sendPing();
  }

  // ---------------------------------------------------------------------------
  // Clock
  // ---------------------------------------------------------------------------
  get hostNow(): number {
    return performance.now() + this.clockOffset;
  }

  private toLocal(hostMs: number): number {
    return hostMs - this.clockOffset;
  }

  private sendPing(): void {
    this.net.toHost({ t: 'ping', c: performance.now(), rtt: this.rtt });
  }

  get me(): PlayerInfo | undefined {
    return this.infos.get(this.selfId);
  }

  get myTeam(): TeamId {
    return this.me?.team ?? this.lobbyPlayers.find((p) => p.id === this.selfId)?.team ?? 0;
  }

  // ---------------------------------------------------------------------------
  // Messages
  // ---------------------------------------------------------------------------
  handle(msg: HostMsg): void {
    if (this.disposed) return;
    const ui = this.deps.ui;
    const audio = this.deps.audio;
    switch (msg.t) {
      case 'welcome':
        break;
      case 'reject':
        this.deps.onLeave(msg.reason);
        break;
      case 'pong': {
        const nowT = performance.now();
        const rtt = nowT - msg.c;
        const sample = msg.h + rtt / 2 - nowT;
        if (!this.clockSynced) {
          this.clockOffset = sample;
          this.clockSynced = true;
          this.rtt = rtt;
        } else {
          this.rtt = lerp(this.rtt, rtt, 0.3);
          if (rtt < this.rtt * 1.5) this.clockOffset = lerp(this.clockOffset, sample, 0.25);
        }
        break;
      }
      case 'lobby':
        this.lobbyPlayers = msg.players;
        this.matchSettings = msg.settings;
        this.hostId = msg.hostId;
        if (this.phase === 'lobby') this.showLobby();
        break;
      case 'phase':
        this.onPhase(msg.phase, msg.round, msg.endsAt, msg.scores);
        break;
      case 'players':
        this.onPlayers(msg.list);
        break;
      case 'snap':
        for (const e of msg.s) {
          if (e[0] === this.selfId) continue;
          const r = this.remotes.get(e[0]);
          if (r) r.push({ t: msg.ht, x: e[1], y: e[2], z: e[3], yaw: e[4], pitch: e[5], f: e[6], w: e[7] });
        }
        break;
      case 'draftOffer':
        this.draftCards = msg.cards;
        this.lastDraft = null;
        ui.draft.show(msg.pick, msg.total, msg.cards, this.toLocal(msg.endsAt), this.me?.abilities ?? []);
        this.deps.input.exitLock();
        break;
      case 'draftWait':
        // The roster update with the new pick arrives right after; preview it now.
        ui.draft.waiting(this.lastDraft ? applyPick(this.me?.abilities ?? [], this.lastDraft).list : (this.me?.abilities ?? []));
        break;
      case 'roundStart':
        this.onRoundStart(msg.round, msg.spawns);
        break;
      case 'coins':
        this.coins.set(msg.list);
        this.coinRequests.clear();
        break;
      case 'coinTaken': {
        const pos = this.coins.remove(msg.id);
        if (pos) {
          this.effects.sparkle(pos, [2.6, 1.8, 0.5], msg.value > 200 ? 40 : 18, msg.value > 200 ? 5 : 3);
          audio.coin(msg.by === this.selfId ? null : pos, msg.value > 200);
        }
        break;
      }
      case 'fire':
        this.onRemoteFire(msg.id, msg.w, msg.o, msg.hits);
        break;
      case 'dmg':
        this.onDamage(msg);
        break;
      case 'kill':
        this.onKill(msg.killer, msg.victim, msg.w, msg.head, msg.assister);
        break;
      case 'heal': {
        const info = this.infos.get(msg.target);
        if (info) {
          info.hp = msg.hp;
          info.armor = msg.armor;
        }
        break;
      }
      case 'throw':
        this.projectiles.spawn(msg);
        break;
      case 'ability':
        this.onRemoteAbility(msg.id, msg.ability);
        break;
      case 'barrier':
        this.addBarrier(msg);
        break;
      case 'barrierHp': {
        const b = this.barriers.get(msg.bid);
        if (b) {
          b.hp = msg.hp;
          b.hit = 1;
        }
        break;
      }
      case 'barrierGone':
        this.removeBarrier(msg.bid);
        break;
      case 'reveal':
        if (msg.team === this.myTeam) {
          const until = performance.now() + msg.duration * 1000;
          for (const id of msg.targets) this.reveals.set(id, Math.max(this.reveals.get(id) ?? 0, until));
          if (msg.kind === 'pulse' && msg.origin) this.effects.pulse(new THREE.Vector3(...msg.origin), 30, TEAMS[this.myTeam].color);
          if (msg.targets.length) ui.hud.toast(msg.kind === 'mark' ? '표식: 적 위치 노출' : `정찰 펄스: 적 ${msg.targets.length}명 노출`, 'good');
        } else if (msg.kind === 'pulse' && msg.origin) {
          // The sound already plays from the matching 'ability' event.
          this.effects.pulse(new THREE.Vector3(...msg.origin), 30, 0xff3a4a);
        }
        break;
      case 'gold':
        ui.hud.goldPop(msg.amount, msg.reason);
        break;
      case 'roundEnd':
        this.onRoundEnd(msg.winner, msg.reason, msg.scores, msg.mvp);
        break;
      case 'matchEnd':
        this.onMatchEnd(msg.winner, msg.scores);
        break;
      case 'chat':
        ui.chat.add(msg.name, msg.text, this.infos.get(msg.from)?.team ?? this.lobbyPlayers.find((p) => p.id === msg.from)?.team ?? null, msg.system);
        break;
      case 'buyResult':
        ui.shop.message(msg.msg, msg.ok);
        if (msg.ok) audio.buy();
        else audio.uiError();
        break;
    }
  }

  private showLobby(): void {
    const ui = this.deps.ui;
    ui.lobby.render(this.net.code, this.lobbyPlayers, this.matchSettings, this.selfId, this.hostId || (this.net.isHost ? this.selfId : ''), this.offline);
    ui.lobby.show(true);
  }

  private onPhase(phase: Phase, round: number, endsAt: number, scores: [number, number]): void {
    const prev = this.phase;
    this.phase = phase;
    this.round = round;
    this.phaseEndsAt = endsAt;
    this.scores = scores;
    const ui = this.deps.ui;
    const map = this.deps.map;
    map.setSpawnBarriers(phase === 'buy');
    ui.pause.setHostEnd(this.net.isHost && phase !== 'lobby' ? () => this.net.toHost({ t: 'toLobby' }) : null);
    if (phase === 'lobby' || phase === 'draft') this.hideBodies();
    if (phase === 'lobby') {
      ui.hud.show(false);
      ui.draft.hide();
      ui.shop.show(false);
      ui.results.hide();
      this.resetWorld();
      this.local.alive = false;
      this.showLobby();
      this.deps.input.exitLock();
      this.deps.audio.stopAmbient();
      return;
    }
    ui.lobby.show(false);
    if (phase === 'draft') {
      ui.hud.show(false);
      ui.results.hide();
      if (prev === 'lobby') this.deps.audio.roundStart();
      return;
    }
    ui.draft.hide();
    if (phase === 'buy') {
      ui.hud.show(true);
      this.deps.audio.startAmbient();
      ui.hud.banner(`ROUND ${round}`, '구매 단계 · B 키로 상점', 'neutral', 2.4);
      if (this.shopAuto) this.openShop(true);
    } else if (phase === 'live') {
      this.openShop(false);
      ui.hud.banner('전투 개시', `${this.matchSettings.mode.toUpperCase()} · 적 전원을 처치하라`, this.myTeam === 0 ? 'team0' : 'team1', 1.8);
      this.deps.audio.roundStart();
    } else if (phase === 'matchEnd') {
      ui.shop.show(false);
    }
  }

  private onPlayers(list: PlayerInfo[]): void {
    const scene = this.deps.renderer.scene;
    const seen = new Set<string>();
    for (const p of list) {
      seen.add(p.id);
      const prev = this.infos.get(p.id);
      this.infos.set(p.id, p);
      if (p.id === this.selfId) {
        this.local.team = p.team;
        this.vm.setTeam(p.team);
        this.selfAvatar.setTeam(p.team);
        this.local.syncLoadout(p.primary, p.secondary, p.abilities);
        if (prev && p.hp < prev.hp - 0.5 && this.local.alive) this.damagePulse = Math.min(1, this.damagePulse + (prev.hp - p.hp) / 50);
        continue;
      }
      let r = this.remotes.get(p.id);
      if (!r) {
        r = new RemotePlayer(p.id, p.team, scene);
        this.remotes.set(p.id, r);
      }
      if (r.team !== p.team) {
        r.team = p.team;
        r.avatar.setTeam(p.team);
      }
    }
    for (const [id, r] of this.remotes) {
      if (!seen.has(id)) {
        r.avatar.dispose();
        this.remotes.delete(id);
      }
    }
    // Players that left (kicked bots, purged disconnects) must vanish from every roster view.
    for (const id of [...this.infos.keys()]) if (!seen.has(id)) this.infos.delete(id);
  }

  private onRoundStart(round: number, spawns: { id: string; pos: [number, number, number]; yaw: number }[]): void {
    this.round = round;
    this.resetWorld();
    for (const s of spawns) {
      if (s.id === this.selfId) {
        this.local.spawn(new THREE.Vector3(...s.pos), s.yaw);
        this.spectating = null;
        this.deathCam = null;
        this.selfAvatar.revive();
        this.selfAvatar.root.visible = false;
        this.vm.setWeapon(this.local.current, 0.6);
        this.deps.ui.hud.setCenter(null);
        if (this.phase === 'buy' && this.shopAuto) this.openShop(true);
      } else {
        const r = this.remotes.get(s.id);
        if (r) {
          r.teleport(s.pos[0], s.pos[1], s.pos[2], s.yaw);
          r.minT = this.hostNow - 30;
          r.alive = true;
          r.avatar.revive();
          r.avatar.root.visible = true;
        }
      }
    }
  }

  /** Clears corpses left from the previous match (lobby / draft show an empty map). */
  private hideBodies(): void {
    for (const r of this.remotes.values()) {
      r.avatar.revive();
      r.avatar.root.visible = false;
    }
    this.selfAvatar.revive();
    this.selfAvatar.root.visible = false;
    this.deathCam = null;
    this.spectating = null;
  }

  private resetWorld(): void {
    this.effects.clearRound();
    this.smoke.clear();
    this.projectiles.clear();
    this.coins.clear();
    for (const id of [...this.barriers.keys()]) this.removeBarrier(id, true);
    this.reveals.clear();
    for (const r of this.remotes.values()) r.avatar.setRevealed(false);
  }

  private onRoundEnd(winner: TeamId | -1, reason: string, scores: [number, number], mvp: string | null): void {
    this.scores = scores;
    const ui = this.deps.ui;
    const audio = this.deps.audio;
    const mine = this.myTeam;
    const reasonText = reason === 'elimination' ? '전원 처치' : reason === 'time' ? '시간 종료 · 남은 체력 우세' : '기권';
    const mvpName = mvp ? this.infos.get(mvp)?.name : null;
    const sub = `${reasonText}${mvpName ? ` · MVP ${mvpName}` : ''}`;
    if (winner === -1) {
      ui.hud.banner('무승부', reason === 'elimination' ? '양 팀 동시 전멸' : '시간 종료 · 체력 동률', 'neutral', 3.5);
      audio.roundLose();
    } else if (winner === mine) {
      ui.hud.banner('라운드 승리', sub, 'win', 3.5);
      audio.roundWin();
    } else {
      ui.hud.banner('라운드 패배', sub, 'lose', 3.5);
      audio.roundLose();
    }
  }

  private onMatchEnd(winner: TeamId, scores: [number, number]): void {
    this.scores = scores;
    const ui = this.deps.ui;
    if (winner === this.myTeam) this.deps.audio.matchWin();
    else this.deps.audio.roundLose();
    ui.hud.banner(winner === this.myTeam ? '승리' : '패배', `${TEAMS[winner].name} 팀이 매치를 가져갔습니다`, winner === this.myTeam ? 'win' : 'lose', 3);
    this.resultsTimer = window.setTimeout(() => {
      if (this.phase !== 'matchEnd') return;
      this.deps.input.exitLock();
      ui.hud.show(false);
      ui.results.show(winner, this.myTeam, scores, [...this.infos.values()], this.selfId, Math.max(0, (this.toLocal(this.phaseEndsAt) - performance.now()) / 1000));
    }, 2600);
  }

  // ---------------------------------------------------------------------------
  // Combat events
  // ---------------------------------------------------------------------------
  private onRemoteFire(id: string, w: WeaponId, o: [number, number, number], hits: ShotHit[]): void {
    const r = this.remotes.get(id);
    const origin = new THREE.Vector3(...o);
    const muzzle = r ? r.avatar.getMuzzleWorld(new THREE.Vector3()) : origin.clone();
    const def = WEAPONS[w];
    const infinite = r ? (r.flags & F.infinite) !== 0 : false;
    this.deps.audio.gunshot(w, muzzle, infinite);
    if (def.slot === 'melee') return;
    r?.avatar.fireKick();
    const firstDir = hits.length ? new THREE.Vector3(...hits[0].p).sub(muzzle).normalize() : dirFromYawPitch(r?.yaw ?? 0, r?.pitch ?? 0);
    this.effects.muzzleBurst(muzzle, firstDir, w === 'shotgun' || w === 'sniper' || w === 'magnum');
    const ear = this.camPos;
    let whiz = false;
    hits.forEach((hHit, i) => {
      const p = new THREE.Vector3(...hHit.p);
      if (i % (w === 'shotgun' ? 3 : 1) === 0) this.effects.tracer(muzzle, p, infinite ? 0x80e0ff : def.tracer);
      if (hHit.k === 0 && hHit.n) {
        this.effects.impact(p, new THREE.Vector3(...hHit.n));
        if (Math.random() < 0.35) this.deps.audio.impact(p);
      } else if (hHit.k === 1) this.effects.blood(p, p.clone().sub(muzzle).normalize(), false);
      else if (hHit.k === 3) this.effects.barrierHit(p, 0x9fe8ff);
      // Bullet passing close to our head
      if (!whiz && this.local.alive) {
        const seg = _v.subVectors(p, muzzle);
        const len = seg.length();
        seg.divideScalar(len || 1);
        const t = clamp(_v2.subVectors(ear, muzzle).dot(seg), 0, len);
        const closest = muzzle.clone().addScaledVector(seg, t);
        if (closest.distanceTo(ear) < 1.4 && t < len - 0.5) whiz = true;
      }
    });
    if (whiz) this.deps.audio.whiz(this.camPos.clone().add(new THREE.Vector3((Math.random() - 0.5) * 2, 0.2, (Math.random() - 0.5) * 2)));
  }

  private onDamage(msg: Extract<HostMsg, { t: 'dmg' }>): void {
    const info = this.infos.get(msg.target);
    if (info) {
      info.hp = msg.hp;
      info.armor = msg.armor;
    }
    if (msg.target === this.selfId) {
      const from = new THREE.Vector3(...msg.from);
      const dx = from.x - this.camPos.x;
      const dz = from.z - this.camPos.z;
      const worldAng = Math.atan2(-dx, -dz);
      const rel = wrapAngle(worldAng - this.local.yaw);
      if (msg.attacker !== this.selfId) this.deps.ui.hud.damageFrom(-rel, msg.amount);
      this.damagePulse = Math.min(1, this.damagePulse + msg.amount / 45);
      this.shake = Math.min(1, this.shake + msg.amount / 80);
      this.deps.audio.hurt();
      // aim punch
      this.local.recoilPitch += Math.min(0.05, msg.amount * 0.0008);
    } else if (msg.attacker === this.selfId && msg.zone === 'blast') {
      this.deps.ui.hud.hitmarker(false, false);
    } else if (msg.attacker === this.selfId && msg.zone === 'toxic') {
      this.deps.ui.hud.hitmarker(false, false);
    }
    const r = this.remotes.get(msg.target);
    if (r && msg.zone !== 'toxic') this.effects.blood(r.hitbox.center.clone(), new THREE.Vector3(0, 0.5, 0), msg.zone === 'head');
  }

  private onKill(killerId: string, victimId: string, w: WeaponId | AbilityId, head: boolean, assister: string | null): void {
    const ui = this.deps.ui;
    const killer = this.infos.get(killerId);
    const victim = this.infos.get(victimId);
    const icon = w in WEAPON_ICONS ? WEAPON_ICONS[w as WeaponId] : `<span class="kf-ab">${ABILITY_ICONS[w as AbilityId] ?? ''}</span>`;
    if (victim) {
      ui.hud.killfeedAdd(
        killer && killerId !== victimId ? { name: killer.name, team: killer.team, self: killerId === this.selfId } : null,
        { name: victim.name, team: victim.team, self: victimId === this.selfId },
        icon,
        head,
        assister ? (this.infos.get(assister)?.name ?? null) : null,
      );
    }
    const kpos = killerId === this.selfId ? this.local.motor.body.pos : this.remotes.get(killerId)?.pos;
    if (killerId === this.selfId && victimId !== this.selfId) {
      ui.hud.hitmarker(head, true);
      this.deps.audio.killConfirm(head);
      ui.hud.toast(head ? `헤드샷 처치 · ${victim?.name ?? ''}` : `처치 · ${victim?.name ?? ''}`, 'good', 1.8);
    }
    if (victimId === this.selfId) {
      this.local.alive = false;
      const pos = this.local.motor.body.pos.clone();
      this.deathCam = { t: 0, killer: killerId !== victimId ? killerId : null, pos };
      this.selfAvatar.root.visible = true;
      this.selfAvatar.revive();
      this.selfAvatar.setWeapon(this.local.current);
      this.selfAvatar.update(0, { pos, yaw: this.local.yaw, pitch: 0, vel: new THREE.Vector3(), crouch: this.local.motor.crouch, onGround: true, ads: false, reloading: false, cloak: false, adrenaline: false });
      const dir = kpos ? pos.clone().sub(kpos) : new THREE.Vector3(Math.sin(this.local.yaw), 0, Math.cos(this.local.yaw));
      this.selfAvatar.die(dir.x, dir.z);
      this.deps.audio.death();
      const wName = w in WEAPONS ? WEAPONS[w as WeaponId].nameKo : (ABILITIES[w as AbilityId]?.name ?? '');
      this.deathInfo =
        killer && killerId !== victimId
          ? `<div class="death-label">처치당함</div><div class="death-name team${killer.team}">${escapeHtml(killer.name)}</div><div class="death-weapon">${escapeHtml(wName)}${head ? ' · 헤드샷' : ''}</div>`
          : '<div class="death-label">사망</div>';
      ui.hud.setCenter(this.deathInfo);
      ui.shop.show(false);
    } else {
      const r = this.remotes.get(victimId);
      if (r) {
        r.alive = false;
        const dir = kpos ? r.pos.clone().sub(kpos) : new THREE.Vector3(0, 0, 1);
        r.avatar.die(dir.x, dir.z);
        r.avatar.setRevealed(false);
      }
      if (this.spectating === victimId) this.spectating = null;
    }
  }

  private onRemoteAbility(id: string, ability: AbilityId): void {
    const r = this.remotes.get(id);
    if (!r) return;
    const pos = r.pos.clone();
    this.deps.audio.ability(ability, pos.clone().setY(pos.y + 1.2));
    switch (ability) {
      case 'heal':
        for (let i = 0; i < 6; i++) this.effects.healAura(pos);
        break;
      case 'dash':
        this.effects.dashTrail(pos, r.vel, r.team === 0 ? [0.5, 2.2, 3] : [3, 1.2, 0.5]);
        break;
      case 'recon':
        break;
      case 'adrenaline':
        this.effects.sparkle(pos.clone().setY(pos.y + 1), [3, 1.2, 0.3], 12, 2);
        break;
      case 'infinite':
        this.effects.sparkle(pos.clone().setY(pos.y + 1.2), [0.6, 2, 3], 12, 2);
        break;
      default:
        break;
    }
  }

  // ---------------------------------------------------------------------------
  // Barriers
  // ---------------------------------------------------------------------------
  private addBarrier(msg: BarrierMsg): void {
    if (this.barriers.has(msg.bid)) return;
    const world = this.deps.map.world;
    const [x, y, z] = msg.pos;
    const w = msg.width;
    const hgt = 2.4;
    const alongX = msg.yaw === 0;
    const min = alongX ? new THREE.Vector3(x - w / 2, y, z - 0.14) : new THREE.Vector3(x - 0.14, y, z - w / 2);
    const max = alongX ? new THREE.Vector3(x + w / 2, y + hgt, z + 0.14) : new THREE.Vector3(x + 0.14, y + hgt, z + w / 2);
    const collider = world.add(min, max, { tag: 'barrier', ref: msg.bid });
    const group = new THREE.Group();
    group.position.set(x, y, z);
    group.rotation.y = alongX ? 0 : Math.PI / 2;
    const mat = energyWallMaterial(TEAMS[msg.team].color, 0.75);
    const wall = new THREE.Mesh(new THREE.PlaneGeometry(w, hgt), mat);
    wall.position.y = hgt / 2;
    wall.renderOrder = 6;
    group.add(wall);
    const pylonMat = new THREE.MeshStandardMaterial({ color: 0x24282e, metalness: 0.8, roughness: 0.35 });
    const glow = new THREE.MeshBasicMaterial({ color: new THREE.Color(TEAMS[msg.team].color).multiplyScalar(4) });
    for (const sx of [-1, 1]) {
      const py = new THREE.Mesh(new THREE.BoxGeometry(0.16, hgt + 0.15, 0.22), pylonMat);
      py.position.set((sx * w) / 2, (hgt + 0.15) / 2, 0);
      py.castShadow = true;
      group.add(py);
      const strip = new THREE.Mesh(new THREE.BoxGeometry(0.04, hgt, 0.235), glow);
      strip.position.set((sx * w) / 2, hgt / 2, 0);
      group.add(strip);
    }
    const base = new THREE.Mesh(new THREE.BoxGeometry(w, 0.08, 0.3), pylonMat);
    base.position.y = 0.04;
    group.add(base);
    this.deps.renderer.scene.add(group);
    this.barriers.set(msg.bid, { msg, group, mat, collider, hp: msg.hp, hit: 0, born: this.time, dying: -1 });
    this.deps.audio.ability('barrier', new THREE.Vector3(x, y + 1, z));
    this.effects.sparkle(new THREE.Vector3(x, y + 1.2, z), [0.5, 1.8, 3], 20, 3);
  }

  private removeBarrier(bid: string, instant = false): void {
    const b = this.barriers.get(bid);
    if (!b) return;
    this.deps.map.world.remove(b.collider);
    if (instant) {
      this.disposeBarrier(b);
      this.barriers.delete(bid);
    } else {
      b.dying = 0;
      this.effects.sparkle(b.group.position.clone().setY(b.group.position.y + 1.2), [0.6, 1.8, 3], 30, 4);
    }
  }

  // ---------------------------------------------------------------------------
  // PlayerHooks (local player → world/network)
  // ---------------------------------------------------------------------------
  trace(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number): TraceResult {
    const wh = this.deps.map.world.raycast(origin, dir, maxDist, true);
    let best = wh ? wh.dist : maxDist;
    let res: TraceResult | null = null;
    for (const r of this.remotes.values()) {
      if (!r.alive || r.avatar.dead) continue;
      const info = this.infos.get(r.id);
      if (!info || info.team === this.myTeam) continue;
      const t = r.hitbox.trace(origin, dir, best);
      if (t) {
        best = t.dist;
        res = { dist: t.dist, point: origin.clone().addScaledVector(dir, t.dist), normal: null, kind: 'player', playerId: r.id, zone: t.zone, victimYaw: r.yaw };
      }
    }
    if (res) return res;
    if (wh) {
      return { dist: wh.dist, point: wh.point.clone(), normal: wh.normal.clone(), kind: wh.box.tag === 'barrier' ? 'barrier' : 'world', barrierId: wh.box.tag === 'barrier' ? wh.box.ref : undefined };
    }
    return { dist: maxDist, point: origin.clone().addScaledVector(dir, maxDist), normal: null, kind: 'none' };
  }

  onShot(def: WeaponDef, origin: THREE.Vector3, shots: ShotResult[], infinite: boolean): void {
    const audio = this.deps.audio;
    const melee = def.slot === 'melee';
    if (!melee) {
      this.vm.fire(def.id === 'shotgun' || def.id === 'sniper' ? 1.3 : 1, infinite);
      audio.gunshot(def.id, null, infinite);
      this.effects.muzzleLight(this.muzzleWorld(), infinite ? 0x80d8ff : 0xffaa55, def.id === 'shotgun' ? 22 : 12);
      this.shake = Math.min(1, this.shake + (def.id === 'sniper' || def.id === 'shotgun' ? 0.25 : def.id === 'magnum' ? 0.18 : 0.05));
    }
    const muzzle = this.muzzleWorld();
    const perTarget = new Map<string, { dmg: number; head: boolean; dist: number }>();
    const perBarrier = new Map<string, number>();
    const hits: ShotHit[] = [];
    shots.forEach((s, i) => {
      const tr = s.trace;
      if (!melee) {
        if (i % (def.id === 'shotgun' ? 2 : 1) === 0) this.effects.tracer(muzzle, tr.point, infinite ? 0x80e0ff : def.tracer);
        hits.push({ p: v3(tr.point), n: tr.normal ? v3(tr.normal) : undefined, k: tr.kind === 'world' ? 0 : tr.kind === 'player' ? 1 : tr.kind === 'barrier' ? 3 : 2 });
      }
      if (tr.kind === 'world' && tr.normal) {
        this.effects.impact(tr.point, tr.normal, !melee);
        if (melee) audio.impact(tr.point);
      } else if (tr.kind === 'player' && tr.playerId) {
        this.effects.blood(tr.point, s.dir, tr.zone === 'head');
        const cur = perTarget.get(tr.playerId);
        if (cur) {
          cur.dmg += s.damage;
          cur.head ||= tr.zone === 'head';
        } else perTarget.set(tr.playerId, { dmg: s.damage, head: tr.zone === 'head', dist: tr.dist });
        if (melee) audio.knifeHit();
      } else if (tr.kind === 'barrier' && tr.barrierId) {
        this.effects.barrierHit(tr.point, TEAMS[this.barriers.get(tr.barrierId)?.msg.team ?? 0].color);
        perBarrier.set(tr.barrierId, (perBarrier.get(tr.barrierId) ?? 0) + def.damage);
      }
    });
    this.net.toHost({ t: 'fire', w: def.id, o: v3(origin), hits });
    for (const [target, r] of perTarget) {
      if (r.dmg <= 0) continue;
      this.net.toHost({ t: 'hit', target, dmg: Math.round(r.dmg * 100) / 100, zone: r.head ? 'head' : 'body', w: def.id, dist: r.dist });
      this.deps.ui.hud.hitmarker(r.head, false);
      audio.hitmarker(r.head);
    }
    for (const [bid, dmg] of perBarrier) this.net.toHost({ t: 'barrierDmg', bid, dmg });
  }

  private muzzleWorld(): THREE.Vector3 {
    const cam = this.deps.renderer.camera;
    return cam.localToWorld(new THREE.Vector3(0.12, -0.12, -0.6));
  }

  onThrow(kind: ThrowKind, pos: THREE.Vector3, vel: THREE.Vector3, rarity: Rarity): void {
    // The host only accepts throws from living players during combat; never show a local-only grenade.
    if (this.phase !== 'live' || !this.local.alive) return;
    const syn: string[] = [];
    for (const s of ['blindfog', 'toxic', 'markflash', 'seeker']) if (hasSynergy(this.local.owned, s)) syn.push(s);
    const msg: ThrowMsg = { t: 'throw', gid: `${this.selfId}-${++this.throwSeq}`, kind, owner: this.selfId, team: this.myTeam, pos: v3(pos), vel: v3(vel), rarity, syn };
    this.projectiles.spawn(msg);
    this.net.toHost(msg);
  }

  onAbility(id: AbilityId, _rarity: Rarity): void {
    const audio = this.deps.audio;
    if (ABILITIES[id].type === 'throw') return;
    audio.ability(id, null);
    const pos = this.local.motor.body.pos;
    if (id === 'heal') for (let i = 0; i < 4; i++) this.effects.healAura(pos);
    if (id === 'dash') this.dashFov = 1;
    if (id !== 'barrier') this.net.toHost({ t: 'ability', ability: id });
    this.deps.ui.hud.toast(`${ABILITIES[id].name} 사용`, 'info', 1.2);
  }

  onRecon(radius: number, duration: number): void {
    this.deps.ui.hud.pulse(TEAMS[this.myTeam].css);
    const me = this.local.motor.body.pos;
    const targets: string[] = [];
    for (const r of this.remotes.values()) {
      const info = this.infos.get(r.id);
      if (!info || !info.alive || info.team === this.myTeam) continue;
      if (r.pos.distanceTo(me) <= radius) targets.push(r.id);
    }
    this.net.toHost({ t: 'reveal', targets, duration, origin: v3(this.local.eye), kind: 'pulse' });
  }

  onBarrier(pos: THREE.Vector3, yaw: number, rarity: Rarity): void {
    this.net.toHost({
      t: 'barrier',
      bid: `${this.selfId}-b${++this.throwSeq}`,
      owner: this.selfId,
      team: this.myTeam,
      pos: v3(pos),
      yaw,
      width: stat('barrier', 'width', rarity),
      hp: stat('barrier', 'hp', rarity),
      duration: stat('barrier', 'duration', rarity),
      regen: hasSynergy(this.local.owned, 'regenwall'),
    });
  }

  onFootstep(): void {
    this.deps.audio.footstep(null, this.local.motor.body.pos.y > 0.25, 1);
  }

  onJump(): void {
    this.deps.audio.jump(null);
  }

  onLand(speed: number): void {
    this.deps.audio.land(null, speed);
    this.vm.landed(speed);
  }

  onWeaponSwitched(id: WeaponId, equipTime: number): void {
    this.vm.setWeapon(id, equipTime);
    this.deps.audio.equip();
  }

  onReloadStart(def: WeaponDef, duration: number): void {
    if (def.shellReload) return;
    this.vm.reload(duration);
  }

  onReloadEvent(kind: 'magOut' | 'magIn' | 'shell' | 'bolt' | 'pump'): void {
    const a = this.deps.audio;
    if (kind === 'magOut') a.magOut();
    else if (kind === 'magIn') a.magIn();
    else if (kind === 'bolt') a.boltPull();
    else if (kind === 'shell') {
      a.shellIn();
      this.vm.insertShell();
    } else if (kind === 'pump') a.pump();
  }

  onDryFire(): void {
    this.deps.audio.dryFire();
  }

  onThrowAnim(kind: ThrowKind): void {
    this.vm.throwGrenade(kind);
    this.deps.audio.throwWhoosh();
  }

  onInspect(): void {
    this.vm.inspect();
  }

  onMelee(_heavy: boolean): void {
    this.vm.melee();
    this.deps.audio.knifeSwing(null);
  }

  // ---------------------------------------------------------------------------
  // Grenade detonation (runs identically on every client)
  // ---------------------------------------------------------------------------
  private onDetonate(g: Grenade): void {
    const m = g.msg;
    const pos = g.pos.clone();
    const audio = this.deps.audio;
    if (m.kind === 'flash') {
      this.effects.flashPop(pos);
      audio.flashBang(pos);
      this.applyFlash(pos, stat('flash', 'blind', m.rarity), stat('flash', 'radius', m.rarity), m.owner);
    } else if (m.kind === 'frag') {
      const r = stat('frag', 'radius', m.rarity);
      const ground = this.deps.map.world.groundBelow(pos.clone().setY(pos.y + 0.2), 0.05, 1.5);
      this.effects.explosion(pos, r, ground);
      audio.explosion(pos);
      const d = pos.distanceTo(this.camPos);
      this.shake = Math.min(1.2, this.shake + Math.max(0, 1 - d / 25) * 1.2);
    } else {
      const r = stat('smoke', 'radius', m.rarity);
      this.smoke.spawn(m.gid, pos, r, stat('smoke', 'duration', m.rarity), m.owner, m.team, m.syn.includes('toxic'), this.time);
      this.effects.smokePopBurst(pos);
      audio.smokePop(pos);
      if (m.syn.includes('blindfog')) {
        this.effects.flashPop(pos.clone().setY(pos.y + 0.8));
        audio.flashBang(pos);
        this.applyFlash(pos.clone().setY(pos.y + 0.8), 2.2, 26, m.owner);
      }
    }
  }

  private applyFlash(pos: THREE.Vector3, maxBlind: number, radius: number, owner: string): void {
    if (!this.local.alive) return;
    const eye = this.camPos;
    const dist = pos.distanceTo(eye);
    if (dist > radius) return;
    if (!this.deps.map.world.lineOfSight(pos, eye)) return;
    const to = pos.clone().sub(eye).normalize();
    const facing = this.local.viewDir.dot(to);
    const f = facing > 0.5 ? 1 : facing > 0 ? 0.6 + facing * 0.8 : facing > -0.5 ? 0.25 + (facing + 0.5) * 0.7 : 0.12;
    const distK = 1 - clamp((dist - radius * 0.35) / (radius * 0.65), 0, 1);
    const smokeK = this.smoke.blocks(pos, eye, this.time) ? 0.35 : 1;
    const strength = f * distK * smokeK;
    const dur = maxBlind * strength;
    if (dur < 0.3) return;
    this.deps.renderer.captureAfterimage();
    this.local.blind(dur);
    this.deps.audio.tinnitus(dur * 0.8, Math.min(1, strength));
    if (owner !== this.selfId) this.net.toHost({ t: 'flashed', by: owner, duration: dur });
  }

  // ---------------------------------------------------------------------------
  // UI actions
  // ---------------------------------------------------------------------------
  openShop(on: boolean): void {
    const ui = this.deps.ui;
    const can = on && this.phase === 'buy' && this.local.alive;
    ui.shop.show(can);
    if (can) this.deps.input.exitLock();
  }

  toggleShop(): void {
    const open = !this.deps.ui.shop.open;
    this.shopAuto = open;
    this.openShop(open);
    if (!open) this.deps.input.requestLock();
  }

  /** Offline pause: shift every absolute deadline so timers resume where they stopped. */
  shiftTime(ms: number): void {
    this.phaseEndsAt += ms;
    this.host?.shiftTime(ms);
  }

  /** Paused frame (offline practice): keep the picture alive without simulating. */
  idle(dt: number): void {
    this.deps.input.consumeMouseDelta();
    this.effects.update(0);
    this.updateGrade(dt);
  }

  draftPick(i: number): void {
    this.lastDraft = this.draftCards[i] ?? null;
    this.net.toHost({ t: 'draftPick', index: i });
  }

  buy(item: string): void {
    this.net.toHost({ t: 'buy', item });
  }

  sendChat(text: string): void {
    this.net.toHost({ t: 'chat', text });
  }

  // ---------------------------------------------------------------------------
  // Frame
  // ---------------------------------------------------------------------------
  update(dt: number): void {
    if (this.disposed) return;
    this.time += dt;
    const { input, renderer, audio, ui, map } = this.deps;
    const now = performance.now();
    this.net.poll();
    this.host?.update(dt);
    if (this.disposed) return;

    this.fpsAcc.frames++;
    this.fpsAcc.t += dt;
    if (this.fpsAcc.t >= 0.5) {
      this.fpsAcc.fps = this.fpsAcc.frames / this.fpsAcc.t;
      this.fpsAcc.frames = 0;
      this.fpsAcc.t = 0;
    }
    this.pingTimer -= dt;
    if (this.pingTimer <= 0) {
      this.pingTimer = NET.pingIntervalMs / 1000;
      this.sendPing();
    }

    const inGame = this.phase === 'buy' || this.phase === 'live' || this.phase === 'roundEnd' || this.phase === 'matchEnd';

    // UI hotkeys (raw so they work with the cursor visible)
    if (!ui.chat.open && !ui.pause.visible) {
      if (inGame && input.keyPressed('KeyB') && this.phase === 'buy') this.toggleShop();
      if (input.keyPressed('Enter') && !ui.modal.visible && this.phase !== 'draft') {
        ui.chat.openInput();
        input.exitLock();
      }
    }
    const showBoard = inGame && input.isDown('scoreboard') && !ui.chat.open;
    ui.scoreboard.show(showBoard);
    if (showBoard) ui.scoreboard.update([...this.infos.values()], this.selfId, this.scores, this.round, map.name);

    // Gameplay input gating
    const blocked = ui.chat.open || ui.pause.visible || ui.modal.visible || ui.draft.visible;
    input.enabled = inGame && !blocked;
    const look = input.consumeMouseDelta();
    const canPlay = this.phase === 'buy' || this.phase === 'live' || this.phase === 'roundEnd';
    const st = settings.value;

    if (canPlay) {
      this.local.update(dt, {
        input,
        lookDX: look.x,
        lookDY: look.y,
        world: map.world,
        frozen: false,
        canShoot: this.phase === 'live' && !ui.shop.open,
        canUseAbilities: this.phase === 'live',
        sens: st.sensitivity,
        adsSens: st.adsSensitivity,
        invertY: st.invertY,
        adsToggle: st.adsToggle,
      });
      // Spectate cycling
      if (!this.local.alive && input.mouseWasPressed(0)) this.cycleSpectate();
    }

    // Send our state
    this.stTimer += dt;
    if (this.stTimer >= 1 / NET.stateHz && (this.phase === 'buy' || this.phase === 'live' || this.phase === 'roundEnd')) {
      this.stTimer = 0;
      const b = this.local.motor.body;
      this.net.toHost({ t: 'st', q: ++this.stSeq, p: v3(b.pos), yaw: Math.round(this.local.yaw * 1000) / 1000, pitch: Math.round(this.local.pitch * 1000) / 1000, f: this.local.flags(), w: WEAPON_INDEX.indexOf(this.local.current) }, true);
    }

    // Coins
    if (this.phase === 'live' && this.local.alive) {
      for (const c of this.coins.touching(this.local.motor.body.pos)) {
        const last = this.coinRequests.get(c.id) ?? 0;
        if (now - last > 800) {
          this.coinRequests.set(c.id, now);
          this.net.toHost({ t: 'coin', id: c.id });
        }
      }
    }

    // Remote players
    const renderT = this.hostNow - NET.interpDelayMs;
    for (const r of this.remotes.values()) {
      const info = this.infos.get(r.id);
      const ev = r.update(renderT, dt);
      if (info) r.alive = info.alive || r.alive;
      if (info && !info.alive && !r.avatar.dead && inGame) r.avatar.root.visible = false;
      const visible = inGame && (info?.alive ?? false);
      if (!r.avatar.dead) r.avatar.root.visible = visible;
      if (visible) {
        r.avatar.setWeapon(WEAPON_INDEX[r.w] ?? 'pistol');
        const cloaked = (r.flags & F.cloak) !== 0;
        const ally = info?.team === this.myTeam;
        r.avatar.setCloaked(cloaked, ally ? 3.0 : 1);
        if (ev.step) audio.footstep(r.pos, r.pos.y > 0.25, 1);
        if (ev.land) audio.land(r.pos, 8);
        if (ev.jump) audio.jump(r.pos);
        if (r.flags & F.adrenaline && Math.random() < dt * 12) this.effects.speedLine(r.pos.clone().setY(r.pos.y + 0.3 + Math.random() * 1.3), [3, 1.3, 0.4]);
        if (r.flags & F.dash) this.effects.dashTrail(r.pos, r.vel, ally ? [0.5, 2.2, 3] : [3, 1.2, 0.5]);
      }
      r.avatar.update(dt, { pos: r.pos, yaw: r.yaw, pitch: r.pitch, vel: r.vel, crouch: r.crouch, onGround: (r.flags & F.ground) !== 0, ads: (r.flags & F.ads) !== 0, reloading: (r.flags & F.reload) !== 0, cloak: (r.flags & F.cloak) !== 0, adrenaline: (r.flags & F.adrenaline) !== 0, throwing: (r.flags & F.throwing) !== 0 });
      const revealed = (this.reveals.get(r.id) ?? 0) > now && info?.alive === true && info.team !== this.myTeam;
      r.avatar.setRevealed(revealed);
    }
    if (this.selfAvatar.root.visible) this.selfAvatar.update(dt, { pos: this.deathCam?.pos ?? this.local.motor.body.pos, yaw: this.local.yaw, pitch: 0, vel: new THREE.Vector3(), crouch: 0, onGround: true, ads: false, reloading: false, cloak: false, adrenaline: false });

    // World systems
    this.projectiles.update(dt, (g) => this.onDetonate(g), (g, speed) => audio.bounce(g.pos, speed));
    this.effects.update(dt, this.camPos);
    this.coins.update(dt, this.time);
    this.smoke.update(this.time, renderer.camera);
    this.updateBarriers(dt);
    if (this.local.alive && this.local.adrenalineT > 0 && Math.random() < dt * 8) {
      const p = this.local.eye.add(new THREE.Vector3((Math.random() - 0.5) * 3, (Math.random() - 0.5) * 1.5, (Math.random() - 0.5) * 3));
      this.effects.speedLine(p, [3, 1.3, 0.4]);
    }

    this.updateCamera(dt);
    this.updateViewModel(dt, look.x, look.y);

    // Audio listener
    audio.setListener(this.camPos, dirFromYawPitch(this.local.yaw, this.local.pitch));
    const myHp = this.me?.hp ?? 100;
    audio.update(dt, this.local.alive && myHp <= 25 && this.phase === 'live');

    this.updateGrade(dt);
    this.updateHud(dt);
    ui.draft.update();
    ui.shop.update(this.me, Math.max(0, (this.toLocal(this.phaseEndsAt) - now) / 1000));
    if (this.phase !== 'buy' && ui.shop.open) ui.shop.show(false);

    // Click-to-play prompt
    const needPrompt = canPlay && !input.locked && !ui.needsCursor;
    ui.clickPrompt.classList.toggle('hidden', !needPrompt);
  }

  private disposeBarrier(b: BarrierVis): void {
    this.deps.renderer.scene.remove(b.group);
    b.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
    });
  }

  private updateBarriers(dt: number): void {
    for (const [bid, b] of this.barriers) {
      b.hit = Math.max(0, b.hit - dt * 4);
      b.mat.uniforms.uHit.value = b.hit;
      const grow = clamp((this.time - b.born) / 0.35, 0, 1);
      b.group.scale.set(1, 0.05 + 0.95 * (1 - Math.pow(1 - grow, 3)), 1);
      b.mat.uniforms.uFade.value = (0.55 + 0.45 * (b.hp / b.msg.hp)) * (b.dying >= 0 ? 1 - b.dying : 1);
      if (b.dying >= 0) {
        b.dying += dt * 2.5;
        b.group.scale.y = Math.max(0.01, 1 - b.dying);
        if (b.dying >= 1) {
          this.disposeBarrier(b);
          this.barriers.delete(bid);
        }
      }
    }
  }

  private cycleSpectate(): void {
    const allies = [...this.remotes.values()].filter((r) => this.infos.get(r.id)?.alive && this.infos.get(r.id)?.team === this.myTeam);
    if (!allies.length) return;
    const i = allies.findIndex((r) => r.id === this.spectating);
    this.spectating = allies[(i + 1) % allies.length].id;
  }

  private updateCamera(dt: number): void {
    const cam = this.deps.renderer.camera;
    const st = settings.value;
    const inGame = this.phase === 'buy' || this.phase === 'live' || this.phase === 'roundEnd' || (this.phase === 'matchEnd' && this.local.alive);
    this.shake = Math.max(0, this.shake - dt * 2.2);
    this.dashFov = Math.max(0, this.dashFov - dt * 3);
    if (!inGame || (!this.local.alive && !this.deathCam)) {
      // Cinematic establishing shot (lobby, draft, results)
      this.attractT += dt;
      cinematicCamera(cam, this.attractT + 40);
      this.deps.renderer.setHorizontalFov(84);
      this.camPos.copy(cam.position);
      this.deps.renderer.vmVisible = false;
      return;
    }
    if (this.local.alive) {
      this.deps.renderer.vmVisible = !this.vm.scoped;
      const eye = this.local.eye;
      const shake = this.shake * this.shake;
      const t = this.time;
      cam.position.copy(eye);
      cam.rotation.order = 'YXZ';
      cam.rotation.set(
        this.local.pitch + this.local.recoilPitch + Math.sin(t * 37) * 0.012 * shake,
        this.local.yaw + this.local.recoilYaw + Math.sin(t * 29) * 0.012 * shake,
        Math.sin(t * 23) * 0.01 * shake,
      );
      const zoom = lerp(1, this.local.def.ads.zoom, this.local.adsT);
      const fovMult = (1 / zoom) * (1 + this.dashFov * 0.08 + (this.local.adrenalineT > 0 ? 0.04 : 0));
      this.deps.renderer.setHorizontalFov(st.fov * fovMult);
      this.camPos.copy(cam.position);
      return;
    }
    // Dead: death cam → spectate
    this.deps.renderer.vmVisible = false;
    const dc = this.deathCam!;
    dc.t += dt;
    const allyAlive = [...this.remotes.values()].some((r) => this.infos.get(r.id)?.alive && this.infos.get(r.id)?.team === this.myTeam);
    if (dc.t > 2.6 && allyAlive && this.phase === 'live') {
      if (!this.spectating || !this.infos.get(this.spectating)?.alive) this.cycleSpectate();
    }
    const target = this.spectating ? this.remotes.get(this.spectating) : null;
    if (target) {
      const eye = target.pos.clone().setY(target.pos.y + lerp(1.64, 1.08, target.crouch));
      const dir = dirFromYawPitch(target.yaw, target.pitch * 0.6);
      const right = new THREE.Vector3(Math.cos(target.yaw), 0, -Math.sin(target.yaw));
      const want = eye.clone().addScaledVector(dir, -2.6).addScaledVector(right, 0.45).add(new THREE.Vector3(0, 0.35, 0));
      const back = want.clone().sub(eye);
      const len = back.length();
      const hit = this.deps.map.world.raycast(eye, back.normalize(), len, false);
      const p = hit ? eye.clone().addScaledVector(back, Math.max(0.3, hit.dist - 0.2)) : want;
      cam.position.lerp(p, 1 - Math.exp(-dt * 10));
      _q.setFromRotationMatrix(new THREE.Matrix4().lookAt(cam.position, eye.clone().addScaledVector(dir, 6), new THREE.Vector3(0, 1, 0)));
      cam.quaternion.slerp(_q, 1 - Math.exp(-dt * 10));
      const info = this.infos.get(target.id);
      this.deps.ui.hud.setCenter(`<div class="spec-label">관전 중</div><div class="spec-name">${escapeHtml(info?.name ?? '')}</div><div class="spec-hint">클릭으로 대상 변경</div>`);
    } else {
      const k = 1 - Math.exp(-dc.t * 1.2);
      const killer = dc.killer ? (this.remotes.get(dc.killer)?.pos ?? null) : null;
      const look = killer ? killer.clone().setY(killer.y + 1.2) : dc.pos.clone().setY(dc.pos.y + 0.4);
      const away = killer ? dc.pos.clone().sub(killer).setY(0).normalize() : new THREE.Vector3(0, 0, 1);
      const want = dc.pos.clone().add(new THREE.Vector3(0, 1.6 + k * 2.2, 0)).addScaledVector(away, k * 3.2);
      const hit = this.deps.map.world.raycast(dc.pos.clone().setY(dc.pos.y + 1.6), want.clone().sub(dc.pos.clone().setY(dc.pos.y + 1.6)).normalize(), want.distanceTo(dc.pos.clone().setY(dc.pos.y + 1.6)), false);
      if (hit) want.copy(hit.point).addScaledVector(hit.normal, 0.3);
      cam.position.lerp(want, 1 - Math.exp(-dt * 4));
      _q.setFromRotationMatrix(new THREE.Matrix4().lookAt(cam.position, look, new THREE.Vector3(0, 1, 0)));
      cam.quaternion.slerp(_q, 1 - Math.exp(-dt * 5));
      this.deps.ui.hud.setCenter(this.deathInfo);
    }
    this.deps.renderer.setHorizontalFov(st.fov);
    this.camPos.copy(cam.position);
  }

  private updateViewModel(dt: number, lookDX: number, lookDY: number): void {
    const l = this.local;
    // Sample whether the eye is in sunlight / indoors a few times per second for viewmodel lighting.
    this.sunCheckT -= dt;
    if (this.sunCheckT <= 0 && l.alive) {
      this.sunCheckT = 0.15;
      const eye = l.eye;
      const inSun = !this.deps.map.world.raycast(eye, SUN_DIR, 80, true);
      const roof = this.deps.map.world.raycast(eye, new THREE.Vector3(0, 1, 0), 30, true);
      this.sunLevel = inSun ? 1 : 0;
      this.indoorLevel = roof ? 1 : 0;
    }
    this.vmLight.sun = damp(this.vmLight.sun, this.sunLevel, 4, dt);
    this.vmLight.indoor = damp(this.vmLight.indoor, this.indoorLevel, 4, dt);
    this.vm.setLighting(this.vmLight.sun, this.vmLight.indoor);
    this.vm.setCloaked(l.cloakT > 0);
    this.vm.setEmpty((l.ammo.get(l.current)?.mag ?? 1) === 0 && l.def.slot === 'secondary');
    this.vm.update({ dt, lookDX, lookDY, speed: l.motor.speed2D, onGround: l.motor.body.onGround, crouch: l.motor.crouch, ads: l.adsT, walking: this.deps.input.isDown('walk') });
    // Keep the viewmodel light direction consistent with the world sun.
    const cam = this.deps.renderer.camera;
    const inv = cam.quaternion.clone().invert();
    this.vm.sunLight.position.copy(SUN_DIR).applyQuaternion(inv);
  }

  private vmLight = { sun: 1, indoor: 0 };

  private updateGrade(dt: number): void {
    const g = this.deps.renderer.grade.uniforms;
    const l = this.local;
    this.damagePulse = Math.max(0, this.damagePulse - dt * 1.6);
    g.uDamage.value = this.damagePulse;
    const hp = this.me?.hp ?? 100;
    g.uLowHp.value = l.alive && hp <= 30 && this.phase !== 'lobby' ? 1 - hp / 30 : 0;
    // Flashbang: hard white for the first part, then a fading afterimage.
    if (l.flashT > 0 && l.alive) {
      const k = l.flashT / Math.max(0.01, l.flashMax);
      g.uFlash.value = clamp((k - 0.35) / 0.65, 0, 1) * 0.98 + (k > 0.35 ? 0 : k * 0.4);
      g.uAfter.value = clamp(k * 1.6, 0, 1);
    } else {
      g.uFlash.value = damp(g.uFlash.value, 0, 6, dt);
      g.uAfter.value = damp(g.uAfter.value, 0, 6, dt);
    }
    g.uSmoke.value = this.local.alive ? this.smoke.densityAt(this.camPos, this.time) * 0.95 : 0;
    const tint = l.cloakT > 0 ? [0.4, 0.75, 1.0] : l.adrenalineT > 0 ? [1.0, 0.45, 0.1] : l.infiniteT > 0 ? [0.3, 0.85, 1.0] : null;
    if (tint && l.alive) {
      g.uTint.value.set(tint[0], tint[1], tint[2]);
      g.uTintAmt.value = damp(g.uTintAmt.value, l.cloakT > 0 ? 0.32 : 0.22, 6, dt);
    } else g.uTintAmt.value = damp(g.uTintAmt.value, 0, 6, dt);
    const dead = !l.alive && (this.phase === 'live' || this.phase === 'roundEnd') && !this.spectating;
    g.uDeath.value = damp(g.uDeath.value, dead ? 1 : 0, 3, dt);
    g.uChroma.value = 0.3 + this.damagePulse * 2;
  }

  private updateHud(dt: number): void {
    const ui = this.deps.ui;
    const l = this.local;
    const me = this.me;
    const st = settings.value;
    const now = performance.now();
    const inGame = this.phase === 'buy' || this.phase === 'live' || this.phase === 'roundEnd' || this.phase === 'matchEnd';
    if (!inGame) return;
    const timeLeft = Math.max(0, (this.toLocal(this.phaseEndsAt) - now) / 1000);
    const phaseLabel = this.phase === 'buy' ? '구매' : this.phase === 'live' ? '전투' : this.phase === 'roundEnd' ? '라운드 종료' : '매치 종료';
    const a = l.ammo.get(l.current);
    const abilities: HudAbility[] = l.abilities.map((ab) => {
      let active = 0;
      if (ab.id === 'infinite' && l.infiniteT > 0) active = l.infiniteT / stat('infinite', 'duration', ab.rarity);
      if (ab.id === 'adrenaline' && l.adrenalineT > 0) active = l.adrenalineT / stat('adrenaline', 'duration', ab.rarity);
      if (ab.id === 'cloak' && l.cloakT > 0) active = l.cloakT / stat('cloak', 'duration', ab.rarity);
      const rc = ab.id === 'dash' ? stat('dash', 'recharge', ab.rarity) : 0;
      return { id: ab.id, rarity: ab.rarity, charges: ab.charges, max: ab.max, recharge: rc > 0 ? ab.recharge / rc : 0, active: clamp(active, 0, 1) };
    });
    // Crosshair spread in pixels from the angular spread.
    const cam = this.deps.renderer.camera;
    const spreadAng = l.currentSpread() + Math.hypot(l.recoilPitch, l.recoilYaw) * 0.15;
    const pxPerRad = window.innerHeight / 2 / Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2);
    const spreadPx = st.crosshairDynamic ? clamp(spreadAng * pxPerRad * 0.55, 0, 90) + st.crosshairGap : st.crosshairGap + 2;
    ui.root.style.setProperty('--ch-color', st.crosshairColor);
    const roster = [...this.infos.values()].map((p) => ({ id: p.id, team: p.team, alive: p.alive, self: p.id === this.selfId }));
    ui.hud.update(
      {
        hp: me?.hp ?? 0,
        armor: me?.armor ?? 0,
        gold: me?.gold ?? 0,
        alive: l.alive,
        weapon: l.current,
        mag: a?.mag ?? 0,
        reserve: a?.reserve ?? 0,
        infinite: l.infiniteT > 0,
        reloading: l.reloadT > 0 ? 1 - l.reloadT / Math.max(0.01, l.reloadTotal) : 0,
        inventory: { primary: l.primary, secondary: l.secondary, current: l.current },
        abilities,
        synergies: activeSynergies(l.owned),
        timer: timeLeft,
        phaseLabel,
        scores: this.scores,
        round: this.round,
        firstTo: this.matchSettings.firstTo,
        myTeam: this.myTeam,
        roster,
        spread: spreadPx,
        crosshair: l.alive && l.def.slot !== 'melee' ? l.adsT < 0.6 || l.def.id === 'shotgun' : l.alive,
        scoped: this.vm.scoped && l.alive,
        ping: this.net.isHost ? 0 : this.rtt,
        fps: this.fpsAcc.fps,
        showFps: st.showFps,
        spectating: null,
        buyPhase: this.phase === 'buy' && !ui.shop.open && l.alive,
        adrenaline: l.adrenalineT,
        cloak: l.cloakT,
      },
      dt,
    );
    if (l.alive && this.phase !== 'matchEnd') ui.hud.setCenter(null);

    // Aim target name (enemy under crosshair)
    this.aimTarget = null;
    if (l.alive) {
      const tr = this.trace(this.camPos, l.viewDir, 80);
      if (tr.kind === 'player' && tr.playerId) this.aimTarget = tr.playerId;
    }

    // Visibility for radar (10 Hz)
    this.radarTimer -= dt;
    if (this.radarTimer <= 0) {
      this.radarTimer = 0.1;
      this.visibleEnemies.clear();
      const eyes: THREE.Vector3[] = [];
      if (l.alive) eyes.push(this.camPos.clone());
      for (const r of this.remotes.values()) {
        const info = this.infos.get(r.id);
        if (info?.alive && info.team === this.myTeam) eyes.push(r.hitbox.head.clone());
      }
      for (const r of this.remotes.values()) {
        const info = this.infos.get(r.id);
        if (!info?.alive || info.team === this.myTeam) continue;
        if ((r.flags & F.cloak) !== 0) continue;
        for (const e of eyes) {
          if (this.deps.map.world.lineOfSight(e, r.hitbox.head) && !this.smoke.blocks(e, r.hitbox.head, this.time)) {
            this.visibleEnemies.add(r.id);
            break;
          }
        }
      }
      const dots: RadarDot[] = [];
      for (const c of this.coins.all) dots.push({ x: c.pos[0], z: c.pos[2], kind: c.big ? 'bigcoin' : 'coin' });
      for (const s of this.smoke.clouds) dots.push({ x: s.pos.x, z: s.pos.z, kind: 'smoke', r: s.radius });
      for (const b of this.barriers.values()) dots.push({ x: b.msg.pos[0], z: b.msg.pos[2], kind: 'barrier', yaw: b.msg.yaw, r: b.msg.width / 2, team: b.msg.team });
      for (const r of this.remotes.values()) {
        const info = this.infos.get(r.id);
        if (!info) continue;
        if (!info.alive) {
          if (info.team === this.myTeam) dots.push({ x: r.pos.x, z: r.pos.z, kind: 'dead' });
          continue;
        }
        if (info.team === this.myTeam) dots.push({ x: r.pos.x, z: r.pos.z, kind: 'ally', yaw: r.yaw, team: info.team });
        else if (this.visibleEnemies.has(r.id) || (this.reveals.get(r.id) ?? 0) > now) dots.push({ x: r.pos.x, z: r.pos.z, kind: 'enemy' });
      }
      if (l.alive) dots.push({ x: l.motor.body.pos.x, z: l.motor.body.pos.z, kind: 'self', yaw: l.yaw, team: this.myTeam });
      ui.hud.drawRadar(dots);
    }

    // Name tags
    const tags: NameTag[] = [];
    const w = window.innerWidth;
    const hgt = window.innerHeight;
    for (const r of this.remotes.values()) {
      const info = this.infos.get(r.id);
      if (!info?.alive) continue;
      const enemy = info.team !== this.myTeam;
      if (enemy && r.id !== this.aimTarget) continue;
      if ((r.flags & F.cloak) !== 0 && enemy) continue;
      _v.copy(r.hitbox.head).setY(r.hitbox.head.y + 0.45);
      const dist = _v.distanceTo(this.camPos);
      if (dist > 70) continue;
      _v.project(cam);
      if (_v.z > 1 || _v.x < -1.1 || _v.x > 1.1 || _v.y < -1.1 || _v.y > 1.1) continue;
      tags.push({ id: r.id, x: (_v.x * 0.5 + 0.5) * w, y: (-_v.y * 0.5 + 0.5) * hgt, name: info.name, hp: info.hp, enemy, team: info.team, dist });
    }
    ui.hud.setTags(tags);
  }

  dispose(): void {
    this.disposed = true;
    if (this.resultsTimer) window.clearTimeout(this.resultsTimer);
    for (const r of this.remotes.values()) r.avatar.dispose();
    this.remotes.clear();
    this.selfAvatar.dispose();
    this.projectiles.clear();
    for (const id of [...this.barriers.keys()]) this.removeBarrier(id, true);
    this.coins.dispose();
    this.effects.dispose();
    this.smoke.dispose();
    this.vm.dispose();
    this.deps.map.setSpawnBarriers(false);
    this.net.close();
  }
}

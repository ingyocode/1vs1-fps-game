import * as THREE from 'three';
import { ECON, PLAYER, TEAMS, TIMING, type HitZone, type TeamId } from '../core/config';
import { shuffle } from '../core/utils';
import type { Net } from '../net/network';
import {
  F,
  PROTOCOL_VERSION,
  WEAPON_INDEX,
  type BarrierMsg,
  type ClientMsg,
  type CoinInfo,
  type LobbyPlayer,
  type MatchSettings,
  type Phase,
  type PlayerInfo,
  type ShotHit,
  type SnapEntry,
  type ThrowMsg,
  type V3,
  v3,
} from '../net/protocol';
import type { GameMap } from '../world/map';
import { segmentHitsSphere } from '../world/collision';
import { ARMOR_ITEMS, WEAPONS, applyArmor, type WeaponId } from './weapons';
import { BARRIER_HALF_DEPTH, BARRIER_HEIGHT, BONUS_PICK_LOSSES, MAX_TIER, TOXIC_SYN_DPS, VULN_BONUS, applyPick, hasSynergy, rollOffer, stat, tierOf, type AbilityId, type DraftCard, type Tier } from './abilities';
import { Hitbox } from './hitbox';
import { ProjectileSystem, type Grenade } from './projectiles';
import { NavGraph } from './nav';
import { BotBrain, BOT_NAMES } from './bot';

export interface HostPlayer {
  info: PlayerInfo;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  yaw: number;
  pitch: number;
  flags: number;
  w: number;
  hitbox: Hitbox;
  lastStateAt: number;
  draftOffer: DraftCard[] | null;
  draftPicked: boolean;
  dmgFrom: Map<string, number>;
  hot: { left: number; perSec: number } | null;
  bot: BotBrain | null;
  flashedUntil: number;
  spawnPos: THREE.Vector3;
  spawnLockUntil: number;
  lastSeq: number;
  /** Exposed by an awakened recon pulse: takes extra damage until then. */
  vulnUntil: number;
  /** Awakened heal: the once-per-round lethal-hit save is still available. */
  lastStand: boolean;
  /** Extra draft cards earned by losing rounds, offered during the next buy phase. */
  bonusPicks: number;
}

interface HostSmoke {
  pos: THREE.Vector3;
  radius: number;
  born: number;
  duration: number;
  owner: string;
  team: TeamId;
  /** Poison per second dealt to enemies inside (0 = plain smoke). */
  dps: number;
  tick: number;
}

interface HostBarrier {
  msg: BarrierMsg;
  hp: number;
  expires: number;
}

const now = (): number => performance.now();

let navCache: { map: GameMap; nav: NavGraph } | null = null;

export class MatchHost {
  readonly players = new Map<string, HostPlayer>();
  phase: Phase = 'lobby';
  round = 0;
  scores: [number, number] = [0, 0];
  phaseEndsAt = 0;
  settings: MatchSettings = { mode: '1v1', firstTo: 4, botFill: true, botSkill: 1 };
  private draftPick = 0;
  private lossStreak: [number, number] = [0, 0];
  readonly coins = new Map<number, CoinInfo>();
  private coinSeq = 1;
  private bigCoinSpawned = false;
  private barriers = new Map<string, HostBarrier>();
  readonly smokes: HostSmoke[] = [];
  private projectiles: ProjectileSystem;
  private snapTimer = 0;
  private playersDirty = true;
  private playersTimer = 0;
  private botSeq = 1;
  private roundStartedAt = 0;
  private pendingNext: { at: number; fn: () => void } | null = null;
  /** Shooting range (offline): no rounds or economy, targets respawn, every gun is free. */
  range = false;
  private respawnAt = new Map<string, number>();
  private roundMvpDamage = new Map<string, number>();
  private batching = false;

  constructor(
    readonly net: Net,
    readonly map: GameMap,
    hostName: string,
  ) {
    this.projectiles = new ProjectileSystem(null, map.world);
    this.addPlayer(net.selfId, hostName, false);
  }

  get world(): GameMap['world'] {
    return this.map.world;
  }

  get nav(): NavGraph {
    if (!navCache || navCache.map !== this.map) {
      // Build the graph against static geometry only (no spawn walls / barriers).
      const dynamic = this.map.world.boxes.filter((b) => b.tag !== 'world' && b.enabled);
      for (const b of dynamic) b.enabled = false;
      navCache = { map: this.map, nav: new NavGraph(this.map.navNodes, this.map.world) };
      for (const b of dynamic) b.enabled = true;
    }
    return navCache.nav;
  }

  get time(): number {
    return now();
  }

  // ---------------------------------------------------------------------------
  // Roster
  // ---------------------------------------------------------------------------
  private teamSize(): number {
    return this.settings.mode === '1v1' ? 1 : 2;
  }

  private teamCount(t: TeamId): number {
    let n = 0;
    for (const p of this.players.values()) if (p.info.team === t) n++;
    return n;
  }

  private addPlayer(id: string, name: string, bot: boolean, team?: TeamId): HostPlayer {
    const t: TeamId = team ?? (this.teamCount(0) <= this.teamCount(1) ? 0 : 1);
    const p: HostPlayer = {
      info: {
        id,
        name,
        team: t,
        bot,
        hp: PLAYER.maxHp,
        armor: 0,
        alive: false,
        gold: ECON.start,
        kills: 0,
        deaths: 0,
        assists: 0,
        damage: 0,
        primary: null,
        secondary: 'pistol',
        abilities: [],
        ping: 0,
        connected: true,
      },
      pos: new THREE.Vector3(0, 0, 0),
      vel: new THREE.Vector3(),
      yaw: 0,
      pitch: 0,
      flags: 0,
      w: 1,
      hitbox: new Hitbox(),
      lastStateAt: now(),
      draftOffer: null,
      draftPicked: false,
      dmgFrom: new Map(),
      hot: null,
      bot: null,
      flashedUntil: 0,
      spawnPos: new THREE.Vector3(),
      spawnLockUntil: 0,
      lastSeq: 0,
      vulnUntil: 0,
      lastStand: false,
      bonusPicks: 0,
    };
    if (bot) p.bot = new BotBrain(p, this);
    this.players.set(id, p);
    this.playersDirty = true;
    return p;
  }

  addBot(team: TeamId): void {
    if (this.phase !== 'lobby') return;
    if (this.teamCount(team) >= this.teamSize()) return;
    const used = new Set([...this.players.values()].map((p) => p.info.name));
    const name = BOT_NAMES.find((n) => !used.has(n)) ?? `BOT-${this.botSeq}`;
    this.addPlayer(`bot-${this.botSeq++}`, name, true, team);
    this.sendLobby();
  }

  /** Fills empty team slots with bots (practice mode / bot fill). */
  fillBots(): void {
    for (const t of [0, 1] as TeamId[]) while (this.teamCount(t) < this.teamSize()) this.addBot(t);
  }

  peerJoined(id: string, name: string): void {
    if (this.phase !== 'lobby') {
      this.net.sendTo(id, { t: 'reject', reason: '이미 경기가 진행 중입니다.' });
      window.setTimeout(() => this.net.kick(id), 500);
      return;
    }
    const humans = [...this.players.values()].filter((p) => !p.info.bot).length;
    if (humans >= this.teamSize() * 2) {
      this.net.sendTo(id, { t: 'reject', reason: '방이 가득 찼습니다.' });
      window.setTimeout(() => this.net.kick(id), 500);
      return;
    }
    // Replace a bot if the room is otherwise full.
    if (this.players.size >= this.teamSize() * 2) {
      const bot = [...this.players.values()].reverse().find((p) => p.info.bot);
      if (bot) this.players.delete(bot.info.id);
    }
    const clean = name.replace(/[<>]/g, '').trim().slice(0, 16) || 'Player';
    this.addPlayer(id, clean, false);
    this.net.sendTo(id, { t: 'welcome', you: id, code: this.net.code, version: PROTOCOL_VERSION });
    this.chatSystem(`${clean} 님이 입장했습니다.`);
    this.sendLobby();
  }

  peerLeft(id: string): void {
    const p = this.players.get(id);
    if (!p) return;
    if (this.phase === 'lobby') {
      this.players.delete(id);
      this.chatSystem(`${p.info.name} 님이 나갔습니다.`);
      this.sendLobby();
      return;
    }
    // Mid-match: a bot takes over so the match can continue.
    p.info.connected = false;
    p.info.bot = true;
    p.info.name = `${p.info.name} (봇)`;
    p.bot = new BotBrain(p, this);
    p.bot.takeOver();
    this.chatSystem(`${p.info.name.replace(' (봇)', '')} 님의 연결이 끊겨 봇이 대신합니다.`);
    this.playersDirty = true;
  }

  private lobbyList(): LobbyPlayer[] {
    return [...this.players.values()].map((p) => ({ id: p.info.id, name: p.info.name, team: p.info.team, bot: p.info.bot }));
  }

  sendLobby(): void {
    this.net.broadcast({ t: 'lobby', players: this.lobbyList(), settings: this.settings, hostId: this.net.selfId });
  }

  private chatSystem(text: string): void {
    this.net.broadcast({ t: 'chat', from: '', name: '', text, system: true });
  }

  // ---------------------------------------------------------------------------
  // Messages
  // ---------------------------------------------------------------------------
  handle(from: string, msg: ClientMsg): void {
    const p = this.players.get(from);
    const isHost = from === this.net.selfId;
    switch (msg.t) {
      case 'hello':
        if (msg.version !== PROTOCOL_VERSION) {
          this.net.sendTo(from, { t: 'reject', reason: '게임 버전이 다릅니다. 새로고침 후 다시 시도하세요.' });
          return;
        }
        if (p) {
          p.info.name = msg.name.replace(/[<>]/g, '').trim().slice(0, 16) || p.info.name;
          this.sendLobby();
        }
        return;
      case 'ping':
        if (p) p.info.ping = isHost ? 0 : Math.round(msg.rtt);
        this.net.sendTo(from, { t: 'pong', c: msg.c, h: now() });
        return;
      case 'chat': {
        if (!p) return;
        const text = msg.text.replace(/[<>]/g, '').slice(0, 120).trim();
        if (text) this.net.broadcast({ t: 'chat', from, name: p.info.name, text });
        return;
      }
      case 'setTeam':
        if (this.phase !== 'lobby' || !p) return;
        if (p.info.team !== msg.team && this.teamCount(msg.team) < this.teamSize()) {
          p.info.team = msg.team;
          this.sendLobby();
        } else if (p.info.team !== msg.team) {
          // swap with a bot on the full team
          const bot = [...this.players.values()].find((q) => q.info.bot && q.info.team === msg.team);
          if (bot) {
            bot.info.team = p.info.team;
            p.info.team = msg.team;
            this.sendLobby();
          }
        }
        return;
      case 'settings':
        if (!isHost || this.phase !== 'lobby') return;
        this.settings = msg.settings;
        // Trim teams that are now too big (bots first).
        for (const t of [0, 1] as TeamId[]) {
          while (this.teamCount(t) > this.teamSize()) {
            const victim = [...this.players.values()].reverse().find((q) => q.info.team === t && q.info.bot) ?? [...this.players.values()].reverse().find((q) => q.info.team === t && q.info.id !== this.net.selfId);
            if (!victim) break;
            if (victim.info.bot) this.players.delete(victim.info.id);
            else victim.info.team = t === 0 ? 1 : 0;
          }
        }
        this.sendLobby();
        return;
      case 'addBot':
        if (isHost) this.addBot(msg.team);
        return;
      case 'kickBot':
        if (isHost && this.phase === 'lobby' && this.players.get(msg.id)?.info.bot) {
          this.players.delete(msg.id);
          this.sendLobby();
        }
        return;
      case 'start':
        if (isHost) this.tryStart();
        return;
      case 'toLobby':
        if (isHost) this.toLobby();
        return;
      default:
        break;
    }
    if (!p) return;
    switch (msg.t) {
      case 'st': {
        // The fast channel is unordered: drop states older than the newest one applied.
        if (msg.q <= p.lastSeq) break;
        p.lastSeq = msg.q;
        // Right after a respawn, ignore in-flight states from the previous round.
        if (now() < p.spawnLockUntil && Math.hypot(msg.p[0] - p.spawnPos.x, msg.p[2] - p.spawnPos.z) > 6) break;
        p.vel.set((msg.p[0] - p.pos.x) * 30, (msg.p[1] - p.pos.y) * 30, (msg.p[2] - p.pos.z) * 30);
        p.pos.set(msg.p[0], msg.p[1], msg.p[2]);
        p.yaw = msg.yaw;
        p.pitch = msg.pitch;
        p.w = msg.w;
        p.flags = (msg.f & ~F.alive) | (p.info.alive ? F.alive : 0);
        p.lastStateAt = now();
        p.hitbox.update(p.pos, p.yaw, msg.f & F.crouch ? 1 : 0, p.pitch, WEAPON_INDEX[p.w]);
        break;
      }
      case 'fire':
        if (!p.info.alive) return;
        this.net.broadcast({ t: 'fire', id: from, w: msg.w, o: msg.o, hits: msg.hits }, false, from);
        this.alertBots(new THREE.Vector3(...msg.o), WEAPONS[msg.w].slot === 'melee' ? 6 : 45, p);
        break;
      case 'hit':
        this.onClientHit(p, msg.target, msg.dmg, msg.zone, msg.w, msg.dist);
        break;
      case 'draftPick':
        this.onDraftPick(p, msg.index);
        break;
      case 'buy':
        this.onBuy(p, msg.item);
        break;
      case 'coin':
        this.onCoin(p, msg.id);
        break;
      case 'throw': {
        if (!p.info.alive || this.phase !== 'live') return;
        // The tier comes from the roster, not the sender; bomblets are never sent.
        const tier = tierOf(p.info.abilities, msg.kind);
        if (tier === null) return;
        this.onThrow({ ...msg, tier, sub: false }, from);
        break;
      }
      case 'ability':
        if (!p.info.alive) return;
        this.onAbility(p, msg.ability);
        break;
      case 'barrier':
        if (!p.info.alive || this.phase !== 'live') return;
        if (!p.info.abilities.some((a) => a.id === 'barrier')) return;
        this.addBarrier(msg);
        break;
      case 'barrierDmg':
        this.damageBarrier(msg.bid, msg.dmg, p);
        break;
      case 'reveal':
        this.pulseReveal(p, msg.targets, msg.duration, msg.origin, msg.kind);
        break;
      case 'flashed': {
        const thrower = this.players.get(msg.by);
        if (thrower && thrower.info.team !== p.info.team && hasSynergy(thrower.info.abilities, 'markflash') && msg.duration > 0.6) {
          this.net.broadcast({ t: 'reveal', team: thrower.info.team, targets: [p.info.id], duration: 3, kind: 'mark' });
        }
        break;
      }
      default:
        break;
    }
  }

  // ---------------------------------------------------------------------------
  // Match flow
  // ---------------------------------------------------------------------------
  private setPhase(phase: Phase, seconds: number): void {
    this.phase = phase;
    // Applied immediately on the host so bots never see stale spawn walls.
    this.map.setSpawnBarriers(phase === 'buy');
    this.phaseEndsAt = now() + seconds * 1000;
    this.net.broadcast({ t: 'phase', phase, round: this.round, endsAt: this.phaseEndsAt, scores: this.scores });
  }

  canStart(): string | null {
    const n = this.teamSize();
    for (const t of [0, 1] as TeamId[]) {
      const c = this.teamCount(t);
      if (c < n && !this.settings.botFill) return `각 팀은 ${n}명이어야 합니다. (봇 채우기를 켜거나 봇을 추가하세요)`;
      if (c > n) return '팀 인원이 너무 많습니다.';
    }
    return null;
  }

  tryStart(): void {
    if (this.phase !== 'lobby') return;
    const err = this.canStart();
    if (err) {
      this.net.sendTo(this.net.selfId, { t: 'chat', from: '', name: '', text: err, system: true });
      return;
    }
    if (this.settings.botFill) this.fillBots();
    this.sendLobby();
    this.scores = [0, 0];
    this.lossStreak = [0, 0];
    this.round = 0;
    for (const p of this.players.values()) {
      Object.assign(p.info, { hp: PLAYER.maxHp, armor: 0, alive: false, gold: ECON.start, kills: 0, deaths: 0, assists: 0, damage: 0, primary: null, secondary: 'pistol', abilities: [] });
      p.draftOffer = null;
      p.draftPicked = false;
      p.bonusPicks = 0;
    }
    this.playersDirty = true;
    this.draftPick = 0;
    this.nextDraftPick();
  }

  private nextDraftPick(): void {
    this.draftPick++;
    if (this.draftPick > 3) {
      this.startRound(1);
      return;
    }
    this.setPhase('draft', TIMING.draftPick);
    for (const p of this.players.values()) {
      p.draftOffer = rollOffer(p.info.abilities);
      p.draftPicked = false;
      if (p.bot) p.bot.scheduleDraft(p.draftOffer);
      else this.net.sendTo(p.info.id, { t: 'draftOffer', pick: this.draftPick, total: 3, cards: p.draftOffer, endsAt: this.phaseEndsAt });
    }
  }

  onDraftPick(p: HostPlayer, index: number): void {
    const bonus = this.phase === 'buy' && p.bonusPicks > 0;
    if ((this.phase !== 'draft' && !bonus) || p.draftPicked || !p.draftOffer) return;
    const card = p.draftOffer[Math.max(0, Math.min(p.draftOffer.length - 1, index | 0))];
    p.info.abilities = applyPick(p.info.abilities, card);
    p.draftPicked = true;
    this.playersDirty = true;
    if (bonus) {
      p.bonusPicks--;
      p.draftOffer = null;
      p.bot?.onAbilitiesChanged();
      this.flushPlayers();
      if (!p.bot) this.net.sendTo(p.info.id, { t: 'draftWait', bonus: true });
      if (p.bonusPicks > 0) this.offerBonus(p);
      return;
    }
    if (!p.bot) this.net.sendTo(p.info.id, { t: 'draftWait' });
    if ([...this.players.values()].every((q) => q.draftPicked) && !this.pendingNext) {
      this.pendingNext = { at: now() + 900, fn: () => this.nextDraftPick() };
    }
  }

  /** Sends the next earned bonus card set (buy phase). Nothing left to draft = the pick lapses. */
  private offerBonus(p: HostPlayer): void {
    const cards = rollOffer(p.info.abilities);
    if (!cards.length) {
      p.bonusPicks = 0;
      p.draftOffer = null;
      return;
    }
    p.draftOffer = cards;
    p.draftPicked = false;
    if (p.bot) p.bot.scheduleDraft(cards);
    else this.net.sendTo(p.info.id, { t: 'draftOffer', pick: 1, total: p.bonusPicks, cards, endsAt: this.phaseEndsAt, bonus: true });
  }

  /** Buy phase over: any bonus card still undecided is picked at random, like a draft timeout. */
  private settleBonusPicks(): void {
    for (const p of this.players.values()) {
      if (p.bonusPicks <= 0) continue;
      while (p.bonusPicks > 0) {
        const offer = p.draftOffer && !p.draftPicked ? p.draftOffer : rollOffer(p.info.abilities);
        p.draftOffer = null;
        if (!offer.length) break;
        p.info.abilities = applyPick(p.info.abilities, offer[Math.floor(Math.random() * offer.length)]);
        p.bonusPicks--;
      }
      p.bonusPicks = 0;
      p.draftPicked = true;
      p.bot?.onAbilitiesChanged();
      this.playersDirty = true;
    }
  }

  private startRound(n: number): void {
    this.round = n;
    this.clearRoundState();
    const spawns: { id: string; pos: V3; yaw: number }[] = [];
    for (const t of [0, 1] as TeamId[]) {
      const members = [...this.players.values()].filter((p) => p.info.team === t).sort((a, b) => a.info.id.localeCompare(b.info.id));
      members.forEach((p, i) => {
        const sp = this.map.spawns[t][i % this.map.spawns[t].length];
        p.pos.copy(sp.pos);
        p.spawnPos.copy(sp.pos);
        p.spawnLockUntil = now() + 600;
        p.yaw = sp.yaw;
        p.pitch = 0;
        p.info.alive = true;
        p.info.hp = PLAYER.maxHp;
        p.dmgFrom.clear();
        p.hot = null;
        p.flashedUntil = 0;
        p.vulnUntil = 0;
        p.hitbox.update(p.pos, p.yaw, 0);
        spawns.push({ id: p.info.id, pos: v3(sp.pos), yaw: sp.yaw });
      });
    }
    this.roundMvpDamage.clear();
    this.playersDirty = true;
    this.setPhase('buy', n === 1 ? TIMING.buyFirst : TIMING.buy);
    this.net.broadcast({ t: 'roundStart', round: n, spawns });
    this.net.broadcast({ t: 'coins', list: [] });
    for (const p of this.players.values()) p.bot?.onRoundStart();
    this.flushPlayers();
    for (const p of this.players.values()) if (p.bonusPicks > 0) this.offerBonus(p);
  }

  private clearRoundState(): void {
    for (const bid of this.barriers.keys()) this.net.broadcast({ t: 'barrierGone', bid });
    this.barriers.clear();
    this.smokes.length = 0;
    this.projectiles.clear();
    this.coins.clear();
    this.bigCoinSpawned = false;
  }

  private goLive(): void {
    this.settleBonusPicks();
    this.setPhase('live', TIMING.round);
    this.roundStartedAt = now();
    // Spawn mirrored pairs of small coins plus one centre coin.
    const pairs = shuffle([...new Set(this.map.coinSpots.filter((c) => c.pair < 100).map((c) => c.pair))]).slice(0, 4);
    const centre = Math.random() < 0.5 ? 100 : 101;
    for (const spot of this.map.coinSpots) {
      if (pairs.includes(spot.pair) || spot.pair === centre) {
        const id = this.coinSeq++;
        this.coins.set(id, { id, pos: v3(spot.pos), value: ECON.coinSmall, big: false });
      }
    }
    this.net.broadcast({ t: 'coins', list: [...this.coins.values()] });
    for (const p of this.players.values()) {
      // Armed at go-live so a heal upgraded in the shop this round counts.
      const heal = tierOf(p.info.abilities, 'heal');
      p.lastStand = heal !== null && stat('heal', 'lastStand', heal) > 0;
      p.bot?.onLive();
    }
  }

  private endRound(winner: TeamId | -1, reason: 'elimination' | 'time' | 'forfeit'): void {
    if (this.phase !== 'live') return;
    if (winner !== -1) {
      this.scores[winner]++;
      const loser: TeamId = winner === 0 ? 1 : 0;
      this.lossStreak[winner] = 0;
      this.lossStreak[loser]++;
      for (const p of this.players.values()) {
        if (p.info.team === winner) this.giveGold(p, ECON.win, '라운드 승리');
        else this.giveGold(p, ECON.loss + ECON.lossStep * Math.min(ECON.lossMaxSteps, this.lossStreak[loser] - 1), '라운드 패배 보상');
      }
      // Every BONUS_PICK_LOSSES lost rounds (the winner's score counts the loser's losses), one more card.
      if (this.scores[winner] % BONUS_PICK_LOSSES === 0 && this.scores[winner] < this.settings.firstTo) {
        for (const p of this.players.values()) if (p.info.team === loser) p.bonusPicks++;
        this.chatSystem(`${TEAMS[loser].name} 팀 ${this.scores[winner]}패 · 다음 구매 단계에서 증강을 하나 더 고릅니다.`);
      }
    } else {
      for (const p of this.players.values()) this.giveGold(p, ECON.draw, '무승부');
    }
    let mvp: string | null = null;
    let best = 0;
    for (const [id, d] of this.roundMvpDamage) if (d > best) [mvp, best] = [id, d];
    this.setPhase('roundEnd', TIMING.roundEnd);
    this.net.broadcast({ t: 'roundEnd', winner, reason, scores: this.scores, mvp });
    this.playersDirty = true;
    const target = this.settings.firstTo;
    this.pendingNext = {
      at: now() + TIMING.roundEnd * 1000,
      fn: () => {
        if (this.scores[0] >= target || this.scores[1] >= target) {
          const w: TeamId = this.scores[0] >= target ? 0 : 1;
          this.setPhase('matchEnd', TIMING.matchEnd);
          this.net.broadcast({ t: 'matchEnd', winner: w, scores: this.scores });
          this.pendingNext = { at: now() + TIMING.matchEnd * 1000, fn: () => this.toLobby() };
        } else this.startRound(this.round + 1);
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Shooting range
  // ---------------------------------------------------------------------------
  /** Offline aim practice on the warehouse lane: one live "round" that never ends. */
  startRange(): void {
    const r = this.map.range;
    this.range = true;
    this.settings = { mode: '1v1', firstTo: 99, botFill: false, botSkill: 1 };
    this.scores = [0, 0];
    this.round = 1;
    this.clearRoundState();
    const self = this.players.get(this.net.selfId)!;
    Object.assign(self.info, { team: 0, hp: PLAYER.maxHp, armor: 0, alive: true, gold: 0, primary: 'rifle', secondary: 'pistol', abilities: [] });
    const spawns: { id: string; pos: V3; yaw: number }[] = [];
    const place = (p: HostPlayer, pos: THREE.Vector3, yaw: number): void => {
      p.pos.copy(pos);
      p.spawnPos.copy(pos);
      p.spawnLockUntil = now() + 600;
      p.yaw = yaw;
      p.pitch = 0;
      p.hitbox.update(p.pos, p.yaw, 0);
      spawns.push({ id: p.info.id, pos: v3(pos), yaw });
    };
    place(self, r.spawn.pos, r.spawn.yaw);
    r.targets.forEach((tg, i) => {
      const p = this.addPlayer(`target-${i}`, tg.name, true, 1);
      Object.assign(p.info, { hp: PLAYER.maxHp, alive: true, gold: 0, primary: 'rifle', secondary: 'pistol', abilities: [] });
      p.bot!.dummy = { home: tg.pos.clone(), yaw: tg.yaw, strafe: tg.strafe, crouch: tg.crouch, dir: 1, flipT: 0, t: i * 0.7 };
      place(p, tg.pos, tg.yaw);
    });
    this.setPhase('live', 24 * 3600);
    this.roundStartedAt = now();
    this.net.broadcast({ t: 'roundStart', round: 1, spawns });
    for (const p of this.players.values()) p.bot?.onRoundStart();
    this.flushPlayers();
  }

  private tickRange(t: number): void {
    for (const [id, at] of this.respawnAt) {
      if (t < at) continue;
      this.respawnAt.delete(id);
      const p = this.players.get(id);
      if (!p) continue;
      const home = p.bot?.dummy ? { pos: p.bot.dummy.home, yaw: p.bot.dummy.yaw } : this.map.range.spawn;
      p.info.alive = true;
      p.info.hp = PLAYER.maxHp;
      p.dmgFrom.clear();
      p.pos.copy(home.pos);
      p.spawnPos.copy(home.pos);
      p.spawnLockUntil = t + 600;
      p.yaw = home.yaw;
      p.hitbox.update(p.pos, p.yaw, 0);
      p.bot?.onRoundStart();
      this.playersDirty = true;
      this.net.broadcast({ t: 'respawn', id, pos: v3(home.pos), yaw: home.yaw });
    }
  }

  toLobby(): void {
    this.pendingNext = null;
    this.clearRoundState();
    this.net.broadcast({ t: 'coins', list: [] });
    // Bots that replaced disconnected humans leave with the match.
    for (const p of [...this.players.values()]) {
      if (!p.info.connected) this.players.delete(p.info.id);
      p.info.alive = false;
    }
    this.round = 0;
    this.scores = [0, 0];
    this.setPhase('lobby', 0);
    this.sendLobby();
    this.playersDirty = true;
  }

  // ---------------------------------------------------------------------------
  // Economy
  // ---------------------------------------------------------------------------
  giveGold(p: HostPlayer, amount: number, reason: string): void {
    if (amount <= 0 || this.range) return;
    p.info.gold = Math.min(ECON.max, p.info.gold + amount);
    this.playersDirty = true;
    if (!p.bot) this.net.sendTo(p.info.id, { t: 'gold', amount, reason });
  }

  onBuy(p: HostPlayer, item: string): void {
    const fail = (msg: string): void => {
      if (!p.bot) this.net.sendTo(p.info.id, { t: 'buyResult', ok: false, msg });
    };
    if (this.phase !== 'buy' && !this.range) return fail('구매 단계에서만 구매할 수 있습니다.');
    if (!p.info.alive) return fail('사망 상태에서는 구매할 수 없습니다.');
    let cost: number;
    let done: string;
    if (item in WEAPONS) {
      const def = WEAPONS[item as WeaponId];
      if (def.slot === 'melee') return fail('구매할 수 없습니다.');
      if ((def.slot === 'primary' && p.info.primary === def.id) || (def.slot === 'secondary' && p.info.secondary === def.id)) return fail('이미 보유 중입니다.');
      cost = this.range ? 0 : def.price;
      if (p.info.gold < cost) return fail('골드가 부족합니다.');
      if (def.slot === 'primary') p.info.primary = def.id;
      else p.info.secondary = def.id;
      done = `${def.nameKo} 구매`;
    } else if (item.startsWith('armor')) {
      const a = ARMOR_ITEMS.find((x) => x.id === item);
      if (!a) return fail('알 수 없는 품목');
      if (p.info.armor >= a.amount) return fail('이미 그 이상의 방어력을 보유 중입니다.');
      cost = this.range ? 0 : a.price;
      if (p.info.gold < cost) return fail('골드가 부족합니다.');
      p.info.armor = a.amount;
      done = `${a.name} 구매`;
    } else if (item.startsWith('up:')) {
      return fail(`능력은 골드로 강화할 수 없습니다. 라운드 ${BONUS_PICK_LOSSES}패마다 추가 증강을 고릅니다.`);
    } else return fail('알 수 없는 품목');
    p.info.gold -= cost;
    this.playersDirty = true;
    this.flushPlayers();
    if (!p.bot) this.net.sendTo(p.info.id, { t: 'buyResult', ok: true, msg: done });
  }

  onCoin(p: HostPlayer, id: number): void {
    if (this.phase !== 'live' || !p.info.alive) return;
    const c = this.coins.get(id);
    if (!c) return;
    const d = Math.hypot(c.pos[0] - p.pos.x, c.pos[2] - p.pos.z);
    if (d > 3) return;
    this.coins.delete(id);
    this.giveGold(p, c.value, c.big ? '대형 골드 획득' : '골드 획득');
    this.net.broadcast({ t: 'coinTaken', id, by: p.info.id, value: c.value });
  }

  // ---------------------------------------------------------------------------
  // Damage
  // ---------------------------------------------------------------------------
  private onClientHit(p: HostPlayer, targetId: string, dmg: number, zone: HitZone, w: WeaponId, dist: number): void {
    if (this.phase !== 'live' || !p.info.alive) return;
    const target = this.players.get(targetId);
    const def = WEAPONS[w];
    if (!target || !target.info.alive || !def) return;
    if (target.info.team === p.info.team) return;
    // Plausibility: never more than the weapon's theoretical max for one trigger pull.
    // Melee heavy backstab deals 180.
    const cap = def.slot === 'melee' ? 190 : def.damage * Math.max(def.headMult, 1) * def.pellets * 1.05;
    if (dmg > cap || dist > 400) return;
    // The weapon must be in the shooter's inventory.
    if (def.slot === 'primary' && p.info.primary !== w) return;
    if (def.slot === 'secondary' && p.info.secondary !== w) return;
    this.applyDamage(target, p, dmg, zone, w, def.armorPen);
  }

  /** Returns the health actually removed. */
  applyDamage(target: HostPlayer, attacker: HostPlayer | null, raw: number, zone: HitZone | 'blast' | 'toxic' | 'shock', w: WeaponId | AbilityId, armorPen = 0.5): number {
    if (!target.info.alive || this.phase !== 'live') return 0;
    const hostile = attacker !== null && attacker !== target && attacker.info.team !== target.info.team;
    if (hostile && target.vulnUntil > now()) raw *= 1 + VULN_BONUS;
    const r = applyArmor(raw, target.info.armor, armorPen);
    // Awakened heal: once per round a non-headshot lethal hit leaves 1 HP instead.
    const saved = r.hp >= target.info.hp && target.lastStand && zone !== 'head';
    if (saved) {
      target.lastStand = false;
      r.hp = Math.max(0, target.info.hp - 1);
    }
    const hpDmg = Math.min(target.info.hp, r.hp);
    target.info.armor = Math.max(0, target.info.armor - r.armor);
    target.info.hp = Math.max(0, target.info.hp - r.hp);
    const aId = attacker?.info.id ?? '';
    if (attacker && attacker !== target) {
      target.dmgFrom.set(aId, (target.dmgFrom.get(aId) ?? 0) + hpDmg);
      attacker.info.damage += Math.round(hpDmg);
      this.roundMvpDamage.set(aId, (this.roundMvpDamage.get(aId) ?? 0) + hpDmg);
    }
    this.playersDirty = true;
    const from = attacker ? attacker.hitbox.head : target.hitbox.center;
    this.net.broadcast({ t: 'dmg', target: target.info.id, attacker: aId, amount: Math.round(r.hp), hp: Math.ceil(target.info.hp), armor: Math.round(target.info.armor), zone, from: v3(from), w });
    target.bot?.onDamaged(attacker);
    if (saved) {
      this.startHeal(target, tierOf(target.info.abilities, 'heal') ?? MAX_TIER);
      this.net.broadcast({ t: 'ability', id: target.info.id, ability: 'heal', data: [1] });
    }
    // Awakened infinite: weapon damage dealt while bottomless heals the shooter.
    if (hostile && attacker.info.alive && w in WEAPONS && (attacker.flags & F.infinite) !== 0) {
      const inf = tierOf(attacker.info.abilities, 'infinite');
      const ls = inf === null ? 0 : stat('infinite', 'lifesteal', inf);
      if (ls > 0) attacker.info.hp = Math.min(PLAYER.maxHp, attacker.info.hp + hpDmg * ls);
    }
    if (target.info.hp <= 0) this.kill(target, attacker, w, zone === 'head');
    return hpDmg;
  }

  private kill(victim: HostPlayer, killer: HostPlayer | null, w: WeaponId | AbilityId, head: boolean): void {
    victim.info.alive = false;
    victim.info.hp = 0;
    victim.info.deaths++;
    if (!this.range) {
      victim.info.primary = null;
      victim.info.secondary = 'pistol';
      victim.info.armor = 0;
    } else this.respawnAt.set(victim.info.id, now() + (victim.bot ? 1400 : 2200));
    victim.hot = null;
    let assister: string | null = null;
    if (killer && killer !== victim && killer.info.team !== victim.info.team) {
      killer.info.kills++;
      const reward = (w in WEAPONS ? WEAPONS[w as WeaponId].killReward : ECON.kill) + (head ? ECON.headshotBonus : 0);
      this.giveGold(killer, reward, head ? '헤드샷 처치' : '처치');
      let bestAssist = 0;
      for (const [id, d] of victim.dmgFrom) {
        if (id === killer.info.id || d < 25) continue;
        const a = this.players.get(id);
        if (a && a.info.team === killer.info.team && d > bestAssist) {
          bestAssist = d;
          assister = id;
        }
      }
      if (assister) {
        const a = this.players.get(assister)!;
        a.info.assists++;
        this.giveGold(a, ECON.assist, '어시스트');
      }
      // Awakened adrenaline: a kill while boosted heals (the duration refresh is local to the killer).
      const adr = tierOf(killer.info.abilities, 'adrenaline');
      if (adr !== null && killer.info.alive && (killer.flags & F.adrenaline) !== 0) killer.info.hp = Math.min(PLAYER.maxHp, killer.info.hp + stat('adrenaline', 'killHeal', adr));
      killer.bot?.onKill();
    }
    this.net.broadcast({ t: 'kill', killer: killer?.info.id ?? victim.info.id, victim: victim.info.id, w, head, assister });
    this.playersDirty = true;
    this.flushPlayers();
    if (!this.batching) this.checkElimination();
  }

  /** Ends the round if a team has nobody left (both wiped out at once = draw). */
  private checkElimination(): void {
    if (this.phase !== 'live' || this.range) return;
    const alive: [boolean, boolean] = [false, false];
    for (const p of this.players.values()) if (p.info.alive) alive[p.info.team] = true;
    if (!alive[0] && !alive[1]) this.endRound(-1, 'elimination');
    else if (!alive[0]) this.endRound(1, 'elimination');
    else if (!alive[1]) this.endRound(0, 'elimination');
  }

  /** Applies several damage events as one simultaneous batch (explosions, gas ticks). */
  private batch(fn: () => void): void {
    this.batching = true;
    try {
      fn();
    } finally {
      this.batching = false;
    }
    this.checkElimination();
  }

  // ---------------------------------------------------------------------------
  // Abilities
  // ---------------------------------------------------------------------------
  private abilityTier(p: HostPlayer, id: AbilityId): Tier | null {
    return tierOf(p.info.abilities, id);
  }

  /** Applies a timed debuff: humans are told about it, bots track it themselves. */
  private debuff(p: HostPlayer, kind: 'slow' | 'vuln', duration: number): void {
    if (p.bot) {
      if (kind === 'slow') p.bot.slow(duration);
    } else this.net.sendTo(p.info.id, { t: 'debuff', target: p.info.id, kind, duration });
  }

  /** Recon pulse (players and bots). An awakened pulse also leaves the targets vulnerable. */
  pulseReveal(p: HostPlayer, targets: string[], duration: number, origin: V3 | undefined, kind: 'pulse' | 'mark'): void {
    const dur = Math.min(6, duration);
    const t = this.abilityTier(p, 'recon');
    const vuln = kind === 'pulse' && t !== null && stat('recon', 'vuln', t) > 0;
    if (vuln) {
      for (const id of targets) {
        const e = this.players.get(id);
        if (!e || !e.info.alive || e.info.team === p.info.team) continue;
        e.vulnUntil = Math.max(e.vulnUntil, now() + dur * 1000);
        this.debuff(e, 'vuln', dur);
      }
    }
    this.net.broadcast({ t: 'reveal', team: p.info.team, targets, duration: dur, origin, kind, vuln });
    this.feedBotsReveal(p.info.team, targets);
  }

  /** Relays a throw to everyone except the thrower (who already simulates it) and simulates it here too. */
  onThrow(msg: ThrowMsg, from: string): void {
    this.net.broadcast(msg, false, from);
    this.projectiles.spawn(msg);
  }

  onAbility(p: HostPlayer, ability: AbilityId): void {
    const t = this.abilityTier(p, ability);
    if (t === null) return;
    if (ability === 'heal') this.startHeal(p, t);
    this.net.broadcast({ t: 'ability', id: p.info.id, ability }, false, p.info.id);
  }

  private startHeal(p: HostPlayer, t: Tier): void {
    const time = stat('heal', 'time', t);
    p.hot = { left: time, perSec: stat('heal', 'amount', t) / time };
    const armor = stat('heal', 'armor', t);
    if (armor > 0) p.info.armor = Math.min(PLAYER.maxArmor, p.info.armor + armor);
    this.playersDirty = true;
  }

  addBarrier(msg: BarrierMsg): void {
    if (this.barriers.has(msg.bid)) return;
    this.barriers.set(msg.bid, { msg, hp: msg.hp, expires: now() + msg.duration * 1000 });
    this.net.broadcast(msg);
  }

  damageBarrier(bid: string, dmg: number, shooter: HostPlayer | null = null): void {
    const b = this.barriers.get(bid);
    if (!b || dmg <= 0) return;
    const dealt = Math.min(dmg, 400);
    b.hp -= dealt;
    // Awakened barrier: enemy shooters take part of what they pour into it.
    const owner = this.players.get(b.msg.owner);
    const bt = owner ? this.abilityTier(owner, 'barrier') : null;
    if (owner && shooter && bt !== null && shooter.info.team !== b.msg.team) {
      const rf = stat('barrier', 'reflect', bt);
      if (rf > 0) this.applyDamage(shooter, owner, Math.min(25, dealt * rf), 'shock', 'barrier', 0.5);
    }
    if (b.hp <= 0) {
      this.barriers.delete(bid);
      this.net.broadcast({ t: 'barrierGone', bid });
    } else this.net.broadcast({ t: 'barrierHp', bid, hp: Math.round(b.hp) });
  }

  private onDetonate(g: Grenade): void {
    const m = g.msg;
    const owner = this.players.get(m.owner);
    const pos = g.pos;
    if (m.kind === 'frag') {
      const radius = stat('frag', m.sub ? 'subRadius' : 'radius', m.tier);
      const maxD = stat('frag', m.sub ? 'subDamage' : 'damage', m.tier);
      const slow = stat('frag', 'slow', m.tier);
      const origin = pos.clone().setY(pos.y + 0.15);
      this.batch(() => {
        for (const p of this.players.values()) {
          if (!p.info.alive) continue;
          const d = origin.distanceTo(p.hitbox.center);
          if (d > radius) continue;
          if (!this.world.lineOfSight(origin, p.hitbox.center) && !this.world.lineOfSight(origin, p.hitbox.head)) continue;
          let dmg = maxD * Math.pow(1 - d / radius, 0.7);
          if (owner && p === owner) dmg *= 0.5;
          else if (owner && p.info.team === owner.info.team) continue;
          if (dmg < 1) continue;
          this.applyDamage(p, owner ?? null, dmg, 'blast', 'frag', 0.3);
          if (slow > 0 && p !== owner && p.info.alive) this.debuff(p, 'slow', slow);
        }
      });
      if (owner && m.syn.includes('seeker') && !m.sub) {
        const targets = [...this.players.values()].filter((p) => p.info.alive && p.info.team !== owner.info.team && p.pos.distanceTo(pos) < 12).map((p) => p.info.id);
        if (targets.length) {
          this.net.broadcast({ t: 'reveal', team: owner.info.team, targets, duration: 3, origin: v3(pos), kind: 'mark' });
          this.feedBotsReveal(owner.info.team, targets);
        }
      }
      this.alertBots(pos, m.sub ? 15 : 30, owner ?? null);
    } else if (m.kind === 'smoke') {
      this.smokes.push({
        pos: pos.clone(),
        radius: stat('smoke', 'radius', m.tier),
        born: now() / 1000,
        duration: stat('smoke', 'duration', m.tier),
        owner: m.owner,
        team: m.team,
        dps: stat('smoke', 'dps', m.tier) + (m.syn.includes('toxic') ? TOXIC_SYN_DPS : 0),
        tick: 0,
      });
      if (m.syn.includes('blindfog')) this.blindBots(pos, 2.2, m.owner, m.team, 0);
    } else if (m.kind === 'flash') {
      this.blindBots(pos, stat('flash', 'blind', m.tier), m.owner, m.team, stat('flash', 'suppress', m.tier));
    }
  }

  private blindBots(pos: THREE.Vector3, maxBlind: number, owner: string, team: TeamId, suppress: number): void {
    const thrower = this.players.get(owner);
    for (const p of this.players.values()) {
      if (!p.bot || !p.info.alive) continue;
      const eye = p.hitbox.head;
      if (!this.world.lineOfSight(pos, eye)) continue;
      const dist = pos.distanceTo(eye);
      if (dist > 34) continue;
      const to = pos.clone().sub(eye).normalize();
      const view = new THREE.Vector3(-Math.sin(p.yaw) * Math.cos(p.pitch), Math.sin(p.pitch), -Math.cos(p.yaw) * Math.cos(p.pitch));
      const facing = view.dot(to);
      const f = facing > 0.3 ? 1 : facing > -0.2 ? 0.55 : 0.2;
      const dur = maxBlind * f * (1 - Math.max(0, dist - 12) / 22);
      if (dur > 0.4) {
        p.flashedUntil = Math.max(p.flashedUntil, now() + dur * 1000);
        if (suppress > 0 && p.info.team !== team) p.bot.suppress(suppress);
        if (thrower && thrower.info.team !== p.info.team && hasSynergy(thrower.info.abilities, 'markflash')) {
          this.net.broadcast({ t: 'reveal', team: thrower.info.team, targets: [p.info.id], duration: 3, kind: 'mark' });
        }
      }
    }
  }

  smokeBlocks(a: THREE.Vector3, b: THREE.Vector3): boolean {
    const t = now() / 1000;
    const d = b.clone().sub(a);
    const len = d.length();
    d.divideScalar(len || 1);
    for (const s of this.smokes) {
      const age = t - s.born;
      if (age < 1 || age > s.duration - 1.5) continue;
      const c = s.pos.clone().setY(s.pos.y + s.radius * 0.35);
      if (segmentHitsSphere(a, d, len, c, s.radius * 0.85)) return true;
    }
    return false;
  }

  // ---------------------------------------------------------------------------
  // Bots support
  // ---------------------------------------------------------------------------
  /** Server-side hitscan for bots. */
  traceShot(shooter: HostPlayer, origin: THREE.Vector3, dir: THREE.Vector3, range: number): { hit: ShotHit; player: HostPlayer | null; zone: HitZone | null; dist: number; barrier: string | null } {
    const wh = this.world.raycast(origin, dir, range, true);
    let best = wh ? wh.dist : range;
    let player: HostPlayer | null = null;
    let zone: HitZone | null = null;
    for (const p of this.players.values()) {
      if (p === shooter || !p.info.alive) continue;
      const r = p.hitbox.trace(origin, dir, best);
      if (r && r.dist < best) {
        best = r.dist;
        player = p;
        zone = r.zone;
      }
    }
    const end = origin.clone().addScaledVector(dir, best);
    if (player) return { hit: { p: v3(end), k: 1 }, player, zone, dist: best, barrier: null };
    if (wh) {
      const isBarrier = wh.box.tag === 'barrier';
      return { hit: { p: v3(end), n: v3(wh.normal), k: isBarrier ? 3 : 0 }, player: null, zone: null, dist: best, barrier: isBarrier ? (wh.box.ref ?? null) : null };
    }
    return { hit: { p: v3(end), k: 2 }, player: null, zone: null, dist: best, barrier: null };
  }

  botFire(bot: HostPlayer, w: WeaponId, origin: THREE.Vector3, hits: ShotHit[]): void {
    this.net.broadcast({ t: 'fire', id: bot.info.id, w, o: v3(origin), hits });
    this.alertBots(origin, 45, bot);
  }

  botThrow(bot: HostPlayer, kind: ThrowMsg['kind'], pos: THREE.Vector3, vel: THREE.Vector3): void {
    const t = this.abilityTier(bot, kind);
    if (t === null) return;
    const syn: string[] = [];
    for (const s of ['blindfog', 'toxic', 'markflash', 'seeker']) if (hasSynergy(bot.info.abilities, s)) syn.push(s);
    const msg: ThrowMsg = { t: 'throw', gid: `${bot.info.id}-${Math.random().toString(36).slice(2, 7)}`, kind, owner: bot.info.id, team: bot.info.team, pos: v3(pos), vel: v3(vel), tier: t, syn };
    this.onThrow(msg, bot.info.id);
  }

  /** True when a barrier at `pos` would not enclose any living player (bots check before deploying). */
  barrierFits(pos: THREE.Vector3, yaw: number, width: number): boolean {
    const hx = yaw === 0 ? width / 2 : BARRIER_HALF_DEPTH;
    const hz = yaw === 0 ? BARRIER_HALF_DEPTH : width / 2;
    for (const p of this.players.values()) {
      if (!p.info.alive) continue;
      const r = PLAYER.radius + 0.05;
      if (Math.abs(p.pos.x - pos.x) < hx + r && Math.abs(p.pos.z - pos.z) < hz + r && p.pos.y < pos.y + BARRIER_HEIGHT && p.pos.y + PLAYER.heightStand > pos.y) return false;
    }
    return true;
  }

  botBarrier(bot: HostPlayer, pos: THREE.Vector3, yaw: number): void {
    const t = this.abilityTier(bot, 'barrier');
    if (t === null) return;
    this.addBarrier({
      t: 'barrier',
      bid: `${bot.info.id}-b${Math.random().toString(36).slice(2, 6)}`,
      owner: bot.info.id,
      team: bot.info.team,
      pos: v3(pos),
      yaw,
      width: stat('barrier', 'width', t),
      hp: stat('barrier', 'hp', t),
      duration: stat('barrier', 'duration', t),
      regen: hasSynergy(bot.info.abilities, 'regenwall'),
    });
  }

  private alertBots(pos: THREE.Vector3, radius: number, source: HostPlayer | null): void {
    for (const p of this.players.values()) {
      if (!p.bot || !p.info.alive || p === source) continue;
      if (source && source.info.team === p.info.team) continue;
      if (p.pos.distanceTo(pos) < radius) p.bot.hear(pos);
    }
  }

  private feedBotsReveal(team: TeamId, targets: string[]): void {
    for (const p of this.players.values()) {
      if (!p.bot || p.info.team !== team) continue;
      for (const id of targets) {
        const t = this.players.get(id);
        if (t) p.bot.hear(t.pos);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Tick
  // ---------------------------------------------------------------------------
  update(dt: number): void {
    const t = now();
    if (this.pendingNext && t >= this.pendingNext.at) {
      const fn = this.pendingNext.fn;
      this.pendingNext = null;
      fn();
    }
    switch (this.phase) {
      case 'draft':
        if (t >= this.phaseEndsAt && !this.pendingNext) {
          for (const p of this.players.values()) if (!p.draftPicked) this.onDraftPick(p, Math.floor(Math.random() * 3));
        }
        break;
      case 'buy':
        if (t >= this.phaseEndsAt) this.goLive();
        break;
      case 'live': {
        if (this.range) {
          this.tickRange(t);
          this.tickAbilities(dt, t);
          break;
        }
        if (t >= this.phaseEndsAt) {
          const hp: [number, number] = [0, 0];
          for (const p of this.players.values()) if (p.info.alive) hp[p.info.team] += p.info.hp;
          this.endRound(hp[0] === hp[1] ? -1 : hp[0] > hp[1] ? 0 : 1, 'time');
          break;
        }
        if (!this.bigCoinSpawned && t - this.roundStartedAt > TIMING.bigCoinAt * 1000) {
          this.bigCoinSpawned = true;
          const spot = this.map.bigCoinSpots[Math.floor(Math.random() * this.map.bigCoinSpots.length)];
          const id = this.coinSeq++;
          this.coins.set(id, { id, pos: v3(spot), value: ECON.coinBig, big: true });
          this.net.broadcast({ t: 'coins', list: [...this.coins.values()] });
          this.chatSystem('중앙 신호탑에 대형 골드가 출현했습니다!');
        }
        this.tickAbilities(dt, t);
        break;
      }
      default:
        break;
    }

    for (const p of this.players.values()) {
      if (p.bot) p.bot.update(dt);
      else p.hitbox.update(p.pos, p.yaw, p.flags & F.crouch ? 1 : 0, p.pitch, WEAPON_INDEX[p.w]);
    }
    this.projectiles.update(dt, (g) => this.onDetonate(g));

    this.snapTimer += dt;
    if (this.snapTimer >= 1 / 22) {
      this.snapTimer = 0;
      const s: SnapEntry[] = [];
      for (const p of this.players.values()) {
        const f = (p.flags & ~F.alive) | (p.info.alive ? F.alive : 0);
        s.push([p.info.id, Math.round(p.pos.x * 1000) / 1000, Math.round(p.pos.y * 1000) / 1000, Math.round(p.pos.z * 1000) / 1000, Math.round(p.yaw * 1000) / 1000, Math.round(p.pitch * 1000) / 1000, f, p.w]);
      }
      this.net.broadcast({ t: 'snap', ht: t, s }, true);
    }
    this.playersTimer += dt;
    if (this.playersDirty && this.playersTimer > 0.1) this.flushPlayers();
  }

  private tickAbilities(dt: number, t: number): void {
    // Heal over time
    for (const p of this.players.values()) {
      if (p.hot && p.info.alive) {
        const step = Math.min(p.hot.left, dt);
        p.hot.left -= step;
        p.info.hp = Math.min(PLAYER.maxHp, p.info.hp + p.hot.perSec * step);
        this.playersDirty = true;
        if (p.hot.left <= 0) p.hot = null;
      }
    }
    // Barriers: expiry + regen synergy
    for (const [bid, b] of this.barriers) {
      if (t >= b.expires) {
        this.barriers.delete(bid);
        this.net.broadcast({ t: 'barrierGone', bid });
        continue;
      }
      if (b.msg.regen) {
        const c = new THREE.Vector3(...b.msg.pos);
        for (const p of this.players.values()) {
          if (p.info.alive && p.info.team === b.msg.team && p.pos.distanceTo(c) < 4 && p.info.hp < PLAYER.maxHp) {
            p.info.hp = Math.min(PLAYER.maxHp, p.info.hp + 10 * dt);
            this.playersDirty = true;
          }
        }
      }
    }
    // Smokes: expiry + poison ticks
    const ts = t / 1000;
    for (let i = this.smokes.length - 1; i >= 0; i--) {
      const s = this.smokes[i];
      if (ts - s.born > s.duration) {
        this.smokes.splice(i, 1);
        continue;
      }
      if (s.dps <= 0 || ts - s.born < 1) continue;
      s.tick += dt;
      if (s.tick >= 0.5) {
        s.tick -= 0.5;
        const owner = this.players.get(s.owner) ?? null;
        this.batch(() => {
          for (const p of this.players.values()) {
            if (!p.info.alive || p.info.team === s.team) continue;
            if (p.hitbox.center.distanceTo(s.pos) < s.radius * 0.9) this.applyDamage(p, owner, s.dps * 0.5, 'toxic', 'smoke', 1);
          }
        });
      }
    }
  }

  flushPlayers(): void {
    this.playersDirty = false;
    this.playersTimer = 0;
    const list = [...this.players.values()].map((p) => ({ ...p.info, hp: Math.ceil(p.info.hp), armor: Math.round(p.info.armor), abilities: p.info.abilities.map((a) => ({ ...a })) }));
    this.net.broadcast({ t: 'players', list });
  }

  shiftTime(ms: number): void {
    this.phaseEndsAt += ms;
    for (const p of this.players.values()) {
      p.flashedUntil += ms;
      p.spawnLockUntil += ms;
      p.vulnUntil += ms;
      p.bot?.shiftTime(ms);
    }
    this.roundStartedAt += ms;
    for (const [id, at] of this.respawnAt) this.respawnAt.set(id, at + ms);
    if (this.pendingNext) this.pendingNext.at += ms;
    for (const b of this.barriers.values()) b.expires += ms;
    for (const sm of this.smokes) sm.born += ms / 1000;
  }

  weaponIndex(id: WeaponId): number {
    return WEAPON_INDEX.indexOf(id);
  }
}

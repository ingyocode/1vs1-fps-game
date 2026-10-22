import * as THREE from 'three';
import type { HitZone } from '../core/config';
import { clamp, coneDirection, dampAngle, dirFromYawPitch, randRange, wrapAngle } from '../core/utils';
import { F, WEAPON_INDEX, type ShotHit } from '../net/protocol';
import { CharacterMotor, type MoveInput } from './movement';
import { WEAPONS, ZONE_PRIORITY, damageAt, type WeaponId } from './weapons';
import { ABILITIES, CLOAK_FLICKER, ECHO_DELAY, SLOW_MULT, hasSynergy, stat, synergyPartners, tierOf, type AbilityId, type DraftCard, type Tier } from './abilities';
import type { HostPlayer, MatchHost } from './host';
import { GRENADE_GRAVITY, THROW_SPEED } from './projectiles';

export const BOT_NAMES = ['Viper', 'Specter', 'Nomad', 'Rook', 'Kestrel', 'Onyx', 'Halcyon', 'Juno', 'Talon', 'Wraith'];

const SKILL = [
  { reaction: 0.62, aimErr: 0.075, settle: 2.2, turn: 6, headBias: 0.12, burst: [2, 4], fov: 0.42, sprayBloom: 1.6 },
  { reaction: 0.4, aimErr: 0.045, settle: 3.2, turn: 9, headBias: 0.28, burst: [3, 5], fov: 0.34, sprayBloom: 1.25 },
  { reaction: 0.26, aimErr: 0.025, settle: 4.5, turn: 13, headBias: 0.45, burst: [3, 6], fov: 0.26, sprayBloom: 1.0 },
];

interface Ammo {
  mag: number;
  reserve: number;
}

const now = (): number => performance.now();
const _eyeA = new THREE.Vector3();
const _eyeB = new THREE.Vector3();

/** Shooting-range target: holds a station, strafes ADAD-style or crouch-peeks, never fights back. */
export interface DummyRole {
  home: THREE.Vector3;
  yaw: number;
  strafe: number;
  crouch: boolean;
  dir: number;
  flipT: number;
  t: number;
}

export class BotBrain {
  readonly motor = new CharacterMotor();
  dummy: DummyRole | null = null;
  private weapon: WeaponId = 'pistol';
  private ammo = new Map<WeaponId, Ammo>();
  private reloadT = 0;
  private fireCd = 0;
  private bloom = 0;
  private burstLeft = 0;
  private burstPause = 0;
  private lastShot = -10;
  private charges = new Map<AbilityId, number>();
  private recharge = new Map<AbilityId, number>();
  private abilityCd = 0;
  private cloakUntil = 0;
  private flickerUntil = 0;
  private adrenalineUntil = 0;
  private infiniteUntil = 0;
  private suppressUntil = 0;
  private slowUntil = 0;
  private dashAimUntil = 0;
  private echo: { at: number; origin: THREE.Vector3 } | null = null;
  private path: number[] = [];
  private goal: THREE.Vector3 | null = null;
  private repathT = 0;
  private stuckT = 0;
  private target: HostPlayer | null = null;
  private reactT = 0;
  private aimHead = false;
  private aimErrYaw = 0;
  private aimErrPitch = 0;
  private lastSeen: { pos: THREE.Vector3; t: number } | null = null;
  private heard: { pos: THREE.Vector3; t: number } | null = null;
  private strafe = 1;
  private strafeT = 0;
  private crouchT = 0;
  private lookAwayT = 0;
  private retreatT = 0;
  private perceiveT = 0;
  private draftAt = 0;
  private draftOffer: DraftCard[] | null = null;
  private buyAt = 0;
  private liveAt = 0;
  private reconAt = 0;
  private yaw = 0;
  private pitch = 0;
  private wantJump = false;
  private goalCoin = -1;
  private throwFlagUntil = 0;
  private badGoals = new Map<number, number>();
  private readonly eye = new THREE.Vector3();

  constructor(
    private readonly p: HostPlayer,
    private readonly host: MatchHost,
  ) {
    this.motor.teleport(p.pos);
  }

  private get skill(): (typeof SKILL)[number] {
    return SKILL[this.host.settings.botSkill] ?? SKILL[1];
  }

  // ---------------------------------------------------------------------------
  // Lifecycle hooks
  // ---------------------------------------------------------------------------
  scheduleDraft(offer: DraftCard[]): void {
    this.draftOffer = offer;
    this.draftAt = now() + randRange(1200, 3800);
  }

  onRoundStart(): void {
    this.motor.teleport(this.p.pos);
    this.yaw = this.p.yaw;
    this.pitch = 0;
    this.weapon = this.p.info.primary ?? this.p.info.secondary;
    this.ammo.clear();
    this.refillAll();
    this.reloadT = 0;
    this.fireCd = 0;
    this.bloom = 0;
    this.target = null;
    this.lastSeen = null;
    this.heard = null;
    this.path = [];
    this.goal = null;
    this.cloakUntil = this.flickerUntil = this.adrenalineUntil = this.infiniteUntil = 0;
    this.suppressUntil = this.slowUntil = this.dashAimUntil = 0;
    this.echo = null;
    this.refillCharges();
    this.buyAt = now() + randRange(1500, 4500);
  }

  /** A bot replacing a disconnected human mid-round keeps their (unknown) spent state: no free charges. */
  takeOver(): void {
    this.motor.teleport(this.p.pos);
    this.yaw = this.p.yaw;
    this.weapon = this.p.info.primary ?? this.p.info.secondary;
    this.refillAll();
    this.charges.clear();
    this.recharge.clear();
    for (const a of this.p.info.abilities) this.charges.set(a.id, 0);
    this.liveAt = now();
    this.reconAt = this.liveAt + randRange(10000, 18000);
    this.buyAt = this.host.phase === 'buy' ? now() + 1500 : 0;
  }

  /** Offline pause: push every absolute timestamp forward. */
  shiftTime(ms: number): void {
    this.cloakUntil += ms;
    this.flickerUntil += ms;
    this.adrenalineUntil += ms;
    this.infiniteUntil += ms;
    this.suppressUntil += ms;
    this.slowUntil += ms;
    this.dashAimUntil += ms;
    this.reconAt += ms;
    if (this.echo) this.echo.at += ms;
    this.throwFlagUntil += ms;
    this.lastShot += ms;
    if (this.draftAt) this.draftAt += ms;
    if (this.buyAt) this.buyAt += ms;
    this.liveAt += ms;
    if (this.heard) this.heard.t += ms;
    if (this.lastSeen) this.lastSeen.t += ms;
    for (const [k, v] of this.badGoals) this.badGoals.set(k, v + ms);
  }

  onLive(): void {
    this.liveAt = now();
    this.reconAt = this.liveAt + randRange(10000, 18000);
    this.weapon = this.p.info.primary ?? this.p.info.secondary;
    this.refillAll();
  }

  private refillAll(): void {
    for (const id of [this.p.info.primary, this.p.info.secondary]) {
      if (!id || this.ammo.has(id)) continue;
      const d = WEAPONS[id];
      this.ammo.set(id, { mag: d.mag, reserve: d.reserve });
    }
  }

  onDamaged(attacker: HostPlayer | null): void {
    if (!attacker || attacker === this.p) return;
    this.heard = { pos: attacker.pos.clone(), t: now() };
    if (this.lookAwayT > 0) this.lookAwayT = 0;
    // Evasive dash
    if (this.has('dash') && Math.random() < 0.35 && this.abilityCd <= 0) {
      const side = Math.random() < 0.5 ? 1 : -1;
      const dx = Math.cos(this.yaw) * side;
      const dz = -Math.sin(this.yaw) * side;
      this.motor.startDash(dx, dz, stat('dash', 'distance', this.tier('dash')));
      if (stat('dash', 'aim', this.tier('dash')) > 0) this.dashAimUntil = now() + 1200;
      this.use('dash');
      if (hasSynergy(this.p.info.abilities, 'shadowstep')) this.cloakUntil = now() + 1500;
    }
    if (this.p.info.hp < 45 && this.has('heal') && Math.random() < 0.4) {
      this.host.onAbility(this.p, 'heal');
      this.use('heal');
      if (hasSynergy(this.p.info.abilities, 'secondwind')) this.adrenalineUntil = Math.max(this.adrenalineUntil, now() + 3000);
    }
  }

  hear(pos: THREE.Vector3): void {
    this.heard = { pos: pos.clone(), t: now() };
  }

  slow(duration: number): void {
    this.slowUntil = Math.max(this.slowUntil, now() + duration * 1000);
  }

  suppress(duration: number): void {
    this.suppressUntil = Math.max(this.suppressUntil, now() + duration * 1000);
  }

  /** A bonus draft card changed the loadout mid buy phase: new abilities start charged. */
  onAbilitiesChanged(): void {
    this.refillCharges();
  }

  /** Kill rewards of awakened dash / adrenaline (the adrenaline heal is applied by the host). */
  onKill(): void {
    const dash = tierOf(this.p.info.abilities, 'dash');
    if (dash !== null && stat('dash', 'aim', dash) > 0) this.charges.set('dash', Math.min(stat('dash', 'charges', dash), (this.charges.get('dash') ?? 0) + 1));
    const adr = tierOf(this.p.info.abilities, 'adrenaline');
    if (adr !== null && now() < this.adrenalineUntil && stat('adrenaline', 'killHeal', adr) > 0) this.adrenalineUntil = now() + stat('adrenaline', 'duration', adr) * 1000;
  }

  // ---------------------------------------------------------------------------
  // Ability helpers
  // ---------------------------------------------------------------------------
  private tier(id: AbilityId): Tier {
    return tierOf(this.p.info.abilities, id) ?? 0;
  }

  private has(id: AbilityId): boolean {
    return (this.charges.get(id) ?? 0) > 0 && this.abilityCd <= 0 && now() >= this.suppressUntil;
  }

  private refillCharges(): void {
    this.charges.clear();
    this.recharge.clear();
    for (const a of this.p.info.abilities) this.charges.set(a.id, stat(a.id, 'charges', a.tier));
  }

  /** Charges come back over time for abilities with a recharge. */
  private tickRecharge(dt: number): void {
    for (const a of this.p.info.abilities) {
      const rc = stat(a.id, 'recharge', a.tier);
      const c = this.charges.get(a.id) ?? 0;
      if (rc <= 0 || c >= stat(a.id, 'charges', a.tier)) continue;
      const acc = (this.recharge.get(a.id) ?? 0) + dt;
      if (acc >= rc) {
        this.charges.set(a.id, c + 1);
        this.recharge.set(a.id, 0);
      } else this.recharge.set(a.id, acc);
    }
  }

  private instantReload(): void {
    const a = this.ammo.get(this.weapon);
    const d = WEAPONS[this.weapon];
    if (!a || d.slot === 'melee') return;
    const take = Math.min(d.mag - a.mag, a.reserve);
    a.mag += take;
    a.reserve -= take;
    this.reloadT = 0;
  }

  private pulse(origin: THREE.Vector3): void {
    const tr = this.tier('recon');
    const r = stat('recon', 'radius', tr);
    const targets = [...this.host.players.values()].filter((e) => e.info.alive && e.info.team !== this.p.info.team && e.pos.distanceTo(origin) < r);
    this.host.pulseReveal(this.p, targets.map((e) => e.info.id), stat('recon', 'reveal', tr), [origin.x, origin.y, origin.z], 'pulse');
    if (targets.length) this.heard = { pos: targets[0].pos.clone(), t: now() };
  }

  private use(id: AbilityId): void {
    this.charges.set(id, (this.charges.get(id) ?? 1) - 1);
    this.abilityCd = 1.2;
    if (ABILITIES[id].type !== 'throw' && id !== 'heal' && id !== 'barrier') this.host.net.broadcast({ t: 'ability', id: this.p.info.id, ability: id });
  }

  private throwAt(kind: 'flash' | 'smoke' | 'frag', target: THREE.Vector3): void {
    const from = this.eye.clone();
    const dx = target.x - from.x;
    const dz = target.z - from.z;
    const dist = Math.hypot(dx, dz);
    const s = clamp((dist * GRENADE_GRAVITY) / (THROW_SPEED * THROW_SPEED), 0, 1);
    const angle = 0.5 * Math.asin(s) + 0.05;
    const yaw = Math.atan2(-dx, -dz);
    const dir = dirFromYawPitch(yaw, angle);
    const pos = from.addScaledVector(dir, 0.5);
    this.host.botThrow(this.p, kind, pos, dir.multiplyScalar(THROW_SPEED));
    this.use(kind);
    this.throwFlagUntil = now() + 350;
  }

  // ---------------------------------------------------------------------------
  // Main update
  // ---------------------------------------------------------------------------
  update(dt: number): void {
    const p = this.p;
    const t = now();
    const phase = this.host.phase;
    // Regular drafts, and bonus cards earned by losses (offered during the buy phase).
    if ((phase === 'draft' || phase === 'buy') && this.draftOffer && t >= this.draftAt && !p.draftPicked) {
      this.host.onDraftPick(p, this.chooseCard(this.draftOffer));
      this.draftOffer = null;
    }
    if (!p.info.alive) {
      p.flags = 0;
      return;
    }
    if (phase === 'buy' && this.buyAt > 0 && t >= this.buyAt) {
      this.buyAt = 0;
      this.shop();
    }
    this.abilityCd = Math.max(0, this.abilityCd - dt);
    if (phase === 'live') {
      this.tickRecharge(dt);
      if (this.echo && t >= this.echo.at) {
        this.pulse(this.echo.origin);
        this.echo = null;
      }
    }
    this.fireCd = Math.max(0, this.fireCd - dt);
    this.burstPause = Math.max(0, this.burstPause - dt);
    this.bloom = Math.max(0, this.bloom - dt * WEAPONS[this.weapon].spread.recover * 0.5);
    this.lookAwayT = Math.max(0, this.lookAwayT - dt);
    this.retreatT = Math.max(0, this.retreatT - dt);
    this.eye.set(this.motor.body.pos.x, this.motor.body.pos.y + this.motor.eyeHeight, this.motor.body.pos.z);

    let input: MoveInput = { forward: 0, right: 0, jump: false, crouch: false, walk: false, yaw: this.yaw };
    if (this.dummy) input = this.dummyInput(dt);
    else if (phase === 'live') input = this.think(dt, t);
    else if (phase === 'buy') {
      this.yaw = dampAngle(this.yaw, p.yaw, 4, dt);
      // keep the latest loadout in hand
      const want = p.info.primary ?? p.info.secondary;
      if (want !== this.weapon) {
        this.weapon = want;
        this.refillAll();
      }
    }

    // Reload
    if (this.reloadT > 0) {
      this.reloadT -= dt * (t < this.adrenalineUntil ? 1.2 : 1);
      if (this.reloadT <= 0) {
        const a = this.ammo.get(this.weapon);
        const d = WEAPONS[this.weapon];
        if (a) {
          const need = d.mag - a.mag;
          const take = Math.min(need, a.reserve);
          a.mag += take;
          a.reserve -= take;
        }
      }
    }

    const speedMult = WEAPONS[this.weapon].moveSpeed * (t < this.adrenalineUntil ? stat('adrenaline', 'speed', this.tier('adrenaline')) : 1) * (t < this.slowUntil ? SLOW_MULT : 1);
    const frozen = phase === 'roundEnd' || phase === 'matchEnd' || phase === 'draft';
    const ev = this.motor.step(input, dt, this.host.world, speedMult, frozen);
    if (ev.jumped) this.wantJump = false;

    // Bots pick up gold the same way players do (host-validated).
    if (phase === 'live') {
      const bp = this.motor.body.pos;
      for (const c of this.host.coins.values()) {
        const dx = c.pos[0] - bp.x;
        const dz = c.pos[2] - bp.z;
        if (dx * dx + dz * dz < (c.big ? 1.3 : 1.0) ** 2 && Math.abs(c.pos[1] - (bp.y + 0.6)) < 1.3) {
          this.host.onCoin(p, c.id);
          break;
        }
      }
    }

    // Write back to the shared host record
    p.pos.copy(this.motor.body.pos);
    p.vel.copy(this.motor.body.vel);
    p.yaw = this.yaw;
    p.pitch = this.pitch;
    p.w = WEAPON_INDEX.indexOf(this.weapon);
    let f = F.alive;
    if (this.motor.crouch > 0.5) f |= F.crouch;
    if (this.motor.body.onGround) f |= F.ground;
    if (t < this.cloakUntil && t >= this.flickerUntil) f |= F.cloak;
    if (t < this.adrenalineUntil) f |= F.adrenaline;
    if (t < this.infiniteUntil) f |= F.infinite;
    if (this.reloadT > 0) f |= F.reload;
    if (t - this.lastShot < 120) f |= F.fired;
    if (this.motor.dashTime > 0) f |= F.dash;
    if (t < this.throwFlagUntil) f |= F.throwing;
    p.flags = f;
    p.hitbox.update(p.pos, p.yaw, this.motor.crouch, p.pitch, this.weapon);
  }

  private dummyInput(dt: number): MoveInput {
    const d = this.dummy!;
    d.t += dt;
    this.yaw = d.yaw;
    this.pitch = 0;
    const input: MoveInput = { forward: 0, right: 0, jump: false, crouch: false, walk: false, yaw: d.yaw };
    if (d.strafe > 0) {
      // Lateral offset from home along the target's right axis; turn around at the lane edge
      // and every so often in between, like a player jiggling a corner.
      const off = (this.motor.body.pos.x - d.home.x) * Math.cos(d.yaw) - (this.motor.body.pos.z - d.home.z) * Math.sin(d.yaw);
      d.flipT -= dt;
      if (off > d.strafe) d.dir = -1;
      else if (off < -d.strafe) d.dir = 1;
      else if (d.flipT <= 0) {
        d.flipT = randRange(0.45, 1.3);
        if (Math.random() < 0.45) d.dir = -d.dir;
      }
      input.right = d.dir;
      input.walk = Math.sin(d.t * 0.7) > 0.6;
    }
    if (d.crouch) input.crouch = Math.sin(d.t * 1.5) > 0.2;
    return input;
  }

  private chooseCard(offer: DraftCard[]): number {
    let best = 0;
    let score = -1;
    offer.forEach((c, i) => {
      // Bots lean toward committing to a path, but still branch out into synergies.
      let s = Math.random() * 10 + (c.tier > 0 ? 2 + c.tier : 0);
      if (c.tier === 0 && synergyPartners(c.ability).some((sp) => this.p.info.abilities.some((a) => a.id === sp.partner))) s += 3;
      if (s > score) {
        score = s;
        best = i;
      }
    });
    return best;
  }

  private shop(): void {
    const p = this.p;
    const buy = (item: string): void => this.host.onBuy(p, item);
    if (!p.info.primary) {
      const g = p.info.gold;
      if (g >= 5100 && this.host.settings.botSkill >= 1 && Math.random() < 0.25) buy('sniper');
      else if (g >= 2900) buy('rifle');
      else if (g >= 1600 && Math.random() < 0.35) buy('shotgun');
      else if (g >= 1300) buy('smg');
      else if (g >= 700 && p.info.secondary === 'pistol') buy('magnum');
    }
    if (p.info.armor < 50 && p.info.gold >= 1000) buy('armorHeavy');
    else if (p.info.armor < 25 && p.info.gold >= 400) buy('armorLight');
    const want = p.info.primary ?? p.info.secondary;
    this.weapon = want;
    this.ammo.clear();
    this.refillAll();
    this.refillCharges();
  }

  // ---------------------------------------------------------------------------
  // Perception, aiming, movement
  // ---------------------------------------------------------------------------
  private perceive(t: number): HostPlayer | null {
    if (t < this.p.flashedUntil) return null;
    const view = dirFromYawPitch(this.yaw, this.pitch);
    let best: HostPlayer | null = null;
    let bestD = Infinity;
    for (const e of this.host.players.values()) {
      if (!e.info.alive || e.info.team === this.p.info.team) continue;
      const c = e.hitbox.center;
      const d = this.eye.distanceTo(c);
      if (d > 85) continue;
      const cloaked = (e.flags & F.cloak) !== 0;
      if (cloaked && d > 4.5) continue;
      const to = c.clone().sub(this.eye).normalize();
      const inFov = view.dot(to) > Math.cos(1.25) || d < 4;
      // keep tracking a current target even at the edge of view
      if (!inFov && e !== this.target) continue;
      const visible = this.host.world.lineOfSight(this.eye, e.hitbox.head) || this.host.world.lineOfSight(this.eye, c);
      if (!visible) continue;
      if (this.host.smokeBlocks(this.eye, c)) continue;
      if (d < bestD) {
        bestD = d;
        best = e;
      }
    }
    return best;
  }

  private think(dt: number, t: number): MoveInput {
    const sk = this.skill;
    const def = WEAPONS[this.weapon];
    this.perceiveT -= dt;
    if (this.perceiveT <= 0) {
      this.perceiveT = 0.1;
      const seen = this.perceive(t);
      if (seen && seen !== this.target) {
        // New contact: human-like reaction delay and initial aim error.
        this.reactT = sk.reaction * randRange(0.8, 1.35);
        this.aimErrYaw = (Math.random() - 0.5) * 2 * sk.aimErr * 2.2;
        this.aimErrPitch = (Math.random() - 0.5) * 2 * sk.aimErr * 1.4;
        this.aimHead = Math.random() < sk.headBias;
        this.burstLeft = 0;
        this.onEngage(seen, t);
      }
      this.target = seen;
      if (seen) this.lastSeen = { pos: seen.pos.clone(), t };
    }
    const tgt = this.target;
    const input: MoveInput = { forward: 0, right: 0, jump: this.wantJump, crouch: false, walk: false, yaw: this.yaw };

    if (tgt && this.lookAwayT <= 0) {
      this.reactT -= dt;
      const aimPoint = this.aimHead ? tgt.hitbox.head : tgt.hitbox.torsoB.clone().lerp(tgt.hitbox.torsoA, 0.4);
      const to = aimPoint.clone().sub(this.eye);
      const dist = to.length();
      const wantYaw = Math.atan2(-to.x, -to.z) + this.aimErrYaw;
      const wantPitch = Math.asin(clamp(to.y / dist, -1, 1)) + this.aimErrPitch;
      const decay = Math.exp(-sk.settle * dt);
      this.aimErrYaw *= decay;
      this.aimErrPitch *= decay;
      const turn = sk.turn * (t < this.p.flashedUntil ? 0.2 : 1);
      this.yaw = dampAngle(this.yaw, wantYaw, turn, dt);
      this.pitch = dampAngle(this.pitch, wantPitch, turn, dt);
      const err = Math.hypot(wrapAngle(this.yaw - (wantYaw - this.aimErrYaw)), this.pitch - (wantPitch - this.aimErrPitch));
      const tol = Math.atan2(this.aimHead ? 0.14 : 0.24, dist) + 0.01;

      // Combat movement
      this.strafeT -= dt;
      if (this.strafeT <= 0) {
        this.strafeT = randRange(0.35, 0.95);
        this.strafe = Math.random() < 0.5 ? -1 : 1;
        if (Math.random() < 0.15) this.strafe = 0;
      }
      const close = def.id === 'shotgun' || def.id === 'smg' || def.id === 'knife';
      let fwd = 0;
      if (this.retreatT > 0) fwd = -1;
      else if (close && dist > (def.id === 'knife' ? 1.5 : 7)) fwd = 1;
      else if (!close && dist < 5) fwd = -0.6;
      const counterStrafe = this.host.settings.botSkill >= 1 && (def.id === 'rifle' || def.id === 'sniper' || def.id === 'magnum') && err < tol * 2.5 && this.reactT <= 0;
      input.forward = fwd;
      input.right = counterStrafe ? 0 : this.strafe;
      input.yaw = this.yaw;
      this.crouchT -= dt;
      if (this.crouchT <= 0) this.crouchT = randRange(0.6, 1.6);
      input.crouch = this.host.settings.botSkill === 2 && this.crouchT < 0.5 && def.id === 'rifle';

      if (this.reactT <= 0 && err < tol) this.tryFire(dist);
    } else {
      if (tgt && this.lookAwayT > 0) {
        // turned away from own flash
        this.yaw = dampAngle(this.yaw, Math.atan2(-(this.eye.x - tgt.pos.x), -(this.eye.z - tgt.pos.z)), 10, dt);
      }
      this.navigate(dt, t, input);
      // Reload during quiet moments
      const a = this.ammo.get(this.weapon);
      if (a && this.reloadT <= 0 && a.mag < WEAPONS[this.weapon].mag * 0.5 && a.reserve > 0 && WEAPONS[this.weapon].slot !== 'melee') this.startReload();
      this.idleAbilities(t);
    }
    return input;
  }

  private onEngage(e: HostPlayer, t: number): void {
    const d = this.eye.distanceTo(e.pos);
    if (this.has('flash') && d > 7 && d < 28 && Math.random() < 0.3) {
      this.throwAt('flash', e.pos.clone().lerp(this.eye, 0.35));
      this.lookAwayT = 0.9;
      return;
    }
    if (this.has('adrenaline') && Math.random() < 0.55) {
      this.adrenalineUntil = t + stat('adrenaline', 'duration', this.tier('adrenaline')) * 1000;
      if (stat('adrenaline', 'reload', this.tier('adrenaline')) > 0) this.instantReload();
      this.use('adrenaline');
      if (hasSynergy(this.p.info.abilities, 'berserk')) this.infiniteUntil = t + stat('infinite', 'duration', this.tier('infinite')) * 600;
    } else if (this.has('infinite') && Math.random() < 0.5) {
      this.infiniteUntil = t + stat('infinite', 'duration', this.tier('infinite')) * 1000;
      this.use('infinite');
      if (hasSynergy(this.p.info.abilities, 'berserk')) this.adrenalineUntil = t + stat('adrenaline', 'duration', this.tier('adrenaline')) * 600;
    }
    if (this.has('barrier') && this.p.info.hp < 60 && d > 9 && Math.random() < 0.5) {
      const dir = e.pos.clone().sub(this.motor.body.pos).setY(0).normalize();
      // Same placement rules as players: clear of walls, on the ground, never around a body.
      const eye = this.eye.clone();
      const wall = this.host.world.raycast(eye, dir, 2.6, true);
      const dist = wall ? wall.dist - 0.45 : 2.2;
      const pos = this.motor.body.pos.clone().addScaledVector(dir, dist);
      const g = this.host.world.groundBelow(new THREE.Vector3(pos.x, pos.y + 1.2, pos.z), 0.05, 4);
      if (g !== null) pos.y = g;
      const yaw = Math.abs(dir.x) > Math.abs(dir.z) ? Math.PI / 2 : 0;
      if (dist >= 1.2 && this.host.barrierFits(pos, yaw, stat('barrier', 'width', this.tier('barrier')))) {
        this.host.botBarrier(this.p, pos, yaw);
        this.use('barrier');
      }
    }
    if (this.has('smoke') && stat('smoke', 'dps', this.tier('smoke')) > 0 && d > 6 && d < 24 && Math.random() < 0.3) {
      // Poison smoke is offensive: drop it on the enemy to flush them out.
      this.throwAt('smoke', e.pos.clone());
    } else if (this.has('smoke') && this.p.info.hp < 40) {
      this.throwAt('smoke', this.motor.body.pos.clone().lerp(e.pos, 0.3));
      this.retreatT = 3;
    }
  }

  private idleAbilities(t: number): void {
    if (this.lastSeen && t - this.lastSeen.t < 3500 && t - this.lastSeen.t > 600 && this.has('frag')) {
      const d = this.eye.distanceTo(this.lastSeen.pos);
      if (d > 7 && d < 26 && Math.random() < 0.02) this.throwAt('frag', this.lastSeen.pos);
    }
    if (t >= this.reconAt && this.has('recon')) {
      this.reconAt = t + randRange(12000, 20000);
      this.use('recon');
      this.pulse(this.eye.clone());
      if (stat('recon', 'echo', this.tier('recon')) > 0) this.echo = { at: t + ECHO_DELAY * 1000, origin: this.eye.clone() };
    }
    if (this.p.info.hp < 60 && this.has('heal') && Math.random() < 0.02) {
      this.host.onAbility(this.p, 'heal');
      this.use('heal');
    }
    if (this.has('cloak') && Math.random() < 0.002) {
      this.cloakUntil = t + stat('cloak', 'duration', this.tier('cloak')) * 1000;
      this.flickerUntil = 0;
      this.use('cloak');
    }
  }

  private navigate(dt: number, t: number, input: MoveInput): void {
    const body = this.motor.body;
    this.repathT -= dt;
    let desired: THREE.Vector3 | null = null;
    if (this.heard && t - this.heard.t < 7000) desired = this.heard.pos;
    else if (this.lastSeen && t - this.lastSeen.t < 8000) desired = this.lastSeen.pos;
    else {
      let bestCoin: THREE.Vector3 | null = null;
      let bestCoinId = -1;
      let bd = 20;
      for (const c of this.host.coins.values()) {
        if ((this.badGoals.get(c.id) ?? 0) > t) continue;
        const cp = new THREE.Vector3(c.pos[0], c.pos[1] - 0.55, c.pos[2]);
        const d = cp.distanceTo(body.pos);
        if (d < bd) {
          bd = d;
          bestCoin = cp;
          bestCoinId = c.id;
        }
      }
      if (bestCoin) {
        desired = bestCoin;
        this.goalCoin = bestCoinId;
      }
    }
    if (desired && (!this.goal || this.goal.distanceTo(desired) > 3)) {
      this.goal = desired.clone();
      this.repathT = 0;
    }
    if (!this.goal || this.repathT <= 0) {
      if (!desired && (!this.goal || this.goal.distanceTo(body.pos) < 2 || this.repathT <= 0)) this.goal = this.pickPatrolGoal();
      const goal = this.goal!;
      const eye = _eyeA.set(body.pos.x, body.pos.y + 0.9, body.pos.z);
      const geye = _eyeB.set(goal.x, goal.y + 0.9, goal.z);
      if (goal.distanceTo(body.pos) < 8 && Math.abs(goal.y - body.pos.y) < 0.5 && this.host.world.lineOfSight(eye, geye)) {
        this.path = [];
      } else {
        const nav = this.host.nav;
        this.path = nav.path(nav.nearest(body.pos, this.host.world), nav.nearest(goal));
      }
      this.repathT = randRange(5, 9);
    }
    let next: THREE.Vector3 | null = null;
    while (this.path.length) {
      const n = this.host.nav.nodes[this.path[0]];
      if (Math.hypot(n.x - body.pos.x, n.z - body.pos.z) < 0.8) this.path.shift();
      else {
        next = n;
        break;
      }
    }
    if (!next && this.goal && this.goal.distanceTo(body.pos) > 0.8) next = this.goal;
    if (!next) {
      // Arrived: forget the goal so a fresh one is chosen next frame.
      if (this.goalCoin >= 0) this.badGoals.set(this.goalCoin, t + 8000);
      this.goal = null;
      this.goalCoin = -1;
      if (this.heard && this.heard.pos.distanceTo(body.pos) < 2) this.heard = null;
      if (this.lastSeen && this.lastSeen.pos.distanceTo(body.pos) < 2) this.lastSeen = null;
    }
    if (next) {
      const moveYaw = Math.atan2(-(next.x - body.pos.x), -(next.z - body.pos.z));
      input.forward = 1;
      input.right = 0;
      input.yaw = moveYaw;
      input.walk = this.retreatT <= 0 && !!this.heard && t - this.heard.t < 4000 && Math.random() < 0.02;
      if (this.lookAwayT <= 0) {
        const lookTarget = this.heard && t - this.heard.t < 3000 ? Math.atan2(-(this.heard.pos.x - body.pos.x), -(this.heard.pos.z - body.pos.z)) : moveYaw;
        this.yaw = dampAngle(this.yaw, lookTarget, 5, dt);
        this.pitch = dampAngle(this.pitch, 0, 4, dt);
      }
      // Stuck detection
      if (this.motor.speed2D < 0.6) {
        this.stuckT += dt;
        if (this.stuckT > 0.7) this.wantJump = true;
        if (this.stuckT > 2.2) {
          this.stuckT = 0;
          // Give up on whatever we were chasing for a while.
          if (this.goalCoin >= 0) this.badGoals.set(this.goalCoin, t + 12000);
          this.heard = null;
          this.goalCoin = -1;
          this.goal = this.pickPatrolGoal();
          this.repathT = 0;
        }
      } else this.stuckT = 0;
    }
    input.jump = this.wantJump;
  }

  private pickPatrolGoal(): THREE.Vector3 {
    const nodes = this.host.nav.nodes;
    const enemySide = this.p.info.team === 0 ? 1 : -1;
    for (let i = 0; i < 12; i++) {
      const n = nodes[Math.floor(Math.random() * nodes.length)];
      if (n.x * enemySide > -8 || Math.random() < 0.2) return n.clone();
    }
    return nodes[Math.floor(Math.random() * nodes.length)].clone();
  }

  private startReload(): void {
    const d = WEAPONS[this.weapon];
    const a = this.ammo.get(this.weapon);
    if (!a || a.reserve <= 0 || a.mag >= d.mag || d.slot === 'melee') return;
    this.reloadT = d.shellReload ? d.shellReload.start + d.shellReload.perShell * (d.mag - a.mag) : d.reloadTime;
  }

  private tryFire(dist: number): void {
    const t = now();
    const def = WEAPONS[this.weapon];
    if (this.fireCd > 0 || this.reloadT > 0) return;
    if (this.burstPause > 0) return;
    const a = this.ammo.get(this.weapon);
    const infinite = t < this.infiniteUntil;
    if (def.slot !== 'melee') {
      if (!a) return;
      if (a.mag <= 0 && !infinite) {
        if (a.reserve > 0) this.startReload();
        else if (this.weapon !== this.p.info.secondary) this.weapon = this.p.info.secondary;
        return;
      }
    } else if (dist > (def.meleeRange ?? 2.3)) return;

    const fireMult = (t < this.adrenalineUntil ? stat('adrenaline', 'fire', this.tier('adrenaline')) : 1) * (infinite ? stat('infinite', 'fireRate', this.tier('infinite')) : 1);
    this.fireCd = 60 / def.rpm / fireMult + (def.auto ? 0 : randRange(0.06, 0.2));
    if (def.auto) {
      if (this.burstLeft <= 0) this.burstLeft = Math.round(randRange(this.skill.burst[0], this.skill.burst[1]));
      this.burstLeft--;
      if (this.burstLeft <= 0) this.burstPause = randRange(0.18, 0.4);
    }
    if (a && !infinite && def.slot !== 'melee') a.mag--;
    this.lastShot = t;
    if (t < this.cloakUntil) {
      // An awakened cloak (or phantom during infinite) only flickers when firing.
      if (stat('cloak', 'phantom', this.tier('cloak')) > 0 || (infinite && hasSynergy(this.p.info.abilities, 'phantom'))) this.flickerUntil = t + CLOAK_FLICKER * 1000;
      else this.cloakUntil = 0;
    }

    const view = dirFromYawPitch(this.yaw, this.pitch);
    const speed = this.motor.speed2D;
    const moveK = clamp((speed - 1.2) / 5, 0, 1);
    const sniperAds = def.id === 'sniper' && speed < 1;
    const precise = t < this.dashAimUntil;
    let spread = (sniperAds ? def.spread.ads : def.spread.hip) + (precise ? 0 : def.spread.move * moveK) + (this.motor.body.onGround || precise ? 0 : def.spread.air) + this.bloom * this.skill.sprayBloom;
    if (this.motor.crouch > 0.5) spread *= def.spread.crouch;
    this.bloom = Math.min(def.spread.bloomMax + 0.02, this.bloom + def.spread.bloom + (def.auto ? 0.004 : 0));

    const hits: ShotHit[] = [];
    const perTarget = new Map<HostPlayer, { dmg: number; zone: HitZone; dist: number }>();
    const pellets = def.slot === 'melee' ? 1 : def.pellets;
    for (let i = 0; i < pellets; i++) {
      const dir = def.slot === 'melee' ? view : coneDirection(view, spread);
      const res = this.host.traceShot(this.p, this.eye, dir, def.slot === 'melee' ? (def.meleeRange ?? 2.3) : 300);
      if (def.slot !== 'melee') hits.push(res.hit);
      if (res.player && res.zone && res.player.info.team !== this.p.info.team) {
        let dmg = damageAt(def, res.dist, res.zone);
        if (def.slot === 'melee') {
          const behind = Math.cos(wrapAngle(res.player.yaw - this.yaw)) > 0.5;
          dmg = behind ? 110 : def.damage;
        }
        const cur = perTarget.get(res.player);
        if (cur) {
          cur.dmg += dmg;
          if (ZONE_PRIORITY[res.zone] > ZONE_PRIORITY[cur.zone]) cur.zone = res.zone;
        } else perTarget.set(res.player, { dmg, zone: res.zone, dist: res.dist });
      } else if (res.barrier) this.host.damageBarrier(res.barrier, def.damage, this.p);
    }
    this.host.botFire(this.p, this.weapon, this.eye.clone().add(new THREE.Vector3(0, -0.12, 0)), hits);
    for (const [target, r] of perTarget) this.host.applyDamage(target, this.p, r.dmg, r.zone, this.weapon, def.armorPen);
  }
}

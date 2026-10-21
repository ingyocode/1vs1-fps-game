import * as THREE from 'three';
import { PLAYER, type HitZone, type TeamId } from '../core/config';
import type { Input } from '../core/input';
import { clamp, coneDirection, dirFromYawPitch, lerp, wrapAngle } from '../core/utils';
import type { CollisionWorld } from '../world/collision';
import { F } from '../net/protocol';
import { CharacterMotor } from './movement';
import { WEAPONS, damageAt, type WeaponDef, type WeaponId } from './weapons';
import { ABILITIES, CLOAK_FLICKER, ECHO_DELAY, SLOW_MULT, hasSynergy, stat, type AbilityId, type OwnedAbility, type ThrowKind, type Tier } from './abilities';
import { THROW_SPEED } from './projectiles';

export interface TraceResult {
  dist: number;
  point: THREE.Vector3;
  normal: THREE.Vector3 | null;
  kind: 'world' | 'player' | 'barrier' | 'none';
  playerId?: string;
  zone?: HitZone;
  barrierId?: string;
  /** Yaw of the victim (for backstabs). */
  victimYaw?: number;
}

export interface ShotResult {
  trace: TraceResult;
  dir: THREE.Vector3;
  damage: number;
}

export interface PlayerHooks {
  trace(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number): TraceResult;
  onShot(def: WeaponDef, origin: THREE.Vector3, shots: ShotResult[], infinite: boolean): void;
  onThrow(kind: ThrowKind, pos: THREE.Vector3, vel: THREE.Vector3, tier: Tier): void;
  onAbility(id: AbilityId, tier: Tier): void;
  onRecon(origin: THREE.Vector3, radius: number, duration: number): void;
  onBarrier(pos: THREE.Vector3, yaw: number, tier: Tier): void;
  onFootstep(): void;
  onJump(): void;
  onLand(speed: number): void;
  onWeaponSwitched(id: WeaponId, equipTime: number): void;
  onReloadStart(def: WeaponDef, duration: number): void;
  onReloadEvent(kind: 'magOut' | 'magIn' | 'shell' | 'bolt' | 'pump'): void;
  onDryFire(): void;
  onThrowAnim(kind: ThrowKind): void;
  onMelee(heavy: boolean): void;
  onInspect(): void;
}

export interface AbilitySlot {
  id: AbilityId;
  tier: Tier;
  charges: number;
  max: number;
  recharge: number;
}

export interface PlayerFrame {
  input: Input;
  lookDX: number;
  lookDY: number;
  world: CollisionWorld;
  frozen: boolean;
  canShoot: boolean;
  canUseAbilities: boolean;
  sens: number;
  adsSens: number;
  invertY: boolean;
  adsToggle: boolean;
}

const _origin = new THREE.Vector3();

export class LocalPlayer {
  readonly motor = new CharacterMotor();
  team: TeamId = 0;
  alive = false;
  yaw = 0;
  pitch = 0;
  recoilPitch = 0;
  recoilYaw = 0;
  primary: WeaponId | null = null;
  secondary: WeaponId = 'pistol';
  current: WeaponId = 'pistol';
  private last: WeaponId = 'knife';
  readonly ammo = new Map<WeaponId, { mag: number; reserve: number }>();
  fireCd = 0;
  equipT = 0;
  reloadT = 0;
  reloadTotal = 0;
  private reloadEvents: { at: number; kind: 'magOut' | 'magIn' | 'bolt' }[] = [];
  private shellState: { phase: 'start' | 'shell' | 'end'; t: number } | null = null;
  boltT = 0;
  shotIndex = 0;
  lastShotAt = -10;
  bloom = 0;
  adsT = 0;
  private adsLatched = false;
  private triggerReleased = true;
  abilities: AbilitySlot[] = [];
  infiniteT = 0;
  adrenalineT = 0;
  cloakT = 0;
  throwCd = 0;
  /** Abilities locked by an awakened flash. */
  suppressT = 0;
  /** Concussed by an enhanced frag. */
  slowT = 0;
  /** An awakened cloak shows briefly after each shot instead of breaking. */
  private flickerT = 0;
  /** Awakened dash: no movement spread right after dashing. */
  private dashAimT = 0;
  private echo: { t: number; origin: THREE.Vector3; radius: number; duration: number } | null = null;
  private pendingThrow: { kind: ThrowKind; t: number; tier: Tier } | null = null;
  flashT = 0;
  flashMax = 0;
  landDip = 0;
  time = 0;
  owned: OwnedAbility[] = [];

  constructor(private hooks: PlayerHooks) {}

  get def(): WeaponDef {
    return WEAPONS[this.current];
  }

  get eye(): THREE.Vector3 {
    const b = this.motor.body;
    return new THREE.Vector3(b.pos.x, b.pos.y + this.motor.eyeHeight + b.stepOffset - this.landDip, b.pos.z);
  }

  get viewDir(): THREE.Vector3 {
    return dirFromYawPitch(this.yaw + this.recoilYaw, this.pitch + this.recoilPitch);
  }

  get reloading(): boolean {
    return this.reloadT > 0 || this.shellState !== null;
  }

  get adrenalineMult(): number {
    return this.adrenalineT > 0 ? stat('adrenaline', 'fire', this.tierOf('adrenaline')) : 1;
  }

  tierOf(id: AbilityId): Tier {
    return this.owned.find((o) => o.id === id)?.tier ?? 0;
  }

  // ---------------------------------------------------------------------------
  // Loadout
  // ---------------------------------------------------------------------------
  /** Called on every roster update from the host. */
  syncLoadout(primary: WeaponId | null, secondary: WeaponId, abilities: OwnedAbility[]): void {
    const gotPrimary = primary && primary !== this.primary;
    const gotSecondary = secondary !== this.secondary;
    this.primary = primary;
    this.secondary = secondary;
    if (gotPrimary && primary) {
      this.ammo.set(primary, { mag: WEAPONS[primary].mag, reserve: WEAPONS[primary].reserve });
      this.equip(primary);
    }
    if (gotSecondary) {
      this.ammo.set(secondary, { mag: WEAPONS[secondary].mag, reserve: WEAPONS[secondary].reserve });
      if (!primary || this.current === 'pistol' || this.current === 'magnum') this.equip(secondary);
    }
    if (!primary && this.current !== secondary && this.current !== 'knife') this.equip(secondary);
    // Tier upgrades keep current charges but refresh maxima.
    const prev = new Map(this.abilities.map((a) => [a.id, a]));
    this.owned = abilities.map((a) => ({ ...a }));
    this.abilities = abilities.map((a) => {
      const max = stat(a.id, 'charges', a.tier);
      const old = prev.get(a.id);
      const charges = old ? Math.min(max, old.charges + Math.max(0, max - old.max)) : max;
      return { id: a.id, tier: a.tier, charges, max, recharge: old?.recharge ?? 0 };
    });
  }

  spawn(pos: THREE.Vector3, yaw: number): void {
    this.motor.teleport(pos);
    this.yaw = yaw;
    this.pitch = 0;
    this.recoilPitch = this.recoilYaw = 0;
    this.alive = true;
    this.ammo.clear();
    for (const id of [this.primary, this.secondary]) if (id) this.ammo.set(id, { mag: WEAPONS[id].mag, reserve: WEAPONS[id].reserve });
    this.reloadT = 0;
    this.shellState = null;
    this.fireCd = 0;
    this.bloom = 0;
    this.adsT = 0;
    this.adsLatched = false;
    this.infiniteT = this.adrenalineT = this.cloakT = 0;
    this.flashT = 0;
    this.suppressT = this.slowT = this.flickerT = this.dashAimT = 0;
    this.echo = null;
    this.pendingThrow = null;
    for (const a of this.abilities) {
      a.charges = a.max;
      a.recharge = 0;
    }
    this.equip(this.primary ?? this.secondary, true);
  }

  equip(id: WeaponId, force = false): void {
    if (id === this.current && !force) return;
    if (id !== this.current) this.last = this.current;
    this.current = id;
    const def = WEAPONS[id];
    this.equipT = def.equipTime;
    this.reloadT = 0;
    this.shellState = null;
    this.reloadEvents = [];
    this.boltT = 0;
    this.shotIndex = 0;
    this.bloom = 0;
    this.hooks.onWeaponSwitched(id, def.equipTime);
  }

  private startReload(): void {
    const def = this.def;
    const a = this.ammo.get(this.current);
    if (!a || def.slot === 'melee' || this.reloading || a.mag >= def.mag || a.reserve <= 0 || this.infiniteT > 0) return;
    if (def.shellReload) {
      this.shellState = { phase: 'start', t: def.shellReload.start };
      this.hooks.onReloadStart(def, def.shellReload.start);
      return;
    }
    const dur = def.reloadTime / this.adrenalineMult;
    this.reloadT = dur;
    this.reloadTotal = dur;
    this.reloadEvents = [
      { at: dur * 0.8, kind: 'magOut' },
      { at: dur * 0.3, kind: 'magIn' },
    ];
    if (a.mag === 0) this.reloadEvents.push({ at: dur * 0.12, kind: 'bolt' });
    this.hooks.onReloadStart(def, dur);
  }

  private finishReload(): void {
    const def = this.def;
    const a = this.ammo.get(this.current);
    if (!a) return;
    const take = Math.min(def.mag - a.mag, a.reserve);
    a.mag += take;
    a.reserve -= take;
  }

  // ---------------------------------------------------------------------------
  // Per-frame
  // ---------------------------------------------------------------------------
  update(dt: number, f: PlayerFrame): void {
    this.time += dt;
    const inp = f.input;
    this.flashT = Math.max(0, this.flashT - dt);
    if (!this.alive) return;

    // Look
    const zoom = lerp(1, this.def.ads.zoom, this.adsT);
    // ≈0.05° per mouse count at sensitivity 1 (typical competitive range).
    const k = 0.0009 * f.sens * (this.adsT > 0.5 ? f.adsSens / zoom : 1);
    this.yaw = wrapAngle(this.yaw - f.lookDX * k);
    this.pitch = clamp(this.pitch - f.lookDY * k * (f.invertY ? -1 : 1), -1.54, 1.54);

    // Timers
    this.fireCd = Math.max(0, this.fireCd - dt);
    this.equipT = Math.max(0, this.equipT - dt);
    this.boltT = Math.max(0, this.boltT - dt);
    this.throwCd = Math.max(0, this.throwCd - dt);
    this.infiniteT = Math.max(0, this.infiniteT - dt);
    this.adrenalineT = Math.max(0, this.adrenalineT - dt);
    this.cloakT = Math.max(0, this.cloakT - dt);
    this.suppressT = Math.max(0, this.suppressT - dt);
    this.slowT = Math.max(0, this.slowT - dt);
    this.flickerT = Math.max(0, this.flickerT - dt);
    this.dashAimT = Math.max(0, this.dashAimT - dt);
    this.landDip = Math.max(0, this.landDip - dt * 0.9);
    for (const a of this.abilities) {
      const rc = stat(a.id, 'recharge', a.tier);
      if (rc > 0 && a.charges < a.max) {
        a.recharge += dt;
        if (a.recharge >= rc) {
          a.recharge = 0;
          a.charges++;
        }
      }
    }

    // Movement
    const fwd = (inp.isDown('forward') ? 1 : 0) - (inp.isDown('back') ? 1 : 0);
    const right = (inp.isDown('right') ? 1 : 0) - (inp.isDown('left') ? 1 : 0);
    const def = this.def;
    const speedMult = def.moveSpeed * (this.adsT > 0.5 ? PLAYER.adsMult : 1) * (this.adrenalineT > 0 ? stat('adrenaline', 'speed', this.tierOf('adrenaline')) : 1) * (this.slowT > 0 ? SLOW_MULT : 1);
    const ev = this.motor.step(
      { forward: fwd, right, jump: inp.isDown('jump'), crouch: inp.isDown('crouch'), walk: inp.isDown('walk'), yaw: this.yaw },
      dt,
      f.world,
      speedMult,
      f.frozen,
    );
    if (ev.jumped) this.hooks.onJump();
    if (ev.landed > 4) {
      this.hooks.onLand(ev.landed);
      this.landDip = Math.min(0.12, ev.landed * 0.008);
    }
    if (ev.footstep && !inp.isDown('walk') && this.motor.crouch < 0.5) this.hooks.onFootstep();

    // Weapon switching
    if (!this.pendingThrow) {
      if (inp.wasPressed('primary') && this.primary) this.equip(this.primary);
      if (inp.wasPressed('secondary')) this.equip(this.secondary);
      if (inp.wasPressed('melee')) this.equip('knife');
      if (inp.wasPressed('lastWeapon')) {
        const l = this.last;
        if (l === 'knife' || l === this.primary || l === this.secondary) this.equip(l);
      }
      const wheel = inp.consumeWheel();
      if (wheel !== 0) {
        const order = [this.primary, this.secondary, 'knife' as WeaponId].filter((x): x is WeaponId => !!x);
        const i = order.indexOf(this.current);
        this.equip(order[(i + (wheel > 0 ? 1 : order.length - 1)) % order.length]);
      }
    }

    // Reload progress
    if (this.reloadT > 0) {
      this.reloadT -= dt;
      for (const e of this.reloadEvents) {
        if (this.reloadT <= e.at && e.at >= 0) {
          this.hooks.onReloadEvent(e.kind);
          e.at = -1;
        }
      }
      if (this.reloadT <= 0) {
        this.reloadT = 0;
        this.finishReload();
      }
    }
    if (this.shellState) this.updateShellReload(dt);
    if (inp.wasPressed('reload')) this.startReload();
    if (inp.wasPressed('inspect') && !this.reloading && this.equipT <= 0) this.hooks.onInspect();

    // ADS
    const wantAds = f.adsToggle ? this.toggleAds(inp) : inp.mouse(2);
    const canAds = def.slot !== 'melee' && !this.reloading && this.equipT <= 0 && !this.pendingThrow && f.canShoot;
    const adsRate = 1 / Math.max(0.05, def.ads.time);
    this.adsT = clamp(this.adsT + (wantAds && canAds ? adsRate : -adsRate * 1.3) * dt, 0, 1);

    // Fire
    const trigger = inp.mouse(0);
    if (!trigger) this.triggerReleased = true;
    if (f.canShoot && !this.pendingThrow && this.equipT <= 0) {
      if (def.slot === 'melee') {
        if (trigger && this.fireCd <= 0) this.melee(false);
        else if (inp.mouse(2) && this.fireCd <= 0) this.melee(true);
      } else if (trigger && (def.auto || this.triggerReleased)) this.tryFire();
    }
    if (trigger) this.triggerReleased = false;

    // Recoil recovery (exponential once the trigger rests)
    const sinceShot = this.time - this.lastShotAt;
    const interval = 60 / def.rpm;
    if (sinceShot > interval * 1.2) {
      const rec = Math.exp(-dt * (def.recoil.recover * 14));
      this.recoilPitch *= rec;
      this.recoilYaw *= rec;
      if (sinceShot > interval * 2.5) this.shotIndex = 0;
    }
    this.bloom = Math.max(0, this.bloom - dt * def.spread.recover);

    // Pending grenade release (cancelled — charge refunded — if combat ended meanwhile)
    if (this.pendingThrow && !f.canUseAbilities) {
      const slot = this.abilities.find((a) => a.id === this.pendingThrow!.kind);
      if (slot) slot.charges = Math.min(slot.max, slot.charges + 1);
      this.pendingThrow = null;
    }
    if (this.pendingThrow) {
      this.pendingThrow.t -= dt;
      if (this.pendingThrow.t <= 0) {
        const pt = this.pendingThrow;
        this.pendingThrow = null;
        const dir = dirFromYawPitch(this.yaw, this.pitch + 0.06);
        const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
        const pos = this.eye.addScaledVector(dir, 0.45).addScaledVector(right, -0.12);
        const vel = dir.multiplyScalar(THROW_SPEED).add(new THREE.Vector3(this.motor.body.vel.x * 0.5, Math.max(0, this.motor.body.vel.y * 0.3) + 1.2, this.motor.body.vel.z * 0.5));
        // Don't spawn inside a wall right in front of the player.
        const back = f.world.raycast(this.eye, dir.clone().normalize(), 0.6, false);
        if (back) pos.copy(this.eye).addScaledVector(dir.clone().normalize(), Math.max(0, back.dist - 0.15));
        this.hooks.onThrow(pt.kind, pos, vel, pt.tier);
      }
    }

    // Enhanced recon: the pulse echoes from where it was fired.
    if (this.echo) {
      this.echo.t -= dt;
      if (this.echo.t <= 0) {
        const e = this.echo;
        this.echo = null;
        if (f.canUseAbilities) this.hooks.onRecon(e.origin, e.radius, e.duration);
      }
    }

    // Abilities
    if (f.canUseAbilities) {
      if (inp.wasPressed('ability1')) this.useAbility(0, f.world);
      if (inp.wasPressed('ability2')) this.useAbility(1, f.world);
      if (inp.wasPressed('ability3')) this.useAbility(2, f.world);
    }
  }

  private toggleAds(inp: Input): boolean {
    if (inp.mouseWasPressed(2)) this.adsLatched = !this.adsLatched;
    if (this.def.slot === 'melee' || this.reloading) this.adsLatched = false;
    return this.adsLatched;
  }

  private updateShellReload(dt: number): void {
    const def = this.def;
    const sr = def.shellReload;
    const s = this.shellState;
    const a = this.ammo.get(this.current);
    if (!sr || !s || !a) {
      this.shellState = null;
      return;
    }
    s.t -= dt * this.adrenalineMult;
    if (s.t > 0) return;
    if (s.phase === 'start' || s.phase === 'shell') {
      if (s.phase === 'shell') {
        a.mag++;
        a.reserve--;
        this.hooks.onReloadEvent('shell');
      }
      if (a.mag < def.mag && a.reserve > 0) {
        s.phase = 'shell';
        s.t = sr.perShell;
      } else {
        s.phase = 'end';
        s.t = sr.end;
        this.hooks.onReloadEvent('pump');
      }
    } else this.shellState = null;
  }

  // ---------------------------------------------------------------------------
  // Shooting
  // ---------------------------------------------------------------------------
  currentSpread(): number {
    const def = this.def;
    if (def.slot === 'melee') return 0;
    const speed = this.motor.speed2D;
    const moveK = clamp((speed - 1.3) / (PLAYER.runSpeed - 1.3), 0, 1);
    const precise = this.dashAimT > 0;
    let s = lerp(def.spread.hip, def.spread.ads, this.adsT) + (precise ? 0 : def.spread.move * moveK) + this.bloom;
    if (!this.motor.body.onGround && !precise) s += def.spread.air;
    if (this.motor.crouch > 0.5) s *= def.spread.crouch;
    return s;
  }

  private tryFire(): void {
    const def = this.def;
    if (this.fireCd > 0 || this.boltT > 0) return;
    const a = this.ammo.get(this.current);
    if (!a) return;
    const infinite = this.infiniteT > 0;
    if (this.shellState && a.mag > 0) this.shellState = null;
    if (this.reloading) return;
    if (a.mag <= 0 && !infinite) {
      this.hooks.onDryFire();
      this.fireCd = 0.25;
      if (a.reserve > 0) this.startReload();
      else if (this.current !== this.secondary) this.equip(this.secondary);
      return;
    }
    const fireMult = this.adrenalineMult * (infinite ? stat('infinite', 'fireRate', this.tierOf('infinite')) : 1);
    this.fireCd = 60 / def.rpm / fireMult;
    if (def.bolt) this.boltT = def.bolt / this.adrenalineMult;
    if (!infinite) a.mag--;
    this.breakCloak();

    const origin = _origin.copy(this.eye);
    const view = this.viewDir;
    const spread = this.currentSpread();
    const shots: ShotResult[] = [];
    for (let i = 0; i < def.pellets; i++) {
      const dir = coneDirection(view, spread, new THREE.Vector3());
      const tr = this.hooks.trace(origin, dir, 300);
      const dmg = tr.kind === 'player' && tr.zone ? damageAt(def, tr.dist, tr.zone) : 0;
      shots.push({ trace: tr, dir, damage: dmg });
    }
    this.hooks.onShot(def, origin.clone(), shots, infinite);

    // Recoil: pattern + jitter, kicks the view (CS-style aim punch).
    const pat = def.recoil.pattern;
    const [pp, py] = this.shotIndex < pat.length ? pat[this.shotIndex] : [def.recoil.tail[0], (Math.random() - 0.5) * 0.012];
    const adsK = lerp(1, 0.82, this.adsT);
    const crouchK = this.motor.crouch > 0.5 ? 0.85 : 1;
    this.recoilPitch += (pp + (Math.random() - 0.5) * def.recoil.jitter) * adsK * crouchK;
    this.recoilYaw += (py + (Math.random() - 0.5) * def.recoil.jitter) * adsK * crouchK;
    this.recoilPitch = Math.min(this.recoilPitch, 0.3);
    this.shotIndex++;
    this.bloom = Math.min(def.spread.bloomMax, this.bloom + def.spread.bloom);
    this.lastShotAt = this.time;
    if (a.mag === 0 && !infinite && a.reserve > 0 && !def.auto) {
      // pistols etc. auto-reload after the last round
      this.fireCd = Math.max(this.fireCd, 0.2);
    }
  }

  private melee(heavy: boolean): void {
    const def = this.def;
    this.fireCd = heavy ? 1.0 : 60 / def.rpm;
    this.breakCloak();
    this.hooks.onMelee(heavy);
    const origin = this.eye;
    const view = this.viewDir;
    const range = def.meleeRange ?? 2.3;
    // Forgiving melee: a few rays in a small fan.
    let best: TraceResult | null = null;
    let bestDir = view;
    for (const [ox, oy] of [
      [0, 0],
      [0.08, 0],
      [-0.08, 0],
      [0, 0.06],
      [0, -0.08],
    ]) {
      const d = dirFromYawPitch(this.yaw + ox, this.pitch + oy, new THREE.Vector3());
      const tr = this.hooks.trace(origin, d, range);
      if (tr.kind === 'player' && (!best || tr.dist < best.dist)) {
        best = tr;
        bestDir = d;
      } else if (!best && tr.kind !== 'none') {
        best = tr;
        bestDir = d;
      }
    }
    const tr = best ?? this.hooks.trace(origin, view, range);
    let dmg = 0;
    if (tr.kind === 'player') {
      const behind = tr.victimYaw !== undefined && Math.cos(wrapAngle(tr.victimYaw - this.yaw)) > 0.5;
      dmg = heavy ? (behind ? 180 : 75) : behind ? 110 : def.damage;
    }
    this.hooks.onShot(def, origin.clone(), [{ trace: tr, dir: bestDir, damage: dmg }], false);
  }

  /** Attacking reveals a cloaked player; an awakened cloak (or phantom during infinite) only flickers. */
  private breakCloak(): void {
    if (this.cloakT <= 0) return;
    if (stat('cloak', 'phantom', this.tierOf('cloak')) > 0 || (this.infiniteT > 0 && hasSynergy(this.owned, 'phantom'))) this.flickerT = CLOAK_FLICKER;
    else this.cloakT = 0;
  }

  // ---------------------------------------------------------------------------
  // Abilities
  // ---------------------------------------------------------------------------
  private useAbility(slot: number, world: CollisionWorld): void {
    const a = this.abilities[slot];
    if (!a || a.charges <= 0 || this.suppressT > 0) return;
    const def = ABILITIES[a.id];
    const syn = (id: string): boolean => hasSynergy(this.owned, id);
    if (def.type === 'throw') {
      if (this.throwCd > 0 || this.pendingThrow) return;
      this.throwCd = 0.7;
      this.pendingThrow = { kind: a.id as ThrowKind, t: 0.24, tier: a.tier };
      this.adsT = 0;
      this.reloadT = 0;
      this.shellState = null;
      this.hooks.onThrowAnim(a.id as ThrowKind);
    } else {
      switch (a.id) {
        case 'dash': {
          if (this.motor.dashTime > 0) return;
          const inp = this.motor.body.vel;
          let dx = inp.x;
          let dz = inp.z;
          if (Math.hypot(dx, dz) < 0.5) {
            dx = -Math.sin(this.yaw);
            dz = -Math.cos(this.yaw);
          }
          this.motor.startDash(dx, dz, stat('dash', 'distance', a.tier));
          if (stat('dash', 'aim', a.tier) > 0) this.dashAimT = 1.2;
          if (syn('shadowstep')) this.cloakT = Math.max(this.cloakT, 1.5);
          break;
        }
        case 'heal':
          if (syn('secondwind')) this.adrenalineT = Math.max(this.adrenalineT, 3);
          break;
        case 'recon': {
          const origin = this.eye;
          const radius = stat('recon', 'radius', a.tier);
          const duration = stat('recon', 'reveal', a.tier);
          this.hooks.onRecon(origin, radius, duration);
          if (stat('recon', 'echo', a.tier) > 0) this.echo = { t: ECHO_DELAY, origin, radius, duration };
          break;
        }
        case 'barrier': {
          const flat = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
          const eye = this.eye;
          let dist = 2.2;
          const hit = world.raycast(eye, flat, 2.6, true);
          if (hit) dist = Math.max(0.6, hit.dist - 0.45);
          const p = this.motor.body.pos.clone().addScaledVector(flat, dist);
          const g = world.groundBelow(new THREE.Vector3(p.x, p.y + 1.2, p.z), 0.05, 4);
          if (g !== null) p.y = g;
          const yaw = Math.abs(flat.z) >= Math.abs(flat.x) ? 0 : Math.PI / 2;
          this.hooks.onBarrier(p, yaw, a.tier);
          break;
        }
        case 'cloak':
          this.cloakT = stat('cloak', 'duration', a.tier);
          this.flickerT = 0;
          break;
        case 'adrenaline':
          this.adrenalineT = stat('adrenaline', 'duration', a.tier);
          if (stat('adrenaline', 'reload', a.tier) > 0) this.instantReload();
          if (syn('berserk')) this.infiniteT = Math.max(this.infiniteT, stat('infinite', 'duration', this.tierOf('infinite')) * 0.6);
          break;
        case 'infinite': {
          this.infiniteT = stat('infinite', 'duration', a.tier);
          const am = this.ammo.get(this.current);
          if (am && this.def.slot !== 'melee') am.mag = Math.max(am.mag, this.def.mag);
          this.reloadT = 0;
          this.shellState = null;
          if (syn('berserk')) this.adrenalineT = Math.max(this.adrenalineT, stat('adrenaline', 'duration', this.tierOf('adrenaline')) * 0.6);
          break;
        }
        default:
          break;
      }
    }
    a.charges--;
    this.hooks.onAbility(a.id, a.tier);
  }

  private instantReload(): void {
    if (this.def.slot === 'melee') return;
    this.reloadT = 0;
    this.shellState = null;
    this.reloadEvents = [];
    this.finishReload();
  }

  /** Kill rewards of awakened abilities. Returns a toast line when something triggered. */
  onKill(): string | null {
    const notes: string[] = [];
    const dash = this.abilities.find((a) => a.id === 'dash');
    if (dash && stat('dash', 'aim', dash.tier) > 0 && dash.charges < dash.max) {
      dash.charges++;
      notes.push('칼바람 · 대시 충전');
    }
    const adr = this.tierOf('adrenaline');
    if (this.adrenalineT > 0 && stat('adrenaline', 'killHeal', adr) > 0) {
      this.adrenalineT = stat('adrenaline', 'duration', adr);
      notes.push(`폭주 · 체력 +${stat('adrenaline', 'killHeal', adr)}`);
    }
    return notes.length ? notes.join(' · ') : null;
  }

  suppress(duration: number): void {
    this.suppressT = Math.max(this.suppressT, duration);
  }

  slow(duration: number): void {
    this.slowT = Math.max(this.slowT, duration);
  }

  // ---------------------------------------------------------------------------
  flags(): number {
    let f = 0;
    if (this.motor.crouch > 0.5) f |= F.crouch;
    if (this.adsT > 0.5) f |= F.ads;
    if (this.motor.body.onGround) f |= F.ground;
    if (this.cloakT > 0 && this.flickerT <= 0) f |= F.cloak;
    if (this.adrenalineT > 0) f |= F.adrenaline;
    if (this.infiniteT > 0) f |= F.infinite;
    if (this.reloading) f |= F.reload;
    if (this.alive) f |= F.alive;
    if (this.time - this.lastShotAt < 0.12) f |= F.fired;
    if (this.motor.dashTime > 0) f |= F.dash;
    if (this.pendingThrow) f |= F.throwing;
    return f;
  }

  blind(duration: number): void {
    this.flashT = Math.max(this.flashT, duration);
    this.flashMax = Math.max(this.flashT, duration);
  }
}

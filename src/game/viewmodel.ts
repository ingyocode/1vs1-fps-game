import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { TEAMS, type TeamId } from '../core/config';
import { clamp, damp, lerp, smoothstep, Spring3 } from '../core/utils';
import { buildGrenade, buildGun } from './gunModels';
import { WEAPONS, type WeaponId } from './weapons';
import type { ThrowKind } from './abilities';
import { muzzleFlare } from '../render/textures';
import { cloakMaterial } from '../render/shaders';

const HIP: Record<WeaponId, [number, number, number]> = {
  knife: [0.15, -0.15, -0.32],
  pistol: [0.15, -0.165, -0.44],
  magnum: [0.15, -0.17, -0.46],
  smg: [0.15, -0.17, -0.42],
  shotgun: [0.15, -0.175, -0.4],
  rifle: [0.15, -0.172, -0.42],
  sniper: [0.155, -0.175, -0.38],
};

/** Resting orientation offsets at the hip (pitch, yaw, roll). */
const HIP_ROT: Partial<Record<WeaponId, [number, number, number]>> = {
  knife: [0.25, 0.45, 0.35],
};

/** Distance from the eye to the sight anchor when aiming. */
const SIGHT_DIST: Record<WeaponId, number> = {
  knife: 0.3,
  pistol: 0.3,
  magnum: 0.32,
  smg: 0.2,
  shotgun: 0.17,
  rifle: 0.2,
  sniper: 0.12,
};

export interface ViewModelInput {
  dt: number;
  lookDX: number;
  lookDY: number;
  speed: number;
  onGround: boolean;
  crouch: number;
  ads: number;
  walking: boolean;
}

interface Shell {
  mesh: THREE.Mesh;
  vel: THREE.Vector3;
  spin: THREE.Vector3;
  life: number;
}

const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);

export class ViewModel {
  readonly root = new THREE.Group();
  private rig = new THREE.Group();
  private holder = new THREE.Group();
  private gun: THREE.Group | null = null;
  private gunId: WeaponId = 'pistol';
  private arms: { upper: THREE.Mesh; fore: THREE.Mesh; cuff: THREE.Mesh; hand: THREE.Mesh }[] = [];
  private flash: THREE.Group;
  private flashLight: THREE.PointLight;
  private flashT = 0;
  private shells: Shell[] = [];
  private shellIdx = 0;
  private grenade: THREE.Group | null = null;
  private grenadeKind: ThrowKind | null = null;

  private recoilPos = new Spring3(170, 17);
  private recoilRot = new Spring3(150, 15);
  private swayRot = new Spring3(90, 12);
  private landSpring = new Spring3(120, 11);
  private bobPhase = 0;
  private bobAmp = 0;
  private time = 0;
  private curAds = 0;
  private crouchT = 0;

  private reloadT = -1;
  private reloadDur = 1;
  private equipT = 1;
  private equipDur = 0.5;
  private meleeT = -1;
  private throwT = -1;
  private boltT = -1;
  private boltDur = 1;
  private pumpT = -1;
  private shellInsertT = -1;
  private inspectT = -1;
  private slideBack = 0;
  private emptyHold = false;

  private sleeveMat: THREE.MeshStandardMaterial;
  private gloveMat: THREE.MeshStandardMaterial;
  private cuffMat: THREE.MeshBasicMaterial;
  private cloakMat = cloakMaterial();
  private cloaked = false;
  private originalMats = new Map<THREE.Mesh, THREE.Material | THREE.Material[]>();

  readonly sunLight: THREE.DirectionalLight;
  readonly hemi: THREE.HemisphereLight;
  readonly fill: THREE.DirectionalLight;
  private readonly rim: THREE.DirectionalLight;
  scoped = false;

  constructor(
    private scene: THREE.Scene,
    team: TeamId,
  ) {
    scene.add(this.root);
    this.root.add(this.rig);
    this.rig.add(this.holder);
    this.sleeveMat = new THREE.MeshStandardMaterial({ color: 0x3a3f48, roughness: 0.9 });
    this.gloveMat = new THREE.MeshStandardMaterial({ color: 0x24262b, roughness: 0.72, metalness: 0.05 });
    this.cuffMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(TEAMS[team].color).multiplyScalar(1.1) });
    for (let i = 0; i < 2; i++) {
      const upper = new THREE.Mesh(new THREE.CapsuleGeometry(0.05, 0.3, 4, 14), this.sleeveMat);
      const fore = new THREE.Mesh(new THREE.CapsuleGeometry(0.042, 0.32, 4, 14), this.sleeveMat);
      const cuff = new THREE.Mesh(new THREE.CylinderGeometry(0.046, 0.046, 0.008, 16), this.cuffMat);
      const hand = new THREE.Mesh(new RoundedBoxGeometry(0.058, 0.08, 0.095, 2, 0.022), this.gloveMat);
      this.rig.add(upper, fore, cuff, hand);
      this.arms.push({ upper, fore, cuff, hand });
    }

    // Muzzle flash: two crossed additive quads + a short-lived light.
    const flareTex = muzzleFlare();
    const fm = new THREE.MeshBasicMaterial({ map: flareTex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, color: new THREE.Color(1, 0.85, 0.6).multiplyScalar(3) });
    this.flash = new THREE.Group();
    const q1 = new THREE.Mesh(new THREE.PlaneGeometry(0.16, 0.16), fm);
    const q2 = new THREE.Mesh(new THREE.PlaneGeometry(0.34, 0.12), fm);
    q2.rotation.y = Math.PI / 2;
    q2.position.z = -0.08;
    const q3 = q2.clone();
    q3.rotation.set(0, Math.PI / 2, Math.PI / 2);
    this.flash.add(q1, q2, q3);
    this.flash.visible = false;
    this.rig.add(this.flash);
    this.flashLight = new THREE.PointLight(0xffb060, 0, 1.6, 2);
    this.rig.add(this.flashLight);

    // Lighting for the viewmodel scene (driven by the world lighting at the eye).
    this.hemi = new THREE.HemisphereLight(0x9a90c8, 0x4a3628, 0.9);
    this.sunLight = new THREE.DirectionalLight(0xffb784, 2.2);
    this.sunLight.position.set(0.3, 1, 0.6);
    // Soft key from the viewer's side so weapons never read as flat black.
    this.fill = new THREE.DirectionalLight(0xc8d4ff, 0.9);
    this.fill.position.set(-0.6, 0.7, 0.8);
    this.rim = new THREE.DirectionalLight(0xffc89a, 0.6);
    this.rim.position.set(0.8, 0.4, -1);
    scene.add(this.hemi, this.sunLight, this.fill, this.rim);

    const brass = new THREE.MeshStandardMaterial({ color: 0xc8a050, roughness: 0.3, metalness: 1 });
    const sg = new THREE.CylinderGeometry(0.0045, 0.0045, 0.022, 8);
    for (let i = 0; i < 14; i++) {
      const mesh = new THREE.Mesh(sg, brass);
      mesh.visible = false;
      this.rig.add(mesh);
      this.shells.push({ mesh, vel: new THREE.Vector3(), spin: new THREE.Vector3(), life: 0 });
    }
    this.setWeapon('pistol', 0.01);
  }

  setTeam(team: TeamId): void {
    this.cuffMat.color.set(TEAMS[team].color).multiplyScalar(1.1);
  }

  get weapon(): WeaponId {
    return this.gunId;
  }

  setWeapon(id: WeaponId, equipTime: number): void {
    if (this.gun) {
      this.holder.remove(this.gun);
      this.gun.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) m.geometry.dispose();
      });
    }
    this.gunId = id;
    this.gun = buildGun(id);
    this.gun.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) {
        o.castShadow = false;
        this.originalMats.set(o as THREE.Mesh, (o as THREE.Mesh).material);
      }
    });
    this.holder.add(this.gun);
    this.equipT = 0;
    this.equipDur = Math.max(0.01, equipTime);
    this.reloadT = -1;
    this.boltT = -1;
    this.pumpT = -1;
    this.meleeT = -1;
    this.inspectT = -1;
    this.emptyHold = false;
    if (this.cloaked) this.applyCloak(true);
  }

  setLighting(sun: number, indoor: number): void {
    this.sunLight.intensity = lerp(0.2, 2.2, sun);
    this.hemi.intensity = lerp(0.95, 0.5, indoor);
    this.fill.intensity = lerp(0.9, 0.6, indoor);
  }

  setCloaked(on: boolean): void {
    if (on === this.cloaked) return;
    this.cloaked = on;
    this.applyCloak(on);
  }

  private applyCloak(on: boolean): void {
    const all: THREE.Mesh[] = [];
    this.gun?.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) all.push(o as THREE.Mesh);
    });
    for (const a of this.arms) all.push(a.upper, a.fore, a.hand, a.cuff);
    for (const m of all) {
      if (!this.originalMats.has(m)) this.originalMats.set(m, m.material);
      m.material = on ? this.cloakMat : this.originalMats.get(m)!;
    }
  }

  // ---------------------------------------------------------------------------
  // Triggers
  // ---------------------------------------------------------------------------
  fire(kickScale: number, infinite: boolean): void {
    const def = WEAPONS[this.gunId];
    if (def.slot === 'melee') return;
    const strength = clamp(def.recoil.pattern[0][0] * 6 + 0.25, 0.3, 1.2) * kickScale;
    const adsDamp = lerp(1, 0.45, this.curAds);
    this.recoilPos.impulse((Math.random() - 0.5) * 0.04 * strength, 0.05 * strength * adsDamp, 0.9 * strength * adsDamp);
    this.recoilRot.impulse(1.6 * strength * adsDamp, (Math.random() - 0.5) * 0.5 * strength, (Math.random() - 0.5) * 1.2 * strength);
    this.flashT = 0.05;
    this.flash.visible = true;
    this.flash.rotation.z = Math.random() * Math.PI;
    const s = (this.gunId === 'shotgun' || this.gunId === 'magnum' || this.gunId === 'sniper' ? 1.5 : 1) * (0.8 + Math.random() * 0.4);
    this.flash.scale.setScalar(s);
    const mat = (this.flash.children[0] as THREE.Mesh).material as THREE.MeshBasicMaterial;
    mat.color.setRGB(infinite ? 0.6 : 1, infinite ? 0.9 : 0.85, infinite ? 1.2 : 0.6).multiplyScalar(3);
    this.flashLight.intensity = 6;
    this.flashLight.color.set(infinite ? 0x80d8ff : 0xffb060);
    this.slideBack = 1;
    if (def.bolt) {
      this.boltT = 0;
      this.boltDur = def.bolt;
    }
    if (this.gunId === 'shotgun') this.pumpT = 0;
    this.ejectShell();
  }

  private ejectShell(): void {
    // Pump and bolt actions do not eject on the shot itself.
    if (this.gunId === 'shotgun' || this.gunId === 'sniper') return;
    const ej = this.gun?.getObjectByName('eject');
    if (!ej) return;
    const sh = this.shells[this.shellIdx++ % this.shells.length];
    ej.updateWorldMatrix(true, false);
    this.rig.updateWorldMatrix(true, false);
    sh.mesh.position.setFromMatrixPosition(ej.matrixWorld);
    this.rig.worldToLocal(sh.mesh.position);
    sh.vel.set(0.9 + Math.random() * 0.5, 0.9 + Math.random() * 0.6, 0.15 + Math.random() * 0.3);
    sh.spin.set(Math.random() * 20, Math.random() * 20, Math.random() * 30);
    sh.life = 0.7;
    sh.mesh.visible = true;
    sh.mesh.rotation.set(0, 0, Math.PI / 2);
  }

  reload(duration: number): void {
    this.reloadT = 0;
    this.reloadDur = duration;
  }

  cancelReload(): void {
    this.reloadT = -1;
    this.shellInsertT = -1;
    const mag = this.gun?.getObjectByName('mag');
    if (mag && this.gunId !== 'shotgun') {
      mag.position.set(0, 0, 0);
      mag.visible = true;
    }
  }

  insertShell(): void {
    this.shellInsertT = 0;
  }

  melee(): void {
    this.meleeT = 0;
  }

  inspect(): void {
    if (this.reloadT < 0 && this.equipT >= 1) this.inspectT = 0;
  }

  throwGrenade(kind: ThrowKind): void {
    this.throwT = 0;
    if (this.grenadeKind !== kind) {
      if (this.grenade) this.rig.remove(this.grenade);
      this.grenade = buildGrenade(kind);
      this.grenade.scale.setScalar(0.9);
      this.rig.add(this.grenade);
      this.grenadeKind = kind;
    }
    this.grenade!.visible = true;
  }

  landed(speed: number): void {
    this.landSpring.impulse(0, -Math.min(0.5, speed * 0.04), 0);
  }

  setEmpty(empty: boolean): void {
    this.emptyHold = empty;
  }

  get busy(): boolean {
    return this.throwT >= 0 && this.throwT < 0.45;
  }

  // ---------------------------------------------------------------------------
  update(inp: ViewModelInput): void {
    const dt = inp.dt;
    this.time += dt;
    this.curAds = inp.ads;
    this.crouchT = damp(this.crouchT, inp.crouch, 10, dt);

    // Sway: the weapon lags behind fast look motion (target from angular speed, frame-rate independent).
    const inv = 1 / Math.max(dt, 1e-3);
    const swayScale = lerp(1, 0.25, inp.ads);
    this.swayRot.x.target = clamp(-inp.lookDY * inv * 0.000035, -0.07, 0.07) * swayScale;
    this.swayRot.y.target = clamp(-inp.lookDX * inv * 0.000035, -0.09, 0.09) * swayScale;
    this.swayRot.z.target = this.swayRot.y.target * 0.6;

    // Bob
    const moving = inp.onGround ? clamp(inp.speed / 6, 0, 1.2) : 0;
    this.bobAmp = damp(this.bobAmp, moving, 8, dt);
    this.bobPhase += dt * (inp.speed * 1.45 + 0.2);
    const bobScale = lerp(1, 0.15, inp.ads) * (inp.walking ? 0.5 : 1);
    const bx = Math.sin(this.bobPhase * Math.PI) * 0.011 * this.bobAmp * bobScale;
    const by = -Math.abs(Math.cos(this.bobPhase * Math.PI)) * 0.012 * this.bobAmp * bobScale;
    const idle = Math.sin(this.time * 1.6) * 0.0018 * (1 - inp.ads * 0.8);

    const rp = new THREE.Vector3();
    const rr = new THREE.Euler();
    this.recoilPos.update(dt, rp);
    this.recoilRot.update(dt, rr);
    const sw = new THREE.Euler();
    this.swayRot.update(dt, sw);
    const land = new THREE.Vector3();
    this.landSpring.update(dt, land);

    // Base pose: hip → ADS
    const hip = HIP[this.gunId];
    const sight = this.gun?.getObjectByName('sight')?.position ?? new THREE.Vector3();
    const adsPos = _v.set(-sight.x, -sight.y, -SIGHT_DIST[this.gunId] - sight.z);
    const a = smoothstep(0, 1, inp.ads);
    const px = lerp(hip[0], adsPos.x, a);
    const py = lerp(hip[1], adsPos.y, a);
    const pz = lerp(hip[2], adsPos.z, a);
    const crouchTilt = this.crouchT * 0.04 * (1 - a);
    const baseRot = HIP_ROT[this.gunId] ?? [0, 0, 0];

    let ox = 0;
    let oy = 0;
    let oz = 0;
    let orx = 0;
    let ory = 0;
    let orz = 0;

    // Equip
    if (this.equipT < 1) {
      this.equipT = Math.min(1, this.equipT + dt / this.equipDur);
      const e = 1 - Math.pow(1 - this.equipT, 3);
      oy -= (1 - e) * 0.25;
      orx -= (1 - e) * 0.9;
      orz += (1 - e) * 0.3;
    }

    // Reload choreography
    const mag = this.gun?.getObjectByName('mag');
    if (this.reloadT >= 0) {
      this.reloadT += dt / this.reloadDur;
      const t = this.reloadT;
      if (this.gunId === 'shotgun') {
        const w = smoothstep(0, 0.1, t) * (1 - smoothstep(0.92, 1, t));
        orz += w * 0.35;
        orx += w * 0.18;
        oy -= w * 0.03;
      } else {
        const w = smoothstep(0, 0.15, t) * (1 - smoothstep(0.85, 1, t));
        orz += w * 0.55;
        orx -= w * 0.15;
        oy -= w * 0.045;
        ox -= w * 0.02;
        if (mag) {
          if (t < 0.4) {
            const k = smoothstep(0.15, 0.38, t);
            mag.position.set(0, -k * 0.25, k * 0.03);
            mag.visible = t < 0.38;
          } else if (t < 0.72) {
            const k = 1 - smoothstep(0.45, 0.68, t);
            mag.visible = true;
            mag.position.set(0, -k * 0.22, 0);
          } else {
            mag.position.set(0, 0, 0);
            mag.visible = true;
            if (t > 0.74 && t < 0.78) this.recoilPos.impulse(0, 0.12, 0);
          }
        }
        // charge the weapon at the end
        if (t > 0.8 && t < 0.95) {
          const k = Math.sin(((t - 0.8) / 0.15) * Math.PI);
          oz += k * 0.015;
          orx += k * 0.06;
        }
      }
      if (this.reloadT >= 1) this.reloadT = -1;
    } else if (mag && this.gunId !== 'shotgun') {
      mag.position.set(0, 0, 0);
      mag.visible = true;
    }

    // Shotgun shell insertion bob + visible shell in the port
    if (this.shellInsertT >= 0 && mag) {
      this.shellInsertT += dt / 0.4;
      const k = Math.sin(clamp(this.shellInsertT, 0, 1) * Math.PI);
      mag.visible = this.shellInsertT < 0.7;
      mag.position.set(0.0, -0.03 - (1 - k) * 0.06, -0.08 + k * 0.03);
      oy -= k * 0.01;
      if (this.shellInsertT >= 1) {
        this.shellInsertT = -1;
        mag.visible = false;
      }
    }

    // Pump action
    const pump = this.gun?.getObjectByName('pump');
    if (pump) {
      if (this.pumpT >= 0) {
        this.pumpT += dt / 0.55;
        const k = this.pumpT < 0.35 ? 0 : Math.sin(clamp((this.pumpT - 0.35) / 0.65, 0, 1) * Math.PI);
        pump.position.z = k * 0.075;
        orx += k * 0.04;
        if (this.pumpT >= 1) this.pumpT = -1;
      } else pump.position.z = 0;
    }

    // Bolt action
    const bolt = this.gun?.getObjectByName('bolt');
    if (bolt) {
      if (this.boltT >= 0) {
        this.boltT += dt / this.boltDur;
        const t = this.boltT;
        const lift = smoothstep(0.25, 0.4, t) * (1 - smoothstep(0.75, 0.9, t));
        const back = smoothstep(0.4, 0.55, t) * (1 - smoothstep(0.6, 0.75, t));
        bolt.rotation.z = lift * 1.1;
        bolt.position.z = back * 0.07;
        orz += lift * 0.12;
        oy -= lift * 0.015;
        if (this.boltT >= 1) this.boltT = -1;
      } else {
        bolt.rotation.z = 0;
        bolt.position.z = 0;
      }
    }

    // Pistol slide
    const slide = this.gun?.getObjectByName('slide');
    this.slideBack = Math.max(0, this.slideBack - dt * 22);
    if (slide) slide.position.z = this.emptyHold ? 0.028 : this.slideBack * 0.028;

    // Melee swing
    if (this.meleeT >= 0) {
      this.meleeT += dt / 0.42;
      const t = this.meleeT;
      const wind = smoothstep(0, 0.2, t) * (1 - smoothstep(0.2, 0.45, t));
      const strike = smoothstep(0.2, 0.42, t) * (1 - smoothstep(0.55, 1, t));
      ory += wind * 0.5 - strike * 1.1;
      orx += -wind * 0.3 + strike * 0.2;
      ox += -strike * 0.18;
      oz += -strike * 0.12;
      orz += strike * 0.6;
      if (this.meleeT >= 1) this.meleeT = -1;
    }

    // Grenade throw (gun dips, left hand throws)
    let throwArm = 0;
    if (this.throwT >= 0) {
      this.throwT += dt / 0.55;
      const t = this.throwT;
      const dip = smoothstep(0, 0.15, t) * (1 - smoothstep(0.6, 1, t));
      oy -= dip * 0.22;
      orx -= dip * 0.5;
      throwArm = t;
      if (this.grenade) {
        const wind = smoothstep(0.05, 0.3, t);
        const rel = smoothstep(0.3, 0.45, t);
        this.grenade.position.set(lerp(-0.12, -0.05, rel), lerp(-0.2, -0.05, wind) + rel * 0.06, lerp(-0.2, -0.05, wind) - rel * 0.35);
        this.grenade.rotation.set(t * 4, t * 2, 0);
        this.grenade.visible = t < 0.42;
      }
      if (this.throwT >= 1) {
        this.throwT = -1;
        if (this.grenade) this.grenade.visible = false;
      }
    }

    // Inspect flourish
    if (this.inspectT >= 0) {
      this.inspectT += dt / 2.2;
      const t = this.inspectT;
      const k = smoothstep(0, 0.2, t) * (1 - smoothstep(0.8, 1, t));
      const roll = Math.sin(t * Math.PI * 2) * 0.4;
      ory += k * 0.8;
      orz += k * (0.5 + roll * 0.3);
      ox -= k * 0.06;
      oy += k * 0.02;
      if (this.inspectT >= 1 || inp.ads > 0.1) this.inspectT = -1;
    }

    this.holder.position.set(px + bx + ox + rp.x * 0.05, py + by + idle + oy + rp.y * 0.05 + land.y * 0.08 - crouchTilt * 0.3, pz + oz + rp.z * 0.06);
    this.holder.rotation.set(rr.x * 0.06 + orx + land.y * 0.2 + baseRot[0] * (1 - a), rr.y * 0.06 + ory + baseRot[1] * (1 - a), rr.z * 0.05 + orz + crouchTilt + bx * 2 + baseRot[2] * (1 - a));
    this.rig.rotation.set(sw.x, sw.y, sw.z * 0.5);

    // Muzzle flash
    if (this.flashT > 0) {
      this.flashT -= dt;
      const muzzle = this.gun?.getObjectByName('muzzle');
      if (muzzle) {
        this.holder.updateMatrixWorld(true);
        muzzle.updateWorldMatrix(true, false);
        this.flash.position.setFromMatrixPosition(muzzle.matrixWorld);
        this.rig.worldToLocal(this.flash.position);
        this.flash.quaternion.copy(this.holder.quaternion);
        this.flashLight.position.copy(this.flash.position);
      }
      if (this.flashT <= 0) this.flash.visible = false;
    }
    this.flashLight.intensity = Math.max(0, this.flashLight.intensity - dt * 120);

    // Shells
    for (const s of this.shells) {
      if (s.life <= 0) continue;
      s.life -= dt;
      s.vel.y -= 9.8 * dt;
      s.mesh.position.addScaledVector(s.vel, dt);
      s.mesh.rotation.x += s.spin.x * dt;
      s.mesh.rotation.y += s.spin.y * dt;
      s.mesh.rotation.z += s.spin.z * dt;
      if (s.life <= 0) s.mesh.visible = false;
    }

    this.updateArms(throwArm);
    this.scoped = this.gunId === 'sniper' && inp.ads > 0.92 && this.boltT < 0;
    this.root.visible = !this.scoped;
  }

  private updateArms(throwT: number): void {
    if (!this.gun) return;
    this.holder.updateMatrixWorld(true);
    this.rig.updateMatrixWorld(true);
    const grips = [this.gun.getObjectByName('gripR'), this.gun.getObjectByName('gripL')];
    for (let i = 0; i < 2; i++) {
      const side = i === 0 ? 1 : -1;
      const g = grips[i];
      const arm = this.arms[i];
      const hand = _v;
      if (g) {
        g.updateWorldMatrix(true, false);
        hand.setFromMatrixPosition(g.matrixWorld);
        this.rig.worldToLocal(hand);
      }
      let freeHand = false;
      if (i === 1 && (this.gunId === 'knife' || throwT > 0)) {
        // Free left hand: rest low, or throw.
        freeHand = true;
        if (throwT > 0 && throwT < 1) {
          const wind = smoothstep(0.05, 0.3, throwT);
          const rel = smoothstep(0.3, 0.45, throwT);
          const back = smoothstep(0.6, 1, throwT);
          hand.set(lerp(-0.16, -0.06, rel), lerp(-0.26, -0.1, wind) + rel * 0.04 - back * 0.28, lerp(-0.3, -0.12, wind) - rel * 0.32 + back * 0.2);
        } else hand.set(-0.26, -0.5, -0.25);
      }
      // The forearm trails back and down from the hand; the elbow stays off-screen.
      const foreDir = _w.set(side * 0.32, -0.62, 0.72).normalize();
      const elbow = new THREE.Vector3().copy(hand).addScaledVector(foreDir, 0.4);
      const upperEnd = elbow.clone().add(new THREE.Vector3(side * 0.12, -0.45, 0.22));
      this.place(arm.fore, hand.clone().addScaledVector(foreDir, 0.05), elbow);
      this.place(arm.upper, elbow, upperEnd);
      arm.cuff.position.copy(hand).addScaledVector(foreDir, 0.085);
      arm.cuff.quaternion.copy(arm.fore.quaternion);
      arm.hand.position.copy(hand);
      arm.hand.quaternion.copy(this.holder.quaternion);
      if (freeHand) arm.hand.rotation.set(-0.6, 0, side * -0.3);
    }
  }

  private place(mesh: THREE.Mesh, a: THREE.Vector3, b: THREE.Vector3): void {
    mesh.position.copy(a).add(b).multiplyScalar(0.5);
    const d = new THREE.Vector3().subVectors(b, a);
    const len = d.length();
    mesh.quaternion.setFromUnitVectors(_up, d.divideScalar(len || 1));
  }

  dispose(): void {
    this.scene.remove(this.root, this.hemi, this.sunLight, this.fill, this.rim);
  }
}

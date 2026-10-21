import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { TEAMS, type TeamId } from '../core/config';
import { clamp, damp, dampAngle, lerp } from '../core/utils';
import { buildGun, flattenByMaterial } from './gunModels';
import type { WeaponId } from './weapons';
import { cloakMaterial, xrayMaterial } from '../render/shaders';

export interface AvatarState {
  pos: THREE.Vector3;
  yaw: number;
  pitch: number;
  vel: THREE.Vector3;
  crouch: number;
  onGround: boolean;
  ads: boolean;
  reloading: boolean;
  cloak: boolean;
  adrenaline: boolean;
  throwing?: boolean;
}

interface TeamMats {
  suit: THREE.MeshStandardMaterial;
  armor: THREE.MeshStandardMaterial;
  helmet: THREE.MeshStandardMaterial;
  glow: THREE.MeshBasicMaterial;
  dark: THREE.MeshStandardMaterial;
  skin: THREE.MeshStandardMaterial;
}

/**
 * Adds a faint team-coloured fresnel rim so silhouettes stay readable in the
 * dark warehouse and against busy backgrounds.
 */
function withRim<M extends THREE.MeshStandardMaterial>(m: M, color: number, strength: number): M {
  const rim = new THREE.Color(color).multiplyScalar(strength);
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uRimColor = { value: rim };
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 uRimColor;')
      .replace(
        '#include <opaque_fragment>',
        `float rimF = pow(1.0 - clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0), 3.0);
        outgoingLight += uRimColor * rimF;
        #include <opaque_fragment>`,
      );
  };
  m.customProgramCacheKey = () => 'avatar-rim';
  return m;
}

const matCache = new Map<TeamId, TeamMats>();
function teamMats(team: TeamId): TeamMats {
  let m = matCache.get(team);
  if (m) return m;
  const tint = team === 0 ? 0x23404e : 0x4e2a20;
  const tc = TEAMS[team].color;
  m = {
    suit: withRim(new THREE.MeshStandardMaterial({ color: 0x343840, roughness: 0.88, metalness: 0.02 }), tc, 0.2),
    armor: withRim(new THREE.MeshStandardMaterial({ color: tint, roughness: 0.48, metalness: 0.35 }), tc, 0.26),
    helmet: withRim(new THREE.MeshStandardMaterial({ color: team === 0 ? 0x2c3a44 : 0x44302a, roughness: 0.4, metalness: 0.4 }), tc, 0.26),
    glow: new THREE.MeshBasicMaterial({ color: new THREE.Color(tc).multiplyScalar(4.5) }),
    dark: withRim(new THREE.MeshStandardMaterial({ color: 0x1b1c20, roughness: 0.75, metalness: 0.1 }), tc, 0.14),
    skin: withRim(new THREE.MeshStandardMaterial({ color: 0x1b1c1f, roughness: 0.9 }), tc, 0.14),
  };
  matCache.set(team, m);
  return m;
}

const rb = (w: number, h: number, d: number, r = 0.03): THREE.BufferGeometry => new RoundedBoxGeometry(w, h, d, 2, Math.min(r, w / 2 - 0.001, h / 2 - 0.001, d / 2 - 0.001));
const capsule = (r: number, len: number): THREE.BufferGeometry => new THREE.CapsuleGeometry(r, len, 4, 10);

const _up = new THREE.Vector3(0, 1, 0);
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();

function placeSegment(mesh: THREE.Object3D, from: THREE.Vector3, to: THREE.Vector3): void {
  mesh.position.copy(from).add(to).multiplyScalar(0.5);
  _a.subVectors(to, from).normalize();
  mesh.quaternion.setFromUnitVectors(_up, _a);
}

/** Analytic two-bone IK: returns elbow position. */
function solveElbow(s: THREE.Vector3, h: THREE.Vector3, l1: number, l2: number, pole: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
  const d = Math.min(s.distanceTo(h), l1 + l2 - 1e-3);
  const dir = _b.subVectors(h, s).normalize();
  const a = (l1 * l1 - l2 * l2 + d * d) / (2 * d);
  const hh = Math.sqrt(Math.max(0, l1 * l1 - a * a));
  const p = _c.copy(pole).addScaledVector(dir, -pole.dot(dir)).normalize();
  return out.copy(s).addScaledVector(dir, a).addScaledVector(p, hh);
}

export class Avatar {
  readonly root = new THREE.Group();
  private pelvis = new THREE.Group();
  private spine = new THREE.Group();
  private head = new THREE.Group();
  private aim = new THREE.Group();
  private gunMount = new THREE.Group();
  private thighs: THREE.Group[] = [];
  private shins: THREE.Group[] = [];
  private armMeshes: THREE.Mesh[] = [];
  private gun: THREE.Object3D | null = null;
  private gunId: WeaponId | null = null;
  private meshes: THREE.Mesh[] = [];
  private originalMats = new Map<THREE.Mesh, THREE.Material>();
  private xrayMeshes: THREE.Mesh[] = [];
  private phase = 0;
  private smoothYaw = 0;
  private smoothCrouch = 0;
  private air = 0;
  private kick = 0;
  private reloadW = 0;
  private throwW = 0;
  private deathT = -1;
  private deathDir = new THREE.Vector2();
  private cloaked = false;
  private revealed = false;
  private mats: TeamMats;
  private readonly cloakMat = cloakMaterial();
  private readonly xrayMat = xrayMaterial(0xff3a4a);
  readonly muzzle = new THREE.Object3D();

  constructor(
    public team: TeamId,
    weapon: WeaponId,
  ) {
    this.mats = teamMats(team);
    this.build();
    this.setWeapon(weapon);
  }

  private add(parent: THREE.Object3D, geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0): THREE.Mesh {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.rotation.set(rx, ry, rz);
    m.castShadow = true;
    m.receiveShadow = true;
    parent.add(m);
    this.meshes.push(m);
    return m;
  }

  private build(): void {
    const M = this.mats;
    this.root.add(this.pelvis);
    this.pelvis.position.y = 0.95;
    this.add(this.pelvis, rb(0.32, 0.16, 0.2, 0.05), M.suit, 0, 0, 0);
    this.add(this.pelvis, rb(0.34, 0.05, 0.22, 0.02), M.dark, 0, 0.06, 0);
    // pouches on the belt
    for (const x of [-0.13, 0.13]) this.add(this.pelvis, rb(0.06, 0.08, 0.07, 0.015), M.armor, x, 0.0, -0.1);

    // Legs
    for (const side of [-1, 1]) {
      const thigh = new THREE.Group();
      thigh.position.set(side * 0.1, -0.04, 0);
      this.pelvis.add(thigh);
      this.add(thigh, capsule(0.1, 0.28), M.suit, 0, -0.22, 0);
      this.add(thigh, rb(0.12, 0.14, 0.05, 0.018), M.armor, side * 0.02, -0.2, -0.095);
      this.add(thigh, rb(0.08, 0.1, 0.06, 0.02), M.dark, side * 0.1, -0.24, 0.0);
      const shin = new THREE.Group();
      shin.position.y = -0.44;
      thigh.add(shin);
      this.add(shin, rb(0.14, 0.1, 0.14, 0.04), M.armor, 0, 0, -0.025);
      this.add(shin, capsule(0.085, 0.28), M.suit, 0, -0.2, 0);
      this.add(shin, rb(0.135, 0.12, 0.28, 0.035), M.dark, 0, -0.42, -0.05);
      this.add(shin, rb(0.14, 0.03, 0.29, 0.01), M.skin, 0, -0.475, -0.05);
      this.thighs.push(thigh);
      this.shins.push(shin);
    }

    // Torso
    this.spine.position.y = 0.08;
    this.pelvis.add(this.spine);
    this.add(this.spine, rb(0.36, 0.44, 0.22, 0.07), M.suit, 0, 0.24, 0);
    this.add(this.spine, rb(0.4, 0.32, 0.1, 0.04), M.armor, 0, 0.28, -0.1);
    this.add(this.spine, rb(0.38, 0.3, 0.08, 0.04), M.armor, 0, 0.28, 0.1);
    this.add(this.spine, rb(0.3, 0.025, 0.012, 0.005), M.glow, 0, 0.36, -0.153);
    for (const x of [-0.09, 0, 0.09]) this.add(this.spine, rb(0.07, 0.09, 0.05, 0.015), M.dark, x, 0.17, -0.16);
    this.add(this.spine, rb(0.28, 0.32, 0.13, 0.04), M.dark, 0, 0.26, 0.19);
    this.add(this.spine, rb(0.05, 0.2, 0.012, 0.005), M.glow, 0, 0.3, 0.258);
    // shoulder pads
    for (const side of [-1, 1]) {
      this.add(this.spine, rb(0.13, 0.08, 0.17, 0.035), M.armor, side * 0.24, 0.46, 0, 0, 0, side * -0.35);
      this.add(this.spine, rb(0.02, 0.012, 0.1, 0.004), M.glow, side * 0.29, 0.49, 0, 0, 0, side * -0.35);
    }

    // Head
    this.head.position.set(0, 0.52, 0);
    this.spine.add(this.head);
    this.add(this.head, capsule(0.055, 0.06), M.skin, 0, 0.02, 0);
    this.add(this.head, new THREE.SphereGeometry(0.115, 18, 14), M.skin, 0, 0.13, 0);
    const helm = this.add(this.head, new THREE.SphereGeometry(0.138, 20, 14, 0, Math.PI * 2, 0, Math.PI * 0.55), M.helmet, 0, 0.14, 0.01);
    helm.scale.set(1, 0.95, 1.08);
    this.add(this.head, rb(0.2, 0.055, 0.06, 0.02), M.glow, 0, 0.135, -0.1);
    this.add(this.head, rb(0.22, 0.03, 0.08, 0.01), M.helmet, 0, 0.175, -0.095);
    this.add(this.head, rb(0.03, 0.05, 0.05, 0.01), M.dark, 0.14, 0.15, 0.0);

    // Aim group (arms + weapon)
    this.aim.position.set(0, 0.4, 0);
    this.spine.add(this.aim);
    this.aim.add(this.gunMount);
    this.gunMount.position.set(0.12, -0.08, -0.32);
    this.muzzle.position.set(0, 0, -0.6);
    this.gunMount.add(this.muzzle);
    for (let i = 0; i < 6; i++) {
      const isHand = i === 2 || i === 5;
      const mesh = new THREE.Mesh(isHand ? rb(0.08, 0.095, 0.11, 0.028) : capsule(i % 3 === 0 ? 0.072 : 0.062, i % 3 === 0 ? 0.17 : 0.16), isHand ? M.dark : M.suit);
      mesh.castShadow = true;
      this.aim.add(mesh);
      this.meshes.push(mesh);
      this.armMeshes.push(mesh);
    }
    for (const m of this.meshes) this.originalMats.set(m, m.material as THREE.Material);
  }

  setTeam(team: TeamId): void {
    if (team === this.team) return;
    const old = this.mats;
    this.team = team;
    this.mats = teamMats(team);
    for (const m of this.meshes) {
      const cur = this.originalMats.get(m);
      const key = (Object.keys(old) as (keyof TeamMats)[]).find((k) => old[k] === cur);
      if (key) {
        this.originalMats.set(m, this.mats[key]);
        if (!this.cloaked) m.material = this.mats[key];
      }
    }
  }

  setWeapon(id: WeaponId): void {
    if (this.gunId === id) return;
    this.gunId = id;
    if (this.gun) {
      this.gunMount.remove(this.gun);
      this.gun.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) m.geometry.dispose();
      });
    }
    // Weapon-specific hold: pistols are pushed out two-handed, knives held low.
    const mount = id === 'pistol' || id === 'magnum' ? [0.03, -0.02, -0.46] : id === 'knife' ? [0.2, -0.22, -0.26] : [0.12, -0.08, -0.32];
    this.gunMount.position.set(mount[0], mount[1], mount[2]);
    const model = buildGun(id);
    const flat = flattenByMaterial(model);
    this.gun = flat;
    this.gunMount.add(flat);
    flat.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        m.castShadow = true;
        if (this.cloaked) m.visible = false;
      }
    });
    const muzzleAnchor = flat.getObjectByName('muzzle');
    if (muzzleAnchor) this.muzzle.position.copy(muzzleAnchor.position);
    // Solve arm IK against this weapon's grips (in aim-group space).
    const gripR = model.getObjectByName('gripR')?.position.clone() ?? new THREE.Vector3();
    const gripL = model.getObjectByName('gripL')?.position.clone() ?? new THREE.Vector3(0, 0, -0.25);
    if (id === 'knife') gripL.set(-0.25, -0.2, 0.15);
    gripR.add(this.gunMount.position);
    gripL.add(this.gunMount.position);
    const shR = new THREE.Vector3(0.21, 0.04, 0.02);
    const shL = new THREE.Vector3(-0.21, 0.04, 0.02);
    const elR = solveElbow(shR, gripR, 0.28, 0.27, new THREE.Vector3(0.6, -1, 0.3), new THREE.Vector3());
    const elL = solveElbow(shL, gripL, 0.28, 0.3, new THREE.Vector3(-0.8, -1, 0.1), new THREE.Vector3());
    placeSegment(this.armMeshes[0], shR, elR);
    placeSegment(this.armMeshes[1], elR, gripR);
    this.armMeshes[2].position.copy(gripR);
    placeSegment(this.armMeshes[3], shL, elL);
    placeSegment(this.armMeshes[4], elL, gripL);
    this.armMeshes[5].position.copy(gripL);
  }

  setCloaked(on: boolean, alpha = 1): void {
    this.cloakMat.uniforms.uAlpha.value = alpha;
    if (on === this.cloaked) return;
    this.cloaked = on;
    for (const m of this.meshes) {
      m.material = on ? this.cloakMat : this.originalMats.get(m)!;
      m.castShadow = !on;
    }
    this.gun?.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) o.visible = !on;
    });
  }

  setRevealed(on: boolean): void {
    if (on === this.revealed) return;
    this.revealed = on;
    if (on && this.xrayMeshes.length === 0) {
      for (const m of this.meshes) {
        const x = new THREE.Mesh(m.geometry, this.xrayMat);
        x.position.copy(m.position);
        x.quaternion.copy(m.quaternion);
        x.scale.copy(m.scale);
        x.renderOrder = 50;
        x.frustumCulled = false;
        m.parent!.add(x);
        this.xrayMeshes.push(x);
      }
    }
    for (const x of this.xrayMeshes) x.visible = on;
  }

  die(dirX: number, dirZ: number): void {
    this.deathT = 0;
    this.deathDir.set(dirX, dirZ).normalize();
  }

  revive(): void {
    this.deathT = -1;
    this.root.rotation.set(0, this.root.rotation.y, 0);
    this.root.position.y = 0;
    this.root.visible = true;
  }

  get dead(): boolean {
    return this.deathT >= 0;
  }

  fireKick(): void {
    this.kick = 1;
  }

  update(dt: number, s: AvatarState): void {
    this.root.position.copy(s.pos);
    if (this.deathT >= 0) {
      this.updateDeath(dt);
      return;
    }
    this.smoothYaw = dampAngle(this.smoothYaw, s.yaw, 18, dt);
    this.root.rotation.set(0, this.smoothYaw, 0);
    this.smoothCrouch = damp(this.smoothCrouch, s.crouch, 14, dt);
    this.air = damp(this.air, s.onGround ? 0 : 1, 10, dt);
    this.kick = Math.max(0, this.kick - dt * 9);
    this.reloadW = damp(this.reloadW, s.reloading ? 1 : 0, 8, dt);
    this.throwW = damp(this.throwW, s.throwing ? 1 : 0, 14, dt);

    // Local-space velocity
    const cy = Math.cos(this.smoothYaw);
    const sy = Math.sin(this.smoothYaw);
    const fwd = -s.vel.x * sy - s.vel.z * cy;
    const right = s.vel.x * cy - s.vel.z * sy;
    const speed = Math.hypot(s.vel.x, s.vel.z);
    const moveW = clamp(speed / 3, 0, 1) * (1 - this.air);
    this.phase += dt * (speed * 1.75 + 0.01) * (s.crouch > 0.5 ? 0.8 : 1);
    const sw = Math.sin(this.phase * Math.PI);
    const cw = Math.cos(this.phase * Math.PI);
    const fwdAmt = speed > 0.1 ? fwd / speed : 0;
    const sideAmt = speed > 0.1 ? right / speed : 0;
    const amp = 0.62 * moveW;

    const crouch = this.smoothCrouch;
    this.pelvis.position.y = lerp(0.95, 0.58, crouch) + Math.abs(cw) * 0.03 * moveW - this.air * 0.04;
    for (let i = 0; i < 2; i++) {
      const sign = i === 0 ? 1 : -1;
      const swing = sw * sign;
      const thighX = swing * amp * fwdAmt + crouch * 1.2 + this.air * 0.55;
      const thighZ = swing * amp * sideAmt * 0.5;
      this.thighs[i].rotation.set(thighX, 0, thighZ);
      const knee = Math.max(0, -Math.cos(this.phase * Math.PI + (sign > 0 ? 0 : Math.PI))) * 0.9 * moveW + crouch * 2.05 + this.air * 0.9;
      this.shins[i].rotation.set(-knee, 0, 0);
    }
    // Upper body: lean, aim pitch, breathing.
    const pitch = clamp(s.pitch, -1.2, 1.2);
    const lean = crouch * 0.28 + fwdAmt * 0.08 * moveW;
    this.spine.rotation.set(lean + pitch * 0.25, 0, -sideAmt * 0.06 * moveW);
    this.head.rotation.set(pitch * 0.55 - lean * 0.6, 0, 0);
    this.aim.rotation.set(pitch * 0.75 - lean - this.reloadW * 0.5 - this.throwW * 0.9, this.throwW * 0.4, this.reloadW * 0.35);
    this.aim.position.set(0, 0.4 + Math.sin(this.phase * Math.PI * 2) * 0.008 * moveW, this.kick * 0.04);
    this.root.position.y = s.pos.y;
  }

  private updateDeath(dt: number): void {
    this.deathT += dt;
    const t = Math.min(1, this.deathT / 0.55);
    const e = 1 - Math.pow(1 - t, 3);
    // Fall over in the direction of the killing shot.
    const ang = e * (Math.PI / 2) * 0.96;
    const dx = this.deathDir.x;
    const dz = this.deathDir.y;
    const ry = this.root.rotation.y;
    // Convert world fall direction into the avatar's local frame.
    const lx = dx * Math.cos(ry) - dz * Math.sin(ry);
    const lz = dx * Math.sin(ry) + dz * Math.cos(ry);
    this.root.rotation.set(lz * ang, ry, -lx * ang, 'YXZ');
    this.pelvis.position.y = lerp(this.pelvis.position.y, 0.35, dt * 6);
    for (const th of this.thighs) th.rotation.x = lerp(th.rotation.x, 0.3, dt * 5);
    for (const sh of this.shins) sh.rotation.x = lerp(sh.rotation.x, -0.4, dt * 5);
    this.aim.rotation.x = lerp(this.aim.rotation.x, -1.0, dt * 4);
    if (this.deathT > 6) this.root.visible = false;
  }

  getMuzzleWorld(out: THREE.Vector3): THREE.Vector3 {
    this.muzzle.updateWorldMatrix(true, false);
    return out.setFromMatrixPosition(this.muzzle.matrixWorld);
  }

  dispose(): void {
    this.root.removeFromParent();
    for (const m of this.meshes) m.geometry.dispose();
  }
}

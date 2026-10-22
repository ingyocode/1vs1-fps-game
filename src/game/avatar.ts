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

/**
 * Two classic tactical-shooter factions:
 * - team 0 (VANGUARD): FBI tactical agent — navy BDU, plate carrier with yellow FBI
 *   lettering, high-cut ballistic helmet, ear pro and shooting glasses.
 * - team 1 (EMBER): insurgent — knit balaclava, shemagh, olive field jacket over desert
 *   camo trousers, coyote chest rig with rifle-mag pouches.
 * Both keep a team-coloured armband and a faint team rim so sides read at a glance.
 */
interface Look {
  jacket: THREE.MeshStandardMaterial;
  pants: THREE.MeshStandardMaterial;
  gear: THREE.MeshStandardMaterial;
  pouch: THREE.MeshStandardMaterial;
  head: THREE.MeshStandardMaterial;
  skin: THREE.MeshStandardMaterial;
  gloves: THREE.MeshStandardMaterial;
  boots: THREE.MeshStandardMaterial;
  sole: THREE.MeshStandardMaterial;
  dark: THREE.MeshStandardMaterial;
  accent: THREE.MeshStandardMaterial;
  lens: THREE.MeshStandardMaterial;
  patch: THREE.MeshStandardMaterial;
  scarf: THREE.MeshStandardMaterial;
}

/** Adds a faint team-coloured fresnel rim so silhouettes stay readable in dark corners. */
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

function canvasTex(w: number, h: number, draw: (ctx: CanvasRenderingContext2D) => void, repeat = 1): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d')!);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat, repeat);
  t.anisotropy = 4;
  return t;
}

/** Yellow block lettering on navy cordura. */
function letteringTex(text: string): THREE.CanvasTexture {
  return canvasTex(256, 96, (ctx) => {
    ctx.fillStyle = '#161c29';
    ctx.fillRect(0, 0, 256, 96);
    ctx.fillStyle = '#e8c23a';
    ctx.font = '900 76px "Arial Black", Impact, Rajdhani, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 128, 52);
  });
}

/** Three-colour desert camouflage blotches. */
function camoTex(): THREE.CanvasTexture {
  let seed = 7;
  const rnd = (): number => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  return canvasTex(
    256,
    256,
    (ctx) => {
      ctx.fillStyle = '#8f7f5c';
      ctx.fillRect(0, 0, 256, 256);
      for (const [col, n, size] of [
        ['#6f5d40', 26, 34],
        ['#5b5d3c', 20, 28],
        ['#b0a07a', 18, 18],
      ] as const) {
        ctx.fillStyle = col;
        for (let i = 0; i < n; i++) {
          const x = rnd() * 256;
          const y = rnd() * 256;
          ctx.beginPath();
          for (let k = 0; k < 7; k++) {
            const a = (k / 7) * Math.PI * 2;
            const r = size * (0.5 + rnd() * 0.6);
            ctx.lineTo(x + Math.cos(a) * r * 1.4, y + Math.sin(a) * r);
          }
          ctx.fill();
        }
      }
    },
    2,
  );
}

/** Red-on-white shemagh weave. */
function shemaghTex(): THREE.CanvasTexture {
  return canvasTex(
    128,
    128,
    (ctx) => {
      ctx.fillStyle = '#d9d2c4';
      ctx.fillRect(0, 0, 128, 128);
      ctx.fillStyle = '#8e2420';
      for (let i = 0; i < 8; i++) {
        for (let j = 0; j < 8; j++) {
          if ((i + j) % 2 === 0) ctx.fillRect(i * 16 + 3, j * 16 + 3, 10, 10);
        }
      }
      ctx.fillStyle = 'rgba(142,36,32,0.55)';
      for (let i = 0; i < 128; i += 16) {
        ctx.fillRect(i, 0, 2, 128);
        ctx.fillRect(0, i, 128, 2);
      }
    },
    3,
  );
}

const lookCache = new Map<TeamId, Look>();
function teamLook(team: TeamId): Look {
  let l = lookCache.get(team);
  if (l) return l;
  const tc = TEAMS[team].color;
  const cloth = (color: number, rough = 0.92, rim = 0.07, map?: THREE.Texture): THREE.MeshStandardMaterial =>
    withRim(new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: 0, ...(map ? { map } : {}) }), tc, rim);
  const accent = new THREE.MeshStandardMaterial({ color: tc, roughness: 0.6, emissive: tc, emissiveIntensity: 0.55 });
  const lens = new THREE.MeshStandardMaterial({ color: 0x1a1f26, roughness: 0.08, metalness: 0.6, transparent: true, opacity: 0.78 });
  if (team === 0) {
    l = {
      jacket: cloth(0x1f2c47),
      pants: cloth(0x232a38),
      gear: cloth(0x171c27, 0.85),
      pouch: cloth(0x1d2331, 0.88),
      head: withRim(new THREE.MeshStandardMaterial({ color: 0x1c1f25, roughness: 0.5, metalness: 0.15 }), tc, 0.09),
      skin: cloth(0xc49a80, 0.68, 0.06),
      gloves: cloth(0x141518, 0.75),
      boots: cloth(0x131417, 0.7),
      sole: cloth(0x0b0b0c, 0.9, 0),
      dark: cloth(0x0f1013, 0.6),
      accent,
      lens,
      patch: new THREE.MeshStandardMaterial({ map: letteringTex('FBI'), roughness: 0.85 }),
      scarf: cloth(0x232a38),
    };
  } else {
    l = {
      jacket: cloth(0x4d4a34),
      pants: cloth(0xffffff, 0.94, 0.07, camoTex()),
      gear: cloth(0x7a684b, 0.9),
      pouch: cloth(0x6f5f44, 0.9),
      head: cloth(0x161618, 1.0, 0.09),
      skin: cloth(0x9c6b50, 0.7, 0.06),
      gloves: cloth(0x2e271f, 0.8),
      boots: cloth(0x3b2d20, 0.75),
      sole: cloth(0x141210, 0.9, 0),
      dark: cloth(0x1b1a17, 0.7),
      accent,
      lens,
      patch: cloth(0x6f5f44),
      scarf: cloth(0xffffff, 0.95, 0.08, shemaghTex()),
    };
  }
  lookCache.set(team, l);
  return l;
}

const rb = (w: number, h: number, d: number, r = 0.03): THREE.BufferGeometry => new RoundedBoxGeometry(w, h, d, 2, Math.min(r, w / 2 - 0.001, h / 2 - 0.001, d / 2 - 0.001));
/** Revolved limb/torso shape from [radius, y] pairs (y ascending). */
const lathe = (pts: [number, number][], seg = 16): THREE.BufferGeometry => new THREE.LatheGeometry(
  pts.map(([r, y]) => new THREE.Vector2(r, y)),
  seg,
);
/** Tapered limb segment along +Y, centred, with rounded ends. */
function limb(r0: number, r1: number, len: number): THREE.BufferGeometry {
  const h = len / 2;
  return lathe([
    [0.001, -h - r0 * 0.6],
    [r0 * 0.75, -h - r0 * 0.35],
    [r0, -h],
    [(r0 + r1) / 2 + Math.max(r0, r1) * 0.06, 0],
    [r1, h],
    [r1 * 0.75, h + r1 * 0.35],
    [0.001, h + r1 * 0.6],
  ]);
}

const _up = new THREE.Vector3(0, 1, 0);
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();

function placeSegment(obj: THREE.Object3D, from: THREE.Vector3, to: THREE.Vector3, baseLen: number): void {
  obj.position.copy(from).add(to).multiplyScalar(0.5);
  _a.subVectors(to, from);
  const len = _a.length();
  obj.quaternion.setFromUnitVectors(_up, _a.divideScalar(len || 1));
  obj.scale.set(1, len / baseLen, 1);
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

/** Upper arm / forearm (shoulder → elbow → palm). */
const UPPER = 0.3;
const FORE = 0.31;
const SHOULDER_W = 0.19;

/**
 * Weapon hold per class, in aim space: where the gun's origin (trigger) sits, how far the
 * chest blades towards the support side and how much the head drops onto the stock.
 */
const HOLDS: Record<'pistol' | 'long' | 'sniper' | 'knife', { mount: [number, number, number]; blade: number; cheek: number }> = {
  pistol: { mount: [0.0, 0.0, -0.48], blade: 0, cheek: 0 },
  long: { mount: [0.13, 0.045, -0.31], blade: -0.4, cheek: 0.16 },
  sniper: { mount: [0.13, 0.0, -0.385], blade: -0.4, cheek: 0.2 },
  knife: { mount: [0.2, -0.22, -0.26], blade: 0, cheek: 0 },
};

function holdOf(id: WeaponId): (typeof HOLDS)[keyof typeof HOLDS] & { butt: number } {
  if (id === 'pistol' || id === 'magnum') return { ...HOLDS.pistol, butt: 0 };
  if (id === 'knife') return { ...HOLDS.knife, butt: 0 };
  if (id === 'sniper') return { ...HOLDS.sniper, butt: 0.385 };
  // Butt-pad distance behind the trigger (MP5 / 870 / M4) so every stock meets the shoulder.
  const butt = id === 'smg' ? 0.333 : id === 'shotgun' ? 0.358 : 0.302;
  return { ...HOLDS.long, mount: [HOLDS.long.mount[0], HOLDS.long.mount[1], -butt], butt };
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
  /** upper R, fore R, hand R, upper L, fore L, hand L */
  private armParts: THREE.Group[] = [];
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
  private blade = 0;
  private cheek = 0;
  private deathT = -1;
  private deathDir = new THREE.Vector2();
  private cloaked = false;
  private revealed = false;
  private look: Look;
  private readonly cloakMat = cloakMaterial();
  private readonly xrayMat = xrayMaterial(0xff3a4a);
  readonly muzzle = new THREE.Object3D();

  constructor(
    public team: TeamId,
    weapon: WeaponId,
  ) {
    this.look = teamLook(team);
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
    const L = this.look;
    const fbi = this.team === 0;
    this.root.add(this.pelvis);
    this.pelvis.position.y = 0.95;

    // --- Hips & belt ---------------------------------------------------------
    this.add(this.pelvis, rb(0.33, 0.2, 0.22, 0.08), L.pants, 0, 0.0, 0);
    this.add(this.pelvis, rb(0.35, 0.05, 0.235, 0.02), L.dark, 0, 0.075, 0);
    this.add(this.pelvis, rb(0.05, 0.035, 0.02, 0.006), L.gear, 0, 0.075, -0.12);
    if (fbi) {
      // Drop-leg holster with a sidearm, cuff and mag pouches on the belt
      this.add(this.pelvis, rb(0.06, 0.16, 0.12, 0.02), L.gear, 0.2, -0.13, 0.0);
      this.add(this.pelvis, rb(0.035, 0.05, 0.08, 0.01), L.dark, 0.2, -0.03, 0.0);
      for (const z of [-0.06, 0.03]) this.add(this.pelvis, rb(0.05, 0.07, 0.04, 0.012), L.pouch, -0.17, 0.05, z);
    } else {
      // Canvas satchel on a shoulder strap
      this.add(this.pelvis, rb(0.07, 0.16, 0.2, 0.03), L.gear, -0.21, -0.02, 0.02);
      this.add(this.pelvis, rb(0.075, 0.04, 0.205, 0.015), L.pouch, -0.212, 0.05, 0.02);
    }

    // --- Legs ----------------------------------------------------------------
    for (const side of [-1, 1]) {
      const thigh = new THREE.Group();
      thigh.position.set(side * 0.1, -0.04, 0);
      this.pelvis.add(thigh);
      this.add(thigh, limb(0.09, 0.066, 0.38), L.pants, 0, -0.21, 0).scale.set(1, 1, 0.92);
      // Cargo pocket on the outside of the thigh
      this.add(thigh, rb(0.03, 0.11, 0.09, 0.012), L.pants, side * 0.07, -0.2, 0.0);
      const shin = new THREE.Group();
      shin.position.y = -0.44;
      thigh.add(shin);
      // Calf with a bulge, tapering to the boot
      this.add(
        shin,
        lathe([
          [0.001, -0.39],
          [0.045, -0.38],
          [0.05, -0.28],
          [0.06, -0.16],
          [0.064, -0.08],
          [0.058, 0],
          [0.03, 0.03],
          [0.001, 0.035],
        ]),
        L.pants,
        0,
        0,
        0.005,
      ).scale.set(1, 1, 0.92);
      if (fbi) this.add(shin, rb(0.095, 0.11, 0.05, 0.02), L.dark, 0, -0.01, -0.058);
      // Boot: upper, toe box, sole
      this.add(shin, rb(0.105, 0.13, 0.15, 0.04), L.boots, 0, -0.39, 0.0);
      this.add(shin, rb(0.1, 0.075, 0.15, 0.035), L.boots, 0, -0.425, -0.09);
      this.add(shin, rb(0.112, 0.03, 0.28, 0.012), L.sole, 0, -0.455, -0.045);
      this.thighs.push(thigh);
      this.shins.push(shin);
    }

    // --- Torso -----------------------------------------------------------------
    this.spine.position.y = 0.08;
    this.pelvis.add(this.spine);
    const torso = this.add(
      this.spine,
      lathe(
        [
          [0.001, -0.02],
          [0.15, 0.0],
          [0.155, 0.06],
          [0.148, 0.14],
          [0.16, 0.24],
          [0.172, 0.34],
          [0.168, 0.42],
          [0.14, 0.47],
          [0.09, 0.5],
          [0.055, 0.52],
        ],
        20,
      ),
      L.jacket,
      0,
      0,
      0,
    );
    torso.scale.set(1.22, 1, 0.74);
    for (const side of [-1, 1]) this.add(this.spine, new THREE.SphereGeometry(0.068, 14, 10), L.jacket, side * SHOULDER_W, 0.415, 0).scale.set(1, 0.92, 1);
    this.add(this.spine, new THREE.CylinderGeometry(0.048, 0.054, 0.09, 12), fbi ? L.skin : L.head, 0, 0.53, 0.0);

    if (fbi) {
      // Plate carrier: front & back plates, cummerbund, shoulder straps
      this.add(this.spine, rb(0.3, 0.31, 0.05, 0.02), L.gear, 0, 0.3, -0.114);
      this.add(this.spine, rb(0.3, 0.33, 0.05, 0.02), L.gear, 0, 0.3, 0.114);
      for (const side of [-1, 1]) {
        this.add(this.spine, rb(0.04, 0.16, 0.2, 0.012), L.gear, side * 0.192, 0.22, 0);
        this.add(this.spine, rb(0.06, 0.028, 0.25, 0.01), L.gear, side * 0.1, 0.46, 0);
      }
      // Rifle-mag pouches, admin pouch and radio
      for (const x of [-0.08, 0, 0.08]) this.add(this.spine, rb(0.07, 0.095, 0.05, 0.012), L.pouch, x, 0.205, -0.158);
      this.add(this.spine, rb(0.16, 0.06, 0.03, 0.01), L.pouch, 0, 0.29, -0.152);
      this.add(this.spine, rb(0.05, 0.11, 0.04, 0.01), L.dark, -0.12, 0.37, -0.15);
      // FBI lettering: chest placard and across the back
      const chest = this.add(this.spine, new THREE.PlaneGeometry(0.15, 0.056), L.patch, 0, 0.36, -0.1405);
      chest.rotation.y = Math.PI;
      chest.castShadow = false;
      const back = this.add(this.spine, new THREE.PlaneGeometry(0.25, 0.094), L.patch, 0, 0.4, 0.1405);
      back.castShadow = false;
      // Hydration / comms pack
      this.add(this.spine, rb(0.18, 0.2, 0.05, 0.02), L.pouch, 0, 0.215, 0.155);
    } else {
      // Coyote chest rig with tall AK-mag pouches and an X-harness on the back
      this.add(this.spine, rb(0.31, 0.19, 0.045, 0.016), L.gear, 0, 0.2, -0.118);
      for (const x of [-0.09, 0, 0.09]) {
        this.add(this.spine, rb(0.074, 0.14, 0.05, 0.012), L.pouch, x, 0.235, -0.155);
        this.add(this.spine, rb(0.076, 0.03, 0.054, 0.008), L.gear, x, 0.3, -0.156);
      }
      for (const side of [-1, 1]) {
        this.add(this.spine, rb(0.05, 0.025, 0.26, 0.008), L.gear, side * 0.1, 0.45, 0);
        this.add(this.spine, rb(0.045, 0.32, 0.012, 0.005), L.gear, side * 0.04, 0.28, 0.122, 0, 0, side * 0.55);
      }
      // Chemlight on the rig strap (team marker)
      this.add(this.spine, new THREE.CylinderGeometry(0.008, 0.008, 0.07, 8), L.accent, 0.12, 0.38, -0.13, 0, 0, 0.3);
      // Shemagh wrapped round the neck, tail hanging over the chest
      this.add(this.spine, new THREE.TorusGeometry(0.075, 0.032, 8, 18), L.scarf, 0, 0.5, 0, Math.PI / 2, 0, 0).scale.set(1, 0.85, 1);
      // Loose fold of the scarf draped under the chin
      this.add(this.spine, new THREE.SphereGeometry(0.07, 12, 8), L.scarf, 0, 0.465, -0.07).scale.set(1.1, 0.55, 0.75);
    }

    // --- Head --------------------------------------------------------------------
    this.head.position.set(0, 0.5, 0);
    this.spine.add(this.head);
    const skullMat = fbi ? L.skin : L.head;
    this.add(this.head, new THREE.SphereGeometry(0.105, 20, 16), skullMat, 0, 0.1, 0).scale.set(0.9, 1.07, 1.0);
    // Jaw, nose, brow and ears give the face a profile
    this.add(this.head, rb(0.11, 0.06, 0.1, 0.03), skullMat, 0, 0.035, -0.032);
    this.add(this.head, rb(0.02, 0.036, 0.03, 0.008), skullMat, 0, 0.085, -0.1, 0.18, 0, 0);
    this.add(this.head, rb(0.1, 0.018, 0.025, 0.008), skullMat, 0, 0.122, -0.095);
    for (const side of [-1, 1]) this.add(this.head, new THREE.SphereGeometry(0.022, 8, 6), skullMat, side * 0.094, 0.095, 0.0).scale.set(0.45, 1, 0.8);
    if (fbi) {
      // High-cut ballistic helmet with side rails, NVG shroud and an IR strobe
      this.add(this.head, new THREE.SphereGeometry(0.122, 22, 12, 0, Math.PI * 2, 0, Math.PI * 0.5), L.head, 0, 0.118, 0.006).scale.set(0.96, 0.88, 1.04);
      for (const side of [-1, 1]) this.add(this.head, rb(0.012, 0.028, 0.12, 0.004), L.dark, side * 0.115, 0.14, 0.005);
      this.add(this.head, rb(0.045, 0.032, 0.02, 0.006), L.dark, 0, 0.172, -0.122);
      this.add(this.head, rb(0.016, 0.012, 0.016, 0.003), L.accent, 0, 0.222, 0.05);
      // Ear pro cups + headband
      for (const side of [-1, 1]) {
        const cup = this.add(this.head, new THREE.CylinderGeometry(0.036, 0.036, 0.03, 16), L.dark, side * 0.1, 0.092, 0.004);
        cup.rotation.z = Math.PI / 2;
      }
      // Shooting glasses
      this.add(this.head, rb(0.118, 0.03, 0.012, 0.006), L.lens, 0, 0.108, -0.104);
      this.add(this.head, rb(0.12, 0.006, 0.014, 0.002), L.dark, 0, 0.124, -0.104);
    } else {
      // Knit balaclava over the head, skin only round the eyes, tan headband
      this.add(this.head, new THREE.SphereGeometry(0.11, 20, 16), L.head, 0, 0.102, 0.002).scale.set(0.93, 1.08, 1.02);
      this.add(this.head, rb(0.1, 0.07, 0.11, 0.032), L.head, 0, 0.04, -0.034);
      this.add(this.head, rb(0.088, 0.03, 0.02, 0.01), L.skin, 0, 0.106, -0.104);
      for (const side of [-1, 1]) this.add(this.head, new THREE.SphereGeometry(0.008, 8, 6), L.dark, side * 0.026, 0.107, -0.11);
      this.add(this.head, new THREE.TorusGeometry(0.104, 0.012, 6, 24), L.gear, 0, 0.15, 0.0, Math.PI / 2 + 0.12, 0, 0).scale.set(0.95, 1.05, 1);
    }

    // --- Aim group: weapon + arms ------------------------------------------------
    this.aim.position.set(0, 0.4, 0);
    this.spine.add(this.aim);
    this.aim.add(this.gunMount);
    this.muzzle.position.set(0, 0, -0.6);
    this.gunMount.add(this.muzzle);
    for (let i = 0; i < 6; i++) {
      const part = new THREE.Group();
      this.aim.add(part);
      this.armParts.push(part);
      const k = i % 3;
      if (k === 0) {
        this.add(part, limb(0.058, 0.048, UPPER), L.jacket, 0, 0, 0);
        // Team armband on the support arm, flag patch on the gun arm
        if (i === 3) this.add(part, new THREE.CylinderGeometry(0.061, 0.06, 0.05, 14), L.accent, 0, -0.05, 0);
        else this.add(part, rb(0.012, 0.05, 0.045, 0.005), fbi ? L.patch : L.pouch, 0.055, -0.06, 0);
      } else if (k === 1) {
        this.add(part, limb(0.047, 0.04, FORE - 0.06), L.jacket, 0, -0.03, 0);
        this.add(part, new THREE.CylinderGeometry(0.043, 0.047, 0.04, 12), L.gloves, 0, (FORE - 0.06) / 2 - 0.02, 0);
      } else {
        this.add(part, rb(0.048, 0.088, 0.098, 0.022), L.gloves, 0, 0, 0);
        this.add(part, rb(0.022, 0.05, 0.026, 0.01), L.gloves, -0.026, 0.01, -0.035, 0, 0, 0.5);
      }
    }
    for (const m of this.meshes) this.originalMats.set(m, m.material as THREE.Material);
  }

  /** Throws away the rig (different faction = different gear) and builds it again. */
  private rebuild(): void {
    const weapon = this.gunId;
    for (const m of this.meshes) m.geometry.dispose();
    this.gun?.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).geometry.dispose();
    });
    for (const x of this.xrayMeshes) x.removeFromParent();
    this.meshes = [];
    this.originalMats.clear();
    this.xrayMeshes = [];
    this.thighs = [];
    this.shins = [];
    this.armParts = [];
    for (const g of [this.pelvis, this.spine, this.head, this.aim]) g.clear();
    this.gunMount.clear();
    this.root.clear();
    this.gun = null;
    this.gunId = null;
    this.build();
    if (weapon) this.setWeapon(weapon);
    const cloaked = this.cloaked;
    this.cloaked = false;
    this.setCloaked(cloaked);
    const revealed = this.revealed;
    this.revealed = false;
    this.setRevealed(revealed);
  }

  setTeam(team: TeamId): void {
    if (team === this.team) return;
    this.team = team;
    this.look = teamLook(team);
    this.rebuild();
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
    const hold = holdOf(id);
    this.gunMount.position.set(hold.mount[0], hold.mount[1], hold.mount[2]);
    this.blade = hold.blade;
    this.cheek = hold.cheek;
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
    // Solve arm IK against this weapon's grips (in aim-group space). The chest blades
    // towards the support side for long guns, which brings the left shoulder forward.
    const gripR = model.getObjectByName('gripR')?.position.clone() ?? new THREE.Vector3();
    const gripL = model.getObjectByName('gripL')?.position.clone() ?? new THREE.Vector3(0, 0, -0.25);
    if (id === 'knife') gripL.set(-0.25, -0.2, 0.15);
    gripR.add(this.gunMount.position);
    gripL.add(this.gunMount.position);
    const cb = Math.cos(this.blade);
    const sb = Math.sin(this.blade);
    const shR = new THREE.Vector3(SHOULDER_W * cb, 0.01, -SHOULDER_W * sb);
    const shL = new THREE.Vector3(-SHOULDER_W * cb, 0.01, SHOULDER_W * sb);
    // A hand just out of reach pulls its shoulder forward (protraction) instead of floating.
    for (const [sh, grip] of [
      [shR, gripR],
      [shL, gripL],
    ] as const) {
      const over = sh.distanceTo(grip) - (UPPER + FORE - 0.004);
      if (over > 0) sh.addScaledVector(_a.subVectors(grip, sh).normalize(), Math.min(0.09, over));
    }
    const elR = solveElbow(shR, gripR, UPPER, FORE, new THREE.Vector3(0.6, -1, 0.3), new THREE.Vector3());
    const elL = solveElbow(shL, gripL, UPPER, FORE, new THREE.Vector3(-0.8, -1, 0.1), new THREE.Vector3());
    placeSegment(this.armParts[0], shR, elR, UPPER);
    placeSegment(this.armParts[1], elR, gripR, FORE);
    placeSegment(this.armParts[3], shL, elL, UPPER);
    placeSegment(this.armParts[4], elL, gripL, FORE);
    // Gloved hands: gun hand wraps the raked grip, support hand cups the fore-end.
    const handR = this.armParts[2];
    const handL = this.armParts[5];
    handR.position.copy(gripR);
    handL.position.copy(gripL);
    handR.scale.setScalar(1);
    handL.scale.setScalar(1);
    if (id === 'knife') {
      handR.rotation.set(-0.2, 0, 0);
      handL.rotation.set(-0.6, 0, 0.3);
    } else if (hold.blade === 0) {
      handR.rotation.set(-0.38, 0, 0);
      handL.rotation.set(-0.3, 0.2, 0.35);
    } else {
      handR.rotation.set(-0.35, 0, 0);
      handL.rotation.set(0.1, 0, 1.25);
    }
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
    // Upper body: lean, bladed stance, aim pitch, cheek weld.
    const pitch = clamp(s.pitch, -1.2, 1.2);
    const lean = crouch * 0.28 + fwdAmt * 0.08 * moveW;
    const blade = this.blade * (1 - this.reloadW * 0.4);
    this.spine.rotation.set(lean + pitch * 0.25, blade, -sideAmt * 0.06 * moveW);
    this.head.rotation.set(pitch * 0.55 - lean * 0.6 + this.cheek * (1 - this.reloadW), -blade * 0.85, 0);
    this.aim.rotation.set(pitch * 0.75 - lean - this.reloadW * 0.5 - this.throwW * 0.9, -blade + this.throwW * 0.4, this.reloadW * 0.35);
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

import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { WeaponId } from './weapons';
import type { ThrowKind } from './abilities';

/**
 * Procedurally modelled weapons built to the published dimensions of real firearms
 * (metres, barrel along -Z, origin at the trigger):
 *
 * | in-game              | reference                     | overall length          | other                           |
 * | -------------------- | ----------------------------- | ----------------------- | ------------------------------- |
 * | P-9 Viper            | Glock 17 Gen5                 | 202 mm (slide 186 mm)   | height 139 mm, barrel 114 mm    |
 * | HC-50 Magnum         | Desert Eagle Mark XIX .50 AE  | 273 mm                  | height 159 mm, barrel 152 mm    |
 * | Vespa SMG-9          | HK MP5A3                      | 700 mm (stock extended) | height 230 mm, barrel 225 mm    |
 * | Breaker 12           | Remington 870 Tactical 18.5"  | 978 mm                  | barrel 470 mm                   |
 * | AR-7 Vanguard        | Colt M4A1 carbine             | 838 mm (stock extended) | barrel 368 mm (14.5")           |
 * | Longbow .338         | Accuracy International AWM    | 1230 mm                 | barrel 686 mm (27")             |
 *
 * Main parts are side profiles traced from those layouts and extruded to the real widths.
 * Named children used by animation: 'mag', 'slide', 'pump', 'bolt' and anchor Object3Ds
 * 'muzzle', 'eject', 'sight', 'gripR', 'gripL'.
 */

export interface GunMaterials {
  polymer: THREE.MeshStandardMaterial;
  gunmetal: THREE.MeshStandardMaterial;
  steel: THREE.MeshStandardMaterial;
  chrome: THREE.MeshStandardMaterial;
  rubber: THREE.MeshStandardMaterial;
  wood: THREE.MeshStandardMaterial;
  tan: THREE.MeshStandardMaterial;
  teal: THREE.MeshStandardMaterial;
  olive: THREE.MeshStandardMaterial;
  glass: THREE.MeshStandardMaterial;
  red: THREE.MeshBasicMaterial;
  green: THREE.MeshBasicMaterial;
  brass: THREE.MeshStandardMaterial;
  bore: THREE.MeshBasicMaterial;
  white: THREE.MeshBasicMaterial;
}

let shared: GunMaterials | null = null;

function microNormal(): THREE.DataTexture {
  // Subtle machining/brushing pattern so metal surfaces catch light.
  const s = 128;
  const data = new Uint8Array(s * s * 4);
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      const o = (y * s + x) * 4;
      const n = Math.sin(y * 0.9 + Math.sin(x * 0.07) * 2) * 0.5 + (Math.random() - 0.5) * 0.6;
      data[o] = 128 + n * 10;
      data[o + 1] = 128 + (Math.random() - 0.5) * 12;
      data[o + 2] = 255;
      data[o + 3] = 255;
    }
  }
  const t = new THREE.DataTexture(data, s, s);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(4, 4);
  t.needsUpdate = true;
  return t;
}

export function gunMaterials(): GunMaterials {
  if (shared) return shared;
  const nrm = microNormal();
  const std = (color: number, roughness: number, metalness: number, extra: THREE.MeshStandardMaterialParameters = {}): THREE.MeshStandardMaterial =>
    new THREE.MeshStandardMaterial({ color, roughness, metalness, normalMap: nrm, normalScale: new THREE.Vector2(0.25, 0.25), ...extra });
  shared = {
    polymer: std(0x26282c, 0.62, 0.05),
    gunmetal: std(0x3c4047, 0.4, 0.7),
    steel: std(0x6c727a, 0.32, 1.0),
    chrome: std(0xb9bec6, 0.18, 1.0),
    rubber: std(0x121315, 0.88, 0.0),
    wood: std(0x6a3d20, 0.55, 0.0),
    tan: std(0x9c7d55, 0.62, 0.05),
    teal: std(0x1f6c78, 0.45, 0.25),
    // Accuracy International "green" stock furniture
    olive: std(0x4f5a3c, 0.66, 0.05),
    glass: std(0x10233a, 0.05, 0.9, { envMapIntensity: 2.0, transparent: true, opacity: 0.32 }),
    red: new THREE.MeshBasicMaterial({ color: new THREE.Color(0xff2a2a).multiplyScalar(2.4) }),
    green: new THREE.MeshBasicMaterial({ color: new THREE.Color(0x5dff7a).multiplyScalar(1.8) }),
    brass: std(0xc8a050, 0.3, 1.0),
    bore: new THREE.MeshBasicMaterial({ color: 0x050506 }),
    white: new THREE.MeshBasicMaterial({ color: 0xd8d8d0 }),
  };
  return shared;
}

type Mat = THREE.Material;
type P2 = [number, number];

function rbox(parent: THREE.Object3D, w: number, h: number, d: number, mat: Mat, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0, r = 0.004): THREE.Mesh {
  const rr = Math.min(r, w / 2 - 1e-4, h / 2 - 1e-4, d / 2 - 1e-4);
  const g = rr > 0.0008 ? new RoundedBoxGeometry(w, h, d, 2, rr) : new THREE.BoxGeometry(w, h, d);
  const m = new THREE.Mesh(g, mat);
  m.position.set(x, y, z);
  m.rotation.set(rx, ry, rz);
  parent.add(m);
  return m;
}

/** Cylinder aligned with the Z axis. */
function zcyl(parent: THREE.Object3D, r: number, len: number, mat: Mat, x: number, y: number, z: number, seg = 16, r2 = r, open = false): THREE.Mesh {
  const g = new THREE.CylinderGeometry(r2, r, len, seg, 1, open);
  g.rotateX(Math.PI / 2);
  const m = new THREE.Mesh(g, mat);
  m.position.set(x, y, z);
  parent.add(m);
  return m;
}

/** Cylinder aligned with the X axis (cross pins, rear sight drums, turrets). */
function xcyl(parent: THREE.Object3D, r: number, len: number, mat: Mat, x: number, y: number, z: number, seg = 14): THREE.Mesh {
  const g = new THREE.CylinderGeometry(r, r, len, seg);
  g.rotateZ(Math.PI / 2);
  const m = new THREE.Mesh(g, mat);
  m.position.set(x, y, z);
  parent.add(m);
  return m;
}

/**
 * Side profile traced in (u = distance forward of the trigger, y = up), extruded `width`
 * across X and centred on `x`. Optional holes (trigger guards, thumbholes).
 */
function profile(parent: THREE.Object3D, pts: P2[], width: number, mat: Mat, x = 0, bevel = 0.0016, holes: P2[][] = []): THREE.Mesh {
  const shape = new THREE.Shape(pts.map(([u, y]) => new THREE.Vector2(u, y)));
  for (const hole of holes) shape.holes.push(new THREE.Path(hole.map(([u, y]) => new THREE.Vector2(u, y))));
  const b = Math.min(bevel, width * 0.3);
  const depth = Math.max(1e-4, width - b * 2);
  const g = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: b > 0, bevelThickness: b, bevelSize: b * 0.8, bevelSegments: 2, curveSegments: 4 });
  g.translate(0, 0, -depth / 2);
  // shape X (forward) → world -Z, extrusion → world X
  g.rotateY(Math.PI / 2);
  const m = new THREE.Mesh(g, mat);
  m.position.x = x;
  parent.add(m);
  return m;
}

/** Turned part (barrels, brakes, scope bells): radius profile [r, u] revolved around the bore axis. */
function lathe(parent: THREE.Object3D, pts: P2[], mat: Mat, y: number, x = 0, seg = 20): THREE.Mesh {
  const g = new THREE.LatheGeometry(
    pts.map(([r, u]) => new THREE.Vector2(r, u)),
    seg,
  );
  // lathe axis Y → world -Z
  g.rotateX(-Math.PI / 2);
  const m = new THREE.Mesh(g, mat);
  m.position.set(x, y, 0);
  parent.add(m);
  return m;
}

/** Dark disc facing forward at the muzzle so barrels read as hollow. */
function boreHole(parent: THREE.Object3D, m: GunMaterials, r: number, y: number, z: number): void {
  const d = new THREE.Mesh(new THREE.CircleGeometry(r, 16), m.bore);
  d.position.set(0, y, z - 0.0005);
  d.rotation.y = Math.PI;
  parent.add(d);
}

function anchor(parent: THREE.Object3D, name: string, x: number, y: number, z: number): THREE.Object3D {
  const o = new THREE.Object3D();
  o.name = name;
  o.position.set(x, y, z);
  parent.add(o);
  return o;
}

function group(parent: THREE.Object3D, name: string, x = 0, y = 0, z = 0): THREE.Group {
  const g = new THREE.Group();
  g.name = name;
  g.position.set(x, y, z);
  parent.add(g);
  return g;
}

/** Picatinny rail: base plus cross slots, from u0 to u1 (forward distances). */
function picatinny(parent: THREE.Object3D, m: GunMaterials, y: number, u0: number, u1: number, w = 0.021, x = 0, side = false): void {
  const len = u1 - u0;
  if (side) {
    rbox(parent, 0.006, w, len, m.gunmetal, x, y, -(u0 + u1) / 2, 0, 0, 0, 0.001);
    for (let u = u0 + 0.005; u < u1 - 0.003; u += 0.01) rbox(parent, 0.0065, w + 0.0006, 0.0048, m.polymer, x + Math.sign(x) * 0.0004, y, -u, 0, 0, 0, 0);
    return;
  }
  rbox(parent, w, 0.006, len, m.gunmetal, x, y, -(u0 + u1) / 2, 0, 0, 0, 0.001);
  for (let u = u0 + 0.005; u < u1 - 0.003; u += 0.01) rbox(parent, w + 0.0006, 0.0065, 0.0048, m.polymer, x, y + 0.0004, -u, 0, 0, 0, 0);
}

/** Thin raised strips on both slide flanks (cocking serrations). */
function serrations(parent: THREE.Object3D, m: Mat, halfW: number, y: number, h: number, u0: number, u1: number, step = 0.004): void {
  for (let u = u0; u <= u1; u += step) for (const s of [-1, 1]) rbox(parent, 0.0012, h, 0.0016, m, s * (halfW + 0.0004), y, -u, 0, 0, 0, 0);
}

// -----------------------------------------------------------------------------
// Glock 17 Gen5 — P-9 Viper
// -----------------------------------------------------------------------------
function buildGlock(m: GunMaterials): THREE.Group {
  const root = new THREE.Group();
  // Frame: dust cover, square-front trigger guard, 22° grip with beavertail.
  profile(
    root,
    [
      [0.113, 0.0172],
      [0.113, 0.006],
      [0.105, 0.0008],
      [0.052, 0],
      [0.047, -0.004],
      [0.047, -0.024],
      [0.041, -0.03],
      [-0.004, -0.031],
      [-0.012, -0.036],
      [-0.031, -0.084],
      [-0.035, -0.087],
      [-0.079, -0.087],
      [-0.083, -0.082],
      [-0.064, -0.02],
      [-0.067, -0.006],
      [-0.082, 0.004],
      [-0.077, 0.009],
      [-0.063, 0.0172],
    ],
    0.0295,
    m.polymer,
    0,
    0.0018,
    [
      [
        [0.04, -0.005],
        [0.04, -0.024],
        [0.035, -0.026],
        [-0.002, -0.026],
        [-0.006, -0.02],
        [-0.004, -0.005],
      ],
    ],
  );
  // Stippled grip panels
  profile(
    root,
    [
      [-0.017, -0.014],
      [-0.031, -0.078],
      [-0.076, -0.078],
      [-0.063, -0.014],
    ],
    0.0312,
    m.rubber,
    0,
    0.0008,
  );
  // Accessory rail slots on the dust cover
  for (const u of [0.072, 0.086, 0.1]) rbox(root, 0.0305, 0.003, 0.004, m.rubber, 0, 0.003, -u, 0, 0, 0, 0);
  // Trigger with the safety blade
  profile(
    root,
    [
      [0.007, -0.002],
      [0.011, -0.01],
      [0.009, -0.02],
      [0.004, -0.021],
      [0.005, -0.012],
      [0.001, -0.002],
    ],
    0.006,
    m.polymer,
    0,
    0.001,
  );
  rbox(root, 0.0016, 0.012, 0.003, m.gunmetal, 0, -0.011, -0.007, 0.15, 0, 0, 0);
  // Slide stop and takedown levers
  rbox(root, 0.003, 0.004, 0.016, m.gunmetal, -0.0162, 0.0145, -0.018, 0, 0, 0, 0.001);
  for (const s of [-1, 1]) rbox(root, 0.002, 0.006, 0.006, m.gunmetal, s * 0.0155, 0.011, -0.032, 0, 0, 0, 0.001);

  // Slide (moves on recoil): 186 × 25.5 mm with the Gen5 nose chamfer.
  const slide = group(root, 'slide');
  profile(
    slide,
    [
      [-0.066, 0.0172],
      [-0.066, 0.043],
      [-0.062, 0.047],
      [0.111, 0.047],
      [0.12, 0.041],
      [0.12, 0.024],
      [0.115, 0.0172],
    ],
    0.0255,
    m.gunmetal,
    0,
    0.0022,
  );
  serrations(slide, m.polymer, 0.01275, 0.032, 0.022, -0.06, -0.036);
  serrations(slide, m.polymer, 0.01275, 0.034, 0.016, 0.074, 0.094);
  // Ejection port with the barrel hood showing through
  rbox(slide, 0.006, 0.011, 0.046, m.bore, 0.0102, 0.0425, -0.017, 0, 0, 0, 0);
  rbox(slide, 0.014, 0.009, 0.042, m.steel, 0.0005, 0.0428, -0.017, 0, 0, 0, 0.0015);
  zcyl(slide, 0.0068, 0.004, m.steel, 0, 0.031, -0.1205, 16);
  boreHole(slide, m, 0.0047, 0.031, -0.1226);
  // Sights: dot front post, U-notch rear
  rbox(slide, 0.0035, 0.0062, 0.005, m.polymer, 0, 0.0501, -0.108, 0, 0, 0, 0);
  rbox(slide, 0.0016, 0.0016, 0.001, m.white, 0, 0.0515, -0.1106, 0, 0, 0, 0);
  for (const s of [-1, 1]) {
    rbox(slide, 0.0075, 0.0072, 0.008, m.polymer, s * 0.0062, 0.0505, 0.056, 0, 0, 0, 0.0008);
    rbox(slide, 0.0012, 0.0012, 0.001, m.white, s * 0.0045, 0.0512, 0.0518, 0, 0, 0, 0);
  }
  rbox(slide, 0.02, 0.0035, 0.008, m.polymer, 0, 0.0484, 0.056, 0, 0, 0, 0);

  // Magazine (drops on reload): follows the 22° grip, polymer floorplate at the bottom.
  const mag = group(root, 'mag');
  rbox(mag, 0.021, 0.096, 0.031, m.gunmetal, 0, -0.04, 0.05, -0.38, 0, 0, 0.003);
  rbox(mag, 0.025, 0.007, 0.036, m.polymer, 0, -0.0895, 0.058, -0.38, 0, 0, 0.002);

  anchor(root, 'muzzle', 0, 0.031, -0.124);
  anchor(root, 'eject', 0.014, 0.043, -0.015);
  anchor(root, 'sight', 0, 0.0535, 0.056);
  anchor(root, 'gripR', 0, -0.042, 0.049);
  anchor(root, 'gripL', -0.014, -0.058, 0.053);
  return root;
}

// -----------------------------------------------------------------------------
// Desert Eagle Mark XIX .50 AE — HC-50 Magnum
// -----------------------------------------------------------------------------
function buildDeagle(m: GunMaterials): THREE.Group {
  const root = new THREE.Group();
  const metal = m.chrome;
  // Fixed barrel block with the Mark XIX top rail (152 mm barrel, flat sides).
  profile(
    root,
    [
      [0.046, 0.0625],
      [0.199, 0.0625],
      [0.205, 0.058],
      [0.205, 0.029],
      [0.197, 0.0235],
      [0.118, 0.0235],
      [0.084, 0.0205],
      [0.046, 0.0205],
    ],
    0.03,
    metal,
    0,
    0.002,
  );
  picatinny(root, m, 0.0655, 0.05, 0.196, 0.016);
  boreHole(root, m, 0.0063, 0.043, -0.2052);
  rbox(root, 0.031, 0.004, 0.06, m.gunmetal, 0, 0.0285, -0.15, 0, 0, 0, 0.001);
  // Front blade sight on the rail
  rbox(root, 0.004, 0.0085, 0.008, m.gunmetal, 0, 0.073, -0.19, 0, 0, 0, 0.001);
  // Frame: dust cover, rounded guard, 18° grip.
  profile(
    root,
    [
      [0.185, 0.0235],
      [0.185, 0.012],
      [0.17, 0.004],
      [0.063, 0.002],
      [0.056, -0.004],
      [0.054, -0.022],
      [0.044, -0.032],
      [0, -0.034],
      [-0.012, -0.04],
      [-0.034, -0.083],
      [-0.04, -0.087],
      [-0.094, -0.087],
      [-0.097, -0.082],
      [-0.075, -0.02],
      [-0.075, -0.004],
      [-0.084, 0.012],
      [-0.075, 0.0235],
    ],
    0.03,
    m.gunmetal,
    0,
    0.002,
    [
      [
        [0.046, -0.006],
        [0.046, -0.024],
        [0.038, -0.028],
        [0.002, -0.028],
        [-0.006, -0.022],
        [-0.004, -0.006],
      ],
    ],
  );
  profile(
    root,
    [
      [-0.018, -0.012],
      [-0.035, -0.076],
      [-0.09, -0.076],
      [-0.073, -0.012],
    ],
    0.0335,
    m.rubber,
    0,
    0.0012,
  );
  profile(
    root,
    [
      [0.007, -0.002],
      [0.012, -0.011],
      [0.01, -0.022],
      [0.005, -0.022],
      [0.006, -0.011],
      [0.001, -0.002],
    ],
    0.007,
    m.steel,
    0,
    0.001,
  );
  // Hammer
  profile(
    root,
    [
      [-0.07, 0.046],
      [-0.079, 0.064],
      [-0.085, 0.063],
      [-0.08, 0.044],
    ],
    0.009,
    m.steel,
    0,
    0.001,
  );
  // Slide (rear half), safety levers, serrations, rear sight
  const slide = group(root, 'slide');
  profile(
    slide,
    [
      [-0.068, 0.0235],
      [-0.068, 0.056],
      [-0.06, 0.064],
      [0.049, 0.064],
      [0.049, 0.0235],
    ],
    0.032,
    metal,
    0,
    0.0022,
  );
  serrations(slide, m.gunmetal, 0.016, 0.044, 0.03, -0.062, -0.036, 0.0045);
  for (const s of [-1, 1]) rbox(slide, 0.004, 0.006, 0.016, m.gunmetal, s * 0.0175, 0.05, 0.05, 0, 0, 0, 0.0012);
  rbox(slide, 0.006, 0.013, 0.04, m.bore, 0.0136, 0.054, -0.012, 0, 0, 0, 0);
  for (const s of [-1, 1]) rbox(slide, 0.008, 0.008, 0.008, m.gunmetal, s * 0.0065, 0.068, 0.058, 0, 0, 0, 0.001);
  // Magazine
  const mag = group(root, 'mag');
  rbox(mag, 0.022, 0.09, 0.04, m.gunmetal, 0, -0.04, 0.056, -0.32, 0, 0, 0.003);
  rbox(mag, 0.027, 0.008, 0.046, m.gunmetal, 0, -0.0885, 0.07, -0.32, 0, 0, 0.002);

  anchor(root, 'muzzle', 0, 0.043, -0.207);
  anchor(root, 'eject', 0.016, 0.058, -0.012);
  anchor(root, 'sight', 0, 0.072, 0.058);
  anchor(root, 'gripR', 0, -0.042, 0.058);
  anchor(root, 'gripL', -0.016, -0.06, 0.062);
  return root;
}

// -----------------------------------------------------------------------------
// HK MP5A3 — Vespa SMG-9
// -----------------------------------------------------------------------------
function buildMp5(m: GunMaterials): THREE.Group {
  const root = new THREE.Group();
  // Stamped receiver
  profile(
    root,
    [
      [-0.1, 0.002],
      [-0.1, 0.049],
      [-0.09, 0.058],
      [0.158, 0.058],
      [0.166, 0.051],
      [0.166, 0.002],
    ],
    0.042,
    m.gunmetal,
    0,
    0.003,
  );
  // Receiver rib + ejection port + selector
  rbox(root, 0.0435, 0.003, 0.24, m.polymer, 0, 0.022, -0.035, 0, 0, 0, 0);
  rbox(root, 0.004, 0.016, 0.04, m.bore, 0.0205, 0.04, -0.05, 0, 0, 0, 0);
  rbox(root, 0.004, 0.012, 0.012, m.gunmetal, -0.022, 0.006, 0.02, 0, 0, 0, 0.001);
  // Navy trigger group / pistol grip
  profile(
    root,
    [
      [0.042, 0.004],
      [0.04, -0.006],
      [0.032, -0.03],
      [-0.006, -0.033],
      [-0.014, -0.042],
      [-0.03, -0.108],
      [-0.036, -0.113],
      [-0.073, -0.113],
      [-0.077, -0.106],
      [-0.062, -0.03],
      [-0.07, -0.012],
      [-0.078, 0.004],
    ],
    0.032,
    m.polymer,
    0,
    0.0025,
    [
      [
        [0.03, -0.006],
        [0.026, -0.026],
        [-0.004, -0.028],
        [-0.007, -0.006],
      ],
    ],
  );
  rbox(root, 0.004, 0.014, 0.004, m.steel, 0, -0.012, -0.008, 0.2, 0, 0, 0);
  // Magazine well
  rbox(root, 0.034, 0.026, 0.044, m.gunmetal, 0, -0.01, -0.081, 0, 0, 0, 0.003);
  // Cocking tube, cocking handle, hooded front sight
  zcyl(root, 0.0105, 0.12, m.gunmetal, 0, 0.066, -0.218, 18);
  zcyl(root, 0.012, 0.012, m.gunmetal, 0, 0.066, -0.282, 18);
  rbox(root, 0.026, 0.006, 0.008, m.gunmetal, -0.017, 0.064, -0.205, 0, 0, 0, 0.001);
  rbox(root, 0.006, 0.012, 0.01, m.polymer, -0.031, 0.064, -0.205, 0, 0, 0, 0.002);
  const hood = new THREE.Mesh(new THREE.TorusGeometry(0.0115, 0.0022, 6, 20), m.gunmetal);
  hood.position.set(0, 0.081, -0.27);
  root.add(hood);
  rbox(root, 0.006, 0.012, 0.008, m.gunmetal, 0, 0.072, -0.27, 0, 0, 0, 0.001);
  rbox(root, 0.0016, 0.008, 0.0016, m.gunmetal, 0, 0.077, -0.27, 0, 0, 0, 0);
  // Rotary diopter rear sight drum
  rbox(root, 0.018, 0.012, 0.02, m.gunmetal, 0, 0.064, 0.062, 0, 0, 0, 0.002);
  xcyl(root, 0.0115, 0.018, m.gunmetal, 0, 0.0795, 0.062, 16);
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.0012, 0.004, 14), m.bore);
  ring.position.set(0, 0.081, 0.051);
  ring.rotation.y = Math.PI;
  root.add(ring);
  // Wide tropical handguard around the barrel
  profile(
    root,
    [
      [0.166, 0.049],
      [0.298, 0.049],
      [0.305, 0.043],
      [0.305, 0.002],
      [0.296, -0.018],
      [0.18, -0.021],
      [0.166, -0.008],
    ],
    0.05,
    m.polymer,
    0,
    0.004,
  );
  for (let u = 0.19; u < 0.29; u += 0.016) for (const s of [-1, 1]) rbox(root, 0.002, 0.03, 0.006, m.rubber, s * 0.0255, 0.014, -u, 0, 0, 0, 0);
  // Barrel stub with three-lug muzzle (225 mm barrel from the chamber at u ≈ 0.11)
  lathe(
    root,
    [
      [0, 0.305],
      [0.0085, 0.305],
      [0.0085, 0.335],
      [0.0108, 0.336],
      [0.0108, 0.37],
      [0.008, 0.372],
      [0, 0.372],
    ],
    m.gunmetal,
    0.028,
  );
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + Math.PI / 2;
    rbox(root, 0.006, 0.006, 0.012, m.gunmetal, Math.cos(a) * 0.012, 0.028 + Math.sin(a) * 0.012, -0.34, 0, 0, a, 0.001);
  }
  boreHole(root, m, 0.0045, 0.028, -0.372);
  // A3 retractable stock: two rails and the butt plate (extended → 700 mm overall)
  for (const s of [-1, 1]) zcyl(root, 0.0045, 0.23, m.gunmetal, s * 0.016, 0.034, 0.215, 10);
  profile(
    root,
    [
      [-0.32, 0.054],
      [-0.33, 0.05],
      [-0.33, -0.052],
      [-0.32, -0.058],
      [-0.312, -0.05],
      [-0.312, 0.046],
    ],
    0.046,
    m.gunmetal,
    0,
    0.003,
  );
  rbox(root, 0.044, 0.1, 0.006, m.rubber, 0, -0.002, 0.333, 0, 0, 0, 0.002);
  // Curved 30-round magazine
  const mag = group(root, 'mag');
  profile(
    mag,
    [
      [0.064, -0.012],
      [0.067, -0.055],
      [0.073, -0.09],
      [0.083, -0.122],
      [0.098, -0.152],
      [0.135, -0.146],
      [0.121, -0.122],
      [0.111, -0.09],
      [0.103, -0.055],
      [0.099, -0.012],
    ],
    0.022,
    m.gunmetal,
    0,
    0.002,
  );
  for (let i = 0; i < 4; i++) {
    const t = 0.25 + i * 0.18;
    rbox(mag, 0.0228, 0.0025, 0.03, m.polymer, 0, -0.03 - t * 0.12, -(0.083 + t * 0.03), 0.12 + t * 0.35, 0, 0, 0);
  }

  anchor(root, 'muzzle', 0, 0.028, -0.374);
  anchor(root, 'eject', 0.024, 0.042, -0.05);
  anchor(root, 'sight', 0, 0.081, 0.062);
  anchor(root, 'gripR', 0, -0.05, 0.05);
  anchor(root, 'gripL', 0, -0.012, -0.235);
  return root;
}

// -----------------------------------------------------------------------------
// Remington 870 Tactical, 18.5" barrel — Breaker 12
// -----------------------------------------------------------------------------
function buildR870(m: GunMaterials): THREE.Group {
  const root = new THREE.Group();
  profile(
    root,
    [
      [-0.068, 0.0],
      [-0.068, 0.058],
      [-0.058, 0.066],
      [0.128, 0.066],
      [0.15, 0.06],
      [0.15, 0.002],
      [0.12, -0.008],
      [-0.04, -0.008],
    ],
    0.041,
    m.gunmetal,
    0,
    0.003,
  );
  rbox(root, 0.004, 0.024, 0.078, m.bore, 0.0195, 0.038, -0.058, 0, 0, 0, 0);
  rbox(root, 0.03, 0.004, 0.07, m.bore, 0, -0.0075, -0.06, 0, 0, 0, 0);
  rbox(root, 0.004, 0.008, 0.012, m.steel, -0.021, 0.002, -0.08, 0, 0, 0, 0.001);
  // Trigger plate and guard
  profile(
    root,
    [
      [0.062, -0.006],
      [0.056, -0.03],
      [0.045, -0.037],
      [-0.006, -0.037],
      [-0.022, -0.03],
      [-0.038, -0.006],
    ],
    0.026,
    m.polymer,
    0,
    0.002,
    [
      [
        [0.042, -0.012],
        [0.038, -0.029],
        [0.0, -0.03],
        [-0.009, -0.012],
      ],
    ],
  );
  rbox(root, 0.004, 0.016, 0.004, m.steel, 0, -0.018, -0.012, 0.2, 0, 0, 0);
  // 18.5" barrel, magazine tube, clamp, front bead
  lathe(
    root,
    [
      [0, 0.15],
      [0.0118, 0.15],
      [0.0118, 0.205],
      [0.0112, 0.215],
      [0.0112, 0.62],
      [0.0095, 0.621],
      [0, 0.621],
    ],
    m.gunmetal,
    0.046,
  );
  boreHole(root, m, 0.0092, 0.046, -0.6212);
  zcyl(root, 0.0115, 0.4, m.gunmetal, 0, 0.0135, -0.35, 16);
  zcyl(root, 0.0128, 0.022, m.gunmetal, 0, 0.0135, -0.561, 16);
  rbox(root, 0.018, 0.05, 0.016, m.gunmetal, 0, 0.03, -0.535, 0, 0, 0, 0.003);
  const bead = new THREE.Mesh(new THREE.SphereGeometry(0.0024, 8, 6), m.white);
  bead.position.set(0, 0.0602, -0.61);
  root.add(bead);
  // Synthetic stock with pistol-grip wrist and recoil pad (978 mm overall)
  profile(
    root,
    [
      [-0.068, 0.056],
      [-0.12, 0.05],
      [-0.335, 0.036],
      [-0.34, 0.03],
      [-0.34, -0.092],
      [-0.326, -0.098],
      [-0.17, -0.066],
      [-0.125, -0.062],
      [-0.1, -0.045],
      [-0.08, -0.02],
      [-0.068, -0.006],
    ],
    0.042,
    m.polymer,
    0,
    0.004,
  );
  profile(
    root,
    [
      [-0.34, 0.034],
      [-0.358, 0.032],
      [-0.358, -0.093],
      [-0.34, -0.096],
    ],
    0.044,
    m.rubber,
    0,
    0.003,
  );
  // Ribbed polymer forend on the action bars (slides back when pumped)
  const pump = group(root, 'pump');
  profile(
    pump,
    [
      [0.205, 0.0335],
      [0.4, 0.0335],
      [0.405, 0.027],
      [0.405, -0.004],
      [0.398, -0.013],
      [0.222, -0.013],
      [0.205, -0.002],
    ],
    0.052,
    m.polymer,
    0,
    0.004,
  );
  for (let u = 0.24; u < 0.39; u += 0.012) for (const s of [-1, 1]) rbox(pump, 0.002, 0.028, 0.004, m.rubber, s * 0.0265, 0.012, -u, 0, 0, 0, 0);
  for (const s of [-1, 1]) rbox(pump, 0.003, 0.004, 0.11, m.steel, s * 0.0145, 0.004, -0.15, 0, 0, 0, 0);
  // Shell shown while loading through the bottom port
  const mag = group(root, 'mag');
  const shell = zcyl(mag, 0.0105, 0.055, m.polymer, 0, 0, 0, 10);
  shell.material = new THREE.MeshStandardMaterial({ color: 0xa01818, roughness: 0.5 });
  zcyl(mag, 0.011, 0.012, m.brass, 0, 0, 0.032, 10);
  mag.visible = false;

  anchor(root, 'muzzle', 0, 0.046, -0.624);
  anchor(root, 'eject', 0.024, 0.04, -0.06);
  anchor(root, 'sight', 0, 0.0662, 0.06);
  anchor(root, 'gripR', 0, -0.045, 0.1);
  anchor(root, 'gripL', 0, -0.004, -0.31);
  return root;
}

// -----------------------------------------------------------------------------
// Colt M4A1 carbine with quad rail and holographic sight — AR-7 Vanguard
// -----------------------------------------------------------------------------
function buildM4(m: GunMaterials): THREE.Group {
  const root = new THREE.Group();
  const bore = 0.032;
  // Upper receiver + flat-top rail
  profile(
    root,
    [
      [-0.095, 0.006],
      [-0.095, 0.048],
      [-0.09, 0.053],
      [0.17, 0.053],
      [0.17, 0.006],
    ],
    0.033,
    m.gunmetal,
    0,
    0.002,
  );
  picatinny(root, m, 0.0565, -0.09, 0.168);
  rbox(root, 0.004, 0.015, 0.05, m.bore, 0.0168, 0.035, -0.02, 0, 0, 0, 0);
  rbox(root, 0.0025, 0.016, 0.052, m.gunmetal, 0.018, 0.035, -0.02, 0, 0, 0, 0.001);
  // Forward assist
  zcyl(root, 0.0062, 0.024, m.gunmetal, 0.021, 0.043, 0.055, 12).rotation.y = -0.3;
  rbox(root, 0.012, 0.012, 0.012, m.gunmetal, 0.018, 0.045, 0.028, 0, 0, 0, 0.002);
  // Charging handle
  rbox(root, 0.038, 0.006, 0.014, m.gunmetal, 0, 0.0535, 0.09, 0, 0, 0, 0.002);
  // Lower receiver: magwell, trigger guard
  profile(
    root,
    [
      [-0.082, 0.006],
      [0.128, 0.006],
      [0.128, -0.01],
      [0.123, -0.064],
      [0.04, -0.064],
      [0.036, -0.03],
      [0.032, -0.034],
      [-0.006, -0.036],
      [-0.012, -0.02],
      [-0.03, -0.01],
      [-0.082, -0.004],
    ],
    0.032,
    m.gunmetal,
    0,
    0.002,
    [
      [
        [0.03, -0.006],
        [0.029, -0.028],
        [-0.003, -0.03],
        [-0.008, -0.008],
      ],
    ],
  );
  rbox(root, 0.004, 0.014, 0.004, m.steel, 0, -0.014, -0.008, 0.2, 0, 0, 0);
  rbox(root, 0.006, 0.004, 0.016, m.steel, -0.017, 0.0, 0.02, 0, 0, 0, 0.001);
  rbox(root, 0.008, 0.008, 0.008, m.gunmetal, 0.017, -0.02, -0.11, 0, 0, 0, 0.002);
  // A2 pistol grip
  profile(
    root,
    [
      [-0.012, -0.012],
      [-0.016, -0.04],
      [-0.023, -0.05],
      [-0.046, -0.112],
      [-0.054, -0.12],
      [-0.083, -0.118],
      [-0.088, -0.11],
      [-0.055, -0.014],
      [-0.046, -0.004],
      [-0.02, -0.004],
    ],
    0.03,
    m.polymer,
    0,
    0.003,
  );
  // Buffer tube + collapsible stock (extended → 838 mm overall)
  zcyl(root, 0.0155, 0.2, m.gunmetal, 0, bore, 0.19, 18);
  zcyl(root, 0.0175, 0.008, m.gunmetal, 0, bore, 0.098, 18);
  profile(
    root,
    [
      [-0.162, 0.056],
      [-0.285, 0.058],
      [-0.29, 0.05],
      [-0.29, -0.052],
      [-0.28, -0.06],
      [-0.245, -0.044],
      [-0.2, 0.01],
      [-0.162, 0.012],
    ],
    0.04,
    m.polymer,
    0,
    0.004,
  );
  rbox(root, 0.042, 0.112, 0.012, m.rubber, 0, -0.002, 0.296, 0, 0, 0, 0.003);
  // Quad rail handguard
  rbox(root, 0.042, 0.042, 0.185, m.gunmetal, 0, bore, -0.262, 0, 0, 0, 0.004);
  picatinny(root, m, bore + 0.024, 0.172, 0.354);
  picatinny(root, m, bore - 0.024, 0.172, 0.354);
  picatinny(root, m, bore, 0.172, 0.354, 0.02, 0.024, true);
  picatinny(root, m, bore, 0.172, 0.354, 0.02, -0.024, true);
  zcyl(root, 0.026, 0.01, m.gunmetal, 0, bore, -0.175, 20);
  // Front sight base (A-frame) co-witnessing the holo
  profile(
    root,
    [
      [0.356, bore],
      [0.356, 0.05],
      [0.364, 0.098],
      [0.371, 0.098],
      [0.384, 0.05],
      [0.384, bore],
    ],
    0.012,
    m.gunmetal,
    0,
    0.0015,
  );
  zcyl(root, 0.015, 0.028, m.gunmetal, 0, bore, -0.37, 16);
  // 14.5" barrel + A2 birdcage flash hider
  lathe(
    root,
    [
      [0, 0.354],
      [0.0095, 0.354],
      [0.0095, 0.49],
      [0.0112, 0.491],
      [0.0112, 0.534],
      [0.009, 0.535],
      [0, 0.535],
    ],
    m.gunmetal,
    bore,
  );
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 + 0.3;
    rbox(root, 0.003, 0.003, 0.026, m.bore, Math.cos(a) * 0.0108, bore + Math.sin(a) * 0.0108, -0.514, 0, 0, a, 0);
  }
  boreHole(root, m, 0.0055, bore, -0.5352);
  // Holographic sight: base, battery box, hood, glass, reticle ring (sight line 66 mm over the bore)
  const holo = group(root, 'holo');
  rbox(holo, 0.03, 0.012, 0.095, m.polymer, 0, 0.065, -0.03, 0, 0, 0, 0.003);
  rbox(holo, 0.026, 0.014, 0.034, m.polymer, 0, 0.077, -0.06, 0, 0, 0, 0.003);
  for (const s of [-1, 1]) rbox(holo, 0.004, 0.044, 0.074, m.polymer, s * 0.019, 0.094, -0.032, 0, 0, 0, 0.0015);
  rbox(holo, 0.042, 0.005, 0.074, m.polymer, 0, 0.1165, -0.032, 0, 0, 0, 0.0015);
  for (const z of [0.004, -0.068]) {
    const glass = new THREE.Mesh(new THREE.PlaneGeometry(0.034, 0.032), m.glass);
    glass.position.set(0, 0.098, z);
    holo.add(glass);
  }
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.0062, 0.0071, 32), m.red);
  ring.position.set(0, 0.098, -0.066);
  holo.add(ring);
  const dot = new THREE.Mesh(new THREE.CircleGeometry(0.001, 12), m.red);
  dot.position.set(0, 0.098, -0.066);
  holo.add(dot);
  // 30-round polymer magazine with the STANAG curve
  const mag = group(root, 'mag');
  profile(
    mag,
    [
      [0.046, -0.02],
      [0.048, -0.08],
      [0.054, -0.13],
      [0.066, -0.18],
      [0.084, -0.224],
      [0.158, -0.214],
      [0.141, -0.172],
      [0.129, -0.13],
      [0.122, -0.08],
      [0.12, -0.02],
    ],
    0.023,
    m.polymer,
    0,
    0.0025,
  );
  rbox(mag, 0.0248, 0.008, 0.078, m.polymer, 0, -0.223, -0.121, 0.12, 0, 0, 0.002);

  anchor(root, 'muzzle', 0, bore, -0.537);
  anchor(root, 'eject', 0.02, 0.036, -0.02);
  anchor(root, 'sight', 0, 0.098, 0.0);
  anchor(root, 'gripR', 0, -0.055, 0.05);
  anchor(root, 'gripL', 0, -0.002, -0.27);
  return root;
}

// -----------------------------------------------------------------------------
// Accuracy International AWM .338 Lapua Magnum — Longbow .338
// -----------------------------------------------------------------------------
function buildAwm(m: GunMaterials): THREE.Group {
  const root = new THREE.Group();
  const bore = 0.042;
  const scopeY = 0.118;
  // Round action and scope base
  zcyl(root, 0.0175, 0.24, m.gunmetal, 0, bore, -0.03, 20);
  picatinny(root, m, 0.0625, -0.08, 0.16, 0.02);
  rbox(root, 0.004, 0.014, 0.06, m.bore, 0.0168, 0.05, -0.04, 0, 0, 0, 0);
  // Fore-end (AI green)
  profile(
    root,
    [
      [0.14, 0.034],
      [0.42, 0.034],
      [0.425, 0.024],
      [0.425, 0.004],
      [0.41, -0.025],
      [0.13, -0.03],
      [0.12, -0.022],
      [0.12, 0.026],
    ],
    0.062,
    m.olive,
    0,
    0.004,
  );
  for (let u = 0.16; u < 0.4; u += 0.03) for (const s of [-1, 1]) rbox(root, 0.002, 0.03, 0.014, m.polymer, s * 0.031, 0.004, -u, 0, 0, 0, 0);
  // Thumbhole stock with pistol grip and cheek piece (1230 mm overall)
  profile(
    root,
    [
      [0.12, 0.03],
      [0.12, -0.028],
      [0.05, -0.03],
      [0.046, -0.052],
      [0.036, -0.06],
      [-0.004, -0.062],
      [-0.016, -0.068],
      [-0.03, -0.128],
      [-0.038, -0.136],
      [-0.07, -0.136],
      [-0.074, -0.128],
      [-0.08, -0.092],
      [-0.1, -0.086],
      [-0.36, -0.1],
      [-0.372, -0.094],
      [-0.372, 0.058],
      [-0.36, 0.066],
      [-0.205, 0.07],
      [-0.165, 0.062],
      [-0.12, 0.034],
      [-0.09, 0.028],
    ],
    0.054,
    m.olive,
    0,
    0.005,
    [
      [
        [-0.072, 0.0],
        [-0.078, -0.06],
        [-0.14, -0.062],
        [-0.162, -0.022],
        [-0.142, 0.016],
        [-0.092, 0.016],
      ],
      [
        [0.04, -0.034],
        [0.034, -0.054],
        [-0.002, -0.056],
        [-0.01, -0.034],
      ],
    ],
  );
  rbox(root, 0.056, 0.12, 0.014, m.rubber, 0, -0.016, 0.378, 0, 0, 0, 0.004);
  rbox(root, 0.004, 0.016, 0.004, m.steel, 0, -0.04, -0.012, 0.2, 0, 0, 0);
  // 27" fluted barrel + muzzle brake
  lathe(
    root,
    [
      [0, 0.15],
      [0.0148, 0.15],
      [0.0145, 0.25],
      [0.012, 0.36],
      [0.0115, 0.77],
      [0, 0.77],
    ],
    m.gunmetal,
    bore,
  );
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    rbox(root, 0.0025, 0.0025, 0.36, m.polymer, Math.cos(a) * 0.0114, bore + Math.sin(a) * 0.0114, -0.56, 0, 0, a, 0);
  }
  lathe(
    root,
    [
      [0, 0.766],
      [0.0165, 0.768],
      [0.0168, 0.845],
      [0.007, 0.846],
      [0, 0.846],
    ],
    m.gunmetal,
    bore,
  );
  for (const u of [0.79, 0.81, 0.83]) for (const s of [-1, 1]) rbox(root, 0.004, 0.012, 0.009, m.bore, s * 0.0158, bore, -u, 0, 0, 0, 0);
  boreHole(root, m, 0.0045, bore, -0.8462);
  // Folded bipod under the fore-end
  rbox(root, 0.03, 0.012, 0.022, m.gunmetal, 0, -0.03, -0.405, 0, 0, 0, 0.002);
  for (const s of [-1, 1]) rbox(root, 0.007, 0.007, 0.19, m.gunmetal, s * 0.01, -0.035, -0.305, 0, 0, 0, 0.002);
  // 3–12×50 scope on two rings
  lathe(
    root,
    [
      [0, -0.152],
      [0.0205, -0.152],
      [0.0212, -0.1],
      [0.015, -0.072],
      [0.015, 0.2],
      [0.0285, 0.248],
      [0.0285, 0.292],
      [0, 0.292],
    ],
    m.polymer,
    scopeY,
    0,
    28,
  );
  const lensF = new THREE.Mesh(new THREE.CircleGeometry(0.026, 24), m.glass);
  lensF.position.set(0, scopeY, -0.2925);
  lensF.rotation.y = Math.PI;
  root.add(lensF);
  const lensR = new THREE.Mesh(new THREE.CircleGeometry(0.0185, 24), m.bore);
  lensR.position.set(0, scopeY, 0.1525);
  root.add(lensR);
  const turret = new THREE.Mesh(new THREE.CylinderGeometry(0.0125, 0.0125, 0.024, 16), m.polymer);
  turret.position.set(0, scopeY + 0.025, -0.06);
  root.add(turret);
  xcyl(root, 0.0125, 0.024, m.polymer, 0.025, scopeY, -0.06, 16);
  for (const u of [-0.02, 0.13]) {
    zcyl(root, 0.0185, 0.016, m.gunmetal, 0, scopeY, -u, 20);
    rbox(root, 0.02, 0.05, 0.016, m.gunmetal, 0, 0.088, -u, 0, 0, 0, 0.002);
  }
  // Bolt (lifts and draws back), pivoting on the bore line
  const bolt = group(root, 'bolt', 0, bore, 0);
  zcyl(bolt, 0.0135, 0.026, m.gunmetal, 0, 0, 0.1, 16);
  rbox(bolt, 0.05, 0.008, 0.008, m.steel, 0.026, -0.006, 0.075, 0, 0, -0.45, 0.002);
  const knob = new THREE.Mesh(new THREE.SphereGeometry(0.0105, 12, 8), m.polymer);
  knob.position.set(0.05, -0.017, 0.075);
  bolt.add(knob);
  // Detachable 5-round magazine
  const mag = group(root, 'mag');
  rbox(mag, 0.03, 0.06, 0.095, m.gunmetal, 0, -0.045, -0.075, 0, 0, 0, 0.004);

  anchor(root, 'muzzle', 0, bore, -0.848);
  anchor(root, 'eject', 0.03, 0.05, -0.03);
  anchor(root, 'sight', 0, scopeY, 0.152);
  anchor(root, 'gripR', 0, -0.088, 0.05);
  anchor(root, 'gripL', 0, -0.035, -0.3);
  return root;
}

// -----------------------------------------------------------------------------
// Tanto fighting knife (about 290 mm, 150 mm blade)
// -----------------------------------------------------------------------------
function buildKnife(m: GunMaterials): THREE.Group {
  const root = new THREE.Group();
  // Cord-wrapped handle, guard and pommel
  rbox(root, 0.024, 0.03, 0.115, m.rubber, 0, 0, 0.035, 0, 0, 0, 0.009);
  for (let i = 0; i < 9; i++) rbox(root, 0.0255, 0.0315, 0.004, m.polymer, 0, 0, -0.012 + i * 0.012, 0, 0, 0, 0.0015);
  rbox(root, 0.028, 0.058, 0.008, m.gunmetal, 0, 0.006, -0.026, 0, 0, 0, 0.002);
  rbox(root, 0.026, 0.032, 0.014, m.gunmetal, 0, 0, 0.098, 0, 0, 0, 0.004);
  // Tanto blade: straight edge, angled secondary point, swedge on the spine
  const blade = profile(
    root,
    [
      [0.03, -0.012],
      [0.155, -0.012],
      [0.178, 0.008],
      [0.172, 0.016],
      [0.03, 0.017],
    ],
    0.0045,
    m.chrome,
    0,
    0.0012,
  );
  blade.position.y = 0.006;
  rbox(root, 0.0048, 0.0025, 0.115, m.steel, 0, 0.0215, -0.09, 0, 0, 0, 0);
  anchor(root, 'muzzle', 0, 0.01, -0.2);
  anchor(root, 'eject', 0, 0, 0);
  anchor(root, 'sight', 0, 0.06, 0.05);
  anchor(root, 'gripR', 0, -0.005, 0.04);
  anchor(root, 'gripL', -0.05, -0.08, 0.02);
  return root;
}

export function buildGun(id: WeaponId): THREE.Group {
  const m = gunMaterials();
  let g: THREE.Group;
  switch (id) {
    case 'pistol':
      g = buildGlock(m);
      break;
    case 'magnum':
      g = buildDeagle(m);
      break;
    case 'smg':
      g = buildMp5(m);
      break;
    case 'shotgun':
      g = buildR870(m);
      break;
    case 'rifle':
      g = buildM4(m);
      break;
    case 'sniper':
      g = buildAwm(m);
      break;
    default:
      g = buildKnife(m);
  }
  g.name = `gun-${id}`;
  g.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) {
      o.castShadow = true;
      o.receiveShadow = false;
    }
  });
  return g;
}

/** Collapses a model into one mesh per material (cheap third-person weapons). */
export function flattenByMaterial(src: THREE.Object3D): THREE.Group {
  src.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(src.matrixWorld).invert();
  const buckets = new Map<THREE.Material, THREE.BufferGeometry[]>();
  src.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || !mesh.visible) return;
    const mat = mesh.material as THREE.Material;
    let g = mesh.geometry.clone();
    if (g.index) g = g.toNonIndexed();
    g.clearGroups();
    for (const name of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(name)) g.deleteAttribute(name);
    if (!g.getAttribute('uv')) g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(g.getAttribute('position').count * 2), 2));
    g.applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, mesh.matrixWorld));
    const list = buckets.get(mat) ?? [];
    list.push(g);
    buckets.set(mat, list);
  });
  const out = new THREE.Group();
  for (const [mat, list] of buckets) {
    const merged = mergeGeometries(list, false);
    if (!merged) continue;
    const mesh = new THREE.Mesh(merged, mat);
    mesh.castShadow = true;
    out.add(mesh);
  }
  // Keep anchors for muzzle flashes.
  for (const name of ['muzzle']) {
    const a = src.getObjectByName(name);
    if (a) {
      const o = new THREE.Object3D();
      o.name = name;
      a.updateMatrixWorld();
      o.position.setFromMatrixPosition(new THREE.Matrix4().multiplyMatrices(inv, a.matrixWorld));
      out.add(o);
    }
  }
  return out;
}

const grenadeGeo = new THREE.CylinderGeometry(0.035, 0.035, 0.11, 16);
const grenadeCap = new THREE.CylinderGeometry(0.02, 0.026, 0.03, 12);

const grenadeTemplates = new Map<ThrowKind, THREE.Group>();

/** Grenade model; clones share geometry and materials so nothing needs disposing per throw. */
export function buildGrenade(kind: ThrowKind): THREE.Group {
  let t = grenadeTemplates.get(kind);
  if (!t) {
    t = makeGrenade(kind);
    grenadeTemplates.set(kind, t);
  }
  return t.clone();
}

function makeGrenade(kind: ThrowKind): THREE.Group {
  const m = gunMaterials();
  const g = new THREE.Group();
  const bodyColor = kind === 'frag' ? 0x3d4a2c : kind === 'smoke' ? 0x5a6066 : 0x8b9096;
  const band = kind === 'frag' ? 0xd2a020 : kind === 'smoke' ? 0x40c070 : 0xf0f0f0;
  const body = new THREE.Mesh(kind === 'frag' ? new THREE.SphereGeometry(0.045, 16, 12) : grenadeGeo, new THREE.MeshStandardMaterial({ color: bodyColor, roughness: 0.55, metalness: 0.5 }));
  g.add(body);
  const b = new THREE.Mesh(new THREE.CylinderGeometry(0.037, 0.037, 0.014, 16), new THREE.MeshBasicMaterial({ color: new THREE.Color(band).multiplyScalar(kind === 'flash' ? 1.5 : 1.2) }));
  b.position.y = 0.02;
  g.add(b);
  const cap = new THREE.Mesh(grenadeCap, m.gunmetal);
  cap.position.y = kind === 'frag' ? 0.05 : 0.07;
  g.add(cap);
  const lever = new THREE.Mesh(new THREE.BoxGeometry(0.01, 0.07, 0.006), m.steel);
  lever.position.set(0.03, 0.03, 0);
  g.add(lever);
  g.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) o.castShadow = true;
  });
  return g;
}

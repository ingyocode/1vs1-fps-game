import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { WeaponId } from './weapons';
import type { ThrowKind } from './abilities';

/**
 * Procedurally modelled weapons. Barrel points to -Z, origin at the trigger.
 * Named children used by animation: 'mag', 'slide', 'pump', 'bolt' and anchor
 * Object3Ds 'muzzle', 'eject', 'sight', 'gripR', 'gripL'.
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
    polymer: std(0x2b2e34, 0.58, 0.05),
    gunmetal: std(0x4a4f57, 0.38, 0.75),
    steel: std(0x6c727a, 0.34, 1.0),
    chrome: std(0xc9ced6, 0.12, 1.0),
    rubber: std(0x111214, 0.85, 0.0),
    wood: std(0x6a3d20, 0.55, 0.0),
    tan: std(0xa8784a, 0.5, 0.15),
    teal: std(0x1f6c78, 0.45, 0.25),
    olive: std(0x4b553a, 0.6, 0.1),
    glass: std(0x10233a, 0.05, 0.9, { envMapIntensity: 2.0 }),
    red: new THREE.MeshBasicMaterial({ color: new THREE.Color(0xff2a2a).multiplyScalar(6) }),
    green: new THREE.MeshBasicMaterial({ color: new THREE.Color(0x5dff7a).multiplyScalar(4) }),
    brass: std(0xc8a050, 0.3, 1.0),
  };
  return shared;
}

type Mat = THREE.Material;

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

function railNotches(parent: THREE.Object3D, mat: Mat, x: number, y: number, z0: number, z1: number, w: number): void {
  for (let z = z0; z < z1; z += 0.011) rbox(parent, w, 0.004, 0.005, mat, x, y, z, 0, 0, 0, 0);
}

function buildPistol(m: GunMaterials, magnum: boolean): THREE.Group {
  const root = new THREE.Group();
  const k = magnum ? 1.28 : 1;
  const slideMat = magnum ? m.chrome : m.gunmetal;
  const slide = group(root, 'slide');
  rbox(slide, 0.034 * k, 0.036 * k, 0.2 * k, slideMat, 0, 0.036 * k, -0.05 * k, 0, 0, 0, 0.005);
  for (let i = 0; i < 6; i++) rbox(slide, 0.035 * k, 0.026 * k, 0.003, m.polymer, 0, 0.038 * k, 0.012 * k + i * 0.006 * k, 0, 0, 0, 0);
  rbox(slide, 0.006, 0.009, 0.006, m.gunmetal, 0, 0.058 * k, -0.138 * k, 0, 0, 0, 0);
  rbox(slide, 0.003, 0.003, 0.003, m.green, 0, 0.061 * k, -0.138 * k, 0, 0, 0, 0);
  rbox(slide, 0.011, 0.009, 0.008, m.gunmetal, -0.009 * k, 0.058 * k, 0.03 * k, 0, 0, 0, 0);
  rbox(slide, 0.011, 0.009, 0.008, m.gunmetal, 0.009 * k, 0.058 * k, 0.03 * k, 0, 0, 0, 0);
  if (magnum) {
    // ported compensator and top rib
    rbox(slide, 0.044, 0.05, 0.05, m.gunmetal, 0, 0.046, -0.29, 0, 0, 0, 0.006);
    for (let i = 0; i < 3; i++) rbox(slide, 0.046, 0.01, 0.006, m.polymer, 0, 0.065, -0.275 - i * 0.012, 0, 0, 0, 0);
    rbox(slide, 0.012, 0.008, 0.2, m.gunmetal, 0, 0.074, -0.08, 0, 0, 0, 0.002);
  }
  zcyl(root, 0.007 * k, 0.012, m.polymer, 0, 0.036 * k, (magnum ? -0.316 : -0.152 * k), 12);
  rbox(root, 0.031 * k, 0.026 * k, 0.17 * k, m.polymer, 0, 0.006 * k, -0.05 * k, 0, 0, 0, 0.004);
  railNotches(root, m.gunmetal, 0, -0.008 * k, -0.13 * k, -0.07 * k, 0.026 * k);
  const grip = rbox(root, 0.031 * k, 0.115 * k, 0.048 * k, magnum ? m.wood : m.polymer, 0, -0.05 * k, 0.022 * k, -0.22, 0, 0, 0.007);
  grip.name = 'grip';
  for (let i = 0; i < 5; i++) rbox(root, 0.033 * k, 0.004, 0.04 * k, m.rubber, 0, -0.02 * k - i * 0.016 * k, 0.026 * k + i * 0.0037, -0.22, 0, 0, 0);
  rbox(root, 0.007, 0.006, 0.055 * k, m.polymer, 0, -0.022 * k, -0.026 * k, 0, 0, 0, 0.002);
  rbox(root, 0.007, 0.03 * k, 0.006, m.polymer, 0, -0.008 * k, -0.052 * k, 0, 0, 0, 0.002);
  rbox(root, 0.004, 0.022, 0.006, m.steel, 0, -0.012 * k, -0.012 * k, 0.3, 0, 0, 0);
  const mag = group(root, 'mag');
  rbox(mag, 0.026 * k, 0.1 * k, 0.04 * k, m.gunmetal, 0, -0.05 * k, 0.026 * k, -0.22, 0, 0, 0.003);
  rbox(mag, 0.034 * k, 0.012 * k, 0.052 * k, m.polymer, 0, -0.107 * k, 0.04 * k, -0.22, 0, 0, 0.004);
  anchor(root, 'muzzle', 0, 0.036 * k, magnum ? -0.33 : -0.16 * k);
  anchor(root, 'eject', 0.02 * k, 0.05 * k, -0.02 * k);
  anchor(root, 'sight', 0, 0.0625 * k, 0.03 * k);
  anchor(root, 'gripR', 0, -0.045 * k, 0.03 * k);
  anchor(root, 'gripL', -0.012, -0.065 * k, 0.04 * k);
  return root;
}

function buildSmg(m: GunMaterials): THREE.Group {
  const root = new THREE.Group();
  rbox(root, 0.05, 0.07, 0.3, m.polymer, 0, 0.03, -0.08, 0, 0, 0, 0.008);
  rbox(root, 0.052, 0.03, 0.18, m.teal, 0, 0.012, -0.1, 0, 0, 0, 0.006);
  rbox(root, 0.026, 0.008, 0.22, m.gunmetal, 0, 0.069, -0.07, 0, 0, 0, 0.002);
  railNotches(root, m.polymer, 0, 0.074, -0.17, 0.03, 0.027);
  zcyl(root, 0.021, 0.14, m.gunmetal, 0, 0.035, -0.29, 18);
  for (let i = 0; i < 4; i++) rbox(root, 0.044, 0.006, 0.012, m.polymer, 0, 0.035, -0.25 - i * 0.025, 0, 0, 0, 0);
  zcyl(root, 0.009, 0.06, m.steel, 0, 0.035, -0.38, 12);
  zcyl(root, 0.013, 0.03, m.gunmetal, 0, 0.035, -0.405, 12);
  rbox(root, 0.03, 0.105, 0.046, m.polymer, 0, -0.05, 0.03, -0.25, 0, 0, 0.008);
  rbox(root, 0.007, 0.006, 0.05, m.polymer, 0, -0.018, -0.01, 0, 0, 0, 0.002);
  const fg = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.015, 0.085, 12), m.polymer);
  fg.position.set(0, -0.035, -0.21);
  root.add(fg);
  // folding stock
  for (const x of [-0.016, 0.016]) rbox(root, 0.006, 0.008, 0.2, m.gunmetal, x, 0.03, 0.15, 0, 0, 0, 0.002);
  rbox(root, 0.04, 0.075, 0.012, m.rubber, 0, 0.012, 0.25, 0, 0, 0, 0.004);
  // red dot
  rbox(root, 0.03, 0.012, 0.05, m.gunmetal, 0, 0.08, -0.03, 0, 0, 0, 0.002);
  const tube = zcyl(root, 0.019, 0.05, m.polymer, 0, 0.104, -0.03, 24, 0.019, true);
  tube.material = m.polymer.clone();
  (tube.material as THREE.MeshStandardMaterial).side = THREE.DoubleSide;
  zcyl(root, 0.021, 0.006, m.gunmetal, 0, 0.104, -0.006, 24, 0.021, true).material = tube.material;
  const lens = new THREE.Mesh(new THREE.CircleGeometry(0.016, 20), m.glass);
  lens.position.set(0, 0.104, -0.054);
  lens.material = m.glass.clone();
  (lens.material as THREE.MeshStandardMaterial).transparent = true;
  (lens.material as THREE.MeshStandardMaterial).opacity = 0.35;
  root.add(lens);
  const dot = new THREE.Mesh(new THREE.CircleGeometry(0.0012, 10), m.red);
  dot.position.set(0, 0.104, -0.05);
  root.add(dot);
  const mag = group(root, 'mag');
  rbox(mag, 0.024, 0.16, 0.042, m.gunmetal, 0, -0.085, -0.085, 0.08, 0, 0, 0.004);
  rbox(mag, 0.028, 0.012, 0.048, m.polymer, 0, -0.163, -0.078, 0.08, 0, 0, 0.003);
  rbox(root, 0.012, 0.012, 0.03, m.gunmetal, -0.03, 0.05, -0.12, 0, 0, 0, 0.003);
  anchor(root, 'muzzle', 0, 0.035, -0.425);
  anchor(root, 'eject', 0.028, 0.05, -0.05);
  anchor(root, 'sight', 0, 0.104, 0.02);
  anchor(root, 'gripR', 0, -0.045, 0.04);
  anchor(root, 'gripL', 0, -0.06, -0.21);
  return root;
}

function buildShotgun(m: GunMaterials): THREE.Group {
  const root = new THREE.Group();
  rbox(root, 0.05, 0.072, 0.24, m.gunmetal, 0, 0.032, -0.04, 0, 0, 0, 0.008);
  rbox(root, 0.051, 0.02, 0.12, m.polymer, 0, 0.004, -0.04, 0, 0, 0, 0.004);
  zcyl(root, 0.0145, 0.52, m.steel, 0, 0.052, -0.42, 18);
  zcyl(root, 0.0135, 0.42, m.gunmetal, 0, 0.018, -0.37, 16);
  rbox(root, 0.03, 0.044, 0.02, m.gunmetal, 0, 0.034, -0.58, 0, 0, 0, 0.004);
  const bead = new THREE.Mesh(new THREE.SphereGeometry(0.004, 8, 6), m.green);
  bead.position.set(0, 0.07, -0.66);
  root.add(bead);
  rbox(root, 0.03, 0.01, 0.03, m.gunmetal, 0, 0.074, -0.02, 0, 0, 0, 0.002);
  const pump = group(root, 'pump');
  rbox(pump, 0.054, 0.052, 0.17, m.polymer, 0, 0.026, -0.3, 0, 0, 0, 0.01);
  for (let i = 0; i < 7; i++) rbox(pump, 0.057, 0.04, 0.006, m.rubber, 0, 0.026, -0.235 - i * 0.02, 0, 0, 0, 0);
  rbox(root, 0.03, 0.105, 0.048, m.polymer, 0, -0.048, 0.06, -0.3, 0, 0, 0.008);
  rbox(root, 0.046, 0.09, 0.27, m.wood, 0, -0.008, 0.24, 0.12, 0, 0, 0.012);
  rbox(root, 0.048, 0.1, 0.02, m.rubber, 0, -0.03, 0.38, 0.12, 0, 0, 0.006);
  rbox(root, 0.007, 0.006, 0.055, m.polymer, 0, -0.016, 0.0, 0, 0, 0, 0.002);
  const mag = group(root, 'mag');
  const shell = zcyl(mag, 0.0105, 0.055, m.polymer, 0, 0, 0, 10);
  shell.material = new THREE.MeshStandardMaterial({ color: 0xa01818, roughness: 0.5 });
  zcyl(mag, 0.011, 0.012, m.brass, 0, 0, 0.032, 10);
  mag.visible = false;
  anchor(root, 'muzzle', 0, 0.052, -0.69);
  anchor(root, 'eject', 0.027, 0.04, -0.05);
  anchor(root, 'sight', 0, 0.09, 0.04);
  anchor(root, 'gripR', 0, -0.045, 0.07);
  anchor(root, 'gripL', 0, 0.0, -0.3);
  return root;
}

function buildRifle(m: GunMaterials): THREE.Group {
  const root = new THREE.Group();
  rbox(root, 0.046, 0.06, 0.2, m.tan, 0, 0.012, -0.02, 0, 0, 0, 0.006);
  rbox(root, 0.043, 0.05, 0.27, m.gunmetal, 0, 0.062, -0.06, 0, 0, 0, 0.005);
  rbox(root, 0.054, 0.058, 0.28, m.polymer, 0, 0.058, -0.33, 0, 0, 0, 0.008);
  for (let i = 0; i < 4; i++) {
    rbox(root, 0.056, 0.012, 0.035, m.gunmetal, 0, 0.058, -0.24 - i * 0.06, 0, 0, 0, 0.002);
  }
  rbox(root, 0.028, 0.008, 0.5, m.gunmetal, 0, 0.09, -0.2, 0, 0, 0, 0.002);
  railNotches(root, m.polymer, 0, 0.095, -0.45, 0.05, 0.029);
  zcyl(root, 0.0105, 0.16, m.steel, 0, 0.06, -0.54, 14);
  rbox(root, 0.026, 0.026, 0.065, m.gunmetal, 0, 0.06, -0.635, 0, 0, 0, 0.004);
  for (let i = 0; i < 3; i++) rbox(root, 0.028, 0.006, 0.006, m.polymer, 0, 0.068, -0.615 - i * 0.017, 0, 0, 0, 0);
  // front sight post (folded) + holo sight
  rbox(root, 0.02, 0.02, 0.012, m.gunmetal, 0, 0.1, -0.44, 0, 0, 0, 0.002);
  const holo = group(root, 'holo');
  rbox(holo, 0.038, 0.014, 0.075, m.gunmetal, 0, 0.1, -0.08, 0, 0, 0, 0.003);
  rbox(holo, 0.004, 0.04, 0.05, m.polymer, -0.02, 0.124, -0.09, 0, 0, 0, 0.0015);
  rbox(holo, 0.004, 0.04, 0.05, m.polymer, 0.02, 0.124, -0.09, 0, 0, 0, 0.0015);
  rbox(holo, 0.044, 0.005, 0.05, m.polymer, 0, 0.145, -0.09, 0, 0, 0, 0.0015);
  const glass = new THREE.Mesh(new THREE.PlaneGeometry(0.036, 0.034), m.glass.clone());
  (glass.material as THREE.MeshStandardMaterial).transparent = true;
  (glass.material as THREE.MeshStandardMaterial).opacity = 0.28;
  glass.position.set(0, 0.125, -0.112);
  holo.add(glass);
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.0068, 0.0078, 32), m.red);
  ring.position.set(0, 0.124, -0.105);
  holo.add(ring);
  const dot = new THREE.Mesh(new THREE.CircleGeometry(0.0011, 12), m.red);
  dot.position.set(0, 0.124, -0.105);
  holo.add(dot);
  const mag = group(root, 'mag');
  rbox(mag, 0.026, 0.09, 0.058, m.polymer, 0, -0.055, -0.1, 0.1, 0, 0, 0.005);
  rbox(mag, 0.026, 0.07, 0.056, m.polymer, 0, -0.125, -0.085, 0.3, 0, 0, 0.005);
  rbox(mag, 0.03, 0.012, 0.062, m.gunmetal, 0, -0.16, -0.072, 0.3, 0, 0, 0.003);
  rbox(root, 0.03, 0.1, 0.045, m.polymer, 0, -0.05, 0.065, -0.32, 0, 0, 0.008);
  rbox(root, 0.007, 0.006, 0.05, m.polymer, 0, -0.022, 0.015, 0, 0, 0, 0.002);
  zcyl(root, 0.016, 0.14, m.gunmetal, 0, 0.055, 0.14, 14);
  rbox(root, 0.042, 0.075, 0.18, m.tan, 0, 0.035, 0.24, 0, 0, 0, 0.01);
  rbox(root, 0.044, 0.09, 0.02, m.rubber, 0, 0.03, 0.335, 0, 0, 0, 0.006);
  rbox(root, 0.02, 0.012, 0.02, m.gunmetal, 0, 0.09, 0.07, 0, 0, 0, 0.003);
  rbox(root, 0.02, 0.06, 0.03, m.polymer, 0, 0.0, -0.36, 0.25, 0, 0, 0.006);
  anchor(root, 'muzzle', 0, 0.06, -0.67);
  anchor(root, 'eject', 0.026, 0.065, -0.05);
  anchor(root, 'sight', 0, 0.124, 0.02);
  anchor(root, 'gripR', 0, -0.045, 0.075);
  anchor(root, 'gripL', 0, -0.03, -0.36);
  return root;
}

function buildSniper(m: GunMaterials): THREE.Group {
  const root = new THREE.Group();
  rbox(root, 0.05, 0.065, 0.3, m.olive, 0, 0.03, -0.02, 0, 0, 0, 0.008);
  rbox(root, 0.054, 0.05, 0.3, m.olive, 0, 0.028, -0.3, 0, 0, 0, 0.008);
  zcyl(root, 0.0135, 0.6, m.gunmetal, 0, 0.048, -0.5, 16);
  for (let i = 0; i < 6; i++) rbox(root, 0.003, 0.004, 0.25, m.polymer, Math.cos(i) * 0.014, 0.048 + Math.sin(i) * 0.014, -0.55, 0, 0, 0, 0);
  rbox(root, 0.036, 0.036, 0.08, m.gunmetal, 0, 0.048, -0.83, 0, 0, 0, 0.005);
  for (let i = 0; i < 3; i++) rbox(root, 0.038, 0.012, 0.008, m.polymer, 0, 0.048, -0.81 - i * 0.02, 0, 0, 0, 0);
  // scope
  zcyl(root, 0.021, 0.34, m.polymer, 0, 0.118, -0.06, 24);
  zcyl(root, 0.03, 0.08, m.polymer, 0, 0.118, -0.27, 24, 0.021);
  zcyl(root, 0.025, 0.07, m.polymer, 0, 0.118, 0.14, 24);
  const lensF = new THREE.Mesh(new THREE.CircleGeometry(0.027, 24), m.glass);
  lensF.position.set(0, 0.118, -0.311);
  lensF.rotation.y = Math.PI;
  root.add(lensF);
  zcyl(root, 0.011, 0.02, m.gunmetal, 0, 0.145, -0.05, 12).rotation.x = Math.PI / 2;
  const turret2 = zcyl(root, 0.011, 0.02, m.gunmetal, 0.028, 0.118, -0.05, 12);
  turret2.rotation.y = Math.PI / 2;
  for (const z of [-0.13, 0.04]) rbox(root, 0.03, 0.03, 0.02, m.gunmetal, 0, 0.088, z, 0, 0, 0, 0.003);
  const bolt = group(root, 'bolt', 0, 0, 0);
  zcyl(bolt, 0.011, 0.06, m.steel, 0, 0.065, 0.06, 12);
  rbox(bolt, 0.05, 0.008, 0.008, m.steel, 0.03, 0.06, 0.08, 0, 0, -0.5, 0.002);
  const knob = new THREE.Mesh(new THREE.SphereGeometry(0.009, 12, 8), m.polymer);
  knob.position.set(0.055, 0.047, 0.08);
  bolt.add(knob);
  rbox(root, 0.05, 0.09, 0.44, m.olive, 0, -0.005, 0.3, 0.05, 0, 0, 0.012);
  rbox(root, 0.052, 0.035, 0.11, m.polymer, 0, -0.01, 0.2, 0.05, 0, 0, 0.008);
  rbox(root, 0.04, 0.03, 0.16, m.olive, 0, 0.058, 0.32, 0, 0, 0, 0.008);
  rbox(root, 0.054, 0.12, 0.022, m.rubber, 0, -0.01, 0.53, 0.05, 0, 0, 0.006);
  rbox(root, 0.007, 0.006, 0.05, m.polymer, 0, -0.025, 0.04, 0, 0, 0, 0.002);
  for (const x of [-0.012, 0.012]) rbox(root, 0.006, 0.006, 0.2, m.gunmetal, x, -0.005, -0.38, 0, 0, 0, 0.002);
  const mag = group(root, 'mag');
  rbox(mag, 0.032, 0.06, 0.085, m.gunmetal, 0, -0.03, -0.05, 0, 0, 0, 0.004);
  anchor(root, 'muzzle', 0, 0.048, -0.875);
  anchor(root, 'eject', 0.027, 0.06, 0.04);
  anchor(root, 'sight', 0, 0.118, 0.22);
  anchor(root, 'gripR', 0, -0.05, 0.09);
  anchor(root, 'gripL', 0, -0.01, -0.3);
  return root;
}

function buildKnife(m: GunMaterials): THREE.Group {
  const root = new THREE.Group();
  rbox(root, 0.026, 0.03, 0.11, m.rubber, 0, 0, 0.03, 0, 0, 0, 0.008);
  for (let i = 0; i < 4; i++) rbox(root, 0.028, 0.032, 0.006, m.polymer, 0, 0, 0.0 + i * 0.022, 0, 0, 0, 0.002);
  rbox(root, 0.03, 0.056, 0.01, m.gunmetal, 0, 0.006, -0.03, 0, 0, 0, 0.002);
  rbox(root, 0.03, 0.03, 0.012, m.gunmetal, 0, 0, 0.09, 0, 0, 0, 0.004);
  const shape = new THREE.Shape();
  shape.moveTo(0, -0.012);
  shape.lineTo(0.15, -0.012);
  shape.lineTo(0.18, 0.004);
  shape.lineTo(0.16, 0.018);
  shape.lineTo(0, 0.018);
  shape.closePath();
  const bg = new THREE.ExtrudeGeometry(shape, { depth: 0.004, bevelEnabled: true, bevelThickness: 0.0012, bevelSize: 0.0012, bevelSegments: 1 });
  bg.translate(0, 0, -0.002);
  const blade = new THREE.Mesh(bg, m.chrome);
  blade.rotation.y = Math.PI / 2;
  blade.position.set(0, 0.008, -0.035);
  root.add(blade);
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
      g = buildPistol(m, false);
      break;
    case 'magnum':
      g = buildPistol(m, true);
      break;
    case 'smg':
      g = buildSmg(m);
      break;
    case 'shotgun':
      g = buildShotgun(m);
      break;
    case 'rifle':
      g = buildRifle(m);
      break;
    case 'sniper':
      g = buildSniper(m);
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

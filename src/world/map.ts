import * as THREE from 'three';
import { CollisionWorld, type ColliderBox } from './collision';
import { Batcher, type BoxOpts, type Tint } from './batcher';
import type { MatKey, MaterialLibrary } from '../render/materials';
import { energyWallMaterial, lightShaftMaterial, globalTime } from '../render/shaders';
import { SUN_DIR } from '../render/environment';
import { spawnEmblem } from '../render/textures';
import { TEAMS, type TeamId } from '../core/config';
import { mulberry32 } from '../core/utils';

export interface SpawnPoint {
  pos: THREE.Vector3;
  yaw: number;
}

export interface CoinSpot {
  id: number;
  pos: THREE.Vector3;
  /** Spots sharing a pair id are mirror images and always spawn together. */
  pair: number;
}

/** A shooting-range target: stands at `pos` facing `yaw`, optionally strafing / crouch-peeking. */
export interface RangeTarget {
  name: string;
  pos: THREE.Vector3;
  yaw: number;
  /** Half-width of the strafe lane in metres (0 = static). */
  strafe: number;
  crouch: boolean;
}

export interface RadarRect {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  h: number;
}

export interface GameMap {
  name: string;
  world: CollisionWorld;
  root: THREE.Group;
  spawns: Record<TeamId, SpawnPoint[]>;
  coinSpots: CoinSpot[];
  bigCoinSpots: THREE.Vector3[];
  navNodes: THREE.Vector3[];
  radar: RadarRect[];
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
  /** Shooting-range layout: the firing spot and target stations. */
  range: { spawn: SpawnPoint; targets: RangeTarget[] };
  pointLights: THREE.PointLight[];
  setSpawnBarriers(active: boolean): void;
  update(time: number, dt: number): void;
}

const V = (x: number, y: number, z: number): THREE.Vector3 => new THREE.Vector3(x, y, z);

interface SolidOpts extends BoxOpts {
  noCollide?: boolean;
  bullets?: boolean;
  skirt?: boolean;
  skirtW?: number;
  radar?: boolean;
  invisible?: boolean;
  tag?: string;
}

function textTexture(lines: string[], color: string, w: number, h: number, font = 'Rajdhani', weight = 700, glow = true): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  ctx.clearRect(0, 0, w, h);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const size = Math.floor((h / lines.length) * 0.72);
  ctx.font = `${weight} ${size}px ${font}, 'Chakra Petch', 'Noto Sans KR', sans-serif`;
  lines.forEach((line, i) => {
    const y = (h / lines.length) * (i + 0.5);
    if (glow) {
      ctx.shadowColor = color;
      ctx.shadowBlur = h * 0.08;
    }
    ctx.fillStyle = color;
    ctx.fillText(line, w / 2, y);
  });
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

export function buildMap(lib: MaterialLibrary): GameMap {
  const b = new Batcher(lib);
  const world = new CollisionWorld();
  const root = new THREE.Group();
  root.name = 'map';
  const radar: RadarRect[] = [];
  const animated: ((t: number, dt: number) => void)[] = [];
  const pointLights: THREE.PointLight[] = [];
  const rng = mulberry32(1337);

  const solid = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, mat: MatKey, o: SolidOpts = {}): ColliderBox | null => {
    const min = V(Math.min(x0, x1), Math.min(y0, y1), Math.min(z0, z1));
    const max = V(Math.max(x0, x1), Math.max(y0, y1), Math.max(z0, z1));
    let box: ColliderBox | null = null;
    if (!o.noCollide) box = world.add(min, max, { blocksBullets: o.bullets ?? true, tag: o.tag ?? 'world' });
    if (!o.invisible) b.box(min, max, mat, o);
    const h = max.y - min.y;
    if (!o.noCollide && o.skirt !== false && h > 0.35 && min.y < 1.5) b.aoSkirt(min, max, o.skirtW ?? Math.min(0.9, 0.35 + h * 0.18));
    if (!o.noCollide && o.radar !== false && h > 0.7) radar.push({ x0: min.x, z0: min.z, x1: max.x, z1: max.z, h: max.y });
    return box;
  };
  const deco = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, mat: MatKey, o: BoxOpts = {}): void => {
    b.box(V(Math.min(x0, x1), Math.min(y0, y1), Math.min(z0, z1)), V(Math.max(x0, x1), Math.max(y0, y1), Math.max(z0, z1)), mat, o);
  };
  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const place = (geo: THREE.BufferGeometry, x: number, y: number, z: number, rx: number, ry: number, rz: number, mat: MatKey, tint?: Tint, aoBase = 0, uvRep: [number, number] = [1, 1], sx = 1, sy = 1, sz = 1): void => {
    e.set(rx, ry, rz);
    q.setFromEuler(e);
    m4.compose(V(x, y, z), q, V(sx, sy, sz));
    b.geom(geo, m4, mat, tint, aoBase, uvRep);
  };

  // Shared prop geometries.
  const cyl = new THREE.CylinderGeometry(1, 1, 1, 18, 1);
  const cylLow = new THREE.CylinderGeometry(1, 1, 1, 10, 1);
  const sphere = new THREE.SphereGeometry(1, 14, 10);

  // ---------------------------------------------------------------------------
  // Props
  // ---------------------------------------------------------------------------

  const containerFrameTint: Partial<Record<MatKey, Tint>> = {
    corrRed: [0.2, 0.035, 0.025],
    corrBlue: [0.03, 0.07, 0.16],
    corrTeal: [0.02, 0.14, 0.14],
    corrOrange: [0.32, 0.11, 0.02],
    corrYellow: [0.32, 0.23, 0.03],
  };

  const container = (x0: number, x1: number, z0: number, z1: number, y0: number, mat: MatKey, doorEnd: 1 | -1 = 1): void => {
    const h = 2.6;
    const minX = Math.min(x0, x1);
    const maxX = Math.max(x0, x1);
    const minZ = Math.min(z0, z1);
    const maxZ = Math.max(z0, z1);
    solid(minX, maxX, y0, y0 + h, minZ, maxZ, mat, { invisible: true });
    const alongX = maxX - minX > maxZ - minZ;
    const ft = containerFrameTint[mat] ?? [0.1, 0.1, 0.1];
    const inset = 0.06;
    const post = 0.17;
    // Body panels (inset on the long sides so the frame reads).
    if (alongX) deco(minX + post, maxX - post, y0 + 0.14, y0 + h - 0.12, minZ + inset, maxZ - inset, mat, { uvOffset: [rng(), 0] });
    else deco(minX + inset, maxX - inset, y0 + 0.14, y0 + h - 0.12, minZ + post, maxZ - post, mat, { uvOffset: [rng(), 0] });
    // Roof
    deco(minX + 0.03, maxX - 0.03, y0 + h - 0.12, y0 + h - 0.02, minZ + 0.03, maxZ - 0.03, 'metal', { tint: ft });
    // Corner posts
    for (const cx of [minX, maxX - post]) for (const cz of [minZ, maxZ - post]) deco(cx, cx + post, y0, y0 + h, cz, cz + post, 'metal', { tint: ft });
    // Rails
    if (alongX) {
      for (const cz of [minZ, maxZ - 0.12]) {
        deco(minX, maxX, y0, y0 + 0.16, cz, cz + 0.12, 'metal', { tint: ft });
        deco(minX, maxX, y0 + h - 0.16, y0 + h, cz, cz + 0.12, 'metal', { tint: ft });
      }
      const endX = doorEnd > 0 ? maxX : minX;
      // door end header / sill
      deco(endX - 0.1, endX, y0, y0 + 0.2, minZ, maxZ, 'metal', { tint: ft });
      deco(endX - 0.1, endX, y0 + h - 0.22, y0 + h, minZ, maxZ, 'metal', { tint: ft });
      // door lock rods
      const dz = maxZ - minZ;
      for (const k of [0.2, 0.38, 0.62, 0.8]) {
        place(cylLow, endX + 0.03 * doorEnd, y0 + h / 2, minZ + dz * k, 0, 0, 0, 'trim', [0.6, 0.6, 0.6], y0, [1, 1], 0.025, h - 0.45, 0.025);
        deco(endX, endX + 0.06 * doorEnd, y0 + 1.1, y0 + 1.2, minZ + dz * k - 0.05, minZ + dz * k + 0.05, 'trim', { tint: [0.5, 0.5, 0.5] });
      }
      deco(endX - 0.02 * doorEnd, endX, y0 + 0.2, y0 + h - 0.22, minZ + dz / 2 - 0.015, minZ + dz / 2 + 0.015, 'rubber', { tint: [0.05, 0.05, 0.05] });
      const otherX = doorEnd > 0 ? minX : maxX;
      deco(otherX - 0.05, otherX + 0.05, y0 + 0.16, y0 + h - 0.16, minZ + post, maxZ - post, mat);
    } else {
      for (const cx of [minX, maxX - 0.12]) {
        deco(cx, cx + 0.12, y0, y0 + 0.16, minZ, maxZ, 'metal', { tint: ft });
        deco(cx, cx + 0.12, y0 + h - 0.16, y0 + h, minZ, maxZ, 'metal', { tint: ft });
      }
      const endZ = doorEnd > 0 ? maxZ : minZ;
      deco(minX, maxX, y0, y0 + 0.2, endZ - 0.1, endZ, 'metal', { tint: ft });
      deco(minX, maxX, y0 + h - 0.22, y0 + h, endZ - 0.1, endZ, 'metal', { tint: ft });
      const dx = maxX - minX;
      for (const k of [0.2, 0.38, 0.62, 0.8]) {
        place(cylLow, minX + dx * k, y0 + h / 2, endZ + 0.03 * doorEnd, 0, 0, 0, 'trim', [0.6, 0.6, 0.6], y0, [1, 1], 0.025, h - 0.45, 0.025);
      }
      const otherZ = doorEnd > 0 ? minZ : maxZ;
      deco(minX + post, maxX - post, y0 + 0.16, y0 + h - 0.16, otherZ - 0.05, otherZ + 0.05, mat);
    }
  };

  const crate = (cx: number, cz: number, size: number, y0 = 0, hgt = size, rot = 0): void => {
    const hs = size / 2;
    solid(cx - hs, cx + hs, y0, y0 + hgt, cz - hs, cz + hs, 'wood', { invisible: true });
    if (rot === 0) {
      deco(cx - hs, cx + hs, y0, y0 + hgt, cz - hs, cz + hs, 'wood', { tint: [0.95 + rng() * 0.1, 0.92 + rng() * 0.1, 0.9] });
    } else {
      place(new THREE.BoxGeometry(size, hgt, size), cx, y0 + hgt / 2, cz, 0, rot, 0, 'wood', [1, 0.96, 0.92], y0);
    }
  };

  const barrel = (cx: number, cz: number, y0: number, tint: Tint): void => {
    const r = 0.29;
    const h = 0.9;
    solid(cx - r, cx + r, y0, y0 + h, cz - r, cz + r, 'metal', { invisible: true, skirtW: 0.35 });
    place(cyl, cx, y0 + h / 2, cz, 0, rng() * 6, 0, 'metal', tint, y0, [1.2, 0.5], r, h, r);
    for (const k of [0.3, 0.66]) place(cyl, cx, y0 + h * k, cz, 0, 0, 0, 'metal', tint, y0, [1, 0.05], r + 0.012, 0.035, r + 0.012);
    place(cyl, cx, y0 + h - 0.005, cz, 0, 0, 0, 'trim', [0.3, 0.3, 0.3], y0, [1, 1], r - 0.02, 0.02, r - 0.02);
  };

  const jersey = (x0: number, x1: number, z0: number, z1: number, tint: Tint = [0.78, 0.77, 0.74]): void => {
    const alongX = Math.abs(x1 - x0) > Math.abs(z1 - z0);
    const len = alongX ? Math.abs(x1 - x0) : Math.abs(z1 - z0);
    const cx = (x0 + x1) / 2;
    const cz = (z0 + z1) / 2;
    const hw = 0.3;
    const top = 0.1;
    if (alongX) {
      solid(cx - len / 2, cx + len / 2, 0, 0.32, cz - hw, cz + hw, 'concrete', { invisible: true });
      solid(cx - len / 2, cx + len / 2, 0.32, 1.05, cz - top - 0.03, cz + top + 0.03, 'concrete', { invisible: true, skirt: false });
    } else {
      solid(cx - hw, cx + hw, 0, 0.32, cz - len / 2, cz + len / 2, 'concrete', { invisible: true });
      solid(cx - top - 0.03, cx + top + 0.03, 0.32, 1.05, cz - len / 2, cz + len / 2, 'concrete', { invisible: true, skirt: false });
    }
    const shape = new THREE.Shape();
    shape.moveTo(-hw, 0);
    shape.lineTo(hw, 0);
    shape.lineTo(hw, 0.08);
    shape.lineTo(0.13, 0.32);
    shape.lineTo(top, 1.05);
    shape.lineTo(-top, 1.05);
    shape.lineTo(-0.13, 0.32);
    shape.lineTo(-hw, 0.08);
    shape.closePath();
    const g = new THREE.ExtrudeGeometry(shape, { depth: len, bevelEnabled: false });
    g.translate(0, 0, -len / 2);
    place(g, cx, 0, cz, 0, alongX ? Math.PI / 2 : 0, 0, 'concrete', tint, 0, [0.25, 0.25]);
    // painted stripes
    const stripeMat: MatKey = 'hazard';
    if (alongX) deco(cx - len / 2 + 0.02, cx + len / 2 - 0.02, 0.85, 0.98, cz - top - 0.012, cz + top + 0.012, stripeMat);
    else deco(cx - top - 0.012, cx + top + 0.012, 0.85, 0.98, cz - len / 2 + 0.02, cz + len / 2 - 0.02, stripeMat);
  };

  const lampPost = (x: number, z: number, armDirX: number, armDirZ: number, color = 0xffc58a, intensity = 26, withLight = true): void => {
    const h = 5.2;
    solid(x - 0.12, x + 0.12, 0, h, z - 0.12, z + 0.12, 'trim', { invisible: true, skirt: false, radar: false });
    place(cyl, x, h / 2, z, 0, 0, 0, 'trim', [0.18, 0.19, 0.2], 0, [1, 1], 0.075, h, 0.075);
    place(cyl, x, 0.25, z, 0, 0, 0, 'trim', [0.15, 0.15, 0.16], 0, [1, 1], 0.14, 0.5, 0.14);
    const ax = x + armDirX * 0.9;
    const az = z + armDirZ * 0.9;
    deco(Math.min(x, ax) - 0.04, Math.max(x, ax) + 0.04, h - 0.1, h, Math.min(z, az) - 0.04, Math.max(z, az) + 0.04, 'trim', { tint: [0.18, 0.19, 0.2] });
    deco(ax - 0.28, ax + 0.28, h - 0.22, h - 0.04, az - 0.16, az + 0.16, 'trim', { tint: [0.12, 0.12, 0.13] });
    deco(ax - 0.24, ax + 0.24, h - 0.24, h - 0.2, az - 0.12, az + 0.12, 'lampLens');
    if (withLight) {
      // Lamp heads stay readable without blowing out the walls right next to them.
      const l = new THREE.PointLight(color, intensity * 0.78, 16, 1.8);
      l.position.set(ax, h - 0.5, az);
      root.add(l);
      pointLights.push(l);
    }
  };

  const ventUnit = (x: number, y: number, z: number, w: number, h: number, d: number): void => {
    deco(x - w / 2, x + w / 2, y, y + h, z - d / 2, z + d / 2, 'metal', { tint: [0.55, 0.57, 0.58] });
    for (let k = 0; k < 5; k++) {
      const yy = y + 0.1 + (k * (h - 0.2)) / 5;
      if (w > d) deco(x - w / 2 + 0.05, x + w / 2 - 0.05, yy, yy + 0.03, z - d / 2 - 0.02, z + d / 2 + 0.02, 'trim', { tint: [0.2, 0.2, 0.2] });
      else deco(x - w / 2 - 0.02, x + w / 2 + 0.02, yy, yy + 0.03, z - d / 2 + 0.05, z + d / 2 - 0.05, 'trim', { tint: [0.2, 0.2, 0.2] });
    }
  };

  /** Row of windows on a facade facing `nx,nz` (one of the axes). */
  const windowRow = (fixedCoord: number, from: number, to: number, y0: number, y1: number, alongX: boolean, outward: 1 | -1, spacing = 3, winW = 1.6, litChance = 0.25): void => {
    for (let c = from + spacing / 2; c < to - 0.8; c += spacing) {
      const lit = rng() < litChance;
      const glassMat: MatKey = lit ? 'neonWarm' : 'glass';
      const o = outward;
      const f = fixedCoord;
      if (alongX) {
        deco(c - winW / 2, c + winW / 2, y0, y1, f + o * 0.005, f + o * 0.03, glassMat, lit ? {} : { tint: [1, 1, 1] });
        deco(c - winW / 2 - 0.08, c + winW / 2 + 0.08, y0 - 0.1, y0, f, f + o * 0.12, 'trim', { tint: [0.25, 0.26, 0.28] });
        deco(c - winW / 2 - 0.08, c + winW / 2 + 0.08, y1, y1 + 0.08, f, f + o * 0.08, 'trim', { tint: [0.25, 0.26, 0.28] });
        deco(c - winW / 2 - 0.08, c - winW / 2, y0, y1, f, f + o * 0.08, 'trim', { tint: [0.25, 0.26, 0.28] });
        deco(c + winW / 2, c + winW / 2 + 0.08, y0, y1, f, f + o * 0.08, 'trim', { tint: [0.25, 0.26, 0.28] });
        deco(c - 0.025, c + 0.025, y0, y1, f, f + o * 0.06, 'trim', { tint: [0.25, 0.26, 0.28] });
      } else {
        deco(f + o * 0.005, f + o * 0.03, y0, y1, c - winW / 2, c + winW / 2, glassMat, lit ? {} : { tint: [1, 1, 1] });
        deco(f, f + o * 0.12, y0 - 0.1, y0, c - winW / 2 - 0.08, c + winW / 2 + 0.08, 'trim', { tint: [0.25, 0.26, 0.28] });
        deco(f, f + o * 0.08, y1, y1 + 0.08, c - winW / 2 - 0.08, c + winW / 2 + 0.08, 'trim', { tint: [0.25, 0.26, 0.28] });
        deco(f, f + o * 0.08, y0, y1, c - winW / 2 - 0.08, c - winW / 2, 'trim', { tint: [0.25, 0.26, 0.28] });
        deco(f, f + o * 0.08, y0, y1, c + winW / 2, c + winW / 2 + 0.08, 'trim', { tint: [0.25, 0.26, 0.28] });
        deco(f, f + o * 0.06, y0, y1, c - 0.025, c + 0.025, 'trim', { tint: [0.25, 0.26, 0.28] });
      }
    }
  };

  const pipeRun = (x0: number, x1: number, y: number, z: number, r: number, tint: Tint): void => {
    const len = Math.abs(x1 - x0);
    place(cyl, (x0 + x1) / 2, y, z, 0, 0, Math.PI / 2, 'metal', tint, 0, [0.3, len / 2], r, len, r);
    for (let x = Math.min(x0, x1) + 1; x < Math.max(x0, x1); x += 2.5) deco(x - 0.04, x + 0.04, y - r - 0.04, y + r + 0.04, z - r - 0.06, z + r + 0.06, 'trim', { tint: [0.15, 0.15, 0.15] });
  };

  const sign = (text: string[], color: string, x: number, y: number, z: number, w: number, h: number, ry: number, intensity = 2.2): void => {
    const tex = textTexture(text, color, 1024, Math.round((1024 * h) / w));
    // Signs read as lit panels, not light sources: 0.7 keeps them under the bloom threshold.
    const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, toneMapped: true, color: new THREE.Color(1, 1, 1).multiplyScalar(intensity * 0.7) });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
    mesh.position.set(x, y, z);
    mesh.rotation.y = ry;
    mesh.renderOrder = 2;
    root.add(mesh);
  };

  // ---------------------------------------------------------------------------
  // Ground
  // ---------------------------------------------------------------------------
  for (const s of [1, -1]) {
    const X = (x: number): number => x * s;
    solid(X(-37.4), X(-22), -1, 0, -22.4, 22.4, 'floor', { skirt: false, radar: false });
  }
  solid(-22, 22, -1, 0, -22.4, -10, 'asphalt', { skirt: false, radar: false });
  solid(-22, 22, -1, 0, -10, 6, 'plaza', { skirt: false, radar: false });
  solid(-22, 22, -1, 0, 6, 22.4, 'epoxy', { skirt: false, radar: false });
  // Lane markings in the container yard
  for (const z of [-10.7, -20.7]) b.floorQuad(-21.5, z - 0.07, 21.5, z + 0.07, 0.004, 'paintYellow');
  for (let x = -20; x <= 20; x += 4) b.floorQuad(x - 0.06, -12.4, x + 0.06, -10.7, 0.004, 'paintWhite');
  // Puddles
  for (const [px, pz, r] of [
    [-9, -12.3, 1.6],
    [9, -12.3, 1.6],
    [-18.5, 1.8, 1.2],
    [18.5, 1.8, 1.2],
    [-25.5, -12, 1.4],
    [25.5, -12, 1.4],
    [0, -19.5, 1.1],
  ] as const) {
    const g = new THREE.CircleGeometry(1, 24);
    g.rotateX(-Math.PI / 2);
    const pos = g.getAttribute('position');
    for (let i = 1; i < pos.count; i++) {
      const k = 0.75 + Math.sin(i * 2.3 + px) * 0.15 + Math.cos(i * 1.7 + pz) * 0.1;
      pos.setXYZ(i, pos.getX(i) * k, 0, pos.getZ(i) * k * 0.7);
    }
    place(g, px, 0.006, pz, 0, rng() * 3, 0, 'puddle', undefined, 0, [1, 1], r, 1, r);
  }

  // ---------------------------------------------------------------------------
  // Outer boundary
  // ---------------------------------------------------------------------------
  // North: jersey barriers + chain-link fence looking out over the harbor.
  for (let x = -36; x < 36; x += 3) jersey(x + 0.05, x + 2.95, -21.6, -21.6);
  solid(-37.4, 37.4, 1.05, 9, -22.2, -21.3, 'concrete', { invisible: true, bullets: false, radar: false, skirt: false });
  for (let x = -36; x <= 36; x += 3) place(cyl, x, 2.6, -21.75, 0, 0, 0, 'trim', [0.4, 0.42, 0.44], 0, [1, 1], 0.045, 5.2, 0.045);
  {
    const fence = new THREE.PlaneGeometry(72.8, 3.6);
    const uv = fence.getAttribute('uv');
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 72.8 * 6, uv.getY(i) * 3.6 * 6);
    place(fence, 0, 3.2, -21.75, 0, 0, 0, 'fence');
    place(cyl, 0, 5.0, -21.75, 0, 0, Math.PI / 2, 'trim', [0.4, 0.42, 0.44], 0, [1, 1], 0.03, 72.8, 0.03);
    place(cyl, 0, 1.4, -21.75, 0, 0, Math.PI / 2, 'trim', [0.4, 0.42, 0.44], 0, [1, 1], 0.03, 72.8, 0.03);
  }
  // South wall (warehouse back) and side walls.
  solid(-22.6, 22.6, 0, 8.5, 21.4, 22.4, 'corrWall', { tint: [0.62, 0.64, 0.66] });
  for (const s of [1, -1]) {
    const X = (x: number): number => x * s;
    solid(X(-37.4), X(-22.6), 0, 8.5, 21.4, 22.4, 'concrete');
    solid(X(-37.4), X(-36.4), 0, 8.5, -22.4, 22.4, 'concrete');
  }

  // ---------------------------------------------------------------------------
  // Mirrored halves (s = 1: west / VANGUARD, s = -1: east / EMBER)
  // ---------------------------------------------------------------------------
  const spawnBarrierBoxes: Record<TeamId, ColliderBox[]> = { 0: [], 1: [] };
  const spawnBarrierMeshes: THREE.Mesh[] = [];

  for (const s of [1, -1] as const) {
    const X = (x: number): number => x * s;
    const team: TeamId = s === 1 ? 0 : 1;
    const neon: MatKey = team === 0 ? 'neonA' : 'neonB';
    const teamColor = TEAMS[team].color;
    const out: 1 | -1 = s === 1 ? 1 : -1; // facade normal direction towards map center (+x for west)

    // --- Base complex: two office blocks flanking the spawn alcove ---------
    const blockTint: Tint = team === 0 ? [0.42, 0.47, 0.54] : [0.55, 0.47, 0.43];
    solid(X(-36.4), X(-28), 0, 6.5, -21.3, -7, 'metal', { tint: blockTint });
    solid(X(-36.4), X(-28), 0, 6.5, 7, 21.3, 'metal', { tint: blockTint });
    // concrete plinth + parapet
    for (const [z0, z1] of [
      [-21.3, -7],
      [7, 21.3],
    ]) {
      deco(X(-28), X(-27.92), 0, 0.6, z0, z1, 'concrete', { tint: [0.7, 0.7, 0.7] });
      deco(X(-36.4), X(-27.85), 6.5, 6.9, z0, z1, 'concrete', { tint: [0.6, 0.6, 0.62] });
      deco(X(-28), X(-27.9), 3.0, 3.12, z0, z1, 'trim', { tint: [0.2, 0.2, 0.22] });
      windowRow(X(-28), z0, z1, 3.6, 5.4, false, out, 3.2, 1.9, 0.3);
      // Roof clutter
      ventUnit(X(-33), 6.9, (z0 + z1) / 2 - 3, 1.6, 1.1, 2.2);
      ventUnit(X(-31), 6.9, (z0 + z1) / 2 + 3.5, 1.2, 0.8, 1.2);
    }
    // Roller shutter doors on the office blocks (decor)
    for (const zc of [-15, 15]) {
      deco(X(-28), X(-27.86), 0, 3.4, zc - 2, zc + 2, 'corrWall', { tint: [0.55, 0.55, 0.52], uvScale: 1.2 });
      deco(X(-28), X(-27.8), 3.4, 3.7, zc - 2.2, zc + 2.2, 'trim', { tint: [0.15, 0.15, 0.16] });
      deco(X(-27.86), X(-27.82), 0.9, 1.1, zc - 0.3, zc + 0.3, 'hazard');
    }
    // Faces looking into the spawn alcove
    for (const [zf, o] of [
      [-7, 1],
      [7, -1],
    ] as const) {
      windowRow(zf, Math.min(X(-36), X(-29)), Math.max(X(-36), X(-29)), 1.0, 2.6, true, o, 2.4, 1.6, 0.4);
    }

    // --- Spawn alcove ----------------------------------------------------------
    solid(X(-36.4), X(-30.2), 3.9, 4.2, -7, 7, 'metal', { tint: [0.22, 0.23, 0.25], radar: false });
    deco(X(-30.4), X(-30.2), 3.6, 3.9, -7, 7, 'trim', { tint: [0.15, 0.15, 0.16] });
    deco(X(-30.32), X(-30.22), 3.55, 3.62, -6.8, 6.8, neon);
    for (const zz of [-6, -2, 2, 6]) deco(X(-36.3), X(-30.4), 3.82, 3.9, zz - 0.06, zz + 0.06, neon);
    // Lockers along the back wall
    for (const z0 of [-6.2, -3.6, 1.2, 3.8]) {
      solid(X(-36.4), X(-35.7), 0, 2.2, z0, z0 + 2.4, 'metal', { tint: team === 0 ? [0.2, 0.32, 0.42] : [0.45, 0.22, 0.15] });
      for (let k = 0; k < 4; k++) deco(X(-35.7), X(-35.66), 0.1, 2.1, z0 + k * 0.6 + 0.04, z0 + k * 0.6 + 0.05, 'trim', { tint: [0.05, 0.05, 0.05] });
    }
    // Team emblem on the spawn floor and team banner on the back wall
    {
      const tex = spawnEmblem(512, TEAMS[team].css, TEAMS[team].name);
      const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, color: new THREE.Color(1, 1, 1).multiplyScalar(1.15) });
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(6, 6), mat);
      mesh.rotation.x = -Math.PI / 2;
      mesh.rotation.z = s === 1 ? -Math.PI / 2 : Math.PI / 2;
      mesh.position.set(X(-33), 0.015, 0);
      mesh.renderOrder = 1;
      root.add(mesh);
      sign([TEAMS[team].name], TEAMS[team].css, X(-36.38), 3.0, 0, 4.4, 0.9, s === 1 ? Math.PI / 2 : -Math.PI / 2, 2.6);
      const l = new THREE.PointLight(teamColor, 3, 8, 1.8);
      l.position.set(X(-33), 3.4, 0);
      root.add(l);
      pointLights.push(l);
    }
    // Spawn barrier (active during the buy phase only)
    {
      const box = world.add(V(Math.min(X(-28.15), X(-27.85)), 0, -7), V(Math.max(X(-28.15), X(-27.85)), 4.2, 7), { tag: 'spawnwall', enabled: false });
      spawnBarrierBoxes[team].push(box);
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(14, 3.9), energyWallMaterial(teamColor, 0.7));
      mesh.position.set(X(-28), 1.95, 0);
      mesh.rotation.y = Math.PI / 2;
      mesh.visible = false;
      mesh.renderOrder = 5;
      root.add(mesh);
      spawnBarrierMeshes.push(mesh);
      deco(X(-28.25), X(-27.75), 0, 0.12, -7, 7, 'trim', { tint: [0.15, 0.15, 0.16] });
      deco(X(-28.08), X(-27.92), 0.12, 0.15, -6.9, 6.9, neon);
    }

    // --- Transition corridor --------------------------------------------------
    solid(X(-24.4), X(-23.8), 0, 3.0, -2.6, 2.6, 'concrete', { tint: [0.85, 0.85, 0.85] });
    deco(X(-24.45), X(-23.75), 3.0, 3.12, -2.65, 2.65, 'hazard');
    deco(X(-23.8), X(-23.77), 1.6, 1.68, -2.4, 2.4, neon);
    crate(X(-26.8), -18.9, 1.2);
    crate(X(-26.95), -17.85, 0.9);
    crate(X(-26.8), -18.9, 0.9, 1.2, 0.9, 0.3);
    barrel(X(-23.1), -19.9, 0, [0.15, 0.3, 0.55]);
    barrel(X(-23.75), -20.45, 0, [0.15, 0.3, 0.55]);
    barrel(X(-22.95), -20.6, 0, [0.55, 0.12, 0.08]);
    crate(X(-26.6), 16.6, 1.2);
    crate(X(-26.6), 16.6, 0.9, 1.2, 0.9, -0.25);
    barrel(X(-23.2), 19.6, 0, [0.6, 0.45, 0.05]);
    barrel(X(-23.85), 20.2, 0, [0.6, 0.45, 0.05]);
    lampPost(X(-27.5), -9.0, out, 0);
    lampPost(X(-27.5), 9.0, out, 0, 0xffc58a, 22, false);

    // --- North divider (container yard | mid) ---------------------------------
    solid(X(-22), X(-7), 0, 4.5, -10, -6, 'concrete');
    deco(X(-22.1), X(-6.9), 4.5, 4.66, -10.1, -5.9, 'trim', { tint: [0.3, 0.3, 0.32] });
    pipeRun(X(-21.5), X(-7.5), 3.7, -10.18, 0.12, [0.5, 0.45, 0.35]);
    pipeRun(X(-21.5), X(-7.5), 3.35, -10.16, 0.07, [0.3, 0.35, 0.4]);
    deco(X(-21.8), X(-7.2), 0, 0.5, -5.95, -5.9, 'hazard');
    deco(X(-19), X(-10), 2.2, 2.28, -5.92, -5.88, neon);
    sign(['DOCK 07'], '#ffd9a8', X(-14.5), 3.2, -5.88, 3.6, 0.9, 0, 1.8);
    ventUnit(X(-16), 4.66, -8, 1.8, 0.9, 1.4);

    // --- Warehouse front (mid | warehouse) ------------------------------------
    solid(X(-22.6), X(-7), 0, 6.5, 6, 10, 'corrWall', { tint: [0.58, 0.6, 0.62] });
    deco(X(-22.6), X(-7), 0, 1.0, 5.94, 6, 'concrete', { tint: [0.72, 0.72, 0.72] });
    deco(X(-22.6), X(-7), 6.5, 6.75, 5.9, 10, 'trim', { tint: [0.24, 0.25, 0.27] });
    windowRow(6, Math.min(X(-21), X(-8)), Math.max(X(-21), X(-8)), 4.2, 5.6, true, -1, 2.6, 1.8, 0.2);
    deco(X(-20), X(-9), 3.6, 3.7, 5.93, 5.96, neon);
    // Doorway lintel & frame for the opening x ∈ [-7,-2.5]
    solid(X(-7), X(-2.5), 4.0, 6.5, 6, 10, 'corrWall', { tint: [0.58, 0.6, 0.62] });
    for (const xx of [-7, -2.5]) deco(X(xx) - 0.08, X(xx) + 0.08, 0, 4.0, 5.92, 6.08, 'hazard');
    deco(X(-7.08), X(-2.42), 3.9, 4.05, 5.9, 6.1, 'trim', { tint: [0.15, 0.15, 0.16] });
    deco(X(-6.9), X(-2.6), 3.8, 3.86, 6.1, 6.14, 'neonWhite');
    // Sliding door panel parked beside the opening
    deco(X(-9.6), X(-7.05), 0, 4.0, 5.82, 5.92, 'corrWall', { tint: [0.4, 0.42, 0.4], uvScale: 1.5 });

    // --- Warehouse interior ------------------------------------------------------
    solid(X(-22.6), X(-22), 0, 6.5, 10, 13, 'corrWall', { tint: [0.55, 0.57, 0.6] });
    solid(X(-22.6), X(-22), 0, 6.5, 17.5, 21.4, 'corrWall', { tint: [0.55, 0.57, 0.6] });
    solid(X(-22.6), X(-22), 4.0, 6.5, 13, 17.5, 'corrWall', { tint: [0.55, 0.57, 0.6] });
    for (const zz of [13, 17.5]) deco(X(-22.68), X(-21.92), 0, 4.0, zz - 0.08, zz + 0.08, 'hazard');
    deco(X(-22.7), X(-21.9), 3.92, 4.06, 12.9, 17.6, 'trim', { tint: [0.15, 0.15, 0.16] });
    // Pallet racks (orange uprights, blue beams, stocked)
    for (const [z0, z1] of [
      [12.6, 13.6],
      [17.4, 18.4],
    ] as const) {
      solid(X(-18), X(-12), 0, 3.0, z0, z1, 'metal', { invisible: true });
      for (const xx of [-18, -15, -12]) deco(X(xx) - 0.06, X(xx) + 0.06, 0, 3.05, z0, z1, 'metal', { tint: [0.75, 0.3, 0.05] });
      for (const yy of [0.12, 1.1, 2.1]) {
        deco(X(-18), X(-12), yy, yy + 0.1, z0, z0 + 0.08, 'metal', { tint: [0.08, 0.2, 0.5] });
        deco(X(-18), X(-12), yy, yy + 0.1, z1 - 0.08, z1, 'metal', { tint: [0.08, 0.2, 0.5] });
        deco(X(-17.95), X(-12.05), yy + 0.08, yy + 0.12, z0 + 0.05, z1 - 0.05, 'wood', { tint: [0.8, 0.7, 0.6] });
      }
      // goods: cardboard boxes & wrapped pallets
      for (const yy of [0.22, 1.22, 2.22]) {
        for (let xx = -17.8; xx < -12.3; xx += 1.45) {
          const hh = 0.55 + rng() * 0.3;
          const ww = 1.1 + rng() * 0.2;
          deco(X(xx), X(xx + ww), yy, yy + hh, z0 + 0.12, z1 - 0.12, rng() < 0.5 ? 'rubber' : 'wood', { tint: rng() < 0.5 ? [0.55, 0.4, 0.25] : [0.75, 0.75, 0.72] });
        }
      }
      deco(X(-18.02), X(-11.98), 0, 3.0, (z0 + z1) / 2 - 0.02, (z0 + z1) / 2 + 0.02, 'metal', { tint: [0.2, 0.2, 0.22] });
    }
    crate(X(-8), 18.8, 1.2);
    crate(X(-7.95), 18.8, 0.9, 1.2, 0.9, 0.2);
    crate(X(-6.35), 11.85, 0.9);
    crate(X(-20.4), 19.6, 1.2);
    // Generator unit
    solid(X(-21.6), X(-19.6), 0, 1.7, 10.6, 12.2, 'metal', { tint: [0.65, 0.5, 0.08] });
    ventUnit(X(-20.6), 1.7, 11.4, 1.2, 0.35, 1.0);
    deco(X(-19.6), X(-19.56), 0.6, 1.3, 10.9, 11.9, 'trim', { tint: [0.1, 0.1, 0.1] });
    deco(X(-19.57), X(-19.54), 1.05, 1.15, 11.0, 11.2, neon);
    // Hanging dome lamps + warm sodium light
    for (const zz of [15.5]) {
      place(cylLow, X(-9), 6.0, zz, 0, 0, 0, 'trim', [0.2, 0.2, 0.2], 0, [1, 1], 0.015, 1.0, 0.015);
      place(sphere, X(-9), 5.45, zz, 0, 0, 0, 'trim', [0.25, 0.26, 0.24], 0, [1, 1], 0.42, 0.2, 0.42);
      deco(X(-9) - 0.3, X(-9) + 0.3, 5.36, 5.4, zz - 0.3, zz + 0.3, 'lampLens');
      const l = new THREE.PointLight(0xffb070, 23, 18, 1.6);
      l.position.set(X(-9), 5.1, zz);
      root.add(l);
      pointLights.push(l);
    }
    place(cylLow, X(-17), 6.0, 15.5, 0, 0, 0, 'trim', [0.2, 0.2, 0.2], 0, [1, 1], 0.015, 1.0, 0.015);
    place(sphere, X(-17), 5.45, 15.5, 0, 0, 0, 'trim', [0.25, 0.26, 0.24], 0, [1, 1], 0.42, 0.2, 0.42);
    deco(X(-17) - 0.3, X(-17) + 0.3, 5.36, 5.4, 15.2, 15.8, 'lampLens');
    // Interior neon accent on the back wall
    deco(X(-21), X(-3), 3.2, 3.28, 21.36, 21.4, neon);
    sign([team === 0 ? 'BAY A' : 'BAY B'], TEAMS[team].css, X(-12), 4.6, 21.34, 3.2, 1.1, Math.PI, 2.0);

    // --- Mid plaza ------------------------------------------------------------------
    // Stairs up to the central platform
    for (let k = 0; k < 3; k++) {
      const x0 = -5.2 + k * 0.4;
      solid(X(x0), X(x0 + 0.4), 0, 0.3 * (k + 1), -1.6, 1.6, 'plate', { tint: [0.8, 0.8, 0.82], skirt: k === 0, radar: false });
      deco(X(x0), X(x0 + 0.06), 0.3 * (k + 1) - 0.06, 0.3 * (k + 1) + 0.002, -1.6, 1.6, 'hazard');
    }
    // Hand rails
    for (const zz of [-1.65, 1.65]) {
      place(cylLow, X(-4.6), 1.35, zz, 0, 0, s * 0.64, 'trim', [0.65, 0.5, 0.08], 0, [1, 1], 0.03, 1.5, 0.03);
      place(cylLow, X(-5.1), 0.6, zz, 0, 0, 0, 'trim', [0.65, 0.5, 0.08], 0, [1, 1], 0.03, 1.2, 0.03);
    }
    // Low concrete cover walls
    solid(X(-13.2), X(-12.6), 0, 1.15, -4.2, -0.8, 'concrete', { tint: [0.8, 0.8, 0.8] });
    deco(X(-13.25), X(-12.55), 1.15, 1.22, -4.25, -0.75, 'hazard');
    // Crate stack
    crate(X(-16.7), 3.1, 1.4);
    crate(X(-16.65), 3.1, 0.9, 1.4, 0.9, 0.35);
    crate(X(-18.1), 3.55, 0.9);
    // Planters with shrubs
    solid(X(-9.6), X(-7.4), 0, 0.8, -5.7, -4.6, 'concrete', { tint: [0.65, 0.64, 0.62] });
    for (let k = 0; k < 5; k++) place(sphere, X(-9.3 + k * 0.42), 0.95 + rng() * 0.1, -5.15 + (rng() - 0.5) * 0.3, 0, rng() * 3, 0, 'rubber', [0.08 + rng() * 0.04, 0.16 + rng() * 0.06, 0.05], 0.8, [1, 1], 0.32, 0.28, 0.32);
    // Barrels near the divider
    barrel(X(-20.6), -4.9, 0, [0.12, 0.35, 0.3]);
    barrel(X(-21.2), -4.35, 0, [0.12, 0.35, 0.3]);
    jersey(X(-20.6), X(-20.6), 1.2, 3.8);
    lampPost(X(-10.5), 5.5, 0, -1, 0xffc58a, 24, s === 1);
    lampPost(X(-10.5), -5.5, 0, 1, 0xffc58a, 24, s === -1);

    // --- North lane: container yard -------------------------------------------
    container(X(-19), X(-13), -17.8, -15.4, 0, team === 0 ? 'corrRed' : 'corrBlue', -s as 1 | -1);
    crate(X(-12.55), -17.25, 0.9);
    crate(X(-12.55), -17.25, 0.9, 0.9, 0.9);
    crate(X(-11.65), -17.25, 0.9);
    container(X(-11), X(-5), -21.25, -18.85, 0, team === 0 ? 'corrTeal' : 'corrOrange', s as 1 | -1);
    container(X(-11), X(-5), -21.25, -18.85, 2.6, team === 0 ? 'corrYellow' : 'corrTeal', -s as 1 | -1);
    jersey(X(-21.6), X(-19.8), -12.2, -12.2);
    jersey(X(-8.4), X(-6.6), -12.6, -12.6);
    barrel(X(-20.7), -17.4, 0, [0.5, 0.1, 0.06]);
    barrel(X(-21.3), -18.0, 0, [0.5, 0.1, 0.06]);
    barrel(X(-20.6), -18.1, 0, [0.15, 0.15, 0.17]);
    lampPost(X(-16), -10.6, 0, -1, 0xffc58a, 20, true);
  }

  // ---------------------------------------------------------------------------
  // Unique center pieces
  // ---------------------------------------------------------------------------
  // North divider center block & warehouse center block
  solid(-2.5, 2.5, 0, 4.5, -10, -6, 'concrete');
  deco(-2.6, 2.6, 4.5, 4.66, -10.1, -5.9, 'trim', { tint: [0.3, 0.3, 0.32] });
  sign(['HARBOR', 'DISTRICT'], '#e8f4ff', 0, 2.8, -5.88, 2.8, 1.4, 0, 1.6);
  solid(-2.5, 2.5, 0, 6.5, 6, 10, 'corrWall', { tint: [0.58, 0.6, 0.62] });
  deco(-2.5, 2.5, 0, 1.0, 5.94, 6, 'concrete', { tint: [0.72, 0.72, 0.72] });
  sign(['WAREHOUSE 07'], '#ffcf8a', 0, 5.0, 5.88, 4.6, 0.8, Math.PI, 2.2);
  sign(['WAREHOUSE 07'], '#ffcf8a', 0, 5.0, 5.88, 4.6, 0.8, 0, 2.2);
  // Central platform
  solid(-4, 4, 0, 1.2, -3, 3, 'concrete', { tint: [0.9, 0.9, 0.9] });
  deco(-4.04, 4.04, 1.12, 1.205, -3.04, -2.96, 'hazard');
  deco(-4.04, 4.04, 1.12, 1.205, 2.96, 3.04, 'hazard');
  deco(-3.9, 3.9, 0.15, 0.2, -3.02, -3.0, 'neonWhite');
  deco(-3.9, 3.9, 0.15, 0.2, 3.0, 3.02, 'neonWhite');
  solid(-2, 2, 1.2, 2.15, -3, -2.72, 'concrete', { tint: [0.75, 0.75, 0.75] });
  solid(-2, 2, 1.2, 2.15, 2.72, 3, 'concrete', { tint: [0.75, 0.75, 0.75] });
  // Signal beacon tower
  solid(-0.55, 0.55, 1.2, 4.6, -0.55, 0.55, 'metal', { tint: [0.2, 0.21, 0.23] });
  for (const yy of [1.8, 2.6, 3.4]) deco(-0.6, 0.6, yy, yy + 0.06, -0.6, 0.6, 'neonWarm');
  deco(-0.7, 0.7, 4.6, 4.75, -0.7, 0.7, 'trim', { tint: [0.15, 0.15, 0.16] });
  const beaconRing = new THREE.Mesh(
    new THREE.TorusGeometry(0.95, 0.035, 8, 48),
    new THREE.MeshBasicMaterial({ color: new THREE.Color(0xffc070).multiplyScalar(2.6) }),
  );
  beaconRing.position.set(0, 5.1, 0);
  root.add(beaconRing);
  const beaconRing2 = beaconRing.clone();
  beaconRing2.scale.setScalar(0.7);
  root.add(beaconRing2);
  animated.push((t) => {
    beaconRing.rotation.set(Math.PI / 2 + Math.sin(t * 0.7) * 0.25, t * 0.9, 0);
    beaconRing2.rotation.set(Math.PI / 2 + Math.cos(t * 0.9) * 0.3, -t * 1.3, 0.4);
    beaconRing.position.y = 5.1 + Math.sin(t * 1.4) * 0.08;
  });
  {
    const l = new THREE.PointLight(0xffb060, 15, 14, 1.7);
    l.position.set(0, 4.2, 0);
    root.add(l);
    pointLights.push(l);
  }
  // North lane center container & warehouse center conveyor
  container(-3, 3, -16, -13.6, 0, 'corrYellow', 1);
  solid(-3.5, 3.5, 0, 1.05, 14.8, 16.0, 'trim', { tint: [0.45, 0.45, 0.42] });
  deco(-3.45, 3.45, 1.05, 1.08, 14.9, 15.9, 'rubber', { tint: [0.05, 0.05, 0.05] });
  for (let x = -3.2; x <= 3.2; x += 0.4) place(cylLow, x, 1.0, 15.4, Math.PI / 2, 0, 0, 'trim', [0.6, 0.6, 0.6], 0, [1, 1], 0.05, 1.05, 0.05);
  deco(-3.5, 3.5, 0.4, 0.46, 14.78, 16.02, 'hazard');
  for (const xx of [-2.2, 0.4, 2.6]) deco(xx - 0.45, xx + 0.45, 1.08, 1.5, 15.05, 15.75, 'wood', { tint: [0.6, 0.45, 0.3], uvScale: 0 });
  // Warehouse center light
  {
    place(sphere, 0, 5.45, 18.2, 0, 0, 0, 'trim', [0.25, 0.26, 0.24], 0, [1, 1], 0.42, 0.2, 0.42);
    deco(-0.3, 0.3, 5.36, 5.4, 17.9, 18.5, 'lampLens');
    const l = new THREE.PointLight(0xffb070, 18, 16, 1.6);
    l.position.set(0, 5.1, 18.2);
    root.add(l);
    pointLights.push(l);
  }

  // Warehouse roof with three skylight openings, plus trusses.
  const roofY0 = 6.5;
  const roofY1 = 6.85;
  solid(-22.6, 22.6, roofY0, roofY1, 6, 10.8, 'metal', { tint: [0.3, 0.31, 0.33], radar: false });
  solid(-22.6, 22.6, roofY0, roofY1, 13.2, 22.4, 'metal', { tint: [0.3, 0.31, 0.33], radar: false });
  const holes: [number, number][] = [
    [-15, -11],
    [-2, 2],
    [11, 15],
  ];
  const roofSegs: [number, number][] = [
    [-22.6, -15],
    [-11, -2],
    [2, 11],
    [15, 22.6],
  ];
  for (const [x0, x1] of roofSegs) solid(x0, x1, roofY0, roofY1, 10.8, 13.2, 'metal', { tint: [0.3, 0.31, 0.33], radar: false });
  for (let x = -20; x <= 20; x += 4) {
    deco(x - 0.08, x + 0.08, 5.9, roofY0, 10, 21.4, 'trim', { tint: [0.3, 0.32, 0.34] });
    deco(x - 0.04, x + 0.04, 5.6, 5.9, 10, 21.4, 'trim', { tint: [0.3, 0.32, 0.34] });
  }
  for (const [x0, x1] of holes) {
    deco(x0 - 0.1, x1 + 0.1, roofY1, roofY1 + 0.2, 10.7, 10.8, 'trim', { tint: [0.2, 0.2, 0.2] });
    deco(x0 - 0.1, x1 + 0.1, roofY1, roofY1 + 0.2, 13.2, 13.3, 'trim', { tint: [0.2, 0.2, 0.2] });
    for (let xx = x0 + 1; xx < x1; xx += 1) deco(xx - 0.03, xx + 0.03, roofY1 - 0.05, roofY1 + 0.02, 10.8, 13.2, 'trim', { tint: [0.2, 0.2, 0.2] });
    // Light shaft volume following the sun direction through the opening.
    const d = SUN_DIR.clone().multiplyScalar(-1);
    const len = (roofY0 - 0.05) / -d.y;
    const off = d.clone().multiplyScalar(len);
    const corners = [
      V(x0, roofY0, 10.8),
      V(x1, roofY0, 10.8),
      V(x1, roofY0, 13.2),
      V(x0, roofY0, 13.2),
    ];
    const pos: number[] = [];
    const ts: number[] = [];
    const idx: number[] = [];
    const quad = (a: THREE.Vector3, bb: THREE.Vector3): void => {
      const base = pos.length / 3;
      const a2 = a.clone().add(off);
      const b2 = bb.clone().add(off);
      pos.push(a.x, a.y, a.z, bb.x, bb.y, bb.z, b2.x, b2.y, b2.z, a2.x, a2.y, a2.z);
      ts.push(0, 0, 1, 1);
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    };
    for (let k = 0; k < 4; k++) quad(corners[k], corners[(k + 1) % 4]);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('aT', new THREE.Float32BufferAttribute(ts, 1));
    g.setIndex(idx);
    g.computeVertexNormals();
    const shaft = new THREE.Mesh(g, lightShaftMaterial(0xffc890, 0.1));
    shaft.renderOrder = 3;
    shaft.frustumCulled = false;
    root.add(shaft);
  }

  // ---------------------------------------------------------------------------
  // Background scenery (non-colliding): harbor water, cranes, ship, skyline
  // ---------------------------------------------------------------------------
  {
    const water = new THREE.Mesh(new THREE.PlaneGeometry(1600, 700), lib.water.material);
    water.rotation.x = -Math.PI / 2;
    water.position.set(0, -1.4, -380);
    root.add(water);
    // quay
    deco(-120, 120, -1.5, 0, -40, -22.4, 'concrete', { tint: [0.5, 0.5, 0.5], uvScale: 8 });
    deco(-120, 120, -1.5, 0.02, 22.4, 120, 'asphalt', { uvScale: 10 });
    deco(-120, -37.4, -1.5, 0.02, -22.4, 22.4, 'asphalt', { uvScale: 10 });
    deco(37.4, 120, -1.5, 0.02, -22.4, 22.4, 'asphalt', { uvScale: 10 });
    deco(-120, 120, -0.1, 0.25, -40.4, -39.8, 'hazard', { uvScale: 2 });

    // Gantry cranes on the quay
    const crane = (cx: number, cz: number, tint: Tint): void => {
      const legH = 32;
      for (const dx of [-5, 5]) for (const dz of [-4, 4]) deco(cx + dx - 0.5, cx + dx + 0.5, 0, legH, cz + dz - 0.5, cz + dz + 0.5, 'metal', { tint, castShadow: false });
      for (const yy of [10, 20]) {
        for (const dz of [-4, 4]) deco(cx - 5.5, cx + 5.5, yy, yy + 0.7, cz + dz - 0.3, cz + dz + 0.3, 'metal', { tint, castShadow: false });
        for (const dx of [-5, 5]) deco(cx + dx - 0.3, cx + dx + 0.3, yy, yy + 0.7, cz - 4.5, cz + 4.5, 'metal', { tint, castShadow: false });
      }
      const armLen = 60;
      deco(cx - 1.2, cx + 1.2, legH, legH + 2.2, cz - armLen * 0.75, cz + armLen * 0.3, 'metal', { tint, castShadow: false });
      deco(cx - 2.5, cx + 2.5, legH + 2.2, legH + 7, cz - 2.5, cz + 2.5, 'metal', { tint: [0.75, 0.75, 0.72], castShadow: false });
      for (let k = 0; k < 10; k++) {
        const zz = cz - armLen * 0.75 + k * 6;
        deco(cx - 1.2, cx + 1.2, legH + 2.2, legH + 2.4, zz, zz + 0.25, 'trim', { tint: [0.1, 0.1, 0.1], castShadow: false });
      }
      deco(cx - 0.05, cx + 0.05, legH - 16, legH, cz - 30, cz - 29.9, 'trim', { tint: [0.1, 0.1, 0.1], castShadow: false });
      deco(cx - 1.4, cx + 1.4, legH - 17, legH - 16, cz - 31.2, cz - 28.8, 'corrBlue', { castShadow: false });
      deco(cx - 0.3, cx + 0.3, legH + 7, legH + 7.3, cz - 0.3, cz + 0.3, 'neonB');
    };
    crane(-46, -32, [0.55, 0.1, 0.06]);
    crane(0, -34, [0.6, 0.45, 0.06]);
    crane(48, -32, [0.55, 0.1, 0.06]);
    // Stacked containers on the quay behind the fence
    const quayColors: MatKey[] = ['corrRed', 'corrBlue', 'corrTeal', 'corrOrange', 'corrYellow'];
    for (let i = 0; i < 26; i++) {
      const x = -70 + i * 5.6 + (rng() - 0.5);
      if (Math.abs(x) < 3) continue;
      const stack = 1 + Math.floor(rng() * 3);
      for (let k = 0; k < stack; k++) {
        const m = quayColors[Math.floor(rng() * quayColors.length)];
        deco(x - 1.2, x + 1.2, k * 2.6, k * 2.6 + 2.55, -31 - 6, -31, m, { uvOffset: [rng(), 0], castShadow: false });
      }
    }
    // Cargo ship silhouette on the water
    deco(-160, -40, -1.5, 9, -150, -128, 'metal', { tint: [0.08, 0.09, 0.11], castShadow: false });
    deco(-150, -138, 9, 24, -146, -132, 'metal', { tint: [0.75, 0.75, 0.72], castShadow: false });
    for (let k = 0; k < 9; k++) deco(-132 + k * 9.5, -124 + k * 9.5, 9, 9 + 2.6 * (1 + (k % 3)), -147, -131, quayColors[k % 5], { castShadow: false });
    deco(-144.2, -143.8, 24, 30, -139.2, -138.8, 'neonB');
    // City skyline behind the base walls (east/west/south)
    const tower = (x: number, z: number, w: number, d: number, h: number): void => {
      deco(x - w / 2, x + w / 2, 0, h, z - d / 2, z + d / 2, 'skyline', { uvOffset: [rng(), rng()], tint: [0.9 + rng() * 0.2, 0.9, 1], castShadow: false });
      if (rng() < 0.5) deco(x - 0.15, x + 0.15, h, h + 6, z - 0.15, z + 0.15, 'neonB');
    };
    for (let i = 0; i < 22; i++) {
      tower(-150 - rng() * 140, -120 + i * 14 + rng() * 6, 14 + rng() * 16, 14 + rng() * 16, 40 + rng() * 110);
      tower(150 + rng() * 140, -120 + i * 14 + rng() * 6, 14 + rng() * 16, 14 + rng() * 16, 40 + rng() * 110);
      tower(-200 + i * 19 + rng() * 6, 140 + rng() * 140, 14 + rng() * 16, 14 + rng() * 16, 40 + rng() * 110);
    }
  }

  // ---------------------------------------------------------------------------
  // Life & detail: string lights, power cables, floor markings, posters
  // ---------------------------------------------------------------------------
  {
    const cableMat: MatKey = 'rubber';
    const catenary = (a: THREE.Vector3, c: THREE.Vector3, sag: number, n = 18): THREE.Vector3[] => {
      const pts: THREE.Vector3[] = [];
      for (let i = 0; i <= n; i++) {
        const t = i / n;
        pts.push(new THREE.Vector3().lerpVectors(a, c, t).add(new THREE.Vector3(0, -sag * 4 * t * (1 - t), 0)));
      }
      return pts;
    };
    const cable = (pts: THREE.Vector3[], r = 0.012): void => {
      const tube = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), pts.length * 2, r, 5, false);
      b.geom(tube, new THREE.Matrix4(), cableMat, [0.05, 0.05, 0.06], 0, [1, 1], false);
    };
    // Festoon lights across the mid plaza (north divider → warehouse front).
    const bulbPositions: THREE.Vector3[] = [];
    for (const x of [-19, -14, -9, 9, 14, 19]) {
      const pts = catenary(new THREE.Vector3(x, 4.55, -6.05), new THREE.Vector3(x + (x < 0 ? 2 : -2), 6.45, 5.95), 1.1, 24);
      cable(pts);
      for (let i = 2; i < pts.length - 1; i += 2) bulbPositions.push(pts[i].clone().add(new THREE.Vector3(0, -0.07, 0)));
    }
    // Diagonal strands over the stairs of the central platform.
    for (const sx of [-1, 1]) {
      const pts = catenary(new THREE.Vector3(sx * 6.5, 4.55, -6.05), new THREE.Vector3(sx * 0.7, 4.7, 0), 0.6, 16);
      cable(pts);
      for (let i = 2; i < pts.length - 1; i += 2) bulbPositions.push(pts[i].clone().add(new THREE.Vector3(0, -0.07, 0)));
    }
    const bulbs = new THREE.InstancedMesh(new THREE.SphereGeometry(0.055, 10, 8), new THREE.MeshBasicMaterial({ color: new THREE.Color(0xffc27a).multiplyScalar(7) }), bulbPositions.length);
    const m = new THREE.Matrix4();
    bulbPositions.forEach((p, i) => bulbs.setMatrixAt(i, m.makeTranslation(p.x, p.y, p.z)));
    bulbs.frustumCulled = false;
    root.add(bulbs);
    // Power cables from the dividers to the harbour fence.
    for (const x of [-20.5, -3.5, 3.5, 20.5]) cable(catenary(new THREE.Vector3(x, 4.5, -10.05), new THREE.Vector3(x * 1.05, 5.0, -21.7), 0.9, 20), 0.018);
    // Cables between the warehouse roof and the office blocks.
    for (const s2 of [1, -1]) cable(catenary(new THREE.Vector3(-22.6 * s2, 6.4, 8), new THREE.Vector3(-28 * s2, 6.2, 7.6), 0.5, 12), 0.016);

    // Floor markings
    const floorText = (text: string, x: number, z: number, w: number, h: number, rot: number, color: string, alpha = 0.55): void => {
      const tex = textTexture([text], color, 512, Math.round((512 * h) / w), 'Rajdhani', 700, false);
      const mat = new THREE.MeshStandardMaterial({ map: tex, transparent: true, opacity: alpha, roughness: 0.8, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
      mesh.rotation.set(-Math.PI / 2, 0, rot);
      mesh.position.set(x, 0.012, z);
      mesh.receiveShadow = true;
      mesh.renderOrder = 1;
      root.add(mesh);
    };
    floorText('07', 0, 11.9, 3.2, 2.0, Math.PI, '#e0b04a', 0.5);
    for (const s2 of [1, -1]) {
      const team: TeamId = s2 === 1 ? 0 : 1;
      floorText(team === 0 ? 'BAY A' : 'BAY B', -15 * s2, 15.5, 3.4, 1.1, s2 === 1 ? -Math.PI / 2 : Math.PI / 2, '#e0b04a', 0.45);
      floorText('LANE 1', -14 * s2, -12.0, 2.6, 0.8, s2 === 1 ? -Math.PI / 2 : Math.PI / 2, '#d8dde0', 0.4);
      floorText('▲', -25 * s2, -6.5, 1.4, 1.4, 0, TEAMS[team].css, 0.45);
      floorText('▼', -25 * s2, 6.5, 1.4, 1.4, 0, TEAMS[team].css, 0.45);
      floorText(team === 0 ? 'ALPHA' : 'BRAVO', -26.2 * s2, 0, 2.6, 0.8, s2 === 1 ? -Math.PI / 2 : Math.PI / 2, TEAMS[team].css, 0.4);
      // hazard boxes in front of the roller doors
      b.floorQuad(-28.05 * s2 - (s2 === 1 ? 0 : 1.6), -17, -28.05 * s2 + (s2 === 1 ? 1.6 : 0), -13, 0.005, 'hazard', [0, 0, 1.6, 4]);
      b.floorQuad(-28.05 * s2 - (s2 === 1 ? 0 : 1.6), 13, -28.05 * s2 + (s2 === 1 ? 1.6 : 0), 17, 0.005, 'hazard', [0, 0, 1.6, 4]);
    }

    // Posters / safety signs on walls
    const poster = (x: number, y: number, z: number, ry: number, w: number, h: number, draw: (ctx: CanvasRenderingContext2D, W: number, H: number) => void): void => {
      const c = document.createElement('canvas');
      c.width = 256;
      c.height = Math.round((256 * h) / w);
      const ctx = c.getContext('2d')!;
      draw(ctx, c.width, c.height);
      // weathering
      for (let i = 0; i < 400; i++) {
        ctx.fillStyle = `rgba(40,30,20,${Math.random() * 0.12})`;
        ctx.fillRect(Math.random() * c.width, Math.random() * c.height, 1 + Math.random() * 3, 1 + Math.random() * 3);
      }
      const tex = new THREE.CanvasTexture(c);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 4;
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.85, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
      mesh.position.set(x, y, z);
      mesh.rotation.y = ry;
      mesh.receiveShadow = true;
      root.add(mesh);
    };
    const safety = (ctx: CanvasRenderingContext2D, W: number, H: number): void => {
      ctx.fillStyle = '#e8e4d8';
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = '#1d6f42';
      ctx.fillRect(0, 0, W, H * 0.3);
      ctx.fillStyle = '#fff';
      ctx.font = `700 ${H * 0.16}px Rajdhani, sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillText('SAFETY FIRST', W / 2, H * 0.21);
      ctx.fillStyle = '#222';
      ctx.font = `600 ${H * 0.09}px Rajdhani, sans-serif`;
      ['HARD HAT AREA', 'NO STANDING', 'UNDER CRANES'].forEach((t, i) => ctx.fillText(t, W / 2, H * (0.45 + i * 0.15)));
    };
    const logo = (ctx: CanvasRenderingContext2D, W: number, H: number): void => {
      const g = ctx.createLinearGradient(0, 0, W, H);
      g.addColorStop(0, '#1b2433');
      g.addColorStop(1, '#3b1f2b');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = '#ff9a4c';
      ctx.beginPath();
      ctx.arc(W * 0.5, H * 0.38, H * 0.18, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#1b2433';
      ctx.fillRect(0, H * 0.4, W, H * 0.03);
      ctx.fillRect(0, H * 0.46, W, H * 0.02);
      ctx.fillStyle = '#f2efe6';
      ctx.font = `700 ${H * 0.12}px Rajdhani, sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillText('DUSK LOGISTICS', W / 2, H * 0.75);
      ctx.font = `500 ${H * 0.06}px Rajdhani, sans-serif`;
      ctx.fillStyle = '#c9b8a0';
      ctx.fillText('PORT OF ARRIVAL · SINCE 2049', W / 2, H * 0.86);
    };
    for (const s2 of [1, -1]) {
      poster(-21.4 * s2, 2.0, -10.13, Math.PI, 1.2, 1.6, safety);
      poster(-20.9 * s2, 2.3, -5.92, 0, 1.6, 1.0, logo);
      poster(-21.97 * s2, 2.2, 19.3, s2 === 1 ? Math.PI / 2 : -Math.PI / 2, 1.2, 1.6, safety);
    }
  }

  const levelMeshes = b.build();
  root.add(levelMeshes);

  // ---------------------------------------------------------------------------
  // Gameplay data
  // ---------------------------------------------------------------------------
  const spawns: Record<TeamId, SpawnPoint[]> = {
    0: [
      { pos: V(-33.5, 0, -2.4), yaw: -Math.PI / 2 },
      { pos: V(-33.5, 0, 2.4), yaw: -Math.PI / 2 },
    ],
    1: [
      { pos: V(33.5, 0, 2.4), yaw: Math.PI / 2 },
      { pos: V(33.5, 0, -2.4), yaw: Math.PI / 2 },
    ],
  };

  const westCoins: [number, number, number][] = [
    [-16, 2.6, -16.6],
    [-8, 0, -14.6],
    [-25, 0, -14.8],
    [-14.4, 0, -2.5],
    [-15, 0, 15.5],
    [-6.2, 0, 19.8],
    [-25, 0, 13.5],
    [-19.5, 0, -0.2],
  ];
  const coinSpots: CoinSpot[] = [];
  let cid = 1;
  westCoins.forEach(([x, y, z], i) => {
    coinSpots.push({ id: cid++, pos: V(x, y + 0.55, z), pair: i });
    coinSpots.push({ id: cid++, pos: V(-x, y + 0.55, z), pair: i });
  });
  coinSpots.push({ id: cid++, pos: V(0, 0.55, -18.4), pair: 100 });
  coinSpots.push({ id: cid++, pos: V(0, 0.55, 12.6), pair: 101 });
  const bigCoinSpots = [V(0, 1.2 + 0.75, 1.8), V(0, 1.2 + 0.75, -1.8)];

  const westNodes: [number, number, number][] = [
    [-33, 0, 0],
    [-29, 0, 0],
    [-26, 0, -4.8],
    [-26, 0, 4.8],
    [-25.6, 0, -11],
    [-25, 0, -16.5],
    [-24.8, 0, -20],
    [-25.4, 0, 11],
    [-25, 0, 15.2],
    [-25, 0, 19.5],
    [-21, 0, -15],
    [-16, 0, -19.6],
    [-16, 0, -13],
    [-10, 0, -14],
    [-12, 0, -11.3],
    [-4.8, 0, -12],
    [-4.8, 0, -8],
    [-4.8, 0, -4.5],
    [-20, 0, 0],
    [-15, 0, 0.4],
    [-10.5, 0, -2.6],
    [-10.5, 0, 3],
    [-6.4, 0, 0],
    [-2.6, 1.2, 0],
    [-4.8, 0, 4.5],
    [-4.8, 0, 8],
    [-4.8, 0, 11.6],
    [-20.4, 0, 15.3],
    [-15, 0, 15.5],
    [-10, 0, 11.6],
    [-10, 0, 20],
    [-5, 0, 16.8],
    [-15, 0, 11.3],
    [-15, 0, 19.8],
    [-19, 0, 4.6],
    [-19, 0, -4],
    [-8.2, 0, -16.8],
  ];
  const navNodes: THREE.Vector3[] = [];
  for (const [x, y, z] of westNodes) {
    navNodes.push(V(x, y, z));
    navNodes.push(V(-x, y, z));
  }
  navNodes.push(V(0, 0, -11.6), V(0, 0, -18.2), V(0, 1.2, 1.8), V(0, 1.2, -1.8), V(0, 0, 12.8), V(0, 0, 18.6), V(0, 0, 4.4), V(0, 0, -4.4));

  // Shooting range down the warehouse (firing spot by the west wall, looking east). Every
  // target sits on its own sight line: through the gap between the pallet racks (z 13.6–17.4)
  // and past the conveyor (z 14.8–16.0, pallets to 1.5 m), so none hides another; two stand
  // on the rack tops (3 m) for vertical aim.
  const faceWest = Math.PI / 2;
  const target = (name: string, x: number, y: number, z: number, strafe = 0, crouch = false): RangeTarget => ({ name, pos: V(x, y, z), yaw: faceWest, strafe, crouch });
  const range = {
    spawn: { pos: V(-20.5, 0, 15.5), yaw: -Math.PI / 2 },
    targets: [
      target('고지대 표적 6m', -14.5, 3.0, 13.1),
      target('표적 10m · 앉기', -10.5, 0, 16.6, 0, true),
      target('이동 표적 15m', -5.0, 0, 13.4, 0.6),
      target('표적 26m', 5.5, 0, 16.9),
      target('이동 표적 30m', 9.5, 0, 13.9, 0.5),
      target('고지대 표적 36m', 15, 3.0, 17.9),
      target('저격 표적 41m', 20.8, 0, 16.8),
    ],
  };

  const setSpawnBarriers = (active: boolean): void => {
    for (const t of [0, 1] as TeamId[]) for (const bx of spawnBarrierBoxes[t]) bx.enabled = active;
    for (const m of spawnBarrierMeshes) m.visible = active;
  };

  return {
    name: 'Harbor District',
    world,
    root,
    spawns,
    coinSpots,
    bigCoinSpots,
    navNodes,
    radar,
    bounds: { minX: -36.4, maxX: 36.4, minZ: -21.3, maxZ: 21.4 },
    range,
    pointLights,
    setSpawnBarriers,
    update(time: number, dt: number) {
      globalTime.value = time;
      for (const a of animated) a(time, dt);
    },
  };
}

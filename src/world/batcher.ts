import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { MatKey, MaterialLibrary } from '../render/materials';

export type Tint = number | [number, number, number];

export interface BoxOpts {
  tint?: Tint;
  /** Override the material's world UV scale (meters per repeat). 0 = face UVs. */
  uvScale?: number;
  /** Height the box stands on (for contact AO). Defaults to its min y. */
  aoBase?: number;
  /** Skip faces: bitmask px=1 nx=2 py=4 ny=8 pz=16 nz=32. */
  skip?: number;
  /** UV offset in repeats, useful to de-correlate repeated props. */
  uvOffset?: [number, number];
  castShadow?: boolean;
}

interface Bucket {
  geoms: THREE.BufferGeometry[];
  noShadow: THREE.BufferGeometry[];
}

const FACE_DIRS: { n: [number, number, number]; u: [number, number, number]; v: [number, number, number]; bit: number }[] = [
  { n: [1, 0, 0], u: [0, 0, -1], v: [0, 1, 0], bit: 1 },
  { n: [-1, 0, 0], u: [0, 0, 1], v: [0, 1, 0], bit: 2 },
  { n: [0, 1, 0], u: [1, 0, 0], v: [0, 0, -1], bit: 4 },
  { n: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1], bit: 8 },
  { n: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0], bit: 16 },
  { n: [0, 0, -1], u: [-1, 0, 0], v: [0, 1, 0], bit: 32 },
];

const tmpColor = new THREE.Color();

function tintToLinear(t: Tint | undefined): [number, number, number] {
  if (t === undefined) return [1, 1, 1];
  if (Array.isArray(t)) return t;
  tmpColor.setHex(t);
  return [tmpColor.r, tmpColor.g, tmpColor.b];
}

/**
 * Accumulates static level geometry and merges it into one mesh per material,
 * which keeps the draw-call count (and shadow pass cost) low.
 */
export class Batcher {
  private buckets = new Map<MatKey, Bucket>();

  constructor(private readonly lib: MaterialLibrary) {}

  private bucket(k: MatKey): Bucket {
    let b = this.buckets.get(k);
    if (!b) {
      b = { geoms: [], noShadow: [] };
      this.buckets.set(k, b);
    }
    return b;
  }

  /** Axis-aligned box from min/max corners, with world-space or per-face UVs. */
  box(min: THREE.Vector3Like, max: THREE.Vector3Like, mat: MatKey, opts: BoxOpts = {}): void {
    const info = this.lib[mat];
    const scale = opts.uvScale ?? info.uvScale;
    const [r, g, b] = tintToLinear(opts.tint);
    const aoBase = opts.aoBase ?? min.y;
    const positions: number[] = [];
    const normals: number[] = [];
    const uvs: number[] = [];
    const colors: number[] = [];
    const aos: number[] = [];
    const index: number[] = [];
    const cx = (min.x + max.x) / 2;
    const cy = (min.y + max.y) / 2;
    const cz = (min.z + max.z) / 2;
    const hx = (max.x - min.x) / 2;
    const hy = (max.y - min.y) / 2;
    const hz = (max.z - min.z) / 2;
    const [ou, ov] = opts.uvOffset ?? [0, 0];
    for (const f of FACE_DIRS) {
      if (opts.skip && opts.skip & f.bit) continue;
      const base = positions.length / 3;
      for (let k = 0; k < 4; k++) {
        const su = k === 0 || k === 3 ? -1 : 1;
        const sv = k < 2 ? -1 : 1;
        const px = cx + f.n[0] * hx + f.u[0] * su * hx + f.v[0] * sv * hx;
        const py = cy + f.n[1] * hy + f.u[1] * su * hy + f.v[1] * sv * hy;
        const pz = cz + f.n[2] * hz + f.u[2] * su * hz + f.v[2] * sv * hz;
        positions.push(px, py, pz);
        normals.push(f.n[0], f.n[1], f.n[2]);
        if (scale > 0) {
          // World-planar mapping keeps texel density constant and seams aligned.
          const u = (px * f.u[0] + py * f.u[1] + pz * f.u[2]) / scale;
          const v = (px * f.v[0] + py * f.v[1] + pz * f.v[2]) / scale;
          uvs.push(u + ou, v + ov);
        } else {
          uvs.push(su > 0 ? 1 : 0, sv > 0 ? 1 : 0);
        }
        colors.push(r, g, b);
        aos.push(aoBase);
      }
      index.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geo.setAttribute('aoBase', new THREE.Float32BufferAttribute(aos, 1));
    geo.setIndex(index);
    this.push(mat, geo, opts.castShadow ?? info.castShadow);
  }

  /** Box from center + size convenience. */
  boxC(cx: number, cy: number, cz: number, sx: number, sy: number, sz: number, mat: MatKey, opts: BoxOpts = {}): void {
    this.box({ x: cx - sx / 2, y: cy - sy / 2, z: cz - sz / 2 }, { x: cx + sx / 2, y: cy + sy / 2, z: cz + sz / 2 }, mat, opts);
  }

  /** Arbitrary geometry (cloned & transformed). UVs are multiplied by `uvRepeat`. */
  geom(src: THREE.BufferGeometry, matrix: THREE.Matrix4, mat: MatKey, tint?: Tint, aoBase = 0, uvRepeat: [number, number] = [1, 1], castShadow?: boolean): void {
    const geo = src.clone();
    if (geo.index === null) {
      // mergeGeometries requires consistent indexing; build a trivial index.
      const count = geo.getAttribute('position').count;
      const idx: number[] = [];
      for (let i = 0; i < count; i++) idx.push(i);
      geo.setIndex(idx);
    }
    geo.applyMatrix4(matrix);
    for (const name of Object.keys(geo.attributes)) {
      if (!['position', 'normal', 'uv'].includes(name)) geo.deleteAttribute(name);
    }
    if (!geo.getAttribute('normal')) geo.computeVertexNormals();
    const count = geo.getAttribute('position').count;
    const uv = geo.getAttribute('uv') as THREE.BufferAttribute | undefined;
    if (uv) {
      for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * uvRepeat[0], uv.getY(i) * uvRepeat[1]);
    } else {
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(count * 2), 2));
    }
    const [r, g, b] = tintToLinear(tint);
    const colors = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      colors[i * 3] = r;
      colors[i * 3 + 1] = g;
      colors[i * 3 + 2] = b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.setAttribute('aoBase', new THREE.BufferAttribute(new Float32Array(count).fill(aoBase), 1));
    this.push(mat, geo, castShadow ?? this.lib[mat].castShadow);
  }

  /** Flat quad on a horizontal plane (decals, markings). Corners in XZ, at height y. */
  floorQuad(x0: number, z0: number, x1: number, z1: number, y: number, mat: MatKey, uv: [number, number, number, number] = [0, 0, 1, 1], tint?: Tint): void {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([x0, y, z1, x1, y, z1, x1, y, z0, x0, y, z0], 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0], 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute([uv[0], uv[1], uv[2], uv[1], uv[2], uv[3], uv[0], uv[3]], 2));
    const [r, g, b] = tintToLinear(tint);
    geo.setAttribute('color', new THREE.Float32BufferAttribute([r, g, b, r, g, b, r, g, b, r, g, b], 3));
    geo.setAttribute('aoBase', new THREE.Float32BufferAttribute([0, 0, 0, 0], 1));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    this.push(mat, geo, false);
  }

  /**
   * Soft contact shadow strips on the floor around a box footprint — cheap,
   * baked-looking ambient occlusion where walls meet the ground.
   */
  aoSkirt(min: THREE.Vector3Like, max: THREE.Vector3Like, width = 0.75): void {
    const y = min.y + 0.012;
    const w = width;
    // Inner edge (against the wall) samples the dark end of the gradient (v = 1).
    const uvs = [0, 1, 0, 0, 1, 0, 1, 1];
    const quad = (pts: number[]): void => {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
      geo.setAttribute('normal', new THREE.Float32BufferAttribute([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0], 3));
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
      geo.setAttribute('color', new THREE.Float32BufferAttribute(new Array(12).fill(1), 3));
      geo.setAttribute('aoBase', new THREE.Float32BufferAttribute([0, 0, 0, 0], 1));
      geo.setIndex([0, 1, 2, 0, 2, 3]);
      this.push('aoStrip', geo, false);
    };
    quad([max.x, y, min.z, max.x + w, y, min.z, max.x + w, y, max.z, max.x, y, max.z]);
    quad([min.x, y, min.z, min.x - w, y, min.z, min.x - w, y, max.z, min.x, y, max.z]);
    quad([min.x, y, max.z, min.x, y, max.z + w, max.x, y, max.z + w, max.x, y, max.z]);
    quad([min.x, y, min.z, min.x, y, min.z - w, max.x, y, min.z - w, max.x, y, min.z]);
  }

  private push(mat: MatKey, geo: THREE.BufferGeometry, cast: boolean): void {
    const b = this.bucket(mat);
    (cast ? b.geoms : b.noShadow).push(geo);
  }

  build(): THREE.Group {
    const group = new THREE.Group();
    group.name = 'static-level';
    for (const [key, bucket] of this.buckets) {
      const info = this.lib[key];
      for (const [list, cast] of [
        [bucket.geoms, true],
        [bucket.noShadow, false],
      ] as const) {
        if (list.length === 0) continue;
        const merged = mergeGeometries(list, false);
        if (!merged) continue;
        merged.computeBoundingSphere();
        merged.computeBoundingBox();
        const mesh = new THREE.Mesh(merged, info.material);
        mesh.castShadow = cast && info.castShadow;
        mesh.receiveShadow = info.receiveShadow;
        mesh.matrixAutoUpdate = false;
        mesh.name = `level-${key}`;
        if (key === 'aoStrip' || key === 'puddle' || key.startsWith('paint')) mesh.renderOrder = 1;
        group.add(mesh);
        list.forEach((g) => g.dispose());
      }
    }
    this.buckets.clear();
    return group;
  }
}

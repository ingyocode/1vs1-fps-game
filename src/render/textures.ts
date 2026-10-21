import * as THREE from 'three';
import { mulberry32 } from '../core/utils';

/**
 * Procedural PBR texture generation. Everything is generated at load time so the
 * game ships with zero binary assets and no CDN cost. Each set provides an
 * albedo map, a tangent-space normal map and a packed ORM map
 * (R = ambient occlusion, G = roughness, B = metalness) which three.js reads
 * through aoMap / roughnessMap / metalnessMap simultaneously.
 */

export interface PBRSet {
  map: THREE.Texture;
  normalMap: THREE.Texture;
  orm: THREE.Texture;
}

// -----------------------------------------------------------------------------
// Tileable noise
// -----------------------------------------------------------------------------

function hash2(x: number, y: number, seed: number): number {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(seed, 1442695041)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967295;
}

class TileNoise {
  constructor(private readonly seed: number) {}

  /**
   * Seamless fBM over texture coordinates u,v ∈ [0,1). Returns roughly [0,1].
   * Separate X/Y frequencies allow anisotropic (streaky) noise that still tiles,
   * because every octave's lattice period equals its integer frequency.
   */
  fbm(u: number, v: number, baseFreq: number, octaves: number, gain = 0.5, freqY = baseFreq): number {
    let sum = 0;
    let amp = 0.5;
    let norm = 0;
    let fx = baseFreq;
    let fy = freqY;
    for (let o = 0; o < octaves; o++) {
      sum += amp * this.value(u * fx, v * fy, fx, fy, this.seed + o * 101);
      norm += amp;
      amp *= gain;
      fx *= 2;
      fy *= 2;
    }
    return sum / norm;
  }

  private value(x: number, y: number, px: number, py: number, seed: number): number {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const xf = x - xi;
    const yf = y - yi;
    const x0 = ((xi % px) + px) % px;
    const y0 = ((yi % py) + py) % py;
    const x1 = (x0 + 1) % px;
    const y1 = (y0 + 1) % py;
    const a = hash2(x0, y0, seed);
    const b = hash2(x1, y0, seed);
    const c = hash2(x0, y1, seed);
    const d = hash2(x1, y1, seed);
    const u = xf * xf * xf * (xf * (xf * 6 - 15) + 10);
    const v = yf * yf * yf * (yf * (yf * 6 - 15) + 10);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  }
}

/** Tileable cellular (Worley F1) noise, returns distance to nearest feature point in cell units. */
function worley(u: number, v: number, cells: number, seed: number): number {
  const x = u * cells;
  const y = v * cells;
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  let best = 9;
  for (let oy = -1; oy <= 1; oy++) {
    for (let ox = -1; ox <= 1; ox++) {
      const cx = xi + ox;
      const cy = yi + oy;
      const wx = ((cx % cells) + cells) % cells;
      const wy = ((cy % cells) + cells) % cells;
      const fx = cx + hash2(wx, wy, seed);
      const fy = cy + hash2(wx, wy, seed + 7);
      const dx = fx - x;
      const dy = fy - y;
      const d = dx * dx + dy * dy;
      if (d < best) best = d;
    }
  }
  return Math.sqrt(best);
}

// -----------------------------------------------------------------------------
// Buffers
// -----------------------------------------------------------------------------

class Layer {
  readonly data: Float32Array;
  constructor(
    readonly size: number,
    fill = 0,
  ) {
    this.data = new Float32Array(size * size).fill(fill);
  }

  idx(x: number, y: number): number {
    const s = this.size;
    return (((y % s) + s) % s) * s + (((x % s) + s) % s);
  }

  get(x: number, y: number): number {
    return this.data[this.idx(x, y)];
  }

  /** Soft-edged disc (wrapping). mode: 'add' | 'min' | 'max' | 'set' */
  disc(cx: number, cy: number, r: number, value: number, soft = 1, mode: 'add' | 'min' | 'max' | 'set' = 'add'): void {
    const r2 = r + soft;
    for (let y = Math.floor(cy - r2); y <= Math.ceil(cy + r2); y++) {
      for (let x = Math.floor(cx - r2); x <= Math.ceil(cx + r2); x++) {
        const d = Math.hypot(x - cx, y - cy);
        if (d > r2) continue;
        const k = d <= r ? 1 : 1 - (d - r) / soft;
        this.apply(this.idx(x, y), value * k, mode, k);
      }
    }
  }

  rect(x0: number, y0: number, w: number, h: number, value: number, mode: 'add' | 'min' | 'max' | 'set' = 'set'): void {
    for (let y = Math.floor(y0); y < Math.floor(y0 + h); y++) {
      for (let x = Math.floor(x0); x < Math.floor(x0 + w); x++) this.apply(this.idx(x, y), value, mode, 1);
    }
  }

  line(x0: number, y0: number, x1: number, y1: number, width: number, value: number, mode: 'add' | 'min' | 'max' | 'set' = 'add'): void {
    const len = Math.hypot(x1 - x0, y1 - y0);
    const steps = Math.max(1, Math.ceil(len));
    const hw = width / 2;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const cx = x0 + (x1 - x0) * t;
      const cy = y0 + (y1 - y0) * t;
      for (let y = Math.floor(cy - hw - 1); y <= Math.ceil(cy + hw + 1); y++) {
        for (let x = Math.floor(cx - hw - 1); x <= Math.ceil(cx + hw + 1); x++) {
          const d = Math.hypot(x - cx, y - cy);
          if (d > hw + 1) continue;
          const k = d <= hw ? 1 : 1 - (d - hw);
          const i2 = this.idx(x, y);
          if (mode === 'add') {
            // avoid accumulating overlapping stamps along the line
            if (k > (this.stamp[i2] ?? 0)) {
              this.data[i2] += value * (k - (this.stamp[i2] ?? 0));
              this.stamp[i2] = k;
            }
          } else this.apply(i2, value * k, mode, k);
        }
      }
    }
    this.stamp = {};
  }

  private stamp: Record<number, number> = {};

  private apply(i: number, v: number, mode: 'add' | 'min' | 'max' | 'set', k: number): void {
    const d = this.data;
    if (mode === 'add') d[i] += v;
    else if (mode === 'min') d[i] = Math.min(d[i], d[i] * (1 - k) + v);
    else if (mode === 'max') d[i] = Math.max(d[i], v);
    else d[i] = d[i] * (1 - k) + (v / (k || 1)) * k;
  }

  blur(radius: number): Layer {
    const s = this.size;
    const tmp = new Float32Array(s * s);
    const out = new Layer(s);
    const r = Math.max(1, Math.round(radius));
    const inv = 1 / (r * 2 + 1);
    for (let y = 0; y < s; y++) {
      let acc = 0;
      for (let k = -r; k <= r; k++) acc += this.data[y * s + ((k + s) % s)];
      for (let x = 0; x < s; x++) {
        tmp[y * s + x] = acc * inv;
        acc += this.data[y * s + ((x + r + 1) % s)] - this.data[y * s + ((x - r + s) % s)];
      }
    }
    for (let x = 0; x < s; x++) {
      let acc = 0;
      for (let k = -r; k <= r; k++) acc += tmp[((k + s) % s) * s + x];
      for (let y = 0; y < s; y++) {
        out.data[y * s + x] = acc * inv;
        acc += tmp[((y + r + 1) % s) * s + x] - tmp[((y - r + s) % s) * s + x];
      }
    }
    return out;
  }
}

class ColorLayer {
  readonly r: Float32Array;
  readonly g: Float32Array;
  readonly b: Float32Array;
  constructor(
    readonly size: number,
    c: [number, number, number],
  ) {
    const n = size * size;
    this.r = new Float32Array(n).fill(c[0]);
    this.g = new Float32Array(n).fill(c[1]);
    this.b = new Float32Array(n).fill(c[2]);
  }

  mix(i: number, c: [number, number, number], t: number): void {
    if (t <= 0) return;
    if (t > 1) t = 1;
    this.r[i] += (c[0] - this.r[i]) * t;
    this.g[i] += (c[1] - this.g[i]) * t;
    this.b[i] += (c[2] - this.b[i]) * t;
  }

  mul(i: number, k: number): void {
    this.r[i] *= k;
    this.g[i] *= k;
    this.b[i] *= k;
  }
}

function fillBytes(size: number, fill: (i: number, out: Uint8Array, o: number) => void): Uint8Array {
  const data = new Uint8Array(size * size * 4);
  for (let i = 0, o = 0; i < size * size; i++, o += 4) {
    fill(i, data, o);
    data[o + 3] = 255;
  }
  return data;
}

function dataTexture(data: Uint8Array, size: number, srgb: boolean): THREE.DataTexture {
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

function toTexture(size: number, fill: (i: number, out: Uint8Array, o: number) => void, srgb: boolean): THREE.DataTexture {
  return dataTexture(fillBytes(size, fill), size, srgb);
}

/** Raw RGBA8 buffers for one PBR set (transferable between workers). */
export interface PBRRaw {
  size: number;
  map: Uint8Array;
  normal: Uint8Array;
  orm: Uint8Array;
}

export function wrapPBR(raw: PBRRaw): PBRSet {
  return { map: dataTexture(raw.map, raw.size, true), normalMap: dataTexture(raw.normal, raw.size, false), orm: dataTexture(raw.orm, raw.size, false) };
}

const to8 = (v: number): number => (v <= 0 ? 0 : v >= 1 ? 255 : Math.round(v * 255));
const toSRGB8 = (v: number): number => to8(v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);

function finalize(size: number, color: ColorLayer, height: Layer, rough: Layer, metal: Layer | number, normalStrength: number, aoStrength = 1.4): PBRRaw {
  // Normal map from height (Sobel).
  const h = height.data;
  const s = size;
  const normal = fillBytes(
    size,
    (i, out, o) => {
      const x = i % s;
      const y = (i / s) | 0;
      const xl = (x - 1 + s) % s;
      const xr = (x + 1) % s;
      const yu = (y - 1 + s) % s;
      const yd = (y + 1) % s;
      const tl = h[yu * s + xl];
      const t = h[yu * s + x];
      const tr = h[yu * s + xr];
      const l = h[y * s + xl];
      const r = h[y * s + xr];
      const bl = h[yd * s + xl];
      const b = h[yd * s + x];
      const br = h[yd * s + xr];
      const dx = (tr + 2 * r + br - (tl + 2 * l + bl)) * normalStrength;
      const dy = (bl + 2 * b + br - (tl + 2 * t + tr)) * normalStrength;
      const nx = -dx;
      const ny = dy;
      const nz = 1;
      const len = Math.hypot(nx, ny, nz);
      out[o] = to8((nx / len) * 0.5 + 0.5);
      out[o + 1] = to8((ny / len) * 0.5 + 0.5);
      out[o + 2] = to8((nz / len) * 0.5 + 0.5);
    },
  );
  // Cavity AO: compare to blurred height.
  const blurred = height.blur(Math.max(2, size / 128));
  const orm = fillBytes(
    size,
    (i, out, o) => {
      const cav = Math.min(0, h[i] - blurred.data[i]);
      out[o] = to8(1 + cav * aoStrength * 2.2);
      out[o + 1] = to8(rough.data[i]);
      out[o + 2] = to8(typeof metal === 'number' ? metal : metal.data[i]);
    },
  );
  const map = fillBytes(
    size,
    (i, out, o) => {
      out[o] = toSRGB8(color.r[i]);
      out[o + 1] = toSRGB8(color.g[i]);
      out[o + 2] = toSRGB8(color.b[i]);
    },
  );
  return { size, map, normal, orm };
}

// -----------------------------------------------------------------------------
// Material recipes
// -----------------------------------------------------------------------------

export function concreteWall(size = 1024, seed = 11): PBRRaw {
  const n = new TileNoise(seed);
  const rnd = mulberry32(seed);
  const height = new Layer(size);
  const rough = new Layer(size, 0.88);
  const color = new ColorLayer(size, [0.42, 0.415, 0.4]);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const u = x / size;
      const v = y / size;
      const big = n.fbm(u, v, 3, 5);
      const fine = n.fbm(u, v, 48, 3);
      const streak = n.fbm(u, v, 24, 4, 0.5, 2);
      height.data[i] = big * 0.4 + fine * 0.18;
      const k = 0.82 + big * 0.32 + (fine - 0.5) * 0.12;
      color.mul(i, k);
      // water streaks running down the wall
      const st = Math.max(0, streak - 0.55) * 2.2;
      color.mul(i, 1 - st * 0.35);
      // warm/cool tint drift
      const tint = n.fbm(u, v, 2, 3) - 0.5;
      color.r[i] *= 1 + tint * 0.08;
      color.b[i] *= 1 - tint * 0.08;
      rough.data[i] = 0.8 + fine * 0.15 - st * 0.1;
    }
  }
  // Formwork panel seams every half tile + tie holes.
  const seamDepth = -0.55;
  for (const p of [0, 0.5]) {
    height.line(0, p * size, size, p * size, 3, seamDepth, 'add');
    height.line(p * size, 0, p * size, size, 3, seamDepth, 'add');
  }
  for (let gy = 0; gy < 4; gy++) {
    for (let gx = 0; gx < 4; gx++) {
      const cx = (gx + 0.5) * (size / 4);
      const cy = (gy + 0.5) * (size / 4);
      height.disc(cx, cy, size / 220, -0.7, 2);
      for (let yy = -4; yy <= 4; yy++) for (let xx = -4; xx <= 4; xx++) {
        const i = height.idx(Math.round(cx + xx), Math.round(cy + yy));
        if (Math.hypot(xx, yy) < 4) color.mul(i, 0.7);
      }
    }
  }
  // Small air pockets typical of cast concrete
  for (let i = 0; i < size * 0.18; i++) {
    const cx = rnd() * size;
    const cy = rnd() * size;
    height.disc(cx, cy, rnd() * 1.2 + 0.3, -0.12, 1);
  }
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const i = y * size + x;
    if (height.data[i] < 0.05) color.mul(i, 0.8 + Math.max(-0.2, height.data[i]) * 0.2 + 0.2);
  }
  return finalize(size, color, height, rough, 0, 2.2);
}

export function concreteFloor(size = 1024, seed = 23, base: [number, number, number] = [0.36, 0.35, 0.33]): PBRRaw {
  const n = new TileNoise(seed);
  const rnd = mulberry32(seed);
  const height = new Layer(size);
  const rough = new Layer(size, 0.85);
  const color = new ColorLayer(size, base);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const u = x / size;
      const v = y / size;
      const big = n.fbm(u, v, 2, 5);
      const mid = n.fbm(u, v, 12, 4);
      const fine = n.fbm(u, v, 96, 2);
      height.data[i] = mid * 0.25 + fine * 0.25;
      color.mul(i, 0.78 + big * 0.4 + (fine - 0.5) * 0.18);
      // oil / water stains with sheen
      const stain = Math.max(0, n.fbm(u + 0.37, v + 0.11, 3, 4) - 0.58) * 3.2;
      color.mul(i, 1 - Math.min(0.5, stain * 0.45));
      rough.data[i] = 0.86 - stain * 0.35 + (fine - 0.5) * 0.1;
      // aggregate specks
      const w = worley(u, v, 160, seed);
      if (w < 0.18) {
        color.mul(i, 1.12);
        height.data[i] += 0.08;
      }
    }
  }
  // Slab joints (2x2 slabs per tile).
  for (const p of [0, 0.5]) {
    height.line(0, p * size, size, p * size, 4, -0.8, 'add');
    height.line(p * size, 0, p * size, size, 4, -0.8, 'add');
  }
  // Cracks: random walks.
  for (let c = 0; c < 9; c++) {
    let x = rnd() * size;
    let y = rnd() * size;
    let a = rnd() * Math.PI * 2;
    const len = 30 + rnd() * 90;
    for (let s = 0; s < len; s++) {
      a += (rnd() - 0.5) * 0.9;
      const nx = x + Math.cos(a) * 3;
      const ny = y + Math.sin(a) * 3;
      height.line(x, y, nx, ny, 1.2, -0.5, 'add');
      x = nx;
      y = ny;
    }
  }
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const i = y * size + x;
    if (height.data[i] < -0.1) {
      color.mul(i, 0.55);
      rough.data[i] = 0.95;
    }
  }
  return finalize(size, color, height, rough, 0, 2.6);
}

export function asphalt(size = 1024, seed = 31): PBRRaw {
  const n = new TileNoise(seed);
  const height = new Layer(size);
  const rough = new Layer(size, 0.9);
  const color = new ColorLayer(size, [0.12, 0.12, 0.125]);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const u = x / size;
      const v = y / size;
      const w = worley(u, v, 220, seed);
      const big = n.fbm(u, v, 3, 4);
      height.data[i] = (1 - Math.min(1, w * 2)) * 0.5;
      const pebble = w < 0.3 ? 1.35 : 1;
      color.mul(i, (0.7 + big * 0.6) * pebble);
      const patch = Math.max(0, n.fbm(u, v, 4, 4) - 0.6) * 3;
      color.mul(i, 1 - patch * 0.3);
      rough.data[i] = 0.92 - patch * 0.4;
    }
  }
  return finalize(size, color, height, rough, 0, 3.0);
}

export function metalPanel(size = 512, seed = 41, base: [number, number, number] = [0.75, 0.75, 0.74]): PBRRaw {
  const n = new TileNoise(seed);
  const rnd = mulberry32(seed);
  const height = new Layer(size);
  const rough = new Layer(size, 0.52);
  const metal = new Layer(size, 0.25);
  const color = new ColorLayer(size, base);
  const bare: [number, number, number] = [0.62, 0.62, 0.6];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const u = x / size;
      const v = y / size;
      const brush = n.fbm(u, v, 2, 3, 0.5, 64);
      const dirt = n.fbm(u, v, 4, 5);
      color.mul(i, 0.85 + dirt * 0.25 + (brush - 0.5) * 0.06);
      rough.data[i] = 0.45 + dirt * 0.25;
      // edge wear near panel seams
      const ex = Math.min(Math.abs(u - 0), Math.abs(u - 0.5), Math.abs(u - 1));
      const ey = Math.min(Math.abs(v - 0), Math.abs(v - 1));
      const edge = Math.min(ex, ey);
      const wear = edge < 0.03 && n.fbm(u, v, 32, 3) > 0.55 ? 1 : 0;
      if (wear) {
        color.mix(i, bare, 0.9);
        metal.data[i] = 0.9;
        rough.data[i] = 0.32;
      }
      // grime gradient towards bottom of each tile
      color.mul(i, 1 - Math.pow(v, 6) * 0.25);
    }
  }
  // Seams + rivets
  for (const p of [0, 0.5]) height.line(p * size, 0, p * size, size, 3, -0.8, 'add');
  height.line(0, 0, size, 0, 3, -0.8, 'add');
  for (let k = 0; k < 2; k++) {
    for (let r = 0; r < 12; r++) {
      const cy = (r + 0.5) * (size / 12);
      for (const cx of [k * 0.5 * size + 10, k * 0.5 * size + size / 2 - 10]) {
        height.disc(cx, cy, 3.2, 0.6, 1.5);
      }
    }
  }
  // Scratches
  for (let s = 0; s < 40; s++) {
    const x0 = rnd() * size;
    const y0 = rnd() * size;
    const a = rnd() * Math.PI;
    const l = 10 + rnd() * 50;
    const x1 = x0 + Math.cos(a) * l;
    const y1 = y0 + Math.sin(a) * l;
    const steps = Math.ceil(l);
    for (let t = 0; t <= steps; t++) {
      const px = Math.round(x0 + ((x1 - x0) * t) / steps);
      const py = Math.round(y0 + ((y1 - y0) * t) / steps);
      const i = height.idx(px, py);
      color.mix(i, bare, 0.7);
      metal.data[i] = 0.85;
      rough.data[i] = 0.3;
      height.data[i] -= 0.15;
    }
  }
  return finalize(size, color, height, rough, metal, 2.0);
}

export function corrugated(size = 1024, seed = 53, base: [number, number, number] = [0.6, 0.12, 0.08]): PBRRaw {
  const n = new TileNoise(seed);
  const height = new Layer(size);
  const rough = new Layer(size, 0.55);
  const metal = new Layer(size, 0.35);
  const color = new ColorLayer(size, base);
  const rust: [number, number, number] = [0.32, 0.15, 0.06];
  const ribs = 16;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const u = x / size;
      const v = y / size;
      // Trapezoidal corrugation profile.
      const ph = (u * ribs) % 1;
      const tri = Math.abs(ph - 0.5) * 2;
      const prof = Math.min(1, Math.max(0, (tri - 0.2) * 1.8));
      const dent = n.fbm(u, v, 3, 3);
      height.data[i] = prof * 0.9 + dent * 0.25;
      const dirt = n.fbm(u, v, 6, 5);
      color.mul(i, 0.78 + dirt * 0.35);
      // rust streaks hanging from top
      const streak = n.fbm(u, v, 40, 3, 0.5, 2);
      const topRust = Math.max(0, streak - 0.5) * 2.5 * (1 - v) * 1.4;
      const patch = Math.max(0, n.fbm(u + 0.5, v, 5, 5) - 0.62) * 4;
      const r = Math.min(1, topRust * 0.9 + patch);
      color.mix(i, rust, r * 0.85);
      rough.data[i] = 0.5 + dirt * 0.2 + r * 0.35;
      metal.data[i] = 0.3 - r * 0.25;
      // faded paint on ridges
      color.mul(i, 1 + prof * 0.05);
    }
  }
  return finalize(size, color, height, rough, metal, 2.4);
}

export function woodCrate(size = 512, seed = 61): PBRRaw {
  const n = new TileNoise(seed);
  const height = new Layer(size);
  const rough = new Layer(size, 0.78);
  const color = new ColorLayer(size, [0.42, 0.28, 0.15]);
  const frame = 0.13;
  const planks = 5;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const u = x / size;
      const v = y / size;
      const inFrame = u < frame || u > 1 - frame || v < frame || v > 1 - frame;
      // diagonal brace
      const diag = Math.abs(u - v) < frame * 0.55;
      const grainDir = inFrame ? (u < frame || u > 1 - frame ? 1 : 0) : diag ? 2 : 0;
      let g: number;
      if (grainDir === 1) g = n.fbm(u, v, 64, 3, 0.5, 2);
      else if (grainDir === 2) g = n.fbm((u + v) * 0.5, (u - v) * 0.5 + 0.5, 3, 3, 0.5, 64);
      else g = n.fbm(u, v, 2, 3, 0.5, 64);
      const rings = Math.sin(g * 40) * 0.5 + 0.5;
      color.mul(i, 0.75 + rings * 0.22 + g * 0.2);
      let h = 0.3 + rings * 0.06;
      if (inFrame || diag) h += 0.45;
      if (!inFrame && !diag) {
        const pv = (v - frame) / (1 - frame * 2);
        const gap = Math.abs(((pv * planks) % 1) - 0.0);
        if (gap < 0.03 || gap > 0.97) {
          h -= 0.4;
          color.mul(i, 0.45);
        }
        // plank tone variation
        const pi = Math.floor(pv * planks);
        color.mul(i, 0.88 + hash2(pi, 3, seed) * 0.24);
      }
      // edges darker (worn)
      const e = Math.min(u, v, 1 - u, 1 - v);
      if (e < 0.012) {
        h -= 0.3;
        color.mul(i, 0.6);
      }
      height.data[i] = h;
      rough.data[i] = 0.7 + g * 0.2;
    }
  }
  // Nails in the frame corners
  for (const [cx, cy] of [
    [frame / 2, frame / 2],
    [1 - frame / 2, frame / 2],
    [frame / 2, 1 - frame / 2],
    [1 - frame / 2, 1 - frame / 2],
    [0.5, frame / 2],
    [0.5, 1 - frame / 2],
  ]) {
    height.disc(cx * size, cy * size, 4, 0.25, 2);
    const i = height.idx(Math.round(cx * size), Math.round(cy * size));
    color.mul(i, 0.4);
  }
  return finalize(size, color, height, rough, 0, 2.4);
}

export function diamondPlate(size = 512, seed = 71): PBRRaw {
  const n = new TileNoise(seed);
  const height = new Layer(size);
  const rough = new Layer(size, 0.38);
  const color = new ColorLayer(size, [0.55, 0.56, 0.57]);
  const cells = 10;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const u = x / size;
      const v = y / size;
      const gu = (u * cells) % 1;
      const gv = (v * cells) % 1;
      const alt = (Math.floor(u * cells) + Math.floor(v * cells)) % 2 === 0;
      // elongated diamond bump rotated ±45°
      const du = gu - 0.5;
      const dv = gv - 0.5;
      const a = alt ? du + dv : du - dv;
      const b = alt ? du - dv : du + dv;
      const d = (a * a) / 0.09 + (b * b) / 0.006;
      const bump = Math.max(0, 1 - d);
      height.data[i] = bump * 0.8;
      const dirt = n.fbm(u, v, 4, 5);
      color.mul(i, 0.7 + dirt * 0.4 + bump * 0.12);
      rough.data[i] = 0.3 + dirt * 0.35 - bump * 0.1;
    }
  }
  return finalize(size, color, height, rough, 0.85, 2.0);
}

export function hazardStripes(size = 512, seed = 81): PBRRaw {
  const n = new TileNoise(seed);
  const height = new Layer(size);
  const rough = new Layer(size, 0.6);
  const color = new ColorLayer(size, [0.75, 0.55, 0.05]);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const u = x / size;
      const v = y / size;
      const s = ((u + v) * 4) % 1;
      if (s > 0.5) color.r[i] = color.g[i] = color.b[i] = 0.035;
      const wear = n.fbm(u, v, 8, 5);
      if (wear > 0.62) {
        color.mix(i, [0.32, 0.31, 0.3], 0.85);
        height.data[i] = -0.2;
        rough.data[i] = 0.9;
      }
      color.mul(i, 0.85 + n.fbm(u, v, 3, 3) * 0.25);
    }
  }
  return finalize(size, color, height, rough, 0.05, 1.5);
}

/** Night-time window facade for distant skyline buildings (emissive). */
export function windowFacade(size = 512, seed = 91): THREE.DataTexture {
  const rnd = mulberry32(seed);
  const cols = 16;
  const rows = 32;
  const lit: number[] = [];
  for (let k = 0; k < cols * rows; k++) lit.push(rnd() < 0.18 ? 0.35 + rnd() * 0.65 : 0);
  const tint: number[] = [];
  for (let k = 0; k < cols * rows; k++) tint.push(rnd());
  return toTexture(
    size,
    (i, out, o) => {
      const x = i % size;
      const y = (i / size) | 0;
      const cu = (x / size) * cols;
      const cv = (y / size) * rows;
      const fu = cu % 1;
      const fv = cv % 1;
      const k = Math.floor(cv) * cols + Math.floor(cu);
      const inWin = fu > 0.18 && fu < 0.82 && fv > 0.25 && fv < 0.8;
      const l = inWin ? lit[k] : 0;
      const t = tint[k];
      out[o] = to8(l * (t > 0.7 ? 0.7 : 1.0));
      out[o + 1] = to8(l * (t > 0.7 ? 0.85 : 0.78));
      out[o + 2] = to8(l * (t > 0.7 ? 1.0 : 0.5));
    },
    true,
  );
}

// -----------------------------------------------------------------------------
// Sprite textures (canvas based, with alpha)
// -----------------------------------------------------------------------------

function canvasTex(size: number, draw: (ctx: CanvasRenderingContext2D, s: number) => void, srgb = true): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d')!;
  draw(ctx, size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.needsUpdate = true;
  return t;
}

export function softDot(size = 128): THREE.CanvasTexture {
  return canvasTex(size, (ctx, s) => {
    const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.25, 'rgba(255,255,255,0.65)');
    g.addColorStop(0.6, 'rgba(255,255,255,0.15)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, s, s);
  });
}

export function smokePuff(size = 256, seed = 5): THREE.CanvasTexture {
  const n = new TileNoise(seed);
  return canvasTex(size, (ctx, s) => {
    const img = ctx.createImageData(s, s);
    for (let y = 0; y < s; y++) {
      for (let x = 0; x < s; x++) {
        const u = x / s;
        const v = y / s;
        const dx = u - 0.5;
        const dy = v - 0.5;
        const d = Math.sqrt(dx * dx + dy * dy) * 2;
        const f = n.fbm(u, v, 4, 5);
        const a = Math.max(0, 1 - d * (1.05 + (0.5 - f) * 0.9));
        const alpha = Math.min(1, Math.pow(a, 1.35) * (0.8 + f * 0.5));
        const o = (y * s + x) * 4;
        const shade = 0.82 + f * 0.18;
        img.data[o] = img.data[o + 1] = img.data[o + 2] = to8(shade);
        img.data[o + 3] = to8(alpha);
      }
    }
    ctx.putImageData(img, 0, 0);
  });
}

export function muzzleFlare(size = 256): THREE.CanvasTexture {
  return canvasTex(size, (ctx, s) => {
    ctx.translate(s / 2, s / 2);
    const core = ctx.createRadialGradient(0, 0, 0, 0, 0, s * 0.5);
    core.addColorStop(0, 'rgba(255,250,235,1)');
    core.addColorStop(0.12, 'rgba(255,215,140,0.95)');
    core.addColorStop(0.35, 'rgba(255,140,40,0.35)');
    core.addColorStop(1, 'rgba(255,90,10,0)');
    ctx.fillStyle = core;
    ctx.fillRect(-s / 2, -s / 2, s, s);
    ctx.globalCompositeOperation = 'lighter';
    for (let k = 0; k < 7; k++) {
      ctx.save();
      ctx.rotate((k / 7) * Math.PI * 2 + (k % 2) * 0.2);
      const len = s * (k % 2 ? 0.32 : 0.48);
      const g = ctx.createLinearGradient(0, 0, len, 0);
      g.addColorStop(0, 'rgba(255,230,170,0.95)');
      g.addColorStop(1, 'rgba(255,120,30,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(0, -s * 0.035);
      ctx.lineTo(len, 0);
      ctx.lineTo(0, s * 0.035);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
  });
}

export function bulletHole(size = 128): THREE.CanvasTexture {
  return canvasTex(size, (ctx, s) => {
    const c = s / 2;
    const g = ctx.createRadialGradient(c, c, 0, c, c, c);
    g.addColorStop(0, 'rgba(5,5,5,1)');
    g.addColorStop(0.16, 'rgba(10,10,10,0.95)');
    g.addColorStop(0.22, 'rgba(60,55,50,0.8)');
    g.addColorStop(0.45, 'rgba(40,38,35,0.35)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, s, s);
    ctx.strokeStyle = 'rgba(15,15,15,0.6)';
    ctx.lineWidth = 1.2;
    for (let k = 0; k < 7; k++) {
      const a = Math.random() * Math.PI * 2;
      const l = s * (0.18 + Math.random() * 0.22);
      ctx.beginPath();
      ctx.moveTo(c + Math.cos(a) * s * 0.1, c + Math.sin(a) * s * 0.1);
      ctx.lineTo(c + Math.cos(a + 0.2) * l, c + Math.sin(a + 0.2) * l);
      ctx.stroke();
    }
  });
}

export function scorch(size = 256, seed = 7): THREE.CanvasTexture {
  const n = new TileNoise(seed);
  return canvasTex(size, (ctx, s) => {
    const img = ctx.createImageData(s, s);
    for (let y = 0; y < s; y++) {
      for (let x = 0; x < s; x++) {
        const u = x / s;
        const v = y / s;
        const d = Math.hypot(u - 0.5, v - 0.5) * 2;
        const f = n.fbm(u, v, 5, 5);
        const a = Math.max(0, 1 - d * (0.9 + (0.5 - f))) * 0.92;
        const o = (y * s + x) * 4;
        img.data[o] = img.data[o + 1] = img.data[o + 2] = 8;
        img.data[o + 3] = to8(a);
      }
    }
    ctx.putImageData(img, 0, 0);
  });
}

export function ringTex(size = 256): THREE.CanvasTexture {
  return canvasTex(size, (ctx, s) => {
    const g = ctx.createRadialGradient(s / 2, s / 2, s * 0.3, s / 2, s / 2, s / 2);
    g.addColorStop(0, 'rgba(255,255,255,0)');
    g.addColorStop(0.75, 'rgba(255,255,255,0.9)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, s, s);
  });
}

/** Vertical gradient used for light beams (bright bottom, fades upward). */
export function beamTex(size = 128): THREE.CanvasTexture {
  return canvasTex(size, (ctx, s) => {
    const g = ctx.createLinearGradient(0, s, 0, 0);
    g.addColorStop(0, 'rgba(255,255,255,0.9)');
    g.addColorStop(0.4, 'rgba(255,255,255,0.3)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, s, s);
    const h = ctx.createLinearGradient(0, 0, s, 0);
    h.addColorStop(0, 'rgba(0,0,0,1)');
    h.addColorStop(0.5, 'rgba(0,0,0,0)');
    h.addColorStop(1, 'rgba(0,0,0,1)');
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = h;
    ctx.fillRect(0, 0, s, s);
  });
}

/** Painted floor markings (team spawn emblem etc). */
export function spawnEmblem(size: number, color: string, label: string): THREE.CanvasTexture {
  return canvasTex(size, (ctx, s) => {
    ctx.clearRect(0, 0, s, s);
    ctx.translate(s / 2, s / 2);
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.85;
    ctx.lineWidth = s * 0.025;
    ctx.beginPath();
    ctx.arc(0, 0, s * 0.42, 0, Math.PI * 2);
    ctx.stroke();
    ctx.lineWidth = s * 0.01;
    ctx.beginPath();
    ctx.arc(0, 0, s * 0.36, 0, Math.PI * 2);
    ctx.stroke();
    for (let k = 0; k < 12; k++) {
      ctx.save();
      ctx.rotate((k / 12) * Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fillRect(s * 0.37, -s * 0.006, s * 0.03, s * 0.012);
      ctx.restore();
    }
    ctx.fillStyle = color;
    ctx.font = `700 ${Math.round(s * 0.14)}px Rajdhani, 'Chakra Petch', sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, 0, 0);
  });
}

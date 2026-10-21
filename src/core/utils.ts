import * as THREE from 'three';

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const invLerp = (a: number, b: number, v: number): number => clamp((v - a) / (b - a), 0, 1);
export const smoothstep = (a: number, b: number, v: number): number => {
  const t = invLerp(a, b, v);
  return t * t * (3 - 2 * t);
};

/** Frame-rate independent exponential smoothing factor. */
export const dampFactor = (lambda: number, dt: number): number => 1 - Math.exp(-lambda * dt);
export const damp = (a: number, b: number, lambda: number, dt: number): number => lerp(a, b, dampFactor(lambda, dt));

export const wrapAngle = (a: number): number => {
  let r = a % (Math.PI * 2);
  if (r > Math.PI) r -= Math.PI * 2;
  if (r < -Math.PI) r += Math.PI * 2;
  return r;
};

export const dampAngle = (a: number, b: number, lambda: number, dt: number): number =>
  a + wrapAngle(b - a) * dampFactor(lambda, dt);

export const randRange = (lo: number, hi: number): number => lo + Math.random() * (hi - lo);
export const randInt = (lo: number, hi: number): number => Math.floor(randRange(lo, hi + 1));
export const pick = <T>(arr: readonly T[]): T => arr[Math.floor(Math.random() * arr.length)];

export function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/** Small deterministic PRNG (mulberry32). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const formatClock = (seconds: number): string => {
  const s = Math.max(0, Math.ceil(seconds));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
};

export const round3 = (v: number): number => Math.round(v * 1000) / 1000;

/** Direction vector from yaw/pitch (yaw 0 looks toward -Z, matching three.js cameras). */
export function dirFromYawPitch(yaw: number, pitch: number, out = new THREE.Vector3()): THREE.Vector3 {
  const cp = Math.cos(pitch);
  return out.set(-Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp);
}

export function yawPitchFromDir(dir: THREE.Vector3): { yaw: number; pitch: number } {
  const yaw = Math.atan2(-dir.x, -dir.z);
  const pitch = Math.asin(clamp(dir.y / (dir.length() || 1), -1, 1));
  return { yaw, pitch };
}

/** Returns a random unit vector inside a cone around `dir` with half-angle `angle` (radians). */
export function coneDirection(dir: THREE.Vector3, angle: number, out = new THREE.Vector3()): THREE.Vector3 {
  if (angle <= 0) return out.copy(dir);
  // Gaussian-ish distribution concentrated near the center feels better than uniform.
  const r = angle * Math.sqrt(-2 * Math.log(Math.max(1e-6, Math.random()))) * 0.45;
  const theta = Math.random() * Math.PI * 2;
  const tangent = Math.abs(dir.y) < 0.99 ? _up : _right;
  _t1.crossVectors(dir, tangent).normalize();
  _t2.crossVectors(dir, _t1).normalize();
  const ra = Math.min(r, angle * 1.6);
  return out
    .copy(dir)
    .addScaledVector(_t1, Math.cos(theta) * Math.tan(ra))
    .addScaledVector(_t2, Math.sin(theta) * Math.tan(ra))
    .normalize();
}
const _up = new THREE.Vector3(0, 1, 0);
const _right = new THREE.Vector3(1, 0, 0);
const _t1 = new THREE.Vector3();
const _t2 = new THREE.Vector3();

export const uid = (): string => Math.random().toString(36).slice(2, 10);

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
}

/** Critically-damped-ish spring for procedural animation. */
export class Spring {
  value = 0;
  velocity = 0;
  target = 0;
  constructor(
    public stiffness = 120,
    public damping = 14,
  ) {}

  update(dt: number): number {
    const force = (this.target - this.value) * this.stiffness - this.velocity * this.damping;
    this.velocity += force * dt;
    this.value += this.velocity * dt;
    return this.value;
  }

  impulse(v: number): void {
    this.velocity += v;
  }
}

export class Spring3 {
  readonly x: Spring;
  readonly y: Spring;
  readonly z: Spring;
  constructor(stiffness = 120, damping = 14) {
    this.x = new Spring(stiffness, damping);
    this.y = new Spring(stiffness, damping);
    this.z = new Spring(stiffness, damping);
  }

  update(dt: number, out: THREE.Vector3 | THREE.Euler): void {
    out.x = this.x.update(dt);
    out.y = this.y.update(dt);
    out.z = this.z.update(dt);
  }

  impulse(x: number, y: number, z: number): void {
    this.x.impulse(x);
    this.y.impulse(y);
    this.z.impulse(z);
  }
}

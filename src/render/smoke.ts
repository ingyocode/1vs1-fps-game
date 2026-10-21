import * as THREE from 'three';
import { smokePuff } from './textures';
import { clamp, mulberry32, smoothstep } from '../core/utils';
import { segmentHitsSphere } from '../world/collision';
import type { TeamId } from '../core/config';

export interface SmokeCloud {
  id: string;
  pos: THREE.Vector3;
  radius: number;
  born: number;
  duration: number;
  owner: string;
  team: TeamId;
  toxic: boolean;
  puffs: { ox: number; oy: number; oz: number; size: number; phase: number; speed: number; shade: number }[];
}

const VS = /* glsl */ `
  attribute vec3 iPos;
  attribute vec4 iColor;
  attribute vec2 iData;
  varying vec2 vUv;
  varying vec4 vColor;
  void main() {
    vUv = uv;
    vColor = iColor;
    vec4 mv = modelViewMatrix * vec4(iPos, 1.0);
    float c = cos(iData.y);
    float s = sin(iData.y);
    vec2 corner = position.xy;
    mv.xy += vec2(c * corner.x - s * corner.y, s * corner.x + c * corner.y) * iData.x;
    gl_Position = projectionMatrix * mv;
  }
`;

const FS = /* glsl */ `
  uniform sampler2D map;
  varying vec2 vUv;
  varying vec4 vColor;
  void main() {
    vec4 t = texture2D(map, vUv);
    gl_FragColor = vec4(vColor.rgb * t.rgb, vColor.a * t.a);
  }
`;

const MAX_PUFFS = 480;
const PUFFS_PER = 58;

/** Volumetric-looking smoke screens made of sorted soft billboards. */
export class SmokeSystem {
  readonly clouds: SmokeCloud[] = [];
  private mesh: THREE.Mesh;
  private geo: THREE.InstancedBufferGeometry;
  private pos = new Float32Array(MAX_PUFFS * 3);
  private col = new Float32Array(MAX_PUFFS * 4);
  private dat = new Float32Array(MAX_PUFFS * 2);
  private order: { d: number; x: number; y: number; z: number; s: number; r: number; c: [number, number, number, number] }[] = [];

  constructor(private readonly scene: THREE.Scene) {
    const plane = new THREE.PlaneGeometry(1, 1);
    this.geo = new THREE.InstancedBufferGeometry();
    this.geo.index = plane.index;
    this.geo.setAttribute('position', plane.getAttribute('position'));
    this.geo.setAttribute('uv', plane.getAttribute('uv'));
    this.geo.setAttribute('iPos', new THREE.InstancedBufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('iColor', new THREE.InstancedBufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('iData', new THREE.InstancedBufferAttribute(this.dat, 2).setUsage(THREE.DynamicDrawUsage));
    this.geo.instanceCount = 0;
    const mat = new THREE.ShaderMaterial({
      uniforms: { map: { value: smokePuff(256, 17) } },
      vertexShader: VS,
      fragmentShader: FS,
      transparent: true,
      depthWrite: false,
    });
    this.mesh = new THREE.Mesh(this.geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 18;
    scene.add(this.mesh);
  }

  spawn(id: string, pos: THREE.Vector3, radius: number, duration: number, owner: string, team: TeamId, toxic: boolean, now: number): void {
    const rnd = mulberry32(Math.floor(pos.x * 1000 + pos.z * 7919) >>> 0);
    const puffs: SmokeCloud['puffs'] = [];
    for (let i = 0; i < PUFFS_PER; i++) {
      // Distribute in a squashed sphere biased towards the ground.
      const u = rnd() * 2 - 1;
      const th = rnd() * Math.PI * 2;
      const rr = Math.cbrt(rnd()) * 0.85;
      const sxz = Math.sqrt(1 - u * u);
      const oy = Math.abs(u) * rr * 0.7 + 0.12;
      puffs.push({
        ox: Math.cos(th) * sxz * rr,
        oy,
        oz: Math.sin(th) * sxz * rr,
        size: 0.75 + rnd() * 0.55,
        phase: rnd() * Math.PI * 2,
        speed: 0.15 + rnd() * 0.25,
        shade: 0.75 + rnd() * 0.25,
      });
    }
    this.clouds.push({ id, pos: pos.clone(), radius, born: now, duration, owner, team, toxic, puffs });
    while (this.clouds.length * PUFFS_PER > MAX_PUFFS) this.clouds.shift();
  }

  clear(): void {
    this.clouds.length = 0;
  }

  dispose(): void {
    this.scene.remove(this.mesh);
    this.geo.dispose();
  }

  /** 0..1 strength of a cloud at time `now` (grow in, fade out). */
  private strength(c: SmokeCloud, now: number): number {
    const age = now - c.born;
    return smoothstep(0, 1.2, age) * (1 - smoothstep(c.duration - 2, c.duration, age));
  }

  /** True if the segment a→b passes through dense smoke. */
  blocks(a: THREE.Vector3, b: THREE.Vector3, now: number): boolean {
    _d.subVectors(b, a);
    const len = _d.length();
    if (len < 1e-3) return false;
    _d.divideScalar(len);
    for (const c of this.clouds) {
      const st = this.strength(c, now);
      if (st < 0.5) continue;
      _c.copy(c.pos).setY(c.pos.y + c.radius * 0.35);
      if (segmentHitsSphere(a, _d, len, _c, c.radius * 0.85 * st)) return true;
    }
    return false;
  }

  /** Density (0..1) of smoke around a point — used for the in-smoke screen effect. */
  densityAt(p: THREE.Vector3, now: number): number {
    let best = 0;
    for (const c of this.clouds) {
      const st = this.strength(c, now);
      if (st <= 0) continue;
      const dy = (p.y - (c.pos.y + c.radius * 0.35)) / 0.8;
      const d = Math.hypot(p.x - c.pos.x, dy, p.z - c.pos.z) / c.radius;
      best = Math.max(best, clamp((1.05 - d) * 3, 0, 1) * st);
    }
    return best;
  }

  update(now: number, camera: THREE.Camera): void {
    for (let i = this.clouds.length - 1; i >= 0; i--) if (now - this.clouds[i].born > this.clouds[i].duration) this.clouds.splice(i, 1);
    const cam = camera.position;
    this.order.length = 0;
    for (const c of this.clouds) {
      const age = now - c.born;
      const st = this.strength(c, now);
      const grow = 0.35 + 0.65 * smoothstep(0, 1.4, age);
      for (const p of c.puffs) {
        const sway = Math.sin(now * p.speed + p.phase) * 0.12;
        const x = c.pos.x + (p.ox + sway * 0.4) * c.radius * grow;
        const y = c.pos.y + p.oy * c.radius * grow + Math.sin(now * p.speed * 0.7 + p.phase) * 0.1;
        const z = c.pos.z + (p.oz + Math.cos(now * p.speed + p.phase) * 0.05) * c.radius * grow;
        const size = p.size * c.radius * (0.65 + 0.35 * grow) * 1.35;
        const dist = Math.hypot(x - cam.x, y - cam.y, z - cam.z);
        const near = smoothstep(0.4, 2.2, dist);
        const h = p.oy;
        const lit = 0.72 + h * 0.5;
        const shade = p.shade * lit;
        // Warm sunset light on top, cooler shadowed underside.
        const tint: [number, number, number] = c.toxic ? [0.5 * shade, 0.7 * shade, 0.4 * shade] : [(0.74 + h * 0.08) * shade, 0.72 * shade, (0.74 - h * 0.06) * shade];
        this.order.push({ d: dist, x, y, z, s: size, r: p.phase + now * p.speed * 0.15, c: [tint[0], tint[1], tint[2], 0.95 * st * near] });
      }
    }
    this.order.sort((a, b) => b.d - a.d);
    const n = Math.min(MAX_PUFFS, this.order.length);
    for (let i = 0; i < n; i++) {
      const o = this.order[i];
      this.pos[i * 3] = o.x;
      this.pos[i * 3 + 1] = o.y;
      this.pos[i * 3 + 2] = o.z;
      this.col[i * 4] = o.c[0];
      this.col[i * 4 + 1] = o.c[1];
      this.col[i * 4 + 2] = o.c[2];
      this.col[i * 4 + 3] = o.c[3];
      this.dat[i * 2] = o.s;
      this.dat[i * 2 + 1] = o.r;
    }
    this.geo.instanceCount = n;
    for (const name of ['iPos', 'iColor', 'iData']) (this.geo.getAttribute(name) as THREE.InstancedBufferAttribute).needsUpdate = true;
  }
}

const _d = new THREE.Vector3();
const _c = new THREE.Vector3();

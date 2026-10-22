import * as THREE from 'three';
import { bulletHole, ringTex, scorch, smokePuff, softDot } from './textures';
import { randRange } from '../core/utils';

// -----------------------------------------------------------------------------
// GPU billboard particles (instanced, CPU simulated)
// -----------------------------------------------------------------------------

interface Particle {
  px: number;
  py: number;
  pz: number;
  vx: number;
  vy: number;
  vz: number;
  life: number;
  max: number;
  s0: number;
  s1: number;
  r: number;
  g: number;
  b: number;
  a0: number;
  a1: number;
  grav: number;
  drag: number;
  rot: number;
  rotV: number;
  stretch: number;
}

export interface SpawnOpts {
  vel?: [number, number, number];
  life: number;
  size: [number, number];
  color: [number, number, number];
  alpha?: [number, number];
  gravity?: number;
  drag?: number;
  rot?: number;
  rotV?: number;
  stretch?: number;
}

const PARTICLE_VS = /* glsl */ `
  attribute vec3 iPos;
  attribute vec3 iVel;
  attribute vec4 iColor;
  attribute vec3 iData; // size, rotation, stretch
  varying vec2 vUv;
  varying vec4 vColor;
  void main() {
    vUv = uv;
    vColor = iColor;
    vec4 mv = modelViewMatrix * vec4(iPos, 1.0);
    vec2 corner = position.xy;
    float size = iData.x;
    if (iData.z > 0.0) {
      vec3 vv = (viewMatrix * vec4(iVel, 0.0)).xyz;
      vec2 d = vv.xy;
      float l = length(d);
      vec2 dir = l > 1e-4 ? d / l : vec2(1.0, 0.0);
      vec2 perp = vec2(-dir.y, dir.x);
      float len = size + l * iData.z;
      mv.xy += dir * corner.x * len + perp * corner.y * size;
    } else {
      float c = cos(iData.y);
      float s = sin(iData.y);
      mv.xy += vec2(c * corner.x - s * corner.y, s * corner.x + c * corner.y) * size;
    }
    gl_Position = projectionMatrix * mv;
  }
`;

const PARTICLE_FS = /* glsl */ `
  uniform sampler2D map;
  varying vec2 vUv;
  varying vec4 vColor;
  void main() {
    vec4 t = texture2D(map, vUv);
    gl_FragColor = vec4(vColor.rgb * t.rgb, vColor.a * t.a);
  }
`;

class ParticleSystem {
  readonly mesh: THREE.Mesh;
  private list: Particle[] = [];
  private pos: Float32Array;
  private vel: Float32Array;
  private col: Float32Array;
  private dat: Float32Array;
  private geo: THREE.InstancedBufferGeometry;

  constructor(
    texture: THREE.Texture,
    additive: boolean,
    private readonly capacity: number,
  ) {
    const plane = new THREE.PlaneGeometry(1, 1);
    this.geo = new THREE.InstancedBufferGeometry();
    this.geo.index = plane.index;
    this.geo.setAttribute('position', plane.getAttribute('position'));
    this.geo.setAttribute('uv', plane.getAttribute('uv'));
    this.pos = new Float32Array(capacity * 3);
    this.vel = new Float32Array(capacity * 3);
    this.col = new Float32Array(capacity * 4);
    this.dat = new Float32Array(capacity * 3);
    this.geo.setAttribute('iPos', new THREE.InstancedBufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('iVel', new THREE.InstancedBufferAttribute(this.vel, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('iColor', new THREE.InstancedBufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('iData', new THREE.InstancedBufferAttribute(this.dat, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.instanceCount = 0;
    const mat = new THREE.ShaderMaterial({
      uniforms: { map: { value: texture } },
      vertexShader: PARTICLE_VS,
      fragmentShader: PARTICLE_FS,
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.mesh = new THREE.Mesh(this.geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = additive ? 20 : 15;
  }

  spawn(x: number, y: number, z: number, o: SpawnOpts): void {
    if (this.list.length >= this.capacity) this.list.shift();
    const v = o.vel ?? [0, 0, 0];
    const a = o.alpha ?? [1, 0];
    this.list.push({
      px: x,
      py: y,
      pz: z,
      vx: v[0],
      vy: v[1],
      vz: v[2],
      life: 0,
      max: o.life,
      s0: o.size[0],
      s1: o.size[1],
      r: o.color[0],
      g: o.color[1],
      b: o.color[2],
      a0: a[0],
      a1: a[1],
      grav: o.gravity ?? 0,
      drag: o.drag ?? 0,
      rot: o.rot ?? Math.random() * Math.PI * 2,
      rotV: o.rotV ?? 0,
      stretch: o.stretch ?? 0,
    });
  }

  update(dt: number): void {
    let n = 0;
    const keep: Particle[] = [];
    for (const p of this.list) {
      p.life += dt;
      if (p.life >= p.max) continue;
      keep.push(p);
      const dragK = Math.exp(-p.drag * dt);
      p.vx *= dragK;
      p.vy = p.vy * dragK - p.grav * dt;
      p.vz *= dragK;
      p.px += p.vx * dt;
      p.py += p.vy * dt;
      p.pz += p.vz * dt;
      p.rot += p.rotV * dt;
      const t = p.life / p.max;
      const i3 = n * 3;
      const i4 = n * 4;
      this.pos[i3] = p.px;
      this.pos[i3 + 1] = p.py;
      this.pos[i3 + 2] = p.pz;
      this.vel[i3] = p.vx;
      this.vel[i3 + 1] = p.vy;
      this.vel[i3 + 2] = p.vz;
      // fade in quickly, then out
      const fadeIn = Math.min(1, t * 12);
      this.col[i4] = p.r;
      this.col[i4 + 1] = p.g;
      this.col[i4 + 2] = p.b;
      this.col[i4 + 3] = (p.a0 + (p.a1 - p.a0) * t) * fadeIn;
      this.dat[i3] = p.s0 + (p.s1 - p.s0) * t;
      this.dat[i3 + 1] = p.rot;
      this.dat[i3 + 2] = p.stretch;
      n++;
    }
    this.list = keep;
    this.geo.instanceCount = n;
    for (const name of ['iPos', 'iVel', 'iColor', 'iData']) {
      const attr = this.geo.getAttribute(name) as THREE.InstancedBufferAttribute;
      attr.clearUpdateRanges();
      attr.addUpdateRange(0, n * attr.itemSize);
      attr.needsUpdate = true;
    }
  }

  clear(): void {
    this.list = [];
  }
}

// -----------------------------------------------------------------------------
// Tracers: camera-facing ribbons that travel along the shot
// -----------------------------------------------------------------------------

interface Tracer {
  ax: number;
  ay: number;
  az: number;
  bx: number;
  by: number;
  bz: number;
  len: number;
  age: number;
  speed: number;
  streak: number;
  r: number;
  g: number;
  b: number;
  width: number;
}

const TRACER_VS = /* glsl */ `
  attribute vec3 iA;
  attribute vec3 iB;
  attribute vec4 iColor;
  attribute float iWidth;
  varying float vT;
  varying float vSide;
  varying vec4 vColor;
  void main() {
    vT = position.x;
    vSide = position.y;
    vColor = iColor;
    vec3 p = mix(iA, iB, position.x);
    vec4 mvA = viewMatrix * vec4(iA, 1.0);
    vec4 mvB = viewMatrix * vec4(iB, 1.0);
    vec4 mv = viewMatrix * vec4(p, 1.0);
    vec3 dir = normalize(mvB.xyz - mvA.xyz);
    vec3 side = normalize(cross(dir, normalize(-mv.xyz)));
    mv.xyz += side * position.y * iWidth;
    gl_Position = projectionMatrix * mv;
  }
`;

const TRACER_FS = /* glsl */ `
  varying float vT;
  varying float vSide;
  varying vec4 vColor;
  void main() {
    float core = 1.0 - smoothstep(0.0, 0.5, abs(vSide));
    float head = smoothstep(0.0, 1.0, vT);
    gl_FragColor = vec4(vColor.rgb * (0.6 + core * 1.8), vColor.a * core * head);
  }
`;

class TracerSystem {
  readonly mesh: THREE.Mesh;
  private list: Tracer[] = [];
  private a: Float32Array;
  private b: Float32Array;
  private c: Float32Array;
  private w: Float32Array;
  private geo: THREE.InstancedBufferGeometry;

  constructor(private readonly capacity = 96) {
    const base = new THREE.BufferGeometry();
    base.setAttribute('position', new THREE.Float32BufferAttribute([0, -0.5, 0, 1, -0.5, 0, 1, 0.5, 0, 0, 0.5, 0], 3));
    base.setIndex([0, 1, 2, 0, 2, 3]);
    this.geo = new THREE.InstancedBufferGeometry();
    this.geo.index = base.index;
    this.geo.setAttribute('position', base.getAttribute('position'));
    this.a = new Float32Array(capacity * 3);
    this.b = new Float32Array(capacity * 3);
    this.c = new Float32Array(capacity * 4);
    this.w = new Float32Array(capacity);
    this.geo.setAttribute('iA', new THREE.InstancedBufferAttribute(this.a, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('iB', new THREE.InstancedBufferAttribute(this.b, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('iColor', new THREE.InstancedBufferAttribute(this.c, 4).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('iWidth', new THREE.InstancedBufferAttribute(this.w, 1).setUsage(THREE.DynamicDrawUsage));
    this.geo.instanceCount = 0;
    const mat = new THREE.ShaderMaterial({
      vertexShader: TRACER_VS,
      fragmentShader: TRACER_FS,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(this.geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 21;
  }

  add(from: THREE.Vector3, to: THREE.Vector3, color: THREE.Color, width = 0.022, speed = 420, streak = 7): void {
    if (this.list.length >= this.capacity) this.list.shift();
    const len = from.distanceTo(to);
    if (len < 0.5) return;
    this.list.push({ ax: from.x, ay: from.y, az: from.z, bx: to.x, by: to.y, bz: to.z, len, age: 0, speed, streak, r: color.r, g: color.g, b: color.b, width });
  }

  update(dt: number): void {
    let n = 0;
    const keep: Tracer[] = [];
    for (const t of this.list) {
      t.age += dt;
      const head = t.age * t.speed;
      if (head - t.streak > t.len) continue;
      keep.push(t);
      const h = Math.min(t.len, head) / t.len;
      const tail = Math.max(0, head - t.streak) / t.len;
      const i3 = n * 3;
      this.a[i3] = t.ax + (t.bx - t.ax) * tail;
      this.a[i3 + 1] = t.ay + (t.by - t.ay) * tail;
      this.a[i3 + 2] = t.az + (t.bz - t.az) * tail;
      this.b[i3] = t.ax + (t.bx - t.ax) * h;
      this.b[i3 + 1] = t.ay + (t.by - t.ay) * h;
      this.b[i3 + 2] = t.az + (t.bz - t.az) * h;
      const i4 = n * 4;
      this.c[i4] = t.r;
      this.c[i4 + 1] = t.g;
      this.c[i4 + 2] = t.b;
      this.c[i4 + 3] = 0.9;
      this.w[n] = t.width;
      n++;
    }
    this.list = keep;
    this.geo.instanceCount = n;
    for (const name of ['iA', 'iB', 'iColor', 'iWidth']) {
      const attr = this.geo.getAttribute(name) as THREE.InstancedBufferAttribute;
      attr.needsUpdate = true;
    }
  }
}

// -----------------------------------------------------------------------------
// Decals (bullet holes, scorch marks) — ring buffers of instanced quads
// -----------------------------------------------------------------------------

class DecalPool {
  readonly mesh: THREE.InstancedMesh;
  private next = 0;
  private dummy = new THREE.Object3D();

  constructor(tex: THREE.Texture, capacity: number, opacity = 1) {
    const mat = new THREE.MeshStandardMaterial({
      map: tex,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
      roughness: 0.9,
      metalness: 0,
      opacity,
    });
    this.mesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), mat, capacity);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
    this.mesh.receiveShadow = true;
  }

  add(point: THREE.Vector3, normal: THREE.Vector3, size: number): void {
    const d = this.dummy;
    d.position.copy(point).addScaledVector(normal, 0.004);
    d.lookAt(_tmp.copy(d.position).add(normal));
    d.rotateZ(Math.random() * Math.PI * 2);
    d.scale.setScalar(size);
    d.updateMatrix();
    const cap = this.mesh.instanceMatrix.count;
    this.mesh.setMatrixAt(this.next % cap, d.matrix);
    this.next++;
    this.mesh.count = Math.min(cap, this.next);
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  clear(): void {
    this.next = 0;
    this.mesh.count = 0;
  }
}
const _tmp = new THREE.Vector3();

// -----------------------------------------------------------------------------
// Short-lived world lights (fixed pool to avoid shader recompiles)
// -----------------------------------------------------------------------------

export const EFFECT_LIGHTS = 4;

/**
 * The pool's lights live in the scene for the whole app run. The number of lights is part of
 * every lit material's shader, so adding them when a match starts (and removing them after)
 * made the first frame of every session recompile all map shaders synchronously — a freeze
 * long enough to drop pointer lock and time out the network link.
 */
export function ensureEffectLights(scene: THREE.Scene): THREE.PointLight[] {
  let lights = scene.userData.effectLights as THREE.PointLight[] | undefined;
  if (!lights) {
    lights = Array.from({ length: EFFECT_LIGHTS }, () => {
      const light = new THREE.PointLight(0xffaa66, 0, 10, 2);
      light.castShadow = false;
      scene.add(light);
      return light;
    });
    scene.userData.effectLights = lights;
  }
  return lights;
}

class LightPool {
  readonly lights: { light: THREE.PointLight; t: number; max: number; peak: number }[] = [];
  constructor(scene: THREE.Scene) {
    for (const light of ensureEffectLights(scene)) {
      light.intensity = 0;
      this.lights.push({ light, t: 1, max: 1, peak: 0 });
    }
  }

  flash(pos: THREE.Vector3, color: number, intensity: number, range: number, duration: number): void {
    let best = this.lights[0];
    for (const l of this.lights) if (l.t / l.max >= best.t / best.max) best = l;
    best.light.position.copy(pos);
    best.light.color.set(color);
    best.light.distance = range;
    best.peak = intensity;
    best.t = 0;
    best.max = duration;
  }

  update(dt: number): void {
    for (const l of this.lights) {
      l.t += dt;
      const k = Math.max(0, 1 - l.t / l.max);
      l.light.intensity = l.peak * k * k;
    }
  }
}

// -----------------------------------------------------------------------------
// Ambient dust motes drifting around the camera (wrap-around volume)
// -----------------------------------------------------------------------------

class AmbientDust {
  readonly points: THREE.Points;
  private pos: Float32Array;
  private seed: Float32Array;
  private readonly size = 14;
  private readonly count = 420;

  constructor() {
    this.pos = new Float32Array(this.count * 3);
    this.seed = new Float32Array(this.count);
    for (let i = 0; i < this.count; i++) {
      this.pos[i * 3] = (Math.random() - 0.5) * this.size;
      this.pos[i * 3 + 1] = Math.random() * 6;
      this.pos[i * 3 + 2] = (Math.random() - 0.5) * this.size;
      this.seed[i] = Math.random();
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(this.seed, 1));
    const mat = new THREE.ShaderMaterial({
      uniforms: { uCam: { value: new THREE.Vector3() }, uTime: { value: 0 }, uSize: { value: this.size }, uScale: { value: 400 } },
      vertexShader: /* glsl */ `
        uniform vec3 uCam;
        uniform float uTime;
        uniform float uSize;
        uniform float uScale;
        attribute float aSeed;
        varying float vA;
        void main() {
          vec3 p = position;
          p.x += sin(uTime * 0.13 + aSeed * 40.0) * 0.6 + uTime * 0.05;
          p.y += sin(uTime * 0.21 + aSeed * 17.0) * 0.4;
          p.z += cos(uTime * 0.11 + aSeed * 23.0) * 0.6;
          // wrap the volume around the camera
          vec3 rel = mod(p - uCam + uSize * 0.5, uSize) - uSize * 0.5;
          vec3 w = uCam + rel;
          w.y = mod(p.y, 6.0) + 0.1;
          vec4 mv = viewMatrix * vec4(w, 1.0);
          float d = length(rel);
          vA = (1.0 - smoothstep(uSize * 0.3, uSize * 0.5, d)) * smoothstep(0.4, 1.5, d) * (0.4 + 0.6 * sin(uTime * 1.3 + aSeed * 31.0) * 0.5 + 0.3);
          gl_PointSize = uScale * (0.012 + aSeed * 0.012) / -mv.z;
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        varying float vA;
        void main() {
          vec2 c = gl_PointCoord - 0.5;
          float a = smoothstep(0.5, 0.0, length(c)) * vA;
          gl_FragColor = vec4(vec3(1.0, 0.82, 0.6) * 1.2, a * 0.35);
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 19;
  }

  update(cam: THREE.Vector3, time: number): void {
    const u = (this.points.material as THREE.ShaderMaterial).uniforms;
    u.uCam.value.copy(cam);
    u.uTime.value = time;
    u.uScale.value = window.innerHeight * 0.9;
  }
}

// -----------------------------------------------------------------------------
// Effects facade
// -----------------------------------------------------------------------------

interface Wave {
  mesh: THREE.Mesh;
  t: number;
  dur: number;
  maxScale: number;
}

export class Effects {
  private add: ParticleSystem;
  private alpha: ParticleSystem;
  private smokeP: ParticleSystem;
  private tracers = new TracerSystem();
  private holes: DecalPool;
  private scorches: DecalPool;
  private lights: LightPool;
  private waves: Wave[] = [];
  private ringMat: THREE.MeshBasicMaterial;
  private sphereMat: THREE.ShaderMaterial;
  private readonly group = new THREE.Group();
  private dust = new AmbientDust();
  private time = 0;

  constructor(private readonly scene: THREE.Scene) {
    const dot = softDot();
    const puff = smokePuff();
    this.add = new ParticleSystem(dot, true, 1400);
    this.alpha = new ParticleSystem(dot, false, 600);
    this.smokeP = new ParticleSystem(puff, false, 500);
    this.holes = new DecalPool(bulletHole(), 160);
    this.scorches = new DecalPool(scorch(), 16, 0.9);
    this.lights = new LightPool(scene);
    this.ringMat = new THREE.MeshBasicMaterial({ map: ringTex(), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, color: 0xffffff, side: THREE.DoubleSide });
    this.sphereMat = new THREE.ShaderMaterial({
      uniforms: { uColor: { value: new THREE.Color(0x60e0ff) }, uAlpha: { value: 1 } },
      vertexShader: /* glsl */ `
        varying vec3 vN; varying vec3 vV;
        void main() { vec4 mv = modelViewMatrix * vec4(position, 1.0); vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix * mv; }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor; uniform float uAlpha; varying vec3 vN; varying vec3 vV;
        void main() { float r = pow(1.0 - abs(dot(vN, vV)), 2.5); gl_FragColor = vec4(uColor * 2.5, r * uAlpha); }
      `,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    this.group.add(this.add.mesh, this.alpha.mesh, this.smokeP.mesh, this.tracers.mesh, this.holes.mesh, this.scorches.mesh, this.dust.points);
    scene.add(this.group);
  }

  dispose(): void {
    this.scene.remove(this.group);
    // Lights stay in the scene (see ensureEffectLights); just switch them off.
    for (const l of this.lights.lights) l.light.intensity = 0;
  }

  clearRound(): void {
    this.holes.clear();
    this.scorches.clear();
    this.add.clear();
    this.alpha.clear();
    this.smokeP.clear();
  }

  tracer(from: THREE.Vector3, to: THREE.Vector3, color: number): void {
    _c.set(color).multiplyScalar(2.2);
    this.tracers.add(from, to, _c);
  }

  muzzleLight(pos: THREE.Vector3, color = 0xffaa55, intensity = 14): void {
    this.lights.flash(pos, color, intensity, 7, 0.07);
  }

  /** Remote muzzle flash sprite burst. */
  muzzleBurst(pos: THREE.Vector3, dir: THREE.Vector3, big: boolean): void {
    const s = big ? 1.5 : 1;
    this.add.spawn(pos.x, pos.y, pos.z, { life: 0.06, size: [0.25 * s, 0.45 * s], color: [2.6, 1.7, 0.8], alpha: [1, 0] });
    for (let i = 0; i < 3; i++) {
      const k = 0.15 + i * 0.12;
      this.add.spawn(pos.x + dir.x * k, pos.y + dir.y * k, pos.z + dir.z * k, { life: 0.05, size: [0.16 * s, 0.24 * s], color: [2.4, 1.4, 0.5], alpha: [0.9, 0] });
    }
    this.muzzleLight(pos);
    this.smokeP.spawn(pos.x + dir.x * 0.2, pos.y + dir.y * 0.2, pos.z + dir.z * 0.2, {
      vel: [dir.x * 0.6, 0.3, dir.z * 0.6],
      life: 0.8,
      size: [0.15, 0.6],
      color: [0.6, 0.6, 0.62],
      alpha: [0.25, 0],
      drag: 2,
    });
  }

  impact(point: THREE.Vector3, normal: THREE.Vector3, decal = true): void {
    const n = normal;
    // sparks
    const sparks = 5 + Math.floor(Math.random() * 5);
    for (let i = 0; i < sparks; i++) {
      const sp = randRange(3, 9);
      this.add.spawn(point.x, point.y, point.z, {
        vel: [(n.x + randRange(-0.8, 0.8)) * sp, (n.y + randRange(-0.3, 1)) * sp, (n.z + randRange(-0.8, 0.8)) * sp],
        life: randRange(0.15, 0.4),
        size: [0.018, 0.008],
        color: [3, 1.9, 0.9],
        alpha: [1, 0],
        gravity: 14,
        drag: 2,
        stretch: 0.012,
      });
    }
    this.add.spawn(point.x + n.x * 0.03, point.y + n.y * 0.03, point.z + n.z * 0.03, { life: 0.07, size: [0.15, 0.25], color: [2.5, 1.8, 1.0], alpha: [0.9, 0] });
    // dust puff
    for (let i = 0; i < 3; i++) {
      this.smokeP.spawn(point.x + n.x * 0.06, point.y + n.y * 0.06, point.z + n.z * 0.06, {
        vel: [n.x * randRange(0.6, 1.6) + randRange(-0.3, 0.3), n.y * randRange(0.6, 1.6) + randRange(0, 0.4), n.z * randRange(0.6, 1.6) + randRange(-0.3, 0.3)],
        life: randRange(0.7, 1.3),
        size: [0.12, randRange(0.5, 0.8)],
        color: [0.55, 0.5, 0.46],
        alpha: [0.55, 0],
        drag: 3.5,
        rotV: randRange(-1, 1),
      });
    }
    // debris chips
    for (let i = 0; i < 4; i++) {
      const sp = randRange(2, 4);
      this.alpha.spawn(point.x, point.y, point.z, {
        vel: [(n.x + randRange(-0.6, 0.6)) * sp, (n.y + randRange(0, 1)) * sp, (n.z + randRange(-0.6, 0.6)) * sp],
        life: randRange(0.4, 0.7),
        size: [0.025, 0.02],
        color: [0.2, 0.19, 0.18],
        alpha: [1, 0.6],
        gravity: 12,
      });
    }
    if (decal) this.holes.add(point, n, randRange(0.07, 0.1));
  }

  blood(point: THREE.Vector3, dir: THREE.Vector3, head: boolean): void {
    const count = head ? 16 : 9;
    for (let i = 0; i < count; i++) {
      const sp = randRange(1, head ? 5 : 3);
      this.alpha.spawn(point.x, point.y, point.z, {
        vel: [(dir.x + randRange(-0.6, 0.6)) * sp, (dir.y + randRange(-0.2, 0.8)) * sp, (dir.z + randRange(-0.6, 0.6)) * sp],
        life: randRange(0.25, 0.55),
        size: [0.05, 0.03],
        color: [0.35, 0.01, 0.02],
        alpha: [1, 0],
        gravity: 9,
      });
    }
    for (let i = 0; i < (head ? 4 : 2); i++) {
      this.smokeP.spawn(point.x, point.y, point.z, {
        vel: [dir.x * 0.8 + randRange(-0.3, 0.3), randRange(0, 0.4), dir.z * 0.8 + randRange(-0.3, 0.3)],
        life: randRange(0.4, 0.7),
        size: [0.15, head ? 0.7 : 0.45],
        color: [0.45, 0.02, 0.03],
        alpha: [0.75, 0],
        drag: 4,
      });
    }
    if (head) {
      for (let i = 0; i < 6; i++) {
        this.add.spawn(point.x, point.y, point.z, {
          vel: [randRange(-3, 3), randRange(1, 4), randRange(-3, 3)],
          life: 0.25,
          size: [0.02, 0.01],
          color: [3, 2.5, 1.2],
          alpha: [1, 0],
          gravity: 10,
          stretch: 0.01,
        });
      }
    }
  }

  barrierHit(point: THREE.Vector3, color: number): void {
    _c.set(color);
    for (let i = 0; i < 8; i++) {
      this.add.spawn(point.x, point.y, point.z, {
        vel: [randRange(-2.5, 2.5), randRange(-2.5, 2.5), randRange(-2.5, 2.5)],
        life: randRange(0.2, 0.4),
        size: [0.04, 0.0],
        color: [_c.r * 3, _c.g * 3, _c.b * 3],
        alpha: [1, 0],
        stretch: 0.02,
      });
    }
    this.add.spawn(point.x, point.y, point.z, { life: 0.15, size: [0.3, 0.6], color: [_c.r * 2, _c.g * 2, _c.b * 2], alpha: [0.8, 0] });
  }

  explosion(pos: THREE.Vector3, radius: number, groundY: number | null): void {
    this.lights.flash(pos, 0xff9a40, 160, radius * 4.5, 0.55);
    this.add.spawn(pos.x, pos.y + 0.3, pos.z, { life: 0.14, size: [radius * 0.9, radius * 1.4], color: [4, 3, 2], alpha: [1, 0] });
    for (let i = 0; i < 10; i++) {
      this.add.spawn(pos.x + randRange(-0.6, 0.6), pos.y + randRange(0.2, 1.2), pos.z + randRange(-0.6, 0.6), {
        vel: [randRange(-2, 2), randRange(1, 4), randRange(-2, 2)],
        life: randRange(0.35, 0.6),
        size: [radius * 0.35, radius * 0.75],
        color: [3, randRange(1.1, 1.6), 0.3],
        alpha: [0.85, 0],
        drag: 4,
        rotV: randRange(-1.5, 1.5),
      });
    }
    for (let i = 0; i < 26; i++) {
      const d = new THREE.Vector3(randRange(-1, 1), randRange(-0.2, 1), randRange(-1, 1)).normalize();
      const sp = randRange(2, 7);
      this.add.spawn(pos.x, pos.y, pos.z, {
        vel: [d.x * sp, d.y * sp, d.z * sp],
        life: randRange(0.25, 0.5),
        size: [randRange(0.4, 0.8), randRange(1.2, 2.2)],
        color: [2.8, randRange(1.0, 1.6), 0.35],
        alpha: [0.9, 0],
        drag: 5,
        rotV: randRange(-2, 2),
      });
    }
    for (let i = 0; i < 60; i++) {
      const d = new THREE.Vector3(randRange(-1, 1), randRange(0, 1.2), randRange(-1, 1)).normalize();
      const sp = randRange(8, 22);
      this.add.spawn(pos.x, pos.y, pos.z, {
        vel: [d.x * sp, d.y * sp, d.z * sp],
        life: randRange(0.3, 0.9),
        size: [0.03, 0.015],
        color: [3, 2, 0.8],
        alpha: [1, 0],
        gravity: 12,
        drag: 1.2,
        stretch: 0.02,
      });
    }
    for (let i = 0; i < 18; i++) {
      this.smokeP.spawn(pos.x + randRange(-0.8, 0.8), pos.y + randRange(0, 0.8), pos.z + randRange(-0.8, 0.8), {
        vel: [randRange(-1.5, 1.5), randRange(0.5, 2.2), randRange(-1.5, 1.5)],
        life: randRange(2, 3.5),
        size: [1.0, randRange(2.4, 3.6)],
        color: [0.18, 0.16, 0.15],
        alpha: [0.75, 0],
        drag: 1.5,
        rotV: randRange(-0.5, 0.5),
      });
    }
    this.wave(pos, radius * 1.6, 0.45, 0xffb070, true);
    if (groundY !== null) this.scorches.add(new THREE.Vector3(pos.x, groundY + 0.01, pos.z), new THREE.Vector3(0, 1, 0), radius * 0.9);
  }

  flashPop(pos: THREE.Vector3): void {
    this.lights.flash(pos, 0xffffff, 220, 26, 0.35);
    this.add.spawn(pos.x, pos.y, pos.z, { life: 0.25, size: [1.5, 4], color: [6, 6, 6], alpha: [1, 0] });
    this.add.spawn(pos.x, pos.y, pos.z, { life: 0.6, size: [0.8, 2.5], color: [3, 3, 3.4], alpha: [0.6, 0] });
    for (let i = 0; i < 24; i++) {
      const sp = randRange(4, 10);
      const d = new THREE.Vector3(randRange(-1, 1), randRange(-1, 1), randRange(-1, 1)).normalize();
      this.add.spawn(pos.x, pos.y, pos.z, { vel: [d.x * sp, d.y * sp, d.z * sp], life: randRange(0.2, 0.5), size: [0.03, 0.01], color: [3, 3, 3], alpha: [1, 0], gravity: 6, stretch: 0.015 });
    }
    this.smokeP.spawn(pos.x, pos.y, pos.z, { life: 1.5, size: [0.4, 1.4], color: [0.75, 0.75, 0.78], alpha: [0.35, 0], drag: 2 });
  }

  smokePopBurst(pos: THREE.Vector3): void {
    for (let i = 0; i < 10; i++) {
      this.smokeP.spawn(pos.x, pos.y + 0.1, pos.z, {
        vel: [randRange(-3, 3), randRange(0.5, 2.5), randRange(-3, 3)],
        life: randRange(0.6, 1.2),
        size: [0.3, 1.5],
        color: [0.75, 0.77, 0.8],
        alpha: [0.6, 0],
        drag: 3,
      });
    }
  }

  pulse(pos: THREE.Vector3, radius: number, color: number): void {
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 40, 24), this.sphereMat.clone());
    (mesh.material as THREE.ShaderMaterial).uniforms.uColor.value.set(color);
    mesh.position.copy(pos);
    mesh.scale.setScalar(0.1);
    mesh.renderOrder = 30;
    this.group.add(mesh);
    this.waves.push({ mesh, t: 0, dur: 1.4, maxScale: radius });
  }

  private wave(pos: THREE.Vector3, radius: number, dur: number, color: number, flat: boolean): void {
    const mat = this.ringMat.clone();
    mat.color.set(color).multiplyScalar(2);
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
    mesh.position.copy(pos);
    if (flat) mesh.rotation.x = -Math.PI / 2;
    mesh.scale.setScalar(0.1);
    mesh.renderOrder = 25;
    this.group.add(mesh);
    this.waves.push({ mesh, t: 0, dur, maxScale: radius });
  }

  sparkle(pos: THREE.Vector3, color: [number, number, number], count = 18, speed = 3): void {
    for (let i = 0; i < count; i++) {
      const d = new THREE.Vector3(randRange(-1, 1), randRange(0, 1.5), randRange(-1, 1)).normalize();
      const sp = randRange(speed * 0.4, speed);
      this.add.spawn(pos.x, pos.y, pos.z, { vel: [d.x * sp, d.y * sp, d.z * sp], life: randRange(0.4, 0.9), size: [0.06, 0.0], color, alpha: [1, 0], gravity: 3, drag: 2 });
    }
    this.add.spawn(pos.x, pos.y, pos.z, { life: 0.3, size: [0.4, 1.2], color: [color[0] * 0.7, color[1] * 0.7, color[2] * 0.7], alpha: [0.9, 0] });
  }

  healAura(pos: THREE.Vector3): void {
    for (let i = 0; i < 3; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = randRange(0.25, 0.5);
      this.add.spawn(pos.x + Math.cos(a) * r, pos.y + randRange(0.1, 1.4), pos.z + Math.sin(a) * r, {
        vel: [0, randRange(0.6, 1.2), 0],
        life: randRange(0.6, 1),
        size: [0.06, 0.02],
        color: [0.4, 2.4, 0.9],
        alpha: [0.9, 0],
      });
    }
  }

  dashTrail(pos: THREE.Vector3, vel: THREE.Vector3, color: [number, number, number]): void {
    for (let i = 0; i < 3; i++) {
      this.add.spawn(pos.x + randRange(-0.2, 0.2), pos.y + randRange(0.2, 1.6), pos.z + randRange(-0.2, 0.2), {
        vel: [-vel.x * 0.1, 0, -vel.z * 0.1],
        life: 0.3,
        size: [0.05, 0.02],
        color,
        alpha: [0.8, 0],
        stretch: 0.06,
      });
    }
  }

  speedLine(pos: THREE.Vector3, color: [number, number, number]): void {
    this.add.spawn(pos.x, pos.y, pos.z, { life: 0.5, size: [0.05, 0.0], color, alpha: [0.6, 0], vel: [0, 0.6, 0] });
  }

  update(dt: number, camPos?: THREE.Vector3): void {
    this.time += dt;
    if (camPos) this.dust.update(camPos, this.time);
    this.add.update(dt);
    this.alpha.update(dt);
    this.smokeP.update(dt);
    this.tracers.update(dt);
    this.lights.update(dt);
    for (let i = this.waves.length - 1; i >= 0; i--) {
      const w = this.waves[i];
      w.t += dt;
      const k = Math.min(1, w.t / w.dur);
      const e = 1 - Math.pow(1 - k, 3);
      w.mesh.scale.setScalar(Math.max(0.01, e * w.maxScale));
      const m = w.mesh.material as THREE.MeshBasicMaterial | THREE.ShaderMaterial;
      if ((m as THREE.ShaderMaterial).uniforms) (m as THREE.ShaderMaterial).uniforms.uAlpha.value = 1 - k;
      else (m as THREE.MeshBasicMaterial).opacity = 1 - k;
      if (k >= 1) {
        this.group.remove(w.mesh);
        w.mesh.geometry.dispose();
        (w.mesh.material as THREE.Material).dispose();
        this.waves.splice(i, 1);
      }
    }
  }
}

const _c = new THREE.Color();

import * as THREE from 'three';

export interface ColliderBox {
  id: number;
  min: THREE.Vector3;
  max: THREE.Vector3;
  blocksMove: boolean;
  blocksBullets: boolean;
  enabled: boolean;
  /** Free-form tag: 'world', 'barrier', 'spawnwall'. */
  tag: string;
  /** Optional owner reference (e.g. barrier id). */
  ref?: string;
}

export interface RayHit {
  dist: number;
  point: THREE.Vector3;
  normal: THREE.Vector3;
  box: ColliderBox;
}

export interface BodyState {
  /** Feet center position. */
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  radius: number;
  height: number;
  onGround: boolean;
  /** Accumulated vertical snap (step up/down) used to smooth the camera. */
  stepOffset: number;
}

const EPS = 1e-4;

export class CollisionWorld {
  readonly boxes: ColliderBox[] = [];
  private nextId = 1;

  add(min: THREE.Vector3, max: THREE.Vector3, opts: Partial<Omit<ColliderBox, 'id' | 'min' | 'max'>> = {}): ColliderBox {
    const box: ColliderBox = {
      id: this.nextId++,
      min: min.clone(),
      max: max.clone(),
      blocksMove: opts.blocksMove ?? true,
      blocksBullets: opts.blocksBullets ?? true,
      enabled: opts.enabled ?? true,
      tag: opts.tag ?? 'world',
      ref: opts.ref,
    };
    this.boxes.push(box);
    return box;
  }

  remove(box: ColliderBox): void {
    const i = this.boxes.indexOf(box);
    if (i >= 0) this.boxes.splice(i, 1);
  }

  removeByRef(ref: string): void {
    for (let i = this.boxes.length - 1; i >= 0; i--) if (this.boxes[i].ref === ref) this.boxes.splice(i, 1);
  }

  // ---------------------------------------------------------------------------
  // Character movement (axis separated AABB sweep with step-up / ground snap)
  // ---------------------------------------------------------------------------

  overlapsBody(pos: THREE.Vector3, radius: number, height: number, ignoreTag?: string): ColliderBox | null {
    for (const b of this.boxes) {
      if (!b.enabled || !b.blocksMove || b.tag === ignoreTag) continue;
      if (
        pos.x - radius < b.max.x - EPS &&
        pos.x + radius > b.min.x + EPS &&
        pos.y < b.max.y - EPS &&
        pos.y + height > b.min.y + EPS &&
        pos.z - radius < b.max.z - EPS &&
        pos.z + radius > b.min.z + EPS
      )
        return b;
    }
    return null;
  }

  moveBody(body: BodyState, dt: number, stepHeight: number): { hitWall: boolean; hitCeiling: boolean; landed: number } {
    const wasGrounded = body.onGround;
    const disp = _disp.copy(body.vel).multiplyScalar(dt);
    const steps = Math.min(24, Math.max(1, Math.ceil(Math.max(Math.abs(disp.x), Math.abs(disp.y), Math.abs(disp.z)) / 0.18)));
    disp.divideScalar(steps);
    let hitWall = false;
    let hitCeiling = false;
    let landed = 0;
    const fallSpeed = -body.vel.y;
    body.onGround = false;
    for (let i = 0; i < steps; i++) {
      if (this.slideHorizontal(body, 'x', disp.x, wasGrounded || body.onGround, stepHeight)) hitWall = true;
      if (this.slideHorizontal(body, 'z', disp.z, wasGrounded || body.onGround, stepHeight)) hitWall = true;
      const v = this.slideVertical(body, disp.y);
      if (v === 1) hitCeiling = true;
      if (v === -1 && !wasGrounded) landed = Math.max(landed, fallSpeed);
    }
    // Ground snapping so walking down stairs does not turn into small falls.
    if (!body.onGround && wasGrounded && body.vel.y <= 0.01) {
      const top = this.groundBelow(body.pos, body.radius, stepHeight + 0.05);
      if (top !== null) {
        const drop = body.pos.y - top;
        body.pos.y = top;
        body.stepOffset += drop;
        body.onGround = true;
        body.vel.y = 0;
      }
    }
    if (!body.onGround && body.vel.y <= 0) {
      // Touching ground without moving vertically this frame.
      const top = this.groundBelow(body.pos, body.radius, 0.02);
      if (top !== null) {
        body.pos.y = top;
        body.onGround = true;
        body.vel.y = 0;
      }
    }
    return { hitWall, hitCeiling, landed };
  }

  private slideHorizontal(body: BodyState, axis: 'x' | 'z', amount: number, canStep: boolean, stepHeight: number): boolean {
    if (amount === 0) return false;
    const p = body.pos;
    p[axis] += amount;
    let hit = false;
    for (const b of this.boxes) {
      if (!b.enabled || !b.blocksMove) continue;
      if (!this.boxOverlap(p, body.radius, body.height, b)) continue;
      if (canStep) {
        const rise = b.max.y - p.y;
        if (rise > 0 && rise <= stepHeight) {
          const oldY = p.y;
          p.y = b.max.y + EPS;
          if (!this.overlapsBody(p, body.radius, body.height)) {
            body.stepOffset -= p.y - oldY;
            continue;
          }
          p.y = oldY;
        }
      }
      if (amount > 0) p[axis] = b.min[axis] - body.radius - EPS * 2;
      else p[axis] = b.max[axis] + body.radius + EPS * 2;
      body.vel[axis] = 0;
      hit = true;
    }
    return hit;
  }

  /** Returns -1 when landing on something, 1 when bumping a ceiling, 0 otherwise. */
  private slideVertical(body: BodyState, amount: number): number {
    if (amount === 0) {
      return 0;
    }
    const p = body.pos;
    p.y += amount;
    let res = 0;
    for (const b of this.boxes) {
      if (!b.enabled || !b.blocksMove) continue;
      if (!this.boxOverlap(p, body.radius, body.height, b)) continue;
      if (amount < 0) {
        p.y = b.max.y;
        if (body.vel.y < 0) body.vel.y = 0;
        body.onGround = true;
        res = -1;
      } else {
        p.y = b.min.y - body.height - EPS;
        if (body.vel.y > 0) body.vel.y = 0;
        res = 1;
      }
    }
    return res;
  }

  private boxOverlap(p: THREE.Vector3, r: number, h: number, b: ColliderBox): boolean {
    return (
      p.x - r < b.max.x - EPS &&
      p.x + r > b.min.x + EPS &&
      p.y < b.max.y - EPS &&
      p.y + h > b.min.y + EPS &&
      p.z - r < b.max.z - EPS &&
      p.z + r > b.min.z + EPS
    );
  }

  /** Highest walkable surface under the body within `maxDrop`, or null. */
  groundBelow(pos: THREE.Vector3, radius: number, maxDrop: number): number | null {
    let best: number | null = null;
    for (const b of this.boxes) {
      if (!b.enabled || !b.blocksMove) continue;
      if (pos.x - radius >= b.max.x - EPS || pos.x + radius <= b.min.x + EPS) continue;
      if (pos.z - radius >= b.max.z - EPS || pos.z + radius <= b.min.z + EPS) continue;
      const top = b.max.y;
      if (top <= pos.y + EPS && pos.y - top <= maxDrop) {
        if (best === null || top > best) best = top;
      }
    }
    return best;
  }

  /** Room above the body for standing up. */
  canStand(pos: THREE.Vector3, radius: number, height: number): boolean {
    return !this.overlapsBody(pos, radius, height);
  }

  // ---------------------------------------------------------------------------
  // Ray queries
  // ---------------------------------------------------------------------------

  raycast(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number, forBullets = true, out?: RayHit): RayHit | null {
    let best = maxDist;
    let bestBox: ColliderBox | null = null;
    let bestAxis = 0;
    const ix = 1 / (dir.x || 1e-12);
    const iy = 1 / (dir.y || 1e-12);
    const iz = 1 / (dir.z || 1e-12);
    for (const b of this.boxes) {
      if (!b.enabled) continue;
      if (forBullets ? !b.blocksBullets : !b.blocksMove) continue;
      let t1 = (b.min.x - origin.x) * ix;
      let t2 = (b.max.x - origin.x) * ix;
      let tmin = Math.min(t1, t2);
      let tmax = Math.max(t1, t2);
      let axis = 0;
      t1 = (b.min.y - origin.y) * iy;
      t2 = (b.max.y - origin.y) * iy;
      const tymin = Math.min(t1, t2);
      tmax = Math.min(tmax, Math.max(t1, t2));
      if (tymin > tmin) {
        tmin = tymin;
        axis = 1;
      }
      t1 = (b.min.z - origin.z) * iz;
      t2 = (b.max.z - origin.z) * iz;
      const tzmin = Math.min(t1, t2);
      tmax = Math.min(tmax, Math.max(t1, t2));
      if (tzmin > tmin) {
        tmin = tzmin;
        axis = 2;
      }
      if (tmax < tmin || tmax < 0) continue;
      // Rays starting inside a box ignore it (prevents self-blocking at spawn edges).
      if (tmin < 0) continue;
      if (tmin < best) {
        best = tmin;
        bestBox = b;
        bestAxis = axis;
      }
    }
    if (!bestBox) return null;
    const hit = out ?? { dist: 0, point: new THREE.Vector3(), normal: new THREE.Vector3(), box: bestBox };
    hit.dist = best;
    hit.box = bestBox;
    hit.point.copy(origin).addScaledVector(dir, best);
    hit.normal.set(0, 0, 0);
    const d = bestAxis === 0 ? dir.x : bestAxis === 1 ? dir.y : dir.z;
    hit.normal.setComponent(bestAxis, d > 0 ? -1 : 1);
    return hit;
  }

  /** True when the straight segment a→b is not blocked by bullet-blocking geometry. */
  lineOfSight(a: THREE.Vector3, b: THREE.Vector3): boolean {
    _dir.subVectors(b, a);
    const len = _dir.length();
    if (len < 1e-4) return true;
    _dir.divideScalar(len);
    return this.raycast(a, _dir, len - 0.02, true, _hit) === null;
  }

  // ---------------------------------------------------------------------------
  // Small bouncing projectiles (grenades). Deterministic for identical inputs.
  // ---------------------------------------------------------------------------

  stepProjectile(pos: THREE.Vector3, vel: THREE.Vector3, r: number, dt: number, restitution: number, friction: number): { bounced: boolean; speed: number; grounded: boolean } {
    let bounced = false;
    let impactSpeed = 0;
    let grounded = false;
    for (const axis of AXES) {
      const amt = vel[axis] * dt;
      if (amt === 0) continue;
      pos[axis] += amt;
      for (const b of this.boxes) {
        if (!b.enabled || !b.blocksMove) continue;
        if (
          pos.x - r < b.max.x &&
          pos.x + r > b.min.x &&
          pos.y - r < b.max.y &&
          pos.y + r > b.min.y &&
          pos.z - r < b.max.z &&
          pos.z + r > b.min.z
        ) {
          pos[axis] = amt > 0 ? b.min[axis] - r - EPS : b.max[axis] + r + EPS;
          impactSpeed = Math.max(impactSpeed, Math.abs(vel[axis]));
          vel[axis] = -vel[axis] * restitution;
          for (const o of AXES) if (o !== axis) vel[o] *= friction;
          bounced = true;
          if (axis === 'y' && amt < 0) grounded = true;
        }
      }
    }
    return { bounced, speed: impactSpeed, grounded };
  }

  pointInside(p: THREE.Vector3): boolean {
    for (const b of this.boxes) {
      if (!b.enabled || !b.blocksMove) continue;
      if (p.x > b.min.x && p.x < b.max.x && p.y > b.min.y && p.y < b.max.y && p.z > b.min.z && p.z < b.max.z) return true;
    }
    return false;
  }
}

const AXES = ['x', 'y', 'z'] as const;
const _disp = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _hit: RayHit = { dist: 0, point: new THREE.Vector3(), normal: new THREE.Vector3(), box: null as unknown as ColliderBox };

// -----------------------------------------------------------------------------
// Analytic primitives for player hitboxes
// -----------------------------------------------------------------------------

/** Ray vs sphere. Returns distance or -1. */
export function raySphere(o: THREE.Vector3, d: THREE.Vector3, c: THREE.Vector3, r: number): number {
  const ox = o.x - c.x;
  const oy = o.y - c.y;
  const oz = o.z - c.z;
  const b = ox * d.x + oy * d.y + oz * d.z;
  const cc = ox * ox + oy * oy + oz * oz - r * r;
  const disc = b * b - cc;
  if (disc < 0) return -1;
  const s = Math.sqrt(disc);
  const t = -b - s;
  if (t >= 0) return t;
  const t2 = -b + s;
  return t2 >= 0 ? 0 : -1;
}

/** Ray vs capsule defined by segment a-b and radius r. Returns distance or -1. */
export function rayCapsule(o: THREE.Vector3, d: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3, r: number): number {
  const ba = _ba.subVectors(b, a);
  const oa = _oa.subVectors(o, a);
  const baba = ba.dot(ba);
  const bard = ba.dot(d);
  const baoa = ba.dot(oa);
  const rdoa = d.dot(oa);
  const oaoa = oa.dot(oa);
  const aa = baba - bard * bard;
  const bb = baba * rdoa - baoa * bard;
  const cc = baba * oaoa - baoa * baoa - r * r * baba;
  const h = bb * bb - aa * cc;
  if (h >= 0) {
    const t = (-bb - Math.sqrt(h)) / aa;
    const y = baoa + t * bard;
    if (y > 0 && y < baba && t >= 0) return t;
    // caps
    const oc = y <= 0 ? oa : _oc.subVectors(o, b);
    const b2 = d.dot(oc);
    const c2 = oc.dot(oc) - r * r;
    const h2 = b2 * b2 - c2;
    if (h2 > 0) {
      const t2 = -b2 - Math.sqrt(h2);
      if (t2 >= 0) return t2;
    }
  }
  return -1;
}
const _ba = new THREE.Vector3();
const _oa = new THREE.Vector3();
const _oc = new THREE.Vector3();

/** Ray vs sphere for vision blocking (smoke). Returns true if the segment of length `len` passes through. */
export function segmentHitsSphere(o: THREE.Vector3, d: THREE.Vector3, len: number, c: THREE.Vector3, r: number): boolean {
  const ox = c.x - o.x;
  const oy = c.y - o.y;
  const oz = c.z - o.z;
  const t = Math.max(0, Math.min(len, ox * d.x + oy * d.y + oz * d.z));
  const px = o.x + d.x * t - c.x;
  const py = o.y + d.y * t - c.y;
  const pz = o.z + d.z * t - c.z;
  return px * px + py * py + pz * pz < r * r;
}

import * as THREE from 'three';
import type { CollisionWorld } from '../world/collision';
import type { ThrowMsg } from '../net/protocol';
import { buildGrenade } from './gunModels';
import { stat } from './abilities';

export interface Grenade {
  msg: ThrowMsg;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  mesh: THREE.Group;
  age: number;
  restTime: number;
  done: boolean;
  acc: number;
}

export const GRENADE_GRAVITY = 17;
export const THROW_SPEED = 17.5;
const STEP = 1 / 120;
const FUSE: Record<'frag' | 'smoke', number> = { frag: 1.5, smoke: 2.4 };
const SUB_FUSE = 0.75;

function fuseOf(m: ThrowMsg): number {
  if (m.sub) return SUB_FUSE;
  return m.kind === 'flash' ? stat('flash', 'fuse', m.tier) : FUSE[m.kind];
}

/** Awakened frags burst into bomblets. Directions derive from the throw id so every simulation agrees. */
function bomblets(g: Grenade): ThrowMsg[] {
  const m = g.msg;
  const n = m.kind === 'frag' && !m.sub ? stat('frag', 'bomblets', m.tier) : 0;
  let hash = 0;
  for (let i = 0; i < m.gid.length; i++) hash = (hash * 31 + m.gid.charCodeAt(i)) >>> 0;
  const base = ((hash % 360) * Math.PI) / 180;
  const out: ThrowMsg[] = [];
  for (let i = 0; i < n; i++) {
    const a = base + (i / n) * Math.PI * 2;
    out.push({ ...m, gid: `${m.gid}:${i}`, pos: [g.pos.x, g.pos.y + 0.15, g.pos.z], vel: [Math.sin(a) * 5.5, 5, Math.cos(a) * 5.5], sub: true });
  }
  return out;
}

/**
 * Deterministic grenade simulation (fixed timestep). Every client — and the host —
 * simulates the same throw from the same initial state, so detonation positions
 * agree without streaming projectile positions.
 */
export class ProjectileSystem {
  readonly list: Grenade[] = [];

  constructor(
    private scene: THREE.Scene | null,
    private world: CollisionWorld,
  ) {}

  spawn(msg: ThrowMsg): Grenade {
    const mesh = buildGrenade(msg.kind);
    if (msg.sub) mesh.scale.setScalar(0.7);
    const g: Grenade = {
      msg,
      pos: new THREE.Vector3(...msg.pos),
      vel: new THREE.Vector3(...msg.vel),
      mesh,
      age: 0,
      restTime: 0,
      done: false,
      acc: 0,
    };
    mesh.position.copy(g.pos);
    this.scene?.add(mesh);
    this.list.push(g);
    return g;
  }

  clear(): void {
    for (const g of this.list) this.scene?.remove(g.mesh);
    this.list.length = 0;
  }

  update(dt: number, onDetonate: (g: Grenade) => void, onBounce?: (g: Grenade, speed: number) => void): void {
    const spawned: ThrowMsg[] = [];
    for (const g of this.list) {
      if (g.done) continue;
      g.acc += Math.min(dt, 0.1);
      while (g.acc >= STEP && !g.done) {
        g.acc -= STEP;
        g.age += STEP;
        g.vel.y -= GRENADE_GRAVITY * STEP;
        const res = this.world.stepProjectile(g.pos, g.vel, 0.06, STEP, 0.36, 0.7);
        if (res.bounced && res.speed > 1.5) onBounce?.(g, res.speed);
        if (res.grounded) {
          // rolling resistance
          const k = Math.exp(-4 * STEP);
          g.vel.x *= k;
          g.vel.z *= k;
        }
        const speed = g.vel.length();
        g.restTime = speed < 0.6 && res.grounded ? g.restTime + STEP : g.restTime;
        const smokeReady = g.msg.kind === 'smoke' && g.restTime > 0.15;
        if (g.age >= fuseOf(g.msg) || smokeReady) {
          g.done = true;
          onDetonate(g);
          spawned.push(...bomblets(g));
        }
      }
      g.mesh.position.copy(g.pos);
      const sp = g.vel.length();
      g.mesh.rotation.x += sp * dt * 2.2;
      g.mesh.rotation.z += sp * dt * 1.3;
    }
    for (let i = this.list.length - 1; i >= 0; i--) {
      if (this.list[i].done) {
        this.scene?.remove(this.list[i].mesh);
        this.list.splice(i, 1);
      }
    }
    for (const m of spawned) this.spawn(m);
  }
}

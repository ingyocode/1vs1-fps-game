import * as THREE from 'three';
import type { CollisionWorld } from '../world/collision';
import type { ThrowMsg } from '../net/protocol';
import { buildGrenade } from './gunModels';

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
const FUSE: Record<ThrowMsg['kind'], number> = { flash: 0.82, frag: 1.5, smoke: 2.4 };

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
        const fuse = FUSE[g.msg.kind];
        const smokeReady = g.msg.kind === 'smoke' && g.restTime > 0.15;
        if (g.age >= fuse || smokeReady) {
          g.done = true;
          onDetonate(g);
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
  }
}

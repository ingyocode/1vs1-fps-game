import * as THREE from 'three';
import type { HitZone } from '../core/config';
import { lerp } from '../core/utils';
import { rayCapsule, raySphere } from '../world/collision';

/** Analytic hit volumes for one player. Shared by clients (shooting) and the host (bots, frags). */
export class Hitbox {
  readonly head = new THREE.Vector3();
  headR = 0.16;
  readonly torsoA = new THREE.Vector3();
  readonly torsoB = new THREE.Vector3();
  torsoR = 0.27;
  readonly legsA = new THREE.Vector3();
  readonly legsB = new THREE.Vector3();
  legsR = 0.2;
  readonly center = new THREE.Vector3();

  /** pos = feet, crouch 0..1, yaw for slight forward head offset. */
  update(pos: THREE.Vector3, yaw: number, crouch: number): this {
    const fx = -Math.sin(yaw) * 0.04;
    const fz = -Math.cos(yaw) * 0.04;
    const headY = lerp(1.6, 1.06, crouch);
    this.head.set(pos.x + fx, pos.y + headY, pos.z + fz);
    this.torsoA.set(pos.x, pos.y + lerp(0.98, 0.62, crouch), pos.z);
    this.torsoB.set(pos.x, pos.y + lerp(1.36, 0.86, crouch), pos.z);
    this.legsA.set(pos.x, pos.y + 0.14, pos.z);
    this.legsB.set(pos.x, pos.y + lerp(0.86, 0.5, crouch), pos.z);
    this.center.set(pos.x, pos.y + lerp(1.0, 0.7, crouch), pos.z);
    return this;
  }

  /** Nearest intersection along a ray. */
  trace(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number): { dist: number; zone: HitZone } | null {
    let best = maxDist;
    let zone: HitZone | null = null;
    const th = raySphere(origin, dir, this.head, this.headR);
    if (th >= 0 && th < best) {
      best = th;
      zone = 'head';
    }
    const tt = rayCapsule(origin, dir, this.torsoA, this.torsoB, this.torsoR);
    if (tt >= 0 && tt < best) {
      best = tt;
      zone = 'body';
    }
    const tl = rayCapsule(origin, dir, this.legsA, this.legsB, this.legsR);
    if (tl >= 0 && tl < best) {
      best = tl;
      zone = 'legs';
    }
    return zone ? { dist: best, zone } : null;
  }

  /** Points used for explosion / visibility line-of-sight tests. */
  samplePoints(): THREE.Vector3[] {
    return [this.head, this.center, this.legsA.clone().setY(this.legsA.y + 0.3)];
  }
}

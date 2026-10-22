import * as THREE from 'three';
import type { HitZone } from '../core/config';
import { lerp } from '../core/utils';
import { rayCapsule, raySphere } from '../world/collision';
import type { WeaponId } from './weapons';

type Seg = { a: [number, number, number]; b: [number, number, number]; r: number };

/**
 * Arm segments in "aim space" (origin at the upper chest, -Z forward, +X right):
 * shoulder → elbow → hand, taken from the solved IK of the third-person rig in avatar.ts.
 * Long guns: bladed stance, gun hand on the grip, support hand far out on the handguard.
 */
const LONG_POSE: Seg[] = [
  { a: [0.175, 0.01, 0.074], b: [0.277, -0.225, -0.083], r: 0.055 },
  { a: [0.277, -0.225, -0.083], b: [0.13, -0.01, -0.252], r: 0.045 },
  { a: [-0.175, 0.01, -0.074], b: [-0.063, -0.046, -0.347], r: 0.055 },
  { a: [-0.063, -0.046, -0.347], b: [0.13, 0.043, -0.572], r: 0.045 },
];
/** Handguns (and the knife): square stance, both hands together in front of the chest. */
const SHORT_POSE: Seg[] = [
  { a: [0.19, 0.01, 0], b: [0.172, -0.192, -0.221], r: 0.055 },
  { a: [0.172, -0.192, -0.221], b: [0, -0.042, -0.431], r: 0.045 },
  { a: [-0.19, 0.01, 0], b: [-0.215, -0.184, -0.227], r: 0.055 },
  { a: [-0.215, -0.184, -0.227], b: [-0.014, -0.058, -0.427], r: 0.045 },
];

/** Analytic hit volumes for one player. Shared by clients (shooting) and the host (bots, frags). */
export class Hitbox {
  readonly head = new THREE.Vector3();
  headR = 0.16;
  readonly torsoA = new THREE.Vector3();
  readonly torsoB = new THREE.Vector3();
  torsoR = 0.25;
  readonly legsA = new THREE.Vector3();
  readonly legsB = new THREE.Vector3();
  legsR = 0.2;
  /** Upper arms and forearms (pairs of capsule end points). */
  readonly arms = LONG_POSE.map((s) => ({ a: new THREE.Vector3(), b: new THREE.Vector3(), r: s.r }));
  readonly center = new THREE.Vector3();

  /** pos = feet, crouch 0..1, yaw for slight forward head offset, pitch raises/lowers the arms, weapon picks the arm pose. */
  update(pos: THREE.Vector3, yaw: number, crouch: number, pitch = 0, weapon: WeaponId = 'rifle'): this {
    const sy = Math.sin(yaw);
    const cy = Math.cos(yaw);
    const fx = -sy * 0.04;
    const fz = -cy * 0.04;
    const headY = lerp(1.6, 1.06, crouch);
    this.head.set(pos.x + fx, pos.y + headY, pos.z + fz);
    this.torsoA.set(pos.x, pos.y + lerp(0.98, 0.62, crouch), pos.z);
    this.torsoB.set(pos.x, pos.y + lerp(1.36, 0.86, crouch), pos.z);
    this.legsA.set(pos.x, pos.y + 0.14, pos.z);
    this.legsB.set(pos.x, pos.y + lerp(0.86, 0.5, crouch), pos.z);
    this.center.set(pos.x, pos.y + lerp(1.0, 0.7, crouch), pos.z);
    // Arms follow the weapon: pitch about the shoulder line, then yaw.
    const aimY = pos.y + lerp(1.43, 0.93, crouch);
    const ap = Math.max(-1.2, Math.min(1.2, pitch)) * 0.9;
    const sp = Math.sin(ap);
    const cp = Math.cos(ap);
    const toWorld = (l: [number, number, number], out: THREE.Vector3): void => {
      // rotate about X (pitch), then about Y (yaw)
      const y = l[1] * cp - l[2] * sp;
      const z = l[1] * sp + l[2] * cp;
      out.set(pos.x + l[0] * cy + z * sy, aimY + y, pos.z - l[0] * sy + z * cy);
    };
    const pose = weapon === 'pistol' || weapon === 'magnum' || weapon === 'knife' ? SHORT_POSE : LONG_POSE;
    pose.forEach((s, i) => {
      toWorld(s.a, this.arms[i].a);
      toWorld(s.b, this.arms[i].b);
    });
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
    for (const arm of this.arms) {
      const ta = rayCapsule(origin, dir, arm.a, arm.b, arm.r);
      if (ta >= 0 && ta < best) {
        best = ta;
        zone = 'arms';
      }
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

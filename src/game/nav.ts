import * as THREE from 'three';
import type { CollisionWorld } from '../world/collision';
import { CharacterMotor } from './movement';

/**
 * Waypoint graph for bots. Edges are discovered by actually simulating the
 * character controller between node pairs, so stairs, drops and obstacles are
 * handled exactly like a player would experience them (edges are directional).
 */
export class NavGraph {
  readonly nodes: THREE.Vector3[];
  readonly edges: number[][];

  constructor(nodes: THREE.Vector3[], world: CollisionWorld) {
    this.nodes = nodes;
    this.edges = nodes.map(() => []);
    const motor = new CharacterMotor();
    const eyeA = new THREE.Vector3();
    const eyeB = new THREE.Vector3();
    for (let i = 0; i < nodes.length; i++) {
      for (let j = 0; j < nodes.length; j++) {
        if (i === j) continue;
        const a = nodes[i];
        const b = nodes[j];
        const d = Math.hypot(a.x - b.x, a.z - b.z);
        if (d > 13) continue;
        eyeA.set(a.x, a.y + 0.9, a.z);
        eyeB.set(b.x, b.y + 0.9, b.z);
        if (!world.lineOfSight(eyeA, eyeB)) continue;
        if (this.walkable(motor, a, b, world)) this.edges[i].push(j);
      }
    }
  }

  private walkable(motor: CharacterMotor, a: THREE.Vector3, b: THREE.Vector3, world: CollisionWorld): boolean {
    motor.teleport(a);
    const dt = 1 / 30;
    const dist = Math.hypot(a.x - b.x, a.z - b.z);
    const maxSteps = Math.ceil((dist / 5.5) * 30 * 1.6) + 10;
    for (let s = 0; s < maxSteps; s++) {
      const p = motor.body.pos;
      const dx = b.x - p.x;
      const dz = b.z - p.z;
      const rem = Math.hypot(dx, dz);
      if (rem < 0.45) return Math.abs(p.y - b.y) < 0.6;
      const yaw = Math.atan2(-dx, -dz);
      motor.step({ forward: 1, right: 0, jump: false, crouch: false, walk: false, yaw }, dt, world, 1);
      if (p.y < b.y - 1.5 && b.y > a.y) return false;
    }
    return false;
  }

  nearest(pos: THREE.Vector3, world?: CollisionWorld): number {
    let best = -1;
    let bestD = Infinity;
    const eye = new THREE.Vector3(pos.x, pos.y + 0.9, pos.z);
    const tmp = new THREE.Vector3();
    for (let i = 0; i < this.nodes.length; i++) {
      const n = this.nodes[i];
      const d = n.distanceToSquared(pos) + Math.abs(n.y - pos.y) * 20;
      if (d < bestD) {
        if (world) {
          tmp.set(n.x, n.y + 0.9, n.z);
          if (!world.lineOfSight(eye, tmp)) continue;
        }
        bestD = d;
        best = i;
      }
    }
    if (best < 0 && world) return this.nearest(pos);
    return best;
  }

  /** A* over the waypoint graph. Returns node indices (excluding start). */
  path(from: number, to: number): number[] {
    if (from < 0 || to < 0) return [];
    if (from === to) return [to];
    const n = this.nodes.length;
    const g = new Float32Array(n).fill(Infinity);
    const f = new Float32Array(n).fill(Infinity);
    const came = new Int32Array(n).fill(-1);
    const open = new Set<number>([from]);
    const closed = new Uint8Array(n);
    g[from] = 0;
    f[from] = this.nodes[from].distanceTo(this.nodes[to]);
    while (open.size) {
      let cur = -1;
      let bf = Infinity;
      for (const o of open) {
        if (f[o] < bf) {
          bf = f[o];
          cur = o;
        }
      }
      if (cur === to) break;
      open.delete(cur);
      closed[cur] = 1;
      for (const nb of this.edges[cur]) {
        if (closed[nb]) continue;
        const cost = g[cur] + this.nodes[cur].distanceTo(this.nodes[nb]) * (0.9 + Math.random() * 0.2);
        if (cost < g[nb]) {
          g[nb] = cost;
          f[nb] = cost + this.nodes[nb].distanceTo(this.nodes[to]);
          came[nb] = cur;
          open.add(nb);
        }
      }
    }
    if (came[to] < 0) return [];
    const out: number[] = [];
    let c = to;
    while (c !== from && c >= 0) {
      out.push(c);
      c = came[c];
    }
    return out.reverse();
  }
}

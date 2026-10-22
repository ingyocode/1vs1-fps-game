import * as THREE from 'three';
import { PLAYER } from '../core/config';
import { lerp } from '../core/utils';
import type { BodyState, CollisionWorld } from '../world/collision';

export interface MoveInput {
  forward: number;
  right: number;
  jump: boolean;
  crouch: boolean;
  walk: boolean;
  yaw: number;
}

export interface MoveEvents {
  jumped: boolean;
  landed: number;
  footstep: boolean;
  hitCeiling: boolean;
}

const _wish = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();

/**
 * Shared character controller used by the local player and bots.
 * Quake-style acceleration/friction, crouch-jumping, step-up and dashes.
 */
export class CharacterMotor {
  readonly body: BodyState;
  /** 0 = standing, 1 = fully crouched (smoothed). */
  crouch = 0;
  dashTime = 0;
  readonly dashVel = new THREE.Vector3();
  private strideAcc = 0;
  private jumpBuffer = 0;
  private coyote = 0;
  airTime = 0;

  constructor(pos = new THREE.Vector3()) {
    this.body = {
      pos: pos.clone(),
      vel: new THREE.Vector3(),
      radius: PLAYER.radius,
      height: PLAYER.heightStand,
      onGround: false,
      stepOffset: 0,
    };
  }

  teleport(pos: THREE.Vector3): void {
    this.body.pos.copy(pos);
    this.body.vel.set(0, 0, 0);
    this.body.stepOffset = 0;
    this.body.onGround = true;
    this.crouch = 0;
    this.body.height = PLAYER.heightStand;
    this.dashTime = 0;
    this.airTime = 0;
  }

  get eyeHeight(): number {
    return lerp(PLAYER.eyeStand, PLAYER.eyeCrouch, this.crouch);
  }

  get speed2D(): number {
    return Math.hypot(this.body.vel.x, this.body.vel.z);
  }

  startDash(dirX: number, dirZ: number, distance: number): void {
    const len = Math.hypot(dirX, dirZ) || 1;
    const dur = 0.17;
    this.dashTime = dur;
    this.dashVel.set((dirX / len) * (distance / dur), 0, (dirZ / len) * (distance / dur));
    this.body.vel.y = Math.max(this.body.vel.y, 1.2);
  }

  step(input: MoveInput, dt: number, world: CollisionWorld, speedMult: number, frozen = false): MoveEvents {
    const b = this.body;
    const ev: MoveEvents = { jumped: false, landed: 0, footstep: false, hitCeiling: false };

    // --- crouch ---------------------------------------------------------
    const wantCrouch = input.crouch && !frozen;
    const target = wantCrouch ? 1 : 0;
    if (target !== this.crouch) {
      const prevH = b.height;
      let next = this.crouch + Math.sign(target - this.crouch) * dt * 7.5;
      next = target > this.crouch ? Math.min(target, next) : Math.max(target, next);
      const nextH = lerp(PLAYER.heightStand, PLAYER.heightCrouch, next);
      if (nextH > prevH) {
        // Standing up needs head room (in air we can also extend the legs down).
        const testPos = b.pos.clone();
        if (!b.onGround) testPos.y -= nextH - prevH;
        if (world.canStand(testPos, b.radius, nextH, b)) {
          if (!b.onGround) b.pos.y = testPos.y;
          this.crouch = next;
          b.height = nextH;
        }
      } else {
        // Crouching mid-air tucks the legs up (crouch-jump).
        if (!b.onGround) b.pos.y += prevH - nextH;
        this.crouch = next;
        b.height = nextH;
      }
    }

    // --- wish direction ---------------------------------------------------
    _fwd.set(-Math.sin(input.yaw), 0, -Math.cos(input.yaw));
    _right.set(Math.cos(input.yaw), 0, -Math.sin(input.yaw));
    _wish.set(0, 0, 0);
    if (!frozen) _wish.addScaledVector(_fwd, input.forward).addScaledVector(_right, input.right);
    const wishLen = _wish.length();
    if (wishLen > 1e-3) _wish.divideScalar(wishLen);
    let maxSpeed = PLAYER.runSpeed * speedMult;
    if (input.walk) maxSpeed *= PLAYER.walkMult;
    if (this.crouch > 0.5 && b.onGround) maxSpeed *= PLAYER.crouchMult;
    const wishSpeed = wishLen > 1e-3 ? maxSpeed : 0;

    // --- jump buffering / coyote time ---------------------------------------
    this.jumpBuffer = input.jump && !frozen ? 0.12 : Math.max(0, this.jumpBuffer - dt);
    this.coyote = b.onGround ? 0.08 : Math.max(0, this.coyote - dt);

    if (this.dashTime > 0) {
      this.dashTime -= dt;
      b.vel.x = this.dashVel.x;
      b.vel.z = this.dashVel.z;
      b.vel.y -= PLAYER.gravity * 0.35 * dt;
      if (this.dashTime <= 0) {
        b.vel.x *= 0.32;
        b.vel.z *= 0.32;
      }
    } else if (b.onGround) {
      // friction
      const speed = Math.hypot(b.vel.x, b.vel.z);
      if (speed > 0) {
        const drop = Math.max(speed, 2.2) * PLAYER.friction * dt;
        const ns = Math.max(0, speed - drop) / speed;
        b.vel.x *= ns;
        b.vel.z *= ns;
      }
      // accelerate
      const cur = b.vel.x * _wish.x + b.vel.z * _wish.z;
      const add = wishSpeed - cur;
      if (add > 0) {
        const acc = Math.min(PLAYER.groundAccel * wishSpeed * dt, add);
        b.vel.x += _wish.x * acc;
        b.vel.z += _wish.z * acc;
      }
      b.vel.y = 0;
    } else {
      const ws = Math.min(wishSpeed, PLAYER.airSpeedCap);
      const cur = b.vel.x * _wish.x + b.vel.z * _wish.z;
      const add = ws - cur;
      if (add > 0) {
        const acc = Math.min(PLAYER.airAccel * wishSpeed * dt * 3, add);
        b.vel.x += _wish.x * acc;
        b.vel.z += _wish.z * acc;
      }
      b.vel.y -= PLAYER.gravity * dt;
    }

    if (this.jumpBuffer > 0 && this.coyote > 0 && this.dashTime <= 0) {
      b.vel.y = PLAYER.jumpSpeed;
      b.onGround = false;
      this.coyote = 0;
      this.jumpBuffer = 0;
      ev.jumped = true;
    }

    const res = world.moveBody(b, dt, PLAYER.stepHeight);
    if (res.hitCeiling) ev.hitCeiling = true;
    if (res.landed > 0) ev.landed = res.landed;
    this.airTime = b.onGround ? 0 : this.airTime + dt;

    // smooth out stair steps on the camera
    b.stepOffset *= Math.exp(-dt * 14);
    if (Math.abs(b.stepOffset) < 1e-3) b.stepOffset = 0;

    // footsteps
    const sp = this.speed2D;
    if (b.onGround && sp > 0.5) {
      this.strideAcc += sp * dt;
      const stride = this.crouch > 0.5 ? 1.5 : 2.15;
      if (this.strideAcc >= stride) {
        this.strideAcc -= stride;
        ev.footstep = true;
      }
    } else if (b.onGround) {
      this.strideAcc = Math.min(this.strideAcc, 1.2);
    }
    return ev;
  }
}

import * as THREE from 'three';
import type { WeaponId } from '../game/weapons';
import type { AbilityId } from '../game/abilities';

/**
 * Fully procedural audio (WebAudio synthesis) — no sample files to host.
 * Remote sounds are spatialised with HRTF panners plus distance-based air absorption.
 */

interface GunProfile {
  crack: [number, number, number];
  body: [number, number, number];
  thump: [number, number, number, number];
  tail: number;
  gain: number;
}

const GUN: Record<WeaponId, GunProfile> = {
  knife: { crack: [0, 0, 0], body: [0, 0, 0], thump: [0, 0, 0, 0], tail: 0, gain: 0 },
  pistol: { crack: [3200, 0.05, 0.9], body: [1600, 0.12, 0.7], thump: [170, 60, 0.09, 0.5], tail: 0.35, gain: 0.6 },
  magnum: { crack: [2600, 0.08, 1.0], body: [1100, 0.25, 1.0], thump: [130, 45, 0.16, 0.9], tail: 0.6, gain: 0.85 },
  smg: { crack: [3600, 0.035, 0.7], body: [1900, 0.08, 0.6], thump: [190, 70, 0.06, 0.4], tail: 0.25, gain: 0.5 },
  shotgun: { crack: [2000, 0.07, 0.9], body: [800, 0.35, 1.1], thump: [100, 40, 0.2, 1.0], tail: 0.7, gain: 0.95 },
  rifle: { crack: [2900, 0.06, 1.0], body: [1300, 0.16, 0.85], thump: [140, 50, 0.1, 0.7], tail: 0.5, gain: 0.72 },
  sniper: { crack: [2400, 0.1, 1.2], body: [900, 0.4, 1.2], thump: [90, 35, 0.25, 1.1], tail: 1.1, gain: 1.0 },
};

export class AudioEngine {
  readonly ctx: AudioContext;
  private master: GainNode;
  private sfx: GainNode;
  private muffle: BiquadFilterNode;
  private ui: GainNode;
  private ambient: GainNode;
  private reverb: ConvolverNode;
  private reverbIn: GainNode;
  private noise: AudioBuffer;
  private brown: AudioBuffer;
  private tinnitusOsc: OscillatorNode | null = null;
  private ambientStarted = false;
  private heartbeatTimer = 0;
  private hornTimer = 25;
  private listenerPos = new THREE.Vector3();

  constructor() {
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    this.ctx = new AC({ latencyHint: 'interactive' });
    const ctx = this.ctx;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.knee.value = 12;
    comp.ratio.value = 4;
    comp.attack.value = 0.003;
    comp.release.value = 0.2;
    this.master = ctx.createGain();
    this.master.gain.value = 0.75;
    this.master.connect(comp).connect(ctx.destination);
    this.muffle = ctx.createBiquadFilter();
    this.muffle.type = 'lowpass';
    this.muffle.frequency.value = 20000;
    this.muffle.connect(this.master);
    this.sfx = ctx.createGain();
    this.sfx.connect(this.muffle);
    this.ui = ctx.createGain();
    this.ui.gain.value = 0.55;
    this.ui.connect(this.master);
    this.ambient = ctx.createGain();
    this.ambient.gain.value = 0.0;
    this.ambient.connect(this.muffle);

    this.reverb = ctx.createConvolver();
    this.reverb.buffer = this.impulse(2.4, 2.6);
    this.reverbIn = ctx.createGain();
    this.reverbIn.gain.value = 0.32;
    this.reverbIn.connect(this.reverb).connect(this.sfx);

    this.noise = this.makeNoise(2, false);
    this.brown = this.makeNoise(4, true);

    const l = ctx.listener;
    if (l.positionX) {
      l.positionX.value = 0;
      l.positionY.value = 0;
      l.positionZ.value = 0;
    }
  }

  setVolume(v: number): void {
    this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05);
  }

  resume(): void {
    if (this.ctx.state !== 'running') void this.ctx.resume();
  }

  private makeNoise(seconds: number, brown: boolean): AudioBuffer {
    const len = Math.floor(this.ctx.sampleRate * seconds);
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      if (brown) {
        last = (last + 0.02 * w) / 1.02;
        d[i] = last * 3.5;
      } else d[i] = w;
    }
    return buf;
  }

  private impulse(seconds: number, decay: number): AudioBuffer {
    const rate = this.ctx.sampleRate;
    const len = Math.floor(rate * seconds);
    const buf = this.ctx.createBuffer(2, len, rate);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < len; i++) {
        const t = i / len;
        // early reflections + diffuse tail (open harbor: sparse slap-back off buildings)
        const slap = i > rate * 0.09 && i < rate * 0.1 ? 0.6 : 0;
        d[i] = ((Math.random() * 2 - 1) * Math.pow(1 - t, decay) + slap * (Math.random() * 2 - 1)) * 0.6;
      }
    }
    return buf;
  }

  setListener(pos: THREE.Vector3, forward: THREE.Vector3): void {
    const l = this.ctx.listener;
    this.listenerPos.copy(pos);
    const t = this.ctx.currentTime;
    if (l.positionX) {
      l.positionX.setTargetAtTime(pos.x, t, 0.02);
      l.positionY.setTargetAtTime(pos.y, t, 0.02);
      l.positionZ.setTargetAtTime(pos.z, t, 0.02);
      l.forwardX.setTargetAtTime(forward.x, t, 0.02);
      l.forwardY.setTargetAtTime(forward.y, t, 0.02);
      l.forwardZ.setTargetAtTime(forward.z, t, 0.02);
      l.upX.value = 0;
      l.upY.value = 1;
      l.upZ.value = 0;
    } else {
      (l as unknown as { setPosition(x: number, y: number, z: number): void }).setPosition(pos.x, pos.y, pos.z);
      (l as unknown as { setOrientation(a: number, b: number, c: number, d: number, e: number, f: number): void }).setOrientation(forward.x, forward.y, forward.z, 0, 1, 0);
    }
  }

  /** Output node for a sound: spatial (with air absorption) when pos is given. */
  private out(pos: THREE.Vector3 | null, gain = 1, reverb = 0.25): AudioNode {
    const ctx = this.ctx;
    const g = ctx.createGain();
    g.gain.value = gain;
    if (pos) {
      const p = ctx.createPanner();
      p.panningModel = 'HRTF';
      p.distanceModel = 'inverse';
      p.refDistance = 2.5;
      p.rolloffFactor = 1.05;
      p.maxDistance = 150;
      p.positionX.value = pos.x;
      p.positionY.value = pos.y;
      p.positionZ.value = pos.z;
      const d = pos.distanceTo(this.listenerPos);
      const air = ctx.createBiquadFilter();
      air.type = 'lowpass';
      air.frequency.value = Math.max(1200, 18000 / (1 + d / 12));
      g.connect(air).connect(p).connect(this.sfx);
      const send = ctx.createGain();
      send.gain.value = reverb * Math.min(1.6, 0.6 + d / 30);
      air.connect(send).connect(this.reverbIn);
    } else {
      g.connect(this.sfx);
      if (reverb > 0) {
        const send = ctx.createGain();
        send.gain.value = reverb;
        g.connect(send).connect(this.reverbIn);
      }
    }
    return g;
  }

  private noiseBurst(dest: AudioNode, type: BiquadFilterType, freq: number, q: number, dur: number, gain: number, delay = 0, freqEnd?: number): void {
    const ctx = this.ctx;
    const t = ctx.currentTime + delay;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.playbackRate.value = 0.9 + Math.random() * 0.2;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.setValueAtTime(freq, t);
    if (freqEnd) f.frequency.exponentialRampToValueAtTime(freqEnd, t + dur);
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.003);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(dest);
    src.start(t, Math.random() * 1.5);
    src.stop(t + dur + 0.05);
  }

  private tone(dest: AudioNode, type: OscillatorType, f0: number, f1: number, dur: number, gain: number, delay = 0, attack = 0.004): void {
    const ctx = this.ctx;
    const t = ctx.currentTime + delay;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(dest);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  // ---------------------------------------------------------------------------
  // Weapons
  // ---------------------------------------------------------------------------
  gunshot(w: WeaponId, pos: THREE.Vector3 | null, infinite = false): void {
    if (w === 'knife') {
      this.knifeSwing(pos);
      return;
    }
    const p = GUN[w];
    const dist = pos ? pos.distanceTo(this.listenerPos) : 0;
    const dest = this.out(pos, p.gain * (pos ? 1.25 : 1), p.tail * 0.7);
    const v = 0.92 + Math.random() * 0.16;
    this.noiseBurst(dest, 'bandpass', p.crack[0] * v, 0.9, p.crack[1], p.crack[2]);
    this.noiseBurst(dest, 'lowpass', p.body[0] * v, 0.7, p.body[1], p.body[2]);
    this.tone(dest, 'triangle', p.thump[0] * v, p.thump[1], p.thump[2], p.thump[3]);
    if (!pos) {
      // mechanical action close to the ear
      this.noiseBurst(dest, 'highpass', 5000, 0.7, 0.025, 0.25, 0.01);
      if (infinite) this.tone(dest, 'sine', 1400, 2200, 0.08, 0.06);
    }
    if (dist > 35) this.noiseBurst(dest, 'lowpass', 500, 0.5, 0.6, 0.35, 0.06 + dist / 340);
    if (w === 'sniper' || w === 'shotgun') this.noiseBurst(dest, 'lowpass', 350, 0.4, 1.2, 0.3, 0.12);
  }

  knifeSwing(pos: THREE.Vector3 | null): void {
    this.noiseBurst(this.out(pos, 0.5, 0.05), 'bandpass', 900, 1.5, 0.22, 0.6, 0, 3200);
  }

  knifeHit(): void {
    const d = this.out(null, 0.7, 0.1);
    this.noiseBurst(d, 'lowpass', 900, 0.8, 0.12, 0.8);
    this.tone(d, 'sine', 160, 70, 0.1, 0.6);
  }

  dryFire(): void {
    this.noiseBurst(this.out(null, 0.5, 0), 'bandpass', 3500, 4, 0.03, 0.6);
  }

  magOut(): void {
    const d = this.out(null, 0.55, 0.05);
    this.noiseBurst(d, 'bandpass', 2400, 3, 0.04, 0.7);
    this.noiseBurst(d, 'bandpass', 1200, 2, 0.08, 0.4, 0.05);
  }

  magIn(): void {
    const d = this.out(null, 0.6, 0.05);
    this.noiseBurst(d, 'lowpass', 900, 1, 0.06, 0.8);
    this.noiseBurst(d, 'bandpass', 3200, 4, 0.03, 0.8, 0.04);
  }

  boltPull(): void {
    const d = this.out(null, 0.55, 0.05);
    this.noiseBurst(d, 'bandpass', 2000, 3, 0.07, 0.6, 0, 4500);
    this.noiseBurst(d, 'bandpass', 4500, 3, 0.06, 0.6, 0.12, 2000);
  }

  pump(): void {
    const d = this.out(null, 0.6, 0.05);
    this.noiseBurst(d, 'bandpass', 1500, 2, 0.09, 0.7, 0, 900);
    this.noiseBurst(d, 'bandpass', 1100, 2, 0.08, 0.7, 0.16, 1900);
  }

  shellIn(): void {
    const d = this.out(null, 0.5, 0.05);
    this.noiseBurst(d, 'bandpass', 2600, 3, 0.04, 0.6);
    this.noiseBurst(d, 'lowpass', 700, 1, 0.05, 0.4, 0.03);
  }

  equip(): void {
    this.noiseBurst(this.out(null, 0.4, 0.02), 'bandpass', 1800, 2, 0.12, 0.5, 0, 3500);
  }

  // ---------------------------------------------------------------------------
  // Movement / world
  // ---------------------------------------------------------------------------
  footstep(pos: THREE.Vector3 | null, metal: boolean, volume = 1): void {
    const d = this.out(pos, (pos ? 0.95 : 0.32) * volume, 0.06);
    const v = 0.85 + Math.random() * 0.3;
    this.noiseBurst(d, 'bandpass', (metal ? 2100 : 650) * v, metal ? 3 : 1.2, metal ? 0.09 : 0.07, 0.9);
    this.tone(d, 'sine', 95 * v, 60, 0.06, 0.5);
    if (metal) this.tone(d, 'triangle', 1900 * v, 1700 * v, 0.12, 0.08);
  }

  land(pos: THREE.Vector3 | null, impact: number): void {
    const d = this.out(pos, Math.min(1, impact / 10) * (pos ? 1 : 0.5), 0.05);
    this.noiseBurst(d, 'lowpass', 500, 0.7, 0.12, 1);
    this.tone(d, 'sine', 80, 45, 0.12, 0.8);
  }

  jump(pos: THREE.Vector3 | null): void {
    this.noiseBurst(this.out(pos, pos ? 0.5 : 0.2, 0.02), 'bandpass', 900, 1, 0.06, 0.6);
  }

  impact(pos: THREE.Vector3): void {
    const d = this.out(pos, 0.35, 0.1);
    this.noiseBurst(d, 'bandpass', 2500 + Math.random() * 2500, 2, 0.05, 0.7);
    if (Math.random() < 0.3) this.tone(d, 'sine', 3000 + Math.random() * 3000, 1500, 0.15, 0.06);
  }

  /** Supersonic crack of a bullet passing close to the listener. */
  whiz(pos: THREE.Vector3): void {
    const d = this.out(pos, 0.45, 0.05);
    this.noiseBurst(d, 'bandpass', 3800, 2.5, 0.09, 0.8, 0, 1600);
  }

  bodyHit(pos: THREE.Vector3 | null): void {
    const d = this.out(pos, 0.7, 0.03);
    this.noiseBurst(d, 'lowpass', 700, 1, 0.08, 0.9);
    this.tone(d, 'sine', 140, 60, 0.08, 0.6);
  }

  // ---------------------------------------------------------------------------
  // Feedback
  // ---------------------------------------------------------------------------
  hitmarker(head: boolean): void {
    const d = this.out(null, 0.5, 0);
    if (head) {
      this.tone(d, 'sine', 2600, 2600, 0.35, 0.35);
      this.tone(d, 'sine', 3900, 3900, 0.25, 0.15);
    } else this.tone(d, 'square', 1700, 1400, 0.035, 0.12);
  }

  killConfirm(head: boolean): void {
    const d = this.out(null, 0.6, 0.1);
    this.tone(d, 'sine', 880, 880, 0.12, 0.3);
    this.tone(d, 'sine', 1320, 1320, 0.25, 0.3, 0.07);
    if (head) this.tone(d, 'sine', 1760, 1760, 0.4, 0.25, 0.14);
    this.tone(d, 'sine', 70, 40, 0.25, 0.7);
  }

  hurt(): void {
    const d = this.out(null, 0.6, 0.02);
    this.noiseBurst(d, 'lowpass', 600, 1, 0.15, 1);
    this.tone(d, 'sine', 120, 50, 0.18, 0.7);
  }

  death(): void {
    const d = this.out(null, 0.7, 0.4);
    this.tone(d, 'sawtooth', 220, 55, 1.2, 0.18);
    this.noiseBurst(d, 'lowpass', 400, 1, 1.0, 0.5);
  }

  coin(pos: THREE.Vector3 | null, big: boolean): void {
    const d = this.out(pos, pos ? 0.6 : 0.4, 0.2);
    const notes = big ? [1318, 1661, 1976, 2637] : [1318, 1976];
    notes.forEach((f, i) => this.tone(d, 'sine', f, f, 0.35, 0.25, i * 0.06));
    this.tone(d, 'triangle', notes[0] * 2, notes[0] * 2, 0.2, 0.06, 0.02);
  }

  // ---------------------------------------------------------------------------
  // Grenades & abilities
  // ---------------------------------------------------------------------------
  throwWhoosh(): void {
    this.noiseBurst(this.out(null, 0.4, 0.02), 'bandpass', 600, 1.2, 0.25, 0.6, 0, 2000);
  }

  bounce(pos: THREE.Vector3, speed: number): void {
    const d = this.out(pos, Math.min(0.6, speed / 15), 0.05);
    this.tone(d, 'triangle', 1800 + Math.random() * 600, 1200, 0.07, 0.4);
    this.noiseBurst(d, 'bandpass', 3000, 3, 0.03, 0.5);
  }

  explosion(pos: THREE.Vector3): void {
    const d = this.out(pos, 1.6, 0.9);
    this.noiseBurst(d, 'lowpass', 3000, 0.5, 1.6, 1.2, 0, 120);
    this.noiseBurst(d, 'bandpass', 1800, 0.8, 0.12, 1.0);
    this.tone(d, 'sine', 70, 28, 1.2, 1.2);
  }

  flashBang(pos: THREE.Vector3): void {
    const d = this.out(pos, 1.4, 0.8);
    this.noiseBurst(d, 'highpass', 1500, 0.6, 0.25, 1.2);
    this.noiseBurst(d, 'lowpass', 1200, 0.6, 0.6, 0.8);
    this.tone(d, 'sine', 90, 40, 0.4, 0.8);
  }

  smokePop(pos: THREE.Vector3): void {
    const d = this.out(pos, 0.9, 0.3);
    this.noiseBurst(d, 'lowpass', 900, 0.6, 0.25, 0.9);
    this.noiseBurst(d, 'bandpass', 3500, 0.6, 2.2, 0.35, 0.05, 1400);
  }

  tinnitus(duration: number, strength: number): void {
    const ctx = this.ctx;
    const t = ctx.currentTime;
    this.tinnitusOsc?.stop();
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.value = 3600;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.18 * strength, t + 0.05);
    g.gain.exponentialRampToValueAtTime(0.0001, t + duration + 1.5);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + duration + 1.6);
    this.tinnitusOsc = o;
    this.muffle.frequency.cancelScheduledValues(t);
    this.muffle.frequency.setValueAtTime(this.muffle.frequency.value, t);
    this.muffle.frequency.exponentialRampToValueAtTime(400 + (1 - strength) * 3000, t + 0.05);
    this.muffle.frequency.exponentialRampToValueAtTime(20000, t + duration + 1.2);
  }

  ability(id: AbilityId, pos: THREE.Vector3 | null): void {
    const d = this.out(pos, pos ? 0.8 : 0.5, 0.3);
    switch (id) {
      case 'dash':
        this.noiseBurst(d, 'bandpass', 500, 1, 0.35, 0.9, 0, 3000);
        break;
      case 'heal':
        [784, 988, 1175, 1568].forEach((f, i) => this.tone(d, 'sine', f, f, 0.5, 0.15, i * 0.08));
        break;
      case 'recon':
        this.tone(d, 'sine', 1200, 300, 1.2, 0.35);
        this.tone(d, 'sine', 1800, 450, 1.0, 0.15, 0.05);
        break;
      case 'cloak':
        this.noiseBurst(d, 'bandpass', 4000, 2, 0.6, 0.35, 0, 600);
        this.tone(d, 'sine', 600, 1400, 0.5, 0.12);
        break;
      case 'adrenaline':
        this.tone(d, 'sine', 60, 50, 0.15, 0.9);
        this.tone(d, 'sine', 60, 50, 0.15, 0.9, 0.22);
        this.noiseBurst(d, 'highpass', 3000, 1, 0.4, 0.2);
        break;
      case 'infinite':
        this.tone(d, 'sawtooth', 220, 880, 0.35, 0.15);
        this.tone(d, 'sine', 880, 1760, 0.4, 0.15, 0.1);
        break;
      case 'barrier':
        this.tone(d, 'sawtooth', 110, 220, 0.6, 0.2);
        this.noiseBurst(d, 'bandpass', 800, 2, 0.5, 0.3, 0, 2400);
        break;
      default:
        this.throwWhoosh();
    }
  }

  // ---------------------------------------------------------------------------
  // UI & music stingers
  // ---------------------------------------------------------------------------
  uiClick(): void {
    this.tone(this.ui, 'sine', 1400, 1000, 0.05, 0.25);
  }

  uiHover(): void {
    this.tone(this.ui, 'sine', 2200, 2200, 0.025, 0.07);
  }

  uiError(): void {
    this.tone(this.ui, 'square', 220, 180, 0.15, 0.12);
  }

  buy(): void {
    this.tone(this.ui, 'sine', 1046, 1046, 0.1, 0.25);
    this.tone(this.ui, 'sine', 1568, 1568, 0.18, 0.2, 0.06);
  }

  cardReveal(rarity: number, delay = 0): void {
    this.noiseBurst(this.ui, 'bandpass', 900, 0.8, 0.25, 0.5, delay, 3500);
    const base = [523, 659, 784, 1046][rarity];
    this.tone(this.ui, 'sine', base, base, 0.4 + rarity * 0.15, 0.18 + rarity * 0.05, delay + 0.05);
    if (rarity >= 2) this.tone(this.ui, 'sine', base * 1.5, base * 1.5, 0.6, 0.15, delay + 0.12);
    if (rarity === 3) {
      this.tone(this.ui, 'sine', base * 2, base * 2, 1.0, 0.18, delay + 0.2);
      this.tone(this.ui, 'triangle', base * 2.5, base * 2.5, 1.0, 0.08, delay + 0.28);
    }
  }

  cardPick(): void {
    this.tone(this.ui, 'sine', 660, 1320, 0.15, 0.3);
    this.noiseBurst(this.ui, 'highpass', 3000, 0.7, 0.2, 0.25);
  }

  beep(high = false): void {
    this.tone(this.ui, 'sine', high ? 1760 : 880, high ? 1760 : 880, 0.12, 0.3);
  }

  chord(freqs: number[], dur: number, type: OscillatorType = 'sawtooth', gain = 0.12): void {
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(600, t);
    lp.frequency.exponentialRampToValueAtTime(3000, t + dur * 0.3);
    lp.frequency.exponentialRampToValueAtTime(800, t + dur);
    lp.connect(this.ui);
    const send = ctx.createGain();
    send.gain.value = 0.5;
    lp.connect(send).connect(this.reverbIn);
    for (const f of freqs) {
      for (const det of [-6, 6]) {
        const o = ctx.createOscillator();
        o.type = type;
        o.frequency.value = f;
        o.detune.value = det;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(gain, t + 0.08);
        g.gain.setValueAtTime(gain, t + dur * 0.6);
        g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
        o.connect(g).connect(lp);
        o.start(t);
        o.stop(t + dur + 0.05);
      }
    }
  }

  roundStart(): void {
    this.chord([196, 293.7, 392], 1.4, 'sawtooth', 0.08);
    this.tone(this.ui, 'sine', 98, 98, 1.2, 0.3);
  }

  roundWin(): void {
    this.chord([261.6, 329.6, 392, 523.3], 2.2, 'sawtooth', 0.08);
  }

  roundLose(): void {
    this.chord([220, 261.6, 329.6], 2.2, 'sawtooth', 0.07);
  }

  matchWin(): void {
    this.chord([261.6, 329.6, 392], 1.0, 'sawtooth', 0.08);
    window.setTimeout(() => this.chord([349.2, 440, 523.3, 698.5], 2.6, 'sawtooth', 0.09), 450);
  }

  // ---------------------------------------------------------------------------
  // Ambience
  // ---------------------------------------------------------------------------
  startAmbient(): void {
    if (this.ambientStarted) {
      this.ambient.gain.setTargetAtTime(0.32, this.ctx.currentTime, 1.5);
      return;
    }
    this.ambientStarted = true;
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.brown;
    src.loop = true;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 380;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.07;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 140;
    lfo.connect(lfoGain).connect(lp.frequency);
    src.connect(lp).connect(this.ambient);
    // water lapping
    const w = ctx.createBufferSource();
    w.buffer = this.noise;
    w.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 900;
    bp.Q.value = 0.6;
    const wg = ctx.createGain();
    wg.gain.value = 0.025;
    const lfo2 = ctx.createOscillator();
    lfo2.frequency.value = 0.21;
    const lg2 = ctx.createGain();
    lg2.gain.value = 0.02;
    lfo2.connect(lg2).connect(wg.gain);
    w.connect(bp).connect(wg).connect(this.ambient);
    src.start();
    w.start();
    lfo.start();
    lfo2.start();
    this.ambient.gain.setTargetAtTime(0.32, ctx.currentTime, 1.5);
  }

  stopAmbient(): void {
    this.ambient.gain.setTargetAtTime(0, this.ctx.currentTime, 0.5);
  }

  /** Called every frame for timed ambience and the low-health heartbeat. */
  update(dt: number, lowHp: boolean): void {
    if (this.ambientStarted) {
      this.hornTimer -= dt;
      if (this.hornTimer <= 0) {
        this.hornTimer = 40 + Math.random() * 40;
        const pos = new THREE.Vector3(-60 + Math.random() * 120, 10, -160);
        const d = this.out(pos, 2.5, 1.2);
        this.tone(d, 'sawtooth', 87, 85, 2.6, 0.25, 0, 0.4);
        this.tone(d, 'sawtooth', 131, 129, 2.6, 0.12, 0, 0.4);
      }
    }
    if (lowHp) {
      this.heartbeatTimer -= dt;
      if (this.heartbeatTimer <= 0) {
        this.heartbeatTimer = 0.85;
        const d = this.out(null, 0.5, 0);
        this.tone(d, 'sine', 55, 45, 0.12, 0.9);
        this.tone(d, 'sine', 55, 45, 0.12, 0.6, 0.18);
      }
    }
  }
}

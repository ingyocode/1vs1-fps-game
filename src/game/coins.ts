import * as THREE from 'three';
import type { CoinInfo } from '../net/protocol';
import { beamTex, softDot } from '../render/textures';

interface CoinVisual {
  info: CoinInfo;
  group: THREE.Group;
  coin: THREE.Mesh;
  glow: THREE.Sprite;
  beam: THREE.Mesh;
  phase: number;
  spawnT: number;
}

function coinFaceTexture(big: boolean): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(128, 110, 10, 128, 128, 128);
  g.addColorStop(0, '#fff2b0');
  g.addColorStop(0.55, '#f2b632');
  g.addColorStop(1, '#a8650c');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(128, 128, 128, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(120,60,0,0.8)';
  ctx.lineWidth = 10;
  ctx.beginPath();
  ctx.arc(128, 128, 104, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = 'rgba(110,55,0,0.9)';
  ctx.font = `900 ${big ? 120 : 140}px Rajdhani, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(big ? '★' : 'G', 128, 136);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Gold pickups on the map (visual layer; the host owns the authoritative list). */
export class CoinField {
  private coins = new Map<number, CoinVisual>();
  private readonly group = new THREE.Group();
  private faceSmall = coinFaceTexture(false);
  private faceBig = coinFaceTexture(true);
  private glowTex = softDot();
  private beamTexture = beamTex();
  private edgeMat = new THREE.MeshStandardMaterial({ color: 0xd9a030, metalness: 1, roughness: 0.28, emissive: 0x6a3a00, emissiveIntensity: 0.6 });

  constructor(private readonly scene: THREE.Scene) {
    scene.add(this.group);
  }

  dispose(): void {
    this.clear();
    this.scene.remove(this.group);
  }

  set(list: CoinInfo[]): void {
    const keep = new Set(list.map((c) => c.id));
    for (const id of [...this.coins.keys()]) if (!keep.has(id)) this.remove(id);
    for (const c of list) if (!this.coins.has(c.id)) this.add(c);
  }

  private add(info: CoinInfo): void {
    const r = info.big ? 0.42 : 0.22;
    const face = new THREE.MeshStandardMaterial({ map: info.big ? this.faceBig : this.faceSmall, metalness: 0.9, roughness: 0.3, emissive: 0xffb030, emissiveIntensity: 0.35, emissiveMap: info.big ? this.faceBig : this.faceSmall });
    const geo = new THREE.CylinderGeometry(r, r, r * 0.18, 32);
    geo.rotateX(Math.PI / 2);
    const coin = new THREE.Mesh(geo, [this.edgeMat, face, face]);
    coin.castShadow = true;
    const group = new THREE.Group();
    group.position.set(...info.pos);
    group.add(coin);
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.glowTex, color: new THREE.Color(1.0, 0.7, 0.2).multiplyScalar(info.big ? 2.2 : 1.4), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
    glow.scale.setScalar(r * 5);
    group.add(glow);
    const beamH = info.big ? 9 : 4;
    const beam = new THREE.Mesh(
      new THREE.CylinderGeometry(r * 0.9, r * 1.4, beamH, 16, 1, true),
      new THREE.MeshBasicMaterial({ map: this.beamTexture, color: new THREE.Color(1, 0.65, 0.2).multiplyScalar(info.big ? 1.6 : 0.9), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }),
    );
    beam.position.y = beamH / 2 - 0.5;
    group.add(beam);
    this.group.add(group);
    this.coins.set(info.id, { info, group, coin, glow, beam, phase: Math.random() * 10, spawnT: 0 });
  }

  remove(id: number): THREE.Vector3 | null {
    const c = this.coins.get(id);
    if (!c) return null;
    this.group.remove(c.group);
    c.coin.geometry.dispose();
    c.beam.geometry.dispose();
    this.coins.delete(id);
    return c.group.position.clone();
  }

  clear(): void {
    for (const id of [...this.coins.keys()]) this.remove(id);
  }

  /** Coins within pickup range of a player's feet position. */
  touching(feet: THREE.Vector3): CoinInfo[] {
    const out: CoinInfo[] = [];
    for (const c of this.coins.values()) {
      const p = c.group.position;
      const dx = p.x - feet.x;
      const dz = p.z - feet.z;
      const dy = p.y - (feet.y + 0.6);
      if (dx * dx + dz * dz < (c.info.big ? 1.3 : 1.0) ** 2 && Math.abs(dy) < 1.3) out.push(c.info);
    }
    return out;
  }

  get all(): CoinInfo[] {
    return [...this.coins.values()].map((c) => c.info);
  }

  update(dt: number, time: number): void {
    for (const c of this.coins.values()) {
      c.spawnT = Math.min(1, c.spawnT + dt * 2.5);
      const s = 1 - Math.pow(1 - c.spawnT, 3);
      c.coin.rotation.y = time * 2.2 + c.phase;
      c.coin.position.y = Math.sin(time * 2 + c.phase) * 0.08;
      c.coin.scale.setScalar(s);
      c.glow.material.opacity = 0.7 + Math.sin(time * 4 + c.phase) * 0.2;
      (c.beam.material as THREE.MeshBasicMaterial).opacity = (0.5 + Math.sin(time * 3 + c.phase) * 0.15) * s;
    }
  }
}

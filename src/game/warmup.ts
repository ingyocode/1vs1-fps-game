import * as THREE from 'three';
import type { GameRenderer } from '../render/renderer';
import { Effects, ensureEffectLights } from '../render/effects';
import { SmokeSystem } from '../render/smoke';
import { energyWallMaterial } from '../render/shaders';
import { Avatar } from './avatar';
import { CoinField } from './coins';
import { buildGrenade, buildGun } from './gunModels';
import { ViewModel } from './viewmodel';
import { WEAPON_INDEX } from '../net/protocol';
import { TEAMS } from '../core/config';

/**
 * Compiles every shader a match can show — both factions (plus cloak / x-ray variants), all
 * weapons in first and third person, grenades, coins, effects, smoke and barriers — while the
 * loading screen is up. Otherwise each one compiles synchronously the first time it appears,
 * freezing the game mid-fight.
 */
export async function warmupShaders(r: GameRenderer): Promise<void> {
  const scene = r.scene;
  const vmScene = r.vmScene;
  ensureEffectLights(scene);
  const holder = new THREE.Group();
  holder.position.set(0, -50, 0);
  scene.add(holder);

  const avatars = [new Avatar(0, 'rifle'), new Avatar(1, 'rifle'), new Avatar(0, 'pistol'), new Avatar(1, 'pistol')];
  avatars[2].setCloaked(true);
  avatars[3].setRevealed(true);
  for (const a of avatars) holder.add(a.root);
  for (const id of WEAPON_INDEX) holder.add(buildGun(id));
  for (const k of ['frag', 'smoke', 'flash'] as const) holder.add(buildGrenade(k));
  const wall = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), energyWallMaterial(TEAMS[0].color, 0.75));
  const pylon = new THREE.Mesh(new THREE.BoxGeometry(0.1, 1, 0.1), new THREE.MeshStandardMaterial({ color: 0x24282e, metalness: 0.8, roughness: 0.35 }));
  holder.add(wall, pylon);

  const effects = new Effects(scene);
  const smoke = new SmokeSystem(scene);
  const coins = new CoinField(scene);
  coins.set([
    { id: -1, pos: [0, -50, 0], value: 0, big: false },
    { id: -2, pos: [1, -50, 0], value: 0, big: true },
  ]);
  const vm = new ViewModel(vmScene, 0);
  const vmGuns = new THREE.Group();
  for (const id of WEAPON_INDEX) vmGuns.add(buildGun(id));
  vmScene.add(vmGuns);

  try {
    await r.precompile(scene, r.camera);
    await r.precompile(vmScene, r.vmCamera);
  } finally {
    for (const a of avatars) a.dispose();
    scene.remove(holder);
    vmScene.remove(vmGuns);
    effects.dispose();
    smoke.dispose();
    coins.dispose();
    vm.dispose();
  }
}

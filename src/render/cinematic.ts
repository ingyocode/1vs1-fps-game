import * as THREE from 'three';

const _look = new THREE.Vector3();

/**
 * Slow establishing shot used behind menus: drifts above the mid plaza and
 * looks north across the container yard towards the harbour sunset.
 */
export function cinematicCamera(cam: THREE.PerspectiveCamera, t: number): void {
  const a = t * 0.045;
  cam.position.set(Math.sin(a) * 15, 6.4 + Math.sin(a * 1.7) * 0.9, 2.2 + Math.cos(a * 0.8) * 2.5);
  _look.set(Math.sin(a + 0.7) * 9, 3.2 + Math.sin(a * 0.9) * 0.6, -18);
  cam.lookAt(_look);
}

import * as THREE from 'three';
import { createSkyDome } from './sky';
import type { Quality } from '../core/settings';

/** Direction *towards* the sun. Low evening sun from the harbor side (north, -Z). */
export const SUN_DIR = new THREE.Vector3(0.16, 0.6, -0.78).normalize();
/** Visual sun position on the sky dome (lower than the light for a richer sunset). */
const SKY_SUN = new THREE.Vector3(0.16, 0.055, -0.98).normalize();

export interface Environment {
  sky: THREE.Mesh;
  sun: THREE.DirectionalLight;
  hemi: THREE.HemisphereLight;
  envTexture: THREE.Texture;
  setQuality(q: Quality): void;
  update(time: number, camera: THREE.Camera): void;
}

export function createEnvironment(renderer: THREE.WebGLRenderer, scene: THREE.Scene, quality: Quality): Environment {
  const sky = createSkyDome(SKY_SUN, 1800, true);
  scene.add(sky);
  const skyUniforms = (sky.material as THREE.ShaderMaterial).uniforms;

  // Bake an environment map from a cloudless copy of the sky (cheap, gives sunset reflections).
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = new THREE.Scene();
  envScene.add(createSkyDome(SKY_SUN, 900, false));
  // A dark ground disc so reflections below the horizon are not sky-bright.
  const groundDisc = new THREE.Mesh(
    new THREE.CircleGeometry(800, 32).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0x2a1f1c, side: THREE.DoubleSide }),
  );
  groundDisc.position.y = -2;
  envScene.add(groundDisc);
  const envRT = pmrem.fromScene(envScene, 0, 0.1, 2000);
  pmrem.dispose();
  scene.environment = envRT.texture;
  scene.environmentIntensity = 0.5;

  const sun = new THREE.DirectionalLight(0xffb784, 2.7);
  sun.position.copy(SUN_DIR).multiplyScalar(80);
  sun.target.position.set(0, 0, 0);
  sun.castShadow = true;
  const sc = sun.shadow.camera;
  sc.left = -48;
  sc.right = 48;
  sc.top = 40;
  sc.bottom = -40;
  sc.near = 10;
  sc.far = 180;
  sun.shadow.bias = -0.00025;
  sun.shadow.normalBias = 0.035;
  scene.add(sun, sun.target);

  const hemi = new THREE.HemisphereLight(0x8a7fb8, 0x3b2a20, 0.55);
  scene.add(hemi);

  scene.fog = new THREE.FogExp2(0x9a6a5c, 0.0058);

  const env: Environment = {
    sky,
    sun,
    hemi,
    envTexture: envRT.texture,
    setQuality(q: Quality) {
      const size = q === 'low' ? 1024 : q === 'medium' ? 2048 : 4096;
      sun.castShadow = true;
      if (sun.shadow.mapSize.x !== size) {
        sun.shadow.mapSize.set(size, size);
        sun.shadow.map?.dispose();
        sun.shadow.map = null;
      }
      sun.shadow.radius = q === 'low' ? 1 : 2.2;
      sun.shadow.blurSamples = q === 'ultra' ? 16 : 8;
    },
    update(time: number, camera: THREE.Camera) {
      skyUniforms.uTime.value = time;
      sky.position.copy(camera.position);
    },
  };
  env.setQuality(quality);
  return env;
}

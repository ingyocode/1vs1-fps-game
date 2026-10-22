import * as THREE from 'three';
import * as T from './textures';
import { PBR_JOBS } from './textureJobs';

export type MatKey =
  | 'concrete'
  | 'floor'
  | 'plaza'
  | 'epoxy'
  | 'asphalt'
  | 'metal'
  | 'corrRed'
  | 'corrBlue'
  | 'corrTeal'
  | 'corrOrange'
  | 'corrYellow'
  | 'corrWall'
  | 'wood'
  | 'plate'
  | 'hazard'
  | 'trim'
  | 'rubber'
  | 'glass'
  | 'neonA'
  | 'neonB'
  | 'neonWarm'
  | 'neonWhite'
  | 'lampLens'
  | 'fence'
  | 'aoStrip'
  | 'puddle'
  | 'skyline'
  | 'water'
  | 'paintYellow'
  | 'paintWhite';

export interface MatInfo {
  material: THREE.Material;
  /** Meters per texture repeat for world-space UVs; 0 = face UVs (0..1 per face). */
  uvScale: number;
  castShadow: boolean;
  receiveShadow: boolean;
}

/**
 * Injects a cheap height-based contact occlusion into vertical surfaces so walls
 * darken towards whatever they stand on. The `aoBase` attribute stores the base
 * height of each box.
 */
function withContactAO<M extends THREE.MeshStandardMaterial>(m: M, strength = 0.5, height = 1.3): M {
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        attribute float aoBase;
        varying float vAoH;
        varying float vAoV;`,
      )
      .replace(
        '#include <worldpos_vertex>',
        `#include <worldpos_vertex>
        vec4 aoWorld = modelMatrix * vec4( transformed, 1.0 );
        vAoH = aoWorld.y - aoBase;
        vAoV = 1.0 - abs( normalize( mat3( modelMatrix ) * objectNormal ).y );`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        varying float vAoH;
        varying float vAoV;`,
      )
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
        float contactAO = mix( ${(1 - strength).toFixed(3)}, 1.0, smoothstep( 0.0, ${height.toFixed(3)}, vAoH ) );
        diffuseColor.rgb *= mix( 1.0, contactAO, clamp( vAoV * 1.4, 0.0, 1.0 ) );`,
      );
  };
  m.customProgramCacheKey = () => `contactAO-${strength}-${height}`;
  return m;
}

function pbr(set: T.PBRSet, params: THREE.MeshStandardMaterialParameters = {}, normalScale = 1): THREE.MeshStandardMaterial {
  for (const t of [set.map, set.normalMap, set.orm]) t.anisotropy = 8;
  const m = new THREE.MeshStandardMaterial({
    map: set.map,
    normalMap: set.normalMap,
    normalScale: new THREE.Vector2(normalScale, normalScale),
    roughnessMap: set.orm,
    metalnessMap: set.orm,
    aoMap: set.orm,
    aoMapIntensity: 1,
    roughness: 1,
    metalness: 1,
    vertexColors: true,
    ...params,
  });
  return withContactAO(m);
}

function neon(color: number, intensity: number): THREE.MeshBasicMaterial {
  const c = new THREE.Color(color).multiplyScalar(intensity);
  return new THREE.MeshBasicMaterial({ color: c, toneMapped: true });
}

function chainLink(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const ctx = c.getContext('2d')!;
  ctx.clearRect(0, 0, 128, 128);
  ctx.strokeStyle = 'rgba(190,195,200,1)';
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(128, 128);
  ctx.moveTo(128, 0);
  ctx.lineTo(0, 128);
  ctx.stroke();
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

function aoStripTex(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 4;
  c.height = 64;
  const ctx = c.getContext('2d')!;
  const g = ctx.createLinearGradient(0, 0, 0, 64);
  g.addColorStop(0, 'rgba(0,0,0,0.62)');
  g.addColorStop(0.35, 'rgba(0,0,0,0.25)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 4, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export type MaterialLibrary = Record<MatKey, MatInfo>;

/** Builds every map material. Yields between heavy texture jobs so a loading bar can update. */
/** Generates all PBR sets, in parallel workers when available (falls back to the main thread). */
async function generatePBR(onProgress: (p: number) => void): Promise<Record<string, T.PBRSet>> {
  const keys = Object.keys(PBR_JOBS);
  const sets: Record<string, T.PBRSet> = {};
  let done = 0;
  const finish = (key: string, raw: T.PBRRaw): void => {
    sets[key] = T.wrapPBR(raw);
    done++;
    onProgress(done / (keys.length + 1));
  };
  const queue = [...keys];
  const workerCount = Math.max(1, Math.min(6, (navigator.hardwareConcurrency || 4) - 1, keys.length));
  const runWorker = (): Promise<void> =>
    new Promise((resolve) => {
      let worker: Worker;
      try {
        worker = new Worker(new URL('./texture.worker.ts', import.meta.url), { type: 'module' });
      } catch {
        resolve();
        return;
      }
      const next = (): void => {
        const key = queue.shift();
        if (!key) {
          worker.terminate();
          resolve();
          return;
        }
        worker.postMessage({ key });
      };
      worker.onmessage = (e: MessageEvent<{ key: string; raw: T.PBRRaw }>) => {
        finish(e.data.key, e.data.raw);
        next();
      };
      worker.onerror = () => {
        worker.terminate();
        resolve();
      };
      next();
    });
  await Promise.all(Array.from({ length: workerCount }, runWorker));
  // Anything a failed worker left behind is generated here.
  for (const key of keys) {
    if (sets[key]) continue;
    finish(key, PBR_JOBS[key]());
    await new Promise((r) => setTimeout(r, 0));
  }
  return sets;
}

export async function createMaterials(onProgress: (p: number) => void): Promise<MaterialLibrary> {
  const sets = await generatePBR(onProgress);
  const skyTex = T.windowFacade(512, 91);
  skyTex.wrapS = skyTex.wrapT = THREE.RepeatWrapping;

  const info = (material: THREE.Material, uvScale: number, cast = true, receive = true): MatInfo => ({
    material,
    uvScale,
    castShadow: cast,
    receiveShadow: receive,
  });

  const fenceMat = new THREE.MeshStandardMaterial({
    map: chainLink(),
    alphaTest: 0.45,
    side: THREE.DoubleSide,
    metalness: 0.7,
    roughness: 0.45,
    color: 0x9aa2a8,
  });
  const aoMat = new THREE.MeshBasicMaterial({
    map: aoStripTex(),
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
    color: 0xffffff,
  });
  const puddle = new THREE.MeshStandardMaterial({
    color: 0x07090b,
    roughness: 0.04,
    metalness: 0.0,
    envMapIntensity: 1.6,
    transparent: true,
    opacity: 0.82,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
    depthWrite: false,
  });
  const paint = (c: number): THREE.MeshStandardMaterial =>
    new THREE.MeshStandardMaterial({
      color: c,
      roughness: 0.7,
      metalness: 0,
      transparent: true,
      opacity: 0.85,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
      depthWrite: false,
    });

  const lib: MaterialLibrary = {
    concrete: info(pbr(sets.concrete), 4),
    floor: info(pbr(sets.floor, {}, 0.6), 6, false),
    plaza: info(pbr(sets.plaza, {}, 0.6), 4, false),
    epoxy: info(pbr(sets.epoxy, { roughness: 0.55 }), 5, false),
    asphalt: info(pbr(sets.asphalt), 7, false),
    metal: info(pbr(sets.metal), 2.2),
    corrRed: info(pbr(sets.corrRed), 2.4),
    corrBlue: info(pbr(sets.corrBlue), 2.4),
    corrTeal: info(pbr(sets.corrTeal), 2.4),
    corrOrange: info(pbr(sets.corrOrange), 2.4),
    corrYellow: info(pbr(sets.corrYellow), 2.4),
    corrWall: info(pbr(sets.corrWall), 3),
    wood: info(pbr(sets.wood), 0),
    plate: info(pbr(sets.plate), 1.5),
    hazard: info(pbr(sets.hazard), 1.2),
    trim: info(withContactAO(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.42, metalness: 0.75, vertexColors: true })), 1),
    rubber: info(withContactAO(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85, metalness: 0, vertexColors: true })), 1),
    glass: info(new THREE.MeshStandardMaterial({ color: 0x0a1216, roughness: 0.06, metalness: 0.2, envMapIntensity: 1.4, vertexColors: true }), 1, false),
    neonA: info(neon(0x38d6ff, 2.5), 1, false, false),
    neonB: info(neon(0xff6a3d, 2.5), 1, false, false),
    neonWarm: info(neon(0xffb36b, 2.2), 1, false, false),
    neonWhite: info(neon(0xe8f4ff, 1.8), 1, false, false),
    lampLens: info(neon(0xffd29a, 3.6), 1, false, false),
    fence: info(fenceMat, 2.0, true, false),
    aoStrip: info(aoMat, 0, false, false),
    puddle: info(puddle, 1, false, false),
    skyline: info(
      new THREE.MeshStandardMaterial({
        color: 0x0c0e14,
        roughness: 0.9,
        metalness: 0.1,
        emissive: 0xffffff,
        emissiveMap: skyTex,
        emissiveIntensity: 0.65,
        vertexColors: true,
        fog: true,
      }),
      14,
      false,
      false,
    ),
    water: info(
      new THREE.MeshStandardMaterial({ color: 0x0b1a26, roughness: 0.12, metalness: 0.1, envMapIntensity: 1.25 }),
      1,
      false,
      false,
    ),
    paintYellow: info(paint(0xd8a21a), 1, false, false),
    paintWhite: info(paint(0xcfd3d6), 1, false, false),
  };
  onProgress(1);
  return lib;
}

import * as THREE from 'three';

/** Shared time uniform for all animated shader materials. */
export const globalTime = { value: 0 };

/** Hexagonal energy wall used by spawn barriers and the Barrier ability. */
export function energyWallMaterial(color: number, opacity = 0.55): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: globalTime,
      uColor: { value: new THREE.Color(color) },
      uOpacity: { value: opacity },
      uHit: { value: 0 },
      uFade: { value: 1 },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      varying vec3 vWorld;
      varying vec3 vNormalW;
      varying vec3 vViewDir;
      void main() {
        vUv = uv;
        vec4 w = modelMatrix * vec4(position, 1.0);
        vWorld = w.xyz;
        vNormalW = normalize(mat3(modelMatrix) * normal);
        vViewDir = normalize(cameraPosition - w.xyz);
        gl_Position = projectionMatrix * viewMatrix * w;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform vec3 uColor;
      uniform float uOpacity;
      uniform float uHit;
      uniform float uFade;
      varying vec2 vUv;
      varying vec3 vWorld;
      varying vec3 vNormalW;
      varying vec3 vViewDir;

      float hexDist(vec2 p) {
        p = abs(p);
        return max(dot(p, normalize(vec2(1.0, 1.73))), p.x);
      }
      vec4 hexCoords(vec2 uv) {
        vec2 r = vec2(1.0, 1.73);
        vec2 h = r * 0.5;
        vec2 a = mod(uv, r) - h;
        vec2 b = mod(uv - h, r) - h;
        vec2 gv = dot(a, a) < dot(b, b) ? a : b;
        return vec4(gv, uv - gv);
      }
      void main() {
        vec2 p = vec2(vWorld.x + vWorld.z, vWorld.y) * 3.2;
        vec4 hc = hexCoords(p);
        float edge = smoothstep(0.42, 0.5, hexDist(hc.xy));
        float pulse = 0.5 + 0.5 * sin(uTime * 2.2 + hc.z * 0.7 + hc.w * 1.3);
        float scan = smoothstep(0.0, 0.06, abs(fract(vWorld.y * 0.35 - uTime * 0.25) - 0.5));
        float fres = pow(1.0 - abs(dot(normalize(vNormalW), normalize(vViewDir))), 2.0);
        float border = smoothstep(0.04, 0.0, min(vUv.y, 1.0 - vUv.y)) + smoothstep(0.03, 0.0, min(vUv.x, 1.0 - vUv.x));
        float a = (0.05 + edge * (0.22 + 0.2 * pulse) + fres * 0.3 + (1.0 - scan) * 0.12 + border * 0.7 + uHit * 0.6) * uOpacity * uFade;
        vec3 col = uColor * (0.9 + edge * 1.1 + border * 2.6 + uHit * 3.0);
        gl_FragColor = vec4(col, clamp(a, 0.0, 1.0));
      }
    `,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.NormalBlending,
  });
}

/** Volumetric-looking light shaft (additive, fades along its length). */
export function lightShaftMaterial(color: number, strength = 0.18): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: globalTime,
      uColor: { value: new THREE.Color(color) },
      uStrength: { value: strength },
    },
    vertexShader: /* glsl */ `
      attribute float aT;
      varying float vT;
      varying vec3 vWorld;
      varying vec3 vN;
      void main() {
        vT = aT;
        vec4 w = modelMatrix * vec4(position, 1.0);
        vWorld = w.xyz;
        vN = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * viewMatrix * w;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform vec3 uColor;
      uniform float uStrength;
      varying float vT;
      varying vec3 vWorld;
      varying vec3 vN;
      float hash(vec2 p) { return fract(sin(dot(p, vec2(41.3, 289.1))) * 43758.5453); }
      void main() {
        vec3 v = normalize(cameraPosition - vWorld);
        float facing = abs(dot(v, vN));
        float soft = smoothstep(0.0, 0.6, facing);
        float fade = (1.0 - vT) * smoothstep(0.0, 0.08, vT);
        float dust = 0.85 + 0.15 * sin(vWorld.x * 3.0 + vWorld.z * 2.0 + uTime * 0.6);
        float a = uStrength * fade * soft * dust;
        gl_FragColor = vec4(uColor * a, 1.0);
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
}

/** Silhouette shown through walls for revealed enemies (Recon). */
export function xrayMaterial(color: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color(color) }, uTime: globalTime, uAlpha: { value: 1 } },
    vertexShader: /* glsl */ `
      varying vec3 vN;
      varying vec3 vV;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vN = normalize(normalMatrix * normal);
        vV = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uTime;
      uniform float uAlpha;
      varying vec3 vN;
      varying vec3 vV;
      void main() {
        float rim = pow(1.0 - abs(dot(vN, vV)), 1.6);
        float pulse = 0.75 + 0.25 * sin(uTime * 8.0);
        gl_FragColor = vec4(uColor * (1.5 + rim * 2.5), (0.25 + rim * 0.75) * pulse * uAlpha);
      }
    `,
    transparent: true,
    depthTest: false,
    depthWrite: false,
  });
}

/** Optical camouflage shimmer. */
export function cloakMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uTime: globalTime, uAlpha: { value: 1 } },
    vertexShader: /* glsl */ `
      varying vec3 vN;
      varying vec3 vV;
      varying vec3 vW;
      void main() {
        vec4 w = modelMatrix * vec4(position, 1.0);
        vW = w.xyz;
        vec4 mv = viewMatrix * w;
        vN = normalize(normalMatrix * normal);
        vV = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform float uAlpha;
      varying vec3 vN;
      varying vec3 vV;
      varying vec3 vW;
      void main() {
        float rim = pow(1.0 - abs(dot(vN, vV)), 3.0);
        float bands = 0.5 + 0.5 * sin(vW.y * 40.0 - uTime * 9.0);
        float a = (0.03 + rim * 0.35 * (0.6 + 0.4 * bands)) * uAlpha;
        gl_FragColor = vec4(vec3(0.75, 0.9, 1.0) * (0.6 + rim), a);
      }
    `,
    transparent: true,
    depthWrite: false,
  });
}

import * as THREE from 'three';

/**
 * Stylised dusk sky: art-directed gradient, sun halo/disc and two layers of
 * procedural clouds lit from the sun side. Output is linear HDR so bloom and
 * tone mapping treat the sun like any other bright source.
 */
export function createSkyDome(sunDir: THREE.Vector3, radius = 1800, withClouds = true): THREE.Mesh {
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uSunDir: { value: sunDir.clone().normalize() },
      uTime: { value: 0 },
      uClouds: { value: withClouds ? 1 : 0 },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_Position = p.xyww;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uSunDir;
      uniform float uTime;
      uniform float uClouds;
      varying vec3 vDir;

      float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }
      float noise(vec2 p) {
        vec2 i = floor(p);
        vec2 f = fract(p);
        vec2 u = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
      }
      float fbm(vec2 p) {
        float s = 0.0;
        float a = 0.5;
        for (int i = 0; i < 6; i++) {
          s += a * noise(p);
          p = p * 2.03 + vec2(1.7, 9.2);
          a *= 0.5;
        }
        return s;
      }

      void main() {
        vec3 d = normalize(vDir);
        float h = d.y;
        float sd = max(dot(d, uSunDir), 0.0);
        // Azimuthal proximity to the sun (warmer horizon on the sun side)
        vec2 dh = normalize(d.xz + 1e-5);
        vec2 sh = normalize(uSunDir.xz + 1e-5);
        float az = dot(dh, sh) * 0.5 + 0.5;

        vec3 zenith = vec3(0.045, 0.06, 0.16);
        vec3 upper = vec3(0.16, 0.13, 0.30);
        vec3 band = mix(vec3(0.55, 0.26, 0.34), vec3(1.25, 0.52, 0.22), az);
        vec3 horizon = mix(vec3(0.85, 0.42, 0.36), vec3(1.9, 0.82, 0.34), pow(az, 2.0));

        vec3 col = mix(horizon, band, smoothstep(0.0, 0.12, h));
        col = mix(col, upper, smoothstep(0.08, 0.38, h));
        col = mix(col, zenith, smoothstep(0.35, 0.95, h));

        // Sun halo, glow and disc
        col += vec3(1.6, 0.75, 0.32) * pow(sd, 8.0) * 0.6;
        col += vec3(2.4, 1.3, 0.6) * pow(sd, 90.0) * 1.0;
        col += vec3(30.0, 22.0, 14.0) * smoothstep(0.99955, 0.99975, sd);

        // Clouds: a stratus band near the horizon and soft cirrus above
        if (uClouds > 0.5 && h > -0.02) {
          float ph = max(h, 0.02);
          vec2 uv = d.xz / (ph + 0.12);
          float n1 = fbm(uv * 1.1 + vec2(uTime * 0.004, 0.0));
          float n2 = fbm(uv * 3.2 - vec2(uTime * 0.006, uTime * 0.002));
          float strat = smoothstep(0.52, 0.78, n1 * 0.75 + n2 * 0.35) * smoothstep(0.0, 0.06, h) * (1.0 - smoothstep(0.18, 0.5, h));
          float cirrus = smoothstep(0.6, 0.85, fbm(vec2(uv.x * 0.6, uv.y * 2.4) + 13.0)) * smoothstep(0.12, 0.4, h) * 0.55;
          float cl = clamp(strat + cirrus, 0.0, 1.0);
          float lit = pow(sd, 3.0) * 0.8 + az * 0.35;
          vec3 dark = vec3(0.16, 0.09, 0.16);
          vec3 bright = vec3(1.9, 0.9, 0.45);
          vec3 cc = mix(dark, bright, clamp(lit + (n2 - 0.5) * 0.4, 0.0, 1.0));
          // silver lining near the sun
          cc += vec3(2.5, 1.4, 0.7) * pow(sd, 24.0) * (1.0 - cl) * 2.0;
          col = mix(col, cc, cl * 0.9);
        }

        // Below the horizon: hazy dark ground tone
        col = mix(col, vec3(0.16, 0.1, 0.1), smoothstep(0.0, -0.06, h));
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 48, 24), mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = -10;
  mesh.name = 'sky';
  return mesh;
}

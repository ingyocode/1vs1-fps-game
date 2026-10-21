import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { FXAAPass } from 'three/addons/postprocessing/FXAAPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import type { Quality } from '../core/settings';

const GRADE_SHADER = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    tAfter: { value: null as THREE.Texture | null },
    uTime: { value: 0 },
    uRes: { value: new THREE.Vector2(1, 1) },
    uVignette: { value: 0.55 },
    uDamage: { value: 0 },
    uFlash: { value: 0 },
    uAfter: { value: 0 },
    uChroma: { value: 0.3 },
    uSat: { value: 1.08 },
    uContrast: { value: 1.06 },
    uSmoke: { value: 0 },
    uLowHp: { value: 0 },
    uTint: { value: new THREE.Vector3(0, 0, 0) },
    uTintAmt: { value: 0 },
    uDeath: { value: 0 },
    uScope: { value: 0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform sampler2D tAfter;
    uniform float uTime;
    uniform vec2 uRes;
    uniform float uVignette;
    uniform float uDamage;
    uniform float uFlash;
    uniform float uAfter;
    uniform float uChroma;
    uniform float uSat;
    uniform float uContrast;
    uniform float uSmoke;
    uniform float uLowHp;
    uniform vec3 uTint;
    uniform float uTintAmt;
    uniform float uDeath;
    uniform float uScope;
    varying vec2 vUv;

    float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }

    void main() {
      vec2 uv = vUv;
      vec2 c = uv - 0.5;
      float r2 = dot(c, c);
      float ca = (uChroma * 0.012 + uDamage * 0.02) * r2;
      vec3 col;
      col.r = texture2D(tDiffuse, uv - c * ca).r;
      col.g = texture2D(tDiffuse, uv).g;
      col.b = texture2D(tDiffuse, uv + c * ca).b;

      // Grading: gentle S-curve, saturation and split toning (warm highlights, cool shadows).
      float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
      float sat = uSat * (1.0 - uLowHp * 0.55) * (1.0 - uDeath * 0.85);
      col = mix(vec3(l), col, sat);
      col = clamp((col - 0.5) * uContrast + 0.5, 0.0, 1.0);
      col += vec3(0.018, 0.008, -0.01) * smoothstep(0.4, 1.0, l) + vec3(-0.008, 0.0, 0.016) * (1.0 - smoothstep(0.0, 0.4, l));

      // Vignette
      float vig = smoothstep(0.95, 0.25, length(c * vec2(1.0, 0.82)));
      col *= mix(1.0, vig, uVignette);

      // Damage & low health edge
      float edge = smoothstep(0.2, 0.75, length(c) * 1.45);
      float pulse = 0.65 + 0.35 * sin(uTime * 6.0);
      col = mix(col, vec3(0.55, 0.02, 0.03), clamp(edge * (uDamage * 0.75 + uLowHp * 0.45 * pulse), 0.0, 0.9));

      // Ability tint (cloak / adrenaline) on the screen edges
      col = mix(col, uTint, edge * uTintAmt);

      // Inside smoke
      col = mix(col, vec3(0.6, 0.62, 0.64) + (hash(uv * 3.0 + uTime) - 0.5) * 0.02, clamp(uSmoke, 0.0, 0.96));

      // Flashbang: frozen afterimage + white-out
      vec3 after = texture2D(tAfter, uv).rgb;
      col = mix(col, max(col, after * 1.4), clamp(uAfter, 0.0, 1.0));
      col = mix(col, vec3(1.0), clamp(uFlash, 0.0, 1.0));

      // Death fade
      col *= 1.0 - uDeath * 0.35;

      // Film grain
      float n = hash(uv * uRes + fract(uTime) * 100.0);
      col += (n - 0.5) * 0.022;
      gl_FragColor = vec4(col, 1.0);
    }
  `,
};

const COPY_SHADER = {
  uniforms: { tDiffuse: { value: null as THREE.Texture | null } },
  vertexShader: GRADE_SHADER.vertexShader,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    varying vec2 vUv;
    void main() { gl_FragColor = texture2D(tDiffuse, vUv); }
  `,
};

/** Final colour grade + screen effects. Can freeze the current frame for flashbang afterimages. */
class GradePass extends Pass {
  readonly uniforms: typeof GRADE_SHADER.uniforms;
  private quad: FullScreenQuad;
  private copyQuad: FullScreenQuad;
  private copyMat: THREE.ShaderMaterial;
  private afterRT: THREE.WebGLRenderTarget;
  captureNext = false;

  constructor() {
    super();
    const mat = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.clone(GRADE_SHADER.uniforms),
      vertexShader: GRADE_SHADER.vertexShader,
      fragmentShader: GRADE_SHADER.fragmentShader,
      depthTest: false,
      depthWrite: false,
    });
    this.uniforms = mat.uniforms as typeof GRADE_SHADER.uniforms;
    this.quad = new FullScreenQuad(mat);
    this.copyMat = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.clone(COPY_SHADER.uniforms),
      vertexShader: COPY_SHADER.vertexShader,
      fragmentShader: COPY_SHADER.fragmentShader,
      depthTest: false,
      depthWrite: false,
    });
    this.copyQuad = new FullScreenQuad(this.copyMat);
    this.afterRT = new THREE.WebGLRenderTarget(4, 4);
    this.uniforms.tAfter.value = this.afterRT.texture;
  }

  override setSize(w: number, h: number): void {
    this.afterRT.setSize(Math.max(1, Math.floor(w / 2)), Math.max(1, Math.floor(h / 2)));
    this.uniforms.uRes.value.set(w, h);
  }

  override render(renderer: THREE.WebGLRenderer, writeBuffer: THREE.WebGLRenderTarget, readBuffer: THREE.WebGLRenderTarget): void {
    if (this.captureNext) {
      this.captureNext = false;
      this.copyMat.uniforms.tDiffuse.value = readBuffer.texture;
      renderer.setRenderTarget(this.afterRT);
      this.copyQuad.render(renderer);
    }
    this.uniforms.tDiffuse.value = readBuffer.texture;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.quad.render(renderer);
  }

  override dispose(): void {
    this.quad.dispose();
    this.copyQuad.dispose();
    this.afterRT.dispose();
  }
}

export class GameRenderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly vmScene = new THREE.Scene();
  readonly vmCamera: THREE.PerspectiveCamera;
  readonly grade: GradePass;
  private composer: EffectComposer;
  private worldPass: RenderPass;
  private vmPass: RenderPass;
  private bloom: UnrealBloomPass;
  private output: OutputPass;
  private smaa: SMAAPass | null = null;
  private fxaa: FXAAPass | null = null;
  private gtao: GTAOPass | null = null;
  private quality: Quality = 'high';
  private renderScale = 1;
  readonly canvas: HTMLCanvasElement;
  vmVisible = true;

  constructor(container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance', stencil: false });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.82;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.canvas = this.renderer.domElement;
    this.canvas.id = 'game-canvas';
    container.appendChild(this.canvas);

    this.camera = new THREE.PerspectiveCamera(75, 16 / 9, 0.05, 2500);
    this.vmCamera = new THREE.PerspectiveCamera(58, 16 / 9, 0.01, 10);

    this.composer = new EffectComposer(this.renderer);
    this.worldPass = new RenderPass(this.scene, this.camera);
    this.vmPass = new RenderPass(this.vmScene, this.vmCamera);
    this.vmPass.clear = false;
    this.vmPass.clearDepth = true;
    this.bloom = new UnrealBloomPass(new THREE.Vector2(512, 512), 0.42, 0.5, 1.25);
    this.output = new OutputPass();
    this.grade = new GradePass();
    this.rebuildChain();

    window.addEventListener('resize', () => this.resize());
    this.resize();
  }

  private rebuildChain(): void {
    const c = this.composer;
    while (c.passes.length) c.removePass(c.passes[0]);
    c.addPass(this.worldPass);
    if (this.quality === 'ultra') {
      if (!this.gtao) {
        this.gtao = new GTAOPass(this.scene, this.camera, 512, 512);
        this.gtao.blendIntensity = 0.85;
        this.gtao.updateGtaoMaterial({ radius: 0.45, distanceExponent: 1.5, thickness: 1.2, scale: 1, samples: 12 });
      }
      c.addPass(this.gtao);
    }
    c.addPass(this.vmPass);
    if (this.quality !== 'low') c.addPass(this.bloom);
    c.addPass(this.output);
    c.addPass(this.grade);
    if (this.quality === 'high' || this.quality === 'ultra') {
      if (!this.smaa) this.smaa = new SMAAPass();
      c.addPass(this.smaa);
    } else if (this.quality === 'medium') {
      if (!this.fxaa) this.fxaa = new FXAAPass();
      c.addPass(this.fxaa);
    }
    this.resize();
  }

  setQuality(q: Quality, renderScale: number): void {
    const changed = q !== this.quality;
    this.quality = q;
    this.renderScale = renderScale;
    this.renderer.shadowMap.enabled = true;
    if (changed) this.rebuildChain();
    else this.resize();
  }

  get pixelRatio(): number {
    const dpr = window.devicePixelRatio || 1;
    const cap = this.quality === 'low' ? 1 : this.quality === 'medium' ? 1.25 : this.quality === 'high' ? 1.5 : 2;
    return Math.min(dpr, cap) * this.renderScale;
  }

  resize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const pr = this.pixelRatio;
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(w, h);
    this.composer.setPixelRatio(pr);
    this.composer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.vmCamera.aspect = w / h;
    this.vmCamera.updateProjectionMatrix();
    this.bloom.resolution.set(Math.floor((w * pr) / 2), Math.floor((h * pr) / 2));
    this.gtao?.setSize(Math.floor(w * pr), Math.floor(h * pr));
  }

  /** Sets the world camera FOV from a horizontal FOV in degrees. */
  setHorizontalFov(hfovDeg: number): void {
    const aspect = window.innerWidth / Math.max(1, window.innerHeight);
    const v = 2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(hfovDeg) / 2) / aspect);
    this.camera.fov = THREE.MathUtils.radToDeg(v);
    this.camera.updateProjectionMatrix();
  }

  captureAfterimage(): void {
    this.grade.captureNext = true;
  }

  render(time: number): void {
    this.grade.uniforms.uTime.value = time;
    this.vmPass.enabled = this.vmVisible;
    this.composer.render();
  }
}

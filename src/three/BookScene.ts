/**
 * Interactive real-time 3D book (three.js). Framework-agnostic: give it a canvas, feed it
 * the book (`setInput`) and its artwork (`setTextures`); it runs its own render loop.
 *
 * Scene graph:  motion (lift / spin / tilt about the book centre)
 *                └ motionInner → stagePivot (standing ↔ lying) → root (pt → scene units, RTL mirror)
 *                   └ BookModel.group (a-space)
 */
import {
  ACESFilmicToneMapping,
  Color,
  Group,
  Mesh,
  PerspectiveCamera,
  PlaneGeometry,
  PMREMGenerator,
  Scene,
  ShadowMaterial,
  SRGBColorSpace,
  Vector2,
  Vector3,
  VSMShadowMap,
  WebGLRenderer,
  type Texture,
  type WebGLProgramParametersWithUniforms,
  type WebGLRenderTarget,
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { mm } from '../model/units';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import {
  ANIMATION_INFO,
  STAGE_ANGLED,
  animationDuration,
  clamp01,
  easeInOutCubic,
  elevationFor,
  leafTurns,
  sampleTimeline,
  type CameraKey,
  type TimelineBook,
  type TimelineSample,
} from './animation';
import { Backdrop, DEFAULT_BACKDROP, isSurface, resolveBackdrop, type ResolvedBackdrop } from './backdrop';
import { ContactShadow } from './contactShadow';
import { BookModel, type BookBounds } from './geometry';
import { SCENE_UNITS_PER_PT, computeLayout, type BookLayout } from './layout';
import { LightRig, resolveLighting, type ResolvedLighting } from './lighting';
import { BookMaterials, TextureCache, createCanvas, type PanelArt } from './materials';
import type {
  AnimationInfo,
  AnimationMode,
  AnimationOptions,
  BackdropOptions,
  BookSceneInput,
  BookSceneOptions,
  BookTextures,
  CameraOptions,
  CameraPose,
  EnvironmentOptions,
  LightingOptions,
  TextureDemand,
} from './types';
import type { WrapRegion } from './regions';

const DEFAULT_BACKGROUND = '#d9d4cb';
/** Seconds to lay the book down / stand it up in the interactive viewer. */
const STAGE_TIME = 0.7;
const OPEN_TIME = 1.1;
/** Framing margin around the book's bounds. */
const MARGIN = 1.1;

/** Time-based tween; `value` is eased unless `linear`. */
class Tween {
  value: number;
  private from: number;
  private to: number;
  private start = 0;
  private dur = 0;
  constructor(v: number, private readonly linear = false) {
    this.value = this.from = this.to = v;
  }
  get target(): number {
    return this.to;
  }
  get active(): boolean {
    return this.dur > 0;
  }
  set(v: number): void {
    this.value = this.from = this.to = v;
    this.dur = 0;
  }
  animate(to: number, now: number, seconds: number, delay = 0): void {
    this.from = this.value;
    this.to = to;
    this.start = now + delay * 1000;
    this.dur = Math.max(1, seconds * 1000);
  }
  /** Returns true while running. */
  update(now: number): boolean {
    if (this.dur <= 0) return false;
    const t = clamp01((now - this.start) / this.dur);
    this.value = this.from + (this.to - this.from) * (this.linear ? t : easeInOutCubic(t));
    if (t >= 1) {
      this.value = this.to;
      this.dur = 0;
    }
    return true;
  }
}

interface RestBounds {
  corners: Vector3[];
  center: Vector3;
  size: Vector3;
}

interface SavedCamera {
  position: Vector3;
  target: Vector3;
}

export class BookScene {
  readonly canvas: HTMLCanvasElement;
  private readonly renderer: WebGLRenderer;
  private readonly scene = new Scene();
  private readonly camera = new PerspectiveCamera(30, 1, 0.5, 1200);
  private readonly controls: OrbitControls;
  private pmrem: PMREMGenerator;
  private envTarget: WebGLRenderTarget;
  private readonly lights = new LightRig();
  private readonly ground: Mesh<PlaneGeometry, ShadowMaterial>;
  private readonly groundFade = { value: 30 };
  private readonly contact = new ContactShadow(512);
  private readonly backdrop = new Backdrop();
  private readonly motion = new Group();
  private readonly motionInner = new Group();
  /** Rotates the book between standing (0) and lying (1) about the tail edge of the back cover. */
  private readonly stagePivot = new Group();
  /** Scales a-space points to scene units and mirrors right-to-left books. */
  private readonly root = new Group();
  private readonly cache: TextureCache;

  private input: BookSceneInput | null = null;
  private layout: BookLayout | null = null;
  private model: BookModel | null = null;
  private materials: BookMaterials | null = null;
  private textures: BookTextures | null = null;

  private lightingOpts: LightingOptions = { preset: 'studio' };
  private lighting: ResolvedLighting = resolveLighting({ preset: 'studio' });
  private backdropState: ResolvedBackdrop = DEFAULT_BACKDROP;
  private shadows = true;
  private span = 30;

  private readonly openTw = new Tween(0);
  private readonly leafTw = new Tween(0, true);
  private readonly stageTw = new Tween(0);
  private closePending = false;
  private pose: CameraPose = 'standing';

  private mode: AnimationMode = 'none';
  private animOpts: AnimationOptions = {};
  private playing = false;
  private playStart = 0;
  private playFrom = 0;
  private time = 0;
  /** The pose comes from setOpen/setLeaf instead of the (paused) timeline. */
  private manual = true;
  private userCamera = false;

  private sample: TimelineSample = { open: 0, leaves: [], stage: 0, cam: null };
  private rest: RestBounds = { corners: [], center: new Vector3(), size: new Vector3(1, 1, 1) };
  private lastPose = '';
  private poseDirty = true;
  private dirty = true;
  private raf = 0;
  private offline = false;
  private savedCamera: SavedCamera | null = null;
  private disposed = false;
  private live = { w: 300, h: 150, pr: 1 };

  constructor(canvas: HTMLCanvasElement, opts?: BookSceneOptions) {
    this.canvas = canvas;
    const r = new WebGLRenderer({
      canvas,
      antialias: true,
      // Alpha so a transparent backdrop can be composited; opaque backdrops clear with alpha 1.
      alpha: true,
      premultipliedAlpha: true,
      preserveDrawingBuffer: !!opts?.preserveDrawingBuffer,
      powerPreference: 'high-performance',
    });
    this.renderer = r;
    r.outputColorSpace = SRGBColorSpace;
    r.toneMapping = ACESFilmicToneMapping;
    r.toneMappingExposure = 1;
    r.shadowMap.enabled = true;
    // Variance shadow maps: blur radius gives a key light that reads like a large softbox.
    r.shadowMap.type = VSMShadowMap;
    r.shadowMap.autoUpdate = false;
    // Full anisotropic filtering keeps type crisp on pages seen at an angle.
    this.cache = new TextureCache(r.capabilities.getMaxAnisotropy(), r.capabilities.maxTextureSize);

    this.backdropState = { ...DEFAULT_BACKDROP, color: opts?.background ?? DEFAULT_BACKGROUND };
    this.pmrem = new PMREMGenerator(r);
    this.envTarget = this.makeEnvironment();
    this.onContextChange = opts?.onContextChange;
    canvas.addEventListener('webglcontextlost', this.contextLost);
    canvas.addEventListener('webglcontextrestored', this.contextRestored);
    this.scene.add(...this.lights.objects);

    this.ground = new Mesh(new PlaneGeometry(400, 400).rotateX(-Math.PI / 2), new ShadowMaterial({ opacity: 0.22 }));
    // Fade the cast shadow out well inside the shadow frustum (no visible frustum edge).
    const fade = this.groundFade;
    this.ground.material.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms) => {
      shader.uniforms.fadeRadius = fade;
      shader.vertexShader = `varying vec2 vGroundXZ;\n${shader.vertexShader.replace(
        '#include <worldpos_vertex>',
        '#include <worldpos_vertex>\n\tvGroundXZ = ( modelMatrix * vec4( transformed, 1.0 ) ).xz;',
      )}`;
      shader.fragmentShader = `uniform float fadeRadius;\nvarying vec2 vGroundXZ;\n${shader.fragmentShader.replace(
        'gl_FragColor = vec4( color, opacity * ( 1.0 - getShadowMask() ) );',
        'gl_FragColor = vec4( color, opacity * ( 1.0 - getShadowMask() ) * ( 1.0 - smoothstep( 0.5, 0.92, length( vGroundXZ ) / fadeRadius ) ) );',
      )}`;
    };
    this.ground.position.y = -0.002;
    this.ground.receiveShadow = true;
    // VSM needs a backdrop in the shadow map, or the blur mixes the book with the far plane.
    this.ground.castShadow = true;
    this.scene.add(this.ground, this.contact.group, this.backdrop.group);

    this.stagePivot.add(this.root);
    this.motionInner.add(this.stagePivot);
    this.motion.add(this.motionInner);
    this.motion.rotation.order = 'YXZ';
    this.scene.add(this.motion);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.addEventListener('start', () => {
      this.userCamera = true;
      this.dirty = true;
    });
    this.controls.addEventListener('change', () => {
      this.dirty = true;
    });
    window.addEventListener('keydown', this.keyDown);
    window.addEventListener('keyup', this.keyUp);
    window.addEventListener('blur', this.keysOff);
    document.addEventListener('visibilitychange', this.keysOff);

    this.applyLighting();
    this.applyBackdrop();
    const w = canvas.clientWidth || canvas.width || 300;
    const h = canvas.clientHeight || canvas.height || 150;
    this.resize(w, h, typeof window !== 'undefined' ? window.devicePixelRatio : 1);
    this.raf = requestAnimationFrame(this.frame);
  }

  /* ----------------------------------------------------------------------- */
  /* Content                                                                  */
  /* ----------------------------------------------------------------------- */

  setInput(input: BookSceneInput): void {
    this.input = input;
    this.rebuild();
  }

  setTextures(tex: BookTextures): void {
    this.textures = tex;
    this.cache.refresh(tex);
    if (this.materials && this.model) {
      this.materials.applyTextures(tex);
      this.model.refreshLeafFlags();
    }
    this.poseDirty = true;
    this.dirty = true;
  }

  private rebuild(): void {
    const input = this.input;
    if (!input) return;
    this.disposeModel();
    const layout = computeLayout(input);
    const materials = new BookMaterials(input, layout, this.cache);
    materials.applyTextures(this.textures);
    const model = new BookModel(layout, input, materials);
    this.layout = layout;
    this.materials = materials;
    this.model = model;
    const k = SCENE_UNITS_PER_PT;
    const sx = layout.rtl ? -1 : 1;
    // Standing, the book rests on its tail-most point; lying, on its lowest one (a jacket or the
    // sewing thread under the back cover lifts the book off the ground).
    const zt = model.zTail * k;
    this.stagePivot.position.set(0, 0, zt);
    this.root.scale.set(sx * k, k, k);
    this.root.position.set(-sx * k * ((layout.a0 + layout.a1) / 2), model.groundLift * k, -zt);
    this.root.add(model.group);
    this.span = Math.max(layout.a1 - layout.a0, layout.coverH, layout.W * 2) * k;
    // Clamp the interactive leaf state to the leaves this book models.
    if (this.leafTw.value > layout.nTurn) this.leafTw.set(layout.nTurn);
    this.placeShadowFrustum();
    this.applyLighting();
    this.applyBackdrop();
    this.lastPose = '';
    this.poseDirty = true;
    this.dirty = true;
    this.applyCurrent();
  }

  private disposeModel(): void {
    if (this.model) {
      this.root.remove(this.model.group);
      this.model.dispose();
    }
    this.materials?.dispose();
    this.model = null;
    this.materials = null;
  }

  /** Shadow frustum, contact-shadow area and orbit limits sized to the book. */
  private placeShadowFrustum(): void {
    const span = this.span;
    const reach = span * 1.35;
    const dist = span * 3;
    const cam = this.lights.key.shadow.camera;
    cam.left = -reach;
    cam.right = reach;
    cam.top = reach;
    cam.bottom = -reach;
    cam.near = dist * 0.3;
    cam.far = dist * 2;
    cam.updateProjectionMatrix();
    this.lights.key.shadow.normalBias = 0.0006 * span;
    this.groundFade.value = reach;
    const L = this.layout;
    // Contact shadow: what is near the floor (a book lying, the foot of one standing). It fades
    // within a quarter of the book's height, so a book lifted off the table (float, drop-in) or
    // a leaf in flight no longer leaves a black blob under it; the key light's shadow stays.
    this.contact.setArea(0, 0, span * 2.4, span * 2.4, (L ? Math.max(L.thick * 2, L.coverH * 0.25) * SCENE_UNITS_PER_PT : span * 0.25));
    this.controls.minDistance = span * 0.2;
    this.controls.maxDistance = span * 12;
    this.renderer.shadowMap.needsUpdate = true;
  }

  /* ----------------------------------------------------------------------- */
  /* Environment, lighting, backdrop, camera                                  */
  /* ----------------------------------------------------------------------- */

  /** Legacy switchboard, mapped onto setBackdrop / setLighting. */
  setEnvironment(opts: EnvironmentOptions): void {
    if (opts.lightIntensity != null || opts.shadows != null) {
      if (opts.shadows != null) this.shadows = opts.shadows;
      if (opts.lightIntensity != null) this.lightingOpts = { ...this.lightingOpts, intensity: opts.lightIntensity };
      this.applyLighting();
    }
    const p = this.backdropState.preset;
    const colourDriven = p === 'solid' || p === 'gradient' || p === 'studio-sweep';
    this.setBackdrop({
      preset: p,
      color: opts.background != null && colourDriven ? opts.background : undefined,
      showGround: opts.showGround,
    });
  }

  setLighting(o: LightingOptions): void {
    // A new preset replaces the look; fields without a preset refine the current one.
    this.lightingOpts = o.preset ? { ...o } : { ...this.lightingOpts, ...o };
    this.applyLighting();
  }

  setBackdrop(o: BackdropOptions): void {
    this.backdropState = resolveBackdrop(o, this.backdropState);
    this.applyBackdrop();
  }

  /** True when the backdrop clears to alpha 0 (stills / WebM can be composited). */
  hasTransparentBackground(): boolean {
    return this.backdropState.preset === 'transparent';
  }

  private applyLighting(): void {
    const l = resolveLighting(this.lightingOpts);
    this.lighting = l;
    this.lights.apply(l, new Vector3(0, 0, 0), this.span, !!this.layout?.rtl, this.shadows);
    this.renderer.toneMappingExposure = l.exposure;
    this.scene.environmentIntensity = 0.55 * l.ambient;
    this.applyShadowStrength();
    this.applyBackground();
    this.renderer.shadowMap.needsUpdate = true;
    this.dirty = true;
  }

  private applyBackdrop(): void {
    const st = this.backdropState;
    this.backdrop.build(st, this.span, this.cache.anisotropy);
    // The flat shadow catcher lies on every floor (plain, surface or cove) and stays in the shadow
    // map as the VSM backdrop even when the ground is hidden.
    const catcher = st.showGround;
    this.ground.visible = true;
    this.ground.castShadow = true;
    this.ground.material.colorWrite = catcher;
    this.ground.material.depthWrite = catcher;
    this.contact.group.visible = st.showGround;
    this.controls.maxPolarAngle = st.showGround ? Math.PI / 2 - 0.03 : Math.PI;
    this.applyShadowStrength();
    this.applyBackground();
    this.renderer.shadowMap.needsUpdate = true;
    this.poseDirty = true;
    this.dirty = true;
  }

  /** Cast-shadow strength: softer light gives lighter shadows; textured floors need more. */
  private applyShadowStrength(): void {
    const p = this.backdropState.preset;
    const textured = isSurface(p) || p === 'studio-sweep';
    this.ground.material.opacity = (0.3 - 0.12 * this.lighting.shadowSoftness) * (textured ? 1.7 : 1);
  }

  private applyBackground(): void {
    const bg: Color | Texture | null = this.backdrop.background(this.lighting.backdrop);
    this.scene.background = bg;
    if (bg === null) this.renderer.setClearColor(0x000000, 0);
    else if (bg instanceof Color) this.renderer.setClearColor(bg, 1);
    else this.renderer.setClearColor(0x000000, 1);
    this.dirty = true;
  }

  setCamera(o: CameraOptions): void {
    if (o.fov != null && Number.isFinite(o.fov)) {
      const prev = this.camera.fov;
      const fov = Math.max(15, Math.min(75, o.fov));
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
      if (this.userCamera) {
        // Keep the book the same size on screen: dolly with the lens change.
        const k = Math.tan((prev * Math.PI) / 360) / Math.tan((fov * Math.PI) / 360);
        const offset = this.camera.position.clone().sub(this.controls.target).multiplyScalar(k);
        this.camera.position.copy(this.controls.target).add(offset);
        this.controls.update();
      } else this.applyCurrent();
      this.dirty = true;
    }
    if (o.pose && o.pose !== this.pose) {
      this.pose = o.pose;
      this.enterManual();
      const now = performance.now();
      if (o.pose === 'open') {
        this.closePending = false;
        const lying = this.stageTw.value >= 0.999;
        this.stageTw.animate(1, now, lying ? 0.001 : STAGE_TIME);
        this.openTw.animate(1, now, OPEN_TIME * Math.max(0.35, 1 - this.openTw.value), lying ? 0 : STAGE_TIME * 0.9);
      } else if (this.openTw.value > 0.001) {
        this.openTw.animate(0, now, OPEN_TIME * Math.max(0.35, this.openTw.value));
        this.closePending = true;
      } else {
        this.stageTw.animate(this.restStage(), now, STAGE_TIME);
      }
      this.dirty = true;
    }
  }

  private restStage(): number {
    return this.pose === 'standing' ? 0 : this.pose === 'angled' ? STAGE_ANGLED : 1;
  }

  /* ----------------------------------------------------------------------- */
  /* Interactive pose                                                         */
  /* ----------------------------------------------------------------------- */

  private nTurn(): number {
    return this.layout?.nTurn ?? 0;
  }

  private book(): TimelineBook {
    return { nTurn: this.nTurn(), height: this.layout?.coverH ?? 600 };
  }

  /** Hand the pose to setOpen/setLeaf (pauses a running animation). */
  private enterManual(): void {
    if (this.mode !== 'none' && !this.manual) {
      this.playing = false;
      // Continue from wherever the timeline left the book.
      const s = this.timelineSample(this.time);
      this.openTw.set(s.open);
      this.stageTw.set(s.stage);
      let pos = 0;
      for (const v of s.leaves) pos += v;
      this.leafTw.set(pos);
    }
    this.manual = true;
  }

  setOpen(amount: number, animate = false): void {
    const a = clamp01(Number.isFinite(amount) ? amount : 0);
    this.enterManual();
    const now = performance.now();
    if (a > 0) {
      this.closePending = false;
      const lying = this.stageTw.target >= 1 && this.stageTw.value >= 0.999;
      this.stageTw.animate(1, now, lying ? 0.001 : STAGE_TIME);
      if (animate) this.openTw.animate(a, now, OPEN_TIME * Math.max(0.35, Math.abs(a - this.openTw.value)), lying ? 0 : STAGE_TIME * 0.9);
      else this.openTw.set(a);
    } else if (animate) {
      // Turned leaves close together with the cover; then the book returns to its resting pose.
      this.openTw.animate(0, now, OPEN_TIME * Math.max(0.35, this.openTw.value));
      this.closePending = true;
    } else {
      this.openTw.set(0);
      this.leafTw.set(0);
      this.stageTw.animate(this.restStage(), now, STAGE_TIME);
    }
    this.dirty = true;
  }

  setLeaf(leavesTurned: number, animate = false): void {
    const n = this.nTurn();
    const target = Math.max(0, Math.min(n, Number.isFinite(leavesTurned) ? leavesTurned : 0));
    this.enterManual();
    const now = performance.now();
    let delay = 0;
    if (target > 0 && this.openTw.target < 1) {
      const lying = this.stageTw.value >= 0.999;
      this.closePending = false;
      this.stageTw.animate(1, now, lying ? 0.001 : STAGE_TIME);
      if (animate) {
        delay = (lying ? 0 : STAGE_TIME * 0.9) + OPEN_TIME * Math.max(0.35, 1 - this.openTw.value);
        this.openTw.animate(1, now, OPEN_TIME * Math.max(0.35, 1 - this.openTw.value), lying ? 0 : STAGE_TIME * 0.9);
      } else this.openTw.set(1);
    }
    if (animate) {
      const d = Math.min(4, Math.max(0.7, 0.95 * Math.abs(target - this.leafTw.value)));
      this.leafTw.animate(target, now, d, delay * 0.85);
    } else this.leafTw.set(target);
    this.dirty = true;
  }

  private staticSample(): TimelineSample {
    return {
      open: this.openTw.value,
      leaves: leafTurns(this.leafTw.value, this.nTurn()),
      stage: this.stageTw.value,
      cam: null,
    };
  }

  private updateTweens(now: number): boolean {
    let active = false;
    if (this.stageTw.update(now)) active = true;
    if (this.openTw.update(now)) active = true;
    if (this.leafTw.update(now)) active = true;
    if (this.closePending && !this.openTw.active) {
      this.closePending = false;
      this.leafTw.set(0);
      this.stageTw.animate(this.restStage(), now, STAGE_TIME);
      active = true;
    }
    return active;
  }

  /* ----------------------------------------------------------------------- */
  /* Animation                                                                */
  /* ----------------------------------------------------------------------- */

  setAnimation(mode: AnimationMode, opts: AnimationOptions = {}): void {
    if (mode === 'none' && this.mode !== 'none') this.enterManual();
    this.mode = mode;
    this.animOpts = { ...opts };
    this.time = 0;
    this.playStart = performance.now();
    this.playFrom = 0;
    if (mode === 'none') {
      this.playing = false;
      this.manual = true;
    } else {
      this.manual = false;
      this.userCamera = false;
    }
    this.applyCurrent();
  }

  play(): void {
    if (this.mode === 'none') return;
    const d = this.getAnimationDuration();
    if (this.animOpts.loop === false && this.time >= d) this.time = 0;
    this.manual = false;
    this.playing = true;
    this.playFrom = this.time;
    this.playStart = performance.now();
    this.dirty = true;
  }

  pause(): void {
    this.playing = false;
  }

  isPlaying(): boolean {
    return this.playing;
  }

  getAnimationDuration(): number {
    return animationDuration(this.mode, this.animOpts, this.book());
  }

  /** Every available animation, with its duration for the current book. */
  getAnimations(): AnimationInfo[] {
    const book = this.book();
    const jacket = this.model?.hasJacket ?? false;
    return ANIMATION_INFO.map((a) => ({
      id: a.id,
      label: a.label,
      duration: +animationDuration(a.id, { pagesToTurn: this.animOpts.pagesToTurn }, book).toFixed(2),
      description: a.id === 'jacket-off' && !jacket ? `${a.description} This book has no jacket, so only the camera move plays.` : a.description,
    }));
  }

  seek(t: number): void {
    this.time = Number.isFinite(t) ? t : 0;
    if (this.mode !== 'none') this.manual = false;
    if (this.playing) {
      this.playFrom = this.time;
      this.playStart = performance.now();
    }
    this.applyAt(this.time, true);
  }

  private timelineSample(t: number): TimelineSample {
    return sampleTimeline(this.mode, this.animOpts, t, this.book(), {
      open: this.openTw.value,
      leaf: this.leafTw.value,
      stage: this.stageTw.value,
    });
  }

  /** Pose book (+ camera when `camera`) at timeline time t. Pure in t. */
  private applyAt(t: number, camera: boolean): void {
    const s = this.mode === 'none' || this.manual ? this.staticSample() : this.timelineSample(t);
    this.applySample(s);
    if (camera && (s.cam || !this.userCamera)) this.frameCamera(s);
  }

  private applyCurrent(): void {
    this.applyAt(this.time, !this.userCamera);
  }

  private applySample(s: TimelineSample): void {
    const stage = clamp01(s.stage);
    const k = SCENE_UNITS_PER_PT;
    // Pose at rest first (no rigid motion), to measure the bounds the camera frames.
    this.motion.position.set(0, 0, 0);
    this.motion.rotation.set(0, 0, 0);
    this.motionInner.position.set(0, 0, 0);
    this.stagePivot.rotation.x = (1 - stage) * (Math.PI / 2);
    if (this.model) {
      this.model.setPose(s.open, s.leaves, stage);
      this.model.setJacketOffset(s.jacket ?? 0);
    }
    this.motion.updateMatrixWorld(true);
    this.measureRest(s.open);
    const lift = s.lift ?? 0, spin = s.spin ?? 0, tilt = s.tilt ?? 0;
    if (lift !== 0 || spin !== 0 || tilt !== 0) {
      const c = this.rest.center;
      this.motion.position.set(c.x, lift * k, c.z);
      this.motion.rotation.set(tilt, spin * (this.layout?.rtl ? -1 : 1), 0);
      this.motionInner.position.set(-c.x, 0, -c.z);
      this.motion.updateMatrixWorld(true);
      // A tilted book rocks on its lowest edge rather than sinking into the floor.
      const m = this.motionInner.matrixWorld;
      let low = Infinity;
      const p = new Vector3();
      for (const q of this.rest.corners) low = Math.min(low, p.copy(q).applyMatrix4(m).y);
      if (low < 0) {
        this.motion.position.y -= low;
        this.motion.updateMatrixWorld(true);
      }
    }
    // Exact: two poses that merely round alike must not share shadows (frame-exact video).
    const key = [s.open, stage, lift, spin, tilt, s.jacket ?? 0].join('|') + '#' + s.leaves.join(',');
    if (key !== this.lastPose) {
      this.lastPose = key;
      this.poseDirty = true;
    }
    this.sample = s;
    this.dirty = true;
  }

  /** World-space bounds of the posed book without rigid motion. */
  private measureRest(open: number): void {
    const corners: Vector3[] = [];
    const center = new Vector3();
    const size = new Vector3(1, 1, 1);
    if (this.model) {
      const b = this.model.bounds(clamp01(open));
      const m = this.model.group.matrixWorld;
      const min = new Vector3(Infinity, Infinity, Infinity), max = new Vector3(-Infinity, -Infinity, -Infinity);
      for (const a of [b.a0, b.a1]) for (const y of [b.y0, b.y1]) for (const z of [b.z0, b.z1]) {
        const p = new Vector3(a, y, z).applyMatrix4(m);
        corners.push(p);
        min.min(p);
        max.max(p);
      }
      center.addVectors(min, max).multiplyScalar(0.5);
      size.subVectors(max, min);
    } else {
      for (const x of [-1, 1]) for (const y of [0, 2]) for (const z of [-1, 1]) corners.push(new Vector3(x * 8, y * 6, z * 11));
      center.set(0, 6, 0);
      size.set(16, 12, 22);
    }
    this.rest = { corners, center, size };
  }

  /* ----------------------------------------------------------------------- */
  /* Camera                                                                   */
  /* ----------------------------------------------------------------------- */

  private baseAzimuth(): number {
    return this.layout?.rtl ? 0.55 : -0.55;
  }

  /** Direction from the target toward the camera for azimuth / elevation (radians). */
  private static viewDir(az: number, el: number): Vector3 {
    return new Vector3(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az));
  }

  /**
   * Smallest camera distance (from `center`, looking along −f) at which every corner of the rest
   * bounds fits both the horizontal and the vertical field of view, with the framing margin.
   */
  private fitDistance(f: Vector3, aspect: number, center: Vector3, corners: Vector3[] = this.rest.corners): number {
    const tanV = Math.tan((this.camera.fov * Math.PI) / 360);
    const tanH = tanV * aspect;
    const up = Math.abs(f.y) > 0.999 ? new Vector3(0, 0, -1) : new Vector3(0, 1, 0);
    const r = up.cross(f).normalize();
    const u = new Vector3().crossVectors(f, r);
    const d = new Vector3();
    let dist = 0.5;
    for (const p of corners) {
      d.subVectors(p, center);
      const depth = d.dot(f);
      dist = Math.max(dist, depth + Math.abs(d.dot(r)) / tanH, depth + Math.abs(d.dot(u)) / tanV);
    }
    return dist * MARGIN;
  }

  /** Place the camera to frame the book for a pose (auto framing, aspect aware). */
  private frameCamera(s: TimelineSample): void {
    const cam: CameraKey = s.cam ?? { az: 0, el: elevationFor(s.stage, s.open), zoom: 1 };
    const sx = this.layout?.rtl ? -1 : 1;
    // The 3/4 view swings toward head-on as the book opens: a spread reads best square on.
    const az = this.baseAzimuth() * (1 - 0.65 * clamp01(s.open)) + sx * cam.az;
    const el = Math.max(0.03, Math.min(1.45, cam.el));
    const { size } = this.rest;
    let corners = this.rest.corners;
    const center = this.rest.center.clone();
    if (cam.headroom && cam.headroom > 0) {
      // Keep the book's highest point in frame as well (it rises above its rest position).
      const up = cam.headroom * SCENE_UNITS_PER_PT;
      corners = [...corners, ...corners.map((p) => p.clone().setY(p.y + up))];
      center.y += up / 2;
    }
    const aspect = this.camera.aspect;
    let dist = 0;
    if (cam.stable) {
      for (let i = 0; i < 12; i++) dist = Math.max(dist, this.fitDistance(BookScene.viewDir((i * Math.PI) / 6, el), aspect, center, corners));
    } else dist = this.fitDistance(BookScene.viewDir(az, el), aspect, center, corners);
    dist *= cam.zoom;
    const target = center.clone();
    if (cam.pan) target.add(new Vector3(size.x * cam.pan[0] * sx, size.y * cam.pan[1], size.z * cam.pan[2]));
    this.camera.position.copy(target).addScaledVector(BookScene.viewDir(az, el), dist);
    this.camera.lookAt(target);
    this.controls.target.copy(target);
    this.dirty = true;
  }

  /** Re-fit a user-placed camera to another aspect, keeping its direction and relative zoom. */
  private refitUserCamera(fromAspect: number, toAspect: number): void {
    const target = this.controls.target;
    const offset = this.camera.position.clone().sub(target);
    const dist = offset.length();
    if (dist < 1e-6) return;
    const f = offset.clone().normalize();
    const ratio = dist / this.fitDistance(f, fromAspect, target);
    this.camera.position.copy(target).addScaledVector(f, ratio * this.fitDistance(f, toAspect, target));
    this.camera.lookAt(target);
  }

  resetCamera(): void {
    this.userCamera = false;
    this.applyCurrent();
    this.controls.update();
  }

  /* ----------------------------------------------------------------------- */
  /* Texture resolution                                                       */
  /* ----------------------------------------------------------------------- */

  /** Largest texture the GPU takes (px per side). */
  get maxTextureSize(): number {
    return this.renderer.capabilities.maxTextureSize;
  }

  /** Demand for the current camera on a viewport of vw × vh device pixels. */
  private demandNow(vw: number, vh: number): TextureDemand {
    const model = this.model;
    if (!model) return { pages: [], cover: {}, jacket: {} };
    this.camera.updateMatrixWorld();
    model.group.updateMatrixWorld(true);
    const m = model.group.matrixWorld;
    const v = new Vector3();
    const toScreen = (a: number, y: number, z: number): [number, number] | null => {
      v.set(a, y, z).applyMatrix4(m).project(this.camera);
      // Off-screen points still count (a close-up spans few samples); behind the camera they don't.
      if (v.z < -1 || v.z > 1 || Math.abs(v.x) > 10 || Math.abs(v.y) > 10) return null;
      return [((v.x + 1) / 2) * vw, ((1 - v.y) / 2) * vh];
    };
    const eye = model.group.worldToLocal(this.camera.position.clone());
    const d = model.textureDemand(toScreen, [eye.x, eye.y, eye.z], [vw, vh]);
    return {
      pages: [...d.pages.entries()].map(([index, pxPerPt]) => ({ index, pxPerPt })).sort((p, q) => q.pxPerPt - p.pxPerPt),
      cover: d.cover,
      jacket: d.jacket,
    };
  }

  /**
   * What the book's textures need to look sharp (px per pt of page / cover art, 0 = not in view):
   * for the live view, or — given a size — for a still rendered at width × height.
   */
  getTextureDemand(width?: number, height?: number): TextureDemand {
    if (width == null || height == null) {
      const size = this.renderer.getDrawingBufferSize(new Vector2());
      return this.demandNow(size.x, size.y);
    }
    const position = this.camera.position.clone(), target = this.controls.target.clone(), aspect = this.camera.aspect;
    const liveAspect = this.live.w / this.live.h;
    if (this.manual || this.mode === 'none') this.applySample(this.staticSample());
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    if (this.userCamera) this.refitUserCamera(liveAspect, width / height);
    else this.frameCamera(this.sample);
    const d = this.demandNow(width, height);
    this.camera.position.copy(position);
    this.controls.target.copy(target);
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
    this.camera.lookAt(target);
    return d;
  }

  /** The most every texture needs over the current animation, rendered at width × height. */
  getAnimationTextureDemand(width: number, height: number, samples = 48): TextureDemand {
    if (this.mode === 'none' || this.manual) return this.getTextureDemand(width, height);
    const position = this.camera.position.clone(), target = this.controls.target.clone(), aspect = this.camera.aspect;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    const D = this.getAnimationDuration();
    const pages = new Map<number, number>();
    const cover: TextureDemand['cover'] = {}, jacket: TextureDemand['jacket'] = {};
    const most = (into: TextureDemand['cover'], from: TextureDemand['cover']) => {
      for (const [r, v] of Object.entries(from) as [WrapRegion, number][]) into[r] = Math.max(into[r] ?? 0, v);
    };
    for (let i = 0; i < samples; i++) {
      this.applyAt((D * i) / samples, true);
      const d = this.demandNow(width, height);
      for (const p of d.pages) pages.set(p.index, Math.max(pages.get(p.index) ?? 0, p.pxPerPt));
      most(cover, d.cover);
      most(jacket, d.jacket);
    }
    this.applyAt(this.time, false);
    this.camera.position.copy(position);
    this.controls.target.copy(target);
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
    this.camera.lookAt(target);
    return { pages: [...pages.entries()].map(([index, pxPerPt]) => ({ index, pxPerPt })).sort((p, q) => q.pxPerPt - p.pxPerPt), cover, jacket };
  }

  /** Sharper art for page `index` (index 0 = page 1); null restores the base art. */
  setPageArt(index: number, art: HTMLCanvasElement | ImageBitmap | null): void {
    if (this.materials?.setPageArt(index, art)) this.dirty = true;
    // The scene owns a bitmap it is given; one for a page it does not model is freed now.
    else if (art && typeof ImageBitmap !== 'undefined' && art instanceof ImageBitmap) art.close();
  }

  /** Sharper art for a region (front, back, spine, flap) of the cover or jacket (see PanelArt); null restores it. */
  setPanelArt(which: 'cover' | 'jacket', region: WrapRegion, art: PanelArt | null): void {
    this.materials?.setPanelArt(which, region, art);
    this.dirty = true;
  }

  /* ----------------------------------------------------------------------- */
  /* Rendering                                                                */
  /* ----------------------------------------------------------------------- */

  resize(width: number, height: number, pixelRatio?: number): void {
    this.offline = false;
    if (this.savedCamera) {
      this.camera.position.copy(this.savedCamera.position);
      this.controls.target.copy(this.savedCamera.target);
      this.savedCamera = null;
    }
    const w = Math.max(1, Math.round(width));
    const h = Math.max(1, Math.round(height));
    const pr = Math.min(3, Math.max(0.5, pixelRatio ?? (typeof window !== 'undefined' ? window.devicePixelRatio : 1)));
    const fromAspect = this.camera.aspect;
    this.live = { w, h, pr };
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    if (!this.userCamera) this.applyCurrent();
    else if (Math.abs(fromAspect - this.camera.aspect) > 1e-3) this.refitUserCamera(fromAspect, this.camera.aspect);
    this.dirty = true;
  }

  render(): void {
    this.renderNow();
  }

  /** Size the drawing buffer for an offline render and aim the camera for that aspect. */
  private prepareOffline(w: number, h: number): void {
    if (this.canvas.width !== w || this.canvas.height !== h || this.renderer.getPixelRatio() !== 1) {
      this.renderer.setPixelRatio(1);
      this.renderer.setSize(w, h, false);
    }
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /**
   * For video export: pose at t (timeline modes pose the camera too), render at exactly
   * width × height into the scene canvas and return it. The caller restores the size with resize().
   */
  renderFrame(t: number, width: number, height: number): HTMLCanvasElement {
    this.assertContext();
    // Hold the live loop (and the camera keys) until the caller restores the size with resize().
    if (!this.offline) this.keysOff();
    this.offline = true;
    const w = Math.max(2, Math.round(width));
    const h = Math.max(2, Math.round(height));
    const liveAspect = this.live.w / this.live.h;
    this.prepareOffline(w, h);
    const timeline = this.mode !== 'none' && !this.manual;
    if (timeline || !this.userCamera) this.applyAt(t, true);
    else {
      this.applyAt(t, false);
      if (!this.savedCamera) this.savedCamera = { position: this.camera.position.clone(), target: this.controls.target.clone() };
      this.camera.position.copy(this.savedCamera.position);
      this.controls.target.copy(this.savedCamera.target);
      this.refitUserCamera(liveAspect, w / h);
    }
    this.renderNow();
    return this.canvas;
  }

  /**
   * A still of the current pose and camera at exactly width × height (aspect-aware framing; a
   * transparent backdrop gives alpha). Returns a separate 2D canvas, ready for toBlob(); the live
   * view is restored before returning.
   */
  renderStill(width: number, height: number): HTMLCanvasElement {
    this.assertContext();
    const w = Math.max(2, Math.round(width));
    const h = Math.max(2, Math.round(height));
    const wasOffline = this.offline;
    this.offline = true;
    this.keysOff();
    const position = this.camera.position.clone();
    const target = this.controls.target.clone();
    const liveAspect = this.live.w / this.live.h;
    // The current pose, even if the render loop hasn't applied the latest setOpen / setLeaf yet.
    if (this.manual || this.mode === 'none') this.applySample(this.staticSample());
    // Supersampled (on top of MSAA) where the GPU allows: page edges a fraction of a pixel thick,
    // deckles, die-cut windows and fine type stay clean instead of stair-stepping.
    const caps = this.renderer.capabilities;
    const limit = Math.min(caps.maxTextureSize, 8192);
    const ss = Math.max(1, Math.min(2, Math.sqrt(16.8e6 / (w * h)), limit / Math.max(w, h)));
    const sw = Math.round(w * ss), sh = Math.round(h * ss);
    this.prepareOffline(sw, sh);
    if (this.userCamera) this.refitUserCamera(liveAspect, w / h);
    else this.frameCamera(this.sample);
    this.renderNow();
    const out = createCanvas(w, h);
    const ctx = out.getContext('2d');
    if (ctx) {
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(this.canvas, 0, 0, sw, sh, 0, 0, w, h);
    }
    // Restore the live view.
    this.renderer.setPixelRatio(this.live.pr);
    this.renderer.setSize(this.live.w, this.live.h, false);
    this.camera.aspect = this.live.w / this.live.h;
    this.camera.updateProjectionMatrix();
    this.camera.position.copy(position);
    this.controls.target.copy(target);
    this.camera.lookAt(target);
    this.offline = wasOffline;
    this.dirty = true;
    if (!wasOffline) this.renderNow();
    return out;
  }

  snapshot(): string {
    this.renderNow();
    return this.canvas.toDataURL('image/png');
  }

  /**
   * Near / far planes hugging the shot: the near plane as far out as the book and the floor in
   * front of the lens allow (depth precision for leaves 0.1 mm apart, no z-fighting on the
   * floor), the far plane just past the backdrop. Pure in the camera and pose, so frames match.
   */
  private fitClipPlanes(): void {
    const cam = this.camera;
    cam.updateMatrixWorld();
    const dir = cam.getWorldDirection(new Vector3());
    const m = this.motionInner.matrixWorld;
    const p = new Vector3();
    let nearest = Infinity;
    for (const q of this.rest.corners) nearest = Math.min(nearest, p.copy(q).applyMatrix4(m).sub(cam.position).dot(dir));
    // The floor and backdrop can come closer than the book on a low camera.
    const floorGap = Math.max(Math.abs(cam.position.y), 0.02 * this.span) * 0.6;
    const near = Math.max(0.01, 0.5 * Math.min(nearest, floorGap));
    const far = cam.position.distanceTo(this.rest.center) + this.span * 10;
    if (Math.abs(near - cam.near) > 1e-6 || Math.abs(far - cam.far) > 1e-6) {
      cam.near = near;
      cam.far = far;
      cam.updateProjectionMatrix();
    }
  }

  /**
   * The book's box in its current pose: open, it takes in the open half too (the closed box let W
   * walk into an open book's left-hand stack). Open flat with no leaf turning, nothing stands
   * higher than the closed book, so close-ups of the spread still reach the page (bounds() keeps
   * headroom for a leaf mid-turn and a board standing half open).
   */
  private poseBounds(model: BookModel): BookBounds {
    const open = clamp01(this.sample.open);
    const b = model.bounds(open);
    if (open > 0.999 && !this.sample.leaves.some((v) => v > 0.001 && v < 0.999)) b.y1 = model.bounds(0).y1;
    return b;
  }

  /**
   * Keep an orbiting / zooming camera out of the book's body (its box in the current pose, a
   * couple of millimetres grown): from the side, OrbitControls' minimum distance alone
   * lets a close camera end up between the pages. Pushed back along its line to the target.
   */
  /** Whether a world point is inside the book's box (with the margin keepCameraOutside keeps). */
  private insideBook(p: Vector3): boolean {
    const model = this.model;
    if (!model) return false;
    const b = this.poseBounds(model);
    const m = mm(2);
    model.group.updateMatrixWorld(true);
    const q = p.clone().applyMatrix4(model.group.matrixWorld.clone().invert());
    return q.x > b.a0 - m && q.x < b.a1 + m && q.y > b.y0 - m && q.y < b.y1 + m && q.z > b.z0 - m && q.z < b.z1 + m;
  }

  keepCameraOutside(): void {
    const model = this.model;
    if (!model) return;
    const b = this.poseBounds(model);
    const m = mm(2);
    const lo = [b.a0 - m, b.y0 - m, b.z0 - m], hi = [b.a1 + m, b.y1 + m, b.z1 + m];
    model.group.updateMatrixWorld(true);
    const toLocal = model.group.matrixWorld.clone().invert();
    const p = this.camera.position.clone().applyMatrix4(toLocal);
    const inside = (q: Vector3) => q.x > lo[0] && q.x < hi[0] && q.y > lo[1] && q.y < hi[1] && q.z > lo[2] && q.z < hi[2];
    if (!inside(p)) return;
    const t = this.controls.target.clone().applyMatrix4(toLocal);
    const dir = p.clone().sub(t);
    if (dir.lengthSq() < 1e-12) dir.set(0, 1, 0);
    dir.normalize();
    // Along the ray from the target through the camera: out of the far side of the box when the
    // target is inside it, else back to where the ray enters it.
    let exit = Infinity, enter = -Infinity;
    const o = [t.x, t.y, t.z], d = [dir.x, dir.y, dir.z];
    for (let k = 0; k < 3; k++) {
      if (Math.abs(d[k]) < 1e-12) continue;
      const s1 = (lo[k] - o[k]) / d[k], s2 = (hi[k] - o[k]) / d[k];
      exit = Math.min(exit, Math.max(s1, s2));
      enter = Math.max(enter, Math.min(s1, s2));
    }
    if (!Number.isFinite(exit)) return;
    const s0 = inside(t) ? exit + mm(0.1) : Math.max(0, enter - mm(0.1));
    const q = t.clone().addScaledVector(dir, s0);
    this.camera.position.copy(q.applyMatrix4(model.group.matrixWorld));
    this.camera.updateMatrixWorld();
  }

  private sortTransparentLeaves(): void {
    const model = this.model;
    if (!model) return;
    const leaves = model.transparentLeaves();
    if (leaves.length === 0) return;
    const cam = this.camera.position;
    const p = new Vector3();
    const sorted = leaves
      .map((l) => ({ l, d: p.set(l.center[0], l.center[1], l.center[2]).applyMatrix4(model.group.matrixWorld).distanceToSquared(cam) }))
      .sort((x, y) => y.d - x.d);
    sorted.forEach((e, i) => { e.l.mesh.renderOrder = 10 + i; });
  }

  private renderNow(): void {
    if (this.disposed) return;
    // Keep the cove's wall behind the book, whatever the camera does.
    const c = this.rest.center;
    this.backdrop.follow(c.x, c.z, Math.atan2(this.camera.position.x - c.x, this.camera.position.z - c.z));
    if (this.poseDirty) {
      if (this.backdropState.showGround && this.model) this.contact.render(this.renderer, this.scene, [this.ground, this.backdrop.group]);
      this.renderer.shadowMap.needsUpdate = true;
      this.poseDirty = false;
    }
    this.sortTransparentLeaves();
    this.fitClipPlanes();
    // See ContactShadow.render: make sure re-posed sheets are re-uploaded this frame
    // (frame-exact video export depends on it).
    this.renderer.info.render.frame++;
    this.renderer.render(this.scene, this.camera);
    this.dirty = false;
  }

  /*
   * Moving the camera with the keyboard: W/S closer to and further from the orbit centre (slowing
   * as it nears, so it never passes through), A/D and Q/E pan left, right, down and up (camera and
   * centre together), Shift faster. Speeds follow the distance, so it feels the same close and far.
   */
  private readonly keys = new Set<string>();
  private lastFrame = 0;
  private static readonly WALK = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE']);
  private shiftHeld = false;
  private readonly keyDown = (e: KeyboardEvent): void => {
    this.shiftHeld = e.shiftKey;
    // macOS sends no keyup for a letter released while ⌘ is down: let go of everything then.
    if (e.metaKey) this.keys.clear();
    // Exporting (frames are posed and rendered offline): keys would move the camera mid-video.
    if (this.offline || !BookScene.WALK.has(e.code) || e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    e.preventDefault();
    this.keys.add(e.code);
    // A tap moves a little at once (a key released before the next frame would not move at all);
    // holding it moves smoothly, frame by frame (the system's key repeat adds nothing).
    if (!e.repeat) this.walk(1 / 20, e.shiftKey, new Set([e.code]));
  };
  private readonly keyUp = (e: KeyboardEvent): void => {
    this.shiftHeld = e.shiftKey;
    if (e.key === 'Meta') this.keys.clear();
    else this.keys.delete(e.code);
  };
  /** Window or tab left (its keyups go elsewhere), or an export starts: nothing stays held. */
  private readonly keysOff = (): void => { this.keys.clear(); this.shiftHeld = false; };

  private walk(dt: number, fast: boolean, k: ReadonlySet<string> = this.keys): void {
    const step = Math.min(dt, 0.1) * (fast ? 3 : 1);
    const target = this.controls.target, cam = this.camera.position;
    const off = cam.clone().sub(target);
    const dist = Math.max(1e-6, off.length());
    let moved = false;
    const zoom = (k.has('KeyS') ? 1 : 0) - (k.has('KeyW') ? 1 : 0);
    if (zoom) {
      // World units, not the book's pt (the book is scaled into the scene): the orbit's own limits.
      let next = Math.min(Math.max(dist * Math.exp(zoom * 1.4 * step), this.controls.minDistance), this.controls.maxDistance);
      // Closer stops at the book's surface rather than going in (the target is inside the book).
      for (let i = 0; i < 8 && next < dist && this.insideBook(target.clone().addScaledVector(off, next / dist)); i++) next = (next + dist) / 2;
      if (Math.abs(next - dist) > 1e-6 && !(next < dist && this.insideBook(target.clone().addScaledVector(off, next / dist)))) {
        off.multiplyScalar(next / dist);
        cam.copy(target).add(off);
        moved = true;
      }
    }
    const dir = new Vector3();
    this.camera.getWorldDirection(dir);
    const right = new Vector3().crossVectors(dir, this.camera.up).normalize();
    const pan = new Vector3();
    if (k.has('KeyD')) pan.add(right);
    if (k.has('KeyA')) pan.sub(right);
    if (k.has('KeyE')) pan.add(this.camera.up);
    if (k.has('KeyQ')) pan.sub(this.camera.up);
    if (pan.lengthSq() > 1e-12) {
      pan.normalize().multiplyScalar(off.length() * 0.8 * step);
      // Not down through the floor (orbiting stops above it; Q panned on below it).
      if (this.backdropState.showGround) pan.y = Math.max(pan.y, Math.min(0, mm(5) * SCENE_UNITS_PER_PT - cam.y));
      cam.add(pan);
      target.add(pan);
      moved = true;
    }
    if (!moved) return;
    this.userCamera = true;
    this.keepCameraOutside();
    this.dirty = true;
  }

  private readonly frame = (now: number): void => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.frame);
    const dt = this.lastFrame ? (now - this.lastFrame) / 1000 : 0;
    this.lastFrame = now;
    if (this.offline) return;
    if (this.keys.size && dt > 0) this.walk(dt, this.shiftHeld);
    if (this.playing && !this.manual) {
      let t = this.playFrom + (now - this.playStart) / 1000;
      const d = this.getAnimationDuration();
      if (this.animOpts.loop === false && t >= d) {
        t = d;
        this.playing = false;
      }
      this.time = t;
      this.applyAt(t, !this.userCamera);
    } else if (this.manual || this.mode === 'none') {
      if (this.updateTweens(now)) this.applyCurrent();
    }
    if (this.controls.update()) {
      if (this.userCamera) this.keepCameraOutside();
      this.dirty = true;
    }
    if (this.dirty) this.renderNow();
  };

  /** Exports from a lost context would be blank images: fail instead. */
  private assertContext(): void {
    if (this.disposed) throw new Error('the 3D view was closed before the export finished');
    if (this.renderer.getContext().isContextLost()) throw new Error('the 3D view lost its graphics context. Wait for it to come back, or restart the 3D view');
  }

  /** The room's reflections, rendered into the scene's environment map. */
  private makeEnvironment(): WebGLRenderTarget {
    const room = new RoomEnvironment();
    const target = this.pmrem.fromScene(room, 0.04);
    room.dispose();
    this.scene.environment = target.texture;
    return target;
  }

  private readonly onContextChange?: (lost: boolean) => void;

  /** three.js keeps the context restorable (it calls preventDefault); the canvas shows nothing meanwhile. */
  private readonly contextLost = (): void => {
    if (this.disposed) return;
    this.onContextChange?.(true);
  };

  /**
   * three.js rebuilds its GL state and re-uploads meshes and textures as they are drawn; what was
   * rendered into targets is gone: the environment map is made again, and the contact shadow and
   * shadow map on the next frame.
   */
  private readonly contextRestored = (): void => {
    if (this.disposed) return;
    this.envTarget.dispose();
    this.pmrem.dispose();
    this.pmrem = new PMREMGenerator(this.renderer);
    this.envTarget = this.makeEnvironment();
    this.poseDirty = true;
    this.dirty = true;
    this.onContextChange?.(false);
  };

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.canvas.removeEventListener('webglcontextlost', this.contextLost);
    this.canvas.removeEventListener('webglcontextrestored', this.contextRestored);
    window.removeEventListener('keydown', this.keyDown);
    window.removeEventListener('keyup', this.keyUp);
    window.removeEventListener('blur', this.keysOff);
    document.removeEventListener('visibilitychange', this.keysOff);
    cancelAnimationFrame(this.raf);
    this.controls.dispose();
    this.disposeModel();
    this.cache.dispose();
    this.contact.dispose();
    this.backdrop.dispose();
    this.ground.geometry.dispose();
    this.ground.material.dispose();
    this.envTarget.dispose();
    this.pmrem.dispose();
    this.scene.clear();
    this.renderer.dispose();
    // Give the context back now: browsers keep only ~16, and switching views would pile them up
    // until garbage collection (the oldest, possibly a live one, is then lost).
    this.renderer.forceContextLoss();
  }
}

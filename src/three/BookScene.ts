/**
 * Interactive real-time 3D book (three.js). Framework-agnostic: give it a canvas, feed it
 * the book (`setInput`) and its artwork (`setTextures`); it runs its own render loop.
 */
import {
  ACESFilmicToneMapping,
  Box3,
  Color,
  DirectionalLight,
  Group,
  Mesh,
  VSMShadowMap,
  PerspectiveCamera,
  PlaneGeometry,
  PMREMGenerator,
  Scene,
  ShadowMaterial,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
  type WebGLProgramParametersWithUniforms,
  type WebGLRenderTarget,
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import {
  animationDuration,
  clamp01,
  easeInOutCubic,
  elevationFor,
  leafTurns,
  sampleTimeline,
  type CameraKey,
  type TimelineSample,
} from './animation';
import { ContactShadow } from './contactShadow';
import { BookModel } from './geometry';
import { SCENE_UNITS_PER_PT, computeLayout, type BookLayout } from './layout';
import { BookMaterials, TextureCache } from './materials';
import type {
  AnimationMode,
  AnimationOptions,
  BookSceneInput,
  BookSceneOptions,
  BookTextures,
  EnvironmentOptions,
} from './types';

const DEFAULT_BACKGROUND = '#d9d4cb';
/** Seconds to lay the book down / stand it up in the interactive viewer. */
const STAGE_TIME = 0.7;
const OPEN_TIME = 1.1;

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

export class BookScene {
  readonly canvas: HTMLCanvasElement;
  private readonly renderer: WebGLRenderer;
  private readonly scene = new Scene();
  private readonly camera = new PerspectiveCamera(30, 1, 0.5, 800);
  private readonly controls: OrbitControls;
  private readonly pmrem: PMREMGenerator;
  private readonly envTarget: WebGLRenderTarget;
  private readonly key = new DirectionalLight(0xfff3e4, 2.6);
  private readonly fill = new DirectionalLight(0xdde6ff, 0.4);
  private readonly rim = new DirectionalLight(0xffffff, 0.8);
  private readonly ground: Mesh<PlaneGeometry, ShadowMaterial>;
  private readonly contact = new ContactShadow(512);
  private readonly groundFade = { value: 30 };
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
  private env: Required<EnvironmentOptions> = { background: DEFAULT_BACKGROUND, lightIntensity: 1, shadows: true, showGround: true };

  private readonly openTw = new Tween(0);
  private readonly leafTw = new Tween(0, true);
  private readonly stageTw = new Tween(0);
  private closePending = false;

  private mode: AnimationMode = 'none';
  private animOpts: AnimationOptions = {};
  private playing = false;
  private playStart = 0;
  private playFrom = 0;
  private time = 0;
  /** The pose comes from setOpen/setLeaf instead of the (paused) timeline. */
  private manual = true;
  private userCamera = false;

  private lastPose = '';
  private poseDirty = true;
  private dirty = true;
  private raf = 0;
  private offline = false;
  private disposed = false;
  private readonly tmpBox = new Box3();
  private readonly tmpV = new Vector3();

  constructor(canvas: HTMLCanvasElement, opts?: BookSceneOptions) {
    this.canvas = canvas;
    const r = new WebGLRenderer({
      canvas,
      antialias: true,
      alpha: false,
      preserveDrawingBuffer: !!opts?.preserveDrawingBuffer,
      powerPreference: 'high-performance',
    });
    this.renderer = r;
    r.outputColorSpace = SRGBColorSpace;
    r.toneMapping = ACESFilmicToneMapping;
    r.toneMappingExposure = 1;
    r.shadowMap.enabled = true;
    // Variance shadow maps: a key light that reads like a large softbox.
    r.shadowMap.type = VSMShadowMap;
    r.shadowMap.autoUpdate = false;
    this.cache = new TextureCache(Math.min(8, r.capabilities.getMaxAnisotropy()));

    this.env.background = opts?.background ?? DEFAULT_BACKGROUND;
    this.pmrem = new PMREMGenerator(r);
    const room = new RoomEnvironment();
    this.envTarget = this.pmrem.fromScene(room, 0.04);
    room.dispose();
    this.scene.environment = this.envTarget.texture;

    this.key.castShadow = true;
    this.key.shadow.mapSize.set(1024, 1024);
    this.key.shadow.bias = -0.0003;
    this.key.shadow.blurSamples = 24;
    this.scene.add(this.key, this.key.target, this.fill, this.fill.target, this.rim, this.rim.target);

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
    this.scene.add(this.ground, this.contact.group);

    this.stagePivot.add(this.root);
    this.scene.add(this.stagePivot);

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

    this.applyEnvironment();
    const w = canvas.clientWidth || canvas.width || 300;
    const h = canvas.clientHeight || canvas.height || 150;
    this.resize(w, h, typeof window !== 'undefined' ? window.devicePixelRatio : 1);
    this.frameCamera(this.staticSample());
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
    const zt = (layout.coverH / 2) * k;
    this.stagePivot.position.set(0, 0, zt);
    this.root.scale.set(sx * k, k, k);
    this.root.position.set(-sx * k * ((layout.a0 + layout.a1) / 2), 0, -zt);
    this.root.add(model.group);
    // Clamp the interactive leaf state to the leaves this book models.
    const n = layout.nTurn;
    if (this.leafTw.value > n) this.leafTw.set(n);
    this.placeLights();
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

  /** Light rig and shadow frusta sized to the book. */
  private placeLights(): void {
    const L = this.layout;
    if (!L) return;
    const k = SCENE_UNITS_PER_PT;
    const span = Math.max(L.a1 - L.a0, L.coverH, L.W * 2) * k;
    const reach = span * 1.35;
    const dist = span * 3;
    const center = new Vector3(0, 0, 0);
    const place = (light: DirectionalLight, dir: [number, number, number]) => {
      const d = new Vector3(dir[0], dir[1], dir[2]).normalize().multiplyScalar(dist);
      light.position.copy(center).add(d);
      light.target.position.copy(center);
      light.target.updateMatrixWorld();
    };
    place(this.key, [-0.95, 1.25, 0.55]);
    place(this.fill, [0.9, 0.5, 0.4]);
    place(this.rim, [0.2, 0.7, -1]);
    const cam = this.key.shadow.camera;
    cam.left = -reach;
    cam.right = reach;
    cam.top = reach;
    cam.bottom = -reach;
    cam.near = dist * 0.3;
    cam.far = dist * 2;
    cam.updateProjectionMatrix();
    // ~1 cm penumbra whatever the book size; the shadow fades out before the frustum edge.
    this.key.shadow.radius = Math.min(24, Math.max(6, 1 / ((2 * reach) / this.key.shadow.mapSize.x)));
    this.key.shadow.normalBias = 0.0006 * span;
    this.groundFade.value = reach;
    this.contact.setArea(0, 0, span * 2.4, span * 2.4, Math.max(L.thick, L.coverH) * k * 0.8);
    this.controls.minDistance = span * 0.35;
    this.controls.maxDistance = span * 12;
    this.renderer.shadowMap.needsUpdate = true;
  }

  /* ----------------------------------------------------------------------- */
  /* Environment                                                              */
  /* ----------------------------------------------------------------------- */

  setEnvironment(opts: EnvironmentOptions): void {
    this.env = {
      background: opts.background ?? this.env.background,
      lightIntensity: opts.lightIntensity ?? this.env.lightIntensity,
      shadows: opts.shadows ?? this.env.shadows,
      showGround: opts.showGround ?? this.env.showGround,
    };
    this.applyEnvironment();
  }

  private applyEnvironment(): void {
    const e = this.env;
    const bg = new Color(e.background);
    this.scene.background = bg;
    this.renderer.setClearColor(bg, 1);
    const li = Math.max(0, e.lightIntensity);
    this.key.intensity = 2.6 * li;
    this.fill.intensity = 0.4 * li;
    this.rim.intensity = 0.8 * li;
    this.scene.environmentIntensity = 0.6 * li;
    this.key.castShadow = e.shadows;
    this.ground.visible = e.showGround && e.shadows;
    this.contact.group.visible = e.showGround;
    this.controls.maxPolarAngle = e.showGround ? Math.PI / 2 - 0.03 : Math.PI;
    this.renderer.shadowMap.needsUpdate = true;
    this.poseDirty = true;
    this.dirty = true;
  }

  /* ----------------------------------------------------------------------- */
  /* Interactive pose                                                         */
  /* ----------------------------------------------------------------------- */

  private nTurn(): number {
    return this.layout?.nTurn ?? 0;
  }

  /** Hand the pose to setOpen/setLeaf (pauses a running animation). */
  private enterManual(): void {
    if (this.mode !== 'none') {
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
    } else {
      // Turned leaves close together with the cover; then the book stands back up.
      if (animate) {
        this.openTw.animate(0, now, OPEN_TIME * Math.max(0.35, this.openTw.value));
        this.closePending = true;
      } else {
        this.openTw.set(0);
        this.leafTw.set(0);
        this.stageTw.animate(0, now, STAGE_TIME);
      }
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
      this.stageTw.animate(0, now, STAGE_TIME);
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
    return animationDuration(this.mode, this.animOpts, this.nTurn());
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
    return sampleTimeline(this.mode, this.animOpts, t, this.nTurn(), {
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
    const key = `${s.open.toFixed(5)}|${s.stage.toFixed(5)}|${s.leaves.map((v) => v.toFixed(5)).join(',')}`;
    this.stagePivot.rotation.x = (1 - clamp01(s.stage)) * (Math.PI / 2);
    this.stagePivot.updateMatrixWorld(true);
    if (this.model) this.model.setPose(s.open, s.leaves, clamp01(s.stage));
    if (key !== this.lastPose) {
      this.lastPose = key;
      this.poseDirty = true;
    }
    this.dirty = true;
  }

  /* ----------------------------------------------------------------------- */
  /* Camera                                                                   */
  /* ----------------------------------------------------------------------- */

  private baseAzimuth(): number {
    return this.layout?.rtl ? 0.55 : -0.55;
  }

  /** Place the camera to frame the book for a pose (auto framing). */
  private frameCamera(s: TimelineSample): void {
    const cam: CameraKey = s.cam ?? { az: 0, el: elevationFor(s.stage, s.open), zoom: 1 };
    // The 3/4 view swings toward head-on as the book opens: a spread reads best square on.
    const az = this.baseAzimuth() * (1 - 0.65 * clamp01(s.open)) + cam.az;
    const el = Math.max(0.03, Math.min(1.45, cam.el));
    const center = this.tmpV;
    const vfov = (this.camera.fov * Math.PI) / 180;
    const tanV = Math.tan(vfov / 2);
    const tanH = tanV * this.camera.aspect;
    // Camera basis for a view: forward f points from the target toward the camera.
    const basis = (azimuth: number) => {
      const f = new Vector3(Math.cos(el) * Math.sin(azimuth), Math.sin(el), Math.cos(el) * Math.cos(azimuth));
      const r = new Vector3(0, 1, 0).cross(f).normalize();
      return { f, r, u: new Vector3().crossVectors(f, r) };
    };
    const views = cam.stable ? Array.from({ length: 12 }, (_, i) => basis((i * Math.PI) / 6)) : [basis(az)];
    let dist = 30;
    if (this.model) {
      const b = this.model.bounds(clamp01(s.open));
      this.model.group.updateWorldMatrix(true, false);
      const box = this.tmpBox.makeEmpty();
      const corners: Vector3[] = [];
      for (const a of [b.a0, b.a1]) for (const y of [b.y0, b.y1]) for (const z of [b.z0, b.z1]) {
        const p = new Vector3(a, y, z).applyMatrix4(this.model.group.matrixWorld);
        corners.push(p);
        box.expandByPoint(p);
      }
      box.getCenter(center);
      // Smallest distance at which every corner of the bounds fits the frustum.
      dist = 1;
      const d = new Vector3();
      for (const { f, r, u } of views) {
        for (const p of corners) {
          d.subVectors(p, center);
          const depth = d.dot(f);
          dist = Math.max(dist, depth + Math.abs(d.dot(r)) / tanH, depth + Math.abs(d.dot(u)) / tanV);
        }
      }
      dist *= 1.1 * cam.zoom;
    } else center.set(0, 0, 0);
    this.camera.position.set(
      center.x + dist * Math.cos(el) * Math.sin(az),
      center.y + dist * Math.sin(el),
      center.z + dist * Math.cos(el) * Math.cos(az),
    );
    this.camera.lookAt(center);
    this.controls.target.copy(center);
    this.dirty = true;
  }

  resetCamera(): void {
    this.userCamera = false;
    this.applyCurrent();
    this.controls.update();
  }

  /* ----------------------------------------------------------------------- */
  /* Rendering                                                                */
  /* ----------------------------------------------------------------------- */

  resize(width: number, height: number, pixelRatio?: number): void {
    this.offline = false;
    const w = Math.max(1, Math.round(width));
    const h = Math.max(1, Math.round(height));
    const pr = pixelRatio ?? (typeof window !== 'undefined' ? window.devicePixelRatio : 1);
    this.renderer.setPixelRatio(Math.min(2, Math.max(0.5, pr)));
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    if (!this.userCamera) this.applyCurrent();
    this.dirty = true;
  }

  render(): void {
    this.renderNow();
  }

  renderFrame(t: number, width: number, height: number): HTMLCanvasElement {
    // Hold the live loop until the caller restores the size with resize().
    this.offline = true;
    const w = Math.max(2, Math.round(width));
    const h = Math.max(2, Math.round(height));
    if (this.canvas.width !== w || this.canvas.height !== h || this.renderer.getPixelRatio() !== 1) {
      this.renderer.setPixelRatio(1);
      this.renderer.setSize(w, h, false);
    }
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.applyAt(t, true);
    this.renderNow();
    return this.canvas;
  }

  snapshot(): string {
    this.renderNow();
    return this.canvas.toDataURL('image/png');
  }

  private sortTransparentLeaves(): void {
    if (!this.model) return;
    const leaves = this.model.transparentLeaves();
    if (leaves.length === 0) return;
    const cam = this.camera.position;
    const p = new Vector3();
    const sorted = leaves
      .map((l) => ({ l, d: p.set(l.center[0], l.center[1], l.center[2]).applyMatrix4(this.model!.group.matrixWorld).distanceToSquared(cam) }))
      .sort((x, y) => y.d - x.d);
    sorted.forEach((e, i) => { e.l.mesh.renderOrder = 10 + i; });
  }

  private renderNow(): void {
    if (this.disposed) return;
    if (this.poseDirty) {
      if (this.env.showGround && this.model) this.contact.render(this.renderer, this.scene, [this.ground]);
      this.renderer.shadowMap.needsUpdate = true;
      this.poseDirty = false;
    }
    this.sortTransparentLeaves();
    // See ContactShadow.render: make sure re-posed sheets are re-uploaded this frame
    // (frame-exact video export depends on it).
    this.renderer.info.render.frame++;
    this.renderer.render(this.scene, this.camera);
    this.dirty = false;
  }

  private readonly frame = (now: number): void => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.frame);
    if (this.offline) return;
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
    if (this.controls.update()) this.dirty = true;
    if (this.dirty) this.renderNow();
  };

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.controls.dispose();
    this.disposeModel();
    this.cache.dispose();
    this.contact.dispose();
    this.ground.geometry.dispose();
    this.ground.material.dispose();
    this.envTarget.dispose();
    this.pmrem.dispose();
    this.scene.clear();
    this.renderer.dispose();
  }
}

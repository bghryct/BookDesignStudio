/**
 * Backdrops: solid colour, vertical gradient, a curved studio sweep (infinity cove), procedural
 * table surfaces (wood, linen, concrete, paper, marble, felt) and a transparent background for
 * compositing. Surfaces fade out radially into the matching background colour.
 */
import {
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  CircleGeometry,
  Color,
  Group,
  Mesh,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  NoColorSpace,
  RepeatWrapping,
  SRGBColorSpace,
  type Texture,
  type WebGLProgramParametersWithUniforms,
} from 'three';
import { hash2, rng } from '../lib/random';
import { mix, parseColor } from '../lib/color';
import { context2d, createCanvas, tileFbm, tileNoise } from './materials';
import type { BackdropOptions, BackdropPreset } from './types';

export type SurfacePreset = 'wood' | 'linen' | 'concrete' | 'paper' | 'marble' | 'felt';
const SURFACES: SurfacePreset[] = ['wood', 'linen', 'concrete', 'paper', 'marble', 'felt'];
export const isSurface = (p: BackdropPreset): p is SurfacePreset => (SURFACES as string[]).includes(p);

interface SurfaceLook {
  color: string;
  color2: string;
  /** Physical size of one texture tile, cm (= scene units). */
  tile: number;
  roughness: number;
  bump: number;
  sheen?: number;
  clearcoat?: number;
}

const LOOKS: Record<SurfacePreset, SurfaceLook> = {
  wood: { color: '#9b6b45', color2: '#5a3820', tile: 60, roughness: 0.55, bump: 0.6, clearcoat: 0.25 },
  linen: { color: '#d8cdbb', color2: '#a99a83', tile: 8, roughness: 0.92, bump: 0.9, sheen: 0.4 },
  concrete: { color: '#a8a59f', color2: '#77736d', tile: 70, roughness: 0.88, bump: 0.7 },
  paper: { color: '#f0ebe0', color2: '#d5ccbb', tile: 40, roughness: 0.9, bump: 0.25 },
  marble: { color: '#ece9e3', color2: '#8c8781', tile: 110, roughness: 0.22, bump: 0.05, clearcoat: 0.6 },
  felt: { color: '#3d5a49', color2: '#263b30', tile: 16, roughness: 1, bump: 0.5, sheen: 1 },
};

const SIZE = 512;
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (e0: number, e1: number, x: number) => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};

/** Tileable colour + height maps for a table surface (deterministic). */
function surfaceMaps(kind: SurfacePreset, c1: string, c2: string): { color: HTMLCanvasElement; height: HTMLCanvasElement } {
  const A = parseColor(c1), B = parseColor(c2);
  const color = createCanvas(SIZE, SIZE), height = createCanvas(SIZE, SIZE);
  const cctx = context2d(color), hctx = context2d(height);
  const ci = cctx.createImageData(SIZE, SIZE), hi = hctx.createImageData(SIZE, SIZE);
  const r = rng(kind.length * 977);
  const planks = 4;
  const plankOffset = Array.from({ length: planks }, () => r());
  const plankTone = Array.from({ length: planks }, () => 0.85 + 0.3 * r());
  const plankJoint = Array.from({ length: planks }, () => r());
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      let t = 0; // 0 = color, 1 = color2
      let h = 0.5;
      let tone = 1;
      const u = x / SIZE, v = y / SIZE;
      switch (kind) {
        case 'wood': {
          const p = Math.min(planks - 1, Math.floor(v * planks));
          const lv = v * planks - p; // across the plank
          const warp = tileFbm(u * 8, v * 2, 8, 2, 4, 11 + p) * 2.2;
          const rings = 0.5 + 0.5 * Math.sin((lv * 9 + warp + plankOffset[p] * 7) * Math.PI);
          const fine = tileNoise(x * 0.5, y / 6, SIZE / 2, SIZE / 6, 23);
          t = clamp01(0.55 * rings * rings + 0.3 * fine + 0.15 * tileFbm(u * 16, v * 4, 16, 4, 3, 5));
          tone = plankTone[p];
          // Seams between planks and a staggered end joint.
          const seam = Math.min(lv, 1 - lv) * SIZE / planks;
          const ju = (u - plankJoint[p] + 1) % 1;
          const joint = Math.min(ju, 1 - ju) * SIZE;
          if (seam < 1.2 || joint < 1.0) { tone *= 0.55; h = 0.2; } else h = 0.45 + 0.25 * fine;
          break;
        }
        case 'linen': {
          const n = 64; // threads per tile
          const gx = u * n, gy = v * n;
          const fx = gx - Math.floor(gx), fy = gy - Math.floor(gy);
          const warpUp = ((Math.floor(gx) + Math.floor(gy)) & 1) === 0;
          const slubX = tileNoise(u * 4, v * 64, 4, 64, 7), slubY = tileNoise(u * 64, v * 4, 64, 4, 9);
          const warp = Math.sin(Math.PI * fx) * (0.75 + 0.5 * slubY);
          const weft = Math.sin(Math.PI * fy) * (0.75 + 0.5 * slubX);
          h = clamp01((warpUp ? Math.max(warp, weft * 0.7) : Math.max(weft, warp * 0.7)) * 0.9);
          t = clamp01(0.25 + 0.5 * (1 - h) + 0.25 * (slubX + slubY - 1));
          break;
        }
        case 'concrete': {
          const big = tileFbm(u * 4, v * 4, 4, 4, 5, 3);
          const fine = hash2(x, y, 4);
          t = clamp01(0.35 + 0.8 * (big - 0.5) + 0.12 * (fine - 0.5));
          h = 0.5 + 0.2 * (big - 0.5);
          if (hash2(x >> 1, y >> 1, 8) > 0.996) { t = 1; h = 0.1; }
          break;
        }
        case 'paper': {
          const mottle = tileFbm(u * 6, v * 6, 6, 6, 4, 13);
          const fibre = tileNoise(u * 128, v * 16, 128, 16, 2) * tileNoise(u * 16, v * 128, 16, 128, 3);
          t = clamp01(0.15 + 0.5 * (mottle - 0.5) + 0.25 * fibre);
          h = 0.5 + 0.15 * (fibre - 0.25);
          break;
        }
        case 'marble': {
          const turb = tileFbm(u * 3, v * 3, 3, 3, 6, 21);
          const vein = Math.abs(Math.sin((u * 2 + v + turb * 2.6) * Math.PI * 2));
          const fineVein = Math.abs(Math.sin((u * 6 - v * 3 + turb * 5) * Math.PI * 2));
          t = clamp01(Math.pow(1 - vein, 9) * 0.95 + Math.pow(1 - fineVein, 26) * 0.4 + 0.08 * (turb - 0.5));
          h = 0.5;
          break;
        }
        case 'felt': {
          const fuzz = hash2(x, y, 31) * 0.6 + tileNoise(u * 128, v * 128, 128, 128, 5) * 0.4;
          const cloud = tileFbm(u * 5, v * 5, 5, 5, 3, 17);
          t = clamp01(0.3 + 0.5 * (fuzz - 0.5) + 0.4 * (cloud - 0.5));
          h = fuzz;
          break;
        }
      }
      const i = 4 * (y * SIZE + x);
      ci.data[i] = (A.r + (B.r - A.r) * t) * tone;
      ci.data[i + 1] = (A.g + (B.g - A.g) * t) * tone;
      ci.data[i + 2] = (A.b + (B.b - A.b) * t) * tone;
      ci.data[i + 3] = 255;
      const hv = clamp01(h) * 255;
      hi.data[i] = hv; hi.data[i + 1] = hv; hi.data[i + 2] = hv; hi.data[i + 3] = 255;
    }
  }
  cctx.putImageData(ci, 0, 0);
  hctx.putImageData(hi, 0, 0);
  return { color, height };
}

/** Infinity cove: a floor that curves up into a back wall, opening toward +z (the camera). */
function coveGeometry(span: number): BufferGeometry {
  const front = span * 4, back = span * 0.9, rc = span * 1.3, wall = span * 4.5, half = span * 6;
  // Profile in (z, y), from the front edge of the floor up to the top of the wall.
  const prof: [number, number][] = [[front, 0], [0, 0], [-back, 0]];
  for (let i = 1; i <= 18; i++) {
    const a = (i / 18) * (Math.PI / 2);
    prof.push([-back - rc * Math.sin(a), rc * (1 - Math.cos(a))]);
  }
  prof.push([-back - rc, wall]);
  const nx = 2;
  const pos: number[] = [], nrm: number[] = [], uv: number[] = [], idx: number[] = [];
  for (let j = 0; j < prof.length; j++) {
    const [z, y] = prof[j];
    const [z0, y0] = prof[Math.max(0, j - 1)], [z1, y1] = prof[Math.min(prof.length - 1, j + 1)];
    // Normal = profile tangent rotated toward the camera side.
    let tz = z1 - z0, ty = y1 - y0;
    const l = Math.hypot(tz, ty) || 1;
    tz /= l; ty /= l;
    for (let i = 0; i < nx; i++) {
      pos.push(i === 0 ? -half : half, y, z);
      nrm.push(0, -tz, ty);
      uv.push(i, j / (prof.length - 1));
    }
  }
  for (let j = 0; j < prof.length - 1; j++) {
    const a = j * nx, b = a + 1, c = a + nx, d = c + 1;
    idx.push(a, b, c, b, d, c);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('normal', new BufferAttribute(new Float32Array(nrm), 3));
  g.setAttribute('uv', new BufferAttribute(new Float32Array(uv), 2));
  g.setIndex(idx);
  return g;
}

/** Radial alpha fade on a ground-like material so it melts into the background colour. */
function installRadialFade(m: MeshStandardMaterial, radius: { value: number }): void {
  m.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms) => {
    shader.uniforms.fadeRadius = radius;
    shader.vertexShader = `varying vec2 vFadeXZ;\n${shader.vertexShader.replace(
      '#include <worldpos_vertex>',
      '#include <worldpos_vertex>\n\tvFadeXZ = ( modelMatrix * vec4( transformed, 1.0 ) ).xz;',
    )}`;
    shader.fragmentShader = `uniform float fadeRadius;\nvarying vec2 vFadeXZ;\n${shader.fragmentShader.replace(
      '#include <opaque_fragment>',
      '#include <opaque_fragment>\n\tgl_FragColor.a *= 1.0 - smoothstep( 0.45, 0.98, length( vFadeXZ ) / fadeRadius );',
    )}`;
  };
  m.customProgramCacheKey = () => 'backdrop-radial-fade';
}

export interface ResolvedBackdrop {
  preset: BackdropPreset;
  color: string;
  color2: string;
  showGround: boolean;
}

export const DEFAULT_BACKDROP: ResolvedBackdrop = { preset: 'solid', color: '#d9d4cb', color2: '#a9a39a', showGround: true };

export function resolveBackdrop(o: BackdropOptions, prev: ResolvedBackdrop): ResolvedBackdrop {
  const preset = o.preset ?? prev.preset;
  const look = isSurface(preset) ? LOOKS[preset] : null;
  const samePreset = preset === prev.preset;
  return {
    preset,
    color: o.color ?? (samePreset ? prev.color : look?.color ?? (preset === 'studio-sweep' ? '#e7e3dc' : prev.color)),
    color2: o.color2 ?? (samePreset ? prev.color2 : look?.color2 ?? (preset === 'gradient' ? mix(prev.color, '#000000', 0.25) : prev.color2)),
    showGround: o.showGround ?? prev.showGround,
  };
}

export class Backdrop {
  readonly group = new Group();
  private surface: Mesh<CircleGeometry, MeshPhysicalMaterial> | null = null;
  private cove: Mesh<BufferGeometry, MeshStandardMaterial> | null = null;
  private gradient: CanvasTexture | null = null;
  private owned: Texture[] = [];
  private readonly fade = { value: 100 };
  private state: ResolvedBackdrop = DEFAULT_BACKDROP;
  private key = '';

  get preset(): BackdropPreset {
    return this.state.preset;
  }

  get transparent(): boolean {
    return this.state.preset === 'transparent';
  }

  /** (Re)build the set for a book of size `span` (scene units). */
  build(state: ResolvedBackdrop, span: number, anisotropy: number): void {
    const key = [state.preset, state.color, state.color2, state.showGround, span.toFixed(2)].join('|');
    this.state = state;
    if (key === this.key) return;
    this.key = key;
    this.clear();
    const p = state.preset;
    if (p === 'gradient') {
      const c = createCanvas(4, 256);
      const ctx = context2d(c);
      const g = ctx.createLinearGradient(0, 0, 0, 256);
      g.addColorStop(0, state.color);
      g.addColorStop(1, state.color2);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, 4, 256);
      this.gradient = new CanvasTexture(c);
      this.gradient.colorSpace = SRGBColorSpace;
      this.owned.push(this.gradient);
    }
    if (!state.showGround) return;
    if (p === 'studio-sweep') {
      const m = new MeshStandardMaterial({ color: new Color(state.color), roughness: 0.94, metalness: 0 });
      this.cove = new Mesh(coveGeometry(span), m);
      // The flat shadow catcher on top carries the cast shadow (the room light would wash it out).
      this.cove.receiveShadow = false;
      this.cove.castShadow = false;
      this.cove.position.y = -0.004;
      this.group.add(this.cove);
    } else if (isSurface(p)) {
      const look = LOOKS[p];
      const maps = surfaceMaps(p, state.color, state.color2);
      const R = span * 5;
      const repeat = (2 * R) / look.tile;
      const map = new CanvasTexture(maps.color);
      map.colorSpace = SRGBColorSpace;
      const bump = new CanvasTexture(maps.height);
      bump.colorSpace = NoColorSpace;
      for (const t of [map, bump]) {
        t.wrapS = t.wrapT = RepeatWrapping;
        t.repeat.set(repeat, repeat);
        t.anisotropy = anisotropy;
        this.owned.push(t);
      }
      const m = new MeshPhysicalMaterial({
        map,
        bumpMap: bump,
        bumpScale: look.bump,
        roughness: look.roughness,
        metalness: 0,
        sheen: look.sheen ?? 0,
        sheenRoughness: 0.8,
        sheenColor: new Color(mix(state.color, '#ffffff', 0.4)),
        clearcoat: look.clearcoat ?? 0,
        clearcoatRoughness: 0.35,
        // Less overhead bounce than the book gets, so the key light models the surface.
        envMapIntensity: 0.6,
        transparent: true,
      });
      this.fade.value = R;
      installRadialFade(m, this.fade);
      this.surface = new Mesh(new CircleGeometry(R, 96).rotateX(-Math.PI / 2), m);
      this.surface.position.y = -0.004;
      this.surface.receiveShadow = false;
      this.surface.castShadow = false;
      this.surface.renderOrder = -1;
      this.group.add(this.surface);
    }
  }

  /** Background for the renderer (null = transparent). `dim` darkens it for night-like lighting. */
  background(dim: number): Color | Texture | null {
    const s = this.state;
    if (s.preset === 'transparent') return null;
    if (s.preset === 'gradient' && this.gradient) return this.gradient;
    let base = s.color;
    if (isSurface(s.preset)) base = s.showGround ? mix(s.color, '#ebe6de', 0.45) : s.color;
    else if (s.preset === 'studio-sweep') base = mix(s.color, '#000000', 0.12);
    return new Color(base).multiplyScalar(Math.max(0, Math.min(1, dim)));
  }

  /** Keep the cove's wall behind the book as the camera moves. */
  follow(x: number, z: number, cameraAzimuth: number): void {
    this.group.position.set(x, 0, z);
    if (this.cove) this.cove.rotation.y = cameraAzimuth;
  }

  private clear(): void {
    for (const t of this.owned) t.dispose();
    this.owned = [];
    for (const m of [this.surface, this.cove]) {
      if (!m) continue;
      m.geometry.dispose();
      m.material.dispose();
      this.group.remove(m);
    }
    this.surface = null;
    this.cove = null;
    this.gradient = null;
  }

  dispose(): void {
    this.clear();
  }
}

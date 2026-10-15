/**
 * Lighting presets and the light rig: a shadow-casting key, a fill, a rim / back light and an
 * optional overhead spot (gallery pools), plus environment (bounce) light and exposure.
 */
import { Color, DirectionalLight, SpotLight, Vector3, type Object3D } from 'three';
import type { LightingOptions, LightingPreset } from './types';

export interface ResolvedLighting {
  preset: LightingPreset;
  intensity: number;
  azimuth: number;
  elevation: number;
  warmth: number;
  exposure: number;
  shadowSoftness: number;
  ambient: number;
  /** Look-specific extras the preset carries (not user fields). */
  fill: number;
  rim: number;
  rimColor: string;
  spot: number;
  /** Multiplier on unlit backdrops (solid / gradient colours): night and dramatic darken the set. */
  backdrop: number;
}

type Look = Omit<ResolvedLighting, 'preset'>;

const LOOKS: Record<LightingPreset, Look> = {
  // Large key at 3/4, gentle fill and rim: the neutral catalogue look.
  'studio': { intensity: 1, azimuth: -55, elevation: 50, warmth: 0.12, exposure: 1, shadowSoftness: 0.6, ambient: 1, fill: 0.32, rim: 0.55, rimColor: '#ffffff', spot: 0, backdrop: 1 },
  // Huge diffused source almost overhead: shadowless wrap-around light.
  'soft-box': { intensity: 1, azimuth: -25, elevation: 62, warmth: 0.04, exposure: 1.06, shadowSoftness: 1, ambient: 1.25, fill: 0.5, rim: 0.3, rimColor: '#ffffff', spot: 0, backdrop: 1 },
  // Cool daylight raking in from one side, little fill.
  'window': { intensity: 1.1, azimuth: -95, elevation: 24, warmth: -0.65, exposure: 1, shadowSoftness: 0.7, ambient: 0.65, fill: 0.12, rim: 0.2, rimColor: '#dfe8ff', spot: 0, backdrop: 0.97 },
  // Low, warm sun from the side-back: long shadows and a glowing edge.
  'golden-hour': { intensity: 1.15, azimuth: 70, elevation: 9, warmth: 1, exposure: 1.08, shadowSoftness: 0.35, ambient: 0.5, fill: 0.14, rim: 0.7, rimColor: '#ffb066', spot: 0, backdrop: 0.95 },
  // Hard key from the side, almost no fill, strong cool rim from behind.
  'dramatic': { intensity: 1.2, azimuth: -112, elevation: 32, warmth: 0.1, exposure: 0.92, shadowSoftness: 0.05, ambient: 0.18, fill: 0.03, rim: 1.7, rimColor: '#e6efff', spot: 0, backdrop: 0.55 },
  // Overhead copy-stand light.
  'top-down': { intensity: 1, azimuth: 0, elevation: 85, warmth: 0, exposure: 1, shadowSoftness: 0.5, ambient: 0.9, fill: 0.22, rim: 0, rimColor: '#ffffff', spot: 0, backdrop: 1 },
  // Bright, flat sky: weak key, lots of bounce, faint shadow.
  'overcast': { intensity: 0.65, azimuth: 10, elevation: 70, warmth: -0.22, exposure: 1.12, shadowSoftness: 1, ambient: 1.65, fill: 0.55, rim: 0.15, rimColor: '#eef3ff', spot: 0, backdrop: 0.98 },
  // Warm ceiling spots: a pool of light on the book, the room falling off around it.
  'gallery': { intensity: 1, azimuth: -18, elevation: 78, warmth: 0.38, exposure: 1, shadowSoftness: 0.3, ambient: 0.4, fill: 0.08, rim: 0.3, rimColor: '#fff2dd', spot: 1.4, backdrop: 0.8 },
  // Dark set: a warm lamp as key, a cold moonlit rim.
  'night': { intensity: 0.9, azimuth: 60, elevation: 22, warmth: 0.85, exposure: 0.85, shadowSoftness: 0.4, ambient: 0.1, fill: 0.02, rim: 1.3, rimColor: '#6f8dff', spot: 0, backdrop: 0.22 },
};

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** A preset supplies every field; explicit fields override it. */
export function resolveLighting(o: LightingOptions): ResolvedLighting {
  const preset = o.preset && LOOKS[o.preset] ? o.preset : 'studio';
  const look = LOOKS[preset];
  return {
    ...look,
    preset,
    intensity: clamp(o.intensity ?? look.intensity, 0, 3),
    azimuth: o.azimuth ?? look.azimuth,
    elevation: clamp(o.elevation ?? look.elevation, 5, 85),
    warmth: clamp(o.warmth ?? look.warmth, -1, 1),
    exposure: clamp(o.exposure ?? look.exposure, 0.3, 3),
    shadowSoftness: clamp(o.shadowSoftness ?? look.shadowSoftness, 0, 1),
    ambient: clamp(o.ambient ?? look.ambient, 0, 2),
  };
}

const COOL = new Color('#c9dcff');
const NEUTRAL = new Color('#fff5ea');
const WARM = new Color('#ffbe7a');

/** Light colour for a warmth in −1 … +1 (in linear working space). */
export function warmthColor(w: number): Color {
  const c = NEUTRAL.clone();
  return w >= 0 ? c.lerp(WARM, clamp(w, 0, 1)) : c.lerp(COOL, clamp(-w, 0, 1));
}

/** Unit vector toward a light at azimuth/elevation degrees (0° = +z/front, 90° = +x/right). */
export function lightDirection(azimuthDeg: number, elevationDeg: number): Vector3 {
  const az = (azimuthDeg * Math.PI) / 180;
  const el = (elevationDeg * Math.PI) / 180;
  return new Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el));
}

export class LightRig {
  readonly key = new DirectionalLight(0xffffff, 2.6);
  readonly fill = new DirectionalLight(0xffffff, 0.4);
  readonly rim = new DirectionalLight(0xffffff, 0.8);
  readonly spot = new SpotLight(0xffffff, 0, 0, 0.42, 0.75, 0);

  constructor() {
    this.key.castShadow = true;
    this.key.shadow.mapSize.set(1024, 1024);
    this.key.shadow.bias = -0.0003;
    this.key.shadow.blurSamples = 24;
    this.spot.castShadow = false;
  }

  get objects(): Object3D[] {
    return [this.key, this.key.target, this.fill, this.fill.target, this.rim, this.rim.target, this.spot, this.spot.target];
  }

  /**
   * Place and colour the lights around `center` for a book of size `span` (scene units).
   * `mirror` flips azimuths for right-to-left books.
   */
  apply(l: ResolvedLighting, center: Vector3, span: number, mirror: boolean, shadows: boolean): void {
    const dist = span * 3;
    const sign = mirror ? -1 : 1;
    const place = (light: DirectionalLight | SpotLight, az: number, el: number, d = dist) => {
      light.position.copy(center).addScaledVector(lightDirection(sign * az, el), d);
      light.target.position.copy(center);
      light.target.updateMatrixWorld();
    };
    const keyColor = warmthColor(l.warmth);
    const i = l.intensity;
    this.key.color.copy(keyColor);
    this.key.intensity = 2.6 * i;
    place(this.key, l.azimuth, l.elevation);
    // Fill from the other side, low, a touch cooler / warmer than the key.
    this.fill.color.copy(warmthColor(-0.4 * l.warmth));
    this.fill.intensity = 2.6 * i * l.fill;
    place(this.fill, l.azimuth + 140, Math.min(35, l.elevation * 0.6 + 8));
    // Rim / back light, opposite the key.
    this.rim.color.set(l.rimColor);
    this.rim.intensity = 1.6 * i * l.rim;
    place(this.rim, l.azimuth + 180, 35);
    // Overhead spot pool.
    this.spot.color.copy(keyColor);
    this.spot.intensity = l.spot > 0 ? 4 * i * l.spot : 0;
    this.spot.visible = l.spot > 0;
    this.spot.angle = 0.42;
    this.spot.distance = 0;
    place(this.spot, l.azimuth * 0.3, 82, span * 2.4);

    this.key.castShadow = shadows;
    // Softness → VSM blur: from a crisp ~1 mm penumbra to a broad ~2 cm one.
    const reach = this.key.shadow.camera.right;
    const texel = (2 * reach) / this.key.shadow.mapSize.x;
    const penumbra = 0.08 + 1.9 * l.shadowSoftness;
    this.key.shadow.radius = clamp(penumbra / Math.max(1e-6, texel), 1, 30);
  }
}

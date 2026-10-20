import type { BookSpec, PaperMaterial } from '../model/types';
import type { BindingCalc, JacketCalc } from '../engine/binding';

export interface PageInfo {
  material: PaperMaterial;          // 'paper' | 'vellum' | 'colored' | 'kraft'
  paperColor: string;               // hex
  vellumOpacity: number;            // 0–1, for vellum
  /** Munari die-cut windows in page-local pt (origin top-left of the trimmed page, y down). */
  cutouts: { x: number; y: number; w: number; h: number; shape: 'rect' | 'ellipse' }[];
}

export interface BookSceneInput {
  spec: BookSpec;
  calc: BindingCalc;
  /** index 0 = page 1 */
  pages: PageInfo[];
  /** Dust jacket layout (`computeJacket`); null / undefined = no jacket. */
  jacket?: JacketCalc | null;
}

export type FinishKey = 'gold-foil' | 'silver-foil' | 'copper-foil' | 'holo-foil' | 'blind-deboss' | 'spot-gloss';

export interface BookTextures {
  /** Flat unwrapped cover art. Canvas pixel (0,0) = cover-surface point (-calc.wrap, -calc.wrap);
   *  canvas size = (calc.coverW + 2·wrap, calc.coverH + 2·wrap) × coverPxPerPt.
   *  Horizontal layout of panels (back/spine/front/flaps/joints) is given by calc.panels (x in pt from the left edge of the cover surface, already mirrored for right-to-left books). */
  cover: HTMLCanvasElement | null;
  coverPxPerPt: number;
  /** Same size/layout as `cover`; white (luminance/alpha) where that finish is applied. */
  finishMasks: Partial<Record<FinishKey, HTMLCanvasElement>>;
  /** Trim-sized page art (no bleed), index 0 = page 1 (a recto). null = blank paper. */
  pages: (HTMLCanvasElement | null)[];
  pagePxPerPt: number;
  /** Flat dust-jacket art. Pixel (0,0) = jacket point (−bleed, −bleed); size (width + 2·bleed,
   *  height + 2·bleed) × jacketPxPerPt; panels from JacketCalc.panels (RTL already mirrored). */
  jacket?: HTMLCanvasElement | null;
  jacketPxPerPt?: number;
  /** Same size/layout as `jacket`. */
  jacketFinishMasks?: Partial<Record<FinishKey, HTMLCanvasElement>>;
}

export type AnimationMode =
  | 'none' | 'orbit' | 'open' | 'page-turn' | 'showcase'
  | 'flip-through' | 'spine-reveal' | 'float' | 'push-in' | 'turntable-flat'
  | 'read-spread' | 'drop-in' | 'jacket-off' | 'cover-close-up';

export interface AnimationOptions {
  /** Seconds. Defaults depend on the mode (see `getAnimationDuration`). */
  duration?: number;
  /** Leaves turned by 'page-turn' (default 3, capped at the modelled leaves). */
  pagesToTurn?: number;
  /** Repeat when playing (default true). */
  loop?: boolean;
}

export interface AnimationInfo {
  id: AnimationMode;
  label: string;
  /** Seconds, for the current book (and the current `pagesToTurn`). */
  duration: number;
  description: string;
}

export interface EnvironmentOptions {
  background?: string;
  lightIntensity?: number;
  shadows?: boolean;
  showGround?: boolean;
}

export type LightingPreset = 'studio' | 'soft-box' | 'window' | 'golden-hour' | 'dramatic' | 'top-down' | 'overcast' | 'gallery' | 'night';

export interface LightingOptions {
  preset?: LightingPreset;
  /** 0–3, default 1. */
  intensity?: number;
  /** Key light around the book, degrees: 0 = from the front, 90 = from the right, −90 = from the left
   *  (mirrored for right-to-left books, so it keeps falling on the spine side). */
  azimuth?: number;
  /** Key light height, degrees 5–85. */
  elevation?: number;
  /** −1 cool … +1 warm. */
  warmth?: number;
  /** Tone-mapping exposure 0.3–3. */
  exposure?: number;
  /** 0 hard … 1 very soft shadows. */
  shadowSoftness?: number;
  /** Environment (bounce) light 0–2. */
  ambient?: number;
}

export type BackdropPreset = 'solid' | 'gradient' | 'studio-sweep' | 'wood' | 'linen' | 'concrete' | 'paper' | 'marble' | 'felt' | 'transparent';

export interface BackdropOptions {
  preset: BackdropPreset;
  /** solid: background; gradient: top colour; studio-sweep: cove colour; surfaces: base tint. */
  color?: string;
  /** gradient: bottom colour; surfaces: secondary (grain / vein) colour. */
  color2?: string;
  showGround?: boolean;
}

export type CameraPose = 'standing' | 'lying' | 'angled' | 'open';

export interface CameraOptions {
  /** Vertical field of view, degrees 15–75 (long lens = flatter product shot). */
  fov?: number;
  /** Resting pose between animations. */
  pose?: CameraPose;
}

export interface BookSceneOptions {
  background?: string;
  preserveDrawingBuffer?: boolean;
}

/**
 * Texture density the book needs to look sharp in a given view (px per pt of the page / cover
 * art); 0 = not in view. See BookScene.getTextureDemand.
 */
export interface TextureDemand {
  /** Page faces in view (index 0 = page 1), sharpest need first. */
  pages: { index: number; pxPerPt: number }[];
  /** Front panel of the cover (case board, soft cover) and of the dust jacket. */
  coverFront: number;
  jacketFront: number;
}

/** Sharper art for the front panel of the cover / jacket wrap. */
export interface PanelArt {
  canvas: HTMLCanvasElement;
  masks: Partial<Record<FinishKey, HTMLCanvasElement>>;
  /** Rectangle of the wrap the canvas covers, pt (cover / jacket canvas frame, origin at the trim). */
  box: { x: number; y: number; w: number; h: number };
}

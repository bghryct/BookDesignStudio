import type { BookSpec, PaperMaterial } from '../model/types';
import type { BindingCalc } from '../engine/binding';

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
}

export type AnimationMode = 'none' | 'orbit' | 'open' | 'page-turn' | 'showcase';

export interface AnimationOptions {
  /** Seconds. Defaults depend on the mode (see `getAnimationDuration`). */
  duration?: number;
  /** Leaves turned by 'page-turn' (default 3, capped at the modelled leaves). */
  pagesToTurn?: number;
  /** Repeat when playing (default true). */
  loop?: boolean;
}

export interface EnvironmentOptions {
  background?: string;
  lightIntensity?: number;
  shadows?: boolean;
  showGround?: boolean;
}

export interface BookSceneOptions {
  background?: string;
  preserveDrawingBuffer?: boolean;
}

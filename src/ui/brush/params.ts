/**
 * Shared brush-UI vocabulary: parameter labels / ranges, the logarithmic size
 * scale, and the panel's open/collapsed state.
 */
import { create } from 'zustand';
import type { BrushType } from '../../model/types';
import type { BrushParams } from '../../engine/brushes';

export type ParamKey = keyof BrushParams;

export const SIZE_MIN = 0.5;
export const SIZE_MAX = 160;
const SIZE_SPAN = Math.log(SIZE_MAX / SIZE_MIN);

/** Slider position 0–1 ↔ brush size in pt (log scale: fine control for thin pens). */
export const sizeToT = (size: number) => Math.log(Math.max(SIZE_MIN, Math.min(SIZE_MAX, size)) / SIZE_MIN) / SIZE_SPAN;
export const tToSize = (t: number) => {
  const v = SIZE_MIN * Math.exp(t * SIZE_SPAN);
  return v < 10 ? Math.round(v * 10) / 10 : Math.round(v);
};
export const fmtSize = (v: number) => `${v < 10 ? v.toFixed(1) : Math.round(v)} pt`;
export const fmtPct = (v: number) => `${Math.round(v * 100)}%`;

export const SIZE_PRESETS = [1, 2, 4, 8, 16, 32, 64];

interface ParamMeta { label: string; hint: string; min: number; max: number; step: number; format: (v: number) => string }

const GENERIC: Record<Exclude<ParamKey, 'size'>, ParamMeta> = {
  opacity: { label: 'Opacity', hint: 'Overall strength of the stroke', min: 0, max: 1, step: 0.01, format: fmtPct },
  flow: { label: 'Flow', hint: 'How much medium each pass lays down', min: 0, max: 1, step: 0.01, format: fmtPct },
  hardness: { label: 'Hardness', hint: 'Crisp or feathered edge', min: 0, max: 1, step: 0.01, format: fmtPct },
  grain: { label: 'Grain', hint: 'How strongly the medium catches the paper tooth', min: 0, max: 1, step: 0.01, format: fmtPct },
  wetness: { label: 'Wetness', hint: 'Water in the brush: spread, blooms and soft edges', min: 0, max: 1, step: 0.01, format: fmtPct },
  angle: { label: 'Nib angle', hint: 'Angle of the broad nib / chisel tip', min: -90, max: 90, step: 1, format: (v) => `${Math.round(v)}°` },
};

/** Medium-specific wording for the generic engine parameters. */
const OVERRIDES: Partial<Record<BrushType, Partial<Record<ParamKey, Partial<ParamMeta>>>>> = {
  pencil: { grain: { label: 'Paper tooth' } },
  graphite: { grain: { label: 'Paper tooth' }, flow: { label: 'Build-up' }, hardness: { label: 'Stick hardness' } },
  charcoal: { grain: { label: 'Paper tooth' }, flow: { label: 'Build-up' } },
  crayon: { grain: { label: 'Paper tooth' } },
  pastel: { grain: { label: 'Paper tooth' }, flow: { label: 'Build-up' }, hardness: { label: 'Stick hardness' } },
  watercolor: {
    flow: { label: 'Pigment load', hint: 'Pigment concentration of the wash' },
    wetness: { label: 'Wetness & bloom', hint: 'More water: wider bleed, softer edge, cauliflower blooms' },
    grain: { label: 'Granulation', hint: 'Pigment settling into the paper valleys' },
  },
  gouache: { flow: { label: 'Paint load', hint: 'Less paint = earlier dry-brush streaks' }, wetness: { hint: 'Wetter paint travels further before the brush runs dry' } },
  airbrush: { flow: { label: 'Spray density' }, hardness: { label: 'Nozzle focus' } },
  ink: { flow: { label: 'Pressure response', hint: 'How much the line swells with pressure' } },
  calligraphy: { angle: { label: 'Nib angle', hint: '30° is the classic angle for textura and bastarda hands' } },
  marker: { angle: { label: 'Chisel angle' } },
  highlighter: { angle: { label: 'Chisel angle' } },
  stipple: { flow: { label: 'Dot density' }, grain: { label: 'Dot size', hint: 'Size of the individual dots' } },
  'gold-leaf': { grain: { label: 'Craquelure', hint: 'Fine cracks revealing the red bole' } },
  eraser: { hardness: { hint: 'Crisp cut or feathered lift' } },
};

export function paramMeta(type: BrushType, key: Exclude<ParamKey, 'size'>): ParamMeta {
  return { ...GENERIC[key], ...OVERRIDES[type]?.[key] };
}

/* -------------------------------------------------------------------------- */
/* Panel state                                                                 */
/* -------------------------------------------------------------------------- */

const PANEL_KEY = 'bds.brushPanel';

function loadPanel(): { open: boolean; collapsed: boolean } {
  try {
    const v = JSON.parse(localStorage.getItem(PANEL_KEY) ?? '{}');
    return { open: v.open !== false, collapsed: v.collapsed === true };
  } catch {
    return { open: true, collapsed: false };
  }
}

interface BrushPanelState {
  /** Panel shown at all (toggled from the brush bar). */
  open: boolean;
  /** Folded down to its header. */
  collapsed: boolean;
  setOpen: (open: boolean) => void;
  toggle: () => void;
  setCollapsed: (collapsed: boolean) => void;
}

export const useBrushPanel = create<BrushPanelState>((set, get) => {
  const save = () => {
    try { localStorage.setItem(PANEL_KEY, JSON.stringify({ open: get().open, collapsed: get().collapsed })); } catch { /* storage unavailable */ }
  };
  return {
    ...loadPanel(),
    setOpen: (open) => { set({ open }); save(); },
    toggle: () => { set({ open: !get().open, collapsed: false }); save(); },
    setCollapsed: (collapsed) => { set({ collapsed }); save(); },
  };
});

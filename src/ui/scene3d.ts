import { create } from 'zustand';
import type { AnimationMode, LightingPreset, LightingOptions, BackdropPreset, CameraPose } from '../three/types';

/* -------------------------------------------------------------------------- */
/* Scene settings (persist across view switches; per-viewer convenience)       */
/* -------------------------------------------------------------------------- */

interface SceneSettings {
  mode: AnimationMode;
  loop: boolean;
  pagesToTurn: number;
  speed: number;
  lighting: LightingPreset;
  light: Partial<LightingOptions>;
  backdrop: BackdropPreset;
  color: string;
  color2: string;
  ground: boolean;
  fov: number;
  pose: CameraPose;
  showJacket: boolean;
  panel: boolean;
  /** Texture sharpness and canvas pixel ratio: standard (lighter), high, ultra (sharpest). */
  quality: 'standard' | 'high' | 'ultra';
}

const DEFAULTS: SceneSettings = {
  mode: 'showcase', loop: true, pagesToTurn: 4, speed: 1,
  lighting: 'studio', light: {}, backdrop: 'studio-sweep', color: '#d9d4cb', color2: '#b9b2a6', ground: true,
  fov: 32, pose: 'angled', showJacket: true, panel: true, quality: 'high',
};

function load(): SceneSettings {
  try {
    const raw = localStorage.getItem('bds.scene3d');
    return raw ? { ...DEFAULTS, ...JSON.parse(raw) } : DEFAULTS;
  } catch {
    return DEFAULTS;
  }
}

/** 3D scene settings, remembered per browser. Kept apart from Viewer3D so the shell can toggle the panel without loading three.js. */
export const useScene3D = create<SceneSettings & { set: (p: Partial<SceneSettings>) => void }>((set, get) => ({
  ...load(),
  set: (p) => {
    set(p);
    try { const { set: _s, ...rest } = { ...get(), ...p }; void _s; localStorage.setItem('bds.scene3d', JSON.stringify(rest)); } catch { /* storage unavailable */ }
  },
}));


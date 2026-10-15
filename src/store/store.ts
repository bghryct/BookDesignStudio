import { create } from 'zustand';
import { produce, type Draft } from 'immer';
import type { BrushType, Element, ID, Project, SurfaceKey } from '../model/types';
import { createDefaultProject } from '../model/defaults';
import { findElement, surfaceElementsDraft, spreadsOf } from '../model/surfaces';
import { cloneElement } from '../model/factory';
import { idbGet, idbSet } from '../lib/idb';

export type View = 'spreads' | 'cover' | '3d' | 'matrix';

export type Tool =
  | 'select' | 'node' | 'hand' | 'zoom'
  | 'text' | 'rect' | 'ellipse' | 'polygon' | 'line' | 'pen' | 'image'
  | 'brush' | 'eraser'
  | 'pattern' | 'ornament' | 'initial' | 'overprint' | 'gradient' | 'cutout' | 'gridtype'
  | 'grid-diagram' | 'dimension' | 'specimen';

export interface BrushSettings {
  type: BrushType;
  size: number;
  opacity: number;
  color: string;
  flow: number;
  hardness: number;
  grain: number;
  wetness: number;
  angle: number;
  stabilizer: number;
  pressure: boolean;
}

export type RightTab = 'element' | 'type' | 'document' | 'binding' | 'fonts';
export type LeftTab = 'pages' | 'layers' | 'library' | 'presets' | 'assets';

/** Which master is being edited instead of a spread. */
export interface MasterEdit { id: ID }

interface State {
  project: Project;
  past: Project[];
  future: Project[];
  /** Bumped by every project change; used for autosave and thumbnails. */
  rev: number;

  view: View;
  spread: number;
  masterEdit: MasterEdit | null;
  selection: ID[];
  tool: Tool;
  zoom: number;
  fitRequest: number;
  brush: BrushSettings;
  leftTab: LeftTab;
  rightTab: RightTab;
  textEditing: ID | null;
  /** Element awaiting a thread target (text frame link mode). */
  linking: ID | null;
  clipboard: Element[];
  toast: { text: string; kind: 'info' | 'error' } | null;
  exportOpen: boolean;
  ready: boolean;

  /** Apply an immer recipe to the project. `history: false` merges into the current state (drags). */
  update: (recipe: (draft: Draft<Project>) => void, opts?: { history?: boolean }) => void;
  /** Push the current project onto the undo stack (call at the start of a drag). */
  checkpoint: () => void;
  undo: () => void;
  redo: () => void;
  replaceProject: (p: Project) => void;

  setView: (v: View) => void;
  setSpread: (i: number) => void;
  setMasterEdit: (m: MasterEdit | null) => void;
  select: (ids: ID[]) => void;
  setTool: (t: Tool) => void;
  setZoom: (z: number) => void;
  requestFit: () => void;
  setBrush: (b: Partial<BrushSettings>) => void;
  setLeftTab: (t: LeftTab) => void;
  setRightTab: (t: RightTab) => void;
  setTextEditing: (id: ID | null) => void;
  setLinking: (id: ID | null) => void;
  setExportOpen: (open: boolean) => void;
  notify: (text: string, kind?: 'info' | 'error') => void;

  updateElement: (id: ID, patch: Partial<Element> | ((el: Draft<Element>) => void), opts?: { history?: boolean }) => void;
  addElement: (key: SurfaceKey, el: Element, select?: boolean) => void;
  deleteSelection: () => void;
  duplicateSelection: () => void;
  copySelection: () => void;
  paste: (key: SurfaceKey) => void;
  arrange: (dir: 'front' | 'back' | 'forward' | 'backward') => void;
}

const HISTORY_LIMIT = 150;

export const useStore = create<State>((set, get) => ({
  project: createDefaultProject(),
  past: [],
  future: [],
  rev: 0,

  view: 'spreads',
  spread: 3,
  masterEdit: null,
  selection: [],
  tool: 'select',
  zoom: 1,
  fitRequest: 0,
  brush: { type: 'watercolor', size: 18, opacity: 0.85, color: '#2b4a8f', flow: 0.7, hardness: 0.5, grain: 0.5, wetness: 0.6, angle: 30, stabilizer: 0.35, pressure: true },
  leftTab: 'pages',
  rightTab: 'element',
  textEditing: null,
  linking: null,
  clipboard: [],
  toast: null,
  exportOpen: false,
  ready: false,

  update: (recipe, opts) => {
    const { project, past } = get();
    const next = produce(project, recipe);
    if (next === project) return;
    if (opts?.history === false) set({ project: next, rev: get().rev + 1 });
    else set({ project: next, past: [...past.slice(-HISTORY_LIMIT), project], future: [], rev: get().rev + 1 });
  },
  checkpoint: () => {
    const { project, past } = get();
    if (past[past.length - 1] === project) return;
    set({ past: [...past.slice(-HISTORY_LIMIT), project], future: [] });
  },
  undo: () => {
    const { past, project, future } = get();
    if (!past.length) return;
    let prev = past[past.length - 1];
    let rest = past.slice(0, -1);
    // Skip a checkpoint that equals the present (a click without a drag).
    if (prev === project && rest.length) { prev = rest[rest.length - 1]; rest = rest.slice(0, -1); }
    set({ project: prev, past: rest, future: [project, ...future], rev: get().rev + 1 });
  },
  redo: () => {
    const { past, project, future } = get();
    if (!future.length) return;
    set({ project: future[0], past: [...past, project], future: future.slice(1), rev: get().rev + 1 });
  },
  replaceProject: (p) => set({ project: p, past: [], future: [], selection: [], spread: 0, masterEdit: null, rev: get().rev + 1 }),

  setView: (view) => set({ view, selection: [], textEditing: null }),
  setSpread: (i) => {
    const n = spreadsOf(get().project).length;
    set({ spread: Math.max(0, Math.min(n - 1, i)), selection: [], masterEdit: null, textEditing: null });
  },
  setMasterEdit: (masterEdit) => set({ masterEdit, selection: [], view: 'spreads', textEditing: null }),
  select: (selection) => set({ selection, textEditing: get().textEditing && selection.includes(get().textEditing!) ? get().textEditing : null }),
  setTool: (tool) => set({ tool, linking: null }),
  setZoom: (zoom) => set({ zoom: Math.max(0.05, Math.min(32, zoom)) }),
  requestFit: () => set({ fitRequest: get().fitRequest + 1 }),
  setBrush: (b) => set({ brush: { ...get().brush, ...b } }),
  setLeftTab: (leftTab) => set({ leftTab }),
  setRightTab: (rightTab) => set({ rightTab }),
  setTextEditing: (textEditing) => set({ textEditing }),
  setLinking: (linking) => set({ linking }),
  setExportOpen: (exportOpen) => set({ exportOpen }),
  notify: (text, kind = 'info') => {
    set({ toast: { text, kind } });
    const t = text;
    setTimeout(() => { if (get().toast?.text === t) set({ toast: null }); }, 3800);
  },

  updateElement: (id, patch, opts) => {
    get().update((d) => {
      const loc = findElement(d as Project, id);
      if (!loc) return;
      const els = surfaceElementsDraft(d as Project, loc.key)!;
      const el = els[loc.index] as Draft<Element>;
      if (typeof patch === 'function') patch(el);
      else Object.assign(el, patch);
    }, opts);
  },
  addElement: (key, el, select = true) => {
    get().update((d) => { surfaceElementsDraft(d as Project, key)?.push(el as Draft<Element>); });
    if (select) set({ selection: [el.id] });
  },
  deleteSelection: () => {
    const ids = new Set(get().selection);
    if (!ids.size) return;
    get().update((d) => {
      const strip = (els: Draft<Element>[]) => {
        for (let i = els.length - 1; i >= 0; i--) if (ids.has(els[i].id) && !els[i].locked) els.splice(i, 1);
        // Unthread links that pointed at removed frames.
        for (const e of els) if (e.type === 'text' && e.flowNext && ids.has(e.flowNext)) e.flowNext = null;
      };
      for (const p of d.pages) strip(p.elements);
      for (const m of d.masters) { strip(m.left); strip(m.right); }
      strip(d.cover.elements);
      for (const p of d.pages) for (const e of p.elements) if (e.type === 'text' && e.flowNext && ids.has(e.flowNext)) e.flowNext = null;
    });
    set({ selection: [], textEditing: null });
  },
  duplicateSelection: () => {
    const { project, selection } = get();
    const created: ID[] = [];
    get().update((d) => {
      for (const id of selection) {
        const loc = findElement(project, id);
        if (!loc) continue;
        const copy = cloneElement(loc.el, 12, 12);
        created.push(copy.id);
        surfaceElementsDraft(d as Project, loc.key)?.push(copy as Draft<Element>);
      }
    });
    set({ selection: created });
  },
  copySelection: () => {
    const { project, selection } = get();
    const els = selection.map((id) => findElement(project, id)?.el).filter(Boolean) as Element[];
    set({ clipboard: els.map((e) => JSON.parse(JSON.stringify(e))) });
  },
  paste: (key) => {
    const clip = get().clipboard;
    if (!clip.length) return;
    const copies = clip.map((e) => cloneElement(e, 10, 10));
    get().update((d) => { const els = surfaceElementsDraft(d as Project, key); if (els) els.push(...(copies as Draft<Element>[])); });
    set({ selection: copies.map((c) => c.id), clipboard: copies });
  },
  arrange: (dir) => {
    const { selection } = get();
    get().update((d) => {
      for (const id of selection) {
        const loc = findElement(d as Project, id);
        if (!loc) continue;
        const els = surfaceElementsDraft(d as Project, loc.key)!;
        const [el] = els.splice(loc.index, 1);
        const to = dir === 'front' ? els.length : dir === 'back' ? 0 : dir === 'forward' ? Math.min(els.length, loc.index + 1) : Math.max(0, loc.index - 1);
        els.splice(to, 0, el);
      }
    });
  },
}));

/* -------------------------------------------------------------------------- */
/* Persistence (IndexedDB autosave)                                            */
/* -------------------------------------------------------------------------- */

const AUTOSAVE_KEY = 'autosave';
let saveTimer: ReturnType<typeof setTimeout> | null = null;

export async function loadAutosave(): Promise<Project | null> {
  try {
    const p = await idbGet<Project>('projects', AUTOSAVE_KEY);
    return p && p.version === 1 && Array.isArray(p.pages) ? p : null;
  } catch {
    return null;
  }
}

export function startAutosave() {
  let last = useStore.getState().project;
  useStore.subscribe((s) => {
    if (s.project === last) return;
    last = s.project;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { void idbSet('projects', AUTOSAVE_KEY, last).catch(() => undefined); }, 700);
  });
}

export const getState = () => useStore.getState();

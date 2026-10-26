import { create } from 'zustand';
import { produce, type Draft } from 'immer';
import type { BrushType, Element, ID, Project, SurfaceKey } from '../model/types';
import { createDefaultProject } from '../model/defaults';
import { findElement, surfaceElementsDraft, spreadsOf, releaseTextFrames } from '../model/surfaces';
import { cloneElement } from '../model/factory';
import { releaseTableFrames } from '../model/table';
import { idbGet, idbSet } from '../lib/idb';
import { normalizeProject } from '../model/normalize';

export type View = 'spreads' | 'cover' | 'jacket' | '3d' | 'matrix';

export type Tool =
  | 'select' | 'node' | 'hand' | 'zoom'
  | 'text' | 'rect' | 'ellipse' | 'polygon' | 'line' | 'pen' | 'image'
  | 'brush' | 'eraser'
  | 'pattern' | 'ornament' | 'initial' | 'overprint' | 'gradient' | 'cutout' | 'gridtype'
  | 'grid-diagram' | 'dimension' | 'specimen' | 'table';

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
  /** Left panel visibility (collapsed by default on narrow screens). */
  leftOpen: boolean;
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
  setLeftOpen: (open: boolean) => void;
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
  /** Ruler guides: add (returns index), move, remove; axis 'x' = vertical guide at x. */
  addGuide: (key: SurfaceKey, axis: 'x' | 'y', pos: number) => void;
  moveGuide: (key: SurfaceKey, axis: 'x' | 'y', index: number, pos: number, opts?: { history?: boolean }) => void;
  removeGuide: (key: SurfaceKey, axis: 'x' | 'y', index: number) => void;
  clearGuides: (keys: SurfaceKey[]) => void;
}

const HISTORY_LIMIT = 150;
let lastHistoryAt = 0;

/**
 * What the view keeps after undo or redo: the spread stays within the book (undoing Flow text
 * removed the pages it was showing), and a master that no longer exists stops being edited.
 */
function viewFor(p: Project, s: { spread: number; masterEdit: MasterEdit | null }): Partial<Pick<State, 'spread' | 'masterEdit'>> {
  const out: Partial<Pick<State, 'spread' | 'masterEdit'>> = {};
  const last = Math.max(0, spreadsOf(p).length - 1);
  if (s.spread > last) out.spread = last;
  if (s.masterEdit && !p.masters.some((m) => m.id === s.masterEdit!.id)) out.masterEdit = null;
  return out;
}

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
  leftOpen: typeof window === 'undefined' ? true : window.innerWidth > 900,
  rightTab: 'element',
  textEditing: null,
  linking: null,
  clipboard: [],
  toast: null,
  exportOpen: false,
  ready: false,

  update: (recipe, opts) => {
    const { project, past } = get();
    const changed = produce(project, recipe);
    if (changed === project) return;
    // Every change stamps the modification time ({modified}).
    const next = produce(changed, (d) => { d.modifiedAt = Date.now(); if (d.createdAt == null) d.createdAt = Date.now(); });
    // Live edits (drags, typing) ride on the caller's checkpoint and leave the burst timer alone,
    // so a real change made just after one still gets its own undo step.
    if (opts?.history === false) { set({ project: next, future: [], rev: get().rev + 1 }); return; }
    const now = performance.now();
    // A burst of changes (dragging in a colour picker, holding an arrow key) is one undo step.
    const burst = now - lastHistoryAt < 300;
    lastHistoryAt = now;
    if (burst && past.length) set({ project: next, future: [], rev: get().rev + 1 });
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
    set({ project: prev, past: rest, future: [project, ...future], rev: get().rev + 1, ...viewFor(prev, get()) });
  },
  redo: () => {
    const { past, project, future } = get();
    if (!future.length) return;
    set({ project: future[0], past: [...past, project], future: future.slice(1), rev: get().rev + 1, ...viewFor(future[0], get()) });
  },
  replaceProject: (p) => {
    // Projects from outside (files, older versions) are repaired first; throws when it has no pages.
    const repairs = { count: 0 };
    const project = normalizeProject(p, repairs);
    set({ project, past: [], future: [], selection: [], spread: 0, masterEdit: null, textEditing: null, rev: get().rev + 1 });
    if (repairs.count) tellRepairs(repairs.count);
  },

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
  setLeftOpen: (leftOpen) => set({ leftOpen }),
  setRightTab: (rightTab) => set({ rightTab }),
  setTextEditing: (textEditing) => set({ textEditing }),
  setLinking: (linking) => set({ linking }),
  setExportOpen: (exportOpen) => set({ exportOpen }),
  notify: (text, kind = 'info') => {
    set({ toast: { text, kind } });
    const t = text;
    // Long notices stay long enough to read (about 55 ms a character, up to 15 s).
    setTimeout(() => { if (get().toast?.text === t) set({ toast: null }); }, Math.min(15000, Math.max(3800, text.length * 55)));
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
      releaseTableFrames(d as Project, ids);
      releaseTextFrames(d as Project, ids);
      const strip = (els: Draft<Element>[]) => {
        for (let i = els.length - 1; i >= 0; i--) if (ids.has(els[i].id) && !els[i].locked) els.splice(i, 1);
        // Unthread links that pointed at removed frames.
        for (const e of els) if (e.type === 'text' && e.flowNext && ids.has(e.flowNext)) e.flowNext = null;
      };
      for (const p of d.pages) strip(p.elements);
      for (const m of d.masters) { strip(m.left); strip(m.right); }
      strip(d.cover.elements);
      if (d.jacket) strip(d.jacket.elements);
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
  addGuide: (key, axis, pos) => {
    get().update((d) => {
      if (!d.guides) d.guides = {};
      if (!d.guides[key]) d.guides[key] = { x: [], y: [] };
      d.guides[key][axis].push(+pos.toFixed(3));
    });
  },
  moveGuide: (key, axis, index, pos, opts) => {
    get().update((d) => {
      const g = d.guides?.[key];
      if (g && index < g[axis].length) g[axis][index] = +pos.toFixed(3);
    }, opts);
  },
  removeGuide: (key, axis, index) => {
    get().update((d) => {
      const g = d.guides?.[key];
      if (g) g[axis].splice(index, 1);
    });
  },
  clearGuides: (keys) => {
    get().update((d) => { for (const k of keys) if (d.guides?.[k]) delete d.guides[k]; });
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

/** The stored autosave as it is: safe mode hands it over as a file instead of opening it. */
export async function rawAutosave(): Promise<unknown> {
  try { return await idbGet<unknown>('projects', AUTOSAVE_KEY); } catch { return null; }
}

/*
 * Safe mode. A book that freezes or crashes the tab while it opens would do so again on every
 * reload, so opening is marked as in progress until the book is on screen. If the last opening in
 * this tab never finished (or the address ends in ?safe), the next start does not open the
 * autosave. The mark is per tab (session storage survives a reload, even of a crashed tab), so
 * another tab of the app opening at the same moment never sets it off. A frozen tab that was
 * closed leaves its mark in local storage too: a new tab started more than 30 s after an opening
 * that never finished starts in safe mode (an opening in a working tab takes seconds, and a tab
 * that is closed or reloaded normally takes its mark away).
 */
const OPENING = 'bds.opening';
const OPENING_TABS = 'bds.openingTabs';
const TAB = Math.random().toString(36).slice(2, 10);
const MARK_LIFE = 10 * 60_000;
function openingTabs(): Record<string, number> {
  try { const v = JSON.parse(localStorage.getItem(OPENING_TABS) ?? '{}') as unknown; return v && typeof v === 'object' ? v as Record<string, number> : {}; } catch { return {}; }
}
function setOpeningTabs(tabs: Record<string, number>) {
  try { if (Object.keys(tabs).length) localStorage.setItem(OPENING_TABS, JSON.stringify(tabs)); else localStorage.removeItem(OPENING_TABS); } catch { /* storage blocked */ }
}
export function startInSafeMode(): boolean {
  if (/[?&]safe\b/.test(location.search)) return true;
  const now = Date.now();
  let safe = false;
  try {
    const t = Number(sessionStorage.getItem(OPENING));
    safe = t > 0 && now - t < MARK_LIFE;
  } catch { /* storage blocked */ }
  // Another tab's opening that never finished: once, and only for a recent one.
  const tabs = openingTabs();
  for (const [tab, t] of Object.entries(tabs)) {
    const age = now - Number(t);
    if (!(age >= 0 && age < MARK_LIFE)) delete tabs[tab];
    else if (age > 30_000) { safe = true; delete tabs[tab]; }
  }
  setOpeningTabs(tabs);
  return safe;
}
export function markOpening(on: boolean) {
  try { if (on) sessionStorage.setItem(OPENING, String(Date.now())); else sessionStorage.removeItem(OPENING); } catch { /* storage blocked */ }
  const tabs = openingTabs();
  if (on) tabs[TAB] = Date.now(); else delete tabs[TAB];
  setOpeningTabs(tabs);
}
// A page closed or reloaded normally was not frozen (a frozen page runs no handlers).
if (typeof window !== 'undefined') window.addEventListener('pagehide', () => markOpening(false));

const RECOVERED_KEY = 'autosave-recovered';
/** Safe mode keeps the book that would not open under its own key too, so nothing overwrites it. */
export async function keepRecoveredAutosave(raw: unknown): Promise<boolean> {
  try { await idbSet('projects', RECOVERED_KEY, raw); return true; } catch { return false; }
}
/** The book safe mode kept, if any (File › Open the book safe mode kept). */
export async function recoveredAutosave(): Promise<unknown> {
  try { return await idbGet<unknown>('projects', RECOVERED_KEY); } catch { return null; }
}

export async function loadAutosave(): Promise<Project | null> {
  try {
    const raw = await idbGet<unknown>('projects', AUTOSAVE_KEY);
    if (!raw) return null;
    const repairs = { count: 0 };
    const p = normalizeProject(raw, repairs);
    if (repairs.count) tellRepairs(repairs.count);
    return p;
  } catch {
    return null;
  }
}

function tellRepairs(n: number) {
  useStore.getState().notify(`Repaired ${n} problem${n === 1 ? '' : 's'} in this project.`);
}

export function startAutosave() {
  let last = useStore.getState().project;
  useStore.subscribe((s) => {
    if (s.project === last) return;
    last = s.project;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { void idbSet('projects', AUTOSAVE_KEY, last).catch(autosaveFailed); }, 700);
  });
}

/** Autosave failures are told once per kind (storage full, unstorable data, …), not on every save. */
const autosaveWarned = new Set<string>();
function autosaveFailed(err: unknown) {
  const kind = (err as Error | undefined)?.name || 'Error';
  if (autosaveWarned.has(kind)) return;
  autosaveWarned.add(kind);
  console.warn('Book Design Studio autosave failed:', err);
  const why = kind === 'QuotaExceededError' ? 'this browser’s storage is full'
    : kind === 'DataCloneError' ? 'part of the project could not be stored'
    : (err as Error | undefined)?.message || 'the browser refused to store it';
  useStore.getState().notify(`Autosave failed (${why}). Save a project file (File › Save project file) to keep your work.`, 'error');
}

export const getState = () => useStore.getState();

/**
 * Font registry & shaping.
 *
 * One shaping engine (fontkit) measures every word, using exactly the same font files the
 * browser renders with. That keeps the editor (SVG text), the canvas back-end (glyph outlines)
 * and the PDF writer (embedded or outlined glyphs) in agreement down to the glyph.
 *
 * Built-in families are OFL fonts shipped in /public/fonts and loaded lazily on first use.
 * Uploaded fonts (OTF/TTF/WOFF/WOFF2, static or variable) are normalised to SFNT bytes.
 */
import fontkit from '@pdf-lib/fontkit';
import type { Font as FkFont, TypeFeatures } from '@pdf-lib/fontkit';
import { create } from 'zustand';
import type { FontRef } from '../render/primitives';
import { idbGet, idbSet } from '../lib/idb';

/* -------------------------------------------------------------------------- */
/* Types                                                                       */
/* -------------------------------------------------------------------------- */

export interface AxisInfo { tag: string; name: string; min: number; default: number; max: number }

export interface FontMetrics {
  unitsPerEm: number;
  /** As fractions of the em. */
  ascender: number;
  descender: number; // negative
  capHeight: number;
  xHeight: number;
  lineGap: number;
}

export interface FaceDef {
  key: string;
  file?: string;          // built-in: path under /fonts
  weight: number | [number, number];
  italic: boolean;
}

export interface FamilyDef {
  id: string;
  name: string;
  /** CSS family name registered with document.fonts. */
  css: string;
  fallback: string;
  category: 'serif' | 'sans' | 'mono' | 'display' | 'blackletter' | 'cjk';
  /** Vox-ATypI / Caflisch classification. */
  classification: string;
  note: string;
  faces: FaceDef[];
  builtin: boolean;
  /** System font: rendered by the browser, no bytes for shaping/outlining. */
  system?: boolean;
}

interface FontkitFont extends FkFont {
  variationAxes?: Record<string, { name: string; min: number; default: number; max: number }>;
  namedVariations?: Record<string, Record<string, number>>;
  getVariation?: (settings: Record<string, number>) => FontkitFont;
}

export interface FaceState {
  def: FaceDef;
  family: string;
  status: 'idle' | 'loading' | 'ready' | 'error';
  bytes: Uint8Array | null;
  fk: FontkitFont | null;
  axes: AxisInfo[];
  features: string[];
  named: Record<string, Record<string, number>>;
  metrics: FontMetrics;
  error?: string;
}

/* -------------------------------------------------------------------------- */
/* Built-in catalogue                                                          */
/* -------------------------------------------------------------------------- */

const SERIF_FALLBACK = ', "Iowan Old Style", Georgia, serif';
const SANS_FALLBACK = ', "Helvetica Neue", Arial, sans-serif';

export const BUILTIN_FAMILIES: FamilyDef[] = [
  {
    id: 'eb-garamond', name: 'EB Garamond', css: 'BDS EB Garamond', fallback: SERIF_FALLBACK,
    category: 'serif', classification: 'Garalde (Humanist old-style)', builtin: true,
    note: 'After Claude Garamont’s 16th-c. romans and Granjon’s italics — true small caps, old-style figures, swashes. The Bringhurst/Tschichold text face.',
    faces: [
      { key: 'eb-garamond-r', file: 'EBGaramond-VF.ttf', weight: [400, 800], italic: false },
      { key: 'eb-garamond-i', file: 'EBGaramond-Italic-VF.ttf', weight: [400, 800], italic: true },
    ],
  },
  {
    id: 'fraunces', name: 'Fraunces', css: 'BDS Fraunces', fallback: SERIF_FALLBACK,
    category: 'serif', classification: 'Soft old-style display (Wonky)', builtin: true,
    note: 'Variable optical size 9–144, weight, SOFT and WONK axes — ideal for exploring `fvar` axes and optical sizing.',
    faces: [
      { key: 'fraunces-r', file: 'Fraunces-VF.ttf', weight: [100, 900], italic: false },
      { key: 'fraunces-i', file: 'Fraunces-Italic-VF.ttf', weight: [100, 900], italic: true },
    ],
  },
  {
    id: 'inter', name: 'Inter', css: 'BDS Inter', fallback: SANS_FALLBACK,
    category: 'sans', classification: 'Neo-grotesque (Swiss)', builtin: true,
    note: 'A neo-grotesque in the Swiss lineage, with optical sizes and tabular figures — the Müller-Brockmann grid face.',
    faces: [
      { key: 'inter-r', file: 'Inter-VF.ttf', weight: [100, 900], italic: false },
      { key: 'inter-i', file: 'Inter-Italic-VF.ttf', weight: [100, 900], italic: true },
    ],
  },
  {
    id: 'space-grotesk', name: 'Space Grotesk', css: 'BDS Space Grotesk', fallback: SANS_FALLBACK,
    category: 'sans', classification: 'Geometric grotesque', builtin: true,
    note: 'Constructed, slightly mechanical forms — at home in Crouwel-style systematic layouts.',
    faces: [{ key: 'space-grotesk-r', file: 'SpaceGrotesk-VF.ttf', weight: [300, 700], italic: false }],
  },
  {
    id: 'ibm-plex-mono', name: 'IBM Plex Mono', css: 'BDS IBM Plex Mono', fallback: ', ui-monospace, Menlo, monospace',
    category: 'mono', classification: 'Monospaced grotesque', builtin: true,
    note: 'Industrial, engineered numerals — Martens-style captions, colophons and technical specs.',
    faces: [
      { key: 'plex-mono-r', file: 'IBMPlexMono-Regular.ttf', weight: 400, italic: false },
      { key: 'plex-mono-i', file: 'IBMPlexMono-Italic.ttf', weight: 400, italic: true },
      { key: 'plex-mono-b', file: 'IBMPlexMono-Bold.ttf', weight: 700, italic: false },
    ],
  },
  {
    id: 'cinzel', name: 'Cinzel', css: 'BDS Cinzel', fallback: SERIF_FALLBACK,
    category: 'display', classification: 'Glyphic (Roman inscriptional capitals)', builtin: true,
    note: 'Capitals after first-century Roman inscriptions — versals, title pages and initials.',
    faces: [{ key: 'cinzel-r', file: 'Cinzel-VF.ttf', weight: [400, 900], italic: false }],
  },
  {
    id: 'unifraktur', name: 'UnifrakturMaguntia', css: 'BDS UnifrakturMaguntia', fallback: SERIF_FALLBACK,
    category: 'blackletter', classification: 'Blackletter (Fraktur/Textura)', builtin: true,
    note: 'Blackletter for manuscript-mode rubrics and headings, as in 15th-c. Netherlandish books of hours.',
    faces: [{ key: 'unifraktur-r', file: 'UnifrakturMaguntia.ttf', weight: 400, italic: false }],
  },
  {
    id: 'mincho', name: 'Mincho (system)', css: '"Hiragino Mincho ProN", "Yu Mincho", YuMincho, "Noto Serif JP", "Noto Serif CJK JP", "MS Mincho", serif', fallback: '',
    category: 'cjk', classification: 'Japanese Mincho (serif)', builtin: true, system: true,
    note: 'Uses the Mincho installed on this device for tategaki (vertical) setting. Upload a Japanese font for PDF outlines.',
    faces: [{ key: 'mincho-sys', weight: 400, italic: false }],
  },
  {
    id: 'gothic-jp', name: 'Gothic JP (system)', css: '"Hiragino Sans", "Hiragino Kaku Gothic ProN", "Yu Gothic", YuGothic, "Noto Sans JP", "Noto Sans CJK JP", sans-serif', fallback: '',
    category: 'cjk', classification: 'Japanese Gothic (sans)', builtin: true, system: true,
    note: 'System Japanese Gothic for captions and modern vertical layouts.',
    faces: [{ key: 'gothic-jp-sys', weight: 400, italic: false }],
  },
];

/* -------------------------------------------------------------------------- */
/* Registry state                                                              */
/* -------------------------------------------------------------------------- */

const families = new Map<string, FamilyDef>();
const faces = new Map<string, FaceState>();
const familyLoads = new Map<string, Promise<void>>();

const DEFAULT_METRICS: FontMetrics = { unitsPerEm: 1000, ascender: 0.8, descender: -0.22, capHeight: 0.68, xHeight: 0.45, lineGap: 0 };

for (const f of BUILTIN_FAMILIES) registerFamilyDef(f);

function registerFamilyDef(def: FamilyDef) {
  families.set(def.id, def);
  for (const face of def.faces) {
    if (!faces.has(face.key)) {
      faces.set(face.key, {
        def: face, family: def.id, status: def.system ? 'ready' : 'idle', bytes: null, fk: null,
        axes: [], features: [], named: {}, metrics: DEFAULT_METRICS,
      });
    }
  }
}

/** Reactive version counter: bumps whenever a face finishes loading so layouts recompute. */
export const useFontStore = create<{ version: number; loading: number; bump: () => void }>((set) => ({
  version: 0,
  loading: 0,
  bump: () => set((s) => ({ version: s.version + 1 })),
}));

export const getFamilies = () => [...families.values()];
export const getFamily = (id: string) => families.get(id) ?? families.get('eb-garamond')!;
export const getFace = (key: string | null) => (key ? faces.get(key) : undefined);
export const isFamilyReady = (id: string) => getFamily(id).faces.every((f) => faces.get(f.key)?.status === 'ready' || faces.get(f.key)?.status === 'error');

/* -------------------------------------------------------------------------- */
/* Loading                                                                     */
/* -------------------------------------------------------------------------- */

const baseUrl = () => (import.meta.env.BASE_URL || './').replace(/\/?$/, '/');

function inspect(state: FaceState, fk: FontkitFont) {
  state.fk = fk;
  const axes = fk.variationAxes ?? {};
  state.axes = Object.entries(axes).map(([tag, a]) => ({ tag, name: a.name, min: a.min, default: a.default, max: a.max }));
  state.features = [...new Set((fk.availableFeatures ?? []).map(String))].sort();
  try { state.named = fk.namedVariations ?? {}; } catch { state.named = {}; }
  const upm = fk.unitsPerEm || 1000;
  state.metrics = {
    unitsPerEm: upm,
    ascender: fk.ascent / upm,
    descender: fk.descent / upm,
    capHeight: (fk.capHeight || fk.ascent * 0.7) / upm,
    xHeight: (fk.xHeight || fk.ascent * 0.5) / upm,
    lineGap: (fk.lineGap || 0) / upm,
  };
}

async function registerWithDocument(def: FamilyDef, face: FaceDef, bytes: Uint8Array) {
  if (typeof document === 'undefined' || !('fonts' in document)) return;
  const weight = Array.isArray(face.weight) ? `${face.weight[0]} ${face.weight[1]}` : String(face.weight);
  const ff = new FontFace(def.css, bytes.slice().buffer as ArrayBuffer, { weight, style: face.italic ? 'italic' : 'normal' });
  await ff.load();
  document.fonts.add(ff);
}

async function loadFace(def: FamilyDef, state: FaceState): Promise<void> {
  if (state.status === 'ready' || state.status === 'loading' || def.system) return;
  state.status = 'loading';
  useFontStore.setState((s) => ({ loading: s.loading + 1 }));
  try {
    let bytes = state.bytes;
    if (!bytes) {
      const res = await fetch(`${baseUrl()}fonts/${state.def.file}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      bytes = new Uint8Array(await res.arrayBuffer());
      state.bytes = bytes;
    }
    inspect(state, fontkit.create(bytes) as FontkitFont);
    await registerWithDocument(def, state.def, bytes);
    state.status = 'ready';
  } catch (e) {
    state.status = 'error';
    state.error = (e as Error).message;
  } finally {
    useFontStore.setState((s) => ({ loading: s.loading - 1 }));
    shapeCache.clear();
    useFontStore.getState().bump();
  }
}

/** Load every face of a family (idempotent). */
export function ensureFamily(id: string): Promise<void> {
  const def = getFamily(id);
  if (def.system) return Promise.resolve();
  let p = familyLoads.get(def.id);
  if (!p) {
    p = Promise.all(def.faces.map((f) => loadFace(def, faces.get(f.key)!))).then(() => undefined);
    familyLoads.set(def.id, p);
  }
  return p;
}

/* -------------------------------------------------------------------------- */
/* Uploads (OTF / TTF / WOFF / WOFF2, static or variable)                      */
/* -------------------------------------------------------------------------- */

async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream('deflate');
  const out = new Response(new Blob([data.slice().buffer as ArrayBuffer]).stream().pipeThrough(ds));
  return new Uint8Array(await out.arrayBuffer());
}

/** WOFF 1.0 → SFNT: inflate each zlib-compressed table and rebuild the table directory. */
async function woff1ToSfnt(buf: Uint8Array): Promise<Uint8Array> {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const flavor = dv.getUint32(4);
  const numTables = dv.getUint16(12);
  const tables: { tag: number; checksum: number; data: Uint8Array }[] = [];
  for (let i = 0; i < numTables; i++) {
    const o = 44 + i * 20;
    const tag = dv.getUint32(o), offset = dv.getUint32(o + 4), compLen = dv.getUint32(o + 8), origLen = dv.getUint32(o + 12), checksum = dv.getUint32(o + 16);
    const raw = buf.subarray(offset, offset + compLen);
    tables.push({ tag, checksum, data: compLen < origLen ? await inflate(raw) : raw });
  }
  let size = 12 + numTables * 16;
  for (const t of tables) size += (t.data.length + 3) & ~3;
  const out = new Uint8Array(size);
  const odv = new DataView(out.buffer);
  let entrySelector = 0;
  while (1 << (entrySelector + 1) <= numTables) entrySelector++;
  const searchRange = (1 << entrySelector) * 16;
  odv.setUint32(0, flavor);
  odv.setUint16(4, numTables);
  odv.setUint16(6, searchRange);
  odv.setUint16(8, entrySelector);
  odv.setUint16(10, numTables * 16 - searchRange);
  let offset = 12 + numTables * 16;
  tables.forEach((t, i) => {
    const o = 12 + i * 16;
    odv.setUint32(o, t.tag);
    odv.setUint32(o + 4, t.checksum);
    odv.setUint32(o + 8, offset);
    odv.setUint32(o + 12, t.data.length);
    out.set(t.data, offset);
    offset += (t.data.length + 3) & ~3;
  });
  return out;
}

/** Normalise any supported web-font container to raw SFNT (TTF/OTF) bytes. */
export async function toSfnt(bytes: Uint8Array): Promise<Uint8Array> {
  const sig = String.fromCharCode(...bytes.subarray(0, 4));
  if (sig === 'wOFF') return woff1ToSfnt(bytes);
  if (sig === 'wOF2') {
    const { default: decompress } = await import('wawoff2/decompress.js');
    return new Uint8Array(await decompress(bytes));
  }
  return bytes;
}

export interface UploadResult { familyId: string; family: string; faceKey: string; weight: number; italic: boolean; variable: boolean }

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/**
 * Register uploaded font bytes. Faces sharing a family name are grouped into one family.
 * `id` is stable across sessions (bytes persist in IndexedDB under it).
 */
export async function registerUploadedFont(raw: Uint8Array, fileName: string, id?: string): Promise<UploadResult> {
  const bytes = await toSfnt(raw);
  const fk = fontkit.create(bytes) as FontkitFont;
  const familyName = fk.familyName || fileName.replace(/\.[^.]+$/, '');
  const sub = (fk.subfamilyName || 'Regular').toLowerCase();
  const italic = /italic|oblique/.test(sub) || !!fk.head?.macStyle?.italic;
  const axes = fk.variationAxes ?? {};
  const variable = Object.keys(axes).length > 0;
  const os2 = (fk as unknown as { 'OS/2'?: { usWeightClass?: number } })['OS/2'];
  const weight = variable && axes.wght ? axes.wght.default : os2?.usWeightClass ?? 400;
  const familyId = `up-${slug(familyName)}`;
  const faceKey = id ?? `${familyId}-${slug(sub)}-${Math.random().toString(36).slice(2, 7)}`;

  let def = families.get(familyId);
  if (!def) {
    def = {
      id: familyId, name: familyName, css: `BDS Up ${familyName}`, fallback: SERIF_FALLBACK,
      category: 'serif', classification: variable ? 'Uploaded variable font' : 'Uploaded font', builtin: false,
      note: `Uploaded from ${fileName}.`, faces: [],
    };
    families.set(familyId, def);
  }
  const faceDef: FaceDef = { key: faceKey, weight: variable && axes.wght ? [axes.wght.min, axes.wght.max] : weight, italic };
  if (!def.faces.some((f) => f.key === faceKey)) def.faces.push(faceDef);
  const state: FaceState = {
    def: faceDef, family: familyId, status: 'loading', bytes, fk: null, axes: [], features: [], named: {}, metrics: DEFAULT_METRICS,
  };
  faces.set(faceKey, state);
  inspect(state, fk);
  await registerWithDocument(def, faceDef, bytes);
  state.status = 'ready';
  familyLoads.set(familyId, Promise.resolve());
  shapeCache.clear();
  useFontStore.getState().bump();
  await idbSet('fonts', faceKey, { bytes, fileName }).catch(() => undefined);
  return { familyId, family: familyName, faceKey, weight, italic, variable };
}

/** Restore uploaded faces from IndexedDB (or from bytes embedded in a project file). */
export async function restoreUploadedFont(faceKey: string, embedded?: { bytes: Uint8Array; fileName: string }): Promise<UploadResult | null> {
  if (faces.has(faceKey) && faces.get(faceKey)!.status === 'ready') return null;
  const rec = embedded ?? (await idbGet<{ bytes: Uint8Array; fileName: string }>('fonts', faceKey).catch(() => undefined));
  if (!rec) return null;
  return registerUploadedFont(new Uint8Array(rec.bytes), rec.fileName, faceKey);
}

/* -------------------------------------------------------------------------- */
/* Resolution                                                                  */
/* -------------------------------------------------------------------------- */

export interface FontRequest {
  family: string;
  weight?: number;
  italic?: boolean;
  axes?: Record<string, number>;
  features?: Record<string, boolean>;
  /** Font size in pt — drives automatic optical sizing (`opsz`). */
  size?: number;
}

function faceWeightDistance(f: FaceDef, w: number) {
  if (Array.isArray(f.weight)) return w < f.weight[0] ? f.weight[0] - w : w > f.weight[1] ? w - f.weight[1] : 0;
  return Math.abs(f.weight - w);
}

/** Pick the best face and build complete variation coordinates. */
export function resolveFont(req: FontRequest): FontRef {
  const fam = getFamily(req.family);
  const weight = req.weight ?? 400;
  const italic = !!req.italic;
  const candidates = fam.faces.filter((f) => f.italic === italic);
  const pool = candidates.length ? candidates : fam.faces;
  const face = pool.reduce((best, f) => (faceWeightDistance(f, weight) < faceWeightDistance(best, weight) ? f : best), pool[0]);
  const state = faces.get(face.key);
  const axes: Record<string, number> = {};
  if (state && state.axes.length) {
    for (const a of state.axes) {
      let v = a.default;
      if (a.tag === 'wght') v = weight;
      if (a.tag === 'opsz' && req.size) v = req.size;
      if (req.axes && req.axes[a.tag] != null) v = req.axes[a.tag];
      axes[a.tag] = Math.max(a.min, Math.min(a.max, v));
    }
  } else if (Array.isArray(face.weight)) {
    // Not loaded yet: remember the requested weight so CSS is right once it arrives.
    axes.wght = weight;
  }
  return {
    family: fam.id,
    face: fam.system ? null : face.key,
    css: cssFamily(fam.id),
    weight,
    italic,
    axes,
    features: req.features ?? {},
    oblique: italic && !candidates.length,
  };
}

/** CSS font-family value for a family (handles system stacks). */
export function cssFamily(id: string): string {
  const fam = getFamily(id);
  return fam.system ? fam.css : `"${fam.css}"${fam.fallback}`;
}

export function fontFeatureCss(features: Record<string, boolean>): string {
  const parts = Object.entries(features).map(([k, v]) => `"${k}" ${v ? 1 : 0}`);
  return parts.length ? parts.join(', ') : 'normal';
}

export function fontVariationCss(axes: Record<string, number>): string {
  const parts = Object.entries(axes).map(([k, v]) => `"${k}" ${+v.toFixed(2)}`);
  return parts.length ? parts.join(', ') : 'normal';
}

export function fontMetrics(ref: FontRef): FontMetrics {
  return getFace(ref.face)?.metrics ?? DEFAULT_METRICS;
}

export function faceSupports(ref: FontRef, feature: string): boolean {
  return !!getFace(ref.face)?.features.includes(feature);
}

/* -------------------------------------------------------------------------- */
/* Shaping & measurement                                                       */
/* -------------------------------------------------------------------------- */

const variationCache = new Map<string, FontkitFont>();

const axesKey = (axes: Record<string, number>) => Object.keys(axes).sort().map((k) => `${k}${axes[k].toFixed(2)}`).join(',');

/** The fontkit instance for this exact variation (shared, cached). */
export function shaperFor(ref: FontRef): FontkitFont | null {
  const st = getFace(ref.face);
  if (!st || st.status !== 'ready' || !st.fk) return null;
  if (!st.axes.length) return st.fk;
  const isDefault = st.axes.every((a) => Math.abs((ref.axes[a.tag] ?? a.default) - a.default) < 1e-6);
  if (isDefault || !st.fk.getVariation) return st.fk;
  const key = `${ref.face}|${axesKey(ref.axes)}`;
  let v = variationCache.get(key);
  if (!v) {
    try {
      v = st.fk.getVariation(ref.axes);
    } catch {
      v = st.fk;
    }
    variationCache.set(key, v);
    if (variationCache.size > 200) variationCache.delete(variationCache.keys().next().value!);
  }
  return v;
}

export interface Shaped {
  /** Advance in em. */
  advance: number;
  /** `units`: UTF-16 code units of the text this glyph covers (ligatures cover several). */
  glyphs: { id: number; xAdvance: number; xOffset: number; yOffset: number; units: number }[];
  /** True when every code point had a glyph. */
  complete: boolean;
}

const shapeCache = new Map<string, Shaped>();
const featKey = (f: Record<string, boolean>) => Object.keys(f).sort().map((k) => (f[k] ? k : `-${k}`)).join(',');

export function shape(text: string, ref: FontRef): Shaped | null {
  const fk = shaperFor(ref);
  if (!fk) return null;
  const key = `${ref.face}|${axesKey(ref.axes)}|${featKey(ref.features)}|${text}`;
  const hit = shapeCache.get(key);
  if (hit) return hit;
  const upm = fk.unitsPerEm;
  let complete = true;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp > 32 && !fk.hasGlyphForCodePoint(cp)) { complete = false; break; }
  }
  // fontkit writes every feature it plans (frac, numr, dnom …) back into the object it is
  // given; pass a copy so the FontRef — and the CSS generated from it — stays clean.
  const run = fk.layout(text, { ...ref.features } as TypeFeatures);
  const glyphs = run.glyphs.map((g, i) => ({
    id: g.id,
    xAdvance: run.positions[i].xAdvance / upm,
    xOffset: run.positions[i].xOffset / upm,
    yOffset: run.positions[i].yOffset / upm,
    units: (g.codePoints ?? []).reduce((n: number, cp: number) => n + (cp > 0xffff ? 2 : 1), 0),
  }));
  const shaped: Shaped = { advance: glyphs.reduce((s, g) => s + g.xAdvance, 0), glyphs, complete };
  shapeCache.set(key, shaped);
  if (shapeCache.size > 60000) shapeCache.clear();
  return shaped;
}

let measureCtx: CanvasRenderingContext2D | null = null;

/** Browser fallback measurement for system fonts or uncovered scripts. */
function measureWithCanvas(text: string, ref: FontRef, size: number): number {
  if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
  if (!measureCtx) return text.length * size * 0.5;
  measureCtx.font = `${ref.italic ? 'italic ' : ''}${ref.weight} ${size * 10}px ${ref.css}`;
  return measureCtx.measureText(text).width / 10;
}

/** Advance width in pt (letter-spacing excluded). */
export function measure(text: string, ref: FontRef, size: number): number {
  if (!text) return 0;
  const s = shape(text, ref);
  if (s && s.complete) return s.advance * size;
  return measureWithCanvas(text, ref, size);
}

/** True when the canvas/PDF back-ends can draw this run from real glyph outlines. */
export function canOutline(text: string, ref: FontRef): boolean {
  const s = shape(text, ref);
  return !!s && s.complete;
}

/** Glyph outline path data (SVG syntax, font units, y up) for a glyph id in a variation. */
const glyphPathCache = new Map<string, string>();
export function glyphPath(ref: FontRef, glyphId: number): { d: string; upm: number } | null {
  const fk = shaperFor(ref);
  if (!fk) return null;
  const key = `${ref.face}|${axesKey(ref.axes)}|${glyphId}`;
  let d = glyphPathCache.get(key);
  if (d == null) {
    try {
      d = fk.getGlyph(glyphId).path.toSVG();
    } catch {
      d = '';
    }
    glyphPathCache.set(key, d);
    if (glyphPathCache.size > 20000) glyphPathCache.clear();
  }
  return { d, upm: fk.unitsPerEm };
}

/**
 * Extra advance after each glyph, pt, from a run's per-character kerning (`kern[i]` follows the
 * UTF-16 unit `i`). A ligature takes the kerning of every character it covers.
 */
export function glyphKerns(shaped: Shaped, kern: number[] | undefined): number[] | null {
  if (!kern || !kern.some((k) => k)) return null;
  let u = 0;
  return shaped.glyphs.map((g) => {
    let k = 0;
    for (let j = 0; j < Math.max(1, g.units); j++) k += kern[u + j] ?? 0;
    u += Math.max(1, g.units);
    return k;
  });
}

/* -------------------------------------------------------------------------- */
/* Optical kerning                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Optical kerning measures the white between two glyph outlines instead of trusting the kern
 * table: each glyph is cut into horizontal bands and the gap is averaged band by band, with
 * deep openings (the arm of a T, the bowl of an L) counted only up to a limit. The pair is then
 * moved toward the gap of two straight stems of the same case (nn / HH), so the colour of the
 * line is even: the eye judges letter spacing by area, not by distance.
 */
const BANDS = 14;
interface Profile { left: (number | null)[]; right: (number | null)[] }
const profileCache = new Map<string, Profile | null>();
const pairCache = new Map<string, number>();

function glyphProfile(ref: FontRef, glyphId: number, zone: number): Profile | null {
  const fk = shaperFor(ref);
  if (!fk) return null;
  const key = `${ref.face}|${axesKey(ref.axes)}|${glyphId}|${zone.toFixed(3)}`;
  if (profileCache.has(key)) return profileCache.get(key)!;
  let prof: Profile | null = null;
  try {
    const upm = fk.unitsPerEm;
    const cmds = (fk.getGlyph(glyphId).path as unknown as { commands: { command: string; args: number[] }[] }).commands;
    const left: (number | null)[] = Array(BANDS).fill(null);
    const right: (number | null)[] = Array(BANDS).fill(null);
    const top = zone * upm;
    const add = (x: number, y: number) => {
      if (y < 0 || y > top) return;
      const b = Math.min(BANDS - 1, Math.floor((y / top) * BANDS));
      const xe = x / upm;
      if (left[b] == null || xe < left[b]!) left[b] = xe;
      if (right[b] == null || xe > right[b]!) right[b] = xe;
    };
    let cx = 0, cy = 0, sx = 0, sy = 0;
    const line = (x1: number, y1: number) => {
      const n = Math.max(1, Math.ceil(Math.hypot(x1 - cx, y1 - cy) / (upm / 120)));
      for (let i = 1; i <= n; i++) add(cx + ((x1 - cx) * i) / n, cy + ((y1 - cy) * i) / n);
      cx = x1; cy = y1;
    };
    for (const c of cmds) {
      const a = c.args;
      if (c.command === 'moveTo') { cx = sx = a[0]; cy = sy = a[1]; add(cx, cy); }
      else if (c.command === 'lineTo') line(a[0], a[1]);
      else if (c.command === 'quadraticCurveTo') {
        const x0 = cx, y0 = cy;
        for (let i = 1; i <= 10; i++) { const t = i / 10, u = 1 - t; line(u * u * x0 + 2 * u * t * a[0] + t * t * a[2], u * u * y0 + 2 * u * t * a[1] + t * t * a[3]); }
      } else if (c.command === 'bezierCurveTo') {
        const x0 = cx, y0 = cy;
        for (let i = 1; i <= 12; i++) {
          const t = i / 12, u = 1 - t;
          line(u * u * u * x0 + 3 * u * u * t * a[0] + 3 * u * t * t * a[2] + t * t * t * a[4], u * u * u * y0 + 3 * u * u * t * a[1] + 3 * u * t * t * a[3] + t * t * t * a[5]);
        }
      } else if (c.command === 'closePath') line(sx, sy);
    }
    prof = left.some((v) => v != null) ? { left, right } : null;
  } catch {
    prof = null;
  }
  profileCache.set(key, prof);
  if (profileCache.size > 20000) profileCache.clear();
  return prof;
}

/**
 * White between two profiles (em): the mean gap over the bands, each band counted only up to
 * `depth` beyond the pair's closest approach. Deep openings (the space under a T's arm, between
 * the diagonals of A and V) then read as open, as they do to the eye.
 */
function pairGap(L: Profile, R: Profile, advL: number, depth: number): number | null {
  const g: (number | null)[] = [];
  let min = Infinity;
  for (let b = 0; b < BANDS; b++) {
    const l = L.right[b], r = R.left[b];
    if (l == null && r == null) { g.push(null); continue; }
    if (l == null || r == null) { g.push(Infinity); continue; }
    const v = advL - l + r;
    g.push(v);
    if (v < min) min = v;
  }
  if (!Number.isFinite(min)) return null;
  let sum = 0, n = 0;
  for (const v of g) { if (v == null) continue; sum += Math.min(v, min + depth); n++; }
  return n >= BANDS / 3 ? sum / n : null;
}

const letterClass = (ch: string): 'lc' | 'uc' | null => (/\p{Ll}/u.test(ch) ? 'lc' : /[\p{Lu}\p{Lt}\p{N}]/u.test(ch) ? 'uc' : null);

/**
 * Optical kerning for a run: extra advance (em) after each UTF-16 unit, or null when nothing
 * changes. Each letter's share of white is what it has beside its own twin (as the type designer
 * spaced it); a pair is moved until its white equals the sum of the two shares.
 */
export function opticalKerning(text: string, ref: FontRef): number[] | null {
  const shaped = shape(text, ref);
  if (!shaped || !shaped.complete || shaped.glyphs.length < 2) return null;
  const m = fontMetrics(ref);
  const xH = m.xHeight || 0.45, capH = m.capHeight || 0.68;
  const depth = 0.15 * xH;
  const starts: number[] = [];
  let u = 0;
  for (const g of shaped.glyphs) { starts.push(u); u += Math.max(1, g.units); }
  const out = new Array<number>(text.length).fill(0);
  let any = false;
  const self = (id: number, adv: number, zone: number) => {
    const p = glyphProfile(ref, id, zone);
    return p ? pairGap(p, p, adv, depth) : null;
  };
  for (let i = 0; i + 1 < shaped.glyphs.length; i++) {
    const gl = shaped.glyphs[i], gr = shaped.glyphs[i + 1];
    const cl = letterClass(text[starts[i]] ?? ''), cr = letterClass(text[starts[i + 1]] ?? '');
    if (!cl || !cr) continue;
    const zone = cl === 'lc' || cr === 'lc' ? xH : capH;
    const key = `${ref.face}|${axesKey(ref.axes)}|${featKey(ref.features)}|${gl.id}|${gr.id}|${cl}${cr}`;
    let k = pairCache.get(key);
    if (k == null) {
      k = 0;
      const pl = glyphProfile(ref, gl.id, zone), pr = glyphProfile(ref, gr.id, zone);
      const gap = pl && pr ? pairGap(pl, pr, gl.xAdvance, depth) : null;
      const sl = self(gl.id, gl.xAdvance, cl === 'lc' ? xH : capH), sr = self(gr.id, gr.xAdvance, cr === 'lc' ? xH : capH);
      if (gap != null && sl != null && sr != null) {
        // Gentle, with a dead band: small differences between well-spaced letters are left alone.
        const d = ((sl + sr) / 2 - gap) * 0.6;
        k = Math.max(-0.12, Math.min(0.05, Math.sign(d) * Math.max(0, Math.abs(d) - 0.025)));
        k = Math.round(k * 500) / 500;
      }
      pairCache.set(key, k);
      if (pairCache.size > 50000) pairCache.clear();
    }
    if (k) {
      out[starts[i] + Math.max(1, gl.units) - 1] = k;
      any = true;
    }
  }
  return any ? out : null;
}

/** Bytes of a face (for PDF embedding / project export). */
export const faceBytes = (key: string | null) => getFace(key)?.bytes ?? null;

/** All uploaded faces (for project export). */
export function uploadedFaces(): { key: string; state: FaceState }[] {
  return [...faces.entries()].filter(([, s]) => s.family.startsWith('up-') && s.bytes).map(([key, state]) => ({ key, state }));
}

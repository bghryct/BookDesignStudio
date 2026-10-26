/**
 * Rasterise the cover, finish masks and interior pages for the 3D book (canvas back-end, so
 * text is drawn from the same glyph outlines as the PDF).
 *
 * Display lists are compiled and lowered on the main thread (short steps) and drawn by raster
 * workers (rasterPool.ts), which also bake the cover finishes; where workers or OffscreenCanvas
 * are missing (or a worker fails), the main-thread canvas back-end draws instead.
 */
import type { Element, Finish, Project } from '../model/types';
import { jacketSpec, type BindingCalc, type JacketCalc } from '../engine/binding';
import { useFontStore } from '../engine/fonts';
import type { BookTextures, FinishKey, PageInfo, PanelArt, PanelMaps, TextureDemand } from '../three';
import { finishParams, heightBlurRadius, JACKET_FINISH, type FinishParams } from '../three/finishing';
import { WRAP_REGIONS, regionExtent, type WrapRegion } from '../three/regions';
import { compileCover, compileJacket, compilePage, elementMatrix } from './compile';
import { lowerPrims, preloadImages, renderToCanvas } from './canvasBackend';
import { applyMatrix, type Prim } from './primitives';
import { abortError, isAbort, rasterPool, type RasterJobOptions } from './rasterPool';
import type { WireList } from './rasterOps';

const FINISHES: FinishKey[] = ['gold-foil', 'silver-foil', 'copper-foil', 'holo-foil', 'blind-deboss', 'spot-gloss'];

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

type Box = { x: number; y: number; w: number; h: number };
export type Art = HTMLCanvasElement | ImageBitmap;

function toMask<T extends HTMLCanvasElement>(c: T): T {
  const ctx = c.getContext('2d')!;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = 'source-in';
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.globalCompositeOperation = 'source-over';
  return c;
}

const isBitmap = (a: unknown): a is ImageBitmap => typeof ImageBitmap !== 'undefined' && a instanceof ImageBitmap;
/** Free a worker result nobody will use. */
export function closeArt(a: unknown): void {
  if (isBitmap(a)) a.close();
}
function closePanel(p: PanelArt | null): void {
  if (p?.maps) for (const b of [p.maps.color, p.maps.surface, p.maps.bump, p.maps.holo]) closeArt(b);
}

/**
 * Compiled display lists per project (and font / image version): the refiner re-rasterises the
 * same pages at other sizes, and compiling (text layout) is the main thread's share of the work.
 */
const compiled = new WeakMap<Project, { v: number; lists: Map<string, Prim[]> }>();
function compileCached(project: Project, key: string, make: () => Prim[]): Prim[] {
  const v = useFontStore.getState().version;
  let c = compiled.get(project);
  if (!c || c.v !== v) {
    c = { v, lists: new Map() };
    compiled.set(project, c);
  }
  let l = c.lists.get(key);
  if (!l) {
    l = make();
    c.lists.set(key, l);
  }
  return l;
}

/** Main-thread budget (ms) for one procedural raster primitive while the live view sharpens. */
const LIVE_RASTER_MS = 30;

export interface ArtOptions extends RasterJobOptions {
  /** Draw on the main thread (no raster workers). */
  main?: boolean;
  /** For the live view: procedural raster primitives may be drawn coarser to keep frames flowing. */
  live?: boolean;
  /** Finish mask: white with the art's alpha. */
  mask?: boolean;
}

/** Display list → pixels covering `box`: in a raster worker when possible, else on the main thread. */
async function rasterise(prims: Prim[], box: Box, pxPerPt: number, o: ArtOptions = {}): Promise<Art> {
  const pool = o.main ? null : rasterPool();
  if (pool) {
    try {
      const list = await lowerPrims(prims, box, pxPerPt, { hideDieLines: true, rasterBudgetMs: o.live ? LIVE_RASTER_MS : undefined });
      if (o.signal?.aborted) throw abortError();
      return await pool.surface(list, o);
    } catch (e) {
      if (isAbort(e)) throw e;
      console.warn('3D textures: raster worker failed, drawing on the main thread.', e);
    }
  }
  await preloadImages(prims);
  if (o.signal?.aborted) throw abortError();
  const c = renderToCanvas(prims, box, pxPerPt, { hideDieLines: true });
  return o.mask ? toMask(c) : c;
}

export interface TextureOptions {
  coverMaxPx?: number;
  pageMaxPx?: number;
  pageLimit?: number;
  /** Polled between steps (the result is dropped when set). */
  signal?: { cancelled: boolean };
  /** Cancels the raster jobs too. */
  abort?: AbortSignal;
  jacket?: JacketCalc | null;
  /** Draw on the main thread (no raster workers). */
  main?: boolean;
}

/** A printed wrapper (cover or jacket): its art, finish masks, covering colour and finish. */
interface Wrapper {
  art: Prim[];
  masks: [FinishKey, () => Prim[]][];
  base: string;
  fp: FinishParams;
  /** What the finished maps were baked for (TextureCache checks it). */
  key: string;
}

function usedFinishes(elements: Element[]): FinishKey[] {
  const used = new Set(elements.map((e) => e.finish).filter((f): f is Finish => !!f && f !== 'none'));
  return FINISHES.filter((f) => used.has(f));
}

function coverWrapper(project: Project, calc: BindingCalc): Wrapper {
  const { finish, material } = project.book.cover;
  return {
    art: compileCached(project, 'cover', () => compileCover(project, calc)),
    masks: usedFinishes(project.cover.elements).map((f) => [f, () => compileCached(project, `cover:${f}`, () => compileCover(project, calc, { background: null, finishFilter: (el: Element) => el.finish === f }))]),
    base: material,
    fp: finishParams(finish),
    key: `${finish}|${material}`,
  };
}

function jacketWrapper(project: Project, jc: JacketCalc): Wrapper {
  const js = jacketSpec(project.book);
  const paper = js.paperColor || '#f4f0e8';
  return {
    art: compileCached(project, 'jacket', () => compileJacket(project, jc)),
    masks: usedFinishes(project.jacket?.elements ?? []).map((f) => [f, () => compileCached(project, `jacket:${f}`, () => compileJacket(project, jc, { background: null, finishFilter: (el: Element) => el.finish === f }))]),
    base: paper,
    fp: finishParams(JACKET_FINISH[js.finish] ?? 'matte'),
    key: `${js.finish}|${paper}`,
  };
}

/**
 * The wrapper's art over `box`, finished in a raster worker (colour, surface, height, iridescence
 * maps), at `pxPerPt` capped like composeSurface caps its working size. null: no workers here.
 */
async function finishedMaps(w: Wrapper, box: Box, pxPerPt: number, o: ArtOptions & { maxPx?: number; maxPixels?: number }): Promise<PanelMaps | null> {
  const pool = o.main ? null : rasterPool();
  if (!pool) return null;
  try {
    const w0 = box.w * pxPerPt, h0 = box.h * pxPerPt;
    const ppp = pxPerPt * Math.min(1, (o.maxPx ?? 8192) / Math.max(w0, h0), Math.sqrt((o.maxPixels ?? 80e6) / (w0 * h0)));
    const lo = { hideDieLines: true, rasterBudgetMs: o.live ? LIVE_RASTER_MS : undefined };
    const art = await lowerPrims(w.art, box, ppp, lo);
    const masks: { key: FinishKey; list: WireList }[] = [];
    for (const [key, make] of w.masks) {
      await tick();
      if (o.signal?.aborted) throw abortError();
      masks.push({ key, list: await lowerPrims(make(), box, ppp, lo) });
    }
    if (o.signal?.aborted) throw abortError();
    // A big panel with finishes is split into bands, one per worker, then joined.
    const W = art.w, H = art.h;
    const n = masks.length && pool.size > 1 && W * H > 6e6 ? Math.min(pool.size, Math.ceil((W * H) / 3e6)) : 1;
    if (n === 1) return await pool.panel({ art, masks, base: w.base, fp: w.fp }, o);
    const pad = 2 * heightBlurRadius(art.m[0]) + 2;
    const half = W * H > HALF_MAPS_PX;
    // Band starts on even rows, so half-size maps join exactly.
    const rows = Array.from({ length: n }, (_, i) => 2 * Math.round((H * i) / n / 2));
    const parts = await settleAll(rows.map((y0, i) => {
      const y1 = rows[i + 1] ?? H, a = Math.max(0, y0 - pad), b = Math.min(H, y1 + pad);
      const band = (l: WireList): WireList => ({ ...l, h: b - a, m: [l.m[0], l.m[1], l.m[2], l.m[3], l.m[4], l.m[5] - a] });
      return pool.panel({
        art: band(art), masks: masks.map((m) => ({ key: m.key, list: band(m.list) })), base: w.base, fp: w.fp,
        band: { row0: a, top: y0 - a, rows: y1 - y0, half },
      }, o);
    }));
    return await pool.stitch({ parts, rows, w: W, h: H, half }, o);
  } catch (e) {
    if (isAbort(e)) throw e;
    console.warn('3D textures: raster worker failed, drawing on the main thread.', e);
    return null;
  }
}

/** Art + finish-mask canvases for the main thread to composite (no workers). */
async function wrapperCanvases(w: Wrapper, box: Box, pxPerPt: number, o: ArtOptions): Promise<{ art: Art; masks: Partial<Record<FinishKey, Art>> }> {
  const art = await rasterise(w.art, box, pxPerPt, { ...o, main: true });
  const masks: Partial<Record<FinishKey, Art>> = {};
  for (const [key, make] of w.masks) {
    await tick();
    masks[key] = await rasterise(make(), box, pxPerPt, { ...o, main: true, mask: true });
  }
  return { art, masks };
}

function hasRasterPrims(prims: Prim[]): boolean {
  return prims.some((p) => p.t === 'raster' || (p.t === 'group' && hasRasterPrims(p.children)));
}

/** Above this many pixels, a finished panel's surface / height / iridescence maps are half size
 *  (as the raster worker decides for a whole panel). */
const HALF_MAPS_PX = 16e6;

/** All of the promises' values; if one fails, the others' bitmaps are freed and it rethrows. */
async function settleAll<T>(ps: Promise<T>[]): Promise<T[]> {
  const rs = await Promise.allSettled(ps);
  const bad = rs.find((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (!bad) return rs.map((r) => (r as PromiseFulfilledResult<T>).value);
  for (const r of rs) if (r.status === 'fulfilled') closeAll(r.value);
  throw bad.reason;
}

/** Close every ImageBitmap in a value (results nobody will use). */
function closeAll(v: unknown, depth = 0): void {
  if (isBitmap(v)) v.close();
  else if (v && typeof v === 'object' && depth < 3) for (const x of Object.values(v)) closeAll(x, depth + 1);
}

export async function buildBookTextures(project: Project, calc: BindingCalc, o: TextureOptions = {}): Promise<BookTextures | null> {
  const cancelled = () => !!o.signal?.cancelled || !!o.abort?.aborted;
  // Every surface is submitted first (short main-thread steps), then awaited together.
  const all: Promise<unknown>[] = [];
  const submit = <T,>(p: Promise<T>) => {
    all.push(p);
    return p;
  };
  const bail = async () => {
    for (const r of await Promise.allSettled(all)) if (r.status === 'fulfilled') closeAll(r.value);
    return null;
  };
  const ro: ArtOptions = { signal: o.abort, priority: 100, main: o.main };
  // Cover and jacket: finished maps from a worker (as composeSurface would make them, so at
  // most 4096 px / 16 MP), or art + masks for the main thread.
  const wrapper = (w: Wrapper, box: Box, ppp: number) => submit((async () => {
    const maps = await finishedMaps(w, box, ppp, { ...ro, maxPx: 4096, maxPixels: 16e6 });
    return maps ? { maps, key: w.key } : await wrapperCanvases(w, box, ppp, ro);
  })());

  const wrap = calc.wrap;
  const coverBox = { x: -wrap, y: -wrap, w: calc.coverW + 2 * wrap, h: calc.coverH + 2 * wrap };
  const coverPxPerPt = Math.min(4, (o.coverMaxPx ?? 2400) / coverBox.w);
  const coverP = wrapper(coverWrapper(project, calc), coverBox, coverPxPerPt);

  const W = project.book.trimW, H = project.book.trimH;
  const pagePxPerPt = Math.min(3, (o.pageMaxPx ?? 1100) / Math.max(W, H));
  const limit = Math.min(project.pages.length, o.pageLimit ?? 26);
  const pageP: Promise<Art>[] = [];
  for (let i = 0; i < limit; i++) {
    await tick();
    if (cancelled()) return bail();
    const prims = compileCached(project, `page:${i}`, () => compilePage(project, i, { dieLines: false }));
    pageP.push(submit(rasterise(prims, { x: 0, y: 0, w: W, h: H }, pagePxPerPt, ro)));
  }
  // Dust jacket, same conventions as the cover (origin at −bleed, −bleed).
  let jacketP: ReturnType<typeof wrapper> | null = null;
  let jacketPxPerPt = 1;
  if (o.jacket) {
    const jc = o.jacket;
    const box = { x: -jc.bleed, y: -jc.bleed, w: jc.width + 2 * jc.bleed, h: jc.height + 2 * jc.bleed };
    jacketPxPerPt = Math.min(4, (o.coverMaxPx ?? 2400) / box.w);
    await tick();
    jacketP = wrapper(jacketWrapper(project, jc), box, jacketPxPerPt);
  }
  try {
    await Promise.all(all);
  } catch (e) {
    await bail();
    if (isAbort(e)) return null;
    throw e;
  }
  if (cancelled()) return bail();
  const cover = await coverP;
  const jacket = jacketP ? await jacketP : null;
  return {
    cover: 'art' in cover ? cover.art : null, coverPxPerPt, finishMasks: 'masks' in cover ? cover.masks : {},
    coverMaps: 'maps' in cover ? cover.maps : null, coverMapsKey: 'key' in cover ? cover.key : undefined,
    pages: await Promise.all(pageP), pagePxPerPt,
    jacket: jacket && 'art' in jacket ? jacket.art : null, jacketPxPerPt, jacketFinishMasks: jacket && 'masks' in jacket ? jacket.masks : {},
    jacketMaps: jacket && 'maps' in jacket ? jacket.maps : null, jacketMapsKey: jacket && 'key' in jacket ? jacket.key : undefined,
  };
}

/** Free the worker bitmaps of textures the scene no longer shows (after it was given new ones). */
export function releaseBookTextures(tex: BookTextures | null): void {
  if (tex) closeAll([tex.cover, tex.jacket, tex.finishMasks, tex.jacketFinishMasks, tex.coverMaps, tex.jacketMaps, tex.pages]);
}

/** Per-page material + die-cut windows (both faces of a leaf share its holes). */
export function pageInfos(project: Project): PageInfo[] {
  const W = project.book.trimW;
  const holes = (i: number, mirror: boolean) => (project.pages[i]?.elements ?? []).filter((e) => e.type === 'cutout' && !e.hidden).map((e) => {
    const m = elementMatrix(e);
    const pts = [[0, 0], [e.w, 0], [e.w, e.h], [0, e.h]].map(([x, y]) => applyMatrix(m, x, y));
    const x0 = Math.min(...pts.map((p) => p[0])), x1 = Math.max(...pts.map((p) => p[0]));
    const y0 = Math.min(...pts.map((p) => p[1])), y1 = Math.max(...pts.map((p) => p[1]));
    const shape: 'rect' | 'ellipse' = e.type === 'cutout' && e.shape === 'ellipse' ? 'ellipse' : 'rect';
    return { x: mirror ? W - x1 : x0, y: y0, w: x1 - x0, h: y1 - y0, shape };
  });
  return project.pages.map((p, i) => {
    const partner = i % 2 === 0 ? i + 1 : i - 1;
    return {
      material: p.material,
      paperColor: p.paperColor,
      vellumOpacity: p.vellumOpacity,
      cutouts: [...holes(i, false), ...holes(partner, true)],
    };
  });
}

/* -------------------------------------------------------------------------- */
/* Camera-driven sharpening                                                     */
/* -------------------------------------------------------------------------- */

export type TextureQuality = 'standard' | 'high' | 'ultra';

/**
 * Per quality: longest edge (px) of a sharpened page and of the front-panel art, and the pixel
 * budgets for all sharpened pages / one panel (for exports, and for the live view) — GPU memory
 * ≈ 5.3 bytes per pixel and map.
 */
const CAPS: Record<TextureQuality, { page: number; panel: number; pages: number; panel2: number; panelLive: number }> = {
  standard: { page: 2048, panel: 4096, pages: 20e6, panel2: 12e6, panelLive: 12e6 },
  high: { page: 4096, panel: 8192, pages: 44e6, panel2: 40e6, panelLive: 24e6 },
  ultra: { page: 6144, panel: 16384, pages: 96e6, panel2: 96e6, panelLive: 36e6 },
};
/** Texture pixels per screen pixel asked for (a little over 1 so mipmaps never blur type). */
const OVERSAMPLE = 1.2;
/** Seconds a sharpened surface lingers after leaving the view before it is dropped. */
const LINGER = 8;

/** Up to the next step of √2 (fewer re-renders as the camera moves). */
const quantize = (ppp: number) => Math.pow(2, Math.ceil(Math.log2(Math.max(1e-3, ppp)) * 2) / 2);

/** Page `index` rasterised at `pxPerPt`. */
export function renderPageArt(project: Project, index: number, pxPerPt: number, o: ArtOptions = {}): Promise<Art> {
  const W = project.book.trimW, H = project.book.trimH;
  const prims = compileCached(project, `page:${index}`, () => compilePage(project, index, { dieLines: false }));
  return rasterise(prims, { x: 0, y: 0, w: W, h: H }, pxPerPt, o);
}

/**
 * A region (front, back, spine, flap) of the cover (or jacket) rasterised at `pxPerPt` with its
 * finishes: finished maps from a raster worker, or the art and masks for the main thread to
 * composite. `maxPx`: the longest edge the GPU takes (the maps are also kept under 80 MP).
 */
export async function renderPanelArt(project: Project, calc: BindingCalc, jacket: JacketCalc | null, which: 'cover' | 'jacket', region: WrapRegion, pxPerPt: number, o: ArtOptions & { maxPx?: number } = {}): Promise<PanelArt | null> {
  const m = 2; // pt of the neighbouring panels, so filtering at the region's edges stays clean
  let box: Box, w: Wrapper;
  if (which === 'cover') {
    const P = regionExtent(calc.panels, region);
    if (!P) return null;
    const x0 = Math.max(-calc.wrap, P.x - m), x1 = Math.min(calc.coverW + calc.wrap, P.x + P.w + m);
    box = { x: x0, y: -m, w: x1 - x0, h: calc.coverH + 2 * m };
    w = coverWrapper(project, calc);
  } else {
    if (!jacket) return null;
    const P = regionExtent(jacket.panels, region);
    if (!P) return null;
    const x0 = Math.max(-jacket.bleed, P.x - m), x1 = Math.min(jacket.width + jacket.bleed, P.x + P.w + m);
    box = { x: x0, y: -m, w: x1 - x0, h: jacket.height + 2 * m };
    w = jacketWrapper(project, jacket);
  }
  // The working size setPanelArt's composite would use: the GPU's longest edge, 80 MP.
  const maps = await finishedMaps(w, box, pxPerPt, { ...o, maxPx: o.maxPx ?? 8192, maxPixels: 80e6 });
  if (maps) return { maps, box };
  await preloadImages(w.art);
  const canvas = renderToCanvas(w.art, box, pxPerPt, { hideDieLines: true });
  const masks: PanelArt['masks'] = {};
  for (const [key, make] of w.masks) masks[key] = toMask(renderToCanvas(make(), box, pxPerPt, { hideDieLines: true }));
  if (o.signal?.aborted) throw abortError();
  return { canvas, masks, box };
}

/** What the refiner drives (BookScene). */
export interface RefinerTarget {
  /** Takes ownership of an ImageBitmap. */
  setPageArt(index: number, art: Art | null): void;
  setPanelArt(which: 'cover' | 'jacket', region: WrapRegion, art: PanelArt | null): void;
  readonly maxTextureSize: number;
}

/** Sharpening a page (`index`) or a region of the cover / jacket wrap. */
interface Job { kind: 'page' | 'cover' | 'jacket'; index: number; region: WrapRegion; ppp: number; need: number }

const keyOf = (j: Job) => (j.kind === 'page' ? `page:${j.index}` : `${j.kind}:${j.region}`);

/** A surface being sharpened. */
interface Flight { ppp: number; live: boolean; ctrl: AbortController; done: Promise<void> }

/**
 * Keeps the book's art as sharp as the view needs: pages in view, and every region of the cover
 * and jacket (front, back, spine, flaps) are re-rasterised at the density the camera asks for, and dropped back to
 * the base art when they leave the view. The raster workers draw several surfaces at once; the
 * main thread only compiles and lowers them, in short steps between frames, and work the view no
 * longer needs is cancelled. Before a still or a video, `prepare` sharpens everything the export
 * will show, at its full size, and waits for all of it.
 */
export class TextureRefiner {
  quality: TextureQuality = 'high';
  /** While true, live updates neither sharpen nor drop anything (an export is running). */
  hold = false;
  private project: Project | null = null;
  private calc: BindingCalc | null = null;
  private jacket: JacketCalc | null = null;
  private base = { page: 0, cover: 0, jacket: 0 };
  private applied = new Map<string, { ppp: number; live: boolean; seen: number }>();
  private flights = new Map<string, Flight>();
  private gen = 0;
  private running = false;
  private next: { demand: TextureDemand; capped: boolean } | null = null;
  private wake: (() => void) | null = null;

  constructor(private readonly target: RefinerTarget) {}

  /** Surfaces in flight at once: one per raster worker (one on the main thread). */
  private get parallel(): number {
    return rasterPool()?.size ?? 1;
  }

  /** New content (or a rebuilt scene): forget every sharpened surface. */
  reset(project: Project | null, calc: BindingCalc | null, jacket: JacketCalc | null, base: BookTextures | null): void {
    this.gen++;
    for (const f of this.flights.values()) f.ctrl.abort();
    this.flights.clear();
    for (const key of this.applied.keys()) this.drop(key);
    this.applied.clear();
    this.project = project;
    this.calc = calc;
    this.jacket = jacket;
    this.base = { page: base?.pagePxPerPt ?? 0, cover: base?.coverPxPerPt ?? 0, jacket: base?.jacketPxPerPt ?? 0 };
    this.next = null;
    this.wake?.();
  }

  /** Live view: sharpen what is in view, in the background. `capped`: keep it light (animating). */
  update(demand: TextureDemand, capped = false): void {
    // Nothing to sharpen until the base art is in (it resets everything when it arrives).
    if (this.hold || !this.project || this.base.page <= 0) return;
    this.next = { demand, capped };
    this.wake?.();
    if (!this.running) void this.loop();
  }

  /** Sharpen everything `demand` needs, now (before a still or a video export), and wait for it. */
  async prepare(demand: TextureDemand): Promise<void> {
    const gen = this.gen;
    const waits: Promise<void>[] = [];
    for (const job of this.plan(demand, false, false)) {
      if (gen !== this.gen) return;
      const f = this.start(job, 1000 + job.need, false);
      if (f) waits.push(f.done);
      await tick();
    }
    await Promise.all(waits);
  }

  /** Surfaces being sharpened (for diagnostics). */
  get pending(): number {
    return this.flights.size;
  }

  dispose(): void {
    this.reset(null, null, null, null);
  }

  /** Whether a surface has procedural raster primitives (drawn coarser for the live view). */
  private hasRaster(key: string): boolean {
    const p = this.project, calc = this.calc;
    if (!p || !calc) return false;
    const [kind, idx] = key.split(':');
    if (kind === 'page') return hasRasterPrims(compileCached(p, `page:${idx}`, () => compilePage(p, Number(idx), { dieLines: false })));
    if (kind === 'cover') return hasRasterPrims(coverWrapper(p, calc).art);
    return !!this.jacket && hasRasterPrims(jacketWrapper(p, this.jacket).art);
  }

  private drop(key: string): void {
    const [kind, idx] = key.split(':');
    if (kind === 'page') this.target.setPageArt(Number(idx), null);
    else this.target.setPanelArt(kind as 'cover' | 'jacket', idx as WrapRegion, null);
  }

  /** Jobs for a demand, most needed first, within the quality's caps and memory budgets. */
  private plan(d: TextureDemand, capped: boolean, live: boolean): Job[] {
    const p = this.project, calc = this.calc;
    if (!p || !calc) return [];
    const caps = CAPS[capped ? 'standard' : this.quality];
    const maxTex = this.target.maxTextureSize || 8192;
    const W = p.book.trimW, H = p.book.trimH;
    const jobs: Job[] = [];
    // Pages: cap the edge, then scale everything down together if over the pixel budget.
    const pageCap = Math.min(caps.page, maxTex) / Math.max(W, H);
    let pages = d.pages.filter((q) => q.index < p.pages.length).map((q) => ({ index: q.index, want: Math.min(pageCap, q.pxPerPt * OVERSAMPLE) }));
    const area = pages.reduce((sum, q) => sum + W * H * q.want * q.want, 0);
    if (area > caps.pages) {
      const k = Math.sqrt(caps.pages / area);
      pages = pages.map((q) => ({ ...q, want: q.want * k }));
    }
    for (const q of pages) {
      const ppp = Math.min(pageCap, quantize(q.want));
      if (ppp > this.base.page * 1.3) jobs.push({ kind: 'page', index: q.index, region: 'front', ppp, need: q.want / Math.max(1e-6, this.base.page) });
    }
    const panel = (kind: 'cover' | 'jacket', region: WrapRegion, need: number, w: number, h: number, base: number) => {
      if (need <= 0) return;
      let want = Math.min(Math.min(caps.panel, maxTex) / Math.max(w, h), need * OVERSAMPLE);
      // The live view keeps a panel's maps smaller: uploading hundreds of MB stalls the GPU for
      // frames, and a close-up shows only part of the panel anyway. Exports take the full budget.
      const budget = live ? caps.panelLive : caps.panel2;
      if (w * h * want * want > budget) want = Math.sqrt(budget / (w * h));
      // Rounding up to the next step must not overshoot the budget (it could double it).
      const ppp = Math.min(Math.min(caps.panel, maxTex) / Math.max(w, h), quantize(want), Math.sqrt(budget / (w * h)));
      if (ppp > base * 1.3) jobs.push({ kind, index: 0, region, ppp, need: want / Math.max(1e-6, base) });
    };
    for (const region of WRAP_REGIONS) {
      const c = regionExtent(calc.panels, region);
      if (c) panel('cover', region, d.cover[region] ?? 0, c.w, calc.coverH, this.base.cover);
      const j = this.jacket ? regionExtent(this.jacket.panels, region) : null;
      if (j && this.jacket) panel('jacket', region, d.jacket[region] ?? 0, j.w, this.jacket.height, this.base.jacket);
    }
    return jobs.sort((a, b) => b.need - a.need);
  }

  /**
   * Start sharpening `job` (its main-thread share runs now, up to its first wait). Returns the
   * flight to wait on: a new one, or one already drawing at least as sharp; null when the surface
   * is already that sharp.
   */
  private start(job: Job, priority: number, live: boolean): Flight | null {
    const key = keyOf(job);
    const have = this.applied.get(key);
    if (have && have.ppp >= job.ppp * 0.99 && (live || !have.live || !this.hasRaster(key))) {
      have.seen = performance.now() / 1000;
      return null;
    }
    const cur = this.flights.get(key);
    if (cur) {
      // An export needs full-density raster primitives: a live flight may have drawn them coarser.
      if (cur.ppp >= job.ppp * 0.99 && (live || !cur.live)) return cur;
      cur.ctrl.abort();
    }
    const f: Flight = { ppp: job.ppp, live, ctrl: new AbortController(), done: Promise.resolve() };
    this.flights.set(key, f);
    f.done = this.exec(job, key, f, priority);
    return f;
  }

  private async exec(job: Job, key: string, f: Flight, priority: number): Promise<void> {
    const p = this.project, calc = this.calc, gen = this.gen;
    const live = () => gen === this.gen && !f.ctrl.signal.aborted && this.flights.get(key) === f;
    try {
      if (!p || !calc) return;
      const o = { signal: f.ctrl.signal, priority, live: f.live };
      if (job.kind === 'page') {
        const art = await renderPageArt(p, job.index, job.ppp, o);
        if (!live()) { closeArt(art); return; }
        this.target.setPageArt(job.index, art);
      } else {
        const art = await renderPanelArt(p, calc, this.jacket, job.kind, job.region, job.ppp, { ...o, maxPx: this.target.maxTextureSize });
        if (!art) return;
        if (!live()) { closePanel(art); return; }
        this.target.setPanelArt(job.kind, job.region, art);
      }
      this.applied.set(key, { ppp: job.ppp, live: f.live, seen: performance.now() / 1000 });
    } catch (e) {
      if (!isAbort(e)) console.warn(`3D textures: could not sharpen ${key}.`, e);
    } finally {
      if (this.flights.get(key) === f) this.flights.delete(key);
    }
  }

  /** Until a flight lands or a new demand (or reset) arrives. */
  private waitAny(): Promise<void> {
    return new Promise<void>((resolve) => {
      const done = () => {
        if (this.wake === done) this.wake = null;
        resolve();
      };
      this.wake = done;
      void Promise.race([...this.flights.values()].map((f) => f.done)).then(done);
    });
  }

  private async loop(): Promise<void> {
    this.running = true;
    try {
      while (this.next && !this.hold) {
        const { demand, capped } = this.next;
        this.next = null;
        const jobs = this.plan(demand, capped, true);
        const now = performance.now() / 1000;
        const wanted = new Set(jobs.map(keyOf));
        // Work for surfaces that left the view is cancelled; their sharp art lingers a while.
        for (const [key, f] of this.flights) {
          if (!wanted.has(key)) {
            f.ctrl.abort();
            this.flights.delete(key);
          }
        }
        for (const [key, a] of this.applied) {
          if (wanted.has(key)) a.seen = now;
          else if (now - a.seen > LINGER) {
            this.drop(key);
            this.applied.delete(key);
          }
        }
        // Keep every worker busy, without queueing work a newer view may not need.
        for (const job of jobs) {
          if (this.next || this.hold) break;
          while (this.flights.size >= this.parallel && !this.next && !this.hold) await this.waitAny();
          if (this.next || this.hold) break;
          if (this.start(job, job.need, true)) await new Promise((r) => setTimeout(r, 16));
        }
      }
    } finally {
      this.running = false;
    }
  }
}

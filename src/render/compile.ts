/**
 * Element → display list compiler, plus the text-layout service (threads, masters, tokens).
 * Results are memoised on element identity (immer keeps unchanged elements identical), the
 * font-load version and the page context, so editing one frame never re-lays the whole book.
 */
import type {
  Element, Project, TextElement, ShapeElement, ImageElement, PathElement, CutoutElement, DrawingElement, SurfaceKey, BookSpec,
} from '../model/types';
import type { GroupPrim, Matrix, PathPrim, Prim } from './primitives';
import { ellipsePath, multiply, rectPath, rotate, translate, polylinePath, IDENTITY, applyMatrix, invert } from './primitives';
import { layoutStory, frameSpecOf, type FrameLayout, type FrameSpec, type TokenContext, type StoryStyles, type WrapShape } from '../engine/textLayout';
import { ensureFamily, resolveFont, measure, fontMetrics, useFontStore } from '../engine/fonts';
import { textBlock, type PageSide } from '../engine/grid';
import type { GenContext } from '../engine/generators/context';
import { generatePattern, generateOrnament, generateInitial, generateOverprint, generateGradient, generateGridType, generateRule } from '../engine/generators';
import { renderStrokes } from '../engine/brushes';
import { getMotif, type MotifContext } from '../engine/motifs';
import { parseSvgCached, svgPrims, svgMarkupFromDataUrl } from './svgImport';
import { transformPath } from '../lib/pathData';
import { findElement, pageSide, facingOf, surfaceElements } from '../model/surfaces';
import { getImage } from './images';
import { mix, parseColor } from '../lib/color';
import { compileTable, tableContextKey } from './table';
import { pathTextPrims } from './pathText';

/* -------------------------------------------------------------------------- */
/* Generator context                                                           */
/* -------------------------------------------------------------------------- */

export const genContext: GenContext = {
  font: (family, weight = 400, italic = false) => {
    void ensureFamily(family);
    return resolveFont({ family, weight, italic });
  },
  measure: (text, font, size) => measure(text, font, size),
  metrics: (font) => {
    const m = fontMetrics(font);
    return { ascender: m.ascender, descender: m.descender, capHeight: m.capHeight, xHeight: m.xHeight };
  },
};

/* -------------------------------------------------------------------------- */
/* Context                                                                     */
/* -------------------------------------------------------------------------- */

export interface CompileContext {
  project: Project;
  surface: SurfaceKey;
  /** The page being rendered (also for master items, which repeat per page). */
  pageIndex: number | null;
  side: PageSide;
}

/** Running heads: the latest chapter heading at or before each page (a `# ` line, or a frame named "Chapter…"). */
const chapterCache = new WeakMap<object, string[]>();
const plainText = (s: string) => s.replace(/<\/?(?:\{[^}]*\}|[^<>]{0,40})>|\{[^}]*\}|\[[^\]]*\]\s*|[*^\\]/g, '').replace(/\s+/g, ' ').trim();
function chapterAt(project: Project, pageIndex: number | null): string {
  if (pageIndex == null) return '';
  let list = chapterCache.get(project.pages);
  if (!list) {
    list = [];
    let cur = '';
    for (const p of project.pages) {
      for (const e of p.elements) {
        if (e.type !== 'text') continue;
        if (/chapter/i.test(e.name) && !/number|no\.?$/i.test(e.name) && e.text.trim()) cur = plainText(e.text.split('\n')[0]);
        for (const line of e.text.split('\n')) if (/^#\s/.test(line)) cur = plainText(line.slice(2));
      }
      list.push(cur);
    }
    chapterCache.set(project.pages, list);
  }
  return list[Math.min(pageIndex, list.length - 1)] ?? '';
}

function tokensFor(project: Project, pageIndex: number | null): TokenContext {
  const b = project.book;
  return { page: (pageIndex ?? 0) + 1, pages: project.pages.length, title: b.title, subtitle: b.subtitle, author: b.author, publisher: b.publisher, chapter: chapterAt(project, pageIndex) };
}

function gridFor(spec: BookSpec, side: PageSide, el: Element, surface: SurfaceKey) {
  if (surface === 'cover' || spec.grid.baseline < 1) return null;
  const block = textBlock(spec, side);
  const line0 = block.y + spec.grid.baselineOffset;
  const inc = spec.grid.baseline;
  const origin = ((((line0 - el.y) % inc) + inc) % inc);
  return { origin, increment: inc };
}

/* -------------------------------------------------------------------------- */
/* Text layout service                                                         */
/* -------------------------------------------------------------------------- */

interface ChainCache { members: Element[]; book: BookSpec; styles: string; version: number; tokens: string; wraps: string; layouts: Map<string, FrameLayout> }
const chainCache = new WeakMap<Element, ChainCache>();
const singleCache = new WeakMap<Element, Map<string, FrameLayout>>();

interface ThreadIndex { prev: Map<string, string>; byId: Map<string, { el: TextElement; pageIndex: number | null; surface: SurfaceKey }> }
const threadIndexCache = new WeakMap<Project, ThreadIndex>();

function threadIndex(project: Project): ThreadIndex {
  let idx = threadIndexCache.get(project);
  if (idx) return idx;
  const prev = new Map<string, string>();
  const byId = new Map<string, { el: TextElement; pageIndex: number | null; surface: SurfaceKey }>();
  project.pages.forEach((p, pi) => {
    for (const e of p.elements) if (e.type === 'text') byId.set(e.id, { el: e, pageIndex: pi, surface: `page:${p.id}` });
  });
  for (const e of project.cover.elements) if (e.type === 'text') byId.set(e.id, { el: e, pageIndex: null, surface: 'cover' });
  for (const e of project.jacket?.elements ?? []) if (e.type === 'text') byId.set(e.id, { el: e, pageIndex: null, surface: 'jacket' });
  for (const { el } of byId.values()) if (el.flowNext && byId.has(el.flowNext)) prev.set(el.flowNext, el.id);
  idx = { prev, byId };
  threadIndexCache.set(project, idx);
  return idx;
}

/** Thread containing `id`, head first (cycle-safe). */
export function threadOf(project: Project, id: string): string[] {
  const { prev, byId } = threadIndex(project);
  let head = id;
  const seen = new Set<string>([head]);
  while (prev.has(head) && !seen.has(prev.get(head)!)) { head = prev.get(head)!; seen.add(head); }
  const chain: string[] = [];
  const seen2 = new Set<string>();
  for (let cur: string | null = head; cur && byId.has(cur) && !seen2.has(cur); cur = byId.get(cur)!.el.flowNext) {
    chain.push(cur);
    seen2.add(cur);
  }
  return chain;
}

/** The project's paragraph / character styles for the text engine, with a cache identity. */
const stylesIds = new WeakMap<object, number>();
let stylesCounter = 0;
function storyStyles(project: Project): { styles: StoryStyles | null; key: string } {
  const para = project.paragraphStyles ?? [], char = project.characterStyles ?? [], hyph = project.hyphenDictionary ?? [];
  if (!para.length && !char.length && !hyph.length) return { styles: null, key: '-' };
  const id = (o: object) => { let v = stylesIds.get(o); if (v == null) { v = ++stylesCounter; stylesIds.set(o, v); } return v; };
  for (const d of [...para, ...char]) if (d.props.fontFamily) void ensureFamily(d.props.fontFamily);
  return { styles: { para, char, hyphenation: hyph }, key: `${id(para)}/${id(char)}/${id(hyph)}` };
}

/* Text wrap: items with a wrap setting push the text of frames on the same page aside. */
function cornersBox(m: Matrix, w: number, h: number) {
  const pts = [applyMatrix(m, 0, 0), applyMatrix(m, w, 0), applyMatrix(m, 0, h), applyMatrix(m, w, h)];
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

function wrapsFor(el: TextElement, ctx: CompileContext): WrapShape[] {
  if (el.wrapIgnore) return [];
  const { project } = ctx;
  const others: { e: Element; dx: number }[] = [];
  const page = ctx.pageIndex != null && ctx.surface.startsWith('page:') ? project.pages[ctx.pageIndex] : null;
  for (const e of surfaceElements(project, ctx.surface)) others.push({ e, dx: 0 });
  if (page?.masterId) {
    const m = project.masters.find((x) => x.id === page.masterId);
    if (m) for (const e of ctx.side === 'left' ? m.left : m.right) others.push({ e, dx: 0 });
  }
  if (page && ctx.pageIndex != null) for (const c of crossovers(project, ctx.pageIndex)) others.push({ e: c.el, dx: c.dx });
  const inv = invert(elementMatrix(el));
  const out: WrapShape[] = [];
  for (const { e, dx } of others) {
    const wr = e.wrap;
    if (!wr || e.id === el.id || e.hidden) continue;
    // The item's box in the frame's own coordinates, grown by the wrap offset.
    const b = cornersBox(multiply(inv, elementMatrix(e, dx, 0)), e.w, e.h);
    const off = Math.max(0, wr.offset ?? 0);
    const x = b.x0 - off, y = b.y0 - off, w = b.x1 - b.x0 + 2 * off, h = b.y1 - b.y0 + 2 * off;
    if (x > el.w || y > el.h || x + w < 0 || y + h < 0) continue;
    const round = wr.mode === 'shape' && ((e.type === 'shape' && e.shape === 'ellipse') || (e.type === 'cutout' && e.shape === 'ellipse'));
    out.push({ x, y, w, h, shape: round ? 'ellipse' : 'rect', side: wr.side ?? 'both', jump: wr.mode === 'jump' });
  }
  return out;
}

const wrapKey = (w: WrapShape[]) => w.map((r) => `${r.x.toFixed(1)},${r.y.toFixed(1)},${r.w.toFixed(1)},${r.h.toFixed(1)},${r.shape[0]}${r.side[0]}${r.jump ? 'j' : ''}`).join(';');

/** Auto-height frames are set in a tall frame; the editor then fits the frame to `usedHeight`. */
function frameFor(el: TextElement, grid: FrameSpec['grid'], wraps: WrapShape[]): FrameSpec {
  const f = frameSpecOf(el, grid, wraps);
  return el.autoHeight ? { ...f, h: Math.max(el.h, 20000), verticalAlign: 'top' } : f;
}

export function layoutText(el: TextElement, ctx: CompileContext): FrameLayout {
  void ensureFamily(el.style.fontFamily);
  if (el.style.dropCap.enabled && el.style.dropCap.fontFamily) void ensureFamily(el.style.dropCap.fontFamily);
  const version = useFontStore.getState().version;
  const { project } = ctx;
  const ss = storyStyles(project);
  const idx = threadIndex(project);
  const threaded = idx.byId.has(el.id) && (idx.prev.has(el.id) || (el.flowNext && idx.byId.has(el.flowNext)));
  if (threaded) {
    const chain = threadOf(project, el.id).map((id) => idx.byId.get(id)!);
    const head = chain[0].el;
    const tokens = tokensFor(project, chain[0].pageIndex);
    const tokensKey = JSON.stringify(tokens);
    const wraps = chain.map((c) => wrapsFor(c.el, { project, surface: c.surface, pageIndex: c.pageIndex, side: c.pageIndex != null ? pageSide(project, c.pageIndex) : 'right' }));
    const wk = wraps.map(wrapKey).join('|');
    const cached = chainCache.get(head);
    if (cached && cached.version === version && cached.book === project.book && cached.styles === ss.key && cached.tokens === tokensKey && cached.wraps === wk &&
      cached.members.length === chain.length && cached.members.every((m, i) => m === chain[i].el)) {
      const hit = cached.layouts.get(el.id);
      if (hit) return hit;
    }
    const frames = chain.map((c, i) => frameFor(c.el, c.pageIndex != null ? gridFor(project.book, pageSide(project, c.pageIndex), c.el, c.surface) : null, wraps[i]));
    const results = layoutStory(head.text, head.style, frames, tokens, ss.styles);
    const layouts = new Map<string, FrameLayout>();
    chain.forEach((c, i) => layouts.set(c.el.id, results[i]));
    chainCache.set(head, { members: chain.map((c) => c.el), book: project.book, styles: ss.key, version, tokens: tokensKey, wraps: wk, layouts });
    return layouts.get(el.id)!;
  }
  const tokens = tokensFor(project, ctx.pageIndex);
  const grid = gridFor(project.book, ctx.side, el, ctx.surface);
  const wraps = wrapsFor(el, ctx);
  const key = `${version}|${ss.key}|${JSON.stringify(tokens)}|${grid ? `${grid.origin.toFixed(3)}/${grid.increment}` : '-'}|${wrapKey(wraps)}`;
  let m = singleCache.get(el);
  if (!m) { m = new Map(); singleCache.set(el, m); }
  const hit = m.get(key);
  if (hit) return hit;
  const [layout] = layoutStory(el.text, el.style, [frameFor(el, grid, wraps)], tokens, ss.styles);
  if (m.size > 24) m.clear();
  m.set(key, layout);
  return layout;
}

/* -------------------------------------------------------------------------- */
/* Element compilers                                                           */
/* -------------------------------------------------------------------------- */

function shapePath(el: ShapeElement): string {
  const { w, h } = el;
  switch (el.shape) {
    case 'rect': return rectPath(0, 0, w, h, el.radius);
    case 'ellipse': return ellipsePath(w / 2, h / 2, w / 2, h / 2);
    case 'triangle': return polylinePath([[w / 2, 0], [w, h], [0, h]], true);
    case 'polygon':
    case 'star': {
      const n = Math.max(3, Math.round(el.sides));
      const pts: [number, number][] = [];
      const count = el.shape === 'star' ? n * 2 : n;
      for (let i = 0; i < count; i++) {
        const a = -Math.PI / 2 + (i * 2 * Math.PI) / count;
        const r = el.shape === 'star' && i % 2 ? el.innerRatio : 1;
        pts.push([w / 2 + (Math.cos(a) * w * r) / 2, h / 2 + (Math.sin(a) * h * r) / 2]);
      }
      return polylinePath(pts, true);
    }
    case 'arc': {
      const sweep = Math.max(0.01, Math.min(0.999, el.innerRatio)) * Math.PI * 2;
      const pts: [number, number][] = [];
      for (let i = 0; i <= 64; i++) {
        const a = -Math.PI / 2 + (sweep * i) / 64;
        pts.push([w / 2 + (Math.cos(a) * w) / 2, h / 2 + (Math.sin(a) * h) / 2]);
      }
      return polylinePath(pts, false);
    }
  }
}

function compileImage(el: ImageElement, project: Project): Prim[] {
  const asset = el.assetId ? project.assets[el.assetId] : null;
  if (!asset) {
    // Classic placeholder: a light box with a diagonal cross.
    return [
      { t: 'path', d: rectPath(0, 0, el.w, el.h), fill: '#e7e1d4', stroke: '#b9b0a0', strokeWidth: 0.5 },
      { t: 'path', d: `M0 0L${el.w} ${el.h}M${el.w} 0L0 ${el.h}`, stroke: '#b9b0a0', strokeWidth: 0.5 },
    ];
  }
  const iw = asset.width || 1, ih = asset.height || 1;
  let dw = el.w, dh = el.h;
  if (el.fit !== 'fill') {
    const s = (el.fit === 'cover' ? Math.max(el.w / iw, el.h / ih) : Math.min(el.w / iw, el.h / ih)) * Math.max(0.05, el.zoom);
    dw = iw * s;
    dh = ih * s;
  }
  const x = (el.w - dw) / 2 + (el.offsetX * Math.abs(dw - el.w)) / 2;
  const y = (el.h - dh) / 2 + (el.offsetY * Math.abs(dh - el.h)) / 2;
  if (el.duotone) {
    const [dark, light] = el.duotone;
    const D = parseColor(dark), L = parseColor(light);
    return [{
      t: 'raster', key: `duo:${asset.id}:${dark}:${light}:${x.toFixed(1)}:${y.toFixed(1)}:${dw.toFixed(1)}:${dh.toFixed(1)}`, x: 0, y: 0, w: el.w, h: el.h,
      draw: (ctx, pxPerPt) => {
        const img = getImage(asset.src);
        if (!img) return;
        const W = Math.max(1, Math.round(el.w * pxPerPt)), H = Math.max(1, Math.round(el.h * pxPerPt));
        const c = document.createElement('canvas');
        c.width = W; c.height = H;
        const g = c.getContext('2d')!;
        g.drawImage(img, x * pxPerPt, y * pxPerPt, dw * pxPerPt, dh * pxPerPt);
        const data = g.getImageData(0, 0, W, H);
        const p = data.data;
        for (let i = 0; i < p.length; i += 4) {
          const l = (0.299 * p[i] + 0.587 * p[i + 1] + 0.114 * p[i + 2]) / 255;
          p[i] = D.r + (L.r - D.r) * l; p[i + 1] = D.g + (L.g - D.g) * l; p[i + 2] = D.b + (L.b - D.b) * l;
        }
        g.putImageData(data, 0, 0);
        ctx.drawImage(c, 0, 0, el.w, el.h);
      },
    }];
  }
  return [{ t: 'image', href: asset.src, assetId: asset.id, x, y, w: dw, h: dh, clip: { x: 0, y: 0, w: el.w, h: el.h }, filter: el.grayscale ? 'grayscale' : null }];
}

function compilePath(el: PathElement): Prim[] {
  const sx = el.vw ? el.w / el.vw : 1, sy = el.vh ? el.h / el.vh : 1;
  const d = sx === 1 && sy === 1 ? el.d : transformPath(el.d, [sx, 0, 0, sy, 0, 0]);
  const path: Prim = { t: 'path', d, fill: el.fill, stroke: el.stroke, strokeWidth: el.strokeWidth, dash: el.dash, cap: el.cap, join: el.join, fillRule: el.fillRule };
  if (!el.pathText) return [path];
  void ensureFamily(el.pathText.fontFamily);
  return [path, ...pathTextPrims(el, d)];
}

export function cutoutPath(el: CutoutElement): string {
  if (el.shape === 'ellipse') return ellipsePath(el.w / 2, el.h / 2, el.w / 2, el.h / 2);
  if (el.shape === 'path' && el.d) return el.d;
  return rectPath(0, 0, el.w, el.h, el.radius);
}

function compileDrawing(el: DrawingElement): Prim[] {
  if (!el.strokes.length) return [];
  return [{
    t: 'raster', key: `draw:${el.id}:${el.strokes.length}:${el.strokes[el.strokes.length - 1].id}:${el.w.toFixed(1)}x${el.h.toFixed(1)}:${el.paperGrain}`,
    x: 0, y: 0, w: el.w, h: el.h,
    draw: (ctx, pxPerPt) => renderStrokes(ctx, el.strokes, { pxPerPt, paperGrain: el.paperGrain }),
  }];
}

export function compileElementLocal(el: Element, ctx: CompileContext): Prim[] {
  switch (el.type) {
    case 'text': {
      const layout = layoutText(el, ctx);
      const out: Prim[] = [];
      if (el.fill) out.push({ t: 'path', d: rectPath(0, 0, el.w, el.h), fill: el.fill });
      out.push(...layout.prims);
      return out;
    }
    case 'image': return compileImage(el, ctx.project);
    case 'shape':
      return [{ t: 'path', d: shapePath(el), fill: el.shape === 'arc' ? null : el.fill, stroke: el.stroke, strokeWidth: el.strokeWidth, dash: el.dash, cap: el.cap, join: el.join }];
    case 'rule': return generateRule(el, genContext);
    case 'path': return compilePath(el);
    case 'svg': {
      const asset = el.assetId ? ctx.project.assets[el.assetId] : null;
      if (!asset) return [{ t: 'path', d: rectPath(0, 0, el.w, el.h), stroke: '#b9b0a0', strokeWidth: 0.5, dash: [3, 3] }];
      const parsed = parseSvgCached(asset.id, svgMarkupFromDataUrl(asset.src));
      if (parsed && parsed.paths.length) return svgPrims(parsed, el.w, el.h, el.fillOverride, el.strokeOverride);
      return [{ t: 'image', href: asset.src, x: 0, y: 0, w: el.w, h: el.h }];
    }
    case 'pattern': void ensureFamily(el.fontFamily); return generatePattern(el, genContext);
    case 'ornament': return generateOrnament(el, genContext);
    case 'initial': void ensureFamily(el.fontFamily); return generateInitial(el, genContext);
    case 'overprint': void ensureFamily(el.fontFamily); return generateOverprint(el, genContext);
    case 'gradient': return generateGradient(el, genContext);
    case 'gridtype': return generateGridType(el, genContext);
    case 'cutout': return [{ t: 'path', d: cutoutPath(el), stroke: '#e5007e', strokeWidth: 0.6, dash: [4, 2], fill: null, role: 'dieline' }];
    case 'drawing': return compileDrawing(el);
    case 'motif': {
      const def = getMotif(el.kind);
      if (!def) return [{ t: 'path', d: rectPath(0, 0, el.w, el.h), stroke: '#b9b0a0', strokeWidth: 0.5, dash: [3, 3] }];
      if (el.fontFamily) void ensureFamily(el.fontFamily);
      const mctx: MotifContext = { ...genContext, unit: ctx.project.book.unit, book: ctx.project.book };
      try {
        return def.generate(el, mctx);
      } catch {
        return [{ t: 'path', d: rectPath(0, 0, el.w, el.h), stroke: '#e5483a', strokeWidth: 0.5, dash: [3, 3] }];
      }
    }
    case 'table': return compileTable(el, ctx);
  }
}

/* -------------------------------------------------------------------------- */
/* Placement & memoisation                                                     */
/* -------------------------------------------------------------------------- */

export function elementMatrix(el: Element, offsetX = 0, offsetY = 0): Matrix {
  let m: Matrix = translate(el.x + offsetX, el.y + offsetY);
  if (el.rotation) m = multiply(m, rotate(el.rotation, el.w / 2, el.h / 2));
  if (el.flipX || el.flipY) m = multiply(m, [el.flipX ? -1 : 1, 0, 0, el.flipY ? -1 : 1, el.flipX ? el.w : 0, el.flipY ? el.h : 0]);
  return m;
}

const compiledCache = new WeakMap<Element, { key: string; prims: Prim[] }>();

const bookIds = new WeakMap<object, number>();
let bookCounter = 0;
function bookKey(book: BookSpec): number {
  let id = bookIds.get(book);
  if (id == null) { id = ++bookCounter; bookIds.set(book, id); }
  return id;
}

function contextKey(el: Element, ctx: CompileContext): string {
  const v = useFontStore.getState().version;
  if (el.type === 'motif') return `${v}|${bookKey(ctx.project.book)}`;
  if (el.type === 'table') return tableContextKey(ctx, v);
  if (el.type === 'image' || el.type === 'svg') return `${v}|${el.assetId ? (ctx.project.assets[el.assetId] ? 1 : 0) : 0}`;
  return String(v);
}

/** Local primitives for an element (memoised; text is cached by the layout service). */
export function compileElement(el: Element, ctx: CompileContext): Prim[] {
  if (el.type === 'text') return compileElementLocal(el, ctx);
  const key = contextKey(el, ctx);
  const hit = compiledCache.get(el);
  if (hit && hit.key === key) return hit.prims;
  const prims = compileElementLocal(el, ctx);
  compiledCache.set(el, { key, prims });
  return prims;
}

/** Element wrapped in its placement group. */
export function placedElement(el: Element, ctx: CompileContext, offsetX = 0, offsetY = 0): GroupPrim {
  return {
    t: 'group',
    matrix: elementMatrix(el, offsetX, offsetY),
    opacity: el.opacity,
    blend: el.blend,
    children: compileElement(el, ctx),
  };
}

/* -------------------------------------------------------------------------- */
/* Surfaces                                                                    */
/* -------------------------------------------------------------------------- */

export interface PageRenderOptions {
  paper?: boolean;
  master?: boolean;
  dieLines?: boolean;
  /** Restrict to elements with this finish (for 3D finish masks). */
  finishFilter?: (el: Element) => boolean;
}

/** Horizontal extent of an element in its surface coordinates (rotation and flips included). */
export function elementXExtent(el: Element): [number, number] {
  const m = elementMatrix(el);
  const xs = [[0, 0], [el.w, 0], [0, el.h], [el.w, el.h]].map(([x, y]) => m[0] * x + m[2] * y + m[4]);
  return [Math.min(...xs), Math.max(...xs)];
}

/** Does an item on a page of this side reach across the gutter onto the facing page? */
export function crossesGutter(el: Element, side: PageSide, W: number): boolean {
  const [x0, x1] = elementXExtent(el);
  return side === 'left' ? x1 > W + 0.01 : x0 < -0.01;
}

/** An item of the facing page (or its master) that crosses the gutter onto this page. */
export interface Crossover { el: Element; ctx: CompileContext; dx: number; above: boolean; master: boolean }

function crossing(els: Element[], ctx: CompileContext, side: PageSide, W: number, dx: number, master: boolean): Crossover[] {
  return els.filter((el) => !el.hidden && crossesGutter(el, side, W)).map((el) => ({ el, ctx, dx, above: !!el.spreadAbove, master }));
}

/**
 * Spread items: everything on the facing page that reaches across the gutter, to be drawn on this
 * page too (beneath this page's items, or above them when the item is marked so).
 */
export function crossovers(project: Project, pageIndex: number): Crossover[] {
  const f = facingOf(project, pageIndex);
  if (!f) return [];
  const fp = project.pages[f.index];
  const side = pageSide(project, f.index);
  const W = project.book.trimW;
  const ctx: CompileContext = { project, surface: `page:${fp.id}`, pageIndex: f.index, side };
  const m = fp.masterId ? project.masters.find((x) => x.id === fp.masterId) : null;
  return [
    ...(m ? crossing(side === 'left' ? m.left : m.right, { ...ctx, surface: `master:${m.id}:${side}` }, side, W, f.dx, true) : []),
    ...crossing(fp.elements, ctx, side, W, f.dx, false),
  ];
}

/** The same for a master spread being edited: items of the other side crossing onto this one. */
export function masterCrossovers(project: Project, masterId: string, side: PageSide): Crossover[] {
  const m = project.masters.find((x) => x.id === masterId);
  if (!m || !project.book.facing) return [];
  const other: PageSide = side === 'left' ? 'right' : 'left';
  const W = project.book.trimW;
  const ctx: CompileContext = { project, surface: `master:${m.id}:${other}`, pageIndex: null, side: other };
  return crossing(other === 'left' ? m.left : m.right, ctx, other, W, side === 'left' ? W : -W, true);
}

/** All primitives of a page in page coordinates (trim origin). */
export function compilePage(project: Project, pageIndex: number, opts: PageRenderOptions = {}): Prim[] {
  const page = project.pages[pageIndex];
  if (!page) return [];
  const side = pageSide(project, pageIndex);
  const ctx: CompileContext = { project, surface: `page:${page.id}`, pageIndex, side };
  const out: Prim[] = [];
  const b = project.book.bleed;
  if (opts.paper !== false) {
    out.push({ t: 'path', d: rectPath(-b, -b, project.book.trimW + 2 * b, project.book.trimH + 2 * b), fill: page.material === 'vellum' ? mix(page.paperColor, '#ffffff', 0.4) : page.paperColor });
  }
  const accept = (el: Element) => !el.hidden && (opts.dieLines !== false || el.type !== 'cutout') && (!opts.finishFilter || opts.finishFilter(el));
  if (opts.master !== false && page.masterId) {
    const m = project.masters.find((x) => x.id === page.masterId);
    if (m) {
      const mctx: CompileContext = { ...ctx, surface: `master:${m.id}:${side}` };
      for (const el of side === 'left' ? m.left : m.right) if (accept(el)) out.push(placedElement(el, mctx));
    }
  }
  const xs = crossovers(project, pageIndex).filter((c) => (opts.master !== false || !c.master) && accept(c.el) && c.el.type !== 'cutout');
  for (const c of xs) if (!c.above) out.push(placedElement(c.el, c.ctx, c.dx));
  for (const el of page.elements) if (accept(el)) out.push(placedElement(el, ctx));
  for (const c of xs) if (c.above) out.push(placedElement(c.el, c.ctx, c.dx));
  return out;
}

export function coverAnchorX(project: Project, el: Element, panels: { id: string; x: number }[]): number {
  if (!el.anchor) return 0;
  return panels.find((p) => p.id === el.anchor)?.x ?? 0;
}

/** Cover surface primitives in cover coordinates (origin = top-left of the flat cover, wrap outside). */
export function compileCover(project: Project, calc: { panels: { id: string; x: number; w: number }[]; coverW: number; coverH: number; wrap: number }, opts: PageRenderOptions & { background?: string | null } = {}): Prim[] {
  const out: Prim[] = [];
  const ctx: CompileContext = { project, surface: 'cover', pageIndex: null, side: 'right' };
  if (opts.background !== null) {
    const w = calc.wrap;
    out.push({ t: 'path', d: rectPath(-w, -w, calc.coverW + 2 * w, calc.coverH + 2 * w), fill: opts.background ?? coverBaseColor(project) });
  }
  for (const el of project.cover.elements) {
    if (el.hidden || (opts.finishFilter && !opts.finishFilter(el))) continue;
    out.push(placedElement(el, ctx, coverAnchorX(project, el, calc.panels), 0));
  }
  return out;
}

export function coverBaseColor(project: Project): string {
  const f = project.book.cover.finish;
  const t = project.book.binding.type;
  if (t === 'case' || t === 'coptic' || f === 'cloth' || f === 'buckram' || f === 'leather') return project.book.cover.material;
  return project.book.cover.material || '#f4efe4';
}

/** Locate the page context of an element anywhere in the project. */
export function contextForElement(project: Project, id: string, fallbackPage: number | null = null): CompileContext | null {
  const loc = findElement(project, id);
  if (!loc) return null;
  if (loc.pageIndex != null) return { project, surface: loc.key, pageIndex: loc.pageIndex, side: pageSide(project, loc.pageIndex) };
  if (loc.key.startsWith('master:')) return { project, surface: loc.key, pageIndex: fallbackPage, side: loc.key.endsWith(':left') ? 'left' : 'right' };
  return { project, surface: loc.key, pageIndex: null, side: 'right' };
}

export { IDENTITY };
export type { PathPrim };

/** Dust-jacket primitives in jacket coordinates (origin = top-left of the flat jacket, bleed outside). */
export function compileJacket(project: Project, jc: { panels: { id: string; x: number; w: number }[]; width: number; height: number; bleed: number }, opts: PageRenderOptions & { background?: string | null } = {}): Prim[] {
  const out: Prim[] = [];
  const ctx: CompileContext = { project, surface: 'jacket', pageIndex: null, side: 'right' };
  if (opts.background !== null) {
    const b = jc.bleed;
    out.push({ t: 'path', d: rectPath(-b, -b, jc.width + 2 * b, jc.height + 2 * b), fill: opts.background ?? project.book.jacket?.paperColor ?? '#f4f0e8' });
  }
  for (const el of project.jacket?.elements ?? []) {
    if (el.hidden || (opts.finishFilter && !opts.finishFilter(el))) continue;
    out.push(placedElement(el, ctx, coverAnchorX(project, el, jc.panels), 0));
  }
  return out;
}

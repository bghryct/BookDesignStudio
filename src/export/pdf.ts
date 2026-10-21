/**
 * Print-ready PDF writer.
 *
 *  • Vector: paths, rules, generators, SVG imports and text (embedded + subset for static
 *    fonts, exact glyph outlines for variable-font instances) are written as PDF vectors.
 *  • Raster only where the medium is raster (brush strokes, grain, blurs) — rendered at the
 *    chosen resolution and placed as images.
 *  • TrimBox / BleedBox, crop, bleed and registration marks, CMYK colour bars, page info.
 *  • CMYK preservation: colours matching a swatch use its exact build; others convert.
 *  • Overprint (OP/op/OPM) for Martens passes, blend modes via ExtGState.
 *  • Die-cuts as a “CutContour” spot colour; foil / deboss / spot-gloss artwork on named spots.
 */
import {
  PDFDocument, PDFPage, PDFOperator, type PDFEmbeddedPage, PDFHexString, PDFNull, PDFString, type PDFObject, PDFOperatorNames as Op, PDFName, PDFNumber, PDFArray, PDFDict, PDFRef, PDFFont, StandardFonts,
  pushGraphicsState, popGraphicsState, concatTransformationMatrix, moveTo, lineTo, appendBezierCurve, closePath, fill, stroke,
  fillAndStroke, endPath, setFillingRgbColor, setFillingCmykColor, setStrokingRgbColor, setStrokingCmykColor, setLineWidth,
  setDashPattern, setLineCap, setLineJoin, setGraphicsState, drawObject, setCharacterSpacing, LineCapStyle, LineJoinStyle, cmyk, rgb,
  setTextRenderingMode, TextRenderingMode,
  type PDFImage,
} from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import type { BlendMode, Element, Finish, Project } from '../model/types';
import type { Paint, Prim, TextRun, Matrix, PathPrim, GradientStop } from '../render/primitives';
import { multiply, runMatrix } from '../render/primitives';
import { compileElement, elementMatrix, type CompileContext } from '../render/compile';
import { renderToCanvas, preloadImages } from '../render/canvasBackend';
import { parsePath } from '../lib/pathData';
import { parseColor, rgbToCmyk, findSwatchCmyk } from '../lib/color';
import { shape, glyphPath, canOutline, faceBytes, getFace, glyphKerns } from '../engine/fonts';
import { computeBinding, computeJacket } from '../engine/binding';
import { contentsEntries } from '../ui/contents';
import { pageNumbers } from '../model/sections';
import { pageSide, spreadsOf } from '../model/surfaces';
import { coverBaseColor, crossovers } from '../render/compile';

export interface PdfOptions {
  scope: 'interior' | 'cover' | 'jacket' | 'spread';
  /** 1-based inclusive page range for the interior. */
  from?: number;
  to?: number;
  /** Reader spreads (two pages per sheet) instead of single pages. */
  spreads: boolean;
  bleed: boolean;
  cropMarks: boolean;
  bleedMarks: boolean;
  registration: boolean;
  colorBars: boolean;
  pageInfo: boolean;
  colorMode: 'cmyk' | 'rgb';
  textMode: 'auto' | 'outline';
  rasterDpi: number;
  dieLines: boolean;
  /** Put foil / deboss / spot-gloss artwork on named spot colours. */
  finishSpots: boolean;
  /** Print the paper colour (for proofs on white stock). */
  paperColor: boolean;
  /** Current spread index (scope 'spread'). */
  spreadIndex?: number;
  onProgress?: (fraction: number, label: string) => void;
}

export const DEFAULT_PDF_OPTIONS: PdfOptions = {
  scope: 'interior', spreads: false, bleed: true, cropMarks: true, bleedMarks: true, registration: true, colorBars: true, pageInfo: true,
  colorMode: 'cmyk', textMode: 'auto', rasterDpi: 300, dieLines: true, finishSpots: true, paperColor: false,
};

const BLEND_NAMES: Partial<Record<BlendMode, string>> = {
  multiply: 'Multiply', screen: 'Screen', overlay: 'Overlay', darken: 'Darken', lighten: 'Lighten', 'color-dodge': 'ColorDodge',
  'color-burn': 'ColorBurn', 'hard-light': 'HardLight', 'soft-light': 'SoftLight', difference: 'Difference', exclusion: 'Exclusion',
  hue: 'Hue', saturation: 'Saturation', color: 'Color', luminosity: 'Luminosity',
};

const SPOTS: Record<string, { name: string; cmyk: [number, number, number, number] }> = {
  dieline: { name: 'CutContour', cmyk: [0, 1, 0, 0] },
  'gold-foil': { name: 'Foil_Gold', cmyk: [0.15, 0.3, 0.9, 0.05] },
  'silver-foil': { name: 'Foil_Silver', cmyk: [0.2, 0.15, 0.15, 0.3] },
  'copper-foil': { name: 'Foil_Copper', cmyk: [0.1, 0.6, 0.85, 0.1] },
  'holo-foil': { name: 'Foil_Holographic', cmyk: [0.3, 0.1, 0, 0.1] },
  'blind-deboss': { name: 'Deboss', cmyk: [0.5, 0, 0.5, 0] },
  'spot-gloss': { name: 'SpotUV', cmyk: [0, 0.5, 1, 0] },
  registration: { name: 'All', cmyk: [1, 1, 1, 1] },
};

/* -------------------------------------------------------------------------- */
/* Writer                                                                       */
/* -------------------------------------------------------------------------- */

class PageWriter {
  private gsCache = new Map<string, PDFName>();
  private csCache = new Map<string, PDFName>();
  private shCount = 0;
  ops: PDFOperator[] = [];

  private glyphNames = new Map<PDFRef, PDFName>();

  constructor(public doc: PDFDocument, public page: PDFPage, public project: Project, public opts: PdfOptions, public images: Map<string, PDFImage>, public fonts: Map<string, PDFFont | null>, public glyphs: Map<string, PDFRef>) {}

  /** Where content space sits on the sheet (y-down, from the sheet's top-left), for annotations. */
  base: Matrix = [1, 0, 0, 1, 0, 0];
  /** Hyperlinks to add once the document's pages exist: rectangles in PDF space. */
  links: { rect: [number, number, number, number]; target: string }[] = [];

  /** A link over a box in the current element's space. */
  addLink(x: number, y: number, wd: number, h: number, ctm: Matrix, target: string) {
    const m = multiply(this.base, ctm);
    const H = this.page.getHeight();
    const pts = [[x, y], [x + wd, y], [x, y + h], [x + wd, y + h]].map(([px, py]) => [m[0] * px + m[2] * py + m[4], H - (m[1] * px + m[3] * py + m[5])]);
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    this.links.push({ rect: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], target });
  }

  /**
   * Each outlined glyph is written once per document as a Form XObject (in font units, y up)
   * and placed with `Do`; it inherits the current fill colour, so one definition serves every
   * colour and size. This keeps outlined text compact.
   */
  /** A glyph outline as a form XObject (filled, or filled and stroked for outlined type). */
  glyph(key: string, d: string, outlined = false): PDFName {
    if (outlined) key += '|B';
    let ref = this.glyphs.get(key);
    if (!ref) {
      const ops: PDFOperator[] = [];
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const s of parsePath(d)) {
        if (s.c === 'M') ops.push(moveTo(s.x, s.y));
        else if (s.c === 'L') ops.push(lineTo(s.x, s.y));
        else if (s.c === 'C') ops.push(appendBezierCurve(s.x1, s.y1, s.x2, s.y2, s.x, s.y));
        else { ops.push(closePath()); continue; }
        const pts = s.c === 'C' ? [s.x1, s.y1, s.x2, s.y2, s.x, s.y] : [s.x, s.y];
        for (let i = 0; i < pts.length; i += 2) { x0 = Math.min(x0, pts[i]); x1 = Math.max(x1, pts[i]); y0 = Math.min(y0, pts[i + 1]); y1 = Math.max(y1, pts[i + 1]); }
      }
      ops.push(outlined ? fillAndStroke() : fill());
      const pad = outlined ? 120 : 1;
      const form = this.doc.context.formXObject(ops, { BBox: [Math.floor(x0) - pad, Math.floor(y0) - pad, Math.ceil(x1) + pad, Math.ceil(y1) + pad] });
      ref = this.doc.context.register(form);
      this.glyphs.set(key, ref);
    }
    let name = this.glyphNames.get(ref);
    if (!name) {
      name = this.page.node.newXObject('G', ref);
      this.glyphNames.set(ref, name);
    }
    return name;
  }

  flush() {
    // Chunked: a dense page has tens of thousands of operators, too many for one spread call.
    for (let i = 0; i < this.ops.length; i += 4000) this.page.pushOperators(...this.ops.slice(i, i + 4000));
    this.ops = [];
  }

  push(...o: PDFOperator[]) { this.ops.push(...o); }

  /* ---- colour */
  cmykOf(hex: string): [number, number, number, number] {
    const sw = findSwatchCmyk(hex, this.project.swatches);
    const c = sw ?? rgbToCmyk(hex);
    return [c.c / 100, c.m / 100, c.y / 100, c.k / 100];
  }

  setColor(hex: string, strokeColor: boolean, spot: string | null) {
    if (spot) {
      const name = this.separation(spot);
      this.push(PDFOperator.of(strokeColor ? Op.StrokingColorspace : Op.NonStrokingColorspace, [name]));
      this.push(PDFOperator.of(strokeColor ? Op.StrokingColorN : Op.NonStrokingColorN, [PDFNumber.of(1)]));
      return;
    }
    if (this.opts.colorMode === 'cmyk') {
      const [c, m, y, k] = this.cmykOf(hex);
      this.push(strokeColor ? setStrokingCmykColor(c, m, y, k) : setFillingCmykColor(c, m, y, k));
    } else {
      const { r, g, b } = parseColor(hex);
      this.push(strokeColor ? setStrokingRgbColor(r / 255, g / 255, b / 255) : setFillingRgbColor(r / 255, g / 255, b / 255));
    }
  }

  /** Register a Separation colour space and return its resource name. */
  separation(key: string): PDFName {
    const hit = this.csCache.get(key);
    if (hit) return hit;
    const spot = SPOTS[key] ?? { name: key, cmyk: [0, 0, 0, 1] };
    const ctx = this.doc.context;
    const fn = ctx.obj({ FunctionType: 2, Domain: [0, 1], C0: [0, 0, 0, 0], C1: spot.cmyk, N: 1 });
    const cs = ctx.obj([PDFName.of('Separation'), PDFName.of(spot.name), PDFName.of('DeviceCMYK'), fn]);
    const ref = ctx.register(cs);
    const name = PDFName.of(`CS${this.csCache.size}`);
    const res = this.resources();
    let dict = res.lookupMaybe(PDFName.of('ColorSpace'), PDFDict);
    if (!dict) { dict = ctx.obj({}); res.set(PDFName.of('ColorSpace'), dict); }
    dict.set(name, ref);
    this.csCache.set(key, name);
    return name;
  }

  resources(): PDFDict {
    const node = this.page.node;
    let res = node.Resources();
    if (!res) { res = this.doc.context.obj({}); node.set(PDFName.of('Resources'), res); }
    return res;
  }

  gs(opacity: number, blend: BlendMode | undefined, overprint: boolean, strokeOpacity = opacity): PDFName | null {
    const bm = blend && blend !== 'normal' ? BLEND_NAMES[blend] : undefined;
    if (opacity >= 0.999 && strokeOpacity >= 0.999 && !bm && !overprint) return null;
    const key = `${opacity.toFixed(3)}|${strokeOpacity.toFixed(3)}|${bm ?? ''}|${overprint}`;
    const hit = this.gsCache.get(key);
    if (hit) return hit;
    const dict: Record<string, unknown> = { Type: 'ExtGState', ca: opacity, CA: strokeOpacity };
    if (bm) dict.BM = PDFName.of(bm);
    if (overprint) { dict.OP = true; dict.op = true; dict.OPM = 1; }
    const name = this.page.node.newExtGState('GS', this.doc.context.obj(dict as Record<string, never>) as unknown as PDFDict);
    this.gsCache.set(key, name);
    return name;
  }

  /* ---- paths */
  pathOps(d: string) {
    for (const s of parsePath(d)) {
      if (s.c === 'M') this.push(moveTo(s.x, s.y));
      else if (s.c === 'L') this.push(lineTo(s.x, s.y));
      else if (s.c === 'C') this.push(appendBezierCurve(s.x1, s.y1, s.x2, s.y2, s.x, s.y));
      else this.push(closePath());
    }
  }

  shading(p: Exclude<Paint, string>): PDFName | null {
    if (p.stops.some((s) => s.opacity != null && s.opacity < 0.999)) return null;
    const ctx = this.doc.context;
    const cmykMode = this.opts.colorMode === 'cmyk';
    const col = (s: GradientStop) => (cmykMode ? this.cmykOf(s.color) : (() => { const c = parseColor(s.color); return [c.r / 255, c.g / 255, c.b / 255]; })());
    const stops = [...p.stops].sort((a, b) => a.offset - b.offset);
    const fns = [];
    for (let i = 0; i < stops.length - 1; i++) fns.push(ctx.obj({ FunctionType: 2, Domain: [0, 1], C0: col(stops[i]), C1: col(stops[i + 1]), N: 1 }));
    const func = fns.length === 1
      ? fns[0]
      : ctx.obj({ FunctionType: 3, Domain: [0, 1], Functions: fns, Bounds: stops.slice(1, -1).map((s) => s.offset), Encode: fns.flatMap(() => [0, 1]) });
    const coords = p.kind === 'linear' ? [p.x1, p.y1, p.x2, p.y2] : [p.fx ?? p.cx, p.fy ?? p.cy, 0, p.cx, p.cy, p.r];
    const sh = ctx.obj({ ShadingType: p.kind === 'linear' ? 2 : 3, ColorSpace: PDFName.of(cmykMode ? 'DeviceCMYK' : 'DeviceRGB'), Coords: coords, Function: func, Extend: [true, true] });
    const name = PDFName.of(`Sh${this.shCount++}`);
    const res = this.resources();
    let dict = res.lookupMaybe(PDFName.of('Shading'), PDFDict);
    if (!dict) { dict = ctx.obj({}); res.set(PDFName.of('Shading'), dict); }
    dict.set(name, ctx.register(sh));
    return name;
  }
}

/* -------------------------------------------------------------------------- */
/* Primitive emission                                                           */
/* -------------------------------------------------------------------------- */

interface EmitState { alpha: number; blend?: BlendMode; spot: string | null; ctm: Matrix }

async function emitPrims(w: PageWriter, prims: Prim[], st: EmitState) {
  for (const p of prims) await emitPrim(w, p, st);
}

async function emitPrim(w: PageWriter, p: Prim, st: EmitState) {
  const alpha = st.alpha * (p.opacity ?? 1);
  if (alpha <= 0.001) return;
  const blend = p.blend && p.blend !== 'normal' ? p.blend : st.blend;
  switch (p.t) {
    case 'group': {
      w.push(pushGraphicsState());
      if (p.matrix) w.push(concatTransformationMatrix(...p.matrix));
      if (p.clip) {
        w.pathOps(p.clip);
        w.push(PDFOperator.of(p.clipRule === 'evenodd' ? Op.ClipEvenOdd : Op.ClipNonZero), endPath());
      }
      await emitPrims(w, p.children, { ...st, alpha, blend, ctm: p.matrix ? multiply(st.ctm, p.matrix) : st.ctm });
      w.push(popGraphicsState());
      return;
    }
    case 'path':
      return emitPath(w, p, alpha, blend, st);
    case 'text': {
      // Runs the font engine can outline become vectors; the rest (system fonts, e.g. Japanese
      // Mincho) are rasterised together as one image rather than glyph by glyph.
      const raster: TextRun[] = [];
      for (const r of p.runs) {
        if (canOutline(r.text, r.font)) await emitRun(w, r, alpha, blend, st);
        else raster.push(r);
        if (r.deco?.link && r.text) w.addLink(r.x, r.y - r.size * 0.8, r.width, r.size, st.ctm, r.deco.link);
      }
      if (raster.length) {
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const r of raster) {
          const ext = r.rotate ? [r.x - r.size * 1.2, r.y - r.size * 0.2, r.x + r.size * 1.2, r.y + r.width + r.size * 0.2] : [r.x - r.size * 0.3, r.y - r.size * 1.15, r.x + r.width + r.size * 0.3, r.y + r.size * 0.45];
          x0 = Math.min(x0, ext[0]); y0 = Math.min(y0, ext[1]); x1 = Math.max(x1, ext[2]); y1 = Math.max(y1, ext[3]);
        }
        await emitRaster(w, [{ t: 'text', runs: raster }], { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, alpha, blend, st);
      }
      return;
    }
    case 'image':
      return emitImage(w, p.href, p.x, p.y, p.w, p.h, p.clip, alpha, blend, p.filter === 'grayscale', st, p.assetId);
    case 'raster':
      return emitRaster(w, [p], { x: p.x, y: p.y, w: p.w, h: p.h }, alpha, blend, st);
  }
}

function emitPath(w: PageWriter, p: PathPrim, alpha: number, blend: BlendMode | undefined, st: EmitState) {
  const isDie = p.role === 'dieline';
  if (isDie && !w.opts.dieLines) return;
  const spot = isDie ? 'dieline' : st.spot;
  const fillPaint = p.fill ?? null;
  const strokePaint = p.stroke ?? null;
  const hasStroke = !!strokePaint && (p.strokeWidth ?? 1) > 0;
  if (!fillPaint && !hasStroke) return;

  // Gradient fills → PDF shadings (vector); translucent stops fall back to raster.
  if (fillPaint && typeof fillPaint !== 'string' && !spot) {
    const sh = w.shading(fillPaint);
    if (!sh) {
      const bounds = pathBoundsOf(p.d);
      return void emitRasterSync(w, [{ ...p, stroke: null }], bounds, alpha, blend, st);
    }
    w.push(pushGraphicsState());
    const g = w.gs(alpha, blend, false);
    if (g) w.push(setGraphicsState(g));
    w.pathOps(p.d);
    w.push(PDFOperator.of(p.fillRule === 'evenodd' ? Op.ClipEvenOdd : Op.ClipNonZero), endPath());
    w.push(PDFOperator.of(Op.ShadingFill, [sh]));
    w.push(popGraphicsState());
    if (hasStroke) emitPath(w, { ...p, fill: null }, alpha, blend, st);
    return;
  }

  w.push(pushGraphicsState());
  const g = w.gs(alpha, blend, !!p.overprint || isDie);
  if (g) w.push(setGraphicsState(g));
  if (fillPaint) w.setColor(typeof fillPaint === 'string' ? fillPaint : fillPaint.stops[0].color, false, spot);
  if (hasStroke) {
    w.setColor(typeof strokePaint === 'string' ? strokePaint : strokePaint!.stops[0].color, true, spot);
    w.push(setLineWidth(isDie ? 0.5 : p.strokeWidth ?? 1));
    const dash = (p.dash ?? []).filter((v) => v >= 0);
    w.push(setDashPattern(dash.length && dash.some((v) => v > 0) ? dash : [], 0));
    w.push(setLineCap(p.cap === 'round' ? LineCapStyle.Round : p.cap === 'square' ? LineCapStyle.Projecting : LineCapStyle.Butt));
    w.push(setLineJoin(p.join === 'round' ? LineJoinStyle.Round : p.join === 'bevel' ? LineJoinStyle.Bevel : LineJoinStyle.Miter));
  }
  w.pathOps(p.d);
  const evenOdd = p.fillRule === 'evenodd';
  if (fillPaint && hasStroke) w.push(evenOdd ? PDFOperator.of(Op.FillEvenOddAndStroke) : fillAndStroke());
  else if (fillPaint) w.push(evenOdd ? PDFOperator.of(Op.FillEvenOdd) : fill());
  else w.push(stroke());
  w.push(popGraphicsState());
}

function pathBoundsOf(d: string) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const s of parsePath(d)) {
    if (s.c === 'Z') continue;
    const pts = s.c === 'C' ? [[s.x1, s.y1], [s.x2, s.y2], [s.x, s.y]] : [[s.x, s.y]];
    for (const [x, y] of pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  }
  return { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) };
}

async function fontFor(w: PageWriter, r: TextRun): Promise<PDFFont | null> {
  if (w.opts.textMode === 'outline') return null;
  const face = getFace(r.font.face);
  // Variable instances and synthetic obliques are outlined; static faces are embedded & subset.
  if (!face || face.axes.length > 0 || r.font.oblique) return null;
  const bytes = faceBytes(r.font.face);
  if (!bytes) return null;
  const key = `${r.font.face}|${JSON.stringify(r.font.features)}`;
  if (w.fonts.has(key)) return w.fonts.get(key)!;
  try {
    const f = await w.doc.embedFont(bytes, { subset: true, features: { ...r.font.features } as Record<string, boolean> });
    w.fonts.set(key, f);
    return f;
  } catch {
    w.fonts.set(key, null);
    return null;
  }
}

async function emitRun(w: PageWriter, r: TextRun, alpha: number, blend: BlendMode | undefined, st: EmitState) {
  w.push(pushGraphicsState());
  // Run-level transforms (sideways Latin in tategaki, tate-chū-yoko compression).
  if (r.rotate) {
    const a = (r.rotate * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
    const [px, py] = r.pivot ?? [r.x, r.y];
    w.push(concatTransformationMatrix(c, s, -s, c, px - c * px + s * py, py - s * px - c * py));
  }
  const rm = runMatrix(r);
  if (rm) w.push(concatTransformationMatrix(rm[0], rm[1], rm[2], rm[3], rm[4], rm[5]));
  const g = w.gs(alpha, blend, false);
  if (g) w.push(setGraphicsState(g));
  const ls = r.letterSpacing ?? 0;

  const pdfFont = canOutline(r.text, r.font) ? await fontFor(w, r) : null;
  if (pdfFont) {
    w.push(concatTransformationMatrix(1, 0, 0, -1, r.x, r.y));
    if (ls) w.push(setCharacterSpacing(ls));
    // Outlined type: fill and stroke the glyphs (text render mode 2).
    if (r.stroke) { w.setColor(r.stroke.color, true, st.spot); w.push(setLineWidth(r.stroke.width), setTextRenderingMode(TextRenderingMode.FillAndOutline)); }
    await w.pendingImages();
    w.flush();
    const color = st.spot ? cmyk(...SPOTS[st.spot]?.cmyk ?? [0, 0, 0, 1]) : w.opts.colorMode === 'cmyk' ? cmyk(...w.cmykOf(r.color)) : (() => { const c = parseColor(r.color); return rgb(c.r / 255, c.g / 255, c.b / 255); })();
    const shaped = shape(r.text, r.font)!;
    const gk = glyphKerns(shaped, r.kern);
    if (!gk) w.page.drawText(r.text, { x: 0, y: 0, size: r.size, font: pdfFont, color });
    else {
      // Kerned pairs: split the run where a kern falls, placing each piece from the whole run's
      // advances so the text stays live (searchable) and lands exactly where the layout put it.
      let x = 0, u = 0, from = 0, x0 = 0;
      shaped.glyphs.forEach((g, i) => {
        u += Math.max(1, g.units);
        x += g.xAdvance * r.size + ls;
        if (gk[i] || i === shaped.glyphs.length - 1) {
          w.page.drawText(r.text.slice(from, u), { x: x0, y: 0, size: r.size, font: pdfFont, color });
          x += gk[i];
          from = u;
          x0 = x;
        }
      });
    }
    if (ls) w.push(setCharacterSpacing(0));
  } else if (canOutline(r.text, r.font)) {
    w.setColor(r.color, false, st.spot);
    // Outlined type: the glyph forms fill and stroke; the line width is set in glyph units below.
    if (r.stroke) w.setColor(r.stroke.color, true, st.spot);
    const shaped = shape(r.text, r.font)!;
    const gk = glyphKerns(shaped, r.kern);
    let x = 0;
    for (let gi = 0; gi < shaped.glyphs.length; gi++) {
      const gl = shaped.glyphs[gi];
      const gp = glyphPath(r.font, gl.id);
      if (gp && gp.d) {
        const k = r.size / gp.upm;
        const name = w.glyph(`${r.font.face}|${JSON.stringify(r.font.axes)}|${gl.id}`, gp.d, !!r.stroke);
        w.push(pushGraphicsState());
        w.push(concatTransformationMatrix(k, 0, 0, -k, r.x + x + gl.xOffset * r.size, r.y - gl.yOffset * r.size));
        if (r.stroke) w.push(setLineWidth(r.stroke.width / k), setLineJoin(LineJoinStyle.Round));
        if (r.font.oblique) w.push(concatTransformationMatrix(1, 0, Math.tan((12 * Math.PI) / 180), 1, 0, 0));
        w.push(drawObject(name));
        w.push(popGraphicsState());
      }
      x += gl.xAdvance * r.size + ls + (gk ? gk[gi] : 0);
    }
  } else {
    // System font / uncovered script: rasterise the run at print resolution.
    const pad = r.size * 0.4;
    const box = { x: r.x - pad, y: r.y - r.size * 1.1, w: r.width + pad * 2, h: r.size * 1.6 };
    w.push(popGraphicsState());
    await emitRaster(w, [{ t: 'text', runs: [{ ...r, rotate: undefined, scaleX: undefined }] }], box, alpha, blend, st, r.rotate || r.scaleX ? r : undefined);
    return;
  }
  w.push(popGraphicsState());
}

async function dataUrlBytes(src: string): Promise<{ bytes: Uint8Array; mime: string }> {
  const res = await fetch(src);
  const blob = await res.blob();
  return { bytes: new Uint8Array(await blob.arrayBuffer()), mime: blob.type };
}

/** Fully opaque rasters (glows, textures, full-bleed paint) go in as JPEG; anything with alpha as PNG. */
function isOpaque(c: HTMLCanvasElement): boolean {
  const ctx = c.getContext('2d', { willReadFrequently: true });
  if (!ctx) return false;
  const data = ctx.getImageData(0, 0, c.width, c.height).data;
  const stride = Math.max(1, Math.floor((c.width * c.height) / 400000));
  for (let p = 0; p < c.width * c.height; p += stride) if (data[p * 4 + 3] < 254) return false;
  return true;
}

async function embedCanvas(w: PageWriter, c: HTMLCanvasElement): Promise<PDFImage> {
  if (isOpaque(c)) {
    const jpg = await new Promise<Blob>((res) => c.toBlob((b) => res(b!), 'image/jpeg', 0.93));
    return w.doc.embedJpg(new Uint8Array(await jpg.arrayBuffer()));
  }
  const blob = await new Promise<Blob>((res) => c.toBlob((b) => res(b!), 'image/png'));
  return w.doc.embedPng(new Uint8Array(await blob.arrayBuffer()));
}

function drawImageXObject(w: PageWriter, img: PDFImage, x: number, y: number, width: number, height: number) {
  const name = w.page.node.newXObject('Im', img.ref);
  // Our space is y-down; an image paints the unit square y-up, so flip it.
  w.push(pushGraphicsState(), concatTransformationMatrix(width, 0, 0, -height, x, y + height), drawObject(name), popGraphicsState());
}

async function emitImage(w: PageWriter, href: string, x: number, y: number, width: number, height: number, clipRect: { x: number; y: number; w: number; h: number } | undefined, alpha: number, blend: BlendMode | undefined, grayscale: boolean, st: EmitState, assetId?: string) {
  if (grayscale) {
    return emitRaster(w, [{ t: 'image', href, x, y, w: width, h: height, clip: clipRect, filter: 'grayscale' }], clipRect ?? { x, y, w: width, h: height }, alpha, blend, st);
  }
  // A placed PDF page goes in as the original page: vector type and art, not the preview.
  const pdfSrc = assetId ? w.project.assets[assetId]?.pdf : undefined;
  if (pdfSrc) {
    try {
      const ep = await embeddedPdfPage(w, pdfSrc);
      w.push(pushGraphicsState());
      const g = w.gs(alpha, blend, false);
      if (g) w.push(setGraphicsState(g));
      if (clipRect) {
        w.push(moveTo(clipRect.x, clipRect.y), lineTo(clipRect.x + clipRect.w, clipRect.y), lineTo(clipRect.x + clipRect.w, clipRect.y + clipRect.h), lineTo(clipRect.x, clipRect.y + clipRect.h), closePath());
        w.push(PDFOperator.of(Op.ClipNonZero), endPath());
      }
      const name = w.page.node.newXObject('EP', ep.ref);
      // The page paints its own space y-up from its lower-left corner: flip it into the box.
      w.push(concatTransformationMatrix(width / ep.width, 0, 0, -height / ep.height, x, y + height), drawObject(name), popGraphicsState());
      return;
    } catch {
      // A PDF pdf-lib cannot read falls back to the raster preview.
    }
  }
  const key = assetId ?? href.slice(0, 120) + href.length;
  let img = w.images.get(key);
  if (!img) {
    const { bytes, mime } = await dataUrlBytes(href);
    try {
      img = mime.includes('jpeg') || mime.includes('jpg') ? await w.doc.embedJpg(bytes) : mime.includes('png') ? await w.doc.embedPng(bytes) : await embedCanvas(w, rasterizeHref(href, width, height, w.opts.rasterDpi));
    } catch {
      img = await embedCanvas(w, rasterizeHref(href, width, height, w.opts.rasterDpi));
    }
    w.images.set(key, img);
  }
  w.push(pushGraphicsState());
  const g = w.gs(alpha, blend, false);
  if (g) w.push(setGraphicsState(g));
  if (clipRect) {
    w.push(moveTo(clipRect.x, clipRect.y), lineTo(clipRect.x + clipRect.w, clipRect.y), lineTo(clipRect.x + clipRect.w, clipRect.y + clipRect.h), lineTo(clipRect.x, clipRect.y + clipRect.h), closePath());
    w.push(PDFOperator.of(Op.ClipNonZero), endPath());
  }
  drawImageXObject(w, img, x, y, width, height);
  w.push(popGraphicsState());
}

/** Embedded PDF pages, one per source page per export. */
const embeddedPages = new WeakMap<PDFDocument, Map<string, PDFEmbeddedPage>>();
async function embeddedPdfPage(w: PageWriter, pdf: NonNullable<Project['assets'][string]['pdf']>): Promise<PDFEmbeddedPage> {
  let m = embeddedPages.get(w.doc);
  if (!m) { m = new Map(); embeddedPages.set(w.doc, m); }
  const key = `${pdf.src.length}:${pdf.src.slice(-64)}#${pdf.page}`;
  let ep = m.get(key);
  if (!ep) {
    const { bytes } = await dataUrlBytes(pdf.src);
    [ep] = await w.doc.embedPdf(bytes, [pdf.page - 1]);
    m.set(key, ep);
  }
  return ep;
}

function rasterizeHref(href: string, width: number, height: number, dpi: number): HTMLCanvasElement {
  return renderToCanvas([{ t: 'image', href, x: 0, y: 0, w: width, h: height }], { x: 0, y: 0, w: width, h: height }, Math.min(dpi / 72, 8192 / Math.max(width, height)));
}

async function emitRaster(w: PageWriter, prims: Prim[], box: { x: number; y: number; w: number; h: number }, alpha: number, blend: BlendMode | undefined, st: EmitState, runTransform?: TextRun) {
  await preloadImages(prims);
  emitRasterSync(w, prims, box, alpha, blend, st, runTransform);
  await w.pendingImages();
}

function emitRasterSync(w: PageWriter, prims: Prim[], box: { x: number; y: number; w: number; h: number }, alpha: number, blend: BlendMode | undefined, _st: EmitState, runTransform?: TextRun) {
  // Resolution: requested dpi, bounded so huge areas stay under ~8k pixels.
  const ppp = Math.max(0.5, Math.min(w.opts.rasterDpi / 72, 8000 / Math.max(box.w, box.h)));
  const canvas = renderToCanvas(prims, box, ppp, { hideDieLines: true });
  w.queueImage(canvas, (img) => {
    w.push(pushGraphicsState());
    if (runTransform?.rotate) {
      const a = (runTransform.rotate * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
      w.push(concatTransformationMatrix(c, s, -s, c, runTransform.x - c * runTransform.x + s * runTransform.y, runTransform.y - s * runTransform.x - c * runTransform.y));
    }
    const g = w.gs(alpha, blend, false);
    if (g) w.push(setGraphicsState(g));
    drawImageXObject(w, img, box.x, box.y, box.w, box.h);
    w.push(popGraphicsState());
  });
}

/* Queued raster images: embedding is async, but operator order must be preserved. */
declare module 'pdf-lib' { interface PDFPage { __bdsQueue?: unknown } }
interface QueueItem { canvas: HTMLCanvasElement; then: (img: PDFImage) => void; index: number }
interface PageWriter { queue: QueueItem[]; queueImage: (c: HTMLCanvasElement, then: (img: PDFImage) => void) => void; pendingImages: () => Promise<void> }
PageWriter.prototype.queueImage = function queueImage(this: PageWriter, canvas: HTMLCanvasElement, then: (img: PDFImage) => void) {
  // Reserve the position in the operator stream with a placeholder.
  if (!this.queue) this.queue = [];
  const index = this.ops.length;
  this.ops.push(PDFOperator.of(Op.EndPath)); // harmless placeholder, replaced below
  this.queue.push({ canvas, then, index });
};
PageWriter.prototype.pendingImages = async function pendingImages(this: PageWriter) {
  if (!this.queue?.length) return;
  const items = this.queue.splice(0);
  for (const it of items.reverse()) {
    const img = await embedCanvas(this, it.canvas);
    const before = this.ops.slice(0, it.index);
    const after = this.ops.slice(it.index + 1);
    this.ops = before;
    it.then(img);
    this.ops.push(...after);
  }
};

/* -------------------------------------------------------------------------- */
/* Elements & surfaces                                                          */
/* -------------------------------------------------------------------------- */

async function emitElement(w: PageWriter, el: Element, ctx: CompileContext, offsetX: number) {
  if (el.hidden) return;
  if (el.type === 'cutout' && !w.opts.dieLines) return;
  const prims = compileElement(el, ctx);
  const m = elementMatrix(el, offsetX, 0);
  const spot = w.opts.finishSpots && el.finish && el.finish !== 'none' ? (el.finish as Finish) : null;
  w.push(pushGraphicsState(), concatTransformationMatrix(...m));
  // Raster-native media (tonal meshes, brush drawings, roller-textured overprints) are flattened
  // into one image per element instead of one translucent image per layer.
  const flatten = el.type === 'gradient' || el.type === 'drawing' || (el.type === 'overprint' && el.texture > 0);
  if (flatten && !spot) {
    const g = w.gs(el.opacity, el.blend, false);
    if (g) w.push(setGraphicsState(g));
    await emitRaster(w, prims, { x: 0, y: 0, w: el.w, h: el.h }, 1, undefined, { alpha: 1, spot: null, ctm: m });
    w.push(popGraphicsState());
    return;
  }
  await emitPrims(w, prims, { alpha: el.opacity, blend: el.blend, spot, ctm: m });
  await w.pendingImages();
  w.push(popGraphicsState());
}

function drawMarks(w: PageWriter, ox: number, oy: number, tw: number, th: number, bleed: number, label: string, pageNo: string) {
  const o = w.opts;
  const reg = () => w.setColor('#000000', true, 'registration');
  const line = (x1: number, y1: number, x2: number, y2: number) => w.push(moveTo(x1, y1), lineTo(x2, y2));
  const off = bleed + 3;
  const len = 14;
  if (o.cropMarks) {
    w.push(pushGraphicsState());
    reg();
    w.push(setLineWidth(0.25));
    for (const [cx, cy, sx, sy] of [[ox, oy, -1, -1], [ox + tw, oy, 1, -1], [ox, oy + th, -1, 1], [ox + tw, oy + th, 1, 1]] as const) {
      line(cx + sx * off, cy, cx + sx * (off + len), cy);
      line(cx, cy + sy * off, cx, cy + sy * (off + len));
    }
    w.push(stroke(), popGraphicsState());
  }
  if (o.bleedMarks && bleed > 0) {
    w.push(pushGraphicsState());
    reg();
    w.push(setLineWidth(0.25), setDashPattern([2, 1.5], 0));
    for (const [cx, cy, sx, sy] of [[ox - bleed, oy - bleed, -1, -1], [ox + tw + bleed, oy - bleed, 1, -1], [ox - bleed, oy + th + bleed, -1, 1], [ox + tw + bleed, oy + th + bleed, 1, 1]] as const) {
      line(cx + sx * 3, cy, cx + sx * 9, cy);
      line(cx, cy + sy * 3, cx, cy + sy * 9);
    }
    w.push(stroke(), popGraphicsState());
  }
  if (o.registration) {
    const targets = [[ox + tw / 2, oy - off - 9], [ox + tw / 2, oy + th + off + 9], [ox - off - 9, oy + th / 2], [ox + tw + off + 9, oy + th / 2]];
    w.push(pushGraphicsState());
    reg();
    w.push(setLineWidth(0.25));
    for (const [cx, cy] of targets) {
      const r = 4.5, k = r * 0.5523;
      w.push(moveTo(cx - r, cy), appendBezierCurve(cx - r, cy - k, cx - k, cy - r, cx, cy - r), appendBezierCurve(cx + k, cy - r, cx + r, cy - k, cx + r, cy),
        appendBezierCurve(cx + r, cy + k, cx + k, cy + r, cx, cy + r), appendBezierCurve(cx - k, cy + r, cx - r, cy + k, cx - r, cy), closePath());
      line(cx - 8, cy, cx + 8, cy);
      line(cx, cy - 8, cx, cy + 8);
    }
    w.push(stroke(), popGraphicsState());
  }
  if (o.colorBars) {
    const sw = 9, y = oy + th + off + 2;
    const patches: [number, number, number, number][] = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1], [1, 1, 0, 0], [0, 1, 1, 0], [1, 0, 1, 0], [0.5, 0, 0, 0], [0, 0.5, 0, 0], [0, 0, 0.5, 0], [0, 0, 0, 0.5], [0, 0, 0, 0.25]];
    const x0 = ox + 8;
    patches.forEach((c, i) => {
      w.push(pushGraphicsState(), setFillingCmykColor(...c), moveTo(x0 + i * sw, y), lineTo(x0 + (i + 1) * sw, y), lineTo(x0 + (i + 1) * sw, y + sw), lineTo(x0 + i * sw, y + sw), closePath(), fill(), popGraphicsState());
    });
  }
  return { label, pageNo };
}

async function pageInfo(w: PageWriter, text: string, x: number, y: number) {
  if (!w.opts.pageInfo) return;
  await w.pendingImages();
  w.flush();
  const font = await w.doc.embedFont(StandardFonts.Helvetica);
  w.push(pushGraphicsState(), concatTransformationMatrix(1, 0, 0, -1, x, y));
  w.flush();
  w.page.drawText(text.replace(/[^\x20-\x7e]/g, '·'), { x: 0, y: 0, size: 6, font, color: cmyk(0, 0, 0, 1) });
  w.push(popGraphicsState());
}

/* -------------------------------------------------------------------------- */
/* Entry point                                                                  */
/* -------------------------------------------------------------------------- */

export async function exportPdf(project: Project, opts: PdfOptions): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const b = project.book;
  doc.setTitle(b.title || project.name);
  doc.setAuthor(b.author);
  doc.setSubject(b.subtitle);
  doc.setCreator('Book Design Studio');
  doc.setProducer('Book Design Studio (pdf-lib)');
  doc.setCreationDate(new Date());
  const images = new Map<string, PDFImage>();
  const fonts = new Map<string, PDFFont | null>();
  const glyphs = new Map<string, PDFRef>();
  const marks = opts.cropMarks || opts.registration || opts.colorBars || opts.pageInfo || opts.bleedMarks;
  const slug = marks ? Math.max(b.slug, 30) : 0;
  const bleed = opts.bleed ? b.bleed : 0;
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');

  if (opts.scope === 'jacket') {
    const jc = computeJacket(b);
    const bl = opts.bleed ? jc.bleed : 0;
    const W = jc.width, H = jc.height;
    const page = doc.addPage([W + 2 * (bl + slug), H + 2 * (bl + slug)]);
    const ox = bl + slug, oy = bl + slug;
    page.setTrimBox(ox, oy, W, H);
    page.setBleedBox(slug, slug, W + 2 * bl, H + 2 * bl);
    const w = new PageWriter(doc, page, project, opts, images, fonts, glyphs);
    w.push(concatTransformationMatrix(1, 0, 0, -1, 0, page.getHeight()));
    w.push(concatTransformationMatrix(1, 0, 0, 1, ox, oy));
    if (opts.paperColor) {
      w.setColor(b.jacket?.paperColor ?? '#ffffff', false, null);
      w.push(moveTo(-bl, -bl), lineTo(W + bl, -bl), lineTo(W + bl, H + bl), lineTo(-bl, H + bl), closePath(), fill());
    }
    const ctx: CompileContext = { project, surface: 'jacket', pageIndex: null, side: 'right' };
    const els = project.jacket?.elements ?? [];
    for (const [i, el] of els.entries()) {
      opts.onProgress?.(i / Math.max(1, els.length), 'Jacket');
      await emitElement(w, el, ctx, el.anchor ? jc.panels.find((p) => p.id === el.anchor)?.x ?? 0 : 0);
    }
    w.push(pushGraphicsState());
    w.setColor('#000000', true, 'registration');
    w.push(setLineWidth(0.3));
    for (const f of jc.folds) w.push(setDashPattern(f.kind === 'spine' ? [3, 2] : [1, 1], 0), moveTo(f.x, -bl - 4), lineTo(f.x, -bl - 16), moveTo(f.x, H + bl + 4), lineTo(f.x, H + bl + 16), stroke());
    w.push(popGraphicsState());
    drawMarks(w, 0, 0, W, H, bl, 'Jacket', '');
    w.flush();
    await pageInfo(w, `${b.title} - dust jacket ${(W / 72 * 25.4).toFixed(1)} x ${(H / 72 * 25.4).toFixed(1)} mm - flaps ${(jc.flapW / 72 * 25.4).toFixed(0)} mm - spine ${(jc.spineW / 72 * 25.4).toFixed(2)} mm - ${stamp}`, opts.colorBars ? 8 + 12 * 9 + 10 : 0, H + bl + slug * 0.55);
    w.flush();
    return doc.save();
  }

  if (opts.scope === 'cover') {
    const calc = computeBinding(b);
    const wrap = opts.bleed ? calc.wrap : 0;
    const W = calc.coverW, H = calc.coverH;
    const page = doc.addPage([W + 2 * (wrap + slug), H + 2 * (wrap + slug)]);
    const ox = wrap + slug, oy = wrap + slug;
    page.setTrimBox(ox, slug + wrap, W, H);
    page.setBleedBox(ox - wrap, slug, W + 2 * wrap, H + 2 * wrap);
    const w = new PageWriter(doc, page, project, opts, images, fonts, glyphs);
    w.push(concatTransformationMatrix(1, 0, 0, -1, 0, page.getHeight()));
    w.push(concatTransformationMatrix(1, 0, 0, 1, ox, oy));
    const printed = !['cloth', 'buckram', 'leather'].includes(b.cover.finish);
    if (printed || opts.paperColor) {
      w.setColor(coverBaseColor(project), false, null);
      w.push(moveTo(-wrap, -wrap), lineTo(W + wrap, -wrap), lineTo(W + wrap, H + wrap), lineTo(-wrap, H + wrap), closePath(), fill());
    }
    const ctx: CompileContext = { project, surface: 'cover', pageIndex: null, side: 'right' };
    for (const [i, el] of project.cover.elements.entries()) {
      opts.onProgress?.(i / Math.max(1, project.cover.elements.length), 'Cover');
      await emitElement(w, el, ctx, el.anchor ? calc.panels.find((p) => p.id === el.anchor)?.x ?? 0 : 0);
    }
    // Fold / score / hinge marks in the slug and the stab holes.
    w.push(pushGraphicsState());
    w.setColor('#000000', true, 'registration');
    w.push(setLineWidth(0.3));
    for (const f of calc.folds) {
      w.push(setDashPattern(f.kind === 'score' ? [1, 1] : [3, 2], 0), moveTo(f.x, -wrap - 4), lineTo(f.x, -wrap - 16), moveTo(f.x, H + wrap + 4), lineTo(f.x, H + wrap + 16), stroke());
    }
    w.push(popGraphicsState());
    if (opts.dieLines && calc.stabHoles.length) {
      const front = calc.panels.find((p) => p.id === 'front')!;
      const spine = calc.panels.find((p) => p.id === 'spine')!;
      const onRight = front.x > spine.x;
      for (const h of calc.stabHoles) {
        const cx = onRight ? front.x + h.x : front.x + front.w - h.x;
        const r = 1.2, k = r * 0.5523;
        emitPath(w, { t: 'path', d: `M${cx - r} ${h.y}C${cx - r} ${h.y - k} ${cx - k} ${h.y - r} ${cx} ${h.y - r}C${cx + k} ${h.y - r} ${cx + r} ${h.y - k} ${cx + r} ${h.y}C${cx + r} ${h.y + k} ${cx + k} ${h.y + r} ${cx} ${h.y + r}C${cx - k} ${h.y + r} ${cx - r} ${h.y + k} ${cx - r} ${h.y}Z`, stroke: '#e5007e', strokeWidth: 0.5, role: 'dieline' }, 1, undefined, { alpha: 1, spot: null, ctm: [1, 0, 0, 1, 0, 0] });
      }
    }
    drawMarks(w, 0, 0, W, H, wrap, 'Cover', '');
    w.flush();
    await pageInfo(w, `${b.title} - cover ${(W / 72 * 25.4).toFixed(1)} x ${(H / 72 * 25.4).toFixed(1)} mm - spine ${(calc.spine / 72 * 25.4).toFixed(2)} mm - ${stamp}`, opts.colorBars ? 8 + 12 * 9 + 10 : 0, H + wrap + slug * 0.55);
    w.flush();
    return doc.save();
  }

  // Interior: single pages or reader spreads.
  type Sheet = { pages: (number | null)[] };
  const sheets: Sheet[] = [];
  const from = Math.max(1, opts.from ?? 1), to = Math.min(project.pages.length, opts.to ?? project.pages.length);
  if (opts.scope === 'spread') {
    const sp = spreadsOf(project)[opts.spreadIndex ?? 0];
    if (sp) sheets.push({ pages: b.facing ? [sp.left, sp.right] : [sp.right] });
  } else if (opts.spreads && b.facing) {
    for (const sp of spreadsOf(project)) {
      const inRange = [sp.left, sp.right].some((i) => i != null && i + 1 >= from && i + 1 <= to);
      if (inRange) sheets.push({ pages: [sp.left, sp.right] });
    }
  } else {
    for (let i = from - 1; i < to; i++) sheets.push({ pages: [i] });
  }

  const allLinks: { page: PDFPage; links: PageWriter['links'] }[] = [];
  for (let si = 0; si < sheets.length; si++) {
    const sheet = sheets[si];
    const n = sheet.pages.length;
    const contentW = b.trimW * n;
    const page = doc.addPage([contentW + 2 * (bleed + slug), b.trimH + 2 * (bleed + slug)]);
    const ox = bleed + slug, oy = bleed + slug;
    page.setTrimBox(ox, oy, contentW, b.trimH);
    page.setBleedBox(slug, slug, contentW + 2 * bleed, b.trimH + 2 * bleed);
    const w = new PageWriter(doc, page, project, opts, images, fonts, glyphs);
    w.push(concatTransformationMatrix(1, 0, 0, -1, 0, page.getHeight()));
    w.push(concatTransformationMatrix(1, 0, 0, 1, ox, oy));
    for (let k = 0; k < n; k++) {
      const pi = sheet.pages[k];
      if (pi == null) continue;
      const pg = project.pages[pi];
      const side = pageSide(project, pi);
      const x0 = k * b.trimW;
      opts.onProgress?.((si + k / n) / sheets.length, `Page ${pi + 1}`);
      w.push(pushGraphicsState(), concatTransformationMatrix(1, 0, 0, 1, x0, 0));
      w.base = [1, 0, 0, 1, ox + x0, oy];
      // Clip to this page's bleed so neighbours in a spread don't overprint each other.
      const cl = n > 1 ? { x: k === 0 ? -bleed : 0, w: b.trimW + bleed } : { x: -bleed, w: b.trimW + 2 * bleed };
      w.push(moveTo(cl.x, -bleed), lineTo(cl.x + cl.w, -bleed), lineTo(cl.x + cl.w, b.trimH + bleed), lineTo(cl.x, b.trimH + bleed), closePath(), PDFOperator.of(Op.ClipNonZero), endPath());
      if (opts.paperColor || pg.material !== 'paper') {
        if (opts.paperColor) {
          w.setColor(pg.paperColor, false, null);
          w.push(moveTo(-bleed, -bleed), lineTo(b.trimW + bleed, -bleed), lineTo(b.trimW + bleed, b.trimH + bleed), lineTo(-bleed, b.trimH + bleed), closePath(), fill());
        }
      }
      const ctx: CompileContext = { project, surface: `page:${pg.id}`, pageIndex: pi, side };
      if (pg.masterId) {
        const m = project.masters.find((x) => x.id === pg.masterId);
        if (m) for (const el of side === 'left' ? m.left : m.right) await emitElement(w, el, { ...ctx, surface: `master:${m.id}:${side}` }, 0);
      }
      // Spread items from the facing page reach across the gutter onto this one.
      const xs = crossovers(project, pi).filter((c) => c.el.type !== 'cutout');
      for (const c of xs) if (!c.above) await emitElement(w, c.el, c.ctx, c.dx);
      for (const el of pg.elements) await emitElement(w, el, ctx, 0);
      for (const c of xs) if (c.above) await emitElement(w, c.el, c.ctx, c.dx);
      w.push(popGraphicsState());
    }
    allLinks.push({ page, links: w.links });
    drawMarks(w, 0, 0, contentW, b.trimH, bleed, '', '');
    w.flush();
    const nums = sheet.pages.filter((x): x is number => x != null).map((x) => x + 1).join('-');
    const mats = sheet.pages.filter((x): x is number => x != null).map((x) => project.pages[x].material).filter((m) => m !== 'paper');
    await pageInfo(w, `${b.title} - p. ${nums}${mats.length ? ` - stock: ${mats.join(', ')}` : ''} - ${stamp}`, opts.colorBars ? 8 + 12 * 9 + 10 : 0, b.trimH + bleed + slug * 0.55);
    w.flush();
  }
  // Hyperlinks: URLs, and cross-references to pages (when the target page is in this file).
  const sheetOf = new Map<number, number>();
  sheets.forEach((sh, k) => sh.pages.forEach((pi) => { if (pi != null) sheetOf.set(pi, k); }));
  for (const { page, links } of allLinks) writeLinks(doc, page, links, (pi) => { const k = sheetOf.get(pi); return k != null ? doc.getPages()[k] : null; }, b.trimH + bleed + slug);
  // Single pages: bookmarks from the chapter titles and headings, and page labels that follow the
  // book's sections (i, ii … then 1, 2 …), as a reader's page box shows them.
  if (opts.scope === 'interior' && !(opts.spreads && b.facing)) {
    const docIndex = new Map<number, number>();
    sheets.forEach((sh, k) => { const pi = sh.pages[0]; if (pi != null) docIndex.set(pi, k); });
    writeOutline(doc, contentsEntries(project).filter((e) => docIndex.has(e.index)).map((e) => ({ level: e.level, title: e.text, page: docIndex.get(e.index)! })), b.trimH + bleed + slug);
    if (project.sections?.length) writePageLabels(doc, project, sheets.map((sh) => sh.pages[0] ?? 0));
  }
  opts.onProgress?.(1, 'Writing file');
  return doc.save();
}

function writeLinks(doc: PDFDocument, page: PDFPage, links: PageWriter['links'], pageFor: (pageIndex: number) => PDFPage | null, top: number) {
  if (!links.length) return;
  const ctx = doc.context;
  const annots: PDFRef[] = [];
  for (const l of links) {
    const d = ctx.obj({}) as PDFDict;
    d.set(PDFName.of('Type'), PDFName.of('Annot'));
    d.set(PDFName.of('Subtype'), PDFName.of('Link'));
    d.set(PDFName.of('Rect'), ctx.obj(l.rect.map((v) => PDFNumber.of(+v.toFixed(2)))));
    d.set(PDFName.of('Border'), ctx.obj([PDFNumber.of(0), PDFNumber.of(0), PDFNumber.of(0)]));
    const m = /^#p:(\d+)$/.exec(l.target);
    if (m) {
      const target = pageFor(parseInt(m[1], 10));
      if (!target) continue;
      d.set(PDFName.of('Dest'), ctx.obj([target.ref, PDFName.of('XYZ'), PDFNull, PDFNumber.of(top), PDFNull]));
    } else {
      const a = ctx.obj({}) as PDFDict;
      a.set(PDFName.of('S'), PDFName.of('URI'));
      a.set(PDFName.of('URI'), PDFString.of(l.target));
      d.set(PDFName.of('A'), a);
    }
    annots.push(ctx.register(d));
  }
  if (!annots.length) return;
  const existing = page.node.lookup(PDFName.of('Annots'));
  if (existing instanceof PDFArray) for (const r of annots) existing.push(r);
  else page.node.set(PDFName.of('Annots'), ctx.obj(annots));
}

/** The document outline (bookmarks): level-2 entries nest under the level-1 entry before them. */
function writeOutline(doc: PDFDocument, items: { level: 1 | 2; title: string; page: number }[], top: number) {
  if (!items.length) return;
  const ctx = doc.context;
  const pages = doc.getPages();
  const root = ctx.nextRef();
  type Node = { ref: PDFRef; title: string; page: number; kids: Node[] };
  const tops: Node[] = [];
  for (const it of items) {
    const node: Node = { ref: ctx.nextRef(), title: it.title, page: it.page, kids: [] };
    if (it.level === 2 && tops.length) tops[tops.length - 1].kids.push(node); else tops.push(node);
  }
  const write = (list: Node[], parent: PDFRef) => {
    list.forEach((n, i) => {
      const d = ctx.obj({}) as PDFDict;
      d.set(PDFName.of('Title'), PDFHexString.fromText(n.title || '—'));
      d.set(PDFName.of('Parent'), parent);
      d.set(PDFName.of('Dest'), ctx.obj([pages[n.page].ref, PDFName.of('XYZ'), PDFNull, PDFNumber.of(top), PDFNull]));
      if (i > 0) d.set(PDFName.of('Prev'), list[i - 1].ref);
      if (i < list.length - 1) d.set(PDFName.of('Next'), list[i + 1].ref);
      if (n.kids.length) {
        d.set(PDFName.of('First'), n.kids[0].ref);
        d.set(PDFName.of('Last'), n.kids[n.kids.length - 1].ref);
        d.set(PDFName.of('Count'), PDFNumber.of(-n.kids.length));
        write(n.kids, n.ref);
      }
      ctx.assign(n.ref, d);
    });
  };
  write(tops, root);
  const outlines = ctx.obj({}) as PDFDict;
  outlines.set(PDFName.of('Type'), PDFName.of('Outlines'));
  outlines.set(PDFName.of('First'), tops[0].ref);
  outlines.set(PDFName.of('Last'), tops[tops.length - 1].ref);
  outlines.set(PDFName.of('Count'), PDFNumber.of(tops.length));
  ctx.assign(root, outlines);
  doc.catalog.set(PDFName.of('Outlines'), root);
  doc.catalog.set(PDFName.of('PageMode'), PDFName.of('UseOutlines'));
}

/** /PageLabels: a new range wherever the numbering's style, prefix or sequence changes. */
function writePageLabels(doc: PDFDocument, project: Project, pageIndexes: number[]) {
  const nums = pageNumbers(project);
  const secOf = (pi: number) => { let s: NonNullable<Project['sections']>[number] | null = null; for (let k = 0; k <= pi; k++) { const f = project.sections?.find((x) => x.pageId === project.pages[k]?.id); if (f) s = f; } return s; };
  const code: Record<string, string> = { arabic: 'D', roman: 'r', ROMAN: 'R', alpha: 'a', ALPHA: 'A' };
  const arr: PDFObject[] = [];
  let prev: { style: string; prefix: string; n: number } | null = null;
  pageIndexes.forEach((pi, k) => {
    const sec = secOf(pi);
    const cur = { style: sec?.style ?? 'arabic', prefix: sec?.prefix ?? '', n: nums[pi]?.n ?? pi + 1 };
    if (!prev || prev.style !== cur.style || prev.prefix !== cur.prefix || cur.n !== prev.n + 1) {
      const d = doc.context.obj({}) as PDFDict;
      d.set(PDFName.of('S'), PDFName.of(code[cur.style] ?? 'D'));
      if (cur.n !== 1) d.set(PDFName.of('St'), PDFNumber.of(cur.n));
      if (cur.prefix) d.set(PDFName.of('P'), PDFHexString.fromText(cur.prefix));
      arr.push(PDFNumber.of(k), d);
    }
    prev = cur;
  });
  const labels = doc.context.obj({}) as PDFDict;
  labels.set(PDFName.of('Nums'), doc.context.obj(arr));
  doc.catalog.set(PDFName.of('PageLabels'), labels);
}

export { PDFArray, PDFRef };

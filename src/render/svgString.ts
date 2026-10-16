/**
 * SVG back-end: display list → SVG markup.
 * Used by the editor (per element, memoised) and by the SVG export (whole pages / spreads).
 */
import type { Paint, Prim, TextRun, PathPrim, ImagePrim, RasterPrim, GroupPrim, TextPrim } from './primitives';
import { fontFeatureCss, fontVariationCss, shape, glyphPath, canOutline, glyphKerns } from '../engine/fonts';

export interface SvgOptions {
  /** Device pixels per pt used to rasterise RasterPrims. */
  pxPerPt: number;
  /** Prefix for generated ids (gradients, clips) — must be unique per document. */
  idPrefix: string;
  /** Convert text to glyph outlines (portable SVG export). */
  outlineText?: boolean;
  /** Hide die lines (3D textures / clean exports). */
  hideDieLines?: boolean;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const n = (v: number) => (Math.abs(v) < 1e-6 ? '0' : String(+v.toFixed(3)));

class Writer {
  defs: string[] = [];
  /** Outlined glyphs are defined once and placed with <use>. */
  glyphIds = new Map<string, string>();
  private counter = 0;
  constructor(public opts: SvgOptions) {}
  id(kind: string) { return `${this.opts.idPrefix}${kind}${this.counter++}`; }

  paint(p: Paint | null | undefined): string {
    if (!p) return 'none';
    if (typeof p === 'string') return p;
    const id = this.id('g');
    const stops = p.stops.map((s) => `<stop offset="${n(s.offset)}" stop-color="${s.color}"${s.opacity != null && s.opacity < 1 ? ` stop-opacity="${n(s.opacity)}"` : ''}/>`).join('');
    if (p.kind === 'linear') {
      this.defs.push(`<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${n(p.x1)}" y1="${n(p.y1)}" x2="${n(p.x2)}" y2="${n(p.y2)}">${stops}</linearGradient>`);
    } else {
      const f = p.fx != null ? ` fx="${n(p.fx)}" fy="${n(p.fy ?? p.cy)}"` : '';
      this.defs.push(`<radialGradient id="${id}" gradientUnits="userSpaceOnUse" cx="${n(p.cx)}" cy="${n(p.cy)}" r="${n(Math.max(0.001, p.r))}"${f}>${stops}</radialGradient>`);
    }
    return `url(#${id})`;
  }
}

function common(p: { opacity?: number; blend?: string }): string {
  let s = '';
  if (p.opacity != null && p.opacity < 1) s += ` opacity="${n(Math.max(0, p.opacity))}"`;
  if (p.blend && p.blend !== 'normal') s += ` style="mix-blend-mode:${p.blend}"`;
  return s;
}

function pathSvg(p: PathPrim, w: Writer): string {
  if (p.role === 'dieline' && w.opts.hideDieLines) return '';
  const fill = w.paint(p.fill);
  const stroke = w.paint(p.stroke);
  let a = `<path d="${p.d}" fill="${fill}"`;
  if (p.fillRule === 'evenodd') a += ' fill-rule="evenodd"';
  if (p.stroke) {
    a += ` stroke="${stroke}" stroke-width="${n(p.strokeWidth ?? 1)}"`;
    if (p.dash && p.dash.length) a += ` stroke-dasharray="${p.dash.map(n).join(' ')}"`;
    if (p.cap && p.cap !== 'butt') a += ` stroke-linecap="${p.cap}"`;
    if (p.join && p.join !== 'miter') a += ` stroke-linejoin="${p.join}"`;
  }
  if (p.role === 'dieline') a += ' vector-effect="non-scaling-stroke" data-role="dieline"';
  return a + common(p) + '/>';
}

function runStyle(r: TextRun): string {
  const f = r.font;
  let s = `font-family:${esc(f.css).replace(/&quot;/g, "'")};font-size:${n(r.size)}px;font-weight:${f.weight};font-kerning:normal;font-optical-sizing:none;white-space:pre`;
  if (f.italic) s += ';font-style:italic';
  const fv = fontVariationCss(f.axes);
  if (fv !== 'normal') s += `;font-variation-settings:${fv.replace(/"/g, "'")}`;
  const ff = fontFeatureCss(f.features);
  if (ff !== 'normal') s += `;font-feature-settings:${ff.replace(/"/g, "'")}`;
  if (r.letterSpacing) s += `;letter-spacing:${n(r.letterSpacing)}px`;
  return s;
}

function runTransform(r: TextRun): string {
  const parts: string[] = [];
  if (r.rotate) parts.push(`rotate(${n(r.rotate)} ${n(r.x)} ${n(r.y)})`);
  if (r.scaleX && r.scaleX !== 1) parts.push(`translate(${n(r.x)} 0) scale(${n(r.scaleX)} 1) translate(${n(-r.x)} 0)`);
  return parts.length ? ` transform="${parts.join(' ')}"` : '';
}

/** Text as glyph outlines (exact in every SVG viewer, no fonts needed). */
function runOutlines(r: TextRun, w: Writer): string | null {
  if (!canOutline(r.text, r.font)) return null;
  const shaped = shape(r.text, r.font);
  const first = shaped && glyphPath(r.font, shaped.glyphs[0]?.id ?? 0);
  if (!shaped || !first) return null;
  const upm = first.upm;
  const k = r.size / upm;
  let x = 0;
  let d = '';
  const ls = r.letterSpacing ?? 0;
  const gk = glyphKerns(shaped, r.kern);
  for (let gi = 0; gi < shaped.glyphs.length; gi++) {
    const g = shaped.glyphs[gi];
    const gp = glyphPath(r.font, g.id);
    if (gp && gp.d) {
      const ox = x + g.xOffset * r.size, oy = -g.yOffset * r.size;
      const key = `${r.font.face}|${JSON.stringify(r.font.axes)}|${g.id}`;
      let id = w.glyphIds.get(key);
      if (!id) {
        id = w.id('gl');
        w.glyphIds.set(key, id);
        w.defs.push(`<path id="${id}" d="${gp.d}"/>`);
      }
      d += `<use href="#${id}" xlink:href="#${id}" transform="translate(${n(r.x + ox)} ${n(r.y + oy)}) scale(${n(k)} ${n(-k)})${r.font.oblique ? ' skewX(12)' : ''}"/>`;
    }
    x += g.xAdvance * r.size + ls + (gk ? gk[gi] : 0);
  }
  return `<g fill="${r.color}"${runTransform(r)}>${d}</g>`;
}

function textSvg(p: TextPrim, w: Writer): string {
  let out = '';
  for (const r of p.runs) {
    // Kerned runs (optical or manual pairs) are drawn from outlines so they match the PDF exactly.
    const kerned = !!r.kern && r.kern.some((k) => k);
    if (w.opts.outlineText || kerned) {
      const o = runOutlines(r, w);
      if (o) { out += o; continue; }
    }
    const dx = kerned ? ` dx="${[0, ...r.kern!.slice(0, -1)].map(n).join(' ')}"` : '';
    out += `<text x="${n(r.x)}" y="${n(r.y)}"${dx} fill="${r.color}" style="${runStyle(r)}"${runTransform(r)}>${esc(r.text)}</text>`;
  }
  return p.opacity != null && p.opacity < 1 || (p.blend && p.blend !== 'normal') ? `<g${common(p)}>${out}</g>` : out;
}

function imageSvg(p: ImagePrim, w: Writer): string {
  let clip = '';
  if (p.clip) {
    const id = w.id('c');
    w.defs.push(`<clipPath id="${id}"><rect x="${n(p.clip.x)}" y="${n(p.clip.y)}" width="${n(p.clip.w)}" height="${n(p.clip.h)}"/></clipPath>`);
    clip = ` clip-path="url(#${id})"`;
  }
  const filter = p.filter === 'grayscale' ? ' style="filter:grayscale(1)"' : '';
  return `<g${clip}${common(p)}><image href="${p.href}" x="${n(p.x)}" y="${n(p.y)}" width="${n(p.w)}" height="${n(p.h)}" preserveAspectRatio="none"${filter}/></g>`;
}

const rasterCache = new Map<string, string>();

export function rasterToDataUrl(p: RasterPrim, pxPerPt: number): string {
  const key = `${p.key}@${pxPerPt}`;
  const hit = rasterCache.get(key);
  if (hit) return hit;
  const W = Math.max(1, Math.min(8192, Math.round(p.w * pxPerPt)));
  const H = Math.max(1, Math.min(8192, Math.round(p.h * pxPerPt)));
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  if (!ctx) return '';
  ctx.setTransform(W / p.w, 0, 0, H / p.h, 0, 0);
  try { p.draw(ctx, W / p.w); } catch { /* a broken raster should never take the page down */ }
  const url = c.toDataURL('image/png');
  rasterCache.set(key, url);
  if (rasterCache.size > 160) rasterCache.delete(rasterCache.keys().next().value!);
  return url;
}

function rasterSvg(p: RasterPrim, w: Writer): string {
  const url = rasterToDataUrl(p, w.opts.pxPerPt);
  return `<image href="${url}" x="${n(p.x)}" y="${n(p.y)}" width="${n(p.w)}" height="${n(p.h)}" preserveAspectRatio="none"${common(p)}/>`;
}

function groupSvg(p: GroupPrim, w: Writer): string {
  let a = '<g';
  if (p.matrix) {
    const m = p.matrix;
    if (!(m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 1 && m[4] === 0 && m[5] === 0)) a += ` transform="matrix(${m.map(n).join(' ')})"`;
  }
  if (p.clip) {
    const id = w.id('c');
    w.defs.push(`<clipPath id="${id}"><path d="${p.clip}"${p.clipRule === 'evenodd' ? ' clip-rule="evenodd"' : ''}/></clipPath>`);
    a += ` clip-path="url(#${id})"`;
  }
  return `${a}${common(p)}>${p.children.map((c) => primSvg(c, w)).join('')}</g>`;
}

function primSvg(p: Prim, w: Writer): string {
  switch (p.t) {
    case 'path': return pathSvg(p, w);
    case 'text': return textSvg(p, w);
    case 'image': return imageSvg(p, w);
    case 'raster': return rasterSvg(p, w);
    case 'group': return groupSvg(p, w);
  }
}

/** Markup for a list of primitives, including any <defs> they need. */
export function primsToSvg(prims: Prim[], opts: SvgOptions): string {
  const w = new Writer(opts);
  const body = prims.map((p) => primSvg(p, w)).join('');
  return (w.defs.length ? `<defs>${w.defs.join('')}</defs>` : '') + body;
}

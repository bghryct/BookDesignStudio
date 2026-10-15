/**
 * Import uploaded SVG markup as vector primitives (so it stays vector in the PDF), or explode
 * it into editable path elements.
 */
import type { Matrix, PathPrim, Prim } from './primitives';
import { IDENTITY, multiply, translate, scale, rotate, ellipsePath, rectPath } from './primitives';
import { transformPath } from '../lib/pathData';

export interface ParsedSvg {
  viewBox: { x: number; y: number; w: number; h: number };
  paths: PathPrim[]; // in viewBox units, transforms baked in
}

function parseTransform(t: string | null): Matrix {
  if (!t) return IDENTITY;
  let m: Matrix = IDENTITY;
  const re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g;
  let x: RegExpExecArray | null;
  while ((x = re.exec(t))) {
    const v = x[2].split(/[\s,]+/).filter(Boolean).map(Number);
    let n: Matrix = IDENTITY;
    switch (x[1]) {
      case 'matrix': n = [v[0], v[1], v[2], v[3], v[4], v[5]]; break;
      case 'translate': n = translate(v[0] || 0, v[1] || 0); break;
      case 'scale': n = scale(v[0], v[1] ?? v[0]); break;
      case 'rotate': n = rotate(v[0], v[1] || 0, v[2] || 0); break;
      case 'skewX': n = [1, 0, Math.tan((v[0] * Math.PI) / 180), 1, 0, 0]; break;
      case 'skewY': n = [1, Math.tan((v[0] * Math.PI) / 180), 0, 1, 0, 0]; break;
    }
    m = multiply(m, n);
  }
  return m;
}

interface Inherited { fill: string | null; stroke: string | null; sw: number; opacity: number; fillOpacity: number; strokeOpacity: number; rule: 'nonzero' | 'evenodd' }

function styleMap(el: Element): Record<string, string> {
  const out: Record<string, string> = {};
  for (const a of ['fill', 'stroke', 'stroke-width', 'opacity', 'fill-opacity', 'stroke-opacity', 'fill-rule', 'display', 'visibility', 'stroke-linecap', 'stroke-linejoin', 'stroke-dasharray']) {
    const v = el.getAttribute(a);
    if (v != null) out[a] = v.trim();
  }
  const style = el.getAttribute('style');
  if (style) for (const decl of style.split(';')) {
    const [k, v] = decl.split(':').map((s) => s?.trim());
    if (k && v) out[k] = v;
  }
  return out;
}

function resolvePaint(v: string | undefined, doc: Document, inherited: string | null): string | null {
  if (v == null) return inherited;
  if (v === 'none' || v === 'transparent') return null;
  if (v === 'currentColor') return inherited ?? '#000';
  const url = v.match(/url\(\s*#([^)]+)\)/);
  if (url) {
    // Gradients collapse to their middle stop — kept vector and editable.
    const g = doc.getElementById(url[1]);
    const stops = g ? [...g.querySelectorAll('stop')] : [];
    const stop = stops[Math.floor(stops.length / 2)];
    return stop ? (styleMap(stop)['stop-color'] ?? stop.getAttribute('stop-color') ?? '#000') : '#000';
  }
  return v;
}

export function parseSvg(markup: string): ParsedSvg | null {
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(markup, 'image/svg+xml');
  } catch {
    return null;
  }
  const svg = doc.documentElement;
  if (!svg || svg.nodeName.toLowerCase() !== 'svg') return null;
  const vbAttr = svg.getAttribute('viewBox')?.split(/[\s,]+/).map(Number);
  const w = parseFloat(svg.getAttribute('width') || '') || vbAttr?.[2] || 100;
  const h = parseFloat(svg.getAttribute('height') || '') || vbAttr?.[3] || 100;
  const viewBox = vbAttr && vbAttr.length === 4 ? { x: vbAttr[0], y: vbAttr[1], w: vbAttr[2], h: vbAttr[3] } : { x: 0, y: 0, w, h };
  const paths: PathPrim[] = [];

  const walk = (node: Element, m: Matrix, inh: Inherited) => {
    const tag = node.nodeName.toLowerCase().replace(/^svg:/, '');
    if (['defs', 'clippath', 'mask', 'lineargradient', 'radialgradient', 'pattern', 'symbol', 'style', 'title', 'desc', 'metadata'].includes(tag)) return;
    const st = styleMap(node);
    if (st.display === 'none' || st.visibility === 'hidden') return;
    const mm = multiply(m, parseTransform(node.getAttribute('transform')));
    const cur: Inherited = {
      fill: resolvePaint(st.fill, doc, inh.fill),
      stroke: resolvePaint(st.stroke, doc, inh.stroke),
      sw: st['stroke-width'] != null ? parseFloat(st['stroke-width']) : inh.sw,
      opacity: inh.opacity * (st.opacity != null ? parseFloat(st.opacity) : 1),
      fillOpacity: st['fill-opacity'] != null ? parseFloat(st['fill-opacity']) : inh.fillOpacity,
      strokeOpacity: st['stroke-opacity'] != null ? parseFloat(st['stroke-opacity']) : inh.strokeOpacity,
      rule: (st['fill-rule'] as Inherited['rule']) ?? inh.rule,
    };
    const num = (a: string) => parseFloat(node.getAttribute(a) || '0');
    let d: string | null = null;
    switch (tag) {
      case 'path': d = node.getAttribute('d'); break;
      case 'rect': d = rectPath(num('x'), num('y'), num('width'), num('height'), num('rx') || num('ry')); break;
      case 'circle': d = ellipsePath(num('cx'), num('cy'), num('r'), num('r')); break;
      case 'ellipse': d = ellipsePath(num('cx'), num('cy'), num('rx'), num('ry')); break;
      case 'line': d = `M${num('x1')} ${num('y1')}L${num('x2')} ${num('y2')}`; break;
      case 'polyline':
      case 'polygon': {
        const pts = (node.getAttribute('points') || '').trim().split(/[\s,]+/).map(Number);
        if (pts.length >= 4) {
          d = `M${pts[0]} ${pts[1]}`;
          for (let i = 2; i + 1 < pts.length; i += 2) d += `L${pts[i]} ${pts[i + 1]}`;
          if (tag === 'polygon') d += 'Z';
        }
        break;
      }
    }
    if (d) {
      const scaleFactor = Math.sqrt(Math.abs(mm[0] * mm[3] - mm[1] * mm[2])) || 1;
      const dash = st['stroke-dasharray'] && st['stroke-dasharray'] !== 'none' ? st['stroke-dasharray'].split(/[\s,]+/).map((v) => parseFloat(v) * scaleFactor) : undefined;
      paths.push({
        t: 'path',
        d: transformPath(d, mm),
        fill: tag === 'line' ? null : cur.fill,
        stroke: cur.stroke,
        strokeWidth: cur.sw * scaleFactor,
        fillRule: cur.rule,
        opacity: cur.opacity * (cur.fill ? cur.fillOpacity : cur.strokeOpacity),
        cap: (st['stroke-linecap'] as PathPrim['cap']) ?? undefined,
        join: (st['stroke-linejoin'] as PathPrim['join']) ?? undefined,
        dash,
      });
    }
    for (const child of Array.from(node.children)) walk(child, mm, cur);
  };
  walk(svg, IDENTITY, { fill: '#000', stroke: null, sw: 1, opacity: 1, fillOpacity: 1, strokeOpacity: 1, rule: 'nonzero' });
  return { viewBox, paths };
}

const parsedCache = new Map<string, ParsedSvg | null>();

export function parseSvgCached(key: string, markup: string): ParsedSvg | null {
  if (!parsedCache.has(key)) parsedCache.set(key, parseSvg(markup));
  return parsedCache.get(key)!;
}

/** Fit an SVG into a w×h box (xMidYMid meet) as primitives. */
export function svgPrims(parsed: ParsedSvg, w: number, h: number, fillOverride: string | null, strokeOverride: string | null): Prim[] {
  const vb = parsed.viewBox;
  const s = Math.min(w / vb.w, h / vb.h);
  const m = multiply(translate((w - vb.w * s) / 2, (h - vb.h * s) / 2), multiply(scale(s), translate(-vb.x, -vb.y)));
  return parsed.paths.map((p) => ({
    ...p,
    d: transformPath(p.d, m),
    strokeWidth: (p.strokeWidth ?? 1) * s,
    dash: p.dash?.map((v) => v * s),
    fill: p.fill && fillOverride ? fillOverride : p.fill,
    stroke: p.stroke && strokeOverride ? strokeOverride : p.stroke,
  }));
}

/** Decode the markup of an SVG data: URL. */
export function svgMarkupFromDataUrl(src: string): string {
  const comma = src.indexOf(',');
  const meta = src.slice(0, comma);
  const data = src.slice(comma + 1);
  return meta.includes('base64') ? decodeURIComponent(escape(atob(data))) : decodeURIComponent(data);
}

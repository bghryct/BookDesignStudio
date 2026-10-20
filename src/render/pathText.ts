/**
 * Type on a path: the story is shaped as one line (kerning and ligatures intact), then each glyph
 * cluster is stood on the path at its own arc length, rotated to the tangent.
 */
import type { PathElement } from '../model/types';
import type { Prim, TextRun } from './primitives';
import { parsePath } from '../lib/pathData';
import { resolveFont, measure, shape, fontMetrics } from '../engine/fonts';

interface Poly { pts: [number, number][]; len: number[] }

/** The first sub-path flattened to a polyline with cumulative lengths. */
function flatten(d: string): Poly {
  const pts: [number, number][] = [];
  let cx = 0, cy = 0, started = false;
  for (const s of parsePath(d)) {
    if (s.c === 'M') { if (started && pts.length > 1) break; cx = s.x; cy = s.y; pts.length = 0; pts.push([cx, cy]); started = true; }
    else if (s.c === 'L') { pts.push([s.x, s.y]); cx = s.x; cy = s.y; }
    else if (s.c === 'C') {
      for (let i = 1; i <= 24; i++) {
        const t = i / 24, u = 1 - t;
        pts.push([u * u * u * cx + 3 * u * u * t * s.x1 + 3 * u * t * t * s.x2 + t * t * t * s.x, u * u * u * cy + 3 * u * u * t * s.y1 + 3 * u * t * t * s.y2 + t * t * t * s.y]);
      }
      cx = s.x; cy = s.y;
    } else if (s.c === 'Z' && pts.length) pts.push([...pts[0]] as [number, number]);
  }
  const len = [0];
  for (let i = 1; i < pts.length; i++) len.push(len[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  return { pts, len };
}

function at(p: Poly, s: number): { x: number; y: number; a: number } {
  const L = p.len[p.len.length - 1];
  const t = Math.max(0, Math.min(L, s));
  let i = 1;
  while (i < p.len.length - 1 && p.len[i] < t) i++;
  const [x0, y0] = p.pts[i - 1], [x1, y1] = p.pts[i];
  const seg = p.len[i] - p.len[i - 1] || 1;
  const k = (t - p.len[i - 1]) / seg;
  return { x: x0 + (x1 - x0) * k, y: y0 + (y1 - y0) * k, a: Math.atan2(y1 - y0, x1 - x0) };
}

export function pathTextPrims(el: PathElement, d: string): Prim[] {
  const pt = el.pathText;
  if (!pt || !pt.text.trim()) return [];
  let poly = flatten(d);
  if (poly.pts.length < 2) return [];
  if (pt.reverse) {
    const pts = [...poly.pts].reverse();
    const len = [0];
    for (let i = 1; i < pts.length; i++) len.push(len[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    poly = { pts, len };
  }
  const L = poly.len[poly.len.length - 1];
  const size = pt.size;
  const font = resolveFont({ family: pt.fontFamily, weight: pt.weight, italic: pt.italic, size, features: pt.features ?? {} });
  const ls = (pt.tracking / 1000) * size;
  const text = pt.text.replace(/\s+/g, ' ');
  // Clusters with their advances from one shaping of the whole line.
  const clusters: { text: string; adv: number }[] = [];
  const shaped = shape(text, font);
  if (shaped && shaped.complete) {
    let u = 0;
    for (const g of shaped.glyphs) {
      const n = Math.max(1, g.units);
      clusters.push({ text: text.slice(u, u + n), adv: g.xAdvance * size + ls });
      u += n;
    }
  } else {
    for (const ch of text) clusters.push({ text: ch, adv: measure(ch, font, size) + ls });
  }
  const total = clusters.reduce((a, c) => a + c.adv, 0);
  const origin = (pt.offset / 100) * L;
  let s = pt.align === 'center' ? origin - total / 2 : pt.align === 'end' ? origin - total : origin;
  const m = fontMetrics(font);
  // Text sits on the path, or hangs below it with its cap height on the line.
  const shift = pt.baselineShift + (pt.side === 'under' ? -m.capHeight * size : 0);
  const runs: TextRun[] = [];
  for (const c of clusters) {
    const mid = s + c.adv / 2;
    if (c.text.trim() && mid >= 0 && mid <= L) {
      const p = at(poly, mid);
      const cos = Math.cos(p.a), sin = Math.sin(p.a);
      const half = (c.adv - ls) / 2;
      // Up from the path (left of the direction of travel) in y-down space is (sin, −cos).
      const x = p.x - cos * half + sin * shift;
      const y = p.y - sin * half - cos * shift;
      runs.push({ x, y, text: c.text, font, size, color: pt.color, rotate: (p.a * 180) / Math.PI, width: c.adv - ls });
    }
    s += c.adv;
  }
  return runs.length ? [{ t: 'text', runs }] : [];
}

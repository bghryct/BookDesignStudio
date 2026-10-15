/**
 * SVG path data: parse → absolute → normalised (M, L, C, Z only).
 * The normalised form is what the node editor edits and what the PDF writer emits.
 */
import type { Matrix } from '../render/primitives';
import { applyMatrix } from '../render/primitives';

export type Seg =
  | { c: 'M'; x: number; y: number }
  | { c: 'L'; x: number; y: number }
  | { c: 'C'; x1: number; y1: number; x2: number; y2: number; x: number; y: number }
  | { c: 'Z' };

const NUM = /-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g;

export function parsePath(d: string): Seg[] {
  const out: Seg[] = [];
  const tokens = d.match(/[a-zA-Z]|-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g) ?? [];
  let i = 0;
  let cmd = '';
  let cx = 0, cy = 0, sx = 0, sy = 0;
  let lastC: { x: number; y: number } | null = null; // last cubic control point (for S)
  let lastQ: { x: number; y: number } | null = null; // last quadratic control point (for T)
  const num = () => parseFloat(tokens[i++]);
  while (i < tokens.length) {
    if (/[a-zA-Z]/.test(tokens[i])) cmd = tokens[i++];
    else if (!cmd) { i++; continue; }
    const rel = cmd === cmd.toLowerCase();
    const C = cmd.toUpperCase();
    const ox = rel ? cx : 0, oy = rel ? cy : 0;
    switch (C) {
      case 'M': {
        cx = ox + num(); cy = oy + num(); sx = cx; sy = cy;
        out.push({ c: 'M', x: cx, y: cy });
        cmd = rel ? 'l' : 'L';
        lastC = lastQ = null;
        break;
      }
      case 'L': cx = ox + num(); cy = oy + num(); out.push({ c: 'L', x: cx, y: cy }); lastC = lastQ = null; break;
      case 'H': cx = ox + num(); out.push({ c: 'L', x: cx, y: cy }); lastC = lastQ = null; break;
      case 'V': cy = oy + num(); out.push({ c: 'L', x: cx, y: cy }); lastC = lastQ = null; break;
      case 'C': {
        const x1 = ox + num(), y1 = oy + num(), x2 = ox + num(), y2 = oy + num(), x = ox + num(), y = oy + num();
        out.push({ c: 'C', x1, y1, x2, y2, x, y });
        lastC = { x: x2, y: y2 }; lastQ = null; cx = x; cy = y;
        break;
      }
      case 'S': {
        const x1 = lastC ? 2 * cx - lastC.x : cx, y1 = lastC ? 2 * cy - lastC.y : cy;
        const x2 = ox + num(), y2 = oy + num(), x = ox + num(), y = oy + num();
        out.push({ c: 'C', x1, y1, x2, y2, x, y });
        lastC = { x: x2, y: y2 }; lastQ = null; cx = x; cy = y;
        break;
      }
      case 'Q': {
        const qx = ox + num(), qy = oy + num(), x = ox + num(), y = oy + num();
        out.push(quadToCubic(cx, cy, qx, qy, x, y));
        lastQ = { x: qx, y: qy }; lastC = null; cx = x; cy = y;
        break;
      }
      case 'T': {
        const qx: number = lastQ ? 2 * cx - lastQ.x : cx, qy: number = lastQ ? 2 * cy - lastQ.y : cy;
        const x = ox + num(), y = oy + num();
        out.push(quadToCubic(cx, cy, qx, qy, x, y));
        lastQ = { x: qx, y: qy }; lastC = null; cx = x; cy = y;
        break;
      }
      case 'A': {
        const rx = num(), ry = num(), rot = num(), large = num(), sweep = num(), x = ox + num(), y = oy + num();
        out.push(...arcToCubics(cx, cy, rx, ry, rot, !!large, !!sweep, x, y));
        cx = x; cy = y; lastC = lastQ = null;
        break;
      }
      case 'Z': out.push({ c: 'Z' }); cx = sx; cy = sy; lastC = lastQ = null; cmd = ''; break;
      default: i++;
    }
  }
  return out;
}

function quadToCubic(x0: number, y0: number, qx: number, qy: number, x: number, y: number): Seg {
  return { c: 'C', x1: x0 + (2 / 3) * (qx - x0), y1: y0 + (2 / 3) * (qy - y0), x2: x + (2 / 3) * (qx - x), y2: y + (2 / 3) * (qy - y), x, y };
}

/** Endpoint-parameterised elliptical arc → cubic Béziers (SVG implementation notes F.6). */
function arcToCubics(x1: number, y1: number, rx: number, ry: number, angle: number, large: boolean, sweep: boolean, x2: number, y2: number): Seg[] {
  if (rx === 0 || ry === 0) return [{ c: 'L', x: x2, y: y2 }];
  const phi = (angle * Math.PI) / 180;
  const cos = Math.cos(phi), sin = Math.sin(phi);
  const dx = (x1 - x2) / 2, dy = (y1 - y2) / 2;
  const x1p = cos * dx + sin * dy, y1p = -sin * dx + cos * dy;
  rx = Math.abs(rx); ry = Math.abs(ry);
  const lam = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lam > 1) { rx *= Math.sqrt(lam); ry *= Math.sqrt(lam); }
  const sign = large === sweep ? -1 : 1;
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  const coef = sign * Math.sqrt(Math.max(0, num / den));
  const cxp = (coef * rx * y1p) / ry, cyp = (-coef * ry * x1p) / rx;
  const cx = cos * cxp - sin * cyp + (x1 + x2) / 2, cy = sin * cxp + cos * cyp + (y1 + y2) / 2;
  const ang = (ux: number, uy: number, vx: number, vy: number) => {
    const a = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
    return a;
  };
  const t1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let dt = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!sweep && dt > 0) dt -= 2 * Math.PI;
  if (sweep && dt < 0) dt += 2 * Math.PI;
  const n = Math.ceil(Math.abs(dt) / (Math.PI / 2));
  const segs: Seg[] = [];
  const d = dt / n;
  const k = (4 / 3) * Math.tan(d / 4);
  let t = t1;
  for (let i = 0; i < n; i++) {
    const c1 = Math.cos(t), s1 = Math.sin(t), c2 = Math.cos(t + d), s2 = Math.sin(t + d);
    const p = (ex: number, ey: number): [number, number] => [cos * rx * ex - sin * ry * ey + cx, sin * rx * ex + cos * ry * ey + cy];
    const [ax, ay] = p(c1 - k * s1, s1 + k * c1);
    const [bx, by] = p(c2 + k * s2, s2 - k * c2);
    const [ex, ey] = p(c2, s2);
    segs.push({ c: 'C', x1: ax, y1: ay, x2: bx, y2: by, x: ex, y: ey });
    t += d;
  }
  return segs;
}

const f = (n: number) => (Math.abs(n) < 1e-9 ? '0' : String(+n.toFixed(3)));

export function serialize(segs: Seg[]): string {
  let d = '';
  for (const s of segs) {
    if (s.c === 'Z') d += 'Z';
    else if (s.c === 'C') d += `C${f(s.x1)} ${f(s.y1)} ${f(s.x2)} ${f(s.y2)} ${f(s.x)} ${f(s.y)}`;
    else d += `${s.c}${f(s.x)} ${f(s.y)}`;
  }
  return d;
}

export function transformSegs(segs: Seg[], m: Matrix): Seg[] {
  return segs.map((s) => {
    if (s.c === 'Z') return s;
    const [x, y] = applyMatrix(m, s.x, s.y);
    if (s.c === 'C') {
      const [x1, y1] = applyMatrix(m, s.x1, s.y1);
      const [x2, y2] = applyMatrix(m, s.x2, s.y2);
      return { c: 'C', x1, y1, x2, y2, x, y };
    }
    return { c: s.c, x, y };
  });
}

export function transformPath(d: string, m: Matrix): string {
  return serialize(transformSegs(parsePath(d), m));
}

export function pathBounds(segs: Seg[]): { x: number; y: number; w: number; h: number } {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const add = (x: number, y: number) => { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); };
  for (const s of segs) {
    if (s.c === 'Z') continue;
    add(s.x, s.y);
    if (s.c === 'C') { add(s.x1, s.y1); add(s.x2, s.y2); }
  }
  if (!isFinite(x0)) return { x: 0, y: 0, w: 0, h: 0 };
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export { NUM };

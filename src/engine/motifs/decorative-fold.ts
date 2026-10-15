/**
 * Folding diagram (Munari): the flat sheet with its creases in the
 * Yoshizawa–Randlett notation — valley folds dashed, mountain folds
 * dash-dot, arrows with a full head for valley and an open head for mountain —
 * panel numbers, fold order and a small side view of the folded sheet.
 */
import type { PathPrim, Prim, TextRun } from '../../render/primitives';
import { rectPath } from '../../render/primitives';
import { clamp } from '../../lib/random';
import { Pen } from '../generators/util';
import type { Pt } from '../generators/util';
import type { MotifDef } from './types';
import { arcTo, okBox, placeRun, readMotifParams, slot } from './decorative-shared';

type FoldKind = 'valley' | 'mountain';

interface Crease {
  /** Vertical crease at x (sheet fraction), or horizontal at y when `horizontal`. */
  at: number;
  horizontal?: boolean;
  kind: FoldKind;
  /** Fold sequence (1 = first). */
  order: number;
  /** Which side moves: -1 left/up side folds over, +1 right/down side folds over. */
  from: -1 | 1;
  /** Draw an arrow for this crease. */
  arrow: boolean;
}

interface Plan {
  name: string;
  cols: number[];
  rows: number[];
  creases: Crease[];
  profile: 'zigzag' | 'gate' | 'roll' | null;
}

function fractions(ws: number[]): number[] {
  const s = ws.reduce((a, b) => a + b, 0) || 1;
  return ws.map((v) => v / s);
}

function planFor(type: number, panels: number): Plan {
  if (type === 1) {
    // Gate fold: outer flaps meet in the middle; with four panels it closes again (double gate).
    const dbl = panels >= 4;
    const cols = dbl ? [1, 1, 1, 1] : [1, 2, 1];
    const f = fractions(cols);
    const creases: Crease[] = [
      { at: f[0], kind: 'valley', order: 1, from: -1, arrow: true },
      { at: 1 - f[f.length - 1], kind: 'valley', order: 1, from: 1, arrow: true },
    ];
    if (dbl) creases.push({ at: 0.5, kind: 'valley', order: 2, from: 1, arrow: true });
    return { name: dbl ? 'Double gate fold' : 'Gate fold', cols: f, rows: [1], creases, profile: 'gate' };
  }
  if (type === 2) {
    // French (cross) fold: right-angle folds, alternating direction.
    const cols = panels <= 5 ? 2 : 4;
    const rows = panels <= 11 ? 2 : 4;
    const creases: Crease[] = [{ at: 0.5, horizontal: true, kind: 'valley', order: 1, from: 1, arrow: true }];
    creases.push({ at: 0.5, kind: 'mountain', order: 2, from: 1, arrow: true });
    if (cols === 4) {
      creases.push({ at: 0.25, kind: 'valley', order: 3, from: -1, arrow: true }, { at: 0.75, kind: 'valley', order: 3, from: 1, arrow: false });
    }
    if (rows === 4) {
      creases.push({ at: 0.25, horizontal: true, kind: 'mountain', order: 4, from: -1, arrow: true }, { at: 0.75, horizontal: true, kind: 'mountain', order: 4, from: 1, arrow: false });
    }
    return { name: 'Cross fold', cols: fractions(new Array(cols).fill(1)), rows: fractions(new Array(rows).fill(1)), creases, profile: null };
  }
  if (type === 3) {
    // Roll fold: each inward panel a little narrower so it rolls inside the last.
    const n = clamp(panels, 3, 10);
    const ws: number[] = [];
    for (let i = 0; i < n; i++) ws.push(1 - 0.035 * Math.max(0, i - 1));
    const f = fractions(ws);
    const creases: Crease[] = [];
    let x = 0;
    for (let i = 0; i < n - 1; i++) {
      x += f[i];
      creases.push({ at: x, kind: 'valley', order: n - 1 - i, from: 1, arrow: true });
    }
    return { name: 'Roll fold', cols: f, rows: [1], creases, profile: 'roll' };
  }
  // Accordion (concertina): alternate valley and mountain.
  const n = clamp(panels, 2, 16);
  const f = fractions(new Array(n).fill(1));
  const creases: Crease[] = [];
  for (let i = 1; i < n; i++) creases.push({ at: i / n, kind: i % 2 ? 'valley' : 'mountain', order: 1, from: 1, arrow: true });
  return { name: 'Accordion fold', cols: f, rows: [1], creases, profile: 'zigzag' };
}

export const FOLD_DIAGRAM: MotifDef = {
  kind: 'fold-diagram',
  label: 'Folding diagram',
  designer: 'munari',
  description:
    'A folding diagram in the origami notation of Yoshizawa and Randlett — dashed valley folds, dash-dot mountain folds, arrows and fold order — for accordion, gate, cross and roll folds: the book as a sheet to be manipulated, as in Munari’s libri illeggibili and Prelibri.',
  defaultSize: { w: 360, h: 230 },
  colors: [
    { label: 'Line', default: '#1b1813' },
    { label: 'Accent', default: '#c8372a' },
  ],
  fontFamily: 'ibm-plex-mono',
  params: [
    { key: 'type', label: 'Fold', min: 0, max: 3, step: 1, default: 0, options: ['Accordion', 'Gate fold', 'Cross fold (French)', 'Roll fold'] },
    { key: 'panels', label: 'Panels', min: 2, max: 16, step: 1, default: 6 },
    { key: 'arrows', label: 'Arrows', min: 0, max: 1, step: 1, default: 1 },
    { key: 'labels', label: 'Labels', min: 0, max: 1, step: 1, default: 1 },
    { key: 'profile', label: 'Side view', min: 0, max: 1, step: 1, default: 1 },
  ],
  generate: (el, ctx) => {
    if (!okBox(el)) return [];
    const p = readMotifParams(FOLD_DIAGRAM, el);
    const line = slot(FOLD_DIAGRAM, el, 0), accent = slot(FOLD_DIAGRAM, el, 1);
    const { w, h } = el;
    const plan = planFor(Math.round(p.type), Math.round(p.panels));
    const arrows = p.arrows >= 0.5, labels = p.labels >= 0.5;
    const showProfile = p.profile >= 0.5 && plan.profile !== null;
    const k = clamp(Math.min(w, h) / 230, 0.25, 2.5);
    const fs = clamp(Math.min(6, h * 0.04, w * 0.035), 1.5, 6);
    const font = ctx.font(el.fontFamily || FOLD_DIAGRAM.fontFamily!, 400);
    const fontB = ctx.font(el.fontFamily || FOLD_DIAGRAM.fontFamily!, 600);

    const pad = clamp(Math.min(w, h) * 0.05, 1, 16);
    const hasH = plan.creases.some((c) => c.horizontal && c.arrow);
    const aTop = arrows ? clamp(h * 0.15, 4, 42) : 0;
    const aSide = arrows && hasH ? clamp(w * 0.08, 4, 36) : 0;
    const legendH = labels ? fs * 2.6 : 0;
    const profH = showProfile ? clamp(h * 0.16, 6, 64) : 0;
    const sx = pad, sy = pad + aTop;
    const sw = Math.max(1, w - 2 * pad - aSide);
    const sh = Math.max(1, h - sy - pad - legendH - (profH ? profH + pad * 0.6 : 0));

    const runs: TextRun[] = [];
    const prims: Prim[] = [];
    const lw = 0.7 * k;
    // Sheet with a faint offset shadow for objecthood.
    prims.push({ t: 'path', d: rectPath(sx + 1.2 * k, sy + 1.2 * k, sw, sh), fill: line, opacity: 0.08 });
    prims.push({ t: 'path', d: rectPath(sx, sy, sw, sh), fill: '#ffffff', stroke: line, strokeWidth: lw, join: 'miter' });

    // Creases.
    const valley = new Pen(), mountain = new Pen();
    for (const c of plan.creases) {
      const pen = c.kind === 'valley' ? valley : mountain;
      if (c.horizontal) pen.move(sx, sy + c.at * sh).line(sx + sw, sy + c.at * sh);
      else pen.move(sx + c.at * sw, sy).line(sx + c.at * sw, sy + sh);
    }
    const dashV = [3.2 * k, 2 * k], dashM = [4.6 * k, 1.5 * k, 0.7 * k, 1.5 * k];
    if (!valley.empty) prims.push({ t: 'path', d: valley.d, fill: null, stroke: line, strokeWidth: 0.55 * k, dash: dashV, cap: 'butt' });
    if (!mountain.empty) prims.push({ t: 'path', d: mountain.d, fill: null, stroke: line, strokeWidth: 0.55 * k, dash: dashM, cap: 'butt' });

    // Panel numbers.
    if (labels && fs >= 1.5) {
      let n = 1;
      let y0 = sy;
      for (const rh of plan.rows) {
        let x0 = sx;
        for (const cw of plan.cols) {
          const cx = x0 + (cw * sw) / 2;
          const cy = y0 + Math.min(rh * sh * 0.5, fs * 2.2);
          if (cw * sw > fs * 1.6 && rh * sh > fs * 1.6) runs.push(placeRun(ctx, String(n), font, fs, cx, cy + fs * 0.35, line, 'center'));
          n++;
          x0 += cw * sw;
        }
        y0 += rh * sh;
      }
    }

    // Arrows: a curved path over the crease, full head for valley, open head for mountain.
    const arrowPen = new Pen(), headFill = new Pen(), headOpen = new Pen();
    const hs = clamp(Math.min(aTop || aSide, 24) * 0.2, 1.2, 5) * (k < 0.6 ? 0.8 : 1);
    const head = (tip: Pt, dir: Pt, open: boolean) => {
      const len = Math.hypot(dir[0], dir[1]) || 1;
      const ux = dir[0] / len, uy = dir[1] / len;
      const bx = tip[0] - ux * hs * 1.5, by = tip[1] - uy * hs * 1.5;
      const pts: Pt[] = [tip, [bx - uy * hs * 0.6, by + ux * hs * 0.6], [bx + uy * hs * 0.6, by - ux * hs * 0.6]];
      if (open) headOpen.poly(pts, true);
      else headFill.poly(pts, true);
    };
    const orders: { x: number; y: number; n: number }[] = [];
    if (arrows) {
      const colEdges = [0];
      for (const c of plan.cols) colEdges.push(colEdges[colEdges.length - 1] + c);
      for (const c of plan.creases) {
        if (!c.arrow) continue;
        if (!c.horizontal) {
          const xf = sx + c.at * sw;
          // Reach: into the neighbouring panels, but never past their centres.
          const idx = colEdges.findIndex((e) => Math.abs(e - c.at) < 1e-6);
          const left = idx > 0 ? (colEdges[idx] - colEdges[idx - 1]) * sw : sw * 0.2;
          const right = idx >= 0 && idx < colEdges.length - 1 ? (colEdges[idx + 1] - colEdges[idx]) * sw : sw * 0.2;
          const reach = Math.min(left, right) * 0.38;
          const xs = xf + c.from * reach, xe = xf - c.from * reach;
          const ys = sy - 1.2 * k, rise = Math.min(aTop * 0.85, reach * 1.1 + 2);
          arrowPen.move(xs, ys).curve(xs, ys - rise * 1.3, xe, ys - rise * 1.3, xe, ys - hs * 0.6);
          head([xe, ys], [0, 1], c.kind === 'mountain');
          if (labels && plan.creases.some((q) => q.order > 1)) orders.push({ x: xf, y: ys - rise * 1.02, n: c.order });
        } else {
          const yf = sy + c.at * sh;
          const reach = Math.min(c.at, 1 - c.at) * sh * 0.4;
          const ys = yf + c.from * reach, ye = yf - c.from * reach;
          const xs = sx + sw + 1.2 * k, rise = Math.min(aSide * 0.85, reach * 1.1 + 2);
          arrowPen.move(xs, ys).curve(xs + rise * 1.3, ys, xs + rise * 1.3, ye, xs + hs * 0.6, ye);
          head([xs, ye], [-1, 0], c.kind === 'mountain');
          if (labels) orders.push({ x: xs + rise * 1.02, y: yf, n: c.order });
        }
      }
    }
    if (!arrowPen.empty) prims.push({ t: 'path', d: arrowPen.d, fill: null, stroke: accent, strokeWidth: 0.6 * k, cap: 'round', join: 'round' });
    if (!headFill.empty) prims.push({ t: 'path', d: headFill.d, fill: accent, join: 'miter' });
    if (!headOpen.empty) prims.push({ t: 'path', d: headOpen.d, fill: '#ffffff', stroke: accent, strokeWidth: 0.5 * k, join: 'miter' });
    // Fold order in small circles at the apex of each arrow.
    if (orders.length && fs >= 1.5) {
      const disc = new Pen();
      const r = fs * 0.72;
      for (const o of orders) {
        disc.circle(o.x, o.y, r);
        runs.push(placeRun(ctx, String(o.n), fontB, fs * 0.9, o.x, o.y + fs * 0.32, '#ffffff', 'center'));
      }
      prims.push({ t: 'path', d: disc.d, fill: accent });
    }

    // Side view of the folded sheet.
    if (showProfile && profH > 3) {
      const py = sy + sh + pad * 0.6;
      const pen = new Pen(), dots = new Pen();
      const pts: Pt[] = [];
      const total = Math.min(sw * 0.42, profH * 3.2);
      const lens = plan.cols.map((c) => c * total);
      if (plan.profile === 'zigzag') {
        const a = (62 * Math.PI) / 180;
        const vx = Math.cos(a), vy = Math.sin(a);
        const segH = Math.min(profH * 0.85, Math.min(...lens) * vy * 2.2);
        const seg = segH / vy;
        let x = sx + sw / 2 - (lens.length * seg * vx) / 2, y = py + profH * 0.5 + segH / 2;
        pts.push([x, y]);
        lens.forEach((_, i) => {
          x += seg * vx;
          y += (i % 2 ? 1 : -1) * seg * vy;
          pts.push([x, y]);
        });
      } else if (plan.profile === 'gate') {
        const mid = lens.length === 4 ? lens[1] + lens[2] : lens[1];
        const flapL = lens[0], flapR = lens[lens.length - 1];
        const a = (58 * Math.PI) / 180;
        const s = Math.min(1, (profH * 0.9) / Math.max(1e-3, Math.max(flapL, flapR) * Math.sin(a)), (sw * 0.9) / Math.max(1e-3, mid));
        const by = py + profH * 0.9;
        const x0 = sx + sw / 2 - (mid * s) / 2;
        pts.push([x0 + flapL * s * Math.cos(a), by - flapL * s * Math.sin(a)], [x0, by], [x0 + mid * s, by], [x0 + mid * s - flapR * s * Math.cos(a), by - flapR * s * Math.sin(a)]);
      } else {
        // Roll: layers nest inward, the creases drawn as concentric half-turns.
        const n = lens.length;
        const g = profH * 0.82;
        const d = g / n;
        const Lp = Math.min(sw * 0.4, profH * 3.4);
        const x0 = sx + sw / 2 - Lp / 2, xr = x0 + Lp, xl = x0 + d * 0.5;
        const base = py + profH * 0.92;
        const yOf = (i: number) => (i % 2 ? base - g + Math.floor(i / 2) * d : base - Math.floor(i / 2) * d);
        pen.move(x0, base);
        for (let i = 0; i < n; i++) {
          const y = yOf(i);
          const right = i % 2 === 0;
          if (i === n - 1) {
            pen.line(right ? xr - Lp * 0.12 : xl + Lp * 0.12, y);
            break;
          }
          const yn = yOf(i + 1);
          const cx = right ? xr : xl;
          pen.line(cx, y);
          const cy = (y + yn) / 2, rad = Math.abs(yn - y) / 2;
          if (right) arcTo(pen, cx, cy, rad, Math.PI / 2, -Math.PI / 2, true);
          else arcTo(pen, cx, cy, rad, -Math.PI / 2, -Math.PI * 1.5, true);
          dots.circle(right ? cx + rad : cx - rad, cy, 0.9 * k);
        }
      }
      if (plan.profile !== 'roll') pen.poly(pts);
      for (let i = 1; i < pts.length - 1; i++) dots.circle(pts[i][0], pts[i][1], 0.9 * k);
      prims.push({ t: 'path', d: pen.d, fill: null, stroke: line, strokeWidth: 0.8 * k, cap: 'round', join: 'round' });
      if (!dots.empty) prims.push({ t: 'path', d: dots.d, fill: accent });
    }

    // Legend: fold name at the left, line key at the right.
    if (labels && fs >= 1.5) {
      const ly = h - pad - fs * 0.6;
      const keyLen = fs * 4;
      const t1 = 'valley', t2 = 'mountain';
      const r1 = placeRun(ctx, t2, font, fs, 0, ly, line, 'left');
      const r0 = placeRun(ctx, t1, font, fs, 0, ly, line, 'left');
      const keyW = keyLen * 2 + r0.width + r1.width + fs * 3;
      let xr = w - pad;
      if (keyW < sw) {
        const x2 = xr - r1.width;
        runs.push({ ...r1, x: x2 });
        const k2 = new Pen().move(x2 - fs * 0.8 - keyLen, ly - fs * 0.3).line(x2 - fs * 0.8, ly - fs * 0.3);
        const x1 = x2 - fs * 0.8 - keyLen - fs * 1.6 - r0.width;
        runs.push({ ...r0, x: x1 });
        const k1 = new Pen().move(x1 - fs * 0.8 - keyLen, ly - fs * 0.3).line(x1 - fs * 0.8, ly - fs * 0.3);
        prims.push({ t: 'path', d: k1.d, fill: null, stroke: line, strokeWidth: 0.55 * k, dash: dashV, cap: 'butt' } as PathPrim);
        prims.push({ t: 'path', d: k2.d, fill: null, stroke: line, strokeWidth: 0.55 * k, dash: dashM, cap: 'butt' } as PathPrim);
        xr = x1 - fs * 0.8 - keyLen - fs * 2;
      }
      const panels = plan.cols.length * plan.rows.length;
      const cap = `${plan.name.toUpperCase()} · ${panels} PANELS`;
      const rc = placeRun(ctx, cap, fontB, fs, pad, ly, line, 'left', fs * 0.06);
      if (rc.width <= xr - pad) runs.push(rc);
    }

    if (runs.length) prims.push({ t: 'text', runs });
    return prims;
  },
};

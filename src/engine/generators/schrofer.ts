/**
 * Jurriaan Schrofer (1926–1990) — "restless typography" and systematic op-art.
 *
 * Schrofer built images out of letters and lines governed by a single rule:
 * text set on concentric rings whose size progresses with the radius, letter
 * grids whose scale or weight follows a field, nested squares that rotate a few
 * degrees per step until a vortex appears. Each kind below is such a system:
 * one rule, applied relentlessly, producing optical movement.
 */
import type { PatternElement, PatternKind } from '../../model/types';
import type { FontRef, Prim, TextRun } from '../../render/primitives';
import { rectPath } from '../../render/primitives';
import { mix } from '../../lib/color';
import { clamp, fbm } from '../../lib/random';
import type { GenContext, Generator } from './context';
import { DEG, Pen, TAU, fillPath, glyphsOf, readParams, strokePath } from './util';
import type { ParamSpec, Pt } from './util';

/* -------------------------------------------------------------------------- */
/* Parameters                                                                  */
/* -------------------------------------------------------------------------- */

const WEIGHT: ParamSpec = { key: 'weight', label: 'Weight', min: 100, max: 900, step: 50, default: 700 };

export const PATTERN_PARAMS: Record<PatternKind, ParamSpec[]> = {
  'text-rings': [
    { key: 'rings', label: 'Rings', min: 2, max: 40, step: 1, default: 12 },
    { key: 'progression', label: 'Scale progression', min: 0, max: 1, step: 0.01, default: 0.8 },
    { key: 'hole', label: 'Centre opening', min: 0, max: 0.7, step: 0.01, default: 0.07 },
    { key: 'fill', label: 'Letter height in ring', min: 0.3, max: 1.3, step: 0.01, default: 0.86 },
    { key: 'twist', label: 'Alternate twist °', min: 0, max: 180, step: 1, default: 9 },
    { key: 'spin', label: 'Spin per ring °', min: -45, max: 45, step: 0.5, default: 0 },
    { key: 'alternate', label: 'Alternate colour', min: 0, max: 1, step: 1, default: 1 },
    { key: 'reverse', label: 'Counter-run odd rings', min: 0, max: 1, step: 1, default: 0 },
    { key: 'cover', label: 'Run to the corners', min: 0, max: 1, step: 1, default: 0 },
    WEIGHT,
  ],
  'wave-letters': [
    { key: 'cols', label: 'Columns', min: 3, max: 60, step: 1, default: 16 },
    { key: 'rows', label: 'Rows (0 = auto)', min: 0, max: 80, step: 1, default: 0 },
    { key: 'mode', label: 'Field (0 sine, 1 ripple, 2 interference, 3 noise)', min: 0, max: 3, step: 1, default: 0 },
    { key: 'frequency', label: 'Frequency', min: 0.1, max: 8, step: 0.05, default: 2 },
    { key: 'angle', label: 'Wave angle °', min: 0, max: 360, step: 1, default: 35 },
    { key: 'phase', label: 'Phase °', min: 0, max: 360, step: 1, default: 0 },
    { key: 'amplitude', label: 'Size swing', min: 0, max: 1, step: 0.01, default: 0.82 },
    { key: 'scale', label: 'Letter size', min: 0.3, max: 2, step: 0.01, default: 1.25 },
    { key: 'weightWave', label: 'Modulate weight', min: 0, max: 1, step: 1, default: 1 },
    { key: 'colorWave', label: 'Modulate colour', min: 0, max: 1, step: 1, default: 0 },
    WEIGHT,
  ],
  'moire-lines': [
    { key: 'mode', label: 'Family (0 lines, 1 circles, 2 rays)', min: 0, max: 2, step: 1, default: 0 },
    { key: 'families', label: 'Families', min: 2, max: 4, step: 1, default: 2 },
    { key: 'spacing', label: 'Pitch pt', min: 1.5, max: 30, step: 0.1, default: 4.5 },
    { key: 'weight', label: 'Line / pitch', min: 0.05, max: 0.95, step: 0.01, default: 0.48 },
    { key: 'angle', label: 'Angle between families °', min: 0, max: 30, step: 0.1, default: 3.5 },
    { key: 'offset', label: 'Centre offset pt', min: 0, max: 120, step: 0.5, default: 14 },
    { key: 'twoColor', label: 'Second family in colour 2', min: 0, max: 1, step: 1, default: 0 },
  ],
  'rotating-squares': [
    { key: 'count', label: 'Steps', min: 3, max: 120, step: 1, default: 40 },
    { key: 'rotation', label: 'Rotation per step °', min: -45, max: 45, step: 0.25, default: 6 },
    { key: 'sides', label: 'Sides', min: 3, max: 8, step: 1, default: 4 },
    { key: 'inscribe', label: 'Inscribe (corners touch)', min: 0, max: 1, step: 1, default: 1 },
    { key: 'shrink', label: 'Shrink (when not inscribed)', min: 0.7, max: 0.995, step: 0.005, default: 0.94 },
    { key: 'style', label: 'Style (0 line, 1 alternate fill)', min: 0, max: 1, step: 1, default: 0 },
    { key: 'stroke', label: 'Line pt', min: 0.1, max: 6, step: 0.05, default: 0.6 },
    { key: 'tiles', label: 'Tiles across', min: 1, max: 8, step: 1, default: 1 },
    { key: 'mirror', label: 'Alternate direction per tile', min: 0, max: 1, step: 1, default: 1 },
  ],
  'radial-bars': [
    { key: 'bars', label: 'Bars', min: 8, max: 360, step: 1, default: 96 },
    { key: 'duty', label: 'Bar width', min: 0.05, max: 0.95, step: 0.01, default: 0.5 },
    { key: 'modulation', label: 'Width modulation', min: 0, max: 1, step: 0.01, default: 0.8 },
    { key: 'lobes', label: 'Lobes', min: 0, max: 24, step: 1, default: 5 },
    { key: 'phase', label: 'Phase °', min: 0, max: 360, step: 1, default: 0 },
    { key: 'inner', label: 'Inner radius', min: 0, max: 0.8, step: 0.01, default: 0.05 },
    { key: 'twist', label: 'Twist °', min: -180, max: 180, step: 1, default: 0 },
    { key: 'cover', label: 'Run to the corners', min: 0, max: 1, step: 1, default: 1 },
    { key: 'alternate', label: 'Alternate colour', min: 0, max: 1, step: 1, default: 0 },
  ],
  'dot-screen': [
    { key: 'spacing', label: 'Screen pitch pt', min: 2.5, max: 40, step: 0.1, default: 7 },
    { key: 'angle', label: 'Screen angle °', min: 0, max: 90, step: 0.5, default: 45 },
    { key: 'mode', label: 'Tone (0 linear, 1 radial, 2 wave, 3 noise)', min: 0, max: 3, step: 1, default: 1 },
    { key: 'direction', label: 'Gradient direction °', min: 0, max: 360, step: 1, default: 90 },
    { key: 'frequency', label: 'Wave / noise frequency', min: 0.2, max: 10, step: 0.1, default: 2 },
    { key: 'minDot', label: 'Smallest dot', min: 0, max: 1, step: 0.01, default: 0.06 },
    { key: 'maxDot', label: 'Largest dot', min: 0.1, max: 1.5, step: 0.01, default: 1.05 },
    { key: 'gamma', label: 'Tone curve', min: 0.3, max: 3, step: 0.05, default: 1 },
    { key: 'invert', label: 'Invert', min: 0, max: 1, step: 1, default: 0 },
    { key: 'ground', label: 'Colour-2 ground', min: 0, max: 1, step: 1, default: 0 },
  ],
  'text-spiral': [
    { key: 'turns', label: 'Turns', min: 1, max: 30, step: 0.5, default: 8 },
    { key: 'inner', label: 'Centre opening', min: 0, max: 0.5, step: 0.01, default: 0.06 },
    { key: 'size', label: 'Letter height / pitch', min: 0.3, max: 1.4, step: 0.01, default: 0.82 },
    { key: 'shrink', label: 'Shrink toward centre', min: 0, max: 1, step: 0.01, default: 0.8 },
    { key: 'tracking', label: 'Tracking (em)', min: -0.1, max: 0.6, step: 0.005, default: 0.02 },
    { key: 'start', label: 'Start angle °', min: 0, max: 360, step: 1, default: 0 },
    { key: 'colorShift', label: 'Fade to colour 2', min: 0, max: 1, step: 1, default: 0 },
    { key: 'cover', label: 'Run to the corners', min: 0, max: 1, step: 1, default: 0 },
    { ...WEIGHT, default: 600 },
  ],
  'letter-grid-scale': [
    { key: 'cols', label: 'Columns', min: 2, max: 40, step: 1, default: 9 },
    { key: 'rows', label: 'Rows (0 = auto)', min: 0, max: 60, step: 1, default: 0 },
    { key: 'mode', label: 'Gradation (0 linear, 1 radial, 2 diamond)', min: 0, max: 2, step: 1, default: 0 },
    { key: 'direction', label: 'Direction °', min: 0, max: 360, step: 1, default: 45 },
    { key: 'minScale', label: 'Smallest', min: 0.02, max: 1, step: 0.01, default: 0.1 },
    { key: 'maxScale', label: 'Largest', min: 0.2, max: 2, step: 0.01, default: 1.15 },
    { key: 'curve', label: 'Progression curve', min: 0.25, max: 4, step: 0.05, default: 1.3 },
    { key: 'colorShift', label: 'Fade to colour 2', min: 0, max: 1, step: 1, default: 0 },
    { ...WEIGHT, default: 800 },
  ],
};

/* -------------------------------------------------------------------------- */
/* Type helper                                                                 */
/* -------------------------------------------------------------------------- */

/** Font + advance cache for one generator call (advances scale linearly with size). */
class Setter {
  private fonts = new Map<number, FontRef>();
  private adv = new Map<string, number>();
  private caps = new Map<FontRef, number>();

  constructor(private ctx: GenContext, private family: string) {}

  font(weight: number): FontRef {
    const wq = Math.round(clamp(weight, 100, 900) / 50) * 50;
    let f = this.fonts.get(wq);
    if (!f) {
      f = this.ctx.font(this.family, wq);
      this.fonts.set(wq, f);
    }
    return f;
  }

  advance(ch: string, font: FontRef, size: number): number {
    const k = `${font.face ?? font.family}|${font.weight}|${ch}`;
    let a = this.adv.get(k);
    if (a === undefined) {
      a = this.ctx.measure(ch, font, 100) / 100;
      this.adv.set(k, a);
    }
    return a * size;
  }

  /** Cap height as a fraction of the em (falls back to a typical 0.7). */
  cap(font: FontRef): number {
    let c = this.caps.get(font);
    if (c === undefined) {
      const m = this.ctx.metrics(font);
      c = m.capHeight > 0.2 && m.capHeight < 1.2 ? m.capHeight : 0.7;
      this.caps.set(font, c);
    }
    return c;
  }
}

/** A run for one glyph whose advance is centred on (px, py), baseline rotated by `phi` (radians). */
function glyphAt(ch: string, font: FontRef, size: number, adv: number, px: number, py: number, phi: number, color: string): TextRun {
  return {
    x: px - Math.cos(phi) * adv / 2,
    y: py - Math.sin(phi) * adv / 2,
    text: ch, font, size, color, width: adv,
    rotate: phi / DEG,
  };
}

const clipBox = (el: PatternElement, children: Prim[]): Prim => ({ t: 'group', clip: rectPath(0, 0, el.w, el.h), children });

const ringText = (s: string) => (s || '').replace(/\s+/g, ' ').trim() || 'SCHROFER';

/* -------------------------------------------------------------------------- */
/* text-rings                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Concentric rings of repeated text. Ring boundaries follow a blend of linear
 * and geometric spacing; with full progression every ring is the previous one
 * scaled — the log-polar letter vortex of Schrofer's covers.
 */
function textRings(el: PatternElement, p: Record<string, number>, T: Setter): Prim[] {
  const { w, h } = el;
  const cx = w / 2, cy = h / 2;
  const R = p.cover ? Math.hypot(w, h) / 2 : Math.min(w, h) / 2;
  const r0 = Math.max(R * p.hole, 0.5);
  const N = Math.round(p.rings);
  const bound = (i: number) => {
    const lin = R - (R - r0) * (i / N);
    const geo = R * Math.pow(r0 / R, i / N);
    return lin + (geo - lin) * p.progression;
  };
  const font = T.font(p.weight);
  const cap = T.cap(font);
  const unit = Array.from(ringText(el.text) + ' ');
  const out: Prim[] = [];
  let glyphs = 0;

  for (let i = 0; i < N && glyphs < 5000; i++) {
    const outer = bound(i), inner = bound(i + 1);
    const band = outer - inner;
    const size = (band * p.fill) / cap;
    if (size < 0.8) continue;
    const reversed = p.reverse > 0 && i % 2 === 1;
    const capPt = size * cap;
    // Baseline on the inner side (feet inward); counter-running rings flip it outward.
    const rb = reversed ? outer - (band - capPt) / 2 : inner + (band - capPt) / 2;
    if (rb <= 0.5) continue;
    const C = TAU * rb;
    const widths = unit.map((ch) => T.advance(ch, font, size));
    const unitW = widths.reduce((a, b) => a + b, 0);
    if (unitW <= 0) continue;
    const reps = Math.max(1, Math.round(C / unitW));
    const extra = (C - reps * unitW) / (reps * unit.length);
    const dir = reversed ? -1 : 1;
    const a0 = -Math.PI / 2 + (i % 2 ? p.twist * DEG : 0) + i * p.spin * DEG;
    const color = p.alternate && i % 2 ? el.color2 : el.color;
    const runs: TextRun[] = [];
    let s = 0;
    for (let r = 0; r < reps; r++) {
      for (let k = 0; k < unit.length; k++) {
        const adv = widths[k];
        const ch = unit[k];
        if (ch !== ' ') {
          const th = a0 + (dir * (s + adv / 2)) / rb;
          const phi = th + (dir * Math.PI) / 2;
          runs.push(glyphAt(ch, font, size, adv, cx + rb * Math.cos(th), cy + rb * Math.sin(th), phi, color));
        }
        s += adv + extra;
      }
    }
    glyphs += runs.length;
    if (runs.length) out.push({ t: 'text', runs });
  }
  return p.cover ? [clipBox(el, out)] : out;
}

/* -------------------------------------------------------------------------- */
/* Fields                                                                      */
/* -------------------------------------------------------------------------- */

/** Scalar field in [0, 1] used to modulate letters and dots. */
function waveField(mode: number, x: number, y: number, w: number, h: number, freq: number, angleDeg: number, phaseDeg: number, seed: number): number {
  const D = Math.hypot(w, h);
  const cx = w / 2, cy = h / 2;
  const a = angleDeg * DEG, ph = phaseDeg * DEG;
  switch (mode) {
    case 1: {
      const d = Math.hypot(x - cx, y - cy) / (D / 2);
      return 0.5 + 0.5 * Math.cos(TAU * freq * d + ph);
    }
    case 2: {
      const o = D * 0.2;
      const d1 = Math.hypot(x - cx - o * Math.cos(a), y - cy - o * Math.sin(a)) / (D / 2);
      const d2 = Math.hypot(x - cx + o * Math.cos(a), y - cy + o * Math.sin(a)) / (D / 2);
      return 0.5 + 0.25 * (Math.cos(TAU * freq * d1 + ph) + Math.cos(TAU * freq * d2 + ph));
    }
    case 3:
      return clamp((fbm((x / D) * freq * 3, (y / D) * freq * 3, 4, seed) - 0.5) * 1.8 + 0.5, 0, 1);
    default: {
      const u = ((x - cx) * Math.cos(a) + (y - cy) * Math.sin(a)) / D;
      return 0.5 + 0.5 * Math.sin(TAU * freq * u + ph);
    }
  }
}

function gridDims(w: number, h: number, cols: number, rows: number): { cols: number; rows: number; cw: number; ch: number } {
  const c = Math.max(1, Math.round(cols));
  const cw = w / c;
  const r = rows > 0 ? Math.round(rows) : Math.max(1, Math.round(h / cw));
  return { cols: c, rows: r, cw, ch: h / r };
}

/* -------------------------------------------------------------------------- */
/* wave-letters                                                                */
/* -------------------------------------------------------------------------- */

/** A letter grid whose size and weight ride a wave field — kinetic optical rhythm. */
function waveLetters(el: PatternElement, p: Record<string, number>, T: Setter): Prim[] {
  const { w, h } = el;
  const g = gridDims(w, h, p.cols, p.rows);
  const glyphs = glyphsOf(el.text, 'SCHROFER');
  const runs: TextRun[] = [];
  const cell = Math.min(g.cw, g.ch);
  let n = 0;
  for (let j = 0; j < g.rows; j++) {
    for (let i = 0; i < g.cols; i++) {
      const x = (i + 0.5) * g.cw, y = (j + 0.5) * g.ch;
      const v = waveField(p.mode, x, y, w, h, p.frequency, p.angle, p.phase, el.seed);
      const f = 1 - p.amplitude * (1 - v);
      const font = T.font(p.weightWave ? 100 + 800 * v : p.weight);
      const cap = T.cap(font);
      const size = (cell * p.scale * f * 0.78) / cap;
      const ch = glyphs[n++ % glyphs.length];
      if (size < 0.4) continue;
      const adv = T.advance(ch, font, size);
      runs.push({
        x: x - adv / 2, y: y + (cap * size) / 2, text: ch, font, size, width: adv,
        color: p.colorWave ? mix(el.color, el.color2, 1 - v) : el.color,
      });
    }
  }
  return runs.length ? [{ t: 'text', runs }] : [];
}

/* -------------------------------------------------------------------------- */
/* moire-lines                                                                 */
/* -------------------------------------------------------------------------- */

/** Two or more families of fine lines, circles or rays, rotated or offset a hair. */
function moireLines(el: PatternElement, p: Record<string, number>): Prim[] {
  const { w, h } = el;
  const cx = w / 2, cy = h / 2;
  const D = Math.hypot(w, h);
  const F = Math.round(p.families);
  const sp = Math.max(p.spacing, (D * 2) / 900); // keep each family under ~450 elements
  const lw = sp * p.weight;
  const out: Prim[] = [];
  for (let f = 0; f < F; f++) {
    const k = f - (F - 1) / 2;
    const color = p.twoColor && f % 2 ? el.color2 : el.color;
    const pen = new Pen();
    if (p.mode === 0) {
      const a = k * p.angle * DEG;
      const ca = Math.cos(a), sa = Math.sin(a);
      const shift = k * p.offset;
      const n = Math.ceil(D / 2 / sp) + 1;
      for (let i = -n; i <= n; i++) {
        const o = i * sp + shift;
        // Line perpendicular offset o along the normal (−sin, cos), length D.
        const x0 = cx - sa * o - ca * (D / 2), y0 = cy + ca * o - sa * (D / 2);
        const x1 = cx - sa * o + ca * (D / 2), y1 = cy + ca * o + sa * (D / 2);
        pen.move(x0, y0).line(x1, y1);
      }
      out.push(strokePath(pen.d, color, lw, { cap: 'butt' }));
    } else if (p.mode === 1) {
      const a = k * p.angle * 6 * DEG;
      const ox = cx + k * p.offset * Math.cos(a), oy = cy + k * p.offset * Math.sin(a);
      const rMax = Math.hypot(Math.max(ox, w - ox), Math.max(oy, h - oy));
      for (let r = sp; r <= rMax + sp; r += sp) pen.circle(ox, oy, r);
      out.push(strokePath(pen.d, color, lw));
    } else {
      // Rays as filled wedges so they thicken outward like real radial line screens.
      const ox = cx + k * p.offset, oy = cy;
      const rMax = Math.hypot(Math.max(ox, w - ox), Math.max(oy, h - oy)) + 2;
      const count = Math.max(12, Math.min(720, Math.round((Math.PI * Math.min(w, h)) / sp)));
      const step = TAU / count;
      const half = (step * p.weight) / 2;
      const rot = k * p.angle * 0.25 * DEG;
      for (let i = 0; i < count; i++) {
        const th = i * step + rot;
        pen.move(ox, oy)
          .line(ox + rMax * Math.cos(th - half), oy + rMax * Math.sin(th - half))
          .line(ox + rMax * Math.cos(th + half), oy + rMax * Math.sin(th + half))
          .close();
      }
      out.push(fillPath(pen.d, color));
    }
  }
  return [clipBox(el, out)];
}

/* -------------------------------------------------------------------------- */
/* rotating-squares                                                            */
/* -------------------------------------------------------------------------- */

function polygon(cx: number, cy: number, R: number, n: number, rot: number): Pt[] {
  const start = n % 2 ? -Math.PI / 2 : -Math.PI / 2 + Math.PI / n;
  const pts: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const a = start + rot + (i * TAU) / n;
    pts.push([cx + R * Math.cos(a), cy + R * Math.sin(a)]);
  }
  return pts;
}

/**
 * Nested polygons, each turned a few degrees. When inscribed, every new square
 * touches the previous one at its corners: R' = R·cos(π/n) / cos(θ − π/n),
 * and the corners trace logarithmic "whirl" curves.
 */
function rotatingSquares(el: PatternElement, p: Record<string, number>): Prim[] {
  const { w, h } = el;
  const n = Math.round(p.sides);
  const cols = Math.round(p.tiles);
  const rows = Math.max(1, Math.round((cols * h) / w));
  const tile = Math.min(w / cols, h / rows);
  const ox = (w - tile * cols) / 2, oy = (h - tile * rows) / 2;
  // Circumradius that fits the polygon's bounding box inside the tile.
  const unit = polygon(0, 0, 1, n, 0);
  const ext = Math.max(...unit.map(([x, y]) => Math.max(Math.abs(x), Math.abs(y))));
  const R0 = tile / 2 / ext;
  const sector = TAU / n;
  const step = p.rotation * DEG;
  const theta = Math.abs(step) % sector;
  const ratio = p.inscribe && theta > 1e-4 ? Math.cos(Math.PI / n) / Math.cos(theta - Math.PI / n) : p.shrink;
  // Keep the live editor responsive: at most ~4000 polygons over all tiles.
  const count = Math.max(2, Math.min(Math.round(p.count), Math.floor(4000 / (cols * rows))));
  const out: Prim[] = [];

  for (let ty = 0; ty < rows; ty++) {
    for (let tx = 0; tx < cols; tx++) {
      const cx = ox + (tx + 0.5) * tile, cy = oy + (ty + 0.5) * tile;
      const sign = p.mirror && (tx + ty) % 2 ? -1 : 1;
      const polys: Pt[][] = [];
      let R = R0, rot = 0;
      for (let i = 0; i < count && R > 0.4; i++) {
        polys.push(polygon(cx, cy, R, n, rot));
        R *= ratio;
        rot += step * sign;
      }
      if (p.style >= 1) {
        // Painter's alternation, expressed as two even-odd paths per tile.
        const a = new Pen(), b = new Pen();
        polys.forEach((pts, i) => {
          a.poly(pts, true);
          if (i > 0) b.poly(pts, true);
        });
        out.push(fillPath(a.d, el.color, { fillRule: 'evenodd' }));
        if (!b.empty) out.push(fillPath(b.d, el.color2, { fillRule: 'evenodd' }));
      } else {
        const pen = new Pen();
        for (const pts of polys) pen.poly(pts, true);
        out.push(strokePath(pen.d, el.color, p.stroke, { join: 'miter', cap: 'butt' }));
      }
    }
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* radial-bars                                                                 */
/* -------------------------------------------------------------------------- */

/** A starburst of bars whose angular width swells and narrows around the circle. */
function radialBars(el: PatternElement, p: Record<string, number>): Prim[] {
  const { w, h } = el;
  const cx = w / 2, cy = h / 2;
  const R = p.cover ? Math.hypot(w, h) / 2 + 1 : Math.min(w, h) / 2;
  const r0 = R * p.inner;
  const N = Math.round(p.bars);
  const twist = p.twist * DEG;
  const steps = Math.abs(twist) > 1e-3 ? 28 : 1;
  const pens = [new Pen(), new Pen()];
  for (let i = 0; i < N; i++) {
    const th = (i / N) * TAU + p.phase * DEG;
    const duty = clamp(p.duty * (1 + p.modulation * Math.sin(p.lobes * th)), 0.02, 0.98);
    const half = (Math.PI / N) * duty;
    const left: Pt[] = [], right: Pt[] = [];
    for (let s = 0; s <= steps; s++) {
      const r = r0 + ((R - r0) * s) / steps;
      const off = twist * Math.pow(r / R, 1.5);
      left.push([cx + r * Math.cos(th - half + off), cy + r * Math.sin(th - half + off)]);
      right.push([cx + r * Math.cos(th + half + off), cy + r * Math.sin(th + half + off)]);
    }
    const pen = pens[p.alternate && i % 2 ? 1 : 0];
    if (steps === 1) {
      pen.poly([left[0], left[1], right[1], right[0]], true);
    } else {
      pen.poly([...left, ...right.reverse()], true);
    }
  }
  const out: Prim[] = [fillPath(pens[0].d, el.color)];
  if (!pens[1].empty) out.push(fillPath(pens[1].d, el.color2));
  return p.cover ? [clipBox(el, out)] : out;
}

/* -------------------------------------------------------------------------- */
/* dot-screen                                                                  */
/* -------------------------------------------------------------------------- */

/** An amplitude-modulated halftone screen as real vector dots. */
function dotScreen(el: PatternElement, p: Record<string, number>): Prim[] {
  const { w, h } = el;
  const D = Math.hypot(w, h);
  // Keep the dot count around ≤ 6000 for the live editor.
  const sp = Math.max(p.spacing, Math.sqrt((w * h) / 6000));
  const a = p.angle * DEG;
  const ca = Math.cos(a), sa = Math.sin(a);
  const dirA = p.direction * DEG;
  const dx = Math.cos(dirA), dy = Math.sin(dirA);
  // Linear tone runs across the box's extent along the direction.
  const span = Math.abs(dx) * w + Math.abs(dy) * h;
  const cx = w / 2, cy = h / 2;
  const n = Math.ceil(D / 2 / sp) + 1;
  const pen = new Pen();
  for (let j = -n; j <= n; j++) {
    for (let i = -n; i <= n; i++) {
      const x = cx + (i * ca - j * sa) * sp;
      const y = cy + (i * sa + j * ca) * sp;
      if (x < -sp || y < -sp || x > w + sp || y > h + sp) continue;
      let v: number;
      switch (p.mode) {
        case 0: v = 0.5 + ((x - cx) * dx + (y - cy) * dy) / span; break;
        case 2: v = waveField(0, x, y, w, h, p.frequency, p.direction, 0, el.seed); break;
        case 3: v = waveField(3, x, y, w, h, p.frequency, 0, 0, el.seed); break;
        default: v = 1 - Math.hypot(x - cx, y - cy) / (D / 2);
      }
      v = Math.pow(clamp(v, 0, 1), p.gamma);
      if (p.invert) v = 1 - v;
      const d = sp * (p.minDot + (p.maxDot - p.minDot) * v);
      if (d < 0.08) continue;
      pen.circle(x, y, d / 2);
    }
  }
  const out: Prim[] = [];
  if (p.ground) out.push(fillPath(rectPath(0, 0, w, h), el.color2));
  out.push(fillPath(pen.d, el.color));
  return [clipBox(el, out)];
}

/* -------------------------------------------------------------------------- */
/* text-spiral                                                                 */
/* -------------------------------------------------------------------------- */

/** Text running inward on an Archimedean spiral r = R − bθ, shrinking toward the eye. */
function textSpiral(el: PatternElement, p: Record<string, number>, T: Setter): Prim[] {
  const { w, h } = el;
  const cx = w / 2, cy = h / 2;
  const R = p.cover ? Math.hypot(w, h) / 2 : Math.min(w, h) / 2;
  const r0 = Math.max(1, R * p.inner);
  const pitch = (R - r0) / p.turns;
  const b = pitch / TAU;
  const font = T.font(p.weight);
  const cap = T.cap(font);
  const sizeAt = (r: number) => {
    const t = clamp((r - r0) / (R - r0), 0, 1);
    return ((pitch * p.size) / cap) * (1 - p.shrink + p.shrink * t);
  };
  const Rb = R - sizeAt(R) * cap; // keep the outermost caps inside the circle
  const text = Array.from(ringText(el.text) + ' ');
  const th0 = p.start * DEG - Math.PI / 2;
  const runs: TextRun[] = [];
  let th = th0, k = 0;
  for (let guard = 0; guard < 8000 && runs.length < 4000; guard++) {
    const r = Rb - b * (th - th0);
    if (r <= r0) break;
    const size = sizeAt(r);
    if (size < 0.5) break;
    const ch = text[k++ % text.length];
    const adv = T.advance(ch, font, size);
    const step = adv + p.tracking * size;
    const thm = th + step / 2 / Math.hypot(r, b);
    const rm = Rb - b * (thm - th0);
    if (ch !== ' ') {
      const tx = -b * Math.cos(thm) - rm * Math.sin(thm);
      const ty = -b * Math.sin(thm) + rm * Math.cos(thm);
      const t = clamp((rm - r0) / (R - r0), 0, 1);
      runs.push(glyphAt(ch, font, size, adv, cx + rm * Math.cos(thm), cy + rm * Math.sin(thm), Math.atan2(ty, tx),
        p.colorShift ? mix(el.color2, el.color, t) : el.color));
    }
    th += step / Math.hypot(rm, b);
  }
  const out: Prim[] = runs.length ? [{ t: 'text', runs }] : [];
  return p.cover ? [clipBox(el, out)] : out;
}

/* -------------------------------------------------------------------------- */
/* letter-grid-scale                                                           */
/* -------------------------------------------------------------------------- */

/** A systematic gradation: the same grid of letters, scaled step by step across the field. */
function letterGridScale(el: PatternElement, p: Record<string, number>, T: Setter): Prim[] {
  const { w, h } = el;
  const g = gridDims(w, h, p.cols, p.rows);
  const glyphs = glyphsOf(el.text, 'SCHROFER');
  const font = T.font(p.weight);
  const cap = T.cap(font);
  const cell = Math.min(g.cw, g.ch);
  const a = p.direction * DEG;
  const dx = Math.cos(a), dy = Math.sin(a);
  const span = Math.abs(dx) * (w - g.cw) + Math.abs(dy) * (h - g.ch) || 1;
  const runs: TextRun[] = [];
  let n = 0;
  for (let j = 0; j < g.rows; j++) {
    for (let i = 0; i < g.cols; i++) {
      const x = (i + 0.5) * g.cw, y = (j + 0.5) * g.ch;
      let t: number;
      if (p.mode === 1) t = 1 - Math.hypot((x - w / 2) / (w / 2 - g.cw / 2 || 1), (y - h / 2) / (h / 2 - g.ch / 2 || 1)) / Math.SQRT2;
      else if (p.mode === 2) t = 1 - (Math.abs(x - w / 2) / (w / 2 - g.cw / 2 || 1) + Math.abs(y - h / 2) / (h / 2 - g.ch / 2 || 1)) / 2;
      else t = 0.5 + ((x - w / 2) * dx + (y - h / 2) * dy) / span;
      t = Math.pow(clamp(t, 0, 1), p.curve);
      const s = p.minScale + (p.maxScale - p.minScale) * t;
      const ch = glyphs[n++ % glyphs.length];
      const size = (cell * 0.8 * s) / cap;
      if (size < 0.4) continue;
      const adv = T.advance(ch, font, size);
      runs.push({
        x: x - adv / 2, y: y + (cap * size) / 2, text: ch, font, size, width: adv,
        color: p.colorShift ? mix(el.color2, el.color, t) : el.color,
      });
    }
  }
  return runs.length ? [{ t: 'text', runs }] : [];
}

/* -------------------------------------------------------------------------- */
/* Entry                                                                       */
/* -------------------------------------------------------------------------- */

export const generatePattern: Generator<PatternElement> = (el, ctx) => {
  if (!(el.w > 0 && el.h > 0)) return [];
  const specs = PATTERN_PARAMS[el.kind] ?? PATTERN_PARAMS['text-rings'];
  const p = readParams(specs, el.params);
  const T = new Setter(ctx, el.fontFamily);
  switch (el.kind) {
    case 'text-rings': return textRings(el, p, T);
    case 'wave-letters': return waveLetters(el, p, T);
    case 'moire-lines': return moireLines(el, p);
    case 'rotating-squares': return rotatingSquares(el, p);
    case 'radial-bars': return radialBars(el, p);
    case 'dot-screen': return dotScreen(el, p);
    case 'text-spiral': return textSpiral(el, p, T);
    case 'letter-grid-scale': return letterGridScale(el, p, T);
    default: return textRings(el, readParams(PATTERN_PARAMS['text-rings'], el.params), T);
  }
};

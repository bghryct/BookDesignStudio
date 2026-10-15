/**
 * Modular grid alphabet, after the spirit of Wim Crouwel's 1967 New Alphabet
 * (an original design — not a copy): every glyph is a set of polylines on a
 * node grid 4 units wide × 6 high (5 × 7 nodes), strokes only horizontal,
 * vertical or at 45°. Curves become 45° chamfers; acute joins are avoided so
 * the strokes stay inside the grid at any weight.
 *
 * Coordinates: x right, y down, cap line y = 0, baseline y = 6. A polyline
 * with a single point is a dot (period, colon, i-dot style marks).
 */
import type { GridTypeElement } from '../../model/types';
import type { Prim } from '../../render/primitives';
import type { Generator } from './context';
import { Pen } from './util';

export interface GridGlyph {
  /** Width of the glyph's centreline box in modules. */
  w: number;
  /** Polylines through grid nodes; `closed` polylines join back to their start. */
  strokes: [number, number][][];
  closed?: number[];
}

type P = [number, number];
const g = (w: number, strokes: P[][], closed?: number[]): GridGlyph => ({ w, strokes, closed });

const OCT: P[] = [[1, 0], [3, 0], [4, 1], [4, 5], [3, 6], [1, 6], [0, 5], [0, 1]];

export const GRID_GLYPHS: Record<string, GridGlyph> = {
  A: g(4, [[[0, 6], [0, 2], [2, 0], [4, 2], [4, 6]], [[0, 4], [4, 4]]]),
  B: g(4, [[[0, 6], [0, 0], [3, 0], [4, 1], [4, 2], [3, 3], [4, 4], [4, 5], [3, 6], [0, 6]], [[0, 3], [3, 3]]]),
  C: g(4, [[[4, 0], [1, 0], [0, 1], [0, 5], [1, 6], [4, 6]]]),
  D: g(4, [[[0, 0], [3, 0], [4, 1], [4, 5], [3, 6], [0, 6]]], [0]),
  E: g(4, [[[4, 0], [0, 0], [0, 6], [4, 6]], [[0, 3], [3, 3]]]),
  F: g(4, [[[4, 0], [0, 0], [0, 6]], [[0, 3], [3, 3]]]),
  G: g(4, [[[4, 0], [1, 0], [0, 1], [0, 5], [1, 6], [4, 6], [4, 3], [2, 3]]]),
  H: g(4, [[[0, 0], [0, 6]], [[4, 0], [4, 6]], [[0, 3], [4, 3]]]),
  I: g(0, [[[0, 0], [0, 6]]]),
  J: g(4, [[[4, 0], [4, 5], [3, 6], [1, 6], [0, 5], [0, 4]]]),
  K: g(4, [[[0, 0], [0, 6]], [[4, 0], [4, 1], [2, 3], [4, 5], [4, 6]], [[0, 3], [2, 3]]]),
  L: g(4, [[[0, 0], [0, 6], [4, 6]]]),
  M: g(6, [[[0, 6], [0, 0], [1, 0], [3, 2], [5, 0], [6, 0], [6, 6]]]),
  N: g(4, [[[0, 6], [0, 0], [1, 0], [4, 3]], [[4, 0], [4, 6]]]),
  O: g(4, [OCT], [0]),
  P: g(4, [[[0, 6], [0, 0], [3, 0], [4, 1], [4, 2], [3, 3], [0, 3]]]),
  Q: g(5, [OCT, [[2, 4], [4, 6], [5, 6]]], [0]),
  R: g(4, [[[0, 6], [0, 0], [3, 0], [4, 1], [4, 2], [3, 3], [0, 3]], [[2, 3], [4, 5], [4, 6]]]),
  S: g(4, [[[4, 0], [1, 0], [0, 1], [0, 2], [1, 3], [3, 3], [4, 4], [4, 5], [3, 6], [0, 6]]]),
  T: g(4, [[[0, 0], [4, 0]], [[2, 0], [2, 6]]]),
  U: g(4, [[[0, 0], [0, 5], [1, 6], [3, 6], [4, 5], [4, 0]]]),
  V: g(4, [[[0, 0], [0, 4], [2, 6], [4, 4], [4, 0]]]),
  W: g(6, [[[0, 0], [0, 6], [1, 6], [3, 4], [5, 6], [6, 6], [6, 0]]]),
  X: g(4, [[[0, 0], [0, 1], [4, 5], [4, 6]], [[4, 0], [4, 1], [0, 5], [0, 6]]]),
  Y: g(4, [[[0, 0], [0, 1], [2, 3], [4, 1], [4, 0]], [[2, 3], [2, 6]]]),
  Z: g(4, [[[0, 0], [4, 0], [4, 1], [0, 5], [0, 6], [4, 6]]]),
  '0': g(4, [[[2, 0], [4, 2], [4, 4], [2, 6], [0, 4], [0, 2]]], [0]),
  '1': g(2, [[[0, 1], [1, 0], [2, 0], [2, 6]]]),
  '2': g(4, [[[0, 0], [3, 0], [4, 1], [4, 2], [3, 3], [1, 3], [0, 4], [0, 6], [4, 6]]]),
  '3': g(4, [[[0, 0], [3, 0], [4, 1], [4, 2], [3, 3], [4, 4], [4, 5], [3, 6], [0, 6]], [[1, 3], [3, 3]]]),
  '4': g(4, [[[3, 6], [3, 0], [2, 0], [0, 2], [0, 4], [4, 4]]]),
  '5': g(4, [[[4, 0], [0, 0], [0, 3], [3, 3], [4, 4], [4, 5], [3, 6], [0, 6]]]),
  '6': g(4, [[[4, 0], [1, 0], [0, 1], [0, 5], [1, 6], [3, 6], [4, 5], [4, 4], [3, 3], [0, 3]]]),
  '7': g(4, [[[0, 0], [4, 0], [4, 1], [1, 4], [1, 6]]]),
  '8': g(4, [[[1, 0], [3, 0], [4, 1], [4, 2], [3, 3], [1, 3], [0, 2], [0, 1]], [[1, 3], [0, 4], [0, 5], [1, 6], [3, 6], [4, 5], [4, 4], [3, 3]]], [0]),
  '9': g(4, [[[0, 6], [3, 6], [4, 5], [4, 1], [3, 0], [1, 0], [0, 1], [0, 2], [1, 3], [4, 3]]]),
  ' ': g(1, []),
  '.': g(0, [[[0, 6]]]),
  ',': g(1, [[[1, 5], [1, 6], [0, 7]]]),
  '-': g(2, [[[0, 3], [2, 3]]]),
  ':': g(0, [[[0, 2]], [[0, 6]]]),
  '/': g(4, [[[0, 6], [0, 5], [4, 1], [4, 0]]]),
  '!': g(0, [[[0, 0], [0, 4]], [[0, 6]]]),
  '?': g(4, [[[0, 0], [3, 0], [4, 1], [4, 2], [3, 3], [2, 3], [2, 4]], [[2, 6]]]),
  "'": g(0, [[[0, 0], [0, 2]]]),
  '"': g(2, [[[0, 0], [0, 2]], [[2, 0], [2, 2]]]),
  '+': g(4, [[[0, 3], [4, 3]], [[2, 1], [2, 5]]]),
  '=': g(4, [[[0, 2], [4, 2]], [[0, 4], [4, 4]]]),
  '(': g(2, [[[2, 0], [1, 0], [0, 1], [0, 5], [1, 6], [2, 6]]]),
  ')': g(2, [[[0, 0], [1, 0], [2, 1], [2, 5], [1, 6], [0, 6]]]),
  '&': g(5, [[[5, 6], [1, 2], [1, 1], [2, 0], [3, 0], [4, 1], [4, 2], [1, 5], [2, 6], [3, 6], [5, 4]]]),
};

/** Cap height in modules, and baseline-to-baseline pitch. */
const CAP = 6;
const LINE = 9;
/** Default space between neighbouring glyph centreline boxes, modules. */
const GAP = 2;

const normalise = (s: string) =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();

function glyphOf(ch: string): GridGlyph | null {
  return GRID_GLYPHS[ch] ?? null;
}

interface Line { glyphs: GridGlyph[]; width: number }

/** Greedy word wrap at a given module size; returns null if a single word cannot fit. */
function wrap(paragraphs: string[], maxModules: number, gap: number): Line[] | null {
  const lines: Line[] = [];
  const widthOf = (gs: GridGlyph[]) => gs.reduce((a, q) => a + q.w, 0) + Math.max(0, gs.length - 1) * gap;
  const space = GRID_GLYPHS[' '];
  for (const para of paragraphs) {
    const words = para.split(/ +/).filter(Boolean).map((wd) => Array.from(wd).map(glyphOf).filter((q): q is GridGlyph => !!q)).filter((q) => q.length);
    let cur: GridGlyph[] = [];
    for (const word of words) {
      const candidate = cur.length ? [...cur, space, ...word] : word;
      if (widthOf(candidate) <= maxModules) {
        cur = candidate;
        continue;
      }
      if (widthOf(word) > maxModules) return null;
      if (cur.length) lines.push({ glyphs: cur, width: widthOf(cur) });
      cur = word;
    }
    lines.push({ glyphs: cur, width: widthOf(cur) });
  }
  return lines;
}

export const generateGridType: Generator<GridTypeElement> = (el) => {
  const { w, h } = el;
  if (!(w > 0 && h > 0)) return [];
  const weight = Math.min(1, Math.max(0.1, el.weight || 0.6));
  const gap = Math.max(0.2 + weight, GAP + el.tracking);
  const paragraphs = normalise(el.text || '').split(/\r?\n/);
  // Module size: the largest m for which the word-wrapped text fits both width and height.
  // For each line budget L, the height allows m ≤ h / ((L−1)·LINE + CAP + weight); within that,
  // binary-search the largest m whose wrap needs at most L lines.
  const fits = (mm: number, L: number) => {
    const wr = wrap(paragraphs, w / mm - weight, gap);
    return wr && wr.length <= L ? wr : null;
  };
  let m = 0;
  let lines: Line[] = [];
  for (let L = 1; L <= 40; L++) {
    const hi = h / ((L - 1) * LINE + CAP + weight);
    if (hi <= m) break;
    let best = fits(hi, L) ? hi : 0;
    if (!best) {
      let lo = m, top = hi;
      for (let it = 0; it < 28; it++) {
        const mid = (lo + top) / 2;
        if (fits(mid, L)) lo = mid;
        else top = mid;
      }
      best = lo > m && fits(lo, L) ? lo : 0;
    }
    if (best > m) {
      m = best;
      lines = fits(best, L) ?? [];
    }
  }
  if (!m || !lines.length) return [];
  const sw = weight * m;
  const ox = sw / 2, oy = sw / 2;
  const out: Prim[] = [];

  if (el.showModules) {
    const grid = new Pen();
    const x0 = ox - m / 2 - Math.ceil((ox - m / 2) / m) * m;
    for (let x = x0; x <= w + 1e-6; x += m) if (x >= 0) grid.move(x, 0).line(x, h);
    const y0 = oy - m / 2 - Math.ceil((oy - m / 2) / m) * m;
    for (let y = y0; y <= h + 1e-6; y += m) if (y >= 0) grid.move(0, y).line(w, y);
    out.push({ t: 'path', d: grid.d, fill: null, stroke: el.color, strokeWidth: Math.max(0.15, m * 0.025), opacity: 0.16 });
  }

  const corner = Math.round(el.corner);
  const strokes = new Pen();
  const dots = new Pen();
  lines.forEach((line, li) => {
    let cx = 0;
    const ly = li * LINE;
    for (const gl of line.glyphs) {
      gl.strokes.forEach((pl, si) => {
        const pts = pl.map(([x, y]) => [ox + (cx + x) * m, oy + (ly + y) * m] as [number, number]);
        if (pts.length === 1) {
          const [x, y] = pts[0];
          const r = sw / 2;
          if (corner === 2) dots.circle(x, y, r);
          else if (corner === 1) {
            const c = r * 0.42;
            dots.poly([[x - r + c, y - r], [x + r - c, y - r], [x + r, y - r + c], [x + r, y + r - c], [x + r - c, y + r], [x - r + c, y + r], [x - r, y + r - c], [x - r, y - r + c]], true);
          } else dots.rect(x - r, y - r, sw, sw);
          return;
        }
        strokes.poly(pts, gl.closed?.includes(si) ?? false);
      });
      cx += gl.w + gap;
    }
  });
  if (!strokes.empty) {
    out.push({
      t: 'path', d: strokes.d, fill: null, stroke: el.color, strokeWidth: sw,
      cap: corner === 2 ? 'round' : 'square',
      join: corner === 2 ? 'round' : corner === 1 ? 'bevel' : 'miter',
    });
  }
  if (!dots.empty) out.push({ t: 'path', d: dots.d, fill: el.color });
  return out;
};

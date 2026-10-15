/**
 * Page geometry: margin canons, modular grids, baseline grids and snap targets.
 */
import type { BookSpec, GridSpec, Margins } from '../model/types';

export type PageSide = 'left' | 'right';

export interface Rect { x: number; y: number; w: number; h: number }

export interface GridGeometry {
  w: number;
  h: number;
  side: PageSide;
  block: Rect;
  cols: { x: number; w: number }[];
  /** Bosshard's second column system (empty when off). */
  cols2: { x: number; w: number }[];
  rows: { y: number; h: number }[];
  baselines: number[];
  microX: number[];
  microY: number[];
  /** Candidate x / y snap lines in page coordinates. */
  snapX: number[];
  snapY: number[];
}

const PHI = (1 + Math.sqrt(5)) / 2;

export type CanonKind =
  | 'van-de-graaf' | 'tschichold-2346' | 'golden' | 'bringhurst' | 'fibonacci'
  | 'manuscript' | 'muller-brockmann' | 'crouwel' | 'ma';

export const CANONS: { id: CanonKind; label: string; source: string; rationale: string }[] = [
  { id: 'van-de-graaf', label: 'Van de Graaf canon', source: 'J. A. van de Graaf (1946), Villard de Honnecourt, Raúl Rosarivo',
    rationale: 'Ninths of the page: the text block takes the proportion of the page and its outer-bottom corner sits on the page diagonal.' },
  { id: 'tschichold-2346', label: 'Tschichold 2 : 3 : 4 : 6', source: 'Jan Tschichold, “The Form of the Book”',
    rationale: 'Inner : top : outer : bottom margins in the ratio 2:3:4:6 — the classical secret canon of late-medieval manuscripts.' },
  { id: 'golden', label: 'Golden progression', source: 'Tschichold / Bringhurst — 1 : 1.618',
    rationale: 'Margins step by √φ (inner → top → outer → bottom) so each is in golden relation to the next-but-one.' },
  { id: 'bringhurst', label: 'Bringhurst proportion', source: 'Robert Bringhurst, “The Elements of Typographic Style” §8',
    rationale: 'Text block shares the page proportion; inner : outer and top : bottom margins in golden ratio.' },
  { id: 'fibonacci', label: 'Fibonacci 3 : 5 : 8 : 13', source: 'Fibonacci series (a rational golden approximation)',
    rationale: 'Successive Fibonacci numbers for inner, top, outer and bottom.' },
  { id: 'manuscript', label: 'Manuscript (Cleves)', source: 'Utrecht book-of-hours practice, c. 1440',
    rationale: 'Generous outer and lower margins to carry marginalia, borders and the hand that holds the book.' },
  { id: 'muller-brockmann', label: 'Müller-Brockmann', source: 'Josef Müller-Brockmann, “Grid Systems in Graphic Design”',
    rationale: 'Tight head margin, deeper foot; margins derived from the field module so the grid feels taut.' },
  { id: 'crouwel', label: 'Crouwel equal', source: 'Wim Crouwel — systematic layouts',
    rationale: 'Equal, machine-like margins; the grid itself carries the composition.' },
  { id: 'ma', label: 'Ma (間) negative space', source: 'Japanese 天地 (heaven/earth) margins, Koichi Sato',
    rationale: 'Large heaven margin, quiet earth; emptiness is an active element of the page.' },
];

export function canonMargins(kind: CanonKind, W: number, H: number): Margins {
  switch (kind) {
    case 'van-de-graaf':
      return { inner: W / 9, top: H / 9, outer: (2 * W) / 9, bottom: (2 * H) / 9 };
    case 'tschichold-2346': {
      const u = W / 18;
      return { inner: 2 * u, top: 3 * u, outer: 4 * u, bottom: 6 * u };
    }
    case 'golden': {
      const s = Math.sqrt(PHI);
      const u = (W * 0.34) / (1 + PHI);
      return { inner: u, top: u * s, outer: u * PHI, bottom: u * PHI * s };
    }
    case 'bringhurst': {
      const k = 0.7;
      const bw = W * k, bh = H * k;
      const hx = W - bw, hy = H - bh;
      return { inner: hx / (1 + PHI), outer: (hx * PHI) / (1 + PHI), top: hy / (1 + PHI), bottom: (hy * PHI) / (1 + PHI) };
    }
    case 'fibonacci': {
      const u = (W * 0.36) / (3 + 8);
      return { inner: 3 * u, top: 5 * u, outer: 8 * u, bottom: 13 * u * Math.min(1, (H / W) / 1.5) };
    }
    case 'manuscript': {
      const u = W / 17;
      return { inner: 2 * u, top: 2.6 * u, outer: 4.4 * u, bottom: 6 * u };
    }
    case 'muller-brockmann':
      return { inner: W / 12, top: H / 16, outer: W / 10, bottom: H / 9 };
    case 'crouwel':
      return { inner: W / 12, top: W / 12, outer: W / 12, bottom: W / 12 };
    case 'ma':
      return { inner: W * 0.12, top: H * 0.17, outer: W * 0.13, bottom: H * 0.11 };
  }
}

/** Text block rectangle for a page shown on a given side of the spread. */
export function textBlock(spec: BookSpec, side: PageSide): Rect {
  const m = spec.margins;
  const facing = spec.facing;
  // On a left-hand page the binding is on the right, so the inner margin is on the right.
  const left = !facing ? m.inner : side === 'left' ? m.outer : m.inner;
  const right = !facing ? m.outer : side === 'left' ? m.inner : m.outer;
  return { x: left, y: m.top, w: Math.max(1, spec.trimW - left - right), h: Math.max(1, spec.trimH - m.top - m.bottom) };
}

export function computeGrid(spec: BookSpec, side: PageSide): GridGeometry {
  const g: GridSpec = spec.grid;
  const block = textBlock(spec, side);
  const ncol = Math.max(1, Math.round(g.columns));
  const nrow = Math.max(1, Math.round(g.rows));
  const colW = (block.w - g.gutter * (ncol - 1)) / ncol;
  const rowH = (block.h - g.rowGutter * (nrow - 1)) / nrow;
  // Columns are mirrored on left pages so column 1 is always at the binding.
  const cols = Array.from({ length: ncol }, (_, i) => ({ x: block.x + i * (colW + g.gutter), w: colW }));
  const rows = Array.from({ length: nrow }, (_, i) => ({ y: block.y + i * (rowH + g.rowGutter), h: rowH }));
  const n2 = Math.max(0, Math.round(g.secondaryColumns ?? 0));
  const col2W = n2 > 0 ? (block.w - g.gutter * (n2 - 1)) / n2 : 0;
  const cols2 = n2 > 0 ? Array.from({ length: n2 }, (_, i) => ({ x: block.x + i * (col2W + g.gutter), w: col2W })) : [];

  const baselines: number[] = [];
  if (g.baseline > 0.5) {
    const first = block.y + g.baselineOffset;
    for (let y = first; y <= block.y + block.h + 0.01; y += g.baseline) baselines.push(y);
  }

  const microX: number[] = [];
  const microY: number[] = [];
  const div = Math.max(1, Math.round(g.microDivisions));
  if (div > 1) {
    for (const c of cols) for (let k = 1; k < div; k++) microX.push(c.x + (c.w * k) / div);
    for (const r of rows) for (let k = 1; k < div; k++) microY.push(r.y + (r.h * k) / div);
  }

  const snapX = [0, spec.trimW, spec.trimW / 2, block.x, block.x + block.w];
  for (const c of cols) snapX.push(c.x, c.x + c.w);
  for (const c of cols2) snapX.push(c.x, c.x + c.w);
  snapX.push(...microX);
  const snapY = [0, spec.trimH, spec.trimH / 2, block.y, block.y + block.h];
  for (const r of rows) snapY.push(r.y, r.y + r.h);
  snapY.push(...microY);

  return { w: spec.trimW, h: spec.trimH, side, block, cols, cols2, rows, baselines, microX, microY, snapX, snapY };
}

/**
 * Müller-Brockmann: make the field rows land on whole baselines, with one empty
 * line as the row gutter. Adjusts bottom margin, row gutter and baseline offset.
 */
export function lockGridToBaseline(spec: BookSpec): Partial<BookSpec> {
  const g = spec.grid;
  const b = g.baseline;
  if (b <= 0.5) return {};
  const available = spec.trimH - spec.margins.top - spec.margins.bottom;
  const totalLines = Math.floor(available / b);
  const rows = Math.max(1, g.rows);
  const linesPerRow = Math.max(1, Math.floor((totalLines - (rows - 1)) / rows));
  const used = (linesPerRow * rows + (rows - 1)) * b;
  return {
    margins: { ...spec.margins, bottom: spec.trimH - spec.margins.top - used },
    grid: { ...g, rowGutter: b, baselineOffset: b },
  };
}

/** Lines of the classical canon construction for a spread (spread coordinates). */
export function canonLines(spec: BookSpec): [number, number, number, number][] {
  const W = spec.trimW, H = spec.trimH;
  if (!spec.facing) return [[0, 0, W, H], [0, H, W, 0]];
  return [
    [0, H, 2 * W, 0],   // spread diagonals
    [0, 0, 2 * W, H],
    [0, H, W, 0],       // page diagonals: outer-bottom → inner-top
    [W, 0, 2 * W, H],
  ];
}

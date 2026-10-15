/**
 * Diagrams of the book itself, read from the BookSpec: Tschichold’s canon construction,
 * Diehl’s flat case and sheetwise imposition, and the Japanese stab-binding thread path.
 */
import type { BookSpec, Margins, MotifElement } from '../../model/types';
import type { Prim, TextRun } from '../../render/primitives';
import { computeBinding, type Panel } from '../binding';
import { canonMargins } from '../grid';
import { Pen } from '../generators/util';
import type { MotifContext, MotifDef } from './types';
import { motifColor } from './types';
import {
  BLUE, FINE, HAIR, INK, ONOFF, PAPER, RED, RULE, arrowHead, choice, clamp, dimH, dimV, fill, finite,
  fitBox, fitLabel, fmtLen, fmtNum, fmtSize, generator, invertedRun, labelFonts, labelSize, run, stroke,
  textPrim, textWidth, vrun, type DimStyle, type Params,
} from './diagrams-kit';

type Pt = [number, number];

/** Trim size with guards against an unset or degenerate book. */
function trim(book: BookSpec): { W: number; H: number } {
  const W = finite(book.trimW, 0) > 1 ? book.trimW : 432;
  const H = finite(book.trimH, 0) > 1 ? book.trimH : 648;
  return { W, H };
}

/* -------------------------------------------------------------------------- */
/* 7. Canon construction — Tschichold                                          */
/* -------------------------------------------------------------------------- */

const CANON_NAMES = ['Van de Graaf canon', 'Tschichold 2 : 3 : 4 : 6', 'Golden progression'];

/**
 * The widest stretch of [a, b] along `axis` that none of the segments crosses inside the
 * band `at ± half` on the other axis — a clear spot for a label among construction lines.
 */
function freeSpan(segs: [Pt, Pt][], axis: 'x' | 'y', at: number, half: number, a: number, b: number): [number, number] {
  const m = axis === 'x' ? 0 : 1, o = 1 - m;
  const lo = at - half, hi = at + half;
  const blocked: [number, number][] = [];
  for (const [p, q] of segs) {
    if (Math.max(p[o], q[o]) < lo || Math.min(p[o], q[o]) > hi) continue;
    const d = q[o] - p[o];
    const t1 = Math.abs(d) < 1e-9 ? 0 : clamp((lo - p[o]) / d, 0, 1);
    const t2 = Math.abs(d) < 1e-9 ? 1 : clamp((hi - p[o]) / d, 0, 1);
    const m1 = p[m] + (q[m] - p[m]) * t1, m2 = p[m] + (q[m] - p[m]) * t2;
    blocked.push([Math.min(m1, m2), Math.max(m1, m2)]);
  }
  blocked.sort((u, v) => u[0] - v[0]);
  let best: [number, number] = [a, a];
  let cur = a;
  const offer = (s0: number, s1: number) => {
    const u = Math.max(a, s0), v = Math.min(b, s1);
    if (v - u > best[1] - best[0]) best = [u, v];
  };
  for (const [u, v] of blocked) {
    if (u > cur) offer(cur, u);
    cur = Math.max(cur, v);
  }
  if (b > cur) offer(cur, b);
  return best;
}

function drawCanon(el: MotifElement, ctx: MotifContext, p: Params, def: MotifDef): Prim[] {
  const { w, h } = el;
  const cPage = motifColor(def, el, 0), cCon = motifColor(def, el, 1), cBlock = motifColor(def, el, 2);
  const { W, H } = trim(ctx.book);
  const canon = choice(p.canon, 0, 2);
  const lab = p.labels >= 0.5 ? labelSize(w, h, 6, 120) : 0;
  const { mono, sans } = labelFonts(ctx);
  const capBand = lab ? lab * 1.6 + 3 : 0;
  const pad = Math.min(4, w * 0.02, h * 0.02);
  const { s, ox, oy } = fitBox(2 * W, H, pad, pad, w - 2 * pad, h - 2 * pad - capBand);
  if (!(s > 0)) return [];
  const X = (x: number) => ox + x * s, Y = (y: number) => oy + y * s;
  const seg = (pen: Pen, a: Pt, b: Pt) => pen.move(X(a[0]), Y(a[1])).line(X(b[0]), Y(b[1]));
  const lines: [Pt, Pt][] = [];
  const con = new Pen();
  const conSeg = (a: Pt, b: Pt) => {
    lines.push([a, b]);
    seg(con, a, b);
  };

  const m: Margins = canonMargins(canon === 0 ? 'van-de-graaf' : canon === 1 ? 'tschichold-2346' : 'golden', W, H);
  const bw = Math.max(0, W - m.inner - m.outer), bh = Math.max(0, H - m.top - m.bottom);
  const out: Prim[] = [];

  // Text blocks (outer margin on the outside of each page).
  const blocks = new Pen().rect(X(m.outer), Y(m.top), bw * s, bh * s).rect(X(W + m.inner), Y(m.top), bw * s, bh * s);
  out.push(...fill(blocks, cBlock, 0.12));

  if (canon === 0 && p.ninths >= 0.5) {
    const g = new Pen();
    for (let i = 1; i < 9; i++) {
      for (const x0 of [0, W]) seg(g, [x0 + (i * W) / 9, 0], [x0 + (i * W) / 9, H]);
      seg(g, [0, (i * H) / 9], [2 * W, (i * H) / 9]);
    }
    out.push(...stroke(g, cCon, FINE, { opacity: 0.35 }));
  }

  // Construction: spread diagonals and the page diagonals from outer-foot to inner-head.
  conSeg([0, H], [2 * W, 0]);
  conSeg([0, 0], [2 * W, H]);
  conSeg([0, H], [W, 0]);
  conSeg([W, 0], [2 * W, H]);
  const dots = new Pen();
  const r = clamp(s * Math.min(W, H) * 0.008, 0.8, 1.6);
  if (canon === 0) {
    // Van de Graaf: where page and spread diagonals cross (one third down), rise to the
    // head; join that point to the crossing on the facing page. That line meets the page
    // diagonal at the inner-head corner of the text block — ninths of the page.
    const PL: Pt = [(2 * W) / 3, H / 3], PR: Pt = [(4 * W) / 3, H / 3];
    const QL: Pt = [(2 * W) / 3, 0], QR: Pt = [(4 * W) / 3, 0];
    conSeg(PL, QL);
    conSeg(PR, QR);
    conSeg(QR, PL);
    conSeg(QL, PR);
    for (const q of [PL, PR, QL, QR, [(8 * W) / 9, H / 9], [(10 * W) / 9, H / 9], [(16 * W) / 9, H / 9], [(2 * W) / 9, H / 9], [(16 * W) / 9, (7 * H) / 9], [(2 * W) / 9, (7 * H) / 9]] as Pt[]) {
      dots.circle(X(q[0]), Y(q[1]), r);
    }
  }
  out.push(...stroke(con, cCon, HAIR), ...fill(dots, cCon));
  out.push(...stroke(blocks, cBlock, 0.6));
  out.push(...stroke(new Pen().rect(X(0), Y(0), W * s, H * s).rect(X(W), Y(0), W * s, H * s), cPage, RULE));

  if (!lab) return out;

  // Ninth divisions along the edges.
  if (canon === 0) {
    const t = new Pen();
    const tl = Math.min(3, W * s * 0.03);
    for (let i = 1; i < 9; i++) {
      for (const x0 of [0, W]) {
        const x = X(x0 + (i * W) / 9);
        t.move(x, Y(0)).line(x, Y(0) + tl).move(x, Y(H)).line(x, Y(H) - tl);
      }
      const y = Y((i * H) / 9);
      t.move(X(0), y).line(X(0) + tl, y).move(X(2 * W), y).line(X(2 * W) - tl, y);
    }
    out.push(...stroke(t, cPage, HAIR));
  }

  // Margin labels on the recto: ratio and length.
  const ratios = canon === 0 ? ['1/9', '1/9', '2/9', '2/9']
    : canon === 1 ? ['2', '3', '4', '6']
      : [1, m.top / m.inner, m.outer / m.inner, m.bottom / m.inner].map((v) => fmtNum(v, 2));
  const lens = [m.inner, m.top, m.outer, m.bottom];
  const runs: TextRun[] = [];
  // Each label goes in the widest stretch of its margin that no construction line crosses.
  const place = (i: number, side: 'side' | 'head', x0: number, x1: number, y0: number, y1: number) => {
    const full = `${ratios[i]} · ${fmtLen(lens[i], ctx.unit)}`;
    const roomW = (x1 - x0) * s, roomH = (y1 - y0) * s;
    for (const t of [full, ratios[i]]) {
      const tw = textWidth(ctx, t, mono, lab);
      if (side === 'side') {
        const horiz = tw <= roomW - 2;
        if (!horiz && (lab > roomW || tw > roomH - 2)) continue;
        const cx = (x0 + x1) / 2;
        const [a, b] = freeSpan(lines, 'y', cx, ((horiz ? tw : lab) / 2 + 1) / s, y0, y1);
        const along = horiz ? lab : tw;
        const cy = (b - a) * s >= along + 3 ? (a + b) / 2 : (y0 + y1) / 2;
        runs.push(horiz ? run(ctx, t, mono, lab, X(cx), Y(cy) + lab * 0.35, cBlock, 'center') : vrun(ctx, t, mono, lab, X(cx), Y(cy), cBlock));
        return;
      }
      if (tw > roomW - 2 || lab > roomH) continue;
      const cy = (y0 + y1) / 2;
      const [a, b] = freeSpan(lines, 'x', cy, (lab / 2 + 1) / s, x0, x1);
      const cx = (b - a) * s >= tw + 3 ? (a + b) / 2 : (x0 + x1) / 2;
      runs.push(run(ctx, t, mono, lab, X(cx), Y(cy) + lab * 0.35, cBlock, 'center'));
      return;
    }
  };
  place(0, 'side', W, W + m.inner, 0, H);
  place(1, 'head', W + m.inner, W + m.inner + bw, 0, m.top);
  place(2, 'side', 2 * W - m.outer, 2 * W, 0, H);
  place(3, 'head', W + m.inner, W + m.inner + bw, H - m.bottom, H);
  out.push(...textPrim(runs));

  const caption = `${CANON_NAMES[canon]} · page ${fmtSize(W, H, ctx.unit)} · text block ${fmtSize(bw, bh, ctx.unit)}`;
  const t = fitLabel(ctx, caption, sans, lab, w - 2 * pad);
  if (t) out.push(...textPrim([run(ctx, t, sans, lab, w / 2, Math.min(h - 1, Y(H) + lab * 1.4 + 2), cPage, 'center')]));
  return out;
}

export const canonDiagram: MotifDef = {
  kind: 'canon-diagram',
  label: 'Canon construction',
  designer: 'tschichold',
  description: 'The Van de Graaf construction of the late-medieval page on a spread of this book’s proportion — diagonals, the rise to the head and the ninths it yields — as Tschichold reconstructed it in “The Form of the Book”, with his 2 : 3 : 4 : 6 and golden canons for comparison.',
  defaultSize: { w: 380, h: 270 },
  colors: [
    { label: 'Pages', default: INK },
    { label: 'Construction', default: RED },
    { label: 'Text block', default: BLUE },
  ],
  params: [
    { key: 'canon', label: 'Canon', min: 0, max: 2, step: 1, default: 0, options: ['Van de Graaf', 'Tschichold 2:3:4:6', 'Golden'] },
    { key: 'labels', label: 'Labels & ninths', min: 0, max: 1, step: 1, default: 1, options: ONOFF },
    { key: 'ninths', label: '9 × 9 grid', min: 0, max: 1, step: 1, default: 0, options: ONOFF },
  ],
  generate: generator(() => canonDiagram, drawCanon),
};

/* -------------------------------------------------------------------------- */
/* 12. Case-making diagram — Diehl                                             */
/* -------------------------------------------------------------------------- */

/**
 * Covering material for a board area: the rectangle grown by the turn-in, its corners cut
 * at 45° so that the cut passes `mitre` from each board corner (Diehl: about one and a half
 * board thicknesses — enough cloth to cover the corner, not so much that it lumps).
 */
function mitredOutline(x0: number, y0: number, x1: number, y1: number, wrap: number, mitre: number): Pt[] {
  const k = Math.SQRT2 * Math.max(0, mitre);
  const d = clamp(wrap - k, -wrap, Math.min(x1 - x0, y1 - y0) / 2);
  return [
    [x0 + d, y0 - wrap], [x1 - d, y0 - wrap], [x1 + wrap, y0 + d], [x1 + wrap, y1 - d],
    [x1 - d, y1 + wrap], [x0 + d, y1 + wrap], [x0 - wrap, y1 - d], [x0 - wrap, y0 + d],
  ];
}

const BINDING_NAMES: Record<string, string> = {
  case: 'Case binding', perfect: 'Perfect binding', smyth: 'Smyth-sewn soft cover', munari: 'Sewn soft cover',
  coptic: 'Coptic binding', stab: 'Stab binding',
};

function drawCase(el: MotifElement, ctx: MotifContext, p: Params, def: MotifDef): Prim[] {
  const { w, h } = el;
  const cLine = motifColor(def, el, 0), cCloth = motifColor(def, el, 1), cBoard = motifColor(def, el, 2);
  const cFold = motifColor(def, el, 3), cDim = motifColor(def, el, 4);
  const calc = computeBinding(ctx.book);
  const unit = ctx.unit;
  const lab = labelSize(w, h, 6, 140);
  const dims = p.dims >= 0.5 && lab > 0;
  const names = p.names >= 0.5 && lab > 0;
  const { mono, sans } = labelFonts(ctx);
  const hard = calc.type === 'case', coptic = calc.type === 'coptic';
  const soft = !hard && !coptic;

  const panels = hard ? calc.panels.filter((q) => q.id !== 'front-flap' && q.id !== 'back-flap') : calc.panels;
  if (!panels.length) return [];
  const X0 = Math.min(...panels.map((q) => q.x));
  const X1 = Math.max(...panels.map((q) => q.x + q.w));
  const CW = Math.max(1, X1 - X0), CH = Math.max(1, calc.coverH);
  const wrap = Math.max(0, finite(calc.wrap));

  const bandTop = dims ? lab * 1.2 + 9 : 2;
  const bandRight = dims ? lab * 1.4 + 9 : 2;
  const bandBottom = (dims ? lab * 1.2 + 9 : 2) + (lab ? lab * 1.3 + 3 : 0);
  const bandLeft = dims ? 9 : 2;
  const { s, ox, oy } = fitBox(CW + 2 * wrap, CH + 2 * wrap, bandLeft, bandTop, w - bandLeft - bandRight, h - bandTop - bandBottom);
  if (!(s > 0)) return [];
  const X = (x: number) => ox + (x - X0 + wrap) * s;
  const Y = (y: number) => oy + (y + wrap) * s;
  const poly = (pen: Pen, pts: Pt[]) => pen.poly(pts.map(([x, y]) => [X(x), Y(y)] as Pt), true);
  const rect = (pen: Pen, x: number, y: number, ww: number, hh: number) => pen.rect(X(x), Y(y), ww * s, hh * s);
  const find = (id: Panel['id']) => panels.find((q) => q.id === id);
  const back = find('back'), front = find('front'), spine = find('spine');
  const out: Prim[] = [];

  // Material: cloth with mitred corners (case, coptic per board) or the trimmed cover with bleed.
  const material = new Pen(), turnIn = new Pen(), boards = new Pen(), inlay = new Pen();
  if (hard) {
    poly(material, mitredOutline(X0, 0, X1, CH, wrap, calc.cornerMitre));
    rect(turnIn, X0, 0, CW, CH);
    for (const b of [back, front]) if (b) rect(boards, b.x, 0, b.w, CH);
    if (spine) rect(inlay, spine.x, 0, spine.w, CH);
  } else if (coptic) {
    for (const b of [back, front]) {
      if (!b) continue;
      poly(material, mitredOutline(b.x, 0, b.x + b.w, CH, wrap, calc.cornerMitre));
      rect(turnIn, b.x, 0, b.w, CH);
      rect(boards, b.x, 0, b.w, CH);
    }
  } else {
    rect(material, X0, 0, CW, CH);
    if (spine) rect(inlay, spine.x, 0, spine.w, CH);
  }
  out.push(...fill(material, cCloth));
  if (soft && wrap > 0) out.push(...stroke(new Pen().rect(X(X0 - wrap), Y(-wrap), (CW + 2 * wrap) * s, (CH + 2 * wrap) * s), cFold, FINE, { dash: [1.5, 1.5] }));
  out.push(...fill(boards, cBoard), ...fill(inlay, cBoard, 0.5));

  // Coptic: the sewn spine is left bare; mark the stations where the link stitches run.
  if (coptic && spine) {
    const st = new Pen(), knots = new Pen();
    const drop = (CH - ctx.book.trimH) / 2;
    for (const y of calc.stations) {
      const yy = Y(y + drop);
      st.move(X(spine.x), yy).line(X(spine.x + spine.w), yy);
      knots.circle(X(spine.x), yy, 0.9).circle(X(spine.x + spine.w), yy, 0.9);
    }
    out.push(...stroke(new Pen().rect(X(spine.x), Y(0), spine.w * s, CH * s), cLine, HAIR, { dash: [2, 1.5] }));
    out.push(...stroke(st, cLine, 0.7), ...fill(knots, cLine));
  }

  // Raised bands across the spine.
  if (hard && spine && calc.bands.length) {
    const bands = new Pen();
    for (const y of calc.bands) {
      bands.move(X(spine.x), Y(y) - 0.6).line(X(spine.x + spine.w), Y(y) - 0.6);
      bands.move(X(spine.x), Y(y) + 0.6).line(X(spine.x + spine.w), Y(y) + 0.6);
    }
    out.push(...stroke(bands, cLine, HAIR));
  }

  out.push(...stroke(material, cLine, RULE), ...stroke(boards, cLine, RULE), ...stroke(inlay, cLine, HAIR));
  if (!soft) out.push(...stroke(turnIn, cFold, HAIR, { dash: [3, 2] }));

  // Folds, hinges and scores.
  const folds = new Pen(), hinges = new Pen(), scores = new Pen();
  const yTop = soft ? 0 : -wrap, yBot = soft ? CH : CH + wrap;
  for (const f of calc.folds) {
    if (f.x < X0 - 0.01 || f.x > X1 + 0.01) continue;
    const pen = f.kind === 'score' ? scores : f.kind === 'hinge' ? hinges : folds;
    pen.move(X(f.x), Y(yTop)).line(X(f.x), Y(yBot));
  }
  out.push(
    ...stroke(folds, cFold, HAIR, { dash: [3, 2] }),
    ...stroke(hinges, cFold, HAIR, { dash: [1, 1.5] }),
    ...stroke(scores, cFold, 0.5, { dash: [0.4, 1.6], cap: 'round' }),
  );

  const runs: TextRun[] = [];
  if (names) {
    for (const q of panels) {
      const pw = q.w * s;
      let mid = CH / 2;
      // On a spine crossed by raised bands or coptic stitches, use the clear panel nearest
      // the middle; if none can hold the name, leave it out.
      const dividers = q.id !== 'spine' ? [] : hard ? calc.bands : coptic ? calc.stations.map((y) => y + (CH - ctx.book.trimH) / 2) : [];
      if (dividers.length) {
        const edges = [0, ...dividers, CH];
        const need = (textWidth(ctx, q.label, sans, lab) + 4) / s;
        const fitting = edges.slice(1).map((b, k) => [edges[k], b] as Pt).filter(([a, b]) => b - a >= need);
        if (!fitting.length) continue;
        const near = fitting.reduce((u, v) => (Math.abs((v[0] + v[1]) / 2 - CH / 2) < Math.abs((u[0] + u[1]) / 2 - CH / 2) ? v : u));
        mid = (near[0] + near[1]) / 2;
      }
      const cx = X(q.x + q.w / 2), cy = Y(mid);
      const name = q.id.startsWith('hinge') ? `${q.label} ${fmtLen(q.w, unit)}` : q.label;
      const tw = textWidth(ctx, name, sans, lab);
      if (tw <= pw - 4) runs.push(run(ctx, name, sans, lab, cx, cy + lab * 0.35, cLine, 'center'));
      else if (lab <= pw - 1 && tw <= CH * s - 4) runs.push(vrun(ctx, name, sans, lab, cx, cy, cLine));
    }
    for (const f of calc.folds) {
      if (f.kind !== 'score' || f.x < X0 || f.x > X1) continue;
      const t = 'score', ts = lab * 0.85, tw = textWidth(ctx, t, mono, ts);
      // Label on the outer side of the score, away from the spine fold.
      const out = spine && f.x < spine.x + spine.w / 2 ? -1 : 1;
      if (tw < CH * s * 0.3) runs.push(vrun(ctx, t, mono, ts, X(f.x) + out * ts * 0.65, Y(CH) - tw / 2 - 3, cFold));
    }
  }
  out.push(...textPrim(runs));

  if (dims) {
    const st: DimStyle = { ctx, font: mono, size: lab, color: cDim, term: 0, k: 0.8 };
    const yd = Y(-wrap) - 5;
    for (const q of panels) {
      if (q.id.startsWith('hinge')) continue;
      out.push(...dimH(st, X(q.x), X(q.x + q.w), yd, fmtLen(q.w, unit), false, q.id === 'spine' ? 'center' : 'after'));
    }
    out.push(...dimV(st, X(X1) + wrap * s + 5, Y(0), Y(CH), fmtLen(CH, unit)));
    const yb = Y(CH + wrap) + 5;
    if (wrap > 0) out.push(...dimH(st, X(X0 - wrap), X(X0), yb, `${soft ? 'bleed' : 'turn-in'} ${fmtLen(wrap, unit)}`, true));
    const joint = find('hinge-front');
    if (joint && joint.w > 0) out.push(...dimH(st, X(joint.x), X(joint.x + joint.w), yb, `joint ${fmtLen(joint.w, unit)}`, true));
  }

  if (lab) {
    const kind = BINDING_NAMES[calc.type] ?? 'Cover';
    const parts = [kind];
    if (hard) parts.push(`cloth ${fmtSize(CW + 2 * wrap, CH + 2 * wrap, unit)}`, `boards ${fmtLen(ctx.book.binding.boardThickness, unit)}`, `corners cut ${fmtLen(calc.cornerMitre, unit)} off`);
    else if (coptic) parts.push(`boards ${fmtSize(calc.boardW, calc.boardH, unit)}`, `${calc.stations.length} stations`);
    else parts.push(`flat cover ${fmtSize(CW, CH, unit)}`, `spine ${fmtLen(calc.spine, unit)}`);
    const t = fitLabel(ctx, parts.join(' · '), sans, lab, w - 4);
    if (t) out.push(...textPrim([run(ctx, t, sans, lab, 2, h - lab * 0.45 - 1, cLine)]));
  }
  return out;
}

export const caseDiagram: MotifDef = {
  kind: 'case-diagram',
  label: 'Case-making diagram',
  designer: 'diehl',
  description: 'The flat case of this book as a binder lays it out — boards, joints, spine inlay and the cloth with its turn-ins and mitred corners — measured from the binding calculation, after the case-making drawings in Edith Diehl’s “Bookbinding: Its Background and Technique”.',
  defaultSize: { w: 440, h: 250 },
  colors: [
    { label: 'Lines & names', default: INK },
    { label: 'Covering', default: '#ece5d7' },
    { label: 'Boards', default: '#cbc1ad' },
    { label: 'Folds', default: RED },
    { label: 'Dimensions', default: BLUE },
  ],
  params: [
    { key: 'dims', label: 'Dimensions', min: 0, max: 1, step: 1, default: 1, options: ONOFF },
    { key: 'names', label: 'Panel names', min: 0, max: 1, step: 1, default: 1, options: ONOFF },
  ],
  generate: generator(() => caseDiagram, drawCase),
};

/* -------------------------------------------------------------------------- */
/* 13. Imposition — Diehl                                                      */
/* -------------------------------------------------------------------------- */

interface ImposedCell { page: number; inverted: boolean }
interface Imposition {
  cols: number;
  rows: number;
  /** Fold axes in order: 'x' = vertical fold line (halves the width). */
  folds: ('x' | 'y')[];
  /** Forme containing page 1 (viewed from its own side) and the other one. */
  outer: ImposedCell[][];
  inner: ImposedCell[][];
}

const LAYOUTS: Record<number, { cols: number; rows: number; folds: ('x' | 'y')[] }> = {
  4: { cols: 2, rows: 1, folds: ['x'] },
  8: { cols: 2, rows: 2, folds: ['y', 'x'] },
  16: { cols: 4, rows: 2, folds: ['x', 'y', 'x'] },
  32: { cols: 4, rows: 4, folds: ['y', 'x', 'y', 'x'] },
};

/**
 * Right-angle folding, simulated: each fold turns one half of the packet over onto the
 * other (right over left, head over foot), reversing its layers and flipping their faces.
 * The last fold is the spine. Reading the finished packet from the top layer down gives
 * pages 1, 2, 3 … on alternate faces; unfolding returns every page to its cell and side.
 */
export function impose(pages: number): Imposition {
  const L = LAYOUTS[pages] ?? LAYOUTS[16];
  const { cols, rows, folds } = L;
  interface Layer { i: number; j: number; cx: number; cy: number; m: [number, number, number, number]; up: 0 | 1; z: number }
  const layers: Layer[] = [];
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) layers.push({ i, j, cx: i + 0.5, cy: j + 0.5, m: [1, 0, 0, 1], up: 0, z: 0 });
  let x1 = cols, y0 = 0;
  for (const f of folds) {
    const zMax = Math.max(...layers.map((l) => l.z));
    if (f === 'x') {
      const xm = x1 / 2;
      for (const l of layers) {
        if (l.cx <= xm) continue;
        l.cx = 2 * xm - l.cx;
        l.m = [-l.m[0], -l.m[1], l.m[2], l.m[3]];
        l.up = l.up ? 0 : 1;
        l.z = zMax + 1 + (zMax - l.z);
      }
      x1 = xm;
    } else {
      const ym = (y0 + rows) / 2;
      for (const l of layers) {
        if (l.cy >= ym) continue;
        l.cy = 2 * ym - l.cy;
        l.m = [l.m[0], l.m[1], -l.m[2], -l.m[3]];
        l.up = l.up ? 0 : 1;
        l.z = zMax + 1 + (zMax - l.z);
      }
      y0 = ym;
    }
  }
  // The spine fold now lies on the right: turn the packet over so it binds on the left.
  for (const l of layers) {
    l.z = -l.z;
    l.up = l.up ? 0 : 1;
  }
  layers.sort((a, b) => b.z - a.z);
  const grid = () => Array.from({ length: rows }, () => Array.from({ length: cols }, () => ({ page: 0, inverted: false })));
  const sides = [grid(), grid()];
  layers.forEach((l, k) => {
    // Page heads point to the packet’s head (−y); back in sheet space that is mᵀ·(0, −1).
    const inverted = l.m[3] < 0;
    const put = (side: 0 | 1, page: number) => {
      const col = side === 0 ? l.i : cols - 1 - l.i; // side 1 is seen from behind, mirrored
      sides[side][l.j][col] = { page, inverted };
    };
    put(l.up, 2 * k + 1);
    put(l.up ? 0 : 1, 2 * k + 2);
  });
  const outerSide = sides[0].some((r) => r.some((c) => c.page === 1)) ? 0 : 1;
  return { cols, rows, folds, outer: sides[outerSide], inner: sides[1 - outerSide] };
}

const FORMATS: Record<number, string> = { 4: 'folio', 8: 'quarto (4to)', 16: 'octavo (8vo)', 32: 'sextodecimo (16mo)' };

function drawImposition(el: MotifElement, ctx: MotifContext, p: Params, def: MotifDef): Prim[] {
  const { w, h } = el;
  const cLine = motifColor(def, el, 0), cFold = motifColor(def, el, 1), cNum = motifColor(def, el, 2), cGrain = motifColor(def, el, 3);
  const book = ctx.book;
  const asked = book.binding.sectionPages;
  const pages = asked === 12 ? 16 : LAYOUTS[asked] ? asked : 16;
  const imp = impose(pages);
  const { cols, rows, folds } = imp;
  const { W, H } = trim(book);

  // Orient the sheet so that its cells come out as upright pages closest to the trim.
  let sw0 = finite(book.paper.sheetW, 0) > 1 ? book.paper.sheetW : 2835;
  let sh0 = finite(book.paper.sheetH, 0) > 1 ? book.paper.sheetH : 1984;
  const target = Math.log(W / H);
  const asIs = Math.abs(Math.log((sw0 / cols) / (sh0 / rows)) - target);
  const turned = Math.abs(Math.log((sh0 / cols) / (sw0 / rows)) - target);
  const rotated = turned < asIs - 1e-9;
  if (rotated) [sw0, sh0] = [sh0, sw0];
  const longIsWidth = sw0 >= sh0;
  const grainHorizontal = (book.paper.grain === 'long') === longIsWidth;
  const grainOk = !grainHorizontal;

  const forme = choice(p.forme, 0, 2);
  const show = forme === 0 ? [imp.outer, imp.inner] : forme === 1 ? [imp.outer] : [imp.inner];
  const titles = forme === 0 ? ['Outer forme', 'Inner forme'] : forme === 1 ? ['Outer forme'] : ['Inner forme'];
  const lab = labelSize(w, h, 6, 120);
  const { mono, sans, bold } = labelFonts(ctx);
  const titleBand = lab ? lab * 1.5 + 2 : 0;
  const capBand = lab ? lab * 2.8 + 3 : 0;
  const pad = Math.min(3, w * 0.02, h * 0.02);
  const gap = show.length > 1 ? Math.min(24, w * 0.06) : 0;
  const rw = (w - 2 * pad - gap * (show.length - 1)) / show.length;
  const rh = h - 2 * pad - titleBand - capBand;
  const s = Math.max(0, Math.min(rw / sw0, rh / sh0));
  if (!(s > 0) || !Number.isFinite(s)) return [];
  const SW = sw0 * s, SH = sh0 * s;
  const cw = SW / cols, ch = SH / rows;
  const total = SW * show.length + gap * (show.length - 1);
  const top = pad + titleBand + (rh - SH) / 2;
  const out: Prim[] = [];

  // Fold lines: the k-th fold along an axis creases the sheet at the odd 2^(k+1)ths.
  const foldLines: { axis: 'x' | 'y'; pos: number; order: number }[] = [];
  const seen = { x: 0, y: 0 };
  folds.forEach((axis, idx) => {
    const t = seen[axis]++;
    const n = 2 ** t;
    for (let j = 0; j < n; j++) foldLines.push({ axis, pos: (2 * j + 1) / (2 * n), order: idx + 1 });
  });

  const numSize = Math.min(30, Math.min(cw, ch) * 0.34);
  const badgeR = clamp(Math.min(cw, ch) * 0.085, 0, 5);

  show.forEach((cells, si) => {
    const x0 = (w - total) / 2 + si * (SW + gap);
    const sheet = new Pen().rect(x0, top, SW, SH);
    // Paper fibres: faint hatching along the grain.
    const fibres = new Pen();
    const step = Math.max(2.5, Math.min(SW, SH) / 26);
    if (grainHorizontal) for (let y = top + step / 2; y < top + SH; y += step) fibres.move(x0, y).line(x0 + SW, y);
    else for (let x = x0 + step / 2; x < x0 + SW; x += step) fibres.move(x, top).line(x, top + SH);
    const one = new Pen(), heads = new Pen();
    const runs: TextRun[] = [];
    cells.forEach((row, j) => row.forEach((c, i) => {
      const cx = x0 + (i + 0.5) * cw, cy = top + (j + 0.5) * ch;
      if (c.page === 1) one.rect(x0 + i * cw, top + j * ch, cw, ch);
      const hl = cw * 0.28, inset = Math.min(2.2, ch * 0.08);
      const hy = c.inverted ? top + (j + 1) * ch - inset : top + j * ch + inset;
      heads.move(cx - hl / 2, hy).line(cx + hl / 2, hy);
      if (numSize >= 3) {
        const t = String(c.page);
        runs.push(c.inverted ? invertedRun(ctx, t, bold, numSize, cx, cy, cNum, 0.72) : run(ctx, t, bold, numSize, cx, cy + numSize * 0.36, cNum, 'center'));
      }
    }));
    out.push(...fill(sheet, '#ffffff'), ...stroke(fibres, cGrain, FINE, { opacity: 0.22 }), ...fill(one, cFold, 0.1));
    const fl = new Pen(), spineLine = new Pen();
    const last = folds.length;
    for (const f of foldLines) {
      const pen = f.order === last ? spineLine : fl;
      if (f.axis === 'x') pen.move(x0 + f.pos * SW, top).line(x0 + f.pos * SW, top + SH);
      else pen.move(x0, top + f.pos * SH).line(x0 + SW, top + f.pos * SH);
    }
    out.push(...stroke(fl, cFold, HAIR, { dash: [3, 2] }), ...stroke(spineLine, cFold, 0.7, { dash: [4, 1.5] }));
    out.push(...stroke(heads, cLine, Math.max(0.5, Math.min(1.2, ch * 0.02))), ...stroke(sheet, cLine, RULE));
    out.push(...textPrim(runs));

    // Fold order, numbered in small discs where each crease meets the sheet edge.
    if (badgeR >= 2.4) {
      const discs = new Pen();
      const nums: TextRun[] = [];
      for (const f of foldLines) {
        const bx = f.axis === 'x' ? x0 + f.pos * SW : x0 + badgeR + 1.5;
        const by = f.axis === 'x' ? top + badgeR + 1.5 : top + f.pos * SH;
        discs.circle(bx, by, badgeR);
        nums.push(run(ctx, String(f.order), mono, badgeR * 1.2, bx, by + badgeR * 0.42, cFold, 'center'));
      }
      out.push(...fill(discs, '#ffffff'), ...stroke(discs, cFold, HAIR), ...textPrim(nums));
    }
    if (lab) {
      const title = fitLabel(ctx, `${titles[si]} · ${si === 0 && forme !== 2 ? 'with page 1' : 'reverse side'}`, sans, lab, SW);
      if (title) out.push(...textPrim([run(ctx, title, sans, lab, x0 + SW / 2, top - lab * 0.55 - 1, cLine, 'center')]));
    }
  });

  if (lab) {
    const left = (w - total) / 2;
    const nf = folds.length;
    const l1 = `${pages} pp · ${FORMATS[pages]} · ${nf} fold${nf > 1 ? 's' : ''}, fold ${nf} is the spine · sheet ${fmtSize(book.paper.sheetW, book.paper.sheetH, ctx.unit, 0)}${rotated ? ' (turned)' : ''}${asked === 12 ? ' · 12 pp drawn as 16' : ''}`;
    const y1 = top + SH + lab * 1.35 + 1;
    out.push(...textPrim([run(ctx, fitLabel(ctx, l1, mono, lab, Math.max(total, w - 2 * pad)), mono, lab, Math.min(left, pad + 1), y1, cLine)]));
    // Grain arrow and verdict.
    const ay = y1 + lab * 1.35, ax = Math.min(left, pad + 1);
    const arrow = new Pen();
    const al = lab * 1.8;
    if (grainHorizontal) {
      arrow.move(ax + 1, ay - lab * 0.32).line(ax + al - 1, ay - lab * 0.32);
      const ah = new Pen();
      arrowHead(ah, ax, ay - lab * 0.32, -1, 0, 2.2, 0.9);
      arrowHead(ah, ax + al, ay - lab * 0.32, 1, 0, 2.2, 0.9);
      out.push(...stroke(arrow, cGrain, 0.6), ...fill(ah, cGrain));
    } else {
      const cx = ax + al / 2;
      arrow.move(cx, ay - lab * 0.95 + 1).line(cx, ay + lab * 0.3 - 1);
      const ah = new Pen();
      arrowHead(ah, cx, ay - lab * 0.95, 0, -1, 2.2, 0.9);
      arrowHead(ah, cx, ay + lab * 0.3, 0, 1, 2.2, 0.9);
      out.push(...stroke(arrow, cGrain, 0.6), ...fill(ah, cGrain));
    }
    const verdict = grainOk ? 'parallel to the spine — the section folds cleanly and opens flat'
      : 'across the spine — order the other grain or turn the sheet';
    const l2 = fitLabel(ctx, `${book.paper.grain} grain ${verdict}`, mono, lab, w - (ax + al + lab * 0.6) - pad);
    if (l2) out.push(...textPrim([run(ctx, l2, mono, lab, ax + al + lab * 0.6, ay, grainOk ? cLine : cFold)]));
  }
  return out;
}

export const impositionDiagram: MotifDef = {
  kind: 'imposition-diagram',
  label: 'Imposition',
  designer: 'diehl',
  description: 'Sheetwise imposition of one section of this book — folio, quarto, octavo or 16mo — with both formes, head-to-head pages turned, the folds numbered in order and the grain checked against the spine, as in the printer’s schemes Diehl reproduces for the binder.',
  defaultSize: { w: 440, h: 250 },
  colors: [
    { label: 'Sheet & heads', default: INK },
    { label: 'Folds', default: RED },
    { label: 'Page numbers', default: INK },
    { label: 'Grain', default: BLUE },
  ],
  params: [
    { key: 'forme', label: 'Formes', min: 0, max: 2, step: 1, default: 0, options: ['Both', 'Outer', 'Inner'] },
  ],
  generate: generator(() => impositionDiagram, drawImposition),
};

/* -------------------------------------------------------------------------- */
/* 14. Stab binding — Sato / wa-toji                                           */
/* -------------------------------------------------------------------------- */

type StitchKind = 'front' | 'back' | 'spine' | 'head' | 'tail';
interface Stitch { kind: StitchKind; a: number; b?: number }

/**
 * The sewing order of four-hole yotsume toji, starting from inside at hole 2 and tying off
 * there; corner holes (kikkō, kōki) add a spine wrap, an end wrap and a diagonal on each
 * side. Every segment appears once on the front and once on the back.
 */
function stitchOrder(headCorner: boolean, tailCorner: boolean): Stitch[] {
  return [
    { kind: 'spine', a: 1 },
    { kind: 'front', a: 1, b: 0 },
    { kind: 'spine', a: 0 },
    { kind: 'head', a: 0 },
    ...(headCorner ? [{ kind: 'back', a: 0, b: 4 }, { kind: 'spine', a: 4 }, { kind: 'head', a: 4 }, { kind: 'front', a: 4, b: 0 }] as Stitch[] : []),
    { kind: 'back', a: 0, b: 1 },
    { kind: 'front', a: 1, b: 2 },
    { kind: 'spine', a: 2 },
    { kind: 'back', a: 2, b: 3 },
    { kind: 'spine', a: 3 },
    { kind: 'tail', a: 3 },
    ...(tailCorner ? [{ kind: 'front', a: 3, b: 5 }, { kind: 'spine', a: 5 }, { kind: 'tail', a: 5 }, { kind: 'back', a: 5, b: 3 }] as Stitch[] : []),
    { kind: 'front', a: 3, b: 2 },
    { kind: 'back', a: 2, b: 1 },
  ];
}

const STAB_NAMES: Record<number, string> = { 4: 'Yotsume toji', 5: 'Kikkō toji', 6: 'Kōki toji' };

function drawStab(el: MotifElement, ctx: MotifContext, p: Params, def: MotifDef): Prim[] {
  const { w, h } = el;
  const cPaper = motifColor(def, el, 0), cThread = motifColor(def, el, 1), cLab = motifColor(def, el, 2);
  const book = ctx.book;
  const pattern = choice(p.pattern, 0, 3);
  const holeCount = (pattern === 0 ? book.binding.stabHoles : [4, 5, 6][pattern - 1]) as 4 | 5 | 6;
  const spec: BookSpec = { ...book, binding: { ...book.binding, type: 'stab', stabHoles: holeCount } };
  const calc = computeBinding(spec);
  const holes = calc.stabHoles;
  if (holes.length < 4) return [];
  const { W, H } = trim(book);
  const rtl = book.direction === 'rtl';
  const maxHx = Math.max(...holes.map((q) => q.x), 1);
  const S = Math.min(W, Math.max(W * 0.42, maxHx * 2.6));
  const lab = labelSize(w, h, 6, 130);
  const { mono, sans } = labelFonts(ctx);
  const topBand = lab ? lab * 1.5 + 2 : 1;
  const capBand = lab ? lab * 1.5 + 2 : 1;

  // Fit the flat view [strip | spine | strip]; very thin books get a legible spine.
  let T = Math.max(0, calc.spine);
  let fit = fitBox(2 * S + T, H, 1, topBand, w - 2, h - topBand - capBand);
  for (let i = 0; i < 2 && fit.s > 0 && T * fit.s < 7; i++) {
    T = 7 / fit.s;
    fit = fitBox(2 * S + T, H, 1, topBand, w - 2, h - topBand - capBand);
  }
  const { s, ox, oy } = fit;
  if (!(s > 0)) return [];
  const X = (x: number) => ox + x * s, Y = (y: number) => oy + y * s;
  // Flat layout: the back strip is mirrored about the spine, as if the cover were unfolded.
  const front = (hx: number) => (rtl ? S - hx : S + T + hx);
  const back = (hx: number) => (rtl ? S + T + hx : S - hx);
  const foreFront = rtl ? -1 : 1;

  const out: Prim[] = [];
  const paper = new Pen().rect(X(0), Y(0), S * s, H * s).rect(X(S + T), Y(0), S * s, H * s);
  out.push(...fill(paper, cPaper), ...fill(new Pen().rect(X(S), Y(0), T * s, H * s), cLab, 0.08));
  // Edges: head, tail and spine folds solid; the cut-away fore-edge side as a break line.
  const edges = new Pen();
  edges.move(X(0), Y(0)).line(X(2 * S + T), Y(0)).move(X(0), Y(H)).line(X(2 * S + T), Y(H));
  edges.move(X(S), Y(0)).line(X(S), Y(H)).move(X(S + T), Y(0)).line(X(S + T), Y(H));
  out.push(...stroke(edges, cLab, HAIR));
  const brk = new Pen();
  const zig = Math.max(3, H * s / 28);
  for (const x of [0, 2 * S + T]) {
    const pts: Pt[] = [];
    const n = Math.max(2, Math.round((H * s) / zig));
    for (let i = 0; i <= n; i++) pts.push([X(x) + (i % 2 ? 1.2 : -1.2) * (S < W ? 1 : 0), Y(0) + (i * H * s) / n]);
    brk.poly(pts);
  }
  out.push(...stroke(brk, cLab, FINE));

  // Thread.
  const order = stitchOrder(holes.length >= 5, holes.length >= 6);
  const thread = new Pen();
  const hy = (i: number) => holes[i].y;
  const segs: [number, number, number, number][] = [];
  const line = (x1: number, y1: number, x2: number, y2: number) => {
    segs.push([X(x1), Y(y1), X(x2), Y(y2)]);
    thread.move(X(x1), Y(y1)).line(X(x2), Y(y2));
  };
  for (const st of order) {
    const a = holes[st.a];
    if (st.kind === 'front' || st.kind === 'back') {
      const b = holes[st.b ?? st.a];
      const f = st.kind === 'front' ? front : back;
      line(f(a.x), a.y, f(b.x), b.y);
    } else if (st.kind === 'spine') {
      line(front(a.x), a.y, back(a.x), a.y);
    } else {
      const edge = st.kind === 'head' ? 0 : H;
      line(front(a.x), a.y, front(a.x), edge);
      line(back(a.x), a.y, back(a.x), edge);
    }
  }
  const tw = clamp(s * Math.min(W, H) * 0.004, 0.6, 1.5);
  out.push(...stroke(thread, cThread, tw, { cap: 'round', join: 'round' }));

  const hr = clamp(tw * 1.25, 1, 2.2);
  const holePen = new Pen();
  for (const q of holes) holePen.circle(X(front(q.x)), Y(q.y), hr).circle(X(back(q.x)), Y(q.y), hr);
  out.push(...fill(holePen, cPaper), ...stroke(holePen, cLab, 0.4));
  // The knot: sewing starts inside at hole 2 and ties off there.
  out.push(...fill(new Pen().circle(X(back(holes[1].x)) - foreFront * (hr + 1.6), Y(hy(1)), 1.3), cThread));

  // Step numbers along the path. Each starts beside its segment and slides outward —
  // toward the fore-edge, or along the spine — until it clears thread, holes and the other
  // numbers; a hairline leader ties a displaced number back to its segment.
  const br = lab ? lab * 0.72 : 0;
  if (p.steps >= 0.5 && br >= 2.2) {
    const discs = new Pen(), leaders = new Pen();
    const nums: TextRun[] = [];
    const placed: Pt[] = [];
    const holePts = holes.flatMap((q) => [[X(front(q.x)), Y(q.y)], [X(back(q.x)), Y(q.y)]] as Pt[]);
    const segDist = (px: number, py: number, [x1, y1, x2, y2]: [number, number, number, number]) => {
      const dx = x2 - x1, dy = y2 - y1, l2 = dx * dx + dy * dy;
      const t = l2 > 0 ? clamp(((px - x1) * dx + (py - y1) * dy) / l2, 0, 1) : 0;
      return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
    };
    const free = (x: number, y: number) =>
      x >= br + 0.5 && x <= w - br - 0.5 && y >= Y(0) + br + 0.5 && y <= Y(H) - br - 0.5
      && segs.every((g) => segDist(x, y, g) >= br + tw / 2 + 0.6)
      && holePts.every(([hx, hy2]) => Math.hypot(x - hx, y - hy2) >= br + hr + 0.6)
      && placed.every(([px, py]) => Math.hypot(x - px, y - py) >= 2 * br + 0.8);
    order.forEach((st, i) => {
      const a = holes[st.a];
      let ax: number, ay: number;
      let dirs: Pt[];
      if (st.kind === 'front' || st.kind === 'back') {
        const b = holes[st.b ?? st.a];
        const f = st.kind === 'front' ? front : back;
        ax = X((f(a.x) + f(b.x)) / 2);
        ay = Y((a.y + b.y) / 2);
        dirs = [[st.kind === 'front' ? foreFront : -foreFront, 0]];
      } else if (st.kind === 'spine') {
        ax = X(S + T / 2);
        ay = Y(a.y);
        const v = a.y < H / 2 ? 1 : -1;
        dirs = [[0, v], [0, -v]];
      } else {
        const edge = st.kind === 'head' ? 0 : H;
        ax = X(front(a.x));
        ay = Y((a.y + edge) / 2);
        dirs = [[foreFront, 0]];
      }
      const base = br + tw / 2 + 0.8;
      let pos: Pt | null = null, moved = false, ux = dirs[0][0], uy = dirs[0][1];
      for (let k = 0; k < 40 && !pos; k++) {
        for (const [dx, dy] of dirs) {
          const d = base + k * br * 0.6;
          if (free(ax + dx * d, ay + dy * d)) {
            pos = [ax + dx * d, ay + dy * d];
            moved = k > 1;
            ux = dx;
            uy = dy;
            break;
          }
        }
      }
      if (!pos) pos = [ax + ux * base, ay + uy * base];
      placed.push(pos);
      if (moved) leaders.move(ax + ux * (tw / 2 + 0.4), ay + uy * (tw / 2 + 0.4)).line(pos[0] - ux * br, pos[1] - uy * br);
      discs.circle(pos[0], pos[1], br);
      nums.push(run(ctx, String(i + 1), mono, br * 1.15, pos[0], pos[1] + br * 0.4, cThread, 'center'));
    });
    out.push(...stroke(leaders, cThread, FINE), ...fill(discs, cPaper), ...stroke(discs, cThread, 0.4), ...textPrim(nums));
  }

  if (lab) {
    const runs: TextRun[] = [];
    const head = (t: string, cx: number, room: number) => {
      const f = fitLabel(ctx, t, sans, lab, room);
      if (f) runs.push(run(ctx, f, sans, lab, cx, Y(0) - lab * 0.6, cLab, 'center'));
    };
    head('back · ura', X(rtl ? S + T + S / 2 : S / 2), S * s - 4);
    head('front · omote', X(rtl ? S / 2 : S + T + S / 2), S * s - 4);
    const name = STAB_NAMES[holeCount] ?? 'Stab binding';
    const cap = `${name} · ${holeCount} holes ${fmtLen(book.binding.stabMargin, ctx.unit)} from the spine · binds on the ${rtl ? 'right' : 'left'}`;
    const t = fitLabel(ctx, cap, sans, lab, w - 2);
    if (t) runs.push(run(ctx, t, sans, lab, w / 2, Y(H) + lab * 1.3 + 1, cLab, 'center'));
    out.push(...textPrim(runs));
  }
  return out;
}

export const stabDiagram: MotifDef = {
  kind: 'stab-diagram',
  label: 'Stab-binding sewing',
  designer: 'sato',
  description: 'The thread path of Japanese four-hole binding (yotsume toji) and its kikkō and kōki corner variants, drawn flat across front, spine and back with every sewing step numbered — wa-toji, the visible structure of the Japanese book, shown alongside Koichi Sato’s art of ma.',
  defaultSize: { w: 280, h: 330 },
  colors: [
    { label: 'Paper', default: PAPER },
    { label: 'Thread', default: '#b0331f' },
    { label: 'Labels & edges', default: INK },
  ],
  params: [
    { key: 'steps', label: 'Step numbers', min: 0, max: 1, step: 1, default: 1, options: ONOFF },
    { key: 'pattern', label: 'Pattern', min: 0, max: 3, step: 1, default: 0, options: ['Book setting', 'Yotsume (4)', 'Kikkō (5)', 'Kōki (6)'] },
  ],
  generate: generator(() => stabDiagram, drawStab),
};

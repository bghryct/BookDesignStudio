/**
 * Binding mechanics after Edith Diehl, "Bookbinding: Its Background and Technique" (1946),
 * with modern trade-production conventions for soft covers.
 *
 * Everything is computed in points from the BookSpec; the cover editor, the 3D model, the
 * PDF cover export and the Binding panel all read from `computeBinding()` so they agree.
 */
import type { BindingType, BookSpec } from '../model/types';
import { mm, ptToMm } from '../model/units';

export interface Panel {
  id: 'front-flap' | 'front' | 'hinge-front' | 'spine' | 'hinge-back' | 'back' | 'back-flap';
  label: string;
  x: number;
  w: number;
}

export interface StabHole { x: number; y: number }

export interface BindingCalc {
  type: BindingType;
  pages: number;
  leaves: number;
  sections: number;
  /** Caliper of one leaf (sheet), pt. */
  caliper: number;
  /** Paper-only thickness of the text block, pt. */
  paperThickness: number;
  /** Extra swell from sewing thread in the folds, pt. */
  swell: number;
  /** Text block thickness including swell, pt. */
  textBlock: number;
  /** Width of the spine panel on the flat cover (arc length when rounded), pt. */
  spine: number;
  /** Chord (straight) width across the spine including shoulders, pt. */
  spineChord: number;
  /** Rounding depth (sagitta), pt. */
  roundDepth: number;
  /** Shoulder depth produced by backing — equals the board thickness for case work. */
  shoulder: number;
  boardW: number;
  boardH: number;
  /** Flat cover (outside) size without wrap/bleed, pt. */
  coverW: number;
  coverH: number;
  /** Turn-in (case) or bleed (soft) that wraps beyond the cover size, pt. */
  wrap: number;
  panels: Panel[];
  /** Vertical fold / score lines on the flat cover, x in pt. */
  folds: { x: number; kind: 'fold' | 'score' | 'hinge' }[];
  /** Raised band centre lines measured from the top of the spine, pt. */
  bands: number[];
  /** Sewing stations along the spine fold (y from head), pt. */
  stations: number[];
  /** Japanese stab holes, x measured from the spine edge, y from head, pt. */
  stabHoles: StabHole[];
  /** Corner mitre offset for the turn-in (distance from the board corner), pt. */
  cornerMitre: number;
  recommendedBoard: number;
  headbandHeight: number;
  linings: string[];
  grain: GrainCheck;
  notes: string[];
  warnings: string[];
}

export interface GrainCheck {
  folds: number;
  /** Axis of the sheet the spine (last fold) runs along. */
  spineAxis: 'sheetWidth' | 'sheetHeight';
  grainAxis: 'sheetWidth' | 'sheetHeight';
  ok: boolean;
  /** Untrimmed page from the fold, pt. */
  pageW: number;
  pageH: number;
  fits: boolean;
  format: string;
  advice: string;
}

const FORMAT_NAMES: Record<number, string> = { 1: 'folio', 2: 'quarto (4to)', 3: 'octavo (8vo)', 4: 'sextodecimo (16mo)', 5: '32mo' };

/** Diehl: the spine of a sewn book must run with the grain, or the leaves cockle and fight the joint. */
export function checkGrain(spec: BookSpec): GrainCheck {
  const { sheetW, sheetH, grain } = spec.paper;
  const sectionPages = spec.binding.type === 'stab' || spec.binding.type === 'perfect' ? 4 : spec.binding.sectionPages;
  // A section of P pages comes from one sheet folded log2(P) − 1 times (folio = 4 pages, 1 fold).
  const folds = Math.max(1, Math.round(Math.log2(Math.max(4, sectionPages))) - 1);
  let px = sheetW, py = sheetH;
  let lastFold: 'sheetWidth' | 'sheetHeight' = 'sheetHeight';
  for (let i = 0; i < folds; i++) {
    // Right-angle folding: each fold halves the longer side; the fold line runs along the other axis.
    if (px >= py) { px /= 2; lastFold = 'sheetHeight'; } else { py /= 2; lastFold = 'sheetWidth'; }
  }
  const longAxis: 'sheetWidth' | 'sheetHeight' = sheetW >= sheetH ? 'sheetWidth' : 'sheetHeight';
  const shortAxis: 'sheetWidth' | 'sheetHeight' = longAxis === 'sheetWidth' ? 'sheetHeight' : 'sheetWidth';
  const grainAxis = grain === 'long' ? longAxis : shortAxis;
  const ok = grainAxis === lastFold;
  const pageH = lastFold === 'sheetHeight' ? py : px;
  const pageW = lastFold === 'sheetHeight' ? px : py;
  const trimAllowance = mm(3);
  const fits = pageH >= spec.trimH + trimAllowance && pageW >= spec.trimW + trimAllowance * 0.5;
  const format = FORMAT_NAMES[folds] ?? `${2 ** (folds + 1)}-page section`;
  const need = lastFold === longAxis ? 'long' : 'short';
  const advice = ok
    ? `Grain runs parallel to the spine — the ${format} folds cleanly and the leaves open flat.`
    : `Grain runs across the spine. For ${format} imposition on this sheet order ${need}-grain stock, or rotate the sheet.`;
  return { folds, spineAxis: lastFold, grainAxis, ok, pageW, pageH, fits, format, advice };
}

/** Board thickness rule of thumb following Diehl's proportion of board to book size. */
export function recommendedBoard(trimH: number): number {
  const h = ptToMm(trimH);
  if (h <= 180) return mm(2);
  if (h <= 250) return mm(2.5);
  if (h <= 320) return mm(3);
  return mm(3.5);
}

/** Arc length of a circular segment with chord c and sagitta s. */
function arcLength(c: number, s: number): number {
  if (s <= 1e-6) return c;
  const r = (c * c) / (8 * s) + s / 2;
  const theta = 2 * Math.asin(Math.min(1, c / (2 * r)));
  return r * theta;
}

export function computeBinding(spec: BookSpec): BindingCalc {
  const b = spec.binding;
  const notes: string[] = [];
  const warnings: string[] = [];
  const pages = Math.max(4, Math.ceil(spec.plannedPages / 2) * 2);
  const leaves = pages / 2;
  // Caliper in µm = grammage × bulk (cm³/g). 1 µm = 0.001 mm.
  const caliper = mm((spec.paper.gsm * spec.paper.bulk) / 1000);
  const fukuro = b.type === 'stab' && b.fukuroToji;
  // Fukuro-toji leaves are folded at the fore-edge, so each leaf is two thicknesses of paper.
  const paperThickness = leaves * caliper * (fukuro ? 2 : 1);

  const sewn = b.type === 'case' || b.type === 'smyth' || b.type === 'coptic' || b.type === 'munari';
  const sections = sewn ? Math.ceil(pages / b.sectionPages) : 0;
  // Each section carries one thread in its fold; backing compresses roughly half of that swell.
  const swell = sewn ? sections * b.threadDiameter * (b.type === 'case' ? 0.5 : 0.75) : 0;
  const textBlock = paperThickness + swell;

  notes.push(`${pages} pp → ${leaves} leaves × ${ptToMm(caliper).toFixed(3)} mm (${spec.paper.gsm} g/m² at bulk ${spec.paper.bulk.toFixed(2)})${fukuro ? ', doubled for fukuro-toji folded leaves' : ''}.`);
  if (sewn) notes.push(`${sections} sections of ${b.sectionPages} pp; thread swell ${ptToMm(swell).toFixed(2)} mm (${ptToMm(b.threadDiameter).toFixed(2)} mm thread${b.type === 'case' ? ', half absorbed by backing' : ''}).`);

  const rb = recommendedBoard(spec.trimH);
  let shoulder = 0, spineChord = textBlock, roundDepth = 0, spine = textBlock;
  let boardW = spec.trimW, boardH = spec.trimH;
  let wrap = spec.bleed;
  const panels: Panel[] = [];
  const folds: BindingCalc['folds'] = [];
  const flap = spec.cover.flapWidth;
  let x = 0;
  const push = (id: Panel['id'], label: string, w: number) => {
    panels.push({ id, label, x, w });
    x += w;
  };

  switch (b.type) {
    case 'case': {
      // Backing raises shoulders equal to the board thickness so the boards close flush (Diehl ch. X).
      shoulder = b.boardThickness;
      spineChord = textBlock + 2 * shoulder;
      // Rounding: depth up to one third of the chord (a "third of a circle" round).
      roundDepth = (b.rounding * spineChord) / 3;
      spine = arcLength(spineChord, roundDepth);
      boardH = spec.trimH + 2 * b.squares;
      // Boards are set back from the joint (~3 mm) and overhang the fore-edge by the square.
      boardW = spec.trimW - mm(3) + b.squares;
      wrap = b.turnIn;
      if (flap > 0) push('back-flap', 'Back flap', flap);
      push('back', 'Back board', boardW);
      push('hinge-back', 'Joint', b.hingeGap);
      push('spine', 'Spine', spine);
      push('hinge-front', 'Joint', b.hingeGap);
      push('front', 'Front board', boardW);
      if (flap > 0) push('front-flap', 'Front flap', flap);
      notes.push(`Shoulders ${ptToMm(shoulder).toFixed(1)} mm (= board), chord ${ptToMm(spineChord).toFixed(1)} mm, rounded arc ${ptToMm(spine).toFixed(1)} mm.`);
      notes.push(`Boards ${ptToMm(boardW).toFixed(1)} × ${ptToMm(boardH).toFixed(1)} mm with ${ptToMm(b.squares).toFixed(1)} mm squares; ${ptToMm(b.hingeGap).toFixed(1)} mm french joints; ${ptToMm(b.turnIn).toFixed(0)} mm turn-ins.`);
      if (Math.abs(b.boardThickness - rb) > mm(0.6)) warnings.push(`Diehl would choose ~${ptToMm(rb).toFixed(1)} mm board for a ${ptToMm(spec.trimH).toFixed(0)} mm book.`);
      if (b.squares < b.boardThickness * 0.8) warnings.push('Squares narrower than the board thickness look mean and leave the edges unprotected.');
      break;
    }
    case 'perfect':
    case 'smyth':
    case 'munari': {
      spine = textBlock + 2 * b.coverCaliper;
      spineChord = spine;
      if (flap > 0) push('back-flap', 'Back flap', flap);
      push('back', 'Back cover', spec.trimW);
      push('spine', 'Spine', spine);
      push('front', 'Front cover', spec.trimW);
      if (flap > 0) push('front-flap', 'Front flap', flap);
      notes.push(`Soft cover: spine = block ${ptToMm(textBlock).toFixed(2)} mm + 2 × cover ${ptToMm(b.coverCaliper).toFixed(2)} mm.`);
      if (b.type === 'perfect' && pages > 64 && ptToMm(spine) < 3) warnings.push('Perfect binding below ~3 mm spine is fragile; consider saddle stitching.');
      if (b.type === 'perfect') notes.push('Hinge scores 6 mm either side of the spine let the cover open without cracking the glue line.');
      break;
    }
    case 'coptic': {
      // Exposed sewn spine; boards are independent and cover-to-board.
      boardH = spec.trimH + 2 * Math.min(b.squares, mm(2));
      boardW = spec.trimW + Math.min(b.squares, mm(2));
      spine = textBlock;
      spineChord = textBlock;
      wrap = mm(5);
      push('back', 'Back board', boardW);
      push('spine', 'Exposed spine', spine);
      push('front', 'Front board', boardW);
      notes.push('Coptic: link-stitch chains run across the exposed folds; boards are sewn on, so they flex at the station holes rather than at a joint.');
      break;
    }
    case 'stab': {
      spine = textBlock + 2 * b.coverCaliper;
      spineChord = spine;
      push('back', 'Back cover', spec.trimW);
      push('spine', 'Spine (stab-sewn)', spine);
      push('front', 'Front cover', spec.trimW);
      notes.push(`Stab binding: thread wraps the spine through ${b.stabHoles} holes ${ptToMm(b.stabMargin).toFixed(0)} mm in from the spine edge.`);
      if (spec.direction !== 'rtl') notes.push('Traditional wa-toji binds on the right with vertical text; switch reading direction to RTL for a Japanese book.');
      break;
    }
  }

  const coverW = x;
  const coverH = b.type === 'case' || b.type === 'coptic' ? boardH : spec.trimH;
  // Right-to-left books (Japanese, Arabic, Hebrew) bind on the right: the front board sits on
  // the left of the unwrapped cover.
  if (spec.direction === 'rtl') {
    for (const p of panels) p.x = coverW - p.x - p.w;
    panels.sort((a, c) => a.x - c.x);
  }

  // Fold and score lines.
  for (const p of panels) {
    if (p.id === 'spine') {
      folds.push({ x: p.x, kind: b.type === 'case' ? 'hinge' : 'fold' });
      folds.push({ x: p.x + p.w, kind: b.type === 'case' ? 'hinge' : 'fold' });
    }
    if (p.id === 'back-flap') folds.push({ x: p.x + p.w, kind: 'fold' });
    if (p.id === 'front-flap') folds.push({ x: p.x, kind: 'fold' });
    if (p.id === 'hinge-back') folds.push({ x: p.x, kind: 'fold' });
    if (p.id === 'hinge-front') folds.push({ x: p.x + p.w, kind: 'fold' });
  }
  if (b.type === 'perfect') {
    const sp = panels.find((p) => p.id === 'spine')!;
    folds.push({ x: sp.x - mm(6), kind: 'score' }, { x: sp.x + sp.w + mm(6), kind: 'score' });
  }
  if (spec.direction === 'rtl') {
    // Flap folds were computed from the panel ids, which already carry mirrored x positions;
    // the flap/fold relationship flips sides, so recompute those from the panel edges.
    folds.length = 0;
    const sp = panels.find((p) => p.id === 'spine')!;
    folds.push({ x: sp.x, kind: b.type === 'case' ? 'hinge' : 'fold' }, { x: sp.x + sp.w, kind: b.type === 'case' ? 'hinge' : 'fold' });
    for (const p of panels) {
      if (p.id === 'back-flap') folds.push({ x: p.x, kind: 'fold' });
      if (p.id === 'front-flap') folds.push({ x: p.x + p.w, kind: 'fold' });
      if (p.id === 'hinge-back') folds.push({ x: p.x + p.w, kind: 'fold' });
      if (p.id === 'hinge-front') folds.push({ x: p.x, kind: 'fold' });
    }
    if (b.type === 'perfect') folds.push({ x: sp.x - mm(6), kind: 'score' }, { x: sp.x + sp.w + mm(6), kind: 'score' });
  }

  // Raised bands: equal panels with a slightly taller tail panel (traditional proportion).
  const bands: number[] = [];
  if (b.type === 'case' && b.raisedBands > 0) {
    const n = b.raisedBands;
    const tailFactor = 1.25;
    const unit = coverH / (n + tailFactor);
    for (let i = 1; i <= n; i++) bands.push(unit * i);
  }

  // Sewing stations: kettle stitches ~12 mm from head/tail, inner stations ~25–30 mm apart.
  const stations: number[] = [];
  if (sewn) {
    const kettle = Math.min(mm(12), spec.trimH * 0.08);
    const inner = spec.trimH - 2 * kettle;
    const count = Math.max(2, Math.round(inner / mm(28)) + 1);
    for (let i = 0; i < count; i++) stations.push(kettle + (inner * i) / (count - 1));
    if (b.type === 'coptic' && stations.length % 2) stations.push(spec.trimH - kettle);
  }

  // Stab holes (yotsume toji = 4, kikko = 5, koki = 6).
  const stabHoles: StabHole[] = [];
  if (b.type === 'stab') {
    const end = Math.max(mm(10), Math.min(mm(25), spec.trimH * 0.08));
    const span = spec.trimH - 2 * end;
    for (let i = 0; i < 4; i++) stabHoles.push({ x: b.stabMargin, y: end + (span * i) / 3 });
    if (b.stabHoles >= 5) stabHoles.push({ x: b.stabMargin * 0.5, y: end * 0.5 });
    if (b.stabHoles >= 6) stabHoles.push({ x: b.stabMargin * 0.5, y: spec.trimH - end * 0.5 });
  }

  const thickMm = ptToMm(textBlock);
  const linings = b.type === 'case'
    ? ['Mull (super) across the spine, 25 mm onto each board', thickMm > 25 ? 'Two kraft-paper linings (thick block)' : 'One kraft-paper lining', 'Hollow tube for leather / tight back for cloth']
    : b.type === 'smyth' || b.type === 'munari'
      ? ['Crash/mull lining glued to the sewn spine', 'Cover hinged with 6 mm side glue']
      : b.type === 'perfect'
        ? ['PUR or EVA hot-melt spine glue, roughened (notched) spine']
        : [];

  const grain = checkGrain(spec);
  if (!grain.ok) warnings.push(grain.advice);
  if (!grain.fits) warnings.push(`The folded ${grain.format} page (${ptToMm(grain.pageW).toFixed(0)} × ${ptToMm(grain.pageH).toFixed(0)} mm) is smaller than trim + allowance.`);

  return {
    type: b.type, pages, leaves, sections, caliper, paperThickness, swell, textBlock,
    spine, spineChord, roundDepth, shoulder, boardW, boardH, coverW, coverH, wrap,
    panels, folds, bands, stations, stabHoles,
    cornerMitre: b.boardThickness * 1.5,
    recommendedBoard: rb,
    headbandHeight: Math.max(mm(2), b.squares * 0.9),
    linings, grain, notes, warnings,
  };
}

/** Front-cover panel rectangle on the flat cover surface. */
export function frontPanel(calc: BindingCalc): Panel {
  return calc.panels.find((p) => p.id === 'front')!;
}
export function spinePanel(calc: BindingCalc): Panel {
  return calc.panels.find((p) => p.id === 'spine')!;
}
export function backPanel(calc: BindingCalc): Panel {
  return calc.panels.find((p) => p.id === 'back')!;
}

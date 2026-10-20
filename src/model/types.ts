/**
 * Book Design Studio — core document model.
 *
 * All geometry is stored in PostScript points (1pt = 1/72in). Points are the
 * native unit of PDF, of type sizes and of leading, so storing everything in pt
 * means the layout engine, the SVG renderer and the PDF writer never round-trip
 * through a lossy conversion. Display units (mm, in, pc …) are a view concern.
 *
 * Coordinates of an element are relative to the top-left corner of the trimmed
 * surface it lives on (a page, or the flat unwrapped cover). Negative values or
 * values past the trim reach into the bleed.
 */

import type { TableElement, TableStyleDef, CellStyleDef } from './table';
export type { TableElement } from './table';

export type ID = string;
export type Unit = 'mm' | 'cm' | 'in' | 'pt' | 'pc' | 'px';

export type BlendMode =
  | 'normal' | 'multiply' | 'screen' | 'overlay' | 'darken' | 'lighten'
  | 'color-dodge' | 'color-burn' | 'hard-light' | 'soft-light'
  | 'difference' | 'exclusion' | 'hue' | 'saturation' | 'color' | 'luminosity';

/** CMYK in percent, 0–100. */
export interface CMYK { c: number; m: number; y: number; k: number }

export interface Swatch {
  id: ID;
  name: string;
  hex: string;
  /** Exact process build used by the PDF writer when the colour is used. */
  cmyk?: CMYK;
}

/* ------------------------------------------------------------------------- */
/* Typography                                                                 */
/* ------------------------------------------------------------------------- */

export type TextAlign = 'left' | 'right' | 'center' | 'justify' | 'justify-all';
export type DropCapFrame = 'none' | 'gilded' | 'vine' | 'rubric' | 'box' | 'outline';

export interface DropCapStyle {
  enabled: boolean;
  /** Number of text lines the initial sinks into. */
  lines: number;
  /** Font family id for the initial (null = same as body). */
  fontFamily: string | null;
  weight: number;
  color: string;
  frame: DropCapFrame;
  frameColor: string;
  /** Gap between initial and text, pt. */
  gap: number;
  /** Characters set as the initial (1 = one letter; an opening quote always comes along). */
  chars?: number;
}

export interface TextStyle {
  fontFamily: string;      // font family id from the font registry
  fontSize: number;        // pt
  leading: number;         // pt, baseline to baseline
  weight: number;          // 100–900 (drives `wght` on variable fonts)
  italic: boolean;
  tracking: number;        // thousandths of an em
  wordSpacing: number;     // % adjustment of the natural space, 0 = font default
  align: TextAlign;
  color: string;
  /** Explicit variation-axis values; `opsz` falls back to the font size. */
  axes: Record<string, number>;
  /** OpenType feature toggles, e.g. { smcp: true, onum: true, liga: true }. */
  features: Record<string, boolean>;
  hyphenate: boolean;
  language: string;        // hyphenation patterns, e.g. 'en-us', 'de', 'la'
  firstLineIndent: number; // pt
  indentFirstParagraph: boolean;
  paragraphSpacing: number;// pt added between paragraphs
  /** Bringhurst / Tschichold hanging punctuation + optical margin alignment. */
  opticalMargin: boolean;
  /** Lock lines to the document baseline grid. */
  baselineGrid: boolean;
  direction: 'ltr' | 'rtl';
  writingMode: 'horizontal' | 'vertical';
  /** Tate-chū-yoko: set short digit runs horizontally inside vertical text. */
  tateChuYoko: boolean;
  textTransform: 'none' | 'uppercase' | 'lowercase' | 'small-caps';
  /** Render the first line in small caps (classical chapter openings). */
  firstLineSmallCaps: boolean;
  dropCap: DropCapStyle;
  /** Avoid single-word last lines (re-breaks with a tighter fit). */
  avoidRunts: boolean;
  /** Pair kerning: the font's own kern table, outline-based optical kerning, or none. */
  kerning?: KerningMode;
  /** Optical tracking by size: small text opens up, display sizes close up (added to tracking). */
  opticalTracking?: boolean;
  /** Paragraph indents from the column edges, pt (a negative first-line indent hangs). */
  leftIndent?: number;
  rightIndent?: number;
  /** Justification: smallest and largest word space, % of the desired space. */
  wordSpaceMin?: number;
  wordSpaceMax?: number;
  /** Hyphenation zone: shortest word, letters kept before / after a break, consecutive hyphens (0 = no limit). */
  hyphenMinWord?: number;
  hyphenBefore?: number;
  hyphenAfter?: number;
  hyphenLimit?: number;
  hyphenateCaps?: boolean;
  /** Hyphenation bias, 0 (better spacing, more hyphens) … 100 (fewer hyphens, looser spacing). */
  hyphenBias?: number;
  /** Ragged text: break a word only when the line would otherwise end this far short of the measure, pt. */
  hyphenZone?: number;
  /** Allow the last word of a paragraph to be hyphenated. */
  hyphenateLastWord?: boolean;
  /** Paragraph composer (Knuth–Plass, the whole paragraph at once) or single-line (first fit). */
  composer?: 'paragraph' | 'single';

  /** Shape of a ragged edge: natural, Swiss (short / long / short / long), balanced, wedge, or a repeating pattern. */
  rag?: RagMode;
  /** How far the short lines of a Swiss rag or wedge come in, % of the measure. */
  ragAmount?: number;
  /** Repeating line lengths for the pattern rag, % of the measure, e.g. "100 84 94". */
  ragPattern?: string;
  /** Swiss Swiss rag starts with the long line (true) or the short one. */
  ragStartLong?: boolean;
  /** Don't end a line on a one- or two-letter word (a, I, of, to). */
  avoidShortLineEnds?: boolean;

  /** Letter spacing the justifier may use, thousandths of an em (e.g. −10 … +20). */
  letterSpaceMin?: number;
  letterSpaceMax?: number;
  /** Glyph scaling the justifier may use, % (hz-programme font expansion, e.g. 98 … 102). */
  glyphScaleMin?: number;
  glyphScaleMax?: number;
  /** Alignment of a justified line that holds a single word. */
  singleWordJustify?: 'left' | 'center' | 'right' | 'full';
  /** Alignment of the last line of a justified paragraph. */
  lastLineAlign?: 'left' | 'center' | 'right' | 'justify';
  /** Strength of optical margin alignment, % (100 = the classical amounts). */
  opticalMarginAmount?: number;

  /** Keep options: lines kept with the next paragraph, whole paragraph together, widows and orphans. */
  keepWithNext?: number;
  keepTogether?: boolean;
  widows?: number;
  orphans?: number;
  /** Start the paragraph anywhere, in the next column or in the next frame. */
  startOn?: 'anywhere' | 'column' | 'frame';
  /** Baseline grid: every line, or only the first line of each paragraph. */
  gridAlign?: 'all' | 'first';
  /** Span all columns of a multi-column frame (heads at the top of the frame). */
  spanColumns?: boolean;

  ruleAbove?: ParagraphRule | null;
  ruleBelow?: ParagraphRule | null;
  shading?: ParagraphShading | null;
  list?: ListSpec | null;
  /** Tab stops measured from the column's left edge; `defaultTab` repeats after the last one. */
  tabStops?: TabStop[];
  defaultTab?: number;
  /** Leader for the right-indent tab ({rtab}), e.g. "." for a table of contents. */
  rightTabLeader?: string;
  /** GREP styles: a character style applied to every match of a pattern in the paragraph. */
  grepStyles?: GrepStyle[];
  /** Nested styles: character styles applied to the start of the paragraph (run-in heads). */
  nestedStyles?: NestedStyle[];

  /** Footnotes set at the foot of the column: numbering, size (% of the text) and separator rule. */
  footnoteNumbering?: 'decimal' | 'roman' | 'alpha' | 'symbols';
  footnoteScale?: number;
  footnoteRule?: boolean;
}

export type RagMode = 'natural' | 'swiss' | 'balanced' | 'wedge' | 'pattern';

export interface ParagraphRule {
  weight: number;
  color: string;
  /** Distance from the line (above the first line's cap height, below the last baseline), pt. */
  offset: number;
  width: 'column' | 'text';
  indentLeft?: number;
  indentRight?: number;
  style?: 'solid' | 'dashed' | 'dotted' | 'double';
}

export interface ParagraphShading {
  color: string;
  /** Padding around the paragraph, pt. */
  padding: number;
  stroke?: string | null;
  strokeWidth?: number;
  radius?: number;
}

export interface ListSpec {
  type: 'bullet' | 'number';
  bullet?: string;
  format?: 'decimal' | 'lower-alpha' | 'upper-alpha' | 'lower-roman' | 'upper-roman';
  suffix?: string;
  /** Restart numbering at this value (null = continue). */
  start?: number | null;
  /** Hanging width of the marker, pt. */
  indent?: number;
  color?: string;
  /** Numbers aligned right (on the full stop) or left. */
  align?: 'left' | 'right';
  level?: number;
}

export interface TabStop { pos: number; align: 'left' | 'center' | 'right' | 'decimal'; leader?: string; char?: string }
export interface GrepStyle { pattern: string; style: string; flags?: string }
export interface NestedStyle { style: string; count: number; unit: 'words' | 'characters' | 'sentences' | 'char'; char?: string }

export type KerningMode = 'metrics' | 'optical' | 'none';

/** A named paragraph style: any paragraph property. Unset properties inherit from the frame. */
export type ParagraphStyleProps = Partial<Omit<TextStyle, 'dropCap' | 'axes' | 'writingMode' | 'tateChuYoko'>> & {
  spaceBefore?: number;
  spaceAfter?: number;
};

/** A named character style, applied to a run inside a paragraph. */
export interface CharacterStyleProps {
  fontFamily?: string;
  weight?: number;
  italic?: boolean;
  /** Size relative to the paragraph, %. */
  sizeScale?: number;
  /** Added to the paragraph tracking, thousandths of an em. */
  tracking?: number;
  color?: string;
  textTransform?: TextStyle['textTransform'];
  position?: 'normal' | 'superscript' | 'subscript';
  /** Raise (+) or lower (−) the run, pt. */
  baselineShift?: number;
  features?: Record<string, boolean>;
  /** Absolute size, pt (overrides sizeScale). */
  size?: number;
  underline?: boolean;
  underlineWeight?: number;
  underlineOffset?: number;
  underlineColor?: string;
  strike?: boolean;
  strikeWeight?: number;
  strikeColor?: string;
  /** Marker colour behind the run. */
  highlight?: string;
  /** Horizontal and vertical scale, %; skew (false italic), degrees. */
  hScale?: number;
  vScale?: number;
  skew?: number;
  /** Outline the glyphs. */
  stroke?: string;
  strokeWidth?: number;
  /** Keep the run on one line (no breaks, no hyphenation). */
  noBreak?: boolean;
  /** Hyphenation language for the run. */
  language?: string;
}

export interface ParagraphStyleDef { id: ID; name: string; props: ParagraphStyleProps }
export interface CharacterStyleDef { id: ID; name: string; props: CharacterStyleProps }

/* ------------------------------------------------------------------------- */
/* Elements                                                                   */
/* ------------------------------------------------------------------------- */

export type ElementType =
  | 'text' | 'image' | 'shape' | 'rule' | 'path' | 'svg'
  | 'pattern' | 'ornament' | 'initial' | 'overprint' | 'gradient'
  | 'cutout' | 'drawing' | 'gridtype' | 'motif' | 'table';

/** Cover finishing applied in the 3D preview and flagged in the PDF. */
export type Finish = 'none' | 'gold-foil' | 'silver-foil' | 'copper-foil' | 'holo-foil' | 'blind-deboss' | 'spot-gloss';

export interface ElementBase {
  id: ID;
  type: ElementType;
  name: string;
  x: number; y: number; w: number; h: number; // pt
  rotation: number;  // degrees, about the box centre
  opacity: number;   // 0–1
  blend: BlendMode;
  locked: boolean;
  hidden: boolean;
  flipX?: boolean;
  flipY?: boolean;
  finish?: Finish;
  /** Cover / jacket only: panel the element is anchored to (x is relative to that panel). */
  anchor?: 'front-flap' | 'front' | 'spine' | 'back' | 'back-flap' | null;
  /** Facing pages: an item crossing the gutter is drawn on the facing page beneath its items, or above them. */
  spreadAbove?: boolean;
  /** Text wrap: text frames on the same page flow around this item. */
  wrap?: TextWrap | null;
}

export interface TextWrap {
  /** Around the bounding box, around the shape (ellipses, circles), or jump over it. */
  mode: 'box' | 'shape' | 'jump';
  /** Distance kept between the item and the text, pt. */
  offset: number;
  /** Text on both sides, on the side with more room, or only left / right. */
  side: 'both' | 'largest' | 'left' | 'right';
}

export interface TextElement extends ElementBase {
  type: 'text';
  text: string;
  style: TextStyle;
  columns: number;
  columnGap: number;   // pt
  inset: number;       // pt, inner padding
  verticalAlign: 'top' | 'middle' | 'bottom' | 'justify';
  /** Make every column end at the same depth. */
  balanceColumns?: boolean;
  /** Rule centred in each column gutter. */
  columnRule?: { weight: number; color: string; style?: 'solid' | 'dashed' | 'dotted' } | null;
  /** Where the first baseline sits below the frame top. */
  firstBaseline?: 'cap' | 'ascent' | 'x-height' | 'leading' | 'fixed';
  firstBaselineMin?: number;
  /** Separate insets per side (overrides `inset`). */
  insetSides?: { top: number; right: number; bottom: number; left: number } | null;
  /** Ignore text wrap from other items. */
  wrapIgnore?: boolean;
  /** Grow or shrink the frame's height to fit its text. */
  autoHeight?: boolean;
  /** Thread: overflow continues in this text element (any page). */
  flowNext: ID | null;
  fill: string | null;
  /** Paragraph style the frame's base style follows (redefining the style updates the frame). */
  paraStyle?: ID | null;
}

export interface ImageElement extends ElementBase {
  type: 'image';
  assetId: ID | null;
  fit: 'cover' | 'contain' | 'fill';
  /** Crop offset of the image inside its frame, -1…1. */
  offsetX: number;
  offsetY: number;
  zoom: number;        // ≥ 1
  grayscale: boolean;
  /** Two-colour duotone [shadow, highlight] or null. */
  duotone: [string, string] | null;
  placeholder?: boolean;
}

export type ShapeKind = 'rect' | 'ellipse' | 'polygon' | 'star' | 'triangle' | 'arc';

export interface StrokeStyle {
  fill: string | null;
  stroke: string | null;
  strokeWidth: number; // pt
  dash: number[];      // pt
  cap: 'butt' | 'round' | 'square';
  join: 'miter' | 'round' | 'bevel';
}

export interface ShapeElement extends ElementBase, StrokeStyle {
  type: 'shape';
  shape: ShapeKind;
  radius: number;      // corner radius (rect)
  sides: number;       // polygon / star points
  innerRatio: number;  // star inner radius ratio / arc sweep
}

export type RuleKind = 'single' | 'double' | 'scotch' | 'dotted' | 'wave' | 'zigzag' | 'greek-key' | 'chain';

export interface RuleElement extends ElementBase {
  type: 'rule';
  kind: RuleKind;
  stroke: string;
  strokeWidth: number;
  dash: number[];
  cap: 'butt' | 'round' | 'square';
}

export interface PathElement extends ElementBase, StrokeStyle {
  type: 'path';
  /** Absolute path data in the path's own coordinate box (vw × vh). */
  d: string;
  vw: number;
  vh: number;
  fillRule: 'nonzero' | 'evenodd';
  /** Type on the path. */
  pathText?: PathText | null;
}

export interface PathText {
  text: string;
  fontFamily: string;
  size: number;
  weight: number;
  italic: boolean;
  color: string;
  tracking: number;
  /** Where the text starts / centres / ends along the path, % of its length. */
  offset: number;
  align: 'start' | 'center' | 'end';
  /** On the path, or hanging below it. */
  side: 'over' | 'under';
  baselineShift: number;
  reverse?: boolean;
  features?: Record<string, boolean>;
}

export interface SvgElement extends ElementBase {
  type: 'svg';
  assetId: ID | null;
  fillOverride: string | null;
  strokeOverride: string | null;
}

/** Jurriaan Schrofer — restless / system typography. */
export type PatternKind =
  | 'text-rings' | 'wave-letters' | 'moire-lines' | 'rotating-squares'
  | 'radial-bars' | 'dot-screen' | 'text-spiral' | 'letter-grid-scale';

export interface PatternElement extends ElementBase {
  type: 'pattern';
  kind: PatternKind;
  text: string;
  fontFamily: string;
  color: string;
  color2: string;
  seed: number;
  /** Generator parameters (count, frequency, amplitude, twist …). */
  params: Record<string, number>;
}

/** Catherine of Cleves — marginalia, borders and frames. */
export type OrnamentKind =
  | 'vine-border' | 'acanthus' | 'strewn-flowers' | 'pearls-and-beads'
  | 'shells-and-coins' | 'rubric-frame' | 'ruling' | 'trompe-loeil-frame';

export interface OrnamentPalette {
  gold: string; ink: string; red: string; blue: string; green: string; ground: string;
}

export interface OrnamentElement extends ElementBase {
  type: 'ornament';
  kind: OrnamentKind;
  seed: number;
  /** Width of the decorated band measured in from the box edge, pt. */
  band: number;
  density: number;     // 0–1
  palette: OrnamentPalette;
  /** Which sides of the frame carry decoration. */
  sides: { top: boolean; right: boolean; bottom: boolean; left: boolean };
  shadow: boolean;     // trompe-l'œil drop shadows
  params: Record<string, number>;
}

export interface InitialElement extends ElementBase {
  type: 'initial';
  letter: string;
  fontFamily: string;
  weight: number;
  color: string;
  frame: DropCapFrame;
  frameColor: string;
  ground: string | null;
  seed: number;
}

/** Karel Martens — overprinted monoprint layers. */
export type OverprintKind = 'numerals' | 'circles' | 'squares-grid' | 'stripes' | 'letters' | 'counters';

export interface OverprintElement extends ElementBase {
  type: 'overprint';
  kind: OverprintKind;
  text: string;
  fontFamily: string;
  inks: string[];
  /** Misregistration between ink passes, pt. */
  misregister: number;
  /** Raw roller texture 0–1. */
  texture: number;
  seed: number;
  /** Write real PDF overprint (OP/op) instead of a blend simulation. */
  pdfOverprint: boolean;
  params: Record<string, number>;
}

/** Koichi Sato — soft tonal gradient meshes. */
export interface GradientPoint { x: number; y: number; color: string; radius: number }
export interface GradientElement extends ElementBase {
  type: 'gradient';
  base: string;
  points: GradientPoint[];
  softness: number; // 0–1
  grain: number;    // 0–1
  glow: boolean;
}

/** Bruno Munari — die-cut window through the leaf. */
export interface CutoutElement extends ElementBase {
  type: 'cutout';
  shape: 'rect' | 'ellipse' | 'path';
  d: string;   // used when shape === 'path', in 0..w × 0..h box
  radius: number;
}

/** Wim Crouwel — modular grid alphabet. */
export interface GridTypeElement extends ElementBase {
  type: 'gridtype';
  text: string;
  color: string;
  /** Stroke weight as a fraction of the module, 0.1–1. */
  weight: number;
  /** Corner treatment: 0 = square, 1 = 45° chamfer, 2 = round. */
  corner: number;
  tracking: number; // modules
  showModules: boolean;
}

/* ------------------------------------------------------------------------- */
/* Drawing                                                                    */
/* ------------------------------------------------------------------------- */

export type BrushType =
  | 'pencil' | 'graphite' | 'charcoal' | 'crayon' | 'pastel' | 'marker'
  | 'highlighter' | 'fineliner' | 'ink' | 'calligraphy' | 'watercolor'
  | 'gouache' | 'airbrush' | 'stipple' | 'gold-leaf' | 'eraser';

export interface BrushStroke {
  id: ID;
  brush: BrushType;
  color: string;
  /** Nominal diameter, pt. */
  size: number;
  opacity: number;   // 0–1
  /** Brush-specific 0–1 controls (flow, wetness, grain, hardness …). */
  flow: number;
  hardness: number;
  grain: number;
  wetness: number;
  /** Nib angle in degrees (calligraphy, marker chisel). */
  angle: number;
  seed: number;
  /** Flat array [x, y, pressure, x, y, pressure, …] in the drawing's local pt space. */
  points: number[];
}

export interface DrawingElement extends ElementBase {
  type: 'drawing';
  strokes: BrushStroke[];
  /** Paper tooth used by grainy media. */
  paperGrain: number; // 0–1
}

/**
 * A designer motif: one element type backed by a registry of generators
 * (src/engine/motifs) — marbled endpapers, line-fillers, Penguin bands, Beethoven arcs,
 * dual grids, teaching diagrams and more. `kind` is the registry key.
 */
export interface MotifElement extends ElementBase {
  type: 'motif';
  kind: string;
  seed: number;
  colors: string[];
  params: Record<string, number>;
  text: string;
  fontFamily: string;
}

export type Element =
  | TextElement | ImageElement | ShapeElement | RuleElement | PathElement | SvgElement
  | PatternElement | OrnamentElement | InitialElement | OverprintElement | GradientElement
  | CutoutElement | DrawingElement | GridTypeElement | MotifElement | TableElement;

/* ------------------------------------------------------------------------- */
/* Book structure                                                             */
/* ------------------------------------------------------------------------- */

export type PaperMaterial = 'paper' | 'vellum' | 'colored' | 'kraft';

export interface Page {
  id: ID;
  elements: Element[];
  masterId: ID | null;
  material: PaperMaterial;
  paperColor: string;
  /** Translucency of vellum/tracing paper, 0–1. */
  vellumOpacity: number;
  label?: string;
}

export interface Master {
  id: ID;
  name: string;
  left: Element[];
  right: Element[];
}

export type BindingType = 'case' | 'perfect' | 'smyth' | 'coptic' | 'stab' | 'munari';
export type CoverFinish = 'matte' | 'gloss' | 'soft-touch' | 'cloth' | 'buckram' | 'leather' | 'paper' | 'vellum';
export type EdgeTreatment = 'plain' | 'gilt' | 'stained' | 'sprayed' | 'deckle';

export interface BindingSpec {
  type: BindingType;
  /** Board thickness (case, coptic), pt. */
  boardThickness: number;
  /** Cover stock caliper for soft covers, pt. */
  coverCaliper: number;
  /** French groove / joint between board and spine, pt. */
  hingeGap: number;
  /** Turn-in of covering material over the board edges, pt. */
  turnIn: number;
  /** Squares: board overhang beyond the text block, pt. */
  squares: number;
  /** Spine rounding 0 (flat back) – 1 (full third-circle round). */
  rounding: number;
  /** Raised bands on the spine (leather case bindings). */
  raisedBands: number;
  headband: boolean;
  headbandColors: [string, string];
  /** Pages per folded section/signature. */
  sectionPages: 4 | 8 | 12 | 16 | 32;
  /** Sewing thread diameter, pt. */
  threadDiameter: number;
  threadColor: string;
  /** Japanese stab binding holes (4 = yotsume toji, 5 = kikko, 6 = koki). */
  stabHoles: 4 | 5 | 6;
  /** Distance of stab holes from the spine edge, pt. */
  stabMargin: number;
  /** Fold-at-the-fore-edge leaves (fukuro-toji), traditional for stab bindings. */
  fukuroToji: boolean;
}

export interface PaperSpec {
  gsm: number;          // grammage, g/m²
  /** Bulk / volume in cm³/g; caliper(µm) = gsm × bulk. */
  bulk: number;
  grain: 'long' | 'short';
  /** Parent sheet used for imposition / grain checks, pt. */
  sheetW: number;
  sheetH: number;
  color: string;
}

/**
 * Grid and margins applied inside each panel of a flat cover or jacket (front, back,
 * flaps; the spine gets only head/foot margins). `inner` is the side toward the spine or fold.
 */
export interface PanelGrid {
  margins: Margins;
  columns: number;
  rows: number;
  gutter: number;
  rowGutter: number;
  /** Baseline increment, pt (0 = off). */
  baseline: number;
  /** Head and foot margin on the spine panel, pt. */
  spineMargin: number;
  show: boolean;
  snap: boolean;
}

export interface CoverSpec {
  /** Soft-cover French flaps (0 = no flaps), pt. Case bindings use the dust jacket instead. */
  flapWidth: number;
  finish: CoverFinish;
  /** Cloth / leather / paper base colour of the case. */
  material: string;
  edge: EdgeTreatment;
  edgeColor: string;
  /** Grid and margins on the cover panels (optional for older projects). */
  grid?: PanelGrid;
}

export type JacketFinish = 'matte' | 'gloss' | 'uncoated' | 'soft-touch';

/** Dust jacket that wraps the case (or a soft cover): flaps fold inside the boards. */
export interface JacketSpec {
  enabled: boolean;
  /** Flap width, pt. */
  flapWidth: number;
  /** Added to the case height, pt (usually 0). */
  heightAllowance: number;
  /** Extra ease at each fore-edge fold beyond the board thickness, pt. */
  foldEase: number;
  finish: JacketFinish;
  paperColor: string;
  grid?: PanelGrid;
}

/** User-placed ruler guides on one surface, in that surface's coordinates. */
export interface Guides { x: number[]; y: number[] }

export interface Margins { inner: number; top: number; outer: number; bottom: number }

export type GridMode = 'modular' | 'manuscript' | 'free';

export interface GridSpec {
  mode: GridMode;
  columns: number;
  rows: number;
  gutter: number;       // pt
  rowGutter: number;    // pt
  baseline: number;     // pt increment
  baselineOffset: number; // pt from the top margin to the first baseline
  /** Bosshard dual micro-grid subdivisions per module (1 = off). */
  microDivisions: number;
  showGrid: boolean;
  showBaseline: boolean;
  showMargins: boolean;
  showBleed: boolean;
  snap: boolean;
  snapToBaseline: boolean;
  /** Show canon construction lines (Van de Graaf / golden section). */
  showCanon: boolean;
  /** Bosshard: a second column system superimposed on the first (0 = off). */
  secondaryColumns?: number;
  /** Hochuli: tint loose / tight lines and mark hyphen ladders on the canvas. */
  showSpacing?: boolean;
  /** Facing pages: one column grid across the spread, outer margin to outer margin (0 = off). */
  spreadColumns?: number;
  spreadGutter?: number;
}

export interface BookSpec {
  title: string;
  subtitle: string;
  author: string;
  publisher: string;
  unit: Unit;
  trimW: number;
  trimH: number;
  bleed: number;
  slug: number;
  margins: Margins;
  facing: boolean;
  /** Reading / binding direction: 'rtl' binds on the right (Japanese, Arabic, Hebrew). */
  direction: 'ltr' | 'rtl';
  /** Page count used for the spine calculation (≥ designed pages). */
  plannedPages: number;
  paper: PaperSpec;
  binding: BindingSpec;
  cover: CoverSpec;
  /** Optional for projects saved before dust jackets existed. */
  jacket?: JacketSpec;
  grid: GridSpec;
}

export interface Asset {
  id: ID;
  kind: 'image' | 'svg';
  name: string;
  mime: string;
  /** data: URL (persisted with the project). */
  src: string;
  width: number;
  height: number;
}

/** Metadata of a user-uploaded font; the bytes live in IndexedDB / the project file. */
export interface UploadedFontMeta {
  id: ID;
  family: string;      // display family name
  fileName: string;
  weight: number;
  italic: boolean;
}

export interface Project {
  version: 1;
  id: ID;
  name: string;
  book: BookSpec;
  pages: Page[];
  masters: Master[];
  cover: { elements: Element[] };
  /** Dust-jacket artwork (optional for older projects). */
  jacket?: { elements: Element[] };
  /** Ruler guides keyed by surface (`page:<id>`, `master:<id>:left`, `cover`, `jacket`). */
  guides?: Record<SurfaceKey, Guides>;
  /** Hide or lock all ruler guides. */
  guidesHidden?: boolean;
  guidesLocked?: boolean;
  swatches: Swatch[];
  assets: Record<ID, Asset>;
  fonts: UploadedFontMeta[];
  /** Hyphenation exceptions: "ty-pog-ra-phy" sets the breaks, a word without hyphens never breaks. */
  hyphenDictionary?: string[];
  /** Named paragraph and character styles (`[Name]` / `<Name>…</Name>` in stories). */
  paragraphStyles?: ParagraphStyleDef[];
  characterStyles?: CharacterStyleDef[];
  /** Named table and cell styles (src/model/table.ts). */
  tableStyles?: TableStyleDef[];
  cellStyles?: CellStyleDef[];
}

/* ------------------------------------------------------------------------- */
/* Surfaces                                                                   */
/* ------------------------------------------------------------------------- */

/**
 * A surface is anything that holds elements:
 *   `page:<pageId>`  `master:<masterId>:left|right`  `cover`
 */
export type SurfaceKey = string;

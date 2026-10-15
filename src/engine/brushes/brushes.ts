/**
 * Brush catalogue — labels, grouping, sensible defaults and which controls the
 * UI should expose per brush. Sizes are nominal diameters in pt.
 */
import type { BrushStroke, BrushType } from '../../model/types';

export type BrushParams = Pick<BrushStroke, 'size' | 'opacity' | 'flow' | 'hardness' | 'grain' | 'wetness' | 'angle'>;

export interface BrushDef {
  type: BrushType;
  label: string;
  group: 'Dry media' | 'Wet media' | 'Ink & pens' | 'Special';
  /** One line, written for book designers / illustrators. */
  description: string;
  defaults: BrushParams;
  /** Which params the UI should expose for this brush. */
  controls: (keyof BrushParams)[];
  pressureSize: boolean;
  pressureOpacity: boolean;
}

const p = (
  size: number, opacity: number, flow: number, hardness: number,
  grain: number, wetness: number, angle = 0,
): BrushParams => ({ size, opacity, flow, hardness, grain, wetness, angle });

export const BRUSHES: BrushDef[] = [
  /* Dry media ------------------------------------------------------------ */
  {
    type: 'pencil', label: 'Pencil', group: 'Dry media',
    description: 'HB graphite line that catches the paper tooth — for sketches, under-drawing and marginal notes.',
    defaults: p(1.6, 0.9, 0.8, 0.7, 0.7, 0),
    controls: ['size', 'opacity', 'grain'],
    pressureSize: true, pressureOpacity: true,
  },
  {
    type: 'graphite', label: 'Graphite stick', group: 'Dry media',
    description: 'Soft 6B stick held on its side: broad, grainy tone that builds with every pass.',
    defaults: p(7, 0.85, 0.6, 0.4, 0.8, 0),
    controls: ['size', 'opacity', 'flow', 'grain', 'hardness'],
    pressureSize: true, pressureOpacity: true,
  },
  {
    type: 'charcoal', label: 'Charcoal', group: 'Dry media',
    description: 'Vine charcoal with broken edges and loose dust — dramatic, matte darks for frontispieces.',
    defaults: p(9, 0.95, 0.75, 0.5, 0.9, 0),
    controls: ['size', 'opacity', 'flow', 'grain'],
    pressureSize: true, pressureOpacity: true,
  },
  {
    type: 'crayon', label: 'Wax crayon', group: 'Dry media',
    description: 'Waxy pigment that sits only on the paper peaks — lively texture for picture books.',
    defaults: p(6, 1, 0.8, 0.7, 0.85, 0),
    controls: ['size', 'opacity', 'grain'],
    pressureSize: true, pressureOpacity: true,
  },
  {
    type: 'pastel', label: 'Soft pastel', group: 'Dry media',
    description: 'Chalky, powdery colour that lightens under a soft touch — atmospheric skies and endpapers.',
    defaults: p(12, 0.9, 0.65, 0.3, 0.7, 0),
    controls: ['size', 'opacity', 'flow', 'grain', 'hardness'],
    pressureSize: true, pressureOpacity: true,
  },

  /* Wet media ------------------------------------------------------------ */
  {
    type: 'watercolor', label: 'Watercolour', group: 'Wet media',
    description: 'Transparent wash with a dark drying edge, soft blooms and granulating pigment; washes glaze over each other.',
    defaults: p(20, 0.6, 0.7, 0.3, 0.6, 0.6),
    controls: ['size', 'opacity', 'flow', 'wetness', 'grain'],
    pressureSize: true, pressureOpacity: false,
  },
  {
    type: 'gouache', label: 'Gouache', group: 'Wet media',
    description: 'Opaque matte paint with visible bristle marks and a dry-brush tail.',
    defaults: p(14, 1, 0.75, 0.7, 0.5, 0.3),
    controls: ['size', 'opacity', 'flow', 'wetness'],
    pressureSize: true, pressureOpacity: false,
  },
  {
    type: 'airbrush', label: 'Airbrush', group: 'Wet media',
    description: 'Soft radial spray with fine speckle — vignettes, shadows and gradients on covers.',
    defaults: p(30, 0.6, 0.25, 0, 0.3, 0),
    controls: ['size', 'opacity', 'flow', 'hardness'],
    pressureSize: false, pressureOpacity: true,
  },

  /* Ink & pens ----------------------------------------------------------- */
  {
    type: 'fineliner', label: 'Fineliner', group: 'Ink & pens',
    description: 'Crisp, even technical-pen line for diagrams, maps and clean line art.',
    defaults: p(0.7, 1, 1, 1, 0, 0),
    controls: ['size', 'opacity'],
    pressureSize: false, pressureOpacity: false,
  },
  {
    type: 'ink', label: 'Dip pen & ink', group: 'Ink & pens',
    description: 'Glossy black ink whose line swells with pressure and tapers at both ends.',
    defaults: p(4, 1, 0.85, 1, 0, 0),
    controls: ['size', 'opacity', 'flow'],
    pressureSize: true, pressureOpacity: false,
  },
  {
    type: 'calligraphy', label: 'Broad-edge nib', group: 'Ink & pens',
    description: 'Square-cut nib held at a fixed angle (30° for textura and bastarda hands) — sharp thick/thin contrast.',
    defaults: p(10, 1, 1, 1, 0, 0, 30),
    controls: ['size', 'opacity', 'angle'],
    pressureSize: true, pressureOpacity: false,
  },
  {
    type: 'marker', label: 'Marker', group: 'Ink & pens',
    description: 'Alcohol marker with a chisel nib: even translucency in one stroke, darker where strokes overlap.',
    defaults: p(8, 0.7, 1, 1, 0, 0, 30),
    controls: ['size', 'opacity', 'angle'],
    pressureSize: false, pressureOpacity: false,
  },
  {
    type: 'highlighter', label: 'Highlighter', group: 'Ink & pens',
    description: 'Wide, flat, very translucent band for marking up proofs and annotations.',
    defaults: p(14, 0.35, 1, 1, 0, 0, 80),
    controls: ['size', 'opacity', 'angle'],
    pressureSize: false, pressureOpacity: false,
  },
  {
    type: 'stipple', label: 'Stipple', group: 'Ink & pens',
    description: 'Pointillist ink dots scattered along the stroke; press harder for denser tone.',
    defaults: p(14, 1, 0.5, 1, 0.4, 0),
    controls: ['size', 'opacity', 'flow', 'grain'],
    pressureSize: false, pressureOpacity: true,
  },

  /* Special -------------------------------------------------------------- */
  {
    type: 'gold-leaf', label: 'Gold leaf', group: 'Special',
    description: 'Burnished gilding with a raised edge and fine craquelure, like the gold of illuminated initials.',
    defaults: p(10, 1, 1, 0.9, 0.5, 0),
    controls: ['size', 'opacity', 'grain'],
    pressureSize: true, pressureOpacity: false,
  },
  {
    type: 'eraser', label: 'Eraser', group: 'Special',
    description: 'Lifts any medium off the drawing; hardness sets a crisp or feathered edge.',
    defaults: p(12, 1, 1, 0.6, 0, 0),
    controls: ['size', 'opacity', 'hardness'],
    pressureSize: true, pressureOpacity: true,
  },
];

const BY_TYPE = new Map<BrushType, BrushDef>(BRUSHES.map((b) => [b.type, b]));

export function getBrush(type: BrushType): BrushDef {
  return BY_TYPE.get(type) ?? BRUSHES[0];
}

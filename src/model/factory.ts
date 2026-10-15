import type {
  Element, ElementType, TextStyle, TextElement, ImageElement, ShapeElement, RuleElement, PathElement, SvgElement,
  PatternElement, OrnamentElement, InitialElement, OverprintElement, GradientElement, CutoutElement, DrawingElement,
  GridTypeElement, ElementBase, OrnamentPalette, Page, Master, MotifElement,
} from './types';
import { uid } from '../lib/random';
import { getMotif } from '../engine/motifs';

export const INK = '#1b1813';
export const VERMILION = '#b0331f';
export const ULTRAMARINE = '#2b4a8f';
export const GOLD = '#c9a227';

export const CLEVES_PALETTE: OrnamentPalette = {
  gold: GOLD, ink: '#2a2118', red: VERMILION, blue: ULTRAMARINE, green: '#3f6b3a', ground: '#efe5cf',
};

export const DEFAULT_TEXT_STYLE: TextStyle = {
  fontFamily: 'eb-garamond',
  fontSize: 11,
  leading: 14,
  weight: 400,
  italic: false,
  tracking: 0,
  wordSpacing: 0,
  align: 'justify',
  color: INK,
  axes: {},
  features: { onum: true, pnum: true },
  hyphenate: true,
  language: 'en-us',
  firstLineIndent: 11,
  indentFirstParagraph: false,
  paragraphSpacing: 0,
  opticalMargin: true,
  baselineGrid: true,
  direction: 'ltr',
  writingMode: 'horizontal',
  tateChuYoko: true,
  textTransform: 'none',
  firstLineSmallCaps: false,
  dropCap: { enabled: false, lines: 3, fontFamily: null, weight: 400, color: VERMILION, frame: 'none', frameColor: ULTRAMARINE, gap: 4 },
  avoidRunts: true,
};

export function textStyle(over: Partial<TextStyle> = {}): TextStyle {
  return {
    ...DEFAULT_TEXT_STYLE,
    ...over,
    features: { ...DEFAULT_TEXT_STYLE.features, ...(over.features ?? {}) },
    axes: { ...(over.axes ?? {}) },
    dropCap: { ...DEFAULT_TEXT_STYLE.dropCap, ...(over.dropCap ?? {}) },
  };
}

const NAMES: Record<ElementType, string> = {
  text: 'Text', image: 'Image', shape: 'Shape', rule: 'Rule', path: 'Path', svg: 'SVG',
  pattern: 'Kinetic pattern', ornament: 'Marginalia', initial: 'Initial', overprint: 'Overprint',
  gradient: 'Tonal gradient', cutout: 'Die-cut', drawing: 'Drawing', gridtype: 'Grid type', motif: 'Motif',
};

function base(type: ElementType, over: Partial<ElementBase>): ElementBase {
  return {
    id: uid(type.slice(0, 3)), type, name: NAMES[type], x: 0, y: 0, w: 100, h: 100, rotation: 0, opacity: 1,
    blend: 'normal', locked: false, hidden: false, finish: 'none', ...over,
  };
}

type Over<T> = Partial<Omit<T, 'type'>>;

export function makeText(over: Over<TextElement> = {}): TextElement {
  return {
    ...base('text', over), type: 'text', text: 'Type here.', columns: 1, columnGap: 12, inset: 0, verticalAlign: 'top',
    flowNext: null, fill: null, ...over, style: textStyle(over.style),
  } as TextElement;
}

export function makeImage(over: Over<ImageElement> = {}): ImageElement {
  return { ...base('image', over), type: 'image', assetId: null, fit: 'cover', offsetX: 0, offsetY: 0, zoom: 1, grayscale: false, duotone: null, ...over } as ImageElement;
}

export function makeShape(over: Over<ShapeElement> = {}): ShapeElement {
  return {
    ...base('shape', over), type: 'shape', shape: 'rect', fill: '#d8cfbd', stroke: null, strokeWidth: 1, dash: [], cap: 'butt', join: 'miter',
    radius: 0, sides: 5, innerRatio: 0.5, ...over,
  } as ShapeElement;
}

export function makeRule(over: Over<RuleElement> = {}): RuleElement {
  return { ...base('rule', { h: 8, ...over }), type: 'rule', kind: 'single', stroke: INK, strokeWidth: 0.5, dash: [], cap: 'butt', ...over } as RuleElement;
}

export function makePath(over: Over<PathElement> = {}): PathElement {
  return {
    ...base('path', over), type: 'path', d: 'M0 100 C30 0 70 0 100 100', vw: 100, vh: 100, fill: null, stroke: INK, strokeWidth: 1,
    dash: [], cap: 'round', join: 'round', fillRule: 'nonzero', ...over,
  } as PathElement;
}

export function makeSvg(over: Over<SvgElement> = {}): SvgElement {
  return { ...base('svg', over), type: 'svg', assetId: null, fillOverride: null, strokeOverride: null, ...over } as SvgElement;
}

export function makePattern(over: Over<PatternElement> = {}): PatternElement {
  return {
    ...base('pattern', { w: 300, h: 300, ...over }), type: 'pattern', kind: 'text-rings', text: 'RESTLESS TYPOGRAPHY ',
    fontFamily: 'space-grotesk', color: INK, color2: VERMILION, seed: 7, params: {}, ...over,
  } as PatternElement;
}

export function makeOrnament(over: Over<OrnamentElement> = {}): OrnamentElement {
  return {
    ...base('ornament', { w: 300, h: 420, ...over }), type: 'ornament', kind: 'vine-border', seed: 11, band: 42, density: 0.6,
    palette: { ...CLEVES_PALETTE }, sides: { top: true, right: true, bottom: true, left: true }, shadow: true, params: {}, ...over,
  } as OrnamentElement;
}

export function makeInitial(over: Over<InitialElement> = {}): InitialElement {
  return {
    ...base('initial', { w: 72, h: 72, ...over }), type: 'initial', letter: 'A', fontFamily: 'cinzel', weight: 700, color: '#f7efd9',
    frame: 'gilded', frameColor: ULTRAMARINE, ground: ULTRAMARINE, seed: 3, ...over,
  } as InitialElement;
}

export function makeOverprint(over: Over<OverprintElement> = {}): OverprintElement {
  return {
    ...base('overprint', { w: 300, h: 300, blend: 'multiply', ...over }), type: 'overprint', kind: 'numerals', text: '1234567890',
    fontFamily: 'ibm-plex-mono', inks: ['#ff4f9a', '#19a7e0', '#ffd400'], misregister: 3, texture: 0.25, seed: 5, pdfOverprint: true, params: {}, ...over,
  } as OverprintElement;
}

export function makeGradient(over: Over<GradientElement> = {}): GradientElement {
  return {
    ...base('gradient', { w: 300, h: 400, ...over }), type: 'gradient', base: '#0f1022',
    points: [
      { x: 0.3, y: 0.35, color: '#f2b8a0', radius: 0.55 },
      { x: 0.72, y: 0.62, color: '#7f8cf0', radius: 0.5 },
      { x: 0.5, y: 0.9, color: '#ffe9c2', radius: 0.35 },
    ],
    softness: 0.7, grain: 0.25, glow: true, ...over,
  } as GradientElement;
}

export function makeCutout(over: Over<CutoutElement> = {}): CutoutElement {
  return { ...base('cutout', { w: 90, h: 90, ...over }), type: 'cutout', shape: 'ellipse', d: '', radius: 0, ...over } as CutoutElement;
}

export function makeDrawing(over: Over<DrawingElement> = {}): DrawingElement {
  return { ...base('drawing', over), type: 'drawing', strokes: [], paperGrain: 0.5, ...over } as DrawingElement;
}

export function makeGridType(over: Over<GridTypeElement> = {}): GridTypeElement {
  return { ...base('gridtype', { w: 320, h: 60, ...over }), type: 'gridtype', text: 'new alphabet', color: INK, weight: 0.62, corner: 1, tracking: 1, showModules: false, ...over } as GridTypeElement;
}

/** A registry motif with its declared defaults (size, colours, params, text, font). */
export function makeMotif(kind: string, over: Over<MotifElement> = {}): MotifElement {
  const def = getMotif(kind);
  const size = def?.defaultSize ?? { w: 200, h: 200 };
  return {
    ...base('motif', { w: size.w, h: size.h, name: def?.label ?? 'Motif', ...over }),
    type: 'motif',
    kind,
    seed: Math.floor(Math.random() * 100000),
    colors: def?.colors.map((c) => c.default) ?? [],
    params: Object.fromEntries((def?.params ?? []).map((p) => [p.key, p.default])),
    text: def?.text?.default ?? '',
    fontFamily: def?.fontFamily ?? 'inter',
    ...over,
  } as MotifElement;
}

export function makeElement(type: ElementType, over: Partial<Element> = {}): Element {
  switch (type) {
    case 'text': return makeText(over as Over<TextElement>);
    case 'image': return makeImage(over as Over<ImageElement>);
    case 'shape': return makeShape(over as Over<ShapeElement>);
    case 'rule': return makeRule(over as Over<RuleElement>);
    case 'path': return makePath(over as Over<PathElement>);
    case 'svg': return makeSvg(over as Over<SvgElement>);
    case 'pattern': return makePattern(over as Over<PatternElement>);
    case 'ornament': return makeOrnament(over as Over<OrnamentElement>);
    case 'initial': return makeInitial(over as Over<InitialElement>);
    case 'overprint': return makeOverprint(over as Over<OverprintElement>);
    case 'gradient': return makeGradient(over as Over<GradientElement>);
    case 'cutout': return makeCutout(over as Over<CutoutElement>);
    case 'drawing': return makeDrawing(over as Over<DrawingElement>);
    case 'gridtype': return makeGridType(over as Over<GridTypeElement>);
    case 'motif': return makeMotif((over as Partial<MotifElement>).kind ?? 'grid-diagram', over as Over<MotifElement>);
  }
}

/** Deep clone with fresh ids (duplicate / paste). */
export function cloneElement<T extends Element>(el: T, dx = 0, dy = 0): T {
  const copy = JSON.parse(JSON.stringify(el)) as T;
  copy.id = uid(el.type.slice(0, 3));
  copy.x += dx;
  copy.y += dy;
  if (copy.type === 'text') copy.flowNext = null;
  if (copy.type === 'drawing') copy.strokes = copy.strokes.map((s) => ({ ...s, id: uid('stk') }));
  return copy;
}

export function makePage(over: Partial<Page> = {}): Page {
  return { id: uid('pg'), elements: [], masterId: null, material: 'paper', paperColor: '#f7f2e7', vellumOpacity: 0.55, ...over };
}

export function makeMaster(name: string, over: Partial<Master> = {}): Master {
  return { id: uid('ms'), name, left: [], right: [], ...over };
}

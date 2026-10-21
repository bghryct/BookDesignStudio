/**
 * Style properties for the text engine: applying paragraph styles to a frame style, merging
 * character styles, and the inline property syntax used for local formatting inside a story:
 *
 *   <{size:14; color:#b0331f; track:40}>words</>      character formatting
 *   [{align:center; before:12; rag:swiss}] Paragraph   paragraph formatting
 *
 * Keys are forgiving (aliases, units-free numbers in pt / ‰ / %); unknown keys are ignored.
 */
import type { TextStyle, ParagraphStyleProps, CharacterStyleProps, ParagraphStyleDef, CharacterStyleDef } from '../../model/types';

/** The frame style with a paragraph style laid over it (unset properties inherit). */
export function applyParagraphStyle(s: TextStyle, p: ParagraphStyleProps | null | undefined): TextStyle {
  if (!p) return s;
  const out = { ...s } as unknown as Record<string, unknown>;
  for (const [k, v] of Object.entries(p)) {
    if (v == null || k === 'spaceBefore' || k === 'spaceAfter' || k === 'features') continue;
    out[k] = v;
  }
  const o = out as unknown as TextStyle;
  // A new size without a new leading keeps the frame's proportion of leading to size.
  if (p.fontSize != null && p.leading == null) o.leading = +((s.leading * p.fontSize) / s.fontSize).toFixed(2);
  if (p.fontFamily != null && p.fontFamily !== s.fontFamily) o.axes = {};
  if (p.features) o.features = { ...s.features, ...p.features };
  return o;
}

/** Character styles nest: later ones win, OpenType features merge. */
export function mergeCs(stack: CharacterStyleProps[]): CharacterStyleProps | null {
  return stack.length ? stack.reduce<CharacterStyleProps>((a, b) => ({ ...a, ...b, features: { ...(a.features ?? {}), ...(b.features ?? {}) } }), {}) : null;
}

export function mergePara(a: ParagraphStyleProps | null, b: ParagraphStyleProps | null): ParagraphStyleProps | null {
  if (!a) return b;
  if (!b) return a;
  return { ...a, ...b, features: a.features || b.features ? { ...(a.features ?? {}), ...(b.features ?? {}) } : undefined };
}

/*
 * Based-on styles: a style's effective properties are its parent's (recursively) with its own on
 * top. Resolved once per list of definitions; cycles stop at the first repeat.
 */
const resolvedPara = new WeakMap<object, ParagraphStyleDef[]>();
const resolvedChar = new WeakMap<object, CharacterStyleDef[]>();

function resolveDefs<D extends { id: string; props: P; basedOn?: string | null }, P>(defs: D[], merge: (a: P, b: P) => P): D[] {
  const byId = new Map(defs.map((d) => [d.id, d]));
  const memo = new Map<string, P>();
  const eff = (d: D, seen: Set<string>): P => {
    const hit = memo.get(d.id);
    if (hit) return hit;
    const parent = d.basedOn ? byId.get(d.basedOn) : undefined;
    const p = parent && !seen.has(parent.id) ? merge(eff(parent, new Set([...seen, d.id])), d.props) : d.props;
    memo.set(d.id, p);
    return p;
  };
  return defs.map((d) => (d.basedOn ? { ...d, props: eff(d, new Set([d.id])) } : d));
}

export function resolveParaStyles(defs: ParagraphStyleDef[]): ParagraphStyleDef[] {
  if (!defs.some((d) => d.basedOn)) return defs;
  let r = resolvedPara.get(defs);
  if (!r) { r = resolveDefs<ParagraphStyleDef, ParagraphStyleProps>(defs, (a, b) => mergePara(a, b) ?? {}); resolvedPara.set(defs, r); }
  return r;
}

export function resolveCharStyles(defs: CharacterStyleDef[]): CharacterStyleDef[] {
  if (!defs.some((d) => d.basedOn)) return defs;
  let r = resolvedChar.get(defs);
  if (!r) { r = resolveDefs<CharacterStyleDef, CharacterStyleProps>(defs, (a, b) => mergeCs([a, b]) ?? {}); resolvedChar.set(defs, r); }
  return r;
}

const CHAR_KEYS: Record<string, keyof CharacterStyleProps> = {
  font: 'fontFamily', family: 'fontFamily', typeface: 'fontFamily', fontfamily: 'fontFamily',
  weight: 'weight', w: 'weight', wght: 'weight',
  italic: 'italic', i: 'italic',
  size: 'size', pt: 'size', scale: 'sizeScale', sizescale: 'sizeScale',
  track: 'tracking', tracking: 'tracking', ls: 'tracking',
  color: 'color', colour: 'color', c: 'color', fill: 'color',
  case: 'textTransform', transform: 'textTransform',
  pos: 'position', position: 'position',
  shift: 'baselineShift', baseline: 'baselineShift', bs: 'baselineShift',
  u: 'underline', underline: 'underline', uweight: 'underlineWeight', uoffset: 'underlineOffset', ucolor: 'underlineColor', ustyle: 'underlineStyle', ugap: 'underlineGap', link: 'link', href: 'link', url: 'link',
  s: 'strike', strike: 'strike', strikethrough: 'strike', sweight: 'strikeWeight', scolor: 'strikeColor',
  highlight: 'highlight', bg: 'highlight', mark: 'highlight',
  hscale: 'hScale', h: 'hScale', vscale: 'vScale', v: 'vScale', skew: 'skew', slant: 'skew',
  stroke: 'stroke', outline: 'stroke', strokewidth: 'strokeWidth', sw: 'strokeWidth',
  nobreak: 'noBreak', nb: 'noBreak',
  lang: 'language', language: 'language', rotate: 'rotate', rot: 'rotate', emphasis: 'emphasis', kenten: 'emphasis',
  features: 'features', ot: 'features',
};

const PARA_KEYS: Record<string, keyof ParagraphStyleProps> = {
  align: 'align', a: 'align',
  font: 'fontFamily', family: 'fontFamily', size: 'fontSize', pt: 'fontSize', leading: 'leading', lead: 'leading',
  weight: 'weight', italic: 'italic', track: 'tracking', tracking: 'tracking', color: 'color', colour: 'color', case: 'textTransform',
  indent: 'firstLineIndent', first: 'firstLineIndent', left: 'leftIndent', right: 'rightIndent',
  before: 'spaceBefore', after: 'spaceAfter', spacebefore: 'spaceBefore', spaceafter: 'spaceAfter',
  hyphenate: 'hyphenate', hyph: 'hyphenate', kerning: 'kerning', kern: 'kerning',
  rag: 'rag', ragamount: 'ragAmount', amount: 'ragAmount', ragpattern: 'ragPattern', pattern: 'ragPattern',
  keep: 'keepWithNext', keepwithnext: 'keepWithNext', keepprev: 'keepWithPrevious', keepwithprevious: 'keepWithPrevious', together: 'keepTogether', widows: 'widows', orphans: 'orphans', start: 'startOn',
  last: 'lastLineAlign', lastline: 'lastLineAlign', single: 'singleWordJustify',
  wordmin: 'wordSpaceMin', wordmax: 'wordSpaceMax', lsmin: 'letterSpaceMin', lsmax: 'letterSpaceMax', gsmin: 'glyphScaleMin', gsmax: 'glyphScaleMax',
  optical: 'opticalMargin', composer: 'composer', grid: 'baselineGrid', span: 'spanColumns',
  split: 'splitColumns', splitcolumns: 'splitColumns', splitgap: 'splitGap', hyphencolumns: 'hyphenateAcrossColumns', acrosscolumns: 'hyphenateAcrossColumns',
};

const ULINES = new Set(['solid', 'double', 'dashed', 'dotted', 'wavy']);

const CASES: Record<string, TextStyle['textTransform']> = { upper: 'uppercase', uppercase: 'uppercase', caps: 'uppercase', lower: 'lowercase', lowercase: 'lowercase', sc: 'small-caps', smallcaps: 'small-caps', 'small-caps': 'small-caps', none: 'none' };
const ALIGNS: Record<string, string> = { left: 'left', l: 'left', center: 'center', centre: 'center', c: 'center', right: 'right', r: 'right', justify: 'justify', j: 'justify', full: 'justify-all', 'justify-all': 'justify-all' };

function value(raw: string): unknown {
  const v = raw.trim();
  if (/^(true|yes|on)$/i.test(v)) return true;
  if (/^(false|no|off)$/i.test(v)) return false;
  if (/^[+-]?\d+(\.\d+)?(pt|%|‰)?$/.test(v)) return parseFloat(v);
  return v.replace(/^["']|["']$/g, '');
}

function entries(src: string): [string, unknown][] {
  return src.split(/[;,](?![^(]*\))/).map((part) => part.trim()).filter(Boolean).map((part) => {
    const m = /^([A-Za-z-]+)\s*[:=]\s*(.+)$/.exec(part);
    return m ? [m[1].toLowerCase(), value(m[2])] : [part.toLowerCase(), true];
  });
}

function features(v: unknown): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const t of String(v).split(/[\s+]+/).filter(Boolean)) out[t.replace(/^-/, '')] = !t.startsWith('-');
  return out;
}

/** `size:14; color:#c00; super` → character properties. */
export function parseCharProps(src: string): CharacterStyleProps {
  const out: Record<string, unknown> = {};
  for (const [k0, v] of entries(src)) {
    if (k0 === 'bold' || k0 === 'b') { out.weight = v === false ? 400 : 700; continue; }
    if (k0 === 'super' || k0 === 'sup' || k0 === 'superscript') { out.position = 'superscript'; continue; }
    if (k0 === 'sub' || k0 === 'subscript') { out.position = 'subscript'; continue; }
    if (k0 === 'roman') { out.italic = false; continue; }
    if (CASES[k0] && v === true) { out.textTransform = CASES[k0]; continue; }
    const k = CHAR_KEYS[k0];
    if (!k) continue;
    if (k === 'textTransform') out[k] = CASES[String(v).toLowerCase()] ?? 'none';
    else if (k === 'position') out[k] = /^sup/i.test(String(v)) ? 'superscript' : /^sub/i.test(String(v)) ? 'subscript' : 'normal';
    else if (k === 'features') out[k] = features(v);
    else if (k === 'underline' && typeof v === 'string' && ULINES.has(v.toLowerCase())) { out.underline = true; out.underlineStyle = v.toLowerCase(); }
    else if (k === 'underline' || k === 'strike') {
      if (typeof v === 'string') { out[k] = true; out[k === 'underline' ? 'underlineColor' : 'strikeColor'] = v; } else out[k] = !!v;
    } else if (k === 'stroke' && v === true) out[k] = 'currentColor';
    else out[k] = v;
  }
  return out as CharacterStyleProps;
}

/** `align:center; before:12; rag:swiss` → paragraph properties. */
export function parseParaProps(src: string): ParagraphStyleProps {
  const out: Record<string, unknown> = {};
  for (const [k0, v] of entries(src)) {
    if (ALIGNS[k0] && v === true) { out.align = ALIGNS[k0]; continue; }
    if (k0 === 'swiss' || k0 === 'balanced' || k0 === 'wedge') { out.rag = k0; continue; }
    if (k0 === 'bullet' || k0 === 'bullets') { out.list = { type: 'bullet', bullet: typeof v === 'string' ? v : '•' }; continue; }
    if (k0 === 'number' || k0 === 'numbered' || k0 === 'list') { out.list = { ...(out.list as object ?? {}), type: 'number', format: typeof v === 'string' && v !== 'number' ? v : 'decimal' }; continue; }
    if (k0 === 'level') { out.list = { type: 'number', ...(out.list as object ?? {}), level: Number(v) || 0 }; continue; }
    if (k0 === 'multi' || k0 === 'hierarchical') { out.list = { type: 'number', ...(out.list as object ?? {}), hierarchical: v !== false }; continue; }
    const k = PARA_KEYS[k0];
    if (!k) continue;
    if (k === 'align' || k === 'lastLineAlign' || k === 'singleWordJustify') out[k] = ALIGNS[String(v).toLowerCase()] === 'justify-all' && k !== 'align' ? 'justify' : ALIGNS[String(v).toLowerCase()] ?? v;
    else if (k === 'textTransform') out[k] = CASES[String(v).toLowerCase()] ?? 'none';
    else if (k === 'keepWithPrevious' || k === 'keepTogether' || k === 'hyphenate' || k === 'opticalMargin' || k === 'baselineGrid' || k === 'spanColumns' || k === 'hyphenateAcrossColumns') out[k] = !!v;
    else if (k === 'splitColumns') out[k] = v === true ? 2 : Number(v) || 1;
    else if (k === 'keepWithNext' && v === true) out[k] = 2;
    else out[k] = v;
  }
  return out as ParagraphStyleProps;
}

/** Inverse of parseCharProps for the story editor's formatting popover. */
export function charPropsToString(p: CharacterStyleProps): string {
  const parts: string[] = [];
  const add = (k: string, v: unknown) => { if (v != null && v !== '') parts.push(v === true ? k : `${k}:${v}`); };
  add('font', p.fontFamily);
  add('size', p.size);
  add('scale', p.sizeScale);
  add('weight', p.weight);
  if (p.italic != null) parts.push(p.italic ? 'italic' : 'roman');
  add('track', p.tracking);
  add('color', p.color);
  if (p.textTransform && p.textTransform !== 'none') add('case', p.textTransform === 'small-caps' ? 'sc' : p.textTransform === 'uppercase' ? 'upper' : 'lower');
  if (p.position === 'superscript') parts.push('super');
  if (p.position === 'subscript') parts.push('sub');
  add('shift', p.baselineShift);
  if (p.underline) parts.push(p.underlineStyle && p.underlineStyle !== 'solid' ? `underline:${p.underlineStyle}` : 'underline');
  add('ugap', p.underlineGap);
  add('link', p.link);
  if (p.strike) parts.push('strike');
  add('highlight', p.highlight);
  add('hscale', p.hScale);
  add('vscale', p.vScale);
  add('skew', p.skew);
  add('rotate', p.rotate);
  add('kenten', p.emphasis);
  add('stroke', p.stroke);
  add('strokewidth', p.strokeWidth);
  if (p.noBreak) parts.push('nobreak');
  add('lang', p.language);
  if (p.features) add('features', Object.entries(p.features).map(([t, on]) => (on ? t : `-${t}`)).join(' '));
  return parts.join('; ');
}

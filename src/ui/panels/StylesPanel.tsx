import React, { useState } from 'react';
import clsx from 'clsx';
import type { Draft } from 'immer';
import { Plus, Trash, ChevronRight } from 'lucide-react';
import { useStore } from '../../store/store';
import type {
  Project, TextElement, TextStyle, Element, ParagraphStyleProps, CharacterStyleProps, ParagraphStyleDef, CharacterStyleDef,
} from '../../model/types';
import { applyParagraphStyle } from '../../engine/textLayout';
import { getFamilies, getFamily } from '../../engine/fonts';
import { VERMILION } from '../../model/factory';
import { uid } from '../../lib/random';
import { Section, Row, NumberField, Select, Toggle, ColorField, TextInput, Button, IconButton, Hint } from '../controls';

/* -------------------------------------------------------------------------- */
/* Starter styles                                                               */
/* -------------------------------------------------------------------------- */

const STARTER_PARA: Omit<ParagraphStyleDef, 'id'>[] = [
  { name: 'Subhead', props: { textTransform: 'small-caps', tracking: 60, align: 'left', firstLineIndent: 0, spaceBefore: 12, spaceAfter: 3, hyphenate: false } },
  { name: 'Caption', props: { fontSize: 8, leading: 11, italic: true, align: 'left', firstLineIndent: 0, hyphenate: false } },
  { name: 'Pull quote', props: { fontSize: 15, leading: 19, italic: true, align: 'center', firstLineIndent: 0, leftIndent: 12, rightIndent: 12, spaceBefore: 12, spaceAfter: 12, hyphenate: false, kerning: 'optical' } },
  { name: 'Epigraph', props: { fontSize: 9, italic: true, align: 'right', firstLineIndent: 0, leftIndent: 48, spaceAfter: 12, hyphenate: false } },
  { name: 'Verse', props: { align: 'left', firstLineIndent: -12, leftIndent: 24, hyphenate: false } },
  { name: 'List', props: { align: 'left', firstLineIndent: -10, leftIndent: 10, spaceBefore: 2 } },
  { name: 'Footnote', props: { fontSize: 7.5, leading: 9.5, firstLineIndent: 0, spaceBefore: 2 } },
  { name: 'Display', props: { fontSize: 36, leading: 38, tracking: -10, align: 'left', firstLineIndent: 0, hyphenate: false, kerning: 'optical' } },
];

const STARTER_CHAR: Omit<CharacterStyleDef, 'id'>[] = [
  { name: 'Emphasis', props: { italic: true } },
  { name: 'Strong', props: { weight: 700 } },
  { name: 'Small caps', props: { textTransform: 'small-caps', tracking: 40 } },
  { name: 'Spaced capitals', props: { textTransform: 'uppercase', tracking: 100, sizeScale: 90 } },
  { name: 'Rubric', props: { color: VERMILION } },
  { name: 'Superscript', props: { position: 'superscript' } },
  { name: 'Subscript', props: { position: 'subscript' } },
  { name: 'Old-style figures', props: { features: { onum: true, lnum: false } } },
];

/* -------------------------------------------------------------------------- */
/* Frame ↔ paragraph style                                                      */
/* -------------------------------------------------------------------------- */

/** A frame's base style with a paragraph style applied (space before becomes paragraph spacing). */
export function frameStyleWith(style: TextStyle, p: ParagraphStyleProps): TextStyle {
  const out = applyParagraphStyle(style, p);
  if (p.spaceBefore != null) out.paragraphSpacing = p.spaceBefore;
  return out;
}

const valueOf = (s: TextStyle, key: keyof ParagraphStyleProps): unknown => (key === 'spaceBefore' ? s.paragraphSpacing : (s as unknown as Record<string, unknown>)[key]);

/** Properties of the style that the frame no longer matches (InDesign's "+"). */
export function overriddenKeys(style: TextStyle, p: ParagraphStyleProps): (keyof ParagraphStyleProps)[] {
  const out: (keyof ParagraphStyleProps)[] = [];
  for (const k of Object.keys(p) as (keyof ParagraphStyleProps)[]) {
    if (k === 'spaceAfter') continue; // a frame has no space after; only tagged paragraphs do
    const want = p[k];
    if (k === 'features') {
      const f = want as Record<string, boolean>;
      if (Object.keys(f).some((t) => !!style.features[t] !== !!f[t])) out.push(k);
      continue;
    }
    const have = valueOf(style, k);
    if (typeof want === 'number' ? Math.abs((have as number ?? 0) - want) > 1e-3 : have !== want) out.push(k);
  }
  return out;
}

/** The frame's current values for a set of properties. */
function capture(style: TextStyle, keys: (keyof ParagraphStyleProps)[]): ParagraphStyleProps {
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    if (k === 'spaceAfter') continue;
    const v = k === 'features' ? { ...style.features } : valueOf(style, k);
    if (v != null) out[k] = v;
  }
  return out as ParagraphStyleProps;
}

const CAPTURE_KEYS: (keyof ParagraphStyleProps)[] = ['fontFamily', 'fontSize', 'leading', 'weight', 'italic', 'tracking', 'color', 'align', 'firstLineIndent', 'leftIndent', 'rightIndent', 'spaceBefore', 'textTransform', 'hyphenate', 'kerning'];

function eachText(d: Draft<Project>, fn: (el: Draft<TextElement>) => void) {
  const visit = (els: Draft<Element>[]) => { for (const e of els) if (e.type === 'text') fn(e as Draft<TextElement>); };
  for (const p of d.pages) visit(p.elements);
  for (const m of d.masters) { visit(m.left); visit(m.right); }
  visit(d.cover.elements);
  if (d.jacket) visit(d.jacket.elements);
}

/** Re-apply a redefined paragraph style to every frame that follows it. */
function propagate(d: Draft<Project>, def: ParagraphStyleDef) {
  eachText(d, (el) => { if (el.paraStyle === def.id) el.style = frameStyleWith(el.style as TextStyle, def.props) as Draft<TextStyle>; });
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Rewrite (or strip, when `to` is null) a style's tags in every story. */
function retag(d: Draft<Project>, kind: 'para' | 'char', from: string, to: string | null) {
  const f = escapeRe(from);
  const para = new RegExp(`^\\[${f}\\]\\s*`, 'gmi');
  const open = new RegExp(`<${f}>`, 'gi'), close = new RegExp(`</${f}>`, 'gi');
  eachText(d, (el) => {
    if (kind === 'para') el.text = el.text.replace(para, to ? `[${to}] ` : '');
    else el.text = el.text.replace(open, to ? `<${to}>` : '').replace(close, to ? `</${to}>` : '');
  });
}

export function addStarterStyles() {
  useStore.getState().update((d) => {
    const pn = new Set((d.paragraphStyles ?? []).map((x) => x.name.toLowerCase()));
    const cn = new Set((d.characterStyles ?? []).map((x) => x.name.toLowerCase()));
    d.paragraphStyles = [...(d.paragraphStyles ?? []), ...STARTER_PARA.filter((x) => !pn.has(x.name.toLowerCase())).map((x) => ({ ...structuredClone(x), id: uid('ps') }))];
    d.characterStyles = [...(d.characterStyles ?? []), ...STARTER_CHAR.filter((x) => !cn.has(x.name.toLowerCase())).map((x) => ({ ...structuredClone(x), id: uid('cs') }))];
  });
}

function uniqueName(base: string, taken: string[]) {
  const set = new Set(taken.map((n) => n.toLowerCase()));
  if (!set.has(base.toLowerCase())) return base;
  for (let i = 2; ; i++) if (!set.has(`${base} ${i}`.toLowerCase())) return `${base} ${i}`;
}

/* -------------------------------------------------------------------------- */
/* Type panel: the frame's paragraph style                                      */
/* -------------------------------------------------------------------------- */

const PROP_LABEL: Record<string, string> = {
  fontFamily: 'typeface', fontSize: 'size', leading: 'leading', weight: 'weight', italic: 'italic', tracking: 'tracking', color: 'colour', align: 'alignment',
  firstLineIndent: 'first-line indent', leftIndent: 'left indent', rightIndent: 'right indent', spaceBefore: 'space before', spaceAfter: 'space after',
  textTransform: 'case', features: 'figures', hyphenate: 'hyphenation', kerning: 'kerning', sizeScale: 'size', position: 'position', baselineShift: 'baseline shift',
};

export function FrameStyleSection({ el }: { el: TextElement }) {
  const defs = useStore((s) => s.project.paragraphStyles) ?? [];
  const s = useStore.getState;
  const def = defs.find((d) => d.id === el.paraStyle) ?? null;
  const over = def ? overriddenKeys(el.style, def.props) : [];
  const [naming, setNaming] = useState<string | null>(null);

  const apply = (id: string) => s().updateElement(el.id, (d) => {
    const t = d as Draft<TextElement>;
    const next = defs.find((x) => x.id === id);
    t.paraStyle = next ? next.id : null;
    if (next) t.style = frameStyleWith(t.style as TextStyle, next.props) as Draft<TextStyle>;
  });
  const redefine = () => s().update((d) => {
    const target = d.paragraphStyles?.find((x) => x.id === def!.id);
    if (!target) return;
    target.props = { ...target.props, ...capture(el.style, Object.keys(target.props) as (keyof ParagraphStyleProps)[]) };
    propagate(d, target as ParagraphStyleDef);
  });
  const create = (name: string) => {
    const id = uid('ps');
    const props = capture(el.style, CAPTURE_KEYS);
    s().update((d) => {
      d.paragraphStyles = [...(d.paragraphStyles ?? []), { id, name: uniqueName(name.trim() || 'Paragraph style', (d.paragraphStyles ?? []).map((x) => x.name)), props }];
      eachText(d, (t) => { if (t.id === el.id) t.paraStyle = id; });
    });
    setNaming(null);
  };

  return (
    <Section title="Paragraph style" id="type-pstyle">
      <Select label={`Frame follows${over.length ? '  (+ overrides)' : ''}`} value={el.paraStyle ?? ''} onChange={apply}
        options={[{ value: '', label: 'No style (local formatting)' }, ...defs.map((d) => ({ value: d.id, label: d.name }))]}
        hint="Redefining the style updates every frame that follows it" />
      {def && over.length > 0 && (
        <div className="rounded-md border border-ink-700 bg-ink-900 p-2 text-[10.5px] text-ink-300">
          <div className="mb-1.5">Overridden here: {over.map((k) => PROP_LABEL[k] ?? k).join(', ')}</div>
          <Row>
            <Button onClick={() => apply(def.id)} title="Back to the style's values">Clear overrides</Button>
            <Button onClick={redefine} title={`Make “${def.name}” match this frame, everywhere`}>Redefine style</Button>
          </Row>
        </div>
      )}
      {naming == null ? (
        <Button className="w-full" onClick={() => setNaming(uniqueName('Paragraph style', defs.map((d) => d.name)))}><Plus size={12} className="mr-1 inline" />New style from this frame</Button>
      ) : (
        <form className="flex items-end gap-1.5" onSubmit={(e) => { e.preventDefault(); create(naming); }}>
          <TextInput label="Style name" value={naming} onChange={setNaming} className="flex-1" />
          <Button type="submit" variant="primary">Create</Button>
          <Button onClick={() => setNaming(null)}>Cancel</Button>
        </form>
      )}
    </Section>
  );
}

/* -------------------------------------------------------------------------- */
/* Styles manager                                                               */
/* -------------------------------------------------------------------------- */

type Kind = 'family' | 'number' | 'length' | 'bool' | 'color' | 'align' | 'case' | 'kerning' | 'position' | 'figures';
interface PropDef { key: string; label: string; kind: Kind; unit?: string; min?: number; max?: number; step?: number; def: unknown; hint?: string }

const PARA_PROPS: PropDef[] = [
  { key: 'fontFamily', label: 'Typeface', kind: 'family', def: 'eb-garamond' },
  { key: 'fontSize', label: 'Size', kind: 'number', unit: 'pt', min: 2, max: 720, step: 0.5, def: 12 },
  { key: 'leading', label: 'Leading', kind: 'number', unit: 'pt', min: 1, step: 0.5, def: 15 },
  { key: 'weight', label: 'Weight', kind: 'number', min: 100, max: 1000, step: 10, def: 600 },
  { key: 'italic', label: 'Italic', kind: 'bool', def: true },
  { key: 'tracking', label: 'Tracking', kind: 'number', unit: '‰ em', step: 5, def: 40 },
  { key: 'color', label: 'Colour', kind: 'color', def: VERMILION },
  { key: 'align', label: 'Alignment', kind: 'align', def: 'left' },
  { key: 'firstLineIndent', label: 'First-line indent', kind: 'length', step: 0.5, def: 0, hint: 'Negative hangs the first line (lists, verse)' },
  { key: 'leftIndent', label: 'Left indent', kind: 'length', min: 0, def: 12 },
  { key: 'rightIndent', label: 'Right indent', kind: 'length', min: 0, def: 12 },
  { key: 'spaceBefore', label: 'Space before', kind: 'length', min: 0, def: 6 },
  { key: 'spaceAfter', label: 'Space after', kind: 'length', min: 0, def: 6 },
  { key: 'textTransform', label: 'Case', kind: 'case', def: 'small-caps' },
  { key: 'features', label: 'Figures', kind: 'figures', def: { onum: true, lnum: false } },
  { key: 'hyphenate', label: 'Hyphenate', kind: 'bool', def: false },
  { key: 'kerning', label: 'Kerning', kind: 'kerning', def: 'optical' },
];

const CHAR_PROPS: PropDef[] = [
  { key: 'fontFamily', label: 'Typeface', kind: 'family', def: 'eb-garamond' },
  { key: 'weight', label: 'Weight', kind: 'number', min: 100, max: 1000, step: 10, def: 700 },
  { key: 'italic', label: 'Italic', kind: 'bool', def: true },
  { key: 'sizeScale', label: 'Size', kind: 'number', unit: '%', min: 10, max: 400, step: 1, def: 80 },
  { key: 'tracking', label: 'Extra tracking', kind: 'number', unit: '‰ em', step: 5, def: 50 },
  { key: 'color', label: 'Colour', kind: 'color', def: VERMILION },
  { key: 'textTransform', label: 'Case', kind: 'case', def: 'uppercase' },
  { key: 'position', label: 'Position', kind: 'position', def: 'superscript' },
  { key: 'baselineShift', label: 'Baseline shift', kind: 'length', step: 0.25, def: 2, hint: 'Positive raises the run' },
  { key: 'features', label: 'Figures', kind: 'figures', def: { onum: true, lnum: false } },
];

const FIGURES: { value: string; label: string; f: Record<string, boolean> }[] = [
  { value: 'onum', label: 'Old-style (text) figures', f: { onum: true, lnum: false } },
  { value: 'lnum', label: 'Lining figures', f: { lnum: true, onum: false } },
  { value: 'tnum', label: 'Tabular lining figures', f: { lnum: true, tnum: true, onum: false, pnum: false } },
  { value: 'smcp', label: 'True small caps (smcp)', f: { smcp: true } },
];
const figuresValue = (f: Record<string, boolean>) => (f.tnum ? 'tnum' : f.smcp ? 'smcp' : f.onum ? 'onum' : 'lnum');

function summary(props: Record<string, unknown>): string {
  const bits: string[] = [];
  const p = props as ParagraphStyleProps & CharacterStyleProps;
  if (p.fontFamily) bits.push(getFamily(p.fontFamily).name);
  if (p.fontSize) bits.push(`${p.fontSize}${p.leading ? `/${p.leading}` : ''} pt`);
  if (p.sizeScale) bits.push(`${p.sizeScale}%`);
  if (p.weight) bits.push(`${p.weight}`);
  if (p.italic) bits.push('italic');
  if (p.textTransform && p.textTransform !== 'none') bits.push(p.textTransform === 'small-caps' ? 'small caps' : p.textTransform);
  if (p.align) bits.push(p.align);
  if (p.position && p.position !== 'normal') bits.push(p.position);
  if (p.tracking) bits.push(`${p.tracking > 0 ? '+' : ''}${p.tracking}‰`);
  if (p.kerning === 'optical') bits.push('optical kerning');
  if (p.features) bits.push(FIGURES.find((x) => x.value === figuresValue(p.features!))?.label.split(' ')[0].toLowerCase() ?? 'figures');
  const rest = Object.keys(props).length - bits.length;
  return bits.length ? bits.join(' · ') + (rest > 0 ? ` · +${rest}` : '') : 'inherits everything';
}

function PropControl({ pd, value, onChange }: { pd: PropDef; value: unknown; onChange: (v: unknown) => void }) {
  switch (pd.kind) {
    case 'family':
      return <Select label={pd.label} value={value as string} onChange={onChange} options={getFamilies().filter((f) => !f.system).map((f) => ({ value: f.id, label: f.name }))} />;
    case 'number':
      return <NumberField label={pd.label} unit={pd.unit} value={value as number} min={pd.min} max={pd.max} step={pd.step} onChange={onChange} hint={pd.hint} />;
    case 'length':
      return <NumberField label={pd.label} length value={value as number} min={pd.min} onChange={onChange} hint={pd.hint} />;
    case 'bool':
      return <Toggle label={pd.label} checked={!!value} onChange={onChange} />;
    case 'color':
      return <ColorField label={pd.label} value={value as string} onChange={(v) => v && onChange(v)} />;
    case 'align':
      return <Select label={pd.label} value={value as string} onChange={onChange} options={[{ value: 'left', label: 'Flush left' }, { value: 'center', label: 'Centred' }, { value: 'right', label: 'Flush right' }, { value: 'justify', label: 'Justified' }, { value: 'justify-all', label: 'Justify all lines' }]} />;
    case 'case':
      return <Select label={pd.label} value={value as string} onChange={onChange} options={[{ value: 'none', label: 'As typed' }, { value: 'uppercase', label: 'CAPITALS' }, { value: 'lowercase', label: 'lowercase' }, { value: 'small-caps', label: 'Small caps' }]} />;
    case 'kerning':
      return <Select label={pd.label} value={value as string} onChange={onChange} options={[{ value: 'metrics', label: 'Metrics (the font’s pairs)' }, { value: 'optical', label: 'Optical (from outlines)' }, { value: 'none', label: 'None' }]} />;
    case 'position':
      return <Select label={pd.label} value={value as string} onChange={onChange} options={[{ value: 'normal', label: 'Normal' }, { value: 'superscript', label: 'Superscript' }, { value: 'subscript', label: 'Subscript' }]} />;
    case 'figures':
      return <Select label={pd.label} value={figuresValue(value as Record<string, boolean>)} onChange={(v) => onChange({ ...FIGURES.find((x) => x.value === v)!.f })} options={FIGURES.map(({ value: v, label }) => ({ value: v, label }))} />;
    default:
      return null;
  }
}

function PropsEditor({ defs, props, onChange }: { defs: PropDef[]; props: Record<string, unknown>; onChange: (next: Record<string, unknown>) => void }) {
  const set = defs.filter((d) => props[d.key] !== undefined);
  const unset = defs.filter((d) => props[d.key] === undefined);
  return (
    <div className="space-y-1.5">
      {set.map((pd) => (
        <div key={pd.key} className="flex items-end gap-1">
          <div className="min-w-0 flex-1"><PropControl pd={pd} value={props[pd.key]} onChange={(v) => onChange({ ...props, [pd.key]: v })} /></div>
          <IconButton title={`Inherit ${pd.label.toLowerCase()} from the frame`} onClick={() => { const n = { ...props }; delete n[pd.key]; onChange(n); }}><Trash size={12} /></IconButton>
        </div>
      ))}
      {unset.length > 0 && (
        <Select label="Add property" value="" onChange={(k) => { const pd = defs.find((d) => d.key === k); if (pd) onChange({ ...props, [k]: structuredClone(pd.def) }); }}
          options={[{ value: '', label: 'Choose…' }, ...unset.map((d) => ({ value: d.key, label: d.label }))]} />
      )}
    </div>
  );
}

function StyleRow({ kind, def, open, onToggle }: { kind: 'para' | 'char'; def: ParagraphStyleDef | CharacterStyleDef; open: boolean; onToggle: () => void }) {
  const s = useStore.getState;
  const edit = (fn: (d: Draft<ParagraphStyleDef | CharacterStyleDef>, project: Draft<Project>) => void) => s().update((d) => {
    const arr = (kind === 'para' ? d.paragraphStyles : d.characterStyles) as Draft<ParagraphStyleDef | CharacterStyleDef>[] | undefined;
    const target = arr?.find((x) => x.id === def.id);
    if (!target) return;
    fn(target, d);
    if (kind === 'para') propagate(d, target as ParagraphStyleDef);
  });
  const remove = () => s().update((d) => {
    if (kind === 'para') d.paragraphStyles = (d.paragraphStyles ?? []).filter((x) => x.id !== def.id);
    else d.characterStyles = (d.characterStyles ?? []).filter((x) => x.id !== def.id);
    retag(d, kind, def.name, null);
    eachText(d, (t) => { if (t.paraStyle === def.id) t.paraStyle = null; });
  });
  return (
    <div className={clsx('rounded-md border', open ? 'border-ink-600 bg-ink-900' : 'border-transparent')}>
      <button type="button" onClick={onToggle} className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left hover:bg-ink-750">
        <ChevronRight size={12} className={clsx('shrink-0 text-ink-500 transition-transform', open && 'rotate-90')} />
        <span className="shrink-0 font-mono text-[10px] text-ink-500">{kind === 'para' ? '¶' : 'a'}</span>
        <span className="max-w-[62%] shrink-0 truncate text-[11.5px] text-ink-100">{def.name}</span>
        <span className="ml-auto min-w-0 truncate pl-2 text-right text-[10px] text-ink-500">{summary(def.props as Record<string, unknown>)}</span>
      </button>
      {open && (
        <div className="space-y-2 px-2 pb-2 pt-1">
          <TextInput label="Name" value={def.name} onChange={(v) => {
            const name = v.replace(/[[\]<>/]/g, '');
            if (!name.trim()) return;
            edit((t, d) => { retag(d, kind, t.name, name); t.name = name; });
          }} />
          <PropsEditor defs={kind === 'para' ? PARA_PROPS : CHAR_PROPS} props={def.props as Record<string, unknown>} onChange={(next) => edit((t) => { t.props = next as Draft<ParagraphStyleProps>; })} />
          <div className="flex items-center justify-between">
            <code className="text-[10px] text-ink-400">{kind === 'para' ? `[${def.name}] …` : `<${def.name}>…</${def.name}>`}</code>
            <Button variant="danger" onClick={remove}>Delete</Button>
          </div>
        </div>
      )}
    </div>
  );
}

export function StylesManager() {
  const para = useStore((s) => s.project.paragraphStyles) ?? [];
  const char = useStore((s) => s.project.characterStyles) ?? [];
  const [open, setOpen] = useState<string | null>(null);
  const s = useStore.getState;
  const add = (kind: 'para' | 'char') => {
    const id = uid(kind === 'para' ? 'ps' : 'cs');
    s().update((d) => {
      if (kind === 'para') d.paragraphStyles = [...(d.paragraphStyles ?? []), { id, name: uniqueName('Paragraph style', (d.paragraphStyles ?? []).map((x) => x.name)), props: { fontSize: 12, leading: 15 } }];
      else d.characterStyles = [...(d.characterStyles ?? []), { id, name: uniqueName('Character style', (d.characterStyles ?? []).map((x) => x.name)), props: { italic: true } }];
    });
    setOpen(id);
  };
  const sub = 'mt-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-500';
  return (
    <Section title={`Styles · ${para.length + char.length}`} id="type-styles">
      {!para.length && !char.length && <Hint>Named styles keep a book consistent: set a caption, a subhead or a rubricated word once, use it everywhere, change it in one place.</Hint>}
      {(STARTER_PARA.some((x) => !para.find((p) => p.name.toLowerCase() === x.name.toLowerCase())) || !char.length) && (
        <Button className="w-full" onClick={addStarterStyles}>Add the starter set ({STARTER_PARA.length} paragraph, {STARTER_CHAR.length} character)</Button>
      )}
      <div className={sub}>Paragraph styles</div>
      <div className="space-y-0.5">
        {para.map((d) => <StyleRow key={d.id} kind="para" def={d} open={open === d.id} onToggle={() => setOpen(open === d.id ? null : d.id)} />)}
      </div>
      <Button variant="ghost" className="w-full" onClick={() => add('para')}><Plus size={12} className="mr-1 inline" />New paragraph style</Button>
      <div className={sub}>Character styles</div>
      <div className="space-y-0.5">
        {char.map((d) => <StyleRow key={d.id} kind="char" def={d} open={open === d.id} onToggle={() => setOpen(open === d.id ? null : d.id)} />)}
      </div>
      <Button variant="ghost" className="w-full" onClick={() => add('char')}><Plus size={12} className="mr-1 inline" />New character style</Button>
      <Hint>In a story, start a line with <code>[Caption]</code> to style that paragraph; wrap words in <code>&lt;Rubric&gt;…&lt;/Rubric&gt;</code> for a character style. The story editor's ¶ and a menus insert these for you. Unset properties inherit from the frame.</Hint>
    </Section>
  );
}

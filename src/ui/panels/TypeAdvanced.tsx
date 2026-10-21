/**
 * The typesetting controls beyond character and paragraph basics: rag shaping, justification and
 * hyphenation, keeps and breaks, rules and shading, lists, tabs, rule-based styles, footnotes and
 * the project's hyphenation dictionary.
 */
import React, { useState } from 'react';
import type { Draft } from 'immer';
import { Plus, Trash } from 'lucide-react';
import { useStore } from '../../store/store';
import type { TextStyle, RagMode, ParagraphRule, ListSpec, TabStop, GrepStyle, NestedStyle } from '../../model/types';
import { Section, Row, NumberField, Slider, Select, Toggle, ColorField, Segmented, Hint, Button, IconButton, TextInput } from '../controls';
import { HYPHEN_LANGUAGES } from '../../engine/hyphenate';

type Setter = (fn: (d: Draft<TextStyle>) => void, history?: boolean) => void;
interface P { st: TextStyle; set: Setter; begin: () => void }

/* -------------------------------------------------------------------------- */
/* Rag & composer                                                              */
/* -------------------------------------------------------------------------- */

const RAG_PREVIEW: Record<RagMode, number[]> = {
  natural: [92, 78, 96, 70, 88],
  swiss: [100, 80, 100, 80, 100],
  balanced: [84, 86, 83, 85, 60],
  wedge: [100, 90, 80, 70, 60],
  pattern: [100, 86, 94, 100, 86],
};

export function RagSection({ st, set, begin }: P) {
  const rag = st.rag ?? 'natural';
  const ragged = st.align === 'left' || st.align === 'right' || st.align === 'center';
  return (
    <Section title="Rag & composer" id="type-rag">
      <div className="grid grid-cols-5 gap-1">
        {(['natural', 'swiss', 'balanced', 'wedge', 'pattern'] as RagMode[]).map((m) => (
          <button key={m} type="button" onClick={() => set((d) => { d.rag = m; })} title={RAG_TITLE[m]}
            className={`flex flex-col items-center gap-1 rounded border px-1 pb-1 pt-1.5 text-[9.5px] ${rag === m ? 'border-rubric bg-rubric/15 text-ink-100' : 'border-ink-700 text-ink-400 hover:text-ink-200'}`}>
            <span className="flex w-full flex-col gap-[2px]" style={{ alignItems: st.align === 'center' ? 'center' : st.align === 'right' ? 'flex-end' : 'flex-start' }}>
              {RAG_PREVIEW[m].map((w, i) => <span key={i} className="block h-[2px] rounded-full bg-current" style={{ width: `${w}%` }} />)}
            </span>
            {RAG_LABEL[m]}
          </button>
        ))}
      </div>
      {!ragged && rag !== 'natural' && <Hint>Rag shapes apply to flush-left, flush-right and centred text; this frame is justified.</Hint>}
      {(rag === 'swiss' || rag === 'wedge') && (
        <Slider label={rag === 'swiss' ? 'Short lines come in by' : 'Last line shorter by'} value={st.ragAmount ?? 12} min={2} max={rag === 'swiss' ? 40 : 60} step={1} onStart={begin} onChange={(v) => set((d) => { d.ragAmount = v; }, false)} format={(v) => `${Math.round(v)}% of the measure`} />
      )}
      {rag === 'swiss' && <Toggle label="Start with the long line" checked={st.ragStartLong !== false} onChange={(v) => set((d) => { d.ragStartLong = v; })} />}
      {rag === 'pattern' && <TextInput label="Line lengths, % of the measure (repeats)" value={st.ragPattern ?? '100 84 94'} onChange={(v) => set((d) => { d.ragPattern = v; })} />}
      <Toggle label="No line ends on a one- or two-letter word" checked={!!st.avoidShortLineEnds} onChange={(v) => set((d) => { d.avoidShortLineEnds = v; })} hint="Swiss and German practice: a, I, of, to, in move to the next line" />
      <Segmented value={st.composer ?? 'paragraph'} onChange={(v) => set((d) => { d.composer = v; })} options={[
        { value: 'paragraph', label: 'Paragraph composer', title: 'Knuth–Plass: the whole paragraph is set at once for the most even spacing' },
        { value: 'single', label: 'Single-line', title: 'First fit, line by line, like a hand compositor' },
      ]} />
    </Section>
  );
}
const RAG_LABEL: Record<RagMode, string> = { natural: 'Natural', swiss: 'Swiss', balanced: 'Balanced', wedge: 'Wedge', pattern: 'Pattern' };
const RAG_TITLE: Record<RagMode, string> = {
  natural: 'Each line as full as the paragraph composer can make it',
  swiss: 'Swiss rag: short line, long line, short line, long line',
  balanced: 'All lines about the same length (headings, captions)',
  wedge: 'Each line a little shorter than the one before (a centred pyramid)',
  pattern: 'A repeating sequence of line lengths you choose',
};

/* -------------------------------------------------------------------------- */
/* Justification & hyphenation                                                 */
/* -------------------------------------------------------------------------- */

export function JustificationSection({ st, set, begin }: P) {
  return (
    <Section title="Justification & hyphenation" id="type-hj" defaultOpen={false}>
      <span className="block text-[10.5px] text-ink-400">Word space, % of the desired space</span>
      <Row>
        <NumberField label="Minimum" unit="%" value={st.wordSpaceMin ?? 67} min={30} max={100} step={1} decimals={0} onScrubStart={begin} onChange={(v) => set((d) => { d.wordSpaceMin = v; })} />
        <NumberField label="Maximum" unit="%" value={st.wordSpaceMax ?? 150} min={100} max={400} step={1} decimals={0} onScrubStart={begin} onChange={(v) => set((d) => { d.wordSpaceMax = v; })} hint="Narrow ranges give even colour" />
      </Row>
      <span className="block text-[10.5px] text-ink-400">Letter spacing, ‰ em (0 / 0 = off)</span>
      <Row>
        <NumberField label="Minimum" unit="‰" value={st.letterSpaceMin ?? 0} min={-50} max={0} step={1} decimals={0} onScrubStart={begin} onChange={(v) => set((d) => { d.letterSpaceMin = v; })} />
        <NumberField label="Maximum" unit="‰" value={st.letterSpaceMax ?? 0} min={0} max={100} step={1} decimals={0} onScrubStart={begin} onChange={(v) => set((d) => { d.letterSpaceMax = v; })} hint="A few thousandths relieve rivers without visible spacing" />
      </Row>
      <span className="block text-[10.5px] text-ink-400">Glyph scaling, % (hz-programme; 100 / 100 = off)</span>
      <Row>
        <NumberField label="Minimum" unit="%" value={st.glyphScaleMin ?? 100} min={90} max={100} step={0.5} decimals={1} onScrubStart={begin} onChange={(v) => set((d) => { d.glyphScaleMin = v; })} />
        <NumberField label="Maximum" unit="%" value={st.glyphScaleMax ?? 100} min={100} max={110} step={0.5} decimals={1} onScrubStart={begin} onChange={(v) => set((d) => { d.glyphScaleMax = v; })} hint="±2% is invisible and evens the colour" />
      </Row>
      <Row>
        <Select label="Last line" value={st.lastLineAlign ?? 'left'} options={[{ value: 'left', label: 'Flush left' }, { value: 'center', label: 'Centred' }, { value: 'right', label: 'Flush right' }, { value: 'justify', label: 'Justified' }]} onChange={(v) => set((d) => { d.lastLineAlign = v as TextStyle['lastLineAlign']; })} />
        <Select label="Single word" value={st.singleWordJustify ?? 'left'} options={[{ value: 'left', label: 'Flush left' }, { value: 'center', label: 'Centred' }, { value: 'right', label: 'Flush right' }, { value: 'full', label: 'Spread letters' }]} onChange={(v) => set((d) => { d.singleWordJustify = v as TextStyle['singleWordJustify']; })} />
      </Row>
      {st.opticalMargin && <Slider label="Optical margin strength" value={st.opticalMarginAmount ?? 100} min={0} max={200} step={5} onStart={begin} onChange={(v) => set((d) => { d.opticalMarginAmount = v; }, false)} format={(v) => `${Math.round(v)}%`} />}
      <Toggle label="Hyphenate" checked={st.hyphenate} onChange={(v) => set((d) => { d.hyphenate = v; })} hint="Liang patterns for the chosen language" />
      {st.hyphenate && (
        <>
          <Select label="Language" value={st.language} options={HYPHEN_LANGUAGES.map((l) => ({ value: l.id, label: l.label }))} onChange={(v) => set((d) => { d.language = v; })} />
          <Slider label="Better spacing ↔ fewer hyphens" value={st.hyphenBias ?? 50} min={0} max={100} step={1} onStart={begin} onChange={(v) => set((d) => { d.hyphenBias = v; }, false)} format={(v) => `${Math.round(v)}`} />
          <Row>
            <NumberField label="Words longer than" value={st.hyphenMinWord ?? 5} min={3} max={15} decimals={0} onChange={(v) => set((d) => { d.hyphenMinWord = Math.round(v); })} />
            <NumberField label="Consecutive hyphens" value={st.hyphenLimit ?? 0} min={0} max={9} decimals={0} onChange={(v) => set((d) => { d.hyphenLimit = Math.round(v); })} hint="0 = no limit. Bringhurst: no more than two in a row" />
            <NumberField label="Letters before break" value={st.hyphenBefore ?? 2} min={1} max={6} decimals={0} onChange={(v) => set((d) => { d.hyphenBefore = Math.round(v); })} />
            <NumberField label="Letters after break" value={st.hyphenAfter ?? 3} min={1} max={6} decimals={0} onChange={(v) => set((d) => { d.hyphenAfter = Math.round(v); })} />
            <NumberField label="Hyphenation zone" unit="pt" value={st.hyphenZone ?? 0} min={0} max={72} step={1} decimals={0} onChange={(v) => set((d) => { d.hyphenZone = v; })} hint="Ragged text: only break a word when the line would end this far short" />
          </Row>
          <Toggle label="Hyphenate capitalised words" checked={st.hyphenateCaps !== false} onChange={(v) => set((d) => { d.hyphenateCaps = v; })} hint="Off keeps names and sentence openings whole" />
          <Toggle label="Hyphenate across columns" checked={st.hyphenateAcrossColumns !== false} onChange={(v) => set((d) => { d.hyphenateAcrossColumns = v; })} hint="Off: the last line of a column or frame never ends in a hyphen — the reader need not carry half a word over a column or page turn" />
          <Toggle label="Hyphenate the last word" checked={st.hyphenateLastWord !== false} onChange={(v) => set((d) => { d.hyphenateLastWord = v; })} />
        </>
      )}
    </Section>
  );
}

/* -------------------------------------------------------------------------- */
/* Keeps & breaks                                                              */
/* -------------------------------------------------------------------------- */

export function KeepsSection({ st, set }: P) {
  return (
    <Section title="Keeps & breaks" id="type-keeps" defaultOpen={false}>
      <Row>
        <NumberField label="Keep with next" unit="lines" value={st.keepWithNext ?? 0} min={0} max={5} decimals={0} onChange={(v) => set((d) => { d.keepWithNext = Math.round(v); })} hint="Headings: keep at least this many lines of the next paragraph in the same column" />
        <NumberField label="Widows" unit="lines" value={st.widows ?? 1} min={1} max={5} decimals={0} onChange={(v) => set((d) => { d.widows = Math.round(v); })} hint="At least this many lines at the top of a column" />
        <NumberField label="Orphans" unit="lines" value={st.orphans ?? 1} min={1} max={5} decimals={0} onChange={(v) => set((d) => { d.orphans = Math.round(v); })} hint="At least this many lines at the foot of a column" />
      </Row>
      <Toggle label="Keep all lines together" checked={!!st.keepTogether} onChange={(v) => set((d) => { d.keepTogether = v; })} />
      <Toggle label="Keep with previous" checked={!!st.keepWithPrevious} onChange={(v) => set((d) => { d.keepWithPrevious = v; })} hint="The first line stays in the same column as the end of the paragraph before (captions under figures, a line after a head)" />
      <Toggle label="Span all columns" checked={!!st.spanColumns} onChange={(v) => set((d) => { d.spanColumns = v; })} hint="Heads at the top of a multi-column frame run across all its columns" />
      <Row>
        <NumberField label="Split column" unit="cols" value={st.splitColumns ?? 1} min={1} max={6} decimals={0} onChange={(v) => set((d) => { d.splitColumns = Math.round(v); })} hint="Set paragraphs in balanced sub-columns inside their column (lists, glossaries). Per paragraph: [{split:3}]" />
        <NumberField label="Split gap" unit="pt" value={st.splitGap ?? Math.max(6, st.fontSize)} min={0} max={72} step={1} onChange={(v) => set((d) => { d.splitGap = v; })} />
      </Row>
      <Select label="Start paragraph" value={st.startOn ?? 'anywhere'} options={[{ value: 'anywhere', label: 'Anywhere' }, { value: 'column', label: 'In the next column' }, { value: 'frame', label: 'In the next frame / page' }, { value: 'odd', label: 'On the next odd page' }, { value: 'even', label: 'On the next even page' }]} onChange={(v) => set((d) => { d.startOn = v as TextStyle['startOn']; })} />
      {st.baselineGrid && <Segmented value={st.gridAlign ?? 'all'} onChange={(v) => set((d) => { d.gridAlign = v; })} options={[{ value: 'all', label: 'Every line on the grid' }, { value: 'first', label: 'First line only' }]} />}
      <Hint>In a story, a line holding only <code>{'{col}'}</code> or <code>{'{frame}'}</code> breaks to the next column or frame; <code>{'{odd}'}</code> / <code>{'{even}'}</code> to the next odd or even page (chapters that open on a recto).</Hint>
    </Section>
  );
}

/* -------------------------------------------------------------------------- */
/* Rules & shading                                                             */
/* -------------------------------------------------------------------------- */

const DEFAULT_RULE: ParagraphRule = { weight: 0.75, color: '#2a2118', offset: 4, width: 'column', style: 'solid' };

function RuleEditor({ label, rule, onChange }: { label: string; rule: ParagraphRule | null | undefined; onChange: (r: ParagraphRule | null) => void }) {
  return (
    <div className="rounded-md border border-ink-700 p-2">
      <Toggle label={label} checked={!!rule} onChange={(v) => onChange(v ? { ...DEFAULT_RULE } : null)} />
      {rule && (
        <div className="mt-1.5 space-y-1.5">
          <Row>
            <NumberField label="Weight" unit="pt" value={rule.weight} min={0.1} max={24} step={0.25} onChange={(v) => onChange({ ...rule, weight: v })} />
            <NumberField label="Offset" unit="pt" value={rule.offset} min={-24} max={72} step={0.5} onChange={(v) => onChange({ ...rule, offset: v })} />
            <NumberField label="Indent left" unit="pt" value={rule.indentLeft ?? 0} step={1} onChange={(v) => onChange({ ...rule, indentLeft: v })} />
            <NumberField label="Indent right" unit="pt" value={rule.indentRight ?? 0} step={1} onChange={(v) => onChange({ ...rule, indentRight: v })} />
          </Row>
          <Row>
            <Select label="Width" value={rule.width} options={[{ value: 'column', label: 'Column' }, { value: 'text', label: 'Text' }]} onChange={(v) => onChange({ ...rule, width: v as ParagraphRule['width'] })} />
            <Select label="Style" value={rule.style ?? 'solid'} options={[{ value: 'solid', label: 'Solid' }, { value: 'dashed', label: 'Dashed' }, { value: 'dotted', label: 'Dotted' }, { value: 'double', label: 'Double' }]} onChange={(v) => onChange({ ...rule, style: v as ParagraphRule['style'] })} />
          </Row>
          <ColorField label="Colour" value={rule.color} onChange={(v) => v && onChange({ ...rule, color: v })} />
        </div>
      )}
    </div>
  );
}

export function RulesSection({ st, set }: P) {
  const sh = st.shading;
  return (
    <Section title="Rules & shading" id="type-rules" defaultOpen={false}>
      <RuleEditor label="Rule above" rule={st.ruleAbove} onChange={(r) => set((d) => { d.ruleAbove = r; })} />
      <RuleEditor label="Rule below" rule={st.ruleBelow} onChange={(r) => set((d) => { d.ruleBelow = r; })} />
      <div className="rounded-md border border-ink-700 p-2">
        <Toggle label="Paragraph shading" checked={!!sh} onChange={(v) => set((d) => { d.shading = v ? { color: '#efe5cf', padding: 4 } : null; })} />
        {sh && (
          <div className="mt-1.5 space-y-1.5">
            <ColorField label="Fill" value={sh.color} onChange={(v) => v && set((d) => { d.shading = { ...sh, color: v }; })} />
            <Row>
              <NumberField label="Padding" unit="pt" value={sh.padding} min={0} max={36} step={0.5} onChange={(v) => set((d) => { d.shading = { ...sh, padding: v }; })} />
              <NumberField label="Corner radius" unit="pt" value={sh.radius ?? 0} min={0} max={36} step={0.5} onChange={(v) => set((d) => { d.shading = { ...sh, radius: v }; })} />
              <NumberField label="Border" unit="pt" value={sh.strokeWidth ?? 0} min={0} max={12} step={0.25} onChange={(v) => set((d) => { d.shading = { ...sh, strokeWidth: v, stroke: v > 0 ? sh.stroke ?? '#2a2118' : null }; })} />
            </Row>
            {(sh.strokeWidth ?? 0) > 0 && <ColorField label="Border colour" value={sh.stroke ?? '#2a2118'} onChange={(v) => v && set((d) => { d.shading = { ...sh, stroke: v }; })} />}
          </div>
        )}
      </div>
    </Section>
  );
}

/* -------------------------------------------------------------------------- */
/* Lists                                                                       */
/* -------------------------------------------------------------------------- */

export function ListSection({ st, set }: P) {
  const l = st.list;
  const upd = (p: Partial<ListSpec>) => set((d) => { d.list = { ...(l ?? { type: 'bullet' }), ...p } as ListSpec; });
  return (
    <Section title="Bullets & numbering" id="type-list" defaultOpen={false}>
      <Segmented value={l?.type ?? 'none'} onChange={(v) => set((d) => { d.list = v === 'none' ? null : { ...(l ?? {}), type: v } as ListSpec; })} options={[{ value: 'none', label: 'None' }, { value: 'bullet', label: 'Bullets' }, { value: 'number', label: 'Numbers' }]} />
      {l && (
        <>
          <Row>
            {l.type === 'bullet'
              ? <Select label="Bullet" value={l.bullet ?? '•'} options={['•', '◦', '▪', '–', '—', '·', '❧', '☞', '✳', '→', '✓'].map((b) => ({ value: b, label: b }))} onChange={(v) => upd({ bullet: v })} />
              : <Select label="Style" value={l.format ?? 'decimal'} options={[{ value: 'decimal', label: '1, 2, 3' }, { value: 'lower-alpha', label: 'a, b, c' }, { value: 'upper-alpha', label: 'A, B, C' }, { value: 'lower-roman', label: 'i, ii, iii' }, { value: 'upper-roman', label: 'I, II, III' }]} onChange={(v) => upd({ format: v as ListSpec['format'] })} />}
            {l.type === 'number' && <Select label="After the number" value={l.suffix ?? '.'} options={[{ value: '.', label: '1.' }, { value: ')', label: '1)' }, { value: '', label: '1' }, { value: ' —', label: '1 —' }]} onChange={(v) => upd({ suffix: v })} />}
            {l.type === 'number' && <NumberField label="Start at" value={l.start ?? 0} min={0} max={9999} decimals={0} onChange={(v) => upd({ start: v > 0 ? Math.round(v) : null })} hint="0 = continue from the previous list paragraph" />}
            <NumberField label="Hang" unit="pt" value={l.indent ?? (l.type === 'number' ? 1.6 : 1.1) * st.fontSize} min={2} max={72} step={0.5} onChange={(v) => upd({ indent: v })} />
            <NumberField label="Level" value={l.level ?? 0} min={0} max={6} decimals={0} onChange={(v) => upd({ level: Math.round(v) })} />
          </Row>
          <Segmented value={l.align ?? (l.type === 'number' ? 'right' : 'left')} onChange={(v) => upd({ align: v })} options={[{ value: 'left', label: 'Marker flush left' }, { value: 'right', label: 'Aligned on the point' }]} />
          {l.type === 'number' && <Toggle label="Multi-level numbers (2.1, 2.1.1)" checked={!!l.hierarchical} onChange={(v) => upd({ hierarchical: v })} hint="Nested items carry their parents' numbers" />}
          <ColorField label="Marker colour" value={l.color ?? st.color} onChange={(v) => upd({ color: v ?? undefined })} />
        </>
      )}
      <Hint>Or type them: a line starting with <code>- </code> or <code>• </code> is a bullet, <code>1. </code> or <code>a) </code> a numbered item; two spaces or a tab in front per level.</Hint>
    </Section>
  );
}

/* -------------------------------------------------------------------------- */
/* Tabs                                                                        */
/* -------------------------------------------------------------------------- */

export function TabsSection({ st, set }: P) {
  const stops = st.tabStops ?? [];
  const upd = (i: number, p: Partial<TabStop>) => set((d) => { d.tabStops = stops.map((t, k) => (k === i ? { ...t, ...p } : t)); });
  return (
    <Section title="Tabs" id="type-tabs" defaultOpen={false}>
      {stops.map((t, i) => (
        <div key={i} className="flex items-end gap-1">
          <NumberField className="w-[70px]" label={i === 0 ? 'At' : undefined as unknown as string} unit="pt" value={t.pos} min={0} step={1} onChange={(v) => upd(i, { pos: v })} />
          <div className="min-w-0 flex-1"><Select label={i === 0 ? 'Align' : ''} value={t.align} options={[{ value: 'left', label: 'Left' }, { value: 'center', label: 'Centre' }, { value: 'right', label: 'Right' }, { value: 'decimal', label: 'Decimal' }]} onChange={(v) => upd(i, { align: v as TabStop['align'] })} /></div>
          <div className="w-[64px]"><Select label={i === 0 ? 'Leader' : ''} value={t.leader ?? ''} options={[{ value: '', label: 'none' }, { value: '.', label: '. . .' }, { value: '. ', label: '.  .  .' }, { value: '·', label: '· · ·' }, { value: '_', label: '___' }, { value: '-', label: '- - -' }]} onChange={(v) => upd(i, { leader: v || undefined })} /></div>
          <IconButton title="Remove tab stop" onClick={() => set((d) => { d.tabStops = stops.filter((_, k) => k !== i); })}><Trash size={12} /></IconButton>
        </div>
      ))}
      <Button variant="ghost" className="w-full" onClick={() => set((d) => { d.tabStops = [...stops, { pos: (stops.at(-1)?.pos ?? 0) + 72, align: 'left' }]; })}><Plus size={12} className="mr-1 inline" />Add tab stop</Button>
      <Row>
        <NumberField label="Default tabs every" unit="pt" value={st.defaultTab ?? 36} min={6} max={144} step={1} onChange={(v) => set((d) => { d.defaultTab = v; })} />
        <Select label="Right-indent tab leader" value={st.rightTabLeader ?? ''} options={[{ value: '', label: 'none' }, { value: '.', label: '. . .' }, { value: '. ', label: '.  .  .' }, { value: '·', label: '· · ·' }]} onChange={(v) => set((d) => { d.rightTabLeader = v || undefined; })} />
      </Row>
      <Hint>Positions are measured from the column's left edge. Use a tab character (or <code>{'{tab}'}</code>) in the story; <code>{'{rtab}'}</code> aligns what follows on the right edge (contents pages), <code>{'{here}'}</code> indents later lines to that point.</Hint>
    </Section>
  );
}

/* -------------------------------------------------------------------------- */
/* Nested & GREP styles                                                        */
/* -------------------------------------------------------------------------- */

export function RuleStylesSection({ st, set }: P) {
  const chars = useStore((s) => s.project.characterStyles) ?? [];
  const nested = st.nestedStyles ?? [];
  const grep = st.grepStyles ?? [];
  const names = chars.map((c) => ({ value: c.name, label: c.name }));
  const [err, setErr] = useState<string | null>(null);
  return (
    <Section title="Nested & GREP styles" id="type-grep" defaultOpen={false}>
      {!chars.length && <Hint>These apply character styles automatically; create some character styles first (Styles, below).</Hint>}
      <span className="block text-[10.5px] font-semibold uppercase tracking-[0.08em] text-ink-500">Nested (from the start of each paragraph)</span>
      {nested.map((n, i) => (
        <div key={i} className="flex items-end gap-1">
          <div className="min-w-0 flex-1"><Select label="Style" value={n.style} options={names} onChange={(v) => set((d) => { d.nestedStyles = nested.map((x, k) => (k === i ? { ...x, style: v } : x)); })} /></div>
          <NumberField className="w-[52px]" label="For" value={n.count} min={1} max={99} decimals={0} onChange={(v) => set((d) => { d.nestedStyles = nested.map((x, k) => (k === i ? { ...x, count: Math.round(v) } : x)); })} />
          <div className="w-[86px]"><Select label="Unit" value={n.unit} options={[{ value: 'words', label: 'words' }, { value: 'characters', label: 'letters' }, { value: 'sentences', label: 'sentences' }, { value: 'char', label: 'up to char' }]} onChange={(v) => set((d) => { d.nestedStyles = nested.map((x, k) => (k === i ? { ...x, unit: v as NestedStyle['unit'] } : x)); })} /></div>
          {n.unit === 'char' && <div className="w-[36px]"><TextInput label="Char" value={n.char ?? '.'} onChange={(v) => set((d) => { d.nestedStyles = nested.map((x, k) => (k === i ? { ...x, char: v.slice(0, 1) || '.' } : x)); })} /></div>}
          <IconButton title="Remove" onClick={() => set((d) => { d.nestedStyles = nested.filter((_, k) => k !== i); })}><Trash size={12} /></IconButton>
        </div>
      ))}
      <Button variant="ghost" className="w-full" disabled={!chars.length} onClick={() => set((d) => { d.nestedStyles = [...nested, { style: chars[0].name, count: 3, unit: 'words' }]; })}><Plus size={12} className="mr-1 inline" />Add nested style (run-in head)</Button>
      <span className="block text-[10.5px] font-semibold uppercase tracking-[0.08em] text-ink-500">Line styles (the first lines, in turn)</span>
      {(st.lineStyles ?? []).map((n, i) => (
        <div key={i} className="flex items-end gap-1">
          <div className="min-w-0 flex-1"><Select label="Style" value={n.style} options={names} onChange={(v) => set((d) => { d.lineStyles = (st.lineStyles ?? []).map((x, k) => (k === i ? { ...x, style: v } : x)); })} /></div>
          <NumberField className="w-[60px]" label="Lines" value={n.lines} min={1} max={20} decimals={0} onChange={(v) => set((d) => { d.lineStyles = (st.lineStyles ?? []).map((x, k) => (k === i ? { ...x, lines: Math.round(v) } : x)); })} />
          <IconButton title="Remove" onClick={() => set((d) => { d.lineStyles = (st.lineStyles ?? []).filter((_, k) => k !== i); })}><Trash size={12} /></IconButton>
        </div>
      ))}
      <Button variant="ghost" className="w-full" disabled={!chars.length} onClick={() => set((d) => { d.lineStyles = [...(st.lineStyles ?? []), { style: chars[0].name, lines: 1 }]; })}><Plus size={12} className="mr-1 inline" />Add line style (e.g. small caps for line one)</Button>
      <span className="block text-[10.5px] font-semibold uppercase tracking-[0.08em] text-ink-500">GREP (every match)</span>
      {grep.map((g, i) => (
        <div key={i} className="flex items-end gap-1">
          <div className="min-w-0 flex-1"><TextInput label="Pattern" mono value={g.pattern} onChange={(v) => {
            try { new RegExp(v); setErr(null); } catch (e) { setErr((e as Error).message); }
            set((d) => { d.grepStyles = grep.map((x, k) => (k === i ? { ...x, pattern: v } : x)); });
          }} /></div>
          <div className="w-[96px]"><Select label="Style" value={g.style} options={names} onChange={(v) => set((d) => { d.grepStyles = grep.map((x, k) => (k === i ? { ...x, style: v } : x)); })} /></div>
          <IconButton title="Remove" onClick={() => set((d) => { d.grepStyles = grep.filter((_, k) => k !== i); })}><Trash size={12} /></IconButton>
        </div>
      ))}
      {err && <p className="text-[10.5px] text-[#e5483a]">{err}</p>}
      <div className="flex flex-wrap gap-1">
        {GREP_PRESETS.map((g) => (
          <button key={g.label} type="button" disabled={!chars.length} className="rounded border border-ink-700 px-1.5 py-0.5 text-[10px] text-ink-300 hover:text-ink-100 disabled:opacity-40"
            onClick={() => set((d) => { d.grepStyles = [...grep, { pattern: g.pattern, style: chars.find((c) => g.prefer.test(c.name))?.name ?? chars[0].name } as GrepStyle]; })}>{g.label}</button>
        ))}
      </div>
    </Section>
  );
}

const GREP_PRESETS: { label: string; pattern: string; prefer: RegExp }[] = [
  { label: '+ all figures', pattern: '\\d+', prefer: /figure/i },
  { label: '+ CAPS words → small caps', pattern: '\\b[A-Z]{2,}\\b', prefer: /small caps|spaced/i },
  { label: '+ ampersands', pattern: '&', prefer: /emphasis|italic/i },
  { label: '+ (parentheses)', pattern: '\\([^)]*\\)', prefer: /emphasis/i },
  { label: '+ ordinals 1st 2nd', pattern: '(?<=\\d)(st|nd|rd|th)\\b', prefer: /super/i },
];

/* -------------------------------------------------------------------------- */
/* Footnotes                                                                   */
/* -------------------------------------------------------------------------- */

export function FootnoteSection({ st, set }: P) {
  return (
    <Section title="Footnotes" id="type-fn" defaultOpen={false}>
      <Row>
        <Select label="Numbering" value={st.footnoteNumbering ?? 'decimal'} options={[{ value: 'decimal', label: '1, 2, 3' }, { value: 'roman', label: 'i, ii, iii' }, { value: 'alpha', label: 'a, b, c' }, { value: 'symbols', label: '* † ‡ § ‖ ¶' }]} onChange={(v) => set((d) => { d.footnoteNumbering = v as TextStyle['footnoteNumbering']; })} />
        <NumberField label="Size" unit="%" value={st.footnoteScale ?? 80} min={50} max={100} step={1} decimals={0} onChange={(v) => set((d) => { d.footnoteScale = v; })} />
      </Row>
      <Toggle label="Separator rule" checked={st.footnoteRule !== false} onChange={(v) => set((d) => { d.footnoteRule = v; })} />
      <TextInput label="Endnotes heading" value={st.endnoteHeading ?? 'Notes'} onChange={(v) => set((d) => { d.endnoteHeading = v; })} />
      <Hint>Write <code>{'{fn:the note}'}</code> where the reference goes. Notes are set at the foot of the column that holds the reference; a line whose note will not fit moves on with it. <code>{'{en:…}'}</code> makes an endnote, collected at the end of the story.</Hint>
    </Section>
  );
}

/* -------------------------------------------------------------------------- */
/* Hyphenation dictionary (project)                                            */
/* -------------------------------------------------------------------------- */

export function HyphenDictionarySection() {
  const list = useStore((s) => s.project.hyphenDictionary) ?? [];
  const [draft, setDraft] = useState<string | null>(null);
  const text = draft ?? list.join('\n');
  return (
    <Section title={`Hyphenation exceptions · ${list.length}`} id="type-dict" defaultOpen={false}>
      <TextInput multiline rows={4} mono value={text} placeholder={'ty-pog-ra-phy\nBookDesignStudio'} onChange={setDraft} />
      <Row>
        <Button variant="primary" disabled={draft == null} onClick={() => { useStore.getState().update((d) => { d.hyphenDictionary = (draft ?? '').split(/\n+/).map((x) => x.trim()).filter(Boolean); }); setDraft(null); }}>Apply</Button>
        <Button disabled={draft == null} onClick={() => setDraft(null)}>Revert</Button>
      </Row>
      <Hint>One word per line, for the whole book. Hyphens mark the only places it may break; a word without hyphens is never broken.</Hint>
    </Section>
  );
}

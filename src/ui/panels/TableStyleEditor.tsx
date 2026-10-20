/**
 * Table and cell style library: every named style is editable in place with an "add property /
 * remove property" editor (like the paragraph and character styles). Tables look their styles up
 * by id when they are set, so an edit shows at once in every table that uses the style.
 * Editing a built-in preset copies it into the document first.
 */
import React, { useState } from 'react';
import clsx from 'clsx';
import { ChevronRight, Plus, RotateCcw, Trash2 } from 'lucide-react';
import type { Draft } from 'immer';
import { useStore } from '../../store/store';
import type { Project, TextStyle } from '../../model/types';
import type { CellStyleDef, CellStyleProps, FigureStyle, TableStroke, TableStyleDef, TableStyleProps, RuleStyle } from '../../model/table';
import { CELL_PRESETS, TABLE_PRESETS, RULE_STYLES, allCellStyles, allTableStyles, gapOf, isMultiLine, rule, ruleStyleOf } from '../../model/table';
import { Button, ColorField, IconButton, NumberField, Select, TextInput, Toggle, Hint } from '../controls';
import { getFamilies, getFamily } from '../../engine/fonts';
import { uid } from '../../lib/random';

const INK = '#1b1813';
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/* -------------------------------------------------------------------------- */
/* Rule editor (shared with the Table panel)                                   */
/* -------------------------------------------------------------------------- */

/** Weight, colour and style of a rule; two-line styles also take the gap between the lines. */
export function StrokeEdit({ label, value, overridden, onChange, onReset, nullable }: {
  label?: string; value: TableStroke | null; overridden?: boolean; onChange: (s: TableStroke) => void; onReset?: () => void; nullable?: string;
}) {
  const v = value ?? { w: 0, color: INK, dash: [] };
  const style = ruleStyleOf(v);
  return (
    <div>
      {label != null && (
        <div className="mb-0.5 flex items-center gap-1 text-[10.5px] text-ink-400">
          <span className="flex-1 truncate">{label}{overridden && <span className="ml-1 text-rubric" title="Overrides the table style">•</span>}</span>
          {nullable && value == null && <span className="text-[10px] text-ink-500">{nullable}</span>}
          {overridden && onReset && <button type="button" className="text-ink-500 hover:text-ink-200" title="Back to the table style" onClick={onReset}><RotateCcw size={11} /></button>}
        </div>
      )}
      <div className="grid grid-cols-[60px_1fr_88px] gap-1">
        <NumberField value={v.w} unit="pt" min={0} max={12} step={0.25} onChange={(w) => onChange({ ...v, w })} hint={isMultiLine(v) ? 'Combined weight of both lines' : 'Weight'} />
        <ColorField value={v.color} onChange={(c) => c && onChange({ ...v, color: c })} />
        <Select<RuleStyle> value={style} options={RULE_STYLES} onChange={(st) => onChange({ ...v, style: st, dash: [], w: v.w || (st === 'solid' ? 0.5 : 1) })} />
      </div>
      {isMultiLine(v) && (
        <div className="mt-1 grid grid-cols-[1fr_auto] items-center gap-2">
          <NumberField label="Gap between the lines" unit="pt" value={gapOf(v)} min={0} max={12} step={0.25} onChange={(g) => onChange({ ...v, gap: g })} />
          <svg width={54} height={22} className="mt-3 shrink-0" aria-hidden>
            {rulePreview(v, 54, 11)}
          </svg>
        </div>
      )}
    </div>
  );
}

/** A small drawing of a two-line rule (screen px, scaled up for legibility). */
function rulePreview(s: TableStroke, w: number, y: number) {
  const k = ruleStyleOf(s), sc = 2.2, g = gapOf(s) * sc;
  const thick = k === 'double' ? (s.w / 2) * sc : ((s.w * 2) / 3) * sc, thin = k === 'double' ? (s.w / 2) * sc : (s.w / 3) * sc;
  const a = k === 'thin-thick' ? thin : thick, b = k === 'thin-thick' ? thick : thin;
  const total = a + g + b;
  return (
    <>
      <rect x={2} y={y - total / 2} width={w - 4} height={a} fill={s.color} />
      <rect x={2} y={y - total / 2 + a + g} width={w - 4} height={b} fill={s.color} />
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* Property definitions                                                        */
/* -------------------------------------------------------------------------- */

type Kind = 'family' | 'number' | 'length' | 'bool' | 'color' | 'colorNone' | 'enum' | 'text' | 'stroke' | 'cellStyle' | 'paraStyle' | 'charStyle' | 'features';
interface PropDef { key: string; label: string; kind: Kind; unit?: string; min?: number; max?: number; step?: number; def: unknown; opts?: [string, string][]; numeric?: boolean; hint?: string }

const FIGURE_OPTS: [FigureStyle, string][] = [['default', 'As the font'], ['tabular-lining', 'Tabular lining'], ['tabular-oldstyle', 'Tabular oldstyle'], ['proportional-lining', 'Proportional lining'], ['proportional-oldstyle', 'Proportional oldstyle']];
const CASE_OPTS: [TextStyle['textTransform'], string][] = [['none', 'As typed'], ['small-caps', 'Small caps'], ['uppercase', 'CAPITALS'], ['lowercase', 'lowercase']];

export const CELL_PROPS: PropDef[] = [
  { key: 'paraStyle', label: 'Paragraph style', kind: 'paraStyle', def: null },
  { key: 'charStyle', label: 'Character style', kind: 'charStyle', def: null },
  { key: 'fontFamily', label: 'Typeface', kind: 'family', def: 'eb-garamond' },
  { key: 'fontSize', label: 'Size', kind: 'number', unit: 'pt', min: 3, max: 96, step: 0.5, def: 8 },
  { key: 'leading', label: 'Leading', kind: 'number', unit: 'pt', min: 3, max: 120, step: 0.5, def: 11 },
  { key: 'weight', label: 'Weight', kind: 'number', min: 100, max: 900, step: 50, def: 650 },
  { key: 'italic', label: 'Italic', kind: 'bool', def: true },
  { key: 'color', label: 'Colour', kind: 'color', def: INK },
  { key: 'tracking', label: 'Tracking', kind: 'number', unit: '‰ em', min: -200, max: 800, step: 5, def: 40 },
  { key: 'textTransform', label: 'Case', kind: 'enum', opts: CASE_OPTS, def: 'small-caps' },
  { key: 'figures', label: 'Figures', kind: 'enum', opts: FIGURE_OPTS, def: 'tabular-lining' },
  { key: 'features', label: 'OpenType features', kind: 'features', def: { c2sc: true }, hint: 'Tags separated by spaces; a minus switches one off (c2sc case -liga)' },
  { key: 'hyphenate', label: 'Hyphenate', kind: 'bool', def: false },
  { key: 'align', label: 'Alignment', kind: 'enum', opts: [['left', 'Left'], ['center', 'Centre'], ['right', 'Right'], ['justify', 'Justify'], ['decimal', 'On the decimal']], def: 'right' },
  { key: 'decimalChar', label: 'Decimal character', kind: 'text', def: ',' },
  { key: 'valign', label: 'Vertical alignment', kind: 'enum', opts: [['top', 'Top'], ['middle', 'Middle'], ['bottom', 'Bottom']], def: 'middle' },
  { key: 'padTop', label: 'Padding top', kind: 'length', min: 0, def: 4 },
  { key: 'padRight', label: 'Padding right', kind: 'length', min: 0, def: 6 },
  { key: 'padBottom', label: 'Padding bottom', kind: 'length', min: 0, def: 4 },
  { key: 'padLeft', label: 'Padding left', kind: 'length', min: 0, def: 6 },
  { key: 'fill', label: 'Fill', kind: 'colorNone', def: '#ece5d6', hint: 'None = no fill, even on zebra rows' },
  { key: 'rotation', label: 'Text rotation', kind: 'enum', opts: [['0', '0°'], ['90', '90°'], ['180', '180°'], ['270', '270°']], numeric: true, def: 90 },
  { key: 'diagonal', label: 'Diagonal', kind: 'enum', opts: [['none', 'None'], ['down', '╲ Down'], ['up', '╱ Up'], ['cross', '╳ Both']], def: 'down' },
  { key: 'diagonalStroke', label: 'Diagonal rule', kind: 'stroke', def: rule(0.5) },
  { key: 'edges.top', label: 'Edge · top', kind: 'stroke', def: rule(0.5) },
  { key: 'edges.bottom', label: 'Edge · bottom', kind: 'stroke', def: rule(0.5) },
  { key: 'edges.left', label: 'Edge · left', kind: 'stroke', def: rule(0.5) },
  { key: 'edges.right', label: 'Edge · right', kind: 'stroke', def: rule(0.5) },
];

export const TABLE_PROPS: PropDef[] = [
  { key: 'borderTop', label: 'Top of table', kind: 'stroke', def: rule(1) },
  { key: 'headerRule', label: 'Below the head', kind: 'stroke', def: rule(0.4) },
  { key: 'rowRule', label: 'Between rows', kind: 'stroke', def: rule(0.25) },
  { key: 'rowRuleEvery', label: 'Row rule every … rows', kind: 'number', min: 1, max: 20, step: 1, def: 5 },
  { key: 'footerRule', label: 'Above the foot', kind: 'stroke', def: rule(0.4) },
  { key: 'borderBottom', label: 'Foot of table', kind: 'stroke', def: rule(1) },
  { key: 'colRule', label: 'Between columns', kind: 'stroke', def: rule(0.25) },
  { key: 'stubRule', label: 'After the stub', kind: 'stroke', def: rule(0.5) },
  { key: 'borderLeft', label: 'Left side', kind: 'stroke', def: rule(0.75) },
  { key: 'borderRight', label: 'Right side', kind: 'stroke', def: rule(0.75) },
  { key: 'headerFill', label: 'Head fill', kind: 'colorNone', def: '#e6dfd0' },
  { key: 'footerFill', label: 'Foot fill', kind: 'colorNone', def: '#e6dfd0' },
  { key: 'fill', label: 'Body fill', kind: 'colorNone', def: '#f4efe4' },
  { key: 'zebraFill', label: 'Alternating rows', kind: 'colorNone', def: '#ece5d6' },
  { key: 'zebraEvery', label: 'Alternate every … rows', kind: 'number', min: 1, max: 20, step: 1, def: 1 },
  { key: 'zebraOffset', label: 'First band', kind: 'enum', opts: [['1', 'Second group'], ['0', 'First group']], numeric: true, def: 1 },
  { key: 'colZebraFill', label: 'Alternating columns', kind: 'colorNone', def: '#ece5d6' },
  { key: 'colZebraEvery', label: 'Alternate every … columns', kind: 'number', min: 1, max: 20, step: 1, def: 1 },
  { key: 'stub', label: 'First column is a stub', kind: 'bool', def: true },
  { key: 'headerCell', label: 'Head cell style', kind: 'cellStyle', def: 'cs-head' },
  { key: 'bodyCell', label: 'Body cell style', kind: 'cellStyle', def: null },
  { key: 'footerCell', label: 'Foot cell style', kind: 'cellStyle', def: 'cs-total' },
  { key: 'stubCell', label: 'Stub cell style', kind: 'cellStyle', def: 'cs-stub' },
];

type Props = Record<string, unknown>;
const getP = (p: Props, key: string): unknown => (key.startsWith('edges.') ? (p.edges as Record<string, unknown> | undefined)?.[key.slice(6)] : p[key]);
function setP(p: Props, key: string, v: unknown): Props {
  const out: Props = { ...p };
  if (key.startsWith('edges.')) {
    const e = { ...((p.edges as Record<string, unknown> | undefined) ?? {}) };
    if (v === undefined) delete e[key.slice(6)]; else e[key.slice(6)] = v;
    if (Object.keys(e).length) out.edges = e; else delete out.edges;
    return out;
  }
  if (v === undefined) delete out[key]; else out[key] = v;
  return out;
}

function PropControl({ pd, value, onChange, project }: { pd: PropDef; value: unknown; onChange: (v: unknown) => void; project: Project }) {
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
    case 'colorNone':
      return <ColorField label={pd.label} value={(value as string | null) ?? null} allowNone onChange={(v) => onChange(v)} hint={pd.hint} />;
    case 'enum':
      return <Select label={pd.label} value={String(value)} onChange={(v) => onChange(pd.numeric ? Number(v) : v)} options={(pd.opts ?? []).map(([v, l]) => ({ value: v, label: l }))} />;
    case 'text':
      return <TextInput label={pd.label} value={(value as string) ?? ''} onChange={(v) => onChange(v.slice(-1) || pd.def)} />;
    case 'stroke':
      return <StrokeEdit label={pd.label} value={value as TableStroke} onChange={onChange} />;
    case 'features':
      return <FeaturesInput label={pd.label} hint={pd.hint} value={(value ?? {}) as Record<string, boolean>} onChange={onChange} />;
    case 'cellStyle':
      return <Select label={pd.label} value={(value as string | null) ?? ''} onChange={(v) => onChange(v || null)} options={[{ value: '', label: '— None —' }, ...allCellStyles(project).map((c) => ({ value: c.id, label: c.name }))]} />;
    case 'paraStyle':
      return <Select label={pd.label} value={(value as string | null) ?? ''} onChange={(v) => onChange(v || null)} options={[{ value: '', label: '— Table text —' }, ...(project.paragraphStyles ?? []).map((c) => ({ value: c.id, label: c.name }))]} />;
    case 'charStyle':
      return <Select label={pd.label} value={(value as string | null) ?? ''} onChange={(v) => onChange(v || null)} options={[{ value: '', label: '— None —' }, ...(project.characterStyles ?? []).map((c) => ({ value: c.id, label: c.name }))]} />;
    default:
      return null;
  }
}

/** OpenType feature tags as text ("c2sc case -liga"), committed when the field is left. */
function FeaturesInput({ label, hint, value, onChange }: { label: string; hint?: string; value: Record<string, boolean>; onChange: (v: Record<string, boolean>) => void }) {
  const shown = Object.entries(value).map(([k, on]) => (on ? k : `-${k}`)).join(' ');
  const [text, setText] = useState(shown);
  const [focus, setFocus] = useState(false);
  const commit = () => {
    const next: Record<string, boolean> = {};
    for (const tok of text.split(/[\s,]+/)) { const m = /^(-?)([a-z0-9]{4})$/i.exec(tok); if (m) next[m[2].toLowerCase()] = !m[1]; }
    onChange(next);
  };
  return (
    <label className="block" title={hint}>
      <span className="block truncate text-[10.5px] text-ink-400">{label}</span>
      <input
        className="mt-0.5 h-7 w-full rounded-[5px] border border-ink-700 bg-ink-900 px-2 font-mono text-[11.5px] text-ink-100 outline-none focus:border-ink-400"
        value={focus ? text : shown}
        onFocus={() => { setText(shown); setFocus(true); }}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => { setFocus(false); commit(); }}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
      />
    </label>
  );
}

/** Properties that are set, each with a remove button, and an "Add property" picker for the rest. */
export function PropsEditor({ defs, props, onChange, project, inheritFrom }: { defs: PropDef[]; props: Props; onChange: (next: Props) => void; project: Project; inheritFrom: string }) {
  const set = defs.filter((d) => getP(props, d.key) !== undefined);
  const unset = defs.filter((d) => getP(props, d.key) === undefined);
  return (
    <div className="space-y-1.5">
      {!set.length && <p className="text-[10.5px] text-ink-500">No properties — everything comes from {inheritFrom}.</p>}
      {set.map((pd) => (
        <div key={pd.key} className="flex items-end gap-1">
          <div className="min-w-0 flex-1"><PropControl pd={pd} value={getP(props, pd.key)} onChange={(v) => onChange(setP(props, pd.key, v))} project={project} /></div>
          <IconButton title={`Remove ${pd.label.toLowerCase()} (inherit it from ${inheritFrom})`} onClick={() => onChange(setP(props, pd.key, undefined))}><Trash2 size={12} /></IconButton>
        </div>
      ))}
      {unset.length > 0 && (
        <Select label="Add property" value="" onChange={(k) => { const pd = defs.find((d) => d.key === k); if (pd) onChange(setP(props, k, clone(pd.def))); }}
          options={[{ value: '', label: 'Choose…' }, ...unset.map((d) => ({ value: d.key, label: d.label }))]} />
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Summaries & usage                                                           */
/* -------------------------------------------------------------------------- */

const pt = (s: TableStroke | null | undefined) => (s && s.w > 0 ? `${+s.w.toFixed(2)}${ruleStyleOf(s) !== 'solid' ? ` ${ruleStyleOf(s)}` : ''}` : 'none');

function describeTable(p: Partial<TableStyleProps>): string {
  const bits: string[] = [];
  if (p.borderTop) bits.push(`top ${pt(p.borderTop)}`);
  if (p.headerRule) bits.push(`head ${pt(p.headerRule)}`);
  if (p.rowRule && p.rowRule.w > 0) bits.push(`rows ${pt(p.rowRule)}`);
  if (p.colRule && p.colRule.w > 0) bits.push('column rules');
  if (p.borderBottom) bits.push(`foot ${pt(p.borderBottom)}`);
  if (p.zebraFill) bits.push('zebra');
  if (p.headerFill) bits.push('head fill');
  if (p.stub) bits.push('stub');
  return bits.join(' · ') || 'no rules';
}

function describeCell(p: CellStyleProps): string {
  const bits: string[] = [];
  if (p.fontFamily) bits.push(getFamily(p.fontFamily).name);
  if (p.fontSize) bits.push(`${p.fontSize} pt`);
  if (p.weight && p.weight >= 600) bits.push('bold');
  if (p.italic) bits.push('italic');
  if (p.textTransform && p.textTransform !== 'none') bits.push(p.textTransform === 'small-caps' ? 'small caps' : p.textTransform);
  if (p.figures && p.figures !== 'default') bits.push(p.figures.replace('-', ' '));
  if (p.align) bits.push(p.align === 'decimal' ? 'decimal' : p.align);
  if (p.valign && p.valign !== 'top') bits.push(p.valign);
  if (p.fill) bits.push('filled');
  if (p.edges && Object.keys(p.edges).length) bits.push('edges');
  const rest = Object.keys(p).length - bits.length;
  return bits.length ? bits.join(' · ') + (rest > 0 ? ` · +${rest}` : '') : 'inherits everything';
}

function allTables(project: Project) {
  const out = [...project.pages.flatMap((p) => p.elements), ...project.masters.flatMap((m) => [...m.left, ...m.right]), ...project.cover.elements, ...(project.jacket?.elements ?? [])];
  return out.filter((e) => e.type === 'table');
}

function tableStyleUse(project: Project, id: string): number {
  return allTables(project).filter((t) => t.type === 'table' && t.tableStyle === id && t.rows.length).length;
}

function cellStyleUse(project: Project, id: string): number {
  let n = 0;
  for (const t of allTables(project)) {
    if (t.type !== 'table') continue;
    if ([t.local.headerCell, t.local.bodyCell, t.local.footerCell, t.local.stubCell].includes(id) || t.cells.some((row) => row.some((c) => c.cellStyle === id))) { n++; continue; }
    const ts = [...(project.tableStyles ?? []), ...TABLE_PRESETS].find((x) => x.id === t.tableStyle);
    if (ts && [ts.props.headerCell, ts.props.bodyCell, ts.props.footerCell, ts.props.stubCell].includes(id)) n++;
  }
  return n;
}

/* -------------------------------------------------------------------------- */
/* Library                                                                     */
/* -------------------------------------------------------------------------- */

function editTableStyle(id: string, fn: (def: TableStyleDef) => TableStyleDef) {
  useStore.getState().update((d) => {
    const list = [...(d.tableStyles ?? [])] as TableStyleDef[];
    let i = list.findIndex((x) => x.id === id);
    if (i < 0) {
      const preset = TABLE_PRESETS.find((x) => x.id === id);
      if (!preset) return;
      list.push(clone(preset));
      i = list.length - 1;
    }
    list[i] = fn(clone(list[i]));
    d.tableStyles = list as Draft<TableStyleDef>[];
  });
}

function editCellStyle(id: string, fn: (def: CellStyleDef) => CellStyleDef) {
  useStore.getState().update((d) => {
    const list = [...(d.cellStyles ?? [])] as CellStyleDef[];
    let i = list.findIndex((x) => x.id === id);
    if (i < 0) {
      const preset = CELL_PRESETS.find((x) => x.id === id);
      if (!preset) return;
      list.push(clone(preset));
      i = list.length - 1;
    }
    list[i] = fn(clone(list[i]));
    d.cellStyles = list as Draft<CellStyleDef>[];
  });
}

function StyleRow({ name, summary, preset, used, open, onToggle, children }: { name: string; summary: string; preset: boolean; used: number; open: boolean; onToggle: () => void; children: React.ReactNode }) {
  return (
    <div className={clsx('rounded-md border', open ? 'border-ink-600 bg-ink-900' : 'border-transparent')}>
      <button type="button" onClick={onToggle} className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left hover:bg-ink-750">
        <ChevronRight size={12} className={clsx('shrink-0 text-ink-500 transition-transform', open && 'rotate-90')} />
        <span className="max-w-[58%] shrink-0 truncate text-[11.5px] text-ink-100">{name}</span>
        {preset && <span className="shrink-0 rounded bg-ink-700 px-1 text-[9px] uppercase tracking-wide text-ink-400" title="Built-in preset — editing copies it into this document">preset</span>}
        <span className="ml-auto min-w-0 truncate pl-2 text-right text-[10px] text-ink-500" title={summary}>{used ? `${used}× · ` : ''}{summary}</span>
      </button>
      {open && <div className="space-y-2 px-2 pb-2 pt-1">{children}</div>}
    </div>
  );
}

export function TableStylesLibrary({ project }: { project: Project }) {
  const s = useStore.getState;
  const [open, setOpen] = useState<string | null>(null);
  const own = new Set((project.tableStyles ?? []).map((x) => x.id));
  const ownCells = new Set((project.cellStyles ?? []).map((x) => x.id));
  const toggle = (k: string) => setOpen(open === k ? null : k);

  const newTable = () => {
    const id = uid('tbs');
    s().update((d) => { d.tableStyles = [...(d.tableStyles ?? []), { id, name: `Table style ${(d.tableStyles?.length ?? 0) + 1}`, props: { borderTop: rule(1), headerRule: rule(0.4), borderBottom: rule(1) } }]; });
    setOpen(`t:${id}`);
  };
  const newCell = () => {
    const id = uid('cs');
    s().update((d) => { d.cellStyles = [...(d.cellStyles ?? []), { id, name: `Cell style ${(d.cellStyles?.length ?? 0) + 1}`, props: {} }]; });
    setOpen(`c:${id}`);
  };
  const removeTable = (id: string) => s().update((d) => {
    d.tableStyles = (d.tableStyles ?? []).filter((x) => x.id !== id);
    // Tables fall back to the preset of that id, if there is one, else to no style.
    if (!TABLE_PRESETS.some((x) => x.id === id)) for (const t of allTables(d as Project)) if (t.type === 'table' && t.tableStyle === id) (t as Draft<typeof t>).tableStyle = null;
  });
  const removeCell = (id: string) => s().update((d) => {
    d.cellStyles = (d.cellStyles ?? []).filter((x) => x.id !== id);
    if (CELL_PRESETS.some((x) => x.id === id)) return;
    for (const t of allTables(d as Project)) {
      if (t.type !== 'table') continue;
      for (const row of t.cells) for (const c of row) if (c.cellStyle === id) c.cellStyle = null;
    }
  });

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-[10.5px] text-ink-400">Table styles</span>
        <Button className="h-6 px-2" onClick={newTable}><Plus size={11} /> New</Button>
      </div>
      <div className="space-y-0.5">
        {allTableStyles(project).map((t) => (
          <StyleRow key={t.id} name={t.name} summary={describeTable(t.props)} preset={!own.has(t.id)} used={tableStyleUse(project, t.id)} open={open === `t:${t.id}`} onToggle={() => toggle(`t:${t.id}`)}>
            <TextInput label="Name" value={t.name} onChange={(v) => v.trim() && editTableStyle(t.id, (def) => ({ ...def, name: v }))} />
            {t.note && <Hint>{t.note}</Hint>}
            <PropsEditor defs={TABLE_PROPS} props={t.props as Props} project={project} inheritFrom="the defaults (no rules, no fills)" onChange={(next) => editTableStyle(t.id, (def) => ({ ...def, props: next as Partial<TableStyleProps> }))} />
            {own.has(t.id) && (
              <div className="flex justify-end">
                <Button variant="danger" onClick={() => removeTable(t.id)}>{TABLE_PRESETS.some((x) => x.id === t.id) ? 'Back to preset' : 'Delete'}</Button>
              </div>
            )}
          </StyleRow>
        ))}
      </div>
      <div className="flex items-center justify-between pt-1">
        <span className="text-[10.5px] text-ink-400">Cell styles</span>
        <Button className="h-6 px-2" onClick={newCell}><Plus size={11} /> New</Button>
      </div>
      <div className="space-y-0.5">
        {allCellStyles(project).map((c) => (
          <StyleRow key={c.id} name={c.name} summary={describeCell(c.props)} preset={!ownCells.has(c.id)} used={cellStyleUse(project, c.id)} open={open === `c:${c.id}`} onToggle={() => toggle(`c:${c.id}`)}>
            <TextInput label="Name" value={c.name} onChange={(v) => v.trim() && editCellStyle(c.id, (def) => ({ ...def, name: v }))} />
            <PropsEditor defs={CELL_PROPS} props={c.props as Props} project={project} inheritFrom="the table text and region style" onChange={(next) => editCellStyle(c.id, (def) => ({ ...def, props: next as CellStyleProps }))} />
            {ownCells.has(c.id) && (
              <div className="flex justify-end">
                <Button variant="danger" onClick={() => removeCell(c.id)}>{CELL_PRESETS.some((x) => x.id === c.id) ? 'Back to preset' : 'Delete'}</Button>
              </div>
            )}
          </StyleRow>
        ))}
      </div>
      <Hint>Changes show at once in every table using the style. Cascade: table text ← column ← head / body / foot / stub cell style ← cell style ← local formatting.</Hint>
    </div>
  );
}

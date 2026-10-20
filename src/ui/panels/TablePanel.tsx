/**
 * Table inspector: structure, table style (rules, fills, region cell styles), table text,
 * columns, rows, the selected cells (merge, insert, cell style and local formatting, per-edge
 * rules) and the project's table and cell styles.
 */
import React, { useRef, useState } from 'react';
import clsx from 'clsx';
import {
  TableCellsMerge, TableCellsSplit, BetweenHorizontalStart, BetweenHorizontalEnd, BetweenVerticalStart, BetweenVerticalEnd, Trash2,
  FileUp, ClipboardPaste, ClipboardCopy, RotateCcw, Save, Pencil, X, AlignLeft, AlignCenter, AlignRight, AlignJustify, Link, Unlink,
} from 'lucide-react';
import { useStore } from '../../store/store';
import type { Project, TextStyle } from '../../model/types';
import type {
  TableElement, TableStyleProps, TableStroke, CellStyleProps, CellRange, CellAlign, CellVAlign, CellRotation, CellDiagonal, FigureStyle,
  ColMode, RowMode, TableStyleDef, CellStyleDef,
} from '../../model/table';
import {
  resolveTableStyle, allTableStyles, allCellStyles, findTableStyle, findCellStyle, anchorsIn, anchorAt, mergeCells, unmergeCells, insertRows, deleteRows,
  insertCols, deleteCols, parseDelimited, tableFromMatrix, fillCells, tableToCSV, figureFeatures, rule, colLetter, rangeLabel, mergeCellProps, BASE_CELL,
} from '../../model/table';
import { Section, Row, NumberField, Select, Toggle, ColorField, Segmented, Button, IconButton, Hint, TextInput } from '../controls';
import { getFamilies } from '../../engine/fonts';
import { layoutTable, cellProps, tableThreadOf, type TableThread } from '../../render/table';
import { StrokeEdit, TableStylesLibrary } from './TableStyleEditor';
import { contextForElement } from '../../render/compile';
import { findElement, surfaceElementsDraft } from '../../model/surfaces';
import { uid } from '../../lib/random';
import { useTableUi, selectedTableRange, continueTableOnNextPage, unthreadTable } from '../canvas/TableTools';

const FIGURES: { value: FigureStyle; label: string }[] = [
  { value: 'default', label: 'As the font' }, { value: 'tabular-lining', label: 'Tabular lining' }, { value: 'tabular-oldstyle', label: 'Tabular oldstyle' },
  { value: 'proportional-lining', label: 'Proportional lining' }, { value: 'proportional-oldstyle', label: 'Proportional oldstyle' },
];
const ALIGN_OPTS: { value: CellAlign; label: React.ReactNode; title: string }[] = [
  { value: 'left', label: <AlignLeft size={13} />, title: 'Left' }, { value: 'center', label: <AlignCenter size={13} />, title: 'Centre' },
  { value: 'right', label: <AlignRight size={13} />, title: 'Right' }, { value: 'justify', label: <AlignJustify size={13} />, title: 'Justify' },
  { value: 'decimal', label: <span className="font-mono text-[11px]">.0</span>, title: 'Align on the decimal (figures line up on . or the chosen character)' },
];
const TRANSFORMS: { value: TextStyle['textTransform']; label: string }[] = [
  { value: 'none', label: 'Normal' }, { value: 'small-caps', label: 'Small caps' }, { value: 'uppercase', label: 'Capitals' }, { value: 'lowercase', label: 'Lowercase' },
];

type Mut = (fn: (t: TableElement) => void, history?: boolean) => void;

function familyOptions() {
  return getFamilies().map((f) => ({ value: f.id, label: f.name, group: f.builtin ? f.category : 'Uploaded' }));
}

/** Drop undefined keys; an empty format becomes undefined. */
function cleanFmt(f: CellStyleProps): CellStyleProps | undefined {
  const out: CellStyleProps = {};
  for (const [k, v] of Object.entries(f)) if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  if (out.edges && !Object.keys(out.edges).length) delete out.edges;
  return Object.keys(out).length ? out : undefined;
}

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/* -------------------------------------------------------------------------- */
/* Panel                                                                       */
/* -------------------------------------------------------------------------- */

export function TablePanel({ el: frame, project }: { el: TableElement; project: Project }) {
  useTableUi();
  const s = useStore.getState;
  // A continuation frame shows (and edits) the table held by the first frame of its thread.
  const th = tableThreadOf(project, frame.id);
  const threaded = !!th && th.frames.length > 1;
  const el = threaded ? th!.head : frame;
  const mut: Mut = (fn, history = true) => s().updateElement(el.id, (d) => fn(d as unknown as TableElement), { history });
  const T = resolveTableStyle(project, el);
  const ctx = contextForElement(project, frame.id, s().spread);
  const L = layoutTable(frame, { project, pageIndex: ctx?.pageIndex ?? null });
  const g = selectedTableRange(el);
  if (!el.rows.length || !el.cols.length) {
    return (
      <>
        <Section title="Empty table frame" id="el-table-empty">
          <Hint>This frame holds no table. Thread a table into it from another table's out-port (lower right), or delete it.</Hint>
        </Section>
      </>
    );
  }
  return (
    <>
      {g ? <CellsSection el={el} project={project} g={g} T={T} mut={mut} /> : (
        <Section title="Cells" id="el-table-cells">
          <Hint>Click the selected table to pick a cell, ⇧-click or drag for a range. Double-click a cell (or start typing) to edit it; Tab moves on. Drag a column or row border to resize it.</Hint>
        </Section>
      )}
      {threaded && th!.index > 0 && (
        <div className="mx-3 my-2 rounded-md border border-[#5aa9e6]/50 bg-[#5aa9e6]/10 px-2 py-1.5 text-[11px] text-ink-200">Frame {th!.index + 1} of {th!.frames.length}: you are editing the table that starts in frame 1.</div>
      )}
      <StructureSection el={el} project={project} T={T} L={L} mut={mut} threaded={threaded} />
      <ThreadSection frame={frame} head={el} th={th} mut={mut} />
      <TextSection el={el} project={project} mut={mut} />
      <RulesSection el={el} T={T} mut={mut} />
      <FillsSection el={el} project={project} T={T} mut={mut} />
      <ColumnsSection el={el} L={L} g={g} mut={mut} />
      <RowsSection el={el} L={L} g={g} mut={mut} />
      <Section title="Table & cell styles" id="el-table-styles" defaultOpen={false}>
        <TableStylesLibrary project={project} />
      </Section>
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* Structure & table style                                                     */
/* -------------------------------------------------------------------------- */

function applyTableStyle(elId: string, id: string | null) {
  useStore.getState().update((d) => {
    const def = id ? findTableStyle(d as Project, id) : null;
    // Presets are copied into the document (with the cell styles they use) so it stays self-contained.
    if (def && !(d.tableStyles ?? []).some((x) => x.id === def.id)) d.tableStyles = [...(d.tableStyles ?? []), clone(def)];
    if (def) {
      for (const cid of [def.props.headerCell, def.props.bodyCell, def.props.footerCell, def.props.stubCell]) {
        const cs = cid ? findCellStyle(d as Project, cid) : null;
        if (cs && !(d.cellStyles ?? []).some((x) => x.id === cs.id)) d.cellStyles = [...(d.cellStyles ?? []), clone(cs)];
      }
    }
    const loc = findElement(d as Project, elId);
    if (!loc) return;
    const t = surfaceElementsDraft(d as Project, loc.key)![loc.index] as unknown as TableElement;
    t.tableStyle = id;
    t.local = {};
  });
}

function StructureSection({ el, project, T, L, mut, threaded }: { el: TableElement; project: Project; T: TableStyleProps; L: ReturnType<typeof layoutTable>; mut: Mut; threaded: boolean }) {
  const s = useStore.getState;
  const fileRef = useRef<HTMLInputElement>(null);
  const [paste, setPaste] = useState<string | null>(null);
  const styles = allTableStyles(project);
  const named = findTableStyle(project, el.tableStyle);
  const overrides = Object.keys(el.local).length;
  const g = selectedTableRange(el);

  const setRowCount = (n: number) => mut((t) => {
    const R = t.rows.length;
    if (n > R) insertRows(t, R - t.footerRows, n - R);
    else if (n < R) { const end = R - t.footerRows - 1; deleteRows(t, Math.max(t.headerRows, end - (R - n) + 1), end); }
  });
  const setColCount = (n: number) => mut((t) => {
    const C = t.cols.length;
    if (n > C) insertCols(t, C, n - C);
    else if (n < C) deleteCols(t, n, C - 1);
  });
  const load = (text: string, into: 'replace' | 'selection') => {
    const data = parseDelimited(text);
    if (!data.length) { s().notify('No rows found in that data.', 'error'); return; }
    if (into === 'selection' && g) mut((t) => { fillCells(t, data, { r: g.r0, c: g.c0 }); });
    else mut((t) => { Object.assign(t, tableFromMatrix(data)); });
    s().notify(`${data.length} rows × ${Math.max(...data.map((r) => r.length))} columns ${into === 'selection' && g ? `filled from ${rangeLabel(g)}` : 'loaded'}. Numeric columns are aligned on the decimal in tabular figures.`);
  };
  const saveStyle = (redefine: boolean) => {
    const base = named?.props ?? {};
    const props = { ...clone(base), ...clone(el.local) };
    const id = redefine && named ? named.id : uid('tbs');
    s().update((d) => {
      const list = [...(d.tableStyles ?? [])];
      const i = list.findIndex((x) => x.id === id);
      const def: TableStyleDef = { id, name: redefine && named ? named.name : `Table style ${list.length + 1}`, props, ...(redefine && named?.note ? { note: named.note } : {}) };
      if (i >= 0) list[i] = def; else list.push(def);
      d.tableStyles = list;
      const loc = findElement(d as Project, el.id);
      if (!loc) return;
      const t = surfaceElementsDraft(d as Project, loc.key)![loc.index] as unknown as TableElement;
      t.tableStyle = id;
      t.local = {};
    });
  };

  return (
    <Section title="Table" id="el-table">
      <div className="flex items-center justify-between rounded-md border border-ink-700 bg-ink-900 px-2 py-1.5 text-[11px] text-ink-300">
        <span>{el.rows.length} rows × {el.cols.length} columns · {L.width.toFixed(1)} × {L.height.toFixed(1)} pt</span>
        {L.overset && <span className="font-medium text-[#e5483a]" title="Rows that do not fit the frame are not printed">Overset rows</span>}
      </div>
      <Row>
        <NumberField label="Rows" value={el.rows.length} min={1} max={500} decimals={0} onChange={(v) => setRowCount(Math.round(v))} />
        <NumberField label="Columns" value={el.cols.length} min={1} max={60} decimals={0} onChange={(v) => setColCount(Math.round(v))} />
      </Row>
      <Row>
        <NumberField label="Head rows" value={el.headerRows} min={0} max={el.rows.length} decimals={0} onChange={(v) => mut((t) => { t.headerRows = Math.round(v); t.footerRows = Math.min(t.footerRows, t.rows.length - t.headerRows); })} hint="Header rows take the header cell style and the header rule" />
        <NumberField label="Foot rows" value={el.footerRows} min={0} max={el.rows.length - el.headerRows} decimals={0} onChange={(v) => mut((t) => { t.footerRows = Math.round(v); })} hint="Footer rows (totals, notes) take the footer cell style and rule" />
      </Row>
      <Toggle label="Columns fill the frame width" checked={el.fitWidth} onChange={(v) => mut((t) => { t.fitWidth = v; })} hint="Proportional columns share what the fixed and automatic ones leave; without them every column scales" />
      {!threaded && <Toggle label="Frame follows the table height" checked={el.autoHeight} onChange={(v) => mut((t) => { t.autoHeight = v; })} hint="Off: the frame keeps its height and rows that do not fit are overset" />}
      {!threaded && <Toggle label="Stretch body rows to the frame" checked={el.fillHeight} onChange={(v) => mut((t) => { t.fillHeight = v; })} hint="Spread a taller frame's extra height evenly over the body rows" />}

      <div className="space-y-1.5 rounded-md border border-ink-700 p-2">
        <Select
          label={`Table style${overrides ? ` · ${overrides} override${overrides === 1 ? '' : 's'}` : ''}`}
          value={el.tableStyle ?? ''}
          options={[{ value: '', label: '— None —' }, ...styles.map((x) => ({ value: x.id, label: x.name, group: (project.tableStyles ?? []).some((o) => o.id === x.id) ? 'This document' : 'Presets' }))]}
          onChange={(v) => applyTableStyle(el.id, v || null)}
        />
        {named?.note && <Hint>{named.note}</Hint>}
        <div className="grid grid-cols-3 gap-1">
          <Button title="Store this table's formatting as a new table style" onClick={() => saveStyle(false)}><Save size={12} /> New</Button>
          <Button disabled={!named || !overrides} title="Write the overrides into the table style (every table using it updates)" onClick={() => saveStyle(true)}><Pencil size={12} /> Redefine</Button>
          <Button disabled={!overrides} title="Remove local overrides of the table style" onClick={() => mut((t) => { t.local = {}; })}><RotateCcw size={12} /> Clear</Button>
        </div>
        <span className="block pt-1 text-[10.5px] text-ink-400">Cell styles of the regions</span>
        <Row>
          <CellStylePick label="Head" project={project} value={T.headerCell} onChange={(v) => mut((t) => { t.local = { ...t.local, headerCell: v }; })} />
          <CellStylePick label="Body" project={project} value={T.bodyCell} onChange={(v) => mut((t) => { t.local = { ...t.local, bodyCell: v }; })} />
          <CellStylePick label="Foot" project={project} value={T.footerCell} onChange={(v) => mut((t) => { t.local = { ...t.local, footerCell: v }; })} />
          <CellStylePick label="Stub (first column)" project={project} value={T.stubCell} onChange={(v) => mut((t) => { t.local = { ...t.local, stubCell: v }; })} />
        </Row>
        <Toggle label="First column is a stub (row heads)" checked={T.stub} onChange={(v) => mut((t) => { t.local = { ...t.local, stub: v }; })} />
      </div>

      <div className="grid grid-cols-3 gap-1">
        <Button title="Load a CSV or TSV file into the table (replaces its contents)" onClick={() => fileRef.current?.click()}><FileUp size={12} /> CSV…</Button>
        <Button title="Paste tab-, comma- or semicolon-separated data" onClick={() => setPaste(paste == null ? '' : null)}><ClipboardPaste size={12} /> Paste…</Button>
        <Button title="Copy the table as CSV" onClick={() => { void navigator.clipboard?.writeText(tableToCSV(el)).then(() => s().notify('Table copied as CSV.')).catch(() => s().notify('Clipboard not available.', 'error')); }}><ClipboardCopy size={12} /> Copy</Button>
      </div>
      <input ref={fileRef} type="file" accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values,text/plain" className="hidden" onChange={async (e) => {
        const f = e.target.files?.[0];
        e.target.value = '';
        if (f) load(await f.text(), g ? 'selection' : 'replace');
      }} />
      {paste != null && (
        <div className="space-y-1">
          <TextInput multiline rows={5} mono value={paste} placeholder={'Year\tTitle\tCopies\n1932\tThe New Typography\t5,000'} onChange={setPaste} />
          <div className="grid grid-cols-2 gap-1">
            <Button variant="primary" disabled={!paste.trim()} onClick={() => { load(paste, 'replace'); setPaste(null); }}>Replace table</Button>
            <Button disabled={!paste.trim() || !g} title={g ? `Write the data from ${rangeLabel(g)} on (the table grows as needed)` : 'Select a cell first'} onClick={() => { load(paste, 'selection'); setPaste(null); }}>Fill from {g ? rangeLabel({ ...g, r1: g.r0, c1: g.c0 }) : 'cell'}</Button>
          </div>
        </div>
      )}
    </Section>
  );
}

function CellStylePick({ label, project, value, onChange }: { label: string; project: Project; value: string | null; onChange: (v: string | null) => void }) {
  const list = allCellStyles(project);
  return (
    <Select
      label={label}
      value={value ?? ''}
      options={[{ value: '', label: '— None —' }, ...list.map((c) => ({ value: c.id, label: c.name, group: (project.cellStyles ?? []).some((o) => o.id === c.id) ? 'This document' : 'Presets' }))]}
      onChange={(v) => onChange(v || null)}
    />
  );
}

/* -------------------------------------------------------------------------- */
/* Table text                                                                  */
/* -------------------------------------------------------------------------- */

function figuresOf(features: Record<string, boolean>): FigureStyle {
  const tab = features.tnum, lin = features.lnum, old = features.onum;
  if (tab && lin) return 'tabular-lining';
  if (tab && old) return 'tabular-oldstyle';
  if (features.pnum && lin) return 'proportional-lining';
  if (features.pnum && old) return 'proportional-oldstyle';
  return 'default';
}

function TextSection({ el, project, mut }: { el: TableElement; project: Project; mut: Mut }) {
  const st = el.style;
  const begin = () => useStore.getState().checkpoint();
  const set = (fn: (s: TextStyle) => void, history = true) => mut((t) => fn(t.style), history);
  return (
    <Section title="Table text" id="el-table-text">
      <Select label="Paragraph style" value={el.paraStyle ?? ''} options={[{ value: '', label: '— None —' }, ...(project.paragraphStyles ?? []).map((p) => ({ value: p.id, label: p.name }))]} onChange={(v) => mut((t) => { t.paraStyle = v || null; })} hint="The base formatting of every cell follows this paragraph style" />
      <Select label="Typeface" value={st.fontFamily} options={familyOptions()} onChange={(v) => set((s) => { s.fontFamily = v; s.axes = {}; })} />
      <Row>
        <NumberField label="Size" unit="pt" value={st.fontSize} min={3} max={72} step={0.5} onChange={(v) => set((s) => { s.leading = +((s.leading * v) / s.fontSize).toFixed(2); s.fontSize = v; })} onScrubStart={begin} />
        <NumberField label="Leading" unit="pt" value={st.leading} min={3} max={120} step={0.5} onChange={(v) => set((s) => { s.leading = v; })} onScrubStart={begin} />
        <NumberField label="Weight" value={st.weight} min={100} max={900} step={50} decimals={0} onChange={(v) => set((s) => { s.weight = v; })} onScrubStart={begin} />
        <NumberField label="Tracking" unit="‰" value={st.tracking} min={-200} max={800} step={5} decimals={0} onChange={(v) => set((s) => { s.tracking = v; })} onScrubStart={begin} />
      </Row>
      <Row>
        <ColorField label="Colour" value={st.color} onChange={(v) => v && set((s) => { s.color = v; })} />
        <Select label="Figures" value={figuresOf(st.features)} options={FIGURES} onChange={(v) => set((s) => {
          const f = { ...s.features };
          for (const k of ['tnum', 'pnum', 'lnum', 'onum']) delete f[k];
          s.features = { ...f, ...(figureFeatures(v) ?? {}) };
        })} hint="Tabular figures share one width so columns of numbers line up (OpenType tnum + lnum/onum)" />
      </Row>
      <Row>
        <Toggle label="Italic" checked={st.italic} onChange={(v) => set((s) => { s.italic = v; })} />
        <Toggle label="Hyphenate" checked={st.hyphenate} onChange={(v) => set((s) => { s.hyphenate = v; })} />
      </Row>
    </Section>
  );
}

/* -------------------------------------------------------------------------- */
/* Rules & fills                                                               */
/* -------------------------------------------------------------------------- */

const RULE_KEYS: { key: keyof TableStyleProps; label: string }[] = [
  { key: 'borderTop', label: 'Top of table' }, { key: 'headerRule', label: 'Below the head' }, { key: 'rowRule', label: 'Between rows' },
  { key: 'footerRule', label: 'Above the foot' }, { key: 'borderBottom', label: 'Foot of table' }, { key: 'colRule', label: 'Between columns' },
  { key: 'stubRule', label: 'After the stub' }, { key: 'borderLeft', label: 'Left side' }, { key: 'borderRight', label: 'Right side' },
];

function RulesSection({ el, T, mut }: { el: TableElement; T: TableStyleProps; mut: Mut }) {
  const set = (k: keyof TableStyleProps, v: unknown) => mut((t) => { t.local = { ...t.local, [k]: v }; });
  const reset = (k: keyof TableStyleProps) => mut((t) => { const l = { ...t.local }; delete l[k]; t.local = l; });
  return (
    <Section title="Rules" id="el-table-rules">
      {RULE_KEYS.map(({ key, label }) => (
        <StrokeEdit key={key} label={label} value={T[key] as TableStroke | null} overridden={key in el.local} onChange={(v) => set(key, v)} onReset={() => reset(key)} nullable={key === 'stubRule' ? 'as columns' : undefined} />
      ))}
      <NumberField label="Row rule every … body rows" value={T.rowRuleEvery} min={1} max={20} decimals={0} onChange={(v) => set('rowRuleEvery', Math.round(v))} hint="Ledger style: a rule every 5 rows guides the eye without fencing every line" />
      <Hint>Rules sit centred on the grid lines and meet cleanly at the corners. Per-cell edges (Cells section) override these.</Hint>
    </Section>
  );
}

function FillsSection({ el, project, T, mut }: { el: TableElement; project: Project; T: TableStyleProps; mut: Mut }) {
  void project;
  const set = (k: keyof TableStyleProps, v: unknown) => mut((t) => { t.local = { ...t.local, [k]: v }; });
  return (
    <Section title="Fills" id="el-table-fills">
      <Row>
        <ColorField label="Head" value={T.headerFill} allowNone onChange={(v) => set('headerFill', v)} />
        <ColorField label="Foot" value={T.footerFill} allowNone onChange={(v) => set('footerFill', v)} />
      </Row>
      <ColorField label="Body" value={T.fill} allowNone onChange={(v) => set('fill', v)} />
      <span className="block text-[10.5px] text-ink-400">Alternating rows</span>
      <div className="grid grid-cols-[1fr_64px_1fr] gap-1">
        <ColorField value={T.zebraFill} allowNone onChange={(v) => set('zebraFill', v)} />
        <NumberField value={T.zebraEvery} min={1} max={20} decimals={0} unit="rows" onChange={(v) => set('zebraEvery', Math.round(v))} />
        <Select value={String((T.zebraOffset ?? 1) % 2)} options={[{ value: '1', label: 'Second group' }, { value: '0', label: 'First group' }]} onChange={(v) => set('zebraOffset', Number(v))} />
      </div>
      <span className="block text-[10.5px] text-ink-400">Alternating columns</span>
      <div className="grid grid-cols-[1fr_64px] gap-1">
        <ColorField value={T.colZebraFill} allowNone onChange={(v) => set('colZebraFill', v)} />
        <NumberField value={T.colZebraEvery} min={1} max={20} decimals={0} unit="cols" onChange={(v) => set('colZebraEvery', Math.round(v))} />
      </div>
      {el.local && Object.keys(el.local).some((k) => /fill|zebra/i.test(k)) && (
        <Button className="w-full" onClick={() => mut((t) => { const l = { ...t.local }; for (const k of Object.keys(l)) if (/fill|zebra/i.test(k)) delete (l as Record<string, unknown>)[k]; t.local = l; })}><RotateCcw size={12} /> Fills as the table style</Button>
      )}
    </Section>
  );
}

/* -------------------------------------------------------------------------- */
/* Columns & rows                                                              */
/* -------------------------------------------------------------------------- */

function ColumnsSection({ el, L, g, mut }: { el: TableElement; L: ReturnType<typeof layoutTable>; g: CellRange | null; mut: Mut }) {
  const begin = () => useStore.getState().checkpoint();
  return (
    <Section title="Columns" id="el-table-cols" defaultOpen={false}>
      <div className="grid grid-cols-2 gap-1">
        <Button title="Every column takes an equal share of the width" onClick={() => mut((t) => { t.cols.forEach((c) => { c.mode = 'fr'; c.w = 1; }); })}>Distribute</Button>
        <Button title="Every column as wide as its content" onClick={() => mut((t) => { t.cols.forEach((c) => { c.mode = 'auto'; c.w = 0; }); })}>Fit content</Button>
      </div>
      {el.cols.map((col, c) => {
        const sel = g && c >= g.c0 && c <= g.c1;
        return (
          <div key={c} className={clsx('space-y-1 rounded-md border p-1.5', sel ? 'border-[#4aa3ff]/70 bg-[#4aa3ff]/5' : 'border-ink-700')}>
            <div className="grid grid-cols-[18px_1fr_74px] items-end gap-1">
              <span className="pb-1.5 font-mono text-[10.5px] text-ink-400" title={`${L.colW[c]?.toFixed(2) ?? '?'} pt`}>{colLetter(c)}</span>
              <Select<ColMode> value={col.mode} options={[{ value: 'fixed', label: 'Fixed' }, { value: 'fr', label: 'Share (fr)' }, { value: 'auto', label: 'Auto · content' }]} onChange={(v) => mut((t) => {
                const cc = t.cols[c];
                cc.mode = v;
                cc.w = v === 'fixed' ? +(L.colW[c] ?? 60).toFixed(2) : v === 'fr' ? 1 : 0;
              })} />
              {col.mode === 'fr'
                ? <NumberField value={col.w} unit="fr" min={0.05} step={0.25} onChange={(v) => mut((t) => { t.cols[c].w = v; })} onScrubStart={begin} />
                : <NumberField length value={col.w} min={0} onChange={(v) => mut((t) => { t.cols[c].w = v; })} onScrubStart={begin} hint={col.mode === 'auto' ? 'Maximum width (0 = no limit)' : 'Width'} />}
            </div>
            <div className="grid grid-cols-[1fr_1fr_38px] gap-1">
              <Select value={col.align ?? ''} options={[{ value: '', label: 'Align: style' }, { value: 'left', label: 'Left' }, { value: 'center', label: 'Centre' }, { value: 'right', label: 'Right' }, { value: 'justify', label: 'Justify' }, { value: 'decimal', label: 'Decimal' }]} onChange={(v) => mut((t) => { t.cols[c].align = (v || undefined) as CellAlign | undefined; })} />
              <Select value={col.figures ?? 'default'} options={FIGURES.map((f) => ({ ...f, label: f.value === 'default' ? 'Figures: text' : f.label }))} onChange={(v) => mut((t) => { t.cols[c].figures = v === 'default' ? undefined : v; })} />
              <TextInput value={col.decimalChar ?? ''} placeholder="." onChange={(v) => mut((t) => { t.cols[c].decimalChar = v.slice(-1) || undefined; }, false)} />
            </div>
          </div>
        );
      })}
      <Hint>Fixed columns keep their width, shares split what is left, auto columns fit their longest line (and give way down to their longest word when space runs out). The last box sets the decimal character for decimal alignment.</Hint>
    </Section>
  );
}

function RowsSection({ el, L, g, mut }: { el: TableElement; L: ReturnType<typeof layoutTable>; g: CellRange | null; mut: Mut }) {
  const begin = () => useStore.getState().checkpoint();
  const from = g ? g.r0 : 0, to = g ? g.r1 : Math.min(el.rows.length - 1, 39);
  const idx = [...Array(to - from + 1).keys()].map((i) => i + from);
  return (
    <Section title={g ? `Rows ${from + 1}–${to + 1}` : 'Rows'} id="el-table-rows" defaultOpen={false}>
      {g && (
        <div className="grid grid-cols-2 gap-1">
          <Button title="Give the selected rows the height of the tallest" onClick={() => mut((t) => { const h = Math.max(...idx.map((r) => L.rowH[r] ?? 0)); for (const r of idx) { const row = t.rows[r]; if (row.mode === 'fixed') row.h = h; else { row.mode = 'min'; row.h = +h.toFixed(2); } } })}>Equalise</Button>
          <Button title="Heights from content again" onClick={() => mut((t) => { for (const r of idx) { t.rows[r].mode = 'auto'; t.rows[r].h = 0; } })}>Auto height</Button>
        </div>
      )}
      {idx.map((r) => (
        <div key={r} className="grid grid-cols-[22px_1fr_80px] items-center gap-1">
          <span className="font-mono text-[10.5px] text-ink-400" title={`${L.rowH[r]?.toFixed(2) ?? '?'} pt · ${r < el.headerRows ? 'head' : r >= el.rows.length - el.footerRows ? 'foot' : 'body'}`}>{r + 1}{r < el.headerRows ? 'ʜ' : r >= el.rows.length - el.footerRows ? 'ғ' : ''}</span>
          <Select<RowMode> value={el.rows[r].mode} options={[{ value: 'auto', label: 'Auto' }, { value: 'min', label: 'At least' }, { value: 'fixed', label: 'Exactly' }]} onChange={(v) => mut((t) => { const row = t.rows[r]; row.mode = v; if (v !== 'auto' && !row.h) row.h = +(L.rowH[r] ?? 14).toFixed(2); })} />
          {el.rows[r].mode === 'auto'
            ? <span className="text-right text-[10.5px] tabular-nums text-ink-500">{(L.rowH[r] ?? 0).toFixed(1)} pt</span>
            : <NumberField length value={el.rows[r].h} min={1} onChange={(v) => mut((t) => { t.rows[r].h = v; })} onScrubStart={begin} />}
        </div>
      ))}
      {!g && el.rows.length > 40 && <Hint>Showing the first 40 rows — select cells to edit others.</Hint>}
    </Section>
  );
}

/* -------------------------------------------------------------------------- */
/* Selected cells                                                              */
/* -------------------------------------------------------------------------- */

type EdgeTarget = 'outline' | 'all' | 'top' | 'bottom' | 'left' | 'right' | 'innerH' | 'innerV';

function CellsSection({ el, project, g, T, mut }: { el: TableElement; project: Project; g: CellRange; T: TableStyleProps; mut: Mut }) {
  const s = useStore.getState;
  const ui = useTableUi.getState();
  const begin = () => s().checkpoint();
  const anchors = anchorsIn(el, g);
  const first = anchors[0] ?? { r: g.r0, c: g.c0, rs: 1, cs: 1 };
  const P = cellProps(el, project, first.r, first.c, T);
  const cell = el.cells[first.r]?.[first.c];
  const local = cell?.fmt ?? {};
  const [edgeTarget, setEdgeTarget] = useState<EdgeTarget>('outline');
  const [edge, setEdge] = useState<TableStroke>(rule(0.5));
  const merged = anchors.some((a) => a.rs > 1 || a.cs > 1);
  const nR = g.r1 - g.r0 + 1, nC = g.c1 - g.c0 + 1;

  /** Change the local format of every selected cell. */
  const fmt = (fn: (f: CellStyleProps) => void, history = true) => mut((t) => {
    for (const a of anchorsIn(t, g)) {
      const c = t.cells[a.r][a.c];
      const f: CellStyleProps = { ...(c.fmt ?? {}) };
      fn(f);
      c.fmt = cleanFmt(f);
    }
  }, history);
  const setSel = (sel: CellRange | null) => { if (sel) ui.setSel(el.id, sel, { r: sel.r0, c: sel.c0 }); else ui.clear(); };

  const applyEdges = (stroke: TableStroke | null) => mut((t) => {
    const put = (r: number, c: number, side: 'top' | 'right' | 'bottom' | 'left') => {
      const a = anchorAt(t, r, c);
      if (!a) return;
      const cc = t.cells[a.r][a.c];
      const f: CellStyleProps = { ...(cc.fmt ?? {}) };
      const e = { ...(f.edges ?? {}) };
      if (stroke) e[side] = { ...stroke, dash: [...stroke.dash] }; else delete e[side];
      f.edges = e;
      cc.fmt = cleanFmt(f);
    };
    const on = (...k: EdgeTarget[]) => k.includes(edgeTarget);
    for (let r = g.r0; r <= g.r1; r++) for (let c = g.c0; c <= g.c1; c++) {
      if (r === g.r0 && on('outline', 'all', 'top')) { put(r, c, 'top'); put(r - 1, c, 'bottom'); }
      if (r === g.r1 && on('outline', 'all', 'bottom')) { put(r, c, 'bottom'); put(r + 1, c, 'top'); }
      if (c === g.c0 && on('outline', 'all', 'left')) { put(r, c, 'left'); put(r, c - 1, 'right'); }
      if (c === g.c1 && on('outline', 'all', 'right')) { put(r, c, 'right'); put(r, c + 1, 'left'); }
      if (r < g.r1 && on('all', 'innerH')) { put(r, c, 'bottom'); put(r + 1, c, 'top'); }
      if (c < g.c1 && on('all', 'innerV')) { put(r, c, 'right'); put(r, c + 1, 'left'); }
    }
  });

  const saveCellStyle = (redefine: boolean) => {
    const named = findCellStyle(project, cell?.cellStyle);
    const id = redefine && named ? named.id : uid('cs');
    const props = mergeCellProps(clone(named?.props ?? {}), clone(local));
    s().update((d) => {
      const list = [...(d.cellStyles ?? [])];
      const i = list.findIndex((x) => x.id === id);
      const def: CellStyleDef = { id, name: redefine && named ? named.name : `Cell style ${list.length + 1}`, props };
      if (i >= 0) list[i] = def; else list.push(def);
      d.cellStyles = list;
      const loc = findElement(d as Project, el.id);
      if (!loc) return;
      const t = surfaceElementsDraft(d as Project, loc.key)![loc.index] as unknown as TableElement;
      for (const a of anchorsIn(t, g)) { t.cells[a.r][a.c].cellStyle = id; delete t.cells[a.r][a.c].fmt; }
    });
  };
  const setCellStyle = (id: string | null) => s().update((d) => {
    const cs = id ? findCellStyle(d as Project, id) : null;
    if (cs && !(d.cellStyles ?? []).some((x) => x.id === cs.id)) d.cellStyles = [...(d.cellStyles ?? []), clone(cs)];
    const loc = findElement(d as Project, el.id);
    if (!loc) return;
    const t = surfaceElementsDraft(d as Project, loc.key)![loc.index] as unknown as TableElement;
    for (const a of anchorsIn(t, g)) t.cells[a.r][a.c].cellStyle = id;
  });

  const pad = (k: 'padTop' | 'padRight' | 'padBottom' | 'padLeft', label: string) => (
    <NumberField label={label} length value={P[k] ?? BASE_CELL[k]} min={0} onChange={(v) => fmt((f) => { f[k] = v; })} onScrubStart={begin} />
  );
  const overrides = Object.keys(local).length;

  return (
    <Section title={`Cells · ${rangeLabel(g)}`} id="el-table-cells" right={<IconButton title="Back to the frame (Esc)" onClick={() => ui.clear()}><X size={13} /></IconButton>}>
      <div className="grid grid-cols-3 gap-1">
        <Button title="Edit the text of the first selected cell (Enter)" onClick={() => ui.edit(el.id, first.r, first.c)}><Pencil size={12} /> Text</Button>
        <Button disabled={anchors.length < 2} title="Merge the selected cells (their texts are joined)" onClick={() => { let ng: CellRange = g; mut((t) => { ng = mergeCells(t, g); }); setSel(ng); }}><TableCellsMerge size={12} /> Merge</Button>
        <Button disabled={!merged} title="Split merged cells" onClick={() => mut((t) => unmergeCells(t, g))}><TableCellsSplit size={12} /> Split</Button>
      </div>
      <div className="flex items-center justify-between rounded-md border border-ink-700 px-1 py-0.5">
        <IconButton title={`Insert ${nR} row${nR > 1 ? 's' : ''} above`} onClick={() => { mut((t) => insertRows(t, g.r0, nR)); setSel({ ...g, r0: g.r0 + nR, r1: g.r1 + nR }); }}><BetweenHorizontalStart size={14} /></IconButton>
        <IconButton title={`Insert ${nR} row${nR > 1 ? 's' : ''} below`} onClick={() => mut((t) => insertRows(t, g.r1 + 1, nR))}><BetweenHorizontalEnd size={14} /></IconButton>
        <IconButton title={`Insert ${nC} column${nC > 1 ? 's' : ''} left`} onClick={() => { mut((t) => insertCols(t, g.c0, nC)); setSel({ ...g, c0: g.c0 + nC, c1: g.c1 + nC }); }}><BetweenVerticalStart size={14} /></IconButton>
        <IconButton title={`Insert ${nC} column${nC > 1 ? 's' : ''} right`} onClick={() => mut((t) => insertCols(t, g.c1 + 1, nC))}><BetweenVerticalEnd size={14} /></IconButton>
        <span className="h-4 w-px bg-ink-700" />
        <IconButton title="Delete the selected rows" disabled={nR >= el.rows.length} onClick={() => { mut((t) => deleteRows(t, g.r0, g.r1)); setSel(null); }}><span className="flex items-center gap-0.5 text-[10px]"><Trash2 size={12} />R</span></IconButton>
        <IconButton title="Delete the selected columns" disabled={nC >= el.cols.length} onClick={() => { mut((t) => deleteCols(t, g.c0, g.c1)); setSel(null); }}><span className="flex items-center gap-0.5 text-[10px]"><Trash2 size={12} />C</span></IconButton>
      </div>

      <div className="space-y-1.5 rounded-md border border-ink-700 p-2">
        <Select
          label={`Cell style${overrides ? ` · ${overrides} override${overrides === 1 ? '' : 's'}` : ''}`}
          value={cell?.cellStyle ?? ''}
          options={[{ value: '', label: '— From the table style —' }, ...allCellStyles(project).map((c) => ({ value: c.id, label: c.name, group: (project.cellStyles ?? []).some((o) => o.id === c.id) ? 'This document' : 'Presets' }))]}
          onChange={(v) => setCellStyle(v || null)}
        />
        <div className="grid grid-cols-3 gap-1">
          <Button title="New cell style from this cell's formatting" disabled={!overrides && !cell?.cellStyle} onClick={() => saveCellStyle(false)}><Save size={12} /> New</Button>
          <Button title="Write these overrides into the cell style" disabled={!cell?.cellStyle || !overrides} onClick={() => saveCellStyle(true)}><Pencil size={12} /> Redefine</Button>
          <Button title="Remove the local formatting of the selected cells" disabled={!anchors.some((a) => el.cells[a.r][a.c].fmt)} onClick={() => mut((t) => { for (const a of anchorsIn(t, g)) delete t.cells[a.r][a.c].fmt; })}><RotateCcw size={12} /> Clear</Button>
        </div>
      </div>

      <div>
        <span className="mb-1 block text-[10.5px] text-ink-400">Alignment</span>
        <Segmented<CellAlign> value={P.align ?? 'left'} options={ALIGN_OPTS} onChange={(v) => fmt((f) => { f.align = v; })} />
      </div>
      <div className="grid grid-cols-[1fr_52px] items-end gap-1">
        <Segmented<CellVAlign> value={P.valign ?? 'top'} options={[{ value: 'top', label: 'Top' }, { value: 'middle', label: 'Middle' }, { value: 'bottom', label: 'Bottom' }]} onChange={(v) => fmt((f) => { f.valign = v; })} />
        <TextInput value={P.decimalChar ?? '.'} onChange={(v) => fmt((f) => { f.decimalChar = v.slice(-1) || undefined; }, false)} />
      </div>
      <div className="grid grid-cols-4 gap-1">
        {pad('padTop', 'Top')}{pad('padRight', 'Right')}{pad('padBottom', 'Bottom')}{pad('padLeft', 'Left')}
      </div>
      <div className="grid grid-cols-[1fr_auto] items-end gap-1">
        <ColorField label="Cell fill" value={P.fill ?? null} allowNone onChange={(v) => fmt((f) => { f.fill = v; })} />
        <IconButton title="Fill from the table style (zebra, head, foot)" disabled={local.fill === undefined} onClick={() => fmt((f) => { delete f.fill; })}><RotateCcw size={12} /></IconButton>
      </div>
      <div>
        <span className="mb-1 block text-[10.5px] text-ink-400">Text rotation</span>
        <Segmented value={String(P.rotation ?? 0)} options={[{ value: '0', label: '0°' }, { value: '90', label: '90°' }, { value: '180', label: '180°' }, { value: '270', label: '270°' }]} onChange={(v) => fmt((f) => { f.rotation = Number(v) as CellRotation; })} />
      </div>
      <div className="grid grid-cols-[1fr_64px_1fr] items-end gap-1">
        <Select<CellDiagonal> label="Diagonal" value={P.diagonal ?? 'none'} options={[{ value: 'none', label: 'None' }, { value: 'down', label: '╲ Down' }, { value: 'up', label: '╱ Up' }, { value: 'cross', label: '╳ Both' }]} onChange={(v) => fmt((f) => { f.diagonal = v; })} />
        <NumberField value={P.diagonalStroke?.w ?? 0.5} unit="pt" min={0} step={0.25} onChange={(w) => fmt((f) => { f.diagonalStroke = { ...(P.diagonalStroke ?? rule(0.5)), w }; })} />
        <ColorField value={P.diagonalStroke?.color ?? '#1b1813'} onChange={(c) => c && fmt((f) => { f.diagonalStroke = { ...(P.diagonalStroke ?? rule(0.5)), color: c }; })} />
      </div>

      <div className="space-y-1.5 rounded-md border border-ink-700 p-2">
        <Select<EdgeTarget> label="Cell edges" value={edgeTarget} options={[
          { value: 'outline', label: 'Outline of the selection' }, { value: 'all', label: 'All edges' }, { value: 'top', label: 'Top' }, { value: 'bottom', label: 'Bottom' },
          { value: 'left', label: 'Left' }, { value: 'right', label: 'Right' }, { value: 'innerH', label: 'Inner horizontal' }, { value: 'innerV', label: 'Inner vertical' },
        ]} onChange={setEdgeTarget} />
        <StrokeEdit label="Rule" value={edge} onChange={setEdge} />
        <div className="grid grid-cols-3 gap-1">
          <Button variant="primary" onClick={() => applyEdges(edge)}>Apply</Button>
          <Button title="Remove the rule on these edges" onClick={() => applyEdges({ ...edge, w: 0 })}>No rule</Button>
          <Button title="Edges back to the table's rules" onClick={() => applyEdges(null)}><RotateCcw size={12} /> Reset</Button>
        </div>
      </div>

      <span className="block pt-1 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-ink-400">Cell text</span>
      <Row>
        <Select label="Paragraph style" value={P.paraStyle ?? ''} options={[{ value: '', label: '— Table text —' }, ...(project.paragraphStyles ?? []).map((p) => ({ value: p.id, label: p.name }))]} onChange={(v) => fmt((f) => { f.paraStyle = v || undefined; })} />
        <Select label="Character style" value={P.charStyle ?? ''} options={[{ value: '', label: '— None —' }, ...(project.characterStyles ?? []).map((p) => ({ value: p.id, label: p.name }))]} onChange={(v) => fmt((f) => { f.charStyle = v || undefined; })} />
      </Row>
      <Select label="Typeface" value={P.fontFamily ?? el.style.fontFamily} options={familyOptions()} onChange={(v) => fmt((f) => { f.fontFamily = v; })} />
      <Row>
        <NumberField label="Size" unit="pt" value={P.fontSize ?? el.style.fontSize} min={3} max={96} step={0.5} onChange={(v) => fmt((f) => { f.fontSize = v; })} onScrubStart={begin} />
        <NumberField label="Leading" unit="pt" value={P.leading ?? (P.fontSize ? +((el.style.leading * P.fontSize) / el.style.fontSize).toFixed(2) : el.style.leading)} min={3} max={120} step={0.5} onChange={(v) => fmt((f) => { f.leading = v; })} onScrubStart={begin} />
        <NumberField label="Weight" value={P.weight ?? el.style.weight} min={100} max={900} step={50} decimals={0} onChange={(v) => fmt((f) => { f.weight = v; })} onScrubStart={begin} />
        <NumberField label="Tracking" unit="‰" value={P.tracking ?? el.style.tracking} min={-200} max={800} step={5} decimals={0} onChange={(v) => fmt((f) => { f.tracking = v; })} onScrubStart={begin} />
      </Row>
      <Row>
        <ColorField label="Colour" value={P.color ?? el.style.color} onChange={(v) => v && fmt((f) => { f.color = v; })} />
        <Select label="Figures" value={P.figures ?? 'default'} options={FIGURES} onChange={(v) => fmt((f) => { f.figures = v === 'default' ? undefined : v; })} />
        <Select label="Case" value={P.textTransform ?? el.style.textTransform} options={TRANSFORMS} onChange={(v) => fmt((f) => { f.textTransform = v; })} />
        <div className="flex items-end pb-1.5"><Toggle label="Italic" checked={P.italic ?? el.style.italic} onChange={(v) => fmt((f) => { f.italic = v; })} /></div>
      </Row>
    </Section>
  );
}

/* -------------------------------------------------------------------------- */
/* Flow across frames                                                          */
/* -------------------------------------------------------------------------- */

function ThreadSection({ frame, head, th, mut }: { frame: TableElement; head: TableElement; th: TableThread | null; mut: Mut }) {
  const s = useStore.getState;
  const project = useStore((st) => st.project);
  const n = th?.frames.length ?? 1, i = th?.index ?? 0;
  const lastRef = th ? th.frames[th.frames.length - 1] : null;
  const last = lastRef ? layoutTable(lastRef.el, { project, pageIndex: lastRef.pageIndex }) : null;
  const L = layoutTable(frame, { project, pageIndex: th?.frames[i].pageIndex ?? null });
  const body = L.rowMap.filter((r) => r >= head.headerRows && r < head.rows.length - head.footerRows);
  return (
    <Section title="Flow across frames" id="el-table-flow">
      <div className="flex items-center justify-between rounded-md border border-ink-700 bg-ink-900 px-2 py-1.5 text-[11px] text-ink-300">
        <span>{n > 1 ? `Frame ${i + 1} of ${n}` : 'One frame'}{body.length ? ` · body rows ${Math.min(...body) + 1}–${Math.max(...body) + 1}` : ''}</span>
        {last?.overset && <span className="font-medium text-[#e5483a]" title="Rows that fit no frame are not printed">Overset rows</span>}
      </div>
      <Button className="w-full" onClick={() => continueTableOnNextPage(frame.id)}><BetweenHorizontalEnd size={12} /> Continue in a new frame on the next page</Button>
      <div className="grid grid-cols-2 gap-1">
        <Button title="Then click an empty table frame, or an empty spot on a page" onClick={() => { s().setLinking(frame.id); s().notify('Click an empty table frame, or an empty spot on any page, to continue the table there (Esc cancels).'); }}><Link size={12} /> Thread to…</Button>
        <Button disabled={!frame.flowNext} title="The frames after this one let go of the table" onClick={() => unthreadTable(frame.id)}><Unlink size={12} /> Unthread</Button>
      </div>
      <Toggle label="Repeat the head in every frame" checked={head.repeatHeader !== false} onChange={(v) => mut((t) => { t.repeatHeader = v; })} hint="Off: the head rows appear once, at the top of the table" />
      <Toggle label="Skip the head in the first frame" checked={!!head.skipFirstHeader} onChange={(v) => mut((t) => { t.skipFirstHeader = v; })} hint="For a 'continued' head that only shows after a break" />
      <Toggle label="Repeat the foot in every frame" checked={head.repeatFooter !== false} onChange={(v) => mut((t) => { t.repeatFooter = v; })} hint="Off: the foot rows appear once, at the end of the table (totals)" />
      <Toggle label="Skip the foot in the last frame" checked={!!head.skipLastFooter} onChange={(v) => mut((t) => { t.skipLastFooter = v; })} />
      <Toggle label="Allow rows to break across frames" checked={!!head.breakRows} onChange={(v) => mut((t) => { t.breakRows = v; })} hint="A row taller than the space left continues in the next frame; otherwise rows move whole (rows joined by a merged cell stay together)" />
      <Hint>Rows never split unless allowed. The head and foot repeat as set; the table's rows live in its first frame, the others are empty frames it flows through.</Hint>
    </Section>
  );
}


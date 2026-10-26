import React, { useState } from 'react';
import type { Draft } from 'immer';
import type { BookSpec, JacketFinish, PanelGrid, Project } from '../../model/types';
import { useStore } from '../../store/store';
import { coverGrid, jacketGrid, computeJacket, computeBinding, DEFAULT_JACKET, DEFAULT_PANEL_GRID } from '../../engine/binding';
import { computeGrid, panelGridLines, textBlock } from '../../engine/grid';
import { spreadsOf, pageKey, masterKey, pageSide, COVER_KEY, JACKET_KEY, guidesOf } from '../../model/surfaces';
import { Section, Row, NumberField, Select, Toggle, ColorField, Button, Hint, Segmented } from '../controls';
import { enableJacket, starterJacket } from '../jacket';
import { cloneElement } from '../../model/factory';
import { ptToMm } from '../../model/units';

/** Editor for the grid & margins applied inside cover / jacket panels. */
export function PanelGridEditor({ which }: { which: 'cover' | 'jacket' }) {
  const book = useStore((s) => s.project.book);
  const s = useStore.getState;
  const g = which === 'cover' ? coverGrid(book) : jacketGrid(book);
  const set = (fn: (d: PanelGrid) => void) => s().update((d) => {
    const cur = which === 'cover' ? coverGrid(d.book as BookSpec) : jacketGrid(d.book as BookSpec);
    const next: PanelGrid = { ...cur, margins: { ...cur.margins } };
    fn(next);
    if (which === 'cover') d.book.cover.grid = next;
    else d.book.jacket = { ...DEFAULT_JACKET, ...(d.book.jacket ?? {}), grid: next };
  });
  const begin = () => s().checkpoint();
  return (
    <Section title={`${which === 'cover' ? 'Cover' : 'Jacket'} grid & margins`} id={`pg-${which}`}>
      <Hint>Applied inside the front, back{which === 'jacket' ? ' and flap' : ''} panels; “inner” is the edge toward the spine{which === 'jacket' ? ' or fold' : ''}. The spine gets head and foot margins.</Hint>
      <Row>
        <NumberField label="Inner" length value={g.margins.inner} min={0} onScrubStart={begin} onChange={(v) => set((d) => { d.margins.inner = v; })} />
        <NumberField label="Outer" length value={g.margins.outer} min={0} onScrubStart={begin} onChange={(v) => set((d) => { d.margins.outer = v; })} />
        <NumberField label="Head" length value={g.margins.top} min={0} onScrubStart={begin} onChange={(v) => set((d) => { d.margins.top = v; })} />
        <NumberField label="Foot" length value={g.margins.bottom} min={0} onScrubStart={begin} onChange={(v) => set((d) => { d.margins.bottom = v; })} />
        <NumberField label="Columns" value={g.columns} min={1} max={24} decimals={0} onChange={(v) => set((d) => { d.columns = Math.round(v); })} />
        <NumberField label="Rows" value={g.rows} min={1} max={24} decimals={0} onChange={(v) => set((d) => { d.rows = Math.round(v); })} />
        <NumberField label="Column gutter" length value={g.gutter} min={0} onChange={(v) => set((d) => { d.gutter = v; })} />
        <NumberField label="Row gutter" length value={g.rowGutter} min={0} onChange={(v) => set((d) => { d.rowGutter = v; })} />
        <NumberField label="Baseline" unit="pt" value={g.baseline} min={0} step={0.5} onChange={(v) => set((d) => { d.baseline = v; })} hint="0 = off" />
        <NumberField label="Spine head/foot" length value={g.spineMargin} min={0} onChange={(v) => set((d) => { d.spineMargin = v; })} />
      </Row>
      <Row>
        <Toggle label="Show grid" checked={g.show} onChange={(v) => set((d) => { d.show = v; })} />
        <Toggle label="Snap" checked={g.snap} onChange={(v) => set((d) => { d.snap = v; })} />
      </Row>
      <Button variant="ghost" className="w-full" onClick={() => set((d) => { Object.assign(d, { ...DEFAULT_PANEL_GRID, margins: { ...DEFAULT_PANEL_GRID.margins } }); })}>Reset to defaults</Button>
    </Section>
  );
}

/** Dust-jacket dimensions, finish and starter artwork. */
export function JacketSettings() {
  const book = useStore((s) => s.project.book);
  const count = useStore((s) => s.project.jacket?.elements.length ?? 0);
  const s = useStore.getState;
  const j = { ...DEFAULT_JACKET, ...(book.jacket ?? {}) };
  const set = (fn: (d: NonNullable<BookSpec['jacket']>) => void) => s().update((d) => {
    const next = { ...DEFAULT_JACKET, ...(d.book.jacket ?? {}) };
    fn(next);
    d.book.jacket = next;
  });
  const jc = computeJacket(book, computeBinding(book));
  return (
    <Section title="Dust jacket" id="jacket-settings">
      <Toggle label="Book has a dust jacket" checked={j.enabled} onChange={(v) => { if (v) enableJacket(false); else set((d) => { d.enabled = false; }); }} />
      <Row>
        <NumberField label="Flap width" length value={j.flapWidth} min={0} onChange={(v) => set((d) => { d.flapWidth = v; })} hint="Usually 75–100 mm, at least a third of the board" />
        <NumberField label="Height allowance" length value={j.heightAllowance} onChange={(v) => set((d) => { d.heightAllowance = v; })} />
        <NumberField label="Fold ease" length value={j.foldEase} min={0} onChange={(v) => set((d) => { d.foldEase = v; })} hint="Extra beyond the board thickness at each fore-edge fold" />
        <Select<JacketFinish> label="Finish" value={j.finish} options={[{ value: 'matte', label: 'Matte laminate' }, { value: 'gloss', label: 'Gloss laminate' }, { value: 'soft-touch', label: 'Soft-touch' }, { value: 'uncoated', label: 'Uncoated paper' }]} onChange={(v) => set((d) => { d.finish = v; })} />
      </Row>
      <ColorField label="Jacket paper" value={j.paperColor} onChange={(v) => v && set((d) => { d.paperColor = v; })} />
      <div className="rounded-md bg-ink-900 p-2 font-mono text-[10.5px] leading-relaxed text-ink-300">
        {jc.notes.map((n, i) => <div key={i}>{n}</div>)}
        <div className="mt-1 text-ink-500">{jc.panels.filter((p) => !p.id.endsWith('-fold')).map((p) => `${p.label} ${ptToMm(p.w).toFixed(0)}`).join(' · ')} mm</div>
      </div>
      <Row>
        <Button disabled={count > 0} onClick={() => { s().update((d) => { if (!d.jacket) d.jacket = { elements: [] }; d.jacket.elements.push(...(starterJacket() as typeof d.jacket.elements)); }); }} title={count > 0 ? 'The jacket already has artwork' : 'Title, author, spine, blurb and flap copy'}>Starter layout</Button>
        <Button onClick={() => s().update((d) => {
          // Copy the case artwork onto the jacket: same panels, same anchors.
          if (!d.jacket) d.jacket = { elements: [] };
          const copies = (d.cover.elements as Project['cover']['elements']).filter((e) => e.anchor && e.anchor !== null).map((e) => ({ ...cloneElement(e), finish: 'none' as const }));
          d.jacket.elements.push(...(copies as typeof d.jacket.elements));
        })}>Copy cover artwork</Button>
      </Row>
    </Section>
  );
}

/** Ruler guides: visibility, locking, clearing and the "Create guides" grid. */
export function GuidesSection() {
  const project = useStore((s) => s.project);
  const view = useStore((s) => s.view);
  const spread = useStore((s) => s.spread);
  const masterEdit = useStore((s) => s.masterEdit);
  const s = useStore.getState;
  const [cols, setCols] = useState(4);
  const [rows, setRows] = useState(0);
  const [gutter, setGutter] = useState(12);
  const [fit, setFit] = useState<'margins' | 'page'>('margins');

  const keys = (): { key: string; box: { x: number; y: number; w: number; h: number }[] }[] => {
    const spec = project.book;
    if (view === 'cover' || view === 'jacket') {
      const calc = computeBinding(spec);
      const panels = view === 'cover' ? calc.panels : computeJacket(spec, calc).panels;
      const H = view === 'cover' ? calc.coverH : computeJacket(spec, calc).height;
      const g = panelGridLines(panels, view === 'cover' ? coverGrid(spec) : jacketGrid(spec), H);
      const boxes = fit === 'margins' ? g.blocks.filter((b) => b.panel !== 'spine') : panels.filter((p) => !p.id.startsWith('hinge') && !p.id.endsWith('-fold') && p.id !== 'spine').map((p) => ({ x: p.x, y: 0, w: p.w, h: H }));
      return [{ key: view === 'cover' ? COVER_KEY : JACKET_KEY, box: boxes }];
    }
    // Editing a master: its two pages, not the spread hidden behind it.
    const master = masterEdit ? project.masters.find((m) => m.id === masterEdit.id) : null;
    if (master) {
      return (['left', 'right'] as const).map((side) => ({ key: masterKey(master.id, side), box: [fit === 'margins' ? textBlock(spec, side) : { x: 0, y: 0, w: spec.trimW, h: spec.trimH }] }));
    }
    const sp = spreadsOf(project)[spread];
    return [sp?.left, sp?.right].filter((i): i is number => i != null).map((pi) => {
      const side = pageSide(project, pi);
      const b = fit === 'margins' ? textBlock(spec, side) : { x: 0, y: 0, w: spec.trimW, h: spec.trimH };
      return { key: pageKey(project.pages[pi].id), box: [b] };
    });
  };

  const create = () => {
    s().update((d) => {
      if (!d.guides) d.guides = {};
      for (const { key, box } of keys()) {
        const g = d.guides[key] ?? { x: [], y: [] };
        for (const b of box) {
          if (cols > 0) {
            const cw = (b.w - gutter * (cols - 1)) / cols;
            for (let i = 0; i <= cols; i++) {
              const x = b.x + i * (cw + gutter);
              if (i > 0) g.x.push(+(x - gutter).toFixed(3));
              if (i < cols) g.x.push(+x.toFixed(3));
            }
          }
          if (rows > 0) {
            const rh = (b.h - gutter * (rows - 1)) / rows;
            for (let i = 0; i <= rows; i++) {
              const y = b.y + i * (rh + gutter);
              if (i > 0) g.y.push(+(y - gutter).toFixed(3));
              if (i < rows) g.y.push(+y.toFixed(3));
            }
          }
        }
        g.x = [...new Set(g.x)]; g.y = [...new Set(g.y)];
        d.guides[key] = g;
      }
      d.guidesHidden = false;
    });
  };

  const count = keys().reduce((n, k) => n + guidesOf(project, k.key).x.length + guidesOf(project, k.key).y.length, 0);
  return (
    <Section title="Guides" id="doc-guides">
      <Hint>Drag from the rulers to place guides on pages, the cover or the jacket; drag a guide back onto a ruler to delete it. ⌘; shows/hides, ⌥⌘; locks.</Hint>
      <Row>
        <Toggle label="Show guides" checked={!project.guidesHidden} onChange={(v) => s().update((d) => { d.guidesHidden = !v; }, { history: false })} />
        <Toggle label="Lock guides" checked={!!project.guidesLocked} onChange={(v) => s().update((d) => { d.guidesLocked = v; }, { history: false })} />
      </Row>
      <div className="rounded-md border border-ink-700 p-2">
        <span className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-ink-400">Create guides</span>
        <Row className="mt-1">
          <NumberField label="Columns" value={cols} min={0} max={48} decimals={0} onChange={(v) => setCols(Math.round(v))} />
          <NumberField label="Rows" value={rows} min={0} max={48} decimals={0} onChange={(v) => setRows(Math.round(v))} />
          <NumberField label="Gutter" length value={gutter} min={0} onChange={setGutter} />
          <div className="flex items-end"><Segmented size="sm" value={fit} onChange={setFit} options={[{ value: 'margins', label: 'Margins' }, { value: 'page', label: view === 'spreads' ? 'Page' : 'Panel' }]} /></div>
        </Row>
        <Button className="mt-2 w-full" onClick={create}>Add to {view === 'cover' ? 'cover panels' : view === 'jacket' ? 'jacket panels' : masterEdit ? 'this master' : 'this spread'}</Button>
      </div>
      <Button variant="danger" className="w-full" disabled={!count} onClick={() => s().clearGuides(keys().map((k) => k.key))}>Clear {count} guide{count === 1 ? '' : 's'} here</Button>
    </Section>
  );
}

export { computeGrid };
export type { Draft };

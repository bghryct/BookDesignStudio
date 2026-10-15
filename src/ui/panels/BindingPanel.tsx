import React, { useMemo } from 'react';
import clsx from 'clsx';
import type { Draft } from 'immer';
import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import { useStore } from '../../store/store';
import type { BookSpec, BindingType, CoverFinish, EdgeTreatment } from '../../model/types';
import { computeBinding, type BindingCalc } from '../../engine/binding';
import { mm, ptToMm, fromPt } from '../../model/units';
import { Section, Row, NumberField, Select, Toggle, Slider, ColorField, Hint, Button } from '../controls';

const BINDINGS: { id: BindingType; name: string; note: string }[] = [
  { id: 'case', name: 'Case-bound', note: 'Sewn sections, rounded & backed, boards, cloth or leather, optional raised bands (Diehl).' },
  { id: 'smyth', name: 'Smyth-sewn soft', note: 'Sewn sections with a flexible wrapped cover — lies open.' },
  { id: 'perfect', name: 'Perfect bound', note: 'Milled spine glued with PUR/EVA; hinge-scored cover.' },
  { id: 'coptic', name: 'Coptic', note: 'Exposed spine, link-stitched sections, independent boards.' },
  { id: 'stab', name: 'Yotsume toji', note: 'Japanese stab binding: four-hole thread pattern, fukuro-toji leaves.' },
  { id: 'munari', name: 'Munari', note: 'Sewn soft cover for die-cut, vellum and coloured-paper sequences.' },
];

const PAPERS: { label: string; gsm: number; bulk: number }[] = [
  { label: 'Book wove 90 g · bulk 1.3', gsm: 90, bulk: 1.3 },
  { label: 'Munken Pure 100 g · bulk 1.13', gsm: 100, bulk: 1.13 },
  { label: 'Munken Print Cream 80 g · bulk 1.5', gsm: 80, bulk: 1.5 },
  { label: 'Bulky novel 70 g · bulk 2.0', gsm: 70, bulk: 2.0 },
  { label: 'Bible / India 40 g · bulk 1.0', gsm: 40, bulk: 1.0 },
  { label: 'Coated silk 130 g · bulk 0.9', gsm: 130, bulk: 0.9 },
  { label: 'Washi (kozo) 30 g · bulk 1.8', gsm: 30, bulk: 1.8 },
  { label: 'Tracing / vellum 90 g · bulk 0.75', gsm: 90, bulk: 0.75 },
];

export function BindingPanel() {
  const book = useStore((s) => s.project.book);
  const pages = useStore((s) => s.project.pages.length);
  const calc = useMemo(() => computeBinding(book), [book]);
  const s = useStore.getState;
  const set = (fn: (d: Draft<BookSpec>) => void) => s().update((d) => { fn(d.book); });
  const begin = () => s().checkpoint();
  const b = book.binding;
  const u = book.unit;
  const fmt = (v: number) => `${(+fromPt(v, u).toFixed(u === 'in' ? 3 : 2))} ${u}`;

  return (
    <div>
      <Section title="Binding" id="bind-type">
        <div className="grid grid-cols-2 gap-1.5">
          {BINDINGS.map((x) => (
            <button key={x.id} type="button" title={x.note} onClick={() => set((d) => {
              d.binding.type = x.id;
              if (x.id === 'stab') { d.direction = d.direction; d.cover.finish = 'paper'; }
              if (x.id === 'case' && (d.cover.finish === 'gloss' || d.cover.finish === 'matte')) d.cover.finish = 'cloth';
              if ((x.id === 'perfect' || x.id === 'smyth' || x.id === 'munari') && (d.cover.finish === 'cloth' || d.cover.finish === 'leather' || d.cover.finish === 'buckram')) d.cover.finish = 'matte';
            })}
              className={clsx('rounded-md border p-2 text-left', b.type === x.id ? 'border-rubric bg-rubric/10' : 'border-ink-700 hover:border-ink-500')}>
              <div className="text-[11.5px] font-medium text-ink-100">{x.name}</div>
              <div className="mt-0.5 line-clamp-2 text-[10px] leading-snug text-ink-400">{x.note}</div>
            </button>
          ))}
        </div>
      </Section>

      <Section title="Spine calculation" id="bind-calc">
        <div className="grid grid-cols-2 gap-x-3 gap-y-1 rounded-md bg-ink-900 p-2 font-mono text-[10.5px] text-ink-300">
          <span className="text-ink-500">Spine</span><span className="text-right text-[12px] text-ink-100">{fmt(calc.spine)}</span>
          <span className="text-ink-500">Text block</span><span className="text-right">{fmt(calc.textBlock)}</span>
          <span className="text-ink-500">Leaves</span><span className="text-right">{calc.leaves}</span>
          {calc.sections > 0 && <><span className="text-ink-500">Sections</span><span className="text-right">{calc.sections} × {b.sectionPages} pp</span></>}
          <span className="text-ink-500">Caliper</span><span className="text-right">{ptToMm(calc.caliper).toFixed(3)} mm</span>
          {calc.swell > 0 && <><span className="text-ink-500">Thread swell</span><span className="text-right">{fmt(calc.swell)}</span></>}
          {b.type === 'case' && <><span className="text-ink-500">Boards</span><span className="text-right">{ptToMm(calc.boardW).toFixed(1)} × {ptToMm(calc.boardH).toFixed(1)} mm</span></>}
          <span className="text-ink-500">Flat cover</span><span className="text-right">{ptToMm(calc.coverW + 2 * calc.wrap).toFixed(1)} × {ptToMm(calc.coverH + 2 * calc.wrap).toFixed(1)} mm</span>
        </div>
        <CaseDiagram calc={calc} />
        {calc.warnings.map((w, i) => (
          <p key={i} className="flex gap-1.5 text-[10.5px] leading-snug text-[#f0b46e]"><AlertTriangle size={12} className="mt-px shrink-0" /> {w}</p>
        ))}
        <details className="text-[10.5px] text-ink-400">
          <summary className="cursor-pointer text-ink-300">Diehl notes</summary>
          <ul className="mt-1 list-disc space-y-1 pl-4 leading-snug">
            {calc.notes.map((n, i) => <li key={i}>{n}</li>)}
            {calc.linings.map((n, i) => <li key={`l${i}`}>{n}</li>)}
          </ul>
        </details>
      </Section>

      <Section title="Text block & paper" id="bind-paper">
        <Row>
          <NumberField label="Planned pages" value={book.plannedPages} min={4} step={2} decimals={0} onScrubStart={begin} onChange={(v) => set((d) => { d.plannedPages = Math.max(4, Math.round(v / 2) * 2); })} hint={`${pages} pages are designed; the spine uses the planned extent`} />
          <Select label="Section" value={String(b.sectionPages)} options={[4, 8, 12, 16, 32].map((n) => ({ value: String(n), label: `${n} pp ${n === 4 ? '(folio)' : n === 8 ? '(quarto)' : n === 16 ? '(octavo)' : n === 32 ? '(16mo)' : ''}` }))} onChange={(v) => set((d) => { d.binding.sectionPages = Number(v) as 4 | 8 | 12 | 16 | 32; })} />
        </Row>
        <Select label="Paper preset" value="" options={[{ value: '', label: 'Choose a stock…' }, ...PAPERS.map((p) => ({ value: p.label, label: p.label }))]} onChange={(v) => {
          const p = PAPERS.find((x) => x.label === v);
          if (p) set((d) => { d.paper.gsm = p.gsm; d.paper.bulk = p.bulk; });
        }} />
        <Row>
          <NumberField label="Grammage" unit="g/m²" value={book.paper.gsm} min={20} max={400} decimals={0} onScrubStart={begin} onChange={(v) => set((d) => { d.paper.gsm = v; })} />
          <NumberField label="Bulk" unit="cm³/g" value={book.paper.bulk} min={0.5} max={3} step={0.01} decimals={2} onScrubStart={begin} onChange={(v) => set((d) => { d.paper.bulk = v; })} />
          <NumberField label="Sheet W" length value={book.paper.sheetW} min={mm(100)} onChange={(v) => set((d) => { d.paper.sheetW = v; })} />
          <NumberField label="Sheet H" length value={book.paper.sheetH} min={mm(100)} onChange={(v) => set((d) => { d.paper.sheetH = v; })} />
        </Row>
        <Select label="Grain" value={book.paper.grain} options={[{ value: 'long', label: 'Long grain (parallel to the long side)' }, { value: 'short', label: 'Short grain' }]} onChange={(v) => set((d) => { d.paper.grain = v; })} />
        <p className={clsx('flex gap-1.5 text-[10.5px] leading-snug', calc.grain.ok ? 'text-[#7fcf9a]' : 'text-[#f0b46e]')}>
          {calc.grain.ok ? <CheckCircle2 size={12} className="mt-px shrink-0" /> : <AlertTriangle size={12} className="mt-px shrink-0" />}
          {calc.grain.advice}
        </p>
        <NumberField label="Thread Ø" length value={b.threadDiameter} min={0} step={0.05} onChange={(v) => set((d) => { d.binding.threadDiameter = v; })} />
      </Section>

      {(b.type === 'case' || b.type === 'coptic') && (
        <Section title="Boards & covering" id="bind-boards">
          <Row>
            <NumberField label="Board" length value={b.boardThickness} min={mm(0.5)} step={0.25} onScrubStart={begin} onChange={(v) => set((d) => { d.binding.boardThickness = v; })} hint={`Diehl: ~${ptToMm(calc.recommendedBoard).toFixed(1)} mm for this size`} />
            <NumberField label="Squares" length value={b.squares} min={0} onScrubStart={begin} onChange={(v) => set((d) => { d.binding.squares = v; })} />
            {b.type === 'case' && <NumberField label="Joint (french groove)" length value={b.hingeGap} min={0} onChange={(v) => set((d) => { d.binding.hingeGap = v; })} />}
            {b.type === 'case' && <NumberField label="Turn-in" length value={b.turnIn} min={0} onChange={(v) => set((d) => { d.binding.turnIn = v; })} />}
          </Row>
          {b.type === 'case' && (
            <>
              <Slider label="Rounding" value={b.rounding} min={0} max={1} onStart={begin} onChange={(v) => s().update((d) => { d.book.binding.rounding = v; }, { history: false })} format={(v) => (v < 0.05 ? 'Flat back' : `${Math.round(v * 100)}% · depth ${ptToMm(calc.roundDepth).toFixed(1)} mm`)} />
              <NumberField label="Raised bands" value={b.raisedBands} min={0} max={8} decimals={0} onChange={(v) => set((d) => { d.binding.raisedBands = Math.round(v); })} />
              <Toggle label="Headbands" checked={b.headband} onChange={(v) => set((d) => { d.binding.headband = v; })} />
              {b.headband && (
                <Row>
                  <ColorField label="Headband A" value={b.headbandColors[0]} onChange={(v) => v && set((d) => { d.binding.headbandColors[0] = v; })} />
                  <ColorField label="Headband B" value={b.headbandColors[1]} onChange={(v) => v && set((d) => { d.binding.headbandColors[1] = v; })} />
                </Row>
              )}
              <Button className="w-full" onClick={() => set((d) => { d.binding.boardThickness = calc.recommendedBoard; d.binding.squares = Math.max(mm(2), calc.recommendedBoard * 1.2); })}>Use Diehl proportions</Button>
            </>
          )}
        </Section>
      )}

      {(b.type === 'perfect' || b.type === 'smyth' || b.type === 'munari' || b.type === 'stab') && (
        <Section title="Soft cover" id="bind-soft">
          <NumberField label="Cover stock caliper" length value={b.coverCaliper} min={0} step={0.05} onChange={(v) => set((d) => { d.binding.coverCaliper = v; })} />
          <NumberField label="Flaps (French fold)" length value={book.cover.flapWidth} min={0} onChange={(v) => set((d) => { d.cover.flapWidth = v; })} />
        </Section>
      )}

      {b.type === 'stab' && (
        <Section title="Stab binding" id="bind-stab">
          <Select label="Pattern" value={String(b.stabHoles)} options={[{ value: '4', label: 'Yotsume toji — 4 holes' }, { value: '5', label: 'Kikkō toji (tortoise shell) — 5' }, { value: '6', label: 'Kōki toji (noble) — 6' }]} onChange={(v) => set((d) => { d.binding.stabHoles = Number(v) as 4 | 5 | 6; })} />
          <NumberField label="Distance from spine" length value={b.stabMargin} min={mm(4)} onChange={(v) => set((d) => { d.binding.stabMargin = v; })} />
          <Toggle label="Fukuro-toji (leaves folded at the fore-edge)" checked={b.fukuroToji} onChange={(v) => set((d) => { d.binding.fukuroToji = v; })} />
          <ColorField label="Thread" value={b.threadColor} onChange={(v) => v && set((d) => { d.binding.threadColor = v; })} />
          {book.direction !== 'rtl' && <Button className="w-full" onClick={() => set((d) => { d.direction = 'rtl'; })}>Bind on the right (RTL)</Button>}
        </Section>
      )}

      {b.type === 'coptic' && (
        <Section title="Sewing" id="bind-coptic">
          <ColorField label="Thread" value={b.threadColor} onChange={(v) => v && set((d) => { d.binding.threadColor = v; })} />
          <Hint>{calc.stations.length} sewing stations, kettle stitches 12 mm from head and tail.</Hint>
        </Section>
      )}

      <Section title="Cover material & edges" id="bind-cover">
        <Select<CoverFinish> label="Finish" value={book.cover.finish} options={[
          { value: 'cloth', label: 'Bookcloth' }, { value: 'buckram', label: 'Library buckram' }, { value: 'leather', label: 'Full leather' },
          { value: 'paper', label: 'Uncoated paper' }, { value: 'matte', label: 'Matte laminate' }, { value: 'soft-touch', label: 'Soft-touch' },
          { value: 'gloss', label: 'Gloss laminate' }, { value: 'vellum', label: 'Translucent vellum' },
        ]} onChange={(v) => set((d) => { d.cover.finish = v; })} />
        <ColorField label="Material colour" value={book.cover.material} onChange={(v) => v && set((d) => { d.cover.material = v; })} />
        <Row>
          <Select<EdgeTreatment> label="Edges" value={book.cover.edge} options={[{ value: 'plain', label: 'Plain' }, { value: 'gilt', label: 'Gilt (gold leaf)' }, { value: 'stained', label: 'Stained' }, { value: 'sprayed', label: 'Sprayed' }, { value: 'deckle', label: 'Deckle' }]} onChange={(v) => set((d) => { d.cover.edge = v; })} />
          <ColorField label="Edge colour" value={book.cover.edgeColor} onChange={(v) => v && set((d) => { d.cover.edgeColor = v; })} />
        </Row>
      </Section>
    </div>
  );
}

/** Flat layout of the cover / case with folds, joints, turn-ins and corner mitres. */
function CaseDiagram({ calc }: { calc: BindingCalc }) {
  const W = calc.coverW + calc.wrap * 2, H = calc.coverH + calc.wrap * 2;
  const k = 260 / W;
  const w = calc.wrap;
  const m = calc.cornerMitre;
  const outline = calc.type === 'case'
    // Turn-in outline with the corners cut at 45°, leaving 1.5 × board thickness.
    ? `M${m + 0} 0 L${W - m} 0 L${W} ${m} L${W} ${H - m} L${W - m} ${H} L${m} ${H} L0 ${H - m} L0 ${m} Z`
    : `M0 0H${W}V${H}H0Z`;
  return (
    <svg viewBox={`${-4} ${-4} ${W + 8} ${H + 8}`} width={260} height={(H + 8) * k} className="mt-2 block">
      <path d={outline} fill="rgba(217,83,47,0.08)" stroke="rgba(217,83,47,0.7)" strokeWidth={1 / k} />
      {calc.panels.map((p) => (
        <g key={p.id}>
          <rect x={w + p.x} y={w} width={p.w} height={calc.coverH} fill={p.id === 'spine' ? 'rgba(201,162,39,0.18)' : p.id.startsWith('hinge') ? 'rgba(255,255,255,0.03)' : 'rgba(255,255,255,0.08)'} stroke="rgba(255,255,255,0.35)" strokeWidth={0.6 / k} />
          {p.w * k > 26 && <text x={w + p.x + p.w / 2} y={w + calc.coverH / 2} fontSize={9 / k} textAnchor="middle" fill="rgba(255,255,255,0.55)" style={{ fontFamily: 'ui-sans-serif' }}>{p.label.split(' ')[0]}</text>}
        </g>
      ))}
      {calc.bands.map((y, i) => {
        const sp = calc.panels.find((p) => p.id === 'spine')!;
        return <line key={i} x1={w + sp.x} x2={w + sp.x + sp.w} y1={w + y} y2={w + y} stroke="#c9a227" strokeWidth={1.5 / k} />;
      })}
      {calc.folds.map((f, i) => <line key={i} x1={w + f.x} x2={w + f.x} y1={0} y2={H} stroke="#3fbf86" strokeWidth={0.7 / k} strokeDasharray={`${4 / k} ${2 / k}`} />)}
    </svg>
  );
}

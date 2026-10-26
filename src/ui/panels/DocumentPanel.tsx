import React, { useState } from 'react';
import type { Draft } from 'immer';
import { Plus, Trash } from 'lucide-react';
import { useStore } from '../../store/store';
import type { BookSpec, Unit, Swatch, GridMode, Element } from '../../model/types';
import { mm, fromPt } from '../../model/units';
import { Section, Row, NumberField, Select, Toggle, TextInput, Segmented, Button, Hint, ColorField } from '../controls';
import { CANONS, canonMargins, lockGridToBaseline, type CanonKind } from '../../engine/grid';
import { cmykToHex, rgbToCmyk } from '../../lib/color';
import { PanelGridEditor, JacketSettings, GuidesSection } from './SurfaceSettings';
import { generateContents, generateIndex, conditionNames } from '../contents';
import { checkSpelling, type Misspelling } from '../../engine/spelling';
import { FindObjectsSection, revealStory } from './FindChange';
import { uid } from '../../lib/random';

export const TRIM_PRESETS: { id: string; label: string; w: number; h: number; group: string }[] = [
  { id: 'classic', label: 'Classical 2:3 — 144 × 216 mm', w: 144, h: 216, group: 'Book' },
  { id: 'golden', label: 'Golden 1:1.618 — 140 × 226.5 mm', w: 140, h: 226.5, group: 'Book' },
  { id: 'royal', label: 'Royal — 156 × 234 mm', w: 156, h: 234, group: 'Book' },
  { id: 'demy', label: 'Demy — 138 × 216 mm', w: 138, h: 216, group: 'Book' },
  { id: 'trade', label: 'US Trade — 6 × 9 in', w: 152.4, h: 228.6, group: 'Book' },
  { id: 'digest', label: 'Digest — 5.5 × 8.5 in', w: 139.7, h: 215.9, group: 'Book' },
  { id: 'bformat', label: 'B-format paperback — 129 × 198 mm', w: 129, h: 198, group: 'Book' },
  { id: 'crown4', label: 'Crown quarto — 189 × 246 mm', w: 189, h: 246, group: 'Book' },
  { id: 'cleves', label: 'Book of hours (Cleves) — 130 × 192 mm', w: 130, h: 192, group: 'Historic' },
  { id: 'octavo', label: 'Aldine octavo — 100 × 155 mm', w: 100, h: 155, group: 'Historic' },
  { id: 'a4', label: 'A4 — 210 × 297 mm', w: 210, h: 297, group: 'ISO' },
  { id: 'a5', label: 'A5 — 148 × 210 mm', w: 148, h: 210, group: 'ISO' },
  { id: 'b5', label: 'B5 — 176 × 250 mm', w: 176, h: 250, group: 'ISO' },
  { id: 'square', label: 'Square — 210 × 210 mm', w: 210, h: 210, group: 'ISO' },
  { id: 'shiroku', label: '四六判 Shiroku — 127 × 188 mm', w: 127, h: 188, group: 'Japanese' },
  { id: 'bunko', label: '文庫 Bunko (A6) — 105 × 148 mm', w: 105, h: 148, group: 'Japanese' },
  { id: 'shinsho', label: '新書 Shinsho — 103 × 182 mm', w: 103, h: 182, group: 'Japanese' },
  { id: 'kiku', label: '菊判 Kiku — 150 × 220 mm', w: 150, h: 220, group: 'Japanese' },
];

/** Page proportions after Bringhurst's musical intervals and geometric series. */
export const PROPORTIONS: { label: string; ratio: number }[] = [
  { label: 'Square (unison)', ratio: 1 }, { label: 'Minor third 5:6', ratio: 6 / 5 }, { label: 'Major third 4:5', ratio: 5 / 4 },
  { label: 'Fourth 3:4', ratio: 4 / 3 }, { label: 'ISO 1:√2', ratio: Math.SQRT2 }, { label: 'Fifth 2:3', ratio: 1.5 },
  { label: 'Minor sixth 5:8', ratio: 1.6 }, { label: 'Golden section 1:φ', ratio: (1 + Math.sqrt(5)) / 2 }, { label: 'Major sixth 3:5', ratio: 5 / 3 },
  { label: 'Hexagon 1:√3', ratio: Math.sqrt(3) }, { label: 'Octave 1:2', ratio: 2 },
];

export function DocumentPanel() {
  const book = useStore((s) => s.project.book);
  const swatches = useStore((s) => s.project.swatches);
  const s = useStore.getState;
  const set = (fn: (d: Draft<BookSpec>) => void) => s().update((d) => { fn(d.book); });
  const live = (fn: (d: Draft<BookSpec>) => void) => s().update((d) => { fn(d.book); }, { history: false });
  const begin = () => s().checkpoint();
  const [canon, setCanon] = useState<CanonKind>('van-de-graaf');
  const canonInfo = CANONS.find((c) => c.id === canon)!;
  const presetId = TRIM_PRESETS.find((p) => Math.abs(mm(p.w) - book.trimW) < 0.5 && Math.abs(mm(p.h) - book.trimH) < 0.5)?.id ?? '';
  const ratio = book.trimH / book.trimW;

  const view = useStore((st) => st.view);
  if (view === 'cover' || view === 'jacket') {
    return (
      <div>
        {view === 'jacket' && <JacketSettings />}
        <PanelGridEditor which={view} />
        <GuidesSection />
        <Section title="Units" id="doc-units-cover">
          <Select<Unit> label="Units" value={book.unit} options={[{ value: 'mm', label: 'Millimetres' }, { value: 'cm', label: 'Centimetres' }, { value: 'in', label: 'Inches' }, { value: 'pt', label: 'Points' }, { value: 'pc', label: 'Picas' }, { value: 'px', label: 'Pixels' }]} onChange={(v) => set((d) => { d.unit = v; })} />
          <Hint>Page format, margins and the book’s grid are edited in the Spreads view.</Hint>
        </Section>
      </div>
    );
  }
  return (
    <div>
      <Section title="Book" id="doc-book">
        <TextInput label="Title" value={book.title} onChange={(v) => live((d) => { d.title = v; })} />
        <TextInput label="Subtitle" value={book.subtitle} onChange={(v) => live((d) => { d.subtitle = v; })} />
        <Row>
          <TextInput label="Author" value={book.author} onChange={(v) => live((d) => { d.author = v; })} />
          <TextInput label="Publisher" value={book.publisher} onChange={(v) => live((d) => { d.publisher = v; })} />
        </Row>
        <Hint>Use {'{title}'} {'{author}'} {'{chapter}'} {'{page}'} {'{page:roman}'} {'{lastpage}'} {'{date}'} in any text frame — running heads and folios update everywhere. {'{xref:name}'} prints the page of {'{anchor:name}'}.</Hint>
        <Button className="w-full" onClick={() => {
          const r = generateContents();
          s().notify(r.entries ? `${r.updated ? 'Updated' : 'Created'} the contents: ${r.entries} entr${r.entries === 1 ? 'y' : 'ies'} with their page numbers.` : 'No chapter titles or # headings found yet.');
        }}>Generate contents page</Button>
        <Button className="w-full" onClick={() => {
          const r = generateIndex();
          s().notify(r.entries ? `${r.updated ? 'Updated' : 'Created'} the index: ${r.entries} term${r.entries === 1 ? '' : 's'} with their page numbers.` : 'No index entries yet — mark words with {ix:term} in the story editor.');
        }}>Generate index</Button>
      </Section>

      <ConditionsSection />

      <SpellingSection />

      <FindObjectsSection />

      <Section title="Format" id="doc-format">
        <Row>
          <Select<Unit> label="Units" value={book.unit} options={[{ value: 'mm', label: 'Millimetres' }, { value: 'cm', label: 'Centimetres' }, { value: 'in', label: 'Inches' }, { value: 'pt', label: 'Points' }, { value: 'pc', label: 'Picas' }, { value: 'px', label: 'Pixels' }]} onChange={(v) => set((d) => { d.unit = v; })} />
          <Select label="Preset" value={presetId} options={[{ value: '', label: 'Custom' }, ...TRIM_PRESETS.map((p) => ({ value: p.id, label: p.label, group: p.group }))]} onChange={(v) => {
            const p = TRIM_PRESETS.find((x) => x.id === v);
            if (p) set((d) => { d.trimW = mm(p.w); d.trimH = mm(p.h); });
          }} />
        </Row>
        <Row>
          <NumberField label="Trim width" length value={book.trimW} min={mm(20)} onScrubStart={begin} onChange={(v) => set((d) => { d.trimW = v; })} />
          <NumberField label="Trim height" length value={book.trimH} min={mm(20)} onScrubStart={begin} onChange={(v) => set((d) => { d.trimH = v; })} />
          <NumberField label="Bleed" length value={book.bleed} min={0} onChange={(v) => set((d) => { d.bleed = v; })} />
          <NumberField label="Slug (marks)" length value={book.slug} min={0} onChange={(v) => set((d) => { d.slug = v; })} />
        </Row>
        <p className="text-[10.5px] text-ink-400">Proportion 1 : {ratio.toFixed(3)}{Math.abs(ratio - 1.5) < 0.01 ? ' — 2:3, the classical page' : Math.abs(ratio - 1.618) < 0.012 ? ' — golden section' : Math.abs(ratio - Math.SQRT2) < 0.01 ? ' — √2 (ISO)' : Math.abs(ratio - 1.333) < 0.01 ? ' — 3:4' : ''}</p>
        <Select label="Proportion (Bringhurst §8.1) — keeps the width" value="" options={[{ value: '', label: 'Set height from a proportion…' }, ...PROPORTIONS.map((p) => ({ value: String(p.ratio), label: `${p.label} — 1 : ${p.ratio.toFixed(3)}` }))]} onChange={(v) => { const r = parseFloat(v); if (r) set((d) => { d.trimH = d.trimW * r; }); }} />
        <Row>
          <Toggle label="Facing pages" checked={book.facing} onChange={(v) => set((d) => { d.facing = v; })} />
          <Segmented value={book.direction} onChange={(v) => set((d) => { d.direction = v; })} options={[{ value: 'ltr', label: 'LTR', title: 'Binds on the left' }, { value: 'rtl', label: 'RTL', title: 'Binds on the right (Japanese, Arabic, Hebrew)' }]} />
        </Row>
      </Section>

      <Section title="Margins & canon" id="doc-margins">
        <Row>
          <NumberField label="Inner" length value={book.margins.inner} min={0} onScrubStart={begin} onChange={(v) => set((d) => { d.margins.inner = v; })} />
          <NumberField label="Outer" length value={book.margins.outer} min={0} onScrubStart={begin} onChange={(v) => set((d) => { d.margins.outer = v; })} />
          <NumberField label="Top (head)" length value={book.margins.top} min={0} onScrubStart={begin} onChange={(v) => set((d) => { d.margins.top = v; })} />
          <NumberField label="Bottom (foot)" length value={book.margins.bottom} min={0} onScrubStart={begin} onChange={(v) => set((d) => { d.margins.bottom = v; })} />
        </Row>
        <Select<CanonKind> label="Canon" value={canon} options={CANONS.map((c) => ({ value: c.id, label: c.label }))} onChange={setCanon} />
        <p className="text-[10.5px] leading-snug text-ink-400"><span className="text-ink-300">{canonInfo.source}.</span> {canonInfo.rationale}</p>
        <Row>
          <Button variant="primary" onClick={() => set((d) => { d.margins = canonMargins(canon, d.trimW, d.trimH); })}>Apply canon</Button>
          <Toggle label="Show construction" checked={book.grid.showCanon} onChange={(v) => set((d) => { d.grid.showCanon = v; })} />
        </Row>
        <p className="font-mono text-[10px] text-ink-500">
          inner:top:outer:bottom = {[book.margins.inner, book.margins.top, book.margins.outer, book.margins.bottom].map((v) => (v / book.margins.inner).toFixed(2)).join(' : ')}
        </p>
      </Section>

      <Section title="Grid" id="doc-grid">
        <Select<GridMode> label="Mode" value={book.grid.mode} options={[{ value: 'modular', label: 'Modular (Müller-Brockmann / Crouwel)' }, { value: 'manuscript', label: 'Manuscript columns' }, { value: 'free', label: 'Free' }]} onChange={(v) => set((d) => { d.grid.mode = v; })} />
        <Row>
          <NumberField label="Columns" value={book.grid.columns} min={1} max={24} decimals={0} onChange={(v) => set((d) => { d.grid.columns = Math.round(v); })} />
          <NumberField label="Rows (fields)" value={book.grid.rows} min={1} max={24} decimals={0} onChange={(v) => set((d) => { d.grid.rows = Math.round(v); })} />
          <NumberField label="Column gutter" length value={book.grid.gutter} min={0} onChange={(v) => set((d) => { d.grid.gutter = v; })} />
          <NumberField label="Row gutter" length value={book.grid.rowGutter} min={0} onChange={(v) => set((d) => { d.grid.rowGutter = v; })} />
          <NumberField label="Baseline" unit="pt" value={book.grid.baseline} min={0} step={0.25} onChange={(v) => set((d) => { d.grid.baseline = v; })} hint="Usually the body leading" />
          <NumberField label="First baseline" unit="pt" value={book.grid.baselineOffset} min={0} step={0.25} onChange={(v) => set((d) => { d.grid.baselineOffset = v; })} hint="Offset from the top margin" />
          <NumberField label="Micro-grid" value={book.grid.microDivisions} min={1} max={12} decimals={0} onChange={(v) => set((d) => { d.grid.microDivisions = Math.round(v); })} hint="Bosshard's dual grid: subdivisions per field" />
          <NumberField label="2nd system (Bosshard)" value={book.grid.secondaryColumns ?? 0} min={0} max={24} decimals={0} onChange={(v) => set((d) => { d.grid.secondaryColumns = Math.round(v); })} hint="A second column system on the same text block (e.g. 2 over 3); 0 = off. Shown dashed orange; items snap to both." />
        </Row>
        {book.facing && (
          <div className="rounded-md border border-ink-700 p-2">
            <Toggle label="Grid across the spread" checked={(book.grid.spreadColumns ?? 0) > 0} onChange={(v) => set((d) => {
              d.grid.spreadColumns = v ? Math.max(2, d.grid.columns * 2) : 0;
              if (v && d.grid.spreadGutter == null) d.grid.spreadGutter = d.grid.gutter;
            })} hint="One column system from outer margin to outer margin, so pictures and headings can run across the fold" />
            {(book.grid.spreadColumns ?? 0) > 0 && (
              <>
                <Row className="mt-1.5">
                  <NumberField label="Spread columns" value={book.grid.spreadColumns ?? 0} min={1} max={48} decimals={0} onChange={(v) => set((d) => { d.grid.spreadColumns = Math.max(1, Math.round(v)); })} />
                  <NumberField label="Gutter" length value={book.grid.spreadGutter ?? book.grid.gutter} min={0} onChange={(v) => set((d) => { d.grid.spreadGutter = v; })} />
                </Row>
                <Hint>{(book.grid.spreadColumns ?? 0) % 2 === 0 ? 'Even: the middle gutter sits on the fold, so no column is cut by the binding.' : 'Odd: the middle column runs across the fold. Keep text out of it; use it for pictures.'} Rows, baselines and margins stay per page.</Hint>
              </>
            )}
          </div>
        )}
        <Button className="w-full" onClick={() => {
          const patch = lockGridToBaseline(s().project.book);
          set((d) => { if (patch.margins) d.margins = patch.margins; if (patch.grid) d.grid = patch.grid; });
          s().notify('Fields now land on whole baselines with a one-line gutter (Müller-Brockmann).');
        }}>Lock fields to baseline grid</Button>
        <div className="grid grid-cols-2 gap-y-1.5">
          <Toggle label="Columns & fields" checked={book.grid.showGrid} onChange={(v) => set((d) => { d.grid.showGrid = v; })} />
          <Toggle label="Baselines" checked={book.grid.showBaseline} onChange={(v) => set((d) => { d.grid.showBaseline = v; })} />
          <Toggle label="Margins" checked={book.grid.showMargins} onChange={(v) => set((d) => { d.grid.showMargins = v; })} />
          <Toggle label="Bleed" checked={book.grid.showBleed} onChange={(v) => set((d) => { d.grid.showBleed = v; })} />
          <Toggle label="Snap to grid" checked={book.grid.snap} onChange={(v) => set((d) => { d.grid.snap = v; })} />
          <Toggle label="Snap to baselines" checked={book.grid.snapToBaseline} onChange={(v) => set((d) => { d.grid.snapToBaseline = v; })} />
          <Toggle label="Spacing check" checked={!!book.grid.showSpacing} onChange={(v) => set((d) => { d.grid.showSpacing = v; })} hint="Hochuli: tint loose (red) and tight (blue) lines, tick hyphens, flag ladders of 3+" />
          <Toggle label="Hidden characters" checked={!!book.grid.showInvisibles} onChange={(v) => set((d) => { d.grid.showInvisibles = v; })} hint="Spaces ·, non-breaking spaces °, paragraph returns ¶ and forced line breaks ¬ on the canvas (⌥⌘I)" />
        </div>
      </Section>

      <GuidesSection />

      <Section title="Paper" id="doc-paper" defaultOpen={false}>
        <ColorField label="Default paper colour" value={book.paper.color} onChange={(v) => v && s().update((d) => {
          const old = d.book.paper.color;
          d.book.paper.color = v;
          for (const p of d.pages) if (p.paperColor === old) p.paperColor = v;
        })} />
        <Hint>Grammage, bulk and grain live in the Binding tab, where they drive the spine.</Hint>
      </Section>

      <Section title={`Swatches · ${swatches.length}`} id="doc-swatches" defaultOpen={false} right={
        <button type="button" title="Add swatch" className="rounded p-1 text-ink-400 hover:bg-ink-700" onClick={() => s().update((d) => { d.swatches.push({ id: uid('sw'), name: 'New swatch', hex: '#808080', cmyk: rgbToCmyk('#808080') }); })}><Plus size={13} /></button>
      }>
        {swatches.map((sw, i) => <SwatchRow key={sw.id} sw={sw} index={i} />)}
        <Hint>Colours that match a swatch are written to the PDF with that exact CMYK build (CMYK preservation).</Hint>
      </Section>
    </div>
  );
}

function SwatchRow({ sw, index }: { sw: Swatch; index: number }) {
  const s = useStore.getState;
  const set = (fn: (d: Draft<Swatch>) => void) => s().update((d) => { fn(d.swatches[index]); });
  const c = sw.cmyk ?? rgbToCmyk(sw.hex);
  const setC = (k: 'c' | 'm' | 'y' | 'k', v: number) => set((d) => {
    const next = { ...c, [k]: Math.max(0, Math.min(100, v)) };
    d.cmyk = next;
    d.hex = cmykToHex(next);
  });
  return (
    <div className="rounded-md border border-ink-700 p-1.5">
      <div className="flex items-center gap-1.5">
        <input type="color" className="h-6 w-7 shrink-0 cursor-pointer" value={sw.hex} onChange={(e) => set((d) => { d.hex = e.target.value; d.cmyk = rgbToCmyk(e.target.value); })} />
        <input className="min-w-0 flex-1 bg-transparent text-[11.5px] text-ink-200 outline-none" value={sw.name} onChange={(e) => set((d) => { d.name = e.target.value; })} />
        <button type="button" className="rounded p-1 text-ink-500 hover:text-[#f08a73]" title="Delete swatch" onClick={() => s().update((d) => { d.swatches.splice(index, 1); })}><Trash size={11} /></button>
      </div>
      <div className="mt-1 grid grid-cols-4 gap-1">
        {(['c', 'm', 'y', 'k'] as const).map((k) => (
          <label key={k} className="flex items-center gap-1 rounded border border-ink-700 bg-ink-900 px-1 text-[10px] text-ink-400">
            {k.toUpperCase()}
            <input className="w-full min-w-0 bg-transparent text-right text-[10.5px] tabular-nums text-ink-200 outline-none" value={Math.round(c[k])} onChange={(e) => { const v = parseFloat(e.target.value); if (Number.isFinite(v)) setC(k, v); }} />
          </label>
        ))}
      </div>
    </div>
  );
}

export { fromPt };

/** Conditional text: every {if:Name} condition in the book, each shown or hidden for the whole book. */
function ConditionsSection() {
  const project = useStore((s) => s.project);
  const names = React.useMemo(() => conditionNames(project), [project]);
  const hidden = new Set((project.hiddenConditions ?? []).map((h) => h.toLowerCase()));
  const toggle = (name: string, show: boolean) => useStore.getState().update((d) => {
    const list = (d.hiddenConditions ?? []).filter((h) => h.toLowerCase() !== name.toLowerCase());
    if (!show) list.push(name);
    d.hiddenConditions = list;
  });
  return (
    <Section title={`Conditional text${names.length ? ` · ${names.length}` : ''}`} id="doc-conditions" defaultOpen={false}>
      {names.length ? names.map((n) => (
        <Toggle key={n} label={n} checked={!hidden.has(n.toLowerCase())} onChange={(v) => toggle(n, v)} hint={`Text inside {if:${n}}…{/if} prints only while this is on`} />
      )) : null}
      <Hint>Wrap text in {'{if:Print}'}…{'{/if}'} (any name; nests, may span paragraphs) to make editions from one story: hide a condition and its text drops out everywhere, re-flowing the book.</Hint>
    </Section>
  );
}

/** Check spelling across every story; change, learn or find each unknown word. */
function SpellingSection() {
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<{ results: Misspelling[]; skipped: number; words: number } | null>(null);
  const run = async () => {
    setBusy(true);
    try { setRes(await checkSpelling(useStore.getState().project)); } finally { setBusy(false); }
  };
  const learn = (w: string) => { useStore.getState().update((d) => { d.spellingDictionary = [...new Set([...(d.spellingDictionary ?? []), w])]; }); setRes((r) => r && { ...r, results: r.results.filter((x) => x.word !== w) }); };
  const ignore = (w: string) => setRes((r) => r && { ...r, results: r.results.filter((x) => x.word !== w) });
  const change = (m: Misspelling, to: string) => {
    // Replace from the last occurrence back, so earlier indices stay valid.
    const byEl = new Map<string, number[]>();
    for (const w of m.where) byEl.set(w.elementId, [...(byEl.get(w.elementId) ?? []), w.index]);
    const s = useStore.getState();
    s.update((d) => {
      const visit = (els: Element[]) => {
        for (const e of els) {
          const idx = e.type === 'text' ? byEl.get(e.id) : undefined;
          if (!idx || e.type !== 'text') continue;
          let t = e.text;
          for (const i of [...idx].sort((a, b) => b - a)) if (t.slice(i, i + m.word.length) === m.word) t = t.slice(0, i) + to + t.slice(i + m.word.length);
          e.text = t;
        }
      };
      for (const p of d.pages) visit(p.elements as Element[]);
      for (const ms of d.masters) { visit(ms.left as Element[]); visit(ms.right as Element[]); }
      visit(d.cover.elements as Element[]);
      visit((d.jacket?.elements ?? []) as Element[]);
    });
    setRes((r) => r && { ...r, results: r.results.filter((x) => x !== m) });
  };
  const find = (m: Misspelling) => {
    const w = m.where[0];
    revealStory(w.elementId);
    setTimeout(() => window.dispatchEvent(new CustomEvent('bds:select', { detail: { start: w.index, end: w.index + m.word.length } })), 120);
  };
  return (
    <Section title={`Spelling${res ? ` · ${res.results.length}` : ''}`} id="doc-spelling" defaultOpen={false}>
      <Button className="w-full" disabled={busy} onClick={() => void run()}>{busy ? 'Checking…' : res ? 'Check again' : 'Check spelling in every story'}</Button>
      {res && (
        <Hint>{res.words.toLocaleString()} words checked{res.skipped ? `; ${res.skipped} stor${res.skipped === 1 ? 'y' : 'ies'} in languages without a dictionary skipped` : ''}. {res.results.length ? 'Unknown words, most frequent first:' : 'No unknown words.'}</Hint>
      )}
      {res?.results.slice(0, 120).map((m) => (
        <div key={m.word} className="rounded border border-ink-700 p-1.5 text-[11px]">
          <div className="flex items-center gap-1.5">
            <button type="button" className="font-medium text-[#f08a73] underline decoration-dotted" title="Show it in the story" onClick={() => find(m)}>{m.word}</button>
            <span className="text-ink-500">×{m.count}</span>
            <span className="flex-1" />
            <button type="button" className="text-[10px] text-ink-400 hover:text-ink-100" onClick={() => learn(m.word)} title="Add to the book's dictionary">Learn</button>
            <button type="button" className="text-[10px] text-ink-400 hover:text-ink-100" onClick={() => ignore(m.word)}>Ignore</button>
          </div>
          {m.suggestions.length > 0 && (
            <div className="mt-1 flex flex-wrap gap-1">
              {m.suggestions.map((sg) => (
                <button key={sg} type="button" title={`Change every “${m.word}” to “${sg}”`} className="rounded border border-ink-600 px-1 text-[10px] text-ink-200 hover:border-ink-400" onClick={() => change(m, sg)}>{sg}</button>
              ))}
            </div>
          )}
        </div>
      ))}
      <Hint>English (US and UK) dictionaries from SCOWL; a story's language is its Type › Language. The story editor also underlines unknown words as you type.</Hint>
      <AutocorrectList />
    </Section>
  );
}

/** The autocorrect list (used by the story editor when Smart typing is on). */
function AutocorrectList() {
  const list = useStore((st) => st.project.autocorrect) ?? [];
  const [draft, setDraft] = useState<string | null>(null);
  const text = draft ?? list.map((a) => `${a.from} → ${a.to}`).join('\n');
  return (
    <div className="space-y-1">
      <TextInput label="Autocorrect (one per line: teh → the)" multiline rows={4} mono value={text} onChange={setDraft} />
      {draft != null && (
        <Button className="w-full" onClick={() => {
          const pairs = draft.split('\n').map((l) => l.split(/\s*(?:→|->|=>|\t)\s*/)).filter((p) => p.length === 2 && p[0].trim() && p[1].trim()).map(([from, to]) => ({ from: from.trim(), to: to.trim() }));
          useStore.getState().update((d) => { d.autocorrect = pairs; });
          setDraft(null);
        }}>Save autocorrect list</Button>
      )}
    </div>
  );
}

import React, { useEffect, useState } from 'react';
import clsx from 'clsx';
import { X, FileDown, Film, Image as ImageIcon, Save, FolderOpen } from 'lucide-react';
import { useStore } from '../store/store';
import { exportPdf, DEFAULT_PDF_OPTIONS, type PdfOptions } from '../export/pdf';
import { exportSvg, exportPng, type SvgExportOptions } from '../export/svg';
import { downloadBlob, saveProjectFile, loadProjectFile, safeName } from './projectIO';
import { Button, Toggle, Select, Segmented, NumberField, Hint, Row } from './controls';
import { spreadsOf } from '../model/surfaces';
import { computeBinding } from '../engine/binding';
import { ptToMm } from '../model/units';

type Tab = 'pdf' | 'svg' | 'video' | 'project';

export default function ExportDialog() {
  const [tab, setTab] = useState<Tab>('pdf');
  const close = () => useStore.getState().setExportOpen(false);
  // Esc closes the dialog (as the close button), wherever the focus is inside it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/55 p-4 backdrop-blur-sm" onPointerDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className="flex max-h-[92vh] w-full max-w-[640px] flex-col overflow-hidden rounded-xl border border-ink-600 bg-ink-850 shadow-2xl">
        <header className="flex items-center gap-3 border-b border-ink-700 px-4 py-3">
          <h2 className="font-serif text-[18px] text-ink-100" style={{ fontFamily: '"BDS EB Garamond", Georgia, serif' }}>Export</h2>
          <div className="ml-2 flex gap-1">
            {([['pdf', 'Print PDF', <FileDown key="a" size={13} />], ['svg', 'SVG · PNG', <ImageIcon key="b" size={13} />], ['video', 'Video', <Film key="c" size={13} />], ['project', 'Project', <Save key="d" size={13} />]] as const).map(([id, label, icon]) => (
              <button key={id} type="button" title={label} onClick={() => setTab(id)} className={clsx('flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[12px]', tab === id ? 'bg-ink-600 text-ink-100' : 'text-ink-400 hover:text-ink-100')}>{icon}<span className="hidden sm:inline">{label}</span></button>
            ))}
          </div>
          <button type="button" title="Close" onClick={close} className="ml-auto rounded p-1 text-ink-400 hover:bg-ink-700 hover:text-ink-100"><X size={16} /></button>
        </header>
        <div className="scroll-thin min-h-0 flex-1 overflow-y-auto p-4">
          {tab === 'pdf' && <PdfTab />}
          {tab === 'svg' && <SvgTab />}
          {tab === 'video' && <VideoTab />}
          {tab === 'project' && <ProjectTab />}
        </div>
      </div>
    </div>
  );
}

function PdfTab() {
  const project = useStore((s) => s.project);
  const spread = useStore((s) => s.spread);
  const [o, setO] = useState<PdfOptions>({ ...DEFAULT_PDF_OPTIONS, from: 1, to: project.pages.length });
  const [busy, setBusy] = useState<{ p: number; label: string } | null>(null);
  const set = (p: Partial<PdfOptions>) => setO({ ...o, ...p });
  const calc = computeBinding(project.book);
  const run = async () => {
    setBusy({ p: 0, label: 'Preparing' });
    try {
      const bytes = await exportPdf(project, { ...o, spreadIndex: spread, onProgress: (p, label) => setBusy({ p, label }) });
      const suffix = o.scope === 'cover' ? 'cover' : o.scope === 'jacket' ? 'jacket' : o.scope === 'spread' ? `spread-${spread}` : 'interior';
      downloadBlob(new Blob([bytes.slice().buffer as ArrayBuffer], { type: 'application/pdf' }), `${safeName(project.book.title)}-${suffix}.pdf`);
      useStore.getState().notify('PDF exported.');
    } catch (e) {
      useStore.getState().notify(`PDF export failed: ${(e as Error).message}`, 'error');
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="space-y-3">
      <Segmented value={o.scope} onChange={(v) => set({ scope: v })} options={[{ value: 'interior', label: 'Interior' }, { value: 'cover', label: 'Cover / case' }, { value: 'jacket', label: 'Dust jacket' }, { value: 'spread', label: 'Spread' }]} />
      {o.scope === 'jacket' && !project.book.jacket?.enabled && <Hint>This book has no dust jacket yet — add one in the Jacket view.</Hint>}
      {o.scope === 'interior' && (
        <Row>
          <NumberField label="From page" value={o.from ?? 1} min={1} max={project.pages.length} decimals={0} onChange={(v) => set({ from: Math.round(v) })} />
          <NumberField label="To page" value={o.to ?? project.pages.length} min={1} max={project.pages.length} decimals={0} onChange={(v) => set({ to: Math.round(v) })} />
        </Row>
      )}
      {o.scope === 'interior' && <Segmented value={o.spreads ? 'spreads' : 'pages'} onChange={(v) => set({ spreads: v === 'spreads' })} options={[{ value: 'pages', label: 'Single pages (for print)' }, { value: 'spreads', label: 'Reader spreads (proof)' }]} />}
      {o.scope === 'cover' && (
        <Hint>
          Flat {calc.type === 'case' ? 'case wrap' : 'cover'} {ptToMm(calc.coverW + 2 * calc.wrap).toFixed(1)} × {ptToMm(calc.coverH + 2 * calc.wrap).toFixed(1)} mm including {calc.type === 'case' ? 'turn-ins' : 'bleed'}; spine {ptToMm(calc.spine).toFixed(2)} mm; fold and score marks in the slug.
        </Hint>
      )}
      <div className="grid grid-cols-2 gap-x-4 gap-y-2 rounded-lg border border-ink-700 p-3">
        <Toggle label="Bleed" checked={o.bleed} onChange={(v) => set({ bleed: v })} />
        <Toggle label="Crop marks" checked={o.cropMarks} onChange={(v) => set({ cropMarks: v })} />
        <Toggle label="Bleed marks" checked={o.bleedMarks} onChange={(v) => set({ bleedMarks: v })} />
        <Toggle label="Registration marks" checked={o.registration} onChange={(v) => set({ registration: v })} />
        <Toggle label="Colour bars" checked={o.colorBars} onChange={(v) => set({ colorBars: v })} />
        <Toggle label="Page information" checked={o.pageInfo} onChange={(v) => set({ pageInfo: v })} />
        <Toggle label="Die lines (CutContour spot)" checked={o.dieLines} onChange={(v) => set({ dieLines: v })} />
        <Toggle label="Foil / deboss on spot plates" checked={o.finishSpots} onChange={(v) => set({ finishSpots: v })} />
        <Toggle label="Print paper colour" checked={o.paperColor} onChange={(v) => set({ paperColor: v })} hint="For proofs on white stock; leave off when printing on coloured paper" />
      </div>
      <Row>
        <Select label="Colour" value={o.colorMode} options={[{ value: 'cmyk', label: 'CMYK (swatch builds preserved)' }, { value: 'rgb', label: 'RGB (screen)' }]} onChange={(v) => set({ colorMode: v })} />
        <Select label="Text" value={o.textMode} options={[{ value: 'auto', label: 'Embed + subset static fonts' }, { value: 'outline', label: 'Convert all to outlines' }]} onChange={(v) => set({ textMode: v })} />
      </Row>
      <Select label="Raster resolution (brushes, grain, blur)" value={String(o.rasterDpi)} options={[{ value: '150', label: '150 dpi — proof' }, { value: '300', label: '300 dpi — offset' }, { value: '450', label: '450 dpi' }, { value: '600', label: '600 dpi — fine art' }]} onChange={(v) => set({ rasterDpi: Number(v) })} />
      <Hint>Vector everywhere it can be: paths, rules, generators, SVG and text. Variable-font instances are written as exact glyph outlines (PDF has no variable fonts); static fonts are embedded and subset. Gradients become PDF shadings.</Hint>
      <div className="flex items-center gap-3 pt-1">
        <Button variant="primary" disabled={!!busy} onClick={run}><FileDown size={14} /> Export PDF</Button>
        {busy && (
          <div className="flex flex-1 items-center gap-2 text-[11px] text-ink-300">
            <div className="h-1.5 flex-1 overflow-hidden rounded bg-ink-700"><div className="h-full bg-rubric transition-[width]" style={{ width: `${Math.round(busy.p * 100)}%` }} /></div>
            {busy.label}
          </div>
        )}
      </div>
    </div>
  );
}

function SvgTab() {
  const project = useStore((s) => s.project);
  const spread = useStore((s) => s.spread);
  const selection = useStore((s) => s.selection);
  const sp = spreadsOf(project)[spread];
  const [o, setO] = useState<SvgExportOptions & { dpi: number }>({ target: 'spread', spreadIndex: spread, pageIndex: sp?.right ?? sp?.left ?? 0, outlineText: true, includeBleed: false, rasterScale: 3, dpi: 300 });
  const [busy, setBusy] = useState(false);
  const set = (p: Partial<typeof o>) => setO({ ...o, ...p });
  const go = async (kind: 'svg' | 'png') => {
    setBusy(true);
    try {
      const opts = { ...o, spreadIndex: spread, selectionId: selection[0] };
      const { blob, name } = kind === 'svg' ? await exportSvg(project, opts) : await exportPng(project, opts);
      downloadBlob(blob, `${safeName(project.book.title)}-${name}`);
    } catch (e) {
      useStore.getState().notify(`Export failed: ${(e as Error).message}`, 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-3">
      <Segmented value={o.target} onChange={(v) => set({ target: v })} options={[
        { value: 'spread', label: 'Spread' }, { value: 'page', label: 'Page' }, { value: 'cover', label: 'Cover' }, { value: 'jacket', label: 'Jacket' }, { value: 'selection', label: 'Selection' },
      ]} />
      {o.target === 'page' && <NumberField label="Page" value={o.pageIndex + 1} min={1} max={project.pages.length} decimals={0} onChange={(v) => set({ pageIndex: Math.round(v) - 1 })} />}
      {o.target === 'selection' && !selection.length && <Hint>Select an item first.</Hint>}
      <div className="grid grid-cols-2 gap-2">
        <Toggle label="Text to outlines" checked={o.outlineText} onChange={(v) => set({ outlineText: v })} hint="Exact rendering without the fonts installed" />
        <Toggle label="Include bleed" checked={o.includeBleed} onChange={(v) => set({ includeBleed: v })} />
      </div>
      <Row>
        <Select label="Raster detail in SVG" value={String(o.rasterScale)} options={[{ value: '2', label: '144 dpi' }, { value: '3', label: '216 dpi' }, { value: '4.1667', label: '300 dpi' }]} onChange={(v) => set({ rasterScale: Number(v) })} />
        <Select label="PNG resolution" value={String(o.dpi)} options={[{ value: '96', label: '96 dpi — screen' }, { value: '150', label: '150 dpi' }, { value: '300', label: '300 dpi' }, { value: '600', label: '600 dpi' }]} onChange={(v) => set({ dpi: Number(v) })} />
      </Row>
      <div className="flex gap-2">
        <Button variant="primary" disabled={busy} onClick={() => go('svg')}>Export SVG</Button>
        <Button disabled={busy} onClick={() => go('png')}>Export PNG</Button>
      </div>
    </div>
  );
}

function VideoTab() {
  return (
    <div className="space-y-3 text-[12px] text-ink-300">
      <p>Motion is rendered from the real-time 3D book: a 360° orbit, the cover opening, pages turning, or a full showcase sequence — frame-exact, encoded in the browser.</p>
      <ul className="list-disc space-y-1 pl-5 text-[11.5px] text-ink-400">
        <li><span className="text-ink-200">MP4</span> — H.264 via WebCodecs (Chrome, Edge, Safari; MediaRecorder fallback)</li>
        <li><span className="text-ink-200">WebM</span> — VP9/VP8 via WebCodecs or MediaRecorder</li>
        <li><span className="text-ink-200">GIF</span> — palette-quantised, everywhere</li>
      </ul>
      <Button variant="primary" onClick={() => { useStore.getState().setExportOpen(false); useStore.getState().setView('3d'); }}><Film size={14} /> Open the 3D view to render video</Button>
    </div>
  );
}

function ProjectTab() {
  const project = useStore((s) => s.project);
  return (
    <div className="space-y-3">
      <p className="text-[12px] text-ink-300">A project file contains every page, master, the cover, swatches, placed images and uploaded fonts — open it on any machine.</p>
      <div className="flex gap-2">
        <Button variant="primary" onClick={() => saveProjectFile(project)}><Save size={14} /> Save .bds.json</Button>
        <label className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-[5px] border border-ink-600 bg-ink-750 px-2.5 text-[11.5px] font-medium text-ink-100 hover:bg-ink-700">
          <FolderOpen size={14} /> Open…
          <input type="file" accept=".json,application/json" className="hidden" onChange={async (e) => {
            const f = e.target.files?.[0];
            if (!f) return;
            try { await loadProjectFile(f); useStore.getState().notify(`Opened ${f.name}`); useStore.getState().setExportOpen(false); } catch (err) { useStore.getState().notify((err as Error).message, 'error'); }
          }} />
        </label>
      </div>
      <Hint>Your work also autosaves in this browser (IndexedDB). Clearing site data removes it, so keep project files for anything important.</Hint>
    </div>
  );
}

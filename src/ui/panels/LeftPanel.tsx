import React, { useDeferredValue, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import { Plus, Trash, Copy, MoreHorizontal, Eye, EyeOff, Lock, LockOpen, ChevronUp, ChevronDown, FileText, Upload, Image as ImageIcon } from 'lucide-react';
import { useStore, type LeftTab } from '../../store/store';
import { spreadsOf, pageKey, masterKey, surfaceElements } from '../../model/surfaces';
import { compilePage, placedElement } from '../../render/compile';
import { primsToSvg } from '../../render/svgString';
import { useFontStore } from '../../engine/fonts';
import type { Element, PaperMaterial, Project } from '../../model/types';
import { insertPages, deletePage, duplicatePage, movePage, addMaster, deleteMaster, autoFlow } from '../../model/pageOps';
import { Button, Select, TextInput, Toggle, Hint } from '../controls';
import { PresetsPanel } from './PresetsPanel';
import { LibraryPanel } from '../library/LibraryPanel';
import { importFiles } from '../importFiles';
import { makeImage, makeSvg } from '../../model/factory';
import { textBlock } from '../../engine/grid';
import { SAMPLE_ESSAY } from '../../model/defaults';

const TABS: { id: LeftTab; label: string }[] = [
  { id: 'pages', label: 'Pages' },
  { id: 'layers', label: 'Layers' },
  { id: 'library', label: 'Library' },
  { id: 'presets', label: 'Presets' },
  { id: 'assets', label: 'Assets' },
];

export function LeftPanel() {
  const tab = useStore((s) => s.leftTab);
  return (
    <aside className="flex w-[248px] shrink-0 flex-col border-r border-ink-700 bg-ink-850">
      <div className="flex h-9 shrink-0 items-end gap-0.5 border-b border-ink-700 px-2">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => useStore.getState().setLeftTab(t.id)}
            className={clsx('h-8 rounded-t px-2 text-[11.5px]', tab === t.id ? 'border-x border-t border-ink-700 bg-ink-800 text-ink-100' : 'text-ink-400 hover:text-ink-200')}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        {tab === 'pages' && <PagesPanel />}
        {tab === 'layers' && <LayersPanel />}
        {tab === 'library' && <LibraryPanel />}
        {tab === 'presets' && <PresetsPanel />}
        {tab === 'assets' && <AssetsPanel />}
      </div>
    </aside>
  );
}

/* -------------------------------------------------------------------------- */
/* Thumbnails                                                                  */
/* -------------------------------------------------------------------------- */

export function PageThumb({ project, index, width }: { project: Project; index: number; width: number }) {
  const version = useFontStore((s) => s.version);
  const html = useMemo(() => {
    try {
      return primsToSvg(compilePage(project, index, { dieLines: false }), { pxPerPt: 0.35, idPrefix: `t${index}x`, hideDieLines: true });
    } catch {
      return '';
    }
  }, [project, index, version]);
  const W = project.book.trimW, H = project.book.trimH;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width={width} height={(width * H) / W} className="block" dangerouslySetInnerHTML={{ __html: html }} />
  );
}

function MasterThumb({ project, id, side, width }: { project: Project; id: string; side: 'left' | 'right'; width: number }) {
  const version = useFontStore((s) => s.version);
  const html = useMemo(() => {
    const els = surfaceElements(project, masterKey(id, side));
    const ctx = { project, surface: masterKey(id, side), pageIndex: null, side } as const;
    return primsToSvg(els.map((e) => placedElement(e, ctx)), { pxPerPt: 0.35, idPrefix: `m${id}${side}x` });
  }, [project, id, side, version]);
  const W = project.book.trimW, H = project.book.trimH;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width={width} height={(width * H) / W} className="block bg-paper" dangerouslySetInnerHTML={{ __html: html }} />
  );
}

/* -------------------------------------------------------------------------- */
/* Pages                                                                       */
/* -------------------------------------------------------------------------- */

function PagesPanel() {
  const live = useStore((s) => s.project);
  const project = useDeferredValue(live);
  const spread = useStore((s) => s.spread);
  const masterEdit = useStore((s) => s.masterEdit);
  const view = useStore((s) => s.view);
  const spreads = spreadsOf(project);
  const [menu, setMenu] = useState<number | null>(null);
  const [flowOpen, setFlowOpen] = useState(false);
  const thumbW = 84;
  const s = useStore.getState;

  return (
    <div className="p-2">
      <div className="mb-1 flex items-center justify-between px-1">
        <span className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-ink-400">Masters</span>
        <button type="button" title="New master" className="rounded p-1 text-ink-400 hover:bg-ink-700 hover:text-ink-100" onClick={addMaster}><Plus size={13} /></button>
      </div>
      <div className="mb-3 space-y-1">
        {project.masters.map((m) => (
          <div key={m.id} className={clsx('group flex items-center gap-2 rounded-md p-1.5', masterEdit?.id === m.id ? 'bg-[#3b2f52]' : 'hover:bg-ink-750')}>
            <button type="button" className="flex shrink-0 gap-px shadow" onClick={() => s().setMasterEdit({ id: m.id })} title="Edit master">
              <MasterThumb project={project} id={m.id} side="left" width={26} />
              <MasterThumb project={project} id={m.id} side="right" width={26} />
            </button>
            <input
              className="min-w-0 flex-1 bg-transparent text-[11.5px] text-ink-200 outline-none"
              value={m.name}
              onChange={(e) => s().update((d) => { const x = d.masters.find((q) => q.id === m.id); if (x) x.name = e.target.value; }, { history: false })}
            />
            <button type="button" title="Delete master" className="invisible rounded p-1 text-ink-400 hover:text-[#f08a73] group-hover:visible" onClick={() => deleteMaster(m.id)}><Trash size={12} /></button>
          </div>
        ))}
        {masterEdit && (
          <Button variant="ghost" className="w-full" onClick={() => s().setMasterEdit(null)}>Back to pages</Button>
        )}
      </div>

      <div className="mb-1 flex items-center justify-between px-1">
        <span className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-ink-400">Spreads · {project.pages.length} pp</span>
        <div className="flex gap-0.5">
          <button type="button" title="Flow a long text into new pages" className="rounded p-1 text-ink-400 hover:bg-ink-700 hover:text-ink-100" onClick={() => setFlowOpen(!flowOpen)}><FileText size={13} /></button>
          <button type="button" title="Add spread at the end" className="rounded p-1 text-ink-400 hover:bg-ink-700 hover:text-ink-100" onClick={() => { insertPages(project.pages.length - 1, 2, project.masters[0]?.id ?? null); }}><Plus size={13} /></button>
        </div>
      </div>
      {flowOpen && <FlowText onDone={() => setFlowOpen(false)} />}
      <div className="space-y-2">
        {spreads.map((sp, si) => {
          const active = si === spread && !masterEdit && view === 'spreads';
          return (
            <div key={si} className={clsx('rounded-md p-1.5', active ? 'bg-ink-700/80 ring-1 ring-rubric/70' : 'hover:bg-ink-750')}>
              <div className="flex justify-center">
                {[sp.left, sp.right].map((pi, k) => (
                  <div key={k} className="relative" style={{ width: thumbW }}>
                    {pi != null ? (
                      <button type="button" className="block w-full shadow-[0_1px_3px_rgba(0,0,0,0.5)]" onClick={() => { s().setView('spreads'); s().setSpread(si); }} title={`Page ${pi + 1}`}>
                        <PageThumb project={project} index={pi} width={thumbW} />
                      </button>
                    ) : <div />}
                  </div>
                ))}
              </div>
              <div className="mt-1 flex items-center justify-center gap-3 text-[10px] tabular-nums text-ink-400">
                {[sp.left, sp.right].map((pi, k) => pi != null && (
                  <div key={k} className="relative flex items-center gap-1">
                    <span>{pi + 1}{project.pages[pi].masterId ? ` ${project.masters.find((m) => m.id === project.pages[pi].masterId)?.name.slice(0, 1) ?? ''}` : ''}</span>
                    {project.pages[pi].material !== 'paper' && <span className="text-gold">{project.pages[pi].material}</span>}
                    <button type="button" className="rounded p-0.5 hover:bg-ink-600" onClick={() => setMenu(menu === pi ? null : pi)} title="Page options"><MoreHorizontal size={11} /></button>
                    {menu === pi && <PageMenu index={pi} onClose={() => setMenu(null)} />}
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function PageMenu({ index, onClose }: { index: number; onClose: () => void }) {
  const project = useStore((s) => s.project);
  const page = project.pages[index];
  const s = useStore.getState;
  const set = (fn: (p: Project['pages'][number]) => void) => s().update((d) => { fn(d.pages[index] as Project['pages'][number]); });
  return (
    <div className="absolute left-1/2 top-full z-40 mt-1 w-56 -translate-x-1/2 space-y-2 rounded-md border border-ink-600 bg-ink-800 p-2 text-left shadow-2xl" onPointerDown={(e) => e.stopPropagation()}>
      <TextInput label="Label" value={page.label ?? ''} onChange={(v) => set((p) => { p.label = v; })} />
      <Select label="Master" value={page.masterId ?? ''} options={[{ value: '', label: 'None' }, ...project.masters.map((m) => ({ value: m.id, label: m.name }))]} onChange={(v) => set((p) => { p.masterId = v || null; })} />
      <Select<PaperMaterial> label="Material (Munari)" value={page.material} options={[{ value: 'paper', label: 'Paper' }, { value: 'vellum', label: 'Vellum / tracing paper' }, { value: 'colored', label: 'Coloured stock' }, { value: 'kraft', label: 'Kraft' }]} onChange={(v) => set((p) => {
        p.material = v;
        if (v === 'kraft') p.paperColor = '#b48a5c';
        if (v === 'colored' && p.paperColor === project.book.paper.color) p.paperColor = '#c8372a';
        if (v === 'paper') p.paperColor = project.book.paper.color;
      })} />
      <div className="grid grid-cols-2 gap-2">
        <label className="text-[10.5px] text-ink-400">Paper
          <input type="color" className="mt-0.5 block h-7 w-full" value={page.paperColor} onChange={(e) => set((p) => { p.paperColor = e.target.value; })} />
        </label>
        {page.material === 'vellum' && (
          <label className="text-[10.5px] text-ink-400">Translucency
            <input type="range" min={0} max={1} step={0.01} className="w-full" value={page.vellumOpacity} onChange={(e) => set((p) => { p.vellumOpacity = parseFloat(e.target.value); })} />
          </label>
        )}
      </div>
      <div className="grid grid-cols-2 gap-1">
        <Button onClick={() => { insertPages(index, 2, page.masterId); onClose(); }}><Plus size={12} /> 2 pages after</Button>
        <Button onClick={() => { duplicatePage(index); onClose(); }}><Copy size={12} /> Duplicate</Button>
        <Button onClick={() => { movePage(index, -1); onClose(); }}><ChevronUp size={12} /> Earlier</Button>
        <Button onClick={() => { movePage(index, 1); onClose(); }}><ChevronDown size={12} /> Later</Button>
      </div>
      <div className="flex gap-1">
        <Button variant="danger" className="flex-1" onClick={() => { if (confirm(`Delete page ${index + 1}?`)) deletePage(index); onClose(); }}><Trash size={12} /> Delete</Button>
        <Button variant="ghost" onClick={onClose}>Close</Button>
      </div>
    </div>
  );
}

function FlowText({ onDone }: { onDone: () => void }) {
  const project = useStore((s) => s.project);
  const [text, setText] = useState('');
  const [master, setMaster] = useState(project.masters[0]?.id ?? '');
  const [recto, setRecto] = useState(true);
  return (
    <div className="mb-3 space-y-2 rounded-md border border-ink-700 bg-ink-800 p-2">
      <Hint>Paste a manuscript. It is set in threaded frames on the text block of as many new pages as it needs.</Hint>
      <TextInput multiline rows={6} value={text} onChange={setText} placeholder="Paste text — one paragraph per line, # for chapter headings" />
      <Button variant="ghost" className="w-full" onClick={() => setText(SAMPLE_ESSAY)}>Use the sample essay</Button>
      <Select label="Master" value={master} options={[{ value: '', label: 'None' }, ...project.masters.map((m) => ({ value: m.id, label: m.name }))]} onChange={setMaster} />
      <Toggle label="Start on a recto" checked={recto} onChange={setRecto} />
      <div className="flex gap-1">
        <Button variant="primary" className="flex-1" disabled={!text.trim()} onClick={() => {
          const n = autoFlow(text, { afterIndex: project.pages.length - 1, masterId: master || null, startRecto: recto });
          useStore.getState().notify(`Flowed into ${n} page${n === 1 ? '' : 's'}.`);
          onDone();
        }}>Flow text</Button>
        <Button variant="ghost" onClick={onDone}>Cancel</Button>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Layers                                                                      */
/* -------------------------------------------------------------------------- */

function currentSurfaces(project: Project, view: string, spread: number, masterId: string | null): { key: string; label: string }[] {
  if (view === 'cover') return [{ key: 'cover', label: 'Cover' }];
  if (masterId) {
    const m = project.masters.find((x) => x.id === masterId);
    return m ? [{ key: masterKey(m.id, 'right'), label: `${m.name} · right` }, { key: masterKey(m.id, 'left'), label: `${m.name} · left` }] : [];
  }
  const sp = spreadsOf(project)[spread];
  if (!sp) return [];
  return [sp.right, sp.left].filter((x): x is number => x != null).map((i) => ({ key: pageKey(project.pages[i].id), label: `Page ${i + 1}` }));
}

const TYPE_GLYPH: Record<Element['type'], string> = {
  text: 'T', image: '▣', shape: '■', rule: '—', path: '✎', svg: '◇', pattern: '◎', ornament: '❦', initial: 'Ꭿ', overprint: '◐', gradient: '◍', cutout: '◌', drawing: '✐', gridtype: '⌗', motif: '✦',
};

function LayersPanel() {
  const project = useStore((s) => s.project);
  const view = useStore((s) => s.view);
  const spread = useStore((s) => s.spread);
  const masterEdit = useStore((s) => s.masterEdit);
  const selection = useStore((s) => s.selection);
  const s = useStore.getState;
  const [drag, setDrag] = useState<{ key: string; index: number } | null>(null);
  const surfaces = currentSurfaces(project, view, spread, masterEdit?.id ?? null);

  return (
    <div className="p-2">
      {surfaces.map((sf) => {
        const els = surfaceElements(project, sf.key);
        return (
          <div key={sf.key} className="mb-3">
            <div className="mb-1 px-1 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-ink-400">{sf.label}</div>
            {els.length === 0 && <p className="px-1 text-[11px] text-ink-500">No items.</p>}
            {[...els].map((el, i) => ({ el, i })).reverse().map(({ el, i }) => (
              <div
                key={el.id}
                draggable
                onDragStart={() => setDrag({ key: sf.key, index: i })}
                onDragOver={(e) => e.preventDefault()}
                onDrop={() => {
                  if (!drag || drag.key !== sf.key) return;
                  s().update((d) => {
                    const arr = surfaceElementsDraftByKey(d as Project, sf.key);
                    if (!arr) return;
                    const [m] = arr.splice(drag.index, 1);
                    arr.splice(i, 0, m);
                  });
                  setDrag(null);
                }}
                onClick={(e) => {
                  const sel = e.shiftKey ? (selection.includes(el.id) ? selection.filter((x) => x !== el.id) : [...selection, el.id]) : [el.id];
                  s().select(sel);
                }}
                className={clsx('group flex h-7 cursor-default items-center gap-2 rounded px-1.5 text-[11.5px]', selection.includes(el.id) ? 'bg-rubric/25 text-ink-100' : 'text-ink-300 hover:bg-ink-750')}
              >
                <span className="w-4 text-center text-[11px] text-ink-400">{TYPE_GLYPH[el.type]}</span>
                <input
                  className="min-w-0 flex-1 bg-transparent outline-none"
                  value={el.name}
                  onChange={(e) => s().updateElement(el.id, { name: e.target.value }, { history: false })}
                  onClick={(e) => e.stopPropagation()}
                  onFocus={() => s().select([el.id])}
                />
                {el.finish && el.finish !== 'none' && <span className="text-[9px] text-gold">{el.finish.split('-')[0]}</span>}
                <button type="button" title={el.hidden ? 'Show' : 'Hide'} className={clsx('rounded p-0.5', el.hidden ? 'text-ink-500' : 'invisible text-ink-400 group-hover:visible')} onClick={(e) => { e.stopPropagation(); s().updateElement(el.id, { hidden: !el.hidden }); }}>
                  {el.hidden ? <EyeOff size={12} /> : <Eye size={12} />}
                </button>
                <button type="button" title={el.locked ? 'Unlock' : 'Lock'} className={clsx('rounded p-0.5', el.locked ? 'text-gold' : 'invisible text-ink-400 group-hover:visible')} onClick={(e) => { e.stopPropagation(); s().updateElement(el.id, { locked: !el.locked }); }}>
                  {el.locked ? <Lock size={12} /> : <LockOpen size={12} />}
                </button>
              </div>
            ))}
          </div>
        );
      })}
      <Hint>Drag rows to restack. Alt-click on the canvas selects the item beneath.</Hint>
    </div>
  );
}

function surfaceElementsDraftByKey(project: Project, key: string): Element[] | null {
  if (key === 'cover') return project.cover.elements;
  if (key.startsWith('page:')) return project.pages.find((p) => p.id === key.slice(5))?.elements ?? null;
  const [, id, side] = key.split(':');
  const m = project.masters.find((x) => x.id === id);
  return m ? (side === 'left' ? m.left : m.right) : null;
}

/* -------------------------------------------------------------------------- */
/* Assets                                                                      */
/* -------------------------------------------------------------------------- */

function AssetsPanel() {
  const project = useStore((s) => s.project);
  const assets = Object.values(project.assets);
  const input = useRef<HTMLInputElement>(null);
  const s = useStore.getState;
  const place = (id: string) => {
    const a = project.assets[id];
    const st = s();
    const surfaces = currentSurfaces(project, st.view, st.spread, st.masterEdit?.id ?? null);
    const key = surfaces[0]?.key;
    if (!key) return;
    const b = textBlock(project.book, 'right');
    const k = Math.min(1, b.w / a.width);
    const w = a.width * k, h = a.height * k;
    const el = a.kind === 'svg' ? makeSvg({ name: a.name, assetId: a.id, x: b.x, y: b.y, w, h }) : makeImage({ name: a.name, assetId: a.id, x: b.x, y: b.y, w, h, fit: 'fill' });
    st.addElement(key, el);
  };
  return (
    <div className="p-2">
      <Button className="mb-2 w-full" onClick={() => input.current?.click()}><Upload size={13} /> Upload images, SVG or fonts</Button>
      <input ref={input} type="file" multiple accept="image/*,.svg,.ttf,.otf,.woff,.woff2" className="hidden" onChange={async (e) => {
        const res = await importFiles(e.target.files ? [...e.target.files] : []);
        if (res.errors.length) s().notify(res.errors[0], 'error');
        else if (res.messages.length) s().notify(res.messages.join(' '));
        e.target.value = '';
      }} />
      {assets.length === 0 && <Hint>Drop images, SVG files or fonts anywhere on the canvas, or upload them here. Everything stays in your browser.</Hint>}
      <div className="grid grid-cols-2 gap-2">
        {assets.map((a) => (
          <div key={a.id} className="group relative overflow-hidden rounded-md border border-ink-700 bg-ink-900">
            <button type="button" className="block aspect-square w-full p-2" title={`Place ${a.name}`} onClick={() => place(a.id)}>
              <img src={a.src} alt={a.name} className="h-full w-full object-contain" />
            </button>
            <div className="flex items-center gap-1 border-t border-ink-700 px-1.5 py-1 text-[10px] text-ink-400">
              {a.kind === 'svg' ? 'SVG' : <ImageIcon size={10} />}
              <span className="min-w-0 flex-1 truncate">{a.name}</span>
              <button type="button" title="Remove asset" className="invisible hover:text-[#f08a73] group-hover:visible" onClick={() => s().update((d) => { delete d.assets[a.id]; })}><Trash size={11} /></button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

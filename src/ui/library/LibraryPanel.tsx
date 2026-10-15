import React, { useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import { Search } from 'lucide-react';
import { useStore } from '../../store/store';
import { DESIGNERS, type DesignerId } from '../../engine/motifs';
import { libraryItems, type LibraryItem } from './items';
import { currentTarget, insertItem, bounds } from './insert';
import { placedElement, type CompileContext } from '../../render/compile';
import { primsToSvg } from '../../render/svgString';
import { useFontStore } from '../../engine/fonts';
import { textBlock } from '../../engine/grid';
import type { Project } from '../../model/types';
import { Hint } from '../controls';

export const LIBRARY_MIME = 'application/x-bds-library';

/** Live thumbnail of a library item, rendered only once it scrolls into view. */
function Thumb({ item, project }: { item: LibraryItem; project: Project }) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const version = useFontStore((s) => s.version);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting)) { setVisible(true); io.disconnect(); } }, { rootMargin: '200px' });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  const els = useMemo(() => {
    if (!visible) return [];
    const spec = project.book;
    try {
      return item.make({ spec, W: spec.trimW, H: spec.trimH, side: 'right', onCover: false, block: textBlock(spec, 'right') });
    } catch {
      return [];
    }
  }, [visible, item, project.book]);
  const html = useMemo(() => {
    if (!els.length) return { svg: '', vb: '0 0 1 1' };
    const ctx: CompileContext = { project, surface: 'library', pageIndex: 4, side: 'right' };
    const b = bounds(els);
    const pad = Math.max(b.w, b.h) * 0.06 + 2;
    try {
      const svg = primsToSvg(els.map((e) => placedElement(e, ctx)), { pxPerPt: 0.6, idPrefix: `lib${item.id.replace(/[^a-z0-9]/gi, '')}`, hideDieLines: false });
      return { svg, vb: `${b.x - pad} ${b.y - pad} ${b.w + pad * 2} ${b.h + pad * 2}` };
    } catch {
      return { svg: '', vb: '0 0 1 1' };
    }
  }, [els, project, item.id, version]);
  return (
    <div ref={ref} className="flex aspect-square items-center justify-center overflow-hidden rounded-[4px] bg-paper p-1.5">
      {html.svg && <svg viewBox={html.vb} className="h-full w-full" preserveAspectRatio="xMidYMid meet" dangerouslySetInnerHTML={{ __html: html.svg }} />}
    </div>
  );
}

export function LibraryPanel() {
  const project = useStore((s) => s.project);
  const [query, setQuery] = useState('');
  const [designer, setDesigner] = useState<DesignerId | 'all'>('all');
  const items = useMemo(() => libraryItems(), []);
  const q = query.trim().toLowerCase();
  const filtered = items.filter((i) => (designer === 'all' || i.designer === designer) && (!q || `${i.label} ${i.note ?? ''} ${i.designer}`.toLowerCase().includes(q)));
  const groups = DESIGNERS.filter((d) => filtered.some((i) => i.designer === d.id));

  const insert = (item: LibraryItem) => {
    const p = useStore.getState().project;
    const target = currentTarget(p);
    if (!target) { useStore.getState().notify('Open a spread or the cover first.', 'error'); return; }
    insertItem(item, target);
  };

  return (
    <div className="p-2">
      <label className="mb-2 flex h-7 items-center gap-1.5 rounded-[5px] border border-ink-700 bg-ink-900 px-2 focus-within:border-ink-400">
        <Search size={12} className="text-ink-500" />
        <input className="w-full bg-transparent text-[11.5px] text-ink-100 outline-none" placeholder="Search elements…" value={query} onChange={(e) => setQuery(e.target.value)} />
      </label>
      <div className="mb-2 flex flex-wrap gap-1">
        <button type="button" onClick={() => setDesigner('all')} className={clsx('rounded-full border px-2 py-0.5 text-[10px]', designer === 'all' ? 'border-rubric bg-rubric/20 text-ink-100' : 'border-ink-700 text-ink-400 hover:text-ink-200')}>All</button>
        {DESIGNERS.filter((d) => items.some((i) => i.designer === d.id)).map((d) => (
          <button key={d.id} type="button" title={`${d.name} — ${d.note}`} onClick={() => setDesigner(d.id)} className={clsx('flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px]', designer === d.id ? 'border-rubric bg-rubric/20 text-ink-100' : 'border-ink-700 text-ink-400 hover:text-ink-200')}>
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: d.accent }} />
            {d.name.split(' ').slice(-1)[0]}
          </button>
        ))}
      </div>
      <Hint>Click to place on the current page (or the front cover); drag onto the canvas to place exactly.</Hint>
      {groups.map((d) => (
        <section key={d.id} className="mt-3">
          <header className="mb-1.5 px-0.5">
            <div className="flex items-center gap-1.5 text-[11.5px] font-medium text-ink-100"><span className="h-2 w-2 rounded-full" style={{ background: d.accent }} />{d.name}</div>
            <div className="text-[10px] text-ink-500">{d.era} · {d.note}</div>
          </header>
          <div className="grid grid-cols-2 gap-1.5">
            {filtered.filter((i) => i.designer === d.id).map((item) => (
              <button
                key={item.id}
                type="button"
                draggable
                onDragStart={(e) => { e.dataTransfer.setData(LIBRARY_MIME, item.id); e.dataTransfer.effectAllowed = 'copy'; }}
                onClick={() => insert(item)}
                title={item.note ?? item.label}
                className="group overflow-hidden rounded-md border border-ink-700 bg-ink-800 text-left transition-colors hover:border-ink-500"
              >
                <Thumb item={item} project={project} />
                <div className="truncate px-1.5 py-1 text-[10.5px] text-ink-300 group-hover:text-ink-100">{item.label}</div>
              </button>
            ))}
          </div>
        </section>
      ))}
      {!filtered.length && <p className="mt-4 text-[11px] text-ink-500">Nothing matches “{query}”.</p>}
    </div>
  );
}

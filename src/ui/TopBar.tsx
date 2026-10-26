import React, { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { Undo2, Redo2, Download, PanelLeft, PanelRight, FolderOpen, Save, FilePlus, BookOpen, Box, LayoutGrid, Book, BookBookmark, ChevronDown, RotateCcw, Upload } from 'lucide-react';
import { useStore, recoveredAutosave, type View } from '../store/store';
import { createDefaultProject } from '../model/defaults';
import { saveProjectFile, loadProjectFile, blankProject, openRecoveredBook } from './projectIO';
import { importFiles } from './importFiles';

const VIEWS: { id: View; label: string; icon: React.ReactNode; title: string }[] = [
  { id: 'spreads', label: 'Spreads', icon: <BookOpen size={14} />, title: 'Interior spreads & masters' },
  { id: 'cover', label: 'Cover', icon: <Book size={14} />, title: 'Unwrapped cover / case' },
  { id: 'jacket', label: 'Jacket', icon: <BookBookmark size={14} />, title: 'Dust jacket — wraps the case, flaps fold inside the boards' },
  { id: '3d', label: '3D', icon: <Box size={14} />, title: 'Real-time 3D book' },
  { id: 'matrix', label: 'Matrix', icon: <LayoutGrid size={14} />, title: 'Generative layout matrix' },
];

export function TopBar({ onToggleLeft, onToggleRight, leftOpen, rightOpen }: { onToggleLeft: () => void; onToggleRight: () => void; leftOpen: boolean; rightOpen: boolean }) {
  const view = useStore((s) => s.view);
  const name = useStore((s) => s.project.name);
  const canUndo = useStore((s) => s.past.length > 0);
  const canRedo = useStore((s) => s.future.length > 0);
  const s = useStore.getState;

  return (
    <header className="flex h-11 shrink-0 items-center gap-1 border-b border-ink-700 bg-ink-900 px-1 sm:gap-2 sm:px-2">
      <button type="button" onClick={onToggleLeft} title="Toggle left panel" className={clsx('inline-flex h-7 w-7 items-center justify-center rounded text-ink-300 hover:bg-ink-700', leftOpen && 'text-ink-100')}>
        <PanelLeft size={15} />
      </button>
      <div className="flex items-center gap-2 pr-2">
        <Logo />
        <div className="hidden leading-none sm:block">
          <div className="font-serif text-[15px] tracking-[0.02em] text-ink-100" style={{ fontFamily: '"BDS EB Garamond", Georgia, serif', fontVariantCaps: 'small-caps' }}>Book Design Studio</div>
        </div>
      </div>
      <FileMenu />
      <input
        className="hidden h-7 w-48 min-w-0 rounded border border-transparent bg-transparent px-2 text-[12px] text-ink-200 outline-none hover:border-ink-700 focus:border-ink-500 md:block"
        value={name}
        onChange={(e) => s().update((d) => { d.name = e.target.value; }, { history: false })}
        title="Project name"
      />
      <div className="mx-auto flex rounded-[7px] border border-ink-700 bg-ink-850 p-[2px]">
        {VIEWS.map((v) => (
          <button
            key={v.id}
            type="button"
            title={v.title}
            onClick={() => s().setView(v.id)}
            className={clsx('flex h-7 items-center gap-1.5 rounded-[5px] px-2.5 text-[12px] transition-colors', view === v.id ? 'bg-ink-600 text-ink-100' : 'text-ink-400 hover:text-ink-100')}
          >
            {v.icon}
            <span className="hidden lg:inline">{v.label}</span>
          </button>
        ))}
      </div>
      <div className="flex items-center gap-1">
        <button type="button" title="Undo (⌘Z)" disabled={!canUndo} onClick={() => s().undo()} className="inline-flex h-7 w-7 items-center justify-center rounded text-ink-300 hover:bg-ink-700 disabled:opacity-30"><Undo2 size={15} /></button>
        <button type="button" title="Redo (⇧⌘Z)" disabled={!canRedo} onClick={() => s().redo()} className="inline-flex h-7 w-7 items-center justify-center rounded text-ink-300 hover:bg-ink-700 disabled:opacity-30"><Redo2 size={15} /></button>
        <button type="button" onClick={() => s().setExportOpen(true)} className="ml-1 inline-flex h-7 items-center gap-1.5 rounded-[5px] bg-rubric px-3 text-[12px] font-medium text-white hover:bg-[#e2623f]">
          <Download size={14} /> <span className="hidden sm:inline">Export</span>
        </button>
        <button type="button" onClick={onToggleRight} title="Toggle inspector" className={clsx('inline-flex h-7 w-7 items-center justify-center rounded text-ink-300 hover:bg-ink-700', rightOpen && 'text-ink-100')}>
          <PanelRight size={15} />
        </button>
      </div>
    </header>
  );
}

function Logo() {
  return (
    <svg width="24" height="24" viewBox="0 0 64 64" aria-hidden>
      <rect width="64" height="64" rx="12" fill="#232126" />
      <path d="M14 16h16a6 6 0 0 1 6 6v28a5 5 0 0 0-5-5H14z" fill="#efe6d2" />
      <path d="M50 16H38a6 6 0 0 0-6 6v28a5 5 0 0 1 5-5h13z" fill="#d8cdb4" />
      <path d="M19 23h11M19 28h11M19 33h8" stroke="#d9532f" strokeWidth="2.4" strokeLinecap="round" />
    </svg>
  );
}

function FileMenu() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const importRef = useRef<HTMLInputElement>(null);
  // Whether safe mode kept a book aside, looked up each time the menu opens.
  const [recovered, setRecovered] = useState(false);
  useEffect(() => {
    if (!open) return;
    let live = true;
    void recoveredAutosave().then((r) => { if (live) setRecovered(!!r); });
    const close = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    window.addEventListener('pointerdown', close);
    return () => { live = false; window.removeEventListener('pointerdown', close); };
  }, [open]);
  const s = useStore.getState;
  const item = 'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[12px] text-ink-200 hover:bg-ink-700';
  return (
    <div className="relative" ref={ref}>
      <button type="button" onClick={() => setOpen(!open)} className="inline-flex h-7 items-center gap-1 rounded px-2 text-[12px] text-ink-300 hover:bg-ink-700 hover:text-ink-100">
        File <ChevronDown size={12} />
      </button>
      {open && (
        <div className="absolute left-0 top-full z-50 mt-1 w-60 rounded-md border border-ink-600 bg-ink-800 p-1 shadow-2xl">
          <button type="button" className={item} onClick={() => {
            if (confirm('Start a new book? The current project is autosaved in this browser until replaced.')) s().replaceProject(blankProject());
            setOpen(false);
          }}><FilePlus size={14} /> New blank book</button>
          <button type="button" className={item} onClick={() => {
            if (confirm('Load the sample book? This replaces the current project.')) s().replaceProject(createDefaultProject());
            setOpen(false);
          }}><RotateCcw size={14} /> Load sample book</button>
          <div className="my-1 border-t border-ink-700" />
          <button type="button" className={item} onClick={() => { fileRef.current?.click(); }}><FolderOpen size={14} /> Open project… <span className="ml-auto text-[10px] text-ink-500">.bds.json</span></button>
          {recovered && (
            <button type="button" className={item} title="The book that stopped the app while opening, kept aside by safe mode" onClick={async () => {
              setOpen(false);
              if (!confirm('Open the book safe mode kept? It stopped the app once while opening; if it does again, the next start is in safe mode. The current project can be brought back with Undo.')) return;
              try { if (await openRecoveredBook()) s().notify('Opened the book safe mode kept.'); else s().notify('There is no book kept by safe mode.', 'error'); } catch (err) { s().notify(`Could not open the kept book: ${(err as Error).message}`, 'error'); }
            }}><RotateCcw size={14} /> Open the book safe mode kept</button>
          )}
          <button type="button" className={item} onClick={() => { saveProjectFile(s().project); setOpen(false); }}><Save size={14} /> Save project file</button>
          <button type="button" className={item} onClick={() => { importRef.current?.click(); }}><Upload size={14} /> Import images, SVG, fonts…</button>
          <input ref={fileRef} type="file" accept=".json,.bds.json,application/json" className="hidden" onChange={async (e) => {
            const f = e.target.files?.[0];
            if (f) {
              try { await loadProjectFile(f); s().notify(`Opened ${f.name}`); } catch (err) { s().notify((err as Error).message, 'error'); }
            }
            setOpen(false);
            e.target.value = '';
          }} />
          <input ref={importRef} type="file" multiple accept="image/*,.svg,.pdf,.ttf,.otf,.woff,.woff2,.docx,.rtf,.idml,.txt,.md,.csv,.tsv" className="hidden" onChange={async (e) => {
            const files = e.target.files ? [...e.target.files] : [];
            const res = await importFiles(files);
            s().notify(res.errors[0] ?? (res.messages.join(' ') || 'Imported.'), res.errors.length ? 'error' : 'info');
            setOpen(false);
            e.target.value = '';
          }} />
          <div className="my-1 border-t border-ink-700" />
          <p className="px-2 py-1 text-[10.5px] leading-snug text-ink-500">Everything runs in your browser. Projects autosave locally; save a project file to move it between machines.</p>
        </div>
      )}
    </div>
  );
}

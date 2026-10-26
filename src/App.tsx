import React, { Suspense, lazy, useEffect, useState } from 'react';
import clsx from 'clsx';
import { useStore, loadAutosave, startAutosave, rawAutosave, startInSafeMode, markOpening, keepRecoveredAutosave } from './store/store';
import { ensureFamily } from './engine/fonts';
import { ensureHyphenation } from './engine/hyphenate';
import { TopBar } from './ui/TopBar';
import { Toolbar } from './ui/Toolbar';
import { BrushBar } from './ui/BrushBar';
import { StatusBar } from './ui/StatusBar';
import { LeftPanel } from './ui/panels/LeftPanel';
import { useScene3D } from './ui/scene3d';
import { RightPanel } from './ui/panels/RightPanel';
import { Editor } from './ui/canvas/Editor';
import { restoreProjectFonts } from './ui/projectIO';
import { Toast } from './ui/Toast';
import { enableJacket } from './ui/jacket';
import { BrushPanel } from './ui/brush';
import { saveProjectFile, blankProject, downloadBlob } from './ui/projectIO';

/** Decided once per page load, before any effect marks this opening as in progress. */
const SAFE_MODE = startInSafeMode();

const Viewer3D = lazy(() => import('./ui/Viewer3D'));
const LayoutMatrix = lazy(() => import('./ui/LayoutMatrix'));
const ExportDialog = lazy(() => import('./ui/ExportDialog'));

/** The whole app sits inside a last-resort boundary, so no render error ever leaves a blank screen. */
export default function App() {
  // Load the autosave once, outside the boundary: recovering from a crash must not reload it.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      // Safe mode with nowhere to keep the book: autosave stays off, so it is not overwritten.
      let autosave = true;
      if (SAFE_MODE) {
        // Opening this book stopped the app last time: keep it aside (File › Open the book safe mode
        // kept) and hand it over as a file rather than open it again.
        const raw = await rawAutosave();
        if (cancelled) return;
        if (raw) {
          const kept = await keepRecoveredAutosave(raw);
          let json: string | null = null;
          try { json = JSON.stringify({ format: 'book-design-studio', version: 1, savedAt: new Date().toISOString(), project: raw, fonts: [] }); } catch { /* too large for one string */ }
          // Downloaded once per book and tab (an address ending in ?safe would otherwise download it
          // on every reload); a different book that stops the app is downloaded too.
          const sig = `${(raw as { id?: unknown }).id ?? ''}:${json?.length ?? 0}`;
          let handed = false;
          try { handed = sessionStorage.getItem('bds.safeHanded') === sig; sessionStorage.setItem('bds.safeHanded', sig); } catch { /* storage blocked */ }
          let downloaded = handed;
          if (json && !handed) {
            try { downloadBlob(new Blob([json], { type: 'application/json' }), 'autosaved-book.bds.json'); downloaded = true; } catch { /* too large to write as one file */ }
          }
          autosave = kept || downloaded;
          const where = [
            downloaded ? (handed ? 'It was downloaded as autosaved-book.bds.json' : 'It has been downloaded as autosaved-book.bds.json') : '',
            kept ? 'it is kept in this browser (File › Open the book safe mode kept)' : '',
          ].filter(Boolean).join(', and ');
          useStore.getState().notify(autosave
            ? `Safe mode: your last book stopped the app while opening, so it was not opened again. ${where.charAt(0).toUpperCase()}${where.slice(1)}.`
            : 'Safe mode: your last book stopped the app while opening, so it was not opened again. It could not be downloaded or copied, so it stays in this browser’s autosave and autosave is off for now: save a project file to keep new work.', 'error');
        }
      } else {
        markOpening(true);
        const saved = await loadAutosave();
        if (cancelled) return;
        if (saved) {
          useStore.setState({ project: saved, past: [], future: [], spread: Math.min(useStore.getState().spread, Math.ceil(saved.pages.length / 2)) });
          await restoreProjectFonts(saved);
        }
      }
      useStore.setState({ ready: true });
      if (autosave) startAutosave();
      // Opening finished once the book has been drawn: a timer runs after React's render, and only
      // if that render didn't freeze the page. (Not an animation frame: those never come in a
      // background tab, and a book opened there would look like one that never finished.)
      setTimeout(() => markOpening(false), 1000);
    })();
    // Warm the default text faces and hyphenation patterns.
    void ensureFamily('eb-garamond');
    void ensureFamily('cinzel');
    void ensureHyphenation('en-us');
    return () => { cancelled = true; };
  }, []);

  return (
    <AppRecover>
      <Workspace />
    </AppRecover>
  );
}

function Workspace() {
  const view = useStore((s) => s.view);
  const tool = useStore((s) => s.tool);
  const exportOpen = useStore((s) => s.exportOpen);
  const left = useStore((s) => s.leftOpen);
  const setLeft = useStore((s) => s.setLeftOpen);
  const [right, setRight] = useState(() => window.innerWidth > 700);

  const editing = view === 'spreads' || view === 'cover' || view === 'jacket';
  // In 3D the left-panel button drives the scene panel; page thumbnails aren't needed there.
  const scenePanel = useScene3D((s) => s.panel);
  const leftShown = view === '3d' ? scenePanel : left;
  const toggleLeft = () => (view === '3d' ? useScene3D.getState().set({ panel: !scenePanel }) : setLeft(!left));
  return (
    <div className="flex h-full flex-col bg-ink-950 text-ink-100">
      <Guard label="top bar" className="h-11 border-b border-ink-700">
        <TopBar onToggleLeft={toggleLeft} onToggleRight={() => setRight(!right)} leftOpen={leftShown} rightOpen={right} />
      </Guard>
      <div className="relative flex min-h-0 flex-1">
        {left && view !== '3d' && <Guard label="left panel" className="w-[248px] border-r border-ink-700"><LeftPanel /></Guard>}
        <main className="relative flex min-w-0 flex-1 flex-col">
          <Recover>
          {editing && (tool === 'brush' || tool === 'eraser') && <BrushBar />}
          <div className="relative flex min-h-0 flex-1">
            {editing && <Toolbar />}
            <div className={clsx('relative min-w-0 flex-1')}>
              {view === 'spreads' && <Editor mode="spreads" />}
              {view === 'cover' && <Editor mode="cover" />}
              {view === 'jacket' && <JacketGate />}
              {editing && (tool === 'brush' || tool === 'eraser') && <BrushPanel />}
              <Suspense fallback={<Loading />}>
                {view === '3d' && <Viewer3D />}
                {view === 'matrix' && <LayoutMatrix />}
              </Suspense>
            </div>
          </div>
          <StatusBar />
          </Recover>
        </main>
        {right && (editing || view === '3d') && <Guard label="inspector" className="w-[296px] border-l border-ink-700"><RightPanel /></Guard>}
      </div>
      <Guard label="export dialog" className="fixed bottom-10 left-1/2 z-[90] -translate-x-1/2 rounded-md border border-ink-600 shadow-2xl" onReset={() => useStore.getState().setExportOpen(false)}>
        <Suspense fallback={null}>{exportOpen && <ExportDialog />}</Suspense>
      </Guard>
      <Toast />
    </div>
  );
}

/** The jacket view; offers to switch the jacket on when it is off. */
function JacketGate() {
  const enabled = useStore((s) => !!s.project.book.jacket?.enabled);
  if (enabled) return <Editor mode="jacket" />;
  return (
    <div className="pasteboard flex h-full items-center justify-center p-6">
      <div className="max-w-sm rounded-lg border border-ink-600 bg-ink-850 p-5 text-center shadow-2xl">
        <h2 className="font-serif text-[18px] text-ink-100" style={{ fontFamily: '"BDS EB Garamond", Georgia, serif' }}>Dust jacket</h2>
        <p className="mt-2 text-[12px] leading-relaxed text-ink-300">A separate printed wrapper around the case: back flap, back, spine, front and front flap, with folds that wrap the board edges. It has its own artwork, grid, finish and PDF, and appears in the 3D book.</p>
        <div className="mt-4 flex justify-center gap-2">
          <button type="button" className="h-8 rounded-md bg-rubric px-3 text-[12px] font-medium text-white hover:bg-[#e2623f]" onClick={() => enableJacket(true)}>Add a dust jacket</button>
          <button type="button" className="h-8 rounded-md border border-ink-600 px-3 text-[12px] text-ink-200 hover:bg-ink-700" onClick={() => enableJacket(false)}>Blank jacket</button>
        </div>
      </div>
    </div>
  );
}

function Loading() {
  return <div className="flex h-full items-center justify-center text-ink-400">Loading…</div>;
}

/**
 * If drawing the work area ever throws, show a way out instead of a black screen: undo the last
 * change (the usual cause), go back to the pages, or save a copy of the project first.
 */
class Recover extends React.Component<{ children: React.ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error) { console.error('Book Design Studio view crashed:', error); }
  private retry = (fn?: () => void) => { fn?.(); this.setState({ error: null }); };
  render() {
    if (!this.state.error) return this.props.children;
    const s = useStore.getState();
    const btn = 'rounded-md border border-ink-600 px-3 py-1.5 text-[12px] text-ink-100 hover:border-ink-400';
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
        <div className="text-[15px] text-ink-100">Something on this page couldn't be drawn.</div>
        <div className="max-w-md text-[12px] text-ink-400">Your work is safe. Undo the last change, or go back to the pages; save a copy first if you like.</div>
        <div className="flex flex-wrap justify-center gap-2">
          <button type="button" className={btn} onClick={() => this.retry(() => s.undo())}>Undo last change</button>
          <button type="button" className={btn} onClick={() => this.retry(() => { s.setTextEditing(null); s.setView('spreads'); })}>Back to the pages</button>
          <button type="button" className={btn} onClick={() => saveProjectFile(s.project)}>Save a copy of the project</button>
        </div>
        <code className="max-w-lg truncate text-[10.5px] text-ink-500">{this.state.error.message}</code>
      </div>
    );
  }
}

/**
 * A side panel (or the top bar) that fails to draw shows a small notice in its place; the canvas
 * and the other panels keep working.
 */
class Guard extends React.Component<{ children: React.ReactNode; label: string; className?: string; onReset?: () => void }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error) { console.error(`Book Design Studio: the ${this.props.label} crashed:`, error); }
  private retry = (fn?: () => void) => { fn?.(); this.setState({ error: null }); };
  render() {
    if (!this.state.error) return this.props.children;
    const btn = 'rounded-md border border-ink-600 px-2 py-1 text-[11px] text-ink-100 hover:border-ink-400';
    return (
      <div className={clsx('flex shrink-0 flex-col items-center justify-center gap-2 bg-ink-850 p-3 text-center', this.props.className)}>
        <div className="text-[11.5px] text-ink-200">The {this.props.label} couldn't be drawn.</div>
        <div className="flex flex-wrap justify-center gap-1.5">
          <button type="button" className={btn} onClick={() => this.retry(() => useStore.getState().undo())}>Undo last change</button>
          <button type="button" className={btn} onClick={() => this.retry(this.props.onReset)}>{this.props.onReset ? 'Close' : 'Try again'}</button>
        </div>
      </div>
    );
  }
}

/**
 * Last resort: if the app itself can't be drawn, offer a way out instead of a blank page — undo,
 * keep a copy of the work, or start a blank project (the broken one is autosaved, so a reload
 * alone would bring the same error back).
 */
class AppRecover extends React.Component<{ children: React.ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error) { console.error('Book Design Studio crashed:', error); }
  private retry = (fn?: () => void) => { fn?.(); this.setState({ error: null }); };
  render() {
    if (!this.state.error) return this.props.children;
    const s = useStore.getState();
    const btn = 'rounded-md border border-ink-600 px-3 py-1.5 text-[12px] text-ink-100 hover:border-ink-400';
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 bg-ink-950 p-8 text-center text-ink-100">
        <div className="text-[15px]">Book Design Studio couldn't be drawn.</div>
        <div className="max-w-md text-[12px] text-ink-400">Your work is autosaved in this browser. Undo the last change, or download the project to keep it, then start a blank one.</div>
        <div className="flex flex-wrap justify-center gap-2">
          <button type="button" className={btn} onClick={() => this.retry(() => { s.undo(); s.setTextEditing(null); s.setView('spreads'); })}>Undo last change</button>
          <button type="button" className={btn} onClick={() => saveProjectFile(useStore.getState().project)}>Download the autosaved project</button>
          <button type="button" className={btn} onClick={() => {
            if (confirm('Start a blank project? It replaces the autosaved one — download that first to keep it.')) this.retry(() => { useStore.getState().replaceProject(blankProject()); useStore.getState().setView('spreads'); });
          }}>Start a blank project</button>
        </div>
        <code className="max-w-lg truncate text-[10.5px] text-ink-500">{this.state.error.message}</code>
      </div>
    );
  }
}

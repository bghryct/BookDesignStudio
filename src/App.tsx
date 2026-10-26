import React, { Suspense, lazy, useEffect, useState } from 'react';
import clsx from 'clsx';
import { useStore, loadAutosave, startAutosave } from './store/store';
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
import { saveProjectFile } from './ui/projectIO';

const Viewer3D = lazy(() => import('./ui/Viewer3D'));
const LayoutMatrix = lazy(() => import('./ui/LayoutMatrix'));
const ExportDialog = lazy(() => import('./ui/ExportDialog'));

export default function App() {
  const view = useStore((s) => s.view);
  const tool = useStore((s) => s.tool);
  const exportOpen = useStore((s) => s.exportOpen);
  const left = useStore((s) => s.leftOpen);
  const setLeft = useStore((s) => s.setLeftOpen);
  const [right, setRight] = useState(() => window.innerWidth > 700);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const saved = await loadAutosave();
      if (cancelled) return;
      if (saved) {
        useStore.setState({ project: saved, past: [], future: [], spread: Math.min(useStore.getState().spread, Math.ceil(saved.pages.length / 2)) });
        await restoreProjectFonts(saved);
      }
      useStore.setState({ ready: true });
      startAutosave();
    })();
    // Warm the default text faces and hyphenation patterns.
    void ensureFamily('eb-garamond');
    void ensureFamily('cinzel');
    void ensureHyphenation('en-us');
    return () => { cancelled = true; };
  }, []);

  const editing = view === 'spreads' || view === 'cover' || view === 'jacket';
  // In 3D the left-panel button drives the scene panel; page thumbnails aren't needed there.
  const scenePanel = useScene3D((s) => s.panel);
  const leftShown = view === '3d' ? scenePanel : left;
  const toggleLeft = () => (view === '3d' ? useScene3D.getState().set({ panel: !scenePanel }) : setLeft(!left));
  return (
    <div className="flex h-full flex-col bg-ink-950 text-ink-100">
      <TopBar onToggleLeft={toggleLeft} onToggleRight={() => setRight(!right)} leftOpen={leftShown} rightOpen={right} />
      <div className="flex min-h-0 flex-1">
        {left && view !== '3d' && <LeftPanel />}
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
        {right && (editing || view === '3d') && <RightPanel />}
      </div>
      <Suspense fallback={null}>{exportOpen && <ExportDialog />}</Suspense>
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

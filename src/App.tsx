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
import { RightPanel } from './ui/panels/RightPanel';
import { Editor } from './ui/canvas/Editor';
import { restoreProjectFonts } from './ui/projectIO';
import { Toast } from './ui/Toast';

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

  const editing = view === 'spreads' || view === 'cover';
  return (
    <div className="flex h-full flex-col bg-ink-950 text-ink-100">
      <TopBar onToggleLeft={() => setLeft(!left)} onToggleRight={() => setRight(!right)} leftOpen={left} rightOpen={right} />
      <div className="flex min-h-0 flex-1">
        {left && <LeftPanel />}
        <main className="relative flex min-w-0 flex-1 flex-col">
          {editing && (tool === 'brush' || tool === 'eraser') && <BrushBar />}
          <div className="relative flex min-h-0 flex-1">
            {editing && <Toolbar />}
            <div className={clsx('relative min-w-0 flex-1')}>
              {view === 'spreads' && <Editor mode="spreads" />}
              {view === 'cover' && <Editor mode="cover" />}
              <Suspense fallback={<Loading />}>
                {view === '3d' && <Viewer3D />}
                {view === 'matrix' && <LayoutMatrix />}
              </Suspense>
            </div>
          </div>
          <StatusBar />
        </main>
        {right && (editing || view === '3d') && <RightPanel />}
      </div>
      <Suspense fallback={null}>{exportOpen && <ExportDialog />}</Suspense>
      <Toast />
    </div>
  );
}

function Loading() {
  return <div className="flex h-full items-center justify-center text-ink-400">Loading…</div>;
}

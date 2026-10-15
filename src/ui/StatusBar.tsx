import React, { useMemo } from 'react';
import { useStore } from '../store/store';
import { useCursor } from './canvas/Editor';
import { useFontStore } from '../engine/fonts';
import { computeBinding } from '../engine/binding';
import { fromPt } from '../model/units';

export function StatusBar() {
  const zoom = useStore((s) => s.zoom);
  const book = useStore((s) => s.project.book);
  const pages = useStore((s) => s.project.pages.length);
  const selection = useStore((s) => s.selection.length);
  const cursor = useCursor();
  const loading = useFontStore((s) => s.loading);
  const calc = useMemo(() => computeBinding(book), [book]);
  const u = book.unit;
  const f = (v: number) => (+fromPt(v, u).toFixed(u === 'in' ? 3 : 1)).toString();
  return (
    <footer className="flex h-7 shrink-0 items-center gap-4 overflow-hidden whitespace-nowrap border-t border-ink-700 bg-ink-900 px-3 text-[11px] tabular-nums text-ink-400">
      <button type="button" className="hover:text-ink-100" title="Fit (⌘0)" onClick={() => useStore.getState().requestFit()}>{Math.round(zoom * 100)}%</button>
      <span className="hidden sm:inline">{cursor.surface ? `${cursor.surface} · ` : ''}x {f(cursor.x)} y {f(cursor.y)} {u}</span>
      <span className="hidden md:inline">Trim {f(book.trimW)} × {f(book.trimH)} {u}</span>
      <span className="hidden md:inline">{pages} designed pp · {calc.pages} planned</span>
      <span title="Spine width from the Diehl binding engine">Spine {f(calc.spine)} {u}</span>
      {selection > 0 && <span>{selection} selected</span>}
      <span className="ml-auto flex items-center gap-2">
        {loading > 0 && <span className="text-gold">Loading fonts…</span>}
        <span className="hidden lg:inline text-ink-500">Space-drag to pan · ⌘-scroll to zoom · ⌘Z undo</span>
      </span>
    </footer>
  );
}

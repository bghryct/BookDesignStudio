import React from 'react';
import { create } from 'zustand';
import { LayoutGrid } from 'lucide-react';
import { useStore } from '../../store/store';
import { PRESET_FAMILIES, applyPreset, defaultContent } from '../../engine/presets';
import { spreadsOf, pageKey } from '../../model/surfaces';
import { textBlock } from '../../engine/grid';
import { makePattern, makeOrnament, makeOverprint, makeGradient, makeGridType, makeCutout, makeInitial } from '../../model/factory';
import type { Element } from '../../model/types';
import { Button, Hint } from '../controls';

export const useMatrix = create<{ family: string; seed: number; source: 'document' | 'sample' }>(() => ({ family: 'all', seed: 17, source: 'document' }));

export function applyFamily(familyId: string, variant: number, seed: number) {
  const s = useStore.getState();
  const fam = PRESET_FAMILIES.find((f) => f.id === familyId);
  if (!fam) return;
  const source = useMatrix.getState().source;
  const content = defaultContent(source === 'document' ? s.project : undefined);
  const result = fam.generate(content, variant, seed);
  s.update((d) => { Object.assign(d, applyPreset(d as never, result)); });
  s.setView('spreads');
  s.setSpread(result.focusSpread);
  s.notify(`${fam.name} applied — ${result.caption}. Undo (⌘Z) to go back.`);
}

const INSERTS: { label: string; make: (b: { x: number; y: number; w: number; h: number }) => Element }[] = [
  { label: 'Schrofer · text rings', make: (b) => makePattern({ x: b.x, y: b.y, w: b.w, h: b.w, kind: 'text-rings' }) },
  { label: 'Schrofer · moiré', make: (b) => makePattern({ x: b.x, y: b.y, w: b.w, h: b.w, kind: 'moire-lines' }) },
  { label: 'Cleves · vine border', make: (b) => makeOrnament({ x: b.x - 20, y: b.y - 20, w: b.w + 40, h: b.h + 40, band: 30, kind: 'vine-border' }) },
  { label: 'Cleves · shells & coins', make: (b) => makeOrnament({ x: b.x - 24, y: b.y - 24, w: b.w + 48, h: b.h + 48, band: 34, kind: 'shells-and-coins' }) },
  { label: 'Cleves · gilded initial', make: (b) => makeInitial({ x: b.x, y: b.y, w: 64, h: 64 }) },
  { label: 'Martens · numerals', make: (b) => makeOverprint({ x: b.x, y: b.y, w: b.w, h: b.w }) },
  { label: 'Martens · circles', make: (b) => makeOverprint({ x: b.x, y: b.y, w: b.w, h: b.w, kind: 'circles' }) },
  { label: 'Sato · glow', make: (b) => makeGradient({ x: b.x, y: b.y, w: b.w, h: b.h * 0.7 }) },
  { label: 'Crouwel · grid type', make: (b) => makeGridType({ x: b.x, y: b.y, w: b.w, h: 60 }) },
  { label: 'Munari · die-cut window', make: (b) => makeCutout({ x: b.x + b.w / 2 - 40, y: b.y + b.h / 3, w: 80, h: 80 }) },
];

export function PresetsPanel() {
  const s = useStore.getState;
  const insert = (make: (b: { x: number; y: number; w: number; h: number }) => Element) => {
    const st = s();
    const p = st.project;
    const sp = spreadsOf(p)[st.spread];
    const idx = sp?.right ?? sp?.left;
    if (idx == null) return;
    const b = textBlock(p.book, sp?.right != null ? 'right' : 'left');
    if (st.view !== 'spreads') st.setView('spreads');
    st.addElement(pageKey(p.pages[idx].id), make(b));
  };
  return (
    <div className="p-2">
      <Button variant="primary" className="mb-2 w-full" onClick={() => { useMatrix.setState({ family: 'all' }); s().setView('matrix'); }}>
        <LayoutGrid size={13} /> Open layout matrix
      </Button>
      <div className="space-y-2">
        {PRESET_FAMILIES.map((f) => (
          <div key={f.id} className="rounded-md border border-ink-700 bg-ink-800/60 p-2.5">
            <div className="flex items-start gap-2">
              <span className="mt-1 h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: f.accent }} />
              <div className="min-w-0">
                <div className="text-[12.5px] font-medium text-ink-100">{f.name}</div>
                <div className="text-[10.5px] text-ink-400">{f.designer} · {f.era}</div>
              </div>
            </div>
            <p className="mt-1.5 text-[10.5px] leading-snug text-ink-300">{f.description}</p>
            <details className="mt-1 text-[10.5px] text-ink-400">
              <summary className="cursor-pointer text-ink-400 hover:text-ink-200">Why it works</summary>
              <ul className="mt-1 list-disc space-y-0.5 pl-4 leading-snug">{f.rationale.map((r, i) => <li key={i}>{r}</li>)}</ul>
            </details>
            <div className="mt-2 flex gap-1">
              <Button className="flex-1" onClick={() => { useMatrix.setState({ family: f.id }); s().setView('matrix'); }}>8 variations</Button>
              <Button className="flex-1" onClick={() => { if (confirm(`Replace the document with a ${f.name} layout? (Undo restores it.)`)) applyFamily(f.id, 0, useMatrix.getState().seed); }}>Apply</Button>
            </div>
          </div>
        ))}
      </div>
      <div className="mt-4 mb-1 px-1 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-ink-400">Insert on current spread</div>
      <div className="grid grid-cols-2 gap-1">
        {INSERTS.map((i) => <Button key={i.label} className="justify-start px-2 text-left text-[10.5px]" onClick={() => insert(i.make)}>{i.label}</Button>)}
      </div>
      <Hint>Presets keep your images, fonts and swatches; text comes from your longest story.</Hint>
    </div>
  );
}

import React from 'react';
import clsx from 'clsx';
import { Brush, Eraser, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { useStore } from '../store/store';
import { BRUSHES, getBrush } from '../engine/brushes';
import type { BrushType } from '../model/types';
import { ColorField } from './controls';
import { fmtPct, fmtSize, sizeToT, tToSize, useBrushPanel } from './brush';

/** Slim context bar for the brush & eraser tools; the full controls live in the BrushPanel. */
export function BrushBar() {
  const brush = useStore((s) => s.brush);
  const tool = useStore((s) => s.tool);
  const setBrush = useStore((s) => s.setBrush);
  const panelOpen = useBrushPanel((s) => s.open);
  const togglePanel = useBrushPanel((s) => s.toggle);
  const eraser = tool === 'eraser';
  const def = getBrush(eraser ? 'eraser' : brush.type);
  const groups = [...new Set(BRUSHES.map((b) => b.group))];

  const pickBrush = (type: BrushType) => {
    // Adopt the medium's defaults but keep the colour.
    setBrush({ type, ...getBrush(type).defaults, color: brush.color });
  };

  return (
    <div className="scroll-thin flex h-9 shrink-0 items-center gap-3 overflow-x-auto border-b border-ink-700 bg-ink-850 px-3">
      <div className="flex shrink-0 items-center gap-1.5 text-ink-300">
        {eraser ? <Eraser size={14} /> : <Brush size={14} />}
        {eraser ? (
          <span className="text-[11.5px] font-medium text-ink-100" title={def.description}>Eraser</span>
        ) : (
          <select
            aria-label="Medium"
            title={def.description}
            value={brush.type}
            onChange={(e) => pickBrush(e.target.value as BrushType)}
            className="h-6 rounded-[5px] border border-transparent bg-transparent pr-1 text-[11.5px] font-medium text-ink-100 outline-none hover:border-ink-700 focus:border-ink-500"
          >
            {groups.map((g) => (
              <optgroup key={g} label={g}>
                {BRUSHES.filter((b) => b.group === g && b.type !== 'eraser').map((b) => (
                  <option key={b.type} value={b.type}>{b.label}</option>
                ))}
              </optgroup>
            ))}
          </select>
        )}
      </div>

      {!eraser && (
        <>
          <div className="h-5 w-px shrink-0 bg-ink-700" />
          <div className="w-32 shrink-0 [&>div]:mt-0 [&_button]:mt-0 [&_button]:h-6">
            <ColorField value={brush.color} onChange={(c) => c && setBrush({ color: c })} hint="Brush colour" />
          </div>
        </>
      )}

      <div className="h-5 w-px shrink-0 bg-ink-700" />
      <label className="flex shrink-0 items-center gap-1.5 text-[11px] text-ink-400" title="Brush size ([ and ] to change)">
        <span>Size</span>
        <input type="range" className="w-24" min={0} max={1} step={0.001} value={sizeToT(brush.size)} onChange={(e) => setBrush({ size: tToSize(parseFloat(e.target.value)) })} />
        <span className="w-11 tabular-nums text-ink-300">{fmtSize(brush.size)}</span>
      </label>
      <label className="flex shrink-0 items-center gap-1.5 text-[11px] text-ink-400" title="Opacity">
        <span>Opacity</span>
        <input type="range" className="w-20" min={0} max={1} step={0.01} value={brush.opacity} onChange={(e) => setBrush({ opacity: parseFloat(e.target.value) })} />
        <span className="w-8 tabular-nums text-ink-300">{fmtPct(brush.opacity)}</span>
      </label>

      <div className="flex-1" />
      <button
        type="button"
        onClick={togglePanel}
        aria-pressed={panelOpen}
        title={panelOpen ? 'Hide the brush panel' : 'Show the brush panel'}
        className={clsx(
          'inline-flex h-6 shrink-0 items-center gap-1.5 rounded-[5px] px-2 text-[11px] transition-colors',
          panelOpen ? 'bg-ink-700 text-ink-100' : 'text-ink-300 hover:bg-ink-700 hover:text-ink-100',
        )}
      >
        {panelOpen ? <PanelLeftClose size={13} /> : <PanelLeftOpen size={13} />}
        Brush panel
      </button>
    </div>
  );
}

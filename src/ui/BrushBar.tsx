import React from 'react';
import clsx from 'clsx';
import { useStore } from '../store/store';
import { BRUSHES, getBrush } from '../engine/brushes';
import type { BrushType } from '../model/types';
import { ColorField, Toggle } from './controls';

const LABELS: Record<string, string> = { size: 'Size', opacity: 'Opacity', flow: 'Flow', hardness: 'Hardness', grain: 'Grain', wetness: 'Wetness', angle: 'Nib angle' };

/** Context bar for the brush & eraser tools. */
export function BrushBar() {
  const brush = useStore((s) => s.brush);
  const tool = useStore((s) => s.tool);
  const setBrush = useStore((s) => s.setBrush);
  const def = getBrush(tool === 'eraser' ? 'eraser' : brush.type);
  const groups = [...new Set(BRUSHES.map((b) => b.group))];

  const pickBrush = (type: BrushType) => {
    const d = getBrush(type);
    // Adopt the medium's defaults but keep the colour.
    setBrush({ type, ...d.defaults, color: brush.color });
  };

  const slider = (key: 'size' | 'opacity' | 'flow' | 'hardness' | 'grain' | 'wetness' | 'angle') => {
    const range = key === 'size' ? [0.5, 160, 0.5] : key === 'angle' ? [-90, 90, 1] : [0, 1, 0.01];
    const v = brush[key];
    return (
      <label key={key} className="flex items-center gap-1.5 text-[11px] text-ink-400" title={LABELS[key]}>
        <span className="w-[52px] shrink-0 truncate">{LABELS[key]}</span>
        <input type="range" className="w-20" min={range[0]} max={range[1]} step={range[2]} value={v} onChange={(e) => setBrush({ [key]: parseFloat(e.target.value) })} />
        <span className="w-8 tabular-nums text-ink-300">{key === 'size' ? v.toFixed(v < 10 ? 1 : 0) : key === 'angle' ? `${v}°` : Math.round(v * 100)}</span>
      </label>
    );
  };

  return (
    <div className="scroll-thin flex shrink-0 items-center gap-3 overflow-x-auto border-b border-ink-700 bg-ink-850 px-3 py-1.5">
      {tool === 'brush' && (
        <div className="flex items-center gap-1">
          {groups.map((g) => (
            <div key={g} className="flex items-center gap-0.5 rounded-md bg-ink-900 p-0.5" title={g}>
              {BRUSHES.filter((b) => b.group === g && b.type !== 'eraser').map((b) => (
                <button
                  key={b.type}
                  type="button"
                  title={`${b.label} — ${b.description}`}
                  onClick={() => pickBrush(b.type)}
                  className={clsx('h-6 whitespace-nowrap rounded px-2 text-[11px]', brush.type === b.type ? 'bg-rubric text-white' : 'text-ink-300 hover:bg-ink-700')}
                >
                  {b.label}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
      {tool === 'eraser' && <span className="text-[11px] text-ink-300">Eraser — removes paint from the selected drawing</span>}
      <div className="h-5 w-px shrink-0 bg-ink-700" />
      {tool === 'brush' && <div className="w-36 shrink-0"><ColorField value={brush.color} onChange={(c) => c && setBrush({ color: c })} /></div>}
      {(['size', 'opacity', ...def.controls.filter((c) => c !== 'size' && c !== 'opacity')] as const).map((k) => slider(k as 'size'))}
      <label className="flex items-center gap-1.5 text-[11px] text-ink-400" title="Stabiliser smooths hand tremor (lazy brush)">
        <span>Stabiliser</span>
        <input type="range" className="w-16" min={0} max={1} step={0.01} value={brush.stabilizer} onChange={(e) => setBrush({ stabilizer: parseFloat(e.target.value) })} />
      </label>
      <Toggle label="Pressure" checked={brush.pressure} onChange={(v) => setBrush({ pressure: v })} hint="Pen pressure (tablet / Apple Pencil); with a mouse, speed simulates pressure" />
    </div>
  );
}

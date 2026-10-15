import React, { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { ChevronDown, ChevronUp, Eraser, RotateCcw, X } from 'lucide-react';
import { useStore, type BrushSettings } from '../../store/store';
import { BRUSHES, getBrush, type BrushDef } from '../../engine/brushes';
import type { BrushType } from '../../model/types';
import { IconButton, Kbd, Section, Slider, Toggle } from '../controls';
import { ColorPicker } from '../controls/ColorPicker';
import { SIZE_PRESETS, fmtPct, fmtSize, paramMeta, sizeToT, tToSize, useBrushPanel, type ParamKey } from './params';
import { drawSample, reachOf, useMediumTile } from './preview';

const PANEL_W = 260;
const INNER_W = PANEL_W - 24; // px-3 on both sides
const TILE_W = (INNER_W - 6) / 2;
const TILE_H = 34;
const PREVIEW_H = 64;

const GROUPS = [...new Set(BRUSHES.map((b) => b.group))];

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/**
 * Docked brush panel floating over the left edge of the canvas: medium picker
 * with real sample strokes, colour, live preview and the brush's controls.
 * Render it while the brush or eraser tool is active; it hides itself when
 * closed from its header or the brush bar.
 */
export function BrushPanel() {
  const tool = useStore((s) => s.tool);
  const brush = useStore((s) => s.brush);
  const setBrush = useStore((s) => s.setBrush);
  const setTool = useStore((s) => s.setTool);
  const swatches = useStore((s) => s.project.swatches);
  const { open, collapsed, setOpen, setCollapsed } = useBrushPanel();
  const tileColor = useDebounced(brush.color, 180);

  if (!open || (tool !== 'brush' && tool !== 'eraser')) return null;
  const eraser = tool === 'eraser';
  const def = getBrush(eraser ? 'eraser' : brush.type);

  const pick = (b: BrushDef) => {
    if (b.type === 'eraser') { setTool('eraser'); return; }
    // Adopt the medium's defaults but keep the colour and input preferences.
    setBrush({ type: b.type, ...b.defaults, color: brush.color });
    if (eraser) setTool('brush');
  };
  const extra = def.controls.filter((k): k is Exclude<ParamKey, 'size' | 'opacity'> => k !== 'size' && k !== 'opacity');

  return (
    <aside
      aria-label="Brush panel"
      className="absolute left-[26px] top-[26px] z-30 flex max-h-[calc(100%-36px)] flex-col overflow-hidden rounded-lg border border-ink-700 bg-ink-850/95 shadow-2xl backdrop-blur-sm"
      style={{ width: PANEL_W }}
      onPointerDown={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
    >
      <header className="flex h-9 shrink-0 items-center gap-2 border-b border-ink-700 pl-2.5 pr-1">
        {eraser
          ? <Eraser size={14} className="shrink-0 text-ink-300" />
          : <span className="h-3.5 w-3.5 shrink-0 rounded-full border border-white/20" style={{ background: brush.color }} />}
        <button
          type="button"
          className="min-w-0 flex-1 truncate text-left text-[11.5px] font-medium text-ink-100"
          onClick={() => setCollapsed(!collapsed)}
          title={def.description}
        >
          {def.label}
        </button>
        <span className="shrink-0 text-[10.5px] tabular-nums text-ink-400">{fmtSize(brush.size)}</span>
        <IconButton title={collapsed ? 'Expand brush panel' : 'Collapse brush panel'} className="h-6 w-6" onClick={() => setCollapsed(!collapsed)}>
          {collapsed ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
        </IconButton>
        <IconButton title="Hide brush panel" className="h-6 w-6" onClick={() => setOpen(false)}>
          <X size={14} />
        </IconButton>
      </header>

      {!collapsed && (
        <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
          <Section title="Medium" id="brush.medium">
            {GROUPS.map((g) => (
              <div key={g}>
                <div className="mb-1 text-[10px] font-medium uppercase tracking-[0.08em] text-ink-500">{g}</div>
                <div className="grid grid-cols-2 gap-1.5">
                  {BRUSHES.filter((b) => b.group === g).map((b) => (
                    <MediumTile
                      key={b.type}
                      def={b}
                      color={tileColor}
                      active={eraser ? b.type === 'eraser' : b.type === brush.type}
                      onPick={() => pick(b)}
                    />
                  ))}
                </div>
              </div>
            ))}
          </Section>

          {!eraser && (
            <Section title="Colour" id="brush.colour">
              <ColorPicker value={brush.color} onChange={(c) => setBrush({ color: c })} swatches={swatches} compact />
            </Section>
          )}

          <div className="border-b border-ink-700/70 px-3 py-2.5">
            <StrokePreview brush={brush} eraser={eraser} />
          </div>

          <Section
            title="Settings"
            id="brush.settings"
            right={(
              <IconButton title={`Reset to ${def.label} defaults`} className="h-6 w-6" onClick={() => setBrush({ ...def.defaults, type: eraser ? brush.type : def.type })}>
                <RotateCcw size={12} />
              </IconButton>
            )}
          >
            <Slider
              label="Size"
              hint="Nominal brush diameter in points"
              value={sizeToT(brush.size)}
              min={0}
              max={1}
              step={0.001}
              format={() => fmtSize(brush.size)}
              onChange={(t) => setBrush({ size: tToSize(t) })}
            />
            <div className="flex gap-1" role="group" aria-label="Size presets">
              {SIZE_PRESETS.map((s) => (
                <button
                  key={s}
                  type="button"
                  title={`${s} pt`}
                  onClick={() => setBrush({ size: s })}
                  className={clsx(
                    'h-5 flex-1 rounded-[4px] text-[10px] tabular-nums transition-colors',
                    Math.abs(brush.size - s) < 0.05 ? 'bg-rubric text-white' : 'bg-ink-900 text-ink-300 hover:bg-ink-700 hover:text-ink-100',
                  )}
                >
                  {s}
                </button>
              ))}
            </div>
            <Slider label="Opacity" value={brush.opacity} min={0} max={1} format={fmtPct} onChange={(v) => setBrush({ opacity: v })} />
            {extra.map((k) => {
              const m = paramMeta(def.type, k);
              return (
                <Slider key={k} label={m.label} hint={m.hint} value={brush[k]} min={m.min} max={m.max} step={m.step} format={m.format} onChange={(v) => setBrush({ [k]: v })} />
              );
            })}
            <div className="h-px bg-ink-700/70" />
            <Slider
              label="Stabiliser"
              hint="Lazy-brush smoothing for steadier lines (the stroke trails the pointer on a string)"
              value={brush.stabilizer}
              min={0}
              max={1}
              format={(v) => (v < 0.01 ? 'Off' : fmtPct(v))}
              onChange={(v) => setBrush({ stabilizer: v })}
            />
            <Toggle
              label="Pressure"
              checked={brush.pressure}
              onChange={(v) => setBrush({ pressure: v })}
              hint="Use pen pressure (tablet / Apple Pencil); with a mouse, speed simulates pressure"
            />
          </Section>

          <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 px-3 py-2.5 text-[10.5px] text-ink-400">
            <Kbd>[</Kbd><Kbd>]</Kbd> size
            <span className="text-ink-600">·</span>
            <Kbd>B</Kbd> brush
            <span className="text-ink-600">·</span>
            <Kbd>X</Kbd> eraser
          </p>
        </div>
      )}
    </aside>
  );
}

function MediumTile({ def, color, active, onPick }: { def: BrushDef; color: string; active: boolean; onPick: () => void }) {
  const url = useMediumTile(def.type, color, TILE_W, TILE_H);
  return (
    <button
      type="button"
      title={`${def.label} — ${def.description}`}
      aria-pressed={active}
      onClick={onPick}
      className={clsx(
        'group overflow-hidden rounded-[6px] border text-left transition-colors',
        active ? 'border-rubric ring-1 ring-rubric/60' : 'border-ink-700 hover:border-ink-500',
      )}
    >
      <span className="block bg-paper" style={{ height: TILE_H }}>
        {url && <img src={url} alt="" draggable={false} className="block h-full w-full" />}
      </span>
      <span className={clsx('block truncate px-1.5 py-[3px] text-[10.5px]', active ? 'bg-rubric/15 text-ink-100' : 'bg-ink-900 text-ink-300 group-hover:text-ink-100')}>
        {def.label}
      </span>
    </button>
  );
}

/** Live sample with the exact current settings (scaled down only when the brush would not fit). */
function StrokePreview({ brush, eraser }: { brush: BrushSettings; eraser: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const type: BrushType = eraser ? 'eraser' : brush.type;
  const params = {
    size: brush.size, opacity: brush.opacity, flow: brush.flow, hardness: brush.hardness,
    grain: brush.grain, wetness: brush.wetness, angle: brush.angle,
  };
  const reach = reachOf(type, params);
  const k = Math.min(1, (PREVIEW_H / 2 - 3) / Math.max(1, reach));
  const sig = JSON.stringify([type, brush.color, brush.pressure, params]);

  useEffect(() => {
    const id = requestAnimationFrame(() => {
      if (ref.current) drawSample(ref.current, type, params, brush.color, INNER_W, PREVIEW_H, { k, pressure: brush.pressure, points: 110 });
    });
    return () => cancelAnimationFrame(id);
  }, [sig]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-[10.5px] text-ink-400">
        <span>Preview</span>
        {k < 0.995 && <span className="tabular-nums text-ink-500">shown at {Math.round(k * 100)}%</span>}
      </div>
      <canvas ref={ref} className="block rounded-[5px] bg-paper" style={{ width: INNER_W, height: PREVIEW_H }} />
    </div>
  );
}

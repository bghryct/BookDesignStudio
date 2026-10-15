import React from 'react';
import type { Unit } from '../../model/types';
import { PT_PER } from '../../model/units';

export const RULER = 18;

/** A tick step (in document units) that keeps major ticks at least ~56 px apart. */
function tickStep(pxPerUnit: number): number {
  const steps = [0.1, 0.25, 0.5, 1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000];
  return steps.find((s) => s * pxPerUnit >= 56) ?? 10000;
}

function Ruler({ orientation, zoom, offset, length, unit }: { orientation: 'top' | 'left'; zoom: number; offset: number; length: number; unit: Unit }) {
  const pxPerUnit = zoom * PT_PER[unit];
  const major = tickStep(pxPerUnit);
  const minor = major / (major * pxPerUnit >= 100 ? 10 : 5);
  const start = Math.floor(-offset / pxPerUnit / major) * major;
  const end = (length - offset) / pxPerUnit;
  const ticks: React.ReactNode[] = [];
  for (let v = start; v <= end; v += minor) {
    const isMajor = Math.abs(v / major - Math.round(v / major)) < 1e-6;
    const pos = offset + v * pxPerUnit;
    if (pos < RULER || pos > length) continue;
    const len = isMajor ? RULER * 0.55 : RULER * 0.22;
    ticks.push(orientation === 'top'
      ? <line key={v} x1={pos} x2={pos} y1={RULER - len} y2={RULER} stroke="#7d7a83" strokeWidth={1} />
      : <line key={v} y1={pos} y2={pos} x1={RULER - len} x2={RULER} stroke="#7d7a83" strokeWidth={1} />);
    if (isMajor) {
      const label = String(+v.toFixed(2));
      ticks.push(orientation === 'top'
        ? <text key={`t${v}`} x={pos + 2} y={9} fontSize={8.5} fill="#a7a3ab" style={{ fontFamily: 'ui-sans-serif, system-ui' }}>{label}</text>
        : <text key={`t${v}`} x={9} y={pos + 2} fontSize={8.5} fill="#a7a3ab" transform={`rotate(-90 9 ${pos + 2})`} textAnchor="end" style={{ fontFamily: 'ui-sans-serif, system-ui' }}>{label}</text>);
    }
  }
  return <>{ticks}</>;
}

/** Top and left rulers in document units; drag out of either to create a guide. */
export function Rulers({ zoom, pan, size, unit }: { zoom: number; pan: { x: number; y: number }; size: { w: number; h: number }; unit: Unit }) {
  return (
    <>
      <svg data-ruler="top" className="absolute left-0 top-0 cursor-row-resize bg-ink-900/95" width={size.w} height={RULER} style={{ borderBottom: '1px solid #2e2d32' }}>
        <title>Drag down to place a horizontal guide</title>
        <Ruler orientation="top" zoom={zoom} offset={pan.x} length={size.w} unit={unit} />
      </svg>
      <svg data-ruler="left" className="absolute left-0 top-0 cursor-col-resize bg-ink-900/95" width={RULER} height={size.h} style={{ borderRight: '1px solid #2e2d32' }}>
        <title>Drag right to place a vertical guide</title>
        <Ruler orientation="left" zoom={zoom} offset={pan.y} length={size.h} unit={unit} />
      </svg>
      <div className="pointer-events-none absolute left-0 top-0 flex items-center justify-center bg-ink-900 text-[8px] text-ink-500" style={{ width: RULER, height: RULER, borderRight: '1px solid #2e2d32', borderBottom: '1px solid #2e2d32' }}>{unit}</div>
    </>
  );
}

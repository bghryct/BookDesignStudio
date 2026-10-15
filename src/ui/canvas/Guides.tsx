import React from 'react';
import type { Project } from '../../model/types';
import { computeGrid, canonLines } from '../../engine/grid';
import type { BindingCalc } from '../../engine/binding';
import type { SurfaceDesc } from './geometry';

const MARGIN = 'rgba(214, 92, 214, 0.85)';
const COLUMN = 'rgba(150, 120, 255, 0.75)';
const ROW = 'rgba(214, 92, 214, 0.35)';
const BASELINE = 'rgba(70, 170, 230, 0.45)';
const MICRO = 'rgba(70, 170, 230, 0.22)';
const BLEED = 'rgba(232, 72, 52, 0.85)';
const CANON = 'rgba(217, 83, 47, 0.75)';
const FOLD = 'rgba(40, 170, 120, 0.95)';

const hair = { vectorEffect: 'non-scaling-stroke' as const, strokeWidth: 1, fill: 'none' };

export function SurfaceGuides({ project, surface }: { project: Project; surface: SurfaceDesc }) {
  const g = project.book.grid;
  if (surface.kind === 'cover') return null;
  const grid = computeGrid(project.book, surface.side);
  const { block } = grid;
  const b = surface.bleed;
  return (
    <g transform={`translate(${surface.x} ${surface.y})`} pointerEvents="none">
      {g.showBleed && b > 0 && (
        // Facing pages bleed only on the three outer edges — never into the spine.
        !project.book.facing
          ? <rect x={-b} y={-b} width={surface.w + 2 * b} height={surface.h + 2 * b} stroke={BLEED} {...hair} />
          : surface.side === 'left'
            ? <path d={`M${surface.w} ${-b}H${-b}V${surface.h + b}H${surface.w}`} stroke={BLEED} {...hair} />
            : <path d={`M0 ${-b}H${surface.w + b}V${surface.h + b}H0`} stroke={BLEED} {...hair} />
      )}
      {g.showBaseline && grid.baselines.map((y, i) => (
        <line key={`b${i}`} x1={0} x2={surface.w} y1={y} y2={y} stroke={BASELINE} {...hair} />
      ))}
      {g.showGrid && grid.microX.map((x, i) => <line key={`mx${i}`} x1={x} x2={x} y1={block.y} y2={block.y + block.h} stroke={MICRO} {...hair} strokeDasharray="2 3" />)}
      {g.showGrid && grid.microY.map((y, i) => <line key={`my${i}`} x1={block.x} x2={block.x + block.w} y1={y} y2={y} stroke={MICRO} {...hair} strokeDasharray="2 3" />)}
      {g.showGrid && grid.rows.length > 1 && grid.rows.map((r, i) => (
        <rect key={`r${i}`} x={block.x} y={r.y} width={block.w} height={r.h} stroke={ROW} {...hair} />
      ))}
      {g.showGrid && grid.cols.length > 1 && grid.cols.map((c, i) => (
        <rect key={`c${i}`} x={c.x} y={block.y} width={c.w} height={block.h} stroke={COLUMN} {...hair} />
      ))}
      {g.showMargins && <rect x={block.x} y={block.y} width={block.w} height={block.h} stroke={MARGIN} {...hair} />}
    </g>
  );
}

/** Van de Graaf / golden canon construction across the whole spread. */
export function CanonGuides({ project, x, y }: { project: Project; x: number; y: number }) {
  if (!project.book.grid.showCanon) return null;
  return (
    <g transform={`translate(${x} ${y})`} pointerEvents="none">
      {canonLines(project.book).map(([x1, y1, x2, y2], i) => (
        <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke={CANON} {...hair} strokeDasharray="5 4" />
      ))}
    </g>
  );
}

export function CoverGuides({ calc, surface, showBleed }: { calc: BindingCalc; surface: SurfaceDesc; showBleed: boolean }) {
  const H = calc.coverH;
  const w = calc.wrap;
  return (
    <g transform={`translate(${surface.x} ${surface.y})`} pointerEvents="none">
      {showBleed && <rect x={-w} y={-w} width={calc.coverW + 2 * w} height={H + 2 * w} stroke={BLEED} {...hair} />}
      {calc.panels.filter((p) => p.id.startsWith('hinge')).map((p) => (
        <rect key={p.id} x={p.x} y={0} width={p.w} height={H} fill="rgba(0,0,0,0.12)" />
      ))}
      {calc.folds.map((f, i) => (
        <line key={i} x1={f.x} x2={f.x} y1={-w} y2={H + w} stroke={f.kind === 'score' ? 'rgba(40,170,120,0.6)' : FOLD} {...hair} strokeDasharray={f.kind === 'score' ? '2 4' : '6 3'} />
      ))}
      {calc.panels.map((p) => (
        <text key={`t${p.id}`} x={p.x + p.w / 2} y={-w - 6} textAnchor="middle" fontSize={8} fill="rgba(240,235,225,0.55)" style={{ fontFamily: 'ui-sans-serif, system-ui', letterSpacing: '0.08em' }}>
          {p.label.toUpperCase()}
        </text>
      ))}
      {calc.bands.map((by, i) => {
        const sp = calc.panels.find((p) => p.id === 'spine')!;
        return <line key={`band${i}`} x1={sp.x} x2={sp.x + sp.w} y1={by} y2={by} stroke="rgba(201,162,39,0.8)" {...hair} />;
      })}
      {calc.stabHoles.map((h, i) => {
        const sp = calc.panels.find((p) => p.id === 'front')!;
        const x = calc.panels.findIndex((p) => p.id === 'front') < calc.panels.findIndex((p) => p.id === 'spine') ? sp.x + sp.w - h.x : sp.x + h.x;
        return <circle key={`h${i}`} cx={x} cy={h.y} r={2.5} stroke={FOLD} {...hair} />;
      })}
    </g>
  );
}

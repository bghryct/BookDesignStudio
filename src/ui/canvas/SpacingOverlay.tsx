import React from 'react';
import type { Element, Project, TextElement } from '../../model/types';
import type { PanelLayout as BindingCalc } from './geometry';
import { layoutText } from '../../render/compile';
import type { LineInfo } from '../../engine/textLayout';
import { sceneMatrix, type SurfaceDesc } from './geometry';

/** Summary of a frame's spacing for the inspector (Hochuli / Bringhurst checks). */
export interface SpacingReport { lines: number; avgChars: number; loose: number; tight: number; hyphens: number; ladder: number }

export function spacingReport(lines: LineInfo[]): SpacingReport {
  const body = lines.filter((l) => !l.last && (l.chars ?? 0) > 0);
  const avgChars = body.length ? body.reduce((n, l) => n + (l.chars ?? 0), 0) / body.length : 0;
  let ladder = 0, run = 0, hyphens = 0;
  for (const l of lines) {
    if (l.hyphenated) { hyphens++; run++; ladder = Math.max(ladder, run); } else run = 0;
  }
  return {
    lines: lines.length,
    avgChars,
    loose: body.filter((l) => l.justified && (l.ratio ?? 0) > 1).length,
    tight: body.filter((l) => (l.ratio ?? 0) < -0.5).length,
    hyphens,
    ladder,
  };
}

/**
 * Draws the micro-typographic state of every text frame on the spread: loose lines (spaces
 * stretched past their ideal) tinted red, tight lines blue, hyphenated lines ticked in the
 * margin, and runs of three or more hyphens ("ladders") flagged.
 */
export function SpacingOverlay({ project, items, calc }: { project: Project; items: { el: Element; surface: SurfaceDesc }[]; calc: BindingCalc | null }) {
  return (
    <g pointerEvents="none">
      {items.filter((x) => x.el.type === 'text' && !x.el.hidden).map(({ el, surface }) => {
        const t = el as TextElement;
        if (t.style.writingMode === 'vertical') return null;
        let lines: LineInfo[] = [];
        try {
          lines = layoutText(t, { project, surface: surface.key, pageIndex: surface.pageIndex, side: surface.side }).lines;
        } catch {
          return null;
        }
        const m = sceneMatrix(el, surface, calc);
        const lead = t.style.leading;
        const ladderSet = new Set<number>();
        let run: number[] = [];
        lines.forEach((l, i) => {
          if (l.hyphenated) run.push(i);
          else { if (run.length >= 3) run.forEach((k) => ladderSet.add(k)); run = []; }
        });
        if (run.length >= 3) run.forEach((k) => ladderSet.add(k));
        return (
          <g key={el.id} transform={`matrix(${m.join(' ')})`}>
            {lines.map((l, i) => {
              const r = l.ratio ?? 0;
              const top = l.y - lead * 0.78, h = lead * 0.96;
              const loose = l.justified && !l.last && r > 0.6;
              const tight = r < -0.35;
              return (
                <g key={i}>
                  {loose && <rect x={l.x} y={top} width={l.w} height={h} fill="#e5483a" opacity={Math.min(0.42, 0.1 + (r - 0.6) * 0.25)} />}
                  {tight && <rect x={l.x} y={top} width={l.w} height={h} fill="#3b82f6" opacity={Math.min(0.4, 0.1 + (-r - 0.35) * 0.5)} />}
                  {l.hyphenated && <rect x={l.x + l.w + 2} y={top + h * 0.3} width={ladderSet.has(i) ? 4 : 2} height={h * 0.4} fill={ladderSet.has(i) ? '#e5483a' : '#f0a020'} />}
                </g>
              );
            })}
          </g>
        );
      })}
    </g>
  );
}

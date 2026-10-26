import React from 'react';
import type { Element, Project, TextElement } from '../../model/types';
import type { PanelLayout as BindingCalc } from './geometry';
import { layoutText } from '../../render/compile';
import type { LineInfo } from '../../engine/textLayout';
import type { Prim, TextRun } from '../../render/primitives';
import { measure } from '../../engine/fonts';
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
                  {loose && <rect x={l.x} y={top} width={Math.max(0, l.w)} height={Math.max(0, h)} fill="#e5483a" opacity={Math.min(0.42, 0.1 + (r - 0.6) * 0.25)} />}
                  {tight && <rect x={l.x} y={top} width={Math.max(0, l.w)} height={Math.max(0, h)} fill="#3b82f6" opacity={Math.min(0.4, 0.1 + (-r - 0.35) * 0.5)} />}
                  {l.hyphenated && <rect x={l.x + l.w + 2} y={top + h * 0.3} width={ladderSet.has(i) ? 4 : 2} height={Math.max(0, h * 0.4)} fill={ladderSet.has(i) ? '#e5483a' : '#f0a020'} />}
                </g>
              );
            })}
          </g>
        );
      })}
    </g>
  );
}

const INV = '#2f7de1';

/** Text runs of a frame layout, with the offsets of the groups that hold them. */
function collectRuns(prims: Prim[], dx: number, dy: number, out: { r: TextRun; dx: number; dy: number }[]) {
  for (const p of prims) {
    if (p.t === 'text') for (const r of p.runs) out.push({ r, dx, dy });
    else if (p.t === 'group' && p.matrix && p.matrix[0] === 1 && p.matrix[3] === 1 && !p.matrix[1] && !p.matrix[2]) collectRuns(p.children, dx + p.matrix[4], dy + p.matrix[5], out);
  }
}

/**
 * Hidden characters (InDesign's Type › Show Hidden Characters): word spaces as raised dots,
 * non-breaking spaces as small rings, paragraph returns ¶ and forced line breaks ¬, in blue.
 */
export function InvisiblesOverlay({ project, items, calc }: { project: Project; items: { el: Element; surface: SurfaceDesc }[]; calc: BindingCalc | null }) {
  return (
    <g pointerEvents="none">
      {items.filter((x) => x.el.type === 'text' && !x.el.hidden).map(({ el, surface }) => {
        const t = el as TextElement;
        if (t.style.writingMode === 'vertical') return null;
        let layout;
        try { layout = layoutText(t, { project, surface: surface.key, pageIndex: surface.pageIndex, side: surface.side }); } catch { return null; }
        const m = sceneMatrix(el, surface, calc);
        const marks: React.ReactNode[] = [];
        const runs: { r: TextRun; dx: number; dy: number }[] = [];
        collectRuns(layout.prims, 0, 0, runs);
        let prev: { r: TextRun; dx: number; dy: number } | null = null;
        runs.forEach(({ r, dx, dy }, k) => {
          if (r.rotate || r.dir === 'rtl') { prev = null; return; }
          const sx = r.scaleX ?? 1;
          const dotR = Math.max(0.25, r.size * 0.045);
          const dotY = r.y + dy - r.size * 0.24;
          // Spaces inside the run.
          if (/[\s\u00a0\u202f]/.test(r.text)) {
            const ls = r.letterSpacing ?? 0;
            const sp = measure(' ', r.font, r.size);
            for (let i = 0; i < r.text.length; i++) {
              const ch = r.text[i];
              if (ch !== ' ' && ch !== '\u00a0' && ch !== '\u202f') continue;
              let kern = 0;
              if (r.kern) for (let j = 0; j < i; j++) kern += r.kern[j] ?? 0;
              const x = r.x + dx + sx * (measure(r.text.slice(0, i), r.font, r.size) + ls * i + kern + sp / 2);
              marks.push(ch === ' '
                ? <circle key={`s${k}-${i}`} cx={x} cy={dotY} r={dotR} fill={INV} />
                : <circle key={`s${k}-${i}`} cx={x} cy={dotY - r.size * 0.12} r={dotR * 1.6} fill="none" stroke={INV} strokeWidth={dotR * 0.6} />);
            }
          }
          // A gap between two runs on one baseline is a word space set as glue.
          if (prev && prev.r.y + prev.dy === r.y + dy && r.text && prev.r.text && !/\s$/.test(prev.r.text) && !/^\s/.test(r.text)) {
            const pEnd = prev.r.x + prev.dx + prev.r.width;
            const gap = r.x + dx - pEnd;
            if (gap > r.size * 0.12) marks.push(<circle key={`g${k}`} cx={pEnd + gap / 2} cy={dotY} r={dotR} fill={INV} />);
          }
          prev = { r, dx, dy };
        });
        // Paragraph returns and forced line breaks after the last character of the line.
        const fs = t.style.fontSize * 0.75;
        layout.lines.forEach((l, i) => {
          if (!l.end) return;
          marks.push(<text key={`e${i}`} x={(l.xEnd ?? l.x) + fs * 0.2} y={l.y} fontSize={fs} fill={INV} fontFamily="Helvetica, Arial, sans-serif">{l.end === 'para' ? '¶' : '¬'}</text>);
        });
        if (!layout.overflow && layout.lines.length) {
          const l = layout.lines[layout.lines.length - 1];
          if (l.end === 'para') marks.push(<text key="end" x={(l.xEnd ?? l.x) + fs * 1.0} y={l.y} fontSize={fs * 0.9} fill={INV} fontFamily="Helvetica, Arial, sans-serif">#</text>);
        }
        return <g key={el.id} transform={`matrix(${m.join(' ')})`}>{marks}</g>;
      })}
    </g>
  );
}

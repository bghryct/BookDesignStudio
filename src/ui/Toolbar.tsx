import React from 'react';
import clsx from 'clsx';
import {
  MousePointer2, Spline, Type, Square, Circle, Star, Minus, PenTool, Image, Brush, Eraser, Orbit, Flower2, TextInitial,
  Blend, Sparkles, Scissors, Grid3x3, Hand, ZoomIn, LayoutGrid, Ruler, CaseSensitive, Library,
} from 'lucide-react';
import { useStore, type Tool } from '../store/store';

interface ToolDef { id: Tool; icon: React.ReactNode; label: string; key?: string; hint?: string }

const GROUPS: ToolDef[][] = [
  [
    { id: 'select', icon: <MousePointer2 size={16} />, label: 'Select & transform', key: 'V', hint: 'Shift: add · Alt-click: select beneath · drag handles to resize, circle to rotate' },
    { id: 'node', icon: <Spline size={16} />, label: 'Direct selection (path nodes)', key: 'A' },
  ],
  [
    { id: 'text', icon: <Type size={16} />, label: 'Text frame', key: 'T', hint: 'Click in a column to frame it to the foot of the text block' },
    { id: 'rect', icon: <Square size={16} />, label: 'Rectangle', key: 'R' },
    { id: 'ellipse', icon: <Circle size={16} />, label: 'Ellipse', key: 'E' },
    { id: 'polygon', icon: <Star size={16} />, label: 'Polygon / star' },
    { id: 'line', icon: <Minus size={16} />, label: 'Rule', key: 'L' },
    { id: 'pen', icon: <PenTool size={16} />, label: 'Pen (Bézier)', key: 'P', hint: 'Click for corners, drag for curves, click the first point to close, Enter to finish' },
    { id: 'image', icon: <Image size={16} />, label: 'Image frame', key: 'I' },
  ],
  [
    { id: 'brush', icon: <Brush size={16} />, label: 'Brushes — watercolour, pencil, crayon, marker…', key: 'B', hint: '[ ] change size' },
    { id: 'eraser', icon: <Eraser size={16} />, label: 'Eraser', key: 'X' },
  ],
  [
    { id: 'pattern', icon: <Orbit size={16} />, label: 'Kinetic pattern (Schrofer)', key: 'K' },
    { id: 'ornament', icon: <Flower2 size={16} />, label: 'Marginalia & borders (Cleves)', key: 'O', hint: 'Click a page to frame its text block' },
    { id: 'initial', icon: <TextInitial size={16} />, label: 'Illuminated initial' },
    { id: 'overprint', icon: <Blend size={16} />, label: 'Overprint monoprint (Martens)' },
    { id: 'gradient', icon: <Sparkles size={16} />, label: 'Tonal gradient (Sato)', key: 'G' },
    { id: 'gridtype', icon: <Grid3x3 size={16} />, label: 'Grid alphabet (Crouwel)' },
    { id: 'cutout', icon: <Scissors size={16} />, label: 'Die-cut window (Munari)', key: 'D' },
  ],
  [
    { id: 'grid-diagram', icon: <LayoutGrid size={16} />, label: 'Grid diagram (teaching)', hint: 'Drag a box to draw a visible field grid' },
    { id: 'dimension', icon: <Ruler size={16} />, label: 'Dimension line', key: 'M', hint: 'Drag to measure; the label shows the length in document units' },
    { id: 'specimen', icon: <CaseSensitive size={16} />, label: 'Type specimen (waterfall)', hint: 'Drag a box; pick the typeface in the inspector' },
  ],
  [
    { id: 'hand', icon: <Hand size={16} />, label: 'Hand (or hold Space)', key: 'H' },
    { id: 'zoom', icon: <ZoomIn size={16} />, label: 'Zoom (Alt to zoom out)', key: 'Z' },
  ],
];

export function Toolbar() {
  const tool = useStore((s) => s.tool);
  const setTool = useStore((s) => s.setTool);
  return (
    <nav className="scroll-thin flex w-10 shrink-0 flex-col items-center gap-0.5 overflow-y-auto border-r border-ink-700 bg-ink-900 py-1.5" aria-label="Tools">
      <button
        type="button"
        title="Element library — designs by Cleves, Diehl, Munari, Crouwel, Martens, Schrofer, Tschichold, Bringhurst, Bosshard, Müller-Brockmann, Hochuli, Unger, Caflisch, Sato"
        aria-label="Element library"
        onClick={() => useStore.getState().setLeftTab('library')}
        className="mb-1 inline-flex h-8 w-8 items-center justify-center rounded-[6px] text-gold hover:bg-ink-700"
      >
        <Library size={16} />
      </button>
      {GROUPS.map((g, gi) => (
        <React.Fragment key={gi}>
          {gi > 0 && <div className="my-1 h-px w-5 bg-ink-700" />}
          {g.map((t) => (
            <button
              key={t.id}
              type="button"
              title={`${t.label}${t.key ? ` (${t.key})` : ''}${t.hint ? ` — ${t.hint}` : ''}`}
              aria-label={t.label}
              onClick={() => setTool(t.id)}
              className={clsx(
                'inline-flex h-8 w-8 items-center justify-center rounded-[6px] transition-colors',
                tool === t.id ? 'bg-rubric text-white' : 'text-ink-300 hover:bg-ink-700 hover:text-ink-100',
              )}
            >
              {t.icon}
            </button>
          ))}
        </React.Fragment>
      ))}
    </nav>
  );
}

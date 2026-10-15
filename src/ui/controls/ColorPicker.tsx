import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import clsx from 'clsx';
import { Pipette } from 'lucide-react';
import type { CMYK } from '../../model/types';
import { parseColor, rgbToCmyk, toHex } from '../../lib/color';

/* -------------------------------------------------------------------------- */
/* Colour maths                                                                */
/* -------------------------------------------------------------------------- */

interface HSV { h: number; s: number; v: number } // h 0–360, s/v 0–1

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

function hexToHsv(hex: string): HSV {
  const { r, g, b } = parseColor(hex);
  const R = r / 255, G = g / 255, B = b / 255;
  const max = Math.max(R, G, B), min = Math.min(R, G, B), d = max - min;
  let h = 0;
  if (d > 1e-9) {
    if (max === R) h = ((G - B) / d) % 6;
    else if (max === G) h = (B - R) / d + 2;
    else h = (R - G) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: max === 0 ? 0 : d / max, v: max };
}

function hsvToHex({ h, s, v }: HSV): string {
  const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
  const [r, g, b] =
    h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return toHex({ r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255 });
}

/** Normalises any CSS colour the app stores (#rgb, #rrggbb, rgb()) to lowercase #rrggbb. */
export const normalizeHex = (c: string) => toHex(parseColor(c)).toLowerCase();

const HEX_RE = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;

/* -------------------------------------------------------------------------- */
/* Palettes                                                                    */
/* -------------------------------------------------------------------------- */

/** Historical pigments for painters and illuminators (approximate sRGB). */
export const ARTIST_PALETTE: { name: string; hex: string; note: string }[] = [
  { name: 'French ultramarine', hex: '#1f3a93', note: 'synthetic ultramarine blue' },
  { name: 'Lapis lazuli', hex: '#26619c', note: 'natural ultramarine — the illuminators’ most precious blue' },
  { name: 'Vermilion', hex: '#e03c28', note: 'mercuric sulphide red of rubrics and initials' },
  { name: 'Madder lake', hex: '#a3243b', note: 'transparent rose-crimson glaze' },
  { name: 'Burnt sienna', hex: '#8a3a22', note: 'warm transparent earth' },
  { name: 'Yellow ochre', hex: '#c8962e', note: 'opaque natural earth yellow' },
  { name: 'Sap green', hex: '#4f7a28', note: 'buckthorn-berry lake green' },
  { name: 'Verdigris', hex: '#3fa592', note: 'copper acetate green-blue' },
  { name: 'Indigo', hex: '#2b2f5a', note: 'deep vegetable blue' },
  { name: 'Lamp black', hex: '#1c1b1a', note: 'soot carbon black' },
  { name: 'Payne’s grey', hex: '#3e4a56', note: 'blue-black mixing grey' },
  { name: 'Chinese white', hex: '#f6f4ee', note: 'zinc white body colour' },
  { name: 'Gold ochre', hex: '#c2862b', note: 'warm golden earth' },
];

/* -------------------------------------------------------------------------- */
/* Recent colours (shared by every picker, persisted)                          */
/* -------------------------------------------------------------------------- */

const RECENT_KEY = 'bds.recentColors';
const RECENT_MAX = 14;
let recent: string[] = (() => {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((c): c is string => typeof c === 'string' && HEX_RE.test(c)).slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
})();
const recentListeners = new Set<() => void>();

export function pushRecentColor(hex: string): void {
  if (!HEX_RE.test(hex)) return;
  const h = normalizeHex(hex);
  if (recent[0] === h) return;
  recent = [h, ...recent.filter((c) => c !== h)].slice(0, RECENT_MAX);
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(recent)); } catch { /* storage unavailable */ }
  recentListeners.forEach((l) => l());
}

function useRecentColors(): string[] {
  return useSyncExternalStore(
    (cb) => { recentListeners.add(cb); return () => { recentListeners.delete(cb); }; },
    () => recent,
  );
}

/* -------------------------------------------------------------------------- */
/* EyeDropper (Chromium only)                                                  */
/* -------------------------------------------------------------------------- */

interface EyeDropperLike { open: () => Promise<{ sRGBHex: string }> }
type EyeDropperCtor = new () => EyeDropperLike;
const eyeDropper = (): EyeDropperCtor | undefined =>
  typeof window === 'undefined' ? undefined : (window as unknown as { EyeDropper?: EyeDropperCtor }).EyeDropper;

/* -------------------------------------------------------------------------- */
/* Picker                                                                      */
/* -------------------------------------------------------------------------- */

export interface PickerSwatch { name: string; hex: string; cmyk?: CMYK }

/**
 * Inline colour picker: HSV square + hue strip (pointer-draggable), hex entry,
 * eyedropper, project swatches, an artists' pigment palette, recent colours
 * and the approximate CMYK build.
 */
export function ColorPicker({ value, onChange, swatches, compact }: {
  value: string;
  onChange: (hex: string) => void;
  swatches?: PickerSwatch[];
  compact?: boolean;
}) {
  const hex = normalizeHex(value || '#000000');
  const [hsv, setHsvState] = useState<HSV>(() => hexToHsv(hex));
  // Mirror of `hsv` for handlers that fire before the next render (drag end → recent colours).
  const hsvRef = useRef(hsv);
  const setHsv = (n: HSV | ((o: HSV) => HSV)) => {
    const next = typeof n === 'function' ? n(hsvRef.current) : n;
    hsvRef.current = next;
    setHsvState(next);
  };
  // Follow external changes, keeping hue (and saturation) where black / grey make them undefined.
  useEffect(() => {
    if (hsvToHex(hsv).toLowerCase() === hex) return;
    const n = hexToHsv(hex);
    setHsv((o) => ({ h: n.s === 0 || n.v === 0 ? o.h : n.h, s: n.v === 0 ? o.s : n.s, v: n.v }));
  }, [hex]); // eslint-disable-line react-hooks/exhaustive-deps

  const emit = (n: HSV) => {
    setHsv(n);
    const out = hsvToHex(n).toLowerCase();
    if (out !== hex) onChange(out);
  };
  const commit = (c?: string) => pushRecentColor(c ?? hsvToHex(hsvRef.current));

  /* Dragging --------------------------------------------------------------- */
  const svRef = useRef<HTMLDivElement>(null);
  const hueRef = useRef<HTMLDivElement>(null);
  const drag = useRef<'sv' | 'hue' | null>(null);
  const fromPointer = (e: React.PointerEvent, which: 'sv' | 'hue') => {
    const el = (which === 'sv' ? svRef : hueRef).current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const x = clamp01((e.clientX - r.left) / r.width), y = clamp01((e.clientY - r.top) / r.height);
    const cur = hsvRef.current;
    if (which === 'sv') emit({ h: cur.h, s: x, v: 1 - y });
    else emit({ ...cur, h: Math.min(359.9, x * 360) });
  };
  const handlers = (which: 'sv' | 'hue') => ({
    onPointerDown: (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      (e.currentTarget as HTMLElement).focus();
      drag.current = which;
      fromPointer(e, which);
    },
    onPointerMove: (e: React.PointerEvent) => { if (drag.current === which) fromPointer(e, which); },
    onPointerUp: (e: React.PointerEvent) => {
      if (drag.current !== which) return;
      drag.current = null;
      if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
      commit();
    },
    onPointerCancel: () => { drag.current = null; },
  });
  const svKeys = (e: React.KeyboardEvent) => {
    const d = e.shiftKey ? 0.1 : 0.01;
    const k: Record<string, [number, number]> = { ArrowLeft: [-d, 0], ArrowRight: [d, 0], ArrowUp: [0, d], ArrowDown: [0, -d] };
    const m = k[e.key];
    if (!m) return;
    e.preventDefault();
    emit({ h: hsv.h, s: clamp01(hsv.s + m[0]), v: clamp01(hsv.v + m[1]) });
  };
  const hueKeys = (e: React.KeyboardEvent) => {
    const d = e.shiftKey ? 10 : 1;
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    emit({ ...hsv, h: Math.max(0, Math.min(359.9, hsv.h + (e.key === 'ArrowRight' ? d : -d))) });
  };

  /* Hex entry -------------------------------------------------------------- */
  const [text, setText] = useState(hex);
  const [editing, setEditing] = useState(false);
  useEffect(() => { if (!editing) setText(hex); }, [hex, editing]);
  const applyText = (raw: string, final: boolean) => {
    const t = raw.trim();
    if (!HEX_RE.test(t)) return;
    const h = normalizeHex(t.startsWith('#') ? t : `#${t}`);
    if (h !== hex) onChange(h);
    if (final) commit(h);
  };

  const pickSwatch = (c: string) => {
    const h = normalizeHex(c);
    setHsv(hexToHsv(h));
    if (h !== hex) onChange(h);
    commit(h);
  };

  const ED = eyeDropper();
  const sample = async () => {
    if (!ED) return;
    try {
      const res = await new ED().open();
      pickSwatch(res.sRGBHex);
    } catch { /* cancelled */ }
  };

  const recentColors = useRecentColors();
  const match = swatches?.find((s) => normalizeHex(s.hex) === hex);
  const cmyk = match?.cmyk ?? rgbToCmyk(hex);
  const pigment = ARTIST_PALETTE.find((p) => p.hex === hex);
  const pureHue = hsvToHex({ h: hsv.h, s: 1, v: 1 });

  const chip = (c: string, title: string, key: string) => (
    <button
      key={key}
      type="button"
      title={title}
      aria-label={title}
      onClick={() => pickSwatch(c)}
      className={clsx(
        'aspect-square w-full rounded-[3px] border transition-transform hover:scale-110',
        normalizeHex(c) === hex ? 'border-white ring-1 ring-white/60' : 'border-white/15',
      )}
      style={{ background: c }}
    />
  );
  const heading = (t: string) => <div className="mb-1 mt-2 text-[10px] font-medium uppercase tracking-[0.08em] text-ink-500">{t}</div>;
  const grid = 'grid grid-cols-[repeat(auto-fill,minmax(17px,1fr))] gap-[5px]';

  return (
    <div className="select-none">
      <div
        ref={svRef}
        role="slider"
        tabIndex={0}
        aria-label="Saturation and brightness"
        aria-valuetext={`saturation ${Math.round(hsv.s * 100)}%, brightness ${Math.round(hsv.v * 100)}%`}
        className={clsx('relative w-full cursor-crosshair touch-none rounded-[5px] outline-none focus-visible:ring-1 focus-visible:ring-rubric', compact ? 'h-[112px]' : 'h-[140px]')}
        style={{ background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, ${pureHue})` }}
        onKeyDown={svKeys}
        {...handlers('sv')}
      >
        <span
          className="pointer-events-none absolute h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-[0_0_0_1px_rgba(0,0,0,0.5)]"
          style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%`, background: hex }}
        />
      </div>
      <div
        ref={hueRef}
        role="slider"
        tabIndex={0}
        aria-label="Hue"
        aria-valuemin={0}
        aria-valuemax={360}
        aria-valuenow={Math.round(hsv.h)}
        className="relative mt-2 h-3 w-full cursor-ew-resize touch-none rounded-full outline-none focus-visible:ring-1 focus-visible:ring-rubric"
        style={{ background: 'linear-gradient(to right, #f00, #ff0 17%, #0f0 33%, #0ff 50%, #00f 67%, #f0f 83%, #f00)' }}
        onKeyDown={hueKeys}
        {...handlers('hue')}
      >
        <span
          className="pointer-events-none absolute top-1/2 h-4 w-2 -translate-x-1/2 -translate-y-1/2 rounded-[3px] border-2 border-white shadow-[0_0_0_1px_rgba(0,0,0,0.5)]"
          style={{ left: `${(hsv.h / 360) * 100}%`, background: pureHue }}
        />
      </div>

      <div className="mt-2 flex items-center gap-1.5">
        <span className="h-7 w-7 shrink-0 rounded-[5px] border border-white/15" style={{ background: hex }} />
        <input
          className="h-7 min-w-0 flex-1 rounded-[5px] border border-ink-700 bg-ink-900 px-1.5 font-mono text-[11px] uppercase text-ink-100 outline-none focus:border-ink-400"
          value={text}
          spellCheck={false}
          aria-label="Hex colour"
          onFocus={(e) => { setEditing(true); e.target.select(); }}
          onBlur={() => { setEditing(false); applyText(text, true); }}
          onChange={(e) => { setText(e.target.value); applyText(e.target.value, false); }}
          onKeyDown={(e) => { if (e.key === 'Enter') { applyText(text, true); (e.target as HTMLInputElement).blur(); } }}
        />
        {ED && (
          <button
            type="button"
            title="Pick a colour from the screen"
            aria-label="Eyedropper"
            onClick={sample}
            className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-[5px] border border-ink-700 bg-ink-900 text-ink-300 hover:border-ink-500 hover:text-ink-100"
          >
            <Pipette size={13} />
          </button>
        )}
      </div>
      <p className="mt-1 truncate font-mono text-[10px] text-ink-400" title={match?.cmyk ? 'Exact process build of the swatch' : 'Approximate device CMYK (GCR 100%)'}>
        {match?.cmyk ? '' : '≈ '}C{Math.round(cmyk.c)} M{Math.round(cmyk.m)} Y{Math.round(cmyk.y)} K{Math.round(cmyk.k)}
        {(match || pigment) && <span className="font-sans text-ink-300"> · {match?.name ?? pigment?.name}</span>}
      </p>

      {!!swatches?.length && (
        <>
          {heading('Project swatches')}
          <div className={grid}>
            {swatches.map((s, i) => chip(s.hex, `${s.name}${s.cmyk ? ` — C${s.cmyk.c} M${s.cmyk.m} Y${s.cmyk.y} K${s.cmyk.k}` : ''}`, `p${i}`))}
          </div>
        </>
      )}
      {heading('Artists’ pigments')}
      <div className={grid}>
        {ARTIST_PALETTE.map((p) => chip(p.hex, `${p.name} — ${p.note}`, p.name))}
      </div>
      {!!recentColors.length && (
        <>
          {heading('Recent')}
          <div className={grid}>{recentColors.map((c) => chip(c, c, `r${c}`))}</div>
        </>
      )}
    </div>
  );
}

import React, { useEffect, useRef, useState, type ReactNode } from 'react';
import clsx from 'clsx';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { Unit } from '../../model/types';
import { fromPt, parseLength, UNIT_DECIMALS, UNIT_STEP, toPt } from '../../model/units';
import { useStore } from '../../store/store';
import { rgbToCmyk } from '../../lib/color';

/* -------------------------------------------------------------------------- */
/* Layout                                                                      */
/* -------------------------------------------------------------------------- */

export function Section({ title, children, defaultOpen = true, right, id }: { title: string; children: ReactNode; defaultOpen?: boolean; right?: ReactNode; id?: string }) {
  const key = `bds.section.${id ?? title}`;
  const [open, setOpen] = useState(() => {
    try {
      const v = localStorage.getItem(key);
      return v == null ? defaultOpen : v === '1';
    } catch {
      return defaultOpen;
    }
  });
  const toggle = () => {
    setOpen(!open);
    try { localStorage.setItem(key, open ? '0' : '1'); } catch { /* storage unavailable */ }
  };
  return (
    <section className="border-b border-ink-700/70">
      <header className="flex h-8 items-center gap-1 px-3">
        <button type="button" onClick={toggle} className="flex flex-1 items-center gap-1.5 text-left text-[10.5px] font-semibold uppercase tracking-[0.08em] text-ink-300 hover:text-ink-100">
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          {title}
        </button>
        {right}
      </header>
      {open && <div className="space-y-2 px-3 pb-3">{children}</div>}
    </section>
  );
}

export function Row({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={clsx('grid grid-cols-2 gap-2', className)}>{children}</div>;
}

export function Label({ children, hint }: { children: ReactNode; hint?: string }) {
  return (
    <span className="block truncate text-[10.5px] text-ink-400" title={hint}>
      {children}
    </span>
  );
}

export function Hint({ children }: { children: ReactNode }) {
  return <p className="text-[10.5px] leading-snug text-ink-400">{children}</p>;
}

/* -------------------------------------------------------------------------- */
/* Numeric input with scrubbing                                                */
/* -------------------------------------------------------------------------- */

interface NumberFieldProps {
  label?: string;
  value: number;
  onChange: (v: number) => void;
  /** Interpret value as a length in pt and display in the document unit. */
  length?: boolean;
  unit?: string;
  min?: number;
  max?: number;
  step?: number;
  decimals?: number;
  hint?: string;
  className?: string;
  disabled?: boolean;
  icon?: ReactNode;
  /** Called on scrub start so the caller can checkpoint history. */
  onScrubStart?: () => void;
}

export function NumberField({ label, value, onChange, length, unit, min, max, step, decimals, hint, className, disabled, icon, onScrubStart }: NumberFieldProps) {
  const docUnit = useStore((s) => s.project.book.unit) as Unit;
  const shown = length ? fromPt(value, docUnit) : value;
  const dec = decimals ?? (length ? UNIT_DECIMALS[docUnit] : 2);
  const st = step ?? (length ? UNIT_STEP[docUnit] : 1);
  const fmt = (v: number) => (Number.isFinite(v) ? String(+v.toFixed(dec)) : '');
  const [text, setText] = useState(fmt(shown));
  const [focused, setFocused] = useState(false);
  useEffect(() => { if (!focused) setText(fmt(shown)); }, [shown, focused]); // eslint-disable-line react-hooks/exhaustive-deps

  const clamp = (v: number) => Math.max(min ?? -Infinity, Math.min(max ?? Infinity, v));
  const commit = (raw: string) => {
    let v: number | null;
    if (length) v = parseLength(raw, docUnit);
    else {
      try {
        // Allow simple arithmetic like "12*1.5".
        v = /^[\d\s.+\-*/()]+$/.test(raw) ? Number(Function(`"use strict";return (${raw})`)()) : parseFloat(raw);
      } catch {
        v = parseFloat(raw);
      }
    }
    if (v == null || !Number.isFinite(v)) { setText(fmt(shown)); return; }
    const outPt = length ? clamp(v) : clamp(v);
    onChange(outPt);
  };

  const scrub = useRef<{ x: number; v: number } | null>(null);
  const onPointerDown = (e: React.PointerEvent) => {
    if (disabled) return;
    e.preventDefault();
    scrub.current = { x: e.clientX, v: value };
    onScrubStart?.();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!scrub.current) return;
    const dx = e.clientX - scrub.current.x;
    const mult = e.shiftKey ? 10 : e.altKey ? 0.1 : 1;
    const delta = (dx / 2) * st * mult;
    onChange(clamp(scrub.current.v + (length ? toPt(delta, docUnit) : delta)));
  };
  const onPointerUp = () => { scrub.current = null; };

  return (
    <label className={clsx('block min-w-0', className)} title={hint}>
      {label && (
        <span
          className={clsx('mb-0.5 flex cursor-ew-resize select-none items-center gap-1 text-[10.5px] text-ink-400 hover:text-ink-200', disabled && 'cursor-default')}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
        >
          {icon}
          {label}
        </span>
      )}
      <div className={clsx('flex h-7 items-center rounded-[5px] border border-ink-700 bg-ink-900 focus-within:border-ink-400', disabled && 'opacity-50')}>
        {!label && icon && (
          <span className="cursor-ew-resize pl-1.5 text-ink-400" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}>{icon}</span>
        )}
        <input
          className="h-full w-full min-w-0 bg-transparent px-1.5 text-[11.5px] tabular-nums text-ink-100 outline-none"
          value={text}
          disabled={disabled}
          onFocus={(e) => { setFocused(true); e.target.select(); }}
          onBlur={() => { setFocused(false); commit(text); }}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { commit(text); (e.target as HTMLInputElement).blur(); }
            if (e.key === 'Escape') { setText(fmt(shown)); (e.target as HTMLInputElement).blur(); }
            if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
              e.preventDefault();
              const dir = e.key === 'ArrowUp' ? 1 : -1;
              const mult = e.shiftKey ? 10 : e.altKey ? 0.1 : 1;
              const next = shown + dir * st * mult;
              onChange(clamp(length ? toPt(next, docUnit) : next));
            }
          }}
        />
        <span className="pr-1.5 text-[10px] text-ink-500">{length ? docUnit : unit}</span>
      </div>
    </label>
  );
}

/* -------------------------------------------------------------------------- */
/* Slider                                                                      */
/* -------------------------------------------------------------------------- */

export function Slider({ label, value, onChange, min, max, step = 0.01, format, hint, onStart }: {
  label: string; value: number; onChange: (v: number) => void; min: number; max: number; step?: number;
  format?: (v: number) => string; hint?: string; onStart?: () => void;
}) {
  return (
    <label className="block" title={hint}>
      <span className="flex items-center justify-between text-[10.5px] text-ink-400">
        <span className="truncate">{label}</span>
        <span className="tabular-nums text-ink-300">{format ? format(value) : +value.toFixed(2)}</span>
      </span>
      <input
        type="range"
        className="w-full"
        min={min}
        max={max}
        step={step}
        value={value}
        onPointerDown={onStart}
        onChange={(e) => onChange(parseFloat(e.target.value))}
      />
    </label>
  );
}

/* -------------------------------------------------------------------------- */
/* Select / toggles                                                            */
/* -------------------------------------------------------------------------- */

export function Select<T extends string | number>({ label, value, options, onChange, hint, className }: {
  label?: string; value: T; options: { value: T; label: string; group?: string }[]; onChange: (v: T) => void; hint?: string; className?: string;
}) {
  const groups = [...new Set(options.map((o) => o.group ?? ''))];
  return (
    <label className={clsx('block min-w-0', className)} title={hint}>
      {label && <Label>{label}</Label>}
      <div className="relative mt-0.5">
        <select
          className="h-7 w-full appearance-none truncate rounded-[5px] border border-ink-700 bg-ink-900 pl-2 pr-6 text-[11.5px] text-ink-100 outline-none focus:border-ink-400"
          value={String(value)}
          onChange={(e) => {
            const o = options.find((x) => String(x.value) === e.target.value);
            if (o) onChange(o.value);
          }}
        >
          {groups.length > 1
            ? groups.map((g) => (
              <optgroup key={g} label={g}>
                {options.filter((o) => (o.group ?? '') === g).map((o) => <option key={String(o.value)} value={String(o.value)}>{o.label}</option>)}
              </optgroup>
            ))
            : options.map((o) => <option key={String(o.value)} value={String(o.value)}>{o.label}</option>)}
        </select>
        <ChevronDown size={12} className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-ink-400" />
      </div>
    </label>
  );
}

export function Toggle({ label, checked, onChange, hint }: { label: ReactNode; checked: boolean; onChange: (v: boolean) => void; hint?: string }) {
  return (
    <label className="flex cursor-pointer select-none items-center gap-2 text-[11.5px] text-ink-200" title={hint}>
      <span
        className={clsx('relative inline-flex h-[15px] w-[26px] shrink-0 rounded-full transition-colors', checked ? 'bg-rubric' : 'bg-ink-600')}
      >
        <span className={clsx('absolute top-[2px] h-[11px] w-[11px] rounded-full bg-white shadow transition-transform', checked ? 'translate-x-[13px]' : 'translate-x-[2px]')} />
      </span>
      <input type="checkbox" className="sr-only" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="min-w-0 truncate">{label}</span>
    </label>
  );
}

export function Segmented<T extends string>({ value, options, onChange, size = 'md' }: {
  value: T; options: { value: T; label: ReactNode; title?: string }[]; onChange: (v: T) => void; size?: 'sm' | 'md';
}) {
  return (
    <div className="flex rounded-[6px] border border-ink-700 bg-ink-900 p-[2px]">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          title={o.title}
          onClick={() => onChange(o.value)}
          className={clsx(
            'flex flex-1 items-center justify-center gap-1 rounded-[4px] px-1.5 text-[11px] transition-colors',
            size === 'sm' ? 'h-5' : 'h-6',
            value === o.value ? 'bg-ink-600 text-ink-100' : 'text-ink-400 hover:text-ink-200',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function TextInput({ label, value, onChange, placeholder, multiline, rows = 3, className, mono }: {
  label?: string; value: string; onChange: (v: string) => void; placeholder?: string; multiline?: boolean; rows?: number; className?: string; mono?: boolean;
}) {
  const cls = clsx('w-full rounded-[5px] border border-ink-700 bg-ink-900 px-2 text-[11.5px] text-ink-100 outline-none focus:border-ink-400', mono && 'font-mono');
  return (
    <label className={clsx('block', className)}>
      {label && <Label>{label}</Label>}
      {multiline
        ? <textarea className={clsx(cls, 'mt-0.5 py-1.5 leading-relaxed scroll-thin')} rows={rows} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
        : <input className={clsx(cls, 'mt-0.5 h-7')} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />}
    </label>
  );
}

export function Button({ children, onClick, variant = 'default', className, title, disabled, type = 'button' }: {
  children: ReactNode; onClick?: () => void; variant?: 'default' | 'primary' | 'ghost' | 'danger'; className?: string; title?: string; disabled?: boolean; type?: 'button' | 'submit';
}) {
  return (
    <button
      type={type}
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={clsx(
        'inline-flex h-7 items-center justify-center gap-1.5 rounded-[5px] px-2.5 text-[11.5px] font-medium transition-colors disabled:pointer-events-none disabled:opacity-40',
        variant === 'primary' && 'bg-rubric text-white hover:bg-[#e2623f]',
        variant === 'default' && 'border border-ink-600 bg-ink-750 text-ink-100 hover:border-ink-500 hover:bg-ink-700',
        variant === 'ghost' && 'text-ink-300 hover:bg-ink-700 hover:text-ink-100',
        variant === 'danger' && 'border border-ink-600 text-[#f08a73] hover:bg-[#3a1f19]',
        className,
      )}
    >
      {children}
    </button>
  );
}

export function IconButton({ children, onClick, active, title, className, disabled }: {
  children: ReactNode; onClick?: () => void; active?: boolean; title: string; className?: string; disabled?: boolean;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
      className={clsx(
        'inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-[5px] transition-colors disabled:opacity-35',
        active ? 'bg-rubric/90 text-white' : 'text-ink-300 hover:bg-ink-700 hover:text-ink-100',
        className,
      )}
    >
      {children}
    </button>
  );
}

/* -------------------------------------------------------------------------- */
/* Colour                                                                      */
/* -------------------------------------------------------------------------- */

export function ColorField({ label, value, onChange, allowNone, hint }: {
  label?: string; value: string | null; onChange: (v: string | null) => void; allowNone?: boolean; hint?: string;
}) {
  const swatches = useStore((s) => s.project.swatches);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [open]);
  const swatch = value ? swatches.find((s) => s.hex.toLowerCase() === value.toLowerCase()) : null;
  const cmyk = value ? swatch?.cmyk ?? rgbToCmyk(value) : null;
  return (
    <div className="relative min-w-0" ref={ref} title={hint}>
      {label && <Label>{label}</Label>}
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="mt-0.5 flex h-7 w-full items-center gap-2 rounded-[5px] border border-ink-700 bg-ink-900 px-1.5 text-left text-[11.5px] hover:border-ink-500"
      >
        <span className={clsx('h-4 w-4 shrink-0 rounded-[3px] border border-white/15', !value && 'checker')} style={value ? { background: value } : undefined} />
        <span className="truncate text-ink-200">{value ? swatch?.name ?? value : 'None'}</span>
      </button>
      {open && (
        <div className="absolute left-0 top-full z-50 mt-1 w-56 rounded-md border border-ink-600 bg-ink-800 p-2 shadow-2xl">
          <div className="flex items-center gap-2">
            <input type="color" className="h-8 w-10 cursor-pointer" value={value && /^#[0-9a-f]{6}$/i.test(value) ? value : '#000000'} onChange={(e) => onChange(e.target.value)} />
            <input
              className="h-7 w-full rounded border border-ink-700 bg-ink-900 px-1.5 font-mono text-[11px] text-ink-100 outline-none"
              value={value ?? ''}
              placeholder="#000000"
              onChange={(e) => { const v = e.target.value.trim(); if (/^#[0-9a-f]{6}$/i.test(v)) onChange(v); }}
            />
          </div>
          {cmyk && (
            <p className="mt-1.5 font-mono text-[10px] text-ink-400">
              {swatch?.cmyk ? 'Swatch ' : '≈ '}C{Math.round(cmyk.c)} M{Math.round(cmyk.m)} Y{Math.round(cmyk.y)} K{Math.round(cmyk.k)}
            </p>
          )}
          <div className="mt-2 grid grid-cols-8 gap-1">
            {allowNone && (
              <button type="button" title="None" className="checker h-5 w-5 rounded-[3px] border border-white/15" onClick={() => { onChange(null); setOpen(false); }} />
            )}
            {swatches.map((s) => (
              <button
                key={s.id}
                type="button"
                title={`${s.name}${s.cmyk ? ` — C${s.cmyk.c} M${s.cmyk.m} Y${s.cmyk.y} K${s.cmyk.k}` : ''}`}
                className={clsx('h-5 w-5 rounded-[3px] border', value?.toLowerCase() === s.hex.toLowerCase() ? 'border-white' : 'border-white/15')}
                style={{ background: s.hex }}
                onClick={() => { onChange(s.hex); setOpen(false); }}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded border border-ink-600 bg-ink-800 px-1 font-mono text-[10px] text-ink-300">{children}</kbd>;
}

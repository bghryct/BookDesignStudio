/**
 * Repairs a project read from outside (a saved file, the autosave, an older version of the app)
 * so that nothing in it can blank the page: missing parts come from a new project's defaults,
 * elements get their type's defaults for fields they lack, numbers that are not finite (JSON turns
 * NaN and Infinity into null) take the default, and entries that are not elements are dropped.
 * Deliberate nulls ("no fill", "no master") are kept.
 *
 * Copy on write: a sound object is returned as it is, and an object that needs a repair is changed
 * in place only when it is not frozen (store state and shared defaults are), otherwise copied.
 */
import type { Element, ElementType, Project } from './types';
import { makeElement, makeMaster, makePage } from './factory';
import { DEFAULT_SWATCHES, defaultBookSpec } from './defaults';
import { uid } from '../lib/random';

type Obj = Record<string, unknown>;

const TYPES = new Set<ElementType>(['text', 'image', 'shape', 'rule', 'path', 'svg', 'pattern', 'ornament', 'initial', 'overprint', 'gradient', 'cutout', 'drawing', 'gridtype', 'motif', 'table']);
const OPTIONAL_LISTS = ['hyphenDictionary', 'hiddenConditions', 'spellingDictionary', 'autocorrect', 'sections', 'paragraphStyles', 'characterStyles', 'tableStyles', 'cellStyles', 'fonts', 'swatches'] as const;
const SECTION_STYLES = ['arabic', 'roman', 'ROMAN', 'alpha', 'ALPHA'];

const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown) => typeof v === 'string';
const styleDef = (d: unknown) => isObj(d) && str(d.id) && str(d.name) && isObj(d.props);
const ENTRY: Record<(typeof OPTIONAL_LISTS)[number], (d: unknown) => boolean> = {
  hyphenDictionary: str, hiddenConditions: str, spellingDictionary: str,
  autocorrect: (d) => isObj(d) && str(d.from) && str(d.to),
  sections: (d) => isObj(d) && str(d.pageId),
  paragraphStyles: styleDef, characterStyles: styleDef, tableStyles: styleDef, cellStyles: styleDef,
  fonts: (d) => isObj(d) && str(d.id) && str(d.family),
  swatches: (d) => isObj(d) && str(d.id) && str(d.hex),
};

export interface Repairs { count: number }

/** o with o[k] = y: o itself when the value is already there, a copy when o is frozen. */
function put<T extends object>(o: T, k: string, y: unknown): T {
  if ((o as Obj)[k] === y) return o;
  const out = (Object.isFrozen(o) ? (Array.isArray(o) ? [...o] : { ...o }) : o) as Obj;
  out[k] = y;
  return out as T;
}

/** o without key k (copied when frozen). */
function drop<T extends object>(o: T, k: string): T {
  if (!(k in o)) return o;
  const out = (Object.isFrozen(o) ? { ...o } : o) as Obj;
  delete out[k];
  return out as T;
}

/** Same list when every entry is unchanged, so sound frozen state is not copied. */
const sameList = <T>(a: unknown[], b: T[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/** v with non-finite numbers anywhere inside it replaced by 0. */
function fixNumbers(v: unknown, r: Repairs, depth = 0): unknown {
  if (typeof v === 'number') { if (Number.isFinite(v)) return v; r.count++; return 0; }
  if (depth > 12 || !v || typeof v !== 'object') return v;
  let o = v as Obj;
  for (const k of Object.keys(v)) o = put(o, k, fixNumbers((v as Obj)[k], r, depth + 1));
  return o;
}

/** v with every field the template d has, of d's kind; v's extra fields are kept (numbers fixed). */
function fill(v: unknown, d: unknown, r: Repairs, depth = 0): unknown {
  if (typeof d === 'number') {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    const n = typeof v === 'string' ? parseFloat(v) : NaN;
    r.count++;
    return Number.isFinite(n) ? n : d;
  }
  if (v === null) return null;
  if (typeof d === 'boolean') { if (typeof v === 'boolean') return v; if (v !== undefined) r.count++; return v === undefined ? d : !!v; }
  if (typeof d === 'string') { if (typeof v === 'string') return v; if (v !== undefined) r.count++; return d; }
  if (Array.isArray(d)) { if (Array.isArray(v)) return fixNumbers(v, r, depth); if (v !== undefined) r.count++; return d; }
  if (isObj(d)) {
    if (!isObj(v)) { if (v !== undefined) r.count++; return d; }
    if (depth > 8) return fixNumbers(v, r, depth);
    let o = v;
    for (const k of Object.keys(d)) {
      const y = fill(o[k], d[k], r, depth + 1);
      if (!(y === undefined && !(k in o))) o = put(o, k, y);
    }
    for (const k of Object.keys(o)) if (!(k in d)) o = put(o, k, fixNumbers(o[k], r, depth + 1));
    return o;
  }
  return fixNumbers(v, r, depth);
}

const defaultsByType = new Map<string, string>();
/** A fresh copy of a new element's fields, so that repaired elements never share a nested object. */
function elementDefaults(el: Obj): Obj | null {
  const key = el.type === 'motif' ? `motif:${String(el.kind)}` : String(el.type);
  let d = defaultsByType.get(key);
  if (d == null) {
    let made: unknown;
    try { made = makeElement(el.type as ElementType, el.type === 'motif' ? ({ kind: el.kind } as Partial<Element>) : {}); }
    catch { try { made = makeElement(el.type as ElementType); } catch { return null; } }
    d = JSON.stringify(made);
    defaultsByType.set(key, d);
  }
  return JSON.parse(d) as Obj;
}

function elements(list: unknown, r: Repairs): Element[] {
  if (!Array.isArray(list)) { if (list !== undefined) r.count++; return []; }
  const out: Element[] = [];
  for (const e0 of list) {
    if (!isObj(e0) || !TYPES.has(e0.type as ElementType)) { r.count++; continue; }
    const d = elementDefaults(e0);
    if (!d) { r.count++; continue; }
    let e = e0;
    if (typeof e.id !== 'string' || !e.id) { e = put(e, 'id', uid(String(e.type).slice(0, 3))); r.count++; }
    out.push(fill(e, { ...d, id: e.id }, r) as Element);
  }
  return sameList(list, out) ? (list as Element[]) : out;
}

/** A surface record ({ elements } or a master's { left, right }) with its element lists repaired. */
function withElements<T extends Obj>(o: T, keys: string[], r: Repairs): T {
  let out = o;
  for (const k of keys) out = put(out, k, elements(out[k], r));
  return out;
}

/**
 * Repair a project and return it: the input itself when it is sound, otherwise the input changed
 * where it is not frozen and copied where it is. Throws if it is not a project at all.
 */
export function normalizeProject(input: unknown, repairs: Repairs = { count: 0 }): Project {
  if (!isObj(input) || !Array.isArray(input.pages)) throw new Error('Not a Book Design Studio project.');
  const r = repairs;
  let p = input;
  if (p.version !== 1) { p = put(p, 'version', 1); r.count++; }
  if (typeof p.id !== 'string' || !p.id) { p = put(p, 'id', uid('prj')); r.count++; }
  if (typeof p.name !== 'string') { p = put(p, 'name', 'Untitled'); r.count++; }
  p = put(p, 'book', fill(p.book, defaultBookSpec(), r));

  const pageDefaults = makePage() as unknown as Obj;
  const pages0 = p.pages as unknown[];
  const pages = pages0.filter((pg) => isObj(pg) || (r.count++, false)).map((pg0) => {
    let pg = pg0 as Obj;
    if (typeof pg.id !== 'string' || !pg.id) { pg = put(pg, 'id', uid('pg')); r.count++; }
    pg = withElements(pg, ['elements'], r);
    return fill(pg, { ...pageDefaults, id: pg.id, elements: pg.elements }, r);
  });
  if (!sameList(pages0, pages)) p = put(p, 'pages', pages);

  const masterDefaults = makeMaster('Master') as unknown as Obj;
  const masters0 = Array.isArray(p.masters) ? p.masters : (r.count++, []);
  const masters = masters0.filter((m) => isObj(m) || (r.count++, false)).map((m0: unknown) => {
    let m = m0 as Obj;
    if (typeof m.id !== 'string' || !m.id) { m = put(m, 'id', uid('ms')); r.count++; }
    m = withElements(m, ['left', 'right'], r);
    return fill(m, { ...masterDefaults, id: m.id, left: m.left, right: m.right }, r);
  });
  if (masters0 !== p.masters || !sameList(masters0, masters)) p = put(p, 'masters', masters);

  if (!isObj(p.cover)) { p = put(p, 'cover', { elements: [] }); r.count++; }
  else p = put(p, 'cover', withElements(p.cover, ['elements'], r));
  if (p.jacket !== undefined) {
    if (isObj(p.jacket)) p = put(p, 'jacket', withElements(p.jacket, ['elements'], r));
    else { p = drop(p, 'jacket'); r.count++; }
  }

  if (!isObj(p.assets)) { p = put(p, 'assets', {}); r.count++; }
  let assets = p.assets as Obj;
  for (const k of Object.keys(assets)) {
    const a = assets[k];
    if (!isObj(a) || typeof a.src !== 'string') { assets = drop(assets, k); r.count++; continue; }
    assets = put(assets, k, fixNumbers(a, r));
  }
  p = put(p, 'assets', assets);

  for (const k of OPTIONAL_LISTS) {
    const list0 = p[k];
    if (list0 === undefined) continue;
    if (!Array.isArray(list0)) {
      r.count++;
      if (k === 'fonts') p = put(p, k, []);
      else if (k === 'swatches') p = put(p, k, DEFAULT_SWATCHES.map((s) => ({ ...s })));
      else p = drop(p, k);
      continue;
    }
    // Entries of the wrong shape are dropped; the rest get their numbers fixed.
    const ok = ENTRY[k];
    let list = list0.filter((d) => { const good = ok(d); if (!good) r.count++; return good; }).map((d) => fixNumbers(d, r) as Obj);
    if (k === 'sections') {
      list = list.map((sec) => {
        let s = sec;
        if (typeof s.start !== 'number') { s = put(s, 'start', 1); r.count++; }
        if (!SECTION_STYLES.includes(s.style as string)) { s = put(s, 'style', 'arabic'); r.count++; }
        return s;
      });
    }
    if (k === 'swatches') list = list.map((sw) => (str(sw.name) ? sw : (r.count++, put(sw, 'name', sw.hex))));
    if (!sameList(list0, list)) p = put(p, k, list);
  }
  if (p.fonts === undefined) p = put(p, 'fonts', []);
  if (p.swatches === undefined) p = put(p, 'swatches', DEFAULT_SWATCHES.map((s) => ({ ...s })));
  if (p.guides !== undefined && !isObj(p.guides)) { p = drop(p, 'guides'); r.count++; }
  return p as unknown as Project;
}

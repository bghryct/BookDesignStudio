/**
 * Spelling check over every story in the book (InDesign's Check Spelling), with Hunspell
 * dictionaries (SCOWL en-US and en-GB, public/dict) read by nspell. Markup, codes and tags are
 * masked out first, so positions in the masked text are positions in the story.
 */
import type { Element, Project, TextElement } from '../model/types';

interface Speller { correct(word: string): boolean; suggest(word: string): string[]; add(word: string): Speller }
type Lang = 'en-us' | 'en-gb';

const spellers = new Map<Lang, Promise<Speller>>();

function langOf(language: string): Lang | null {
  const l = language.toLowerCase();
  if (l === 'en-gb' || l === 'en-au' || l === 'en-nz') return 'en-gb';
  if (l.startsWith('en')) return 'en-us';
  return null;
}

async function speller(lang: Lang): Promise<Speller> {
  let p = spellers.get(lang);
  if (!p) {
    p = (async () => {
      const base = import.meta.env.BASE_URL ?? './';
      const [aff, dic, mod] = await Promise.all([
        fetch(`${base}dict/${lang}.aff`).then((r) => r.text()),
        fetch(`${base}dict/${lang}.dic`).then((r) => r.text()),
        import('nspell'),
      ]);
      const make = (mod as unknown as { default: (aff: string, dic: string) => Speller }).default;
      return make(aff, dic);
    })();
    spellers.set(lang, p);
  }
  return p;
}

/** The story with markup blanked out (same length, so indices line up); note text and words in footnotes, ruby and warichu stay. */
export function maskMarkup(text: string): string {
  const blank = (m: string) => m.replace(/[^\n]/g, ' ');
  const codes = (t: string): string => {
    let out = '';
    for (let i = 0; i < t.length; i++) {
      if (t[i] !== '{') { out += t[i]; continue; }
      let depth = 0, j = i;
      for (; j < t.length; j++) { if (t[j] === '{') depth++; else if (t[j] === '}' && --depth === 0) break; }
      const whole = t.slice(i, j + 1);
      const m = /^\{([a-z]+):/.exec(whole);
      if (m && (m[1] === 'fn' || m[1] === 'en' || m[1] === 'wari' || m[1] === 'ruby')) {
        let inner = whole.slice(m[0].length, -1);
        if (m[1] === 'ruby') inner = inner.replace(/\|.*$/s, (r) => blank(r));
        else if (m[1] === 'wari') inner = inner.replace('|', ' ');
        out += blank(m[0]) + codes(inner) + (whole.endsWith('}') ? ' ' : '');
      } else out += blank(whole);
      i = j;
    }
    return out;
  };
  return codes(text)
    .replace(/<\/?\{[^}]*\}>|<\/?[^<>\n]{0,40}>/g, blank)
    .replace(/^((?:\[[^\]\n]{1,400}\]\s*)+)/gm, blank)
    .replace(/\\./g, '  ')
    .replace(/[*^#]/g, ' ');
}

export interface Misspelling {
  word: string;
  count: number;
  suggestions: string[];
  where: { elementId: string; index: number }[];
}

function storiesOf(project: Project): TextElement[] {
  const out: TextElement[] = [];
  const add = (els: Element[]) => { for (const e of els) if (e.type === 'text' && e.text.trim()) out.push(e); };
  for (const p of project.pages) add(p.elements);
  for (const m of project.masters) { add(m.left); add(m.right); }
  add(project.cover.elements);
  add(project.jacket?.elements ?? []);
  return out;
}

/** Every word the dictionaries don't know, with where it occurs and suggestions. */
export async function checkSpelling(project: Project): Promise<{ results: Misspelling[]; skipped: number; words: number }> {
  const known = new Set((project.spellingDictionary ?? []).map((w) => w.toLowerCase()));
  const found = new Map<string, Misspelling>();
  let skipped = 0, words = 0;
  for (const el of storiesOf(project)) {
    const lang = langOf(el.style.language);
    if (!lang) { skipped++; continue; }
    const sp = await speller(lang);
    const masked = maskMarkup(el.text);
    for (const m of masked.matchAll(/[\p{L}][\p{L}\p{M}’'-]*[\p{L}]|[\p{L}]/gu)) {
      const w = m[0].replace(/[’']s$/u, '').replace(/’/g, "'");
      words++;
      if (w.length < 2 || /\d/.test(w) || known.has(w.toLowerCase())) continue;
      // Hyphenated compounds: check each part.
      const parts = w.split('-').filter(Boolean);
      if (parts.every((p) => sp.correct(p) || sp.correct(p.toLowerCase()) || known.has(p.toLowerCase()))) continue;
      const key = w;
      const rec = found.get(key) ?? { word: w, count: 0, suggestions: [], where: [] };
      rec.count++;
      rec.where.push({ elementId: el.id, index: m.index! });
      found.set(key, rec);
    }
  }
  // Suggestions only for what is shown (they are the slow part).
  const results = [...found.values()].sort((a, b) => b.count - a.count || a.word.localeCompare(b.word));
  for (const r of results.slice(0, 200)) {
    const lang = langOf(storiesOf(project).find((e) => e.id === r.where[0].elementId)?.style.language ?? 'en-us') ?? 'en-us';
    try { r.suggestions = (await speller(lang)).suggest(r.word).slice(0, 5); } catch { r.suggestions = []; }
  }
  return { results, skipped, words };
}

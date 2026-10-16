/**
 * Liang/TeX hyphenation patterns (via the `hyphen` package), loaded lazily per language.
 * Bringhurst §2.4.8: leave at least two letters behind and carry at least three forward.
 */
import { useFontStore } from './fonts';

type Hyphenator = (text: string, options?: { hyphenChar?: string; minWordLength?: number }) => string;

const LOADERS: Record<string, () => Promise<{ hyphenateSync: Hyphenator }>> = {
  'en-us': () => import('hyphen/en-us'),
  'en-gb': () => import('hyphen/en-gb'),
  de: () => import('hyphen/de'),
  nl: () => import('hyphen/nl'),
  fr: () => import('hyphen/fr'),
  it: () => import('hyphen/it'),
  es: () => import('hyphen/es'),
  pt: () => import('hyphen/pt'),
  la: () => import('hyphen/la'),
  sv: () => import('hyphen/sv'),
  da: () => import('hyphen/da'),
  pl: () => import('hyphen/pl'),
  cs: () => import('hyphen/cs'),
};

export const HYPHEN_LANGUAGES: { id: string; label: string }[] = [
  { id: 'en-us', label: 'English (US)' }, { id: 'en-gb', label: 'English (UK)' }, { id: 'de', label: 'Deutsch' },
  { id: 'nl', label: 'Nederlands' }, { id: 'fr', label: 'Français' }, { id: 'it', label: 'Italiano' },
  { id: 'es', label: 'Español' }, { id: 'pt', label: 'Português' }, { id: 'la', label: 'Latina' },
  { id: 'sv', label: 'Svenska' }, { id: 'da', label: 'Dansk' }, { id: 'pl', label: 'Polski' }, { id: 'cs', label: 'Čeština' },
];

const loaded = new Map<string, Hyphenator>();
const pending = new Map<string, Promise<void>>();
const cache = new Map<string, number[]>();

export function ensureHyphenation(lang: string): Promise<void> {
  if (loaded.has(lang) || !LOADERS[lang]) return Promise.resolve();
  let p = pending.get(lang);
  if (!p) {
    p = LOADERS[lang]()
      .then((m) => {
        const mod = m as unknown as { hyphenateSync?: Hyphenator; default?: { hyphenateSync: Hyphenator } };
        const fn = mod.hyphenateSync ?? mod.default?.hyphenateSync;
        if (fn) loaded.set(lang, fn);
        cache.clear();
        useFontStore.getState().bump();
      })
      .catch(() => undefined);
    pending.set(lang, p);
  }
  return p;
}

/**
 * Break opportunities inside a word, as character offsets.
 * Returns [] while the language is still loading.
 */
export function hyphenPoints(word: string, lang: string, minBefore = 2, minAfter = 3): number[] {
  const fn = loaded.get(lang);
  if (!fn) {
    void ensureHyphenation(lang);
    return [];
  }
  if (word.length < minBefore + minAfter) return [];
  const key = `${lang}|${minBefore}|${minAfter}|${word}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const out: number[] = [];
  const marked = fn(word, { hyphenChar: '­', minWordLength: minBefore + minAfter });
  let idx = 0;
  for (const ch of marked) {
    if (ch === '­') {
      if (idx >= minBefore && word.length - idx >= minAfter) out.push(idx);
    } else idx += ch.length;
  }
  cache.set(key, out);
  if (cache.size > 50000) cache.clear();
  return out;
}

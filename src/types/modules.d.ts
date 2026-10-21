declare module 'wawoff2/decompress.js' {
  const decompress: (buffer: Uint8Array) => Promise<Uint8Array>;
  export default decompress;
}

declare module 'hyphen/*' {
  export function hyphenateSync(text: string, options?: { hyphenChar?: string; minWordLength?: number }): string;
  export function hyphenate(text: string, options?: { hyphenChar?: string; minWordLength?: number }): Promise<string>;
}

/** nspell: Hunspell-compatible spelling (src/engine/spelling.ts). */
declare module 'nspell' {
  interface NSpell { correct(word: string): boolean; suggest(word: string): string[]; add(word: string): NSpell }
  export default function nspell(aff: string, dic: string): NSpell;
}

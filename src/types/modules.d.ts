declare module 'wawoff2/decompress.js' {
  const decompress: (buffer: Uint8Array) => Promise<Uint8Array>;
  export default decompress;
}

declare module 'hyphen/*' {
  export function hyphenateSync(text: string, options?: { hyphenChar?: string; minWordLength?: number }): string;
  export function hyphenate(text: string, options?: { hyphenChar?: string; minWordLength?: number }): Promise<string>;
}

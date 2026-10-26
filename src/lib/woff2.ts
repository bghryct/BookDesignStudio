/**
 * WOFF2 → TTF/OTF, with the WebAssembly decoder from wawoff2.
 *
 * wawoff2's own entry (`wawoff2/decompress.js`) waits for its Emscripten module through
 * `module.exports`, which the module only sets under Node: in a browser bundle the wait never ends
 * and a dropped .woff2 font hung the import. Here the module is run with a `Module` object of our
 * own, so its start-up (and any failure) reaches us.
 */
import binding from 'wawoff2/build/decompress_binding.js?raw';

interface Woff2Module { decompress(bytes: Uint8Array): Uint8Array | false }

let ready: Promise<Woff2Module> | null = null;

function load(): Promise<Woff2Module> {
  ready ??= new Promise<Woff2Module>((resolve, reject) => {
    const Module: Record<string, unknown> = {
      onRuntimeInitialized: () => resolve(Module as unknown as Woff2Module),
      onAbort: (why: unknown) => reject(new Error(`the WOFF2 decoder could not start (${String(why)})`)),
    };
    try {
      // eslint-disable-next-line no-new-func
      new Function('Module', binding)(Module);
    } catch (e) {
      reject(e);
    }
  }).catch((e) => { ready = null; throw e; });
  return ready;
}

/** The SFNT (TrueType / OpenType) bytes inside a WOFF2 file. */
export async function woff2ToSfnt(bytes: Uint8Array): Promise<Uint8Array> {
  const m = await load();
  const out = m.decompress(bytes);
  if (out === false) throw new Error('not a WOFF2 font this app can read');
  return new Uint8Array(out);
}

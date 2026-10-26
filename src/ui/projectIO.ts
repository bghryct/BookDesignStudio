import type { Project } from '../model/types';
import { useStore, recoveredAutosave, markOpening } from '../store/store';
import { faceBytes, restoreUploadedFont, getFace } from '../engine/fonts';
import { uid } from '../lib/random';
import { createDefaultProject } from '../model/defaults';
import { makePage } from '../model/factory';
import { normalizeProject } from '../model/normalize';

interface ProjectFile {
  format: 'book-design-studio';
  version: 1;
  savedAt: string;
  project: Project;
  fonts: { id: string; fileName: string; data: string }[];
}

function toBase64(bytes: Uint8Array): string {
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) s += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(s);
}

function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export const safeName = (s: string) => (s || 'book').replace(/[^\w\-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'book';

/** File › New blank book: four empty pages with the sample's masters, styles and swatches. */
export function blankProject(): Project {
  const p = createDefaultProject();
  p.pages = [makePage(), makePage(), makePage(), makePage()];
  p.name = 'Untitled book';
  p.book.title = 'Untitled';
  p.cover.elements = [];
  return p;
}

/** Save the project — including uploaded fonts and images — as one portable file. */
export function saveProjectFile(project: Project): boolean {
  try {
    const fonts = project.fonts
      .map((f) => {
        const bytes = faceBytes(f.id);
        return bytes ? { id: f.id, fileName: f.fileName, data: toBase64(bytes) } : null;
      })
      .filter(Boolean) as ProjectFile['fonts'];
    const file: ProjectFile = { format: 'book-design-studio', version: 1, savedAt: new Date().toISOString(), project: sharePdfSources(project), fonts };
    downloadBlob(new Blob([JSON.stringify(file)], { type: 'application/json' }), `${safeName(project.name)}.bds.json`);
    return true;
  } catch (e) {
    // JSON.stringify gives up at ~512 MB (RangeError): say so, or the student believes it was saved.
    const big = e instanceof RangeError;
    useStore.getState().notify(big
      ? 'The project is too large to save as one file. Remove pictures, placed PDFs or fonts you no longer use, then save again.'
      : `The project could not be saved: ${(e as Error).message}`, 'error');
    return false;
  }
}

/**
 * Placed PDF pages of one file all carry the whole PDF (pdf.src). In the saved file the PDF is
 * written once: the other pages point at the first asset that holds it (`#asset-id`).
 */
function sharePdfSources(project: Project): Project {
  const first = new Map<string, string>();
  let assets: Project['assets'] | null = null;
  for (const [id, a] of Object.entries(project.assets)) {
    const src = a.pdf?.src;
    if (!src || src.startsWith('#')) continue;
    const owner = first.get(src);
    if (!owner) { first.set(src, id); continue; }
    assets ??= { ...project.assets };
    assets[id] = { ...a, pdf: { ...a.pdf!, src: `#${owner}` } };
  }
  return assets ? { ...project, assets } : project;
}

/** The PDF bytes of a placed page whose file was saved once (`#asset-id`), as one shared string again. */
function resolvePdfSources(project: Project): void {
  for (const a of Object.values(project.assets)) {
    const src = a.pdf?.src;
    if (!src?.startsWith('#')) continue;
    const owner = project.assets[src.slice(1)]?.pdf?.src;
    if (owner && !owner.startsWith('#')) a.pdf!.src = owner;
  }
}

/** Parse a project file (or a bare project), repaired so that nothing in it can blank the app. */
async function readProjectFile(file: File, repairs?: { count: number }): Promise<{ project: Project; fonts: ProjectFile['fonts'] }> {
  const raw = await file.text();
  if (!raw.trim()) throw new Error('The file is empty.');
  let data: ProjectFile | Project | null;
  // The parser's own message ("Unexpected token 'P'…") means nothing to a student.
  try { data = JSON.parse(raw) as ProjectFile | Project | null; } catch { throw new Error('Not a Book Design Studio project: the file is not a .bds.json project (another kind of file, or a download that did not finish).'); }
  const pf = data && typeof data === 'object' && 'format' in data ? data : { project: data, fonts: [] };
  const project = normalizeProject(pf.project, repairs);
  resolvePdfSources(project);
  return { project, fonts: Array.isArray(pf.fonts) ? pf.fonts : [] };
}

/** Uploaded fonts carried in the file; a damaged one falls back to the default face instead of
 *  keeping the book from opening. Returns how many could not be read. */
async function restoreFileFonts(fonts: ProjectFile['fonts']): Promise<number> {
  let bad = 0;
  for (const f of fonts) {
    try { await restoreUploadedFont(f.id, { bytes: fromBase64(f.data), fileName: f.fileName }); } catch { bad++; }
  }
  return bad;
}

export async function loadProjectFile(file: File) {
  const repairs = { count: 0 };
  const { project, fonts } = await readProjectFile(file, repairs);
  // A book needs a page to show.
  if (!project.pages.length) project.pages.push(makePage({ masterId: project.masters[0]?.id ?? null }));
  const badFonts = await restoreFileFonts(fonts);
  const s = useStore.getState();
  const previous = s.project;
  s.replaceProject(project);
  // The browser keeps one book: opening a file can be undone, back to the book it replaced.
  useStore.setState({ past: [previous] });
  // Uploaded fonts the file did not carry (a safe-mode download has none) come from this
  // browser's store, as on a reload, instead of standing in as the default face.
  await restoreProjectFonts(useStore.getState().project).catch(() => undefined);
  const notes = [
    repairs.count ? `repaired ${repairs.count} problem${repairs.count === 1 ? '' : 's'} in this project` : '',
    badFonts ? `${badFonts} uploaded font${badFonts === 1 ? '' : 's'} could not be read (the default face stands in)` : '',
  ].filter(Boolean);
  // After the caller's own "Opened …" message.
  if (notes.length) setTimeout(() => useStore.getState().notify(`Opened ${file.name}: ${notes.join('; ')}.`), 0);
}

/**
 * Open the book safe mode kept aside. It stopped the app once, so its opening is marked as for an
 * autosave: if it stops the app again, the next start is in safe mode. False when there is none.
 */
export async function openRecoveredBook(): Promise<boolean> {
  const raw = await recoveredAutosave();
  if (!raw) return false;
  const repairs = { count: 0 };
  const project = normalizeProject(raw, repairs);
  resolvePdfSources(project);
  if (!project.pages.length) project.pages.push(makePage({ masterId: project.masters[0]?.id ?? null }));
  markOpening(true);
  const s = useStore.getState();
  const previous = s.project;
  s.replaceProject(project);
  useStore.setState({ past: [previous] });
  await restoreProjectFonts(useStore.getState().project).catch(() => undefined);
  setTimeout(() => markOpening(false), 1000);
  if (repairs.count) setTimeout(() => useStore.getState().notify(`Repaired ${repairs.count} problem${repairs.count === 1 ? '' : 's'} in this project.`), 0);
  return true;
}

/** Re-register the uploaded fonts a project references (bytes from IndexedDB). */
export async function restoreProjectFonts(project: Project) {
  for (const f of project.fonts) {
    if (getFace(f.id)?.status === 'ready') continue;
    await restoreUploadedFont(f.id).catch(() => null);
  }
}

/**
 * Book assembly: insert another project's pages (a chapter prepared as its own file) after a page.
 * Its masters, styles and pictures come along with fresh ids; styles whose names the book already
 * has map onto the book's own (the book's definitions win, as in a synchronised InDesign book).
 * Optionally the inserted pages start a section named after the file.
 */
export async function insertProjectFile(file: File, afterIndex: number, opts: { section?: boolean } = {}): Promise<{ pages: number; styles: number; masters: number }> {
  const { project: src, fonts } = await readProjectFile(file);
  await restoreFileFonts(fonts);
  // “chapter-2.bds.json” → “chapter-2”.
  const baseName = file.name.replace(/(\.bds)?\.json$|\.[^.]+$/i, '');
  const book = useStore.getState().project;

  // Every id in the incoming pages, masters, styles and assets gets a fresh one.
  const map = new Map<string, string>();
  const fresh = (id: string) => { if (!map.has(id)) map.set(id, uid(id.split('_')[0] || 'id')); return map.get(id)!; };
  const visit = (v: unknown) => {
    if (Array.isArray(v)) { v.forEach(visit); return; }
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      if (typeof o.id === 'string') fresh(o.id);
      for (const k of Object.keys(o)) visit(o[k]);
    }
  };
  visit(src.pages); visit(src.masters);
  for (const k of Object.keys(src.assets ?? {})) fresh(k);
  const byName = (list: { id: string; name: string }[] | undefined, mine: { id: string; name: string }[] | undefined) => {
    let added = 0;
    for (const d of list ?? []) {
      const same = (mine ?? []).find((x) => x.name.toLowerCase() === d.name.toLowerCase());
      if (same) map.set(d.id, same.id); else { fresh(d.id); added++; }
    }
    return added;
  };
  const newStyles = byName(src.paragraphStyles, book.paragraphStyles) + byName(src.characterStyles, book.characterStyles)
    + byName(src.tableStyles as { id: string; name: string }[] | undefined, book.tableStyles as { id: string; name: string }[] | undefined)
    + byName(src.cellStyles as { id: string; name: string }[] | undefined, book.cellStyles as { id: string; name: string }[] | undefined);
  // Rewrite ids wherever they occur (fields, references, {img:…} in stories): ids are unique tokens.
  const ids = [...map.keys()].sort((a, b) => b.length - a.length);
  const re = ids.length ? new RegExp(ids.map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g') : null;
  const remap = <T,>(v: T): T => (re ? JSON.parse(JSON.stringify(v).replace(re, (m) => map.get(m) ?? m)) : structuredClone(v));
  const pages = remap(src.pages);
  const masters = remap(src.masters).map((m) => ({ ...m, name: book.masters.some((x) => x.name === m.name) ? `${m.name} (${baseName})` : m.name }));
  const take = <D extends { id: string }>(list: D[] | undefined, mine: D[] | undefined) => remap((list ?? []).filter((d) => !(mine ?? []).some((x) => x.id === map.get(d.id))));
  const assets = remap(src.assets ?? {});

  useStore.getState().update((d) => {
    d.pages.splice(afterIndex + 1, 0, ...(pages as typeof d.pages));
    d.masters.push(...(masters as typeof d.masters));
    d.paragraphStyles = [...(d.paragraphStyles ?? []), ...take(src.paragraphStyles, book.paragraphStyles)];
    d.characterStyles = [...(d.characterStyles ?? []), ...take(src.characterStyles, book.characterStyles)];
    d.tableStyles = [...(d.tableStyles ?? []), ...take(src.tableStyles, book.tableStyles)] as typeof d.tableStyles;
    d.cellStyles = [...(d.cellStyles ?? []), ...take(src.cellStyles, book.cellStyles)] as typeof d.cellStyles;
    Object.assign(d.assets, assets);
    for (const f of src.fonts ?? []) if (!d.fonts.some((x) => x.id === f.id)) d.fonts.push(f);
    if (opts.section && pages.length) d.sections = [...(d.sections ?? []).filter((x) => x.pageId !== pages[0].id), { pageId: pages[0].id, start: 1, style: 'arabic', marker: src.book?.title || baseName }];
  });
  // Its uploaded fonts that the file did not carry, from this browser's store.
  await restoreProjectFonts(src).catch(() => undefined);
  return { pages: pages.length, styles: newStyles, masters: masters.length };
}

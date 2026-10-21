import type { Project } from '../model/types';
import { useStore } from '../store/store';
import { faceBytes, restoreUploadedFont, getFace } from '../engine/fonts';
import { uid } from '../lib/random';

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

/** Save the project — including uploaded fonts and images — as one portable file. */
export function saveProjectFile(project: Project) {
  const fonts = project.fonts
    .map((f) => {
      const bytes = faceBytes(f.id);
      return bytes ? { id: f.id, fileName: f.fileName, data: toBase64(bytes) } : null;
    })
    .filter(Boolean) as ProjectFile['fonts'];
  const file: ProjectFile = { format: 'book-design-studio', version: 1, savedAt: new Date().toISOString(), project, fonts };
  downloadBlob(new Blob([JSON.stringify(file)], { type: 'application/json' }), `${safeName(project.name)}.bds.json`);
}

export async function loadProjectFile(file: File) {
  const data = JSON.parse(await file.text()) as ProjectFile | Project;
  const pf: ProjectFile = 'format' in data ? data : { format: 'book-design-studio', version: 1, savedAt: '', project: data, fonts: [] };
  if (!pf.project || !Array.isArray(pf.project.pages)) throw new Error('Not a Book Design Studio project.');
  for (const f of pf.fonts ?? []) await restoreUploadedFont(f.id, { bytes: fromBase64(f.data), fileName: f.fileName });
  useStore.getState().replaceProject(pf.project);
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
  const data = JSON.parse(await file.text()) as ProjectFile | Project;
  const pf: ProjectFile = 'format' in data ? data : { format: 'book-design-studio', version: 1, savedAt: '', project: data, fonts: [] };
  const src = pf.project;
  if (!src || !Array.isArray(src.pages)) throw new Error('Not a Book Design Studio project.');
  for (const f of pf.fonts ?? []) await restoreUploadedFont(f.id, { bytes: fromBase64(f.data), fileName: f.fileName });
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
  const masters = remap(src.masters).map((m) => ({ ...m, name: book.masters.some((x) => x.name === m.name) ? `${m.name} (${file.name.replace(/\.[^.]+$/, '')})` : m.name }));
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
    if (opts.section && pages.length) d.sections = [...(d.sections ?? []).filter((x) => x.pageId !== pages[0].id), { pageId: pages[0].id, start: 1, style: 'arabic', marker: src.book?.title || file.name.replace(/\.[^.]+$/, '') }];
  });
  return { pages: pages.length, styles: newStyles, masters: masters.length };
}

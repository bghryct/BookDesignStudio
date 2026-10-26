import type { Asset, Element, Project, SvgElement, ImageElement, UploadedFontMeta } from '../model/types';
import { useStore } from '../store/store';
import { makeImage, makeSvg, makeText } from '../model/factory';
import { uid } from '../lib/random';
import { registerUploadedFont } from '../engine/fonts';
import { surfaceElementsDraft, findElement } from '../model/surfaces';
import { parseSvg } from '../render/svgImport';
import { loadProjectFile } from './projectIO';
import { tableFromText } from './canvas/TableTools';
import { loadManuscript, MANUSCRIPT_EXT } from './manuscript';

/** A PDF page as an asset: a raster preview for the screen, the file itself for vector export. */
export async function pdfPageAsset(bytes: Uint8Array, name: string, page: number, src?: string): Promise<Asset> {
  const { openPdf, renderPdfPage } = await import('../lib/pdfImport');
  const { doc, close } = await openPdf(bytes);
  try {
    const n = Math.max(1, Math.min(doc.numPages, page));
    const r = await renderPdfPage(doc, n);
    const fileSrc = src ?? `data:application/pdf;base64,${toBase64(bytes)}`;
    return {
      id: uid('as'), kind: 'image', name: doc.numPages > 1 ? `${name} · p. ${n}` : name, mime: 'image/png', src: r.dataUrl, width: r.pxW, height: r.pxH,
      pdf: { src: fileSrc, page: n, pages: doc.numPages, widthPt: r.widthPt, heightPt: r.heightPt },
    };
  } finally {
    void close();
  }
}

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** How many times an asset id is used by the book's elements and stories ({img:…}). */
function assetUses(p: Project, id: string): number {
  const json = JSON.stringify([p.pages, p.masters, p.cover, p.jacket ?? null]);
  let n = 0;
  for (let i = json.indexOf(id); i >= 0; i = json.indexOf(id, i + id.length)) n++;
  return n;
}

/**
 * Show page `page` of a placed PDF in image element `elementId`. Every page asset of a file carries
 * the whole PDF, so the file is not copied again for each page tried: the element's asset becomes
 * the new page when nothing else uses it, a page placed before is reused, and pages of the file
 * that nothing uses any more are removed.
 */
export async function switchPdfPage(elementId: string, page: number): Promise<void> {
  const s = useStore.getState();
  const loc = findElement(s.project, elementId);
  const asset = loc?.el.type === 'image' && loc.el.assetId ? s.project.assets[loc.el.assetId] : undefined;
  const pdf = asset?.pdf;
  if (!asset || !pdf || page === pdf.page) return;
  let target = Object.values(s.project.assets).find((a) => a.pdf && a.pdf.src === pdf.src && a.pdf.page === page);
  if (!target) {
    const bytes = new Uint8Array(await (await fetch(pdf.src)).arrayBuffer());
    target = await pdfPageAsset(bytes, asset.name.replace(/ · p\. \d+$/, ''), page, pdf.src);
    if (assetUses(useStore.getState().project, asset.id) <= 1) target = { ...target, id: asset.id };
  }
  const next = target;
  s.update((d) => {
    d.assets[next.id] = next as typeof d.assets[string];
    const el = surfaceElementsDraft(d as Project, loc!.key)?.find((x) => x.id === elementId);
    if (el && el.type === 'image') { el.assetId = next.id; el.placeholder = false; }
  });
  // Pages of this PDF that nothing shows any more.
  const now = useStore.getState().project;
  const unused = Object.values(now.assets).filter((a) => a.id !== next.id && a.pdf?.src === pdf.src && assetUses(now, a.id) === 0).map((a) => a.id);
  if (unused.length) s.update((d) => { for (const id of unused) delete d.assets[id]; }, { history: false });
}
import { autoFlow } from '../model/pageOps';
import { spreadsOf, pageSide, pageKey } from '../model/surfaces';
import { textBlock } from '../engine/grid';

/** Without a drop point: the text block of the current spread's right-hand (or only) page. */
function defaultPlace(): { surfaceKey: string; x: number; y: number; w: number; h: number } | null {
  const s = useStore.getState();
  const sp = spreadsOf(s.project)[s.spread];
  const pi = sp?.right ?? sp?.left;
  if (pi == null) return null;
  const b = textBlock(s.project.book, pageSide(s.project, pi));
  return { surfaceKey: pageKey(s.project.pages[pi].id), x: b.x, y: b.y, w: b.w, h: b.h };
}

/** The head of the text block on a page or master surface (undefined on the cover and jacket). */
function blockTop(surfaceKey: string): number | undefined {
  const p = useStore.getState().project;
  const pi = p.pages.findIndex((pg) => pageKey(pg.id) === surfaceKey);
  const side = pi >= 0 ? pageSide(p, pi) : surfaceKey.startsWith('master:') ? (surfaceKey.endsWith(':left') ? 'left' : 'right') : null;
  return side ? textBlock(p.book, side).y : undefined;
}

export interface ImportOptions {
  place?: { surfaceKey: string; x: number; y: number };
  replaceImageId?: string;
}

const readAsDataUrl = (f: Blob) => new Promise<string>((res, rej) => {
  const r = new FileReader();
  r.onload = () => res(r.result as string);
  r.onerror = () => rej(r.error);
  r.readAsDataURL(f);
});

/** The image's pixel size; null when the browser cannot decode it (empty, damaged, not an image). */
const imageSize = (src: string) => new Promise<{ w: number; h: number } | null>((res) => {
  const img = new Image();
  img.onload = () => res(img.naturalWidth > 0 && img.naturalHeight > 0 ? { w: img.naturalWidth, h: img.naturalHeight } : null);
  img.onerror = () => res(null);
  img.src = src;
});

const FONT_EXT = /\.(ttf|otf|woff2?|ttc)$/i;
/**
 * Largest table a dropped CSV / TSV may make (cells). The table engine now redraws a large table
 * in well under a second after an edit, but the first setting of new cells costs 0.1–0.2 ms each
 * (font shaping; again on every reload), and the new table arrives as one frame as tall as all
 * its rows, which every redraw of its page paints whole until it is threaded over pages. At this
 * size (1,600 rows × 30 columns, 5,000 × 10) a placement takes several seconds and a redraw of the
 * unthreaded frame one to two.
 */
const MAX_TABLE_CELLS = 50_000;

/** Import dropped/picked files: images, SVG, fonts, text, project files. */
export async function importFiles(files: File[], opts: ImportOptions = {}): Promise<{ messages: string[]; errors: string[] }> {
  const messages: string[] = [];
  const errors: string[] = [];
  const s = useStore.getState();
  let offset = 0;
  for (const file of files) {
    try {
      if (FONT_EXT.test(file.name) || /font/.test(file.type)) {
        let bytes: Uint8Array = new Uint8Array(await file.arrayBuffer());
        const sig = String.fromCharCode(...bytes.subarray(0, 4));
        if (sig === 'ttcf') { errors.push(`${file.name}: a font collection (.ttc) holds several fonts; export the face you want as .ttf or .otf.`); continue; }
        // WOFF2 is unpacked here (the font engine's own decoder never starts in a browser).
        if (sig === 'wOF2') bytes = await (await import('../lib/woff2')).woff2ToSfnt(bytes);
        const r = await registerUploadedFont(bytes, file.name).catch((e: Error) => { throw new Error(`not a font this app can read (${e.message})`); });
        // The same file uploaded again (to be sure it worked) must not store a second copy in the book.
        if (useStore.getState().project.fonts.some((f) => f.fileName === file.name && f.family === r.family && f.weight === r.weight && f.italic === r.italic)) {
          messages.push(`Font “${r.family}” is already in this book.`);
          continue;
        }
        const meta: UploadedFontMeta = { id: r.faceKey, family: r.family, fileName: file.name, weight: r.weight, italic: r.italic };
        s.update((d) => { d.fonts.push(meta); });
        messages.push(`Font “${r.family}”${r.variable ? ' (variable)' : ''} added.`);
        continue;
      }
      if (/\.bds(\.json)?$|\.json$/i.test(file.name)) {
        await loadProjectFile(file);
        messages.push(`Opened ${file.name}.`);
        continue;
      }
      if (/\.(csv|tsv|tab)$/i.test(file.name) || file.type === 'text/csv' || file.type === 'text/tab-separated-values') {
        // Picked from the File menu (no drop point): centre it in the current spread's text block.
        const dp = opts.place ? null : defaultPlace();
        const place = opts.place ?? (dp && { surfaceKey: dp.surfaceKey, x: dp.x + dp.w / 2, y: dp.y + dp.h / 2 });
        if (!place) { errors.push(`${file.name}: open a page to place the table on.`); continue; }
        const el = tableFromText(await file.text(), place, file.name.replace(/\.[^.]+$/, ''), blockTop(place.surfaceKey));
        // Beyond this a first placement (and every reload of the autosave) holds the tab for many
        // seconds: refuse with the reason instead of hanging.
        const cells = el ? el.rows.length * el.cols.length : 0;
        if (el && cells > MAX_TABLE_CELLS) { errors.push(`${file.name}: ${el.rows.length.toLocaleString()} rows × ${el.cols.length} columns is ${cells.toLocaleString()} cells — more than one table can take without stalling the app (${MAX_TABLE_CELLS.toLocaleString()} cells). Split the file into parts of fewer rows (or drop unneeded columns) and place each part as its own table.`); continue; }
        if (el) { s.addElement(place.surfaceKey, el); messages.push(`Table made from ${file.name}: ${el.rows.length} rows × ${el.cols.length} columns.`); }
        else errors.push(`${file.name}: no rows found.`);
        continue;
      }
      if (MANUSCRIPT_EXT.test(file.name) || file.type === 'text/plain' || file.type === 'text/markdown') {
        const { text, summary } = await loadManuscript(file, (useStore.getState().project.paragraphStyles ?? []).map((p) => p.name));
        if (!text.trim()) { errors.push(`${file.name}: no text found.`); continue; }
        // A book-length text picked without a drop point flows into new pages (after any flowed
        // by an earlier file of the same drop: the project as it is now, not as it was).
        if (!opts.place && text.length > 12000) {
          const now = useStore.getState().project;
          const n = autoFlow(text, { afterIndex: now.pages.length - 1, masterId: now.masters[0]?.id ?? null, startRecto: true });
          messages.push(`${file.name}: ${summary} — flowed into ${n} new page${n === 1 ? '' : 's'}.`);
          continue;
        }
        const place: { surfaceKey: string; x: number; y: number; w?: number; h?: number } | null = opts.place ?? defaultPlace();
        if (!place) { errors.push(`${file.name}: open a page to place the manuscript on.`); continue; }
        const el = makeText({ name: file.name.replace(/\.[^.]+$/, ''), x: place.x, y: place.y, w: place.w ?? 240, h: place.h ?? 320, text });
        s.addElement(place.surfaceKey, el);
        s.select([el.id]);
        messages.push(`${file.name}: ${summary} — placed; thread it on into more frames with the + port, or use Pages › Flow text.`);
        continue;
      }
      if (/\.pdf$/i.test(file.name) || file.type === 'application/pdf') {
        // A PDF is placed as a graphic: its first page, vector in the exported PDF.
        const bytes = new Uint8Array(await file.arrayBuffer());
        const asset = await pdfPageAsset(bytes, file.name, 1);
        s.update((d) => { d.assets[asset.id] = asset; });
        const place = opts.place ?? defaultPlace();
        if (!place) { messages.push(`${file.name} added to assets.`); continue; }
        if (opts.replaceImageId) { s.updateElement(opts.replaceImageId, { assetId: asset.id, placeholder: false } as Partial<ImageElement>); continue; }
        const k = Math.min(1, 300 / asset.pdf!.widthPt, 420 / asset.pdf!.heightPt);
        const w = asset.pdf!.widthPt * k, h = asset.pdf!.heightPt * k;
        const at = opts.place ? { x: place.x - w / 2 + offset, y: place.y - h / 2 + offset } : { x: place.x, y: place.y };
        const el = makeImage({ name: file.name, assetId: asset.id, x: at.x, y: at.y, w, h, fit: 'contain' });
        s.update((d) => { surfaceElementsDraft(d as Project, place.surfaceKey)?.push(el); });
        s.select([el.id]);
        offset += 12;
        messages.push(`${file.name}: page 1 of ${asset.pdf!.pages} placed (vector in the exported PDF)${asset.pdf!.pages > 1 ? ' — choose another page in the Image panel' : ''}. To set its text instead, load it with Pages › Flow text.`);
        continue;
      }
      const isSvg = file.type === 'image/svg+xml' || /\.svg$/i.test(file.name);
      if (!isSvg && !file.type.startsWith('image/')) { errors.push(`Unsupported file: ${file.name}`); continue; }
      const src = isSvg ? `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(await file.text())))}` : await readAsDataUrl(file);
      let size = await imageSize(src);
      if (isSvg) {
        const parsed = parseSvg(await file.text());
        if (!parsed) { errors.push(`${file.name}: not an SVG drawing this app can read.`); continue; }
        // A viewBox like "0 0 -10 NaN" must not give the frame a NaN size (it would never draw).
        if (parsed.viewBox.w > 0 && parsed.viewBox.h > 0 && Number.isFinite(parsed.viewBox.w * parsed.viewBox.h)) size = { w: parsed.viewBox.w, h: parsed.viewBox.h };
        size ??= { w: 100, h: 100 };
      }
      // Empty or damaged pictures used to be placed as frames that never draw.
      if (!size) { errors.push(`${file.name}: the picture is empty or damaged, or not in a format the browser can show.`); continue; }
      const asset: Asset = { id: uid('as'), kind: isSvg ? 'svg' : 'image', name: file.name, mime: file.type || (isSvg ? 'image/svg+xml' : 'image/png'), src, width: size.w, height: size.h };
      s.update((d) => { d.assets[asset.id] = asset; });
      if (opts.replaceImageId) {
        const loc = findElement(useStore.getState().project, opts.replaceImageId);
        if (loc && loc.el.type === 'image') s.updateElement(loc.el.id, { assetId: asset.id, placeholder: false } as Partial<ImageElement>);
        else if (loc && loc.el.type === 'svg') s.updateElement(loc.el.id, { assetId: asset.id } as Partial<SvgElement>);
        continue;
      }
      if (opts.place) {
        const maxW = 260;
        const k = Math.min(1, maxW / size.w);
        const w = Math.max(20, size.w * k), h = Math.max(20, size.h * k);
        const el: Element = isSvg
          ? makeSvg({ name: file.name, assetId: asset.id, x: opts.place.x - w / 2 + offset, y: opts.place.y - h / 2 + offset, w, h })
          : makeImage({ name: file.name, assetId: asset.id, x: opts.place.x - w / 2 + offset, y: opts.place.y - h / 2 + offset, w, h, fit: 'fill' });
        s.update((d) => { surfaceElementsDraft(d as Project, opts.place!.surfaceKey)?.push(el); });
        s.select([el.id]);
        offset += 12;
      } else {
        messages.push(`${file.name} added to assets.`);
      }
    } catch (e) {
      errors.push(`${file.name}: ${(e as Error).message}`);
    }
  }
  return { messages, errors };
}

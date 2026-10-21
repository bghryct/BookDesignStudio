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

const imageSize = (src: string) => new Promise<{ w: number; h: number }>((res) => {
  const img = new Image();
  img.onload = () => res({ w: img.naturalWidth || 100, h: img.naturalHeight || 100 });
  img.onerror = () => res({ w: 100, h: 100 });
  img.src = src;
});

const FONT_EXT = /\.(ttf|otf|woff2?|ttc)$/i;

/** Import dropped/picked files: images, SVG, fonts, text, project files. */
export async function importFiles(files: File[], opts: ImportOptions = {}): Promise<{ messages: string[]; errors: string[] }> {
  const messages: string[] = [];
  const errors: string[] = [];
  const s = useStore.getState();
  let offset = 0;
  for (const file of files) {
    try {
      if (FONT_EXT.test(file.name) || /font/.test(file.type)) {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const r = await registerUploadedFont(bytes, file.name);
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
        const el = opts.place ? tableFromText(await file.text(), opts.place, file.name.replace(/\.[^.]+$/, '')) : null;
        if (el) { s.addElement(opts.place!.surfaceKey, el); messages.push(`Table made from ${file.name}: ${el.rows.length} rows × ${el.cols.length} columns.`); }
        else errors.push(`${file.name}: no rows found (drop it on a page to make a table).`);
        continue;
      }
      if (MANUSCRIPT_EXT.test(file.name) || file.type === 'text/plain' || file.type === 'text/markdown') {
        const { text, summary } = await loadManuscript(file, (s.project.paragraphStyles ?? []).map((p) => p.name));
        // A book-length text picked without a drop point flows into new pages.
        if (!opts.place && text.length > 12000) {
          const n = autoFlow(text, { afterIndex: s.project.pages.length - 1, masterId: s.project.masters[0]?.id ?? null, startRecto: true });
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
        if (parsed) size = { w: parsed.viewBox.w, h: parsed.viewBox.h };
      }
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

import type { Asset, Element, Project, SvgElement, ImageElement, UploadedFontMeta } from '../model/types';
import { useStore } from '../store/store';
import { makeImage, makeSvg, makeText } from '../model/factory';
import { uid } from '../lib/random';
import { registerUploadedFont } from '../engine/fonts';
import { surfaceElementsDraft, findElement } from '../model/surfaces';
import { parseSvg } from '../render/svgImport';
import { loadProjectFile } from './projectIO';
import { tableFromText } from './canvas/TableTools';

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
      if (/\.(txt|md)$/i.test(file.name) || file.type === 'text/plain') {
        const text = await file.text();
        if (opts.place) {
          const el = makeText({ x: opts.place.x, y: opts.place.y, w: 240, h: 320, text: text.trim() });
          s.addElement(opts.place.surfaceKey, el);
          messages.push('Text placed — thread it into more frames with the + port.');
        }
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

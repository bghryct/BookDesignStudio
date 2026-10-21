/**
 * PDF import with Mozilla's pdf.js, loaded only when a PDF is opened:
 *
 *  - `renderPdfPage`: a page as a raster preview for the canvas and the 3D book. The PDF export
 *    embeds the original page instead, so placed PDFs stay vector in print.
 *  - `pdfToStory`: a PDF's text rebuilt as story markup. A PDF stores positioned glyph runs, not
 *    paragraphs, so this works backwards from the layout:
 *      - lines are found from baselines, and paragraphs from line spacing, first-line indents and
 *        short last lines;
 *      - running heads and folios (text repeated at page tops and feet, bare page numbers) are dropped;
 *      - words hyphenated at line ends are rejoined;
 *      - larger lines become headings, and italic and bold fonts become *…* and **…**.
 *    Tables, footnotes and multi-column pages come through as plain paragraphs, so check the result.
 */
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import type { TextItem } from 'pdfjs-dist/types/src/display/api';

type PdfJs = typeof import('pdfjs-dist');
let lib: Promise<PdfJs> | null = null;

function pdfjs(): Promise<PdfJs> {
  if (!lib) {
    lib = (async () => {
      const [m, worker] = await Promise.all([import('pdfjs-dist'), import('pdfjs-dist/build/pdf.worker.min.mjs?url')]);
      m.GlobalWorkerOptions.workerSrc = worker.default;
      return m;
    })();
  }
  return lib;
}

/** Open a PDF (the bytes are copied: pdf.js hands its buffer to its worker). `close` frees the worker. */
export async function openPdf(bytes: Uint8Array): Promise<{ doc: PDFDocumentProxy; close: () => Promise<void> }> {
  const m = await pdfjs();
  const task = m.getDocument({ data: bytes.slice(), fontExtraProperties: true });
  return { doc: await task.promise, close: () => task.destroy() };
}

export interface RenderedPage { dataUrl: string; widthPt: number; heightPt: number; pxW: number; pxH: number }

/** Page `n` (1-based) as a PNG with a transparent background, at most `maxPx` on its long side. */
export async function renderPdfPage(doc: PDFDocumentProxy, n: number, maxPx = 3000, ppp = 2.5): Promise<RenderedPage> {
  const page = await doc.getPage(n);
  const vp1 = page.getViewport({ scale: 1 });
  const scale = Math.min(ppp, maxPx / Math.max(vp1.width, vp1.height));
  const vp = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.ceil(vp.width));
  canvas.height = Math.max(1, Math.ceil(vp.height));
  // Our own context with alpha: given only the canvas, pdf.js opens an opaque one and a clear
  // background comes out black.
  const ctx = canvas.getContext('2d', { alpha: true })!;
  await page.render({ canvas: null, canvasContext: ctx, viewport: vp, background: 'rgba(0,0,0,0)' }).promise;
  const dataUrl = canvas.toDataURL('image/png');
  page.cleanup();
  return { dataUrl, widthPt: vp1.width, heightPt: vp1.height, pxW: canvas.width, pxH: canvas.height };
}

/* -------------------------------------------------------------------------- */
/* Text                                                                        */
/* -------------------------------------------------------------------------- */

interface Run { text: string; x: number; y: number; w: number; size: number; italic: boolean; bold: boolean }
interface Line { runs: Run[]; x: number; end: number; y: number; size: number; page: number; text: string }

const esc = (t: string) => t.replace(/([\\*^{}<>])/g, '\\$1');
const median = (v: number[]) => { if (!v.length) return 0; const s = [...v].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

/** Italic and bold for each font of the page, so emphasis survives (from pdf.js's font flags and name). */
async function fontLooks(page: PDFPageProxy, ids: Set<string>): Promise<Map<string, { italic: boolean; bold: boolean }>> {
  const out = new Map<string, { italic: boolean; bold: boolean }>();
  try {
    await page.getOperatorList();
    for (const id of ids) {
      try {
        if (!page.commonObjs.has(id)) continue;
        const f = page.commonObjs.get(id) as { name?: string; italic?: boolean; bold?: boolean; black?: boolean } | null;
        if (!f) continue;
        const name = (f.name ?? '').replace(/^[A-Z]{6}\+/, '');
        out.set(id, { italic: !!f.italic || /italic|oblique|-it$/i.test(name), bold: !!f.bold || !!f.black || /bold|black|heavy|semibold|demi/i.test(name) });
      } catch { /* font not resolved */ }
    }
  } catch { /* no operator list: styles stay plain */ }
  return out;
}

async function pageLines(page: PDFPageProxy, pageNo: number): Promise<Line[]> {
  const tc = await page.getTextContent();
  const items = tc.items.filter((i): i is TextItem => 'str' in i && i.str.length > 0 && i.dir !== 'ttb');
  const looks = await fontLooks(page, new Set(items.map((i) => i.fontName)));
  const lines: Line[] = [];
  let cur: Line | null = null;
  for (const it of items) {
    const [a, b, c, d, x, y] = it.transform as number[];
    const size = Math.hypot(c, d) || Math.hypot(a, b) || it.height || 10;
    const look = looks.get(it.fontName);
    const run: Run = { text: it.str, x, y, w: it.width, size, italic: !!look?.italic, bold: !!look?.bold };
    if (!run.text.trim() && cur) { cur.runs.push(run); continue; }
    if (!cur || Math.abs(y - cur.y) > Math.min(size, cur.size) * 0.45) {
      cur = { runs: [], x, end: x, y, size, page: pageNo, text: '' };
      lines.push(cur);
    }
    cur.runs.push(run);
    cur.size = Math.max(cur.size, size);
  }
  for (const l of lines) {
    l.runs.sort((p, q) => p.x - q.x);
    l.x = l.runs.find((r) => r.text.trim())?.x ?? l.runs[0].x;
    l.end = Math.max(...l.runs.map((r) => r.x + r.w));
    l.text = l.runs.map((r) => r.text).join('').replace(/\s+/g, ' ').trim();
  }
  return lines.filter((l) => l.text);
}

/** A line's text as markup: spaces where the runs leave a gap, italic and bold marked. */
function lineMarkup(l: Line): string {
  const segs: { t: string; i: boolean; b: boolean }[] = [];
  let prevEnd: number | null = null;
  for (const r of l.runs) {
    let t = r.text;
    if (prevEnd != null && r.x - prevEnd > r.size * 0.12 && !/^\s/.test(t)) {
      const last = segs[segs.length - 1];
      if (last && !/\s$/.test(last.t)) t = ' ' + t;
    }
    prevEnd = r.x + r.w;
    const last = segs[segs.length - 1];
    const blank = !t.trim();
    if (last && (blank || (last.i === r.italic && last.b === r.bold))) last.t += t;
    else segs.push({ t, i: r.italic, b: r.bold });
  }
  return segs.map(({ t, i, b }) => {
    const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(t.replace(/\s+/g, ' '))!;
    let core = esc(m[2]);
    if (!core) return m[1] + m[3];
    if (i && b) core = `***${core}***`; else if (b) core = `**${core}**`; else if (i) core = `*${core}*`;
    return m[1] + core + m[3];
  }).join('').trim();
}

export interface PdfTextResult { text: string; pages: number; paragraphs: number; headings: number; dropped: number }

export async function pdfToStory(bytes: Uint8Array, onProgress?: (page: number, pages: number) => void): Promise<PdfTextResult> {
  const { doc, close: closeDoc } = await openPdf(bytes);
  const pages: Line[][] = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    pages.push(await pageLines(page, n));
    page.cleanup();
    onProgress?.(n, doc.numPages);
  }
  await closeDoc();

  // Running heads and folios: bare page numbers, or the first / last line of a page whose text
  // (numbers aside) recurs on many pages.
  const norm = (s: string) => s.toLowerCase().replace(/[0-9ivxlc]+/g, '#').replace(/\s+/g, ' ').trim();
  const edgeCount = new Map<string, number>();
  for (const ls of pages) for (const l of [ls[0], ls[1], ls[ls.length - 2], ls[ls.length - 1]]) if (l) edgeCount.set(norm(l.text), (edgeCount.get(norm(l.text)) ?? 0) + 1);
  const minRepeat = Math.max(3, pages.length * 0.25);
  let dropped = 0;
  const body = pages.map((ls) => ls.filter((l, k) => {
    const edge = k <= 1 || k >= ls.length - 2;
    const folio = /^[\divxlcIVXLC]{1,6}$/.test(l.text.replace(/[\s.–—-]/g, ''));
    const repeated = edge && (edgeCount.get(norm(l.text)) ?? 0) >= minRepeat && pages.length > 2;
    if ((edge && folio) || repeated) { dropped++; return false; }
    return true;
  }));

  // Body measures: the commonest size, line spacing, left edge and right edge.
  const all = body.flat();
  const bodySize = median(all.map((l) => Math.round(l.size * 2) / 2));
  const isBody = (l: Line) => Math.abs(l.size - bodySize) < bodySize * 0.12;
  const gaps: number[] = [];
  for (const ls of body) for (let k = 1; k < ls.length; k++) if (isBody(ls[k]) && isBody(ls[k - 1])) { const g = ls[k - 1].y - ls[k].y; if (g > 0 && g < bodySize * 3) gaps.push(g); }
  const lead = median(gaps) || bodySize * 1.2;
  const left = median(all.filter(isBody).map((l) => Math.round(l.x)));
  const right = (() => { const e = all.filter(isBody).map((l) => l.end).sort((a, b) => a - b); return e.length ? e[Math.floor(e.length * 0.9)] : 0; })();

  const paras: { text: string; head: 0 | 1 | 2 }[] = [];
  let curP = null as { parts: string[]; head: 0 | 1 | 2 } | null;
  const close = () => {
    if (!curP) return;
    let text = '';
    for (const part of curP.parts) {
      // A word hyphenated at the line end joins up again.
      if (/[a-z]-$/i.test(text) && /^[a-z]/.test(part)) text = text.slice(0, -1) + part;
      else text = text ? `${text} ${part}` : part;
    }
    paras.push({ text: text.replace(/­/g, ''), head: curP.head });
    curP = null;
  };
  let prev = null as Line | null;
  let headings = 0;
  for (const ls of body) {
    for (let k = 0; k < ls.length; k++) {
      const l = ls[k];
      const md = lineMarkup(l);
      const head: 0 | 1 | 2 = l.size >= bodySize * 1.6 ? 1 : l.size >= bodySize * 1.2 ? 2 : 0;
      let fresh = !curP || head !== curP.head || !!head;
      if (!fresh && prev) {
        const samePage = prev.page === l.page;
        const gap = samePage ? prev.y - l.y : lead;
        const indented = l.x > left + bodySize * 0.8 && l.x < left + bodySize * 6;
        const prevShort = prev.end < right - bodySize * 2.5;
        const prevEnds = /[.!?:;”’"')\]]$/.test(prev.text);
        fresh = gap > lead * 1.45 || indented || (prevShort && prevEnds);
        // Across a page turn, an unfinished sentence carries on.
        if (!samePage && !indented && !/[.!?]["”’)]?$/.test(prev.text)) fresh = false;
      }
      if (head && curP?.head === head && prev && prev.page === l.page && prev.y - l.y < l.size * 1.6) fresh = false;
      if (fresh) { close(); curP = { parts: [], head }; if (head) headings++; }
      curP!.parts.push(md);
      prev = l;
    }
  }
  close();
  const text = paras.map((p) => {
    const t = p.head ? `${p.head === 1 ? '#' : '##'} ${p.text.replace(/^\*+|\*+$/g, '')}` : /^(#|- |• |\d+[.)] |[a-z]\) |\[|---\s*$)/.test(p.text) ? '\\' + p.text : p.text;
    return t;
  }).join('\n');
  return { text, pages: pages.length, paragraphs: paras.length, headings, dropped };
}

/**
 * Word (.docx) import: the document's paragraphs become story markup, keeping what a typesetter
 * needs from a manuscript and dropping the rest.
 *
 *   headings → # / ##    italic, bold, small caps → * ** ^    super/subscript, underline, strike
 *   footnotes / endnotes → {fn:…} / {en:…}    lists → - / 1.    tabs, line and page breaks
 *   centred / right-aligned paragraphs → [{align:…}]    other named styles → [Style] when the
 *   book has a paragraph style of that name
 *
 * The .docx container is a zip; it is read with the browser's DecompressionStream.
 */

export interface ZipEntry { name: string; method: number; size: number; offset: number }

export function zipEntries(buf: Uint8Array): ZipEntry[] {
  try {
    return readZipDirectory(buf);
  } catch (e) {
    // A cut-off or damaged file reads past its end: say what that means.
    if (e instanceof RangeError) throw new Error('the file is damaged or incomplete (its zip directory cannot be read)');
    throw e;
  }
}

function readZipDirectory(buf: Uint8Array): ZipEntry[] {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  // End of central directory: scan back from the end for its signature.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('not a .docx / .idml file (no zip directory found)');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const out: ZipEntry[] = [];
  const dec = new TextDecoder();
  for (let k = 0; k < count && dv.getUint32(p, true) === 0x02014b50; k++) {
    const method = dv.getUint16(p + 10, true);
    const size = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true), extraLen = dv.getUint16(p + 30, true), commentLen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const name = dec.decode(buf.subarray(p + 46, p + 46 + nameLen));
    // Data starts after the local header, whose name / extra lengths may differ from the central copy.
    const lNameLen = dv.getUint16(local + 26, true), lExtraLen = dv.getUint16(local + 28, true);
    out.push({ name, method, size, offset: local + 30 + lNameLen + lExtraLen });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

export async function readEntry(buf: Uint8Array, e: ZipEntry): Promise<string> {
  const data = buf.subarray(e.offset, e.offset + e.size);
  if (e.method === 0) return new TextDecoder().decode(data);
  if (e.method !== 8) throw new Error(`unsupported compression in ${e.name}`);
  const stream = new Blob([data.slice()]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  try {
    return await new Response(stream).text();
  } catch {
    // The browser reports bad deflate data as "Failed to fetch".
    throw new Error(`the file is damaged (${e.name} cannot be unpacked)`);
  }
}

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const kids = (el: Element, local: string) => Array.from(el.childNodes).filter((n): n is Element => n.nodeType === 1 && (n as Element).localName === local);
const kid = (el: Element | null | undefined, local: string) => (el ? kids(el, local)[0] ?? null : null);
const val = (el: Element | null) => el?.getAttributeNS(W, 'val') ?? el?.getAttribute('w:val') ?? null;
const on = (el: Element | null) => !!el && !/^(0|false|off|none)$/i.test(val(el) ?? 'true');

interface Look { i: boolean; b: boolean; sc: boolean; caps: boolean; sup: boolean; sub: boolean; u: boolean; s: boolean }
const PLAIN: Look = { i: false, b: false, sc: false, caps: false, sup: false, sub: false, u: false, s: false };
const sameLook = (a: Look, b: Look) => (Object.keys(a) as (keyof Look)[]).every((k) => a[k] === b[k]);

/** Escape characters the story markup would read as formatting. */
const esc = (t: string) => t.replace(/([\\*^{}<>])/g, '\\$1');

export interface DocxResult { text: string; paragraphs: number; notes: number }

export async function docxToStory(file: Blob, paraStyleNames: string[] = []): Promise<DocxResult> {
  const buf = new Uint8Array(await file.arrayBuffer());
  const entries = zipEntries(buf);
  const get = async (name: string) => { const e = entries.find((x) => x.name === name); return e ? readEntry(buf, e) : null; };
  const docXml = await get('word/document.xml');
  if (!docXml) throw new Error('no word/document.xml inside');
  const parse = (s: string) => new DOMParser().parseFromString(s, 'application/xml');
  const doc = parse(docXml);

  // Style names (Heading 1, Quote …) by style id.
  const styleName = new Map<string, string>();
  const stylesXml = await get('word/styles.xml');
  if (stylesXml) for (const st of Array.from(parse(stylesXml).getElementsByTagNameNS(W, 'style'))) {
    const id = st.getAttributeNS(W, 'styleId') ?? st.getAttribute('w:styleId');
    const name = val(kid(st, 'name'));
    if (id && name) styleName.set(id, name);
  }
  // Numbering: bullet or numbered, per numId and level.
  const numFmt = new Map<string, string>();
  const numXml = await get('word/numbering.xml');
  if (numXml) {
    const nx = parse(numXml);
    const abs = new Map<string, Element>();
    for (const a of Array.from(nx.getElementsByTagNameNS(W, 'abstractNum'))) abs.set(a.getAttributeNS(W, 'abstractNumId') ?? a.getAttribute('w:abstractNumId') ?? '', a);
    for (const n of Array.from(nx.getElementsByTagNameNS(W, 'num'))) {
      const id = n.getAttributeNS(W, 'numId') ?? n.getAttribute('w:numId') ?? '';
      const a = abs.get(val(kid(n, 'abstractNumId')) ?? '');
      if (!a) continue;
      for (const lvl of kids(a, 'lvl')) numFmt.set(`${id}:${lvl.getAttributeNS(W, 'ilvl') ?? lvl.getAttribute('w:ilvl')}`, val(kid(lvl, 'numFmt')) ?? 'decimal');
    }
  }

  let notes = 0;
  const noteText = new Map<string, string>();
  for (const [file, tag] of [['word/footnotes.xml', 'footnote'], ['word/endnotes.xml', 'endnote']] as const) {
    const x = await get(file);
    if (!x) continue;
    for (const n of Array.from(parse(x).getElementsByTagNameNS(W, tag))) {
      const id = n.getAttributeNS(W, 'id') ?? n.getAttribute('w:id') ?? '';
      const type = n.getAttributeNS(W, 'type') ?? n.getAttribute('w:type');
      if (type === 'separator' || type === 'continuationSeparator') continue;
      noteText.set(`${tag}:${id}`, kids(n, 'p').map((p) => inline(p).trim()).filter(Boolean).join(' '));
    }
  }

  /** A paragraph's runs as story markup. */
  function inline(p: Element): string {
    const segs: { t: string; look: Look }[] = [];
    const walk = (el: Element) => {
      for (const c of Array.from(el.childNodes)) {
        if (c.nodeType !== 1) continue;
        const e = c as Element;
        if (e.localName === 'r') run(e);
        else if (e.localName === 'hyperlink' || e.localName === 'ins' || e.localName === 'smartTag' || e.localName === 'sdt' || e.localName === 'sdtContent' || e.localName === 'fldSimple') walk(e);
      }
    };
    const run = (r: Element) => {
      const pr = kid(r, 'rPr');
      const va = val(kid(pr, 'vertAlign'));
      const u = kid(pr, 'u');
      const look: Look = {
        i: on(kid(pr, 'i')), b: on(kid(pr, 'b')), sc: on(kid(pr, 'smallCaps')), caps: on(kid(pr, 'caps')),
        sup: va === 'superscript', sub: va === 'subscript', u: !!u && val(u) !== 'none', s: on(kid(pr, 'strike')) || on(kid(pr, 'dstrike')),
      };
      for (const c of Array.from(r.childNodes)) {
        if (c.nodeType !== 1) continue;
        const e = c as Element;
        switch (e.localName) {
          case 't': segs.push({ t: esc(e.textContent ?? ''), look }); break;
          case 'tab': segs.push({ t: '\t', look: PLAIN }); break;
          case 'br': segs.push({ t: (e.getAttributeNS(W, 'type') ?? e.getAttribute('w:type')) === 'page' ? '\u0000PAGE' : '{br}', look: PLAIN }); break;
          case 'noBreakHyphen': segs.push({ t: '{nbhy}', look }); break;
          case 'softHyphen': segs.push({ t: '{shy}', look }); break;
          case 'sym': segs.push({ t: String.fromCharCode(parseInt(e.getAttributeNS(W, 'char') ?? e.getAttribute('w:char') ?? '20', 16) & 0xffff), look }); break;
          case 'footnoteReference': case 'endnoteReference': {
            const tag = e.localName === 'footnoteReference' ? 'footnote' : 'endnote';
            const t = noteText.get(`${tag}:${e.getAttributeNS(W, 'id') ?? e.getAttribute('w:id')}`);
            if (t != null) { notes++; segs.push({ t: `{${tag === 'footnote' ? 'fn' : 'en'}:${t}}`, look: PLAIN }); }
            break;
          }
        }
      }
    };
    walk(p);
    // Merge runs with the same look, then wrap each in its markup.
    const merged: { t: string; look: Look }[] = [];
    for (const s of segs) {
      const last = merged[merged.length - 1];
      if (last && sameLook(last.look, s.look)) last.t += s.t; else merged.push({ ...s });
    }
    return merged.map(({ t, look }) => {
      if (!t.trim() || t.startsWith('{fn:') || t.startsWith('{en:')) return t;
      // Keep surrounding spaces outside the markers so *…* still closes on a letter.
      const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(t)!;
      let core = m[2];
      if (look.caps) core = core.toUpperCase();
      if (look.sc) core = `^${core}^`;
      if (look.i && look.b) core = `***${core}***`;
      else if (look.b) core = `**${core}**`;
      else if (look.i) core = `*${core}*`;
      const props = [look.sup && 'super', look.sub && 'sub', look.u && 'underline', look.s && 'strike'].filter(Boolean);
      if (props.length) core = `<{${props.join('; ')}}>${core}</>`;
      return m[1] + core + m[3];
    }).join('');
  }

  const known = new Map(paraStyleNames.map((n) => [n.toLowerCase(), n]));
  const out: string[] = [];
  let paragraphs = 0;
  const body = kid(doc.documentElement, 'body');
  const blocks = body ? Array.from(body.childNodes).filter((n): n is Element => n.nodeType === 1) : [];
  const para = (p: Element) => {
    const pr = kid(p, 'pPr');
    const sid = val(kid(pr, 'pStyle')) ?? '';
    const sname = styleName.get(sid) ?? sid;
    let text = inline(p);
    const breaks = text.split('\u0000PAGE');
    text = breaks.join('');
    let prefix = '';
    if (/^(title|heading 1|heading1)$/i.test(sname)) prefix = '# ';
    else if (/^(subtitle|heading [2-6]|heading[2-6])$/i.test(sname)) prefix = '## ';
    else if (known.has(sname.toLowerCase())) prefix = `[${known.get(sname.toLowerCase())}] `;
    const numPr = kid(pr, 'numPr');
    if (numPr && !prefix) {
      const lvl = parseInt(val(kid(numPr, 'ilvl')) ?? '0', 10) || 0;
      const fmt = numFmt.get(`${val(kid(numPr, 'numId'))}:${lvl}`) ?? 'bullet';
      prefix = '  '.repeat(lvl) + (fmt === 'bullet' ? '- ' : fmt === 'lowerLetter' ? 'a) ' : '1. ');
    }
    const jc = val(kid(pr, 'jc'));
    const align = jc === 'center' ? 'center' : jc === 'right' || jc === 'end' ? 'right' : null;
    if (align && !prefix.startsWith('#')) prefix = `[{align:${align}}] ` + prefix;
    // A literal leading marker would be read as markup.
    if (!prefix && /^(#|- |• |\d+[.)] |[a-z]\) |\[|---\s*$)/.test(text)) text = '\\' + text;
    if (breaks.length > 1 && out.length) out.push('{frame}');
    if (text.trim() || prefix) { out.push(prefix + text.replace(/\n/g, ' ')); paragraphs++; }
    else out.push('');
  };
  for (const b of blocks) {
    if (b.localName === 'p') para(b);
    else if (b.localName === 'tbl') {
      // Tables come in as tab-separated lines (make a table from them with the table tool).
      for (const tr of kids(b, 'tr')) out.push(kids(tr, 'tc').map((tc) => kids(tc, 'p').map((p) => inline(p).trim()).join(' ')).join('\t'));
    } else if (b.localName === 'sdt') for (const p of Array.from(b.getElementsByTagNameNS(W, 'p'))) para(p);
  }
  // Empty paragraphs go (Word users space with returns; the book's styles set the spacing).
  const text = out.filter((l) => l.trim() !== '').join('\n').trim();
  return { text, paragraphs, notes };
}

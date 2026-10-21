/**
 * InDesign Markup (.idml) → story markup. An IDML package is a zip of XML: designmap.xml lists the
 * stories, and each story is ParagraphStyleRange › CharacterStyleRange › Content / Br runs.
 *
 * The main text flow is taken: the stories that hold most of the document's text (small stories,
 * such as folios and captions, are left out), in the document's order, a frame break between them.
 * Headings come from paragraph style names; italic, bold, small caps, super- and subscript,
 * underline and strikethrough from the character ranges; footnotes become {fn:…}; centred and
 * right-aligned paragraphs keep their alignment. Book paragraph styles of the same name are applied.
 */
import { zipEntries, readEntry } from './docx';

const esc = (t: string) => t.replace(/([\\*^{}<>])/g, '\\$1');
const styleName = (ref: string | null) => decodeURIComponent((ref ?? '').replace(/^(Paragraph|Character)Style\//, '').replace(/^\$ID\//, '').replace(/%3a/gi, ':'));

interface Look { i: boolean; b: boolean; sc: boolean; sup: boolean; sub: boolean; u: boolean; s: boolean }

function lookOf(r: Element): Look {
  const fs = r.getAttribute('FontStyle') ?? '';
  const cs = styleName(r.getAttribute('AppliedCharacterStyle')).toLowerCase();
  const pos = r.getAttribute('Position') ?? '';
  return {
    i: /italic|oblique/i.test(fs) || /italic|emphasis/.test(cs),
    b: /bold|black|heavy|semibold/i.test(fs) || /bold|strong/.test(cs),
    sc: r.getAttribute('Capitalization') === 'SmallCaps' || /small ?caps/.test(cs),
    sup: /Superscript/.test(pos), sub: /Subscript/.test(pos),
    u: r.getAttribute('Underline') === 'true', s: r.getAttribute('StrikeThru') === 'true',
  };
}

function wrap(t: string, l: Look): string {
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(t)!;
  let core = m[2];
  if (!core) return t;
  if (l.sc) core = `^${core}^`;
  if (l.i && l.b) core = `***${core}***`; else if (l.b) core = `**${core}**`; else if (l.i) core = `*${core}*`;
  const props = [l.sup && 'super', l.sub && 'sub', l.u && 'underline', l.s && 'strike'].filter(Boolean);
  if (props.length) core = `<{${props.join('; ')}}>${core}</>`;
  return m[1] + core + m[3];
}

export interface IdmlResult { text: string; paragraphs: number; notes: number; stories: number; skipped: number }

export async function idmlToStory(file: Blob, paraStyleNames: string[] = []): Promise<IdmlResult> {
  const buf = new Uint8Array(await file.arrayBuffer());
  const entries = zipEntries(buf);
  const get = async (name: string) => { const e = entries.find((x) => x.name === name); return e ? readEntry(buf, e) : null; };
  const parse = (s: string) => new DOMParser().parseFromString(s, 'application/xml');
  const design = await get('designmap.xml');
  if (!design) throw new Error('not an IDML package (no designmap.xml)');
  const order = [...design.matchAll(/<idPkg:Story\s+src="([^"]+)"/g)].map((m) => m[1]);
  const files = order.length ? order : entries.map((e) => e.name).filter((n) => /^Stories\/.*\.xml$/.test(n));
  const known = new Map(paraStyleNames.map((n) => [n.toLowerCase(), n]));

  let notes = 0;
  const stories: { paras: string[]; chars: number }[] = [];
  for (const f of files) {
    const xml = await get(f);
    if (!xml) continue;
    const story = parse(xml).getElementsByTagName('Story')[0];
    if (!story) continue;
    const paras: string[] = [];
    let chars = 0;
    // Walk the paragraph ranges; a <Br/> ends a paragraph.
    const ranges = Array.from(story.children).filter((e) => e.localName === 'ParagraphStyleRange');
    const noteText = (fn: Element) => Array.from(fn.getElementsByTagName('Content')).map((c) => c.textContent ?? '').join('').replace(/\s+/g, ' ').trim();
    for (const pr of ranges) {
      const pname = styleName(pr.getAttribute('AppliedParagraphStyle'));
      const just = pr.getAttribute('Justification') ?? '';
      let prefix = '';
      if (/^(title|chapter( title| head)?|heading ?1|h1)\b/i.test(pname)) prefix = '# ';
      else if (/^(subtitle|subhead|heading ?[2-6]|h[2-6]|section head)/i.test(pname)) prefix = '## ';
      else if (known.has(pname.toLowerCase())) prefix = `[${known.get(pname.toLowerCase())}] `;
      if (/Center/.test(just) && !prefix.startsWith('#')) prefix = '[{align:center}] ' + prefix;
      else if (/Right/.test(just) && !prefix.startsWith('#')) prefix = '[{align:right}] ' + prefix;
      let cur = '';
      const flush = () => {
        let t = cur.replace(/[ \t]+$/, '').trim();
        cur = '';
        if (!t) return;
        if (!prefix && /^(#|- |• |\d+[.)] |[a-z]\) |\[|---\s*$)/.test(t)) t = '\\' + t;
        paras.push(prefix + t);
      };
      for (const cr of Array.from(pr.children)) {
        if (cr.localName !== 'CharacterStyleRange') continue;
        const look = lookOf(cr);
        for (const n of Array.from(cr.children)) {
          if (n.localName === 'Content') {
            // Forced line breaks (U+2028) and discretionary hyphens (U+00AD) become their codes.
            const t = n.textContent ?? '';
            chars += t.length;
            cur += t.split('\u2028').map((part) => wrap(esc(part).replace(/\u00ad/g, '{shy}'), look)).join('{br}');
          } else if (n.localName === 'Br') flush();
          else if (n.localName === 'Footnote') { const t = noteText(n); if (t) { notes++; cur += `{fn:${esc(t)}}`; } }
          else if (n.localName === 'Tab' || n.localName === 'TabCharacter') cur += '\t';
        }
      }
      flush();
    }
    stories.push({ paras, chars });
  }
  // The main flow: stories with a good share of the text, in document order.
  const longest = Math.max(0, ...stories.map((s) => s.chars));
  const main = stories.filter((s) => s.chars >= Math.max(200, longest * 0.15));
  const kept = main.length ? main : stories.filter((s) => s.chars === longest);
  const text = kept.map((s) => s.paras.join('\n')).filter(Boolean).join('\n{frame}\n');
  return { text, paragraphs: kept.reduce((n, s) => n + s.paras.length, 0), notes, stories: kept.length, skipped: stories.length - kept.length };
}

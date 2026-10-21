/**
 * Rich Text Format → story markup: paragraphs, headings (from the stylesheet's names), italic, bold,
 * small caps, super- and subscript, underline, strikethrough, footnotes, tabs, line and page breaks,
 * centred and right-aligned paragraphs, and Unicode text (\uN, \'hh in the document's code page).
 */

interface Look { i: boolean; b: boolean; sc: boolean; caps: boolean; sup: boolean; sub: boolean; u: boolean; s: boolean }
interface State extends Look { skip: boolean; uc: number; style: number; align: 'left' | 'center' | 'right' | null; fn: boolean }

const PLAIN: Look = { i: false, b: false, sc: false, caps: false, sup: false, sub: false, u: false, s: false };
const sameLook = (a: Look, b: Look) => (Object.keys(PLAIN) as (keyof Look)[]).every((k) => a[k] === b[k]);
const esc = (t: string) => t.replace(/([\\*^{}<>])/g, '\\$1');

/** Groups whose text is never part of the story. */
const SKIP = new Set(['fonttbl', 'colortbl', 'stylesheet', 'info', 'pict', 'header', 'headerl', 'headerr', 'headerf', 'footer', 'footerl', 'footerr', 'footerf', 'listtable', 'listoverridetable', 'rsidtbl', 'generator', 'xmlnstbl', 'themedata', 'colorschememapping', 'latentstyles', 'datastore', 'fldinst', 'object', 'shp', 'nonshppict', 'filetbl', 'revtbl', 'pgdsctbl']);

function wrap(t: string, look: Look): string {
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(t)!;
  let core = m[2];
  if (!core) return t;
  if (look.caps) core = core.toUpperCase();
  if (look.sc) core = `^${core}^`;
  if (look.i && look.b) core = `***${core}***`; else if (look.b) core = `**${core}**`; else if (look.i) core = `*${core}*`;
  const props = [look.sup && 'super', look.sub && 'sub', look.u && 'underline', look.s && 'strike'].filter(Boolean);
  if (props.length) core = `<{${props.join('; ')}}>${core}</>`;
  return m[1] + core + m[3];
}

export interface RtfResult { text: string; paragraphs: number; notes: number }

export function rtfToStory(src: string, paraStyleNames: string[] = []): RtfResult {
  // Stylesheet: style number → name (for headings and the book's own styles).
  const styleNames = new Map<number, string>();
  const sheet = /\{\\stylesheet([\s\S]*?)\}\s*(?:\{\\\*?\\?(?:listtable|info|generator|rsidtbl)|\\pard|\{\\info)/.exec(src);
  if (sheet) for (const m of sheet[1].matchAll(/\{[^{}]*?\\s(\d+)[^{}]*?\s([^\\{};][^;{}]*);\s*\}/g)) styleNames.set(parseInt(m[1], 10), m[2].trim());
  const known = new Map(paraStyleNames.map((n) => [n.toLowerCase(), n]));

  const paras: string[] = [];
  let notes = 0;
  let segs: { t: string; look: Look }[] = [];
  let noteSegs: { t: string; look: Look }[] | null = null;
  let st: State = { ...PLAIN, skip: false, uc: 1, style: 0, align: null, fn: false };
  const stack: State[] = [];
  let pendingSkip = 0;
  let paraStyle = 0, paraAlign: State['align'] = null;

  const out = () => (st.fn && noteSegs ? noteSegs : segs);
  const emit = (t: string) => {
    if (st.skip || !t) return;
    if (pendingSkip > 0) { const n = Math.min(pendingSkip, t.length); pendingSkip -= n; t = t.slice(n); if (!t) return; }
    const list = out();
    const last = list[list.length - 1];
    const look: Look = { i: st.i, b: st.b, sc: st.sc, caps: st.caps, sup: st.sup, sub: st.sub, u: st.u, s: st.s };
    if (last && !last.t.startsWith('\u0001') && sameLook(last.look, look)) last.t += t; else list.push({ t, look });
  };
  const render = (list: { t: string; look: Look }[]) => list.map(({ t, look }) => (t.startsWith('\u0001') ? t.slice(1) : wrap(esc(t).replace(/\u0002/g, '\t'), look))).join('');
  const raw = (t: string) => { const list = out(); list.push({ t: '\u0001' + t, look: PLAIN }); };
  const endPara = () => {
    let text = render(segs).replace(/[ \t]+$/, '');
    segs = [];
    const name = styleNames.get(paraStyle) ?? '';
    let prefix = '';
    if (/^(title|heading 1|heading1|chapter)/i.test(name)) prefix = '# ';
    else if (/^(subtitle|heading [2-6]|heading[2-6])/i.test(name)) prefix = '## ';
    else if (known.has(name.toLowerCase())) prefix = `[${known.get(name.toLowerCase())}] `;
    if (paraAlign && paraAlign !== 'left' && !prefix.startsWith('#')) prefix = `[{align:${paraAlign}}] ` + prefix;
    if (!prefix && /^(#|- |• |\d+[.)] |[a-z]\) |\[|---\s*$)/.test(text)) text = '\\' + text;
    if (text.trim()) paras.push(prefix + text.trim());
  };

  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '{') {
      stack.push({ ...st });
      i++;
      // Ignorable destinations ({\*\foo …}) and known non-text groups are skipped whole.
      const dest = /^\\\*?\\?([a-z]+)/.exec(src.slice(i, i + 40));
      if (src.startsWith('\\*', i) || (dest && SKIP.has(dest[1]))) st.skip = true;
      continue;
    }
    if (ch === '}') {
      const wasNote = st.fn && !(stack[stack.length - 1]?.fn);
      if (wasNote && noteSegs) {
        const note = render(noteSegs).replace(/\s+/g, ' ').trim();
        noteSegs = null;
        st = stack.pop() ?? st;
        if (note) { notes++; raw(`{fn:${note}}`); }
        i++;
        continue;
      }
      st = stack.pop() ?? st;
      i++;
      continue;
    }
    if (ch === '\\') {
      const next = src[i + 1];
      if (next === '\\' || next === '{' || next === '}') { emit(next); i += 2; continue; }
      if (next === '~') { emit(' '); i += 2; continue; }
      if (next === '-') { raw('{shy}'); i += 2; continue; }
      if (next === '_') { raw('{nbhy}'); i += 2; continue; }
      if (next === '\'') { emit(String.fromCharCode(cp1252(parseInt(src.substr(i + 2, 2), 16)))); i += 4; continue; }
      if (next === '\n' || next === '\r') { if (!st.skip) endPara(); i += 2; continue; }
      const m = /^\\([a-zA-Z]+)(-?\d+)? ?/.exec(src.slice(i, i + 40));
      if (!m) { i++; continue; }
      i += m[0].length;
      const word = m[1], arg = m[2] != null ? parseInt(m[2], 10) : null;
      const on = arg !== 0;
      switch (word) {
        case 'par': if (!st.skip && !st.fn) endPara(); else if (st.fn) emit(' '); break;
        case 'line': if (!st.skip) raw('{br}'); break;
        case 'page': if (!st.skip && !st.fn) { endPara(); paras.push('{frame}'); } break;
        case 'tab': emit('\u0002'); break;
        case 'emdash': emit('—'); break;
        case 'endash': emit('–'); break;
        case 'lquote': emit('‘'); break;
        case 'rquote': emit('’'); break;
        case 'ldblquote': emit('“'); break;
        case 'rdblquote': emit('”'); break;
        case 'bullet': emit('•'); break;
        case 'u': { if (arg != null) emit(String.fromCharCode(arg < 0 ? arg + 65536 : arg)); pendingSkip = st.uc; break; }
        case 'uc': st.uc = arg ?? 1; break;
        case 'i': st.i = on; break;
        case 'b': st.b = on; break;
        case 'scaps': st.sc = on; break;
        case 'caps': st.caps = on; break;
        case 'super': st.sup = on; st.sub = false; break;
        case 'sub': st.sub = on; st.sup = false; break;
        case 'nosupersub': st.sup = st.sub = false; break;
        case 'ul': st.u = on; break;
        case 'ulnone': st.u = false; break;
        case 'strike': case 'striked': st.s = on; break;
        case 'plain': Object.assign(st, PLAIN); break;
        case 'pard': paraStyle = 0; paraAlign = null; break;
        case 's': if (arg != null && !st.skip) paraStyle = arg; break;
        case 'qc': paraAlign = 'center'; break;
        case 'qr': paraAlign = 'right'; break;
        case 'ql': case 'qj': paraAlign = null; break;
        case 'footnote': st.fn = true; st.skip = false; noteSegs = []; break;
        case 'chftn': break;
        default:
          if (SKIP.has(word)) st.skip = true;
      }
      continue;
    }
    if (ch === '\r' || ch === '\n') { i++; continue; }
    // Plain text up to the next control character.
    let j = i;
    while (j < src.length && src[j] !== '\\' && src[j] !== '{' && src[j] !== '}' && src[j] !== '\r' && src[j] !== '\n') j++;
    emit(src.slice(i, j));
    i = j;
  }
  if (segs.length) endPara();
  return { text: paras.join('\n'), paragraphs: paras.filter((p) => p !== '{frame}').length, notes };
}

/** Windows-1252 for \'hh escapes (the common case; other code pages map through Latin-1). */
function cp1252(b: number): number {
  const hi: Record<number, number> = { 0x80: 0x20ac, 0x82: 0x201a, 0x83: 0x192, 0x84: 0x201e, 0x85: 0x2026, 0x86: 0x2020, 0x87: 0x2021, 0x88: 0x2c6, 0x89: 0x2030, 0x8a: 0x160, 0x8b: 0x2039, 0x8c: 0x152, 0x8e: 0x17d, 0x91: 0x2018, 0x92: 0x2019, 0x93: 0x201c, 0x94: 0x201d, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014, 0x98: 0x2dc, 0x99: 0x2122, 0x9a: 0x161, 0x9b: 0x203a, 0x9c: 0x153, 0x9e: 0x17e, 0x9f: 0x178 };
  return hi[b] ?? b;
}

/**
 * Story parsing: the markup of a story becomes paragraphs of words.
 *
 * Paragraph level (one paragraph per line):
 *   # Heading · ## Subhead · --- section break · {col} / {frame} on a line: break to the next column / frame
 *   [Style name] … · [{align:center; before:12}] …   (named and local paragraph formatting, combinable)
 *   - item · • item · 1. item · a) item              (lists; two spaces or a tab per level)
 * Character level:
 *   *italic* · **bold** · ^small caps^ · <Style>…</Style> · <{size:14; color:#c00}>…</> · \* escapes
 *   {k:-20} kern · {br} forced line break · {tab} / tab · {rtab} right-indent tab · {here} indent to here
 *   {shy} discretionary hyphen · {nbsp} {thin} {hair} {en} {em} {figure} spaces · {nbhy} non-breaking hyphen
 *   {fn:footnote text} footnote
 * Paragraph styles may add nested styles (run-in heads) and GREP styles (pattern → character style).
 */
import type {
  TextStyle, ParagraphStyleProps, CharacterStyleProps, ParagraphStyleDef, CharacterStyleDef, ListSpec,
} from '../../model/types';
import { applyParagraphStyle, mergeCs, mergePara, parseCharProps, parseParaProps } from './props';
import { toRoman } from '../../model/units';

/** The project's named styles, hyphenation exceptions and images (for inline graphics). */
export interface StoryStyles {
  para: ParagraphStyleDef[];
  char: CharacterStyleDef[];
  hyphenation?: string[];
  images?: Record<string, { href: string; w: number; h: number }>;
  /** Conditional text whose condition is hidden. */
  hiddenConditions?: string[];
}

/**
 * Conditional text: `{if:Name}…{/if}` (nestable, may span paragraphs) is kept when the condition is
 * shown and removed when it is hidden; the tags themselves never print.
 */
export function applyConditions(text: string, hidden: string[] | undefined): string {
  if (!text.includes('{if:')) return text;
  const hide = new Set((hidden ?? []).map((h) => h.trim().toLowerCase()));
  let out = '';
  const stack: boolean[] = [];
  const re = /\{if:([^}]*)\}|\{\/if\}/g;
  let last = 0;
  let m: RegExpExecArray | null;
  const visible = () => stack.every((v) => v);
  while ((m = re.exec(text))) {
    if (visible()) out += text.slice(last, m.index);
    if (m[1] != null) stack.push(!hide.has(m[1].trim().toLowerCase()));
    else stack.pop();
    last = m.index + m[0].length;
  }
  if (visible()) out += text.slice(last);
  return out;
}

/** An inline graphic: `{img:assetId; w:120; h:80; shift:2}` (w may be a % of the column). */
export interface InlineObj { id: string; w?: number; h?: number; pct?: number; shift?: number }

export interface SpanStyle { italic: boolean; bold: boolean; sc: boolean; cs: CharacterStyleProps | null; fn?: boolean; obj?: InlineObj; ruby?: string; wari?: [string, string] }
/** `kern[i]`: manual kerning after UTF-16 unit `i`, thousandths of an em. */
export interface Piece { text: string; st: SpanStyle; kern?: number[] }
/** What separates a word from the one before it. */
export type Sep = 'start' | 'none' | 'space' | 'tab' | 'rtab' | 'br';
export interface Word {
  pieces: Piece[];
  text: string;
  before: Sep;
  /** `{here}` stands before this word: later lines of the paragraph indent to it. */
  here?: boolean;
  /** Discretionary hyphens (positions in `text`); they replace automatic hyphenation for the word. */
  shy?: number[];
  /** Index entries marked in this word ({ix:term} or {ix:term!sub}). */
  ix?: string[];
  /** Cross-reference anchors set in this word ({anchor:name}). */
  anchors?: string[];
}
export type ParaKind = 'body' | 'h1' | 'h2' | 'break';
export interface Footnote { n: number; label: string; text: string }
export interface Paragraph {
  kind: ParaKind;
  words: Word[];
  first: boolean;
  /** Effective style: the frame style with the paragraph's styles applied. */
  style: TextStyle;
  pstyle: ParagraphStyleProps | null;
  list: ListSpec | null;
  marker: string | null;
  level: number;
  breakBefore: 'column' | 'frame' | 'odd' | 'even' | null;
  footnotes: Footnote[];
  hasTabs: boolean;
  /** A paragraph holding nothing but one graphic: an anchored figure in the text flow. */
  figure?: InlineObj | null;
  /** Names of the paragraph styles tagged on it (running heads by style). */
  styleNames?: string[];
}

export const PLAIN: SpanStyle = { italic: false, bold: false, sc: false, cs: null };
export const nameKey = (n: string) => n.trim().toLowerCase();

/* -------------------------------------------------------------------------- */
/* Numbering                                                                   */
/* -------------------------------------------------------------------------- */

const alpha = (n: number) => { let s = ''; for (let k = n; k > 0; k = Math.floor((k - 1) / 26)) s = String.fromCharCode(97 + ((k - 1) % 26)) + s; return s || 'a'; };

export function formatNumber(n: number, format: ListSpec['format'] = 'decimal'): string {
  switch (format) {
    case 'lower-alpha': return alpha(n);
    case 'upper-alpha': return alpha(n).toUpperCase();
    case 'lower-roman': return toRoman(n).toLowerCase();
    case 'upper-roman': return toRoman(n, true);
    default: return String(n);
  }
}

const SYMBOLS = ['*', '†', '‡', '§', '‖', '¶'];
export function footnoteLabel(n: number, kind: TextStyle['footnoteNumbering'] = 'decimal'): string {
  switch (kind) {
    case 'roman': return toRoman(n).toLowerCase();
    case 'alpha': return alpha(n);
    case 'symbols': return SYMBOLS[(n - 1) % SYMBOLS.length].repeat(Math.floor((n - 1) / SYMBOLS.length) + 1);
    default: return String(n);
  }
}

/* -------------------------------------------------------------------------- */
/* Nested & GREP styles                                                        */
/* -------------------------------------------------------------------------- */

/** Markup that rule-based styles must never match into: tags, {…} codes, * ^ and escapes. */
function maskMarkup(s: string): boolean[] {
  const mask = new Array<boolean>(s.length).fill(false);
  const re = /<\/?(?:\{[^}]*\}|[^<>]{0,60})>|\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}|\\.|[*^]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) for (let i = m.index; i < m.index + m[0].length; i++) mask[i] = true;
  return mask;
}

function applyRuleStyles(body: string, eff: TextStyle, cmap: Map<string, CharacterStyleProps>): string {
  const nested = (eff.nestedStyles ?? []).filter((n) => cmap.has(nameKey(n.style)) && n.count > 0);
  const grep = (eff.grepStyles ?? []).filter((g) => cmap.has(nameKey(g.style)) && g.pattern);
  if (!nested.length && !grep.length) return body;
  const mask = maskMarkup(body);
  const wraps: { a: number; b: number; name: string }[] = [];
  // Nested styles run one after another from the start of the paragraph.
  let pos = 0;
  for (const ns of nested) {
    let i = pos, count = 0;
    const done = () => count >= ns.count;
    let inWord = false;
    for (; i < body.length && !done(); i++) {
      if (mask[i]) continue;
      const ch = body[i];
      if (ns.unit === 'characters') { if (!/\s/.test(ch)) count++; }
      else if (ns.unit === 'char') { if (ch === (ns.char ?? '.')) count++; }
      else if (ns.unit === 'sentences') { if (/[.!?]/.test(ch) && (i + 1 >= body.length || /\s/.test(body[i + 1]))) count++; }
      else {
        const sp = /\s/.test(ch);
        if (!sp) inWord = true;
        if (inWord && (sp || i + 1 >= body.length)) { count += 1; inWord = false; if (sp && done()) { i--; } }
      }
    }
    if (i > pos) wraps.push({ a: pos, b: Math.min(i, body.length), name: ns.style });
    pos = i;
    if (pos >= body.length) break;
  }
  // GREP styles: every match of the pattern outside markup.
  for (const g of grep) {
    let re: RegExp;
    try { re = new RegExp(g.pattern, (g.flags ?? '').replace(/g/g, '') + 'g'); } catch { continue; }
    let m: RegExpExecArray | null;
    let guard = 0;
    while ((m = re.exec(body)) && guard++ < 2000) {
      if (!m[0].length) { re.lastIndex++; continue; }
      const a = m.index, b = a + m[0].length;
      let clean = true;
      for (let i = a; i < b; i++) if (mask[i]) { clean = false; break; }
      if (clean) wraps.push({ a, b, name: g.style });
    }
  }
  if (!wraps.length) return body;
  // Insert from the right so earlier offsets stay valid. Tags inserted at the same offset end up
  // in reverse order, so process opens (inner first) before closes (outer first): the result
  // reads closes inner→outer, then opens outer→inner, and wraps nest properly.
  const ins: { at: number; text: string; close: boolean; len: number }[] = [];
  for (const w of wraps) {
    ins.push({ at: w.a, text: `<${w.name}>`, close: false, len: w.b - w.a });
    ins.push({ at: w.b, text: `</${w.name}>`, close: true, len: w.b - w.a });
  }
  ins.sort((x, y) => (y.at - x.at) || (Number(x.close) - Number(y.close)) || (x.close ? y.len - x.len : x.len - y.len));
  let out = body;
  for (const x of ins) out = out.slice(0, x.at) + x.text + out.slice(x.at);
  return out;
}

/* -------------------------------------------------------------------------- */
/* Paragraphs                                                                  */
/* -------------------------------------------------------------------------- */

const LIST_RE = /^((?: {2}|\t)*)(?:([-•▪◦])|(\d{1,3}[.)]|[a-zA-Z]\)))[ \t]+(?=\S)/;

/** Notes ({note:…}, nestable braces) are kept in the story but never set. */
export function stripNotes(text: string): string {
  if (!text.includes('{note:')) return text;
  let out = '';
  for (let i = 0; i < text.length; i++) {
    if (text.startsWith('{note:', i)) {
      let depth = 0, j = i;
      for (; j < text.length; j++) { if (text[j] === '{') depth++; else if (text[j] === '}' && --depth === 0) break; }
      i = j;
      continue;
    }
    out += text[i];
  }
  return out;
}

export function parseStory(text: string, style: TextStyle, styles: StoryStyles | null): Paragraph[] {
  text = applyConditions(stripNotes(text), styles?.hiddenConditions);
  const pmap = new Map((styles?.para ?? []).map((d) => [nameKey(d.name), d.props]));
  const cmap = new Map((styles?.char ?? []).map((d) => [nameKey(d.name), d.props]));
  const paras: Paragraph[] = [];
  const counters: number[] = [];
  const fn = { count: 0, en: 0, endnotes: [] as Footnote[] };
  let afterBreak = true;
  let pendingBreak: Paragraph['breakBefore'] = null;
  for (const rawLine of text.replace(/\r\n?/g, '\n').split('\n')) {
    let line = rawLine.replace(/[ 　]+$/, '');
    if (!line.trim()) continue;
    const brk = /^\s*\{(col|column|frame|odd|even)\}\s*$/i.exec(line);
    if (brk) { const k = brk[1].toLowerCase(); pendingBreak = k === 'frame' ? 'frame' : k === 'odd' || k === 'even' ? k : 'column'; continue; }

    // Paragraph styles: named [Caption] and local [{align:center}], in any combination.
    let pstyle: ParagraphStyleProps | null = null;
    const styleNames: string[] = [];
    for (;;) {
      const m = /^\[([^\]\n]{1,400})\]\s*/.exec(line);
      if (!m) break;
      const inner = m[1].trim();
      if (inner.startsWith('{') && inner.endsWith('}')) pstyle = mergePara(pstyle, parseParaProps(inner.slice(1, -1)));
      else if (pmap.has(nameKey(inner))) { pstyle = mergePara(pstyle, pmap.get(nameKey(inner))!); styleNames.push(inner); }
      else break;
      line = line.slice(m[0].length);
    }
    if (!line.trim()) continue;

    let kind: Paragraph['kind'] = 'body';
    let body = line;
    if (/^#\s/.test(line)) { kind = 'h1'; body = line.slice(2); }
    else if (/^##\s/.test(line)) { kind = 'h2'; body = line.slice(3); }
    else if (/^(-{3,}|\*\s\*\s\*|⁂)$/.test(line.trim())) { kind = 'break'; body = '⁂'; }
    if (kind !== 'body') counters.length = 0;

    const eff = applyParagraphStyle(style, pstyle);
    let list: ListSpec | null = kind === 'body' && eff.list ? { ...eff.list } : null;
    let level = 0;
    let typed: string | null = null;
    if (kind === 'body') {
      const lm = LIST_RE.exec(body);
      if (lm) {
        level = Math.floor(lm[1].replace(/\t/g, '  ').length / 2);
        if (lm[2]) list = { ...(list ?? {}), type: 'bullet', bullet: list?.type === 'bullet' && list.bullet ? list.bullet : lm[2] === '-' ? '•' : lm[2] };
        else { list = { ...(list ?? {}), type: 'number' }; typed = lm[3]; }
        body = body.slice(lm[0].length);
      }
    }
    let marker: string | null = null;
    if (list) {
      const lv = level + (list.level ?? 0);
      level = lv;
      counters.length = lv + 1;
      if (list.type === 'number') {
        if (typed) {
          marker = typed;
          const n = parseInt(typed, 10);
          counters[lv] = Number.isFinite(n) ? n : (counters[lv] ?? 0) + 1;
        } else {
          counters[lv] = list.start != null ? list.start : (counters[lv] ?? 0) + 1;
          const path = list.hierarchical ? counters.slice(0, lv + 1).map((c) => c ?? 1) : [counters[lv]];
          marker = path.map((c) => formatNumber(c, list!.format)).join('.') + (list.suffix ?? '.');
        }
      } else marker = list.bullet || '•';
    }

    body = applyRuleStyles(body, eff, cmap);
    const { words, footnotes, hasTabs } = parseInline(body, eff, cmap, fn);
    const only = words.length === 1 && words[0].pieces.length === 1 ? words[0].pieces[0].st.obj : undefined;
    paras.push({ kind, words, first: afterBreak, style: eff, pstyle, list, marker, level, breakBefore: pendingBreak, footnotes, hasTabs, figure: only ?? null, styleNames: styleNames.length ? styleNames : undefined });
    pendingBreak = null;
    afterBreak = kind !== 'body';
  }
  // Endnotes: collected at the end of the story under a heading, numbered in order.
  if (fn.endnotes.length) {
    const noteStyle = applyParagraphStyle(style, { fontSize: style.fontSize * 0.85, leading: style.leading * 0.85, firstLineIndent: 0, align: style.align === 'justify' || style.align === 'justify-all' ? 'justify' : 'left', list: null });
    const head = parseInline(style.endnoteHeading ?? 'Notes', style, cmap, fn);
    paras.push({ kind: 'h2', words: head.words, first: false, style, pstyle: null, list: null, marker: null, level: 0, breakBefore: null, footnotes: [], hasTabs: false });
    fn.endnotes.forEach((n, i) => {
      const r = parseInline(n.text, noteStyle, cmap, fn);
      const lab = { text: `${n.label}.`, st: { ...PLAIN } };
      r.words.unshift({ pieces: [lab], text: lab.text, before: 'start' });
      if (r.words[1]) r.words[1].before = 'space';
      paras.push({ kind: 'body', words: r.words, first: i === 0, style: noteStyle, pstyle: { spaceBefore: style.leading * 0.2 }, list: null, marker: null, level: 0, breakBefore: null, footnotes: r.footnotes, hasTabs: false });
    });
  }
  // Keep with previous: the paragraph before keeps (at least) one line with this one.
  for (let i = 1; i < paras.length; i++) {
    if (!paras[i].style.keepWithPrevious) continue;
    const prev = paras[i - 1];
    if ((prev.style.keepWithNext ?? 0) < 1) paras[i - 1] = { ...prev, style: { ...prev.style, keepWithNext: 1 } };
  }
  return paras;
}

/* -------------------------------------------------------------------------- */
/* Inline markup                                                               */
/* -------------------------------------------------------------------------- */

const CODES: Record<string, string> = { nbsp: ' ', thin: ' ', hair: ' ', en: ' ', em: ' ', figure: ' ', punct: ' ', nnbsp: ' ', nbhy: '‑', third: ' ', quarter: ' ', sixth: ' ' };

function parseInline(s: string, style: TextStyle, cmap: Map<string, CharacterStyleProps>, fn: { count: number; en: number; endnotes: Footnote[] }) {
  const st: SpanStyle = { ...PLAIN };
  const csStack: CharacterStyleProps[] = [];
  const words: Word[] = [];
  const footnotes: Footnote[] = [];
  let cur: Piece[] = [];
  let buf = '';
  let kbuf: number[] = [];
  let sep: Sep | null = 'start';
  let here = false;
  let shy: number[] = [];
  let ix: string[] = [];
  let anchors: string[] = [];
  let hasTabs = false;
  const wordLen = () => cur.reduce((n, p) => n + p.text.length, 0) + buf.length;

  const flush = () => {
    if (buf) cur.push({ text: buf, st: { ...st }, kern: kbuf.some((v) => v) ? Array.from({ length: buf.length }, (_, i) => kbuf[i] ?? 0) : undefined });
    buf = '';
    kbuf = [];
  };
  const pushWord = (force = false) => {
    flush();
    if (!cur.length && !force) return;
    words.push({ pieces: cur, text: cur.map((p) => p.text).join(''), before: sep ?? 'none', here: here || undefined, shy: shy.length ? shy : undefined, ix: ix.length ? ix : undefined, anchors: anchors.length ? anchors : undefined });
    cur = [];
    here = false;
    shy = [];
    ix = [];
    anchors = [];
    sep = null;
  };
  const setSep = (k: Sep) => {
    pushWord();
    if (k === 'space') { if (sep === null) sep = 'space'; return; }
    // Consecutive tabs / breaks: an empty word holds the earlier one (it may carry a leader).
    if (sep === 'tab' || sep === 'rtab' || sep === 'br') pushWord(true);
    sep = k;
  };
  // Kerning after the last character set so far (a kern at a word start widens the space).
  const addKern = (n: number) => {
    if (buf) { kbuf[buf.length - 1] = (kbuf[buf.length - 1] ?? 0) + n; return; }
    const piece = cur.length ? cur[cur.length - 1] : words.length ? words[words.length - 1].pieces.at(-1) : undefined;
    if (!piece || !piece.text) return;
    piece.kern ??= new Array<number>(piece.text.length).fill(0);
    piece.kern[piece.text.length - 1] += n;
  };

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\' && i + 1 < s.length) { buf += s[++i]; continue; }
    if (ch === '{') {
      const rest = s.slice(i, i + 24);
      let m = /^\{k:([+-]?\d+(?:\.\d+)?)\}/.exec(rest);
      if (m) { addKern(parseFloat(m[1])); i += m[0].length - 1; continue; }
      m = /^\{(br|tab|rtab|here|shy|nbsp|nnbsp|thin|hair|en|em|figure|punct|nbhy|third|quarter|sixth)\}/.exec(rest);
      if (m) {
        const code = m[1];
        if (code === 'br') setSep('br');
        else if (code === 'tab' || code === 'rtab') { setSep(code); hasTabs = true; }
        else if (code === 'here') { pushWord(); here = true; }
        else if (code === 'shy') shy.push(wordLen());
        else buf += CODES[code];
        i += m[0].length - 1;
        continue;
      }
      if (s.startsWith('{fn:', i) || s.startsWith('{en:', i) || s.startsWith('{ix:', i) || s.startsWith('{img:', i) || s.startsWith('{anchor:', i) || s.startsWith('{ruby:', i) || s.startsWith('{wari:', i)) {
        let depth = 0, j = i;
        for (; j < s.length; j++) { if (s[j] === '{') depth++; else if (s[j] === '}' && --depth === 0) break; }
        const kind = s.slice(i + 1, s.indexOf(':', i));
        const content = s.slice(s.indexOf(':', i) + 1, j).trim();
        i = j;
        if (kind === 'anchor') {
          if (!content) continue;
          if (buf || cur.length) anchors.push(content);
          else if (words.length) (words[words.length - 1].anchors ??= []).push(content);
          else anchors.push(content);
          continue;
        }
        if (kind === 'wari') {
          // Warichu: {wari:top|bottom}, or split evenly at a space.
          let [a, b] = content.split('|');
          if (b == null) {
            const mid = content.length / 2;
            let cut = -1;
            for (let k = 0; k < content.length; k++) if (content[k] === ' ' && (cut < 0 || Math.abs(k - mid) < Math.abs(cut - mid))) cut = k;
            const at = cut > 0 ? cut : Math.ceil(mid);
            a = content.slice(0, at).trim(); b = content.slice(at).trim();
          }
          if (a || b) { flush(); cur.push({ text: '\u2060', st: { ...st, wari: [a ?? '', b ?? ''] } }); }
          continue;
        }
        if (kind === 'ruby') {
          // Ruby (furigana): {ruby:base|annotation}, the annotation set small above the base.
          const [base, ann] = content.split('|');
          if (base) { flush(); cur.push({ text: base, st: { ...st, ruby: ann ?? '' } }); }
          continue;
        }
        if (kind === 'ix') {
          // Index marker: attaches to the word being set (or the one just finished).
          if (!content) continue;
          if (buf || cur.length) ix.push(content);
          else if (words.length) (words[words.length - 1].ix ??= []).push(content);
          else ix.push(content);
          continue;
        }
        if (kind === 'img') {
          const parts = content.split(';').map((x) => x.trim()).filter(Boolean);
          const obj: InlineObj = { id: parts[0] ?? '' };
          for (const p of parts.slice(1)) {
            const m = /^(w|width|h|height|shift)\s*:\s*([\d.]+)(%?)$/i.exec(p);
            if (!m) continue;
            const v = parseFloat(m[2]);
            if (/^w/i.test(m[1])) { if (m[3]) obj.pct = v; else obj.w = v; }
            else if (/^h/i.test(m[1])) obj.h = v;
            else obj.shift = v;
          }
          flush();
          cur.push({ text: '\uFFFC', st: { ...st, obj } });
          continue;
        }
        flush();
        if (kind === 'en') {
          const n = ++fn.en;
          const label = String(n);
          cur.push({ text: label, st: { ...st, cs: mergeCs([...csStack, { position: 'superscript' }]) } });
          fn.endnotes.push({ n, label, text: content });
          continue;
        }
        const n = ++fn.count;
        const label = footnoteLabel(n, style.footnoteNumbering);
        cur.push({ text: label, st: { ...st, cs: mergeCs([...csStack, { position: 'superscript' }]), fn: true } });
        footnotes.push({ n, label, text: content });
        continue;
      }
    }
    if (ch === '\t') { setSep('tab'); hasTabs = true; continue; }
    if (ch === ' ') { setSep('br'); continue; }
    if (ch === '­') { shy.push(wordLen()); continue; }
    if (ch === '<') {
      const rest = s.slice(i, i + 400);
      const local = /^<\{([^}]*)\}>/.exec(rest);
      if (local) { flush(); csStack.push(parseCharProps(local[1])); st.cs = mergeCs(csStack); i += local[0].length - 1; continue; }
      const m = /^<(\/?)([^<>/{}]{0,40})>/.exec(rest);
      if (m) {
        const name = nameKey(m[2]);
        if (m[1] && csStack.length && (!name || cmap.has(name))) { flush(); csStack.pop(); st.cs = mergeCs(csStack); i += m[0].length - 1; continue; }
        if (!m[1] && cmap.has(name)) { flush(); csStack.push(cmap.get(name)!); st.cs = mergeCs(csStack); i += m[0].length - 1; continue; }
      }
    }
    if (ch === '*' && s[i + 1] === '*') { flush(); st.bold = !st.bold; i++; continue; }
    if (ch === '*') { flush(); st.italic = !st.italic; continue; }
    if (ch === '^') { flush(); st.sc = !st.sc; continue; }
    if (ch === ' ') { setSep('space'); continue; }
    buf += ch;
  }
  pushWord();
  // (Closures assign `sep`; read it through a widened type.)
  const endSep = sep as Sep | null;
  if (endSep === 'tab' || endSep === 'rtab') pushWord(true);

  for (const w of words) {
    let changed = false;
    for (const p of w.pieces) {
      if (p.st.fn) continue;
      const tt = p.st.cs?.textTransform && p.st.cs.textTransform !== 'none' ? p.st.cs.textTransform : style.textTransform;
      if (tt !== 'uppercase' && tt !== 'lowercase') continue;
      const next = tt === 'uppercase' ? p.text.toUpperCase() : p.text.toLowerCase();
      if (next.length !== p.text.length) { p.kern = undefined; w.shy = undefined; }
      p.text = next;
      changed = true;
    }
    if (changed) w.text = w.pieces.map((p) => p.text).join('');
  }
  return { words, footnotes, hasTabs };
}

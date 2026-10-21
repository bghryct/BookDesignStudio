# Story format

A story is **plain UTF-8 text with light markup**. Each line is one paragraph. The story editor
(double-click a text frame) shows the markup in colour, and its Insert menu and formatting
popovers write it for you.

## What to load

| You have | Load it as | What happens |
|---|---|---|
| A Word manuscript | `.docx` | Headings, italic, bold, small caps, super- and subscript, underline, footnotes, endnotes, lists, tabs, breaks and alignment are kept. Word styles named like the book's paragraph styles are applied. |
| A Project Gutenberg book, or any hard-wrapped text | `.txt` | The licence header and footer are removed. Wrapped lines are joined into paragraphs, and verse keeps its line breaks. CHAPTER lines become headings, `_italics_` become italics, quotes become curly and `--` becomes an em dash. |
| Markdown | `.md` | `#` and `##` headings, `*italic*`, `**bold**`, lists and `>` quotes come through. |
| Text already in this format | `.txt` | Used as it is. |
| A PDF's text | `.pdf` via Pages › Flow text › Load, or the Image panel's *Set the PDF's text in new pages* | Lines and paragraphs are rebuilt from where the text sits on the page. Running heads and folios are dropped, hyphenated line ends rejoined, larger lines become headings, and italic and bold are kept. Tables, footnotes and multi-column pages come through as plain paragraphs, so check them. A scan with no text layer has nothing to read. |

**Ways to load a file:**
- Drop it on a page.
- Choose **File › Import**.
- Open **Pages › Flow text › Load**. You can review the text before it flows.

A long text flows into as many new pages as it needs. A PDF dropped on a page is placed as a graphic, not as text (see the README). RTF and IDML can't be loaded yet.

To set *Moby-Dick*, download the Plain Text UTF-8 file from Project Gutenberg and load it.

## Paragraphs

```
# Chapter heading
## Section heading
An ordinary paragraph is one line, however long.
- A bullet item
  - A nested item (two spaces or a tab per level)
1. A numbered item
a) A lettered item
---
```

- `---` on its own line is a section break (⁂).
- A paragraph style goes in square brackets at the start of the line: `[Epigraph] Call me Ishmael.`
- Local paragraph settings go in braces inside the brackets: `[{align:center; before:12; rag:swiss}] Text`.
  - Other keys: `size` `leading` `indent` `left` `right` `after` `track` `hyphenate` `keep` `keepprev` `together` `widows` `orphans` `start` `split` `span` `grid` `optical` `composer` `last`.

## Breaks

These go on a line of their own:

| Code | Breaks to |
|---|---|
| `{col}` | the next column |
| `{frame}` | the next frame |
| `{odd}` | the next odd page |
| `{even}` | the next even page |

Inside a paragraph:
- `{br}` is a line break.
- A tab character (or `{tab}`) is a tab.
- `{rtab}` is a right-indent tab.
- `{here}` indents to here.

## Inside a line

| Write | For |
|---|---|
| `*italic*` · `**bold**` · `^small caps^` | emphasis |
| `<Style>…</Style>` | a character style |
| `<{size:14; color:#b0331f; track:40}>…</>` | local character formatting (also `weight` `italic` `case` `super` `sub` `shift` `underline` `underline:double` `strike` `highlight` `hscale` `vscale` `skew` `rotate` `stroke` `nobreak` `lang` `features`) |
| `{fn:The note.}` · `{en:The note.}` | footnote · endnote |
| `{ix:whale}` · `{ix:whale!sperm}` | index entry · sub-entry |
| `{anchor:name}` · `{xref:name}` · `{xreftext:name}` | cross-reference target · its page · its paragraph's text |
| `{if:Print}…{/if}` | conditional text |
| `{ruby:東京\|とうきょう}` | ruby above a base |
| `{img:asset-id}` · `{img:asset-id; w:100%}` | inline graphic · column-wide figure |
| `{page}` `{page:roman}` `{lastpage}` `{chapter}` `{title}` `{author}` `{date}` | tokens |
| `{shy}` `{nbhy}` | discretionary · non-breaking hyphen |
| `{nbsp}` `{nnbsp}` `{em}` `{en}` `{thin}` `{hair}` `{figure}` `{punct}` | special spaces |
| `{k:-20}` | manual kerning, thousandths of an em |
| `\*` `\^` `\{` `\<` | a literal character that would otherwise be markup |

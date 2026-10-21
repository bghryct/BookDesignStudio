# Typesetting: Book Design Studio compared with InDesign

This is a feature-by-feature check of Book Design Studio's typesetting against Adobe InDesign's core
typesetting tools. Each row gives its status and where to find the feature.

| Mark | Meaning |
|---|---|
| ✅ | Does what InDesign does |
| ◐ | Partly: the gap is noted |
| ✗ | Not yet |
| ★ | Goes beyond InDesign |

**Where things live:**
- **Type** is the right-hand panel's Type tab for the selected text frame. Its sections are Rag, Justification, Keeps & breaks, Rules, Lists, Tabs, Rule styles (GREP), Footnotes and Hyphenation.
- **Styles** is the Styles panel.
- **Story editor** opens when you double-click a frame. It has the Inserts menu and the Character and Paragraph popovers.
- **Frame** is the Element panel for a text frame.
- **Document** is the Document panel.

Markup is written in the story itself; see [STORY_FORMAT.md](STORY_FORMAT.md).

---

## Character formatting

| Feature | InDesign | Here | Where |
|---|---|---|---|
| Family, weight, italic, size, leading | ✅ | ✅ | Type; per run `<{font:…; size:…; weight:…}>` |
| Auto leading (120 %) | ✅ | ✅ | Type › *Auto ld* |
| Kerning: metrics / optical / none | ✅ | ✅ ★ | Type › Kerning. Optical kerning is measured from the glyph outlines (twin targets, dead band), so it also works for fonts without kern tables |
| Manual kerning | ✅ | ✅ | Story editor ⌥← / ⌥→ (⇧ ×5); `{k:N}` |
| Tracking | ✅ | ✅ | Type; `track:` |
| Optical tracking by size | ✗ | ★ | Type › Optical tracking: small sizes open up, display sizes close up |
| Horizontal / vertical scale, skew | ✅ | ✅ | Character popover; `hscale:` `vscale:` `skew:` |
| Baseline shift | ✅ | ✅ | `shift:` |
| Super / subscript | ✅ | ✅ | Uses the font's true `sups`/`subs` when present, otherwise scales and shifts |
| All caps, small caps | ✅ | ✅ | `^small caps^`, `case:`. Synthetic small caps get added tracking |
| Underline: weight, offset, colour | ✅ | ✅ | `uweight:` `uoffset:` `ucolor:` |
| Underline styles: double, dashed, dotted, wavy | ✅ | ✅ | `underline:double` etc.; Character popover; Styles |
| Underline gap colour | ✅ | ✗ | |
| Strikethrough with options | ✅ | ✅ | `strike`, `sweight:` `scolor:` |
| Character highlight (shading) | ✅ | ✅ | `highlight:` |
| Outline (stroke) text | ✅ | ✅ | `stroke:` `strokewidth:`; vector stroke in PDF |
| Character rotation | ✅ | ✅ | `rotate:` |
| No break | ✅ | ✅ | `nobreak` |
| Language per run (hyphenation) | ✅ | ✅ | `lang:`. 13 hyphenation languages (en-us, en-gb, de, nl, fr, it, es, pt, la, sv, da, pl, cs) |
| OpenType features | ✅ | ✅ | Any tag via `features:` / `ot:` (liga, dlig, smcp, c2sc, onum, lnum, tnum, pnum, frac, ordn, swsh, salt, ss01…, zero, case, calt) |
| Variable fonts: axes, automatic optical size | ✅ | ✅ | Type › axes; `opsz` follows the point size |
| Glyphs panel | ✅ | ✅ | Fonts › Glyphs (click a glyph to insert it in the open story) |
| Ruby (furigana) | ✅ (CJK) | ✅ | `{ruby:base|annotation}`; Inserts › Ruby |
| Kenten, warichu | ✅ (CJK) | ✗ | |
| Vertical text, tate-chū-yoko | ✅ (CJK) | ✅ | Type › Writing mode |

## Paragraph formatting

| Feature | InDesign | Here | Where |
|---|---|---|---|
| Left, centre, right, justify; last-line alignment; justify all | ✅ | ✅ | Type; `align:` `last:` |
| Single-word justification | ✅ | ✅ | Justification |
| Indents: left, right, first-line, hanging | ✅ | ✅ | Type; `indent:` `left:` `right:` |
| Indent to here, right-indent tab | ✅ | ✅ | `{here}`, `{rtab}` |
| Space before / after | ✅ | ✅ | `before:` `after:` |
| Drop caps: lines, characters | ✅ | ✅ ★ | Type › Drop cap, with illuminated frames |
| Drop cap character style, scale for descenders | ✅ | ◐ | Font, weight and colour only |
| Nested styles | ✅ | ✅ | Type › Rule styles; `nestedStyles` (words, characters, sentences, up to a character) |
| GREP styles | ✅ | ✅ | Type › Rule styles |
| Line styles (first N lines) | ✅ | ◐ | First line in small caps only |
| Paragraph rules above / below | ✅ | ✅ | Type › Rules (solid, dashed, dotted, double; column or text width; indents; offset) |
| Paragraph shading | ✅ | ✅ | Type › Rules (padding, corner radius) |
| Paragraph border | ✅ | ◐ | Done as shading with a stroke |
| Span columns | ✅ | ✅ | Keeps & breaks › Span all columns, at the top of a frame or mid-story (columns above are balanced) |
| Split column | ✅ | ✅ | Keeps & breaks › Split column, Split gap; `[{split:3}]` |
| Keep with next | ✅ | ✅ | Keeps & breaks |
| Keep with previous | ✅ | ✅ | Keeps & breaks; `keepprev` |
| Keep lines together (all lines) | ✅ | ✅ | Keeps & breaks |
| Keep lines together (first N / last N lines) | ✅ | ✅ | Orphans and widows |
| Start in next column / frame / odd page / even page | ✅ | ✅ | Keeps & breaks; `{col}` `{frame}` `{odd}` `{even}` lines |
| Bullets and numbering, multi-level, restart | ✅ | ✅ | Type › Lists; `- ` `1. ` `a) `, two spaces per level; Multi-level numbers |
| Numbering lists across stories | ✅ | ✗ | Each story numbers its own lists |
| Tab stops: left, centre, right, decimal, align on character; leaders | ✅ | ✅ | Type › Tabs |
| Align to baseline grid: all lines / first line only | ✅ | ✅ | Type; Keeps & breaks |
| Custom baseline grid per frame | ✅ | ✅ | Frame › Own baseline grid |
| Right-to-left paragraphs | ✅ (ME) | ✅ | Type › Direction |

## Composition, justification and hyphenation

| Feature | InDesign | Here | Where |
|---|---|---|---|
| Paragraph composer / single-line composer | ✅ | ✅ | Justification › Composer. Knuth–Plass with fitness classes and flagged-penalty demerits |
| Word spacing: min / desired / max | ✅ | ✅ | Justification |
| Letter spacing in justification | ✅ | ✅ | Justification (stretch and shrink on the boxes) |
| Glyph scaling in justification | ✅ | ✅ | Justification (hz-style 98–102 %) |
| Hyphenation: shortest word, letters before / after, limit, zone, caps, last word | ✅ | ✅ | Hyphenation |
| Better spacing ↔ fewer hyphens slider | ✅ | ✅ | Hyphenation › Fewer hyphens |
| Hyphenate across columns | ✅ | ✅ | Hyphenation. Off: no hyphen on the last line of a column or frame |
| User hyphenation dictionary | ✅ | ✅ | Hyphenation dictionary (`ty-pog-ra-phy`; a word with no hyphens never breaks) |
| Discretionary / non-breaking hyphen | ✅ | ✅ | `{shy}`, `{nbhy}` |
| Balance ragged lines | ✅ | ✅ | Rag › Balanced |
| Swiss rag (short–long–short–long), wedge, custom rag pattern | ✗ | ★ | Rag › Swiss, Wedge, Pattern (`ragpattern:"100 84 94"`) |
| Avoid one- and two-letter words at line ends | ✗ | ★ | Rag › Avoid short line ends |
| Avoid runts (one-word last lines) | ◐ | ✅ | Type › Avoid runts |
| Optical margin alignment | ✅ (per story) | ✅ ★ | Type; per paragraph, with adjustable strength |
| Highlight H&J violations | ✅ | ✅ ★ | Document › Spacing check: loose and tight lines tinted, hyphens ticked, ladders of 3+ flagged |

## Frames and flow

| Feature | InDesign | Here | Where |
|---|---|---|---|
| Columns, gutter, column rules | ✅ | ✅ | Frame |
| Fixed-width / flexible-width columns | ✅ | ✗ | |
| Balance columns | ✅ | ✅ | Frame |
| Inset per side | ✅ | ✅ | Frame |
| Vertical justification: top / centre / bottom / justify | ✅ | ✅ | Frame |
| First-baseline offset (ascent, cap, x-height, leading, fixed; minimum) | ✅ | ✅ | Frame |
| Auto-size frame | ✅ (height and width) | ◐ | Height only (Frame › Fit height to text) |
| Threading, overset indicator | ✅ | ✅ | The + port; it turns red when text is overset |
| Autoflow into new pages | ✅ | ✅ | Pages › Flow text, or File › Import of a long manuscript. A 1.2-million-character novel flows into ~800 pages in about a second |
| Text wrap: bounding box, shape, jump object; wrap side | ✅ | ✅ | Frame › Text wrap (both, largest, left, right) |
| Wrap around an image's alpha contour | ✅ | ✗ | Box and ellipse shapes only |
| Ignore text wrap | ✅ | ✅ | Frame |
| Text on a path | ✅ | ◐ | Path › Text on path (offset, alignment, over / under, reverse). No rainbow, skew or stair-step effects |
| Inline and anchored graphics | ✅ | ◐ | `{img:id}` inline, `{img:id; w:100%}` column-wide figure. No custom anchored positioning |

## Long documents

| Feature | InDesign | Here | Where |
|---|---|---|---|
| Footnotes: numbering style, size, separator rule | ✅ | ✅ | Type › Footnotes; `{fn:…}` |
| Endnotes | ✅ | ✅ | `{en:…}`, collected under a heading |
| Table of contents | ✅ | ✅ | Document › Generate contents page (with page numbers from the actual layout) |
| Index: topics, sub-entries, page ranges | ✅ | ✅ | `{ix:term!sub}`; Document › Generate index |
| Cross-references: page number, paragraph text | ✅ | ✅ | `{anchor:name}`, `{xref:name}`, `{xreftext:name}`; Inserts lists the book's anchors |
| Conditional text | ✅ | ✅ | `{if:Name}…{/if}` (nests, spans paragraphs); Document › Conditional text shows or hides each condition |
| Text variables: page, page count, chapter, title, author, date | ✅ | ✅ | `{page}` `{page:roman}` `{lastpage}` `{chapter}` `{title}` `{author}` `{date}` |
| Running head from a character style; file name; modification date | ✅ | ✗ | |
| "Continued on / from page" jump lines | ✅ | ◐ | Tables only (blue "continues on p. N" labels) |
| Master (parent) pages | ✅ | ✅ | Pages › Masters |
| Sections and restarted page numbering | ✅ | ✗ | |
| Book files (several documents) | ✅ | ✗ | One document per book |
| PDF hyperlinks and bookmarks | ✅ | ✗ | |

## Styles

| Feature | InDesign | Here | Where |
|---|---|---|---|
| Paragraph and character styles | ✅ | ✅ | Styles; `[Style]` and `<Style>…</Style>` in the story |
| Local overrides, clear overrides | ✅ | ✅ | Paragraph and Character popovers, `[{…}]` and `<{…}>`; Styles shows overrides |
| Table and cell styles | ✅ | ✅ | Tables panel |
| Based on / next style | ✅ | ✗ | |

## Tables

| Feature | InDesign | Here | Where |
|---|---|---|---|
| Header and footer rows repeated across frames | ✅ | ✅ | Tables panel |
| Merged cells; tall merged groups broken across frames | ✅ | ✅ | |
| Threading over frames and pages, including master pages | ✅ | ✅ | With "continues on p. N" labels |
| Row breaking, overset warning | ✅ | ✅ | |
| Fixed, auto and proportional column widths; decimal alignment | ✅ | ✅ | |
| Fills, zebra rows and columns, rule styles, diagonal lines, rotated cells | ✅ | ✅ | |
| Import from CSV / TSV | ✅ | ✅ | Drop a .csv on a page |

## Find, check and import

| Feature | InDesign | Here | Where |
|---|---|---|---|
| Find / change text with GREP, across stories | ✅ | ✅ | Type › Find / Change (with presets) |
| Find glyph / object | ✅ | ✗ | |
| Show hidden characters | ✅ | ✅ | Document › Hidden characters, ⌥⌘I: spaces ·, no-break °, ¶, ¬, # |
| Story editor | ✅ | ✅ | Double-click a frame; syntax-highlighted markup |
| Spell check, autocorrect | ✅ | ✗ | |
| Track changes, notes | ✅ | ✗ | |
| Place Word (.docx) | ✅ | ✅ | Drop, File › Import, or Pages › Flow text › Load. Keeps headings, italic, bold, small caps, super- and subscript, underline, strikethrough, footnotes, endnotes, lists, tabs, breaks and alignment; maps Word style names onto the book's paragraph styles. Tables come in as tab-separated lines. |
| Place plain text / Markdown | ✅ | ✅ ★ | Hard-wrapped text is unwrapped. Project Gutenberg books are cleaned up: the licence text is removed, chapters become headings, `_italics_` become italics, straight quotes become typographer's quotes and `--` becomes an em dash |
| Place PDF as a graphic (any page) | ✅ | ✅ | Drop or File › Import; the Image panel picks the page. The page stays vector in the exported PDF |
| Get the text out of a PDF | ◐ | ✅ | Pages › Flow text › Load, or the Image panel. Rebuilds paragraphs, drops running heads and folios, rejoins hyphens, keeps italic and bold |
| Place RTF / IDML | ✅ | ✗ | |

---

## What remains

These InDesign typesetting features are not here yet:

- Kenten and warichu.
- Underline gap colour.
- Fixed-width and flexible-width columns.
- Auto-size by width.
- Wrap around an image's alpha contour.
- Path-text effects (rainbow, skew, stair step).
- Custom anchored-object positions.
- Running heads from a character style.
- Sections and restarted page numbering.
- Book files.
- PDF hyperlinks and bookmarks.
- Based-on and next styles.
- Glyph and object search.
- Spell check.
- Track changes.
- RTF and IDML import.

## Performance

The figures below were measured in Chrome on the development build, with one threaded story of 1.2 million characters (about the length of *Moby-Dick*) set into 821 pages:

| | Time |
|---|---|
| Convert the Gutenberg text | 44 ms |
| Flow into pages | about 1.1 s |
| Re-set the whole story after an edit | about 100 ms |
| Draw a page from cache | about 0.1 ms |

Each paragraph's measured items and line breaks are cached, so an edit re-measures only the paragraphs it changed.

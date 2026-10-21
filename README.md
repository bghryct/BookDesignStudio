# Book Design Studio

**Book design studio and teaching tool** — live at **https://bghryct.github.io/BookDesignStudio/**

A browser-based book design engine for students, typographers and book designers: freeform canvas editing on real grids, Knuth–Plass micro-typography, Diehl-grade binding calculations, generative layouts drawn from the Western, Swiss, Dutch, Italian and Japanese canons, natural-media brushes, a real-time 3D book, and print-ready PDF / SVG / PNG / MP4 / WebM / GIF export.

Everything runs client-side. There is no server, no account and no upload — projects autosave in the browser (IndexedDB) and can be saved as portable `.bds.json` files. That makes it a static site you can host for free on GitHub Pages.

---

## Deployment

Every push to `main` runs `.github/workflows/deploy.yml`, which builds the site with Vite and publishes it to GitHub Pages (repository **Settings → Pages → Source: GitHub Actions**). The build uses relative asset paths (`base: './'` in `vite.config.ts`), so the same `dist/` also works at a custom domain or from any sub-folder of another static host.

## Run locally

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # production build in dist/
npm run preview    # serve dist/
```

Node 20+ is recommended (CI uses Node 22).

---

## What's inside

### Parametric geometry & binding engine (`src/engine/binding.ts`)
- Trim, margins, bleed and slug in mm, cm, in, pt, pc or px (all fields accept `12mm`, `0.5in`, `3p6`).
- Spine width from grammage × bulk (caliper), leaves, sewing-thread swell per section, cover caliper and — for case binding — backing shoulders equal to the board thickness and the arc length of a rounded spine.
- Case-making geometry after Edith Diehl: board size with squares and joint set-back, french joints, turn-ins with corner mitres, raised-band positions, sewing stations with kettle stitches, headband height, spine linings, Diehl's board-thickness recommendations.
- **Grain-direction check**: folds the parent sheet as folio / quarto / octavo / 16mo and reports whether the grain runs parallel to the spine.
- Bindings: hardcover case (raised bands, headbands), Smyth-sewn and perfect-bound soft covers, Coptic with exposed spine, Japanese stab binding (yotsume / kikkō / kōki toji, fukuro-toji leaves), and Munari soft covers for die-cut / vellum sequences. Right-to-left books bind on the right.
- Flat cover / case editor with panels for boards, joints and spine; objects anchor to their panel so they follow the spine as the page count changes.
- **Dust jacket**: its own unwrapped editor (the **Jacket** view) with flaps, fore-edge folds sized to the board thickness plus ease, a spine that wraps the case's hinges, height allowance, a finish (matte, gloss, soft-touch, uncoated) and a paper colour. It has starter typography, can copy the cover artwork, exports a jacket PDF with fold marks, SVG and PNG, and is worn by the book in 3D.
- **Cover and jacket grids**: margins (inner/outer/head/foot, measured from the spine or fold), columns, rows, gutters and a baseline inside every panel, plus head and foot margins on the spine. Items snap to them.

### Grids & canons (`src/engine/grid.ts`)
Van de Graaf, Tschichold 2:3:4:6, golden progression, Bringhurst proportion, Fibonacci, manuscript (Cleves), Müller-Brockmann, Crouwel and Ma (間) margins, each with its source and rationale; modular field grids with column and row gutters; baseline grid; Bosshard dual micro-grid; "lock fields to baseline" (rows become whole lines with a one-line gutter); Van de Graaf construction overlay. **Grid across the spread**: on facing pages, one column system from the left page's outer margin to the right page's. With an even count the middle gutter sits on the fold; with an odd count a column runs across it, for pictures. Items snap to it, and clicking a column with the text tool frames it, across the gutter if the column crosses it.

### Canvas
Every item can be moved, resized, rotated, flipped, stacked, locked, hidden and blended (multiply, screen, difference …), and snaps to columns, fields, baselines, margins, ruler guides and other items. **Rulers and guides** work on pages, master pages, the cover and the jacket: drag a guide out of a ruler, drag it back to delete it, or create a column/row guide grid from the Document panel (`⌘;` show/hide, `⌥⌘;` lock). **Spreads**: any item can cross the gutter (a photo, a headline, a brush drawing, a band of colour). It's drawn on both pages in the editor, the thumbnails, the 3D book and every export, and the two halves meet exactly at the fold. On the facing page it sits beneath that page's items, or above them. *Fill page*, *Fill spread* and *Span text* place an item in one click, and new brush layers span the whole spread. There's a pen tool with Bézier handles and a node editor, threaded text frames (click the red `+` overset port, then a frame), master pages with `{page}` `{title}` `{author}` `{page:roman}` tokens, drag-and-drop of images, SVG, fonts and text, and undo/redo.

### Typesetting (`src/engine/text/`, `src/engine/textLayout.ts`, `src/engine/fonts.ts`)
One shaping engine (fontkit) measures with the same font files the browser renders, so the editor, the 3D textures and the PDF agree to the glyph. [docs/TYPESETTING.md](docs/TYPESETTING.md) compares every core typesetting feature with InDesign's: what matches, what goes further, and what is still missing. [docs/STORY_FORMAT.md](docs/STORY_FORMAT.md) describes the story text format and which manuscript files to load.

**Composition**
- **Knuth–Plass** paragraph composer for justified *and* ragged text, with fitness classes, flagged-hyphen demerits and runt avoidance. A single-line (first-fit) composer is also available.
- **Rag shaping**:
  - **Swiss rag**: short line, long line, short line, long line, with an adjustable amount and a choice of starting long or short.
  - **Balanced** lines for headings and captions.
  - **Wedge** (a centred pyramid).
  - A **pattern** of line lengths you choose.
  - "No line ends on a one- or two-letter word".
- **Justification** by word space, letter spacing and glyph scaling (the hz-programme), each within its own minimum and maximum. You can also set the last-line alignment and how a single-word line is aligned (including spreading its letters).
- **Hyphenation** (Liang, 13 languages):
  - shortest word, letters kept before and after a break
  - a limit on consecutive hyphens, enforced inside the breaker
  - a hyphenation zone for ragged text
  - a better-spacing ↔ fewer-hyphens bias
  - capitalised words and the last word
  - discretionary hyphens (`{shy}`)
  - a book-wide exceptions dictionary (`ty-pog-ra-phy`)
  - **hyphenate across columns** off: no hyphen on the last line of a column or frame

**Kerning and spacing**
- **Kerning modes**:
  - Metrics: the font's own kerning pairs.
  - **Optical**: measured from the glyph outlines. Each letter's share of white is what it has beside its own twin, so it tightens To, AV and Yo, leaves well-spaced pairs alone, and fixes fonts with thin kern tables.
  - None.
- **Pair kerning by hand**: ⌥← / ⌥→ in the story editor (`{k:-20}`). Kerned text stays live, searchable text in the PDF.
- Tracking, word space, optical margin alignment with an adjustable strength, and hanging punctuation.
- **Optical tracking by size**: small sizes open up and display sizes close up along the curve type founders cut into metal (+8‰ at 9 pt, −18‰ at 36 pt). It is applied per run, so a frame that mixes sizes gets each one right.
- **Special spaces**: em, en, thin, hair, figure, punctuation and no-break spaces, plus non-breaking hyphens.

**Paragraphs**
- Left, right, first-line and hanging indents; space before and after; drop caps of one to six letters with Cleves illuminations; first line in small caps.
- **Rules and shading**: rules above and below (solid, dashed, dotted or double; column or text width; offsets and indents). Shading has padding, corner radius and a border.
- **Lists**: bullets and numbering (1, a, i, I), nesting, multi-level numbers (2.1, 2.1.1), start-at and continue, markers aligned on the point. Type `- `, `• `, `1. ` or `a) ` to start a list item.
- **Tabs**: left, centre, right and decimal stops with leaders that line up from line to line; default tab interval; right-indent tab (`{rtab}`) for contents pages; indent to here (`{here}`).
- **Keeps**: keep with next, keep with previous, keep lines together, widows, orphans, start in the next column, frame, odd page or even page, and breaks on a line of their own (`{col}`, `{frame}`, `{odd}`, `{even}`).
- **Split column**: a paragraph set in two to six balanced sub-columns inside its column (glossaries, lists), with its own gap (`[{split:3}]`).
- **Baseline grid**: every line, or only the first line of each paragraph. A frame can have its own grid (increment and offset from its top) for sidebars and captions.
- **Auto leading**: one click sets 120% of the size.
- **Footnotes** (`{fn:…}`) are set at the foot of the column that holds the reference, under a separator rule. Numbering can be 1, i, a or * † ‡; a line whose note won't fit moves on with it. **Endnotes** (`{en:…}`) are collected at the end of the story under a heading.
- **Graphics in the text flow**: `{img:…}` sets an image inline in the line (it moves with the text), or on a line of its own as an anchored figure the width you give it (`w:100%` = the column), with room made above it. Pick them from the story editor's Insert menu.

**Styles and local formatting**
- **Paragraph and character styles**:
  - A starter set, or your own.
  - A paragraph style can carry any paragraph property, including rag, keeps, lists and justification.
  - A frame can follow a style, with overrides flagged so you can clear them or redefine the style; editing a style reflows everything that uses it.
  - **Nested styles** (run-in heads: the first N words, letters or sentences, or up to a character) and **GREP styles** (a character style on every match of a pattern) apply character styles automatically.
- **Local formatting**: change anything about any run of text inside a frame with `<{size:14; color:#b0331f; track:40; underline}>…</>`, or about a paragraph with `[{align:center; before:12; rag:swiss}]`. The story editor's formatting popovers write these for you. Character properties include:
  - typeface, absolute or relative size, weight, italic
  - tracking and colour
  - case, superscript and subscript (true `sups`/`subs` when the font has them), baseline shift
  - underline (solid, double, dashed, dotted or wavy, with weight, offset and colour), strikethrough and highlight
  - ruby / furigana above a base: `{ruby:東京|とうきょう}`
  - horizontal and vertical scale, skew, character rotation, outline stroke
  - no-break, hyphenation language and OpenType features

**Frames**
- Columns with a column rule, **balanced columns**, heads that **span all columns** anywhere in the story (the columns above balance, a new band of columns starts below).
- **Vertical justification** (top, middle, bottom, justify).
- First-baseline options (cap height, ascent, x-height, leading, fixed) and insets per side.
- **Fit the frame to its text**.
- **Text wrap** around any item: its box, its shape, or jumping it, on both sides, the larger side, left or right, with an offset.
- Threads across pages. Running heads with `{chapter}`, `{title}` and `{page:roman}`; also `{lastpage}` and `{date}`.
- **Type on a path**: any path can carry a line of type that follows its curves, positioned along the path, on or below it.

**Tables** (`src/model/table.ts`, `src/render/table.ts`)
- **Columns and rows**: fixed, proportional (fr) or auto-width columns; auto, at-least and exact row heights; tables that fill the frame width or set their own.
- **Cells**:
  - Merged cells, header and footer rows, alternating row and column fills.
  - Cells set by the same text engine as frames: every markup, style and kerning feature works.
  - Per-cell alignment (including decimal alignment on any character, shared down the column), vertical alignment, padding, fill, rotation, diagonals.
  - Figure styles: tabular/proportional × lining/old-style.
- **Rules**: border, head, foot, row, column and stub rules. Each is solid, dotted, dashed, double, thick–thin or thin–thick, with weight, colour and gap. Per-edge overrides, and two-line rules nest properly at corners.
- **Tables across frames and pages**: thread a table on into further frames, or let the panel continue it on the next page.
  - Body rows flow on, and header and footer rows repeat (with InDesign's skip-first / skip-last options).
  - Rows stay whole unless you allow tall rows to break.
  - Merged rows travel together.
- **Table and cell styles** with a full property editor that updates every table using them. Presets include Tschichold book rules, Scotch rules, Swiss grid, ledger zebra, full grid, tabular without rules, and a grand-total cell style.
- **Editing**: the table tool, CSV/TSV drop and paste, Tab / ⇧Tab between cells (a new row at the end), cell ranges, copy and paste as tab-separated data, and dragging column and row borders.

**Long documents**
- **Cross-references**: name a place with `{anchor:fig-3}`, then `{xref:fig-3}` prints the page it lands on and `{xreftext:fig-3}` the text of its paragraph. They update as the book reflows; the story editor lists the book's anchors to insert.
- **Conditional text**: `{if:Print}…{/if}` (any name; nests, may span paragraphs). Document › Conditional text shows or hides each condition for the whole book, so one story can make several editions.

**Manuscripts** (`src/lib/docx.ts`, `src/lib/plainText.ts`)
- **Word (.docx)**:
  - Brings in headings, italic, bold, small caps, super- and subscript, underline and strikethrough.
  - Footnotes and endnotes become `{fn:…}` / `{en:…}`.
  - Also keeps bullet and numbered lists, tabs, line and page breaks, and centred or right-aligned paragraphs.
  - Word style names that match a paragraph style in the book are applied.
- **Plain text (.txt) and Markdown (.md)**:
  - Hard-wrapped text is joined into paragraphs. Verse and letters keep their line breaks, and indented blocks become extracts.
  - CHAPTER / BOOK / PART lines become headings, and `_underscores_` become italics.
  - Straight quotes become typographer's quotes, and `--` becomes an em dash.
  - Project Gutenberg books lose their licence header and footer, and a contents list stays a list.
- **PDF**:
  - A PDF dropped on a page (or picked with File › Import) is placed as a graphic. The Image panel chooses which page shows.
  - The exported PDF embeds the original page, so its type and art stay vector; the canvas and the 3D book show a preview.
  - A PDF's *text* can be set as a story with Pages › Flow text › Load, or with the Image panel's button. Paragraphs are rebuilt from the layout, running heads and folios are dropped, hyphenated line ends are rejoined, and italic and bold are kept.
  - PDFs are read with Mozilla's pdf.js, loaded only when a PDF is opened.
- **Where to load them**: drop the file on a page, use File › Import, or use Pages › Flow text › Load. A long manuscript flows into as many new pages as it needs. *Moby-Dick* (1.2 million characters) flows into about 800 pages in a second, and an edit re-sets the whole novel in about a tenth of a second.

**Tools**
- **Hidden characters** (Document panel or ⌥⌘I): word spaces as dots, no-break spaces as rings, ¶ at paragraph ends, ¬ at forced line breaks, # at the end of the story.
- The **story editor** highlights markup and has:
  - character and paragraph formatting popovers
  - an Insert menu for breaks, spaces, tabs, footnotes, anchors and cross-references, conditional text, ruby, tokens and typographic characters
  - ⇧↵ for a line break, ⇥ for a tab, ⌥←/→ for kerning
- **Generate index** (Document panel): mark terms with `{ix:term}` or `{ix:term!subterm}`. The index lists each term with the pages it actually lands on, folds consecutive pages into ranges, groups terms by letter and sets them in two columns.
- **Generate contents page** (Document panel): finds chapter titles and `#`/`##` headings, including those inside threaded stories, records the page each one is actually set on, and sets the contents with dot leaders. Run it again to refresh the page numbers.
- **Find / change** across every story in the book, with GREP, `$1` groups and one-click clean-ups (straight → curly quotes, double spaces, ranges → en dashes, thin spaces before French punctuation).
- RTL lines, and **vertical Japanese (tategaki)** with kinsoku rules, hanging 、。, vertical punctuation forms and tate-chū-yoko.
- **Font Studio**: upload OTF / TTF / WOFF / WOFF2, static or variable. It parses the `fvar` axes and named instances (sliders for `wght`, `wdth`, `slnt`, `ital`, `opsz` and custom axes) and lists the GSUB/GPOS features (`kern`, `liga`, `dlig`, `smcp`, `c2sc`, `onum`, `lnum`, `pnum`, `tnum`, `swsh`, `ss01`…), with a glyph grid; click a glyph to insert it into the story being edited.

### Generators (`src/engine/generators/`)
Live vector objects with their own controls:
- **Schrofer** restless typography: text rings, wave fields, moiré, rotating squares, radial bars, dot screens, spirals, scaling letter grids.
- **Cleves** marginalia: vine rinceaux with hairline sprays, acanthus, strewn flowers, pearls and beads, trompe-l'œil mussel shells and coins, rubric penwork, ruling with prickings, gilded frames, illuminated initials.
- **Martens** overprinted monoprints: ink passes with misregistration, roller texture, real PDF overprint.
- **Sato** tonal gradient meshes.
- **Crouwel** modular grid alphabet.
- **Munari** die-cut windows: you see the page beneath through them, and they become real holes in 3D and a CutContour die line in the PDF.
- Rules: double, Scotch, dotted, wave, Greek key, chain.

### Generative presets & layout matrix (`src/engine/presets/`)
Thirteen canons, each generating a complete small book (spec, masters, pages, cover) from your own text, in eight structured variations:
- Illuminated Manuscript (Cleves)
- Systematic Grid (Crouwel)
- Restless Typography (Schrofer)
- Overprint Monoprint (Martens)
- Unreadable Book (Munari)
- Golden Canon (Tschichold)
- Elements of Style (Bringhurst)
- Swiss Grid (Müller-Brockmann)
- **Typographic Grid** and **Concrete Typography** (Hans Rudolf Bosshard): two column systems on one common unit grid; constructive bar progressions and Lohse-style serial colour fields
- **Detail in Typography** and **Typotron** (Jost Hochuli): reader-first asymmetric books with marginalia (or a symmetric axis when the content asks for it); small, playful St. Gallen booklets
- Ma · Japanese (Sato / wa-toji)

The **Matrix** view compares them side by side; Apply is undoable.

### Element library (`src/ui/library/`, `src/engine/motifs/`)
A **Library** tab of ready-made design elements grouped by designer — Cleves, Diehl, Munari, Crouwel, Martens, Schrofer, Tschichold, Bringhurst, Bosshard, Müller-Brockmann, Hochuli, Unger, Caflisch, Sato — with live thumbnails. Click to place on the current page or front cover, or drag onto the canvas. Besides compositions (title pages, chapter openings, marginal headings, rotated columns, die-cut windows, overprints, kinetic patterns, illuminated frames and initials …) it exposes the **motif** generators:
- **Decorative**: marbled and paste-paper endpapers, block-printed repeats, washi, manuscript line-fillers and rubricated pilcrows, printer's-flower borders, the Penguin band structure, Beethoven-style concentric arcs, circle compositions, diagonal bar progressions, concrete colour fields, folding diagrams.
- **Teaching**: field grids, Bosshard dual and em-derived grids, dimension lines, the typographic scale, page-proportion charts, the Van de Graaf construction, type waterfalls, letter-spacing studies, a Vox-ATypI classification chart, letterform anatomy, case-making, imposition and stab-binding diagrams drawn from the book's own settings.

### Teaching tools
- **Spacing check** (Hochuli): tints loose and tight lines, ticks hyphenated lines and flags hyphen ladders. The inspector reports the measure in characters per line (Bringhurst's 45–75).
- **Second column system** (Bosshard): a second grid over the first; items snap to both.
- Classical typographic-scale size chips; page proportions from Bringhurst's musical intervals.
- Grid-diagram, dimension and type-specimen tools in the toolbar.

### Brushes (`src/engine/brushes/`)
Pencil, graphite, charcoal, crayon, pastel, marker, highlighter, fineliner, ink, broad-edge calligraphy, watercolour (wet edges, blooms, granulation), gouache, airbrush, stipple, gold leaf and eraser. They respond to pen pressure; with a mouse, speed simulates pressure. A stabiliser smooths the line. The **brush panel** shows every medium as a live stroke preview, with a full colour picker (HSV, hex, CMYK readout, eyedropper, artist's pigment palette and recent colours) and per-brush size, opacity, flow, hardness, texture and smoothing. Strokes are stored as data and re-rendered at screen, 300-dpi and video resolution.

### 3D visualiser (`src/three/`)
three.js with PBR materials: cloth weave, buckram, leather grain, matte / gloss / soft-touch, translucent vellum. Gold, silver, copper and holographic foil, blind deboss and spot gloss come from the finish you set on cover items. It models the exact board, rounded spine, raised bands, headbands, gilt / stained / sprayed / deckle edges, Coptic link stitches, stab-binding thread, vellum pages and die-cut holes. The book can wear its dust jacket.
- **Animations** (each with a speed control, loop and a scrubber): 360° orbit, open cover, turn pages, showcase, flip through, spine reveal, float, push in, flat turntable, read the spread, drop in, jacket off and cover close-up.
- **Lighting**: studio, soft box, window, golden hour, dramatic, top-down, overcast, gallery and night presets, each adjustable (intensity, key direction and height, warmth, exposure, shadow softness, ambient bounce).
- **Backdrops**: studio sweep, solid, gradient, oak desk, linen, concrete, paper, marble, felt or transparent, with your own colours and an optional ground with contact shadow.
- **Camera**: lens from 15° to 75° field of view (shown as 35 mm equivalent), and standing, angled, lying or open poses.
- **Stills and video in any orientation**: landscape 3:2, wide 16:9, portrait 4:5, portrait 1:√2, square and 9:16 story. The framing adapts to the aspect ratio.
- **Sharp textures, off the main thread**:
  - Close-ups redraw the visible surfaces at the resolution the camera needs. Cover finishes are included, and a Quality setting chooses between Standard, High and Ultra.
  - The drawing runs in a pool of web workers on OffscreenCanvas (`src/render/rasterPool.ts`, `rasterWorker.ts`), so orbiting and zooming don't stall the page.
  - If workers aren't available, the textures are drawn on the main thread as before.

### Export
- **Print PDF** (pdf-lib):
  - TrimBox and BleedBox, crop / bleed / registration marks, CMYK colour bars, page info.
  - CMYK with swatch builds preserved.
  - Static fonts embedded and subset; variable-font instances written as exact glyph outlines, shared as form XObjects.
  - Gradients as PDF shadings, blend modes, overprint.
  - Die-cuts on a *CutContour* spot; foil, deboss and spot-UV artwork on named spot plates.
  - Rasters only where the medium is raster, at 150–600 dpi.
- **Cover PDF** with fold and score marks and stab-hole die lines; **dust-jacket PDF** with flap and spine fold marks.
- **SVG** (text as outlines or live text) and **PNG** of a page, spread, cover or single item.
- **3D stills**: PNG up to 4096 px on the long edge, with alpha on a transparent backdrop.
- **Video**: frame-exact MP4 (H.264) and WebM (VP9) via WebCodecs + mp4-muxer / webm-muxer, with a MediaRecorder fallback, and animated GIF, in landscape, portrait, square or story formats up to 4K.
- **Project file** `.bds.json` with images and fonts embedded.

---

## Browser support
Current Chrome, Edge, Safari and Firefox on desktop. MP4/WebM encoding uses WebCodecs where available (Chrome, Edge, Safari 16.4+, Firefox 130+), otherwise MediaRecorder; GIF works everywhere. A pen tablet or Apple Pencil gives real pressure for the brushes.

## Keyboard
`V` select · `A` direct selection · `T` text · `R` rectangle · `E` ellipse · `L` rule · `P` pen · `B` brush · `X` eraser · `K` pattern · `O` ornament · `G` gradient · `D` die-cut · `M` dimension · `H`/Space hand · `Z` zoom · `[ ]` brush size · `⌘Z / ⇧⌘Z` undo/redo · `⌘D` duplicate · `⌘0` fit · `⌘= / ⌘-` zoom · `⌘] / ⌘[` arrange · `⌥⌘I` hidden characters · arrows nudge (⇧ ×10).

## Licence
The application code is licensed under the Apache License 2.0 (see `LICENSE`).

## Fonts
The bundled fonts are under the SIL Open Font License 1.1 (licence files in `public/fonts/`): EB Garamond, Fraunces, Inter, Space Grotesk, Cinzel, IBM Plex Mono and UnifrakturMaguntia. Fonts without a Reserved Font Name were subset to Latin with every OpenType feature and axis kept; Plex Mono and UnifrakturMaguntia ship unmodified. `scripts/fetch-fonts.sh` reproduces them. Japanese vertical setting uses the Mincho/Gothic installed on the viewer's system; upload a Japanese font to outline it in the PDF.

## Project layout
```
src/model       document model, units, factories, surfaces, page operations
src/engine      fonts, text layout, hyphenation, grid, binding, generators, presets, brushes
src/render      display list, element compiler, SVG / Canvas back-ends, SVG import, 3D textures
src/export      PDF, SVG/PNG, video
src/three       3D book scene
src/ui          app shell, canvas editor, inspectors, matrix, 3D view, export dialog
```

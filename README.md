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

### Micro-typography (`src/engine/textLayout.ts`, `src/engine/fonts.ts`)
- **Knuth–Plass** total-fit line breaking for justified *and* ragged text, with fitness classes, flagged-hyphen demerits and runt avoidance.
- Liang hyphenation in 13 languages, including Latin. You can set the shortest word, the letters before and after a break, a limit on consecutive hyphens (enforced inside the line breaker) and whether capitalised words break.
- Justification range: the smallest and largest word space, as a percentage of the desired space.
- **Kerning**: the font's own pairs (metrics), **optical** kerning, or none. Optical kerning is measured from the glyph outlines: it compares the white between two letters with what each has beside its own twin, so it tightens To, AV and Yo but leaves well-spaced pairs alone. Pair kerning by hand: put the cursor between two letters in the story editor and press ⌥← / ⌥→ (⇧ ×5), stored as `{k:-20}`. Kerned text stays live text in the PDF.
- **Paragraph and character styles**: a starter set (Subhead, Caption, Pull quote, Epigraph, Verse, List, Footnote, Display; Emphasis, Strong, Small caps, Spaced capitals, Rubric, superscript, subscript, old-style figures) or your own. Start a line with `[Caption]` or wrap words in `<Rubric>…</Rubric>`; the story editor's ¶ and a menus do it for you. A frame can follow a paragraph style, and overrides are flagged so you can clear them or redefine the style. Editing a style reflows every frame and paragraph that uses it. Character styles cover typeface, weight, italic, relative size, tracking, colour, case, superscript or subscript (true `sups`/`subs` when the font has them), baseline shift and figure style.
- Left, right and hanging indents, and space before and after paragraphs.
- Optical margin alignment and hanging punctuation.
- Baseline-grid locking.
- Drop caps sized so the cap height spans exactly N lines, with Cleves illumination frames.
- First line in small caps; true small caps from the font, synthesised when it has none.
- RTL lines.
- **Vertical Japanese (tategaki)** with kinsoku rules, hanging 、。, vertical punctuation forms and tate-chū-yoko.
- One shaping engine (fontkit) measures with the same font files the browser renders, so the editor, the canvas textures and the PDF agree to the glyph.
- **Font Studio**: upload OTF / TTF / WOFF / WOFF2, static or variable. It parses the `fvar` axes and named instances (sliders for `wght`, `wdth`, `slnt`, `ital`, `opsz` and custom axes) and lists the GSUB/GPOS features (`kern`, `liga`, `dlig`, `smcp`, `c2sc`, `onum`, `lnum`, `pnum`, `tnum`, `swsh`, `ss01`…), with a glyph grid.

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
`V` select · `A` direct selection · `T` text · `R` rectangle · `E` ellipse · `L` rule · `P` pen · `B` brush · `X` eraser · `K` pattern · `O` ornament · `G` gradient · `D` die-cut · `M` dimension · `H`/Space hand · `Z` zoom · `[ ]` brush size · `⌘Z / ⇧⌘Z` undo/redo · `⌘D` duplicate · `⌘0` fit · `⌘= / ⌘-` zoom · `⌘] / ⌘[` arrange · arrows nudge (⇧ ×10).

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

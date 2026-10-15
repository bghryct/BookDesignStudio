#!/usr/bin/env bash
# Fetches the open-licensed (SIL OFL 1.1) fonts bundled with Book Design Studio from
# the google/fonts repository and subsets them to Latin / Latin-Extended while keeping
# every OpenType layout feature (smcp, onum, liga, ss01 …) and every variation axis.
# Requires: curl, fonttools (pip install fonttools brotli)
set -euo pipefail
cd "$(dirname "$0")/.."
SRC="https://raw.githubusercontent.com/google/fonts/main"
TMP="$(mktemp -d)"
OUT="public/fonts"
mkdir -p "$OUT"
UNICODES="U+0000-024F,U+0259,U+02B0-02FF,U+0300-036F,U+1E00-1EFF,U+2000-206F,U+2070-209F,U+20A0-20CF,U+2100-218F,U+2190-21FF,U+2212,U+2215,U+25A0-25FF,U+2600-26FF,U+FB00-FB06,U+E000-F8FF"
fetch() { # <repo path> <out name>
  curl -sfL "$SRC/$1" -o "$TMP/$2"
  pyftsubset "$TMP/$2" --unicodes="$UNICODES" --layout-features='*' --glyph-names --notdef-outline \
    --name-IDs='*' --name-languages='*' --output-file="$OUT/$2"
  echo "  $2 $(wc -c < "$OUT/$2") bytes"
}
# Fonts whose licence declares a Reserved Font Name are shipped unmodified (no subsetting).
fetch_raw() { # <repo path> <out name>
  curl -sfL "$SRC/$1" -o "$OUT/$2"
  echo "  $2 $(wc -c < "$OUT/$2") bytes (unmodified)"
}
fetch "ofl/ebgaramond/EBGaramond%5Bwght%5D.ttf" EBGaramond-VF.ttf
fetch "ofl/ebgaramond/EBGaramond-Italic%5Bwght%5D.ttf" EBGaramond-Italic-VF.ttf
fetch "ofl/fraunces/Fraunces%5BSOFT,WONK,opsz,wght%5D.ttf" Fraunces-VF.ttf
fetch "ofl/fraunces/Fraunces-Italic%5BSOFT,WONK,opsz,wght%5D.ttf" Fraunces-Italic-VF.ttf
fetch "ofl/inter/Inter%5Bopsz,wght%5D.ttf" Inter-VF.ttf
fetch "ofl/inter/Inter-Italic%5Bopsz,wght%5D.ttf" Inter-Italic-VF.ttf
fetch "ofl/spacegrotesk/SpaceGrotesk%5Bwght%5D.ttf" SpaceGrotesk-VF.ttf
fetch_raw "ofl/ibmplexmono/IBMPlexMono-Regular.ttf" IBMPlexMono-Regular.ttf
fetch_raw "ofl/ibmplexmono/IBMPlexMono-Italic.ttf" IBMPlexMono-Italic.ttf
fetch_raw "ofl/ibmplexmono/IBMPlexMono-Bold.ttf" IBMPlexMono-Bold.ttf
fetch "ofl/cinzel/Cinzel%5Bwght%5D.ttf" Cinzel-VF.ttf
fetch_raw "ofl/unifrakturmaguntia/UnifrakturMaguntia-Book.ttf" UnifrakturMaguntia.ttf
for d in ebgaramond fraunces inter spacegrotesk ibmplexmono cinzel unifrakturmaguntia; do
  curl -sfL "$SRC/ofl/$d/OFL.txt" -o "$OUT/OFL-$d.txt" || true
done
rm -rf "$TMP"

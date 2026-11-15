#!/bin/sh
# The Devanagari font is cut down to the Hindi characters the site uses (about 12 KB
# instead of 120 KB). Run this after adding new Hindi text, then rebuild.
# Needs fonttools (pip install fonttools brotli) and the full font from Google Fonts:
#   https://fonts.google.com/noto/specimen/Noto+Sans+Devanagari  (weight 700, woff2 or ttf)
# usage: sh scripts/subset-devanagari.sh path/to/NotoSansDevanagari-full.woff2
set -e
cd "$(dirname "$0")/.."
CHARS=$(python3 -c "
import pathlib
s=''.join(p.read_text() for p in pathlib.Path('src').rglob('*.ts*'))
print(''.join(sorted(set(c for c in s if 'ऀ'<=c<='ॿ'))))")
pyftsubset "$1" --text="$CHARS ,.?!-" --unicodes="U+0964,U+0965,U+200C,U+200D,U+25CC" \
  --layout-features='*' --flavor=woff2 --output-file=public/fonts/noto-sans-devanagari-subset.woff2
echo "subset written for: $CHARS"

"""Mask Aadhaar and PAN numbers in text before it is stored.

The agent has to hear these on a call, so nothing here touches the live
conversation. This runs on the way to disk: transcripts, summaries, anything a
person or another system reads later. The rule is that a full number never
reaches storage; the last four characters stay so a human can still tell
"the 4321 one" apart from another.

Over-masking is the right way to be wrong. A masked phone number costs a
follow-up; a stored Aadhaar is a breach. So the Aadhaar pattern takes any run
of twelve digits, however the caller or the STT grouped them.

Known limits, in order of how much they matter:
- Numbers spoken as words that STT left un-numeralised ("four five six...")
  are not caught. Deepgram runs with numerals=True, which turns most into digits.
- A digit the STT got wrong is still masked, which is the safe direction.
- A twelve-digit phone number written with its country code and no "+" (as in
  "91 98765 43210") looks exactly like an Aadhaar and is masked.
"""

import re

# Devanagari digits read as their ASCII equivalents, so Hindi transcripts are
# masked the same way.
_DIGIT_TABLE = str.maketrans("०१२३४५६७८९", "0123456789")

_SEP = r"[ \-.]?"

# Twelve digits with optional single separators between them. Digit runs on
# either side disqualify it, so a 16-digit card number is not half-masked as an
# "Aadhaar" plus four stray digits, and a "+91..." phone number is left alone.
_AADHAAR = re.compile(r"(?<![\d+])(?:\d" + _SEP + r"){11}\d(?!\d)")

# Five letters, four digits, one letter, with the same separators allowed
# between characters because STT often spells a PAN out one character at a time.
_PAN = re.compile(
    r"(?<![A-Za-z0-9])(?:[A-Za-z]" + _SEP + r"){5}(?:\d" + _SEP + r"){4}[A-Za-z](?![A-Za-z0-9])"
)


def _mask_aadhaar(match: re.Match) -> str:
    digits = re.sub(r"\D", "", match.group())
    return f"XXXX XXXX {digits[-4:]}"


def _mask_pan(match: re.Match) -> str:
    chars = re.sub(r"[^A-Za-z0-9]", "", match.group()).upper()
    return f"XXXXXX{chars[-4:]}"


def mask_sensitive(text: str) -> str:
    """Return text with any Aadhaar or PAN number replaced by a masked form."""
    text = text.translate(_DIGIT_TABLE)
    text = _AADHAAR.sub(_mask_aadhaar, text)
    return _PAN.sub(_mask_pan, text)


def contains_sensitive(text: str) -> bool:
    """True if mask_sensitive would change anything beyond digit normalisation."""
    return mask_sensitive(text) != text.translate(_DIGIT_TABLE)

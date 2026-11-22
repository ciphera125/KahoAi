"""Ask again when the recogniser was not sure of a number.

Deepgram scores every word it hears, from 0 to 1, on the result Pipecat attaches to each final
transcript. A phone number, an OTP or an amount with a low score is likely wrong, and a lead saved
with a wrong number is worse than asking once more. When a number's score is below the threshold,
the model is handed a short note after the caller's words, in plain language, so it asks the caller
to say it again in whatever language the call is in.

The note is ours, not the caller's: CallTranscript strips it before anything is stored, and
nothing here may ever raise into a live call.
"""

import math
import re

from loguru import logger
from pipecat.frames.frames import TranscriptionFrame
from pipecat.processors.frame_processor import FrameProcessor

NOTE = ("[Speech recognition could not hear the number just said clearly. "
        "Ask the caller to say it again, slowly, before you use it.]")

# Measured on 2026-11-22 (32 spoken numbers through the live API, see CLEANROOM.md): this flags
# 6 of the 18 wrong numbers and 2 of the 14 right ones. A weak signal, not a guarantee.
DEFAULT_MIN_CONFIDENCE = 0.65

# Spoken digits, in English and in Hindi (Devanagari and Roman). One of these alone is an
# ordinary word ("ek minute", "do log"), so only a run of at least three counts as a number.
_DIGIT_WORDS = {
    "zero", "oh", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine",
    "शून्य", "एक", "दो", "तीन", "चार", "पांच", "पाँच", "छह", "छे", "छः", "सात", "आठ", "नौ",
    "shunya", "ek", "do", "teen", "char", "chaar", "panch", "paanch", "chhe", "chheh", "che",
    "saat", "aath", "nau", "nao",
}
_MIN_RUN = 3
# Asking again is a cost to the caller. After this many requests in one call it stops, whatever
# the line sounds like: a caller on a bad line, or one talking the agent in circles, is not asked
# all call long.
MAX_NOTES_PER_CALL = 3
_EDGE = re.compile(r"^[^\w]+|[^\w]+$")


def min_confidence(raw) -> float | None:
    """STT_NUMBER_MIN_CONFIDENCE: unset means the default, "off" or 0 means never ask, and a
    value that is not a number between 0 and 1 means the default."""
    text = raw.strip().lower() if isinstance(raw, str) else ""
    if not text:
        return DEFAULT_MIN_CONFIDENCE
    if text == "off":
        return None
    try:
        value = float(text)
    except ValueError:
        return DEFAULT_MIN_CONFIDENCE
    if not math.isfinite(value) or value < 0 or value > 1:
        return DEFAULT_MIN_CONFIDENCE
    return None if value == 0 else value


def _words(result) -> list[tuple[str, float]]:
    """(text, confidence) for each word of the first alternative, or [] for anything unexpected."""
    try:
        words = result.channel.alternatives[0].words
        out = []
        for w in words:
            confidence = float(w.confidence)
            if math.isfinite(confidence):
                out.append((str(w.word), confidence))
        return out
    except Exception:  # noqa: BLE001 - a transcript is never lost to a surprise in its metadata
        return []


def lowest_number_confidence(result) -> float | None:
    """The lowest score among the words that are part of a number, or None when there is no
    number (or nothing readable). A number is a word with a digit in it, or a run of spoken
    digits."""
    words = _words(result)
    if not words:
        return None
    numeric = [any(ch.isdigit() for ch in text) for text, _ in words]
    spoken = [_EDGE.sub("", text).casefold() in _DIGIT_WORDS for text, _ in words]
    i = 0
    while i < len(words):
        if spoken[i]:
            j = i
            while j < len(words) and spoken[j]:
                j += 1
            if j - i >= _MIN_RUN:
                for k in range(i, j):
                    numeric[k] = True
            i = j
        else:
            i += 1
    scores = [c for (_, c), is_number in zip(words, numeric, strict=True) if is_number]
    return min(scores) if scores else None


class FlagUnsureNumbers(FrameProcessor):
    """Adds NOTE to a final transcript whose number was not heard clearly. Interim
    transcripts, transcripts with no result, and clear numbers pass untouched."""

    def __init__(self, threshold: float, on_unsure=None):
        super().__init__()
        self._threshold = threshold
        self._on_unsure = on_unsure
        self._asked = 0

    async def process_frame(self, frame, direction):
        await super().process_frame(frame, direction)
        if (isinstance(frame, TranscriptionFrame) and NOTE not in frame.text
                and self._asked < MAX_NOTES_PER_CALL):
            try:
                low = lowest_number_confidence(getattr(frame, "result", None))
                if low is not None and low < self._threshold:
                    frame.text = f"{frame.text} {NOTE}"
                    self._asked += 1
                    if self._on_unsure is not None:
                        self._on_unsure(low)
            except Exception as e:  # noqa: BLE001 - never raised into a live call
                logger.warning(f"Number confidence check skipped: {type(e).__name__}")
        await self.push_frame(frame, direction)

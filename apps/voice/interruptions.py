"""Decide which caller sounds are allowed to interrupt the agent.

Pipecat's defaults start the caller's turn, and so cancel the LLM and TTS, the
moment the VAD hears anything. On a phone line that includes a cough, traffic,
a TV in the room and the "haan" / "okay" / "mm-hm" people say to show they are
listening. Each of those would cut the agent off mid-sentence.

While the agent is silent nothing changes: any speech starts the caller's turn.
While the agent is speaking:

- the VAD alone never interrupts. A noise that the STT hears no words in stays
  ignored, however loud;
- words interrupt only if enough of them are not backchannel. "yeah", "okay",
  "hmm", "haan", "theek hai" are ignored; "wait", "no", "what about Sunday" are
  not. A backchannel followed by real words ("yeah but ...") interrupts.

Ignored transcripts are dropped from the pending turn, so a "yeah" said over the
agent does not reappear glued to the caller's next real sentence.

What we cannot know: whether a caller who only says backchannel words over the
agent wanted it to stop. That is the trade-off; INTERRUPT_IGNORE_WORDS and
INTERRUPT_MIN_WORDS tune it, INTERRUPT_FILTER=false restores Pipecat's default.
The cost is time: an interruption now waits for the STT to produce words
(typically a few hundred ms) instead of firing on the first VAD frame.
"""

import re

from loguru import logger
from pipecat.frames.frames import (
    BotStartedSpeakingFrame,
    BotStoppedSpeakingFrame,
    Frame,
    InterimTranscriptionFrame,
    TranscriptionFrame,
    VADUserStartedSpeakingFrame,
)
from pipecat.turns.types import ProcessFrameResult
from pipecat.turns.user_start.base_user_turn_start_strategy import BaseUserTurnStartStrategy

# Words that show the caller is listening, not that they want the floor. English,
# Hindi in Roman script, and Hindi in Devanagari, since the STT emits either.
BACKCHANNEL_WORDS = frozenset(
    {
        # English
        "yeah", "yes", "yep", "yup", "ya", "okay", "ok", "k", "right", "sure", "alright",
        "hmm", "hm", "mm", "mmm", "mhm", "uh", "um", "uhh", "umm", "huh", "ah", "oh",
        "aha", "got", "it", "i", "see", "true", "fine", "cool", "good", "great", "nice",
        # Hindi, Roman script
        "haan", "han", "ha", "hanji", "ji", "achha", "accha", "acha", "theek", "thik",
        "hai", "sahi", "bilkul",
        # Hindi, Devanagari
        "हाँ", "हां", "हा", "जी", "अच्छा", "ठीक", "है", "सही", "बिल्कुल", "हम्म",
    }
)  # fmt: skip

# Split on whitespace and punctuation rather than matching word characters:
# Devanagari vowel signs are not \w, so "हाँ" would be cut into pieces.
_SPLIT = re.compile(r"[\s.,!?;:\"“”()\-–—…।]+")


def words_of(text: str) -> list[str]:
    return [w.lower() for w in _SPLIT.split(text or "") if w]


def substantive_words(text: str, ignore: frozenset[str] = BACKCHANNEL_WORDS) -> int:
    """How many words in `text` are not backchannel."""
    return sum(1 for w in words_of(text) if w not in ignore)


class SpeechWhileSilentStartStrategy(BaseUserTurnStartStrategy):
    """Start the caller's turn on VAD, but only while the agent is not speaking.

    While the agent speaks, this stays out of the way and the word-based strategy
    decides. Without it the VAD would interrupt on every cough.
    """

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self._bot_speaking = False

    async def process_frame(self, frame: Frame) -> ProcessFrameResult:
        if isinstance(frame, BotStartedSpeakingFrame):
            self._bot_speaking = True
        elif isinstance(frame, BotStoppedSpeakingFrame):
            self._bot_speaking = False
        elif isinstance(frame, VADUserStartedSpeakingFrame) and not self._bot_speaking:
            await self.trigger_user_turn_started()
            return ProcessFrameResult.STOP
        return ProcessFrameResult.CONTINUE


class RealInterruptionStartStrategy(BaseUserTurnStartStrategy):
    """Start the caller's turn from words: any word while the agent is silent, and
    `min_words` non-backchannel words while it speaks."""

    def __init__(
        self,
        *,
        min_words: int = 1,
        ignore_words: frozenset[str] = BACKCHANNEL_WORDS,
        **kwargs,
    ):
        super().__init__(**kwargs)
        self._min_words = max(1, min_words)
        self._ignore = ignore_words
        self._bot_speaking = False

    async def handle_user_turn_started(self):
        self._bot_speaking = False

    async def process_frame(self, frame: Frame) -> ProcessFrameResult:
        if isinstance(frame, BotStartedSpeakingFrame):
            self._bot_speaking = True
        elif isinstance(frame, BotStoppedSpeakingFrame):
            self._bot_speaking = False
        elif isinstance(frame, TranscriptionFrame | InterimTranscriptionFrame):
            return await self._on_words(frame)
        return ProcessFrameResult.CONTINUE

    async def _on_words(self, frame) -> ProcessFrameResult:
        if not words_of(frame.text):
            return ProcessFrameResult.CONTINUE
        if not self._bot_speaking:
            await self.trigger_user_turn_started()
            return ProcessFrameResult.STOP
        if substantive_words(frame.text, self._ignore) >= self._min_words:
            logger.info(f"Interruption: {len(words_of(frame.text))} word(s) over the agent")
            await self.trigger_user_turn_started()
            return ProcessFrameResult.STOP
        logger.debug("Ignored backchannel over the agent; not an interruption")
        await self.trigger_reset_aggregation()
        return ProcessFrameResult.CONTINUE


def build_start_strategies(
    *, enabled: bool = True, min_words: int = 1, extra_ignore: frozenset[str] = frozenset()
) -> list[BaseUserTurnStartStrategy]:
    """The start strategies for the caller's turn. Disabled means Pipecat's own defaults."""
    if not enabled:
        from pipecat.turns.user_turn_strategies import default_user_turn_start_strategies

        return default_user_turn_start_strategies()
    return [
        SpeechWhileSilentStartStrategy(),
        RealInterruptionStartStrategy(
            min_words=min_words, ignore_words=BACKCHANNEL_WORDS | extra_ignore
        ),
    ]

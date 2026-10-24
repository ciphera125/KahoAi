"""A reply is cut after REPLY_MAX_SENTENCES, whatever the model writes.

Seen on a real call: replies ran long and the caller cut the agent off 11
times. The prompt asks for one or two sentences; this is the code that holds it.
"""

import main
import pytest
from pipecat.frames.frames import (
    InterruptionFrame,
    LLMFullResponseEndFrame,
    LLMFullResponseStartFrame,
    LLMTextFrame,
    TTSSpeakFrame,
)
from pipecat.processors.frame_processor import FrameDirection


async def run(cap, *frames):
    out = []
    proc = main.CapReplyLength(cap)

    async def capture(frame, direction=FrameDirection.DOWNSTREAM):
        out.append(frame)

    proc.push_frame = capture
    for f in frames:
        await proc.process_frame(f, FrameDirection.DOWNSTREAM)
    return "".join(f.text for f in out if isinstance(f, LLMTextFrame)), out


def tokens(text):
    return [LLMTextFrame(t) for t in text.split("|")]


async def test_text_after_the_last_allowed_sentence_is_not_spoken():
    reply = "Your EMI is due| tomorrow. It is| Rs. 5,000. Pay by| UPI or card."
    said, out = await run(2, LLMFullResponseStartFrame(), *tokens(reply),
                          LLMFullResponseEndFrame())
    assert said == "Your EMI is due tomorrow. It is Rs. 5,000."
    assert isinstance(out[-1], LLMFullResponseEndFrame)  # the reply still ends normally


async def test_hindi_sentences_count_too():
    said, _ = await run(1, LLMFullResponseStartFrame(),
                        *tokens("आपकी EMI कल है।| क्या आप भुगतान करेंगे?"), LLMFullResponseEndFrame())
    assert said == "आपकी EMI कल है।"


async def test_a_short_reply_passes_untouched_and_each_reply_starts_afresh():
    said, _ = await run(1, LLMFullResponseStartFrame(), *tokens("Hello."),
                        LLMFullResponseEndFrame(), LLMFullResponseStartFrame(),
                        *tokens(" How can| I help?"), LLMFullResponseEndFrame())
    assert said == "Hello. How can I help?"


async def test_decimals_and_abbreviations_are_not_sentence_ends():
    said, _ = await run(1, LLMFullResponseStartFrame(),
                        *tokens("Dr. Rao charges 5.5 per cent. Anything else?"),
                        LLMFullResponseEndFrame())
    assert said == "Dr. Rao charges 5.5 per cent."


async def test_an_interruption_starts_a_fresh_count():
    said, _ = await run(1, LLMFullResponseStartFrame(), *tokens("One. Two."),
                        InterruptionFrame(), *tokens(" Three."), LLMFullResponseEndFrame())
    assert said == "One. Three."


async def test_other_frames_and_spoken_lines_are_never_cut():
    _, out = await run(1, LLMFullResponseStartFrame(), *tokens("One. Two."),
                       TTSSpeakFrame("This call may be recorded. Please hold."))
    assert any(isinstance(f, TTSSpeakFrame) for f in out)


@pytest.mark.parametrize("raw, expected", [(None, 3), ("", 3), ("2", 2), ("0", 0),
                                           ("-1", 3), ("lots", 3)])
def test_the_cap_comes_from_the_environment(monkeypatch, raw, expected):
    if raw is None:
        monkeypatch.delenv("REPLY_MAX_SENTENCES", raising=False)
    else:
        monkeypatch.setenv("REPLY_MAX_SENTENCES", raw)
    assert main.reply_max_sentences() == expected

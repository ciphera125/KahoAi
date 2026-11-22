"""The agent asks again when the recogniser was not sure of a number (2026-11-22).

Deepgram scores every word it hears. A phone number, an OTP or an amount that came back with a
low score is likely wrong, and a lead saved with a wrong number is worse than asking once more.
The score was always on the result Pipecat attaches to each transcript; nothing read it.

The note the model is given is ours, not the caller's: it must never be stored as something the
caller said, and the check must never break a call.
"""

import json

import number_confidence
import pytest
from deepgram.listen.v1.types import ListenV1Results
from pipecat.frames.frames import InterimTranscriptionFrame, TranscriptionFrame
from pipecat.processors.frame_processor import FrameDirection
from transcript import CallTranscript

META = {"request_id": "r", "model_uuid": "u",
        "model_info": {"name": "n", "version": "v", "arch": "a"}}


def result(*words, is_final=True):
    """A real Deepgram result whose words are (text, confidence) pairs."""
    spoken = [{"word": w, "start": i * 0.3, "end": i * 0.3 + 0.2, "confidence": c}
              for i, (w, c) in enumerate(words)]
    return ListenV1Results.model_validate({
        "type": "Results", "channel_index": [0, 1], "duration": 1.0, "start": 0.0,
        "is_final": is_final, "speech_final": is_final, "from_finalize": False,
        "metadata": META,
        "channel": {"alternatives": [{
            "transcript": " ".join(w for w, _ in words), "confidence": 0.9, "words": spoken}]}})


# ---- finding the doubtful number ----


def test_a_clear_number_has_no_doubt():
    r = result(("my", 0.99), ("number", 0.98), ("9876543210", 0.97))
    assert number_confidence.lowest_number_confidence(r) == 0.97


def test_a_doubtful_number_is_reported_at_its_lowest_score():
    r = result(("it", 0.99), ("is", 0.99), ("98765", 0.95), ("43210", 0.41))
    assert number_confidence.lowest_number_confidence(r) == 0.41


def test_a_doubtful_ordinary_word_is_not_a_doubtful_number():
    r = result(("maybe", 0.2), ("tomorrow", 0.3), ("morning", 0.9))
    assert number_confidence.lowest_number_confidence(r) is None


def test_digit_words_in_a_run_count_as_a_number_in_english_and_hindi():
    english = result(("nine", 0.9), ("eight", 0.5), ("seven", 0.9), ("six", 0.9))
    assert number_confidence.lowest_number_confidence(english) == 0.5
    hindi = result(("नौ", 0.9), ("आठ", 0.9), ("सात", 0.3), ("छह", 0.9))
    assert number_confidence.lowest_number_confidence(hindi) == 0.3


def test_one_small_word_alone_is_not_a_number():
    # "ek minute", "do log": common Hindi words that are also digits.
    r = result(("ek", 0.2), ("minute", 0.9))
    assert number_confidence.lowest_number_confidence(r) is None
    r = result(("do", 0.2), ("teen", 0.2), ("minute", 0.9))
    assert number_confidence.lowest_number_confidence(r) is None


def test_devanagari_digits_count_as_digits():
    assert number_confidence.lowest_number_confidence(result(("९८७६५", 0.4))) == 0.4


@pytest.mark.parametrize("junk", [None, 5, "text", object(), {"channel": 1}])
def test_anything_unexpected_gives_no_answer_and_never_raises(junk):
    assert number_confidence.lowest_number_confidence(junk) is None


def test_a_result_with_no_words_gives_no_answer():
    r = ListenV1Results.model_validate({
        "type": "Results", "channel_index": [0, 1], "duration": 1.0, "start": 0.0, "is_final": True,
        "speech_final": True, "from_finalize": False, "metadata": META,
        "channel": {"alternatives": [{"transcript": "", "confidence": 0.0, "words": []}]}})
    assert number_confidence.lowest_number_confidence(r) is None


# ---- the setting ----


def test_the_threshold_has_a_default_and_can_be_changed_or_switched_off():
    assert number_confidence.min_confidence(None) == number_confidence.DEFAULT_MIN_CONFIDENCE
    assert number_confidence.min_confidence("") == number_confidence.DEFAULT_MIN_CONFIDENCE
    assert number_confidence.min_confidence("0.6") == 0.6
    assert number_confidence.min_confidence("off") is None
    assert number_confidence.min_confidence("0") is None


def test_the_default_is_the_one_measured_on_real_deepgram_runs():
    # 2026-11-22, 32 spoken numbers through the live API (CLEANROOM.md): below 0.65 it flagged
    # 6 of the 18 wrong numbers and 2 of the 14 right ones. Higher flags more right ones than
    # wrong ones it adds. Change it only with a new measurement.
    assert number_confidence.DEFAULT_MIN_CONFIDENCE == 0.65


@pytest.mark.parametrize("bad", ["lots", "1.5", "-1", "nan", "inf"])
def test_a_threshold_that_makes_no_sense_falls_back_to_the_default(bad):
    assert number_confidence.min_confidence(bad) == number_confidence.DEFAULT_MIN_CONFIDENCE


# ---- the processor ----


async def run(processor, frame):
    out = []

    async def capture(f, direction=None):
        out.append(f)

    processor.push_frame = capture
    await processor.process_frame(frame, FrameDirection.DOWNSTREAM)
    return out


def final(text, res):
    return TranscriptionFrame(text, "u", "2026-11-22T00:00:00Z", None, result=res)


async def test_a_doubtful_number_gets_the_note_the_model_reads():
    seen = []
    proc = number_confidence.FlagUnsureNumbers(0.75, on_unsure=lambda low: seen.append(low))
    out = await run(proc, final("it is 98765 43210", result(("98765", 0.95), ("43210", 0.41))))
    assert out[0].text.startswith("it is 98765 43210")
    assert out[0].text.endswith(number_confidence.NOTE)
    assert seen == [0.41]


async def test_a_clear_number_is_left_exactly_alone():
    proc = number_confidence.FlagUnsureNumbers(0.75)
    out = await run(proc, final("it is 9876543210", result(("9876543210", 0.97))))
    assert out[0].text == "it is 9876543210"


async def test_a_transcript_without_a_result_passes_untouched():
    proc = number_confidence.FlagUnsureNumbers(0.75)
    frame = TranscriptionFrame("hello 5", "u", "t", None)
    out = await run(proc, frame)
    assert out[0].text == "hello 5"


async def test_interim_transcripts_are_never_flagged():
    proc = number_confidence.FlagUnsureNumbers(0.75)
    frame = InterimTranscriptionFrame(
        "it is 98", "u", "t", None, result=result(("98", 0.1), is_final=False))
    out = await run(proc, frame)
    assert out[0].text == "it is 98"


async def test_a_note_is_added_once_only():
    proc = number_confidence.FlagUnsureNumbers(0.75)
    first = (await run(proc, final("98", result(("98", 0.1)))))[0]
    again = (await run(proc, first))[0]
    assert again.text.count(number_confidence.NOTE) == 1


async def test_a_broken_result_cannot_break_the_call():
    proc = number_confidence.FlagUnsureNumbers(0.75, on_unsure=lambda low: 1 / 0)
    out = await run(proc, final("98", result(("98", 0.1))))
    assert out and out[0].text.startswith("98")


# ---- the transcript keeps only what the caller said ----


def test_the_note_is_never_stored_as_something_the_caller_said(tmp_path):
    t = CallTranscript("call-note", tmp_path)
    t.user(f"my number is 98765 43210 {number_confidence.NOTE}")
    t.end()
    text = "\n".join(p.read_text(encoding="utf-8") for p in tmp_path.rglob("*") if p.is_file())
    assert "Speech recognition" not in text
    assert "my number is" in text
    assert json.dumps(t.caller_text).count("Speech recognition") == 0


def test_a_turn_that_is_only_the_note_stores_nothing(tmp_path):
    t = CallTranscript("call-note-2", tmp_path)
    t.user(number_confidence.NOTE)
    assert t.caller_text == []

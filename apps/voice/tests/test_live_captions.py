"""Live captions: what the agent is saying and what the caller is saying, as it happens.

They reach the Studio's live transcript through the call's transcript file, so they
go through CallTranscript like all call content. A caption can be a fragment of a
number spread over several ("2 3 4" / "5 6 7"), which per-line masking cannot see,
so every digit in a caption is blanked; the turn's final, properly masked text
replaces it when the turn ends.
"""

import json

import main
from pipecat.frames.frames import InterimTranscriptionFrame, TTSTextFrame
from pipecat.observers.base_observer import FramePushed
from pipecat.processors.frame_processor import FrameDirection
from transcript import CallTranscript


def lines(t):
    return [json.loads(x) for x in t.path.read_text(encoding="utf-8").splitlines()]


def test_a_caption_is_written_with_every_digit_blanked(tmp_path):
    t = CallTranscript("c1", tmp_path)
    t.live("agent", "Your number ends 2 3 4 5, right?")
    t.live("caller", "it's 9876")
    live = [x for x in lines(t) if x["event"] == "live"]
    assert [(x["role"], x["text"]) for x in live] == [
        ("agent", "Your number ends • • • •, right?"), ("caller", "it's ••••")]


async def push(observer, frame, direction=FrameDirection.DOWNSTREAM):
    await observer.on_push_frame(FramePushed(source=None, destination=None, frame=frame,
                                             direction=direction, timestamp=0))


async def test_spoken_words_and_heard_words_become_captions_once(tmp_path):
    t = CallTranscript("c2", tmp_path)
    obs = main.LiveCaptions(t)
    spoken = TTSTextFrame("Hello there", aggregated_by="word")
    heard = InterimTranscriptionFrame("मेरा नाम", user_id="", timestamp="")
    for frame in (spoken, spoken, heard, heard):  # observers see each frame at every hop
        await push(obs, frame)
    live = [(x["role"], x["text"]) for x in lines(t) if x["event"] == "live"]
    assert live == [("agent", "Hello there"), ("caller", "मेरा नाम")]


async def test_empty_text_is_not_a_caption(tmp_path):
    t = CallTranscript("c3", tmp_path)
    await push(main.LiveCaptions(t), TTSTextFrame("  ", aggregated_by="word"))
    assert not [x for x in lines(t) if x["event"] == "live"]


def test_captions_never_reach_the_summary(tmp_path):
    import summary

    t = CallTranscript("c4", tmp_path)
    t.live("agent", "Hello")
    t.user("Hi")
    text, caller_turns = summary.transcript_text(t.path)
    assert text == "Caller: Hi" and caller_turns == 1

"""The turn-phase timings TurnTimingLogger adds on top of Pipecat's metrics.

Pipecat's own metrics begin when a service is handed work, so they cannot see
the wait before that: the VAD's stop_secs, then the smart-turn classifier
deciding the caller has actually finished. On the first real phone calls
(2026-10-15) those stage metrics summed to 1-2s while the caller sat through
4-7s of silence, so that gap is now measured from frames instead.
"""

import json

import main
import pytest
from pipecat.frames.frames import (
    BotStartedSpeakingFrame,
    BotStoppedSpeakingFrame,
    UserStoppedSpeakingFrame,
    VADUserStoppedSpeakingFrame,
)
from pipecat.observers.base_observer import FramePushed
from pipecat.processors.frame_processor import FrameDirection


@pytest.fixture
def logger(tmp_path):
    return main.TurnTimingLogger(tmp_path / "turns.jsonl")


def pushed(frame, direction=FrameDirection.DOWNSTREAM):
    """A FramePushed as an observer receives it; only `.frame` and `.direction`
    are read. Downstream is the copy that counts — see the logger."""
    return FramePushed(
        source=None, destination=None, frame=frame, direction=direction, timestamp=0
    )


async def feed(logger, *frames):
    for frame in frames:
        await logger.on_push_frame(pushed(frame))


def records(logger, metric=None):
    path = logger._path
    if not path.exists():
        return []
    rows = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]
    return [r for r in rows if metric is None or r["metric"] == metric]


async def test_a_whole_turn_is_broken_into_detection_and_reply(logger):
    """The caller's wait splits into the part before the turn was ruled over and
    the part after, and the total is what they actually sat through."""
    await feed(
        logger,
        VADUserStoppedSpeakingFrame(),
        UserStoppedSpeakingFrame(),
        BotStartedSpeakingFrame(),
    )
    detection = records(logger, "turn_detection")
    reply = records(logger, "reply_after_turn")
    wait = records(logger, "caller_wait")
    assert len(detection) == len(reply) == len(wait) == 1
    assert wait[0]["seconds"] == pytest.approx(
        detection[0]["seconds"] + reply[0]["seconds"], abs=0.01
    )


async def test_the_greeting_is_not_timed_against_a_caller_turn(logger):
    """The greeting and the recording notice speak with no caller turn in front
    of them; timing them against nothing would invent a measurement."""
    await feed(logger, BotStartedSpeakingFrame(), BotStoppedSpeakingFrame())
    assert records(logger) == []


async def test_each_frame_is_counted_once_however_many_hops_it_makes(logger):
    """Observers see a frame at every hop, and the output transport sends the
    speaking frames in both directions. Counting the copies would log a turn
    several times over."""
    vad, turn, bot = (
        VADUserStoppedSpeakingFrame(),
        UserStoppedSpeakingFrame(),
        BotStartedSpeakingFrame(),
    )
    await feed(logger, vad, vad, turn, turn, turn, bot, bot)
    # Every phase, not just the total: a re-counted turn-end writes its own
    # measurement each time while the total still looks right.
    assert len(records(logger, "turn_detection")) == 1
    assert len(records(logger, "reply_after_turn")) == 1
    assert len(records(logger, "caller_wait")) == 1


async def test_the_upstream_copy_of_a_speaking_frame_is_not_a_second_turn(logger):
    """The output transport sends each bot-speaking frame in both directions.
    The upstream copy is the same event, not another reply."""
    bot = BotStartedSpeakingFrame()
    await feed(logger, VADUserStoppedSpeakingFrame(), UserStoppedSpeakingFrame())
    await logger.on_push_frame(pushed(bot, FrameDirection.UPSTREAM))
    assert records(logger, "caller_wait") == []
    await logger.on_push_frame(pushed(bot, FrameDirection.DOWNSTREAM))
    assert len(records(logger, "caller_wait")) == 1


async def test_a_new_caller_turn_drops_the_last_one(logger):
    """A turn that never reached the agent (an interruption, a cancelled reply)
    must not be measured against the *next* reply, which would report a wait
    that nobody sat through."""
    await feed(logger, VADUserStoppedSpeakingFrame(), UserStoppedSpeakingFrame())
    await feed(logger, VADUserStoppedSpeakingFrame(), BotStartedSpeakingFrame())
    # Only the second turn reached the agent, and it never had a turn-end.
    assert len(records(logger, "caller_wait")) == 1
    assert records(logger, "reply_after_turn") == []


async def test_a_reply_is_measured_once_not_once_per_sentence(logger):
    """TTS speaks a reply sentence by sentence, so the agent starts and stops
    speaking several times per turn; only the first start is the caller's wait."""
    await feed(
        logger,
        VADUserStoppedSpeakingFrame(),
        UserStoppedSpeakingFrame(),
        BotStartedSpeakingFrame(),
        BotStoppedSpeakingFrame(),
        BotStartedSpeakingFrame(),
    )
    assert len(records(logger, "caller_wait")) == 1

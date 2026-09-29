"""Only real speech over the agent interrupts it; noise and backchannel do not.

These run a real LLMUserAggregator in a real pipeline with the strategies from
interruptions.py, and look at whether Pipecat's InterruptionFrame comes out. That
frame is what cancels the LLM generation and the TTS audio downstream.
"""

import pytest
from interruptions import BACKCHANNEL_WORDS, build_start_strategies, substantive_words
from pipecat.frames.frames import (
    BotStartedSpeakingFrame,
    BotStoppedSpeakingFrame,
    InterimTranscriptionFrame,
    InterruptionFrame,
    TranscriptionFrame,
    UserStartedSpeakingFrame,
    VADUserStartedSpeakingFrame,
    VADUserStoppedSpeakingFrame,
)
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import (
    LLMContextAggregatorPair,
    LLMUserAggregatorParams,
)
from pipecat.tests.utils import SleepFrame, run_test
from pipecat.turns.user_turn_strategies import UserTurnStrategies


def words(text):
    return TranscriptionFrame(text=text, user_id="u", timestamp="2026-09-29T00:00:00Z")


async def interrupted(frames, **kw):
    """True if the caller's frames, sent while the agent speaks, produced an interruption."""
    user, _ = LLMContextAggregatorPair(
        LLMContext(),
        user_params=LLMUserAggregatorParams(
            user_turn_strategies=UserTurnStrategies(start=build_start_strategies(**kw))
        ),
    )
    down, _ = await run_test(
        user,
        frames_to_send=[BotStartedSpeakingFrame(), SleepFrame(0.05), *frames, SleepFrame(0.1)],
    )
    return any(isinstance(f, InterruptionFrame) for f in down)


async def test_real_speech_over_the_agent_interrupts_it():
    assert await interrupted(
        [VADUserStartedSpeakingFrame(), words("wait, what about Sunday")]
    )


async def test_a_single_real_word_interrupts():
    assert await interrupted([VADUserStartedSpeakingFrame(), words("stop")])


async def test_a_cough_does_not_interrupt():
    # The VAD fires, the STT hears no words: nothing to interrupt for.
    assert not await interrupted(
        [VADUserStartedSpeakingFrame(), SleepFrame(0.2), VADUserStoppedSpeakingFrame()]
    )


async def test_a_noise_the_stt_transcribes_as_nothing_does_not_interrupt():
    assert not await interrupted([VADUserStartedSpeakingFrame(), words("  ")])


@pytest.mark.parametrize(
    "text", ["okay", "hmm", "Yeah.", "mm-hm", "uh-huh", "haan", "theek hai", "हाँ", "okay, right"]
)
async def test_a_backchannel_does_not_interrupt(text):
    assert not await interrupted([VADUserStartedSpeakingFrame(), words(text)])


async def test_an_interim_backchannel_does_not_interrupt():
    assert not await interrupted(
        [
            VADUserStartedSpeakingFrame(),
            InterimTranscriptionFrame(text="yeah", user_id="u", timestamp="t"),
        ]
    )


async def test_a_backchannel_followed_by_real_words_interrupts():
    assert await interrupted([VADUserStartedSpeakingFrame(), words("yeah but the price is wrong")])


async def test_min_words_raises_the_bar():
    assert not await interrupted([words("wait")], min_words=2)
    assert await interrupted([words("wait a second")], min_words=2)


async def test_extra_ignore_words_are_honoured():
    assert not await interrupted([words("achhaji")], extra_ignore=frozenset({"achhaji"}))


async def test_disabling_the_filter_restores_pipecats_default():
    # Pipecat's default interrupts on the VAD alone, so even a backchannel cuts in.
    assert await interrupted([VADUserStartedSpeakingFrame(), words("okay")], enabled=False)


@pytest.mark.parametrize("text", ["okay", "hello there"])
async def test_speech_when_the_agent_is_silent_starts_the_turn(text):
    # Not over the agent, so even "okay" is an ordinary answer, not a backchannel.
    user, _ = LLMContextAggregatorPair(
        LLMContext(),
        user_params=LLMUserAggregatorParams(
            user_turn_strategies=UserTurnStrategies(start=build_start_strategies())
        ),
    )
    down, _ = await run_test(
        user,
        frames_to_send=[
            BotStartedSpeakingFrame(),
            BotStoppedSpeakingFrame(),
            SleepFrame(0.05),
            words(text),
            SleepFrame(0.1),
        ],
    )
    assert any(isinstance(f, UserStartedSpeakingFrame) for f in down)


async def test_vad_alone_starts_the_turn_when_the_agent_is_silent():
    user, _ = LLMContextAggregatorPair(
        LLMContext(),
        user_params=LLMUserAggregatorParams(
            user_turn_strategies=UserTurnStrategies(start=build_start_strategies())
        ),
    )
    down, _ = await run_test(
        user, frames_to_send=[VADUserStartedSpeakingFrame(), SleepFrame(0.1)]
    )
    assert any(isinstance(f, UserStartedSpeakingFrame) for f in down)


def test_word_classification():
    assert substantive_words("okay yeah hmm") == 0
    assert substantive_words("okay but wait") == 2
    assert substantive_words("") == 0
    assert "yeah" in BACKCHANNEL_WORDS

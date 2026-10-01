"""The recording notice: said first, word for word, whenever the call is recorded."""

import asyncio
import json
import time
from types import SimpleNamespace

import main
import pytest
from pipecat.processors.aggregators.llm_response_universal import LLMUserAggregator
from pipecat.turns.user_mute import MuteUntilFirstBotCompleteUserMuteStrategy
from pipecat.workers.runner import WorkerRunner
from pipeline_fakes import GreetingLLM, PassThrough, SpeakingTTS, Transport
from recording import DEFAULT_NOTICE

GREETING = GreetingLLM.GREETING


@pytest.fixture
def call(monkeypatch, tmp_path):
    for name, value in {
        "DEEPGRAM_API_KEY": "k",
        "CALL_LOG_DIR": str(tmp_path / "calls"),
        "LATENCY_LOG_PATH": str(tmp_path / "turns.jsonl"),
        "RECORDING_DIR": str(tmp_path / "recordings"),
        "RECORDING_ENABLED": "true",
        "SUMMARY_ENABLED": "false",
    }.items():
        monkeypatch.setenv(name, value)
    for name in ("RECORDING_NOTICE", "RECORDING_NOTICE_ENABLED", "TTS_FALLBACK_PROVIDER"):
        monkeypatch.delenv(name, raising=False)
    tts, llm = SpeakingTTS(), GreetingLLM()
    monkeypatch.setattr(main, "DeepgramSTTService", PassThrough)
    monkeypatch.setattr(main, "build_tts_stack", lambda: (tts, [tts], None))
    monkeypatch.setattr(main, "build_llm", lambda *a, **k: llm)
    return SimpleNamespace(tts=tts, llm=llm, calls=tmp_path / "calls")


async def opening(c, said: int, timeout: float = 5.0):
    """Run a call until the bot has said `said` things, then hang up. Returns the worker."""
    worker = main.build_worker(Transport(), call_id="notice")
    running = asyncio.create_task(WorkerRunner(handle_sigint=False).run(worker))
    end = time.monotonic() + timeout
    while len(c.tts.said) < said and time.monotonic() < end:
        await asyncio.sleep(0.02)
    await asyncio.sleep(0.15)  # anything said after that would show up too
    await worker.cancel()
    await asyncio.wait_for(running, timeout)
    return worker


def events(c) -> list[dict]:
    path = c.calls / "notice.jsonl"
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]


def mute_strategies(worker) -> list:
    def leaves(processors):
        for p in processors:
            yield from leaves(p.processors) if p.processors else [p]

    user = next(p for p in leaves(worker._pipeline.processors) if isinstance(p, LLMUserAggregator))
    return user._params.user_mute_strategies


async def test_a_recorded_call_opens_with_the_notice_then_the_greeting(call):
    worker = await opening(call, said=2)
    assert call.tts.said == [DEFAULT_NOTICE, GREETING]

    # The greeting is asked for once the notice has played, and the model is told
    # it was said; the notice itself is not in its context as a line to continue.
    [request] = call.llm.requests
    assert request[-1]["role"] == "user" and f'"{DEFAULT_NOTICE}"' in request[-1]["content"]
    assert not any(m["role"] == "assistant" for m in request)
    played = [e for e in events(call) if e["event"] == "recording_notice_played"]
    assert played and played[0]["notice"] == DEFAULT_NOTICE
    assert not worker.health.failed


async def test_the_caller_cannot_cut_the_notice_short(call):
    worker = await opening(call, said=2)
    strategies = mute_strategies(worker)
    assert any(isinstance(s, MuteUntilFirstBotCompleteUserMuteStrategy) for s in strategies)


async def test_an_unrecorded_call_has_no_notice_and_no_mute(call, monkeypatch):
    monkeypatch.setenv("RECORDING_ENABLED", "false")
    worker = await opening(call, said=1)
    assert call.tts.said == [GREETING]
    assert call.llm.requests[0][-1]["content"] == "Start by concisely introducing yourself."
    assert mute_strategies(worker) == []


async def test_the_notice_can_be_turned_off_while_recording(call, monkeypatch):
    monkeypatch.setenv("RECORDING_NOTICE_ENABLED", "false")
    await opening(call, said=1)
    assert call.tts.said == [GREETING]


async def test_the_notice_wording_can_be_changed(call, monkeypatch):
    monkeypatch.setenv("RECORDING_NOTICE", "Yeh call record ho sakti hai.")
    await opening(call, said=2)
    assert call.tts.said == ["Yeh call record ho sakti hai.", GREETING]
    assert "Yeh call record ho sakti hai." in call.llm.requests[0][-1]["content"]

"""A hung LLM request, through the real pipeline that build_worker wires up.

Seen live on 2026-10-02: Groq sent nothing for 11s. The filler, the apology and
the end of the call were all queued behind the stuck request, so the caller heard
nothing and the call never ended. Here the providers at the edges are stand-ins
(STT passes frames through; TTS notes what it is asked to say and "plays" it as
bot speech) and the LLM is the real service with its request hung.
"""

import asyncio
import time

import main
import pytest
from pipecat.workers.runner import WorkerRunner
from pipeline_fakes import PassThrough, SpeakingTTS, Transport
from recording import DEFAULT_NOTICE
from resilience import DEFAULT_APOLOGY, DEFAULT_FILLER


@pytest.fixture
def hung_call(monkeypatch, tmp_path):
    for name, value in {
        "DEEPGRAM_API_KEY": "k",
        "GROQ_API_KEY": "k",
        "GROQ_MODEL_ID": "qwen/qwen3.8-27b",
        "CALL_LOG_DIR": str(tmp_path / "calls"),
        "LATENCY_LOG_PATH": str(tmp_path / "turns.jsonl"),
        "RECORDING_ENABLED": "false",
        "RECORDING_DIR": str(tmp_path / "recordings"),
        "SUMMARY_ENABLED": "false",
        "FILLER_AFTER_SECS": "0.2",
        "RESPONSE_DEADLINE_SECS": "0.6",
    }.items():
        monkeypatch.setenv(name, value)
    for name in (
        "FILLER_MESSAGE",
        "FAILURE_MESSAGE",
        "TTS_FALLBACK_PROVIDER",
        "RECORDING_NOTICE",
        "RECORDING_NOTICE_ENABLED",
    ):
        monkeypatch.delenv(name, raising=False)

    async def hang(self, context):
        await asyncio.Event().wait()  # the request that never answers

    tts = SpeakingTTS()
    monkeypatch.setattr(main.PortableGroqLLMService, "get_chat_completions", hang)
    monkeypatch.setattr(main, "DeepgramSTTService", PassThrough)
    monkeypatch.setattr(main, "build_tts_stack", lambda: (tts, [tts], None))
    return tts


async def test_a_hung_llm_gets_the_filler_then_the_apology_then_the_call_ends(hung_call):
    tts = hung_call
    aborts = []

    async def on_abort(spoken):
        aborts.append(spoken)
        await worker.cancel(reason="provider failure")  # what the phone server does

    worker = main.build_worker(Transport(), call_id="hung", on_abort=on_abort)
    started = time.monotonic()
    await asyncio.wait_for(WorkerRunner(handle_sigint=False).run(worker), timeout=8)

    # Filler at 0.2s and again after the first miss; two misses (0.6s, 1.2s) fail
    # the call; the apology plays; the call ends because it was heard, long before
    # the 10s backstop would have cut it off unspoken.
    assert tts.said == [DEFAULT_FILLER, DEFAULT_FILLER, DEFAULT_APOLOGY]
    assert aborts == [True]
    assert time.monotonic() - started < 5
    assert worker.health.failed.startswith("response:")


async def test_a_hung_greeting_after_the_recording_notice_is_still_caught(hung_call, monkeypatch):
    """The notice is bot speech too: it must not stand in for the greeting it precedes."""
    monkeypatch.setenv("RECORDING_ENABLED", "true")
    tts = hung_call
    aborts = []

    async def on_abort(spoken):
        aborts.append(spoken)
        await worker.cancel(reason="provider failure")

    worker = main.build_worker(Transport(), call_id="hung-notice", on_abort=on_abort)
    await asyncio.wait_for(WorkerRunner(handle_sigint=False).run(worker), timeout=8)
    assert tts.said == [DEFAULT_NOTICE, DEFAULT_FILLER, DEFAULT_FILLER, DEFAULT_APOLOGY]
    assert aborts == [True]

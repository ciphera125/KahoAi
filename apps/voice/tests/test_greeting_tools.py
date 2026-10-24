"""No tools on the greeting request.

Measured against live gpt-oss-20b (2026-10-24): 6 of 12 greeting requests called
capture_lead instead of greeting, half of those with phone: null, which Groq
rejected outright and the caller heard silence. tool_choice "none" does not help:
the model still emits a tool call and Groq rejects the request ("Tool choice is
none, but model called a tool", 4 of 10). With no tools sent, 15 of 15 greeted.
So the greeting request carries no tools, and they come back afterwards.
"""

import asyncio
import time

import main
import pytest
from pipecat.frames.frames import LLMContextFrame
from pipecat.processors.aggregators.llm_context import NOT_GIVEN
from pipecat.workers.runner import WorkerRunner
from pipeline_fakes import GreetingLLM, PassThrough, SpeakingTTS, Transport


class ToolChoiceLLM(GreetingLLM):
    """Records the tools each request was made with."""

    def __init__(self):
        super().__init__()
        self.tools_sent = []
        self.context = None

    async def process_frame(self, frame, direction):
        if isinstance(frame, LLMContextFrame):
            self.context = frame.context
            self.tools_sent.append(frame.context.tools)
        await super().process_frame(frame, direction)


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
    for name in ("RECORDING_NOTICE", "RECORDING_NOTICE_ENABLED", "TTS_FALLBACK_PROVIDER",
                 "TOOLS_ENABLED"):
        monkeypatch.delenv(name, raising=False)
    tts, llm = SpeakingTTS(), ToolChoiceLLM()
    monkeypatch.setattr(main, "DeepgramSTTService", PassThrough)
    monkeypatch.setattr(main, "build_tts_stack", lambda: (tts, [tts], None))
    monkeypatch.setattr(main, "build_llm", lambda *a, **k: llm)
    return tts, llm


async def run_opening(tts, said=2, timeout=5.0):
    worker = main.build_worker(Transport(), call_id="greet-tools")
    running = asyncio.create_task(WorkerRunner(handle_sigint=False).run(worker))
    end = time.monotonic() + timeout
    while len(tts.said) < said and time.monotonic() < end:
        await asyncio.sleep(0.02)
    await asyncio.sleep(0.2)
    await worker.cancel()
    await asyncio.wait_for(running, timeout)


async def test_the_greeting_is_asked_for_without_tools(call):
    tts, llm = call
    await run_opening(tts)
    assert llm.tools_sent[:1] == [NOT_GIVEN]


async def test_tools_come_back_once_the_greeting_is_done(call):
    tts, llm = call
    await run_opening(tts)
    names = [t.name for t in llm.context.tools.standard_tools]
    assert names == ["end_call", "capture_lead"]


async def test_the_transcript_names_the_other_party(call, tmp_path):
    import json

    tts, llm = call
    worker = main.build_worker(Transport(), call_id="party-1", caller_number="+919876543210")
    running = asyncio.create_task(WorkerRunner(handle_sigint=False).run(worker))
    await asyncio.sleep(0.3)
    await worker.cancel()
    await asyncio.wait_for(running, 5)
    rows = [json.loads(x) for x in (tmp_path / "calls" / "party-1.jsonl").read_text().splitlines()]
    assert {"event": "call_party", "number": "+919876543210"}.items() <= next(
        r for r in rows if r["event"] == "call_party").items()


# --- an agent from the Studio picks its own tools and opening line ------------------


async def run_agent_opening(tts, **kwargs):
    worker = main.build_worker(Transport(), call_id="agent-open", **kwargs)
    running = asyncio.create_task(WorkerRunner(handle_sigint=False).run(worker))
    end = time.monotonic() + 5
    while len(tts.said) < 1 and time.monotonic() < end:
        await asyncio.sleep(0.02)
    await asyncio.sleep(0.2)
    await worker.cancel()
    await asyncio.wait_for(running, 5)


async def test_an_agents_tools_replace_tools_enabled(call):
    tts, llm = call
    await run_agent_opening(tts, tool_names=["end_call"])
    assert [t.name for t in llm.context.tools.standard_tools] == ["end_call"]


async def test_an_agent_with_no_tools_gets_none(call):
    tts, llm = call
    await run_agent_opening(tts, tool_names=[])
    assert llm.context.tools is NOT_GIVEN


async def test_an_opening_line_is_what_the_greeting_asks_for(call):
    tts, llm = call
    await run_agent_opening(tts, opening_line="Namaste, Riya here from Acme.")
    first = llm.requests[0][-1]["content"]
    assert "Namaste, Riya here from Acme." in first

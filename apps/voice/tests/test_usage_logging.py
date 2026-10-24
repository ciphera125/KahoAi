"""What each call spends: LLM tokens and TTS characters, logged and summed.

Pipecat reports both as usage metrics; the timing log used to drop the LLM's,
because its value is an object rather than a number.
"""

import importlib.util
import json
from pathlib import Path

import main
import pytest
from pipecat.frames.frames import MetricsFrame
from pipecat.metrics.metrics import LLMTokenUsage, LLMUsageMetricsData, TTSUsageMetricsData
from pipecat.observers.base_observer import FramePushed
from pipecat.processors.frame_processor import FrameDirection

SCRIPT = Path(__file__).resolve().parents[3] / "scripts" / "latency_summary.py"
spec = importlib.util.spec_from_file_location("kaho_latency_summary", SCRIPT)
summary = importlib.util.module_from_spec(spec)
spec.loader.exec_module(summary)


@pytest.fixture
def logger(tmp_path):
    return main.TurnTimingLogger(tmp_path / "turns.jsonl")


async def push(logger, *data):
    frame = MetricsFrame(data=list(data))
    await logger.on_push_frame(
        FramePushed(source=None, destination=None, frame=frame,
                    direction=FrameDirection.DOWNSTREAM, timestamp=0)
    )


def rows(logger, metric):
    lines = logger._path.read_text(encoding="utf-8").splitlines()
    return [r for r in map(json.loads, lines) if r["metric"] == metric]


async def test_llm_tokens_are_logged(logger):
    await push(logger, LLMUsageMetricsData(
        processor="PortableGroqLLMService#0", model="openai/gpt-oss-20b",
        value=LLMTokenUsage(prompt_tokens=1500, completion_tokens=40, total_tokens=1540),
    ))
    [row] = rows(logger, "llmusage")
    assert row["model"] == "openai/gpt-oss-20b"
    assert (row["prompt_tokens"], row["completion_tokens"], row["total_tokens"]) == (1500, 40, 1540)


async def test_tts_characters_are_logged_as_characters(logger):
    await push(logger, TTSUsageMetricsData(
        processor="GoogleChirpTTSService#0", model="hi-IN-Chirp3-HD-Leda", value=42))
    [row] = rows(logger, "ttsusage")
    assert row["characters"] == 42


def test_the_summary_totals_usage_per_call():
    records = [
        {"run": "a", "metric": "llmusage", "model": "openai/gpt-oss-20b",
         "prompt_tokens": 1000, "completion_tokens": 30, "total_tokens": 1030},
        {"run": "a", "metric": "llmusage", "model": "openai/gpt-oss-20b",
         "prompt_tokens": 1200, "completion_tokens": 50, "total_tokens": 1250},
        {"run": "a", "metric": "ttsusage", "processor": "GoogleChirpTTSService#0",
         "characters": 60},
        {"run": "b", "metric": "ttsusage", "processor": "GoogleChirpTTSService#0",
         "characters": 40},
        # Older lines carried the count only in "seconds".
        {"run": "b", "metric": "ttsusage", "processor": "CartesiaTTSService#0", "seconds": 25},
    ]
    totals = summary.usage(records)
    assert totals["llm"]["openai/gpt-oss-20b"] == {
        "requests": 2, "prompt_tokens": 2200, "completion_tokens": 80}
    assert totals["tts"] == {"GoogleChirpTTSService": 100, "CartesiaTTSService": 25}
    assert totals["calls"] == 2

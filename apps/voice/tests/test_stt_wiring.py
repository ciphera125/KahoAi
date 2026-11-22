"""The real pipeline carries the agent's words, the labels and the number check (2026-11-22)."""

import json

import number_confidence
import pytest
from main import DeepgramSTTService, NormalizeTranscripts, build_worker
from pipecat.processors.frame_processor import FrameProcessor

ORG = "org_8f2a91c4d0e7"


class FakeTransport:
    def __init__(self):
        self.out = FrameProcessor(name="transport-output")

    def input(self):
        return FrameProcessor(name="transport-input")

    def output(self):
        return self.out


@pytest.fixture
def worker_env(monkeypatch, tmp_path):
    for name in ("DEEPGRAM_API_KEY", "GROQ_API_KEY"):
        monkeypatch.setenv(name, "k")
    monkeypatch.setenv("GROQ_MODEL_ID", "openai/gpt-oss-20b")
    monkeypatch.setenv("TTS_PROVIDER", "deepgram")
    monkeypatch.setenv("DEEPGRAM_VOICE_ID", "aura-2-thalia-en")
    monkeypatch.setenv("DEEPGRAM_MODEL", "nova-3")
    monkeypatch.setenv("DEEPGRAM_LANGUAGE", "multi")
    monkeypatch.setenv("DEEPGRAM_KEYTERMS", "Kaho")
    monkeypatch.delenv("DEEPGRAM_LANGUAGE_HINTS", raising=False)
    monkeypatch.delenv("STT_NUMBER_MIN_CONFIDENCE", raising=False)
    monkeypatch.delenv("TTS_FALLBACK_PROVIDER", raising=False)
    monkeypatch.setenv("CALL_LOG_DIR", str(tmp_path / "calls"))
    monkeypatch.setenv("RECORDING_DIR", str(tmp_path / "recordings"))
    monkeypatch.setenv("LATENCY_LOG_PATH", str(tmp_path / "turns.jsonl"))


def processors(worker) -> list:
    def flatten(items):
        for p in items:
            yield from flatten(p.processors) if p.processors else [p]

    return list(flatten(worker._pipeline.processors))


def test_the_agents_words_and_ids_reach_the_speech_recognition(worker_env):
    worker = build_worker(FakeTransport(), call_id="call-77", keyterms=["Dr. Mehta"], org_id=ORG,
                          agent_id="ag_6d26dca7bd61")
    stt = next(p for p in processors(worker) if isinstance(p, DeepgramSTTService))
    kw = stt._build_connect_kwargs()
    assert kw["keyterm"] == ["Dr. Mehta", "Kaho"]
    assert kw["tag"] == ORG
    assert kw["extra"] == ["call_id:call-77", "agent_id:ag_6d26dca7bd61"]


def test_the_number_check_sits_between_the_cleanup_and_the_model(worker_env):
    worker = build_worker(FakeTransport(), call_id="call-78")
    procs = processors(worker)
    names = [type(p).__name__ for p in procs]
    # After the speech recognition has its say and the cleanup has run, before anything reads it.
    assert names.index("DeepgramSTTService") < names.index("NormalizeTranscripts")
    assert names.index("NormalizeTranscripts") + 1 == names.index("FlagUnsureNumbers")
    assert names.index("FlagUnsureNumbers") < names.index("LLMUserAggregator")
    assert names.index("FlagUnsureNumbers") < names.index("PortableGroqLLMService")
    assert isinstance(procs[names.index("NormalizeTranscripts")], NormalizeTranscripts)


def test_the_number_check_can_be_switched_off(worker_env, monkeypatch):
    monkeypatch.setenv("STT_NUMBER_MIN_CONFIDENCE", "off")
    worker = build_worker(FakeTransport(), call_id="call-79")
    assert not any(isinstance(p, number_confidence.FlagUnsureNumbers) for p in processors(worker))


def test_a_doubted_number_is_recorded_without_the_digits(worker_env):
    worker = build_worker(FakeTransport(), call_id="call-80")
    flag = next(p for p in processors(worker) if isinstance(p, number_confidence.FlagUnsureNumbers))
    flag._on_unsure(0.412)
    worker.transcript.end()
    text = worker.transcript.path.read_text(encoding="utf-8")
    lines = [json.loads(line) for line in text.splitlines()]
    event = next(line for line in lines if line.get("event") == "number_unsure")
    assert event["confidence"] == 0.41
    # Only the score: nothing of what was said.
    assert set(event) <= {"event", "confidence", "at", "call_id"}

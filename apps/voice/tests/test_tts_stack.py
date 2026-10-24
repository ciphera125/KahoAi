import main
import pytest
from pipecat.pipeline.service_switcher import ServiceSwitcher, ServiceSwitcherStrategyFailover


@pytest.fixture
def keys(monkeypatch):
    for k in ("TTS_FALLBACK_PROVIDER", "TTS_PROVIDER"):
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setenv("DEEPGRAM_API_KEY", "k")
    monkeypatch.setenv("DEEPGRAM_VOICE_ID", "aura-2-thalia-en")
    monkeypatch.setenv("SMALLEST_API_KEY", "k")
    monkeypatch.setenv("SMALLEST_VOICE_ID", "meher")


def test_no_fallback_means_the_plain_service(keys):
    processor, services, switcher = main.build_tts_stack()
    assert switcher is None and services == [processor]


def test_a_fallback_wraps_both_in_a_failover_switcher(keys, monkeypatch):
    monkeypatch.setenv("TTS_PROVIDER", "smallest")
    monkeypatch.setenv("TTS_FALLBACK_PROVIDER", "deepgram")
    processor, services, switcher = main.build_tts_stack()
    assert isinstance(processor, ServiceSwitcher) and processor is switcher
    assert [type(s).__name__ for s in services] == ["SmallestTTSService", "DeepgramTTSService"]
    assert isinstance(switcher.strategy, ServiceSwitcherStrategyFailover)
    assert switcher.strategy.active_service is services[0]


def test_a_fallback_the_same_as_the_primary_is_refused(keys, monkeypatch):
    monkeypatch.setenv("TTS_FALLBACK_PROVIDER", "deepgram")
    with pytest.raises(SystemExit):
        main.build_tts_stack()


def test_a_fallback_missing_its_key_stops_startup_not_the_call(keys, monkeypatch):
    monkeypatch.delenv("SMALLEST_API_KEY")
    monkeypatch.setenv("TTS_FALLBACK_PROVIDER", "smallest")
    with pytest.raises(SystemExit):
        main.build_tts_stack()


def test_an_unknown_fallback_is_refused(keys, monkeypatch):
    monkeypatch.setenv("TTS_FALLBACK_PROVIDER", "nonesuch")
    with pytest.raises(SystemExit):
        main.build_tts_stack()


def test_google_has_been_removed_as_a_voice():
    # Owner's decision, 2026-10-24: Google TTS is out (robotic on calls; unrestricted key).
    assert "google" not in main.SUPPORTED_TTS_PROVIDERS
    assert "google" not in main.MULTILINGUAL_TTS_PROVIDERS
    import importlib.util

    assert importlib.util.find_spec("google_tts") is None


# --- end to end: a voice that refuses every request ---------------------------------


async def test_a_refusing_voice_is_replaced_and_the_caller_hears_the_reply(monkeypatch, tmp_path):
    import asyncio
    import json

    from pipecat.frames.frames import TTSSpeakFrame
    from pipecat.pipeline.service_switcher import (
        ServiceSwitcher,
        ServiceSwitcherStrategyFailover,
    )
    from pipecat.processors.frame_processor import FrameProcessor
    from pipecat.workers.runner import WorkerRunner
    from pipeline_fakes import GreetingLLM, PassThrough, SpeakingTTS, Transport

    class RefusingTTS(FrameProcessor):
        """Like a provider answering 402/quota: an error per request, no audio,
        and it still calls itself usable."""

        async def process_frame(self, frame, direction):
            await super().process_frame(frame, direction)
            if isinstance(frame, TTSSpeakFrame):
                await self.push_error("HTTP 402 payment required")
                return
            await self.push_frame(frame, direction)

    for name, value in {"DEEPGRAM_API_KEY": "k", "CALL_LOG_DIR": str(tmp_path / "calls"),
                        "LATENCY_LOG_PATH": str(tmp_path / "t.jsonl"),
                        "RECORDING_ENABLED": "false", "SUMMARY_ENABLED": "false",
                        "RECORDING_NOTICE_ENABLED": "false"}.items():
        monkeypatch.setenv(name, value)
    primary, backup = RefusingTTS(), SpeakingTTS()
    switcher = ServiceSwitcher(services=[primary, backup],
                               strategy_type=ServiceSwitcherStrategyFailover)
    monkeypatch.setattr(main, "DeepgramSTTService", PassThrough)
    monkeypatch.setattr(main, "build_tts_stack", lambda: (switcher, [primary, backup], switcher))
    monkeypatch.setattr(main, "build_llm", lambda *a, **k: GreetingLLM())
    worker = main.build_worker(Transport(), call_id="refusing-voice")
    running = asyncio.create_task(WorkerRunner(handle_sigint=False).run(worker))
    for _ in range(100):
        if backup.said:
            break
        await asyncio.sleep(0.05)
    await worker.cancel()
    await asyncio.wait_for(running, 5)
    assert backup.said[:1] == [GreetingLLM.GREETING]  # well before the 10s deadline
    events = [json.loads(x)["event"] for x in
              (tmp_path / "calls" / "refusing-voice.jsonl").read_text().splitlines()]
    assert "provider_failover" in events and "reply_retried" in events

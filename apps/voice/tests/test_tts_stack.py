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

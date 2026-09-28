import main
import pytest
from pipecat.services.smallest.tts import SmallestTTSService
from pipecat.transcriptions.language import Language


@pytest.fixture
def smallest_env(monkeypatch):
    for name in (
        "SMALLEST_MODEL_ID",
        "SMALLEST_LANGUAGE",
        "SMALLEST_SPEED",
        "SMALLEST_MAX_BUFFER_DELAY_MS",
    ):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("TTS_PROVIDER", "smallest")
    monkeypatch.setenv("SMALLEST_API_KEY", "test-key")
    monkeypatch.setenv("SMALLEST_VOICE_ID", "meher")


def test_builds_smallest_service_with_configured_voice(smallest_env, monkeypatch):
    monkeypatch.setenv("SMALLEST_LANGUAGE", "hi")
    tts = main.build_tts()
    assert isinstance(tts, SmallestTTSService)
    msg = tts._build_msg("नमस्ते")
    assert msg["voice_id"] == "meher"
    assert msg["language"] == Language.HI


def test_unset_options_fall_back_to_service_defaults(smallest_env):
    msg = main.build_tts()._build_msg("hello")
    assert msg["model"] == "lightning_v3.1_pro"
    assert msg["language"] == Language.EN
    assert "max_buffer_delay_ms" not in msg


def test_buffer_delay_is_forwarded_when_set(smallest_env, monkeypatch):
    monkeypatch.setenv("SMALLEST_MAX_BUFFER_DELAY_MS", "200")
    assert main.build_tts()._build_msg("hello")["max_buffer_delay_ms"] == 200


def test_missing_key_exits(smallest_env, monkeypatch):
    monkeypatch.delenv("SMALLEST_API_KEY")
    with pytest.raises(SystemExit):
        main.build_tts()


def test_bad_language_exits(smallest_env, monkeypatch):
    monkeypatch.setenv("SMALLEST_LANGUAGE", "not-a-language")
    with pytest.raises(SystemExit):
        main.build_tts()

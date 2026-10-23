import json

import main
import pytest
from pipecat.services.cartesia.tts import CartesiaTTSService

VOICE = "a81fccdc-5595-4dfc-ae76-4de6a515b8a2"


@pytest.fixture
def cartesia_env(monkeypatch):
    for name in ("CARTESIA_MODEL_ID", "CARTESIA_LANGUAGE", "CARTESIA_SPEED"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("TTS_PROVIDER", "cartesia")
    monkeypatch.setenv("CARTESIA_API_KEY", "test-key")
    monkeypatch.setenv("CARTESIA_VOICE_ID", VOICE)


def msg(tts) -> dict:
    return json.loads(tts._build_msg("नमस्ते"))


def test_builds_cartesia_service_with_configured_voice(cartesia_env, monkeypatch):
    monkeypatch.setenv("CARTESIA_LANGUAGE", "hi")
    tts = main.build_tts()
    assert isinstance(tts, CartesiaTTSService)
    m = msg(tts)
    assert m["voice"] == {"mode": "id", "id": VOICE}
    assert m["language"] == "hi"


def test_unset_options_fall_back_to_service_defaults(cartesia_env):
    m = msg(main.build_tts())
    assert m["model_id"] == "sonic-3.6"
    assert m["language"] == "en"
    assert "generation_config" not in m


def test_model_is_forwarded_when_set(cartesia_env, monkeypatch):
    monkeypatch.setenv("CARTESIA_MODEL_ID", "sonic-3")
    assert msg(main.build_tts())["model_id"] == "sonic-3"


def test_speed_goes_into_generation_config(cartesia_env, monkeypatch):
    monkeypatch.setenv("CARTESIA_SPEED", "1.1")
    assert msg(main.build_tts())["generation_config"] == {"speed": 1.1}


def test_missing_key_exits(cartesia_env, monkeypatch):
    monkeypatch.delenv("CARTESIA_API_KEY")
    with pytest.raises(SystemExit):
        main.build_tts()


def test_missing_voice_exits(cartesia_env, monkeypatch):
    monkeypatch.delenv("CARTESIA_VOICE_ID")
    with pytest.raises(SystemExit):
        main.build_tts()


def test_bad_language_exits(cartesia_env, monkeypatch):
    monkeypatch.setenv("CARTESIA_LANGUAGE", "not-a-language")
    with pytest.raises(SystemExit):
        main.build_tts()


@pytest.mark.parametrize("speed", ["0.5", "1.6", "fast"])
def test_speed_outside_cartesias_range_exits(cartesia_env, monkeypatch, speed):
    # Cartesia accepts 0.6 to 1.5; anything else would fail on the first sentence
    # of a live call instead of at startup.
    monkeypatch.setenv("CARTESIA_SPEED", speed)
    with pytest.raises(SystemExit):
        main.build_tts()


def test_the_voice_follows_the_callers_language(cartesia_env, monkeypatch):
    monkeypatch.delenv("TTS_FOLLOW_CALLER_LANGUAGE", raising=False)
    assert main.voice_follows_caller_language() is True
    monkeypatch.setenv("TTS_PROVIDER", "deepgram")
    assert main.voice_follows_caller_language() is False


def test_cartesia_can_back_up_another_provider(cartesia_env, monkeypatch):
    monkeypatch.setenv("TTS_PROVIDER", "deepgram")
    monkeypatch.setenv("DEEPGRAM_API_KEY", "k")
    monkeypatch.setenv("DEEPGRAM_VOICE_ID", "aura-2-thalia-en")
    monkeypatch.setenv("TTS_FALLBACK_PROVIDER", "cartesia")
    _, services, _ = main.build_tts_stack()
    assert [type(s).__name__ for s in services] == ["DeepgramTTSService", "CartesiaTTSService"]

import asyncio

import google_tts
import main
import pytest
from pipecat.transcriptions.language import Language


class FakeClient:
    """Stands in for TextToSpeechAsyncClient: records each streaming request."""

    def __init__(self, **kwargs):
        self.kwargs = kwargs
        self.configs = []

    async def streaming_synthesize(self, requests):
        async for request in requests:
            if request.streaming_config.voice.name:
                self.configs.append(request.streaming_config)

        async def responses():
            yield type("Response", (), {"audio_content": b"\x00\x00" * 160})()

        return responses()


@pytest.fixture
def google_env(monkeypatch):
    monkeypatch.setattr(google_tts.texttospeech_v1, "TextToSpeechAsyncClient", FakeClient)
    monkeypatch.delenv("GOOGLE_TTS_LANGUAGE", raising=False)
    monkeypatch.setenv("TTS_PROVIDER", "google")
    monkeypatch.setenv("GOOGLE_TTS_API_KEY", "AIza-test-key")
    monkeypatch.setenv("GOOGLE_TTS_VOICE", "Aoede")


def spoken_voice(tts, text="Hello"):
    """Run one sentence through run_tts and return the voice Google was asked for."""
    tts._sample_rate = 8000

    async def go():
        async for _ in tts.run_tts(text, "ctx"):
            pass

    asyncio.run(go())
    voice = tts._client.configs[-1].voice
    return voice.language_code, voice.name


def test_builds_chirp_service_with_an_indian_english_voice_by_default(google_env):
    tts = main.build_tts()
    assert isinstance(tts, google_tts.GoogleChirpTTSService)
    assert spoken_voice(tts) == ("en-IN", "en-IN-Chirp3-HD-Aoede")


def test_hindi_start_language_picks_the_hindi_voice(google_env, monkeypatch):
    monkeypatch.setenv("GOOGLE_TTS_LANGUAGE", "hi")
    assert spoken_voice(main.build_tts()) == ("hi-IN", "hi-IN-Chirp3-HD-Aoede")


def test_the_client_uses_the_api_key_not_a_service_account(google_env):
    kwargs = main.build_tts()._client.kwargs
    assert kwargs["client_options"].api_key == "AIza-test-key"
    assert kwargs.get("credentials") is None


@pytest.mark.parametrize(
    "caller_language, expected",
    [
        (Language.HI, ("hi-IN", "hi-IN-Chirp3-HD-Aoede")),
        # Pipecat maps plain English to en-US; an en-US request for an en-IN
        # voice is a 400 from Google, so it must land on en-IN.
        (Language.EN, ("en-IN", "en-IN-Chirp3-HD-Aoede")),
        (Language.EN_IN, ("en-IN", "en-IN-Chirp3-HD-Aoede")),
    ],
)
def test_voice_and_language_switch_together(google_env, caller_language, expected):
    tts = main.build_tts()
    asyncio.run(tts._update_settings(tts.Settings(language=caller_language)))
    assert spoken_voice(tts) == expected


def test_a_language_with_no_voice_keeps_the_current_one(google_env):
    # Deepgram has reported Bengali for a Hindi caller; there is no voice to
    # switch to, and a mismatched request would fail the sentence.
    tts = main.build_tts()
    asyncio.run(tts._update_settings(tts.Settings(language=Language.HI)))
    asyncio.run(tts._update_settings(tts.Settings(language=Language.BN)))
    assert spoken_voice(tts) == ("hi-IN", "hi-IN-Chirp3-HD-Aoede")


def test_missing_key_exits(google_env, monkeypatch):
    monkeypatch.delenv("GOOGLE_TTS_API_KEY")
    with pytest.raises(SystemExit):
        main.build_tts()


def test_missing_voice_exits(google_env, monkeypatch):
    monkeypatch.delenv("GOOGLE_TTS_VOICE")
    with pytest.raises(SystemExit):
        main.build_tts()


def test_an_unsupported_start_language_exits(google_env, monkeypatch):
    monkeypatch.setenv("GOOGLE_TTS_LANGUAGE", "fr")
    with pytest.raises(SystemExit):
        main.build_tts()


def test_the_voice_follows_the_callers_language(google_env, monkeypatch):
    monkeypatch.delenv("TTS_FOLLOW_CALLER_LANGUAGE", raising=False)
    assert main.voice_follows_caller_language() is True

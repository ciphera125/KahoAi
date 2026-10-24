import importlib.util
from pathlib import Path

import httpx
import pytest

SCRIPT = Path(__file__).resolve().parents[3] / "scripts" / "check_providers.py"
spec = importlib.util.spec_from_file_location("kaho_check_providers_google", SCRIPT)
check = importlib.util.module_from_spec(spec)
spec.loader.exec_module(check)

KEY = "AIza-test-secret"


@pytest.fixture
def google(monkeypatch):
    monkeypatch.delenv("GOOGLE_TTS_LANGUAGE", raising=False)
    monkeypatch.setenv("GOOGLE_TTS_API_KEY", KEY)
    monkeypatch.setenv("GOOGLE_TTS_VOICE", "Aoede")
    sent = {}

    def serve(status, body):
        def post(url, params=None, json=None, timeout=None):
            sent.update(url=url, params=params, json=json)
            return httpx.Response(status, json=body, request=httpx.Request("POST", url))

        monkeypatch.setattr(check.httpx, "post", post)
        return sent

    return serve


def test_google_is_a_tts_check():
    assert "google" in check.TTS_CHECKS


def test_missing_config_names_the_variables(monkeypatch):
    monkeypatch.delenv("GOOGLE_TTS_API_KEY", raising=False)
    monkeypatch.delenv("GOOGLE_TTS_VOICE", raising=False)
    ok, reason = check.check_google()
    assert not ok and "GOOGLE_TTS_API_KEY" in reason and "GOOGLE_TTS_VOICE" in reason


def test_audio_back_is_ok_and_the_voice_matches_its_locale(google):
    sent = google(200, {"audioContent": "AAAA"})
    assert check.check_google() == (True, "")
    assert sent["params"] == {"key": KEY}
    assert sent["json"]["voice"] == {"languageCode": "en-IN", "name": "en-IN-Chirp3-HD-Aoede"}


def test_hindi_checks_the_hindi_voice(google, monkeypatch):
    monkeypatch.setenv("GOOGLE_TTS_LANGUAGE", "hi")
    sent = google(200, {"audioContent": "AAAA"})
    check.check_google()
    assert sent["json"]["voice"]["name"] == "hi-IN-Chirp3-HD-Aoede"


def test_an_error_fails_with_googles_reason_and_never_the_key(google):
    google(400, {"error": {"message": f"API key not valid: {KEY}"}})
    ok, reason = check.check_google()
    assert not ok and "API key not valid" in reason and KEY not in reason


def test_no_audio_fails(google):
    google(200, {})
    ok, reason = check.check_google()
    assert not ok and "no audio" in reason

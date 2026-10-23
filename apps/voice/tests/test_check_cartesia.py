import importlib.util
import json
from pathlib import Path

import pytest
import websockets.sync.client

SCRIPT = Path(__file__).resolve().parents[3] / "scripts" / "check_providers.py"
spec = importlib.util.spec_from_file_location("kaho_check_providers", SCRIPT)
check = importlib.util.module_from_spec(spec)
spec.loader.exec_module(check)

KEY = "sk_car_test_secret"
VOICE = "a81fccdc-5595-4dfc-ae76-4de6a515b8a2"


class FakeSocket:
    def __init__(self, replies):
        self.replies = list(replies)
        self.sent = []

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def send(self, message):
        self.sent.append(json.loads(message))

    def recv(self, timeout=None):
        return json.dumps(self.replies.pop(0))


@pytest.fixture
def cartesia(monkeypatch):
    for name in ("CARTESIA_MODEL_ID", "CARTESIA_LANGUAGE"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("CARTESIA_API_KEY", KEY)
    monkeypatch.setenv("CARTESIA_VOICE_ID", VOICE)
    opened = {}

    def serve(replies):
        sock = FakeSocket(replies)

        def connect(url, additional_headers=None, open_timeout=None):
            opened.update(url=url, headers=additional_headers, sock=sock)
            return sock

        monkeypatch.setattr(websockets.sync.client, "connect", connect)
        return opened

    return serve


def test_cartesia_is_a_tts_check():
    assert "cartesia" in check.TTS_CHECKS


def test_missing_config_names_the_variables(monkeypatch):
    monkeypatch.delenv("CARTESIA_API_KEY", raising=False)
    monkeypatch.delenv("CARTESIA_VOICE_ID", raising=False)
    ok, reason = check.check_cartesia()
    assert not ok
    assert "CARTESIA_API_KEY" in reason and "CARTESIA_VOICE_ID" in reason


def test_audio_back_is_ok(cartesia):
    opened = cartesia([{"type": "chunk", "data": "AAAA"}])
    assert check.check_cartesia() == (True, "")
    assert opened["url"].startswith("wss://api.cartesia.ai/")
    assert opened["headers"]["X-API-Key"] == KEY
    sent = opened["sock"].sent[0]
    assert sent["voice"] == {"mode": "id", "id": VOICE}
    assert sent["language"] == "hi"


def test_timestamps_before_audio_are_skipped(cartesia):
    cartesia([{"type": "timestamps"}, {"type": "chunk", "data": "AAAA"}])
    assert check.check_cartesia() == (True, "")


def test_an_error_reply_fails_with_the_providers_reason(cartesia):
    cartesia([{"type": "error", "error": "voice not found"}])
    ok, reason = check.check_cartesia()
    assert not ok and "voice not found" in reason


def test_done_without_audio_fails(cartesia):
    cartesia([{"type": "done"}])
    ok, reason = check.check_cartesia()
    assert not ok and "no audio" in reason


def test_the_key_never_appears_in_the_reason(cartesia):
    cartesia([{"type": "error", "error": f"bad key {KEY}"}])
    ok, reason = check.check_cartesia()
    assert not ok and KEY not in reason

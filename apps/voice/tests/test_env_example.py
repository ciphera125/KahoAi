""".env.example is committed, so it must never hold a real key.

It once did (Deepgram, Groq and ElevenLabs keys sat in the working tree for
days, one commit away from GitHub). Every secret-like setting must be empty or
an obvious placeholder.
"""

import re
from pathlib import Path

EXAMPLE = Path(__file__).resolve().parents[3] / ".env.example"
SECRETISH = re.compile(r"(KEY|TOKEN|SECRET|PASSWORD|AUTH_ID)$")
PLACEHOLDER = re.compile(r"^(|<[^>]*>|your[-_].*|change[-_]?me|xxx+|\.\.\.)$", re.IGNORECASE)
LOOKS_LIVE = re.compile(r"(sk_[A-Za-z0-9_]{10,}|gsk_[A-Za-z0-9]{10,}|AIza[0-9A-Za-z_-]{20,}"
                        r"|MA[A-Z0-9]{18}|[0-9a-f]{32,})")


def settings():
    for line in EXAMPLE.read_text(encoding="utf-8").splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            name, value = line.split("=", 1)
            yield name.strip(), value.split(" #")[0].strip().strip('"')


def test_secret_settings_are_empty_or_placeholders():
    leaked = [n for n, v in settings() if SECRETISH.search(n) and not PLACEHOLDER.match(v)]
    assert leaked == []


def test_nothing_in_it_looks_like_a_live_credential():
    assert not LOOKS_LIVE.search(EXAMPLE.read_text(encoding="utf-8"))


def test_it_documents_the_settings_the_code_reads():
    names = {n for n, _ in settings()}
    for name in ("TTS_PROVIDER", "TTS_FALLBACK_PROVIDER", "WEBHOOK_SECRET",
                 "PLIVO_VERIFY_SIGNATURE", "ELEVENLABS_VOICE_ID"):
        assert name in names, name

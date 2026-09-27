"""Make one small real test call to each provider and report OK or the error.

Each check exercises the same credentials and model the agent itself uses, so a
green run here means the pipeline's config is actually valid — not just that the
key exists. The calls are deliberately tiny (0.3s of silence to transcribe, a
two-character phrase to synthesize), so the spend is negligible.

Never prints API key values — only whether each call succeeded, and the
provider's own error message if it didn't.
"""
import io
import os
import sys
import wave
from pathlib import Path

import httpx
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
TIMEOUT = 30


def env(name: str) -> str | None:
    """Read an env var, treating an empty string the same as unset."""
    return os.getenv(name) or None


def silent_wav(seconds: float = 0.3, sample_rate: int = 16000) -> bytes:
    """A mono PCM16 WAV of silence — just enough to exercise a transcription."""
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(b"\x00\x00" * int(sample_rate * seconds))
    return buf.getvalue()


def check_deepgram() -> tuple[bool, str]:
    """Transcribe a fragment of silence, using the configured model/language."""
    api_key = env("DEEPGRAM_API_KEY")
    if not api_key:
        return False, "DEEPGRAM_API_KEY is not set"
    params = {}
    if model := env("DEEPGRAM_MODEL"):
        params["model"] = model
    if language := env("DEEPGRAM_LANGUAGE"):
        params["language"] = language
    try:
        resp = httpx.post(
            "https://api.deepgram.com/v1/listen",
            params=params,
            headers={"Authorization": f"Token {api_key}", "Content-Type": "audio/wav"},
            content=silent_wav(),
            timeout=TIMEOUT,
        )
        resp.raise_for_status()
        return True, ""
    except httpx.HTTPStatusError as e:
        return False, f"HTTP {e.response.status_code}: {e.response.text.strip()[:200]}"
    except httpx.HTTPError as e:
        return False, f"{type(e).__name__}: {e}"


def check_deepgram_tts() -> tuple[bool, str]:
    """Synthesize a short phrase with the configured Aura voice."""
    api_key = env("DEEPGRAM_API_KEY")
    voice = env("DEEPGRAM_VOICE_ID")
    missing = [
        name
        for name, value in [("DEEPGRAM_API_KEY", api_key), ("DEEPGRAM_VOICE_ID", voice)]
        if not value
    ]
    if missing:
        return False, f"missing: {', '.join(missing)}"
    try:
        resp = httpx.post(
            "https://api.deepgram.com/v1/speak",
            params={"model": voice},
            headers={"Authorization": f"Token {api_key}", "Content-Type": "application/json"},
            json={"text": "Hi"},
            timeout=TIMEOUT,
        )
        resp.raise_for_status()
        if not resp.content:
            return False, "the request succeeded but returned no audio"
        return True, ""
    except httpx.HTTPStatusError as e:
        return False, f"HTTP {e.response.status_code}: {e.response.text.strip()[:200]}"
    except httpx.HTTPError as e:
        return False, f"{type(e).__name__}: {e}"


def check_sarvam() -> tuple[bool, str]:
    """Synthesize two characters through Sarvam's Bulbul TTS."""
    api_key = env("SARVAM_API_KEY")
    voice = env("SARVAM_VOICE_ID")
    missing = [
        name
        for name, value in [("SARVAM_API_KEY", api_key), ("SARVAM_VOICE_ID", voice)]
        if not value
    ]
    if missing:
        return False, f"missing: {', '.join(missing)}"
    payload = {
        "text": "Namaste",
        "speaker": voice,
        "target_language_code": env("SARVAM_LANGUAGE") or "hi-IN",
        "model": env("SARVAM_MODEL_ID") or "bulbul:v3",
    }
    try:
        resp = httpx.post(
            "https://api.sarvam.ai/text-to-speech",
            headers={"api-subscription-key": api_key},
            json=payload,
            timeout=TIMEOUT,
        )
        resp.raise_for_status()
        if not resp.json().get("audios"):
            return False, "the request succeeded but returned no audio"
        return True, ""
    except httpx.HTTPStatusError as e:
        return False, f"HTTP {e.response.status_code}: {e.response.text.strip()[:200]}"
    except (httpx.HTTPError, ValueError) as e:
        return False, f"{type(e).__name__}: {e}"


def check_elevenlabs() -> tuple[bool, str]:
    """Synthesize two characters of speech.

    A TTS-scoped key often can't read /v1/user, /v1/models or /v1/voices, so
    synthesis is the only call that reliably proves the key works.
    """
    api_key = env("ELEVENLABS_API_KEY")
    voice_id = env("ELEVENLABS_VOICE_ID")
    missing = [
        name
        for name, value in [("ELEVENLABS_API_KEY", api_key), ("ELEVENLABS_VOICE_ID", voice_id)]
        if not value
    ]
    if missing:
        return False, f"missing: {', '.join(missing)}"
    payload: dict[str, str] = {"text": "Hi"}
    if model := env("ELEVENLABS_MODEL_ID"):
        payload["model_id"] = model
    try:
        resp = httpx.post(
            f"https://api.elevenlabs.io/v1/text-to-speech/{voice_id}",
            headers={"xi-api-key": api_key},
            json=payload,
            timeout=TIMEOUT,
        )
        resp.raise_for_status()
        if not resp.content:
            return False, "the request succeeded but returned no audio"
        return True, ""
    except httpx.HTTPStatusError as e:
        hint = ""
        if e.response.status_code == 402:
            hint = (
                " — on the free plan, pick a voice from your own dashboard;"
                " Voice Library voices are paid-only over the API"
            )
        return False, f"HTTP {e.response.status_code}: {e.response.text.strip()[:200]}{hint}"
    except httpx.HTTPError as e:
        return False, f"{type(e).__name__}: {e}"


def check_groq() -> tuple[bool, str]:
    """One tiny chat completion (a few tokens) against Groq's OpenAI-compatible API."""
    api_key = env("GROQ_API_KEY")
    model_id = env("GROQ_MODEL_ID")
    missing = [
        name
        for name, value in [("GROQ_API_KEY", api_key), ("GROQ_MODEL_ID", model_id)]
        if not value
    ]
    if missing:
        return False, f"missing: {', '.join(missing)}"
    try:
        resp = httpx.post(
            "https://api.groq.com/openai/v1/chat/completions",
            headers={"Authorization": f"Bearer {api_key}"},
            json={
                "model": model_id,
                "messages": [{"role": "user", "content": "Hi"}],
                "max_tokens": 5,
            },
            timeout=TIMEOUT,
        )
        resp.raise_for_status()
        return True, ""
    except httpx.HTTPStatusError as e:
        return False, f"HTTP {e.response.status_code}: {e.response.text.strip()[:200]}"
    except httpx.HTTPError as e:
        return False, f"{type(e).__name__}: {e}"


def check_bedrock() -> tuple[bool, str]:
    """One tiny Converse call to Claude Haiku 4.5 on Bedrock (a few tokens)."""
    access_key = env("AWS_ACCESS_KEY_ID")
    secret_key = env("AWS_SECRET_ACCESS_KEY")
    region = env("AWS_REGION")
    model_id = env("BEDROCK_MODEL_ID")
    missing = [
        name
        for name, value in [
            ("AWS_ACCESS_KEY_ID", access_key),
            ("AWS_SECRET_ACCESS_KEY", secret_key),
            ("AWS_REGION", region),
            ("BEDROCK_MODEL_ID", model_id),
        ]
        if not value
    ]
    if missing:
        return False, f"missing: {', '.join(missing)}"
    try:
        import boto3
        from botocore.exceptions import BotoCoreError, ClientError

        client = boto3.client(
            "bedrock-runtime",
            region_name=region,
            aws_access_key_id=access_key,
            aws_secret_access_key=secret_key,
            aws_session_token=env("AWS_SESSION_TOKEN"),
        )
        client.converse(
            modelId=model_id,
            messages=[{"role": "user", "content": [{"text": "Hi"}]}],
            inferenceConfig={"maxTokens": 5},
        )
        return True, ""
    except (BotoCoreError, ClientError) as e:
        return False, f"{type(e).__name__}: {e}"


LLM_CHECKS = {
    "groq": ("Groq (LLM)", check_groq),
    "bedrock": ("AWS Bedrock (LLM)", check_bedrock),
}

TTS_CHECKS = {
    "deepgram": ("Deepgram Aura (TTS)", check_deepgram_tts),
    "elevenlabs": ("ElevenLabs (TTS)", check_elevenlabs),
    "sarvam": ("Sarvam Bulbul (TTS)", check_sarvam),
}


def pick(kind: str, var: str, default: str, table: dict) -> tuple[str, object] | None:
    """Resolve a provider env var to its check, or report the bad value."""
    name = (env(var) or default).strip().lower()
    if name not in table:
        print(f"{kind}: FAILED - unknown {var}={name!r} (expected: {', '.join(table)})")
        return None
    return table[name]


def main() -> int:
    load_dotenv(ROOT / ".env")
    llm_check = pick("LLM", "LLM_PROVIDER", "groq", LLM_CHECKS)
    tts_check = pick("TTS", "TTS_PROVIDER", "deepgram", TTS_CHECKS)
    if llm_check is None or tts_check is None:
        return 1
    checks = [
        ("Deepgram (STT)", check_deepgram),
        tts_check,
        llm_check,
    ]
    all_ok = True
    for label, check in checks:
        ok, error = check()
        if ok:
            print(f"{label}: OK")
        else:
            all_ok = False
            print(f"{label}: FAILED - {error}")
    return 0 if all_ok else 1


if __name__ == "__main__":
    sys.exit(main())

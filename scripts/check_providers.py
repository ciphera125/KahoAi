"""Make one lightweight test call to each provider and report OK or the error.

Never prints API key values — only whether each call succeeded, and the
provider's own error message if it didn't.
"""
import os
import sys
from pathlib import Path

import httpx
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
TIMEOUT = 10


def check_deepgram() -> tuple[bool, str]:
    """GET /v1/projects — the lightest authenticated call Deepgram offers."""
    api_key = os.getenv("DEEPGRAM_API_KEY")
    if not api_key:
        return False, "DEEPGRAM_API_KEY is not set"
    try:
        resp = httpx.get(
            "https://api.deepgram.com/v1/projects",
            headers={"Authorization": f"Token {api_key}"},
            timeout=TIMEOUT,
        )
        resp.raise_for_status()
        return True, ""
    except httpx.HTTPStatusError as e:
        return False, f"HTTP {e.response.status_code}: {e.response.text.strip()[:200]}"
    except httpx.HTTPError as e:
        return False, f"{type(e).__name__}: {e}"


def check_elevenlabs() -> tuple[bool, str]:
    """GET /v1/user — validates the key without generating any audio."""
    api_key = os.getenv("ELEVENLABS_API_KEY")
    if not api_key:
        return False, "ELEVENLABS_API_KEY is not set"
    try:
        resp = httpx.get(
            "https://api.elevenlabs.io/v1/user",
            headers={"xi-api-key": api_key},
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
    access_key = os.getenv("AWS_ACCESS_KEY_ID")
    secret_key = os.getenv("AWS_SECRET_ACCESS_KEY")
    region = os.getenv("AWS_REGION")
    model_id = os.getenv("BEDROCK_MODEL_ID")
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
            aws_session_token=os.getenv("AWS_SESSION_TOKEN") or None,
        )
        client.converse(
            modelId=model_id,
            messages=[{"role": "user", "content": [{"text": "Hi"}]}],
            inferenceConfig={"maxTokens": 5},
        )
        return True, ""
    except (BotoCoreError, ClientError) as e:
        return False, f"{type(e).__name__}: {e}"


CHECKS = [
    ("Deepgram (STT)", check_deepgram),
    ("ElevenLabs (TTS)", check_elevenlabs),
    ("AWS Bedrock (LLM)", check_bedrock),
]


def main() -> int:
    load_dotenv(ROOT / ".env")
    all_ok = True
    for label, check in CHECKS:
        ok, error = check()
        if ok:
            print(f"{label}: OK")
        else:
            all_ok = False
            print(f"{label}: FAILED - {error}")
    return 0 if all_ok else 1


if __name__ == "__main__":
    sys.exit(main())

"""Uploads a finished call recording to Supabase Storage.

Off the call path by construction: CallRecorder (recording.py) schedules this
as a background task only from close(), after the WAV is already fully
written and the transcript already has its `recording_saved` marker. Nothing
here can delay or break a call; every failure is logged and swallowed, and
the local WAV is never touched on failure, so retention (recording.py) is
still the backstop.

Uploaded exactly as the call left it -- unmasked, full audio -- by the
owner's explicit decision (2026-11-03): recordings are not put through
masking.py the way text is (see transcript.py for why text is). Opus encoding
here is a storage-cost optimisation, not a content change: on failure the
original WAV is uploaded unchanged.

Off unless SUPABASE_URL, SUPABASE_SECRET_KEY and SUPABASE_RECORDINGS_BUCKET
are all set; the local file is then the only copy, as before this module
existed.
"""

import asyncio
import datetime
import os
import re
import subprocess
from pathlib import Path

import httpx
from loguru import logger

DEFAULT_TIMEOUT_SECS = 30.0
MAX_RETRIES = 2
RETRY_DELAY_SECS = 0.5
FFMPEG_TIMEOUT_SECS = 60.0

# Tests swap in an httpx.MockTransport here.
_transport: httpx.AsyncBaseTransport | None = None


def configured() -> bool:
    return bool(_url() and _key() and _bucket())


def _url() -> str:
    return (os.getenv("SUPABASE_URL") or "").strip().rstrip("/")


def _key() -> str:
    return (os.getenv("SUPABASE_SECRET_KEY") or "").strip()


def _bucket() -> str:
    return (os.getenv("SUPABASE_RECORDINGS_BUCKET") or "").strip()


def _timeout() -> float:
    try:
        value = float(os.getenv("RECORDING_UPLOAD_TIMEOUT_SECS") or DEFAULT_TIMEOUT_SECS)
    except ValueError:
        return DEFAULT_TIMEOUT_SECS
    return value if value > 0 else DEFAULT_TIMEOUT_SECS


_UNSAFE_ID = re.compile(r"[^A-Za-z0-9_-]")


def object_name(call_id: str, when: datetime.datetime | None = None) -> str:
    """`<yyyy>/<mm>/<call_id>.wav` (UTC), the call's place in the bucket. The id comes
    from the network, so nothing but letters, digits, `_` and `-` survives; the
    extension is swapped for .opus by upload_recording when the audio is encoded."""
    when = when or datetime.datetime.now(datetime.timezone.utc)
    safe = _UNSAFE_ID.sub("_", call_id or "")[:100] or "unknown"
    return f"{when:%Y}/{when:%m}/{safe}.wav"


def _encode_opus(wav_path: Path) -> Path | None:
    """WAV -> Opus alongside the original, via ffmpeg. None if ffmpeg is missing
    or fails -- compression is an optimisation, never a reason to drop the
    recording, so the caller then uploads the WAV unchanged."""
    opus_path = wav_path.with_suffix(".opus")
    try:
        subprocess.run(
            ["ffmpeg", "-y", "-i", str(wav_path), "-c:a", "libopus", "-b:a", "24k", str(opus_path)],
            check=True, capture_output=True, timeout=FFMPEG_TIMEOUT_SECS,
        )
        return opus_path
    except (OSError, subprocess.CalledProcessError, subprocess.TimeoutExpired) as e:
        logger.warning(f"Could not encode {wav_path.name} to Opus; "
                        f"uploading the WAV instead: {e!r}")
        return None


async def upload_recording(path: Path, object_name: str, report=None) -> bool:
    """Never raises. Retries a transient failure (429/5xx/connection error) up
    to MAX_RETRIES times, each under its own deadline; a refusal (4xx other
    than 429) is not retried. Gives up silently (logged) rather than touching
    the call or the local file. After a successful upload, `report(path, bytes,
    mime)` is awaited with what was really stored; its failure is contained."""
    if not configured():
        return False

    upload_path, content_type = path, "audio/wav"
    encoded = await asyncio.to_thread(_encode_opus, path)
    if encoded is not None:
        upload_path, content_type = encoded, "audio/opus"
        object_name = str(Path(object_name).with_suffix(".opus"))

    try:
        data = await asyncio.to_thread(upload_path.read_bytes)
    except OSError as e:
        logger.error(f"Could not read {upload_path} for upload: {e!r}")
        return False

    url = f"{_url()}/storage/v1/object/{_bucket()}/{object_name}"
    headers = {
        "Authorization": f"Bearer {_key()}", "apikey": _key(),
        "Content-Type": content_type, "x-upsert": "true",
    }
    ok = await _send(url, headers, data, object_name)
    if ok and encoded is not None:
        try:
            encoded.unlink()
        except OSError:
            pass  # the upload already succeeded; a leftover temp file is harmless
    if ok and report is not None:
        try:
            await report(object_name, len(data), content_type)
        except Exception as e:  # noqa: BLE001 -- the recording is safe; telling the Studio is optional
            logger.warning(f"Could not report the recording {object_name}: {type(e).__name__}")
    return ok


async def _send(url: str, headers: dict, data: bytes, object_name: str) -> bool:
    for attempt in range(MAX_RETRIES + 1):
        try:
            async with httpx.AsyncClient(transport=_transport, timeout=_timeout()) as client:
                r = await client.post(url, headers=headers, content=data)
        except (httpx.HTTPError, TimeoutError) as e:
            if attempt == MAX_RETRIES:
                logger.warning(f"Could not upload recording {object_name} after retries: "
                                f"{type(e).__name__}")
                return False
            await asyncio.sleep(RETRY_DELAY_SECS * (attempt + 1))
            continue
        if r.status_code in (200, 201):
            logger.info(f"Recording uploaded: {object_name} ({len(data)} bytes)")
            return True
        if r.status_code == 429 or r.status_code >= 500:
            if attempt == MAX_RETRIES:
                logger.warning(f"Recording upload for {object_name} still failing after retries "
                                f"(HTTP {r.status_code})")
                return False
            await asyncio.sleep(RETRY_DELAY_SECS * (attempt + 1))
            continue
        logger.error(f"Recording upload refused for {object_name}: HTTP {r.status_code}")
        return False
    return False

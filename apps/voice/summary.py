"""Post-call summary: read the masked transcript, write <call_id>.summary.json.

It reads the transcript file, never the live conversation, so it can only ever
see text that already went through masking; the output is masked again anyway,
because a model can always restate something oddly. It runs once, after the
call has ended, so it costs the caller nothing in latency.

Failure policy: a summary is worth a few retries but never worth disturbing
call teardown. Rate limits (429), server errors and network timeouts are
retried with backoff, honouring the provider's Retry-After, inside one hard
overall deadline. Errors that will not clear (bad key, bad model) are not
retried. If it still fails, it is logged AND a `<call_id>.summary.failed.json`
marker is written beside the transcript, so a lost summary is visible on disk
rather than just absent. Nothing is raised.
"""

import asyncio
import json
import random
import re
import time
from datetime import UTC, datetime
from pathlib import Path

import httpx
from loguru import logger
from masking import mask_sensitive

GROQ_URL = "https://api.groq.com/openai/v1/chat/completions"

PROMPT = """\
You summarise phone calls between a caller and a voice assistant called Kaho.
You get the transcript. Reply with one JSON object and nothing else, with keys:
  "summary": two or three plain sentences on what the call was about and how it ended
  "caller_intent": one short phrase
  "outcome": "resolved", "unresolved" or "follow_up_needed"
  "follow_ups": a list of things a person still has to do, empty if none
  "languages": the languages the caller used
Only report what the transcript says; never guess. Numbers written as X are
deliberately hidden, so do not try to reconstruct them.
"""


def transcript_text(path: Path) -> tuple[str, int]:
    """The spoken turns as 'Caller:' / 'Kaho:' lines, and how many were the caller's."""
    lines, caller_turns = [], 0
    for raw in path.read_text(encoding="utf-8").splitlines():
        row = json.loads(raw)
        if row.get("event") == "tool":
            lines.append(f"Tool {row['name']}: {row['text']}")
            continue
        if row.get("event") != "turn":
            continue
        who = "Caller" if row["role"] == "user" else "Kaho"
        caller_turns += row["role"] == "user"
        lines.append(f"{who}: {row['text']}")
    return "\n".join(lines), caller_turns


def parse_summary(reply: str) -> dict:
    """Pull the JSON object out of a reply that may carry reasoning or fences."""
    reply = re.sub(r"<think>.*?</think>", "", reply, flags=re.DOTALL)
    start, end = reply.find("{"), reply.rfind("}")
    if start == -1 or end <= start:
        raise ValueError("no JSON object in the model's reply")
    return json.loads(reply[start : end + 1])


def _mask_values(value):
    if isinstance(value, str):
        return mask_sensitive(value)
    if isinstance(value, list):
        return [_mask_values(v) for v in value]
    if isinstance(value, dict):
        return {k: _mask_values(v) for k, v in value.items()}
    return value


# Statuses that can clear on their own. Everything else (401, 403, 404, other
# 4xx) will fail the same way every time, so retrying only delays the marker.
RETRYABLE_STATUS = frozenset({408, 429, 500, 502, 503, 504})

DEFAULT_ATTEMPTS = 4
DEFAULT_DEADLINE_SECS = 45.0
ATTEMPT_TIMEOUT_SECS = 20.0
MAX_BACKOFF_SECS = 10.0


class SummaryFailed(Exception):
    """The summary could not be produced. `reason` is safe to store: no content, no keys."""

    def __init__(self, reason: str, attempts: int):
        super().__init__(reason)
        self.reason = reason
        self.attempts = attempts


def retry_after_secs(response: httpx.Response) -> float | None:
    """Seconds the provider asked us to wait, if it said so as a plain number."""
    try:
        value = float(response.headers.get("retry-after", ""))
    except ValueError:
        return None
    return value if value >= 0 else None


async def _post(client: httpx.AsyncClient, api_key: str, model: str, transcript: str) -> str:
    resp = await client.post(
        GROQ_URL,
        headers={"Authorization": f"Bearer {api_key}"},
        json={
            "model": model,
            "temperature": 0,
            "messages": [
                {"role": "system", "content": PROMPT},
                {"role": "user", "content": transcript},
            ],
        },
    )
    resp.raise_for_status()
    return resp.json()["choices"][0]["message"]["content"]


async def chat(
    api_key: str,
    model: str,
    transcript: str,
    *,
    attempts: int = DEFAULT_ATTEMPTS,
    deadline_secs: float = DEFAULT_DEADLINE_SECS,
    sleep=asyncio.sleep,
    clock=time.monotonic,
) -> str:
    """One chat completion, retried on failures that can clear, within a deadline.

    Raises SummaryFailed when it gives up; the reason never includes the
    transcript or the key.
    """
    start = clock()
    reason = "no attempt made"
    async with httpx.AsyncClient(timeout=ATTEMPT_TIMEOUT_SECS) as client:
        for attempt in range(1, attempts + 1):
            wait: float | None = None
            try:
                return await _post(client, api_key, model, transcript)
            except httpx.HTTPStatusError as e:
                status = e.response.status_code
                reason = f"HTTP {status}"
                if status not in RETRYABLE_STATUS:
                    raise SummaryFailed(reason + " (not retryable)", attempt) from e
                wait = retry_after_secs(e.response)
            except httpx.TransportError as e:
                # Timeouts, resets, DNS: the provider may be back in a moment.
                reason = type(e).__name__
            except (KeyError, IndexError, ValueError) as e:
                # A 200 with a body we cannot read will not improve on retry.
                raise SummaryFailed(f"unreadable response ({type(e).__name__})", attempt) from e

            if attempt == attempts:
                break
            if wait is None:
                # Exponential with jitter, so concurrent calls do not retry in step.
                wait = min(MAX_BACKOFF_SECS, 2 ** (attempt - 1)) * random.uniform(0.75, 1.25)
            wait = min(wait, MAX_BACKOFF_SECS * 3)
            if clock() - start + wait >= deadline_secs:
                # Sleeping would run past the deadline, so waiting is pointless.
                raise SummaryFailed(f"{reason}; deadline of {deadline_secs:g}s reached", attempt)
            logger.warning(f"Summary attempt {attempt} failed ({reason}); retrying in {wait:.1f}s")
            await sleep(wait)
    raise SummaryFailed(f"{reason}; gave up after {attempts} attempts", attempts)


def write_failure_marker(path: Path, reason: str, attempts: int) -> Path:
    """Leave evidence beside the transcript that the summary was lost, and why."""
    marker = path.with_suffix(".summary.failed.json")
    marker.write_text(
        json.dumps(
            {
                "call_transcript": path.name,
                "reason": reason,
                "attempts": attempts,
                "at": datetime.now(UTC).isoformat(),
            },
            indent=2,
        ),
        encoding="utf-8",
    )
    return marker


async def summarise_call(
    path: Path,
    api_key: str,
    model: str,
    *,
    attempts: int = DEFAULT_ATTEMPTS,
    deadline_secs: float = DEFAULT_DEADLINE_SECS,
) -> Path | None:
    """Write the summary next to the transcript. Returns its path, or None.

    Never raises. On failure a marker file is written and the error is logged.
    """
    attempts_made = 0
    try:
        text, caller_turns = transcript_text(path)
        if not caller_turns:
            logger.info(f"No caller speech in {path.name}; skipping the summary.")
            return None
        reply = await chat(api_key, model, text, attempts=attempts, deadline_secs=deadline_secs)
        summary = _mask_values(parse_summary(reply))
        out = path.with_suffix(".summary.json")
        out.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
        logger.info(f"Call summary -> {out}")
        return out
    except SummaryFailed as e:
        reason, attempts_made = e.reason, e.attempts
    except ValueError as e:
        # The model answered but not with the JSON we asked for.
        reason = f"model reply was not usable JSON ({type(e).__name__})"
    except Exception as e:
        reason = f"unexpected {type(e).__name__}"
    logger.error(f"Could not summarise {path.name}: {reason}")
    try:
        write_failure_marker(path, reason, attempts_made)
    except OSError as e:
        logger.error(f"Could not even write the failure marker for {path.name}: {e}")
    return None

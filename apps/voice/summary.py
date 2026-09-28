"""Post-call summary: read the masked transcript, write <call_id>.summary.json.

It reads the transcript file, never the live conversation, so it can only ever
see text that already went through masking; the output is masked again anyway,
because a model can always restate something oddly. It runs once, after the
call has ended, so it costs the caller nothing in latency. A failure here is
logged and swallowed: losing a summary must never disturb call teardown.
"""

import json
import re
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


async def chat(api_key: str, model: str, transcript: str) -> str:
    async with httpx.AsyncClient(timeout=30) as client:
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


async def summarise_call(path: Path, api_key: str, model: str) -> Path | None:
    """Write the summary next to the transcript. Returns its path, or None."""
    try:
        text, caller_turns = transcript_text(path)
        if not caller_turns:
            logger.info(f"No caller speech in {path.name}; skipping the summary.")
            return None
        summary = _mask_values(parse_summary(await chat(api_key, model, text)))
        out = path.with_suffix(".summary.json")
        out.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
        logger.info(f"Call summary -> {out}")
        return out
    except Exception as e:
        logger.error(f"Could not summarise {path.name}: {e}")
        return None

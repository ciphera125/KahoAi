"""Measure the LLM and TTS legs of a turn, without needing anyone to speak.

Time to first audio is what a caller waits through after they stop talking:
the model has to produce a first sentence, then the voice has to produce a
first audio byte. This drives both with real API calls over scripted
conversations and writes the results to the same JSONL that the live agent
writes, so scripts/latency_summary.py reads either the same way.

What this does NOT cover is the microphone, the VAD hold, and streaming STT,
because those need a real person speaking. Numbers from here are a floor: add
VAD_STOP_SECS and the STT finalisation on top for what a caller experiences.

    python scripts/bench_llm_tts.py                       # current .env model
    python scripts/bench_llm_tts.py --model openai/gpt-oss-20b --label b
"""

import argparse
import json
import os
import sys
import time
from datetime import UTC, datetime
from pathlib import Path

import httpx
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "apps" / "voice"))

# Five short conversations of the kind a clinic line actually gets.
CONVERSATIONS = [
    ["What are your opening hours?", "And on Sunday?"],
    ["I want to book an appointment", "Tuesday afternoon if possible"],
    ["How much is a consultation?", "Do you take insurance?"],
    ["Where exactly are you located?", "Is there parking?"],
    ["the stick", "sorry, I meant do you have a paediatrician"],
]


def llm_turn(key: str, model: str, effort: str | None, messages: list[dict]) -> tuple[float, str]:
    """Returns time to the first streamed content token, and the full reply."""
    body = {"model": model, "messages": messages, "stream": True, "max_tokens": 150}
    if effort:
        body["reasoning_effort"] = effort
    start = time.perf_counter()
    first, chunks = None, []
    with httpx.stream(
        "POST",
        "https://api.groq.com/openai/v1/chat/completions",
        headers={"Authorization": f"Bearer {key}"},
        json=body,
        timeout=60,
    ) as r:
        if r.status_code != 200:
            r.read()
            raise RuntimeError(f"Groq HTTP {r.status_code}: {r.text[:120]}")
        for line in r.iter_lines():
            if not line.startswith("data: ") or line == "data: [DONE]":
                continue
            delta = json.loads(line[6:])["choices"][0].get("delta", {})
            if piece := delta.get("content"):
                if first is None:
                    first = time.perf_counter() - start
                chunks.append(piece)
    return (first if first is not None else -1.0), "".join(chunks)


def tts_first_audio(key: str, voice: str, text: str) -> float:
    """Time until Deepgram Aura returns its first audio byte.

    Uses the HTTP endpoint: the agent itself uses the websocket, which avoids
    per-request setup once warm, so treat this as the pessimistic figure.
    """
    start = time.perf_counter()
    with httpx.stream(
        "POST",
        "https://api.deepgram.com/v1/speak",
        params={"model": voice},
        headers={"Authorization": f"Token {key}", "Content-Type": "application/json"},
        json={"text": text},
        timeout=60,
    ) as r:
        if r.status_code != 200:
            r.read()
            raise RuntimeError(f"Deepgram HTTP {r.status_code}: {r.text[:120]}")
        for chunk in r.iter_bytes():
            if chunk:
                return time.perf_counter() - start
    return -1.0


def first_sentence(text: str) -> str:
    """TTS starts on the first complete sentence, so that is what we time."""
    for stop in (". ", "? ", "! "):
        if (i := text.find(stop)) != -1:
            return text[: i + 1]
    return text[:200] or "One moment."


def main() -> int:
    load_dotenv(ROOT / ".env")
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--model", default=os.getenv("GROQ_MODEL_ID"))
    ap.add_argument("--label", default="", help="tag for this run in the log")
    ap.add_argument("--path", type=Path, default=ROOT / "logs" / "turns.jsonl")
    args = ap.parse_args()

    groq_key, dg_key = os.getenv("GROQ_API_KEY"), os.getenv("DEEPGRAM_API_KEY")
    voice = os.getenv("DEEPGRAM_VOICE_ID") or "aura-2-thalia-en"
    effort = os.getenv("GROQ_REASONING_EFFORT") or None
    if not (groq_key and dg_key and args.model):
        sys.exit("Need GROQ_API_KEY, DEEPGRAM_API_KEY and a --model / GROQ_MODEL_ID.")

    import main as agent  # noqa: PLC0415 — needs sys.path set above

    system = agent.load_system_prompt()
    run_id = datetime.now(UTC).strftime("%Y%m%dT%H%M%S") + (f"-{args.label}" if args.label else "")
    args.path.parent.mkdir(parents=True, exist_ok=True)

    print(f"model: {args.model}   voice: {voice}   run: {run_id}")
    records = []
    for n, convo in enumerate(CONVERSATIONS, 1):
        messages = [{"role": "system", "content": system}]
        for turn in convo:
            messages.append({"role": "user", "content": turn})
            try:
                llm_s, reply = llm_turn(groq_key, args.model, effort, messages)
                tts_s = tts_first_audio(dg_key, voice, first_sentence(reply))
            except RuntimeError as e:
                print(f"  conversation {n}: {e}")
                break
            messages.append({"role": "assistant", "content": reply})
            print(f"  [{n}] llm {llm_s:5.3f}s  tts {tts_s:5.3f}s  {reply.strip()[:52]}")
            for metric, processor, seconds in (
                ("ttfb", "GroqLLMService#bench", llm_s),
                ("ttfa", "DeepgramTTSService#bench", tts_s),
            ):
                records.append(
                    {
                        "metric": metric,
                        "processor": processor,
                        "model": args.model if "Groq" in processor else voice,
                        "seconds": seconds,
                        "run": run_id,
                        "at": time.time(),
                    }
                )
            time.sleep(1.0)  # stay under the per-minute token limits

    with args.path.open("a", encoding="utf-8") as f:
        for r in records:
            f.write(json.dumps(r) + "\n")
    print(f"\nwrote {len(records)} measurements to {args.path}")
    print(f"summarise: python scripts/latency_summary.py --run {run_id}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

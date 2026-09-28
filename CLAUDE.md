# Kaho AI — working notes

A voice AI calling agent for the Indian market. Stage 1 is terminal-only: no web
app, no telephony. You run it, you talk into your mic, it talks back.

Built clean-room. Every non-obvious decision is logged in `CLEANROOM.md` with
the source or the measurement behind it — add a row when you make another one.

## Layout

```
apps/voice/main.py       the whole pipeline
apps/voice/prompts/      personas; AGENT_SYSTEM_PROMPT_PATH picks one
scripts/                 command-line helpers
logs/turns.jsonl         per-turn timings (gitignored)
```

## The pipeline

`mic -> Deepgram STT -> context aggregator -> Groq LLM -> TTS -> speaker`

Silero VAD decides when the caller's turn has ended. Providers are swappable by
env var: `LLM_PROVIDER` (groq; bedrock is stubbed but not wired), `TTS_PROVIDER`
(deepgram, elevenlabs, sarvam or smallest).

## Commands

```bash
python scripts/check_providers.py    # one real call per provider, fails loudly
python apps/voice/main.py            # run the agent
python scripts/latency_summary.py    # per-stage latency from logs/turns.jsonl
cd apps/voice && venv/bin/pytest -q
ruff check --config apps/voice/pyproject.toml .
```

## Conventions that matter

**Prompts are data, not code.** A persona file says who the agent is and what it
knows. `VOICE_RULES` in `main.py` says how to speak and is always prepended.
Keep them apart, and keep `VOICE_RULES` short — it is re-sent on every turn of
every call.

**Enforce in code what you can.** The prompt asks for speakable text; the text
filters guarantee it. When the model can get something wrong and the caller
would hear it, add a filter rather than another sentence of prompt.

**Never state a fact the persona was not given.** This has broken twice. Phrase
the rule as sourcing ("only say what you were given"), never as absence ("you
have no prices") — the absence phrasing makes personas refuse facts they do
have.

**Tune against measurements, not vibes.** Latency knobs are env vars precisely
so they can be changed per deployment. Change one, make real calls, compare
`latency_summary.py` before and after.

## Before going live with real calls

**Deploy to `ap-south-1` (Mumbai).** Nothing in the repo pins a region yet, and
this does not apply while we run locally, but it is required before real calls:
every turn crosses the network three times (STT, LLM, TTS), so hosting outside
India adds round-trip time to all three, on every turn. That cost is invisible
in local development and very visible on a call from Pune.

Note `AWS_REGION` in `.env` is for Bedrock, a separate thing from where the
voice service itself is hosted.

Also still open before real traffic: telephony (no provider chosen),
concurrency, call recording and consent, and a real answer on Hindi TTS —
Deepgram Aura is English-only, so Hindi output needs ElevenLabs, Sarvam or
Smallest; the Hindi voice is still being chosen between Sarvam and Smallest.

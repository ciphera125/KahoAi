# Kaho AI

A voice AI calling agent for the Indian market. Stage 1 is a terminal-only voice
agent: no website, no telephony. Run it, talk into your mic, it talks back.

**Stack:** Python · Pipecat · Silero VAD · Deepgram nova-3 (STT) · Groq (LLM) ·
Deepgram Aura or ElevenLabs (TTS)

## Layout

```
apps/voice/          Pipecat voice agent
apps/voice/prompts/  Agent personas — the prompt decides how the bot behaves
scripts/             Command-line helpers to run and test the agent
```

## Setup

```bash
python3 -m venv apps/voice/venv
source apps/voice/venv/bin/activate
pip install -r apps/voice/requirements-dev.txt
cp .env.example .env    # then fill in the keys
python scripts/check_providers.py
```

On macOS the local audio transport needs PortAudio: `brew install portaudio`.
The first run also triggers the microphone permission prompt, which can stall
startup once — grant it and run again.

## Run

```bash
python apps/voice/main.py
```

Point it at a different persona to change what the agent is:

```bash
AGENT_SYSTEM_PROMPT_PATH=prompts/example_clinic.md python apps/voice/main.py
```

## Tuning

Latency knobs live in `.env` (`VAD_STOP_SECS`, `TTS_TEXT_AGGREGATION`,
`GROQ_MODEL_ID`) so they can be tuned per deployment instead of guessed once.
The agent writes per-turn timings to `logs/turns.jsonl`:

```bash
python scripts/latency_summary.py --last 5
```

Change one knob, make a few real calls, and compare before and after.

## Test / lint

```bash
ruff check --config apps/voice/pyproject.toml .
cd apps/voice && venv/bin/pytest -q
```

## Before going live with real calls

**The voice service has to run in `ap-south-1` (Mumbai).** This does not apply
while we develop locally, and nothing in the repo pins a region yet, but every
turn crosses the network three times — STT, LLM, TTS — so hosting outside India
adds round-trip latency to all three on every turn. See `CLAUDE.md` for the
other open items.

See `CLEANROOM.md` for the sources and measurements behind non-obvious
decisions.

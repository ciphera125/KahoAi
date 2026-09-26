# Kaho AI

A voice AI calling agent for the Indian market. Stage 1 is a terminal-only voice agent (no website yet).

**Stack:** Python · Pipecat · Silero VAD · Deepgram (STT) · Claude Haiku 4.5 on AWS Bedrock (LLM) · ElevenLabs (TTS)

## Layout

```
apps/voice/   Pipecat voice agent
scripts/      Command-line helpers to run and test the agent
```

## Setup

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r apps/voice/requirements-dev.txt
cp .env.example .env    # then fill in the values
python scripts/check_env.py
```

## Run

```bash
./scripts/run_agent.sh   # placeholder until the pipeline is built
```

## Test / lint

```bash
ruff check .
pytest apps/voice
```

See `CLEANROOM.md` for the sources behind non-obvious decisions.

# Kaho AI — working notes

A voice AI calling agent for the Indian market. Stage 1 is terminal-only: no web
app, no telephony. You run it, you talk into your mic, it talks back.

Built clean-room. Every non-obvious decision is logged in `CLEANROOM.md` with
the source or the measurement behind it — add a row when you make another one.

## Session handoff

`HANDOFF.md` is the memory between sessions. **At the start of a session, read it
and check it against `git log` and `git status` before doing anything.** When
asked to end a session or "update the handoff", rewrite its state sections and
append to its session log. It also records the owner's working agreements, what
is confirmed by real tests versus only simulated, and what is open.

## Layout

```
apps/voice/main.py       the pipeline (build_worker) and the local mic/speaker entrypoint
apps/voice/server.py     phone entrypoint: Plivo calls (in and out) over a websocket
apps/voice/interruptions.py  which caller sounds may interrupt the agent (words, not noise or backchannel)
apps/voice/duration_limit.py  hard ceiling on any call's length, enforced beside the pipeline
apps/voice/personas.py   safe lookup of a persona by name (agent names can arrive from the network)
scripts/call.py          dial out through Plivo into the same pipeline (--number, --agent)
apps/voice/recording.py  call audio to recordings/<call_id>.wav (caller left, agent right)
apps/voice/resilience.py  what happens when a provider fails mid-call (backup TTS, apology, hang-up rules)
apps/voice/tools.py      tools the agent can call (decorator registry; TOOLS_ENABLED picks them):
                         end_call, capture_lead, transfer_to_human, call_webhook
scripts/talk.py          local mic/speaker run (same as apps/voice/main.py)
apps/voice/prompts/      personas; AGENT_SYSTEM_PROMPT_PATH picks one
scripts/                 command-line helpers
logs/turns.jsonl         per-turn timings (gitignored)
logs/calls/              per-call masked transcripts and summaries (gitignored)
leads/                   captured leads, one JSON-lines file per day (gitignored)
recordings/              call audio, NOT masked (gitignored)
```

## The pipeline

`mic -> Deepgram STT -> context aggregator -> Groq LLM -> TTS -> speaker`

The LLM is `qwen/qwen3.8-27b` (`GROQ_MODEL_ID`). On a 429, a 5xx or a connection
error from it, the same turn is retried once on `openai/gpt-oss-20b`
(`LLM_FALLBACK_MODEL_ID`, `off` disables) under its own deadline
(`LLM_FALLBACK_TIMEOUT_SECS`, default 3s), logged as `LLM fallback` and as an
`llm_fallback` line in the call transcript. Only after that fails does
`resilience.py` apologise. **This covers a qwen-specific failure only, not a full
Groq outage**: both models share one service, account and key. Known, accepted gap.

Barge-in is Pipecat's (a started caller turn broadcasts an interruption that cancels
the LLM and TTS); `interruptions.py` decides what starts one. While the agent speaks,
only words interrupt: the VAD alone (a cough) never does, and backchannel ("okay",
"hmm", "haan") is ignored. Tune with `INTERRUPT_MIN_WORDS`, `INTERRUPT_IGNORE_WORDS`;
`INTERRUPT_FILTER=false` restores Pipecat's default. Cost: an interruption waits for
STT words (a few hundred ms) instead of the first VAD frame.

Silero VAD decides when the caller's turn has ended. Providers are swappable by
env var: `LLM_PROVIDER` (groq; bedrock is stubbed but not wired), `TTS_PROVIDER`
(deepgram, elevenlabs, sarvam or smallest).

## Commands

```bash
python scripts/check_providers.py    # one real call per provider, fails loudly
python apps/voice/main.py            # run the agent on your mic and speakers
python apps/voice/server.py          # run it as a phone server for Plivo (see .env.example)
python scripts/call.py --number +91XXXXXXXXXX --agent sales   # dial out; the server must be up
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

**Anything stored goes through `masking.py`.** Aadhaar and PAN reach the agent
live, because it has to hear them, and never reach disk in full. `CallTranscript`
is the only writer for call content and masks inside `write`, so a new caller
cannot forget. Numbers arrive split across turns ("2 3 4" / "5 6 7"), so
digit-like turns are held and checked together; do not "simplify" that back to
per-turn masking. Any new store of call content must write through it too.
The one exception is call audio, which cannot be masked: `recording.py` keeps it
in `recordings/`, in full, by the owner's decision (2026-10-02). Anything derived
from a recording (a re-transcription, say) is call content and is masked again.

**Tools are one decorated function.** See `tools.py`. What a tool does is code;
when to use it goes in the persona, not `VOICE_RULES`. Don't call handlers around
the wrapper: it is what gives every tool a deadline, contained errors, and a
masked audit line in the transcript.

**Every external call has a deadline and a defined failure.** No silent
failures: a provider that dies must never leave the caller in silence.
`resilience.py` owns this for the call path (backup TTS, spoken apology, response
deadline); `summary.py` and `tools.py` show the pattern for calls off the path
(bounded retries inside a hard deadline, a marker on disk when it gives up,
errors contained instead of raised). A new external call needs the same three
things and a test that injects its failure. Stored or logged error text goes
through `safe_reason`, since provider errors can echo headers and keys.

**Every call has a hard maximum duration.** `MAX_CALL_DURATION_SECS` (default 600)
is enforced by `duration_limit.py` from a timer that runs beside the pipeline, so
a stuck pipeline cannot stop it; it hangs up via Plivo, cancels the pipeline, and
closes the stream, each step with its own timeout. A request (`call.py
--max-duration`) can only lower the ceiling. **Placing a call is never retried**:
after a timeout the outcome is unknown and a retry could ring someone twice.
Outbound calls need the person's consent (India's TRAI/DND rules); that is the
operator's responsibility, and `call.py` says so before it dials.

## Before going live with real calls

**Deploy to `ap-south-1` (Mumbai).** Nothing in the repo pins a region yet, and
this does not apply while we run locally, but it is required before real calls:
every turn crosses the network three times (STT, LLM, TTS), so hosting outside
India adds round-trip time to all three, on every turn. That cost is invisible
in local development and very visible on a call from Pune.

Note `AWS_REGION` in `.env` is for Bedrock, a separate thing from where the
voice service itself is hosted.

Also still open before real traffic: telephony is wired for Plivo inbound but has
not taken a real call yet (and no outbound), concurrency, and a real answer on Hindi TTS —
Deepgram Aura is English-only, so Hindi output needs ElevenLabs, Sarvam or
Smallest; the owner ruled Sarvam out (2026-10-02), so Hindi is to be Smallest,
which has not yet run against the live API. Calls are recorded without an
announcement, by the owner's decision; whether that meets India's notice and
Aadhaar-storage rules is the owner's call to settle before real traffic.

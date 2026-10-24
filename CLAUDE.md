# Kaho AI — working notes

A voice AI calling agent for the Indian market. No web app yet. It runs on your
mic and speakers, or takes and places real phone calls through Plivo.

Built clean-room. Every non-obvious decision is logged in `CLEANROOM.md` with
the source or the measurement behind it — add a row when you make another one.

## Session handoff

`HANDOFF.md` is the memory between sessions. **At the start of a session, read it
and check it against `git log` and `git status` before doing anything.** When
asked to end a session or "update the handoff", rewrite its state sections and
append to its session log. It also records the owner's working agreements, what
is confirmed by real tests versus only simulated, and what is open.

## How we build (owner's rules, 2026-10-24)

**Test first, always.** Every change starts with a failing unit test that states
the behaviour, then the code that makes it pass, then a refactor with the tests
still green. A bug fix starts with a test that reproduces the bug. No production
code without a test that failed first; show the red run before the green one.

**Then break it, as a pen tester.** After building something, and always before a
push, attack what was just built as a real security tester would: hostile input
over `/answer`, `/ws` and `/transfer`, forged or replayed webhooks, a leaked or
missing `WEBHOOK_SECRET`, prompt injection spoken by the caller (talking the model
into a tool call, a wrong fact, or leaking its prompt), PII reaching disk or logs
unmasked, secrets in tracked files or error text, path traversal through names
that arrive from the network, resource exhaustion (long calls, many connections,
token burn), and anything that fails open. Run the attacks for real where it is
safe to (locally, against the test server); say which were run and which were
only reasoned about.

**Report, do not fix.** List what broke in plain, simple bullet points: what the
attack was, what happened, how bad it is. Then a separate list of the scope for
improvement. Do not change code to fix findings; the owner decides what gets
fixed and asks for it. The goal is to learn, and to keep the system secure and
scalable.

## Layout

```
apps/voice/main.py       the pipeline (build_worker) and the local mic/speaker entrypoint
apps/voice/server.py     phone entrypoint: Plivo calls (in and out) over a websocket
apps/voice/interruptions.py  which caller sounds may interrupt the agent (words, not noise or backchannel)
apps/voice/duration_limit.py  hard ceiling on any call's length, enforced beside the pipeline
apps/voice/personas.py   safe lookup of a persona by name (agent names can arrive from the network)
apps/voice/admin.py      Kaho AI Studio (127.0.0.1:8001, this machine only, behind sign-in): Dashboard, Calls + live
                         transcript, Contacts, Agents, Prompts, Numbers; notifications and a tour
apps/voice/auth_store.py  Studio accounts: first is owner, others need its invite code; scrypt, hashed sessions;
                         only the owner changes numbers/credentials and deletes agents, prompts, contacts in bulk
apps/voice/agents_store.py  agents, their prompts (versions) and tools/settings; numbers route to agents
                         (data/agents.json); calls read call_config(), which never raises
apps/voice/call_outcomes.py  how each call ended (Plivo /hangup callback, Studio dials, Plivo sync)
apps/voice/analytics.py  every call joined from outcomes + transcripts, and the dashboard's numbers
apps/voice/activity.py   the Studio's notifications feed (data/activity.jsonl)
apps/voice/contacts_store.py  contacts, their numbers and tags (data/contacts.json, gitignored)
apps/voice/call_history.py  calls per contact (from transcripts' call_party line) and transcripts as CSV
scripts/backfill_call_index.py  one-off: the other party for pre-2026-10-24 calls, from Plivo's records
apps/voice/numbers_store.py  our numbers and provider credentials (data/numbers.json); secrets masked, only Plivo can call
apps/voice/prompt_store.py  the per-number prompt from before agents (migrated into agents.json); still a fallback
scripts/call.py          dial out through Plivo into the same pipeline (--number, --agent)
apps/voice/recording.py  call audio to recordings/<call_id>.recording.wav, and its deletion after RECORDING_RETENTION_DAYS
apps/voice/resilience.py  what happens when a provider fails mid-call (backup TTS, apology, hang-up rules)
apps/voice/tools.py      tools the agent can call (decorator registry; TOOLS_ENABLED picks them):
                         end_call, capture_lead, transfer_to_human, call_webhook
scripts/talk.py          local mic/speaker run (same as apps/voice/main.py)
apps/voice/prompts/      personas; AGENT_SYSTEM_PROMPT_PATH picks one
scripts/                 command-line helpers
logs/turns.jsonl         per-turn timings (gitignored)
logs/calls/              per-call masked transcripts and summaries (gitignored)
leads/                   captured leads, one JSON-lines file per day (gitignored)
recordings/              call audio, NOT masked, deleted after 60 days by default (gitignored)
```

## The pipeline

`mic -> Deepgram STT -> context aggregator -> Groq LLM -> TTS -> speaker`

The LLM is `openai/gpt-oss-20b` (`GROQ_MODEL_ID`, `GROQ_REASONING_EFFORT=medium`),
pinned as the primary: do not switch it without asking first. gpt-oss-120b was
tried on one real call (2026-10-24) and switched back the same day for speed; the
owner will say when to use it. **GPT-OSS models only; no qwen** (owner,
2026-10-24). `LLM_FALLBACK_MODEL_ID` is `off`; if it is ever set, it is the other
gpt-oss size: on a 429/5xx/connection error from the primary, the turn
retries once on it under its own deadline, `LLM_FALLBACK_TIMEOUT_SECS`,
logged as `LLM fallback` and as an `llm_fallback` line in the call transcript.
Only after that attempt fails, or with the fallback off, does `resilience.py`
apologise. Even with a fallback on, **this only ever covers a failure specific
to one model,
not a full Groq outage**: any two Groq models share one service, account and
key. Known, accepted gap.

Barge-in is Pipecat's (a started caller turn broadcasts an interruption that cancels
the LLM and TTS); `interruptions.py` decides what starts one. While the agent speaks,
only words interrupt: the VAD alone (a cough) never does, and backchannel ("okay",
"hmm", "haan") is ignored. Tune with `INTERRUPT_MIN_WORDS`, `INTERRUPT_IGNORE_WORDS`;
`INTERRUPT_FILTER=false` restores Pipecat's default. Cost: an interruption waits for
STT words (a few hundred ms) instead of the first VAD frame.

The Groq account is on the Developer plan (250K tokens/minute, read from the live
`x-ratelimit-limit-tokens` header on 2026-10-24). Check plan changes from those
headers, never from the billing page.

Silero VAD decides when the caller's turn has ended. Providers are swappable by
env var: `LLM_PROVIDER` (groq; bedrock is stubbed but not wired), `TTS_PROVIDER`
(deepgram, elevenlabs, sarvam, smallest or cartesia), `TTS_FALLBACK_PROVIDER`
(a backup voice if the first one dies mid-call).

The voice is **Smallest `suri`** (owner's pick by ear, 2026-10-24; `lakshmi` and `manmeet` were the
other two liked; `meher` before), starting in English (`SMALLEST_LANGUAGE=en`: the notice and greeting
are English, and starting in Hindi audibly switched 2s in on call ddedb4fd), backed up by **ElevenLabs** (`TTS_FALLBACK_PROVIDER=elevenlabs`,
built-in voice `EXAVITQu4vr4xnSDxMaL`, since the free plan refuses Voice Library voices over the
API). **Google TTS was removed and Cartesia is on hold** (owner, 2026-10-24): Cartesia's code
stays, unused. A voice that refuses a request (a 402, a spent quota) still calls itself usable,
so Pipecat's switcher never left it and the caller heard silence; `CallHealth` now moves to the
backup on the first voice error, never switches back to the one that failed, and asks again for
a reply the caller was still owed (`reply_retried` in the transcript). Sarvam is ruled out
(owner, 2026-10-02); Deepgram Aura is English-only.

Text between the model and the voice: `CapReplyLength` speaks at most `REPLY_MAX_SENTENCES`
(default 3) per reply; `RepeatedSentenceFilter` drops a sentence said twice in a row (sentence
aggregation only). Transcripts are cleaned before the model reads them (`NormalizeTranscripts`):
"Cairo AI" and similar become "Kaho AI", Bengali letters become Devanagari. The "one moment"
filler is Hindi after a Hindi turn (`FILLER_MESSAGE_HI`) and is cancelled if the caller resumes.

The brand is spoken as **"KahoAI"**, one word: `BrandNameFilter` rewrites every way the model
writes it, because the owner chose that spelling by ear (sample b_KahoAI_hi_sentence).

**Fast opening.** The phone server synthesises the recording notice once at startup
(`notice_audio.py`, bounded at `NOTICE_SYNTH_TIMEOUT_SECS`, silence trimmed) and sends it as
Plivo playAudio the moment a stream opens, before any provider has connected. Measured on a
real call (831f85db): pickup to notice on the line 340ms (was ~1.8s), to the greeting 2.2s
(was 5.6s). Deepgram now connects in the background, so the pipeline no longer waits ~1s for
it: pickup to greeting 1.30-1.49s on simulated calls (2026-10-25). The greeting is asked for
`GREETING_LEAD_SECS` (0.8) before the notice ends; the notice is written into the recording.
**The caller is muted through the notice and the whole greeting** (owner, 2026-10-25: the first
line is always completed; a nearby voice once cut it to "Hello,"). From then on every word is heard.

Webhooks: `/answer`, `/hangup` and `/transfer` need `WEBHOOK_SECRET` *and* Plivo's V3 signature
(`plivo_signature.py`, checked on a real call 2026-10-24); our own preflight signs its request
the same way. `/ws` needs a single-use token `/answer` issues (`STREAM_TOKEN_SECS`), and the
call's settings stay on the server, not in the stream URL. `PLIVO_VERIFY_SIGNATURE=false` is
for tests only.

Dependencies are pinned in `apps/voice/constraints.txt` (pipecat-ai 1.12.0, openai 3.19.2...):
unpinned, CI picked up pipecat 1.14 and went red. Bump a pin deliberately, with a real call.

## Commands

```bash
python scripts/check_providers.py    # one real call per provider, fails loudly
TTS_PROVIDER=cartesia python scripts/check_providers.py   # check another voice
python apps/voice/main.py            # run the agent on your mic and speakers
python apps/voice/server.py          # run it as a phone server for Plivo (see .env.example)
python apps/voice/admin.py           # Kaho AI Studio on http://127.0.0.1:8001 (this machine only)
python scripts/call.py --number +91XXXXXXXXXX --agent sales   # dial out; the server must be up
python scripts/latency_summary.py    # per-stage latency, LLM tokens and TTS characters from logs/turns.jsonl
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
Live captions (`CallTranscript.live`, written by `LiveCaptions` in `main.py` for the Studio's
live transcript) blank every digit, because a caption can be one fragment of a number; the
turn's own masked line replaces it. The one exception is call audio, which cannot be masked: `recording.py` keeps it
in `recordings/`, in full, by the owner's decision (2026-10-02), and deletes it
after `RECORDING_RETENTION_DAYS` (default 60). Anything derived from a recording
(a re-transcription, say) is call content and is masked again.

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
Frames queued on the worker wait behind whatever the LLM is doing, so speech
that must be heard while the LLM may be stuck is pushed from the LLM's place in
the pipeline, and failure handling ends a call by cancelling it, never with an
EndFrame (one stuck behind a hung request blocks every later cancel). See
`main.py` and `resilience.py`; `tests/test_hung_llm.py` holds the line.

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

Also still open before real traffic: Plivo has taken real calls in and out
(first on 2026-10-15), but never two at once, so concurrency is unproven; and no
call has yet been held in Hindi end to end, though the Hindi voices themselves
work against the live APIs. Every recorded call opens with
"This call may be recorded." (`RECORDING_NOTICE`), which the caller cannot talk
over; the deeper DPDP / Aadhaar Data Vault question is with the owner's CA.

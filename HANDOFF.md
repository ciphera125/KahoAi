# Kaho AI: session handoff

**Purpose.** This file is the memory between sessions. A new session starts with
no context, so it reads this first. Nothing here is a substitute for the code:
verify a specific claim against the repo before relying on it, especially the
"unverified" items.

**How to use it**
- End of a session: tell Claude *"update HANDOFF.md"*. It rewrites the state
  sections (1, 3, 4, 5, 6) to match reality and appends to the session log (9).
- Start of a session: tell Claude *"review HANDOFF.md"*. It reads this, checks
  `git log` and `git status` against section 2, and reports what is done, what is
  open, and what it would do next, before touching anything.

Last updated: 2026-10-01. Everything through `2c7418c` (transfer/webhook tools, filler,
warm-up) is pushed, and CI is green on `af8e967` (#23), `6819dc2` (#24) and `2c7418c`
(#25). This file's own update is the commit after `2c7418c`. No real phone
call, inbound or outbound, has happened yet: that is the next milestone.

---

## 0. Working agreements with the owner (Aditya)

- **Act as senior tech lead; production accuracy, not a rough first pass.**
  Explicit timeout and defined fallback on every external call, no silent
  failures, and tests that prove the behaviour holds, not that it ran once.
- **Done means:** tests pass; latency benchmark recorded if it touches the call
  path; a PII test if it touches sensitive data; no prior-employer residue
  (every non-obvious decision logged in `CLEANROOM.md` with its source).
  *The owner refers to a "what done looks like" checklist and a "CLAUDE.md §4"
  requiring timeouts and fallbacks. Neither exists in this repo's `CLAUDE.md`
  (checked 2026-09-28). Ask for them and add them; until then the line above is
  the standard.* The owner also refers to a "build plan" (Day 4, Days 5-6); no
  such file is in the repo either.
- **Never re-verify or redo the CONFIRMED list in section 1.** It came from the
  owner's real test calls.
- **Commit and push only when asked.** Commit separately per concern, with a
  message that says what broke and why. Pushes have each been explicitly
  requested, with one exception: when the owner asked for CI to be confirmed green on a
  new commit, that needs a push (Actions only runs on one), so Claude pushed and said so
  in its report. Otherwise ask before pushing. Do not amend or rewrite pushed commits.
- **A finished task is verified on the real thing, not just by unit tests.** Where it
  can be done without a real phone, drive the real pipeline with real providers (bad
  keys to inject failures, a simulated Plivo client), and mutation-check a safety test
  by breaking the code and watching the test fail.
- **Report honestly.** Say what was verified and how, and what was not. Never
  claim a live behaviour that was only simulated. Say "I could not check X".
- **Do not move to new tasks while a gate is open.** The owner sets explicit
  gates ("CI green first"); respect the order.
- **Move fast** on well-specified work; ask only when the answer changes what
  gets built.

## 1. What the owner has confirmed from real tests (ground truth)

Do not redo these.

- Scaffold, CI file, `.env.example`, `CLEANROOM.md`, clean-room setup.
- `scripts/check_providers.py`: Deepgram STT, Deepgram Aura TTS, Groq LLM OK
  with real keys.
- Full pipeline mic, VAD, STT, LLM, TTS, speaker, live via `python apps/voice/main.py`.
- Per-turn latency logging and `scripts/latency_summary.py`, validated on real
  conversations.
- LLM `qwen/qwen3.8-27b` (0.26s avg vs 0.64s on gpt-oss-120b) via `GROQ_MODEL_ID`.
- `VOICE_RULES` trimmed about 51% with no quality regression.
- `VAD_STOP_SECS` configurable (0.25s default); barge-in confirmed on real speech.
- Sarvam Bulbul as a TTS option: Hindi works, 0.716s vs Aura 0.781s time to first
  audio, hi-IN and en-IN switching works live. The owner does **not** like
  Sarvam's default Hindi voice, hence Smallest AI below.
- `PortableGroqLLMService` (developer to user role rewrite) fixes the qwen crash on
  interruption; committed and pushed (`4c89535`).

## 2. Repository state

Branch `main`, remote `origin` = `github.com/ciphera125/KahoAi` (**private**; the
GitHub API returns 404 unauthenticated and `gh` is not installed). **Claude can read
Actions runs and logs through the owner's logged-in Chrome** (the Claude in Chrome
tools): open `https://github.com/ciphera125/KahoAi/actions`, screenshot the run list,
and open a run and then its job to read a failing step's log. Runs take about a minute;
close the tab afterwards. A local equivalent for pre-checking: `git archive HEAD` into
a temp dir and run the workflow's own steps in a `python:3.11` Docker container.

Commits this project, newest first:

| Commit | What |
|---|---|
| `daa7b20` | HANDOFF.md update (CI green on `2c7418c`) |
| `2c7418c` | Transfer-to-human and webhook tools, spoken filler for a slow reply, startup warm-up, region warning, `scripts/talk.py` |
| `6819dc2` | Interruption filter (`interruptions.py`): coughs and backchannel no longer interrupt the agent |
| `af8e967` | LLM fallback: a qwen 429/5xx retries the turn on `openai/gpt-oss-20b` before the apology |
| `9ee23d5` | HANDOFF.md update |
| `c43c24a` | `scripts/call.py`: dial out through Plivo into the same pipeline (+ docs, tests, `.env.example`) |
| `80fa24a` | Hard max call duration (`duration_limit.py`); outbound params on `/answer` and `/ws`; `personas.py`; `sales` persona |
| `481621e` | HANDOFF.md update |
| `1064e67` | Provider failure no longer leaves the caller in silence (`resilience.py`, backup TTS, apology, response deadline) |
| `4961b56` | Summary retries on 429/5xx/timeouts within a deadline, marker file on failure |
| `644a256` | HANDOFF.md |
| `a4e68f4` | CI: install PortAudio so `pip install` can succeed |
| `0ead791` | `capture_lead` tool; persona updates; `/answer` reads `From` from the POST form body |
| `1fdbf3b` | Tool-calling framework (`tools.py`), `end_call`; aiohttp CA fix |
| `eb80de9` | Post-call summary (`summary.py`) |
| `0f4ff0a` | Masked call transcripts (`masking.py`, `transcript.py`) |
| `e8025e0` | Plivo inbound telephony (`server.py`), shared `build_worker()` |
| `8321073` | Smallest AI as a TTS provider |
| `4c89535` | Qwen interrupt-crash fix (pre-existing) |

Everything up to `daa7b20` is pushed; the working tree was clean (checked 2026-10-01).
CI is green on `a4e68f4`, `644a256`, `481621e` and `c43c24a` (runs #18 to #21), and on
`af8e967` (#23), `6819dc2` (#24) and `2c7418c` (#25); runs #15 to #17 and earlier-red
ones were the pyaudio failure. Check `git log origin/main..` at the start of
a session.

## 3. What exists (file map)

```
apps/voice/main.py       build_worker(transport) = the whole pipeline; local mic entrypoint
apps/voice/server.py     FastAPI: POST/GET /answer (Plivo XML), WS /ws (audio); token-gated
apps/voice/tools.py      decorator tool registry; end_call, capture_lead, transfer_to_human, call_webhook
apps/voice/interruptions.py  which caller sounds may interrupt (words only; backchannel ignored)
scripts/talk.py          local mic/speaker run, same as apps/voice/main.py
apps/voice/masking.py    Aadhaar/PAN masking (any 12 digits; AAAAA9999A)
apps/voice/transcript.py CallTranscript: only writer of call content; masks in write()
apps/voice/summary.py    post-call LLM summary of the MASKED transcript; retry + failure marker
apps/voice/duration_limit.py hard max call duration, enforced by a timer beside the pipeline
apps/voice/personas.py   safe persona lookup by name (names arrive from the network)
scripts/call.py          dial out via Plivo: --number, --agent, --max-duration, --dry-run
apps/voice/resilience.py CallHealth: what happens when STT/LLM/TTS fails mid-call; safe_reason
apps/voice/prompts/      default.md (with "Leaving details"), example_clinic.md, sales.md (generic outbound template)
apps/voice/tests/        254 tests
scripts/                 check_providers.py, latency_summary.py, bench_llm_tts.py, ...
logs/turns.jsonl         per-turn timings        (gitignored)
logs/calls/<id>.jsonl    masked transcript, <id>.summary.json   (gitignored)
leads/<date>.jsonl       captured leads          (gitignored; holds names/numbers)
CLEANROOM.md             decision log with sources; add a row for every non-obvious choice
```

Pipeline: `transport -> Deepgram STT -> [FollowCallerLanguage] -> user aggregator ->
Groq LLM -> TTS (optionally a failover pair) -> transport -> assistant aggregator`. `TTS_PROVIDER` is one of
deepgram, elevenlabs, sarvam, smallest. Tools are enabled by `TOOLS_ENABLED`
(default `end_call,capture_lead`).

## 4. Verified by Claude (simulated or offline, NOT real phone calls)

- 254 tests pass; ruff clean; on Python 3.13 and 3.11, clean installs, and in a
  Linux 3.11 container running the CI workflow's own steps (exit 0).
- The server, driven by a **simulated Plivo client** over `/ws` with
  Deepgram-synthesised 8kHz mu-law speech: greeting audio returns as `playAudio`;
  hangup tears the pipeline down; the transcript is written; the summary works
  against live `qwen/qwen3.8-27b`; `end_call` was called by the model and ended
  the call; `capture_lead` saved a lead in 2 of 4 live runs.
- A spoken Aadhaar arrives split across turns ("2 3 4", "5 6 7", ...). Per-turn
  masking leaked it in pieces; fixed by holding number-like fragments and masking
  them as one run. Verified live: no digit or PAN letter reached disk.

- **Provider failure, live, with deliberately bad keys through the phone path**
  (simulated Plivo client, real Deepgram/Sarvam/ElevenLabs/Groq):
  primary TTS dead with a backup -> failed over and audio was delivered; STT dead
  -> spoken apology and hang-up attempt in 6s; every TTS dead -> the call ends in
  2.9s with the line left open (`Leaving the call open for Plivo's own apology`).
  The third scenario failed on the first run (37s of silence) and was fixed; the
  three-scenario harness is in the session log below if it needs repeating.
- Summary retry: verified live only for the non-retryable path (bad key -> 401, no
  retry, marker written). The 429 path is covered by unit tests with an injected
  clock, not yet seen against a real 429 after the change.
- Backup-TTS switcher latency: no visible cost (TTS time-to-first-audio 0.51s vs
  0.56s; 4 samples each, one run each; not a rigorous benchmark).

- **Max duration, live through the real pipeline:** asked for 9999s, clamped to the
  10s server ceiling, cut off at 10.0s (the simulated client would have gone on for
  40s); logged, `max_duration_exceeded` in the transcript, pipeline cancelled, stream
  closed. Testing it found and fixed two defects (see the CLEANROOM row). The
  hang-up step correctly reports `failed ... 401` with fake credentials.
- `scripts/call.py`: input validation, dry run, preflight, dial request shape, error
  mapping, no-retry-on-unknown-outcome and confirmation are covered by tests with a
  mocked network. **It has never dialled a real number or fetched a real tunnel URL.**

- **LLM fallback (`af8e967`):** a 429 on qwen retries the turn on gpt-oss-20b under a 3s
  deadline, logged and recorded as `llm_fallback`; 7 tests through Pipecat's real
  request path with the HTTP client stubbed, mutation-checked. The 429 is injected; a
  real one was seen once in the benchmark run. Covers a qwen-specific failure only, not
  a Groq-wide outage (same account and key): accepted gap.
- **A/B of models (2026-09-29):** gpt-oss-20b median 0.57s to first token vs qwen 0.40s,
  so qwen stays the default (see CLEANROOM).
- **Interruptions (`6819dc2`):** while the agent speaks, only STT words interrupt; the
  VAD alone (a cough) and backchannel ("okay", "hmm", "haan", "theek hai", Devanagari
  too) do not. 22 tests run a real LLMUserAggregator; mutation-checked. NOT measured on
  real speech: an interruption now waits for STT words (a few hundred ms) instead of the
  first VAD frame, and the backchannel word list is our own judgement. Tune with
  `INTERRUPT_MIN_WORDS`, `INTERRUPT_IGNORE_WORDS`, `INTERRUPT_FILTER=false`.
- **Tools added:** `transfer_to_human` (destination is `TRANSFER_NUMBER`, never the model's
  choice; `/transfer` route returns `<Dial>` XML; Plivo's transfer request tested against a
  local server only) and `call_webhook` (fixed `TOOL_WEBHOOK_URL`, https only, no redirects,
  6s deadline, masked). Both are off unless named in `TOOLS_ENABLED`.
- **Filler line:** a reply slower than `FILLER_AFTER_SECS` (3) gets `FILLER_MESSAGE` once; its
  audio does not disarm the response deadline. Unit tests, mutation-checked; never heard on
  a real call.
- **Warm-up:** server start loads the VAD/turn models (about 50ms per call anyway) and makes one
  free Groq request; verified live. Does not pool provider connections across calls.

## 5. UNVERIFIED (assume nothing)

Never claim any of these works until a real call shows it.

**The whole real-call path**
- **No real Plivo call has happened, inbound or outbound.** Everything has been driven by
  a simulated Plivo client over `/ws`. The `start` event parsing in `server.read_start`
  was written from memory of Plivo's protocol; it logs the raw event at DEBUG ("Plivo
  start event"), which is the first thing to read after a real call.
- A real hang-up via `api.plivo.com` with real credentials has not been seen (it failed
  with fake credentials, as expected, and the SSL problem behind an earlier failure is
  fixed in `ensure_ca_bundle`).

**Outbound (`scripts/call.py`)**
- Never dialled a real number or fetched a real tunnel URL. Untested against real
  Plivo: the Make Call request; the `time_limit` and `ring_timeout` parameter names
  (from memory of the API); Plivo's POST to `/answer`; how the callee's first greeting
  sounds (the agent speaks first on answer).
- Voicemail / answering-machine detection is not implemented: a call that reaches
  voicemail will be talked to.
- The `sales` persona is a generic template that states no business facts; edit it with
  the real business before anyone is dialled.

**New on 2026-09-29 (all simulated or unit-tested only)**
- Plivo's call-transfer API request (`legs=aleg`, `aleg_url`, `aleg_method`) is from memory;
  whether Plivo then plays `<Speak>` and dials the number is unseen. A transfer also ends our
  websocket; the disconnect handler then cancels the pipeline (not exercised for this case).
- The filler and the interruption filter have never been heard or felt on a real call.
- Hindi/Hinglish quality, Smallest AI, and everything in the real-call path are unchanged from
  above.

**Provider failure**
- **Plivo `<Speak>` after a stream that ends without a hang-up.** When every TTS is dead
  the line is deliberately left open on the assumption that Plivo continues to the next
  XML element after `<Stream keepCallAlive="true">` and reads the apology. If it does
  not, the call just ends (still not indefinite silence).
- There is **no backup STT**: a dead STT ends the call with an apology.
- A settings update (language retune) reaches only the active TTS; after a failover
  `FollowCallerLanguage.retune()` resends the current language, but this has only been
  checked in code, not with a real Hindi call.
- A provider that hangs without raising is covered by the response deadline's unit tests
  only, not by a live hang.
- The summary retry's 429 path is proven with an injected clock, not yet seen against a
  real 429 after the change (the 401 path was seen live).

**Other**
- Smallest AI TTS has never run against the live API (no key when written);
  `check_smallest` in `check_providers.py` is likewise untested live.
- Real-call behaviour of `capture_lead`: one live run stopped after the read-back,
  probably because a second utterance interrupted the in-flight tool call (Pipecat
  cancels function calls on interruption by default).

## 6. Open work, in the owner's order

**Ready for when the owner has Plivo (the owner is doing the Plivo setup themselves; give
Claude the auth id/token, number and tunnel and item 1 starts).** Also needed for the new
tools: `TRANSFER_NUMBER` (a human's number) and, for webhooks, `TOOL_WEBHOOK_URL`.

**Gaps against the owner's original 15-item build plan (audit 2026-09-29), not built:**
- Bedrock/Claude Haiku 4.5 is not the LLM (Groq qwen is); `BEDROCK` is stubbed.
- Prompt caching (not applicable to the current Groq path; unmeasured).
- Per-agent language setting in a config file, and 5 sample conversations per language with a
  pronunciation check: needs a person's ear. Hindi voice choice (Sarvam vs Smallest) is open.
- Audio recording of calls: blocked on the consent decision.
- A real local database: tools write JSON-lines files.
- Backup STT.
- The 20 inbound + 20 outbound test calls, the top-5 fix pass, and Mumbai (ap-south-1)
  hosting: need real calls and a deployment.
- Connection reuse across calls.


**Done and pushed (2026-09-28 to 2026-09-29):** Smallest AI TTS, Plivo inbound, masked
transcripts, summary (+ 429 retry and failure marker), tool framework, `capture_lead`,
provider-failure handling, HANDOFF.md, CI fixed, hard max call duration, `scripts/call.py`,
`sales` persona; then LLM fallback to gpt-oss-20b, the interruption filter,
`transfer_to_human`, `call_webhook`, the slow-reply filler, server warm-up and region
warning, `scripts/talk.py`. Remaining:

1. **First real Plivo calls, inbound then outbound.** The owner owes: a Plivo number
   (Indian numbers may need KYC; a US number works for a test), `PLIVO_FROM_NUMBER`, and
   a tunnel.
   - Inbound: `ngrok http 8000`; in `.env` set `PUBLIC_HOST` (hostname only),
     `WEBHOOK_SECRET`, `PLIVO_AUTH_ID`, `PLIVO_AUTH_TOKEN`; run
     `apps/voice/venv/bin/python apps/voice/server.py`; set the Plivo XML application's
     Answer URL to `https://<host>/answer?token=<secret>` (POST) and attach it to the
     number; call it. The owner sends the server output; read the `Plivo start event`
     line and the hang-up.
   - Outbound: with the server up, `python scripts/call.py --number +91... --agent sales
     --dry-run`, then without `--dry-run`. Edit `prompts/sales.md` first.
2. Smallest AI vs Sarvam A/B on Hindi voices (needs `SMALLEST_API_KEY`; Pipecat lists
   `meher`, `devansh`, `kartik`, `maithili` as Hindi-capable).
3. Plivo V3 webhook signature validation (replaces the shared-secret token as the main
   guard; do it against a real request).
4. Audio recording, **blocked on a consent decision** (transcripts only for now).
5. Concurrency, and deploying to `ap-south-1` before real traffic (see CLAUDE.md).
6. Full regression across English/Hindi, inbound/outbound, once telephony works.
7. Still owed to the "done" standard: a proper latency benchmark for the phone path (only
   smoke timings and the small backup-TTS comparison exist), and a PII test suite that
   covers every store of call content (transcript, summary, leads, failure markers) as
   one suite instead of individually.
8. Optional hardening: a backup STT provider; voicemail detection for outbound calls; a
   live test of a provider that hangs rather than errors.
9. The owner's "CLAUDE.md §4" and "what done looks like" checklist are still not in the
   repo (see section 0). Ask for them and add them.

## 7. Gotchas that cost time

- **CI was red because of `pyaudio`.** The `local` extra needs PortAudio headers on
  Linux; CI now installs `portaudio19-dev`. It was red before this work too. It
  was not a Python-version or test problem.
- **Run ruff from the repo root**, as CLAUDE.md says. Running it from `apps/voice`
  changes isort's first-party detection and produces conflicting import-order
  fixes.
- aiohttp builds its SSL context at import, before `ensure_ca_bundle()`; the fix
  loads certifi into `aiohttp.connector._SSL_CONTEXT_VERIFIED` (private attr,
  guarded). Specific to the python.org macOS Python.
- Qwen's chat template rejects the `developer` role and needs a `user` turn; the
  greeting is sent as `user` and `PortableGroqLLMService` rewrites the rest.
- Plivo posts webhook parameters as a **form body**, not the query string.
- Deepgram ends a turn at every pause, so read-out numbers arrive fragmented;
  masking must work across turns.
- Groq returns 429 after repeated smoke runs on this account. Space them out.
- `macOS sed` differs from GNU sed; use Python for scripted edits.
- The default persona said "you are not a business", which made the model refuse
  callbacks; the "Leaving details" section now overrides that explicitly.
- **Pipecat's worker `ProcessorUnusablePolicy` acts on the failed service even when
  a backup exists**, so leave it on CONTINUE and decide in `CallHealth`.
- An `ErrorFrame` can arrive a moment before its processor's `is_usable` flips;
  `CallHealth` re-checks 0.5s later for that reason.
- A `ServiceSwitcher` pushes its own error once every service behind it is dead;
  that frame's processor is the switcher, not a service.
- Never store or log a provider error verbatim: it can embed request headers.
  Use `resilience.safe_reason`.
- The live failure harness: run the real server with one service given a bad key
  (`SARVAM_API_KEY=bad`, `DEEPGRAM_API_KEY=bad`, ...) and a simulated Plivo client
  sending 8kHz mu-law silence; look for `call_failed` in `logs/calls/<id>.jsonl`.
  Use the project's venv Python (the system one has no `websockets`).
- Placing a call is not idempotent: `call.py` never retries, and tells you to check
  the Plivo console after a timeout. Do not add a retry.
- A request can only lower `MAX_CALL_DURATION_SECS`; the server clamps. The test
  suite shrinks `duration_limit.FLOOR_SECS` to test the cutoff quickly.
- The real-handler cutoff tests run the client in a daemon thread with a timeout, so a
  broken cutoff fails in seconds instead of hanging pytest.
- A commit cannot cite its own hash, and `git commit --amend` changes it: do not put a
  commit's own hash in a file inside that commit (refer to it by message instead).
- Waiting in the browser tools: the `wait` action errors on a `chrome://newtab` tab; navigate
  to a real page first.
- Free ngrok hostnames change on restart: update `PUBLIC_HOST` and the Plivo
  Answer URL together.

## 8. Commands

```bash
apps/voice/venv/bin/python apps/voice/main.py      # local mic/speaker
apps/voice/venv/bin/python apps/voice/server.py    # phone server (needs the Plivo env vars)
python scripts/check_providers.py                  # one real call per provider
python scripts/latency_summary.py
cd apps/voice && venv/bin/pytest -q
apps/voice/venv/bin/ruff check --config apps/voice/pyproject.toml .   # from the repo root
```

## 9. Session log (append newest last)

**2026-09-27 and earlier (from the owner's status, not re-derived).** Scaffold and
pipeline; provider checks; latency logging; qwen chosen; prompt trimmed; VAD
tuned; Sarvam wired in; qwen interrupt crash found and fixed and pushed.

**2026-09-28, session 1.**
- Confirmed the interrupt fix was already pushed. Added Smallest AI TTS (`8321073`).
- Built Plivo inbound telephony; refactored `main.py` into `build_worker()`;
  token-gated routes (`e8025e0`). Corrected my earlier wrong claim that Pipecat has
  no Plivo support (it ships `PlivoFrameSerializer`).
- Masked transcripts (`0f4ff0a`). A live test exposed the fragmented-number leak;
  fixed.
- Post-call summary (`eb80de9`); hit a Groq 429 in testing.
- Tool framework and `end_call` (`1fdbf3b`); found and fixed the aiohttp CA problem
  that would have left real calls open.
- `capture_lead` (`0ead791`); fixed `/answer` reading `From` from the wrong place.
- Owner reported CI red on three commits. Could not read the Actions log (private
  repo). Reproduced locally: clean installs on Python 3.11 and 3.13 both pass; in
  a Linux 3.11 container `pip install` fails building `pyaudio`, and `4c89535`
  fails the same way. With `portaudio19-dev` the whole workflow passes (68 tests).
  Fixed in `a4e68f4`. Ruled out: version mismatch, new dependencies, any bug in
  `capture_lead`, the tool framework or the masking.
- Owner set the standard in section 0 and asked for this file. Next: confirm CI
  green, then fix the two regressions in section 6.1, then the real Plivo call.

**2026-09-28, session 1 (continued).**
- CI: read the real failing log through the owner's Chrome (repo is private): the
  install step died building `pyaudio` (`portaudio.h: No such file`), exactly as
  diagnosed from the container. `a4e68f4` went green, so did `644a256`. Also
  confirmed from the run list that `4c89535` was already red, so CI was red before
  this work.
- Summary retry (`4961b56`): bounded retries, Retry-After, deadline, marker file.
- Provider failure (`1064e67`): `resilience.py`, backup TTS, apology-then-hang-up or
  leave-the-line-to-Plivo, error-rate check, response deadline, sanitised reasons.
  Live failure runs found and fixed a real bug (all-TTS-dead stayed silent for 37s)
  and two smaller ones (transcript flush crash on a held marker, marker `role`
  overwritten). The owner's "CLAUDE.md §4" and "what done looks like" checklist are
  still not in the repo; the standard in section 0 was used.
- Next: owner says whether to push, then the first real Plivo call.

**2026-09-28, session 1 (outbound).**
- Owner asked for `scripts/call.py`, a hard max call duration, tests proving the
  cutoff fires, no changes to STT/TTS/summary code, and CI confirmed green.
- `80fa24a`: `duration_limit.py`, outbound params on `/answer` and `/ws`, `personas.py`,
  `sales.md`. Found and fixed two defects while testing the cutoff (guard cancelled
  before its close step; Pipecat's hang-up hides failures). STT/TTS/summary code was
  not touched (`main.py` only gained persona plumbing and exposes `worker.transcript`).
- `c43c24a`: the dialler (`scripts/call.py`), its 42 tests, docs, `.env.example`.
  Verified: dry run and failure cases from the terminal; the real pipeline cut off a call
  at the 10s ceiling; the workflow's steps in a clean Linux 3.11 container (200 passed).
  Pushed both commits to get CI, which came back green (run #21).
- Not done, deliberately: nothing dialled (no Plivo number yet); no change to STT, TTS or
  summary code.
- Owner still owes: a Plivo number (`PLIVO_FROM_NUMBER`), the tunnel, and a real inbound
  and outbound call. Next session: review this file, then help run those calls and read
  the server output.

**2026-09-29.**
- Read the handoff, checked against git (clean, level with origin). The owner's pasted Groq
  switch did not match the repo (Groq/qwen was already the LLM; no CLAUDE.md section 3); asked,
  and the owner chose to A/B gpt-oss-20b. It was slower (0.57s vs 0.40s), so qwen stays.
- `af8e967`: LLM fallback to gpt-oss-20b on a qwen 429/5xx/connection error. CI #23 green.
- `6819dc2`: interruption filter (`interruptions.py`). Pipecat already did the cancelling; what
  was missing was telling noise and backchannel from a real interruption. CI #24 green.
- Audited the owner's 15-item plan against the repo and reported what is done, simulated and
  missing (see section 6).
- Then, with Plivo left to the owner: `transfer_to_human`, `call_webhook`, the slow-reply
  filler, server warm-up and region warning, `scripts/talk.py`; 254 tests, ruff clean. Not
  built, deliberately: language config (needs a listener), recording (consent), Bedrock.
- Next session: review this file, check CI on the newest commit, then the first real Plivo
  calls once the owner supplies the credentials.

**2026-10-01.**
- Confirmed CI green on `2c7418c` (run #25) by screenshot of the Actions page; no code changed
  since. Handoff refreshed only. Waiting on the owner for the Plivo credentials, the number, the
  tunnel host and a `TRANSFER_NUMBER`; then the first real inbound call, then outbound.

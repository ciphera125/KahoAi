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

Last updated: 2026-09-28, after the provider-failure work (`1064e67`). CI was confirmed
green on `a4e68f4` and `644a256` by reading the Actions tab through the owner's Chrome.

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
  requested; ask before pushing.
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
GitHub API returns 404 unauthenticated, and `gh` is not installed, so Claude
cannot read Actions logs; the owner has to paste them).

Commits this project, newest first:

| Commit | What |
|---|---|
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

Everything up to `644a256` is pushed; `4961b56` and `1064e67` are local until the owner
says to push. Check `git log origin/main..` at the start of a session.

## 3. What exists (file map)

```
apps/voice/main.py       build_worker(transport) = the whole pipeline; local mic entrypoint
apps/voice/server.py     FastAPI: POST/GET /answer (Plivo XML), WS /ws (audio); token-gated
apps/voice/tools.py      decorator tool registry; end_call, capture_lead
apps/voice/masking.py    Aadhaar/PAN masking (any 12 digits; AAAAA9999A)
apps/voice/transcript.py CallTranscript: only writer of call content; masks in write()
apps/voice/summary.py    post-call LLM summary of the MASKED transcript; retry + failure marker
apps/voice/resilience.py CallHealth: what happens when STT/LLM/TTS fails mid-call; safe_reason
apps/voice/prompts/      default.md (with "Leaving details"), example_clinic.md
apps/voice/tests/        120 tests
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

- 120 tests pass; ruff clean; on Python 3.13 and 3.11, clean installs, and in a
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

## 5. UNVERIFIED (assume nothing)

- **Plivo `<Speak>` after a stream that ends without a hang-up.** The all-TTS-dead
  design leaves the line open on the assumption that Plivo continues to the next XML
  element after `<Stream keepCallAlive="true">` and reads the apology. Not seen on a
  real call. If it does not, the call just ends (still not indefinite silence).
- There is **no backup STT**: a dead STT ends the call with an apology.
- A settings update (language retune) reaches only the active TTS; after a failover
  `FollowCallerLanguage.retune()` resends the current language, but this path has
  only been checked in code, not with a real Hindi call.
- Not simulated: a provider that hangs without raising (only covered by the response
  deadline's unit tests, not a live hang).

- **No real Plivo call has happened.** The `start` event parsing in
  `server.read_start` was written from memory of Plivo's protocol and only tested
  against my own simulator. It logs the raw event at DEBUG ("Plivo start event").
- Smallest AI TTS has never run against the live API (no key when written).
  `check_smallest` in `check_providers.py` is likewise untested live.
- Plivo hang-up: it failed on this Mac with an SSL error (fixed in
  `ensure_ca_bundle`); a real hang-up via `api.plivo.com` with real credentials
  has not been seen.
- Real-call behaviour of `capture_lead`: one live run stopped after the read-back,
  probably because a second utterance interrupted the in-flight tool call
  (Pipecat cancels function calls on interruption by default).
- CI: green on `a4e68f4` and `644a256` (read from the Actions tab). Older runs stay
  red for the pyaudio reason in section 7. New pushes need to be checked again.

## 6. Open work, in the owner's order

**Done this session:** the two known regressions (summary 429 retry; silence on provider
failure), CI green. Remaining, in the owner's order:

1. **Push `4961b56` and `1064e67`** when the owner says so, then check the Actions tab
   (they add no dependencies, and the workflow's steps passed in a clean Linux 3.11
   container).
2. **First real inbound Plivo call.** Owner's setup steps: buy a number (Indian
   numbers may need KYC; a US number works for a test), `ngrok http 8000`, put
   `PUBLIC_HOST` (hostname only), `WEBHOOK_SECRET`, `PLIVO_AUTH_ID`,
   `PLIVO_AUTH_TOKEN` in `.env`, run `apps/voice/venv/bin/python apps/voice/server.py`,
   set the Plivo XML application's Answer URL to
   `https://<host>/answer?token=<secret>` (POST) and attach it to the number.
   Owner sends the server output; look at the `Plivo start event` line and the
   hang-up.
3. Smallest AI vs Sarvam A/B on Hindi voices (needs `SMALLEST_API_KEY`; Pipecat
   lists `meher`, `devansh`, `kartik`, `maithili` as Hindi-capable).
4. Plivo V3 webhook signature validation (replaces the shared-secret token as the
   main guard; do it against a real request).
5. Audio recording, **blocked on a consent decision** (transcripts only for now).
6. Outbound calls, concurrency, region (`ap-south-1`) before real traffic.
7. Full regression across English/Hindi, inbound/outbound, once telephony works.
8. Also owed: a proper latency benchmark for the phone path (only smoke timings and the
   small backup-TTS comparison exist), and a PII test suite covering each store of
   call content (transcript, summary, leads, and now the failure markers are covered
   individually, but not as one suite).
9. Optional hardening seen while doing the fallback: a backup STT provider; a live
   test of a provider that hangs rather than errors.

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


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

Last updated: 2026-09-28, after the CI fix (`a4e68f4`).

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
| `a4e68f4` | CI: install PortAudio so `pip install` can succeed |
| `0ead791` | `capture_lead` tool; persona updates; `/answer` reads `From` from the POST form body |
| `1fdbf3b` | Tool-calling framework (`tools.py`), `end_call`; aiohttp CA fix |
| `eb80de9` | Post-call summary (`summary.py`) |
| `0f4ff0a` | Masked call transcripts (`masking.py`, `transcript.py`) |
| `e8025e0` | Plivo inbound telephony (`server.py`), shared `build_worker()` |
| `8321073` | Smallest AI as a TTS provider |
| `4c89535` | Qwen interrupt-crash fix (pre-existing) |

All of the above are pushed. Check `git status` and `git log origin/main..` at the
start of a session to confirm nothing local is unpushed.

## 3. What exists (file map)

```
apps/voice/main.py       build_worker(transport) = the whole pipeline; local mic entrypoint
apps/voice/server.py     FastAPI: POST/GET /answer (Plivo XML), WS /ws (audio); token-gated
apps/voice/tools.py      decorator tool registry; end_call, capture_lead
apps/voice/masking.py    Aadhaar/PAN masking (any 12 digits; AAAAA9999A)
apps/voice/transcript.py CallTranscript: only writer of call content; masks in write()
apps/voice/summary.py    post-call LLM summary of the MASKED transcript
apps/voice/prompts/      default.md (with "Leaving details"), example_clinic.md
apps/voice/tests/        68 tests
scripts/                 check_providers.py, latency_summary.py, bench_llm_tts.py, ...
logs/turns.jsonl         per-turn timings        (gitignored)
logs/calls/<id>.jsonl    masked transcript, <id>.summary.json   (gitignored)
leads/<date>.jsonl       captured leads          (gitignored; holds names/numbers)
CLEANROOM.md             decision log with sources; add a row for every non-obvious choice
```

Pipeline: `transport -> Deepgram STT -> [FollowCallerLanguage] -> user aggregator ->
Groq LLM -> TTS -> transport -> assistant aggregator`. `TTS_PROVIDER` is one of
deepgram, elevenlabs, sarvam, smallest. Tools are enabled by `TOOLS_ENABLED`
(default `end_call,capture_lead`).

## 4. Verified by Claude (simulated or offline, NOT real phone calls)

- 68 tests pass; ruff clean; on Python 3.13 and 3.11, clean installs, and in a
  Linux 3.11 container running the CI workflow's own steps (exit 0).
- The server, driven by a **simulated Plivo client** over `/ws` with
  Deepgram-synthesised 8kHz mu-law speech: greeting audio returns as `playAudio`;
  hangup tears the pipeline down; the transcript is written; the summary works
  against live `qwen/qwen3.8-27b`; `end_call` was called by the model and ended
  the call; `capture_lead` saved a lead in 2 of 4 live runs.
- A spoken Aadhaar arrives split across turns ("2 3 4", "5 6 7", ...). Per-turn
  masking leaked it in pieces; fixed by holding number-like fragments and masking
  them as one run. Verified live: no digit or PAN letter reached disk.

## 5. UNVERIFIED (assume nothing)

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
- CI on GitHub: the fix `a4e68f4` is pushed; the result is not yet confirmed.
  Earlier runs (`eb80de9`, `1fdbf3b`, `0ead791`) were red for the pyaudio reason
  below and will stay red; only the new head can go green.

## 6. Open work, in the owner's order

**Gate first:** confirm CI is green on `a4e68f4` (owner checks the Actions tab).

1. **Two known regressions against the timeout-and-fallback standard** (owner
   wants these fixed before the first real call):
   - `summary.py`: no retry on a 429 (hit live: that call's summary was lost).
     Needs bounded retry with backoff honouring `Retry-After`, a total deadline,
     and a defined outcome when it gives up (log it, and leave a marker file so
     the loss is visible, not silent).
   - **STT/TTS failure means silence.** No fallback if Deepgram STT or the TTS
     provider errors mid-call. Needs a defined behaviour (e.g. fall back to a
     second TTS provider; if none, say a fixed apology via a pre-rendered clip or
     a different voice, and hang up cleanly rather than staying silent), and a
     test that injects the failure.
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
8. Also owed: a proper latency benchmark for the phone path (only smoke timings
   exist), and a PII test suite covering each store of call content.

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

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

Last updated: 2026-10-25. **Everything is committed and pushed; CI green on `6f55232`.**
The voice is Smallest **`suri`** in English (`SMALLEST_LANGUAGE=en`), backed up by ElevenLabs
(`EXAVITQu4vr4xnSDxMaL`); Google TTS removed, Cartesia on hold. LLM `openai/gpt-oss-20b`, effort
medium, fallback off, GPT-OSS only, no qwen. The recording notice is cached at startup and sent
the instant a call opens (pickup -> voice 340ms, -> greeting 2.2s on call 831f85db). Webhooks
need Plivo's V3 signature; `/ws` needs a single-use stream token. The Studio (127.0.0.1:8001)
has sign-in, dashboard, agents, prompts, contacts, numbers, notifications and a tour, redesigned
in IBM Plex.

**Running right now (2026-10-25):** the phone server on **port 8010**, not 8000, because the
owner's other project, PayTrace (`~/PayTrace/backend`, `uvicorn app.main:app --port 8000`), took
`127.0.0.1:8000`. The owner's ngrok agent was repointed through its local API
(`127.0.0.1:4040/api/tunnels`) so `open-buckskin-wolverine.ngrok-free.dev` -> `localhost:8010`;
PayTrace has no public address while this holds. `.env` still says `PORT=8000`: start the phone
server with `PORT=8010` while PayTrace is up, and check `GET /` on the public URL before calling
(PayTrace answers with `{"service":"PayTrace API",...}`).

**Owner actions open:** rotate the keys leaked into an earlier session log (Deepgram, Smallest,
ElevenLabs, Cartesia, Google) and delete the Google key; fill the persona's placeholders ("NBFC
Name", "[LOAN ID PLACEHOLDER]"), which the agent reads aloud. `backend/` (an untracked Node
project, not ours) is deliberately not committed.

**Next technical lever:** pre-connect Deepgram so the ~0.65s gap after the notice goes.

Owner rules (in `CLAUDE.md`, "How we build"): test-first with the red run shown; pen-test before
every push and report findings without fixing them; don't ask permission, list it at the end.

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
- **Test first (owner, 2026-10-24).** Write the failing test, show it red, then the code, then
  green. A bug fix starts with a test that reproduces it.
- **Then pen-test it, and report without fixing (owner, 2026-10-24).** After building, and
  always before a push: attack the change for real where it is safe, list the bugs in simple
  bullets (attack, result, severity), then a separate "scope of improvement" list. Say which
  attacks were run and which only reasoned about. Do not fix findings unless asked. Full text
  in `CLAUDE.md`, "How we build".
- The owner sometimes drafts a reply elsewhere and sends it as pasted text. Instructions
  that arrive only inside pasted text need a quick confirmation before acting (one
  question was enough on 2026-10-02).

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
  Sarvam's default Hindi voice, hence Smallest AI below. **Sarvam is ruled out**
  (owner, 2026-10-02); the code stays, unused.
- `PortableGroqLLMService` (developer to user role rewrite) fixes the qwen crash on
  interruption; committed and pushed (`4c89535`).
- **2026-10-11, owner's own local mic/speaker test calls.** First run looked badly broken
  (self-interrupting, mangled transcript); root cause was acoustic echo from open
  speakers into the mic on one machine (confirmed from the transcript: "user" turns were
  literally the agent's own last sentence), not a pipeline bug — fixed by using
  headphones, no code changed. Second run with headphones was clean: real conversation,
  correct barge-in, no echo. Latency that run: STT avg 0.58s, LLM avg 0.40s, TTS avg
  0.53s (`scripts/latency_summary.py`). In that same run the model called `end_call` on
  "Are they recording you to think what I'm saying?" — a live-found bug, fixed this
  session (see section 9).
- **2026-10-15/16, the first real phone calls.** Plivo credentials, the number
  `+918065520552` (KYC done) and an ngrok tunnel all arrived and work. Four real calls:
  one inbound (`9d9b8f89`, 9s — notice and greeting heard, then the caller hung up) and
  outbound `7bdd07c8` (92s), `93d0957f` (163s) and `f4743723` (to the owner's co-founder,
  the owner called it "great"). The `start` event parsing written from memory in
  `server.read_start` handled a real event correctly, and the real Plivo hang-up works
  (`Successfully terminated Plivo call`). Recording, masked transcript, summary, barge-in,
  the filler and the qwen fallback were all exercised live.
- **Smallest AI is live and speaks Hindi.** The owner heard the `meher` voice and chose
  it. Fastest TTS measured here: TTFB 0.158-0.202s, TTFA 0.278-0.315s. Devanagari and
  code-switched Hinglish both verified against the live API.
- **The agent is Aayushi, calling from Kaho AI** (owner's decision, 2026-10-16), heard on
  a real call: "Hello, I'm Aayushi, calling from Kaho AI."
- **The LLM fallback to `qwen/qwen3.8-27b` is back on** (owner's decision, 2026-10-15) and
  proven live: six `llm_fallback` events on `93d0957f`, each a 429 retried on qwen.

- **2026-10-24, Cartesia call (`ad57ba2c`, outbound to the owner, 115s).** The owner called it
  "perfect". Cartesia **Neha** (`47f3bbb1-e98f-4e0c-92c5-5f0325e1e206`) is now the default voice
  (owner's decision), replacing Smallest `meher`. Hindi on a real call worked: the owner asked for
  Hindi only and the agent stayed in Hindi; 4 barge-ins all stopped the agent; "Ok. Thank you."
  ended the call. Recording, masked transcript and summary were all written.
- **Groq Developer plan is permanent (owner, 2026-10-24).** 250K TPM from the live headers; zero
  429s and zero fallbacks across 21 completions on `ad57ba2c`.

- **Two calls to Ayushi, the co-founder (2026-10-24, `4f6452c9` 147s and `188ae535` 84s).**
  Second call: caller wait 797ms avg (fastest yet). Both exposed real bugs (section 6 item 15).
- **GPT-OSS only, 120b primary (owner, 2026-10-24).** "Don't use Qwen for right now."

## 2. Repository state

Branch `main`, remote `origin` = `github.com/ciphera125/KahoAi` (**private**; the
GitHub API returns 404 unauthenticated and `gh` is not installed). **Claude can read
Actions runs and logs through the owner's logged-in Chrome** (the Claude in Chrome
tools): open `https://github.com/ciphera125/KahoAi/actions`, screenshot the run list,
and open a run and then its job to read a failing step's log. Runs take about a minute;
close the tab afterwards. For a big log, use the job's gear menu, "View raw logs"
(`/ciphera125/KahoAi/commit/<full sha>/checks/<job id>/logs`), and search it in the page
with the javascript tool (`document.body.innerText`); the extension blocks output that
contains URL query strings, so strip those. "Cancel workflow" is a plain form post, no
confirm dialog.

A CI-like machine for reproducing: `git archive HEAD` into a scratch dir, then
`docker run -d --name kaho-ci --cpus=2 -v <dir>:/repo -w /repo python:3.11 sleep infinity`,
`docker exec kaho-ci bash -c "apt-get update && apt-get install -y portaudio19-dev && pip install
-r apps/voice/requirements-dev.txt"`, then run ruff and pytest inside. `docker update
--cpus=0.7 kaho-ci` emulates a loaded runner. It reproduced the CI test failure exactly.

Commits this project, newest first:

| Commit | What |
|---|---|
| `6f55232` | Caching the notice can never stop the server from starting (warm-up catches SystemExit; CI was red without keys) |
| `ce6bbd3` | Docs: voice Suri, "KahoAI", fast opening, webhooks, pins |
| `6d0e90e` | Calls: fast opening (`notice_audio.py`), voice failover in `CallHealth`, Plivo V3 signatures, stream tokens, conversation filters |
| `e84891f` | Studio redesign: IBM Plex, light/dark tokens, Operate/Configure sidebar |
| `55c834f` | `.env.example` restored as a template; `test_env_example.py` fails on a real-looking key |
| `a0fb8e0` | Google TTS removed; ElevenLabs is the backup voice; Cartesia on hold |
| `bb555a4` | Dependencies pinned in `constraints.txt` (pipecat-ai 1.12.0, openai 3.19.2); CI green again |
| `823d491`..`abc9374` | Kaho AI Studio, then the medium and low pen-test fixes and their docs |
| `6304f5c`..`2a2a967` | Cartesia provider, "into" as multiplication, rules, Google Chirp (since removed), safer tools, live captions |
| `6b3b150` | CLEANROOM rows + handoff update after the first real phone calls |
| `bed7be2` | `LLM_FALLBACK_MODEL_ID` back to `qwen/qwen3.8-27b` (owner's decision); docs only, the mechanism was untouched |
| `fa1c7fa` | Persona identity: the agent is Aayushi, calling from Kaho AI; "not a business" reframed as sourcing |
| `291b5dc` | `check_providers.py` calls `ensure_ca_bundle()`, so the Smallest check stops failing falsely on macOS |
| `04f4c6f` | Turn-phase timings (`turn_detection`, `reply_after_turn`, `caller_wait`) — the wait Pipecat's metrics cannot see |
| `fe4d08e` | The missing-config test no longer reads the real `.env` (it only passed while those lines were blank) |
| `1c8ccee` | `end_call` no longer fires on a stall, a repeat, or alongside text inviting the caller to continue |
| `4e28b58` | HANDOFF.md update (model pin, end_call fix, Groq logging, `/ws` rate limiting) |
| `eeef867` | `/ws` rate limiting: per-IP per-minute cap and a global concurrent cap (`rate_limit.py`), ahead of any pipeline work |
| `05f42d5` | Every Groq API call appended to `logs/groq_usage.log` (`groq_usage.py`): timestamp, caller, model |
| `c0172d4` | `end_call`'s tool description tightened so a question about recording/privacy no longer ends the call |
| `f36d5ae` | LLM pinned to `openai/gpt-oss-20b` only; `LLM_FALLBACK_MODEL_ID` defaults to `off` (no second approved model) |
| `531ae05` | HANDOFF.md update (confirm push and CI #32 green, build-plan review and Plivo setup steps given) |
| `bfc5b0c` | HANDOFF.md update (end_call deadlock and LLM request timeout closed) |
| `02b03d2` | The Groq LLM request gets its own timeout (`LLM_REQUEST_TIMEOUT_SECS`, default 6s) and `max_retries=0`, so a stall is seen and falls back at once instead of waiting on the OpenAI client's 600s default |
| `dc9f891` | A successful `end_call` skips the follow-up LLM reply (`ends_call=True`, `run_llm=False`): closes the deadlock where that second request could hang behind the hang-up |
| `03c01b7` | HANDOFF.md update (CI green on `cb7771b`, run #31) |
| `cb7771b` | HANDOFF.md update after recording, retention, the notice and the hung-LLM fix |
| `c11d7c2` | Recording tests hold under CI load (speaking signals, compare structure not bytes); pytest `faulthandler_timeout`; CI job `timeout-minutes: 15` |
| `1d6c4d7` | Recording notice: "This call may be recorded." before the greeting; caller muted until it has played |
| `e37a64e` | `RECORDING_RETENTION_DAYS` (60): expired recordings deleted at start and hourly; files renamed `<id>.recording.wav` |
| `0c74c53` | A hung LLM no longer silences the call: filler pushed from the LLM, apology behind an interruption, call cancelled once the apology is heard, speech signals counted once |
| `1a04ecb` | Call recording (`recording.py`): stereo WAV per call, written in chunks without moving either side |
| `1cdd6a3` | HANDOFF.md stale notes fixed |
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

As of 2026-10-24, `main` is level with `origin/main` at `6b3b150`; everything listed as
uncommitted above is only in the working tree. Earlier: pushed through `eeef867`, level with
origin (2026-10-12). **CI #34 is green** (1m12s),
confirmed by screenshot of the Actions page; one run covers the whole push (`f36d5ae`
through `eeef867`), since GitHub Actions fires once per push, not once per commit.

Earlier: CI: green through #26 (`daa7b20`).
#27 (`1a04ecb`), #28 (`0c74c53`)
and #30 (`1d6c4d7`) failed on `test_writing_as_the_call_goes_changes_nothing_in_the_recording`
alone (#30: 1 failed, 298 passed). #29 (`e37a64e`) hung inside `tests/test_recording.py`;
Claude cancelled it after 22 minutes. `c11d7c2` fixed the flaky test and added a
`faulthandler_timeout`/15-minute job ceiling for the hang; before pushing, re-verified the
full CI steps (ruff + 299 tests) and looped `tests/test_recording.py` 5x at 2 CPUs and 5x at
0.7 CPUs in the CI-like container (10/10 passed, no hang). Pushed as `c11d7c2` + `cb7771b`;
**CI #31 is green** (1m24s), confirmed by screenshot of the Actions page. Then `03c01b7`,
`dc9f891` and `02b03d2` (the `end_call` deadlock and LLM request timeout, see below) and
`bfc5b0c` were pushed together; **CI #32 is green too** (1m24s on `bfc5b0c`), also confirmed
by screenshot. Earlier: green on #18 to #21 and #23 to #25; #15 to #17 and earlier-red runs
were the pyaudio failure. Check `git log origin/main..` at the start of a session.

## 3. What exists (file map)

```
apps/voice/main.py       build_worker(transport) = the whole pipeline; local mic entrypoint
apps/voice/server.py     FastAPI: POST/GET /answer (Plivo XML), WS /ws (audio); token-gated
apps/voice/tools.py      decorator tool registry; end_call, capture_lead, transfer_to_human, call_webhook
apps/voice/interruptions.py  which caller sounds may interrupt (words only; backchannel ignored)
scripts/talk.py          local mic/speaker run, same as apps/voice/main.py
apps/voice/masking.py    Aadhaar/PAN masking (any 12 digits; AAAAA9999A)
apps/voice/transcript.py CallTranscript: only writer of call content; masks in write()
apps/voice/recording.py  CallRecorder: call audio to recordings/<id>.recording.wav (NOT masked); retention
apps/voice/summary.py    post-call LLM summary of the MASKED transcript; retry + failure marker
apps/voice/duration_limit.py hard max call duration, enforced by a timer beside the pipeline
apps/voice/personas.py   safe persona lookup by name (names arrive from the network)
scripts/call.py          dial out via Plivo: --number, --agent, --max-duration, --dry-run
apps/voice/resilience.py CallHealth: what happens when STT/LLM/TTS fails mid-call; safe_reason
apps/voice/groq_usage.py append-only log of every Groq API call (logs/groq_usage.log): timestamp, caller, model
apps/voice/rate_limit.py ConnectionLimiter: /ws's per-IP-per-minute and global-concurrent caps, ahead of any pipeline work
apps/voice/prompts/      default.md (with "Leaving details"), example_clinic.md, sales.md (generic outbound template)
apps/voice/tests/        355 tests (pipeline_fakes.py: provider stand-ins for build_worker tests)
scripts/                 check_providers.py, latency_summary.py, bench_llm_tts.py, ...
logs/turns.jsonl         per-turn timings        (gitignored)
logs/groq_usage.log      every Groq API call: timestamp, caller, model (gitignored)
logs/calls/<id>.jsonl    masked transcript, <id>.summary.json   (gitignored)
leads/<date>.jsonl       captured leads          (gitignored; holds names/numbers)
recordings/<id>.recording.wav  call audio, caller left, agent right (gitignored; unmasked; 60 days)
CLEANROOM.md             decision log with sources; add a row for every non-obvious choice
```

Pipeline: `transport -> Deepgram STT -> [FollowCallerLanguage] -> user aggregator ->
Groq LLM -> TTS (optionally a failover pair) -> transport -> assistant aggregator`. `TTS_PROVIDER` is one of
deepgram, elevenlabs, sarvam, smallest, cartesia. This deployment's `.env` uses `cartesia`
(Neha, `CARTESIA_LANGUAGE=hi`, model default `sonic-3.6`), with **no `TTS_FALLBACK_PROVIDER`**.
The code's own default when unset is still `deepgram`. Tools are enabled by `TOOLS_ENABLED`
(default `end_call,capture_lead`).

`GROQ_MODEL_ID` is pinned to `openai/gpt-oss-20b` only (owner's decision, 2026-10-12); do
not change it to `qwen/qwen3.8-27b` or any other Groq model without asking first.
**Superseded 2026-10-24 (end of session):** `GROQ_MODEL_ID=openai/gpt-oss-20b`,
`GROQ_REASONING_EFFORT=medium`, `LLM_FALLBACK_MODEL_ID=off`; GPT-OSS only, no qwen (owner).
`CARTESIA_LANGUAGE=en`. The Groq account is on the Developer plan: 250K TPM from the live headers
on 2026-10-24. `/ws` is rate-limited right after the `WEBHOOK_SECRET` check, before any pipeline
work: `WS_RATE_LIMIT_PER_MINUTE` (default 5, per IP) and `WS_MAX_CONCURRENT_CALLS` (default
10, across every IP) — a safety net, not the real guard (Plivo signature validation is
still open, section 6).

## 4. Verified by Claude (simulated or offline, NOT real phone calls)

- 299 tests pass locally (Python 3.13) at `c11d7c2`; ruff clean. In the CI-like Linux 3.11
  container, the previous version of one recording test was flaky (failed in up to half the
  runs); its replacement passes locally but was not looped in the container (interrupted)
  and has not run on GitHub.
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
- **A hung LLM request (fixed 2026-10-02).** Reproduced live first, through the phone server
  with the Groq client pointed at an endpoint that never answers: the caller heard nothing
  for 45s and the call never ended, because the filler, the apology and the EndFrame all
  queued behind the request, and Pipecat would not act on a cancel until that EndFrame got
  through. Also found: observers see each "bot started speaking" at every hop and in both
  directions, so a filler that really played would have stopped the deadline. Now the filler
  is pushed from the LLM's place, the apology goes in behind an interruption that cancels the
  request, the call is cancelled once the apology has been heard, and each start/stop counts
  once. Same live run after the fix: filler heard at 5s and 15s, apology at 22-26s, line
  closed at 28s. `tests/test_hung_llm.py` drives the real `build_worker` wiring with a hung
  LLM; four mutations, all caught.
- **Warm-up:** server start loads the VAD/turn models (about 50ms per call anyway) and makes one
  free Groq request; verified live. Does not pool provider connections across calls.
- **Call recording (2026-10-02):** every call to `recordings/<id>.recording.wav`, stereo (caller left,
  agent right), 8kHz on the phone path, written in 5s chunks. Pipecat's own chunking was
  measured to insert gaps and drift (see CLEANROOM), so ours hands over only audio both sides
  cover: the same as writing at the end (byte-identical when frames arrive in the same order;
  on a busy machine the sides can line up a frame differently). Live through the phone server, simulated Plivo
  client, real Deepgram and Groq: a 42.7s call gave a 42.5s file; both sides line up with what
  the client sent and heard, no drift; `recording_saved` precedes `call_end`; the summary still
  runs. Unwritable folder, live: one `recording_failed` line and the call carried on normally.
  TTS first audio 0.51s avg with it (4 turns) vs 0.53s without (6); not rigorous. 15 tests;
  six mutations, all caught.
- **Recording notice (2026-10-02):** every recorded call opens with `RECORDING_NOTICE` ("This call
  may be recorded."), word for word, then the greeting is asked for once it has played, so the
  two are separate stretches of speech and the deadline still watches the greeting. The caller
  is muted until the notice has played (Pipecat's `MuteUntilFirstBotCompleteUserMuteStrategy`),
  so an early "hello?" cannot cancel it. It stays out of the LLM context; the greeting
  instruction says it was said; the transcript gets `recording_notice_played`. Live through the
  phone server: notice heard 1.6-3.1s, greeting 4.0s, a "Hello?" at connect ignored, and with a
  hung LLM: notice, filler, filler, apology, call ended at 29.6s. Five mutations, all caught.
- **Recording retention (2026-10-02):** `RECORDING_RETENTION_DAYS` (default 60). The phone server
  deletes expired recordings at start and hourly; a local run at start. Only `*.recording.wav`
  directly in the folder, never through a symlink; a file that cannot be deleted is logged and
  skipped; an invalid value stops startup. 15 tests; seven mutations, all caught. Not yet run
  against a real 60-day-old file (tests age files with `os.utime`).
- **The `end_call` deadlock, closed (2026-10-05).** The cause: a successful `end_call` result is
  truthy, so Pipecat's own context aggregator queued a second LLM completion to let the model
  reply after the tool result (`_handle_function_call_result` in
  `llm_response_universal.py`) — a second request on the same hung-prone LLM, with no one left
  to hear it, that would block the graceful `EndFrame` behind it if it ever hung. Tools can now
  be marked `ends_call=True` (only `end_call` is); on success the wrapper passes
  `FunctionCallResultProperties(run_llm=False)`, skipping that request entirely. A failed
  `end_call` (no `hang_up` hook) still gets the normal follow-up, since the call goes on.
  3 new unit tests on the tool wrapper, mutation-checked (reverting the suppression fails the
  success-path test). Not re-verified live end to end (no real Plivo call yet); the mechanism
  is read directly from Pipecat's source, not re-derived from a guess.
- **The LLM request's own deadline (2026-10-05).** The OpenAI client's defaults are a 600s
  timeout and up to 2 silent retries on a timeout or connection error (the 11s time-to-first-
  token seen live on 2026-10-02 with nothing logged was this). `PortableGroqLLMService.
  create_client()` now builds its client with `timeout=LLM_REQUEST_TIMEOUT_SECS` (default 6s,
  under the 10s response deadline) and `max_retries=0`, so a stall raises once instead of after
  quiet retries and `get_chat_completions` can fall back to gpt-oss-20b at once.
  Verified against a real hung socket (accepts, never answers): a standalone script confirmed
  the client raises in 0.53s against a 0.5s configured timeout (not the 600s default); 4 tests
  cover the client's own config and the hung-socket path, mutation-checked (restoring the old
  timeout/retries makes the hung-connection test hang instead of pass). Not yet seen against a
  real Groq stall; the only live 11s stall was before this fix.
- **`end_call` no longer fires on a question (2026-10-12).** Live-found: the owner's own test
  call asked "are you recording this?" and the model hung up. The tool's description (shared
  across every persona, not persona-specific) was tightened: an explicit ending signal only,
  the exact failure phrase named as a negative example, and "ask, don't guess" for anything
  ambiguous. Not yet re-verified live (needs the owner to say the same phrase again); the
  owner's next local test call is the way to confirm it.
- **Groq usage logging (2026-10-12).** Audited the whole codebase for anything that could call
  Groq without the owner starting it: no cron/interval/scheduled job does, and every existing
  retry (summary.py's 4-attempt backoff, the LLM fallback) was already bounded, so neither
  needed a cap added. Added `groq_usage.py`: every real Groq call appends one line to
  `logs/groq_usage.log` (timestamp, caller, model). Wired into all five call sites found (the
  live per-turn LLM call and its fallback, the post-call summary, the startup warm-up, and the
  two manual diagnostic scripts). Verified live: ran `check_providers.py` for real and got the
  expected single log line. 4 unit tests, mutation-checked.
- **`/ws` rate limiting (2026-10-12).** Two independent, in-memory, no-I/O limits ahead of any
  pipeline work: `WS_RATE_LIMIT_PER_MINUTE` (default 5, per IP, a rejected attempt doesn't
  count against the quota) and `WS_MAX_CONCURRENT_CALLS` (default 10, across every IP). A
  rejection closes with code 1013 and logs the IP and which limit fired. `stream()` was split
  into itself (auth + rate limit gate) and a new `_run_call()` (the actual pipeline work) so
  tests could exercise the gate against the real FastAPI route without needing a real pipeline
  (`build_worker` needs live provider keys). 14 unit tests on the limiter itself + 6 integration
  tests against the real `/ws` route (normal connection passes through; per-IP rejection and its
  close code; the rejection log's content; global-cap rejection; a rejected attempt never holds
  a concurrent slot). Mutation-checked: disabling the limiting logic fails 10 of these tests.
  Flagged to the owner: the 5/minute default is a guess, and a weak signal for real traffic
  specifically, since Plivo's media connections come from a shared IP pool, not the caller's
  own address — the global cap is the one that actually bounds concurrent Groq usage. This is
  a safety net; it is not the Plivo webhook signature validation still open in section 6, and
  does not touch the existing `WEBHOOK_SECRET` check.

- **Groq Developer plan (2026-10-24).** One 5-token request; live headers
  `x-ratelimit-limit-tokens: 250000`, `x-ratelimit-limit-requests: 500000` (was 8,000 / 1,000).
  No call has been made on the new plan yet, so "no more 429s or fillers" is expected, not seen.
- **Cartesia TTS (2026-10-24).** `TTS_PROVIDER=cartesia` builds Pipecat's `CartesiaTTSService`
  from `CARTESIA_API_KEY`, `CARTESIA_VOICE_ID` (required), `CARTESIA_MODEL_ID` (default
  `sonic-3.6`), `CARTESIA_LANGUAGE` (e.g. `hi`), `CARTESIA_SPEED` (0.6-1.5, else startup stops).
  It follows the caller's language like the other multilingual voices
  (`MULTILINGUAL_TTS_PROVIDERS`, decided in `voice_follows_caller_language()`), and can be a
  `TTS_FALLBACK_PROVIDER`. Built test-first: 12 tests in `test_cartesia_tts.py` and 7 in
  `test_check_cartesia.py`, each shown red before the code; four mutations caught (the first
  version of the language-follow test missed one and was rewritten). Live: `TTS_PROVIDER=cartesia
  python scripts/check_providers.py` passes. Benchmark (scratch script over each raw websocket,
  owner's Mac, 6 requests each, Hindi and Hinglish, time from send to first audio): Cartesia
  median 0.082s, Smallest median 0.178s. Small and from India-to-wherever, not from the pipeline.
  Live probes: 8kHz output works; wrong key gives HTTP 401 with no key in the text; unknown
  voice and empty text return `type: error` replies; a 5,000-character request is synthesised
  in full; **the 3rd to 6th concurrent connection get "You have reached your concurrency limit
  of 2"**. The owner chose **Neha** (`47f3bbb1-e98f-4e0c-92c5-5f0325e1e206`); other Hindi
  voices tried: Meera `a81fccdc-5595-4dfc-ae76-4de6a515b8a2`, Siya
  `4459a9a5-69d6-4680-b970-e13dc51845b6`, Diya `d2d3584d-1b44-428e-aab1-30255d28d978`.
- **Latency on the real Cartesia call `ad57ba2c` (`latency_summary.py --run 20261023T212110`).**
  Caller wait 608-1,546ms, avg 974, p50 917 (12 turns); turn detection avg 356ms; reply after
  turn avg 572ms; Deepgram STT 588-658ms (avg 632, n=4); Groq TTFB 132-202ms (avg 153, n=5);
  Cartesia TTFB 73-86ms (avg 79, n=9), first audio 194-230ms (avg 210, n=4). Only some turns were
  logged per stage (interruptions cut the rest), so the per-stage n is small. Measured inside the
  server: the ngrok/Plivo/phone-network leg is not included.
- **Cost estimate for a call like `ad57ba2c` (2026-10-24), per minute:** Plivo $0.0048 (real CDR
  rate, bills whole minutes); Deepgram $0.0071-0.0105 (nova-3 multilingual streaming plus
  keyterms; third-party sources disagree on the base rate); Cartesia ~$0.017 on Startup ($49 /
  1.25M credits, ~1 credit/char, ~440 chars/min on this call); Groq ~$0.0016 (**estimated**,
  scaled from the 15 Oct token count; tokens are not logged per call). Total ~$0.028-0.034/min.
  Prices from third-party pages, not checked on the providers' own pricing pages.

- **Model and pronunciation experiments (2026-10-24), all live API, none on a call yet.** See the
  three CLEANROOM rows of that date: 120b-low vs 20b vs medium effort; the "into" rule (2/12 and
  4/12 multiplied correctly without it, 10/12 and 9/12 with it, 12/12 division phrasings still
  divided); Cartesia English mode clean for all voices, Hindi mode mangles "Kaho AI" for all, and
  inline IPA does not help. English-mode greeting samples of Neha, Arushi, Ishani, Swati, Kiara
  and Palak saved for the owner in the session scratchpad (`voices_en/`, temporary). 356 tests.

- **The one real call on gpt-oss-120b (`0d5723b4`, 215s, to Ayushi, 2026-10-24).** No 429s,
  no errors, no junk `capture_lead`, `end_call` only on "No. That's it.", no complaint about
  "Kaho AI" (greeting in English mode). Caller wait p50 992ms but avg 1,525ms / worst 3,713ms:
  four turns hit the ~3s turn-detection ceiling when the caller paused mid-sentence. Groq TTFB
  238ms avg (vs 153-179 on 20b). Cartesia TTFB 252ms vs 79-102ms earlier the same day; a direct
  probe straight after gave ~400ms in **both** English and Hindi mode, so the language setting is
  not the cause; Cartesia itself was slower, reason unknown. 120b's replies were long compound
  sentences and were cut off 11 times. The caller steered the default persona into a detailed
  sex-education explanation; it answered, since the default persona answers general questions.

## 5. UNVERIFIED (assume nothing)

Never claim any of these works until a real call shows it.

**Rate limiting and Groq logging**
- `/ws` rate limiting has only been driven through FastAPI's `TestClient`, never a real
  websocket client over the network or a real Plivo connection. The close code (1013) and
  the rejection log have not been seen outside a test. TestClient also could not hold two
  genuinely concurrent `/ws` connections open from one process (see section 7), so the
  global-cap test fills the slot directly through `ws_limiter()` rather than a second real
  connection — the limiter's own accounting is unit-tested instead (`test_rate_limit.py`).
- Groq usage logging has been seen live for exactly one call site (`check_providers.py`); the
  other four (the live per-turn LLM call and its fallback, the post-call summary, the startup
  warm-up) are wired the same way but not yet each individually confirmed against a real call.

**CI**
- **CI gate closed 2026-10-05: #31 is green on `cb7771b`.** `c11d7c2` fixed the flaky
  recording test. The #29 hang is still unexplained: it never reproduced locally (23 container
  runs total at 2 and 0.7 CPUs across two sessions) and hasn't recurred on GitHub either. With
  `c11d7c2`, a repeat would dump every thread's stack after 120s on one test and the job would
  stop at 15 minutes, so a future hang is now bounded and diagnosable instead of silent.
- Recordings line the two sides up only to about 0.1s: Pipecat's resampler hands audio over
  in bursts and the sides are matched at those. The last ~0.1s of each side stays in the
  resampler and is never written.

**The real-call path (mostly closed 2026-10-15/16 — see section 1)**
- Real inbound and outbound calls both work, so the items that used to sit here are gone.
  What is still unproven on a real call: **concurrency** (two calls at once has never
  been tried; the owner asked for a parallel test and it was deferred until the Groq tier
  is fixed, since both calls would otherwise sit in 429s), `transfer_to_human` against
  real Plivo, and `call_webhook`.
- **Hindi end to end has not happened on a real call.** The *voice* is proven (Smallest
  speaks Devanagari and Hinglish) and the model mirrors the caller's language in an
  isolated test — it answered "नमस्ते, आप कौन हैं?" with "नमस्ते, मैं आयुषी हूँ, काहो एआई से कॉल
  कर रही हूँ।", with correct feminine grammar. But every real call so far has been in
  English, and nothing *enforces* the reply language: `FollowCallerLanguage` retunes the
  TTS only, and the code comment says "the LLM follows the caller on its own". Hinglish is
  where models drift back to English mid-reply.
- `ring_timeout` and `time_limit` were accepted by real Make Call requests, but their
  effect has not been observed (no call was left to ring out or hit the Plivo backstop).
- Voicemail / answering-machine detection is not implemented: a call that reaches
  voicemail will be talked to.
- The `sales` persona is a generic template that states no business facts; edit it with
  the real business before anyone is dialled.

**New on 2026-09-29 (all simulated or unit-tested only)**
- Plivo's call-transfer API request (`legs=aleg`, `aleg_url`, `aleg_method`) is from memory;
  whether Plivo then plays `<Speak>` and dials the number is unseen. A transfer also ends our
  websocket; the disconnect handler then cancels the pipeline (not exercised for this case).
- The interruption filter has never been felt on a real call.
- Call recordings have not been listened to by a person (checked by levels and timings) and
  have not run on a real Plivo call. Neither has the recording notice been heard on one.
- **Words at the edge of a split turn can be lost.** When STT splits one sentence into two
  turns ("Hi there." / "...can you help me with today?"), a word in the gap went missing in 3
  of 8 simulated calls: "today?" once before the notice existed, "What" twice after. Not
  caused by the notice's mute (released seconds earlier). Not investigated.
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

**Cartesia (new 2026-10-24)**
- One real phone call only (`ad57ba2c`), never on the local mic, never two calls at once.
  Interruption and Hindi were seen working on that call; the language retune itself
  (`FollowCallerLanguage`) was not checked in the logs.
- What the caller hears when Cartesia returns an error mid-call (for example the concurrency
  limit) is reasoned, not run: Pipecat's service pushes an error but its socket stays open, so
  `CallHealth` may not see it as dead and fail over. See the pen-test findings in section 6.
- Number and Aadhaar-style digit reading in Hindi not checked by ear.

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
- Bedrock/Claude Haiku 4.5 is not the LLM (Groq `openai/gpt-oss-20b` is, pinned); `BEDROCK`
  is stubbed.
- Prompt caching (not applicable to the current Groq path; unmeasured).
- Per-agent language setting in a config file, and 5 sample conversations per language with a
  pronunciation check: needs a person's ear. Sarvam is ruled out; the Hindi voice is to be
  Smallest, which has not run live.
- Audio recording: built 2026-10-02, unmasked, deleted after `RECORDING_RETENTION_DAYS` (60),
  by the owner's decision. The owner is taking the deeper DPDP / Aadhaar Data Vault question to
  a CA; it does not block development.
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
warning, `scripts/talk.py`. **Done 2026-10-02, pushed; CI confirmed green 2026-10-05
(run #31 on `cb7771b`):** call recording, 60-day retention, the recording notice, the
hung-LLM fix, the recording-test flakiness fix. **Done 2026-10-05, pushed; CI confirmed
green the same day (run #32 on `bfc5b0c`):** the `end_call` deadlock closed (`dc9f891`),
the LLM request's own timeout (`02b03d2`). **Done 2026-10-12, pushed; CI confirmed green
the same day (run #34 on `eeef867`):** LLM pinned to `openai/gpt-oss-20b` only
(`f36d5ae`), `end_call` no longer fires on a question (`c0172d4`), every Groq call logged
to `logs/groq_usage.log` (`05f42d5`), and `/ws` rate limiting as a safety net ahead of the
signature validation below (`eeef867`). Remaining:

1. ~~**Upgrade the Groq plan.**~~ **Done 2026-10-24**: Developer plan, 250K TPM, confirmed
   from the live headers. Next is a real call on it to see the 429s and fillers gone. The note
   from before: the account was on the free tier: the live headers say `x-ratelimit-limit-tokens: 8000`, where Developer is
   250K TPM. One 163s call sent 25,265 prompt tokens over 15 completions (~9,300/min), so
   exceeding the cap is structural, not bad luck. It is the cause of every 429, every
   audible "One moment" filler, and all six qwen fallbacks on `93d0957f`. It costs almost
   nothing to fix — Groq was about **$0.002 of a ~$0.04 call** — and nothing else moves
   the caller's experience as much. **Verify from the headers, not the billing page**: the
   2026-10-12 note recording the owner saying the plan was upgraded was wrong.
2. **`capture_lead` saves junk (seen again, worse, on `ad57ba2c`: item 14).** On `93d0957f` it wrote `{"name": "?", "reason": "?"}`
   to `leads/`, called with placeholder arguments while the model was mid-stall and being
   interrupted. Same family as the two `end_call` bugs: a tool fired without real intent.
   The persona already says to read the details back and only save after a yes, so the
   fix probably belongs in code (refuse obviously empty values at the wrapper) rather
   than in another sentence of prompt. Not started.
3. **Where call data is stored.** Everything is local files on the owner's Mac today —
   `logs/calls/` (52K, masked), `recordings/` (17M, unmasked), `leads/`, all gitignored.
   The owner wants Supabase. Agreed shape, not yet built: transcripts/summaries/leads
   into Postgres **through `CallTranscript` so masking cannot be bypassed**; recordings
   into object storage, but two decisions are the owner's first — the Mumbai region (DPDP
   data residency, same reasoning as hosting in `ap-south-1`) and whether unmasked audio
   goes to the cloud at all. Uncompressed stereo WAV is ~1.8MB/min (5.0MB for a 163s
   call), so encode to Opus before uploading anything: a 1GB free tier is about two days
   at 100 calls/day. **Upload after `call_end`, never on the call path** — a cloud write
   that hangs mid-call is the hung-LLM incident again.
4. **STT fragmentation, which is also the biggest remaining latency cost.** Deepgram
   splits one sentence into several turns ("Okay. So" / "what do you do?"), which costs
   three ways: extra LLM completions (token burn, hence the 429s), partial sentences
   reaching the model, and spurious tool calls. `endpointing` and `utterance_end_ms` are
   both supported by `DeepgramSTTService.Settings` and **neither is set today**; those
   plus `VAD_STOP_SECS` and the smart-turn classifier are the knobs. Turn detection is
   the dominant share of the caller's wait (avg 1.377s, worst 3.05s on the last call).
   Tune against `caller_wait` and the INCOMPLETE/COMPLETE ratio, not vibes.
   Noise suppression is a *separate* and smaller question: Pipecat ships `rnnoise_filter`
   (free), `koala_filter`, `krisp_viva_filter` and `aic_filter`, and none is wired
   (`audio_in_filter` is unused). Expect little from it on a phone call, since Plivo
   delivers 8kHz mu-law and no filter restores what the codec discarded; it is worth more
   on the local mic path.
5. **Barge-in lag is 486ms, not the <300ms the owner asked for** (`231, 235, 279, 799,
   887 ms` on `93d0957f`). The owner chose to keep the words-only filter
   (`INTERRUPT_FILTER=true`) rather than revert to raw VAD, accepting that coughs and
   backchannel must not interrupt. So the floor is STT latency; tune `INTERRUPT_MIN_WORDS`
   and look for buffer-flush lag above that floor rather than expecting <300ms.
6. Plivo V3 webhook signature validation (replaces the shared-secret token as the main
   guard; do it against a real request). `/ws` now also has a per-IP and a global-concurrent
   rate limit (2026-10-12) as a safety net ahead of this, not a replacement for it.
7. Concurrency (the owner's parallel-call test is still owed), and deploying to `ap-south-1` before real traffic (see CLAUDE.md).
8. Full regression across English/Hindi, inbound/outbound. Telephony now works, so this
   is no longer blocked — what it needs is the Groq tier (item 1) so results mean something.
9. Still owed to the "done" standard: a proper latency benchmark for the phone path (only
   smoke timings and the small backup-TTS comparison exist), and a PII test suite that
   covers every store of call content (transcript, summary, leads, failure markers) as
   one suite instead of individually.
10. Optional hardening: a backup STT provider; voicemail detection for outbound calls; a
   live test of a provider that hangs rather than errors.
11. The owner's "CLAUDE.md §4" and "what done looks like" checklist are still not in the
   repo (see section 0). Ask for them and add them.
12. **Cartesia is the default (decided 2026-10-24); what it still needs.** A paid plan before
   real traffic: the free plan allows 2 concurrent connections and ~10-20K characters a month
   (~25-45 minutes of calls like `ad57ba2c`). Consider `TTS_FALLBACK_PROVIDER=smallest` (its key
   is set), but see item 13: a Cartesia error may not trigger failover. Log Groq token counts per
   call so cost stops being an estimate.
13. **Pen-test findings on the Cartesia change, reported not fixed (2026-10-24).** Owner decides:
   - Concurrency limit of 2 on the free plan (run live): a 3rd parallel call gets no Cartesia audio.
   - An error reply mid-call may not trigger failover (reasoned): the socket stays open, so the
     caller could hear silence until `RESPONSE_DEADLINE_SECS` (10s) ends it.
   - `check_cartesia` reads the error from an `error` field, but Cartesia's real replies carry it
     in `message` (run live); the check still fails correctly but prints the whole reply, and the
     unit test's fake uses the wrong shape.
   - Caller-facing text, including read-back details, goes to another US provider (reasoned);
     part of the DPDP question already with the owner's CA.
   - The Cartesia key was pasted into the chat (it is in the session transcript). Rotate it if
     that matters.
   - Pre-existing, found this session: `.env.example` holds real keys in the working tree.
15. **Bugs on the calls to Ayushi (`4f6452c9`, `188ae535`), reported not fixed (2026-10-24).**
   - `end_call` hung up on a caller who wanted to keep talking, twice: on "Sorry to interrupt
     you." (with junk args `{"": ""}`) and on "1 more time." Highest priority.
   - `capture_lead` saved junk on both calls (`name: "?"`, and the agent's own name 4s in).
   - The agent looped "Please share your name and what you'd like us to note" three times and
     promised to "fix" the name, which it cannot do.
   - "Kaho AI" mispronounced; cause found and partly fixed (see the header and CLEANROOM).
   - Still open after the fix: the name inside Hindi sentences.
17. **Pen-test of the Google voice, reported not fixed (2026-10-24).**
   - Run live: a rejected request (bad key; the same would happen past a quota) produces no audio
     and the service still reports itself usable, so the switch to the Smallest backup likely
     does not happen; the caller hears silence until the 10s response deadline. Same as Cartesia.
   - The API key was created unrestricted and was pasted into chat. Restrict it to the
     Text-to-Speech API in the Google console; anyone holding it can bill the project.
   - Past 1M characters a month Google bills silently at $30/M: no budget alert or quota cap is
     set, and the agent does not count characters.
   - Adds the gRPC/google-cloud stack to `requirements.txt` (`pipecat-ai[...,google]`); CI has
     not run with it yet.
   - Not heard by a person: English "Kaho" transcribes as "Caho" on most voices (likely the same
     sound); Hindi as "कहो".
16. **From the 120b call `0d5723b4`, reported not fixed (2026-10-24).** Replies too long (cut off
   11 times): cap length in code, not only in `VOICE_RULES`. ~3s waits when the caller pauses
   mid-sentence (4 of 14 turns): the turn-detection ceiling, part of item 4. The default persona
   has no topic boundary. Cartesia latency swung from ~80ms to ~400ms within hours; re-measure.
14. **Bugs seen on the real Cartesia call `ad57ba2c`, reported not fixed (2026-10-24).**
   - `capture_lead` fired 3s in, before the caller spoke, saving `name: "Aayushi"` (the agent's
     own name), `reason: "Introduction"`; later saved `name: "?"` again. Both in
     `leads/2026-10-23.jsonl`. Item 2, now worse.
   - STT heard "Kaho AI" as "Cairo AI" in a Hindi sentence; the agent said it had no information
     on it. `DEEPGRAM_KEYTERMS` did not help there; the persona also says nothing about Kaho AI.
   - A Hindi question got an English reply (nothing enforces the reply language).
   - One reply said the same sentence twice ("मेरा नाम आयुशी है…").
   - The filler "One moment." played while the caller was still talking: the 3s timer kept
     running from a turn the caller then continued (log 02:52:11-14). It is also English-only.
   - STT split one Hindi sentence into 3 turns (item 4).
   - "Aচ্ছা" came back partly in Bengali script, so the summary lists Bengali as a language.

## 7. Gotchas that cost time

- **Port 8000 is shared with the owner's PayTrace API.** It binds `127.0.0.1:8000`, which wins
  over our `0.0.0.0:8000` for `localhost`, so ngrok silently forwards to PayTrace and the Studio's
  pre-dial check gets a 404 ("server not started"). Run ours on `PORT=8010` and point the tunnel
  there (ngrok local API, or `ngrok http 8010 --url open-buckskin-wolverine.ngrok-free.dev`).
- **zsh treats a word starting with `=` as a command lookup**: `echo =====` fails. Quote it.
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
- Groq returns 429 after repeated smoke runs on this account. Space them out. A stall can
  also show up only as a long LLM TTFB (11s on 2026-10-02) with no 429 in the log: the OpenAI
  client underneath retries quietly.
- `macOS sed` differs from GNU sed; use Python for scripted edits.
- The default persona said "you are not a business", which made the model refuse
  callbacks; the "Leaving details" section now overrides that explicitly.
- **Pipecat's worker `ProcessorUnusablePolicy` acts on the failed service even when
  a backup exists**, so leave it on CONTINUE and decide in `CallHealth`.
- An `ErrorFrame` can arrive a moment before its processor's `is_usable` flips;
  `CallHealth` re-checks 0.5s later for that reason.
- A `ServiceSwitcher` pushes its own error once every service behind it is dead;
  that frame's processor is the switcher, not a service.
- Frames queued on the worker enter at the start of the pipeline and wait behind the LLM's
  current request. Push from the LLM (`llm.push_frame`) anything that must get past a busy
  LLM; send an `InterruptionFrame` first when the request itself should be dropped.
- Pipecat waits for an EndFrame to cross the whole pipeline, with no time limit, before it
  acts on a cancel (`PipelineWorker._wait_for_pipeline_end`). Never end a call from failure
  handling with an EndFrame.
- Observers see a frame at every hop, and the output transport sends each "bot started/
  stopped speaking" in both directions: count downstream copies, once per frame id.
- The hung-LLM harness: a local TCP server that accepts and never answers, and a wrapper
  that sets `base_url` on `PortableGroqLLMService` before `server.main()`.
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
- Never assert `==` on long sample lists: a failing pytest diff printed every sample and made
  one CI log 10MB. Compare lengths, onsets and loudness instead.
- Pipecat audio in tests: caller audio is a system frame and agent audio a data frame, so a
  busy machine interleaves them differently. Send the user/bot started/stopped speaking frames
  around each side's speech, as a real call does, or the recorder pads silence inside speech.
  Its resampler emits in ~0.1s bursts and resets after 0.2s idle (`clear_after_secs`).
- FastAPI's `TestClient` cannot cleanly hold two genuinely concurrent `/ws` connections open
  from one test process (tried it for the rate limiter's global-cap test; it hung). Fill the
  limiter's state directly through its own object instead of a second real connection when a
  test needs "already at capacity" as a starting condition.
- Local mic/speaker echo looks exactly like a pipeline bug: open speakers feeding back into
  the mic gets transcribed as the caller repeating the agent's own words, which then
  self-interrupts the agent (barge-in reacts to real words). Seen live 2026-10-11, fixed with
  headphones, no code involved. Check the transcript for a "user" turn that is literally the
  agent's last sentence before suspecting the pipeline.
- A single `git push` triggers GitHub Actions once for the whole push, not once per commit
  (`on: [push]`): pushing four commits together shows one CI run on the Actions page, named
  after the top commit, not four.
- **Dedupe frames on Pipecat's `frame.id`, never `id(frame)`.** The memory address is reused
  by CPython once a frame is collected, so a later frame can inherit a "already seen" id and
  be silently dropped. It passes in isolation and fails only under the full suite, where GC
  actually runs. `resilience.py` does it correctly; the `MetricsFrame` dedupe in
  `TurnTimingLogger` still uses `id(frame)` with an unbounded set (pre-existing, left alone).
- Pipecat's own metrics only start when a *service* is handed work, so they cannot see the
  VAD + smart-turn wait in front of it. Read `caller_wait` from `latency_summary.py` to judge
  a call; the stage sums understated the real wait by 2-5s on the first phone calls.
- `check_providers.py` must call `ensure_ca_bundle()`. Its Smallest check is the only one over
  a raw websocket, so it is the only one without certifi behind it, and it reports a dead
  provider on the python.org macOS build when the key is fine.
- Smallest's websocket returns audio **base64**-encoded, not hex.
- ElevenLabs free plan: Voice *Library* voices are rejected over the API (402), but the
  **premade** voice Sarah (`EXAVITQu4vr4xnSDxMaL`) works and speaks Hindi. The earlier note
  that every voice was blocked was wrong. A text-to-speech-scoped key cannot list voices or
  read quota (`missing_permissions`).
- **Do not trust a stated Groq plan.** Read `x-ratelimit-limit-tokens` off a live request:
  8000 means free tier, 250000 means Developer.
- Plivo's CDR (`GET /v1/Account/{id}/Call/`) gives the actual billed cost per call, which
  beats arguing with published rate cards (their India pages disagree with each other).
- A persona instruction that pins an exact phrase can swallow everything around it: telling
  the model to say "I am calling from Kaho AI" made it answer *every* identity question with
  only that line, name included. Give the facts and one example, not a script.
- Placing a call from the agent can be blocked by Claude Code's auto-mode classifier as a
  real-world transaction, and a one-off approval does not always carry. The owner running
  `! apps/voice/venv/bin/python scripts/call.py ...` in the session works; a scoped `Bash`
  permission rule for the dialler is the durable fix, and is the owner's call to add.

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

**2026-10-02.**
- Reviewed this file against git (clean, level with origin) and fixed its stale notes
  (`1cdd6a3`). Mapped the owner's 15-item plan to what is built, partial and missing.
- Owner's decisions: Sarvam is out; every call is recorded; at first with no announcement
  and no automatic deletion, then the same day a "This call may be recorded." notice (on by
  default) and 60-day retention. The DPDP / Aadhaar Data Vault question is with the owner's CA.
- `1a04ecb`: call recording. Measured that Pipecat's own chunked hand-over puts gaps into
  speech and drifts; wrote chunking that hands over only audio both sides cover.
- A live run showed the filler unheard during an 11s Groq stall. Reproduced a hung LLM live:
  45s of silence and the call never ended (filler, apology and EndFrame queued behind the
  request; Pipecat would not cancel past the EndFrame). Also found the speech observer
  counting every hop. Fixed in `0c74c53`; the same live run then heard the filler at 5s and
  15s and the apology at 22s, and the line closed at 28s.
- `e37a64e`: retention (checked on a real server start). `1d6c4d7`: the notice, live-verified
  including an early "Hello?" and a hung greeting after it.
- The owner's go-ahead arrived as pasted text; confirmed with one question before acting.
- Pushed the five commits for CI: red. One recording test failed on #27, #28 and #30; #29
  hung and was cancelled through Chrome. Reproduced the failure in a CI-like container (frame
  interleaving under load, not the chunking) and fixed the test in `c11d7c2`, verified locally
  only. The hang did not reproduce.
- Also noticed, not fixed: words lost at the edge of a split turn; `end_call` can still
  deadlock behind a hung LLM; the LLM request has no deadline of its own (section 5).
- Interrupted while looping the new test in the container; the owner asked to update this file
  and save. Nothing pushed after `1d6c4d7`. Next: push and confirm CI green, then the first
  Plivo calls once the credentials arrive.

**2026-10-05.**
- Reviewed this file against git: clean, local commits `c11d7c2` and `cb7771b` not yet
  pushed, matching what the file said. Ran the full local suite (299 passed) and ruff
  (clean) directly, and separately rebuilt the CI-like container from `HEAD` (Docker Desktop
  was not running; started it) and ran the exact CI steps (PortAudio install, `pip install`,
  ruff, pytest) there too: all green.
- Looped `tests/test_recording.py` in the container, 5 runs at `--cpus=2` and 5 at
  `--cpus=0.7` (10 total, the owner chose a smaller count over the original 15+15 plan):
  10/10 passed, no hang, continuing the previous session's interrupted attempt at this.
- Pushed `c11d7c2` and `cb7771b` to `origin/main` (owner said go ahead). Watched
  `github.com/ciphera125/KahoAi/actions` through the owner's Chrome: **CI #31 on `cb7771b`
  finished green in 1m24s.** The CI gate from the previous session is closed.
- Updated this file's state sections (2, 5, 6) and this log entry. The #29 hang from
  2026-10-02 never recurred, locally or on GitHub, and remains unexplained but now bounded
  (faulthandler dump + 15-minute job ceiling).
- Next: the first real Plivo calls (inbound then outbound), still waiting on the owner for
  credentials, a Plivo number, and a tunnel; see section 6, item 1.
- Committed the handoff update itself (`03c01b7`, local only).
- Asked to review the open work and fix what didn't need the owner. Items 1-2 (Plivo, Smallest)
  are blocked on credentials; picked the two reproducible defects in section 5 that were not:
  the `end_call` deadlock and the LLM request's missing deadline.
- Read Pipecat's source directly rather than guess: `_handle_function_call_result` in
  `llm_response_universal.py` runs the LLM again after any tool result unless
  `FunctionCallResultProperties(run_llm=False)` is set, confirming the deadlock's exact
  mechanism (a second, hangable request, not literally "Pipecat asks for a goodbye" as
  the old wording implied). `dc9f891`: tools can now be marked `ends_call=True`; `end_call`
  is. 3 new unit tests, mutation-checked.
- `02b03d2`: `PortableGroqLLMService.create_client()` sets its own request timeout
  (`LLM_REQUEST_TIMEOUT_SECS`, default 6s) and `max_retries=0`. Proved the client-level
  timeout actually fires (rather than trusting the OpenAI SDK's docs) with a real hung TCP
  server: a standalone script first (raised in 0.53s against a 0.5s timeout), then 4 pytest
  tests. One early version of the test hung in cleanup — not the fix — because Python 3.13's
  `Server.wait_closed()` waits for open connections too, which a server that never closes its
  one connection blocks forever; fixed by aborting every accepted connection before closing.
  Mutation-checked both fixes (reverting either makes its new test fail/hang instead of pass).
- Full suite (306 tests) and ruff clean; committed as two commits, neither pushed (the owner's
  go-ahead to push was for the CI-gate commits specifically, not standing permission).
- Next: ask the owner whether to push `dc9f891` and `02b03d2`; then still the first real Plivo
  calls once credentials arrive (section 6, item 1).

**2026-10-05, continued.**
- Owner said to push. Pushed `03c01b7`, `dc9f891`, `02b03d2` and this file's update
  (`bfc5b0c`) to `origin/main`. Watched the Actions page through the owner's Chrome: **CI #32
  on `bfc5b0c` is green, 1m24s**, same as #31. `origin/main` and local are level; nothing
  outstanding.
- Owner pasted the original 15-item build plan and asked whether it was all done. Answered
  item by item from this file, without re-deriving or re-testing anything already confirmed
  here: most engineering-only items are done and real-tested (masking, resilience, duration
  limits, tools, recording, post-call summary); the Bedrock-to-Groq LLM swap was named as the
  one deviation running through several items; the three real-call-dependent items (telephony,
  outbound dialling, Hindi pronunciation, the 20+20 shakeout) are the ones still open, same as
  section 6.
- Gave the owner the concrete Plivo setup steps (buy a number, create the XML application with
  an Answer URL pointing at `PUBLIC_HOST`, get the Auth ID/Token, run `ngrok http 8000`) and the
  exact env values to send back (`PLIVO_AUTH_ID`, `PLIVO_AUTH_TOKEN`, `PLIVO_FROM_NUMBER`,
  `WEBHOOK_SECRET`, the ngrok host, plus `TRANSFER_NUMBER` and optionally `TOOL_WEBHOOK_URL`).
  Nothing has arrived yet.
- Next: still waiting on the owner for the above; once they arrive, start section 6 item 1
  (the first real Plivo call, inbound then outbound).

**2026-10-12.**
- Reviewed this file against git (clean, level with origin at `531ae05`, the `bfc5b0c` gap
  from 2026-10-05 already closed). No code had changed since; still waiting on Plivo.
- Owner ran the pipeline locally themselves (`apps/voice/main.py`) and reported it "talking
  badly" with pauses. Read `logs/turns.jsonl` and the call transcript: latency was normal
  (STT/LLM/TTS all sub-second); the transcript showed "user" turns that were literally the
  agent's own last sentence — acoustic echo from open speakers into the mic, not a pipeline
  bug. Fixed with headphones, no code touched. Confirmed clean on the next run.
- That clean run's transcript showed the model calling `end_call` on "Are they recording you
  to think what I'm saying?" — a live-found bug. `c0172d4` tightened `end_call`'s tool
  description: explicit ending signal only, the exact phrase named as a negative example,
  "ask, don't guess" for anything ambiguous.
- Owner said to pin the LLM to `openai/gpt-oss-20b` only, not Grok (clarified: meant Groq's
  own `gpt-oss-20b`, not xAI's Grok, which was never in this repo). `f36d5ae`: `GROQ_MODEL_ID`
  default changed, `qwen/qwen3.8-27b` removed from every live config and test fixture (two
  historical docstring mentions of why the role-rewrite exists were left alone, since they
  explain a real fix, not a config). `LLM_FALLBACK_MODEL_ID` now defaults to `off`, since
  there is no second approved model; the fallback mechanism itself is untouched.
- Checked whether the account's new Groq Developer plan needed any retry/backoff code
  changes: no, since neither `summary.py` nor the LLM fallback hardcodes a numeric rate
  limit — both only react to whatever `Retry-After`/status the provider actually sends.
- Owner worried about unexpected background Groq usage. Audited the whole codebase for
  cron/interval/scheduled jobs (none touch Groq) and every retry loop (already bounded, no
  cap needed). `05f42d5`: `groq_usage.py`, an append-only `logs/groq_usage.log` line per real
  Groq call, wired into all five call sites found. Verified live via `check_providers.py`.
- Owner asked for rate limiting on `/ws` as a safety net ahead of the still-open Plivo
  signature validation. `eeef867`: `rate_limit.py` (`ConnectionLimiter`), a per-IP-per-minute
  cap and a global concurrent cap, checked right after the `WEBHOOK_SECRET` check and before
  any pipeline work; `stream()` split into itself (the gate) and `_run_call()` (the pipeline)
  so this could be tested against the real FastAPI route without needing live provider keys.
  Flagged to the owner that the per-IP default is a weak signal for real traffic specifically,
  since Plivo's media connections share an IP pool; the global cap is the one that matters.
- 329 tests pass, ruff clean, all four groups mutation-checked (model-pin: existing suite
  still exercises the fallback-disabled path; groq logging and rate limiting: breaking each
  on purpose failed the relevant new tests).
- Committed as four separate commits by concern (`f36d5ae`, `c0172d4`, `05f42d5`, `eeef867`),
  each self-contained (new modules land in the same commit as their first import). Pushed;
  **CI #34 is green, 1m12s**, confirmed by screenshot — one run covers the whole push, not
  one per commit (see section 7). `origin/main` and local are level.
- Next: still waiting on the owner for Plivo credentials, a number, and a tunnel (section 6,
  item 1). Everything built this session is independent of that and does not block it.

**2026-10-15 / 2026-10-16. The first real phone calls.**
- Reviewed this file against git (clean, level with origin at `4e28b58`). Then the owner
  supplied Plivo: auth id/token, the number `+918065520552` (KYC done), and `ngrok`. Added a
  Telephony section to `.env`, generated `WEBHOOK_SECRET`, read the ngrok host from its local
  API, and confirmed the tunnel reached the server (a bare `/answer` correctly 403s).
- **First real call ever** (`7bdd07c8`, outbound, 92s). It worked, then ended wrongly: the
  model called `end_call` while its own reply said "Sure, go ahead". Root cause was not the
  duration limit or a crash — a Groq 429 stalled the turn, the caller repeated themselves,
  and the model treated that as a goodbye. Fixed in `1c8ccee`; a test now locks the wording.
  That work exposed a pre-existing test bug too (`fe4d08e`): the missing-config test was
  reading the real `.env` and had only passed while those lines were blank.
- Owner asked for the qwen fallback back on; `bed7be2`. Proven live the same day (6 events).
- Owner set `TTS_PROVIDER=smallest` with no key, which would have killed the next call at
  `build_tts` (`sys.exit(1)`); caught before dialling. The key took three attempts to land on
  disk. Then `check_providers.py` reported Smallest dead — a false failure, because it never
  called `ensure_ca_bundle()` (`291b5dc`). **Smallest then ran live for the first time**, and
  Hindi was verified with real Devanagari and Hinglish, not just romanised text.
- Built the turn-phase instrumentation the owner asked for before any tuning (`04f4c6f`), and
  it immediately changed the story: the 4-7s waits were **not** batching (streaming was
  already on, per-sentence), **not** ngrok or network distance (~0.1s unaccounted), but turn
  detection — every outlier an `INCOMPLETE` where the caller paused mid-sentence. Caller wait
  p50 was 1.34s on the second call, with 10 of 14 turns inside 1.1-1.7s.
- Measured the real cost from Plivo's CDR: **$0.01425** for a 163s call, ~$0.04 all in, of
  which Groq is ~5%. Then found the thing that matters most: the account is on Groq's **free**
  tier (8,000 TPM), not the Developer plan this file recorded on 2026-10-12. Token burn is
  ~9,300/min, so the 429s are structural. Item 1 in section 6.
- Owner heard the `meher` voice and chose it, and renamed the agent: **Aayushi, calling from
  Kaho AI** (`fa1c7fa`). Testing the persona against the live model first caught a regression
  (the pinned phrase swallowed the name) before it reached a call. Added `Aayushi` and
  `Kaho AI` to `DEEPGRAM_KEYTERMS`.
- Called the owner's co-founder (`f4743723`); the owner called it "great" and the new identity
  landed verbatim. Claude's own dial was blocked by the auto-mode classifier as a real-world
  transaction, twice, including after a one-off approval; the owner ran the dialler himself.
- Also found and **not** fixed: `capture_lead` saved `{"name": "?", "reason": "?"}` on
  `93d0957f` (section 6 item 2). Barge-in lag measured at 486ms average, not the <300ms the
  owner asked for; the owner chose to keep the words-only filter, which sets that floor.
- Owner asked about voice isolation for cleaner STT. Answered that fragmentation, not noise,
  is the real problem and that `endpointing`/`utterance_end_ms` are unset — section 6 item 4.
  Nothing tuned yet: it needs real calls to validate, and the Groq tier first.
- Owner asked for Supabase for recordings and transcripts. Scoped, not built: section 6 item 3.
- 336 tests pass, ruff clean. Six commits by concern, then this update. Pushed at the owner's
  request; CI not yet confirmed green on it — **check the Actions page** (section 2).
- Next: Groq tier (item 1), then the deferred parallel-call test, then `capture_lead`, then
  the fragmentation/endpointing tuning with real calls.

**2026-10-24.**
- Reviewed this file against `git log`/`git status`: level with origin at `6b3b150`. Found the
  working copy of `.env.example` holding real Deepgram, Groq and ElevenLabs keys (not committed,
  not in history) and told the owner; left the file untouched.
- Owner set two new rules, added to `CLAUDE.md` ("How we build"): test-first always; pen-test
  every change and report bugs plainly without fixing them.
- Owner moved Groq to the Developer plan; confirmed from the live headers (250K TPM). Item 1 closed.
- Owner asked for free Hindi-capable STT/TTS options; shortlisted (Cartesia, Azure, Google Chirp
  for TTS; Sarvam STT, Gnani, Speechmatics for STT). Owner supplied a Cartesia key.
- Built Cartesia as a `TTS_PROVIDER` and a `check_providers.py` check, test-first (19 tests, red
  then green, mutation-checked). Live check passes; benchmark 0.082s vs Smallest 0.178s to first
  audio. Pen-tested it live: found the 2-connection limit and the error-field mismatch, among
  others (section 6 item 13). Not fixed, per the new rule.
- Corrected stale lines in `CLAUDE.md` (no telephony, Smallest never live) and here (fallback
  `off`). 355 tests pass, ruff clean. Nothing committed.
- Next: owner picks a voice from the samples; a real call on the Groq Developer plan; then the
  parallel-call test (now limited by Cartesia's 2 if it is the voice), then `capture_lead`.

**2026-10-24 (continued).**
- Owner asked Claude to dial them on Cartesia Neha. The auto-mode classifier blocked Claude's
  first `ngrok` start; a follow-up command then **blanked `PUBLIC_HOST` in `.env`** (Claude's
  mistake: it wrote before checking the tunnel was up). On the owner's direct request the second
  start found an ngrok already serving `open-buckskin-wolverine.ngrok-free.dev` (PID 3285);
  `PUBLIC_HOST` now holds that. Server started with `TTS_PROVIDER=cartesia`; `call.py` dialled
  the owner's own number (`ad57ba2c`). Owner: "perfect".
- Read the transcript, summary, leads, recording, server log and Groq usage; latency and cost
  are in section 4, bugs in section 6 item 14 (not fixed, per the owner's rule).
- Owner decided: Cartesia Neha is the default voice, Groq Developer the permanent plan. `.env`
  now has `TTS_PROVIDER=cartesia`; `check_providers.py` passes for Deepgram, Cartesia, Groq.
  `CLAUDE.md` updated to match.
- The server and the ngrok tunnel may still be running from this session.
- Next: fix `capture_lead` (items 2 and 14) when the owner asks; paid Cartesia plan before
  traffic; the parallel-call test; the Deepgram endpointing tuning (STT is now the slowest stage).

**2026-10-24 (later still).**
- Called Ayushi twice (owner approved via `/permissions`; a third attempt failed first because
  the Mac's resolver could not look up the ngrok host for ~40s, then went through). A live
  tracker script (scratchpad `watch_call.py`) followed the second call's turns, tools and
  latencies as they happened. Findings in section 6 item 15.
- Owner asked for: another Cartesia voice, a professional "Kaho AI", gpt-oss-120b, no qwen.
  Measured before changing anything (CLEANROOM, three rows): the voice was not the cause, Hindi
  mode was; the wrong multiplication was the word "into", not model size. Changed `.env`
  (`GROQ_MODEL_ID=openai/gpt-oss-120b`, effort `low`, fallback `openai/gpt-oss-20b`,
  `CARTESIA_LANGUAGE=en`) and `VOICE_RULES` (test first: `tests/test_voice_rules.py`, red then
  green). Restarted the server; `check_providers.py` passes on 120b. Left the voice as Neha
  pending the owner's ear on the English-mode samples.
- Owner asked not to be asked for permission; Claude lists permissions used at the end instead
  (saved to Claude's memory).
- Next: a real call on 120b + English-mode greeting; then `end_call` and `capture_lead` fixes
  when the owner asks.

**2026-10-24 (end of session).**
- Called Ayushi on gpt-oss-120b (`0d5723b4`); findings in sections 4 and 6 item 16. Owner then
  switched back to `openai/gpt-oss-20b` (effort medium, fallback off) and will say when to use
  120b. Server restarted on 20b; `check_providers.py` passes.
- Committed by concern and pushed at the owner's request; `.env.example` deliberately left out
  (it holds real keys in the working tree). CI result not checked from here.

**2026-10-24 (after the push).**
- Owner found Cartesia's free credits gone (172 left). Counted: the four Cartesia calls used
  ~4.5-6K characters; Claude's own benchmarks and probes used ~13-15K, including a deliberate
  5,000-character stress test. Told the owner; agreed to estimate credit spend before tests.
- Owner supplied a Google Cloud API key for Chirp 3 HD. Measured first (CLEANROOM), then built
  `GoogleChirpTTSService` test-first: 11 tests (a real bug caught: two language changes in a row
  lost the first), 6 for `check_google`, mutations caught. Live through the class: en, hi, bn
  (kept hi), en, no errors. `TTS_PROVIDER=google`, `GOOGLE_TTS_VOICE=Aoede`,
  `GOOGLE_TTS_LANGUAGE=en`, `TTS_FALLBACK_PROVIDER=smallest`; `check_providers.py` passes for
  Deepgram, Google, Groq, Smallest. 373 tests. Server restarted on it. Not committed.
- Pen-test findings in section 6 item 17.
- Owner asked for the most natural Hindi Google voice and for latency and spend logging. Leda
  chosen by a Deepgram-confidence proxy (CLEANROOM). LLM tokens and TTS characters now land in
  `logs/turns.jsonl` and `latency_summary.py` prints them (3 tests, red first; 376 total). The
  live tracker shows them too. Groq's streamed usage reaching the log is **not yet seen on a real
  call**. Server restarted on Leda. Not committed.
- Two calls on Google (`e39b7374` Leda, `718d2f63` Despina). Owner: "the most robotic voice".
  Built a phone-quality comparison set (Google Chirp x4, Smallest meher, ElevenLabs Sarah,
  Cartesia Neha); Gemini TTS needs the "Agent Platform API" enabled and was not sampled.
- **New, worst bug, not fixed:** on `718d2f63` gpt-oss-20b called `capture_lead` instead of the
  greeting, with `phone: null`; Groq rejected the whole completion ("parameters for tool
  capture_lead did not match schema: /phone expected string, but got null"), so the greeting was
  lost and the caller heard ~14s of silence and "One moment". The same tool-at-greeting bug saved
  junk leads on every call today. Fix order proposed to the owner: `capture_lead` gating and an
  optional `phone`, then turn detection (3s waits on every short reply), then `end_call`.
- Owner switched back to Smallest `meher`; backup is now Google Despina. Server restarted;
  `check_providers.py` passes for Smallest and Google. Not committed.

**2026-10-24 (capture_lead and end_call fixes).**
- `capture_lead` (tests first, 5 mutations caught): refused before the caller has said anything,
  for placeholder values ("?", "unknown", "N/A", a phone with no digits), and for a name the
  caller never said (Devanagari speech lets a name through, since it cannot be matched).
  `phone` now allows null in the schema. Root cause found live: on 6 of 12 greeting requests
  gpt-oss-20b called `capture_lead` instead of greeting (the greeting arrives as a "user"
  message). `tool_choice: "none"` does not help (Groq: "Tool choice is none, but model called a
  tool", 4 of 10); sending the greeting request with **no tools** gave 15 of 15 clean greetings.
  So `build_worker` holds the tools back for the greeting and restores them after the first
  assistant turn (or the caller's first turn, if the greeting never finished).
- `end_call` (tests first, 3 mutations caught): the last wrong hang-up (`fc2a2387`) was STT,
  not the model: the caller said "अच्छा" and nova-3 multi wrote "That's all." (re-transcribed
  from the recording: `hi` hears "अच्छा"). Code now requires the caller's words since the agent
  last spoke to contain a goodbye ("bye", "अलविदा", "hang up", ...) or a short no right after
  the agent asked "anything else?". Otherwise the model is told to keep helping. "That's all"
  alone no longer ends a call. Tool description aligned.
- Samples for the owner: all 37 female Hindi voices on Smallest `lightning_v3.1_pro`
  (`smallest_hi/`), and 7 written forms of the brand name on `meher` (`brand/`). 399 tests.
  Server restarted. Not committed.
- Owner asked for a plan (not code) for a local prompt-per-number website; plan given, waiting
  for "go".

**2026-10-24 (Prompt Studio).**
- Owner said go. Built test-first (33 tests, 3 security mutations caught): `prompt_store.py`
  (JSON file `data/number_prompts.json`, gitignored; atomic writes; 8,000-char cap; a corrupt file
  reads as empty and is never overwritten), `admin.py` + `admin_page.html` (Inter, aubergine,
  silver, marigold), served on **127.0.0.1:8001**, separate from the ngrok-exposed phone server,
  refusing any request with a non-local Host, a forwarding header or another site's Origin.
  Prompts are keyed by our Plivo number (+918065520552, from `PLIVO_FROM_NUMBER`). The phone
  server reads the store at the start of every call (`server.persona_text_for_call`); a saved
  prompt wins over `--agent` and the default file; VOICE_RULES still lead; the store can never
  fail a call. 432 tests, ruff clean. Seen rendering in Chrome. **No call has used a saved prompt
  yet.** Not committed.
- Missing before clients: login, version history and undo, preview/test call before a prompt
  goes live, real storage, hosting with HTTPS and an audit log, per-client number ownership.

**2026-10-24 (Studio: sidebar, Call, Numbers).**
- Hover-expanding icon sidebar; three sections. **Call**: dial any number from one of our
  numbers through `scripts/call.py`'s own `preflight` and `dial` (loaded as a module, so the
  never-retry rule holds), consent checkbox required. **Numbers**: `numbers_store.py`
  (`data/numbers.json`), providers Plivo, Exotel, Twilio, SIP trunk with their credential fields;
  our Plivo number seeded from .env without copying its token; a token saved there wins over .env
  and the phone server now uses it for hang-ups (`server.plivo_auth`); secrets are masked in every
  API response; Exotel/Twilio/SIP save but show "not connected" and cannot place calls (no
  telephony for them yet). Row menu: Edit, Set as default, Call from this number, Edit prompt,
  Delete; "Add new number" dropdown top right opens a per-provider form.
- Found and fixed while building: the test suite wrote an empty `data/numbers.json` over the real
  one (server tests drive the call path); `tests/conftest.py` now points every test at temp files,
  and seeding no longer saves an empty list. 457 tests, ruff clean, checked in Chrome. **No call
  has been placed from the page yet.** Not committed.

**2026-10-24 (Studio: Contacts, live transcript, alignment).**
- **Contacts** (`contacts_store.py`, `data/contacts.json`): list with select-all and bulk delete,
  search, per-row call button and ⋯ menu; a phone-book drawer per contact (numbers with tags,
  call button and ⋯ edit/delete; shared tags create/edit/delete with a colour palette). Every
  call button opens a "Call from" pop-up (active numbers only) with a required consent box.
- **Live transcript** on the Call page, WhatsApp-style (agent left, caller right). The phone
  server writes live captions into the call's transcript (`LiveCaptions` observer:
  `TTSTextFrame` = agent words as spoken, `InterimTranscriptionFrame` = caller words as heard),
  through `CallTranscript.live`, which blanks every digit; the final masked turn replaces each
  caption. The Studio streams the transcript file as server-sent events
  (`/api/calls/{id}/stream`, id validated against path traversal); tool lines go out as the tool
  name only, never their arguments. Plivo's request id is the transcript's file name.
- Alignment pass: one spacing scale, one header layout, fixed column grids; all "local / this
  Mac" wording removed (the local-only protection itself is unchanged).
- Tests first: 23 new (480 total), mutation-checked (digit blanking, caption dedupe, tool-detail
  hiding, call-id validation). Verified in Chrome with a scripted transcript (live captions,
  `••` replaced by the final text, states Ringing/Live/Ended) and demo contacts (drawer, tags,
  call pop-up, consent refusal), all demo data removed after. **Live captions have not been
  seen on a real call yet.** Not committed.

**2026-10-24 (Studio: versions, call history, calmer icons).**
- **Prompt versions:** every save is kept (newest first, capped at 50); restore makes it current
  (and a new version); delete removes it from history; revert-to-default keeps the history.
- **Call history per contact:** clicking a contact expands its calls, grouped by day, 10/20/25/50
  per page, each with duration, summary, a transcript viewer and a CSV download. Transcripts now
  name the other party (`call_party` line, written by `build_worker`); the 15 older calls were
  matched from Plivo's call records by `scripts/backfill_call_index.py` into
  `data/call_index.json`. The CSV escapes cells that start like a spreadsheet formula.
- **Fixes the owner asked for:** a tag created in a contact's phone book now attaches to that
  contact (contact-level tags) and shows in the list; ⋯ on a contact edits only its name and
  numbers; the phone book has its own button; icons flattened (no glow, outline call icon).
- 503 tests (written first, CSV guard mutation-checked), ruff clean, checked in Chrome on real
  data. Owner already had contact "Aayuu"; Claude added "Aditya Nair" (owner's number) with an
  "Owner" tag while testing. Not committed.


**2026-10-24 (Studio becomes a business app: sign-in, dashboard, agents, prompts table).**
- **Sign in / sign up** (`auth_store.py`): the first account owns the workspace; later accounts
  need the owner's invite code (profile). scrypt hashes, sessions as an HttpOnly SameSite=Strict
  cookie with only its SHA-256 on disk, 7-day expiry, 5 wrong passwords lock an email for 5 min.
  Every `/api/` route except signing in answers 401 without a session. **The owner has not
  created their account yet**: the first person to sign up at http://127.0.0.1:8001 becomes owner.
- **Sidebar order** (Claude's pick): Dashboard, Calls, Contacts | Agents, Prompts, Numbers (daily
  work first, setup below). Bottom-left: the signed-in user; click for profile (counts, team,
  invite code, sign out). Top right: `?` tour (10 steps, auto on first sign-in) and notifications
  (`activity.py`, data/activity.jsonl; each links to where the change happened).
- **Agents** (`agents_store.py`, data/agents.json): name, description, several prompts (one "in
  use"), tools (per agent, replacing TOOLS_ENABLED for its calls), call settings (opening line,
  longest call ≤ the server ceiling, ring time), Test call. Numbers route to an agent for inbound
  calls; the old per-number prompt was migrated into "Main line agent" (answers +918065520552,
  history kept). The phone server takes `studio_agent` on /answer and /ws, re-reads the agent at
  stream start (deleted mid-ring = default persona), and `call_agent` is written to the transcript.
- **Prompts page** is a table: name (opens it inside its agent), agent, versions, in use, last
  edited, ⋯ Edit / Change agent / Delete.
- **Dashboard** (`analytics.py`, `call_outcomes.py`): calls, picked up %, successful % (picked up
  and the person replied twice or a lead was saved), avg talk time, minutes, how calls ended
  (picked up / no answer / declined / failed), calls per day, best hour (IST), agents, latest
  calls. Outcomes come from Plivo's hangup callback (`/hangup` on the phone server, token-checked;
  `call.py` and the Studio now pass `hangup_url`) and from "Sync with Plivo" (call records,
  read-only). Not yet seen: a real unanswered call reported by the callback.
- **Contacts:** last call + outcome per contact, Do not call (enforced by the Studio's dial
  endpoint only, not `scripts/call.py`), ⋯ Edit opens the side panel with pencil edits for name
  and numbers (no add-number), tags attach to the contact. Call page fields are one size.
- **Colours:** purple replaced by deep teal + sea blue (calm, trust-coded in fintech), marigold
  kept only for calling actions. CSP, X-Frame-Options DENY and no-referrer on the page.
- 612 tests (written first), ruff clean. Checked in Chrome on a copy of the data on port 8002
  (sign-up, tour, every page, tag fix, prompt move, notifications, profile, XSS in names).
  Claude's slip: an early test run (before conftest covered `AGENT_STORE_PATH`) wrote a test
  agent into the real data/agents.json, which also blocked the migration; deleted and migrated.
  An attack run left one fake outcome line in data/call_outcomes.jsonl; deleted. Not committed.

**2026-10-24 (medium pen-test findings fixed, pushed).** Owner asked to fix the medium findings
and push. Webhook bodies capped at 16KB (413; re-attacked: 50MB and chunked bodies refused in
<0.1s); outcome and activity logs written 0600; owner/member roles (owner alone changes numbers
and credentials, deletes agents/prompts, bulk-deletes contacts, syncs Plivo); `scripts/call.py`
refuses Do-not-call numbers. 629 tests. Still open (low): login lockout can be triggered by
anyone at the machine, forged outcomes by anyone with WEBHOOK_SECRET (Plivo signature check
not done), invite codes never expire, no password change, CSP allows inline scripts, the
dashboard reads every transcript per request. `.env.example` (real keys) still uncommitted.

**2026-10-24 (low pen-test findings fixed, pushed).** /hangup requires Plivo's V3 signature
(`plivo_signature.py`, matched Plivo's own code on 5 cases; **not yet seen on a real Plivo
callback** - if real reports are refused, the log says "without a valid Plivo signature";
"Sync with Plivo" still fills outcomes, and `PLIVO_VERIFY_SIGNATURE=false` turns the check off).
Device cookies keep the owner's own browser out of a stranger's lockout; invites are single-use
and expire in 7 days (new code from the profile); password change signs out other sessions;
the page's script is /app.js and the CSP forbids inline scripts; the dashboard caches each
transcript until it changes. 656 tests. Re-attacked live: stranger locked out while the owner's
browser signed in, invite reuse refused, forged /hangup refused with and without a fake signature.
Remaining: `/answer` and `/ws` still trust WEBHOOK_SECRET alone; style-src still allows inline
styles; the data stores are single-workspace JSON files.

**2026-10-24 (owner: fix every open finding one by one; remove Google; hold Cartesia; redesign;
make CI green).** Done in this order, each test-first, nothing in parallel:
1. **CI** had been red since 8bf6d0e: pipecat-ai/openai were unpinned and CI got pipecat 1.14,
   breaking 9 LLM fallback/timeout tests. `constraints.txt` pins the tested versions; runner
   pinned to ubuntu-24.04, actions bumped to Node-24 versions. Pushed (bb555a4); CI green.
2. **Google TTS removed** (code, checks, `google` extra, tests, `.env`). **Cartesia on hold.**
   Backup voice is now ElevenLabs, voice `EXAVITQu4vr4xnSDxMaL` (the configured Library voice
   is paid-only over the API; checked live).
3. **Backup voice takes over** on the first voice error and the owed reply is asked for again
   (end-to-end test with a refusing fake voice; not yet seen with a real provider failure).
4. **/answer and /transfer need Plivo's signature; /ws needs a single-use stream token.**
   Verified on a real call to the owner (ddedb4fd): Plivo's signed /answer and /hangup passed,
   the stream token was accepted, the outcome was recorded; old-style and replayed /ws refused.
5. **.env.example** restored to the template (it held real Deepgram/Groq/ElevenLabs keys, all
   already in .env); a test now fails if a real-looking key ever lands in it.
6. Conversation fixes in code: no filler over a caller still talking; Hindi filler after a
   Hindi turn; "Cairo AI" -> "Kaho AI" and Bengali -> Devanagari in transcripts; repeated
   sentence dropped; replies capped at REPLY_MAX_SENTENCES (3).
7. **Studio redesigned**: IBM Plex Sans/Mono, neutral light theme + system dark theme, fixed
   sidebar (Operate / Configure), no aurora/glass/gradients. Checked in Chrome, both themes.
697 tests, ruff clean. Not committed (only the CI fix was pushed, as asked).
Claude's slip: a `.env` listing meant to mask values printed them into the session log
(Deepgram, Smallest, ElevenLabs, Cartesia, Google keys). Rotate them.
On ddedb4fd the voice started in Hindi mode (SMALLEST_LANGUAGE=hi) and switched to English 2s
in when the caller's first words were detected as English; every line of the call was English.
The persona still has unfilled placeholders ("NBFC Name", "[LOAN ID PLACEHOLDER]") that the
agent read aloud. Still open: turn timing (needs measured tuning), reply language is only
prompted not enforced, "Kaho AI" inside Hindi sentences (owner's spelling pick), concurrency
and a full Hindi call untested, DPDP question with the CA.

**2026-10-24 (voice Suri, "KahoAI", fast opening; everything pushed).**
- `SMALLEST_LANGUAGE=en` (owner said yes) and `SMALLEST_VOICE_ID=suri` (owner liked Suri,
  Lakshmi, Manmeet; Suri in use). The brand is always spoken from "KahoAI" (`BrandNameFilter`),
  the spelling the owner picked from the brand samples.
- **Fast opening:** the notice is cached at startup and sent the instant the stream opens.
  Real call 831f85db: pickup -> notice 340ms, -> greeting 2.21s (were ~1.8s and 5.58s). A
  ~0.65s silence remains between the 1.2s notice and the greeting while Deepgram connects.
- **Caught before shipping:** the first version hung the server at startup (the real Smallest
  service held the one-off synthesis pipeline's EndFrame and cancel; the fake test voice did
  not). Every step is now bounded, warm-up caps it at 20s, and tests use a voice that never
  shuts down. The server never started in that state; no call was affected.
- 723 tests, ruff clean. Committed by concern and pushed; CI checked after the push.

**2026-10-25 (owner: start the server; calls returned 404).**
- The owner's PayTrace API had taken `127.0.0.1:8000`, so the public tunnel reached PayTrace and
  the Studio's pre-dial check got a 404. Started the phone server on `PORT=8010` (notice cached,
  1.76s), stopped the old copy on 8000, and repointed the owner's running ngrok tunnel to 8010
  through its local API. Public `/answer` now reaches Kaho AI (403 unsigned, as it should).
- PayTrace keeps running locally but has no public URL until the tunnel is pointed back.
- No code changed. Handoff updated and pushed.

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

Last updated: 2026-10-05. **Pushed through `bfc5b0c`, level with origin** (nothing local,
nothing ahead). **CI is green**: run #32 on `bfc5b0c` passed in 1m24s, confirmed by
screenshot of the Actions page, same as run #31 before it. No real phone call, inbound or
outbound, has happened yet: that is the next milestone, waiting on the owner for Plivo
credentials, a Plivo number, and a tunnel — the setup steps and exactly which values to send
back were given to the owner this session (see the log below); nothing has arrived yet.

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

Pushed through `bfc5b0c`, level with origin (2026-10-05). CI: green through #26 (`daa7b20`).
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
apps/voice/prompts/      default.md (with "Leaving details"), example_clinic.md, sales.md (generic outbound template)
apps/voice/tests/        299 tests (pipeline_fakes.py: provider stand-ins for build_worker tests)
scripts/                 check_providers.py, latency_summary.py, bench_llm_tts.py, ...
logs/turns.jsonl         per-turn timings        (gitignored)
logs/calls/<id>.jsonl    masked transcript, <id>.summary.json   (gitignored)
leads/<date>.jsonl       captured leads          (gitignored; holds names/numbers)
recordings/<id>.recording.wav  call audio, caller left, agent right (gitignored; unmasked; 60 days)
CLEANROOM.md             decision log with sources; add a row for every non-obvious choice
```

Pipeline: `transport -> Deepgram STT -> [FollowCallerLanguage] -> user aggregator ->
Groq LLM -> TTS (optionally a failover pair) -> transport -> assistant aggregator`. `TTS_PROVIDER` is one of
deepgram, elevenlabs, sarvam, smallest. Tools are enabled by `TOOLS_ENABLED`
(default `end_call,capture_lead`).

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

## 5. UNVERIFIED (assume nothing)

Never claim any of these works until a real call shows it.

**CI**
- **CI gate closed 2026-10-05: #31 is green on `cb7771b`.** `c11d7c2` fixed the flaky
  recording test. The #29 hang is still unexplained: it never reproduced locally (23 container
  runs total at 2 and 0.7 CPUs across two sessions) and hasn't recurred on GitHub either. With
  `c11d7c2`, a repeat would dump every thread's stack after 120s on one test and the job would
  stop at 15 minutes, so a future hang is now bounded and diagnosable instead of silent.
- Recordings line the two sides up only to about 0.1s: Pipecat's resampler hands audio over
  in bursts and the sides are matched at those. The last ~0.1s of each side stays in the
  resampler and is never written.

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
the LLM request's own timeout (`02b03d2`). Remaining:

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
2. Smallest AI for Hindi: first live run and a voice choice (needs `SMALLEST_API_KEY`;
   Pipecat lists `meher`, `devansh`, `kartik`, `maithili` as Hindi-capable). Sarvam is out.
3. Plivo V3 webhook signature validation (replaces the shared-secret token as the main
   guard; do it against a real request).
4. Concurrency, and deploying to `ap-south-1` before real traffic (see CLAUDE.md).
5. Full regression across English/Hindi, inbound/outbound, once telephony works.
6. Still owed to the "done" standard: a proper latency benchmark for the phone path (only
   smoke timings and the small backup-TTS comparison exist), and a PII test suite that
   covers every store of call content (transcript, summary, leads, failure markers) as
   one suite instead of individually.
7. Optional hardening: a backup STT provider; voicemail detection for outbound calls; a
   live test of a provider that hangs rather than errors.
8. The owner's "CLAUDE.md §4" and "what done looks like" checklist are still not in the
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

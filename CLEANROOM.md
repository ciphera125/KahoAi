# Clean-room log

Kaho AI is built from scratch using only public documentation and first-principles engineering.
Note here any public docs or sources relied on for non-obvious decisions.

| Date | Decision | Source (public URL) |
|------|----------|---------------------|
| 2026-09-26 | Pipeline wiring (`LLMContext` + `LLMContextAggregatorPair`, `PipelineWorker` + `WorkerRunner`, service stage order) follows the templates and service registry bundled inside the installed `pipecat-ai` package (`pipecat/cli/templates/`, `pipecat/cli/registry/_configs.py`). `PipelineTask`/`PipelineRunner` are deprecated aliases in 1.12.0. | Pipecat's own shipped templates; https://docs.pipecat.ai |
| 2026-09-26 | `LocalAudioTransport` (PyAudio mic/speaker) over the CLI's WebRTC/telephony transports — stage 1 is terminal-only, no browser. Needs the `local` extra and `brew install portaudio`. | `pipecat/transports/local/audio.py` docstring; https://docs.pipecat.ai |
| 2026-09-26 | Deepgram `nova-3` with `language=multi` for Hindi/English code-switching. Verified against the live API: `nova-3` returned 200 for `multi`, `en-IN`, `en`, `hi`. Pipecat passes the unrecognized-by-its-enum `multi` through as-is. | https://developers.deepgram.com — combination confirmed empirically |
| 2026-09-26 | Groq `openai/gpt-oss-120b`. `GET /openai/v1/models` on this account lists only gpt-oss (120b/20b), `qwen/qwen3.8-27b` and `allam-2-7b` as chat models — no Llama 3.3. 120b matched 20b on latency (~0.54s) at higher quality. Measured 0.53s to first streamed token. | https://console.groq.com/docs — model list and timings measured against the live API |
| 2026-09-26 | `GROQ_REASONING_EFFORT=low`, and `LLM_MAX_TOKENS` left unset. gpt-oss models spend the `max_tokens` budget on reasoning first: at 100 tokens with no `reasoning_effort`, 120b truncated mid-sentence and 20b returned empty content. Reasoning arrives in a separate `reasoning` field, so it is never spoken. | `GroqLLMSettings` docstring in `pipecat/services/groq/llm.py`; truncation reproduced against the live API |
| 2026-09-26 | ElevenLabs `eleven_flash_v2_5`: lowest latency (~75ms class) and half the per-character credit cost of `multilingual_v2`, which roughly doubles the number of test calls a plan covers. | https://elevenlabs.io/docs |
| 2026-09-26 | `check_providers.py` validates ElevenLabs by synthesizing two characters rather than reading account metadata: a TTS-scoped key returns 401 `missing_permissions` for `/v1/user`, `/v1/models` and `/v1/voices`, so only synthesis proves it works. Free plans also reject Voice Library voices over the API with HTTP 402. | ElevenLabs API error responses observed directly; https://elevenlabs.io/docs |

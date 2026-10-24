"""Kaho AI voice agent entrypoint.

A terminal-only pipeline: your mic/speakers -> Deepgram (STT) -> Groq (LLM)
-> Deepgram, ElevenLabs, Sarvam, Smallest or Cartesia (TTS), with Silero VAD
driving turn-taking. No web server, no browser — run it with `python main.py`
(or `./scripts/run_agent.sh`) and talk.

TTS_PROVIDER picks the voice: Deepgram Aura is the default because it runs on
the STT key we already have and costs nothing extra to iterate against, but its
voices are English-only. Switch to ElevenLabs for Hindi and the other Indian
languages.
"""

import array
import asyncio
import json
import os
import re
import ssl
import sys
import time
from collections import deque
from datetime import UTC, datetime
from pathlib import Path

import certifi
import openai
from dotenv import load_dotenv
from groq_usage import log_groq_call
from interruptions import build_start_strategies
from loguru import logger
from openai import AsyncOpenAI, DefaultAsyncHttpxClient
from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.audio.vad.vad_analyzer import VADParams
from pipecat.frames.frames import (
    BotStartedSpeakingFrame,
    EndTaskFrame,
    Frame,
    InterimTranscriptionFrame,
    InterruptionFrame,
    LLMFullResponseStartFrame,
    LLMRunFrame,
    LLMTextFrame,
    ManuallySwitchServiceFrame,
    MetricsFrame,
    TranscriptionFrame,
    TTSSpeakFrame,
    TTSTextFrame,
    TTSUpdateSettingsFrame,
    UserStoppedSpeakingFrame,
    VADUserStoppedSpeakingFrame,
)
from pipecat.metrics.metrics import LLMTokenUsage
from pipecat.observers.base_observer import BaseObserver, FramePushed
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.service_switcher import ServiceSwitcher, ServiceSwitcherStrategyFailover
from pipecat.pipeline.worker import PipelineParams, PipelineWorker
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import (
    LLMContextAggregatorPair,
    LLMUserAggregatorParams,
)
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
from pipecat.services.cartesia.tts import CartesiaTTSService, GenerationConfig
from pipecat.services.deepgram.stt import DeepgramSTTService as PipecatDeepgramSTTService
from pipecat.services.deepgram.tts import DeepgramTTSService
from pipecat.services.elevenlabs.tts import ElevenLabsTTSService
from pipecat.services.groq.llm import GroqLLMService
from pipecat.services.sarvam.tts import SarvamTTSService
from pipecat.services.settings import TTSSettings
from pipecat.services.smallest.tts import SmallestTTSService
from pipecat.services.tts_service import TextAggregationMode
from pipecat.transcriptions.language import Language
from pipecat.transports.local.audio import LocalAudioTransport, LocalAudioTransportParams
from pipecat.turns.user_mute import BaseUserMuteStrategy, MuteUntilFirstBotCompleteUserMuteStrategy
from pipecat.turns.user_turn_strategies import UserTurnStrategies
from pipecat.utils.http import connection_limits
from pipecat.utils.text.base_text_filter import BaseTextFilter
from pipecat.utils.text.markdown_text_filter import MarkdownTextFilter
from pipecat.utils.types import NOT_GIVEN
from pipecat.workers.runner import WorkerRunner
from recording import (
    DEFAULT_NOTICE,
    CallRecorder,
    delete_expired_recordings,
    recording_retention_days,
)
from resilience import (
    DEFAULT_APOLOGY,
    DEFAULT_FILLER,
    FILLER_AFTER_SECS,
    RESPONSE_DEADLINE_SECS,
    BotSpeechObserver,
    CallHealth,
    safe_reason,
)
from summary import DEFAULT_ATTEMPTS, DEFAULT_DEADLINE_SECS, summarise_call
from tools import DEFAULT_TIMEOUT_SECS, CallContext, build_tool_schemas, enabled_names
from transcript import CallTranscript

HERE = Path(__file__).resolve().parent
DEFAULT_PROMPT_PATH = HERE / "prompts" / "default.md"

# Every token here is re-sent on every turn of every call, so it is kept as short
# as it can be while still holding. Formatting is barely mentioned on purpose:
# speech_text_filters() strips markdown and dashes deterministically, which is
# cheaper and more reliable than spending tokens asking the model to behave.
# These rules cover only *how* to speak; the persona file says what the agent is.
VOICE_RULES = """\
You are speaking aloud on a phone call. Write for the ear: plain spoken prose,
never lists or headings.

Keep each turn to one or two sentences. Say the most useful thing and stop. Do
not open with filler like "Sure" or "Got it", and do not reuse a phrase you have
already said.

Say numbers as a person would. Phone numbers digit by digit, prices and times in
full, so "rupees five hundred" and "three thirty in the afternoon". In Indian
English "100 into 4,000" means multiplied by.

Answer in whatever language the caller just used, turn by turn. If they switch
to Hindi mid-conversation, switch with them; if they switch back, switch back.
Judge it from their latest turn alone, not from how the call opened. Open in
English unless they have already spoken.

Write Hindi in Devanagari, not romanised, because the voice pronounces its own
script far better than a transliteration. English stays in the Latin alphabet.
Keep a reply in one language rather than mixing the two in a sentence, except
for words that have no natural translation.

Everything you say must come from these instructions or from what the caller
just told you, and those facts are yours to give freely. Anything else, a price,
a time, whether something is available, you do not have: say so, and say who
does. Never fill the gap with a plausible guess, because the caller will act on
it. If a transcript is garbled, ask once about the part you missed, and never
guess at a name or a number.
"""

# Providers we know how to wire up. Bedrock support (Claude Haiku 4.5) lands
# later; for now Groq is the only LLM_PROVIDER this entrypoint understands.
SUPPORTED_LLM_PROVIDERS = ("groq",)
SUPPORTED_TTS_PROVIDERS = ("deepgram", "elevenlabs", "sarvam", "smallest", "cartesia")
# Voices that speak more than one language, so worth retuning to the caller's.
# Aura is English-only.
MULTILINGUAL_TTS_PROVIDERS = ("sarvam", "smallest", "elevenlabs", "cartesia")


def ensure_ca_bundle() -> None:
    """Point OpenSSL at certifi when the interpreter ships without a CA bundle.

    The python.org macOS builds leave .../etc/openssl/cert.pem unpopulated
    unless you run their "Install Certificates.command". HTTP still works,
    because httpx carries its own certifi copy, but every websocket — our STT
    and TTS both — dies on CERTIFICATE_VERIFY_FAILED. Setting SSL_CERT_FILE
    before the first handshake fixes it without touching the machine.
    """
    if os.environ.get("SSL_CERT_FILE"):
        return
    cafile = ssl.get_default_verify_paths().openssl_cafile
    if cafile and os.path.exists(cafile):
        return
    os.environ["SSL_CERT_FILE"] = certifi.where()
    logger.debug(f"No system CA bundle at {cafile}; using certifi instead.")
    load_certifi_into_aiohttp()


def load_certifi_into_aiohttp() -> None:
    """aiohttp builds its verified SSL context when it is first imported.

    Pipecat imports it long before ensure_ca_bundle() runs, so SSL_CERT_FILE
    arrives too late for it. Everything using aiohttp, notably the Plivo
    hang-up request, then fails with CERTIFICATE_VERIFY_FAILED and a real call
    would be left open. The context is a private module attribute, so this is
    guarded: if aiohttp moves it, we lose only this workaround.
    """
    try:
        from aiohttp import connector

        connector._SSL_CONTEXT_VERIFIED.load_verify_locations(cafile=certifi.where())
    except Exception as e:
        logger.warning(f"Could not add certifi to aiohttp's SSL context: {e}")


def env(name: str) -> str | None:
    """Read an env var, treating an empty string the same as unset."""
    return os.getenv(name) or None


def env_float(name: str, default: float | None) -> float | None:
    raw = env(name)
    if raw is None:
        return default
    try:
        return float(raw)
    except ValueError:
        logger.error(f"{name}={raw!r} is not a number.")
        sys.exit(1)


def build_vad() -> SileroVADAnalyzer:
    """Silero VAD, with the turn-taking thresholds exposed for tuning.

    stop_secs is the one that decides how the agent feels. It is how long the
    caller has to go quiet before we treat their turn as finished, so it is
    added to *every* reply's latency. Drop it and the agent feels sharp but
    starts talking over anyone who pauses to think, which on a real call means
    interrupting someone mid-sentence while they recall a date or an amount —
    far more damaging than a short wait. Raise it and every answer drags.

    250ms is a starting point, not an answer. Tune it against recordings of the
    people who actually call you: slower or less fluent speakers need more.
    """
    return SileroVADAnalyzer(
        params=VADParams(
            confidence=env_float("VAD_CONFIDENCE", 0.7),
            start_secs=env_float("VAD_START_SECS", 0.2),
            stop_secs=env_float("VAD_STOP_SECS", 0.25),
            min_volume=env_float("VAD_MIN_VOLUME", 0.6),
        )
    )


def build_turn_strategies() -> UserTurnStrategies:
    """What counts as the caller taking the turn, and so as interrupting the agent.

    See interruptions.py. Only the start strategies are ours; how a turn *ends*
    stays Pipecat's default (smart-turn analysis on top of the VAD's stop_secs).
    """
    ignore = frozenset(w.strip().lower() for w in (env("INTERRUPT_IGNORE_WORDS") or "").split(","))
    return UserTurnStrategies(
        start=build_start_strategies(
            enabled=(env("INTERRUPT_FILTER") or "true").strip().lower() != "false",
            min_words=int(env_float("INTERRUPT_MIN_WORDS", 1)),
            extra_ignore=ignore - {""},
        )
    )


class LiveCaptions(BaseObserver):
    """Write what the agent says and what the caller is saying to the transcript as
    live captions, for the Studio's live view. TTSTextFrame carries the agent's words
    as they are spoken; InterimTranscriptionFrame the caller's as STT hears them.
    Observers see a frame at every hop, so each is written once, by frame id.
    """

    def __init__(self, transcript: CallTranscript):
        super().__init__()
        self._transcript = transcript
        self._seen: deque[int] = deque(maxlen=256)

    async def on_push_frame(self, data: FramePushed) -> None:
        frame = data.frame
        if isinstance(frame, TTSTextFrame):
            role = "agent"
        elif isinstance(frame, InterimTranscriptionFrame):
            role = "caller"
        else:
            return
        if frame.id in self._seen:
            return
        self._seen.append(frame.id)
        self._transcript.live(role, frame.text)


class TurnTimingLogger(BaseObserver):
    """Append one JSON object per metric to a log that latency_summary.py reads.

    Pipecat already measures each stage; this only writes what it reports to
    disk so runs can be compared after the fact instead of by squinting at a
    scrolling terminal. TTFA is the number that matters — time to first audio,
    i.e. what the caller actually waits through.

    Pipecat's own metrics start when a *service* is handed work, so they cannot
    see the wait before that: the VAD's stop_secs and then the smart-turn
    classifier deciding the caller is actually finished. On the first real phone
    calls (2026-10-15) the stage metrics summed to 1-2s while the caller waited
    4-7s, so the gap is timed here too, from frames rather than services:

      turn_detection   VAD says the caller stopped -> the turn is ruled over
      reply_after_turn the turn is over            -> the agent's audio starts
      caller_wait      VAD says the caller stopped -> the agent's audio starts

    `caller_wait` is the one to judge a call by: it is the silence the caller
    sits through, and it is the sum of the other two.
    """

    def __init__(self, path: Path):
        super().__init__()
        self._path = path
        self._path.parent.mkdir(parents=True, exist_ok=True)
        self._run = datetime.now(UTC).strftime("%Y%m%dT%H%M%S")
        self._seen: set[int] = set()
        self._vad_stopped_at: float | None = None
        self._turn_ended_at: float | None = None
        self._last_turn_frame: dict[type, int] = {}

    def _write(self, record: dict) -> None:
        record |= {"run": self._run, "at": time.time()}
        with self._path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(record) + "\n")

    def _write_turn_phase(self, metric: str, started_at: float, now: float) -> None:
        self._write(
            {"metric": metric, "processor": None, "model": None, "seconds": now - started_at}
        )

    async def on_push_frame(self, data: FramePushed) -> None:
        frame = data.frame
        if isinstance(
            frame, VADUserStoppedSpeakingFrame | UserStoppedSpeakingFrame | BotStartedSpeakingFrame
        ):
            # Observers see a frame at every hop and the output transport sends
            # the speaking ones both ways, so only the downstream copy counts,
            # once per frame. Pipecat's `frame.id` is a counter it hands out;
            # `id(frame)` would be a memory address, which CPython reuses once
            # the frame is collected, and a reused one would silently drop the
            # next turn's measurement. Same approach as resilience.py.
            kind = type(frame)
            if data.direction != FrameDirection.DOWNSTREAM:
                return
            if self._last_turn_frame.get(kind) == frame.id:
                return
            self._last_turn_frame[kind] = frame.id
            self._on_turn_frame(frame)
            return
        if not isinstance(frame, MetricsFrame):
            return
        # Every processor that passes a frame along pushes it again; count once.
        if id(frame) in self._seen:
            return
        self._seen.add(id(frame))
        for item in frame.data:
            kind = type(item).__name__.replace("MetricsData", "").lower()
            record = {
                "metric": kind,
                "processor": getattr(item, "processor", None),
                "model": getattr(item, "model", None),
            }
            if hasattr(item, "ttfa"):
                record |= {
                    "seconds": item.ttfa,
                    "ttfb": item.ttfb,
                    "leading_silence": item.leading_silence,
                }
            # LLM usage is an object of token counts; log the counts themselves,
            # so what each call spends is on disk next to how long it took.
            elif isinstance(getattr(item, "value", None), LLMTokenUsage):
                usage = item.value
                record |= {
                    "prompt_tokens": usage.prompt_tokens,
                    "completion_tokens": usage.completion_tokens,
                    "total_tokens": usage.total_tokens,
                }
            elif isinstance(getattr(item, "value", None), int | float):
                record["seconds"] = item.value
                # TTS usage is a character count, which is what TTS bills by.
                if kind == "ttsusage":
                    record["characters"] = item.value
            else:
                continue
            self._write(record)

    def _on_turn_frame(self, frame: Frame) -> None:
        now = time.time()
        if isinstance(frame, VADUserStoppedSpeakingFrame):
            # A fresh caller turn: anything held from the last one is stale.
            self._vad_stopped_at, self._turn_ended_at = now, None
        elif isinstance(frame, UserStoppedSpeakingFrame):
            if self._vad_stopped_at is not None:
                self._write_turn_phase("turn_detection", self._vad_stopped_at, now)
            self._turn_ended_at = now
        elif isinstance(frame, BotStartedSpeakingFrame):
            # The greeting and the recording notice have no caller turn in front
            # of them, so there is nothing to measure against.
            if self._turn_ended_at is not None:
                self._write_turn_phase("reply_after_turn", self._turn_ended_at, now)
            if self._vad_stopped_at is not None:
                self._write_turn_phase("caller_wait", self._vad_stopped_at, now)
            self._vad_stopped_at = self._turn_ended_at = None


def load_system_prompt(persona_path: Path | None = None, persona_text: str | None = None) -> str:
    """Build the system instruction: the voice rules, then the chosen persona.

    AGENT_SYSTEM_PROMPT_PATH swaps the persona without touching code — that file
    alone decides what the agent is, knows and does. See apps/voice/prompts/.
    A per-call `persona_path` (an outbound call's agent) wins over it. This exits
    the process on an unreadable file, so a caller taking names from the network
    must resolve them with personas.resolve() first.

    `persona_text`, a prompt saved on the admin page for this call's number,
    wins over every file. The voice rules still come first either way.
    """
    if persona_text and persona_text.strip():
        logger.info("Persona: saved prompt for this number")
        return f"{VOICE_RULES}\n\n{persona_text.strip()}"
    path = persona_path or Path(env("AGENT_SYSTEM_PROMPT_PATH") or DEFAULT_PROMPT_PATH)
    if not path.is_absolute():
        path = (HERE / path).resolve()
    try:
        persona = path.read_text(encoding="utf-8").strip()
    except OSError as e:
        logger.error(f"Could not read the system prompt at {path}: {e}")
        sys.exit(1)
    if not persona:
        logger.error(f"The system prompt at {path} is empty.")
        sys.exit(1)
    logger.info(f"Persona: {path.name}")
    return f"{VOICE_RULES}\n\n{persona}"


def require_env(*names: str) -> None:
    missing = [name for name in names if not env(name)]
    if missing:
        logger.error(
            f"Missing required env var(s): {', '.join(missing)}. "
            "Copy .env.example to .env and fill them in, then run "
            "scripts/check_providers.py to verify."
        )
        sys.exit(1)


class DeepgramSTTService(PipecatDeepgramSTTService):
    """Deepgram, connecting in the background instead of holding up the call.

    Pipecat waits for Deepgram's handshake before the pipeline starts: 1.0s on
    892bf848 (2026-10-25), the largest part of pickup-to-greeting. Nothing needs
    the caller's words that early, since the caller is muted through the notice
    and greeting, so the pipeline starts at once and audio that arrives before
    the connection is dropped (run_stt sends only on an open connection).
    Reconnects after a drop work the same way, also without waiting.
    """

    async def _connect(self):
        logger.debug("Connecting to Deepgram in the background")
        self._quick_failure_tracker.reset()
        self._connection_settled.clear()
        self._connection_task = self.create_task(self._connection_handler())


class PortableGroqLLMService(GroqLLMService):
    """Groq, with message roles normalised to the ones every model accepts.

    When the caller interrupts and the STT recognises nothing, Pipecat appends
    a "developer" note telling the model it was cut off, which is what lets the
    bot ask them to repeat instead of trailing into silence. That role is
    hardcoded, and Qwen's chat template rejects it outright: HTTP 400,
    "Unexpected message role", after which the LLM is marked unusable and the
    call is over. Since barge-in is normal on a real call, this took the agent
    down repeatedly in testing.

    Rewriting the role here keeps Pipecat's recovery behaviour and works on any
    model, which beats disabling the recovery or pinning ourselves to a model
    that tolerates the role.
    """

    PORTABLE_ROLES = {"developer": "user"}

    # Retry the same turn on this model when the primary refuses it. "off" by
    # default. Only gpt-oss models are approved (owner's decision, 2026-10-24),
    # so a fallback, if set, is the other gpt-oss size. Both are Groq's, on the
    # same account and key, so it covers a failure specific to the primary (its
    # per-model rate limit, an outage of that model) and NOT a Groq-wide outage.
    DEFAULT_FALLBACK_MODEL = "off"
    DEFAULT_FALLBACK_TIMEOUT_SECS = 3.0

    # The OpenAI client's own defaults are a 600s timeout and up to 2 silent
    # retries on a timeout or connection error (seen live as an 11s time-to-first-
    # token with no error logged, 2026-10-02): a hang would run past every other
    # deadline in this file before the client itself gave up. This is the ceiling
    # on one HTTP attempt; max_retries=0 below means that ceiling is hit once,
    # not after quiet retries, so get_chat_completions sees the failure and can
    # fall back to gpt-oss at once instead of waiting on a client we do not control.
    DEFAULT_REQUEST_TIMEOUT_SECS = 6.0

    def __init__(
        self,
        *args,
        fallback_model: str | None = None,
        fallback_timeout_secs: float = DEFAULT_FALLBACK_TIMEOUT_SECS,
        request_timeout_secs: float = DEFAULT_REQUEST_TIMEOUT_SECS,
        on_fallback=None,
        **kwargs,
    ):
        # Read by create_client(), which the base __init__ calls below.
        self._request_timeout_secs = request_timeout_secs
        super().__init__(*args, **kwargs)
        self._fallback_model = fallback_model
        self._fallback_timeout_secs = fallback_timeout_secs
        self._on_fallback = on_fallback

    def create_client(self, api_key=None, base_url=None, organization=None, project=None, **kwargs):
        # Same construction as the base class (pipecat.services.openai.base_llm),
        # plus our own request timeout and no hidden retries. The base class's
        # create_client() does not forward extra kwargs to AsyncOpenAI, so the
        # timeout/max_retries have to be set here rather than passed through.
        return AsyncOpenAI(
            api_key=api_key,
            base_url=base_url,
            organization=organization,
            project=project,
            http_client=DefaultAsyncHttpxClient(
                limits=connection_limits(
                    max_keepalive_connections=100, max_connections=1000, keepalive_expiry=None
                )
            ),
            default_headers=kwargs.get("default_headers"),
            timeout=self._request_timeout_secs,
            max_retries=0,
        )

    @staticmethod
    def _worth_falling_back(exc: Exception) -> bool:
        """Rate limits, server errors and unreachable service. A 400 or 401 is
        our request or key, and the second model would fail the same way."""
        if isinstance(exc, openai.RateLimitError | openai.APIConnectionError):
            return True  # APITimeoutError is a subclass of APIConnectionError
        return isinstance(exc, openai.APIStatusError) and exc.status_code >= 500

    @staticmethod
    def _rejected_tool_call(exc: Exception) -> bool:
        """Groq checks a tool call's arguments against its schema and fails the
        stream when they do not match ("Tool call validation failed")."""
        body = getattr(exc, "body", None)
        return isinstance(exc, openai.APIError) and (
            getattr(exc, "code", None) == "tool_use_failed"
            or (isinstance(body, dict) and body.get("code") == "tool_use_failed")
            or "Tool call validation failed" in str(exc))

    async def _answer_in_words_if_a_tool_call_is_rejected(self, stream, context):
        """Pass the stream through; if Groq rejects a tool call before any words
        were said, ask once more without tools, so the turn is spoken.

        On 892bf848 (2026-10-25) gpt-oss-20b called capture_lead without its
        required "reason", Groq failed the turn, and the caller heard only "One
        moment" and then the apology. After words were spoken a retry would say
        them twice, so the error is raised as before.
        """
        spoke = False
        try:
            async for chunk in stream:
                choices = getattr(chunk, "choices", None)
                if choices and getattr(choices[0].delta, "content", None):
                    spoke = True
                yield chunk
        except openai.APIError as e:
            if spoke or not self._rejected_tool_call(e):
                raise
            logger.warning(f"Groq rejected a tool call ({safe_reason(e)}); answering this turn "
                           "again without tools")
            retry = await self._completions_without_tools(context)
            try:
                async for chunk in retry:
                    yield chunk
            finally:
                if hasattr(retry, "close"):
                    await retry.close()
        finally:
            if hasattr(stream, "close"):
                await stream.close()

    async def _completions_without_tools(self, context):
        adapter = self.get_llm_adapter()
        params = self.build_chat_completion_params(
            adapter.get_llm_invocation_params(
                context,
                system_instruction=self._settings.system_instruction,
                convert_developer_to_user=not self.supports_developer_role,
            )
        )
        params.pop("tools", None)
        params.pop("tool_choice", None)
        log_groq_call("PortableGroqLLMService._completions_without_tools", params.get("model"))
        return await self._client.chat.completions.create(**params)

    async def get_chat_completions(self, context):
        stream = await self._chat_completions(context)
        if not hasattr(stream, "__aiter__"):
            return stream
        return self._answer_in_words_if_a_tool_call_is_rejected(stream, context)

    async def _chat_completions(self, context):
        log_groq_call("PortableGroqLLMService.get_chat_completions", self._settings.model)
        try:
            return await super().get_chat_completions(context)
        except Exception as e:
            model = self._settings.model
            if (
                not self._fallback_model
                or self._fallback_model == model
                or not self._worth_falling_back(e)
            ):
                raise
            reason = safe_reason(e)
            logger.warning(
                f"LLM fallback: {model} failed ({reason}); retrying this turn on "
                f"{self._fallback_model} with a {self._fallback_timeout_secs}s deadline"
            )
            if self._on_fallback:
                self._on_fallback(model, self._fallback_model, reason)
            return await self._fallback_completions(context)

    async def _fallback_completions(self, context):
        """The same request against the fallback model, bounded by its own deadline
        so a slow fallback cannot stretch the turn past the response deadline."""
        adapter = self.get_llm_adapter()
        params = self.build_chat_completion_params(
            adapter.get_llm_invocation_params(
                context,
                system_instruction=self._settings.system_instruction,
                convert_developer_to_user=not self.supports_developer_role,
            )
        )
        params["model"] = self._fallback_model
        log_groq_call("PortableGroqLLMService._fallback_completions", self._fallback_model)
        return await asyncio.wait_for(
            self._client.chat.completions.create(**params),
            timeout=self._fallback_timeout_secs,
        )

    def build_chat_completion_params(self, params_from_context) -> dict:
        params = super().build_chat_completion_params(params_from_context)
        messages = params.get("messages")
        if messages:
            params["messages"] = [
                {**m, "role": self.PORTABLE_ROLES[m["role"]]}
                if isinstance(m, dict) and m.get("role") in self.PORTABLE_ROLES
                else m
                for m in messages
            ]
        return params


def build_llm(
    persona_path: Path | None = None, on_fallback=None, persona_text: str | None = None
) -> GroqLLMService:
    provider = (env("LLM_PROVIDER") or "groq").lower()
    if provider not in SUPPORTED_LLM_PROVIDERS:
        logger.error(
            f"LLM_PROVIDER={provider!r} isn't wired up yet — only "
            f"{', '.join(SUPPORTED_LLM_PROVIDERS)} is supported right now."
        )
        sys.exit(1)

    require_env("GROQ_API_KEY", "GROQ_MODEL_ID")
    max_tokens = env("LLM_MAX_TOKENS")
    temperature = env("LLM_TEMPERATURE")
    # The gpt-oss models reason before answering, which costs us time to first
    # word. "low" keeps that in check; non-reasoning models reject the param,
    # so it stays unset unless asked for.
    reasoning_effort = env("GROQ_REASONING_EFFORT")
    fallback = env("LLM_FALLBACK_MODEL_ID") or PortableGroqLLMService.DEFAULT_FALLBACK_MODEL
    fallback_secs = env("LLM_FALLBACK_TIMEOUT_SECS")
    request_secs = env("LLM_REQUEST_TIMEOUT_SECS")
    return PortableGroqLLMService(
        api_key=env("GROQ_API_KEY"),
        fallback_model=None if fallback.lower() in ("off", "none") else fallback,
        fallback_timeout_secs=(
            float(fallback_secs)
            if fallback_secs
            else PortableGroqLLMService.DEFAULT_FALLBACK_TIMEOUT_SECS
        ),
        request_timeout_secs=(
            float(request_secs)
            if request_secs
            else PortableGroqLLMService.DEFAULT_REQUEST_TIMEOUT_SECS
        ),
        on_fallback=on_fallback,
        settings=GroqLLMService.Settings(
            model=env("GROQ_MODEL_ID"),
            system_instruction=load_system_prompt(persona_path, persona_text),
            max_tokens=int(max_tokens) if max_tokens else None,
            temperature=float(temperature) if temperature else None,
            reasoning_effort=reasoning_effort,
        ),
    )


# The brand as speech-to-text mishears it, only when "AI" follows, so the Hindi
# word कहो ("say") and the city Cairo on their own are left alone.
_BRAND = re.compile(
    r"(?<!\w)(?:cairo|kairo|kaho+|caho+|cahu|kahu|कैरो|काहो|कहो)\s*"
    r"(?:a\.?\s?i\.?|एआई|ए\s?आई)(?!\w)",
    re.IGNORECASE,
)


def normalize_transcript(text: str) -> str:
    """Fix what nova-3 predictably gets wrong before the model reads it: the brand
    name, and Bengali letters for Hindi words (its multilingual mode has no
    Bengali, so they are always a mis-script; the two blocks share a layout)."""
    text = "".join(chr(ord(c) - 0x80) if "\u0981" <= c <= "\u09ff" else c for c in text)
    return _BRAND.sub("Kaho AI", text)


class NormalizeTranscripts(FrameProcessor):
    """Applies normalize_transcript to every transcript, final and interim."""

    async def process_frame(self, frame, direction):
        await super().process_frame(frame, direction)
        if isinstance(frame, TranscriptionFrame | InterimTranscriptionFrame):
            frame.text = normalize_transcript(frame.text)
        await self.push_frame(frame, direction)


DEFAULT_REPLY_MAX_SENTENCES = 3


def reply_max_sentences() -> int:
    """REPLY_MAX_SENTENCES: how many sentences of a reply are spoken (0 = no cap)."""
    raw = (env("REPLY_MAX_SENTENCES") or "").strip()
    if not raw:
        return DEFAULT_REPLY_MAX_SENTENCES
    try:
        value = int(raw)
    except ValueError:
        value = -1
    if value < 0:
        logger.warning(f"REPLY_MAX_SENTENCES={raw!r} is not a count; using "
                       f"{DEFAULT_REPLY_MAX_SENTENCES}")
        return DEFAULT_REPLY_MAX_SENTENCES
    return value


class CapReplyLength(FrameProcessor):
    """Speak at most `max_sentences` sentences of each reply; drop the rest.

    The prompt asks for one or two sentences and the model still ran long on a
    real call (the caller cut it off 11 times). Sits between the LLM and the
    voice, so what is dropped is never spoken and never enters the context. A
    sentence ends at . ! ? or । followed by a space; a decimal ("5.5") has no
    space, and a short abbreviation ("Rs.", "Dr.") or a single letter is not an
    end. Spoken lines (TTSSpeakFrame) are never cut.
    """

    _END = re.compile(r"(\S*?)([.!?।]+)(?=\s)")
    _ABBREVIATIONS = {"rs", "dr", "mr", "mrs", "ms", "no", "st", "sr", "jr", "vs", "etc",
                      "approx", "dept", "govt", "ltd", "pvt", "co", "inc", "a.m", "p.m"}

    def __init__(self, max_sentences: int):
        super().__init__()
        self._max = max_sentences
        self._reset()

    def _reset(self) -> None:
        self._text, self._passed, self._done = "", 0, False

    def _cut(self) -> int | None:
        """Where the reply's last allowed sentence ends, once it has."""
        count = 0
        for m in self._END.finditer(self._text):
            word = m.group(1).lstrip("(\"'").lower()
            if m.group(2) == "." and (word in self._ABBREVIATIONS
                                      or (len(word) == 1 and word.isalpha())):
                continue
            count += 1
            if count == self._max:
                return m.end()
        return None

    async def process_frame(self, frame, direction):
        await super().process_frame(frame, direction)
        if isinstance(frame, LLMFullResponseStartFrame | InterruptionFrame):
            self._reset()
        elif isinstance(frame, LLMTextFrame) and self._max > 0:
            if self._done:
                return
            start = len(self._text)
            self._text += frame.text
            cut = self._cut()
            if cut is not None:
                self._done = True
                logger.info(f"Reply cut at {self._max} sentence(s) (REPLY_MAX_SENTENCES)")
                frame.text = self._text[start:cut]
                if not frame.text:
                    return
        await self.push_frame(frame, direction)


DEFAULT_FILLER_HI = "एक सेकंड।"
_DEVANAGARI = re.compile(r"[\u0900-\u097F]")


def filler_line(caller_turns: list[str]) -> str:
    """The "one moment" line in the language of the caller's latest turn: an
    English filler to a caller speaking Hindi was heard on a real call."""
    if caller_turns and _DEVANAGARI.search(caller_turns[-1]):
        return env("FILLER_MESSAGE_HI") or DEFAULT_FILLER_HI
    return env("FILLER_MESSAGE") or DEFAULT_FILLER


def recording_notice_text() -> str | None:
    """The notice a call opens with, or None if calls are not recorded or the
    notice is off. build_worker decides the same way."""
    recorded = (env("RECORDING_ENABLED") or "true").strip().lower() == "true"
    notice_on = (env("RECORDING_NOTICE_ENABLED") or "true").strip().lower() == "true"
    return (env("RECORDING_NOTICE") or DEFAULT_NOTICE) if recorded and notice_on else None


DEFAULT_GREETING_LEAD_SECS = 0.8  # Groq TTFAT ~0.46s + voice TTFA ~0.27s on ddedb4fd


class MuteUntil(BaseUserMuteStrategy):
    """Mutes the caller until a moment on the monotonic clock: the end of a
    recording notice that plays outside the pipeline, which the caller must not
    talk over."""

    def __init__(self, until: float):
        super().__init__()
        self._until = until

    async def process_frame(self, frame) -> bool:
        return time.monotonic() < self._until


def opening_mute_strategies(prespoken: bool, notice_ends_at: float | None) -> list:
    """The caller cannot talk over the opening: the notice, then the greeting.

    The greeting is protected too. On 892bf848 (2026-10-25) a voice near the
    phone was taken for the caller 0.3s into it and cut it to "Hello,", though
    the caller had said nothing; people often answer and wait for the bot to
    speak. Released when the greeting ends, or if it fails before any audio.
    """
    first_speech = [MuteUntilFirstBotCompleteUserMuteStrategy()]
    if prespoken:
        return [MuteUntil(notice_ends_at), *first_speech]
    return first_speech


class SpokenPunctuationFilter(BaseTextFilter):
    """Normalise punctuation that reads badly when spoken.

    The prompt asks the model to avoid these, and mostly it does, but "mostly"
    is not a guarantee you want between the LLM and the caller's ear — it still
    slipped an em-dash through in testing. Anything we can enforce in code, we
    enforce in code, and leave the prompt to handle what only judgement can.
    """

    # Smart quotes are flattened because some voices spell them out.
    REPLACEMENTS = {"…": "...", "“": '"', "”": '"', "‘": "'", "’": "'"}

    # A dash becomes the comma a speaker actually pauses on. It swallows the
    # space around it too: an unspaced "need—could" would otherwise turn into
    # "need,could" and be read as one slurred word.
    DASHES = re.compile(r"\s*[—–]\s*")

    async def filter(self, text: str) -> str:
        text = self.DASHES.sub(", ", text)
        for old, new in self.REPLACEMENTS.items():
            text = text.replace(old, new)
        return text

    async def handle_interruption(self):
        """Nothing is buffered between calls, so an interruption needs no reset."""


class BrandNameFilter(BaseTextFilter):
    """Speak the brand from the one spelling the owner chose by ear: "KahoAI"
    (2026-10-24, sample b_KahoAI_hi_sentence). The model writes it many ways, and
    each one is pronounced differently ("Kahoo", "Cahu" were heard)."""

    _BRAND = re.compile(
        r"(?<!\w)(?:kaho\s*[-]?\s*a\.?\s?i\.?|कहो\s*(?:ai|एआई|ए\s?आई)|काहो\s*(?:ai|एआई|ए\s?आई))"
        r"(?!\w)",
        re.IGNORECASE,
    )

    async def filter(self, text: str) -> str:
        return self._BRAND.sub("KahoAI", text)

    async def handle_interruption(self):
        """Stateless."""


class RepeatedSentenceFilter(BaseTextFilter):
    """Say a sentence once when the model writes it twice in a row (seen live:
    "मेरा नाम आयुशी है…" back to back). Compared without case, spacing or
    punctuation. Only meaningful when text arrives a sentence at a time."""

    _NOISE = re.compile(r"[\W_]+", re.UNICODE)

    def __init__(self):
        self._last: str | None = None

    async def filter(self, text: str) -> str:
        key = self._NOISE.sub("", text).casefold()
        if not key:
            return text
        if key == self._last:
            return ""
        self._last = key
        return text

    async def handle_interruption(self):
        self._last = None


def speech_text_filters() -> list[BaseTextFilter]:
    """Strip markdown, then fix punctuation, before any text reaches the voice;
    when text goes by sentence, also drop a sentence repeated back to back."""
    filters: list[BaseTextFilter] = [MarkdownTextFilter(), SpokenPunctuationFilter(),
                                     BrandNameFilter()]
    if text_aggregation_mode() == TextAggregationMode.SENTENCE:
        filters.append(RepeatedSentenceFilter())
    return filters


class FollowCallerLanguage(FrameProcessor):
    """Retune the voice to whatever language the caller just spoke.

    The LLM follows the caller on its own, but the voice does not: Sarvam is
    told a target language once, when its websocket connects, and keeps using
    it. Left alone it would read a Hindi reply with English pronunciation
    rules, which is worse than either language on its own.

    Deepgram's nova-3 reports a detected language per utterance when it runs
    with language=multi, so each final transcript carries the answer already.
    When it changes, this sends the TTS a settings update, which Sarvam applies
    by resending its config rather than reconnecting. Nothing is emitted while
    the caller stays in one language.

    Pinning DEEPGRAM_LANGUAGE to a single language turns the detection off, and
    this then has nothing to act on.
    """

    def __init__(self):
        super().__init__()
        self._current = None

    async def retune(self) -> None:
        """Send the current language to the TTS again, after a backup took over.

        A settings update reaches only the active service, so a backup that
        becomes active later starts from its own default language.
        """
        if self._current:
            await self.push_frame(
                TTSUpdateSettingsFrame(delta=TTSSettings(language=self._current)),
                FrameDirection.DOWNSTREAM,
            )

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        if isinstance(frame, TranscriptionFrame) and frame.language:
            if frame.language != self._current:
                logger.info(f"Caller switched to {frame.language}; retuning the voice.")
                self._current = frame.language
                await self.push_frame(
                    TTSUpdateSettingsFrame(delta=TTSSettings(language=frame.language)),
                    FrameDirection.DOWNSTREAM,
                )
        await self.push_frame(frame, direction)


def text_aggregation_mode() -> TextAggregationMode:
    """How much text to gather before handing it to the voice.

    "sentence" (the default) sends each sentence the moment it is complete,
    rather than waiting for the whole reply, so the caller hears the first
    sentence while the model is still writing the second. "token" forwards
    tokens as they arrive, shaving off the wait for the first sentence to end
    at the cost of the engine having less context for prosody — it has to
    commit to an intonation before it knows where the sentence is going, which
    is what makes fragment-level synthesis sound choppy.

    Deepgram Aura streams over a websocket and buffers text on its own side
    until we flush, so there is no character-count knob to set here; this
    choice of boundary is the equivalent lever.
    """
    raw = (env("TTS_TEXT_AGGREGATION") or "sentence").strip().lower()
    try:
        return TextAggregationMode(raw)
    except ValueError:
        options = ", ".join(m.value for m in TextAggregationMode)
        logger.error(f"TTS_TEXT_AGGREGATION={raw!r} is not one of: {options}")
        sys.exit(1)


def env_int(name: str) -> int | None:
    raw = env(name)
    if raw is None:
        return None
    try:
        return int(raw)
    except ValueError:
        logger.error(f"{name}={raw!r} is not a whole number.")
        sys.exit(1)


def build_tts(
    provider: str | None = None,
) -> (
    DeepgramTTSService
    | ElevenLabsTTSService
    | SarvamTTSService
    | SmallestTTSService
    | CartesiaTTSService
):
    provider = (provider or env("TTS_PROVIDER") or "deepgram").lower()
    if provider not in SUPPORTED_TTS_PROVIDERS:
        logger.error(
            f"TTS provider {provider!r} isn't wired up — expected one of "
            f"{', '.join(SUPPORTED_TTS_PROVIDERS)}."
        )
        sys.exit(1)

    if provider == "sarvam":
        require_env("SARVAM_API_KEY", "SARVAM_VOICE_ID")
        # Sarvam is the one provider here with a real character buffer.
        # min_buffer_size is how much text it collects before it starts
        # speaking: small starts sooner but gives the voice less to plan its
        # intonation with, which is what makes short fragments sound clipped.
        #
        # Every one of these goes into the websocket config verbatim, nulls
        # included, and Sarvam rejects the whole message if any is null
        # ("Input parameters has to be a valid dictionary"), so an unset
        # option has to be left out entirely rather than passed as None.
        options = {
            "voice": env("SARVAM_VOICE_ID"),
            "model": env("SARVAM_MODEL_ID"),
            "language": env("SARVAM_LANGUAGE"),
            "pace": env_float("SARVAM_PACE", 1.0),
            "min_buffer_size": env_int("SARVAM_MIN_BUFFER_SIZE"),
            "max_chunk_length": env_int("SARVAM_MAX_CHUNK_LENGTH"),
        }
        return SarvamTTSService(
            api_key=env("SARVAM_API_KEY"),
            settings=SarvamTTSService.Settings(
                **{k: v for k, v in options.items() if v is not None}
            ),
            text_filters=speech_text_filters(),
            text_aggregation_mode=text_aggregation_mode(),
        )

    if provider == "smallest":
        require_env("SMALLEST_API_KEY", "SMALLEST_VOICE_ID")
        raw_language = env("SMALLEST_LANGUAGE")
        try:
            language = Language(raw_language) if raw_language else None
        except ValueError:
            logger.error(f"SMALLEST_LANGUAGE={raw_language!r} is not a language code.")
            sys.exit(1)
        # Unset options are left out so the service's own defaults apply, the
        # same rule as Sarvam: a None here would be sent as an explicit null.
        options = {
            "voice": env("SMALLEST_VOICE_ID"),
            "model": env("SMALLEST_MODEL_ID"),
            "language": language,
            "speed": env_float("SMALLEST_SPEED", 1.0),
        }
        return SmallestTTSService(
            api_key=env("SMALLEST_API_KEY"),
            max_buffer_delay_ms=env_int("SMALLEST_MAX_BUFFER_DELAY_MS"),
            settings=SmallestTTSService.Settings(
                **{k: v for k, v in options.items() if v is not None}
            ),
            text_filters=speech_text_filters(),
            text_aggregation_mode=text_aggregation_mode(),
        )

    if provider == "cartesia":
        require_env("CARTESIA_API_KEY", "CARTESIA_VOICE_ID")
        raw_language = env("CARTESIA_LANGUAGE")
        try:
            language = Language(raw_language) if raw_language else None
        except ValueError:
            logger.error(f"CARTESIA_LANGUAGE={raw_language!r} is not a language code.")
            sys.exit(1)
        # Cartesia takes 0.6 to 1.5. Out of range would only fail on the first
        # sentence of a live call, so it stops startup instead.
        speed = env_float("CARTESIA_SPEED", None)
        if speed is not None and not 0.6 <= speed <= 1.5:
            logger.error(f"CARTESIA_SPEED={speed} is outside Cartesia's 0.6 to 1.5.")
            sys.exit(1)
        options = {
            "voice": env("CARTESIA_VOICE_ID"),
            "model": env("CARTESIA_MODEL_ID"),
            "language": language,
            "generation_config": GenerationConfig(speed=speed) if speed is not None else None,
        }
        return CartesiaTTSService(
            api_key=env("CARTESIA_API_KEY"),
            settings=CartesiaTTSService.Settings(
                **{k: v for k, v in options.items() if v is not None}
            ),
            text_filters=speech_text_filters(),
            text_aggregation_mode=text_aggregation_mode(),
        )

    if provider == "elevenlabs":
        require_env("ELEVENLABS_API_KEY", "ELEVENLABS_VOICE_ID")
        return ElevenLabsTTSService(
            api_key=env("ELEVENLABS_API_KEY"),
            settings=ElevenLabsTTSService.Settings(
                voice=env("ELEVENLABS_VOICE_ID"),
                model=env("ELEVENLABS_MODEL_ID"),
            ),
            text_filters=speech_text_filters(),
            text_aggregation_mode=text_aggregation_mode(),
        )

    require_env("DEEPGRAM_API_KEY", "DEEPGRAM_VOICE_ID")
    return DeepgramTTSService(
        api_key=env("DEEPGRAM_API_KEY"),
        settings=DeepgramTTSService.Settings(voice=env("DEEPGRAM_VOICE_ID")),
        text_filters=speech_text_filters(),
        text_aggregation_mode=text_aggregation_mode(),
    )


def build_worker(
    transport,
    params: PipelineParams | None = None,
    call_id: str | None = None,
    caller_number: str | None = None,
    on_abort=None,
    persona_path: Path | None = None,
    transfer=None,
    recording_sample_rate: int = 16000,
    persona_text: str | None = None,
    tool_names: list[str] | None = None,
    opening_line: str | None = None,
    notice_prespoken: tuple | None = None,
) -> PipelineWorker:
    """Everything between the transport's input and output, shared by every entry point.

    The local mic/speaker run and each phone call get exactly the same STT, LLM,
    TTS and turn-taking; only the transport differs. Call load_dotenv() and
    ensure_ca_bundle() first.

    on_abort(spoken) replaces the default hard stop when a provider failure ends
    the call; `spoken` is whether the caller heard an apology. persona_path picks
    this call's persona (an outbound agent). The worker carries its CallHealth as
    `worker.health` and its CallTranscript as `worker.transcript`. `transfer` is an
    async callable that hands the live call to a human (phone server only).
    recording_sample_rate is the rate the call's recording is saved at; the phone
    server passes the phone line's 8kHz, since anything higher stores no more sound.
    tool_names and opening_line come from a Studio agent: its tools replace
    TOOLS_ENABLED, and the greeting opens with its line. notice_prespoken is
    (PrespokenNotice, monotonic time it was sent): the phone server already sent
    the recording notice to the caller, so the pipeline must not say it again.
    """
    require_env("DEEPGRAM_API_KEY")

    # keyterm biases nova-3 toward words it would otherwise mangle: brand names,
    # drug names, place names, anything domain-specific. Worth filling in per
    # deployment — it is the main lever on mis-transcription. (nova-3 replaced
    # the older `keywords` parameter with this one and rejects `keywords`.)
    keyterms = [t.strip() for t in (env("DEEPGRAM_KEYTERMS") or "").split(",") if t.strip()]
    stt = DeepgramSTTService(
        api_key=env("DEEPGRAM_API_KEY"),
        settings=DeepgramSTTService.Settings(
            model=env("DEEPGRAM_MODEL"),
            language=env("DEEPGRAM_LANGUAGE"),
            # Punctuation and sentence casing give the LLM cleaner input, and
            # numerals matter here: phone numbers, rupee amounts and OTPs are
            # far easier to act on as digits than as spelled-out words.
            smart_format=True,
            numerals=True,
            keyterm=keyterms or None,
        ),
    )

    # The fallback callback reaches the transcript, which is created just below.
    llm = build_llm(
        persona_path,
        on_fallback=lambda primary, backup, reason: transcript.event(
            "llm_fallback", primary=primary, to=backup, reason=reason
        ),
        persona_text=persona_text,
    )
    tts, tts_services, switcher = build_tts_stack()

    # Masked transcript of every call. See transcript.py for why it is written
    # as text and with Aadhaar/PAN masked at the point of writing.
    call_id = call_id or datetime.now(UTC).strftime("local-%Y%m%dT%H%M%S")
    calls_dir = Path(env("CALL_LOG_DIR") or HERE.parent.parent / "logs" / "calls")
    transcript = CallTranscript(call_id, calls_dir)
    if caller_number:
        # Who was on the other end, for the Studio's call history. A phone number,
        # not call content, so it goes in its own field rather than through masking.
        transcript.event("call_party", number=caller_number)
    logger.info(f"Transcript -> {calls_dir}/{call_id}.jsonl (sensitive numbers masked)")

    # Audio of every call, unannounced and unmasked by the owner's decision; see
    # recording.py. RECORDING_ENABLED=false turns it off.
    recorder = None
    if (env("RECORDING_ENABLED") or "true").strip().lower() == "true":
        recorder = CallRecorder(
            call_id, recordings_dir(), recording_sample_rate, record=transcript.event
        )

    # A recorded call opens with RECORDING_NOTICE, word for word, before anything else
    # is said. RECORDING_NOTICE_ENABLED=false leaves it out; an unrecorded call never
    # hears it, since it would not be true.
    notice = None
    notice_on = (env("RECORDING_NOTICE_ENABLED") or "true").strip().lower() == "true"
    if recorder is not None and notice_on:
        notice = env("RECORDING_NOTICE") or DEFAULT_NOTICE
    # The server sends the notice itself the moment the call opens (notice_audio.py);
    # used only if it is these exact words.
    prespoken, notice_ends_at = None, None
    if notice and notice_prespoken and notice_prespoken[0].text == notice:
        prespoken = notice_prespoken[0]
        notice_ends_at = notice_prespoken[1] + prespoken.duration_secs
        if recording_sample_rate == 8000:
            # Caller on the left, bot on the right, as the recorder's own buffer has it.
            bot = array.array("h", prespoken.pcm_8k)
            stereo = array.array("h", [0] * (2 * len(bot)))
            stereo[1::2] = bot
            recorder.write(stereo.tobytes(), 8000, 2)

    # Tools are opt-in per deployment through TOOLS_ENABLED (default: end_call).
    call = CallContext(call_id=call_id, transcript=transcript, caller_number=caller_number)
    call.transfer = transfer
    call.hang_up = lambda: llm.push_frame(EndTaskFrame(), FrameDirection.UPSTREAM)
    try:
        tool_schemas = build_tool_schemas(
            call,
            enabled_names(env("TOOLS_ENABLED")) if tool_names is None else list(tool_names),
            env_float("TOOL_TIMEOUT_SECS", DEFAULT_TIMEOUT_SECS),
        )
    except ValueError as e:
        logger.error(str(e))
        sys.exit(1)

    context = LLMContext(tools=tool_schemas or NOT_GIVEN)
    user_aggregator, assistant_aggregator = LLMContextAggregatorPair(
        context,
        user_params=LLMUserAggregatorParams(
            vad_analyzer=build_vad(),
            user_turn_strategies=build_turn_strategies(),
            # The caller can neither talk over the notice and greeting nor, with an
            # early "hello?", cancel them. Released once the greeting has played.
            user_mute_strategies=opening_mute_strategies(bool(prespoken), notice_ends_at),
        ),
    )

    follow_proc = FollowCallerLanguage() if voice_follows_caller_language() else None

    pipeline = Pipeline(
        [
            transport.input(),
            stt,
            NormalizeTranscripts(),
            *([follow_proc] if follow_proc else []),
            user_aggregator,
            llm,
            *([CapReplyLength(reply_max_sentences())] if reply_max_sentences() else []),
            tts,
            transport.output(),
            # After the output, so it records what was actually sent to the caller.
            *([recorder.processor()] if recorder else []),
            assistant_aggregator,
        ]
    )

    timings = Path(env("LATENCY_LOG_PATH") or HERE.parent.parent / "logs" / "turns.jsonl")
    params = params or PipelineParams()
    params.enable_metrics = True
    params.enable_usage_metrics = True

    # What happens when a provider dies mid-call. See resilience.py for the rules.
    # Frames queued on the worker enter at the start of the pipeline and wait behind
    # whatever the LLM is doing; a hung LLM request held back the filler, the apology
    # and the end of the call that way (seen live, 2026-10-02). So the apology goes in
    # behind an interruption, which overtakes everything and cancels the request, and
    # the frames that must not cancel the reply are pushed out from the LLM's place.
    async def interrupt_and_say(text: str) -> None:
        await worker.queue_frames([InterruptionFrame(), TTSSpeakFrame(text)])

    async def abort(spoken: bool) -> None:
        if on_abort is not None:
            await on_abort(spoken)
        else:
            await worker.cancel(reason="provider failure")

    async def say(text: str) -> None:
        await llm.push_frame(TTSSpeakFrame(text))

    async def switch_to(service) -> None:
        await llm.push_frame(ManuallySwitchServiceFrame(service=service))

    async def retry_reply() -> None:
        # The lost reply was never spoken, so it never reached the context: running
        # the LLM again answers the caller's last turn, this time in the new voice.
        await worker.queue_frames([LLMRunFrame()])

    health = CallHealth(
        {"stt": [stt], "llm": [llm], "tts": tts_services},
        record=transcript.event,
        interrupt_and_say=interrupt_and_say,
        abort=abort,
        switch_to=switch_to if switcher else None,
        say=say,
        retry_reply=retry_reply if switcher else None,
        filler=env("FILLER_MESSAGE") or DEFAULT_FILLER,
        filler_for=lambda: filler_line(transcript.caller_text),
        filler_after_secs=env_float("FILLER_AFTER_SECS", FILLER_AFTER_SECS),
        wrappers={"tts": [switcher]} if switcher else None,
        apology=env("FAILURE_MESSAGE") or DEFAULT_APOLOGY,
        response_deadline_secs=env_float("RESPONSE_DEADLINE_SECS", RESPONSE_DEADLINE_SECS),
    )
    worker = PipelineWorker(
        pipeline,
        params=params,
        observers=[TurnTimingLogger(timings), BotSpeechObserver(health), LiveCaptions(transcript)],
    )
    worker.health = health
    if switcher is not None:

        @switcher.strategy.event_handler("on_service_switched")
        async def voice_switched(strategy, service):
            await health.on_switched(service)

    worker.transcript = transcript
    worker.recorder = recorder
    logger.info(f"Per-turn timings -> {timings} (summarise: scripts/latency_summary.py)")

    transcript.attach(user_aggregator, assistant_aggregator)

    @worker.event_handler("on_pipeline_error")
    async def provider_error(worker, frame):
        await health.on_error(frame)

    @user_aggregator.event_handler("on_user_turn_started")
    async def caller_is_talking(aggregator, strategy):
        health.caller_resumed()

    @user_aggregator.event_handler("on_user_turn_stopped")
    async def reply_is_due(aggregator, strategy, message):
        health.arm()
        restore_tools()  # in case the greeting never finished

    held_tools: list = []

    def restore_tools():
        if held_tools:
            context.set_tools(held_tools.pop())

    @assistant_aggregator.event_handler("on_assistant_turn_stopped")
    async def greeting_done(aggregator, message):
        restore_tools()

    if switcher is not None:

        @switcher.strategy.event_handler("on_service_switched")
        async def tts_switched(strategy, service):
            logger.warning(f"TTS switched to {service.name}")
            transcript.event("tts_switched", to=service.name)
            if follow_proc is not None:
                await follow_proc.retune()

    @worker.event_handler("on_pipeline_finished")
    async def call_finished(worker, frame):
        health.finished()
        if recorder is not None:
            recorder.close()  # normally already closed when the recording stopped
        transcript.end()
        # SUMMARY_ENABLED=false skips it. It runs after the call, so it adds no
        # latency for the caller, and it never raises into teardown.
        if (env("SUMMARY_ENABLED") or "true").strip().lower() == "true":
            await summarise_call(
                transcript.path,
                env("GROQ_API_KEY"),
                env("SUMMARY_MODEL_ID") or env("GROQ_MODEL_ID"),
                attempts=int(env_float("SUMMARY_MAX_ATTEMPTS", DEFAULT_ATTEMPTS)),
                deadline_secs=env_float("SUMMARY_DEADLINE_SECS", DEFAULT_DEADLINE_SECS),
            )

    @worker.event_handler("on_pipeline_started")
    async def greet(worker, frame):
        # Sent as "user", not "developer". Qwen's chat template refuses a
        # conversation with no user turn ("No user query found in messages",
        # HTTP 400) and the LLM service is then marked unusable, so the call
        # opens in silence. gpt-oss happens to tolerate "developer"; a role
        # every model accepts is the portable choice, since the whole point of
        # GROQ_MODEL_ID is being able to swap models freely.
        instruction = "Start by concisely introducing yourself."
        if opening_line:
            instruction = f'Open the call with this line, word for word: "{opening_line}"'

        async def ask_for_the_greeting():
            # No tools on the greeting: there is nothing to act on yet, and with
            # them gpt-oss-20b called capture_lead instead of greeting in 6 of 12
            # live requests (2026-10-24). tool_choice "none" is no help: the model
            # still calls the tool and Groq rejects the request. Without tools,
            # 15 of 15 greeted. They come back once the greeting is done.
            held_tools.append(context.tools)
            context.set_tools(NOT_GIVEN)
            context.add_message({"role": "user", "content": instruction})
            await worker.queue_frames([LLMRunFrame()])
            # The greeting is a reply too: a dead TTS would otherwise open in silence.
            health.arm()

        if not notice:
            await ask_for_the_greeting()
            return
        # The notice plays on its own and the greeting is asked for once it has: run
        # together they can merge into one stretch of speech, and the deadline would
        # then take the notice for the greeting. It stays out of the LLM's context (a
        # trailing assistant line can be taken as one to continue); the instruction
        # tells the model instead.
        instruction += f' The caller has just heard "{notice}"; do not repeat it.'

        if prespoken:
            # Already playing on the line. Ask for the greeting GREETING_LEAD_SECS
            # before the notice ends, about what the LLM and voice take, so it
            # follows without a gap; Plivo plays the two in order, never over
            # each other, and the caller is muted until the notice is over.
            lead = env_float("GREETING_LEAD_SECS", DEFAULT_GREETING_LEAD_SECS)
            await asyncio.sleep(max(0.0, notice_ends_at - lead - time.monotonic()))
            transcript.event("recording_notice_played", notice=notice, prespoken=True)
            await ask_for_the_greeting()
            return

        async def after_the_notice():
            transcript.event("recording_notice_played", notice=notice)
            await ask_for_the_greeting()

        health.after_next_speech(after_the_notice)
        await worker.queue_frame(TTSSpeakFrame(notice, append_to_context=False))
        health.arm()  # the notice is due now: a TTS that says nothing is still caught

    return worker


def recordings_dir() -> Path:
    return Path(env("RECORDING_DIR") or HERE.parent.parent / "recordings")


def voice_follows_caller_language() -> bool:
    """Whether the voice is retuned to the caller's language, turn by turn.

    Only worth doing for a voice that speaks more than one language. Aura is
    English-only, so retuning it would be noise. TTS_FOLLOW_CALLER_LANGUAGE=false
    opts out.
    """
    provider = (env("TTS_PROVIDER") or "deepgram").lower()
    multilingual = provider in MULTILINGUAL_TTS_PROVIDERS
    follow = (env("TTS_FOLLOW_CALLER_LANGUAGE") or str(multilingual)).strip().lower() == "true"
    if follow and not multilingual:
        logger.warning(
            "TTS_FOLLOW_CALLER_LANGUAGE is on but this voice speaks one language; ignoring."
        )
        follow = False
    if follow:
        logger.info("Voice will follow the caller's language, turn by turn.")
    return follow


def build_tts_stack():
    """The TTS for the pipeline, with an optional backup provider behind it.

    Returns (processor for the pipeline, the services it can use, the switcher or None).
    TTS_FALLBACK_PROVIDER names a second provider. Both are built at startup, so a
    missing key stops the server at boot instead of surfacing mid-call, when the
    primary has already failed and the backup is the only thing left.
    """
    primary = build_tts()
    backup_name = (env("TTS_FALLBACK_PROVIDER") or "").strip().lower()
    if not backup_name:
        return primary, [primary], None
    primary_name = (env("TTS_PROVIDER") or "deepgram").strip().lower()
    if backup_name == primary_name:
        logger.error(f"TTS_FALLBACK_PROVIDER={backup_name!r} is the same as TTS_PROVIDER.")
        sys.exit(1)
    backup = build_tts(backup_name)
    switcher = ServiceSwitcher(
        services=[primary, backup], strategy_type=ServiceSwitcherStrategyFailover
    )
    logger.info(f"TTS: {primary_name}, backed up by {backup_name}")
    return switcher, [primary, backup], switcher


async def main() -> None:
    load_dotenv()
    ensure_ca_bundle()
    # Recordings past RECORDING_RETENTION_DAYS go before anything is recorded.
    try:
        delete_expired_recordings(recordings_dir(), recording_retention_days())
    except ValueError as e:
        logger.error(str(e))
        sys.exit(1)

    transport = LocalAudioTransport(
        LocalAudioTransportParams(audio_in_enabled=True, audio_out_enabled=True)
    )
    worker = build_worker(transport)

    runner = WorkerRunner()
    await runner.add_workers(worker)

    logger.info("Kaho AI voice agent is listening. Press Ctrl+C to stop.")
    await runner.run()
    if worker.health.failed:
        logger.error(f"The session ended because a provider failed: {worker.health.failed}")
        sys.exit(1)


if __name__ == "__main__":
    asyncio.run(main())

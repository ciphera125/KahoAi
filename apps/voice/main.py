"""Kaho AI voice agent entrypoint.

A terminal-only pipeline: your mic/speakers -> Deepgram (STT) -> Groq (LLM)
-> Deepgram, ElevenLabs, Sarvam or Smallest (TTS), with Silero VAD driving turn-taking. No web
server, no browser — run it with `python main.py` (or `./scripts/run_agent.sh`)
and talk.

TTS_PROVIDER picks the voice: Deepgram Aura is the default because it runs on
the STT key we already have and costs nothing extra to iterate against, but its
voices are English-only. Switch to ElevenLabs for Hindi and the other Indian
languages.
"""

import asyncio
import json
import os
import re
import ssl
import sys
import time
from datetime import UTC, datetime
from pathlib import Path

import certifi
import openai
from dotenv import load_dotenv
from interruptions import build_start_strategies
from loguru import logger
from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.audio.vad.vad_analyzer import VADParams
from pipecat.frames.frames import (
    EndTaskFrame,
    Frame,
    InterruptionFrame,
    LLMRunFrame,
    ManuallySwitchServiceFrame,
    MetricsFrame,
    TranscriptionFrame,
    TTSSpeakFrame,
    TTSUpdateSettingsFrame,
)
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
from pipecat.services.deepgram.stt import DeepgramSTTService
from pipecat.services.deepgram.tts import DeepgramTTSService
from pipecat.services.elevenlabs.tts import ElevenLabsTTSService
from pipecat.services.groq.llm import GroqLLMService
from pipecat.services.sarvam.tts import SarvamTTSService
from pipecat.services.settings import TTSSettings
from pipecat.services.smallest.tts import SmallestTTSService
from pipecat.services.tts_service import TextAggregationMode
from pipecat.transcriptions.language import Language
from pipecat.transports.local.audio import LocalAudioTransport, LocalAudioTransportParams
from pipecat.turns.user_mute import MuteUntilFirstBotCompleteUserMuteStrategy
from pipecat.turns.user_turn_strategies import UserTurnStrategies
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
full, so "rupees five hundred" and "three thirty in the afternoon".

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
SUPPORTED_TTS_PROVIDERS = ("deepgram", "elevenlabs", "sarvam", "smallest")


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


def env_float(name: str, default: float) -> float:
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


class TurnTimingLogger(BaseObserver):
    """Append one JSON object per metric to a log that latency_summary.py reads.

    Pipecat already measures each stage; this only writes what it reports to
    disk so runs can be compared after the fact instead of by squinting at a
    scrolling terminal. TTFA is the number that matters — time to first audio,
    i.e. what the caller actually waits through.
    """

    def __init__(self, path: Path):
        super().__init__()
        self._path = path
        self._path.parent.mkdir(parents=True, exist_ok=True)
        self._run = datetime.now(UTC).strftime("%Y%m%dT%H%M%S")
        self._seen: set[int] = set()

    def _write(self, record: dict) -> None:
        record |= {"run": self._run, "at": time.time()}
        with self._path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(record) + "\n")

    async def on_push_frame(self, data: FramePushed) -> None:
        frame = data.frame
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
            # Only durations. Usage metrics also carry a `value`, but theirs is
            # an object (token counts, audio seconds) that json would choke on.
            elif isinstance(getattr(item, "value", None), int | float):
                record["seconds"] = item.value
            else:
                continue
            self._write(record)


def load_system_prompt(persona_path: Path | None = None) -> str:
    """Build the system instruction: the voice rules, then the chosen persona.

    AGENT_SYSTEM_PROMPT_PATH swaps the persona without touching code — that file
    alone decides what the agent is, knows and does. See apps/voice/prompts/.
    A per-call `persona_path` (an outbound call's agent) wins over it. This exits
    the process on an unreadable file, so a caller taking names from the network
    must resolve them with personas.resolve() first.
    """
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

    # Retry the same turn on this model when the primary refuses it. Both models
    # are Groq's, on the same account and key, so this covers a failure specific
    # to the primary (its per-model rate limit, an outage of that model) and NOT
    # a Groq-wide outage: that is a known, accepted gap, left to resilience.py.
    DEFAULT_FALLBACK_MODEL = "openai/gpt-oss-20b"
    DEFAULT_FALLBACK_TIMEOUT_SECS = 3.0

    def __init__(
        self,
        *args,
        fallback_model: str | None = None,
        fallback_timeout_secs: float = DEFAULT_FALLBACK_TIMEOUT_SECS,
        on_fallback=None,
        **kwargs,
    ):
        super().__init__(*args, **kwargs)
        self._fallback_model = fallback_model
        self._fallback_timeout_secs = fallback_timeout_secs
        self._on_fallback = on_fallback

    @staticmethod
    def _worth_falling_back(exc: Exception) -> bool:
        """Rate limits, server errors and unreachable service. A 400 or 401 is
        our request or key, and the second model would fail the same way."""
        if isinstance(exc, openai.RateLimitError | openai.APIConnectionError):
            return True  # APITimeoutError is a subclass of APIConnectionError
        return isinstance(exc, openai.APIStatusError) and exc.status_code >= 500

    async def get_chat_completions(self, context):
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


def build_llm(persona_path: Path | None = None, on_fallback=None) -> GroqLLMService:
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
    return PortableGroqLLMService(
        api_key=env("GROQ_API_KEY"),
        fallback_model=None if fallback.lower() in ("off", "none") else fallback,
        fallback_timeout_secs=(
            float(fallback_secs)
            if fallback_secs
            else PortableGroqLLMService.DEFAULT_FALLBACK_TIMEOUT_SECS
        ),
        on_fallback=on_fallback,
        settings=GroqLLMService.Settings(
            model=env("GROQ_MODEL_ID"),
            system_instruction=load_system_prompt(persona_path),
            max_tokens=int(max_tokens) if max_tokens else None,
            temperature=float(temperature) if temperature else None,
            reasoning_effort=reasoning_effort,
        ),
    )


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


def speech_text_filters() -> list[BaseTextFilter]:
    """Strip markdown, then fix punctuation, before any text reaches the voice."""
    return [MarkdownTextFilter(), SpokenPunctuationFilter()]


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
) -> DeepgramTTSService | ElevenLabsTTSService | SarvamTTSService | SmallestTTSService:
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
    )
    tts, tts_services, switcher = build_tts_stack()

    # Masked transcript of every call. See transcript.py for why it is written
    # as text and with Aadhaar/PAN masked at the point of writing.
    call_id = call_id or datetime.now(UTC).strftime("local-%Y%m%dT%H%M%S")
    calls_dir = Path(env("CALL_LOG_DIR") or HERE.parent.parent / "logs" / "calls")
    transcript = CallTranscript(call_id, calls_dir)
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

    # Tools are opt-in per deployment through TOOLS_ENABLED (default: end_call).
    call = CallContext(call_id=call_id, transcript=transcript, caller_number=caller_number)
    call.transfer = transfer
    call.hang_up = lambda: llm.push_frame(EndTaskFrame(), FrameDirection.UPSTREAM)
    try:
        tool_schemas = build_tool_schemas(
            call,
            enabled_names(env("TOOLS_ENABLED")),
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
            # The caller can neither talk over the notice nor, with an early "hello?",
            # cancel it before it starts. Released once it has played, or if it fails.
            user_mute_strategies=[MuteUntilFirstBotCompleteUserMuteStrategy()] if notice else [],
        ),
    )

    # Only worth doing for a voice that speaks more than one language. Aura is
    # English-only, so retuning it would be noise; Sarvam, Smallest and
    # ElevenLabs are the multilingual ones. TTS_FOLLOW_CALLER_LANGUAGE=false opts out.
    provider = (env("TTS_PROVIDER") or "deepgram").lower()
    multilingual = provider in ("sarvam", "smallest", "elevenlabs")
    follow = (env("TTS_FOLLOW_CALLER_LANGUAGE") or str(multilingual)).strip().lower() == "true"
    if follow and not multilingual:
        logger.warning(
            "TTS_FOLLOW_CALLER_LANGUAGE is on but this voice speaks one language; ignoring."
        )
        follow = False
    if follow:
        logger.info("Voice will follow the caller's language, turn by turn.")

    follow_proc = FollowCallerLanguage() if follow else None

    pipeline = Pipeline(
        [
            transport.input(),
            stt,
            *([follow_proc] if follow_proc else []),
            user_aggregator,
            llm,
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

    health = CallHealth(
        {"stt": [stt], "llm": [llm], "tts": tts_services},
        record=transcript.event,
        interrupt_and_say=interrupt_and_say,
        abort=abort,
        switch_to=switch_to if switcher else None,
        say=say,
        filler=env("FILLER_MESSAGE") or DEFAULT_FILLER,
        filler_after_secs=env_float("FILLER_AFTER_SECS", FILLER_AFTER_SECS),
        wrappers={"tts": [switcher]} if switcher else None,
        apology=env("FAILURE_MESSAGE") or DEFAULT_APOLOGY,
        response_deadline_secs=env_float("RESPONSE_DEADLINE_SECS", RESPONSE_DEADLINE_SECS),
    )
    worker = PipelineWorker(
        pipeline,
        params=params,
        observers=[TurnTimingLogger(timings), BotSpeechObserver(health)],
    )
    worker.health = health
    worker.transcript = transcript
    worker.recorder = recorder
    logger.info(f"Per-turn timings -> {timings} (summarise: scripts/latency_summary.py)")

    transcript.attach(user_aggregator, assistant_aggregator)

    @worker.event_handler("on_pipeline_error")
    async def provider_error(worker, frame):
        await health.on_error(frame)

    @user_aggregator.event_handler("on_user_turn_stopped")
    async def reply_is_due(aggregator, strategy, message):
        health.arm()

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

        async def ask_for_the_greeting():
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

        async def after_the_notice():
            transcript.event("recording_notice_played", notice=notice)
            await ask_for_the_greeting()

        health.after_next_speech(after_the_notice)
        await worker.queue_frame(TTSSpeakFrame(notice, append_to_context=False))
        health.arm()  # the notice is due now: a TTS that says nothing is still caught

    return worker


def recordings_dir() -> Path:
    return Path(env("RECORDING_DIR") or HERE.parent.parent / "recordings")


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

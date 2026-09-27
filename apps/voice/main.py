"""Kaho AI voice agent entrypoint.

A terminal-only pipeline: your mic/speakers -> Deepgram (STT) -> Groq (LLM)
-> Deepgram or ElevenLabs (TTS), with Silero VAD driving turn-taking. No web
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
from dotenv import load_dotenv
from loguru import logger
from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.audio.vad.vad_analyzer import VADParams
from pipecat.frames.frames import LLMRunFrame, MetricsFrame
from pipecat.observers.base_observer import BaseObserver, FramePushed
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.worker import PipelineParams, PipelineWorker
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import (
    LLMContextAggregatorPair,
    LLMUserAggregatorParams,
)
from pipecat.services.deepgram.stt import DeepgramSTTService
from pipecat.services.deepgram.tts import DeepgramTTSService
from pipecat.services.elevenlabs.tts import ElevenLabsTTSService
from pipecat.services.groq.llm import GroqLLMService
from pipecat.services.sarvam.tts import SarvamTTSService
from pipecat.services.tts_service import TextAggregationMode
from pipecat.transports.local.audio import LocalAudioTransport, LocalAudioTransportParams
from pipecat.utils.text.base_text_filter import BaseTextFilter
from pipecat.utils.text.markdown_text_filter import MarkdownTextFilter
from pipecat.workers.runner import WorkerRunner

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

Always reply in English, including your opening line. Even when the caller
speaks Hindi or Hinglish, understand them and answer in English. Never reply in
Hindi, never mix a Hindi word into an English sentence, and never use another
script. Greet with "Hello" or "Hi", never "Namaste".

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
SUPPORTED_TTS_PROVIDERS = ("deepgram", "elevenlabs", "sarvam")


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


def load_system_prompt() -> str:
    """Build the system instruction: the voice rules, then the chosen persona.

    AGENT_SYSTEM_PROMPT_PATH swaps the persona without touching code — that file
    alone decides what the agent is, knows and does. See apps/voice/prompts/.
    """
    path = Path(env("AGENT_SYSTEM_PROMPT_PATH") or DEFAULT_PROMPT_PATH)
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


def build_llm() -> GroqLLMService:
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
    return GroqLLMService(
        api_key=env("GROQ_API_KEY"),
        settings=GroqLLMService.Settings(
            model=env("GROQ_MODEL_ID"),
            system_instruction=load_system_prompt(),
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


def build_tts() -> DeepgramTTSService | ElevenLabsTTSService | SarvamTTSService:
    provider = (env("TTS_PROVIDER") or "deepgram").lower()
    if provider not in SUPPORTED_TTS_PROVIDERS:
        logger.error(
            f"TTS_PROVIDER={provider!r} isn't wired up — expected one of "
            f"{', '.join(SUPPORTED_TTS_PROVIDERS)}."
        )
        sys.exit(1)

    if provider == "sarvam":
        require_env("SARVAM_API_KEY", "SARVAM_VOICE_ID")
        # Sarvam is the one provider here with a real character buffer.
        # min_buffer_size is how much text it collects before it starts
        # speaking: small starts sooner but gives the voice less to plan its
        # intonation with, which is what makes short fragments sound clipped.
        return SarvamTTSService(
            api_key=env("SARVAM_API_KEY"),
            settings=SarvamTTSService.Settings(
                voice=env("SARVAM_VOICE_ID"),
                model=env("SARVAM_MODEL_ID"),
                language=env("SARVAM_LANGUAGE"),
                pace=env_float("SARVAM_PACE", 1.0),
                min_buffer_size=env_int("SARVAM_MIN_BUFFER_SIZE"),
                max_chunk_length=env_int("SARVAM_MAX_CHUNK_LENGTH"),
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


async def main() -> None:
    load_dotenv()
    ensure_ca_bundle()
    require_env("DEEPGRAM_API_KEY")

    transport = LocalAudioTransport(
        LocalAudioTransportParams(audio_in_enabled=True, audio_out_enabled=True)
    )

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

    llm = build_llm()
    tts = build_tts()

    context = LLMContext()
    user_aggregator, assistant_aggregator = LLMContextAggregatorPair(
        context,
        user_params=LLMUserAggregatorParams(vad_analyzer=build_vad()),
    )

    pipeline = Pipeline(
        [
            transport.input(),
            stt,
            user_aggregator,
            llm,
            tts,
            transport.output(),
            assistant_aggregator,
        ]
    )

    timings = Path(env("LATENCY_LOG_PATH") or HERE.parent.parent / "logs" / "turns.jsonl")
    worker = PipelineWorker(
        pipeline,
        params=PipelineParams(enable_metrics=True, enable_usage_metrics=True),
        observers=[TurnTimingLogger(timings)],
    )
    logger.info(f"Per-turn timings -> {timings} (summarise: scripts/latency_summary.py)")

    @worker.event_handler("on_pipeline_started")
    async def greet(worker, frame):
        # Sent as "user", not "developer". Qwen's chat template refuses a
        # conversation with no user turn ("No user query found in messages",
        # HTTP 400) and the LLM service is then marked unusable, so the call
        # opens in silence. gpt-oss happens to tolerate "developer"; a role
        # every model accepts is the portable choice, since the whole point of
        # GROQ_MODEL_ID is being able to swap models freely.
        context.add_message(
            {"role": "user", "content": "Start by concisely introducing yourself."}
        )
        await worker.queue_frames([LLMRunFrame()])

    runner = WorkerRunner()
    await runner.add_workers(worker)

    logger.info("Kaho AI voice agent is listening. Press Ctrl+C to stop.")
    await runner.run()


if __name__ == "__main__":
    asyncio.run(main())

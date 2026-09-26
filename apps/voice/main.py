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
import os
import ssl
import sys

import certifi
from dotenv import load_dotenv
from loguru import logger
from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.frames.frames import LLMRunFrame
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
from pipecat.transports.local.audio import LocalAudioTransport, LocalAudioTransportParams
from pipecat.workers.runner import WorkerRunner

SYSTEM_INSTRUCTION = (
    "You are Kaho, a helpful voice assistant for the Indian market. Your "
    "responses will be spoken aloud, so avoid emojis, bullet points, or any "
    "formatting that can't be spoken. Keep answers brief and conversational."
)

# Providers we know how to wire up. Bedrock support (Claude Haiku 4.5) lands
# later; for now Groq is the only LLM_PROVIDER this entrypoint understands.
SUPPORTED_LLM_PROVIDERS = ("groq",)
SUPPORTED_TTS_PROVIDERS = ("deepgram", "elevenlabs")


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
            system_instruction=SYSTEM_INSTRUCTION,
            max_tokens=int(max_tokens) if max_tokens else None,
            temperature=float(temperature) if temperature else None,
            reasoning_effort=reasoning_effort,
        ),
    )


def build_tts() -> DeepgramTTSService | ElevenLabsTTSService:
    provider = (env("TTS_PROVIDER") or "deepgram").lower()
    if provider not in SUPPORTED_TTS_PROVIDERS:
        logger.error(
            f"TTS_PROVIDER={provider!r} isn't wired up — expected one of "
            f"{', '.join(SUPPORTED_TTS_PROVIDERS)}."
        )
        sys.exit(1)

    if provider == "elevenlabs":
        require_env("ELEVENLABS_API_KEY", "ELEVENLABS_VOICE_ID")
        return ElevenLabsTTSService(
            api_key=env("ELEVENLABS_API_KEY"),
            settings=ElevenLabsTTSService.Settings(
                voice=env("ELEVENLABS_VOICE_ID"),
                model=env("ELEVENLABS_MODEL_ID"),
            ),
        )

    require_env("DEEPGRAM_API_KEY", "DEEPGRAM_VOICE_ID")
    return DeepgramTTSService(
        api_key=env("DEEPGRAM_API_KEY"),
        settings=DeepgramTTSService.Settings(voice=env("DEEPGRAM_VOICE_ID")),
    )


async def main() -> None:
    load_dotenv()
    ensure_ca_bundle()
    require_env("DEEPGRAM_API_KEY")

    transport = LocalAudioTransport(
        LocalAudioTransportParams(audio_in_enabled=True, audio_out_enabled=True)
    )

    stt = DeepgramSTTService(
        api_key=env("DEEPGRAM_API_KEY"),
        settings=DeepgramSTTService.Settings(
            model=env("DEEPGRAM_MODEL"),
            language=env("DEEPGRAM_LANGUAGE"),
        ),
    )

    llm = build_llm()
    tts = build_tts()

    context = LLMContext()
    user_aggregator, assistant_aggregator = LLMContextAggregatorPair(
        context,
        user_params=LLMUserAggregatorParams(vad_analyzer=SileroVADAnalyzer()),
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

    worker = PipelineWorker(
        pipeline,
        params=PipelineParams(enable_metrics=True, enable_usage_metrics=True),
    )

    @worker.event_handler("on_pipeline_started")
    async def greet(worker, frame):
        context.add_message(
            {"role": "developer", "content": "Start by concisely introducing yourself."}
        )
        await worker.queue_frames([LLMRunFrame()])

    runner = WorkerRunner()
    await runner.add_workers(worker)

    logger.info("Kaho AI voice agent is listening. Press Ctrl+C to stop.")
    await runner.run()


if __name__ == "__main__":
    asyncio.run(main())

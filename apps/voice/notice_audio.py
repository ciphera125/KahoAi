"""The recording notice, synthesised once and ready to send the instant a call opens.

Pickup to the first audible word took ~1.8s on call ddedb4fd (2026-10-24), and
almost all of it was ours: the pipeline will not speak until every provider has
connected (~0.93s for Deepgram), and the voice put 0.26s of silence before the
notice. The notice is the same words on every call, so the server synthesises it
at startup with the call's own voice, trims the leading silence, and keeps it as
8kHz mu-law, the phone line's own format. server.py sends it as Plivo playAudio
messages as soon as the stream starts, while the pipeline connects behind it.
"""

from __future__ import annotations

import array
import asyncio
import base64
import json
from dataclasses import dataclass

from loguru import logger
from pipecat.audio.utils import create_file_resampler, pcm_to_ulaw, ulaw_to_pcm
from pipecat.frames.frames import TTSAudioRawFrame, TTSSpeakFrame, TTSStoppedFrame
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.worker import PipelineParams, PipelineWorker
from pipecat.processors.frame_processor import FrameProcessor
from pipecat.workers.runner import WorkerRunner

PHONE_RATE = 8000
CHUNK_MS = 100  # one playAudio message per 100ms: Plivo queues and plays them in order
SILENCE_LEVEL = 300  # 16-bit amplitude below which a sample counts as silence


def trim_leading_silence(pcm: bytes, sample_rate: int, keep_ms: int = 30) -> bytes:
    """Drop the silence before the first sound, keeping `keep_ms` of it so the first
    syllable is not clipped. Audio that is all silence is returned unchanged."""
    samples = array.array("h", pcm)
    first = next((i for i, s in enumerate(samples) if abs(s) > SILENCE_LEVEL), None)
    if first is None:
        return pcm
    start = max(0, first - int(sample_rate * keep_ms / 1000))
    return samples[start:].tobytes()


@dataclass(frozen=True)
class PrespokenNotice:
    text: str
    ulaw_chunks: tuple[bytes, ...]
    pcm_8k: bytes  # the same audio as 16-bit PCM at 8kHz, for the call recording
    duration_secs: float

    @classmethod
    async def from_pcm(cls, text: str, pcm: bytes, sample_rate: int) -> PrespokenNotice:
        audio = trim_leading_silence(pcm, sample_rate)
        ulaw = await pcm_to_ulaw(audio, sample_rate, PHONE_RATE, create_file_resampler())
        pcm_8k = await ulaw_to_pcm(ulaw, PHONE_RATE, PHONE_RATE, create_file_resampler())
        step = PHONE_RATE * CHUNK_MS // 1000
        chunks = tuple(ulaw[i:i + step] for i in range(0, len(ulaw), step))
        return cls(text, chunks, pcm_8k, len(ulaw) / PHONE_RATE)

    def messages(self, stream_id: str) -> list[str]:
        """The notice as Plivo playAudio messages for one call's stream."""
        return [json.dumps({"event": "playAudio", "streamId": stream_id,
                            "media": {"contentType": "audio/x-mulaw", "sampleRate": PHONE_RATE,
                                      "payload": base64.b64encode(chunk).decode("ascii")}})
                for chunk in self.ulaw_chunks]


class _Collect(FrameProcessor):
    def __init__(self, done: asyncio.Event):
        super().__init__()
        self.audio = bytearray()
        self.sample_rate: int | None = None
        self._done = done

    async def process_frame(self, frame, direction):
        await super().process_frame(frame, direction)
        if isinstance(frame, TTSAudioRawFrame):
            self.audio += frame.audio
            self.sample_rate = frame.sample_rate
        elif isinstance(frame, TTSStoppedFrame) and self.audio:
            self._done.set()
        await self.push_frame(frame, direction)


STOP_SECS = 2.0


async def _stop(worker: PipelineWorker, running: asyncio.Task) -> None:
    """Tear the one-off pipeline down within STOP_SECS, whatever the voice does.
    The real Smallest service held an EndFrame and the cancel after it, and the
    server never finished starting (2026-10-24); so every step has a limit and
    the task is abandoned if it will not end."""
    try:
        await asyncio.wait_for(worker.cancel(), STOP_SECS)
    except (TimeoutError, Exception):  # noqa: BLE001
        pass
    running.cancel()
    try:
        await asyncio.wait_for(asyncio.shield(running), STOP_SECS)
    except (TimeoutError, asyncio.CancelledError, Exception):  # noqa: BLE001
        logger.debug("The notice synthesis pipeline did not stop; left behind")


async def synthesise(text: str, tts: FrameProcessor, sample_rate: int,
                     timeout: float = 10.0) -> PrespokenNotice | None:
    """Say `text` once with `tts` (a fresh TTS service) and keep the audio. None if
    the voice gives nothing in `timeout`: calls then speak the notice the normal way."""
    done = asyncio.Event()
    collect = _Collect(done)
    worker = PipelineWorker(Pipeline([tts, collect]),
                            params=PipelineParams(audio_out_sample_rate=sample_rate))
    running = asyncio.create_task(WorkerRunner(handle_sigint=False).run(worker))
    try:
        await worker.queue_frames([TTSSpeakFrame(text)])
        await asyncio.wait_for(done.wait(), timeout)
        await asyncio.sleep(0.2)  # any audio still on its way after the stop
    except TimeoutError:
        logger.warning(f"The recording notice was not synthesised within {timeout:g}s; "
                       "calls will speak it the normal way")
        return None
    except Exception as e:  # noqa: BLE001 - a missing cache only costs the head start
        logger.warning(f"Could not synthesise the recording notice: {type(e).__name__}")
        return None
    finally:
        await _stop(worker, running)
    return await PrespokenNotice.from_pcm(text, bytes(collect.audio),
                                          collect.sample_rate or sample_rate)

"""Per-call audio recordings: recordings/<call_id>.wav, caller left, agent right.

The owner's decisions (2026-10-02): every call is recorded, the caller is not
told, and recordings are kept until the owner deletes them. Audio cannot be
masked the way text is, so a recording holds any Aadhaar or PAN the caller reads
out, in full. That is accepted; it is why recordings live in their own gitignored
directory, apart from the masked transcripts in logs/calls/, and why nothing
else (summary, tools) ever reads them.

Pipecat's AudioBufferProcessor keeps the two sides in step. Its own way of
handing over audio in chunks (`buffer_size`) pads the shorter side to the longer
before emptying both, and measured, that puts a gap into whoever is speaking at
that moment and shifts them later for the rest of the utterance: a 6s test call
came out 6.65s long with the agent's reply broken in four. So the chunking here
hands over only the stretch both sides already cover and leaves the rest where
it is, which keeps the two sides exactly where Pipecat put them. Chunks go
straight to disk, so a crash loses at most one, and Python's wave module rewrites
the header after every chunk, so the file stays playable even if never closed.

Failure policy: a recording must never disturb the call. A disk error is caught,
logged, recorded in the transcript as `recording_failed`, and recording stops for
that call; the conversation goes on. Nothing is raised.
"""

import re
import wave
from pathlib import Path

from loguru import logger
from pipecat.audio.utils import interleave_stereo_audio
from pipecat.processors.audio.audio_buffer_processor import AudioBufferProcessor
from resilience import safe_reason

_UNSAFE = re.compile(r"[^A-Za-z0-9_.-]")

# Audio is written every this many seconds of call, which bounds both the memory
# a call holds and what a crash can lose.
CHUNK_SECS = 5.0


class CallRecorder:
    def __init__(
        self,
        call_id: str,
        directory: Path,
        sample_rate: int,
        record=None,
        chunk_secs: float = CHUNK_SECS,
    ):
        """record(event, **fields) writes a marker line, normally CallTranscript.event."""
        # The id comes from the network on a phone call, so it is not trusted to
        # be a safe filename.
        safe_id = _UNSAFE.sub("_", call_id)[:100] or "unknown"
        self.path = directory / f"{safe_id}.wav"
        self.sample_rate = sample_rate
        self._directory = directory
        self._record = record or (lambda *a, **k: None)
        self._chunk_bytes = max(2, int(sample_rate * chunk_secs) * 2)  # per side, 16-bit
        self._wav: wave.Wave_write | None = None
        self._failed = False
        self._closed = False

    def processor(self) -> AudioBufferProcessor:
        """The pipeline processor that feeds this recorder. Place it after transport.output()."""
        buffer = _ChunkedAudioBuffer(
            self.write,
            self._chunk_bytes,
            sample_rate=self.sample_rate,
            num_channels=2,
            auto_start_recording=True,
        )

        # What is left when the call ends. Pipecat raises these in their own tasks,
        # in order, and the call's teardown waits for them, so the last audio is
        # written before the file is closed.
        @buffer.event_handler("on_audio_data")
        async def _rest(processor, audio, sample_rate, num_channels):
            self.write(audio, sample_rate, num_channels)

        @buffer.event_handler("on_recording_stopped")
        async def _stopped(processor):
            self.close()

        return buffer

    @property
    def failed(self) -> bool:
        return self._failed

    def write(self, audio: bytes, sample_rate: int, num_channels: int) -> None:
        if self._failed or not audio:
            return
        if self._closed:
            logger.warning(f"Recording {self.path.name}: {len(audio)} bytes after closing, dropped")
            return
        try:
            if self._wav is None:
                self._directory.mkdir(parents=True, exist_ok=True)
                self._wav = wave.open(str(self.path), "wb")
                self._wav.setnchannels(num_channels)
                self._wav.setsampwidth(2)
                self._wav.setframerate(sample_rate)
                logger.info(f"Recording -> {self.path}")
            elif (sample_rate, num_channels) != (
                self._wav.getframerate(),
                self._wav.getnchannels(),
            ):
                # Never seen; appending it would corrupt everything already saved.
                raise ValueError(f"audio format changed mid-call: {sample_rate}Hz x{num_channels}")
            self._wav.writeframes(audio)
        except Exception as e:  # noqa: BLE001 - a recording must never break the call
            self._fail(e)

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        if self._wav is None:
            return
        try:
            seconds = round(self._wav.getnframes() / self._wav.getframerate(), 1)
            self._wav.close()
        except Exception as e:  # noqa: BLE001
            self._fail(e)
            return
        self._wav = None
        self._record("recording_saved", file=self.path.name, seconds=seconds)
        logger.info(f"Recording saved: {self.path} ({seconds}s)")

    def _fail(self, error: Exception) -> None:
        self._failed = True
        reason = safe_reason(error)
        logger.error(f"Recording stopped for this call; the call goes on: {reason}")
        self._record("recording_failed", reason=reason)
        if self._wav is not None:
            try:
                self._wav.close()
            except Exception:  # noqa: BLE001 - already failing; the marker is written
                pass
            self._wav = None


class _ChunkedAudioBuffer(AudioBufferProcessor):
    """Hands over the audio both sides already cover, every `chunk_bytes` per side.

    It reads Pipecat's two private buffers, which no public method exposes. If a
    Pipecat release changes them, the call is unaffected: the whole recording is
    handed over when the call ends instead, through Pipecat's own public event.
    """

    def __init__(self, write, chunk_bytes: int, **kwargs):
        super().__init__(buffer_size=0, **kwargs)  # 0: Pipecat's own chunking is off
        self._write = write
        self._chunk_bytes = chunk_bytes
        self.chunking = all(
            isinstance(getattr(self, name, None), bytearray)
            for name in ("_user_audio_buffer", "_bot_audio_buffer")
        )
        if not self.chunking:
            logger.error("Pipecat's audio buffer changed; recordings are written as each call ends")

    async def process_frame(self, frame, direction):
        await super().process_frame(frame, direction)
        if self.chunking:
            try:
                self._hand_over_settled_audio()
            except Exception as e:  # noqa: BLE001 - never the call's problem
                self.chunking = False
                logger.error(f"Recording falls back to writing as the call ends: {safe_reason(e)}")

    def _hand_over_settled_audio(self) -> None:
        # Pipecat replaces these buffers when it resets, so read them every time.
        user, bot = self._user_audio_buffer, self._bot_audio_buffer
        settled = min(len(user), len(bot))
        settled -= settled % 2
        if settled < self._chunk_bytes:
            return
        audio = interleave_stereo_audio(bytes(user[:settled]), bytes(bot[:settled]))
        # Removing the same length from both keeps every later position in step.
        del user[:settled]
        del bot[:settled]
        self._write(audio, self.sample_rate, 2)

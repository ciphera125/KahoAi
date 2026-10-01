"""Call recordings: what lands on disk, and that a broken disk never breaks the call."""

import array
import json
import math
import wave
from pathlib import Path

import pytest
from pipecat.frames.frames import (
    CancelFrame,
    ErrorFrame,
    InputAudioRawFrame,
    OutputAudioRawFrame,
    TextFrame,
)
from pipecat.pipeline.pipeline import Pipeline
from pipecat.processors.frame_processor import FrameProcessor
from pipecat.tests.utils import SleepFrame, run_test
from recording import CallRecorder
from transcript import CallTranscript

RATE = 8000


def tone(seconds: float, rate: int, hz: float = 440.0, amp: int = 8000) -> bytes:
    n = int(seconds * rate)
    wave_ = (int(amp * math.sin(2 * math.pi * hz * i / rate)) for i in range(n))
    return array.array("h", wave_).tobytes()


def conversation(caller_secs: float, agent_secs: float) -> list:
    """The caller speaks, then the agent replies, framed as a real call delivers it.

    Input audio arrives every 20ms for the whole call, silence included, and the
    recorder lines the two sides up by it; output audio arrives while the agent
    speaks. Input is at the pipeline's 16kHz, output at its default 24kHz. Input
    audio is a system frame and jumps ahead of queued output audio, so each 20ms
    pair is let through before the next, as real time would.
    """
    frames = []
    speech = tone(caller_secs, 16000)
    for i in range(0, len(speech), 640):  # 20ms at 16kHz, 16-bit
        frames.append(InputAudioRawFrame(speech[i : i + 640], sample_rate=16000, num_channels=1))
    reply = tone(agent_secs, 24000)
    for i in range(0, len(reply), 960):  # 20ms at 24kHz
        frames.append(InputAudioRawFrame(bytes(640), sample_rate=16000, num_channels=1))
        frames.append(OutputAudioRawFrame(reply[i : i + 960], sample_rate=24000, num_channels=1))
        frames.append(SleepFrame(0.005))
    return frames


def channels(path: Path) -> tuple[list[int], list[int], int]:
    """(left samples, right samples, sample rate) of a stereo WAV."""
    with wave.open(str(path), "rb") as w:
        assert w.getnchannels() == 2 and w.getsampwidth() == 2
        samples = array.array("h", w.readframes(w.getnframes()))
        return list(samples[0::2]), list(samples[1::2]), w.getframerate()


def rms(samples: list[int]) -> float:
    return math.sqrt(sum(s * s for s in samples) / len(samples)) if samples else 0.0


def events(transcript: CallTranscript) -> list[dict]:
    return [json.loads(line) for line in transcript.path.read_text(encoding="utf-8").splitlines()]


@pytest.fixture
def transcript(tmp_path):
    return CallTranscript("call-1", tmp_path / "calls")


def recorder(tmp_path, transcript, **kw) -> CallRecorder:
    return CallRecorder("call-1", tmp_path / "recordings", RATE, record=transcript.event, **kw)


async def test_caller_is_on_the_left_and_the_agent_on_the_right_in_time_order(tmp_path, transcript):
    rec = recorder(tmp_path, transcript)
    await run_test(rec.processor(), frames_to_send=conversation(1.0, 1.0))

    left, right, rate = channels(rec.path)
    assert rate == RATE
    assert len(left) == pytest.approx(2 * RATE, abs=RATE // 10)  # resamplers hold back a little
    first, second = slice(800, RATE - 800), slice(RATE + 800, 2 * RATE - 800)  # 0.1s off each edge
    assert rms(left[first]) > 4000 and rms(right[first]) < 100  # the caller spoke first
    assert rms(right[second]) > 4000 and rms(left[second]) < 100  # then the agent replied


async def test_writing_as_the_call_goes_changes_nothing_in_the_recording(tmp_path):
    """Pipecat's own chunking moved the speaker at every write (measured); ours must not."""
    as_it_goes = CallRecorder("chunked", tmp_path, RATE, chunk_secs=0.1)
    at_the_end = CallRecorder("whole", tmp_path, RATE, chunk_secs=1000)
    writes = []
    original = as_it_goes.write
    as_it_goes.write = lambda audio, *a: (writes.append(len(audio)), original(audio, *a))

    both = Pipeline([as_it_goes.processor(), at_the_end.processor()])
    await run_test(both, frames_to_send=[*conversation(1.0, 3.0), *conversation(1.0, 1.0)])

    assert len(writes) > 30
    assert channels(as_it_goes.path) == channels(at_the_end.path)
    _, right, _ = channels(as_it_goes.path)
    reply = right[int(1.1 * RATE) : int(3.9 * RATE)]
    gaps = [i for i in range(0, len(reply) - 160, 160) if rms(reply[i : i + 160]) < 2000]
    assert gaps == []  # the agent's 3s reply is one unbroken stretch


async def test_a_hang_up_still_saves_the_recording(tmp_path, transcript):
    """A caller hanging up cancels the pipeline rather than ending it."""
    rec = recorder(tmp_path, transcript)
    frames = [*conversation(0.5, 0.5), CancelFrame()]
    await run_test(rec.processor(), frames_to_send=frames, send_end_frame=False)
    left, _, _ = channels(rec.path)
    assert len(left) == pytest.approx(RATE, abs=RATE // 10)
    saved = [e for e in events(transcript) if e["event"] == "recording_saved"]
    assert saved == [saved[0]] and saved[0]["file"] == "call-1.wav"
    assert saved[0]["seconds"] == pytest.approx(1.0, abs=0.1)


def test_the_file_is_playable_before_it_is_closed(tmp_path, transcript):
    """What a crash mid-call leaves behind: every chunk written so far, readable."""
    rec = recorder(tmp_path, transcript)
    rec.write(tone(0.5, RATE) * 2, RATE, 2)
    rec.write(tone(0.5, RATE) * 2, RATE, 2)
    with wave.open(str(rec.path), "rb") as w:  # rec is still open
        assert w.getnframes() == RATE
    rec.close()


def test_a_call_with_no_audio_leaves_no_file_and_no_marker(tmp_path, transcript):
    rec = recorder(tmp_path, transcript)
    rec.close()
    rec.close()
    assert not rec.path.exists()
    assert [e["event"] for e in events(transcript)] == ["call_start"]


def test_closing_twice_records_the_save_once(tmp_path, transcript):
    rec = recorder(tmp_path, transcript)
    rec.write(tone(0.5, RATE) * 2, RATE, 2)
    rec.close()
    rec.close()
    rec.write(tone(0.5, RATE) * 2, RATE, 2)  # late audio is dropped, not appended
    assert [e["event"] for e in events(transcript)].count("recording_saved") == 1
    with wave.open(str(rec.path), "rb") as w:
        assert w.getnframes() == RATE // 2


def test_hostile_call_id_cannot_escape_the_directory(tmp_path):
    rec = CallRecorder("../../etc/passwd", tmp_path, RATE)
    assert rec.path.parent == tmp_path


def test_an_unwritable_folder_is_recorded_as_a_failure_not_raised(tmp_path, transcript):
    blocker = tmp_path / "recordings"
    blocker.write_text("a file where the folder should be")
    rec = recorder(tmp_path, transcript)

    rec.write(tone(0.5, RATE) * 2, RATE, 2)
    rec.write(tone(0.5, RATE) * 2, RATE, 2)  # no second attempt, no second marker
    rec.close()

    assert rec.failed
    marks = [e for e in events(transcript) if e["event"].startswith("recording")]
    assert [m["event"] for m in marks] == ["recording_failed"]
    assert marks[0]["reason"]


async def test_a_disk_failure_mid_call_stops_recording_and_the_call_goes_on(
    tmp_path, transcript, monkeypatch
):
    rec = recorder(tmp_path, transcript, chunk_secs=0.1)
    calls = {"n": 0}
    real = wave.Wave_write.writeframes

    def full_disk_on_third_chunk(self, data):
        calls["n"] += 1
        if calls["n"] == 3:
            raise OSError(28, "No space left on device")
        real(self, data)

    monkeypatch.setattr(wave.Wave_write, "writeframes", full_disk_on_third_chunk)
    marker = TextFrame(text="the agent kept talking")
    down, _ = await run_test(rec.processor(), frames_to_send=[*conversation(1.0, 1.0), marker])

    assert marker in down  # frames still flowed past the recorder
    assert rec.failed and calls["n"] == 3  # nothing more was attempted after the failure
    failed = [e for e in events(transcript) if e["event"] == "recording_failed"]
    assert len(failed) == 1 and "No space left" in failed[0]["reason"]
    assert not [e for e in events(transcript) if e["event"] == "recording_saved"]


def test_a_change_of_format_mid_call_is_a_failure_not_a_corrupt_file(tmp_path, transcript):
    rec = recorder(tmp_path, transcript)
    rec.write(tone(0.5, RATE) * 2, RATE, 2)
    rec.write(tone(0.5, 16000) * 2, 16000, 2)
    assert rec.failed
    with wave.open(str(rec.path), "rb") as w:
        assert w.getframerate() == RATE and w.getnframes() == RATE // 2


async def test_if_writing_as_it_goes_breaks_the_whole_call_is_written_at_the_end(
    tmp_path, transcript, monkeypatch
):
    """What a Pipecat upgrade that changes its buffers would do: no harm to the call."""
    import recording

    attempts = []

    def broken(*args):
        attempts.append(1)
        raise AttributeError("'AudioBufferProcessor' object has no attribute '_user_audio_buffer'")

    monkeypatch.setattr(recording, "interleave_stereo_audio", broken)
    rec = recorder(tmp_path, transcript, chunk_secs=0.1)
    marker = TextFrame(text="the agent kept talking")
    down, up = await run_test(rec.processor(), frames_to_send=[*conversation(1.0, 1.0), marker])

    assert marker in down
    # Uncaught, Pipecat would report an error upstream on every audio frame.
    assert len(attempts) == 1 and not any(isinstance(f, ErrorFrame) for f in up)
    left, right, _ = channels(rec.path)
    assert len(left) == pytest.approx(2 * RATE, abs=RATE // 10)
    assert rms(left[800 : RATE - 800]) > 4000 and rms(right[RATE + 800 : -800]) > 4000


def test_the_installed_pipecat_supports_writing_as_the_call_goes():
    """Fails after a Pipecat upgrade that changes its buffers. Calls would still be
    recorded, but held whole in memory and written when they end."""
    assert CallRecorder("x", Path("unused"), RATE).processor().chunking


class FakeTransport:
    def __init__(self):
        self.out = FrameProcessor(name="transport-output")

    def input(self):
        return FrameProcessor(name="transport-input")

    def output(self):
        return self.out


@pytest.fixture
def worker_env(monkeypatch, tmp_path):
    for name in ("DEEPGRAM_API_KEY", "GROQ_API_KEY"):
        monkeypatch.setenv(name, "k")
    monkeypatch.setenv("GROQ_MODEL_ID", "qwen/qwen3.8-27b")
    monkeypatch.setenv("TTS_PROVIDER", "deepgram")
    monkeypatch.setenv("DEEPGRAM_VOICE_ID", "aura-2-thalia-en")
    monkeypatch.delenv("TTS_FALLBACK_PROVIDER", raising=False)
    monkeypatch.setenv("CALL_LOG_DIR", str(tmp_path / "calls"))
    monkeypatch.setenv("RECORDING_DIR", str(tmp_path / "recordings"))
    monkeypatch.setenv("LATENCY_LOG_PATH", str(tmp_path / "turns.jsonl"))
    monkeypatch.delenv("RECORDING_ENABLED", raising=False)


def pipeline_processors(worker) -> list:
    """Every leaf processor in the worker's pipeline, in order."""

    def flatten(processors):
        for p in processors:
            yield from flatten(p.processors) if p.processors else [p]

    return list(flatten(worker._pipeline.processors))


def test_every_call_is_recorded_right_after_the_transport_output(worker_env, tmp_path):
    from main import build_worker
    from pipecat.processors.audio.audio_buffer_processor import AudioBufferProcessor

    transport = FakeTransport()
    worker = build_worker(transport, call_id="call-9", recording_sample_rate=RATE)

    assert worker.recorder.path == tmp_path / "recordings" / "call-9.wav"
    assert worker.recorder.sample_rate == RATE
    procs = pipeline_processors(worker)
    after_output = procs[procs.index(transport.out) + 1]
    assert isinstance(after_output, AudioBufferProcessor)


def test_recording_can_be_turned_off(worker_env, monkeypatch):
    from main import build_worker
    from pipecat.processors.audio.audio_buffer_processor import AudioBufferProcessor

    monkeypatch.setenv("RECORDING_ENABLED", "false")
    worker = build_worker(FakeTransport(), call_id="call-10")
    assert worker.recorder is None
    assert not any(isinstance(p, AudioBufferProcessor) for p in pipeline_processors(worker))


def test_the_recordings_folder_is_never_committed():
    """Recordings hold callers' voices and any ID number they read out, unmasked."""
    gitignore = Path(__file__).resolve().parents[3] / ".gitignore"
    assert "recordings/" in gitignore.read_text(encoding="utf-8").splitlines()

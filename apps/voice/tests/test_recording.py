"""Call recordings: what lands on disk, and that a broken disk never breaks the call."""

import array
import json
import math
import os
import time
import wave
from pathlib import Path

import pytest
from pipecat.frames.frames import (
    BotStartedSpeakingFrame,
    BotStoppedSpeakingFrame,
    CancelFrame,
    ErrorFrame,
    InputAudioRawFrame,
    OutputAudioRawFrame,
    TextFrame,
    UserStartedSpeakingFrame,
    UserStoppedSpeakingFrame,
)
from pipecat.pipeline.pipeline import Pipeline
from pipecat.processors.frame_processor import FrameProcessor
from pipecat.tests.utils import SleepFrame, run_test
from recording import CallRecorder, delete_expired_recordings, recording_retention_days
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

    Around each side's speech go the signals a real call carries (the user
    aggregator's user started/stopped speaking, the output transport's bot
    started/stopped speaking). They tell the recorder whose side is live, so it
    never pads silence into the middle of someone's speech; without them, a busy
    machine that let a frame through late put gaps into the agent's audio.
    """
    frames = [UserStartedSpeakingFrame()]
    speech = tone(caller_secs, 16000)
    for i in range(0, len(speech), 640):  # 20ms at 16kHz, 16-bit
        frames.append(InputAudioRawFrame(speech[i : i + 640], sample_rate=16000, num_channels=1))
    frames += [UserStoppedSpeakingFrame(), BotStartedSpeakingFrame()]
    reply = tone(agent_secs, 24000)
    for i in range(0, len(reply), 960):  # 20ms at 24kHz
        frames.append(InputAudioRawFrame(bytes(640), sample_rate=16000, num_channels=1))
        frames.append(OutputAudioRawFrame(reply[i : i + 960], sample_rate=24000, num_channels=1))
        frames.append(SleepFrame(0.005))
    # The stop is a system frame too: let the queued audio through before it.
    frames += [SleepFrame(0.05), BotStoppedSpeakingFrame()]
    return frames


def channels(path: Path) -> tuple[list[int], list[int], int]:
    """(left samples, right samples, sample rate) of a stereo WAV."""
    with wave.open(str(path), "rb") as w:
        assert w.getnchannels() == 2 and w.getsampwidth() == 2
        samples = array.array("h", w.readframes(w.getnframes()))
        return list(samples[0::2]), list(samples[1::2]), w.getframerate()


def rms(samples: list[int]) -> float:
    return math.sqrt(sum(s * s for s in samples) / len(samples)) if samples else 0.0


# Pipecat lines the two sides up only as precisely as its resampler hands audio over,
# in bursts of about 0.1s, so where a side's speech lands can move by about that much.
SLACK = 0.2


def quiet_stretches_inside(samples: list[int], rate: int, start: float, end: float) -> list[float]:
    """Quiet 20ms windows between the first and last loud ones in [start, end): gaps in speech."""
    window = rate // 50
    times = [t / rate for t in range(int(start * rate), int(end * rate) - window + 1, window)]
    loud = [rms(samples[int(t * rate) : int(t * rate) + window]) > 2000 for t in times]
    if True not in loud:
        return []
    first, last = loud.index(True), len(loud) - 1 - loud[::-1].index(True)
    return [times[i] for i in range(first, last + 1) if not loud[i]]


def onsets(samples: list[int], rate: int, quiet: float = 0.2) -> list[float]:
    """When each stretch of speech starts (s): a loud 20ms window after `quiet` s of quiet ones."""
    window, starts, last_loud = rate // 50, [], -1.0
    for i in range(0, len(samples) - window + 1, window):
        t = i / rate
        if rms(samples[i : i + window]) > 2000:
            if t - last_loud > quiet:
                starts.append(t)
            last_loud = t
    return starts


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
    assert len(left) == pytest.approx(2 * RATE, abs=SLACK * RATE)  # resamplers hold some back
    assert onsets(left, RATE) == pytest.approx([0.0], abs=SLACK)  # the caller spoke first
    assert onsets(right, RATE) == pytest.approx([1.0], abs=SLACK)  # then the agent replied
    caller_only, agent_only = slice(800, int(0.7 * RATE)), slice(int(1.3 * RATE), int(1.7 * RATE))
    assert rms(left[caller_only]) > 4000 and rms(right[caller_only]) < 100
    assert rms(right[agent_only]) > 4000 and rms(left[agent_only]) < 100


async def test_writing_as_the_call_goes_changes_nothing_in_the_recording(tmp_path):
    """Pipecat's own chunking padded whoever was speaking at every write and pushed them
    later (measured: a 6s call came out 6.65s, the agent's 3s reply in four pieces).
    Written as it goes, a recording must come out as it does written at the end.

    Not compared byte for byte: the two recorders see the same frames a moment apart
    and, on a busy machine, can line the sides up a frame differently (CI did), as
    two runs of any call can. Length, where each side's speech starts, and an
    unbroken reply are what the old chunking got wrong.
    """
    as_it_goes = CallRecorder("chunked", tmp_path, RATE, chunk_secs=0.1)
    at_the_end = CallRecorder("whole", tmp_path, RATE, chunk_secs=1000)
    writes = []
    original = as_it_goes.write
    as_it_goes.write = lambda audio, *a: (writes.append(len(audio)), original(audio, *a))

    both = Pipeline([as_it_goes.processor(), at_the_end.processor()])
    await run_test(both, frames_to_send=[*conversation(1.0, 3.0), *conversation(1.0, 1.0)])

    assert len(writes) > 30
    left, right, _ = channels(as_it_goes.path)
    whole_left, whole_right, _ = channels(at_the_end.path)
    assert len(left) == pytest.approx(len(whole_left), abs=RATE // 50)  # within 20ms
    assert onsets(left, RATE) == pytest.approx(onsets(whole_left, RATE), abs=0.05)
    assert onsets(right, RATE) == pytest.approx(onsets(whole_right, RATE), abs=0.05)
    assert quiet_stretches_inside(right, RATE, 0.5, 4.5) == []  # the 3s reply is unbroken


async def test_a_hang_up_still_saves_the_recording(tmp_path, transcript):
    """A caller hanging up cancels the pipeline rather than ending it."""
    rec = recorder(tmp_path, transcript)
    frames = [*conversation(0.5, 0.5), CancelFrame()]
    await run_test(rec.processor(), frames_to_send=frames, send_end_frame=False)
    left, _, _ = channels(rec.path)
    assert len(left) == pytest.approx(RATE, abs=SLACK * RATE)
    saved = [e for e in events(transcript) if e["event"] == "recording_saved"]
    assert saved == [saved[0]] and saved[0]["file"] == "call-1.recording.wav"
    assert saved[0]["seconds"] == pytest.approx(1.0, abs=SLACK)


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
    assert len(left) == pytest.approx(2 * RATE, abs=SLACK * RATE)
    assert onsets(left, RATE) == pytest.approx([0.0], abs=SLACK)
    assert onsets(right, RATE) == pytest.approx([1.0], abs=SLACK)


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

    assert worker.recorder.path == tmp_path / "recordings" / "call-9.recording.wav"
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


# --- retention: recordings are deleted RECORDING_RETENTION_DAYS after the call --


DAY = 86400


def aged(path: Path, days: float, now: float) -> Path:
    path.write_bytes(b"RIFF")
    os.utime(path, (now - days * DAY, now - days * DAY))
    return path


def test_recordings_past_the_window_are_deleted_and_newer_ones_kept(tmp_path):
    now = time.time()
    old = aged(tmp_path / "a.recording.wav", 61, now)
    recent = aged(tmp_path / "b.recording.wav", 59, now)
    assert delete_expired_recordings(tmp_path, 60, now=now) == 1
    assert not old.exists() and recent.exists()


def test_only_files_the_recorder_writes_are_ever_deleted(tmp_path):
    """A RECORDING_DIR pointed at a folder of other audio must not lose that audio."""
    now = time.time()
    keep = [
        aged(tmp_path / "song.wav", 400, now),
        aged(tmp_path / "notes.recording.txt", 400, now),
        aged(tmp_path / "x.recording.wav.bak", 400, now),
    ]
    (tmp_path / "sub").mkdir()
    keep.append(aged(tmp_path / "sub" / "c.recording.wav", 400, now))
    elsewhere = aged(tmp_path / "sub" / "target.recording.wav", 400, now)
    (tmp_path / "link.recording.wav").symlink_to(elsewhere)
    assert delete_expired_recordings(tmp_path, 60, now=now) == 0
    assert all(p.exists() for p in keep) and elsewhere.exists()


def test_a_missing_folder_is_not_an_error(tmp_path):
    assert delete_expired_recordings(tmp_path / "never-made", 60) == 0


def test_a_file_that_cannot_be_deleted_is_skipped_and_the_rest_still_go(tmp_path, monkeypatch):
    now = time.time()
    stuck = aged(tmp_path / "a.recording.wav", 90, now)
    gone = aged(tmp_path / "b.recording.wav", 90, now)
    real_remove = os.remove

    def remove(path):
        if str(path).endswith("a.recording.wav"):
            raise PermissionError(13, "Permission denied")
        real_remove(path)

    monkeypatch.setattr(os, "remove", remove)
    assert delete_expired_recordings(tmp_path, 60, now=now) == 1
    assert stuck.exists() and not gone.exists()


def test_retention_defaults_to_60_days(monkeypatch):
    monkeypatch.delenv("RECORDING_RETENTION_DAYS", raising=False)
    assert recording_retention_days() == 60


@pytest.mark.parametrize("raw", ["30", "0.5", " 90 "])
def test_a_valid_retention_is_used(monkeypatch, raw):
    monkeypatch.setenv("RECORDING_RETENTION_DAYS", raw)
    assert recording_retention_days() == float(raw)


@pytest.mark.parametrize("raw", ["0", "-1", "sixty", "inf", "nan"])
def test_an_invalid_retention_is_an_error_not_a_silent_default(monkeypatch, raw):
    monkeypatch.setenv("RECORDING_RETENTION_DAYS", raw)
    with pytest.raises(ValueError):
        recording_retention_days()


def test_the_phone_server_deletes_expired_recordings_at_start_and_then_periodically(
    monkeypatch, tmp_path
):
    import server
    from fastapi.testclient import TestClient

    monkeypatch.setenv("RECORDING_DIR", str(tmp_path))
    monkeypatch.setenv("RECORDING_RETENTION_DAYS", "60")
    monkeypatch.setattr(server, "RETENTION_SWEEP_SECS", 0.05)
    now = time.time()
    first = aged(tmp_path / "a.recording.wav", 61, now)
    recent = aged(tmp_path / "b.recording.wav", 1, now)

    def gone(path, timeout=3.0):
        end = time.monotonic() + timeout
        while path.exists() and time.monotonic() < end:
            time.sleep(0.02)
        return not path.exists()

    with TestClient(server.app):
        assert gone(first)  # the sweep at start
        later = aged(tmp_path / "c.recording.wav", 61, time.time())
        assert gone(later)  # and the next one, while the server runs
    assert recent.exists()


def test_the_phone_server_refuses_to_start_with_an_invalid_retention(monkeypatch):
    import server

    for name, value in {
        "WEBHOOK_SECRET": "s",
        "PUBLIC_HOST": "h",
        "PLIVO_AUTH_ID": "i",
        "PLIVO_AUTH_TOKEN": "t",
        "RECORDING_RETENTION_DAYS": "forever",
    }.items():
        monkeypatch.setenv(name, value)
    monkeypatch.delenv("MAX_CALL_DURATION_SECS", raising=False)
    monkeypatch.setattr(server, "load_dotenv", lambda: None)
    monkeypatch.setattr(server, "ensure_ca_bundle", lambda: None)
    reached = []
    monkeypatch.setattr(server, "check_region", lambda: reached.append("startup went on"))
    monkeypatch.setattr(server.uvicorn, "run", lambda *a, **k: reached.append("served"))
    with pytest.raises(SystemExit):
        server.main()
    assert reached == []

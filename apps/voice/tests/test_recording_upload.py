"""recording_upload.py: sends a finished call recording to Supabase Storage.

Off the call path by construction (CallRecorder schedules it only after the
file is closed), so every test here is about never raising and never silently
losing the recording: a failed upload leaves the local WAV exactly where it
was, for retention to delete in its own time.
"""

import httpx
import pytest
import recording_upload


@pytest.fixture
def studio(monkeypatch):
    calls = []

    async def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        return httpx.Response(200, json={"Key": "x"})

    monkeypatch.setenv("SUPABASE_URL", "https://proj.supabase.co")
    monkeypatch.setenv("SUPABASE_SECRET_KEY", "sb_secret_test")
    monkeypatch.setenv("SUPABASE_RECORDINGS_BUCKET", "call-recordings")
    monkeypatch.setattr(recording_upload, "_transport", httpx.MockTransport(handler))
    monkeypatch.setattr(recording_upload, "_encode_opus", lambda path: None)  # skip ffmpeg in tests
    monkeypatch.setattr(recording_upload, "RETRY_DELAY_SECS", 0)
    return calls


async def test_not_configured_without_env(monkeypatch, tmp_path):
    monkeypatch.delenv("SUPABASE_URL", raising=False)
    path = tmp_path / "c1.recording.wav"
    path.write_bytes(b"abc")
    assert await recording_upload.upload_recording(path, "c1.recording.wav") is False


async def test_uploads_the_file_as_is_when_opus_is_unavailable(studio, tmp_path):
    path = tmp_path / "c1.recording.wav"
    path.write_bytes(b"RIFF....")
    assert await recording_upload.upload_recording(path, "c1.recording.wav") is True
    (req,) = studio
    assert req.url.path == "/storage/v1/object/call-recordings/c1.recording.wav"
    assert req.headers["authorization"] == "Bearer sb_secret_test"
    assert req.headers["apikey"] == "sb_secret_test"
    assert req.content == b"RIFF...."


async def test_uploads_as_opus_when_encoding_succeeds(studio, tmp_path, monkeypatch):
    path = tmp_path / "c1.recording.wav"
    path.write_bytes(b"RIFF....")
    opus_path = tmp_path / "c1.recording.opus"
    opus_path.write_bytes(b"OPUSDATA")
    monkeypatch.setattr(recording_upload, "_encode_opus", lambda p: opus_path)
    assert await recording_upload.upload_recording(path, "c1.recording.wav") is True
    (req,) = studio
    assert req.url.path == "/storage/v1/object/call-recordings/c1.recording.opus"
    assert req.content == b"OPUSDATA"
    assert not opus_path.exists()  # the temporary encode is cleaned up after a successful upload
    assert path.exists()  # the original WAV is never touched


async def test_a_failed_opus_upload_still_leaves_the_original_wav(studio, tmp_path, monkeypatch):
    path = tmp_path / "c1.recording.wav"
    path.write_bytes(b"RIFF....")
    opus_path = tmp_path / "c1.recording.opus"
    opus_path.write_bytes(b"OPUSDATA")
    monkeypatch.setattr(recording_upload, "_encode_opus", lambda p: opus_path)

    async def handler(request):
        return httpx.Response(500)

    monkeypatch.setattr(recording_upload, "_transport", httpx.MockTransport(handler))
    assert await recording_upload.upload_recording(path, "c1.recording.wav") is False
    assert path.exists() and opus_path.exists()  # nothing deleted on failure


async def test_retries_a_server_error_then_succeeds(studio, tmp_path, monkeypatch):
    path = tmp_path / "c1.recording.wav"
    path.write_bytes(b"data")
    attempts = {"n": 0}

    async def handler(request):
        attempts["n"] += 1
        if attempts["n"] < 2:
            return httpx.Response(503)
        return httpx.Response(200)

    monkeypatch.setattr(recording_upload, "_transport", httpx.MockTransport(handler))
    assert await recording_upload.upload_recording(path, "c1.recording.wav") is True
    assert attempts["n"] == 2


async def test_gives_up_after_repeated_failures_without_raising(studio, tmp_path, monkeypatch):
    path = tmp_path / "c1.recording.wav"
    path.write_bytes(b"data")

    async def handler(request):
        return httpx.Response(500)

    monkeypatch.setattr(recording_upload, "_transport", httpx.MockTransport(handler))
    assert await recording_upload.upload_recording(path, "c1.recording.wav") is False


async def test_a_refused_request_is_not_retried(studio, tmp_path, monkeypatch):
    path = tmp_path / "c1.recording.wav"
    path.write_bytes(b"data")
    attempts = {"n": 0}

    async def handler(request):
        attempts["n"] += 1
        return httpx.Response(403)

    monkeypatch.setattr(recording_upload, "_transport", httpx.MockTransport(handler))
    assert await recording_upload.upload_recording(path, "c1.recording.wav") is False
    assert attempts["n"] == 1


async def test_a_missing_file_never_raises(studio, tmp_path):
    missing = tmp_path / "nope.recording.wav"
    assert await recording_upload.upload_recording(missing, "nope.recording.wav") is False


async def test_a_connection_error_never_raises(tmp_path, monkeypatch):
    path = tmp_path / "c1.recording.wav"
    path.write_bytes(b"data")
    monkeypatch.setenv("SUPABASE_URL", "https://proj.supabase.co")
    monkeypatch.setenv("SUPABASE_SECRET_KEY", "sb_secret_test")
    monkeypatch.setenv("SUPABASE_RECORDINGS_BUCKET", "call-recordings")
    monkeypatch.setattr(recording_upload, "_encode_opus", lambda p: None)
    monkeypatch.setattr(recording_upload, "RETRY_DELAY_SECS", 0)

    async def handler(request):
        raise httpx.ConnectError("no route")

    monkeypatch.setattr(recording_upload, "_transport", httpx.MockTransport(handler))
    assert await recording_upload.upload_recording(path, "c1.recording.wav") is False


# ---- date-partitioned names and the report to the Studio ---------------------------------

import datetime  # noqa: E402


def test_object_names_are_date_partitioned_and_traversal_safe():
    when = datetime.datetime(2026, 11, 7, 9, 0, tzinfo=datetime.timezone.utc)
    assert recording_upload.object_name("4f9c1e2a-0b3d", when) == "2026/11/4f9c1e2a-0b3d.wav"
    hostile = recording_upload.object_name("../../etc/passwd\x00/x", when)
    assert hostile.startswith("2026/11/") and hostile.count("/") == 2 and ".." not in hostile
    assert recording_upload.object_name("a" * 500, when).count("/") == 2
    assert len(recording_upload.object_name("a" * 500, when)) <= 8 + 100 + 4


async def test_reports_the_final_opus_path_size_and_mime(studio, tmp_path, monkeypatch):
    path = tmp_path / "c1.recording.wav"
    path.write_bytes(b"RIFF....")
    opus_path = tmp_path / "c1.recording.opus"
    opus_path.write_bytes(b"OPUSDATA")
    monkeypatch.setattr(recording_upload, "_encode_opus", lambda p: opus_path)
    seen = []

    async def report(p, size, mime):
        seen.append((p, size, mime))

    assert await recording_upload.upload_recording(path, "2026/11/c1.wav", report=report) is True
    assert seen == [("2026/11/c1.opus", 8, "audio/opus")]


async def test_reports_the_wav_when_opus_is_unavailable(studio, tmp_path):
    path = tmp_path / "c1.recording.wav"
    path.write_bytes(b"RIFF....")
    seen = []

    async def report(p, size, mime):
        seen.append((p, size, mime))

    assert await recording_upload.upload_recording(path, "2026/11/c1.wav", report=report) is True
    assert seen == [("2026/11/c1.wav", 8, "audio/wav")]


async def test_nothing_is_reported_when_the_upload_failed(studio, tmp_path, monkeypatch):
    monkeypatch.setattr(recording_upload, "_transport",
                        httpx.MockTransport(lambda r: httpx.Response(403)))
    path = tmp_path / "c1.recording.wav"
    path.write_bytes(b"RIFF....")
    seen = []

    async def report(*a):
        seen.append(a)

    assert await recording_upload.upload_recording(path, "2026/11/c1.wav", report=report) is False
    assert seen == []


async def test_a_failing_report_never_changes_the_upload_result(studio, tmp_path):
    path = tmp_path / "c1.recording.wav"
    path.write_bytes(b"RIFF....")

    async def report(*a):
        raise RuntimeError("studio exploded")

    assert await recording_upload.upload_recording(path, "2026/11/c1.wav", report=report) is True

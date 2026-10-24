"""The caller hears the agent within a second of picking up.

Measured on call ddedb4fd (2026-10-24): pickup to the first audible word took
~1.8s, almost all of it ours: ~0.93s waiting for every provider connection
before the pipeline would speak, then 0.26s of leading silence in the notice.
So the recording notice is synthesised once at startup, trimmed of leading
silence, and sent the moment Plivo opens the stream; the pipeline starts behind
it, and the greeting is asked for just before the notice ends.
"""

import array
import asyncio
import base64
import json
import time
import wave

import main
import notice_audio
import pytest
from pipecat.frames.frames import TTSAudioRawFrame, TTSSpeakFrame, TTSStartedFrame, TTSStoppedFrame
from pipecat.processors.frame_processor import FrameProcessor
from pipecat.workers.runner import WorkerRunner
from pipeline_fakes import GreetingLLM, PassThrough, SpeakingTTS, Transport
from recording import DEFAULT_NOTICE

RATE = 24000


def pcm(samples):
    return array.array("h", samples).tobytes()


def tone(n, level=8000):
    return [level if i % 2 else -level for i in range(n)]


# --- the cached audio -----------------------------------------------------------------


def test_leading_silence_is_trimmed_but_a_breath_is_kept():
    audio = pcm([0] * 6000 + [40, -30] * 500 + tone(2400))
    trimmed = notice_audio.trim_leading_silence(audio, RATE, keep_ms=20)
    first_loud = array.array("h", trimmed).tolist().index(-8000)
    assert len(trimmed) < len(audio) and first_loud == int(RATE * 0.02)


def test_all_silence_is_left_alone():
    audio = pcm([0] * 1000)
    assert notice_audio.trim_leading_silence(audio, RATE) == audio


async def test_the_notice_becomes_plivo_play_messages_for_each_stream():
    notice = await notice_audio.PrespokenNotice.from_pcm(DEFAULT_NOTICE, pcm(tone(RATE)), RATE)
    assert abs(notice.duration_secs - 1.0) < 0.02
    messages = [json.loads(m) for m in notice.messages("stream-1")]
    assert {m["event"] for m in messages} == {"playAudio"}
    assert {m["streamId"] for m in messages} == {"stream-1"}
    assert {m["media"]["contentType"] for m in messages} == {"audio/x-mulaw"}
    ulaw = b"".join(base64.b64decode(m["media"]["payload"]) for m in messages)
    assert abs(len(ulaw) - 8000) < 80  # one second at 8kHz, one byte a sample
    assert len(notice.pcm_8k) == 2 * len(ulaw)


class FakeVoice(FrameProcessor):
    """Speaks any TTSSpeakFrame as half a second of tone after 0.1s of silence."""

    async def process_frame(self, frame, direction):
        await super().process_frame(frame, direction)
        if isinstance(frame, TTSSpeakFrame):
            await self.push_frame(TTSStartedFrame())
            audio = pcm([0] * int(RATE * 0.1) + tone(RATE // 2))
            for i in range(0, len(audio), 4800):
                await self.push_frame(TTSAudioRawFrame(audio[i:i + 4800], RATE, 1))
            await self.push_frame(TTSStoppedFrame())
            return
        await self.push_frame(frame, direction)


async def test_synthesise_runs_the_real_voice_once_and_trims_it():
    notice = await notice_audio.synthesise(DEFAULT_NOTICE, FakeVoice(), RATE, timeout=5)
    assert notice is not None and notice.text == DEFAULT_NOTICE
    assert 0.5 <= notice.duration_secs < 0.56  # the 0.1s of silence is gone


class DeadVoice(FrameProcessor):
    async def process_frame(self, frame, direction):
        await super().process_frame(frame, direction)
        if not isinstance(frame, TTSSpeakFrame):
            await self.push_frame(frame, direction)


async def test_a_voice_that_says_nothing_gives_no_cache_in_time():
    started = time.monotonic()
    assert await notice_audio.synthesise(DEFAULT_NOTICE, DeadVoice(), RATE, timeout=0.5) is None
    assert time.monotonic() - started < 2


# --- the call with a pre-spoken notice --------------------------------------------------


@pytest.fixture
def call(monkeypatch, tmp_path):
    for name, value in {"DEEPGRAM_API_KEY": "k", "CALL_LOG_DIR": str(tmp_path / "calls"),
                        "LATENCY_LOG_PATH": str(tmp_path / "turns.jsonl"),
                        "RECORDING_DIR": str(tmp_path / "rec"), "RECORDING_ENABLED": "true",
                        "SUMMARY_ENABLED": "false", "GREETING_LEAD_SECS": "0.2"}.items():
        monkeypatch.setenv(name, value)
    for name in ("RECORDING_NOTICE", "RECORDING_NOTICE_ENABLED", "TTS_FALLBACK_PROVIDER"):
        monkeypatch.delenv(name, raising=False)
    tts, llm = SpeakingTTS(), GreetingLLM()
    monkeypatch.setattr(main, "DeepgramSTTService", PassThrough)
    monkeypatch.setattr(main, "build_tts_stack", lambda: (tts, [tts], None))
    monkeypatch.setattr(main, "build_llm", lambda *a, **k: llm)
    return tts, llm, tmp_path


async def run_call(tts, notice, sent_at, until_said=1, timeout=5.0):
    worker = main.build_worker(Transport(), call_id="fast", recording_sample_rate=8000,
                               notice_prespoken=(notice, sent_at))
    running = asyncio.create_task(WorkerRunner(handle_sigint=False).run(worker))
    end = time.monotonic() + timeout
    while len(tts.said) < until_said and time.monotonic() < end:
        await asyncio.sleep(0.01)
    said_at = time.monotonic()
    await asyncio.sleep(0.1)
    await worker.cancel()
    await asyncio.wait_for(running, timeout)
    return worker, said_at


async def test_the_pipeline_does_not_say_the_notice_again_and_greets_on_time(call):
    tts, llm, tmp = call
    notice = await notice_audio.PrespokenNotice.from_pcm(DEFAULT_NOTICE, pcm(tone(RATE)), RATE)
    sent_at = time.monotonic()
    _, said_at = await run_call(tts, notice, sent_at)
    assert tts.said == [GreetingLLM.GREETING]  # the notice went out before the pipeline
    # Asked for GREETING_LEAD_SECS before the notice ends, not after it.
    assert 0.6 <= said_at - sent_at <= 1.0
    assert f'"{DEFAULT_NOTICE}"' in llm.requests[0][-1]["content"]
    rows = [json.loads(x) for x in (tmp / "calls" / "fast.jsonl").read_text().splitlines()]
    played = [r for r in rows if r["event"] == "recording_notice_played"]
    assert played and played[0]["prespoken"] is True


async def test_the_caller_is_muted_until_the_notice_has_finished_playing():
    notice = await notice_audio.PrespokenNotice.from_pcm(DEFAULT_NOTICE, pcm(tone(RATE)), RATE)
    mute = main.MuteUntil(time.monotonic() + 0.3)
    assert await mute.process_frame(object()) is True
    await asyncio.sleep(0.35)
    assert await mute.process_frame(object()) is False
    assert notice.duration_secs > 0


async def test_the_recording_starts_with_the_notice(call):
    tts, _, tmp = call
    notice = await notice_audio.PrespokenNotice.from_pcm(DEFAULT_NOTICE, pcm(tone(RATE)), RATE)
    worker, _ = await run_call(tts, notice, time.monotonic())
    worker.recorder.close()
    with wave.open(str(worker.recorder.path)) as w:
        frames = array.array("h", w.readframes(8000))
    bot, caller = frames[1::2], frames[0::2]
    assert max(abs(s) for s in bot[:4000]) > 1000 and max(abs(s) for s in caller[:4000]) == 0


async def test_a_cache_for_other_words_is_not_used(call, monkeypatch):
    tts, _, _ = call
    monkeypatch.setenv("RECORDING_NOTICE", "This call is recorded for quality.")
    notice = await notice_audio.PrespokenNotice.from_pcm(DEFAULT_NOTICE, pcm(tone(RATE)), RATE)
    await run_call(tts, notice, time.monotonic(), until_said=2)
    assert tts.said[0] == "This call is recorded for quality."  # spoken the normal way


# --- the phone server sends it before anything else ----------------------------------


def test_the_server_sends_the_notice_first_and_hands_it_to_the_pipeline(monkeypatch, tmp_path):
    import server
    from fastapi.testclient import TestClient
    from transcript import CallTranscript

    notice = asyncio.run(notice_audio.PrespokenNotice.from_pcm(DEFAULT_NOTICE,
                                                               pcm(tone(RATE // 2)), RATE))
    monkeypatch.setattr(server, "_prespoken_notice", notice)
    monkeypatch.setattr(server, "_ws_limiter", None)
    monkeypatch.setenv("PLIVO_AUTH_ID", "MAID")
    monkeypatch.setenv("PLIVO_AUTH_TOKEN", "tok")
    seen = {}

    class Worker:
        def __init__(self):
            self.transcript = CallTranscript("C1", tmp_path)
            self.health = None

        async def cancel(self, reason=None):
            pass

    def fake_build_worker(transport, params=None, **kw):
        seen.update(kw)
        return Worker()

    class Runner:
        def __init__(self, **k):
            pass

        async def run(self, worker):
            return

    monkeypatch.setattr(server, "build_worker", fake_build_worker)
    monkeypatch.setattr(server, "WorkerRunner", Runner)
    token = server.issue_stream({"caller": None, "agent": None, "max_secs": None,
                                 "studio_agent": None})
    with TestClient(server.app).websocket_connect(f"/ws?stream={token}") as ws:
        ws.send_text(json.dumps({"event": "start", "start": {"streamId": "S1", "callId": "C1"}}))
        first = json.loads(ws.receive_text())
    assert first["event"] == "playAudio" and first["streamId"] == "S1"
    sent, at = seen["notice_prespoken"]
    assert sent is notice and abs(time.monotonic() - at) < 5


def test_no_cache_means_the_pipeline_says_it_as_before(monkeypatch):
    import server

    monkeypatch.setattr(server, "_prespoken_notice", None)
    assert server.prespoken_for_call() is None


# --- a voice that will not shut down must never hold up the server's startup ----------


class StubbornVoice(FakeVoice):
    """Speaks, then never lets an EndFrame or a cancel through, like the real
    Smallest service did at startup (server hung, 2026-10-24)."""

    async def process_frame(self, frame, direction):
        from pipecat.frames.frames import CancelFrame, EndFrame

        if isinstance(frame, EndFrame | CancelFrame):
            await asyncio.Event().wait()
        await super().process_frame(frame, direction)


async def test_synthesise_returns_even_if_the_voice_never_shuts_down():
    started = time.monotonic()
    notice = await notice_audio.synthesise(DEFAULT_NOTICE, StubbornVoice(), RATE, timeout=5)
    assert notice is not None and time.monotonic() - started < 6


async def test_the_server_warm_up_is_bounded_whatever_the_voice_does(monkeypatch):
    import server

    async def forever(*a, **k):
        await asyncio.Event().wait()

    monkeypatch.setattr(server.notice_audio, "synthesise", forever)
    monkeypatch.setattr(server, "build_tts", lambda *a, **k: None)
    monkeypatch.setattr(server, "NOTICE_SYNTH_TIMEOUT_SECS", 0.3)
    monkeypatch.delenv("GROQ_API_KEY", raising=False)
    started = time.monotonic()
    await asyncio.wait_for(server.warm_up(), 10)
    assert time.monotonic() - started < 5 and server._prespoken_notice is None


async def test_warm_up_never_fails_when_the_voice_is_not_configured(monkeypatch):
    # CI caught it (2026-10-24): with no voice keys, build_tts() exits, and
    # warm-up must never take the server down. Calls then speak the notice.
    import server

    def unconfigured(*a, **k):
        raise SystemExit(1)

    monkeypatch.setattr(server, "build_tts", unconfigured)
    monkeypatch.setattr(server, "_prespoken_notice", None)
    monkeypatch.delenv("GROQ_API_KEY", raising=False)
    await server.warm_up()
    assert server._prespoken_notice is None

import json

import pytest
import summary
from transcript import CallTranscript


def make_call(tmp_path, *turns):
    t = CallTranscript("c1", tmp_path)
    for role, text in turns:
        (t.user if role == "user" else t.assistant)(text)
    t.end()
    return t.path


def test_parse_handles_reasoning_and_fences():
    reply = '<think>hmm {not json}</think>\n```json\n{"summary": "ok"}\n```'
    assert summary.parse_summary(reply) == {"summary": "ok"}


def test_parse_rejects_a_reply_without_json():
    with pytest.raises(ValueError):
        summary.parse_summary("sorry, I cannot")


def test_transcript_text_labels_speakers(tmp_path):
    path = make_call(tmp_path, ("assistant", "Hi"), ("user", "Book me a slot"))
    text, caller_turns = summary.transcript_text(path)
    assert text == "Kaho: Hi\nCaller: Book me a slot"
    assert caller_turns == 1


async def test_summary_is_written_and_masked(tmp_path, monkeypatch):
    path = make_call(tmp_path, ("assistant", "Hi"), ("user", "I need an appointment"))
    seen = {}

    async def fake_chat(api_key, model, transcript, **kw):
        seen["transcript"] = transcript
        return json.dumps({"summary": "Caller gave 234567891234.", "follow_ups": ["ABCDE1234F"]})

    monkeypatch.setattr(summary, "chat", fake_chat)
    out = await summary.summarise_call(path, "key", "model")
    written = json.loads(out.read_text(encoding="utf-8"))
    assert "234567891234" not in json.dumps(written) and "ABCDE1234F" not in json.dumps(written)
    assert "XXXX XXXX 1234" in written["summary"]
    assert "Caller: I need an appointment" in seen["transcript"]


async def test_no_caller_speech_means_no_call_to_the_model(tmp_path, monkeypatch):
    path = make_call(tmp_path, ("assistant", "Hi"))

    async def boom(*a, **kw):
        raise AssertionError("should not be called")

    monkeypatch.setattr(summary, "chat", boom)
    assert await summary.summarise_call(path, "key", "model") is None


async def test_model_failure_is_swallowed(tmp_path, monkeypatch):
    path = make_call(tmp_path, ("user", "hello"))

    async def fail(*a, **kw):
        raise RuntimeError("HTTP 500")

    monkeypatch.setattr(summary, "chat", fail)
    assert await summary.summarise_call(path, "key", "model") is None
    assert not path.with_suffix(".summary.json").exists()


# --- retry, deadline and failure marker ---------------------------------------

import httpx  # noqa: E402


def status_error(code, retry_after=None):
    headers = {"retry-after": str(retry_after)} if retry_after is not None else {}
    request = httpx.Request("POST", summary.GROQ_URL)
    response = httpx.Response(code, headers=headers, request=request)
    try:
        response.raise_for_status()
    except httpx.HTTPStatusError as e:
        return e


class FakeTime:
    """A clock that only moves when the code under test sleeps."""

    def __init__(self):
        self.now = 0.0
        self.sleeps = []

    def clock(self):
        return self.now

    async def sleep(self, secs):
        self.sleeps.append(secs)
        self.now += secs


def script(monkeypatch, *outcomes):
    """Make each _post call return or raise the next outcome, and count the calls."""
    calls = []

    async def fake_post(client, api_key, model, transcript):
        calls.append(1)
        outcome = outcomes[min(len(calls), len(outcomes)) - 1]
        if isinstance(outcome, Exception):
            raise outcome
        return outcome

    monkeypatch.setattr(summary, "_post", fake_post)
    return calls


async def run_chat(ft, **kw):
    return await summary.chat("key", "model", "text", sleep=ft.sleep, clock=ft.clock, **kw)


async def test_a_429_is_retried_and_then_succeeds(monkeypatch):
    ft = FakeTime()
    calls = script(monkeypatch, status_error(429), '{"summary": "ok"}')
    assert await run_chat(ft) == '{"summary": "ok"}'
    assert len(calls) == 2 and len(ft.sleeps) == 1


async def test_retry_after_from_the_provider_is_honoured(monkeypatch):
    ft = FakeTime()
    script(monkeypatch, status_error(429, retry_after=3), "done")
    await run_chat(ft)
    assert ft.sleeps == [3.0]


async def test_backoff_grows_and_is_jittered_within_bounds(monkeypatch):
    ft = FakeTime()
    script(monkeypatch, status_error(503), status_error(503), status_error(503), "done")
    await run_chat(ft)
    for slept, base in zip(ft.sleeps, (1, 2, 4), strict=True):
        assert 0.75 * base <= slept <= 1.25 * base


async def test_gives_up_after_max_attempts_with_a_reason(monkeypatch):
    ft = FakeTime()
    calls = script(monkeypatch, status_error(429))
    with pytest.raises(summary.SummaryFailed) as e:
        await run_chat(ft, attempts=3)
    assert len(calls) == 3 and len(ft.sleeps) == 2
    assert "429" in e.value.reason and e.value.attempts == 3


async def test_a_permanent_error_is_not_retried(monkeypatch):
    ft = FakeTime()
    calls = script(monkeypatch, status_error(401))
    with pytest.raises(summary.SummaryFailed) as e:
        await run_chat(ft)
    assert len(calls) == 1 and ft.sleeps == []
    assert "not retryable" in e.value.reason


async def test_a_wait_that_would_pass_the_deadline_is_not_taken(monkeypatch):
    ft = FakeTime()
    calls = script(monkeypatch, status_error(429, retry_after=100))
    with pytest.raises(summary.SummaryFailed) as e:
        await run_chat(ft, deadline_secs=30)
    assert len(calls) == 1 and ft.sleeps == []
    assert "deadline" in e.value.reason


async def test_the_total_time_never_exceeds_the_deadline(monkeypatch):
    ft = FakeTime()
    script(monkeypatch, status_error(503))
    with pytest.raises(summary.SummaryFailed):
        await run_chat(ft, attempts=50, deadline_secs=20)
    assert ft.now < 20


async def test_a_network_timeout_is_retried(monkeypatch):
    ft = FakeTime()
    calls = script(monkeypatch, httpx.ReadTimeout("slow"), "done")
    assert await run_chat(ft) == "done"
    assert len(calls) == 2


async def test_an_unreadable_200_is_not_retried(monkeypatch):
    ft = FakeTime()
    calls = script(monkeypatch, KeyError("choices"))
    with pytest.raises(summary.SummaryFailed):
        await run_chat(ft)
    assert len(calls) == 1


async def test_failure_leaves_a_marker_and_no_secrets(tmp_path, monkeypatch):
    path = make_call(tmp_path, ("user", "my aadhaar is 2345 6789 1234"))

    async def down(*a, **kw):
        raise summary.SummaryFailed("HTTP 429; gave up after 4 attempts", 4)

    monkeypatch.setattr(summary, "chat", down)
    assert await summary.summarise_call(path, "sk-SECRET-KEY", "model") is None
    marker = path.with_suffix(".summary.failed.json")
    body = json.loads(marker.read_text(encoding="utf-8"))
    assert body["reason"] == "HTTP 429; gave up after 4 attempts" and body["attempts"] == 4
    assert body["call_transcript"] == "c1.jsonl" and "at" in body
    raw = marker.read_text(encoding="utf-8")
    assert "SECRET" not in raw and "2345" not in raw
    assert not path.with_suffix(".summary.json").exists()


async def test_unusable_model_json_is_marked_not_silent(tmp_path, monkeypatch):
    path = make_call(tmp_path, ("user", "hello"))

    async def prose(*a, **kw):
        return "I am unable to comply."

    monkeypatch.setattr(summary, "chat", prose)
    assert await summary.summarise_call(path, "key", "model") is None
    assert "usable JSON" in json.loads(
        path.with_suffix(".summary.failed.json").read_text(encoding="utf-8")
    )["reason"]


async def test_success_leaves_no_marker(tmp_path, monkeypatch):
    path = make_call(tmp_path, ("user", "hello"))

    async def fine(*a, **kw):
        return '{"summary": "ok"}'

    monkeypatch.setattr(summary, "chat", fine)
    assert await summary.summarise_call(path, "key", "model") is not None
    assert not path.with_suffix(".summary.failed.json").exists()


async def test_the_no_caller_speech_skip_is_not_a_failure(tmp_path):
    path = make_call(tmp_path, ("assistant", "Hi"))
    assert await summary.summarise_call(path, "key", "model") is None
    assert not path.with_suffix(".summary.failed.json").exists()

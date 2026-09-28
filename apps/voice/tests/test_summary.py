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

    async def fake_chat(api_key, model, transcript):
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

    async def boom(*a):
        raise AssertionError("should not be called")

    monkeypatch.setattr(summary, "chat", boom)
    assert await summary.summarise_call(path, "key", "model") is None


async def test_model_failure_is_swallowed(tmp_path, monkeypatch):
    path = make_call(tmp_path, ("user", "hello"))

    async def fail(*a):
        raise RuntimeError("HTTP 500")

    monkeypatch.setattr(summary, "chat", fail)
    assert await summary.summarise_call(path, "key", "model") is None
    assert not path.with_suffix(".summary.json").exists()

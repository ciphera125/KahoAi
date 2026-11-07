"""The first seconds of a call: the greeting is heard in full, and on time.

Call 892bf848 (2026-10-25): the caller said nothing, yet 0.3s into the greeting
the line picked up a voice (Meet audio near the phone) and it counted as a
barge-in, so the greeting stopped at "Hello,". The model then answered those
words with a capture_lead call that Groq rejected ("Tool call validation
failed"), the turn produced nothing, and the caller heard "One moment" and,
10s later, the apology. Pickup to greeting was 1.8s, 1.0s of it waiting for
Deepgram to connect before the pipeline would start.
"""

import asyncio
import time
from types import SimpleNamespace

import httpx
import main
import openai
import pytest
from pipecat.frames.frames import (
    BotStartedSpeakingFrame,
    BotStoppedSpeakingFrame,
    InputAudioRawFrame,
)

# --- the greeting is not cut off ---------------------------------------------------


def audio():
    return InputAudioRawFrame(audio=b"\0\0" * 160, sample_rate=8000, num_channels=1)


async def muted(strategies, frame) -> bool:
    result = False
    for s in strategies:
        result |= await s.process_frame(frame)
    return result


async def test_the_caller_stays_muted_after_the_notice_until_the_greeting_is_over():
    strategies = main.opening_mute_strategies(prespoken=True, notice_ends_at=time.monotonic())
    await asyncio.sleep(0.01)  # the notice has finished playing
    assert await muted(strategies, audio()) is True
    assert await muted(strategies, BotStartedSpeakingFrame()) is True
    assert await muted(strategies, audio()) is True  # mid-greeting: a voice nearby is ignored
    await muted(strategies, BotStoppedSpeakingFrame())
    assert await muted(strategies, audio()) is False  # greeting done: the caller has the floor


async def test_the_caller_is_muted_during_the_notice_even_before_the_greeting():
    strategies = main.opening_mute_strategies(prespoken=True,
                                              notice_ends_at=time.monotonic() + 5)
    await muted(strategies, BotStartedSpeakingFrame())
    await muted(strategies, BotStoppedSpeakingFrame())
    assert await muted(strategies, audio()) is True


async def test_without_a_prespoken_notice_the_first_speech_is_protected_as_before():
    strategies = main.opening_mute_strategies(prespoken=False, notice_ends_at=None)
    assert await muted(strategies, audio()) is True
    await muted(strategies, BotStartedSpeakingFrame())
    await muted(strategies, BotStoppedSpeakingFrame())
    assert await muted(strategies, audio()) is False


# --- a rejected tool call does not leave the caller in silence -----------------------


def chunk(content=None, reasoning=None):
    delta = SimpleNamespace(content=content, reasoning=reasoning, tool_calls=None)
    return SimpleNamespace(choices=[SimpleNamespace(delta=delta)], usage=None, model="m")


def tool_use_failed():
    req = httpx.Request("POST", "https://api.groq.com/openai/v1/chat/completions")
    return openai.APIError(
        "Tool call validation failed: parameters for tool capture_lead did not match schema",
        request=req, body={"code": "tool_use_failed", "type": "invalid_request_error"})


def other_error():
    req = httpx.Request("POST", "https://api.groq.com/openai/v1/chat/completions")
    return openai.APIError("something else", request=req, body={"code": "server_error"})


class Stream:
    def __init__(self, chunks, error=None):
        self.chunks, self.error, self.closed = chunks, error, False

    def __aiter__(self):
        return self._iter()

    async def _iter(self):
        for c in self.chunks:
            yield c
        if self.error:
            raise self.error

    async def close(self):
        self.closed = True


class Completions:
    def __init__(self, *streams):
        self.streams, self.params = list(streams), []

    async def create(self, **params):
        self.params.append(params)
        return self.streams.pop(0)


def service(monkeypatch, completions):
    svc = object.__new__(main.PortableGroqLLMService)
    svc._fallback_model, svc._fallback_timeout_secs, svc._on_fallback = None, 3.0, None
    svc._on_tool_rejected = None
    svc._settings = SimpleNamespace(model="openai/gpt-oss-20b", system_instruction="x")
    svc._client = SimpleNamespace(chat=SimpleNamespace(completions=completions))
    svc._name = "GroqLLMService#test"
    svc._retry_on_timeout = False
    svc.get_llm_adapter = lambda: SimpleNamespace(
        get_messages_for_logging=lambda ctx: [],
        get_llm_invocation_params=lambda ctx, **k: {"messages": [], "tools": ["capture_lead"],
                                                    "tool_choice": "auto"})
    svc.supports_developer_role = False
    monkeypatch.setattr(main.GroqLLMService, "build_chat_completion_params",
                        lambda self, p: {"model": self._settings.model, "stream": True, **p})
    return svc


async def drain(stream):
    return [c async for c in stream]


async def test_a_rejected_tool_call_is_answered_again_in_words(monkeypatch):
    first = Stream([chunk(reasoning="thinking")], error=tool_use_failed())
    retry = Stream([chunk(content="Hi, this is Priya.")])
    comp = Completions(first, retry)
    svc = service(monkeypatch, comp)
    got = await drain(await svc.get_chat_completions(None))
    assert [c.choices[0].delta.content for c in got] == [None, "Hi, this is Priya."]
    assert len(comp.params) == 2
    assert "tools" in comp.params[0]
    # The retry has no tools: the model got one wrong, so this turn is spoken.
    assert "tools" not in comp.params[1] and "tool_choice" not in comp.params[1]
    assert first.closed


async def test_a_rejection_after_words_were_spoken_is_not_retried(monkeypatch):
    # A retry would say those words twice.
    comp = Completions(Stream([chunk(content="Hello,")], error=tool_use_failed()))
    svc = service(monkeypatch, comp)
    with pytest.raises(openai.APIError):
        await drain(await svc.get_chat_completions(None))
    assert len(comp.params) == 1


async def test_other_errors_are_not_retried(monkeypatch):
    comp = Completions(Stream([], error=other_error()))
    svc = service(monkeypatch, comp)
    with pytest.raises(openai.APIError):
        await drain(await svc.get_chat_completions(None))
    assert len(comp.params) == 1


async def test_the_retry_happens_once(monkeypatch):
    comp = Completions(Stream([], error=tool_use_failed()), Stream([], error=tool_use_failed()))
    svc = service(monkeypatch, comp)
    with pytest.raises(openai.APIError):
        await drain(await svc.get_chat_completions(None))
    assert len(comp.params) == 2


async def test_a_retry_that_says_nothing_still_gets_a_spoken_reply(monkeypatch):
    # 2026-11-07, call db32d982: the retry came back empty and the caller heard filler, then the
    # failure apology. An empty answer to a caller is turned into a short ask to repeat.
    comp = Completions(Stream([chunk(reasoning="thinking")], error=tool_use_failed()),
                       Stream([chunk(reasoning="still thinking")]))
    svc = service(monkeypatch, comp)
    got = await drain(await svc.get_chat_completions(None))
    spoken = [c.choices[0].delta.content for c in got if c.choices[0].delta.content]
    assert spoken == [main.EMPTY_REPLY_LINE]


async def test_a_reply_with_words_is_not_given_the_fallback(monkeypatch):
    comp = Completions(Stream([chunk(content="Hello.")]))
    svc = service(monkeypatch, comp)
    got = await drain(await svc.get_chat_completions(None))
    assert [c.choices[0].delta.content for c in got] == ["Hello."]


async def test_a_tool_call_without_words_is_not_given_the_fallback(monkeypatch):
    call = SimpleNamespace(choices=[SimpleNamespace(delta=SimpleNamespace(
        content=None, reasoning=None, tool_calls=[object()]))], usage=None, model="m")
    comp = Completions(Stream([call]))
    svc = service(monkeypatch, comp)
    got = await drain(await svc.get_chat_completions(None))
    assert all(not c.choices[0].delta.content for c in got)


def tool_use_failed_without_a_name(generation=None):
    req = httpx.Request("POST", "https://api.groq.com/openai/v1/chat/completions")
    body = {"code": "tool_use_failed", "type": "invalid_request_error"}
    if generation is not None:
        body["failed_generation"] = generation
    return openai.APIError("Tool call validation failed", request=req, body=body)


def test_the_tool_the_model_tried_to_call_is_read_from_the_error():
    # 2026-11-07, call db32d982: four tool names the agent never had were in its prompt,
    # and nothing recorded which one the model reached for. Groq names it in the message.
    assert main.rejected_tool_name(tool_use_failed()) == "capture_lead"


def test_the_tool_name_is_read_from_the_generation_when_the_message_has_none():
    e = tool_use_failed_without_a_name('{"name": "get_tasks", "arguments": {"range": "monday"}}')
    assert main.rejected_tool_name(e) == "get_tasks"


def test_the_tool_name_is_read_from_the_wording_groq_really_uses():
    # Seen live 2026-11-08, the real model against the real API, when a tool was asked for
    # that was not in the request: the name is in quotes, not after "for tool".
    req = httpx.Request("POST", "https://api.groq.com/openai/v1/chat/completions")
    e = openai.APIError(
        "Tool call validation failed: tool call validation failed: attempted to call tool "
        "'get_balance' which was not in request.tools",
        request=req, body={"code": "tool_use_failed"})
    assert main.rejected_tool_name(e) == "get_balance"


def test_an_unnamed_rejection_and_an_unrelated_error_give_no_name():
    assert main.rejected_tool_name(tool_use_failed_without_a_name()) is None
    assert main.rejected_tool_name(other_error()) is None


async def test_the_retry_tells_the_model_to_answer_in_words_only(monkeypatch):
    # Without this line the model asks for the same missing tool again and the turn is lost.
    comp = Completions(Stream([], error=tool_use_failed()), Stream([chunk(content="Of course.")]))
    svc = service(monkeypatch, comp)
    await drain(await svc.get_chat_completions(None))
    assert comp.params[1]["messages"][-1] == {"role": "system", "content": main.NO_TOOLS_LINE}
    assert "do not call any tool" in main.NO_TOOLS_LINE.lower()
    assert comp.params[0].get("messages") == []  # the first request is left as it was


async def test_the_rejected_tool_is_reported_so_the_transcript_can_show_it(monkeypatch):
    seen = []
    comp = Completions(Stream([], error=tool_use_failed()), Stream([chunk(content="Sure.")]))
    svc = service(monkeypatch, comp)
    svc._on_tool_rejected = lambda name, reason: seen.append((name, reason))
    await drain(await svc.get_chat_completions(None))
    assert [n for n, _ in seen] == ["capture_lead"]
    assert "schema" in seen[0][1]


# --- the pipeline does not wait for speech recognition to connect --------------------


async def test_the_pipeline_starts_without_waiting_for_deepgram(monkeypatch):
    stt = main.DeepgramSTTService(api_key="k")
    connected = asyncio.Event()

    async def slow_handler():
        await asyncio.sleep(1.0)  # what Deepgram's handshake took on 892bf848
        connected.set()

    monkeypatch.setattr(stt, "_connection_handler", slow_handler)
    monkeypatch.setattr(stt, "create_task", lambda coro, *a, **k: asyncio.create_task(coro))
    started = time.monotonic()
    await asyncio.wait_for(stt._connect(), 2.0)
    assert time.monotonic() - started < 0.1
    assert not connected.is_set()  # still connecting, in the background
    await asyncio.wait_for(connected.wait(), 2.0)


async def test_audio_before_deepgram_connects_is_dropped_not_an_error():
    stt = main.DeepgramSTTService(api_key="k")
    assert stt._connection is None
    assert [f async for f in stt.run_stt(b"\0\0" * 160)] == [None]

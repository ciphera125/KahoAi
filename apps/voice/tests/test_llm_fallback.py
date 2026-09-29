"""A 429 on the primary model must be retried on the fallback model, not go to silence.

This covers a failure specific to the primary model (Groq rate-limits per model,
and a 429 on qwen/qwen3.8-27b was seen live during the benchmark run). Both
models are Groq's on the same account and key, so it does NOT cover a Groq-wide
outage: a known, accepted gap for now.
"""

import asyncio

import httpx
import main
import openai
import pytest

PRIMARY = "qwen/qwen3.8-27b"
BACKUP = "openai/gpt-oss-20b"


def _status_error(cls, code):
    req = httpx.Request("POST", "https://api.groq.com/openai/v1/chat/completions")
    return cls(
        f"Rate limit reached for model `{PRIMARY}`",
        response=httpx.Response(code, request=req),
        body=None,
    )


class FakeCompletions:
    """Fails on the primary model only, the way the real 429 did."""

    def __init__(self, primary_error=None, fallback_delay=0.0):
        self.models, self.primary_error, self.fallback_delay = [], primary_error, fallback_delay

    async def create(self, **params):
        self.models.append(params["model"])
        if params["model"] == PRIMARY and self.primary_error:
            raise self.primary_error
        if params["model"] == BACKUP and self.fallback_delay:
            await asyncio.sleep(self.fallback_delay)
        return f"stream from {params['model']}"


def make(monkeypatch, completions, **kw):
    svc = object.__new__(main.PortableGroqLLMService)
    svc._fallback_model = kw.get("fallback_model", BACKUP)
    svc._fallback_timeout_secs = kw.get("timeout", 3.0)
    svc._on_fallback = kw.get("on_fallback")
    svc._settings = type("S", (), {"model": PRIMARY, "system_instruction": "x"})()
    svc._client = type("C", (), {"chat": type("Ch", (), {"completions": completions})()})()
    svc._name = "GroqLLMService#test"
    svc._retry_on_timeout = False
    svc.get_llm_adapter = lambda: type(
        "A",
        (),
        {
            "get_messages_for_logging": lambda self, ctx: [],
            "get_llm_invocation_params": lambda self, ctx, **k: {"messages": []},
        },
    )()
    svc.supports_developer_role = False
    # The real base-class request path runs; only the model name and the HTTP
    # client are stubbed, so this exercises Pipecat's own get_chat_completions.
    monkeypatch.setattr(
        main.GroqLLMService,
        "build_chat_completion_params",
        lambda self, p: {"model": self._settings.model, **p},
    )
    return svc


async def test_429_on_qwen_is_retried_on_gpt_oss_20b(monkeypatch):
    comp = FakeCompletions(primary_error=_status_error(openai.RateLimitError, 429))
    seen = []
    svc = make(monkeypatch, comp, on_fallback=lambda *a: seen.append(a))
    assert await svc.get_chat_completions(None) == f"stream from {BACKUP}"
    assert comp.models == [PRIMARY, BACKUP]
    assert seen and seen[0][:2] == (PRIMARY, BACKUP)


async def test_healthy_primary_never_touches_the_fallback(monkeypatch):
    comp = FakeCompletions()
    svc = make(monkeypatch, comp)
    assert await svc.get_chat_completions(None) == f"stream from {PRIMARY}"
    assert comp.models == [PRIMARY]


async def test_server_error_falls_back_too(monkeypatch):
    comp = FakeCompletions(primary_error=_status_error(openai.InternalServerError, 503))
    assert await make(monkeypatch, comp).get_chat_completions(None) == f"stream from {BACKUP}"


async def test_a_bad_request_is_not_retried(monkeypatch):
    comp = FakeCompletions(primary_error=_status_error(openai.BadRequestError, 400))
    with pytest.raises(openai.BadRequestError):
        await make(monkeypatch, comp).get_chat_completions(None)
    assert comp.models == [PRIMARY]


async def test_a_slow_fallback_is_cut_off_by_its_own_deadline(monkeypatch):
    comp = FakeCompletions(
        primary_error=_status_error(openai.RateLimitError, 429), fallback_delay=5.0
    )
    svc = make(monkeypatch, comp, timeout=0.05)
    with pytest.raises(asyncio.TimeoutError):
        await svc.get_chat_completions(None)


async def test_both_failing_raises_so_resilience_can_apologise(monkeypatch):
    class Both(FakeCompletions):
        async def create(self, **params):
            self.models.append(params["model"])
            raise _status_error(openai.RateLimitError, 429)

    with pytest.raises(openai.RateLimitError):
        await make(monkeypatch, Both()).get_chat_completions(None)


async def test_no_fallback_configured_raises_the_original_error(monkeypatch):
    comp = FakeCompletions(primary_error=_status_error(openai.RateLimitError, 429))
    with pytest.raises(openai.RateLimitError):
        await make(monkeypatch, comp, fallback_model=None).get_chat_completions(None)
    assert comp.models == [PRIMARY]

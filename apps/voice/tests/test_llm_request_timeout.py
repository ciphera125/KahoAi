"""The OpenAI client's own defaults are a 600s timeout and up to 2 silent
retries on a timeout or connection error (seen live as an 11s time-to-first-
token with nothing in the log, 2026-10-02): a hang would run past every
deadline this file knows about before the client itself gave up.
PortableGroqLLMService.create_client() sets its own, much shorter timeout and
turns the hidden retries off. This checks that against a request that really
hangs over a real socket, not a monkeypatched coroutine, so the client
construction itself is exercised, not just the fallback logic (see
test_llm_fallback.py for that).
"""

import asyncio

import main
import openai
import pytest


def _adapter_stub():
    return type(
        "A",
        (),
        {
            "get_messages_for_logging": lambda self, ctx: [],
            "get_llm_invocation_params": lambda self, ctx, **k: {"messages": []},
        },
    )()


def _bare_service(monkeypatch, **kwargs):
    """A real PortableGroqLLMService, with only the request path stubbed enough
    to reach the real client: no fake _client, unlike test_llm_fallback.py."""
    monkeypatch.setattr(
        main.GroqLLMService,
        "build_chat_completion_params",
        lambda self, p: {"model": self._settings.model, **p},
    )
    svc = main.PortableGroqLLMService(
        api_key="k",
        settings=main.GroqLLMService.Settings(model="m"),
        **kwargs,
    )
    svc.get_llm_adapter = _adapter_stub
    svc.supports_developer_role = False
    return svc


class HungServer:
    """Accepts a connection and never answers: no response, no close, no
    error — the same shape as the live stall this is guarding against.

    Python 3.13's Server.wait_closed() waits for open connections to finish,
    not just for the listening socket to shut down, so a connection this
    server never closes would hang the test's own teardown; close() aborts
    every connection it has accepted first.
    """

    def __init__(self):
        self.writers: list[asyncio.StreamWriter] = []

    async def _handle(self, reader, writer):
        self.writers.append(writer)
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            pass

    async def start(self) -> str:
        self._server = await asyncio.start_server(self._handle, "127.0.0.1", 0)
        host, port = self._server.sockets[0].getsockname()[:2]
        return f"http://{host}:{port}/v1"

    async def close(self) -> None:
        for writer in self.writers:
            writer.transport.abort()
        self._server.close()
        await self._server.wait_closed()


async def _hung_server():
    server = HungServer()
    base_url = await server.start()
    return server, base_url


def test_the_client_has_no_hidden_retries_and_the_configured_timeout(monkeypatch):
    svc = _bare_service(monkeypatch, request_timeout_secs=1.5)
    assert svc._client.max_retries == 0
    assert svc._client.timeout == pytest.approx(1.5)


def test_a_different_timeout_can_be_configured(monkeypatch):
    svc = _bare_service(monkeypatch, request_timeout_secs=12.0)
    assert svc._client.timeout == pytest.approx(12.0)


async def test_a_hung_connection_is_caught_well_under_the_clients_600s_default(monkeypatch):
    server, base_url = await _hung_server()
    try:
        svc = _bare_service(
            monkeypatch, base_url=base_url, request_timeout_secs=0.3, fallback_model=None
        )
        started = asyncio.get_event_loop().time()
        with pytest.raises(openai.APITimeoutError):
            await svc.get_chat_completions(None)
        # Well under the client's 600s default and with no quiet retry stretching it.
        assert asyncio.get_event_loop().time() - started < 5
    finally:
        await server.close()


async def test_a_hung_primary_still_falls_back_through_the_clients_own_timeout(monkeypatch):
    """Same as above, but through get_chat_completions' own fallback path: a
    stall on the primary is 'worth falling back' (it is an APIConnectionError
    subclass), so this raises only once gpt-oss has also been tried."""
    server, base_url = await _hung_server()
    try:
        svc = _bare_service(
            monkeypatch,
            base_url=base_url,
            request_timeout_secs=0.3,
            fallback_model="openai/gpt-oss-20b",
            fallback_timeout_secs=0.3,
        )
        started = asyncio.get_event_loop().time()
        # The fallback request goes to the same hung server, so it also stalls;
        # _fallback_completions bounds it with its own asyncio.wait_for.
        with pytest.raises(TimeoutError):
            await svc.get_chat_completions(None)
        assert asyncio.get_event_loop().time() - started < 5
    finally:
        await server.close()

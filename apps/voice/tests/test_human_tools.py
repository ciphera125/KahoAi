"""transfer_to_human and call_webhook: real HTTP against a local server, no Plivo."""

import asyncio
import json
from types import SimpleNamespace

import pytest
import server
import tools
from aiohttp import web


@pytest.fixture
async def business():
    """A stand-in for the business's system. Behaviour is chosen per test."""
    seen, mode = [], {"kind": "ok"}

    async def handler(request):
        seen.append({"body": await request.json(), "auth": request.headers.get("Authorization")})
        kind = mode["kind"]
        if kind == "slow":
            await asyncio.sleep(5)
        if kind == "500":
            return web.Response(status=500, text="boom")
        if kind == "redirect":
            raise web.HTTPFound("http://127.0.0.1:1/internal")
        return web.Response(text=json.dumps({"order": "shipped"}))

    app = web.Application()
    app.router.add_post("/hook", handler)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    port = site._server.sockets[0].getsockname()[1]
    yield SimpleNamespace(url=f"http://127.0.0.1:{port}/hook", seen=seen, mode=mode)
    await runner.cleanup()


def call():
    return tools.CallContext(call_id="c1", caller_number="+919800000000")


async def test_webhook_posts_masked_details_and_returns_the_reply(business, monkeypatch):
    monkeypatch.setenv("TOOL_WEBHOOK_URL", business.url)
    monkeypatch.setenv("TOOL_WEBHOOK_SECRET", "s3cret")
    out = await tools.call_webhook(
        {"action": "check_order", "details": "aadhaar 2345 6789 0123, order 55"}, call()
    )
    assert out["status"] == "ok" and "shipped" in out["reply"]
    sent = business.seen[0]
    assert sent["auth"] == "Bearer s3cret"
    assert sent["body"]["action"] == "check_order" and sent["body"]["call_id"] == "c1"
    assert "2345 6789 0123" not in json.dumps(sent["body"])  # never leaves in full


async def test_webhook_error_status_is_reported_not_swallowed(business, monkeypatch):
    monkeypatch.setenv("TOOL_WEBHOOK_URL", business.url)
    business.mode["kind"] = "500"
    out = await tools.call_webhook({"action": "x"}, call())
    assert "error" in out and "500" in out["error"]


async def test_webhook_is_bounded_by_a_deadline(business, monkeypatch):
    monkeypatch.setenv("TOOL_WEBHOOK_URL", business.url)
    monkeypatch.setattr(tools, "WEBHOOK_TIMEOUT_SECS", 0.1)
    business.mode["kind"] = "slow"
    out = await asyncio.wait_for(tools.call_webhook({"action": "x"}, call()), 2)
    assert "error" in out


async def test_webhook_does_not_follow_redirects(business, monkeypatch):
    monkeypatch.setenv("TOOL_WEBHOOK_URL", business.url)
    business.mode["kind"] = "redirect"
    out = await tools.call_webhook({"action": "x"}, call())
    assert "error" in out  # a 302 is not a 2xx, and was not chased


async def test_webhook_unreachable_is_an_error_result(monkeypatch):
    monkeypatch.setenv("TOOL_WEBHOOK_URL", "http://127.0.0.1:1/hook")
    out = await tools.call_webhook({"action": "x"}, call())
    assert "error" in out


@pytest.mark.parametrize(
    "url", [None, "", "ftp://x.example/h", "http://example.com/h", "http://169.254.169.254/h"]
)
async def test_webhook_refuses_unset_or_insecure_urls(url, monkeypatch):
    monkeypatch.delenv("TOOL_WEBHOOK_URL", raising=False)
    if url is not None:
        monkeypatch.setenv("TOOL_WEBHOOK_URL", url)
    assert "error" in await tools.call_webhook({"action": "x"}, call())


async def test_webhook_needs_an_action(business, monkeypatch):
    monkeypatch.setenv("TOOL_WEBHOOK_URL", business.url)
    assert "error" in await tools.call_webhook({"action": " "}, call())
    assert business.seen == []


async def test_the_model_cannot_choose_the_webhook_url(business, monkeypatch):
    monkeypatch.setenv("TOOL_WEBHOOK_URL", business.url)
    await tools.call_webhook({"action": "x", "url": "https://evil.example"}, call())
    assert len(business.seen) == 1  # went to the configured URL, `url` is ignored


# --- transfer ------------------------------------------------------------------


async def test_transfer_asks_the_phone_server_to_move_the_call():
    c, moved = call(), []

    async def transfer():
        moved.append(True)

    c.transfer = transfer
    assert await tools.transfer_to_human({}, c) == {"status": "transferring"}
    assert moved == [True]


async def test_transfer_on_a_call_that_cannot_transfer_says_so():
    assert "error" in await tools.transfer_to_human({}, call())


async def test_a_failed_transfer_reaches_the_model_as_an_error_and_is_audited(tmp_path):
    from transcript import CallTranscript

    t = CallTranscript("c1", tmp_path)
    c = tools.CallContext(call_id="c1", transcript=t)

    async def refuse():
        raise RuntimeError("Plivo refused the transfer (HTTP 400)")

    c.transfer = refuse
    schemas = tools.build_tool_schemas(c, ["transfer_to_human"])
    got = []

    async def cb(result, **kw):
        got.append(result)

    await schemas[0].handler(SimpleNamespace(arguments={}, result_callback=cb))
    assert "error" in got[0]
    assert "transfer_to_human" in t.path.read_text(encoding="utf-8")


def test_transfer_route_needs_the_token_and_a_configured_number(monkeypatch):
    from fastapi.testclient import TestClient

    monkeypatch.setenv("WEBHOOK_SECRET", "tok")
    monkeypatch.delenv("TRANSFER_NUMBER", raising=False)
    client = TestClient(server.app)
    assert client.post("/transfer?token=tok").status_code == 403  # no number set
    monkeypatch.setenv("TRANSFER_NUMBER", "+919811111111")
    assert client.post("/transfer?token=wrong").status_code == 403
    ok = client.post("/transfer?token=tok")
    assert ok.status_code == 200 and "<Dial><Number>+919811111111</Number></Dial>" in ok.text


def test_transfer_number_is_reduced_to_a_phone_number(monkeypatch):
    monkeypatch.setenv("TRANSFER_NUMBER", "+91 98111<script>11111")
    assert server.transfer_number() == "+919811111111"
    assert "script" not in server.transfer_xml(server.transfer_number())
    monkeypatch.setenv("TRANSFER_NUMBER", "abc")
    assert server.transfer_number() is None


async def test_request_transfer_raises_when_plivo_refuses():
    async def refuse(request):
        return web.Response(status=400)

    async def accept(request):
        body = await request.json()
        assert body["legs"] == "aleg" and body["aleg_url"] == "https://h/transfer?token=t"
        return web.Response(status=202)

    for handler, should_raise in ((refuse, True), (accept, False)):
        app = web.Application()
        app.router.add_post("/v1/Account/A/Call/C/", handler)
        runner = web.AppRunner(app)
        await runner.setup()
        site = web.TCPSite(runner, "127.0.0.1", 0)
        await site.start()
        base = f"http://127.0.0.1:{site._server.sockets[0].getsockname()[1]}"
        try:
            coro = server.request_transfer("A", "T", "C", "https://h/transfer?token=t", base)
            if should_raise:
                with pytest.raises(RuntimeError):
                    await coro
            else:
                await coro
        finally:
            await runner.cleanup()


async def test_warm_up_never_raises_when_groq_is_unreachable(monkeypatch):
    monkeypatch.setenv("GROQ_API_KEY", "k")
    import aiohttp

    def boom(*a, **k):
        raise aiohttp.ClientConnectionError("no route")

    monkeypatch.setattr(aiohttp.ClientSession, "get", boom)
    await server.warm_up()


def test_region_check_only_warns(monkeypatch):
    monkeypatch.delenv("DEPLOY_REGION", raising=False)
    server.check_region()
    monkeypatch.setenv("DEPLOY_REGION", "ap-south-1")
    server.check_region()

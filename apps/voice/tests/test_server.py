import re

import pytest
import server
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect


def stream_url(**call) -> str:
    """A /ws URL with a token as /answer would issue it for this call."""
    base = {"caller": None, "agent": None, "max_secs": None, "studio_agent": None}
    return f"/ws?stream={server.issue_stream({**base, **call})}"


def answered(resp) -> dict:
    """What /answer decided for the call, as /ws will receive it."""
    token = re.search(r"stream=([A-Za-z0-9_-]+)", resp.text).group(1)
    return server._streams[token][1]


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setenv("WEBHOOK_SECRET", "s3cret")
    monkeypatch.setenv("PUBLIC_HOST", "kaho.example.com")
    monkeypatch.delenv("MAX_CALL_DURATION_SECS", raising=False)
    monkeypatch.delenv("WS_RATE_LIMIT_PER_MINUTE", raising=False)
    monkeypatch.delenv("WS_MAX_CONCURRENT_CALLS", raising=False)
    # Each test gets its own limiter: the real one is process-wide, so state
    # from one test must never leak into the next.
    monkeypatch.setattr(server, "_ws_limiter", None)
    return TestClient(server.app)


def test_answer_rejects_missing_or_wrong_token(client):
    assert client.post("/answer").status_code == 403
    assert client.post("/answer?token=nope").status_code == 403


def test_answer_streams_call_audio_to_our_websocket(client):
    resp = client.post("/answer?token=s3cret&From=%2B919999999999")
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("text/xml")
    assert 'bidirectional="true"' in resp.text
    assert 'contentType="audio/x-mulaw;rate=8000"' in resp.text
    assert ">wss://kaho.example.com/ws?stream=" in resp.text and "s3cret" not in resp.text
    assert answered(resp) == {"caller": "+919999999999", "agent": None, "max_secs": 600,
                              "studio_agent": None}


def test_answer_works_for_get_too(client):
    assert client.get("/answer?token=s3cret").status_code == 200


def test_no_secret_configured_rejects_everything(client, monkeypatch):
    monkeypatch.delenv("WEBHOOK_SECRET")
    assert client.post("/answer").status_code == 403
    assert client.post("/answer?token=").status_code == 403


def test_websocket_rejects_bad_token(client):
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect("/ws?stream=wrong"):
            pass


def test_callers_number_from_the_post_form_rides_on_the_stream_url(client):
    """Plivo sends its parameters as a form body, not a query string."""
    resp = client.post(
        "/answer?token=s3cret",
        content="From=%2B919876543210&To=%2B918000000000&CallUUID=abc",
        headers={"content-type": "application/x-www-form-urlencoded"},
    )
    assert answered(resp)["caller"] == "+919876543210"


def test_no_caller_number_means_no_from_param(client):
    assert answered(client.post("/answer?token=s3cret"))["caller"] is None


def test_hostile_caller_value_is_reduced_to_digits():
    assert server.clean_caller("+91 98765-43210") == "+919876543210"
    assert server.clean_caller("<script>1</script>") == "1"
    assert server.clean_caller("") is None


# --- provider-failure behaviour on the phone path ------------------------------

import asyncio  # noqa: E402


def test_the_answer_xml_has_a_spoken_fallback_after_the_stream(client):
    text = client.post("/answer?token=s3cret").text
    assert text.index("</Stream>") < text.index("<Speak")
    assert "technical problem" in text and text.endswith("</Speak></Response>")


def test_a_custom_failure_message_is_used_and_escaped(client, monkeypatch):
    monkeypatch.setenv("FAILURE_MESSAGE", "Sorry & <bye>")
    assert "<Speak language=\"en-IN\">Sorry &amp; &lt;bye&gt;</Speak>" in client.post(
        "/answer?token=s3cret"
    ).text


async def test_fail_open_serializer_leaves_the_call_alone(monkeypatch):
    hung = []

    async def real_hangup(self):
        hung.append(True)

    monkeypatch.setattr(server.PlivoFrameSerializer, "_hang_up_call", real_hangup)
    s = server.FailOpenPlivoSerializer(
        stream_id="S", call_id="C", auth_id="a", auth_token="t"
    )
    s.fail_open = True
    await s._hang_up_call()
    assert hung == []
    s.fail_open = False
    await s._hang_up_call()
    assert hung == [True]
    await asyncio.sleep(0)


def _stub_run_call(monkeypatch, on_accept=None):
    """Replace the real call handling with one that just accepts and closes,
    so these tests exercise the rate limiter in stream() without needing a
    real pipeline (build_worker needs real provider keys)."""

    async def fake(websocket, token, caller, persona_path, limit, **_):
        await websocket.accept()
        if on_accept:
            on_accept()
        await websocket.close()

    monkeypatch.setattr(server, "_run_call", fake)


def test_a_normal_connection_passes_the_rate_limiter_and_is_handled(client, monkeypatch):
    accepted = []
    _stub_run_call(monkeypatch, on_accept=lambda: accepted.append(1))
    with client.websocket_connect(stream_url()):
        pass
    assert accepted == [1]


def test_a_connection_over_the_per_ip_limit_is_rejected(client, monkeypatch):
    monkeypatch.setenv("WS_RATE_LIMIT_PER_MINUTE", "2")
    monkeypatch.setenv("WS_MAX_CONCURRENT_CALLS", "100")
    _stub_run_call(monkeypatch)

    with client.websocket_connect(stream_url()):
        pass
    with client.websocket_connect(stream_url()):
        pass
    with pytest.raises(WebSocketDisconnect) as exc:
        with client.websocket_connect(stream_url()):
            pass
    assert exc.value.code == 1013


def test_a_rejection_is_logged_with_the_ip_and_the_limit(client, monkeypatch):
    monkeypatch.setenv("WS_RATE_LIMIT_PER_MINUTE", "1")
    monkeypatch.setenv("WS_MAX_CONCURRENT_CALLS", "100")
    _stub_run_call(monkeypatch)
    warnings = []
    monkeypatch.setattr(server.logger, "warning", lambda msg: warnings.append(msg))

    with client.websocket_connect(stream_url()):
        pass
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect(stream_url()):
            pass

    assert len(warnings) == 1
    assert "testclient" in warnings[0]
    assert "per-IP" in warnings[0]


def test_a_connection_over_the_global_concurrent_cap_is_rejected(client, monkeypatch):
    """The global cap is meant to fire even from a fresh IP, independent of the
    per-IP window, so it is filled directly here rather than by holding a second
    real websocket open: TestClient's websocket support does not handle two
    genuinely concurrent connections from one test process cleanly, and the
    limiter itself (which IP takes which slot) is already covered in
    test_rate_limit.py — this test is only about stream()'s own wiring to it."""
    monkeypatch.setenv("WS_RATE_LIMIT_PER_MINUTE", "100")
    monkeypatch.setenv("WS_MAX_CONCURRENT_CALLS", "1")
    _stub_run_call(monkeypatch)

    # Occupy the one global slot as some other, already-connected caller would.
    assert server.ws_limiter().try_accept("9.9.9.9") is None

    with pytest.raises(WebSocketDisconnect) as exc:
        with client.websocket_connect(stream_url()):
            pass
    assert exc.value.code == 1013


def test_rejected_attempts_do_not_hold_the_global_slot_open(client, monkeypatch):
    """A connection rejected by the per-IP limit must never have taken a
    concurrent slot, or it would starve later, legitimate connections."""
    monkeypatch.setenv("WS_RATE_LIMIT_PER_MINUTE", "1")
    monkeypatch.setenv("WS_MAX_CONCURRENT_CALLS", "1")
    accepted = []
    _stub_run_call(monkeypatch, on_accept=lambda: accepted.append(1))

    with client.websocket_connect(stream_url()):
        pass
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect(stream_url()):
            pass
    assert accepted == [1]

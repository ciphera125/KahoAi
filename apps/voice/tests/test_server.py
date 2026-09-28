import pytest
import server
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setenv("WEBHOOK_SECRET", "s3cret")
    monkeypatch.setenv("PUBLIC_HOST", "kaho.example.com")
    monkeypatch.delenv("MAX_CALL_DURATION_SECS", raising=False)
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
    assert "/ws?token=s3cret&amp;from=%2B919999999999&amp;max=600</Stream>" in resp.text


def test_answer_works_for_get_too(client):
    assert client.get("/answer?token=s3cret").status_code == 200


def test_no_secret_configured_rejects_everything(client, monkeypatch):
    monkeypatch.delenv("WEBHOOK_SECRET")
    assert client.post("/answer").status_code == 403
    assert client.post("/answer?token=").status_code == 403


def test_websocket_rejects_bad_token(client):
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect("/ws?token=wrong"):
            pass


def test_callers_number_from_the_post_form_rides_on_the_stream_url(client):
    """Plivo sends its parameters as a form body, not a query string."""
    resp = client.post(
        "/answer?token=s3cret",
        content="From=%2B919876543210&To=%2B918000000000&CallUUID=abc",
        headers={"content-type": "application/x-www-form-urlencoded"},
    )
    assert "/ws?token=s3cret&amp;from=%2B919876543210&amp;max=600</Stream>" in resp.text


def test_no_caller_number_means_no_from_param(client):
    assert ">wss://kaho.example.com/ws?token=s3cret&amp;max=600</Stream>" in client.post(
        "/answer?token=s3cret"
    ).text


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

import pytest
import server
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setenv("WEBHOOK_SECRET", "s3cret")
    monkeypatch.setenv("PUBLIC_HOST", "kaho.example.com")
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
    assert "/ws?token=s3cret&amp;from=%2B919999999999</Stream>" in resp.text


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
    assert "/ws?token=s3cret&amp;from=%2B919876543210</Stream>" in resp.text


def test_no_caller_number_means_no_from_param(client):
    assert ">wss://kaho.example.com/ws?token=s3cret</Stream>" in client.post(
        "/answer?token=s3cret"
    ).text


def test_hostile_caller_value_is_reduced_to_digits():
    assert server.clean_caller("+91 98765-43210") == "+919876543210"
    assert server.clean_caller("<script>1</script>") == "1"
    assert server.clean_caller("") is None

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
    assert ">wss://kaho.example.com/ws?token=s3cret</Stream>" in resp.text


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

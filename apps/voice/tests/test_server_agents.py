"""The phone server runs the agent the Studio chose, and records how calls ended."""

import agents_store
import call_outcomes
import pytest
import server
from fastapi.testclient import TestClient

OURS = "+918065520552"


@pytest.fixture
def client(monkeypatch, tmp_path):
    monkeypatch.setenv("WEBHOOK_SECRET", "s3cret")
    monkeypatch.setenv("PUBLIC_HOST", "kaho.example.com")
    monkeypatch.setenv("PLIVO_FROM_NUMBER", OURS)
    monkeypatch.setenv("AGENT_STORE_PATH", str(tmp_path / "agents.json"))
    monkeypatch.setenv("OUTCOME_LOG_PATH", str(tmp_path / "outcomes.jsonl"))
    monkeypatch.setattr(server, "_ws_limiter", None)
    return TestClient(server.app)


@pytest.fixture
def agent():
    store = agents_store.default_store()
    a = store.create_agent("Reminder", "", "You are Riya, reminding about EMIs.")
    store.update_agent(a["id"], tools=["end_call"],
                       settings={"opening_line": "Namaste, Riya here.", "max_minutes": 2})
    return a


def test_an_outbound_studio_agent_rides_on_to_the_stream(client, agent):
    r = client.post(f"/answer?token=s3cret&studio_agent={agent['id']}&peer=%2B919876543210")
    assert r.status_code == 200 and f"studio_agent={agent['id']}" in r.text
    assert "max=120" in r.text  # the agent's own limit, under the server ceiling


def test_an_inbound_call_gets_the_agent_its_number_routes_to(client, agent):
    agents_store.default_store().route_number(OURS, agent["id"])
    r = client.post("/answer?token=s3cret", content=f"From=%2B919876543210&To={OURS[1:]}",
                    headers={"content-type": "application/x-www-form-urlencoded"})
    assert f"studio_agent={agent['id']}" in r.text


@pytest.mark.parametrize("bad", ["ag_000000000000", "..%2F..%2F.env", "x" * 200])
def test_an_unknown_studio_agent_is_refused(client, bad):
    assert client.post(f"/answer?token=s3cret&studio_agent={bad}").status_code == 400
    assert client.post("/answer?token=s3cret").status_code == 200


def test_the_stream_hands_the_agents_config_to_the_call(client, agent, monkeypatch):
    seen = {}

    async def fake(websocket, token, caller, persona_path, limit, agent_config=None):
        seen.update(limit=limit, config=agent_config)
        await websocket.accept()
        await websocket.close()

    monkeypatch.setattr(server, "_run_call", fake)
    with client.websocket_connect(f"/ws?token=s3cret&studio_agent={agent['id']}&max=600"):
        pass
    assert seen["config"]["prompt"] == "You are Riya, reminding about EMIs."
    assert seen["config"]["tools"] == ["end_call"]
    assert seen["limit"] == 120


def test_an_agent_deleted_mid_ring_falls_back_instead_of_failing(client, agent, monkeypatch):
    seen = {}

    async def fake(websocket, token, caller, persona_path, limit, agent_config=None):
        seen["config"] = agent_config
        await websocket.accept()
        await websocket.close()

    monkeypatch.setattr(server, "_run_call", fake)
    agents_store.default_store().delete_agent(agent["id"])
    with client.websocket_connect(f"/ws?token=s3cret&studio_agent={agent['id']}"):
        pass
    assert seen["config"] is None


def test_the_studio_agents_prompt_beats_the_old_number_prompt(agent):
    cfg = agents_store.default_store().call_config(agent["id"])
    assert server.persona_text_for_call(cfg) == "You are Riya, reminding about EMIs."


# --- how the call ended ----------------------------------------------------------


def hangup(client, body, token="s3cret", query=""):
    return client.post(f"/hangup?token={token}{query}", content=body,
                       headers={"content-type": "application/x-www-form-urlencoded"})


def test_a_hangup_callback_records_the_outcome(client):
    r = hangup(client, "CallUUID=abc12345-1&RequestUUID=abc12345-1&CallStatus=no-answer"
                       "&HangupCauseName=No+Answer&BillDuration=0&To=919876543210"
                       "&Direction=outbound", query="&peer=%2B919876543210")
    assert r.status_code == 200
    row = call_outcomes.default_log().all()["abc12345-1"]
    assert row["status"] == "no_answer" and row["peer"] == "+919876543210"


def test_a_hangup_without_the_token_is_refused_and_not_recorded(client):
    assert hangup(client, "CallUUID=abc12345-1&CallStatus=completed", token="nope").status_code \
        == 403
    assert call_outcomes.default_log().all() == {}


@pytest.mark.parametrize("body", ["CallUUID=..%2F..%2Fetc&CallStatus=completed", "CallStatus=x",
                                  "CallUUID=" + "a" * 5000])
def test_a_junk_hangup_is_ignored(client, body):
    assert hangup(client, body).status_code == 200
    assert call_outcomes.default_log().all() == {}


@pytest.mark.parametrize("path", ["/hangup", "/answer"])
def test_an_oversized_webhook_body_is_refused_unread(client, path):
    big = "CallUUID=abc12345-9&CallStatus=completed&x=" + "A" * (1024 * 1024)
    r = client.post(f"{path}?token=s3cret", content=big,
                    headers={"content-type": "application/x-www-form-urlencoded"})
    assert r.status_code == 413
    assert call_outcomes.default_log().all() == {}


def test_a_body_without_a_length_is_still_capped(client):
    def chunks():
        for _ in range(64):
            yield b"A" * 1024

    r = client.post("/hangup?token=s3cret", content=chunks(),
                    headers={"content-type": "application/x-www-form-urlencoded"})
    assert r.status_code == 413

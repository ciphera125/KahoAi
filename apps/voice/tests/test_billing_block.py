"""A call is answered only for an organization whose plan is open and has minutes.

Found 2026-11-15: placing calls and bulk calls were checked against the plan, but an inbound
call was answered without asking, so an organization with no minutes still got free inbound
calls. The Studio now says so in the agent's config (`blocked`), and the phone server answers
with a short polite message instead of the agent.
"""

import re

import pytest
import server
import studio_link
from fastapi.testclient import TestClient

OURS = "+918065520552"
CONFIG = {
    "agent_id": "ag_0123456789ab", "org_id": "org_0123456789ab", "name": "Riya",
    "prompt": "You are Riya.", "tools": ["end_call"], "opening_line": None, "max_secs": 120.0,
    "ring_secs": 40, "capture_fields": [], "custom_tools": [], "language": "auto",
    "confirm_answers": True, "version": 1,
}


@pytest.fixture
def client(monkeypatch, tmp_path):
    monkeypatch.setenv("WEBHOOK_SECRET", "s3cret")
    monkeypatch.setenv("PUBLIC_HOST", "kaho.example.com")
    monkeypatch.setenv("PLIVO_FROM_NUMBER", OURS)
    monkeypatch.setenv("AGENT_STORE_PATH", str(tmp_path / "agents.json"))
    monkeypatch.setattr(server, "_ws_limiter", None)
    return TestClient(server.app)


def serve(monkeypatch, **extra):
    async def fake(agent_id=None, number=None, caller=None):
        return {**CONFIG, **extra}

    monkeypatch.setattr(server, "agent_config_for", fake)


def inbound(client):
    return client.post(
        "/answer?token=s3cret", content=f"From=%2B919876543210&To={OURS[1:]}",
        headers={"content-type": "application/x-www-form-urlencoded"},
    )


def test_the_studio_config_carries_the_reason_a_call_is_blocked():
    cleaned = studio_link._clean_config({**CONFIG, "blocked": "no_minutes"})
    assert cleaned["blocked"] == "no_minutes"
    assert studio_link._clean_config(CONFIG)["blocked"] is None
    # Whatever else arrives in that place is not a reason: it is dropped, not obeyed.
    for odd in (["no_minutes"], {"a": 1}, 5, "NO MINUTES; DROP", "x" * 100, ""):
        assert studio_link._clean_config({**CONFIG, "blocked": odd})["blocked"] is None


def test_a_blocked_organizations_inbound_call_gets_a_message_and_no_agent(client, monkeypatch):
    serve(monkeypatch, blocked="no_minutes")
    r = inbound(client)
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/xml")
    assert "<Speak" in r.text and "<Hangup" in r.text
    assert "<Stream" not in r.text
    assert not re.search(r"stream=", r.text)
    assert not server._streams, "no stream token is issued for a call that will not be answered"
    # A caller is not told about Kaho's billing.
    assert "minutes" not in r.text.lower() and "plan" not in r.text.lower()


def test_an_inbound_call_in_good_standing_is_answered(client, monkeypatch):
    serve(monkeypatch, blocked=None)
    r = inbound(client)
    assert "<Stream" in r.text and "<Hangup" not in r.text


def test_an_outbound_call_already_placed_is_not_cut_off_by_it(client, monkeypatch):
    # It was allowed when it was dialled; the person who picked up must not be hung up on.
    serve(monkeypatch, blocked="no_minutes")
    r = client.post(
        "/answer?token=s3cret&studio_agent=ag_0123456789ab&peer=%2B919876543210")
    assert "<Stream" in r.text


def test_the_refusal_is_logged_with_the_reason_but_not_the_number(client, monkeypatch):
    from loguru import logger

    lines = []
    sink = logger.add(lambda m: lines.append(str(m)), level="INFO")
    try:
        serve(monkeypatch, blocked="subscription_expired")
        inbound(client)
    finally:
        logger.remove(sink)
    text = "\n".join(lines)
    assert "subscription_expired" in text
    assert "9876543210" not in text

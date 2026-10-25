"""The phone server reads its agents from the Studio and reports calls back to it.

Before this, the Studio (backend/, Postgres) dialled calls with its agent's id,
but the phone server looked that id up in data/agents.json, the old Studio's
file: an agent made in the new Studio was refused ("unknown agent"), and one
edited there kept its old prompt and opening line on calls. Nothing the call
did reached the Studio either: no outcome, no transcript, no live captions.
"""

import asyncio
import json
import re
from pathlib import Path

import agents_store
import httpx
import pytest
import server
import studio_link
from fastapi.testclient import TestClient
from transcript import CallTranscript

TOKEN = "t" * 40
AGENT = "ag_0123456789ab"
CONFIG = {"agent_id": AGENT, "org_id": "org_0123456789ab", "name": "Reminder",
          "prompt": "You are Riya.", "tools": ["end_call"],
          "opening_line": "Namaste, Riya here.",
          "max_secs": 120, "ring_secs": 40,
          "call_window": {"enabled": False, "start": "09:00", "end": "21:00",
                          "timezone": "Asia/Kolkata"}}


class FakeStudio:
    """The Studio's /internal/v1 API, as the voice service sees it."""

    def __init__(self, agents=None, fail=False, delay=0.0):
        self.agents = agents if agents is not None else {AGENT: CONFIG}
        self.fail, self.delay = fail, delay
        self.requests: list[httpx.Request] = []
        self.outcomes: dict[str, dict] = {}
        self.events: dict[str, list] = {}

    async def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if self.delay:
            await asyncio.sleep(self.delay)
        if self.fail:
            return httpx.Response(500, json={"error": "down"})
        if request.headers.get("authorization") != f"Bearer {TOKEN}":
            return httpx.Response(401)
        path = request.url.path
        if path == "/internal/v1/call-config":
            agent_id = request.url.params.get("agent_id")
            if not agent_id and request.url.params.get("number", "").lstrip("+") == "918065520552":
                agent_id = AGENT
            return httpx.Response(200, json={"config": self.agents.get(agent_id)})
        if path.startswith("/internal/v1/calls/") and path.endswith("/events"):
            call_id = path.split("/")[4]
            self.events.setdefault(call_id, []).extend(json.loads(request.content)["events"])
            return httpx.Response(200, json={"ok": True})
        if path.startswith("/internal/v1/calls/") and request.method == "PUT":
            self.outcomes[path.split("/")[4]] = json.loads(request.content)
            return httpx.Response(200, json={"ok": True})
        return httpx.Response(404)


@pytest.fixture
def studio(monkeypatch):
    fake = FakeStudio()
    monkeypatch.setenv("STUDIO_INTERNAL_URL", "http://127.0.0.1:8021")
    monkeypatch.setenv("STUDIO_INTERNAL_TOKEN", TOKEN)
    monkeypatch.setattr(studio_link, "_transport", httpx.MockTransport(fake.handler))
    return fake


@pytest.fixture
def client(monkeypatch, tmp_path):
    monkeypatch.setenv("WEBHOOK_SECRET", "s3cret")
    monkeypatch.setenv("PUBLIC_HOST", "kaho.example.com")
    monkeypatch.setenv("PLIVO_FROM_NUMBER", "+918065520552")
    monkeypatch.setenv("AGENT_STORE_PATH", str(tmp_path / "agents.json"))
    monkeypatch.setenv("OUTCOME_LOG_PATH", str(tmp_path / "outcomes.jsonl"))
    monkeypatch.setattr(server, "_ws_limiter", None)
    return TestClient(server.app)


def stream_token(xml: str) -> str:
    return re.search(r"stream=([A-Za-z0-9_-]+)", xml).group(1)


def stream_call(xml: str) -> dict:
    return server._streams[stream_token(xml)][1]


# --- which agent a call gets -----------------------------------------------------------


def test_without_the_studio_settings_the_link_is_off(monkeypatch):
    monkeypatch.delenv("STUDIO_INTERNAL_URL", raising=False)
    monkeypatch.delenv("STUDIO_INTERNAL_TOKEN", raising=False)
    assert studio_link.configured() is False


async def test_an_agent_is_read_from_the_studio_with_the_token(studio):
    config = await studio_link.call_config(agent_id=AGENT)
    assert config["opening_line"] == "Namaste, Riya here."
    assert config["max_secs"] == 120.0
    assert studio.requests[0].headers["authorization"] == f"Bearer {TOKEN}"


async def test_an_unknown_agent_is_none_not_an_error(studio):
    assert await studio_link.call_config(agent_id="ag_000000000000") is None


async def test_a_studio_that_fails_raises_so_the_caller_can_fall_back(studio):
    studio.fail = True
    with pytest.raises(studio_link.StudioUnavailable):
        await studio_link.call_config(agent_id=AGENT)


async def test_a_slow_studio_is_given_up_on_within_its_deadline(studio, monkeypatch):
    monkeypatch.setenv("STUDIO_TIMEOUT_SECS", "0.2")
    studio.delay = 2.0
    loop = asyncio.get_running_loop()
    started = loop.time()
    with pytest.raises(studio_link.StudioUnavailable):
        await studio_link.call_config(agent_id=AGENT)
    assert loop.time() - started < 1.0


async def test_a_malformed_config_is_treated_as_unknown(studio):
    studio.agents = {AGENT: {"agent_id": AGENT, "max_secs": "lots"}}
    assert await studio_link.call_config(agent_id=AGENT) is None


def test_an_outbound_call_uses_the_studios_agent(client, studio):
    r = client.post(f"/answer?token=s3cret&studio_agent={AGENT}&peer=%2B919876543210")
    assert r.status_code == 200
    call = stream_call(r.text)
    assert call["studio_agent"] == AGENT
    assert call["agent_config"]["opening_line"] == "Namaste, Riya here."
    assert call["max_secs"] == 120  # the agent's own limit, under the server's ceiling


def test_an_agent_only_the_studio_knows_is_not_refused(client, studio, tmp_path):
    # data/agents.json is empty: the old lookup refused this call with 400.
    assert agents_store.default_store().call_config(AGENT) is None
    r = client.post(f"/answer?token=s3cret&studio_agent={AGENT}&peer=%2B91987")
    assert r.status_code == 200


def test_an_agent_unknown_to_the_studio_is_refused(client, studio):
    r = client.post("/answer?token=s3cret&studio_agent=ag_000000000000&peer=%2B919876543210")
    assert r.status_code == 400


def test_an_inbound_call_gets_the_agent_its_number_routes_to_in_the_studio(client, studio):
    r = client.post("/answer?token=s3cret", content="From=%2B919876543210&To=918065520552",
                    headers={"content-type": "application/x-www-form-urlencoded"})
    assert stream_call(r.text)["studio_agent"] == AGENT


def test_when_the_studio_is_down_the_call_still_rings_on_the_local_agents(client, studio):
    studio.fail = True
    store = agents_store.default_store()
    local = store.create_agent("Local", "", "You are Asha.")
    r = client.post(f"/answer?token=s3cret&studio_agent={local['id']}&peer=%2B919876543210")
    assert r.status_code == 200
    assert stream_call(r.text)["studio_agent"] == local["id"]


def test_the_stream_uses_the_config_the_answer_read_without_asking_again(client, studio,
                                                                       monkeypatch):
    seen = {}

    async def fake(websocket, secret, caller, persona_path, limit, agent_config=None):
        seen.update(agent_config=agent_config, limit=limit)
        await websocket.accept()
        await websocket.close()

    monkeypatch.setattr(server, "_run_call", fake)
    r = client.post(f"/answer?token=s3cret&studio_agent={AGENT}&peer=%2B919876543210")
    token = stream_token(r.text)
    asked = len(studio.requests)
    with client.websocket_connect(f"/ws?stream={token}"):
        pass
    assert seen["agent_config"]["prompt"] == "You are Riya."
    assert seen["limit"] == 120
    assert len(studio.requests) == asked  # nothing more on the way to the greeting


# --- what the call reports back --------------------------------------------------------


async def test_an_outcome_is_reported_and_a_failure_never_raises(studio):
    assert await studio_link.report_outcome("c8eea833-f765-449e-ba8e-e7554f8f1e21",
                                            {"status": "answered", "duration_secs": "42"}) is True
    assert studio.outcomes["c8eea833-f765-449e-ba8e-e7554f8f1e21"]["status"] == "answered"
    studio.fail = True
    assert await studio_link.report_outcome("c8eea833-f765-449e-ba8e-e7554f8f1e21", {}) is False


def test_a_hangup_is_reported_to_the_studio(client, studio):
    call_id = "c8eea833-f765-449e-ba8e-e7554f8f1e21"
    r = client.post("/hangup?token=s3cret&peer=%2B919876543210",
                    content=f"CallUUID={call_id}&RequestUUID={call_id}&CallStatus=completed"
                            "&HangupCauseName=NORMAL_CLEARING&BillDuration=42&Direction=outbound",
                    headers={"content-type": "application/x-www-form-urlencoded"})
    assert r.status_code == 200
    sent = studio.outcomes[call_id]
    assert sent["status"] == "answered" and sent["duration_secs"] == 42
    assert sent["peer"] == "+919876543210" and sent["request_uuid"] == call_id


async def test_transcript_lines_reach_the_studio_masked(studio, tmp_path: Path):
    sink = studio_link.EventSink("c8eea833-f765-449e-ba8e-e7554f8f1e21", interval=0.01)
    sink.start()
    t = CallTranscript("c8eea833-f765-449e-ba8e-e7554f8f1e21", tmp_path, sink=sink)
    t.user("My Aadhaar is 2345 6789 1234")
    t.assistant("Thank you.")
    t.end()
    await sink.close()
    sent = studio.events["c8eea833-f765-449e-ba8e-e7554f8f1e21"]
    assert [e["event"] for e in sent] == ["call_start", "turn", "turn", "call_end"]
    assert "2345 6789 1234" not in json.dumps(sent)  # masked before it left
    on_disk = [json.loads(line)["event"] for line in t.path.read_text().splitlines()]
    assert on_disk == ["call_start", "turn", "turn", "call_end"]  # the file is unchanged


async def test_a_studio_that_is_down_never_stops_the_transcript(studio, tmp_path: Path):
    studio.fail = True
    sink = studio_link.EventSink("c8eea833-f765-449e-ba8e-e7554f8f1e21", interval=0.01)
    sink.start()
    t = CallTranscript("c8eea833-f765-449e-ba8e-e7554f8f1e21", tmp_path, sink=sink)
    t.assistant("Hello.")
    await asyncio.sleep(0.05)
    t.end()
    await asyncio.wait_for(sink.close(), 3)  # bounded, however the Studio behaves
    assert len(t.path.read_text().splitlines()) == 3


async def test_lines_held_while_the_studio_was_down_are_sent_later(studio, tmp_path):
    studio.fail = True
    sink = studio_link.EventSink("c8eea833-f765-449e-ba8e-e7554f8f1e21", interval=0.01)
    sink.start()
    t = CallTranscript("c8eea833-f765-449e-ba8e-e7554f8f1e21", tmp_path, sink=sink)
    await asyncio.sleep(0.05)
    studio.fail = False
    t.end()
    await sink.close()
    sent = studio.events["c8eea833-f765-449e-ba8e-e7554f8f1e21"]
    assert [e["event"] for e in sent] == ["call_start", "call_end"]


def test_the_held_backlog_is_bounded():
    sink = studio_link.EventSink("c8eea833-f765-449e-ba8e-e7554f8f1e21")
    for i in range(studio_link.MAX_PENDING + 50):
        sink({"event": "live", "text": str(i)})
    assert len(sink._pending) == studio_link.MAX_PENDING

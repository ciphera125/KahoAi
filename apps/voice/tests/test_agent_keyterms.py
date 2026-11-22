"""The words an agent should listen for travel from the Studio to the call (2026-11-22).

studio_link._clean_config builds a fixed shape, so a field the Studio sends is dropped unless it
is named there; and the phone server has to hand it, with the organization and agent ids the
usage labels need, to the pipeline.
"""

import asyncio
import json

import studio_link
from fastapi.testclient import TestClient

BASE = {"agent_id": "ag_6d26dca7bd61", "org_id": "org_8f2a91c4d0e7", "name": "Ria", "prompt": "hi",
        "tools": [], "opening_line": None, "max_secs": 600.0, "ring_secs": 40, "version": 3}


def test_the_config_carries_the_agents_keyterms():
    out = studio_link._clean_config({**BASE, "keyterms": ["Dr. Mehta", "Apollo Clinic"]})
    assert out["keyterms"] == ["Dr. Mehta", "Apollo Clinic"]


def test_an_agent_with_no_keyterms_gets_an_empty_list():
    assert studio_link._clean_config(BASE)["keyterms"] == []
    assert studio_link._clean_config({**BASE, "keyterms": None})["keyterms"] == []


def test_junk_keyterms_are_cleaned_here_too_never_trusted_from_the_wire():
    out = studio_link._clean_config({**BASE, "keyterms": ["ok", "a,b", 5, {"x": 1}, "ok", "t:0.5"]})
    assert out["keyterms"] == ["ok"]
    assert studio_link._clean_config({**BASE, "keyterms": "not a list"})["keyterms"] == []
    assert studio_link._clean_config({**BASE, "keyterms": {"a": "b"}})["keyterms"] == []


def test_the_phone_server_hands_the_pipeline_the_words_and_the_ids(monkeypatch, tmp_path):
    import server
    from transcript import CallTranscript

    monkeypatch.setattr(server, "_prespoken_notice", None)
    monkeypatch.setattr(server, "_ws_limiter", None)
    monkeypatch.setenv("PLIVO_AUTH_ID", "MAID")
    monkeypatch.setenv("PLIVO_AUTH_TOKEN", "tok")
    monkeypatch.setenv("STUDIO_INTERNAL_URL", "http://127.0.0.1:8021")
    monkeypatch.setenv("STUDIO_INTERNAL_TOKEN", "t" * 40)
    seen = {}

    class Worker:
        def __init__(self):
            self.transcript = CallTranscript("C1", tmp_path)
            self.health = None

        async def cancel(self, reason=None):
            pass

    def fake_build_worker(transport, params=None, **kw):
        seen.update(kw)
        return Worker()

    class Runner:
        def __init__(self, **k):
            pass

        async def run(self, worker):
            return

    monkeypatch.setattr(server, "build_worker", fake_build_worker)
    monkeypatch.setattr(server, "WorkerRunner", Runner)
    config = studio_link._clean_config({**BASE, "keyterms": ["Dr. Mehta"]})
    token = server.issue_stream({"caller": None, "agent": None, "max_secs": None,
                                 "studio_agent": BASE["agent_id"], "agent_config": config})
    with TestClient(server.app).websocket_connect(f"/ws?stream={token}") as ws:
        ws.send_text(json.dumps({"event": "start", "start": {"streamId": "S1", "callId": "C1"}}))
        asyncio.run(asyncio.sleep(0.2))
    assert seen["keyterms"] == ["Dr. Mehta"]
    assert seen["org_id"] == "org_8f2a91c4d0e7"
    assert seen["agent_id"] == "ag_6d26dca7bd61"


def test_a_call_with_no_studio_agent_passes_nothing_and_still_runs(monkeypatch, tmp_path):
    import server
    from transcript import CallTranscript

    monkeypatch.setattr(server, "_prespoken_notice", None)
    monkeypatch.setattr(server, "_ws_limiter", None)
    monkeypatch.setenv("PLIVO_AUTH_ID", "MAID")
    monkeypatch.setenv("PLIVO_AUTH_TOKEN", "tok")
    seen = {}

    class Worker:
        def __init__(self):
            self.transcript = CallTranscript("C2", tmp_path)
            self.health = None

        async def cancel(self, reason=None):
            pass

    def fake_build_worker(transport, params=None, **kw):
        seen.update(kw)
        return Worker()

    monkeypatch.setattr(server, "build_worker", fake_build_worker)

    class Runner:
        def __init__(self, **k):
            pass

        async def run(self, worker):
            return

    monkeypatch.setattr(server, "WorkerRunner", Runner)
    token = server.issue_stream(
        {"caller": None, "agent": None, "max_secs": None, "studio_agent": None})
    with TestClient(server.app).websocket_connect(f"/ws?stream={token}") as ws:
        ws.send_text(json.dumps({"event": "start", "start": {"streamId": "S2", "callId": "C2"}}))
        asyncio.run(asyncio.sleep(0.2))
    assert seen["keyterms"] is None and seen["org_id"] is None and seen["agent_id"] is None

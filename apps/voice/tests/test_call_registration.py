"""A live call tells the Studio which agent it is on, as it starts (2026-11-22).

Before this the Studio learned a call's agent, and so its organization, only when the call
hung up. Every tool the Studio runs (tasks, documents, contact lookup, booking a meeting)
looks the organization up from the call, so on an inbound call each of them answered "I could
not do that just now" for as long as the call lasted. Calls the Studio dials itself already
had a record, which is why no real call showed it.
"""

import json
import time

import studio_link
from fastapi.testclient import TestClient
from transcript import CallTranscript

BASE = {"agent_id": "ag_6d26dca7bd61", "org_id": "org_8f2a91c4d0e7", "name": "Ria", "prompt": "hi",
        "tools": [], "opening_line": None, "max_secs": 600.0, "ring_secs": 40, "version": 3}


def run_a_call(monkeypatch, tmp_path, agent_config, report):
    import server

    monkeypatch.setattr(server, "_prespoken_notice", None)
    monkeypatch.setattr(server, "_ws_limiter", None)
    monkeypatch.setenv("PLIVO_AUTH_ID", "MAID")
    monkeypatch.setenv("PLIVO_AUTH_TOKEN", "tok")
    monkeypatch.setenv("STUDIO_INTERNAL_URL", "http://127.0.0.1:8021")
    monkeypatch.setenv("STUDIO_INTERNAL_TOKEN", "t" * 40)
    monkeypatch.setattr(studio_link, "report_outcome", report)

    class Worker:
        def __init__(self):
            self.transcript = CallTranscript("C1", tmp_path)
            self.health = None

        async def cancel(self, reason=None):
            pass

    class Runner:
        def __init__(self, **k):
            pass

        async def run(self, worker):
            import asyncio

            await asyncio.sleep(0.2)  # a call lasts longer than the moment it starts

    monkeypatch.setattr(server, "build_worker", lambda transport, params=None, **kw: Worker())
    monkeypatch.setattr(server, "WorkerRunner", Runner)
    token = server.issue_stream({"caller": None, "agent": None, "max_secs": None,
                                 "studio_agent": (agent_config or {}).get("agent_id"),
                                 "agent_config": agent_config})
    with TestClient(server.app).websocket_connect(f"/ws?stream={token}") as ws:
        ws.send_text(json.dumps({"event": "start", "start": {"streamId": "S1", "callId": "C1"}}))
        time.sleep(0.5)


def test_the_studio_is_told_the_agent_when_the_call_starts(monkeypatch, tmp_path):
    seen = []

    async def report(call_id, fields):
        seen.append((call_id, fields))
        return True

    run_a_call(monkeypatch, tmp_path, studio_link._clean_config(BASE), report)
    assert seen == [("C1", {"agent_id": "ag_6d26dca7bd61"})]


def test_a_call_with_no_studio_agent_tells_the_studio_nothing(monkeypatch, tmp_path):
    seen = []

    async def report(call_id, fields):
        seen.append((call_id, fields))
        return True

    run_a_call(monkeypatch, tmp_path, None, report)
    assert seen == []


def test_a_studio_that_cannot_be_reached_never_holds_up_the_call(monkeypatch, tmp_path):
    started = time.monotonic()

    async def report(call_id, fields):
        import asyncio

        await asyncio.sleep(30)  # a Studio that never answers
        return True

    run_a_call(monkeypatch, tmp_path, studio_link._clean_config(BASE), report)
    assert time.monotonic() - started < 5

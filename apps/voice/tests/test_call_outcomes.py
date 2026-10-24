"""How each call ended (picked up, declined, no answer, failed) and the dashboard built on it."""

import json
from datetime import UTC, datetime

import analytics
import call_outcomes
import pytest

ASHA = "+919876543210"
OURS = "+918065520552"


@pytest.mark.parametrize("status, cause, billed, expected", [
    ("completed", "Normal Hangup", 30, "answered"),
    ("ANSWER", "Normal Hangup", 5, "answered"),
    ("busy", "Busy Line", 0, "declined"),
    ("completed", "Rejected", 0, "declined"),
    ("no-answer", "No Answer", 0, "no_answer"),
    ("timeout", "", 0, "no_answer"),
    ("NO ANSWER", "Ring Timeout Reached", 0, "no_answer"),
    ("failed", "Unallocated Number", 0, "failed"),
    ("", "", 0, "failed"),
])
def test_classify(status, cause, billed, expected):
    assert call_outcomes.classify(status, cause, billed) == expected


@pytest.fixture
def log(tmp_path):
    return call_outcomes.OutcomeLog(tmp_path / "outcomes.jsonl")


def test_the_latest_line_for_a_call_wins(log):
    log.record("abc123", status="ringing", peer=ASHA, ours=OURS, direction="outbound",
               agent_id="ag_000000000001", at="2026-10-24T10:00:00+00:00")
    log.record("abc123", status="no_answer", cause="No Answer")
    out = log.all()["abc123"]
    assert out["status"] == "no_answer" and out["peer"] == ASHA
    assert out["agent_id"] == "ag_000000000001"


@pytest.mark.parametrize("call_id", ["../x", "", "a" * 100, "a b c d e f"])
def test_bad_ids_are_not_written(log, call_id):
    with pytest.raises(ValueError):
        log.record(call_id, status="answered")


def test_unknown_fields_and_statuses_are_dropped(log):
    log.record("abc123", status="pwned", evil="x" * 100)
    row = log.all()["abc123"]
    assert "evil" not in row and row["status"] == "failed"


def test_cdr_import_classifies_plivo_records():
    cdr = {"call_uuid": "11111111-2222-3333-4444-555555555555", "call_direction": "outbound",
           "from_number": "918065520552", "to_number": "919876543210",
           "hangup_cause_name": "Busy Line", "call_state": "BUSY", "bill_duration": 0,
           "initiation_time": "2026-10-24 10:19:37+00:00", "total_amount": "0.00000"}
    row = call_outcomes.from_cdr(cdr, OURS)
    assert row == {**row, "status": "declined", "peer": ASHA, "direction": "outbound",
                   "at": "2026-10-24T10:19:37+00:00"}


# --- the dashboard --------------------------------------------------------------


def transcript(dir_, call_id, peer, start, end, caller_turns=2, lead=False):
    rows = [{"event": "call_start", "at": start},
            {"event": "call_party", "number": peer, "at": start}]
    for i in range(caller_turns):
        rows += [{"event": "turn", "role": "assistant", "text": "Hi", "at": start},
                 {"event": "turn", "role": "user", "text": f"reply {i}", "at": start}]
    if lead:
        rows.append({"event": "tool", "name": "capture_lead",
                     "text": json.dumps({"args": {}, "result": {"saved": True}}), "at": start})
    rows.append({"event": "call_end", "at": end})
    (dir_ / f"{call_id}.jsonl").write_text("".join(json.dumps(r) + "\n" for r in rows))


@pytest.fixture
def calls(tmp_path, log):
    d = tmp_path / "calls"
    d.mkdir()
    transcript(d, "call0001", ASHA, "2026-10-24T05:00:00+00:00", "2026-10-24T05:02:00+00:00",
               lead=True)
    transcript(d, "call0002", ASHA, "2026-10-24T06:00:00+00:00", "2026-10-24T06:00:40+00:00",
               caller_turns=0)
    log.record("call0001", status="answered", peer=ASHA, direction="outbound",
               at="2026-10-24T05:00:00+00:00", agent_id="ag_000000000001")
    log.record("call0003", status="no_answer", peer="+919000000001", direction="outbound",
               at="2026-10-23T05:00:00+00:00")
    log.record("call0004", status="declined", peer="+919000000002", direction="outbound",
               at="2026-10-23T09:00:00+00:00")
    return analytics.all_calls(d, log.all(), {})


def test_all_calls_joins_outcomes_and_transcripts(calls):
    by_id = {c["call_id"]: c for c in calls}
    assert set(by_id) == {"call0001", "call0002", "call0003", "call0004"}
    assert by_id["call0002"]["status"] == "answered"  # a transcript means it was picked up
    assert by_id["call0001"]["lead"] is True and by_id["call0001"]["successful"] is True
    assert by_id["call0002"]["successful"] is False  # picked up, never talked back
    assert by_id["call0001"]["duration_secs"] == 120


def test_dashboard_numbers(calls):
    now = datetime(2026, 10, 24, 12, 0, tzinfo=UTC)
    d = analytics.dashboard(calls, now=now, days=7)
    t = d["totals"]
    assert t["calls"] == 4 and t["answered"] == 2 and t["no_answer"] == 1 and t["declined"] == 1
    assert t["successful"] == 1 and t["leads"] == 1
    assert d["rates"]["answer"] == 50.0 and d["rates"]["success"] == 25.0
    assert d["talk"]["avg_secs"] == 80 and d["talk"]["total_minutes"] == 2.7
    assert len(d["by_day"]) == 7 and d["by_day"][-1]["answered"] == 2
    assert sum(h["calls"] for h in d["by_hour"]) == 4
    assert d["by_agent"][0]["agent_id"] == "ag_000000000001"


def test_the_window_leaves_older_calls_out(calls):
    now = datetime(2026, 11, 30, tzinfo=UTC)
    assert analytics.dashboard(calls, now=now, days=7)["totals"]["calls"] == 0


def test_contact_history_and_last_call(calls):
    page = analytics.calls_for([ASHA], calls, page=1, per_page=10)
    assert [c["call_id"] for c in page["calls"]] == ["call0002", "call0001"]
    last = analytics.last_calls(calls)
    assert last[ASHA]["call_id"] == "call0002"
    with pytest.raises(ValueError):
        analytics.calls_for([ASHA], calls, 1, 13)


class FakeResponse:
    def __init__(self, status, body):
        self.status_code, self._body = status, body

    def json(self):
        return self._body


def test_sync_reads_plivos_records_page_by_page(log, monkeypatch):
    pages = {0: {"meta": {"next": "/next"}, "objects": [
                 {"call_uuid": "aaaaaa-1", "call_direction": "outbound",
                  "from_number": "918065520552", "to_number": "919876543210",
                  "call_state": "NO ANSWER", "hangup_cause_name": "No Answer",
                  "bill_duration": 0, "initiation_time": "2026-10-24 10:00:00+00:00"}]},
             20: {"meta": {"next": None}, "objects": [
                 {"call_uuid": "bbbbbb-2", "call_direction": "outbound",
                  "from_number": "918065520552", "to_number": "919876543210",
                  "call_state": "ANSWER", "hangup_cause_name": "Normal Hangup",
                  "bill_duration": 30, "initiation_time": "2026-10-24 11:00:00+00:00"}]}}
    seen = []

    def get(url, params, auth, timeout):
        seen.append(params["offset"])
        return FakeResponse(200, pages[params["offset"]])

    monkeypatch.setattr(call_outcomes.httpx, "get", get)
    assert call_outcomes.sync_from_plivo(log, "MA1", "tok", OURS) == 2
    assert seen == [0, 20]
    assert log.all()["aaaaaa-1"]["status"] == "no_answer"


def test_sync_reports_a_refusal_without_the_token(log, monkeypatch):
    monkeypatch.setattr(call_outcomes.httpx, "get",
                        lambda *a, **k: FakeResponse(401, {"error": "tok bad"}))
    with pytest.raises(RuntimeError) as e:
        call_outcomes.sync_from_plivo(log, "MA1", "tok", OURS)
    assert "tok" not in str(e.value).replace("Plivo", "")


def test_the_outcome_file_is_private_to_its_owner(log):
    log.record("abc123", status="answered", peer=ASHA)
    assert log.path.stat().st_mode & 0o077 == 0


def test_an_existing_readable_file_is_made_private(log):
    log.path.write_text("", encoding="utf-8")
    log.path.chmod(0o644)
    log.record("abc123", status="answered")
    assert log.path.stat().st_mode & 0o077 == 0

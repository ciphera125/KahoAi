"""Every call in one list, and the dashboard's numbers built from it.

A call is known from its outcome line (call_outcomes.py), its transcript
(logs/calls/<id>.jsonl, only for calls that were picked up), or both. A call is
*successful* when it was picked up and the person really talked: at least two
turns of their own, or a lead saved. Days and hours are India time.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

from call_history import PAGE_SIZES, describe

IST = ZoneInfo("Asia/Kolkata")
SUCCESS_MIN_CALLER_TURNS = 2
RINGING_STALE_SECS = 15 * 60  # a "ringing" line with no outcome after this is unknown


def _rows(path: Path):
    for line in path.read_text(encoding="utf-8").splitlines():
        try:
            yield json.loads(line)
        except json.JSONDecodeError:
            continue


def _engagement(path: Path) -> tuple[int, bool]:
    caller_turns, lead = 0, False
    for row in _rows(path):
        if row.get("event") == "turn" and row.get("role") == "user":
            caller_turns += 1
        elif row.get("event") == "tool" and row.get("name") == "capture_lead":
            try:
                lead = lead or "error" not in json.loads(row.get("text") or "{}").get("result", {})
            except (json.JSONDecodeError, AttributeError):
                pass
    return caller_turns, lead


def _when(value) -> datetime | None:
    try:
        when = datetime.fromisoformat(str(value))
    except (TypeError, ValueError):
        return None
    return when if when.tzinfo else when.replace(tzinfo=UTC)


def all_calls(calls_dir: Path, outcomes: dict, index: dict, now: datetime | None = None) -> list:
    """Every call we know of, newest first."""
    now = now or datetime.now(UTC)
    calls: dict[str, dict] = {}
    if Path(calls_dir).exists():
        for path in Path(calls_dir).glob("*.jsonl"):
            info = describe(path, index)
            caller_turns, lead = _engagement(path)
            info.update(status="answered", caller_turns=caller_turns, lead=lead, agent_id=None,
                        cause=None, cost=None, has_transcript=True)
            calls[info["call_id"]] = info
    for call_id, out in outcomes.items():
        info = calls.get(call_id) or {
            "call_id": call_id, "peer": None, "direction": None, "started_at": None,
            "duration_secs": None, "turns": 0, "summary": None, "caller_turns": 0,
            "lead": False, "has_transcript": False}
        status = out.get("status") or "failed"
        if info.get("has_transcript"):
            status = "answered"  # a transcript is proof it was picked up
        elif status == "ringing":
            started = _when(out.get("at"))
            if started and (now - started).total_seconds() > RINGING_STALE_SECS:
                status = "unknown"
        info.update(status=status, cause=out.get("cause"), cost=out.get("cost"),
                    agent_id=out.get("agent_id"))
        info["peer"] = info.get("peer") or out.get("peer")
        info["direction"] = info.get("direction") or out.get("direction")
        info["started_at"] = info.get("started_at") or out.get("at")
        if info.get("duration_secs") is None and out.get("duration_secs") is not None:
            info["duration_secs"] = round(out["duration_secs"])
        calls[call_id] = info
    for info in calls.values():
        info["successful"] = info["status"] == "answered" and (
            info.get("caller_turns", 0) >= SUCCESS_MIN_CALLER_TURNS or bool(info.get("lead")))
    return sorted(calls.values(), key=lambda c: c.get("started_at") or "", reverse=True)


def _pct(part: int, whole: int) -> float:
    return round(100 * part / whole, 1) if whole else 0.0


def dashboard(calls: list, now: datetime | None = None, days: int = 30,
              agent_names: dict | None = None) -> dict:
    now = now or datetime.now(UTC)
    today = now.astimezone(IST).date()
    first_day = today - timedelta(days=days - 1)
    window = []
    for c in calls:
        when = _when(c.get("started_at"))
        if when and when.astimezone(IST).date() >= first_day:
            window.append((c, when.astimezone(IST)))
    count = lambda status: sum(1 for c, _ in window if c["status"] == status)  # noqa: E731
    answered = [c for c, _ in window if c["status"] == "answered"]
    talk = [c["duration_secs"] for c in answered if c.get("duration_secs") is not None]
    totals = {"calls": len(window), "answered": len(answered), "declined": count("declined"),
              "no_answer": count("no_answer"), "failed": count("failed"),
              "ringing": count("ringing") + count("unknown"),
              "successful": sum(1 for c, _ in window if c["successful"]),
              "leads": sum(1 for c, _ in window if c.get("lead")),
              "outbound": sum(1 for c, _ in window if c.get("direction") != "inbound"),
              "inbound": sum(1 for c, _ in window if c.get("direction") == "inbound"),
              "people": len({c["peer"] for c, _ in window if c.get("peer")})}
    finished = totals["calls"] - totals["ringing"]
    by_day = []
    for i in range(days):
        day = first_day + timedelta(days=i)
        on = [c for c, w in window if w.date() == day]
        by_day.append({"date": day.isoformat(), "calls": len(on),
                       "answered": sum(1 for c in on if c["status"] == "answered"),
                       "successful": sum(1 for c in on if c["successful"])})
    by_hour = []
    for hour in range(24):
        at = [c for c, w in window if w.hour == hour]
        picked = sum(1 for c in at if c["status"] == "answered")
        by_hour.append({"hour": hour, "calls": len(at), "answered": picked,
                        "answer_rate": _pct(picked, len(at))})
    agents: dict[str, dict] = {}
    for c, _ in window:
        if c.get("agent_id"):
            a = agents.setdefault(c["agent_id"], {"agent_id": c["agent_id"], "calls": 0,
                                                  "answered": 0, "successful": 0})
            a["calls"] += 1
            a["answered"] += c["status"] == "answered"
            a["successful"] += bool(c["successful"])
    names = agent_names or {}
    by_agent = sorted(({**a, "name": names.get(a["agent_id"]),
                        "success_rate": _pct(a["successful"], a["calls"])}
                       for a in agents.values()), key=lambda a: -a["calls"])
    cost = sum(c.get("cost") or 0 for c, _ in window)
    return {
        "days": days, "totals": totals,
        "rates": {"answer": _pct(totals["answered"], finished),
                  "success": _pct(totals["successful"], finished),
                  "conversion": _pct(totals["successful"], totals["answered"])},
        "talk": {"avg_secs": round(sum(talk) / len(talk)) if talk else 0,
                 "total_minutes": round(sum(talk) / 60, 1)},
        "cost": round(cost, 2),
        "by_day": by_day, "by_hour": by_hour, "by_agent": by_agent,
        "best_hour": max((h for h in by_hour if h["calls"] >= 2),
                         key=lambda h: (h["answer_rate"], h["calls"]), default=None),
        "recent": [{**c, "agent_name": names.get(c.get("agent_id"))}
                   for c, _ in window[:8]],
    }


def calls_for(numbers: list[str], calls: list, page: int, per_page: int) -> dict:
    if per_page not in PAGE_SIZES:
        raise ValueError(f"per_page must be one of {', '.join(map(str, PAGE_SIZES))}")
    wanted = set(numbers)
    mine = [c for c in calls if c.get("peer") in wanted]
    page = max(1, page)
    start = (page - 1) * per_page
    return {"total": len(mine), "page": page, "per_page": per_page,
            "calls": mine[start:start + per_page]}


def last_calls(calls: list) -> dict[str, dict]:
    """The newest call with each number (calls come newest first)."""
    last: dict[str, dict] = {}
    for c in calls:
        if c.get("peer") and c["peer"] not in last:
            last[c["peer"]] = c
    return last

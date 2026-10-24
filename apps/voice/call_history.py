"""Calls with a given person, read from the call transcripts, and a transcript as CSV.

Each transcript names the other party in a `call_party` line (written since
2026-10-24). Older calls are looked up in an index built once from Plivo's own
call records (scripts/backfill_call_index.py). Transcripts are already masked, so
nothing here can show more than they hold.
"""

import csv
import io
import json
from datetime import datetime
from pathlib import Path

PAGE_SIZES = (10, 20, 25, 50)
SPEAKERS = {"assistant": "Agent", "user": "Caller"}


def _rows(path: Path):
    for line in path.read_text(encoding="utf-8").splitlines():
        try:
            yield json.loads(line)
        except json.JSONDecodeError:
            continue


def _when(value):
    try:
        return datetime.fromisoformat(value)
    except (TypeError, ValueError):
        return None


def describe(path: Path, index: dict | None = None) -> dict:
    call_id = path.stem
    info = {"call_id": call_id, "peer": None, "direction": None, "started_at": None,
            "duration_secs": None, "turns": 0, "summary": None}
    started = ended = None
    for row in _rows(path):
        event = row.get("event")
        if event == "call_start":
            started = _when(row.get("at"))
        elif event == "call_party":
            info["peer"] = row.get("number")
            info["direction"] = row.get("direction")
        elif event == "turn":
            info["turns"] += 1
        elif event == "call_end":
            ended = _when(row.get("at"))
    known = (index or {}).get(call_id) or {}
    info["peer"] = info["peer"] or known.get("peer")
    info["direction"] = info["direction"] or known.get("direction")
    if started:
        info["started_at"] = started.isoformat()
    if started and ended:
        info["duration_secs"] = round((ended - started).total_seconds())
    summary = path.with_name(f"{call_id}.summary.json")
    if summary.exists():
        try:
            info["summary"] = json.loads(summary.read_text(encoding="utf-8")).get("summary")
        except (json.JSONDecodeError, OSError):
            pass
    return info


def calls_for(numbers: list[str], calls_dir: Path, page: int, per_page: int,
              index: dict | None = None) -> dict:
    """One page of the calls with any of `numbers`, newest first."""
    if per_page not in PAGE_SIZES:
        raise ValueError(f"per_page must be one of {', '.join(map(str, PAGE_SIZES))}")
    wanted = set(numbers)
    calls = []
    if Path(calls_dir).exists():
        for path in Path(calls_dir).glob("*.jsonl"):
            info = describe(path, index)
            if info["peer"] in wanted:
                calls.append(info)
    calls.sort(key=lambda c: c["started_at"] or "", reverse=True)
    page = max(1, page)
    start = (page - 1) * per_page
    return {"total": len(calls), "page": page, "per_page": per_page,
            "calls": calls[start:start + per_page]}


def _cell(text: str) -> str:
    # A spreadsheet runs a cell that starts like a formula; a caller's words must not.
    return "'" + text if text[:1] in ("=", "+", "-", "@", "\t", "\r") else text


def turns(path: Path) -> list[dict]:
    return [{"at": r.get("at"), "role": "agent" if r.get("role") == "assistant" else "caller",
             "text": r.get("text", "")} for r in _rows(path) if r.get("event") == "turn"]


def transcript_csv(path: Path) -> str:
    out = io.StringIO()
    writer = csv.writer(out)
    writer.writerow(["time", "speaker", "text"])
    for row in _rows(path):
        if row.get("event") == "turn":
            writer.writerow([row.get("at", ""), SPEAKERS.get(row.get("role"), row.get("role")),
                             _cell(row.get("text", ""))])
    return out.getvalue()

"""How each call ended: picked up, declined, no answer, or failed.

A transcript exists only for a call that was picked up, so this is the one record
of the calls that were not. Lines come from three places: the Studio when it
dials ("ringing"), Plivo's hangup callback to the phone server, and Plivo's own
call records (scripts/backfill_call_index.py --outcomes). The latest line for a
call wins, field by field.

Append-only JSON lines (data/call_outcomes.jsonl, gitignored), written by two
processes (the Studio and the phone server), so each write is one short append.
"""

from __future__ import annotations

import json
import os
import re
import threading
from datetime import datetime
from pathlib import Path

import httpx
from prompt_store import normalize_number

DEFAULT_PATH = Path(__file__).resolve().parent.parent.parent / "data" / "call_outcomes.jsonl"
CALL_ID = re.compile(r"^[A-Za-z0-9-]{6,64}$")
STATUSES = ("ringing", "answered", "declined", "no_answer", "failed")
FIELDS = {"status", "cause", "peer", "ours", "direction", "agent_id", "at", "duration_secs",
          "cost", "request_uuid"}
_lock = threading.Lock()


def classify(status: str | None, cause: str | None, billed_secs=0) -> str:
    """Plivo's CallStatus (or a call record's call_state) and hangup cause, as one of
    answered, declined, no_answer or failed."""
    s = (status or "").strip().lower().replace("_", "-")
    c = (cause or "").strip().lower()
    try:
        billed = float(billed_secs or 0)
    except (TypeError, ValueError):
        billed = 0
    if "reject" in c or "declin" in c or "busy" in c or s == "busy":
        return "declined"
    if billed > 0 or s in ("answer", "answered", "in-progress"):
        return "answered"
    if s == "completed":  # Plivo's word for any call that ended; the cause says how
        return "answered" if not c or "normal" in c else "failed"
    if s in ("no-answer", "no answer", "timeout", "cancel", "canceled", "cancelled") \
            or "no answer" in c or "timeout" in c or "not answered" in c:
        return "no_answer"
    return "failed"


def _clean(fields: dict) -> dict:
    out = {}
    for key, value in fields.items():
        if key not in FIELDS or value is None or value == "":
            continue
        if key == "status":
            value = value if value in STATUSES else "failed"
        elif key in ("peer", "ours"):
            try:
                value = normalize_number(str(value))
            except ValueError:
                continue
        elif key == "direction":
            value = "inbound" if str(value).lower().startswith("in") else "outbound"
        elif key in ("duration_secs", "cost"):
            try:
                value = round(float(value), 4)
            except (TypeError, ValueError):
                continue
        elif key == "request_uuid":
            if not CALL_ID.match(str(value)):
                continue
        elif key == "agent_id":
            if not re.match(r"^ag_[0-9a-f]{12}$", str(value)):
                continue
        else:
            value = str(value)[:80]
        out[key] = value
    return out


class OutcomeLog:
    def __init__(self, path: Path):
        self.path = Path(path)

    def record(self, call_id: str, **fields) -> None:
        if not isinstance(call_id, str) or not CALL_ID.match(call_id):
            raise ValueError("not a call id")
        row = {"call_id": call_id, **_clean(fields)}
        with _lock:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            with self.path.open("a", encoding="utf-8") as f:
                f.write(json.dumps(row, ensure_ascii=False) + "\n")

    def all(self) -> dict[str, dict]:
        out: dict[str, dict] = {}
        if not self.path.exists():
            return out
        for line in self.path.read_text(encoding="utf-8").splitlines():
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue
            call_id = row.get("call_id")
            if isinstance(call_id, str) and CALL_ID.match(call_id):
                out.setdefault(call_id, {}).update(row)
        return out


def _iso(raw: str | None) -> str | None:
    try:
        return datetime.fromisoformat(str(raw).replace(" ", "T", 1)).isoformat()
    except (TypeError, ValueError):
        return None


def from_cdr(cdr: dict, ours: str | None) -> dict:
    """One of Plivo's call records as outcome fields."""
    numbers = []
    for key in ("from_number", "to_number"):
        try:
            numbers.append(normalize_number(str(cdr.get(key) or "")))
        except ValueError:
            numbers.append(None)
    direction = "inbound" if str(cdr.get("call_direction")).lower() == "inbound" else "outbound"
    peer = numbers[0] if direction == "inbound" else numbers[1]
    if peer == ours:
        peer = next((n for n in numbers if n and n != ours), None)
    return _clean({
        "status": classify(cdr.get("call_state"), cdr.get("hangup_cause_name"),
                           cdr.get("bill_duration")),
        "cause": cdr.get("hangup_cause_name"), "peer": peer, "ours": ours,
        "direction": direction, "at": _iso(cdr.get("initiation_time")),
        "duration_secs": cdr.get("bill_duration"), "cost": cdr.get("total_amount")})


def default_log() -> OutcomeLog:
    return OutcomeLog(Path(os.getenv("OUTCOME_LOG_PATH") or DEFAULT_PATH))


SYNC_PAGE = 20
SYNC_MAX_PAGES = 25  # 500 calls: Plivo keeps only recent records in its list anyway
SYNC_TIMEOUT = httpx.Timeout(10.0, connect=5.0)


def sync_from_plivo(log: OutcomeLog, auth_id: str, auth_token: str, ours: str | None) -> int:
    """Copy how each recent call ended from Plivo's call records. Read-only at
    Plivo; one request per page, each with a deadline. Returns calls recorded."""
    url = f"https://api.plivo.com/v1/Account/{auth_id}/Call/"
    recorded = 0
    for page in range(SYNC_MAX_PAGES):
        try:
            r = httpx.get(url, params={"limit": SYNC_PAGE, "offset": page * SYNC_PAGE},
                          auth=(auth_id, auth_token), timeout=SYNC_TIMEOUT)
        except httpx.HTTPError as e:
            raise RuntimeError(f"Could not reach Plivo ({type(e).__name__})") from e
        if r.status_code != 200:
            raise RuntimeError(f"Plivo answered HTTP {r.status_code}")
        body = r.json()
        for cdr in body.get("objects") or []:
            call_id = str(cdr.get("call_uuid") or "")
            if CALL_ID.match(call_id):
                log.record(call_id, **from_cdr(cdr, ours))
                recorded += 1
        if not (body.get("meta") or {}).get("next"):
            break
    return recorded

"""Find the other party for calls recorded before transcripts named it.

Since 2026-10-24 every transcript has a `call_party` line. For older calls this
asks Plivo's call record (one request per call, a timeout each, a failure skips
that call) and writes data/call_index.json, which the Studio's call history
reads. Safe to run again: calls already in the index are not asked about.

Run: python scripts/backfill_call_index.py
"""

import json
import os
import sys
from pathlib import Path

import httpx
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "apps" / "voice"))
from prompt_store import normalize_number, write_json_atomic  # noqa: E402

CDR_URL = "https://api.plivo.com/v1/Account/{auth_id}/Call/{call_id}/"
TIMEOUT = httpx.Timeout(10.0, connect=5.0)


def has_party(path: Path) -> bool:
    for line in path.read_text(encoding="utf-8").splitlines():
        try:
            if json.loads(line).get("event") == "call_party":
                return True
        except json.JSONDecodeError:
            continue
    return False


def build(calls_dir: Path, index: dict, auth_id: str, auth_token: str, ours: str) -> dict:
    index = dict(index)
    for path in sorted(Path(calls_dir).glob("*.jsonl")):
        call_id = path.stem
        if call_id in index or call_id.startswith("local-") or has_party(path):
            continue
        try:
            r = httpx.get(CDR_URL.format(auth_id=auth_id, call_id=call_id),
                          auth=(auth_id, auth_token), timeout=TIMEOUT)
        except httpx.HTTPError as e:
            print(f"  {call_id}: skipped ({type(e).__name__})")
            continue
        if r.status_code != 200:
            print(f"  {call_id}: skipped (HTTP {r.status_code})")
            continue
        cdr = r.json()
        try:
            numbers = [normalize_number(cdr.get("from_number") or ""),
                       normalize_number(cdr.get("to_number") or "")]
        except ValueError:
            continue
        peer = next((n for n in numbers if n != ours), None)
        if peer:
            index[call_id] = {"peer": peer, "direction": cdr.get("call_direction")}
            print(f"  {call_id}: {peer}")
    return index


def main() -> int:
    load_dotenv(ROOT / ".env")
    sys.path.insert(0, str(ROOT / "apps" / "voice"))
    from numbers_store import plivo_credentials

    auth_id, auth_token = plivo_credentials()
    ours = normalize_number(os.getenv("PLIVO_FROM_NUMBER") or "")
    calls_dir = Path(os.getenv("CALL_LOG_DIR") or ROOT / "logs" / "calls")
    path = Path(os.getenv("CALL_INDEX_PATH") or ROOT / "data" / "call_index.json")
    known = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
    index = build(calls_dir, known, auth_id, auth_token, ours)
    write_json_atomic(path, index)
    print(f"{len(index)} calls indexed -> {path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

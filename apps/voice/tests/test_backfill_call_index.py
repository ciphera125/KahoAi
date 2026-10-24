import importlib.util
import json
from pathlib import Path

import httpx

SCRIPT = Path(__file__).resolve().parents[3] / "scripts" / "backfill_call_index.py"
spec = importlib.util.spec_from_file_location("kaho_backfill", SCRIPT)
backfill = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backfill)
OURS = "+918065520552"


def transcript(dir_, call_id, party=None):
    rows = [{"event": "call_start"}] + ([{"event": "call_party", "number": party}] if party else [])
    (dir_ / f"{call_id}.jsonl").write_text("".join(json.dumps(r) + "\n" for r in rows))


def test_looks_up_only_calls_without_a_party_and_keeps_the_other_side(tmp_path, monkeypatch):
    transcript(tmp_path, "out-1")
    transcript(tmp_path, "in-2")
    transcript(tmp_path, "has-3", party="+911111111111")
    asked = []

    def get(url, auth, timeout):
        asked.append(url.rstrip("/").rsplit("/", 1)[-1])
        cdr = {"out-1": {"from_number": "918065520552", "to_number": "919876543210",
                         "call_direction": "outbound"},
               "in-2": {"from_number": "919000000001", "to_number": "918065520552",
                        "call_direction": "inbound"}}
        return httpx.Response(200, json=cdr[asked[-1]], request=httpx.Request("GET", url))

    monkeypatch.setattr(backfill.httpx, "get", get)
    index = backfill.build(tmp_path, {}, "MAID", "tok", OURS)
    assert sorted(asked) == ["in-2", "out-1"]
    assert index == {"out-1": {"peer": "+919876543210", "direction": "outbound"},
                     "in-2": {"peer": "+919000000001", "direction": "inbound"}}


def test_a_failed_lookup_is_skipped_not_fatal_and_known_calls_are_not_asked_again(tmp_path,
                                                                                  monkeypatch):
    transcript(tmp_path, "gone-1")
    transcript(tmp_path, "known-2")

    def get(url, auth, timeout):
        raise httpx.ConnectTimeout("slow")

    monkeypatch.setattr(backfill.httpx, "get", get)
    known = {"known-2": {"peer": "+91999", "direction": "outbound"}}
    assert backfill.build(tmp_path, known, "MAID", "tok", OURS) == known

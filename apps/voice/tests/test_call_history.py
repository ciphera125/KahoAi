"""Calls per contact, day by day, and transcripts as CSV."""

import csv
import io
import json

import call_history
import pytest

ASHA = "+919876543210"


def write(dir_, call_id, rows):
    (dir_ / f"{call_id}.jsonl").write_text("".join(json.dumps(r) + "\n" for r in rows),
                                            encoding="utf-8")


def call(dir_, call_id, peer, start, end, text="Hello", summary=None):
    rows = [{"event": "call_start", "at": start}]
    if peer:
        rows.append({"event": "call_party", "number": peer, "at": start})
    rows += [{"event": "turn", "role": "assistant", "text": text, "at": start},
             {"event": "live", "role": "agent", "text": "ignored", "at": start},
             {"event": "call_end", "at": end}]
    write(dir_, call_id, rows)
    if summary:
        (dir_ / f"{call_id}.summary.json").write_text(json.dumps({"summary": summary}))


def test_calls_for_a_contact_newest_first_with_duration_and_summary(tmp_path):
    call(tmp_path, "aaa111", ASHA, "2026-10-23T10:00:00+00:00", "2026-10-23T10:02:05+00:00",
         summary="Asked about timings.")
    call(tmp_path, "bbb222", ASHA, "2026-10-24T09:00:00+00:00", "2026-10-24T09:00:30+00:00")
    call(tmp_path, "ccc333", "+919000000001", "2026-10-24T11:00:00+00:00",
         "2026-10-24T11:01:00+00:00")
    page = call_history.calls_for([ASHA], tmp_path, page=1, per_page=10)
    assert page["total"] == 2
    assert [c["call_id"] for c in page["calls"]] == ["bbb222", "aaa111"]
    assert page["calls"][1]["duration_secs"] == 125
    assert page["calls"][1]["summary"] == "Asked about timings."


def test_an_index_supplies_the_number_for_older_calls(tmp_path):
    call(tmp_path, "old999", None, "2026-10-15T10:00:00+00:00", "2026-10-15T10:01:00+00:00")
    assert call_history.calls_for([ASHA], tmp_path, 1, 10)["total"] == 0
    index = {"old999": {"peer": ASHA, "direction": "outbound"}}
    assert call_history.calls_for([ASHA], tmp_path, 1, 10, index=index)["total"] == 1


@pytest.mark.parametrize("per_page", [10, 20, 25, 50])
def test_pages(tmp_path, per_page):
    for i in range(60):
        call(tmp_path, f"call{i:03d}", ASHA, f"2026-10-24T10:{i:02d}:00+00:00",
             f"2026-10-24T10:{i:02d}:30+00:00")
    first = call_history.calls_for([ASHA], tmp_path, 1, per_page)
    last = call_history.calls_for([ASHA], tmp_path, -(-60 // per_page), per_page)
    assert len(first["calls"]) == per_page and first["total"] == 60
    assert len(last["calls"]) == 60 - per_page * (-(-60 // per_page) - 1)


def test_a_page_size_off_the_list_is_refused(tmp_path):
    with pytest.raises(ValueError):
        call_history.calls_for([ASHA], tmp_path, 1, 13)


def test_transcript_csv_has_turns_only_and_cannot_run_formulas(tmp_path):
    write(tmp_path, "csv001", [
        {"event": "call_start", "at": "2026-10-24T09:00:00+00:00"},
        {"event": "turn", "role": "assistant", "text": "Hello", "at": "2026-10-24T09:00:01+00:00"},
        {"event": "live", "role": "caller", "text": "=HYPERLINK(\"x\")", "at": "x"},
        {"event": "turn", "role": "user", "text": "=HYPERLINK(\"evil\")",
         "at": "2026-10-24T09:00:03+00:00"},
    ])
    rows = list(csv.reader(io.StringIO(call_history.transcript_csv(tmp_path / "csv001.jsonl"))))
    assert rows[0] == ["time", "speaker", "text"]
    assert [r[1] for r in rows[1:]] == ["Agent", "Caller"]
    assert rows[2][2] == "'=HYPERLINK(\"evil\")"


def test_a_corrupt_transcript_line_is_skipped(tmp_path):
    (tmp_path / "bad001.jsonl").write_text('{"event": "call_party", "number": "%s"}\nnot json\n'
                                           % ASHA, encoding="utf-8")
    assert call_history.calls_for([ASHA], tmp_path, 1, 10)["total"] == 1

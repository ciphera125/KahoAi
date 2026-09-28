import json

from transcript import CallTranscript


def lines(path):
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]


def test_turns_are_written_in_order_with_call_markers(tmp_path):
    t = CallTranscript("call-1", tmp_path)
    t.user("hello")
    t.assistant("Hi, I'm Kaho.", interrupted=True)
    t.end()
    rows = lines(t.path)
    assert [r["event"] for r in rows] == ["call_start", "turn", "turn", "call_end"]
    assert rows[1]["role"] == "user" and rows[1]["text"] == "hello"
    assert rows[2]["interrupted"] is True


def test_aadhaar_and_pan_never_reach_the_file(tmp_path):
    t = CallTranscript("call-2", tmp_path)
    t.user("my aadhaar is 2345 6789 1234 and pan ABCDE1234F")
    t.assistant("Thanks, I have 234567891234 noted.")
    t.end()
    raw = t.path.read_text(encoding="utf-8")
    for secret in ("2345 6789", "234567891234", "ABCDE"):
        assert secret not in raw
    assert "XXXX XXXX 1234" in raw and "XXXXXX234F" in raw


def test_blank_turns_are_skipped(tmp_path):
    t = CallTranscript("call-3", tmp_path)
    t.user("   ")
    t.assistant("")
    assert [r["event"] for r in lines(t.path)] == ["call_start"]


def test_end_is_written_once(tmp_path):
    t = CallTranscript("call-4", tmp_path)
    t.end()
    t.end()
    assert [r["event"] for r in lines(t.path)].count("call_end") == 1


def test_hostile_call_id_cannot_escape_the_directory(tmp_path):
    t = CallTranscript("../../etc/passwd", tmp_path)
    assert t.path.parent == tmp_path
    assert t.path.exists()


def test_aadhaar_split_across_turns_is_masked_as_one(tmp_path):
    """Seen live: STT ended a turn at every pause while a number was read out."""
    t = CallTranscript("call-5", tmp_path)
    t.assistant("Hi, I'm Kaho.")
    t.user("My Aadhar number is 2 3 4")
    t.user("5 6 7")
    t.assistant("Keep going, just six more digits.", interrupted=True)
    t.user("8 9 1")
    t.user("2 3 4,")
    t.user("Can you note that down?")
    raw = t.path.read_text(encoding="utf-8")
    for piece in ("2 3 4", "5 6 7", "8 9 1"):
        assert piece not in raw
    assert "XXXX XXXX 1234" in raw
    assert "six more digits" in raw
    assert "Can you note that down?" in raw


def test_pan_spelled_across_turns_is_masked(tmp_path):
    t = CallTranscript("call-6", tmp_path)
    t.user("my pan is")
    t.user("A B C D E")
    t.user("1 2 3 4 F")
    t.user("thank you")
    raw = t.path.read_text(encoding="utf-8")
    assert "A B C D E" not in raw and "1 2 3 4 F" not in raw
    assert "XXXXXX234F" in raw


def test_short_number_split_across_turns_is_kept(tmp_path):
    """A phone number is not sensitive here, and masking it would cost a follow-up."""
    t = CallTranscript("call-7", tmp_path)
    t.user("call me on 98765")
    t.user("43210")
    t.user("thanks")
    rows = [r for r in lines(t.path) if r["event"] == "turn"]
    assert [r["text"] for r in rows] == ["call me on 98765", "43210", "thanks"]


def test_fragments_held_at_hangup_are_still_masked_and_written(tmp_path):
    t = CallTranscript("call-8", tmp_path)
    t.user("2 3 4 5 6 7")
    t.user("8 9 1 2 3 4")
    t.end()
    raw = t.path.read_text(encoding="utf-8")
    assert "2 3 4 5 6 7" not in raw
    assert "XXXX XXXX 1234" in raw and "call_end" in raw


def test_a_marker_recorded_while_number_fragments_are_held_does_not_crash(tmp_path):
    """Found by the resilience tests: a call can fail in the middle of a read-out number."""
    t = CallTranscript("call-9", tmp_path)
    t.user("2 3 4 5 6 7")
    t.event("call_failed", role="stt", reason="no usable stt service left")
    t.user("8 9 1 2 3 4")
    t.end()
    rows = lines(t.path)
    assert "call_failed" in [r["event"] for r in rows]
    raw = t.path.read_text(encoding="utf-8")
    assert "2 3 4 5 6 7" not in raw and "XXXX XXXX 1234" in raw

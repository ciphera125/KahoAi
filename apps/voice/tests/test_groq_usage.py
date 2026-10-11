"""groq_usage.log_groq_call: one plain-text line per Groq call, never raising."""

from groq_usage import log_groq_call


def test_a_call_appends_one_line(tmp_path):
    path = tmp_path / "groq_usage.log"
    log_groq_call("some.caller", "openai/gpt-oss-20b", path=path)
    lines = path.read_text(encoding="utf-8").splitlines()
    assert len(lines) == 1
    assert "some.caller" in lines[0]
    assert "openai/gpt-oss-20b" in lines[0]


def test_two_calls_append_two_lines(tmp_path):
    path = tmp_path / "groq_usage.log"
    log_groq_call("a", "m1", path=path)
    log_groq_call("b", "m2", path=path)
    assert len(path.read_text(encoding="utf-8").splitlines()) == 2


def test_the_parent_directory_is_created(tmp_path):
    path = tmp_path / "nested" / "dir" / "groq_usage.log"
    log_groq_call("a", "m", path=path)
    assert path.exists()


def test_an_unwritable_path_does_not_raise(tmp_path):
    # A directory where the log file should be: writing to it fails, but the
    # call site must never see that failure.
    blocked = tmp_path / "blocked"
    blocked.mkdir()
    log_groq_call("a", "m", path=blocked)

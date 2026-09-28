import importlib.util
from pathlib import Path

import httpx
import pytest

SCRIPT = Path(__file__).resolve().parents[3] / "scripts" / "call.py"
spec = importlib.util.spec_from_file_location("kaho_call", SCRIPT)
call = importlib.util.module_from_spec(spec)
spec.loader.exec_module(call)

CFG = {
    "PLIVO_AUTH_ID": "MAXXXX",
    "PLIVO_AUTH_TOKEN": "tok-secret",
    "PLIVO_FROM_NUMBER": "+912200000000",
    "PUBLIC_HOST": "abc.ngrok.app",
    "WEBHOOK_SECRET": "hook secret/1",
}


@pytest.fixture(autouse=True)
def env(monkeypatch):
    for k, v in CFG.items():
        monkeypatch.setenv(k, v)
    monkeypatch.delenv("MAX_CALL_DURATION_SECS", raising=False)


def resp(status, text="", json=None, headers=None):
    request = httpx.Request("GET", "https://x")
    if json is not None:
        return httpx.Response(status, json=json, request=request, headers=headers)
    return httpx.Response(status, text=text, request=request, headers=headers)


class Net:
    """Records every network call the script makes, and returns scripted results."""

    def __init__(self, monkeypatch, get=None, post=None):
        self.gets, self.posts = [], []
        self._get, self._post = get, post
        monkeypatch.setattr(call, "_get", self.get)
        monkeypatch.setattr(call, "_post", self.post)

    def _result(self, scripted):
        if isinstance(scripted, Exception):
            raise scripted
        return scripted

    def get(self, url):
        self.gets.append(url)
        return self._result(self._get or resp(200, "<Response><Stream/></Response>"))

    def post(self, url, **kw):
        self.posts.append((url, kw))
        return self._result(self._post or resp(201, json={"request_uuid": "req-123"}))


def cli(*args):
    return call.main(["--number", "+919876543210", "--agent", "sales", "--yes", *args])


# --- input checking -----------------------------------------------------------


@pytest.mark.parametrize("raw", ["+919876543210", "+91 98765-43210", "+1 (415) 555-2671"])
def test_valid_numbers_are_normalised(raw):
    assert call.check_number(raw, "--number").startswith("+")
    assert " " not in call.check_number(raw, "--number")


@pytest.mark.parametrize(
    "raw", ["9876543210", "+0123456789", "+91", "abc", "", "+91987654321012345"]
)
def test_invalid_numbers_are_rejected_before_anything_is_sent(raw, monkeypatch):
    net = Net(monkeypatch)
    assert call.main(["--number", raw, "--agent", "sales", "--yes"]) == 2
    assert net.gets == [] and net.posts == []


def test_an_unknown_agent_is_rejected_and_the_choices_are_listed(monkeypatch, capsys):
    net = Net(monkeypatch)
    assert call.main(["--number", "+919876543210", "--agent", "nope", "--yes"]) == 2
    assert "sales" in capsys.readouterr().err and net.posts == []


def test_a_path_like_agent_is_just_an_unknown_name(monkeypatch):
    net = Net(monkeypatch)
    assert call.main(["--number", "+919876543210", "--agent", "../../.env", "--yes"]) == 2
    assert net.posts == []


def test_missing_configuration_is_listed_and_nothing_is_sent(monkeypatch, capsys):
    net = Net(monkeypatch)
    monkeypatch.delenv("PLIVO_FROM_NUMBER")
    monkeypatch.delenv("PUBLIC_HOST")
    assert cli() == 2
    err = capsys.readouterr().err
    assert "PLIVO_FROM_NUMBER" in err and "PUBLIC_HOST" in err and net.posts == []


def test_a_bad_from_number_in_the_environment_is_caught(monkeypatch):
    net = Net(monkeypatch)
    monkeypatch.setenv("PLIVO_FROM_NUMBER", "2200000000")
    assert cli() == 2 and net.posts == []


# --- the maximum duration ----------------------------------------------------


def test_max_duration_defaults_to_the_environment_ceiling(monkeypatch):
    monkeypatch.setenv("MAX_CALL_DURATION_SECS", "240")
    assert call.resolve_max_duration(None) == 240


def test_max_duration_can_be_lowered_but_not_raised(monkeypatch, capsys):
    monkeypatch.setenv("MAX_CALL_DURATION_SECS", "240")
    assert call.resolve_max_duration(90) == 90
    assert call.resolve_max_duration(9999) == 240
    assert "capped" in capsys.readouterr().out


def test_max_duration_below_the_floor_is_an_error():
    with pytest.raises(call.CallError) as e:
        call.resolve_max_duration(3)
    assert e.value.code == 2


def test_the_max_duration_reaches_both_the_answer_url_and_plivos_own_limit(monkeypatch):
    net = Net(monkeypatch)
    assert cli("--max-duration", "120") == 0
    assert "max=120" in net.gets[0]
    payload = net.posts[0][1]["json"]
    assert payload["time_limit"] == 120 + call.PLIVO_LIMIT_GRACE_SECS


# --- the answer URL and the secret ---------------------------------------------


def test_the_answer_url_is_encoded_and_carries_agent_callee_and_limit():
    url = call.build_answer_url(CFG, "sales", "+919876543210", 300)
    assert url == (
        "https://abc.ngrok.app/answer?token=hook%20secret/1&agent=sales"
        "&peer=%2B919876543210&max=300"
    )


def test_the_secret_is_never_shown_in_a_dry_run(capsys, monkeypatch):
    net = Net(monkeypatch)
    assert cli("--dry-run") == 0
    out = capsys.readouterr().out
    assert "hook" not in out and "***" in out and "dry run" in out
    assert net.gets == [] and net.posts == []  # nothing at all is sent


# --- the server must be ready before anyone is dialled ---------------------------


@pytest.mark.parametrize(
    "answer, fragment",
    [
        (resp(403), "token"),
        (resp(400, "unknown agent 'sales'"), "refused the call"),
        (resp(502, "bad gateway"), "expected stream XML"),
        (resp(200, "<html>ngrok</html>"), "expected stream XML"),
        (httpx.ConnectTimeout("slow"), "Cannot reach"),
        (httpx.ConnectError("refused"), "Cannot reach"),
    ],
)
def test_a_server_that_is_not_ready_stops_the_call_before_it_is_dialled(
    monkeypatch, capsys, answer, fragment
):
    net = Net(monkeypatch, get=answer)
    assert cli() == 3
    assert fragment in capsys.readouterr().err
    assert net.posts == []  # the important part: nobody was called


def test_the_preflight_happens_before_the_dial(monkeypatch):
    order = []
    monkeypatch.setattr(call, "_get", lambda url: order.append("preflight") or resp(200, "<Stream"))
    monkeypatch.setattr(
        call, "_post", lambda url, **kw: order.append("dial") or resp(201, json={})
    )
    assert cli() == 0
    assert order == ["preflight", "dial"]


# --- dialling ----------------------------------------------------------------


def test_a_successful_dial_sends_the_right_request(monkeypatch, capsys):
    net = Net(monkeypatch)
    assert cli() == 0
    url, kw = net.posts[0]
    assert url == "https://api.plivo.com/v1/Account/MAXXXX/Call/"
    assert kw["auth"] == ("MAXXXX", "tok-secret")
    body = kw["json"]
    assert body["from"] == "+912200000000" and body["to"] == "+919876543210"
    assert body["answer_url"].startswith("https://abc.ngrok.app/answer?token=")
    assert body["ring_timeout"] == call.DEFAULT_RING_TIMEOUT_SECS
    assert "req-123" in capsys.readouterr().out


@pytest.mark.parametrize(
    "answer, fragment",
    [
        (resp(401), "rejected"),
        (resp(403), "rejected"),
        (resp(400, '{"error": "invalid to number"}'), "invalid to number"),
        (resp(429), "rate limiting"),
    ],
)
def test_a_refusal_from_plivo_is_explained_and_says_nothing_was_dialled(
    monkeypatch, capsys, answer, fragment
):
    Net(monkeypatch, post=answer)
    assert cli() == 4
    err = capsys.readouterr().err
    assert fragment in err and "Nothing was dialled" in err


def test_a_connection_failure_means_nothing_was_sent(monkeypatch, capsys):
    net = Net(monkeypatch, post=httpx.ConnectError("no route"))
    assert cli() == 4
    assert "Nothing was dialled" in capsys.readouterr().err and len(net.posts) == 1


@pytest.mark.parametrize(
    "outcome", [httpx.ReadTimeout("slow"), httpx.RemoteProtocolError("dropped"), resp(500, "oops")]
)
def test_an_unknown_outcome_is_never_retried_and_says_to_check_before_retrying(
    monkeypatch, capsys, outcome
):
    """A retry could ring the same person twice."""
    net = Net(monkeypatch, post=outcome)
    assert cli() == 4
    assert len(net.posts) == 1
    err = capsys.readouterr().err
    assert "MAY OR MAY NOT" in err and "before running this again" in err


def test_plivos_error_text_cannot_leak_our_credentials(monkeypatch, capsys):
    Net(monkeypatch, post=resp(500, "x" * 1000))
    cli()
    assert len(capsys.readouterr().err) < 700


# --- confirmation --------------------------------------------------------------


def test_nothing_is_dialled_without_confirmation(monkeypatch):
    net = Net(monkeypatch)
    monkeypatch.setattr("sys.stdin.isatty", lambda: True, raising=False)
    monkeypatch.setattr("builtins.input", lambda prompt="": "n")
    assert call.main(["--number", "+919876543210", "--agent", "sales"]) == 2
    assert net.gets == [] and net.posts == []


def test_a_yes_at_the_prompt_dials(monkeypatch):
    net = Net(monkeypatch)
    monkeypatch.setattr("sys.stdin.isatty", lambda: True, raising=False)
    monkeypatch.setattr("builtins.input", lambda prompt="": "y")
    assert call.main(["--number", "+919876543210", "--agent", "sales"]) == 0
    assert len(net.posts) == 1


def test_without_a_terminal_it_refuses_unless_told_to_go_ahead(monkeypatch, capsys):
    net = Net(monkeypatch)
    monkeypatch.setattr("sys.stdin.isatty", lambda: False, raising=False)
    assert call.main(["--number", "+919876543210", "--agent", "sales"]) == 2
    assert "--yes" in capsys.readouterr().err and net.posts == []


@pytest.mark.parametrize("value", ["1", "4", "500"])
def test_an_absurd_ring_timeout_is_rejected(monkeypatch, value):
    net = Net(monkeypatch)
    assert cli("--ring-timeout", value) == 2 and net.posts == []

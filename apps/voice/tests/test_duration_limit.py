import asyncio
import json
import threading
from types import SimpleNamespace

import duration_limit
import pytest
import server
from duration_limit import enforce_max_duration, resolve_max_duration
from fastapi.testclient import TestClient
from loguru import logger
from starlette.websockets import WebSocketDisconnect
from transcript import CallTranscript


@pytest.fixture(autouse=True)
def clean_env(monkeypatch):
    monkeypatch.delenv("MAX_CALL_DURATION_SECS", raising=False)


# --- the ceiling is configuration, and a request can only lower it -------------


def test_default_ceiling():
    assert resolve_max_duration() == 600


def test_server_ceiling_from_the_environment(monkeypatch):
    monkeypatch.setenv("MAX_CALL_DURATION_SECS", "120")
    assert resolve_max_duration() == 120


def test_a_request_can_lower_the_ceiling(monkeypatch):
    monkeypatch.setenv("MAX_CALL_DURATION_SECS", "300")
    assert resolve_max_duration(90) == 90


def test_a_request_can_never_raise_it(monkeypatch):
    """Whoever holds the webhook token must not be able to extend a call."""
    monkeypatch.setenv("MAX_CALL_DURATION_SECS", "300")
    assert resolve_max_duration(99999) == 300


def test_a_request_below_the_floor_is_raised_to_it():
    assert resolve_max_duration(1) == duration_limit.FLOOR_SECS


@pytest.mark.parametrize("bad", ["abc", "5", "-1", "nan", "inf"])
def test_an_invalid_ceiling_is_an_error_not_a_silent_default(monkeypatch, bad):
    monkeypatch.setenv("MAX_CALL_DURATION_SECS", bad)
    with pytest.raises(ValueError):
        resolve_max_duration()


def test_a_non_finite_request_falls_back_to_the_ceiling():
    assert resolve_max_duration(float("nan")) == 600


# --- the guard itself ----------------------------------------------------------


class Steps:
    def __init__(self):
        self.ran = []

    def make(self, name, behaviour="ok"):
        async def step():
            self.ran.append(name)
            if behaviour == "hang":
                await asyncio.sleep(60)
            if behaviour == "raise":
                raise RuntimeError("plivo down")

        return name, step


@pytest.fixture
def logs():
    seen = []
    sink = logger.add(lambda m: seen.append(m.record["message"]), level="INFO")
    yield seen
    logger.remove(sink)


async def test_the_cutoff_fires_after_the_limit_and_runs_every_step_in_order(logs):
    s, events = Steps(), []
    await enforce_max_duration(
        0.05,
        [s.make("hang up"), s.make("cancel"), s.make("close")],
        record=lambda name, **f: events.append((name, f)),
    )
    assert s.ran == ["hang up", "cancel", "close"]
    assert events == [("max_duration_exceeded", {"limit_secs": 0.05})]


async def test_the_cutoff_is_logged(logs):
    await enforce_max_duration(0.02, [Steps().make("x")])
    assert any("exceeded the maximum duration" in m for m in logs)


async def test_nothing_happens_before_the_limit():
    s = Steps()
    task = asyncio.create_task(enforce_max_duration(5, [s.make("hang up")]))
    await asyncio.sleep(0.05)
    assert s.ran == []
    task.cancel()


async def test_a_call_that_ends_first_cancels_the_guard_and_it_never_acts():
    s, events = Steps(), []
    task = asyncio.create_task(
        enforce_max_duration(0.1, [s.make("hang up")], record=lambda *a, **k: events.append(a))
    )
    await asyncio.sleep(0.02)
    task.cancel()
    await asyncio.sleep(0.2)
    assert s.ran == [] and events == []


async def test_a_hanging_step_is_cut_off_and_the_next_still_runs(logs):
    s = Steps()
    await enforce_max_duration(
        0.02,
        [s.make("hang up", "hang"), s.make("cancel"), s.make("close")],
        step_timeout=0.05,
    )
    assert s.ran == ["hang up", "cancel", "close"]
    assert any("did not finish" in m for m in logs)


async def test_a_failing_step_is_logged_and_the_next_still_runs(logs):
    s = Steps()
    await enforce_max_duration(
        0.02, [s.make("hang up", "raise"), s.make("cancel")], step_timeout=1
    )
    assert s.ran == ["hang up", "cancel"]
    assert any("failed" in m and "plivo down" in m for m in logs)


async def test_a_broken_recorder_does_not_stop_the_hangup():
    s = Steps()

    def broken(*a, **k):
        raise OSError("disk full")

    await enforce_max_duration(0.02, [s.make("hang up")], record=broken)
    assert s.ran == ["hang up"]


# --- in the real /ws handler: the call is actually ended ------------------------


class FakeWorker:
    def __init__(self, transcript):
        self.transcript = transcript
        self.health = SimpleNamespace(failed=None)
        self.cancelled = threading.Event()
        self.done = None

    async def cancel(self, reason=None):
        self.cancelled.set()
        if self.done and not self.done.done():
            self.done.set_result(None)


class FakeRunner:
    """Stands in for a call that would run forever, until it is cancelled."""

    def __init__(self, **kw):
        pass

    async def run(self, worker):
        worker.done = asyncio.get_running_loop().create_future()
        await worker.done


@pytest.fixture
def call_env(monkeypatch, tmp_path):
    monkeypatch.setenv("WEBHOOK_SECRET", "s3cret")
    monkeypatch.setenv("PUBLIC_HOST", "kaho.example.com")
    monkeypatch.setenv("PLIVO_AUTH_ID", "id")
    monkeypatch.setenv("PLIVO_AUTH_TOKEN", "tok")
    # Real limits are tens of seconds; the test shrinks the floor, not the logic.
    monkeypatch.setattr(duration_limit, "FLOOR_SECS", 0.05)
    hangups = []

    async def fake_hang_up(self):
        hangups.append(self.__class__.__name__)

    monkeypatch.setattr(server.FailOpenPlivoSerializer, "hang_up", fake_hang_up)
    workers = []

    def fake_build_worker(transport, params=None, **kw):
        worker = FakeWorker(CallTranscript(kw.get("call_id") or "x", tmp_path))
        workers.append(worker)
        return worker

    monkeypatch.setattr(server, "build_worker", fake_build_worker)
    monkeypatch.setattr(server, "WorkerRunner", FakeRunner)
    return SimpleNamespace(hangups=hangups, workers=workers, tmp=tmp_path)


def wait_for_server_to_close(client, url, timeout=5.0):
    """Connect, send the start event, then wait for the SERVER to end the call.

    Runs in a daemon thread with a timeout, so if the cutoff ever stops working
    this fails in seconds instead of hanging the whole suite.
    """
    outcome = {}

    def run():
        try:
            with client.websocket_connect(url) as ws:
                start = {"event": "start", "start": {"streamId": "S", "callId": "C1"}}
                ws.send_text(json.dumps(start))
                ws.receive_text()  # blocks until the server closes the stream
        except WebSocketDisconnect as e:
            outcome["closed"] = e.code
        except Exception as e:  # pragma: no cover
            outcome["error"] = repr(e)

    t = threading.Thread(target=run, daemon=True)
    t.start()
    t.join(timeout)
    return outcome, not t.is_alive()


def test_the_real_call_handler_hangs_up_when_the_maximum_duration_passes(call_env):
    client = TestClient(server.app)
    outcome, finished = wait_for_server_to_close(client, "/ws?token=s3cret&max=0.3")
    assert finished, "the call was still running long after its maximum duration"
    assert "closed" in outcome, outcome
    assert call_env.hangups == ["FailOpenPlivoSerializer"]  # Plivo was told to hang up
    worker = call_env.workers[0]
    assert worker.cancelled.is_set()  # and our pipeline was torn down
    rows = [json.loads(x) for x in worker.transcript.path.read_text(encoding="utf-8").splitlines()]
    exceeded = [r for r in rows if r["event"] == "max_duration_exceeded"]
    assert exceeded and exceeded[0]["limit_secs"] == 0.3  # and it was recorded


def test_the_server_ceiling_applies_when_the_stream_asks_for_more(call_env, monkeypatch):
    monkeypatch.setenv("MAX_CALL_DURATION_SECS", "0.3")
    client = TestClient(server.app)
    _, finished = wait_for_server_to_close(client, "/ws?token=s3cret&max=9999")
    assert finished and call_env.hangups


def test_the_default_ceiling_applies_to_a_call_that_names_no_limit(call_env, monkeypatch):
    monkeypatch.setenv("MAX_CALL_DURATION_SECS", "0.3")
    client = TestClient(server.app)
    _, finished = wait_for_server_to_close(client, "/ws?token=s3cret")
    assert finished and call_env.hangups


def test_a_call_that_ends_by_itself_is_not_hung_up_again(call_env, monkeypatch):
    class QuickRunner(FakeRunner):
        async def run(self, worker):
            return  # the call is over immediately

    monkeypatch.setattr(server, "WorkerRunner", QuickRunner)
    client = TestClient(server.app)
    with client.websocket_connect("/ws?token=s3cret&max=0.2") as ws:
        ws.send_text(json.dumps({"event": "start", "start": {"streamId": "S", "callId": "C2"}}))
        threading.Event().wait(0.5)  # well past the limit
    assert call_env.hangups == []


# --- the forced hang-up reports its own failures -------------------------------


class FakeSession:
    """Stands in for aiohttp.ClientSession; `behaviour` decides what the DELETE does."""

    behaviour = 204
    seen = []

    def __init__(self, *a, **k):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    def delete(self, url, headers=None):
        FakeSession.seen.append((url, headers["Authorization"]))
        outer = FakeSession.behaviour

        class Ctx:
            async def __aenter__(self_inner):
                if outer == "stall":
                    await asyncio.sleep(60)
                return SimpleNamespace(status=outer)

            async def __aexit__(self_inner, *exc):
                return False

        return Ctx()


@pytest.fixture
def plivo(monkeypatch):
    FakeSession.seen = []
    monkeypatch.setattr(server.aiohttp, "ClientSession", FakeSession)
    return server.FailOpenPlivoSerializer(
        stream_id="S", call_id="CALL-9", auth_id="AUTHID", auth_token="tok"
    )


@pytest.mark.parametrize("status", [204, 404])
async def test_a_forced_hangup_succeeds_on_204_and_on_already_ended(plivo, status):
    FakeSession.behaviour = status
    await plivo.hang_up()
    url, authorization = FakeSession.seen[0]
    assert url == "https://api.plivo.com/v1/Account/AUTHID/Call/CALL-9/"
    assert authorization == "Basic QVVUSElEOnRvaw=="  # AUTHID:tok


@pytest.mark.parametrize("status", [401, 403, 500])
async def test_a_forced_hangup_that_plivo_refuses_raises_instead_of_pretending(plivo, status):
    """Seen live: the guard logged 'hang up done' for a 401."""
    FakeSession.behaviour = status
    with pytest.raises(RuntimeError, match=str(status)):
        await plivo.hang_up()


async def test_a_stalled_forced_hangup_times_out_and_raises(plivo, monkeypatch):
    FakeSession.behaviour = "stall"
    monkeypatch.setattr(server, "HANGUP_TIMEOUT_SECS", 0.05)
    with pytest.raises(RuntimeError, match="did not answer"):
        await asyncio.wait_for(plivo.hang_up(), 2)


async def test_the_forced_hangup_ignores_fail_open(plivo):
    FakeSession.behaviour = 204
    plivo.fail_open = True
    await plivo.hang_up()
    assert len(FakeSession.seen) == 1


async def test_a_forced_hangup_with_no_credentials_says_so():
    s = server.FailOpenPlivoSerializer(
        stream_id="S", call_id="C", auth_id="a", auth_token="t"
    )
    s._forced_hangup = (None, None, None)
    with pytest.raises(RuntimeError, match="no Plivo credentials"):
        await s.hang_up()


async def test_the_normal_hangup_still_respects_fail_open_and_has_a_timeout(monkeypatch, logs):
    calls = []

    async def real(self):
        calls.append(1)
        await asyncio.sleep(60)

    monkeypatch.setattr(server.PlivoFrameSerializer, "_hang_up_call", real)
    monkeypatch.setattr(server, "HANGUP_TIMEOUT_SECS", 0.05)
    s = server.FailOpenPlivoSerializer(stream_id="S", call_id="C", auth_id="a", auth_token="t")
    s.fail_open = True
    await s._hang_up_call()
    assert calls == []  # left open for Plivo's own apology
    s.fail_open = False
    await asyncio.wait_for(s._hang_up_call(), 2)
    assert calls == [1] and any("did not answer" in m for m in logs)


async def test_the_guard_reports_a_failed_hangup_as_failed_and_carries_on(monkeypatch, logs):
    s = Steps()
    plivo = server.FailOpenPlivoSerializer(stream_id="S", call_id="C", auth_id="a", auth_token="t")
    FakeSession.behaviour = 401
    FakeSession.seen = []
    monkeypatch.setattr(server.aiohttp, "ClientSession", FakeSession)
    await enforce_max_duration(
        0.02, [("hang up via Plivo", plivo.hang_up), s.make("cancel")], step_timeout=1
    )
    assert s.ran == ["cancel"]
    assert any("'hang up via Plivo' failed" in m and "401" in m for m in logs)
    assert not any("'hang up via Plivo' done" in m for m in logs)


# --- outbound parameters on the answer webhook ---------------------------------


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setenv("WEBHOOK_SECRET", "s3cret")
    monkeypatch.setenv("PUBLIC_HOST", "kaho.example.com")
    return TestClient(server.app)


def test_an_outbound_answer_carries_agent_peer_and_max(client):
    resp = client.post("/answer?token=s3cret&agent=sales&peer=%2B919876543210&max=120")
    assert resp.status_code == 200
    assert "from=%2B919876543210&amp;agent=sales&amp;max=120</Stream>" in resp.text


def test_the_callee_is_the_number_the_tools_use_for_an_outbound_call(client):
    resp = client.post(
        "/answer?token=s3cret&agent=sales&peer=%2B919876543210",
        content="From=%2B912200000000&To=%2B919876543210",
        headers={"content-type": "application/x-www-form-urlencoded"},
    )
    assert "from=%2B919876543210" in resp.text and "912200000000" not in resp.text


def test_an_unknown_agent_is_refused_without_touching_the_server(client):
    assert client.post("/answer?token=s3cret&agent=nope").status_code == 400
    assert client.post("/answer?token=s3cret&agent=..%2F..%2F.env").status_code == 400
    assert client.post("/answer?token=s3cret").status_code == 200  # still serving


def test_the_answer_clamps_a_requested_duration_to_the_ceiling(client, monkeypatch):
    monkeypatch.setenv("MAX_CALL_DURATION_SECS", "200")
    assert "max=200</Stream>" in client.post("/answer?token=s3cret&max=5000").text
    assert "max=60</Stream>" in client.post("/answer?token=s3cret&max=60").text


def test_a_garbage_duration_is_refused(client):
    assert client.post("/answer?token=s3cret&max=abc").status_code == 400


def test_a_stream_with_an_unknown_agent_is_closed_and_the_server_survives(client):
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect("/ws?token=s3cret&agent=nope") as ws:
            ws.receive_text()
    assert client.post("/answer?token=s3cret").status_code == 200

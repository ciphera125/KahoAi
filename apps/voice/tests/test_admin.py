"""Kaho AI Studio's API: accounts, agents, prompts, numbers, contacts and calls.

Testing tool only. It must answer only to this machine: the phone server is
exposed through ngrok, so the admin app runs separately, on 127.0.0.1, and
refuses requests that look forwarded or come from another site.
"""

import json

import admin
import pytest
from fastapi.testclient import TestClient

NUMBER = "+918065520552"
LOCAL = "http://127.0.0.1:8001"


@pytest.fixture
def anon(monkeypatch, tmp_path):
    monkeypatch.setenv("PROMPT_STORE_PATH", str(tmp_path / "p.json"))
    monkeypatch.setenv("PLIVO_FROM_NUMBER", NUMBER)
    return TestClient(admin.app, base_url=LOCAL)


@pytest.fixture
def client(anon):
    r = anon.post("/api/auth/signup", json={"name": "Aditya Nair", "email": "a@example.com",
                                            "password": "correct horse", "company": "Kaho AI"})
    assert r.status_code == 200
    return anon


def test_the_page_loads(anon):
    r = anon.get("/")
    assert r.status_code == 200
    assert "Inter" in r.text and 'id="auth"' in r.text


@pytest.mark.parametrize(
    "headers",
    [
        {"host": "open-buckskin-wolverine.ngrok-free.dev"},  # DNS rebinding, a tunnel
        {"x-forwarded-for": "203.0.113.9"},  # anything that came through a proxy
        {"origin": "https://evil.example"},  # another site posting from your browser
    ],
)
def test_only_this_machine_may_use_it(client, headers):
    assert client.get("/", headers=headers).status_code == 403
    r = client.post("/api/agents", json={"name": "pwned", "prompt": "x"}, headers=headers)
    assert r.status_code == 403
    assert client.get("/api/agents").json() == []


def test_it_binds_to_loopback_only():
    assert admin.HOST == "127.0.0.1"


# --- numbers and calling ----------------------------------------------------


@pytest.fixture
def numbers(client, monkeypatch, tmp_path):
    monkeypatch.setenv("NUMBER_STORE_PATH", str(tmp_path / "numbers.json"))
    monkeypatch.setenv("PLIVO_AUTH_ID", "MAENVID")
    monkeypatch.setenv("PLIVO_AUTH_TOKEN", "env-token-9999")
    monkeypatch.setenv("PUBLIC_HOST", "abc.ngrok.app")
    monkeypatch.setenv("WEBHOOK_SECRET", "hook-secret")
    return client


def test_numbers_list_has_our_plivo_number_and_no_secret(numbers):
    r = numbers.get("/api/numbers")
    assert r.status_code == 200 and "env-token-9999" not in r.text
    [row] = r.json()
    assert row["number"] == NUMBER and row["status"] == "active"
    assert {p["id"] for p in numbers.get("/api/providers").json()} >= {
        "plivo", "exotel", "twilio", "sip"}


def test_add_edit_delete_a_number(numbers):
    r = numbers.post("/api/numbers", json={"provider": "exotel", "number": "+919800000001",
        "label": "Exotel test", "credentials": {"account_sid": "s", "api_key": "k",
        "api_token": "tok-secret-7777", "subdomain": "api.in.exotel.com"}})
    assert r.status_code == 200 and "tok-secret-7777" not in r.text
    nid = r.json()["id"]
    assert numbers.patch(f"/api/numbers/{nid}", json={"label": "Renamed"}).status_code == 200
    assert numbers.delete(f"/api/numbers/{nid}").status_code == 200
    assert [x["number"] for x in numbers.get("/api/numbers").json()] == [NUMBER]


def test_adding_a_bad_number_is_refused(numbers):
    r = numbers.post("/api/numbers", json={"provider": "plivo", "number": "abc", "credentials": {}})
    assert r.status_code == 400


def test_calling_uses_the_dialler_once_with_this_numbers_credentials(numbers, monkeypatch):
    seen = []
    monkeypatch.setattr(admin.dialler, "preflight", lambda url, cfg: None)

    def dial(cfg, number, answer_url, max_secs, ring_timeout, **_):
        seen.append(
            (cfg["PLIVO_AUTH_ID"], cfg["PLIVO_AUTH_TOKEN"], cfg["PLIVO_FROM_NUMBER"], number)
        )
        return {"request_uuid": "req-1"}

    monkeypatch.setattr(admin.dialler, "dial", dial)
    from_id = numbers.get("/api/numbers").json()[0]["id"]
    r = numbers.post("/api/calls", json={"from_id": from_id, "to": "9343602016", "consent": True})
    assert r.status_code == 200 and r.json()["request_uuid"] == "req-1"
    assert seen == [("MAENVID", "env-token-9999", NUMBER, "+919343602016")]


def test_no_call_without_consent(numbers, monkeypatch):
    monkeypatch.setattr(admin.dialler, "dial", lambda *a, **k: pytest.fail("dialled"))
    from_id = numbers.get("/api/numbers").json()[0]["id"]
    r = numbers.post("/api/calls", json={"from_id": from_id, "to": "9343602016"})
    assert r.status_code == 400


def test_no_call_from_a_provider_that_is_not_connected(numbers, monkeypatch):
    monkeypatch.setattr(admin.dialler, "dial", lambda *a, **k: pytest.fail("dialled"))
    nid = numbers.post("/api/numbers", json={"provider": "sip", "number": "+919800000002",
        "credentials": {"sip_host": "h", "username": "u", "password": "p",
                        "transport": "udp"}}).json()["id"]
    r = numbers.post("/api/calls", json={"from_id": nid, "to": "9343602016", "consent": True})
    assert r.status_code == 400 and "not connected" in r.json()["error"]


def test_a_failed_dial_is_reported_not_retried(numbers, monkeypatch):
    calls = []
    monkeypatch.setattr(admin.dialler, "preflight", lambda url, cfg: None)

    def dial(*a, **_):
        calls.append(1)
        raise admin.dialler.CallError(
            "Plivo answered HTTP 500. The call MAY OR MAY NOT have been placed.", 4
        )

    monkeypatch.setattr(admin.dialler, "dial", dial)
    from_id = numbers.get("/api/numbers").json()[0]["id"]
    r = numbers.post("/api/calls", json={"from_id": from_id, "to": "9343602016", "consent": True})
    assert r.status_code == 502 and "MAY OR MAY NOT" in r.json()["error"] and calls == [1]


def test_calling_is_local_only_too(numbers):
    r = numbers.post("/api/calls", json={"to": "9343602016", "consent": True},
                     headers={"origin": "https://evil.example"})
    assert r.status_code == 403


# --- contacts, tags, live transcript ----------------------------------------


@pytest.fixture
def people(client, monkeypatch, tmp_path):
    monkeypatch.setenv("CONTACT_STORE_PATH", str(tmp_path / "contacts.json"))
    return client


def test_the_page_says_nothing_about_being_local(client):
    text = client.get("/").text.lower()
    assert "this mac" not in text and "local only" not in text


def test_contacts_create_list_rename_delete(people):
    r = people.post("/api/contacts", json={"name": "Asha Rao", "numbers": ["98765 43210"]})
    assert r.status_code == 200
    cid = r.json()["id"]
    assert people.patch(f"/api/contacts/{cid}", json={"name": "Asha R"}).json()["name"] == "Asha R"
    [c] = people.get("/api/contacts").json()
    assert c["numbers"][0]["number"] == "+919876543210"
    assert people.delete(f"/api/contacts/{cid}").status_code == 200
    assert people.get("/api/contacts").json() == []


def test_a_contact_needs_a_name_and_real_numbers(people):
    assert people.post("/api/contacts", json={"name": "", "numbers": []}).status_code == 400
    assert people.post("/api/contacts", json={"name": "A", "numbers": ["abc"]}).status_code == 400


def test_contact_numbers_and_tags(people):
    cid = people.post("/api/contacts", json={"name": "Asha", "numbers": []}).json()["id"]
    tag = people.post("/api/tags", json={"name": "Hot lead", "color": "marigold"}).json()
    n = people.post(f"/api/contacts/{cid}/numbers",
                    json={"number": "9876543210", "tags": [tag["id"]]}).json()
    assert n["tags"] == [tag["id"]]
    assert people.patch(f"/api/contacts/{cid}/numbers/{n['id']}",
                        json={"number": "9000000001"}).json()["number"] == "+919000000001"
    assert people.patch(f"/api/tags/{tag['id']}", json={"name": "Warm"}).json()["name"] == "Warm"
    assert people.delete(f"/api/tags/{tag['id']}").status_code == 200
    assert people.get("/api/contacts").json()[0]["numbers"][0]["tags"] == []
    assert people.delete(f"/api/contacts/{cid}/numbers/{n['id']}").status_code == 200


def test_bulk_delete(people):
    ids = [people.post("/api/contacts", json={"name": x, "numbers": []}).json()["id"]
           for x in "ABC"]
    r = people.post("/api/contacts/delete", json={"ids": ids[:2]})
    assert r.json() == {"deleted": 2}
    assert [c["name"] for c in people.get("/api/contacts").json()] == ["C"]


def write_call(path, *rows):
    path.write_text("".join(json.dumps(r) + "\n" for r in rows), encoding="utf-8")


def test_the_live_transcript_streams_turns_until_the_call_ends(client, monkeypatch, tmp_path):
    monkeypatch.setenv("CALL_LOG_DIR", str(tmp_path))
    write_call(tmp_path / "abc-123.jsonl",
               {"event": "call_start"},
               {"event": "live", "role": "agent", "text": "Hello, I'm"},
               {"event": "turn", "role": "assistant", "text": "Hello, I'm Aayushi."},
               {"event": "turn", "role": "user", "text": "Hi"},
               {"event": "tool", "name": "capture_lead",
                "text": "{\"args\": {\"name\": \"Asha\"}}"},
               {"event": "call_end"})
    with client.stream("GET", "/api/calls/abc-123/stream") as r:
        assert r.headers["content-type"].startswith("text/event-stream")
        events = [json.loads(line[6:]) for line in r.iter_lines() if line.startswith("data: ")]
    assert [e["event"] for e in events] == [
        "call_start", "live", "turn", "turn", "tool", "call_end"]
    assert events[2] == {"event": "turn", "role": "agent", "text": "Hello, I'm Aayushi."}
    assert events[3]["role"] == "caller"
    # A tool line says what happened, never the details (names, numbers) it carried.
    assert events[4] == {"event": "tool", "name": "capture_lead"}


@pytest.mark.parametrize("call_id", ["../../etc/passwd", "a b", "x" * 200])
def test_a_bad_call_id_is_refused(client, call_id):
    assert client.get(f"/api/calls/{call_id}/stream").status_code in (400, 404)


# --- prompt versions, contact tags, call history ------------------------------


def test_a_contact_gets_tags_and_a_new_name(people):
    cid = people.post("/api/contacts", json={"name": "Asha", "numbers": []}).json()["id"]
    tag = people.post("/api/tags", json={"name": "VIP", "color": "plum"}).json()
    r = people.patch(f"/api/contacts/{cid}", json={"tags": [tag["id"]]})
    assert r.status_code == 200 and r.json()["tags"] == [tag["id"]]
    assert people.patch(f"/api/contacts/{cid}", json={"tags": ["nope"]}).status_code == 400


def test_a_contacts_calls_page_and_transcript_csv(people, monkeypatch, tmp_path):
    monkeypatch.setenv("CALL_LOG_DIR", str(tmp_path / "calls"))
    (tmp_path / "calls").mkdir()
    write_call(tmp_path / "calls" / "call-aaa111.jsonl",
               {"event": "call_start", "at": "2026-10-24T09:00:00+00:00"},
               {"event": "call_party", "number": "+919876543210"},
               {"event": "turn", "role": "assistant", "text": "Hello",
                "at": "2026-10-24T09:00:01+00:00"},
               {"event": "call_end", "at": "2026-10-24T09:00:40+00:00"})
    cid = people.post("/api/contacts",
                      json={"name": "Asha", "numbers": ["9876543210"]}).json()["id"]
    page = people.get(f"/api/contacts/{cid}/calls?page=1&per_page=10").json()
    assert page["total"] == 1 and page["calls"][0]["duration_secs"] == 40
    assert people.get(f"/api/contacts/{cid}/calls?per_page=7").status_code == 400
    r = people.get("/api/calls/call-aaa111/transcript.csv")
    assert r.status_code == 200 and r.headers["content-type"].startswith("text/csv")
    assert "attachment" in r.headers["content-disposition"] and "Agent,Hello" in r.text
    assert people.get("/api/calls/call-aaa111/transcript").json()[0]["text"] == "Hello"
    assert people.get("/api/calls/..%2F..%2Fx/transcript.csv").status_code in (400, 404)


# --- accounts --------------------------------------------------------------------


@pytest.mark.parametrize("path", ["/api/agents", "/api/contacts", "/api/numbers",
                                  "/api/dashboard", "/api/notifications", "/api/me",
                                  "/api/calls/abc123/transcript.csv", "/api/calls/abc123/stream"])
def test_nothing_without_signing_in(anon, path):
    assert anon.get(path).status_code == 401


def test_sign_up_once_then_sign_in_and_out(anon):
    assert anon.get("/api/auth/state").json() == {"has_accounts": False}
    r = anon.post("/api/auth/signup", json={"name": "Aditya", "email": "a@example.com",
                                            "password": "correct horse"})
    cookie = r.headers["set-cookie"].lower()
    assert "httponly" in cookie and "samesite=strict" in cookie
    assert anon.get("/api/me").json()["name"] == "Aditya"
    assert anon.post("/api/auth/logout").status_code == 200
    assert anon.get("/api/me").status_code == 401
    assert anon.post("/api/auth/login", json={"email": "a@example.com",
                                              "password": "wrong one!"}).status_code == 401
    assert anon.post("/api/auth/login", json={"email": "A@example.com",
                                              "password": "correct horse"}).status_code == 200
    assert anon.get("/api/me").status_code == 200


def test_a_second_sign_up_needs_the_invite_code(client):
    code = client.get("/api/me").json()["invite_code"]
    other = TestClient(admin.app, base_url=LOCAL)
    body = {"name": "Ayushi", "email": "ay@example.com", "password": "another pass"}
    assert other.post("/api/auth/signup", json=body).status_code == 403
    assert other.post("/api/auth/signup", json={**body, "invite": code}).status_code == 200
    assert "invite_code" not in other.get("/api/me").json()  # members do not hand out invites


def test_the_profile_counts_what_the_account_has(client):
    client.post("/api/agents", json={"name": "Bot", "description": "", "prompt": "Hi"})
    me = client.get("/api/me").json()
    assert me["counts"]["agents"] == 1 and me["counts"]["prompts"] == 1
    assert me["counts"]["numbers"] >= 0 and "hash" not in json.dumps(me)


# --- agents and prompts ------------------------------------------------------------


@pytest.fixture
def bot(client):
    r = client.post("/api/agents", json={"name": "Reminder", "description": "EMI reminders",
                                         "prompt": "You are Riya."})
    assert r.status_code == 200
    return r.json()


def test_agents_create_edit_and_delete(client, bot):
    assert client.get("/api/agents").json()[0]["name"] == "Reminder"
    r = client.patch(f"/api/agents/{bot['id']}", json={
        "name": "EMI reminder", "tools": ["end_call"],
        "settings": {"opening_line": "Namaste", "max_minutes": 4, "ring_secs": 25}})
    assert r.status_code == 200 and r.json()["tools"] == ["end_call"]
    assert client.patch(f"/api/agents/{bot['id']}", json={"tools": ["nope"]}).status_code == 400
    assert client.delete(f"/api/agents/{bot['id']}").status_code == 200
    assert client.get("/api/agents").json() == []


def test_the_prompts_table_and_its_actions(client, bot):
    rows = client.get("/api/prompts").json()
    assert rows[0]["agent_name"] == "Reminder" and rows[0]["version_count"] == 1
    pid = rows[0]["id"]
    assert client.patch(f"/api/prompts/{pid}", json={"text": "v2", "name": "EMI v2"}).json()[
        "name"] == "EMI v2"
    versions = client.get(f"/api/prompts/{pid}/versions").json()
    assert [v["prompt"] for v in versions] == ["v2", "You are Riya."]
    client.post(f"/api/prompts/{pid}/versions/{versions[1]['id']}/restore")
    assert client.get(f"/api/prompts/{pid}").json()["prompt"] == "You are Riya."
    other = client.post("/api/agents", json={"name": "Other", "prompt": "o"}).json()
    r = client.post(f"/api/prompts/{pid}/assign", json={"agent_id": other["id"]})
    assert r.status_code == 200 and r.json()["agent_id"] == other["id"]
    assert client.delete(f"/api/prompts/{pid}").status_code == 200
    assert client.get(f"/api/prompts/{pid}").status_code == 404


def test_a_number_routes_to_an_agent(numbers, bot):
    nid = numbers.get("/api/numbers").json()[0]["id"]
    r = numbers.post(f"/api/numbers/{nid}/agent", json={"agent_id": bot["id"]})
    assert r.status_code == 200 and r.json()["agent_id"] == bot["id"]
    assert numbers.get("/api/numbers").json()[0]["agent_id"] == bot["id"]


def test_a_call_from_an_agent_carries_it_and_asks_plivo_for_the_outcome(numbers, monkeypatch,
                                                                         bot):
    seen = {}
    monkeypatch.setattr(admin.dialler, "preflight", lambda url, cfg: None)

    def dial(cfg, number, answer_url, max_secs, ring_timeout, hangup_url=None):
        seen.update(answer=answer_url, hangup=hangup_url, ring=ring_timeout, max=max_secs)
        return {"request_uuid": "req-12345"}

    monkeypatch.setattr(admin.dialler, "dial", dial)
    numbers.patch(f"/api/agents/{bot['id']}", json={"settings": {"ring_secs": 25,
                                                                 "max_minutes": 2}})
    r = numbers.post("/api/calls", json={"to": "9343602016", "consent": True,
                                         "agent_id": bot["id"]})
    assert r.status_code == 200
    assert f"studio_agent={bot['id']}" in seen["answer"] and seen["ring"] == 25
    assert seen["max"] == 120 and "/hangup?token=" in seen["hangup"]
    assert "peer=%2B919343602016" in seen["hangup"]
    row = numbers.get("/api/dashboard?days=7").json()["recent"][0]
    assert row["status"] == "ringing" and row["agent_name"] == "Reminder"


def test_a_do_not_call_contact_is_never_dialled(numbers, monkeypatch, tmp_path):
    monkeypatch.setenv("CONTACT_STORE_PATH", str(tmp_path / "contacts.json"))
    monkeypatch.setattr(admin.dialler, "dial", lambda *a, **k: pytest.fail("dialled"))
    cid = numbers.post("/api/contacts", json={"name": "Asha",
                                              "numbers": ["9343602016"]}).json()["id"]
    assert numbers.patch(f"/api/contacts/{cid}", json={"dnc": True}).json()["dnc"] is True
    r = numbers.post("/api/calls", json={"to": "+91 93436 02016", "consent": True})
    assert r.status_code == 400 and "do not call" in r.json()["error"].lower()


def test_contacts_show_their_last_call(people, monkeypatch, tmp_path):
    monkeypatch.setenv("CALL_LOG_DIR", str(tmp_path / "calls"))
    (tmp_path / "calls").mkdir()
    write_call(tmp_path / "calls" / "call-bbb222.jsonl",
               {"event": "call_start", "at": "2026-10-24T09:00:00+00:00"},
               {"event": "call_party", "number": "+919876543210"},
               {"event": "call_end", "at": "2026-10-24T09:00:40+00:00"})
    people.post("/api/contacts", json={"name": "Asha", "numbers": ["9876543210"]})
    (row,) = people.get("/api/contacts").json()
    assert row["last_call"]["call_id"] == "call-bbb222" and row["call_count"] == 1


# --- notifications and the dashboard ----------------------------------------------


def test_changes_show_up_as_notifications_with_a_link(client, bot):
    feed = client.get("/api/notifications").json()
    assert feed["unread"] >= 1
    item = feed["items"][0]
    assert "Reminder" in item["text"] and item["view"] == "agents" and item["ref"] == bot["id"]
    assert client.post("/api/notifications/seen").status_code == 200
    assert client.get("/api/notifications").json()["unread"] == 0


def test_the_dashboard_answers_with_totals_and_series(client):
    d = client.get("/api/dashboard?days=30").json()
    assert {"totals", "rates", "talk", "by_day", "by_hour", "by_agent", "recent"} <= set(d)
    assert client.get("/api/dashboard?days=9999").status_code == 400


def test_the_longest_call_offered_is_the_servers_ceiling(client, monkeypatch):
    monkeypatch.setenv("MAX_CALL_DURATION_SECS", "600")
    assert client.get("/api/config").json()["limits"]["max_minutes"] == 10


def test_an_agent_cannot_ask_for_longer_than_the_server_allows(client, bot, monkeypatch):
    monkeypatch.setenv("MAX_CALL_DURATION_SECS", "600")
    r = client.patch(f"/api/agents/{bot['id']}", json={"settings": {"max_minutes": 25}})
    assert r.status_code == 400 and "10" in r.json()["error"]


# --- roles ------------------------------------------------------------------------


@pytest.fixture
def member(client):
    code = client.get("/api/me").json()["invite_code"]
    other = TestClient(admin.app, base_url=LOCAL)
    assert other.post("/api/auth/signup", json={"name": "Ayushi", "email": "ay@example.com",
                                                "password": "another pass",
                                                "invite": code}).status_code == 200
    return other


@pytest.mark.parametrize("method, path, body", [
    ("post", "/api/numbers", {"provider": "plivo", "number": "+919800000009"}),
    ("patch", "/api/numbers/x", {"credentials": {"auth_token": "stolen"}}),
    ("delete", "/api/numbers/x", None),
    ("post", "/api/numbers/x/default", None),
    ("post", "/api/numbers/x/agent", {"agent_id": None}),
    ("delete", "/api/agents/ag_000000000000", None),
    ("delete", "/api/prompts/pr_000000000000", None),
    ("post", "/api/contacts/delete", {"ids": []}),
    ("post", "/api/dashboard/sync", None),
])
def test_members_cannot_change_numbers_or_delete_in_bulk(member, method, path, body):
    kwargs = {"json": body} if body is not None else {}
    r = getattr(member, method)(path, **kwargs)
    assert r.status_code == 403 and "owner" in r.json()["error"]


def test_members_still_do_the_daily_work(member):
    assert member.post("/api/contacts", json={"name": "Asha", "numbers": []}).status_code == 200
    r = member.post("/api/agents", json={"name": "Bot", "prompt": "Hi"})
    assert r.status_code == 200
    assert member.patch(f"/api/agents/{r.json()['id']}", json={"tools": []}).status_code == 200
    assert member.get("/api/me").json()["role"] == "member"

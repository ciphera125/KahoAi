"""Our phone numbers and the provider credentials each one needs."""

import json

import numbers_store
import pytest

OURS = "+918065520552"


@pytest.fixture
def store(tmp_path, monkeypatch):
    monkeypatch.setenv("PLIVO_FROM_NUMBER", OURS)
    monkeypatch.setenv("PLIVO_AUTH_ID", "MAENVID")
    monkeypatch.setenv("PLIVO_AUTH_TOKEN", "env-token-9999")
    return numbers_store.NumberStore(tmp_path / "numbers.json")


def test_our_plivo_number_is_there_from_the_start_and_active(store):
    [row] = store.list_public()
    assert (row["provider"], row["number"], row["status"], row["is_default"]) == (
        "plivo", OURS, "active", True)


def test_the_env_token_is_not_copied_to_disk(store):
    store.list_public()
    assert "env-token-9999" not in store.path.read_text(encoding="utf-8")


def test_secrets_are_never_shown_in_full(store):
    row = store.add("twilio", "+14155550100", "US line",
                    {"account_sid": "AC123", "auth_token": "supersecret-4321"})
    shown = json.dumps(store.list_public())
    assert "supersecret-4321" not in shown and "env-token-9999" not in shown
    public = next(r for r in store.list_public() if r["id"] == row["id"])
    assert public["credentials"]["auth_token"] == "••••4321"
    assert public["credentials"]["account_sid"] == "AC123"


@pytest.mark.parametrize("provider, status", [
    ("exotel", "not_connected"), ("twilio", "not_connected"), ("sip", "not_connected")])
def test_providers_without_telephony_are_not_connected(store, provider, status):
    creds = {f: "x" for f, *_ in numbers_store.PROVIDERS[provider]["fields"]}
    row = store.add(provider, "+919800000001", "", creds)
    assert next(r for r in store.list_public() if r["id"] == row["id"])["status"] == status


def test_a_plivo_number_missing_credentials_is_incomplete(store, monkeypatch):
    monkeypatch.delenv("PLIVO_AUTH_TOKEN")
    assert store.list_public()[0]["status"] == "incomplete"


@pytest.mark.parametrize("provider, number, creds", [
    ("nonesuch", "+919800000001", {}),
    ("plivo", "not a number", {"auth_id": "a", "auth_token": "b"}),
    ("plivo", "+919800000001", {"auth_id": "a"}),  # missing auth_token
])
def test_bad_numbers_are_refused(store, provider, number, creds):
    with pytest.raises(ValueError):
        store.add(provider, number, "", creds)


def test_the_same_number_cannot_be_added_twice(store):
    with pytest.raises(ValueError):
        store.add("plivo", "8065520552", "", {"auth_id": "a", "auth_token": "b"})


def test_editing_with_a_blank_secret_keeps_the_old_one(store):
    row = store.add("plivo", "+919800000001", "Second", {"auth_id": "MA2", "auth_token": "tok-2"})
    store.update(row["id"], label="Renamed", credentials={"auth_id": "MA3", "auth_token": ""})
    assert store.credentials(row["id"]) == {"auth_id": "MA3", "auth_token": "tok-2"}
    assert next(r for r in store.list_public() if r["id"] == row["id"])["label"] == "Renamed"


def test_a_token_saved_here_wins_over_env(store):
    ours = store.list_public()[0]["id"]
    assert store.credentials(ours) == {"auth_id": "MAENVID", "auth_token": "env-token-9999"}
    store.update(ours, credentials={"auth_token": "rotated-token"})
    assert store.credentials(ours)["auth_token"] == "rotated-token"
    assert numbers_store.plivo_credentials(store) == ("MAENVID", "rotated-token")


def test_delete_and_default(store):
    row = store.add("plivo", "+919800000001", "", {"auth_id": "a", "auth_token": "b"})
    store.set_default(row["id"])
    assert [r["is_default"] for r in store.list_public()] == [False, True]
    store.delete(row["id"])
    assert [r["number"] for r in store.list_public()] == [OURS]
    with pytest.raises(KeyError):
        store.delete("nope")


def test_a_deleted_env_number_stays_deleted(store):
    store.delete(store.list_public()[0]["id"])
    assert store.list_public() == []
    assert numbers_store.plivo_credentials(store) == ("MAENVID", "env-token-9999")


def test_the_phone_server_uses_the_token_saved_here(store, monkeypatch):
    import server

    monkeypatch.setenv("NUMBER_STORE_PATH", str(store.path))
    ours = store.list_public()[0]["id"]
    store.update(ours, credentials={"auth_token": "rotated-token"})
    assert server.plivo_auth() == ("MAENVID", "rotated-token")


def test_with_no_number_in_env_nothing_is_written(tmp_path, monkeypatch):
    # Otherwise a run without .env would save an empty list, and our number
    # would never appear once .env was there again.
    monkeypatch.delenv("PLIVO_FROM_NUMBER", raising=False)
    store = numbers_store.NumberStore(tmp_path / "numbers.json")
    assert store.list_public() == []
    assert not store.path.exists()

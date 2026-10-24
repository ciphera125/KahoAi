"""Accounts for the Studio: sign up, sign in, sessions."""

import json
import time

import auth_store
import pytest


@pytest.fixture
def store(tmp_path):
    return auth_store.AuthStore(tmp_path / "users.json")


def owner(store):
    return store.sign_up("Aditya Nair", "Aditya@Example.com", "correct horse", "Kaho AI")


def test_the_first_account_is_the_owner_and_needs_no_invite(store):
    assert store.has_accounts() is False
    user = owner(store)
    assert user["email"] == "aditya@example.com" and user["role"] == "owner"
    assert store.has_accounts() is True


def test_passwords_are_never_stored(store, tmp_path):
    owner(store)
    raw = (tmp_path / "users.json").read_text(encoding="utf-8")
    assert "correct horse" not in raw


def test_sign_in_with_the_right_password_only(store):
    owner(store)
    assert store.check_password("aditya@example.com", "correct horse")["name"] == "Aditya Nair"
    with pytest.raises(auth_store.AuthError):
        store.check_password("aditya@example.com", "wrong password")
    with pytest.raises(auth_store.AuthError):
        store.check_password("nobody@example.com", "correct horse")


@pytest.mark.parametrize("name, email, password", [
    ("", "a@b.co", "longenough"), ("A", "not-an-email", "longenough"), ("A", "a@b.co", "short"),
    ("A", "a@b.co", "x" * 300)])
def test_bad_sign_ups_are_refused(store, name, email, password):
    with pytest.raises(ValueError):
        store.sign_up(name, email, password, "")


def test_later_accounts_need_the_owners_invite_code(store):
    owner(store)
    with pytest.raises(auth_store.AuthError):
        store.sign_up("Ayushi", "ayushi@example.com", "another pass", "")
    with pytest.raises(auth_store.AuthError):
        store.sign_up("Ayushi", "ayushi@example.com", "another pass", "", invite="guess")
    code = store.invite_code()
    member = store.sign_up("Ayushi", "ayushi@example.com", "another pass", "", invite=code)
    assert member["role"] == "member"


def test_an_email_signs_up_once(store):
    owner(store)
    with pytest.raises(ValueError):
        store.sign_up("Again", "aditya@example.com", "another pass", "", invite=store.invite_code())


def test_sessions_last_until_signed_out(store):
    user = owner(store)
    token = store.start_session(user["id"])
    assert store.user_for(token)["id"] == user["id"]
    store.end_session(token)
    assert store.user_for(token) is None


def test_the_session_token_is_not_kept_in_the_file(store, tmp_path):
    user = owner(store)
    token = store.start_session(user["id"])
    assert token not in (tmp_path / "users.json").read_text(encoding="utf-8")


def test_sessions_expire(store, monkeypatch):
    user = owner(store)
    token = store.start_session(user["id"])
    later = time.time() + auth_store.SESSION_SECS + 5
    monkeypatch.setattr(auth_store.time, "time", lambda: later)
    assert store.user_for(token) is None


@pytest.mark.parametrize("token", [None, "", "x", "a" * 5000])
def test_junk_tokens_are_nobody(store, token):
    owner(store)
    assert store.user_for(token) is None


def test_repeated_wrong_passwords_lock_the_account_for_a_while(store):
    owner(store)
    for _ in range(auth_store.MAX_FAILURES):
        with pytest.raises(auth_store.AuthError):
            store.check_password("aditya@example.com", "wrong password")
    with pytest.raises(auth_store.AuthError, match="Too many"):
        store.check_password("aditya@example.com", "correct horse")


def test_public_users_have_no_secrets(store):
    user = owner(store)
    shown = json.dumps(store.public(user["id"]))
    assert "hash" not in shown and "salt" not in shown

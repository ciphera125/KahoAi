"""The prompt saved per phone number, which the admin page writes and calls read."""

import json
import os

import main
import prompt_store
import pytest
import server

NUMBER = "+918065520552"


@pytest.fixture
def store(tmp_path):
    return prompt_store.PromptStore(tmp_path / "number_prompts.json")


@pytest.mark.parametrize(
    "raw", ["8065520552", "+91 80655 20552", "08065520552", "+918065520552", "91-8065520552"]
)
def test_numbers_are_normalised_to_e164(raw):
    assert prompt_store.normalize_number(raw) == NUMBER


@pytest.mark.parametrize("raw", ["", "abc", "123", "+1234567890123456789"])
def test_a_bad_number_is_refused(raw):
    with pytest.raises(ValueError):
        prompt_store.normalize_number(raw)


def test_save_then_load(store):
    store.set("8065520552", "You are Riya from Acme.")
    saved = store.get(NUMBER)
    assert saved["prompt"] == "You are Riya from Acme."
    assert saved["updated_at"]


def test_an_unsaved_number_has_no_prompt(store):
    assert store.get(NUMBER) is None


def test_delete_reverts_to_nothing(store):
    store.set(NUMBER, "x")
    store.delete(NUMBER)
    assert store.get(NUMBER) is None


@pytest.mark.parametrize("prompt", ["", "   \n "])
def test_an_empty_prompt_is_refused(store, prompt):
    with pytest.raises(ValueError):
        store.set(NUMBER, prompt)


def test_an_overlong_prompt_is_refused(store):
    # Every character is re-sent to the LLM on every turn of every call.
    with pytest.raises(ValueError):
        store.set(NUMBER, "x" * (prompt_store.MAX_PROMPT_CHARS + 1))


def test_a_failed_write_leaves_the_old_prompt(store, monkeypatch):
    store.set(NUMBER, "old")

    def broken_replace(src, dst):
        raise OSError("disk full")

    monkeypatch.setattr(prompt_store.os, "replace", broken_replace)
    with pytest.raises(OSError):
        store.set(NUMBER, "new")
    monkeypatch.setattr(prompt_store.os, "replace", os.replace)
    assert store.get(NUMBER)["prompt"] == "old"


def test_a_corrupt_file_reads_as_empty_and_is_not_overwritten(store):
    store.path.write_text("{not json", encoding="utf-8")
    assert store.get(NUMBER) is None
    with pytest.raises(ValueError):
        store.set(NUMBER, "x")
    assert store.path.read_text(encoding="utf-8") == "{not json"


def test_the_file_is_plain_json_keyed_by_number(store):
    store.set(NUMBER, "hello")
    assert list(json.loads(store.path.read_text(encoding="utf-8"))) == [NUMBER]


# --- at call time ----------------------------------------------------------


def test_a_saved_prompt_becomes_the_persona(monkeypatch, tmp_path):
    monkeypatch.setenv("PROMPT_STORE_PATH", str(tmp_path / "p.json"))
    monkeypatch.setenv("PLIVO_FROM_NUMBER", NUMBER)
    prompt_store.default_store().set(NUMBER, "You are Riya from Acme.")
    assert prompt_store.prompt_for_our_number() == "You are Riya from Acme."


def test_no_saved_prompt_means_the_default(monkeypatch, tmp_path):
    monkeypatch.setenv("PROMPT_STORE_PATH", str(tmp_path / "p.json"))
    monkeypatch.setenv("PLIVO_FROM_NUMBER", NUMBER)
    assert prompt_store.prompt_for_our_number() is None


def test_a_broken_store_never_breaks_a_call(monkeypatch, tmp_path):
    path = tmp_path / "p.json"
    path.write_text("{not json", encoding="utf-8")
    monkeypatch.setenv("PROMPT_STORE_PATH", str(path))
    monkeypatch.setenv("PLIVO_FROM_NUMBER", NUMBER)
    assert prompt_store.prompt_for_our_number() is None
    monkeypatch.setenv("PLIVO_FROM_NUMBER", "not a number")
    assert prompt_store.prompt_for_our_number() is None


def test_persona_text_wins_and_voice_rules_still_lead():
    system = main.load_system_prompt(persona_text="You are Riya from Acme.")
    assert system.startswith(main.VOICE_RULES)
    assert system.endswith("You are Riya from Acme.")


def test_the_phone_server_reads_the_store_for_every_call(monkeypatch, tmp_path):
    monkeypatch.setenv("PROMPT_STORE_PATH", str(tmp_path / "p.json"))
    monkeypatch.setenv("PLIVO_FROM_NUMBER", NUMBER)
    assert server.persona_text_for_call() is None
    prompt_store.default_store().set(NUMBER, "Version 2")
    assert server.persona_text_for_call() == "Version 2"


# --- versions ----------------------------------------------------------------


def test_every_save_is_a_version_newest_first(store):
    store.set(NUMBER, "v1")
    store.set(NUMBER, "v2")
    assert [v["prompt"] for v in store.versions(NUMBER)] == ["v2", "v1"]


def test_restoring_a_version_makes_it_current_and_a_new_version(store):
    store.set(NUMBER, "v1")
    store.set(NUMBER, "v2")
    old = store.versions(NUMBER)[1]
    store.restore_version(NUMBER, old["id"])
    assert store.get(NUMBER)["prompt"] == "v1"
    assert [v["prompt"] for v in store.versions(NUMBER)] == ["v1", "v2", "v1"]


def test_deleting_a_version_keeps_the_current_prompt(store):
    store.set(NUMBER, "v1")
    store.set(NUMBER, "v2")
    store.delete_version(NUMBER, store.versions(NUMBER)[1]["id"])
    assert [v["prompt"] for v in store.versions(NUMBER)] == ["v2"]
    assert store.get(NUMBER)["prompt"] == "v2"
    with pytest.raises(KeyError):
        store.delete_version(NUMBER, "nope")


def test_reverting_to_default_keeps_the_history(store):
    store.set(NUMBER, "v1")
    store.delete(NUMBER)
    assert store.get(NUMBER) is None
    assert [v["prompt"] for v in store.versions(NUMBER)] == ["v1"]


def test_a_prompt_saved_before_versions_existed_counts_as_one(store):
    store.path.write_text(json.dumps({NUMBER: {"prompt": "old", "updated_at": "2026-10-24"}}))
    assert [v["prompt"] for v in store.versions(NUMBER)] == ["old"]


def test_history_is_capped(store):
    for i in range(prompt_store.MAX_VERSIONS + 5):
        store.set(NUMBER, f"v{i}")
    assert len(store.versions(NUMBER)) == prompt_store.MAX_VERSIONS

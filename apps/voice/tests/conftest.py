import pytest


@pytest.fixture(autouse=True)
def _local_data_files(tmp_path, monkeypatch):
    """Keep every test away from the real data/ folder.

    The phone server reads saved prompts and numbers on every call; a test that
    drives a call without this once wrote an empty numbers file over the real one
    (2026-10-24). Tests that need a store still set their own paths.
    """
    monkeypatch.setenv("NUMBER_STORE_PATH", str(tmp_path / "_numbers.json"))
    monkeypatch.setenv("PROMPT_STORE_PATH", str(tmp_path / "_number_prompts.json"))
    monkeypatch.setenv("CONTACT_STORE_PATH", str(tmp_path / "_contacts.json"))
    monkeypatch.setenv("CALL_LOG_DIR", str(tmp_path / "_calls"))
    monkeypatch.setenv("AGENT_STORE_PATH", str(tmp_path / "_agents.json"))
    monkeypatch.setenv("USER_STORE_PATH", str(tmp_path / "_users.json"))
    monkeypatch.setenv("ACTIVITY_PATH", str(tmp_path / "_activity.jsonl"))
    monkeypatch.setenv("OUTCOME_LOG_PATH", str(tmp_path / "_outcomes.jsonl"))
    monkeypatch.setenv("CALL_INDEX_PATH", str(tmp_path / "_call_index.json"))

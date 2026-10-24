"""Agents and their prompts: what the Studio's Agents and Prompts pages edit and calls read."""

import json

import agents_store
import pytest
import tools

NUMBER = "+918065520552"


@pytest.fixture
def store(tmp_path):
    return agents_store.AgentStore(tmp_path / "agents.json")


def test_creating_an_agent_gives_it_its_own_prompt_in_use(store):
    agent = store.create_agent("Reminder bot", "EMI reminders", "You are Riya from Acme.")
    assert agent["name"] == "Reminder bot" and agent["description"] == "EMI reminders"
    prompt = store.get_prompt(agent["active_prompt_id"])
    assert prompt["agent_id"] == agent["id"]
    assert prompt["prompt"] == "You are Riya from Acme."
    assert prompt["name"] == "Reminder bot prompt"
    assert agent["tools"] == ["end_call", "capture_lead"]


@pytest.mark.parametrize("name, prompt", [("", "x"), ("a" * 61, "x"), ("Bot", ""),
                                          ("Bot", "x" * (agents_store.MAX_PROMPT_CHARS + 1))])
def test_bad_agents_are_refused(store, name, prompt):
    with pytest.raises(ValueError):
        store.create_agent(name, "", prompt)


def test_every_prompt_edit_is_a_version_and_restore_and_delete_work(store):
    agent = store.create_agent("Bot", "", "v1")
    pid = agent["active_prompt_id"]
    store.update_prompt(pid, text="v2")
    versions = store.versions(pid)
    assert [v["prompt"] for v in versions] == ["v2", "v1"]
    store.restore_version(pid, versions[1]["id"])
    assert store.get_prompt(pid)["prompt"] == "v1"
    assert len(store.versions(pid)) == 3
    with pytest.raises(ValueError):  # the version in use cannot be deleted
        store.delete_version(pid, store.versions(pid)[0]["id"])
    store.delete_version(pid, store.versions(pid)[2]["id"])
    assert [v["prompt"] for v in store.versions(pid)] == ["v1", "v2"]


def test_saving_the_same_text_is_not_a_new_version(store):
    pid = store.create_agent("Bot", "", "same")["active_prompt_id"]
    store.update_prompt(pid, text="same")
    assert len(store.versions(pid)) == 1


def test_renaming_a_prompt_keeps_its_text(store):
    pid = store.create_agent("Bot", "", "text")["active_prompt_id"]
    store.update_prompt(pid, name="EMI reminder, Hindi")
    assert store.get_prompt(pid) == {**store.get_prompt(pid), "name": "EMI reminder, Hindi",
                                     "prompt": "text"}


def test_the_prompt_list_names_the_agent_and_counts_versions(store):
    a = store.create_agent("Bot", "", "v1")
    store.update_prompt(a["active_prompt_id"], text="v2")
    row = store.list_prompts()[0]
    assert row["agent_name"] == "Bot" and row["version_count"] == 2 and row["in_use"] is True


def test_reassigning_a_prompt_moves_it_and_fixes_both_agents(store):
    a = store.create_agent("A", "", "for A")
    b = store.create_agent("B", "", "for B")
    store.assign_prompt(a["active_prompt_id"], b["id"])
    moved = store.get_prompt(a["active_prompt_id"])
    assert moved["agent_id"] == b["id"]
    assert store.get_agent(a["id"])["active_prompt_id"] is None  # A lost its only prompt
    assert store.get_agent(b["id"])["active_prompt_id"] == b["active_prompt_id"]  # B unchanged


def test_an_agent_can_switch_which_of_its_prompts_is_used(store):
    a = store.create_agent("A", "", "first")
    second = store.create_prompt("Second", "second", a["id"])
    store.update_agent(a["id"], active_prompt_id=second["id"])
    assert store.call_config(a["id"])["prompt"] == "second"
    other = store.create_agent("B", "", "b")
    with pytest.raises(ValueError):  # only one of its own prompts
        store.update_agent(a["id"], active_prompt_id=other["active_prompt_id"])


def test_deleting_the_prompt_in_use_falls_back_to_another_of_the_agents(store):
    a = store.create_agent("A", "", "first")
    second = store.create_prompt("Second", "second", a["id"])
    store.delete_prompt(a["active_prompt_id"])
    assert store.get_agent(a["id"])["active_prompt_id"] == second["id"]


def test_deleting_an_agent_keeps_its_prompts_unassigned_and_drops_its_numbers(store):
    a = store.create_agent("A", "", "text")
    store.route_number(NUMBER, a["id"])
    store.delete_agent(a["id"])
    assert store.get_prompt(a["active_prompt_id"])["agent_id"] is None
    assert store.agent_for_number(NUMBER) is None


def test_tools_must_be_known(store):
    a = store.create_agent("A", "", "text")
    store.update_agent(a["id"], tools=["end_call"])
    assert store.get_agent(a["id"])["tools"] == ["end_call"]
    with pytest.raises(ValueError):
        store.update_agent(a["id"], tools=["rm_rf"])


def test_known_tools_match_the_registry():
    assert set(agents_store.KNOWN_TOOLS) == set(tools.REGISTRY)


@pytest.mark.parametrize("settings", [{"max_minutes": 0}, {"max_minutes": 999},
                                      {"ring_secs": 5}, {"ring_secs": 500},
                                      {"opening_line": "x" * 201}, {"max_minutes": "ten"}])
def test_bad_call_settings_are_refused(store, settings):
    a = store.create_agent("A", "", "text")
    with pytest.raises(ValueError):
        store.update_agent(a["id"], settings=settings)


def test_call_config_is_what_a_call_needs(store):
    a = store.create_agent("A", "", "You are A.")
    store.update_agent(a["id"], tools=["end_call"],
                       settings={"opening_line": "Hi, Riya here.", "max_minutes": 3,
                                 "ring_secs": 30})
    cfg = store.call_config(a["id"])
    assert cfg == {"agent_id": a["id"], "name": "A", "prompt": "You are A.",
                   "tools": ["end_call"], "opening_line": "Hi, Riya here.",
                   "max_secs": 180.0, "ring_secs": 30}


@pytest.mark.parametrize("agent_id", [None, "", "../../.env", "ag_doesnotexist", 5])
def test_call_config_never_raises(store, agent_id):
    assert store.call_config(agent_id) is None


def test_a_corrupt_file_never_breaks_a_call(tmp_path):
    path = tmp_path / "agents.json"
    path.write_text("{oops", encoding="utf-8")
    s = agents_store.AgentStore(path)
    assert s.call_config("ag_000000000000") is None
    assert s.agent_for_number(NUMBER) is None
    with pytest.raises(ValueError):
        s.create_agent("A", "", "x")
    assert path.read_text(encoding="utf-8") == "{oops"


def test_numbers_route_to_agents(store):
    a = store.create_agent("A", "", "x")
    store.route_number("8065520552", a["id"])
    assert store.agent_for_number(NUMBER) == a["id"]
    store.route_number(NUMBER, None)
    assert store.agent_for_number(NUMBER) is None
    with pytest.raises(KeyError):
        store.route_number(NUMBER, "ag_000000000000")


def test_the_old_per_number_prompt_becomes_an_agent_with_its_history(tmp_path):
    legacy = tmp_path / "number_prompts.json"
    legacy.write_text(json.dumps({NUMBER: {
        "prompt": "new", "updated_at": "2026-10-24T10:00:00+00:00",
        # The old store keeps versions oldest first.
        "versions": [{"id": "a", "prompt": "old", "saved_at": "2026-10-23T10:00:00+00:00"},
                     {"id": "b", "prompt": "new", "saved_at": "2026-10-24T10:00:00+00:00"}]}}))
    s = agents_store.AgentStore(tmp_path / "agents.json", legacy_path=legacy)
    (agent,) = s.list_agents()
    assert s.agent_for_number(NUMBER) == agent["id"]
    assert [v["prompt"] for v in s.versions(agent["active_prompt_id"])] == ["new", "old"]
    # Done once: a second store reads the same agents, it does not migrate again.
    assert len(agents_store.AgentStore(tmp_path / "agents.json", legacy_path=legacy)
               .list_agents()) == 1


def test_setting_errors_are_in_plain_words(store):
    a = store.create_agent("A", "", "text")
    with pytest.raises(ValueError, match="Longest call"):
        store.update_agent(a["id"], settings={"max_minutes": 99})

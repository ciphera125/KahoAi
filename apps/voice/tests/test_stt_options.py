"""What is sent to Deepgram when a call's speech recognition connects.

Four things ride on the connection (2026-11-22): the words this agent should listen for
(keyterm), a nudge towards the languages callers speak (language_hint), and two labels that
make Deepgram's usage reports split by customer (tag, extra). A bad value in any of them can
make Deepgram refuse the whole connection (the call would then have no ears), so every value
is checked here before it is sent, and a bad one is dropped, never sent.
"""

import pytest
import stt_options

# ---- keyterms ----


def test_a_list_of_words_stays_a_list_of_words():
    words = ["Dr. Mehta", "Apollo Clinic"]
    assert stt_options.clean_keyterms(words) == words


def test_blank_duplicate_and_non_text_entries_are_dropped():
    raw = ["Mehta", "  ", "mehta", "Mehta ", 7, None, {"a": 1}, ["x"], "Apollo"]
    assert stt_options.clean_keyterms(raw) == ["Mehta", "Apollo"]


@pytest.mark.parametrize(
    "bad", ["one, two", "one;two", "one\ntwo", "one\rtwo", "one\x00two", "term:0.5"])
def test_a_word_deepgram_would_read_wrongly_is_dropped(bad):
    # Commas, semicolons and line breaks are not separators for Deepgram: they would be one
    # literal "word" that boosts nothing. A weight ("term:0.15") is read the same way.
    assert stt_options.clean_keyterms([bad, "Mehta"]) == ["Mehta"]


def test_a_very_long_word_is_dropped_and_the_list_is_capped():
    long_one = "x" * (stt_options.MAX_KEYTERM_CHARS + 1)
    assert stt_options.clean_keyterms([long_one, "ok"]) == ["ok"]
    many = [f"word{i}" for i in range(stt_options.MAX_KEYTERMS + 20)]
    assert len(stt_options.clean_keyterms(many)) == stt_options.MAX_KEYTERMS


def test_something_that_is_not_a_list_gives_nothing():
    for raw in (None, 5, {"a": "b"}, True):
        assert stt_options.clean_keyterms(raw) == []


def test_a_single_string_is_one_comma_separated_list_like_the_env_setting():
    parsed = stt_options.keyterms_from_text("Kaho, Kaho AI ,, Aayushi")
    assert parsed == ["Kaho", "Kaho AI", "Aayushi"]
    assert stt_options.keyterms_from_text("") == []
    assert stt_options.keyterms_from_text(None) == []


def test_the_agents_own_words_come_first_then_the_global_ones_without_repeats():
    merged = stt_options.merge_keyterms(["Dr. Mehta", "kaho"], ["Kaho", "Kaho AI"])
    assert merged == ["Dr. Mehta", "kaho", "Kaho AI"]


def test_the_merged_list_stays_under_the_token_budget_and_keeps_the_agents_words_first():
    agent = [f"agent term number {i}" for i in range(40)]
    globals_ = [f"global term number {i}" for i in range(40)]
    merged = stt_options.merge_keyterms(agent, globals_)
    assert sum(stt_options.estimate_tokens(t) for t in merged) <= stt_options.KEYTERM_TOKEN_BUDGET
    assert merged[0] == "agent term number 0"
    assert "global term number 39" not in merged


def test_the_token_estimate_never_undercounts_indian_scripts():
    # Deepgram refuses a connection over 500 tokens. Devanagari costs about a token a
    # character, so it must never be counted like short English words.
    assert stt_options.estimate_tokens("नमस्ते") >= 6
    assert stt_options.estimate_tokens("Kaho") >= 2


# ---- language hints ----


def test_the_default_hint_is_hindi_and_english():
    assert stt_options.language_hints(None) == ["hi", "en"]
    assert stt_options.language_hints("") == ["hi", "en"]


def test_the_hints_can_be_set_or_switched_off():
    assert stt_options.language_hints("hi, ta ,en") == ["hi", "ta", "en"]
    assert stt_options.language_hints("off") == []
    assert stt_options.language_hints("OFF") == []


def test_a_code_deepgram_does_not_know_is_dropped_because_it_would_end_the_call():
    # An unknown hint is an HTTP 400 on the websocket: the call would have no speech recognition.
    assert stt_options.language_hints("hi,klingon,en") == ["hi", "en"]
    assert stt_options.language_hints("klingon") == []
    assert stt_options.language_hints("hi&model=x") == []
    assert stt_options.language_hints("hi,hi,HI") == ["hi"]


def test_a_locale_deepgram_lists_is_kept_in_its_listed_form():
    assert stt_options.language_hints("en-IN,zh-hk") == ["en-IN", "zh-HK"]


# ---- the labels ----


def test_the_tag_names_the_organization_and_nothing_personal():
    # Organization ids are "org_" and twelve hex characters: opaque, so no name leaves the building.
    assert stt_options.usage_tag("org_8f2a91c4d0e7") == "org_8f2a91c4d0e7"
    assert stt_options.usage_tag(None) is None


@pytest.mark.parametrize("bad", ["", "a b", "x&tag=y", "a" * 200, "名前", "x\ny", "../x"])
def test_an_id_that_could_alter_the_request_gives_no_tag(bad):
    assert stt_options.usage_tag(bad) is None


def test_extra_carries_the_call_and_agent_ids():
    assert stt_options.usage_extra("call-123", "ag_abc") == ["call_id:call-123", "agent_id:ag_abc"]
    assert stt_options.usage_extra(None, "ag_abc") == ["agent_id:ag_abc"]
    assert stt_options.usage_extra(None, None) == []


@pytest.mark.parametrize("bad", ["a b", "x&extra=y", "a:b", "a" * 200, "x\ny"])
def test_extra_never_carries_an_id_that_could_alter_the_request(bad):
    assert stt_options.usage_extra(bad, bad) == []

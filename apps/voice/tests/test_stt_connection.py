"""How the call's speech recognition is connected to Deepgram (2026-11-22).

The agent's own keyterms, language hints, the organization tag and the call labels must reach
the connection exactly, and nothing a caller or an agent author types may add a parameter to it.
The last test builds the real URL the Deepgram SDK would open, since the SDK's `connect()` has
no `language_hint` argument of its own and a wrong guess there is a TypeError on every call.
"""

from urllib.parse import parse_qs, urlparse

import deepgram.listen.v1.client as sdk_client
import main
import pytest
import stt_options

ORG = "org_8f2a91c4d0e7"


@pytest.fixture(autouse=True)
def _deepgram_env(monkeypatch):
    monkeypatch.setenv("DEEPGRAM_API_KEY", "test-key-not-real")
    monkeypatch.setenv("DEEPGRAM_MODEL", "nova-3")
    monkeypatch.setenv("DEEPGRAM_LANGUAGE", "multi")
    monkeypatch.setenv("DEEPGRAM_KEYTERMS", "Kaho,Kaho AI")
    monkeypatch.delenv("DEEPGRAM_LANGUAGE_HINTS", raising=False)


def kwargs_for(**options):
    return main.build_stt(**options)._build_connect_kwargs()


def test_the_agents_keyterms_come_before_the_deployments():
    kw = kwargs_for(keyterms=["Dr. Mehta", "Apollo Clinic"])
    assert kw["keyterm"] == ["Dr. Mehta", "Apollo Clinic", "Kaho", "Kaho AI"]


def test_with_no_agent_keyterms_the_deployments_words_still_go():
    assert kwargs_for()["keyterm"] == ["Kaho", "Kaho AI"]
    assert kwargs_for(keyterms=[])["keyterm"] == ["Kaho", "Kaho AI"]


def test_with_no_words_at_all_no_keyterm_is_sent(monkeypatch):
    monkeypatch.setenv("DEEPGRAM_KEYTERMS", "")
    assert "keyterm" not in kwargs_for()


def test_a_huge_list_is_cut_so_deepgram_never_refuses_the_connection():
    many = [f"clinic doctor name {i}" for i in range(500)]
    sent = kwargs_for(keyterms=many)["keyterm"]
    assert sum(stt_options.estimate_tokens(t) for t in sent) <= stt_options.KEYTERM_TOKEN_BUDGET


def test_hostile_keyterms_are_dropped_not_sent():
    sent = kwargs_for(keyterms=["ok one", "a,b", "x\ny", "t:0.9", 5, None])["keyterm"]
    assert sent[0] == "ok one"
    assert not any(c in t for t in sent for c in ",;\n:")


def test_the_call_carries_the_organization_tag_and_the_call_labels():
    kw = kwargs_for(org_id=ORG, agent_id="ag_6d26dca7bd61", call_id="c-1")
    assert kw["tag"] == ORG
    assert kw["extra"] == ["call_id:c-1", "agent_id:ag_6d26dca7bd61"]


def test_an_unsafe_id_adds_nothing_to_the_connection():
    kw = kwargs_for(org_id="x&model=nova-2", agent_id="a b", call_id="../../c")
    assert "tag" not in kw
    assert "extra" not in kw
    assert kw["model"] == "nova-3"


def test_no_ids_means_no_labels():
    kw = kwargs_for()
    assert "tag" not in kw and "extra" not in kw


def test_hindi_and_english_hints_are_sent_with_the_multilingual_setting():
    kw = kwargs_for()
    extra = kw["request_options"]["additional_query_parameters"]
    assert extra["language_hint"] == ["hi", "en"]


def test_hints_follow_the_setting_and_can_be_switched_off(monkeypatch):
    monkeypatch.setenv("DEEPGRAM_LANGUAGE_HINTS", "hi,ta")
    hints = kwargs_for()["request_options"]["additional_query_parameters"]["language_hint"]
    assert hints == ["hi", "ta"]
    monkeypatch.setenv("DEEPGRAM_LANGUAGE_HINTS", "off")
    assert "language_hint" not in kwargs_for()["request_options"]["additional_query_parameters"]


def test_a_bad_hint_in_the_setting_never_reaches_deepgram(monkeypatch):
    monkeypatch.setenv("DEEPGRAM_LANGUAGE_HINTS", "hi,klingon")
    assert kwargs_for()["request_options"]["additional_query_parameters"]["language_hint"] == ["hi"]


def test_hints_are_not_sent_when_the_language_is_pinned(monkeypatch):
    # Deepgram ignores them unless language=multi; sending them would only be noise.
    monkeypatch.setenv("DEEPGRAM_LANGUAGE", "en")
    assert "language_hint" not in kwargs_for()["request_options"]["additional_query_parameters"]


def test_what_was_already_sent_is_still_sent():
    kw = kwargs_for()
    assert kw["model"] == "nova-3" and kw["language"] == "multi"
    assert kw["smart_format"] == "true" and kw["numerals"] == "true"


async def test_the_real_url_carries_every_parameter_once_each(monkeypatch):
    seen = {}

    class FakeSocket:
        async def __aenter__(self):
            return object()

        async def __aexit__(self, *exc):
            return False

    def fake_connect(url, **kw):
        seen["url"] = url
        return FakeSocket()

    monkeypatch.setattr(sdk_client, "websockets_client_connect", fake_connect)
    stt = main.build_stt(keyterms=["Dr. Mehta"], org_id=ORG, agent_id="ag_x1", call_id="c-9")
    async with stt._client.listen.v1.connect(**stt._build_connect_kwargs()):
        pass
    query = parse_qs(urlparse(seen["url"]).query)
    assert query["language_hint"] == ["hi", "en"]
    assert query["keyterm"] == ["Dr. Mehta", "Kaho", "Kaho AI"]
    assert query["tag"] == [ORG]
    assert query["extra"] == ["call_id:c-9", "agent_id:ag_x1"]
    assert query["model"] == ["nova-3"] and query["language"] == ["multi"]
    assert query["redact_usage"] == ["true"]


async def test_a_keyterm_cannot_add_a_parameter_to_the_connection(monkeypatch):
    # Pen-test, 2026-11-22: terms that look like query-string syntax stay one literal word each.
    seen = {}

    class FakeSocket:
        async def __aenter__(self):
            return object()

        async def __aexit__(self, *exc):
            return False

    def fake_connect(url, **kw):
        seen["url"] = url
        return FakeSocket()

    monkeypatch.setattr(sdk_client, "websockets_client_connect", fake_connect)
    hostile = ["&language_hint=klingon", "&model=nova-2&", "a=b#c", "%0d%0aHost: evil",
               "x&tag=other_org"]
    stt = main.build_stt(keyterms=hostile, org_id=ORG, agent_id="ag_x1", call_id="c-9")
    async with stt._client.listen.v1.connect(**stt._build_connect_kwargs()):
        pass
    query = parse_qs(urlparse(seen["url"]).query)
    # Pipecat's own parameters plus ours; nothing a keyterm said.
    pipecat_own = {"detect_entities", "diarize", "dictation", "interim_results", "punctuate",
                   "encoding", "channels", "multichannel", "sample_rate"}
    ours = {"model", "language", "smart_format", "numerals", "keyterm", "tag", "extra",
            "language_hint", "redact_usage"}
    assert set(query) == pipecat_own | ours
    assert query["model"] == ["nova-3"] and query["tag"] == [ORG]
    assert query["language_hint"] == ["hi", "en"]
    assert query["keyterm"][:5] == hostile


def test_the_words_are_kept_out_of_deepgrams_usage_records():
    # Deepgram's usage records show keyterms unless redact_usage is set, and a customer may
    # list the names of doctors or patients there (security pass, 2026-11-22).
    extra = kwargs_for(keyterms=["Dr. Mehta"])["request_options"]["additional_query_parameters"]
    assert extra["redact_usage"] == "true"


def test_it_is_set_whatever_else_is_switched_off(monkeypatch):
    monkeypatch.setenv("DEEPGRAM_LANGUAGE_HINTS", "off")
    monkeypatch.setenv("DEEPGRAM_LANGUAGE", "en")
    extra = kwargs_for()["request_options"]["additional_query_parameters"]
    assert extra == {"redact_usage": "true"}

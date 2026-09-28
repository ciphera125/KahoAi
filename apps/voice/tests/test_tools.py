import asyncio
import json
from types import SimpleNamespace

import pytest
import tools
from transcript import CallTranscript


@pytest.fixture
def registry(monkeypatch):
    """An isolated registry, so tests neither see nor leave behind tools."""
    monkeypatch.setattr(tools, "REGISTRY", {})
    return tools.REGISTRY


def make_call(tmp_path):
    transcript = CallTranscript("t1", tmp_path)
    return tools.CallContext(call_id="t1", transcript=transcript), transcript


def params(**arguments):
    got = []

    async def result_callback(result, **kw):
        got.append(result)

    return SimpleNamespace(arguments=arguments, result_callback=result_callback), got


def rows(transcript):
    return [json.loads(x) for x in transcript.path.read_text(encoding="utf-8").splitlines()]


async def run(schemas, name, p):
    schema = next(s for s in schemas if s.name == name)
    await schema.handler(p)


async def test_tool_result_reaches_the_model_and_the_audit_log(registry, tmp_path):
    @tools.tool("add", "Add.", {"a": {"type": "integer"}}, ["a"])
    async def add(args, call):
        return {"sum": args["a"] + 1}

    call, transcript = make_call(tmp_path)
    schemas = tools.build_tool_schemas(call, ["add"])
    p, got = params(a=1)
    await run(schemas, "add", p)
    assert got == [{"sum": 2}]
    logged = [r for r in rows(transcript) if r["event"] == "tool"]
    assert logged[0]["name"] == "add"
    assert json.loads(logged[0]["text"]) == {"args": {"a": 1}, "result": {"sum": 2}}


async def test_sensitive_numbers_in_tool_traffic_are_masked_on_disk(registry, tmp_path):
    @tools.tool("verify", "Verify an id.", {"id": {"type": "string"}}, ["id"])
    async def verify(args, call):
        return {"checked": args["id"]}

    call, transcript = make_call(tmp_path)
    schemas = tools.build_tool_schemas(call, ["verify"])
    p, got = params(id="234567891234")
    await run(schemas, "verify", p)
    transcript.end()
    assert "234567891234" not in transcript.path.read_text(encoding="utf-8")
    assert got == [{"checked": "234567891234"}]  # the model still gets the real value


async def test_slow_tool_is_cut_off_and_reported_as_an_error(registry, tmp_path):
    @tools.tool("slow", "Slow.")
    async def slow(args, call):
        await asyncio.sleep(5)
        return {}

    call, _ = make_call(tmp_path)
    schemas = tools.build_tool_schemas(call, ["slow"], timeout=0.05)
    p, got = params()
    await run(schemas, "slow", p)
    assert "error" in got[0] and "too long" in got[0]["error"]


async def test_crashing_tool_never_raises_into_the_llm_service(registry, tmp_path):
    @tools.tool("boom", "Boom.")
    async def boom(args, call):
        raise RuntimeError("db down at 10.0.0.5")

    call, _ = make_call(tmp_path)
    schemas = tools.build_tool_schemas(call, ["boom"])
    p, got = params()
    await run(schemas, "boom", p)
    assert "error" in got[0]
    assert "10.0.0.5" not in json.dumps(got[0])  # internals are not read to the caller


def test_unknown_tool_name_fails_loudly(registry, tmp_path):
    call, _ = make_call(tmp_path)
    with pytest.raises(ValueError, match="nope"):
        tools.build_tool_schemas(call, ["nope"])


def test_duplicate_registration_is_rejected(registry):
    tools.tool("dup", "x")(lambda a, c: None)
    with pytest.raises(ValueError):
        tools.tool("dup", "y")(lambda a, c: None)


def test_default_is_end_call_only():
    assert tools.enabled_names(None) == ["end_call"]
    assert tools.enabled_names(" a , b ,") == ["a", "b"]


async def test_end_call_hangs_up(tmp_path):
    call, _ = make_call(tmp_path)
    hung = []

    async def hang_up():
        hung.append(True)

    call.hang_up = hang_up
    schemas = tools.build_tool_schemas(call, ["end_call"])
    p, got = params()
    await run(schemas, "end_call", p)
    assert hung and got == [{"status": "ending"}]


async def test_end_call_without_a_hangup_hook_says_so(tmp_path):
    call, _ = make_call(tmp_path)
    schemas = tools.build_tool_schemas(call, ["end_call"])
    p, got = params()
    await run(schemas, "end_call", p)
    assert "error" in got[0]

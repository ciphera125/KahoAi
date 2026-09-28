"""Tools the agent can call mid-conversation.

Adding one is a single decorated function:

    @tool(
        "check_slot",
        "Check whether an appointment slot is free.",
        properties={"day": {"type": "string", "description": "e.g. 'Monday'"}},
        required=["day"],
    )
    async def check_slot(args: dict, call: "CallContext") -> dict:
        return {"free": True}

It is then switched on per deployment by naming it in TOOLS_ENABLED. What a tool
does is code; when the agent should use it belongs in the persona file, which
also keeps VOICE_RULES short.

Every call goes through one wrapper, so each tool gets the same guarantees
without having to remember them:
- a deadline (TOOL_TIMEOUT_SECS): the caller is on the line in silence while a
  tool runs, so a slow one is cut off and reported to the model as an error
  rather than left to hang the call;
- errors are contained: an exception becomes an {"error": ...} result the model
  can explain to the caller, never a crash inside the LLM service;
- both the arguments and the result are written to the call transcript, which
  masks Aadhaar and PAN, so tool traffic obeys the same storage rule as speech.
"""

import asyncio
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

from loguru import logger
from pipecat.adapters.schemas.function_schema import FunctionSchema
from pipecat.services.llm_service import FunctionCallParams

DEFAULT_TIMEOUT_SECS = 8.0

ToolHandler = Callable[[dict, "CallContext"], Awaitable[dict]]


@dataclass
class CallContext:
    """What a tool can see of the call it is running in."""

    call_id: str
    transcript: Any = None
    # Set by whoever builds the pipeline: ends the call once queued speech is done.
    hang_up: Callable[[], Awaitable[None]] | None = None
    # Room for per-call state a deployment's tools want to share (a looked-up
    # customer, a chosen slot) without reaching for globals.
    state: dict = field(default_factory=dict)


@dataclass
class Tool:
    name: str
    description: str
    properties: dict
    required: list[str]
    handler: ToolHandler


REGISTRY: dict[str, Tool] = {}


def tool(name: str, description: str, properties: dict | None = None, required=None):
    """Register an async function as a tool the model may call."""

    def decorate(fn: ToolHandler) -> ToolHandler:
        if name in REGISTRY:
            raise ValueError(f"tool {name!r} is already registered")
        REGISTRY[name] = Tool(name, description, properties or {}, list(required or []), fn)
        return fn

    return decorate


def _log(call: CallContext, name: str, args: dict, result: dict, seconds: float) -> None:
    if call.transcript is not None:
        call.transcript.tool(name, args, result, seconds)


def _wrap(t: Tool, call: CallContext, timeout: float):
    async def run(params: FunctionCallParams) -> None:
        args = dict(params.arguments or {})
        started = time.monotonic()
        try:
            result = await asyncio.wait_for(t.handler(args, call), timeout)
        except TimeoutError:
            logger.error(f"Tool {t.name} timed out after {timeout}s")
            result = {"error": "the lookup took too long; tell the caller and offer to try again"}
        except Exception as e:
            logger.error(f"Tool {t.name} failed: {e!r}")
            result = {"error": "the tool failed; tell the caller you could not do that"}
        _log(call, t.name, args, result, time.monotonic() - started)
        await params.result_callback(result)

    return run


def enabled_names(raw: str | None) -> list[str]:
    return [n.strip() for n in (raw or "end_call").split(",") if n.strip()]


def build_tool_schemas(
    call: CallContext, names: list[str], timeout: float = DEFAULT_TIMEOUT_SECS
) -> list[FunctionSchema]:
    """Schemas for the named tools, each carrying its wrapped handler."""
    unknown = [n for n in names if n not in REGISTRY]
    if unknown:
        raise ValueError(
            f"TOOLS_ENABLED names unknown tool(s): {', '.join(unknown)}. "
            f"Known: {', '.join(sorted(REGISTRY)) or 'none'}."
        )
    return [
        FunctionSchema(
            name=t.name,
            description=t.description,
            properties=t.properties,
            required=t.required,
            handler=_wrap(t, call, timeout),
        )
        for t in (REGISTRY[n] for n in names)
    ]


@tool(
    "end_call",
    "Hang up. Use only once the caller's needs are met or they say goodbye. "
    "Say a brief goodbye in the same turn.",
)
async def end_call(args: dict, call: CallContext) -> dict:
    # Queued after the goodbye has been spoken, not cut across it.
    if call.hang_up is None:
        return {"error": "this call cannot be ended from here"}
    await call.hang_up()
    return {"status": "ending"}

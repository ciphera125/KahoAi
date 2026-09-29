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
import ipaddress
import json
import os
import re
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import aiohttp
from loguru import logger
from masking import mask_sensitive
from pipecat.adapters.schemas.function_schema import FunctionSchema
from pipecat.services.llm_service import FunctionCallParams

DEFAULT_TIMEOUT_SECS = 8.0

ToolHandler = Callable[[dict, "CallContext"], Awaitable[dict]]


@dataclass
class CallContext:
    """What a tool can see of the call it is running in."""

    call_id: str
    transcript: Any = None
    # The caller's own number from the telephony webhook; None on a local run.
    caller_number: str | None = None
    # Set by whoever builds the pipeline: ends the call once queued speech is done.
    hang_up: Callable[[], Awaitable[None]] | None = None
    # Set by the phone server: hands the live call to a human. None on a local run.
    transfer: Callable[[], Awaitable[None]] | None = None
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
    return [n.strip() for n in (raw or "end_call,capture_lead").split(",") if n.strip()]


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


def leads_dir() -> Path:
    return Path(os.getenv("LEADS_DIR") or Path(__file__).resolve().parent.parent.parent / "leads")


def clean_phone(raw: str | None) -> str | None:
    """Digits with an optional leading +, or None if nothing phone-like is there."""
    raw = (raw or "").strip()
    digits = re.sub(r"\D", "", raw)
    if len(digits) < 7:
        return None
    return ("+" if raw.startswith("+") else "") + digits


@tool(
    "capture_lead",
    "Save a caller's details so a person can follow up. Use it whenever the caller "
    "wants to leave contact information, asks for a callback, or shows interest in "
    "something, as soon as you have their name and what they want, not only at the "
    "end of the call. Read the details back and save only after the caller confirms.",
    properties={
        "name": {"type": "string", "description": "The caller's name."},
        "reason": {
            "type": "string",
            "description": "One line on what they want, in their own terms.",
        },
        "phone": {
            "type": "string",
            "description": "Number to reach them on, only if they gave one different "
            "from the one they are calling from.",
        },
    },
    required=["name", "reason"],
)
async def capture_lead(args: dict, call: CallContext) -> dict:
    name = " ".join(str(args.get("name") or "").split())
    reason = " ".join(str(args.get("reason") or "").split())
    if not name or not reason:
        return {"error": "a name and a reason are both needed; ask the caller for the missing one"}

    stated = clean_phone(args.get("phone"))
    phone = stated or clean_phone(call.caller_number)
    if not phone:
        return {"error": "there is no number to reach them on; ask the caller for one"}

    # Free text can hold anything a caller said, including a full Aadhaar or PAN,
    # which must never reach disk. Same rule as the transcript, same function.
    now = datetime.now(UTC)
    lead = {
        "at": now.isoformat(),
        "call_id": call.call_id,
        "name": mask_sensitive(name),
        "phone": phone,
        "phone_source": "caller_stated" if stated else "call_metadata",
        "reason": mask_sensitive(reason),
    }
    directory = leads_dir()
    directory.mkdir(parents=True, exist_ok=True)
    # One file per day; a single small write per lead keeps concurrent calls from
    # interleaving lines.
    with (directory / f"{now:%Y-%m-%d}.jsonl").open("a", encoding="utf-8") as f:
        f.write(json.dumps(lead, ensure_ascii=False) + "\n")
    logger.info(f"Lead captured for call {call.call_id}")
    return {"status": "saved", "phone_saved": phone}



@tool(
    "transfer_to_human",
    "Hand the call to a person. Use it when the caller asks for a human, or has a "
    "need you cannot meet. Say one short line that you are connecting them, in the "
    "same turn.",
)
async def transfer_to_human(args: dict, call: CallContext) -> dict:
    # The destination is server configuration (TRANSFER_NUMBER), never something the
    # model or the caller can choose.
    if call.transfer is None:
        return {"error": "this call cannot be transferred from here; offer to take a message"}
    await call.transfer()
    return {"status": "transferring"}


WEBHOOK_TIMEOUT_SECS = 6.0
WEBHOOK_MAX_REPLY_CHARS = 500


def webhook_url_problem(url: str | None) -> str | None:
    """Why this URL may not be used, or None. https only; plain http for loopback dev."""
    if not url:
        return "TOOL_WEBHOOK_URL is not set"
    parsed = re.match(r"^(https?)://([^/:?#]+)", url)
    if not parsed:
        return "TOOL_WEBHOOK_URL is not an http(s) URL"
    scheme, host = parsed.groups()
    if scheme == "https":
        return None
    try:
        loopback = host == "localhost" or ipaddress.ip_address(host).is_loopback
    except ValueError:
        loopback = False
    return None if loopback else "TOOL_WEBHOOK_URL must be https (http only for localhost)"


@tool(
    "call_webhook",
    "Save or look something up in the business's own system. Use it only for what the "
    "persona says it is for. The answer comes back as text for you to use.",
    properties={
        "action": {
            "type": "string",
            "description": "What to do, as the persona names it, e.g. 'check_order'.",
        },
        "details": {
            "type": "string",
            "description": "The facts the action needs, in one short line.",
        },
    },
    required=["action"],
)
async def call_webhook(args: dict, call: CallContext) -> dict:
    """POST to one fixed URL from the environment, never one the model supplies.

    The URL is configuration so a caller cannot steer the server at an internal
    address; redirects are not followed for the same reason. The body is masked like
    everything else that leaves our process about a caller.
    """
    url = os.getenv("TOOL_WEBHOOK_URL")
    if problem := webhook_url_problem(url):
        return {"error": f"{problem}; tell the caller you cannot do that right now"}
    body = {
        "call_id": call.call_id,
        "caller": call.caller_number,
        "action": mask_sensitive(" ".join(str(args.get("action") or "").split())),
        "details": mask_sensitive(" ".join(str(args.get("details") or "").split())),
    }
    if not body["action"]:
        return {"error": "an action is needed"}
    headers = {}
    if secret := os.getenv("TOOL_WEBHOOK_SECRET"):
        headers["Authorization"] = f"Bearer {secret}"
    timeout = aiohttp.ClientTimeout(total=WEBHOOK_TIMEOUT_SECS)
    try:
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.post(url, json=body, headers=headers, allow_redirects=False) as r:
                text = (await r.text())[:WEBHOOK_MAX_REPLY_CHARS]
                status = r.status
    except (TimeoutError, aiohttp.ClientError) as e:
        logger.error(f"Webhook for call {call.call_id} failed: {type(e).__name__}")
        return {"error": "the business system did not answer; tell the caller you could not"}
    if not 200 <= status < 300:
        logger.error(f"Webhook for call {call.call_id} returned HTTP {status}")
        return {"error": f"the business system refused (HTTP {status}); tell the caller"}
    return {"status": "ok", "reply": mask_sensitive(text)}

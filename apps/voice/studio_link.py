"""The phone server's link to the Studio (backend/, its /internal/v1 API).

Which agent a call gets, and its prompt, opening line, tools and limits, are
read from the Studio; how the call ended and its transcript are sent back, so
the Studio's Calls page and live transcript show real calls. Off unless
STUDIO_INTERNAL_URL and STUDIO_INTERNAL_TOKEN are both set: the phone server
then keeps reading data/agents.json, as before.

Failure policy (every external call has a deadline and a defined failure):
- reading an agent waits at most STUDIO_TIMEOUT_SECS, then raises
  StudioUnavailable, and server.py falls back to data/agents.json, so a Studio
  that is down never stops a call from ringing;
- reports never raise and never sit on the call path: transcript lines are
  queued and sent by a background task, and a Studio that is down only delays
  them (the backlog is bounded, oldest live captions dropped first).
Transcript lines are sent exactly as CallTranscript wrote them, after masking.
"""

from __future__ import annotations

import asyncio
import os
import re

import httpx
from loguru import logger

DEFAULT_TIMEOUT_SECS = 1.5
MAX_PENDING = 2000  # lines held while the Studio is unreachable
MAX_BATCH = 500  # the Studio's own limit per request
CLOSE_DEADLINE_SECS = 2.0
_CALL_ID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")

# Tests swap in an httpx.MockTransport here.
_transport: httpx.AsyncBaseTransport | None = None


class StudioUnavailable(Exception):
    """The Studio did not answer in time or answered with an error."""


def configured() -> bool:
    return bool(_url() and _token())


def _url() -> str:
    return (os.getenv("STUDIO_INTERNAL_URL") or "").strip().rstrip("/")


def _token() -> str:
    return (os.getenv("STUDIO_INTERNAL_TOKEN") or "").strip()


def _timeout() -> float:
    try:
        value = float(os.getenv("STUDIO_TIMEOUT_SECS") or DEFAULT_TIMEOUT_SECS)
    except ValueError:
        return DEFAULT_TIMEOUT_SECS
    return value if value > 0 else DEFAULT_TIMEOUT_SECS


def _client() -> httpx.AsyncClient:
    return httpx.AsyncClient(base_url=_url(), transport=_transport, timeout=_timeout(),
                             headers={"Authorization": f"Bearer {_token()}"})


def _clean_config(raw) -> dict | None:
    """The Studio's config in the shape agents_store.call_config gives, or None
    if anything in it is malformed (it decides what a live call does)."""
    if not isinstance(raw, dict):
        return None
    try:
        tools = raw.get("tools") or []
        if not isinstance(tools, list) or not all(isinstance(t, str) for t in tools):
            return None
        prompt, opening = raw.get("prompt"), raw.get("opening_line")
        if prompt is not None and not isinstance(prompt, str):
            return None
        if opening is not None and not isinstance(opening, str):
            return None
        org_id = raw.get("org_id")
        return {"agent_id": str(raw["agent_id"]), "org_id": str(org_id) if org_id else None,
                "name": str(raw.get("name") or ""),
                "prompt": prompt or None, "tools": tools, "opening_line": opening or None,
                "max_secs": float(raw["max_secs"]), "ring_secs": int(raw["ring_secs"])}
    except (KeyError, TypeError, ValueError):
        return None


async def call_config(agent_id: str | None = None, number: str | None = None) -> dict | None:
    """The agent for this call, by its id or by the number it was routed to.
    None if the Studio has no such agent; StudioUnavailable if it could not say."""
    params = {"agent_id": agent_id} if agent_id else {"number": number or ""}
    try:
        async with _client() as client:
            r = await asyncio.wait_for(client.get("/internal/v1/call-config", params=params),
                                       _timeout())
    except (httpx.HTTPError, TimeoutError) as e:
        raise StudioUnavailable(type(e).__name__) from None
    if r.status_code != 200:
        raise StudioUnavailable(f"HTTP {r.status_code}")
    try:
        raw = r.json().get("config")
    except (ValueError, AttributeError):
        raise StudioUnavailable("not JSON") from None
    return _clean_config(raw) if raw is not None else None


async def report_outcome(call_id: str, fields: dict) -> bool:
    """How a call ended, for the Studio's Calls page. Never raises."""
    if not configured() or not _CALL_ID.match(call_id or ""):
        return False
    body = {k: v for k, v in fields.items() if v not in (None, "")}
    try:
        async with _client() as client:
            r = await asyncio.wait_for(client.put(f"/internal/v1/calls/{call_id}", json=body),
                                       _timeout())
        return r.status_code == 200
    except (httpx.HTTPError, TimeoutError) as e:
        logger.warning(f"Could not report call {call_id} to the Studio: {type(e).__name__}")
        return False


async def report_error(level: str, source: str, message: str, *, call_id: str | None = None,
                        org_id: str | None = None) -> bool:
    """A provider or call failure, for the Studio's Error Logs page and its
    notifications. Never raises; off the call path, like report_outcome."""
    if not configured():
        return False
    body = {"level": level, "source": source, "message": message}
    if call_id:
        body["call_id"] = call_id
    if org_id:
        body["org_id"] = org_id
    try:
        async with _client() as client:
            r = await asyncio.wait_for(client.post("/internal/v1/errors", json=body), _timeout())
        return r.status_code == 200
    except (httpx.HTTPError, TimeoutError) as e:
        logger.warning(f"Could not report an error to the Studio: {type(e).__name__}")
        return False


async def report_lead(lead: dict, *, org_id: str | None = None) -> bool:
    """A captured lead, mirrored to the Studio's own store (the voice service
    keeps its local leads/*.jsonl copy regardless). Never raises; off the call
    path, like report_outcome and report_error. `lead` already has every field
    masking.py requires masked (capture_lead does this before calling here)."""
    if not configured():
        return False
    body = dict(lead)
    if org_id:
        body["org_id"] = org_id
    try:
        async with _client() as client:
            r = await asyncio.wait_for(client.post("/internal/v1/leads", json=body), _timeout())
        return r.status_code == 200
    except (httpx.HTTPError, TimeoutError) as e:
        logger.warning(f"Could not report a lead to the Studio: {type(e).__name__}")
        return False


async def save_answer(call_id: str, *, field_key: str, said: str, turn: int,
                      confirmed: bool) -> dict:
    """One answer the caller gave, for the Studio to read, check and store. Unlike the
    other reports this one is ON the call path: the agent waits for the reply to know
    whether to read the value back or move on. So it has the same short deadline as
    everything else on the path, and a failure becomes something the agent can say
    rather than an exception.

    Only the field and the words go over; the Studio works out the organization and the
    contact from the call itself, so nothing said on a call can point an answer
    somewhere else."""
    if not configured() or not _CALL_ID.match(call_id or ""):
        return {"ok": False, "value": None, "message": "There is nowhere to save that. Carry on."}
    body = {"field_key": field_key, "said": said, "turn": turn, "confirmed": confirmed}
    try:
        async with _client() as client:
            r = await asyncio.wait_for(
                client.post(f"/internal/v1/calls/{call_id}/answers", json=body), _timeout())
        if r.status_code != 200:
            return {"ok": False, "value": None,
                    "message": "I could not save that just now. Please carry on."}
        return r.json()
    except (httpx.HTTPError, TimeoutError, ValueError) as e:
        logger.warning(f"Could not save an answer on call {call_id}: {type(e).__name__}")
        return {"ok": False, "value": None,
                "message": "I could not save that just now. Please carry on."}


async def report_recording(call_id: str, path: str, size: int, mime: str) -> bool:
    """Where a call's recording was stored (Supabase Storage object path, bytes, type),
    so the Studio can link and play it. Never raises; off the call path, like the other
    reports."""
    if not configured() or not _CALL_ID.match(call_id or ""):
        return False
    body = {"path": path, "bytes": size, "mime": mime}
    try:
        async with _client() as client:
            r = await asyncio.wait_for(
                client.post(f"/internal/v1/calls/{call_id}/recording", json=body), _timeout())
        return r.status_code == 200
    except (httpx.HTTPError, TimeoutError) as e:
        logger.warning(f"Could not report the recording of call {call_id} to the Studio: "
                        f"{type(e).__name__}")
        return False


class EventSink:
    """Transcript lines on their way to the Studio, sent in the background.

    CallTranscript calls it with each masked line it writes; a task sends what
    has queued up every `interval` seconds. close() sends what is left within
    CLOSE_DEADLINE_SECS and gives up after that."""

    def __init__(self, call_id: str, interval: float = 0.5):
        self.call_id = call_id
        self.interval = interval
        self._pending: list[dict] = []
        self._task: asyncio.Task | None = None
        self._closed = False

    def __call__(self, record: dict) -> None:
        if self._closed:
            return
        self._pending.append(record)
        if len(self._pending) > MAX_PENDING:
            # Drop a live caption first (the masked turn replaces it), else the oldest line.
            drop = next((i for i, r in enumerate(self._pending) if r.get("event") == "live"), 0)
            del self._pending[drop]

    def start(self) -> None:
        if configured() and _CALL_ID.match(self.call_id) and self._task is None:
            self._task = asyncio.create_task(self._run())

    async def _send(self) -> bool:
        batch = self._pending[:MAX_BATCH]
        if not batch:
            return True
        try:
            async with _client() as client:
                r = await asyncio.wait_for(
                    client.post(f"/internal/v1/calls/{self.call_id}/events",
                                json={"events": batch}),
                    _timeout())
        except (httpx.HTTPError, TimeoutError):
            return False
        if r.status_code != 200:
            return False
        del self._pending[:len(batch)]
        return True

    async def _run(self) -> None:
        while not self._closed:
            await asyncio.sleep(self.interval)
            await self._send()

    async def close(self) -> None:
        """Send what is left, within the deadline. Never raises."""
        self._closed = True
        if self._task is None:
            return
        self._task.cancel()
        try:
            await self._task
        except (asyncio.CancelledError, Exception):  # noqa: BLE001
            pass

        async def drain() -> None:
            while self._pending:
                if not await self._send():
                    await asyncio.sleep(0.2)

        try:
            await asyncio.wait_for(drain(), CLOSE_DEADLINE_SECS)
        except TimeoutError:
            logger.warning(f"Gave up sending {len(self._pending)} transcript lines of "
                           f"{self.call_id} to the Studio")

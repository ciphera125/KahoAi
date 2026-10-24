"""Phone entrypoint: Plivo calls in, the same pipeline as main.py answers.

    python apps/voice/server.py        # listens on PORT (default 8000)

Point a Plivo number's Answer URL at https://<PUBLIC_HOST>/answer. Plivo fetches
it when a call arrives, and the reply tells Plivo to open a bidirectional audio
stream to wss://<PUBLIC_HOST>/ws. That websocket carries 8kHz mu-law both ways;
PlivoFrameSerializer converts it to and from the PCM the pipeline works in, and
tells Plivo to drop queued audio when the caller barges in.

Both routes require WEBHOOK_SECRET as a ?token= query parameter, because the
server is on the public internet and an open /ws would let anyone run up our
STT, LLM and TTS bills. The answer XML carries the token into the stream URL.
"""

import asyncio
import base64
import hmac
import json
import math
import os
import re
from contextlib import asynccontextmanager
from html import escape
from urllib.parse import parse_qs, quote

import agents_store
import aiohttp
import call_outcomes
import numbers_store
import personas
import plivo_signature
import prompt_store
import uvicorn
from dotenv import load_dotenv
from duration_limit import configured_ceiling, enforce_max_duration, resolve_max_duration
from fastapi import FastAPI, Query, Request, Response, WebSocket
from groq_usage import log_groq_call
from loguru import logger
from main import build_worker, ensure_ca_bundle, env, recordings_dir, require_env
from pipecat.pipeline.worker import PipelineParams
from pipecat.serializers.plivo import PlivoFrameSerializer
from pipecat.transports.websocket.fastapi import FastAPIWebsocketParams, FastAPIWebsocketTransport
from pipecat.workers.runner import WorkerRunner
from rate_limit import ConnectionLimiter, ws_max_concurrent_calls, ws_rate_limit_per_minute
from recording import delete_expired_recordings, recording_retention_days
from resilience import DEFAULT_APOLOGY, safe_reason

# Pipecat's own hang-up request has no timeout, and a hang-up that stalls is a call
# that keeps running, so it gets one here.
HANGUP_TIMEOUT_SECS = 10.0
TRANSFER_TIMEOUT_SECS = 10.0
# Three cutoff steps, each bounded by duration_limit.STEP_TIMEOUT_SECS, plus slack.
CUTOFF_FINISH_SECS = 35.0

# Plivo carries the call as 8kHz mu-law in both directions.
PHONE_LINE_RATE = 8000

# Silero VAD only accepts 8kHz or 16kHz. The phone line is 8kHz, and the
# serializer upsamples it to this before it reaches VAD and STT.
PIPELINE_INPUT_RATE = 16000

# A running server deletes recordings past RECORDING_RETENTION_DAYS at start and
# then this often, so nothing outlives the window by more than an hour.
RETENTION_SWEEP_SECS = 3600.0

# Built lazily (not at import) so WS_RATE_LIMIT_PER_MINUTE/WS_MAX_CONCURRENT_CALLS
# are read after .env is loaded, and so a test can reset it to a fresh instance
# with its own thresholds and a fake clock. One instance for the process: the
# whole point is a shared count across every connection, not a per-request one.
_ws_limiter: ConnectionLimiter | None = None


def ws_limiter() -> ConnectionLimiter:
    global _ws_limiter
    if _ws_limiter is None:
        _ws_limiter = ConnectionLimiter(ws_rate_limit_per_minute(), ws_max_concurrent_calls())
    return _ws_limiter


def client_ip(websocket: WebSocket) -> str:
    """The connecting address, or a fixed placeholder if the transport has none
    (seen in tests). Never raises: a missing address must not break the limiter."""
    return websocket.client.host if websocket.client else "unknown"


async def enforce_recording_retention(days: float) -> None:
    while True:
        try:
            await asyncio.to_thread(delete_expired_recordings, recordings_dir(), days)
        except Exception as e:  # noqa: BLE001 - one bad pass must not end the sweeping
            logger.error(f"Recording retention sweep failed: {safe_reason(e)}")
        await asyncio.sleep(RETENTION_SWEEP_SECS)


@asynccontextmanager
async def lifespan(app: FastAPI):
    days = recording_retention_days()
    logger.info(f"Recordings are deleted {days:g} days after the call (checked hourly)")
    sweeper = asyncio.create_task(enforce_recording_retention(days))
    try:
        yield
    finally:
        sweeper.cancel()


app = FastAPI(lifespan=lifespan)


class FailOpenPlivoSerializer(PlivoFrameSerializer):
    """Plivo serializer that can be told not to hang up when the stream ends.

    Normally the call is hung up when the pipeline ends. When our own text to
    speech is what broke, the caller has heard nothing, so hanging up would
    just drop the line. With `fail_open` set the stream is closed and the call
    is left alone: Plivo carries on to the <Speak> after the <Stream> in the
    answer XML and reads the caller an apology with its own voice.
    """

    fail_open = False

    def __init__(self, *, stream_id, call_id=None, auth_id=None, auth_token=None, params=None):
        super().__init__(
            stream_id=stream_id,
            call_id=call_id,
            auth_id=auth_id,
            auth_token=auth_token,
            params=params,
        )
        self._forced_hangup = (auth_id, auth_token, call_id)

    async def _bounded_hang_up(self) -> None:
        try:
            await asyncio.wait_for(super()._hang_up_call(), HANGUP_TIMEOUT_SECS)
        except TimeoutError:
            logger.error(f"Plivo hang-up did not answer within {HANGUP_TIMEOUT_SECS:g}s")

    async def _hang_up_call(self):
        if self.fail_open:
            logger.warning("Leaving the call open for Plivo's own apology")
            return
        await self._bounded_hang_up()

    async def hang_up(self) -> None:
        """Hang up now, whatever `fail_open` says. Used by the maximum-duration guard.

        Pipecat's own hang-up logs its failures and returns as if it had worked,
        which would let the guard report success for a call it never ended. This
        one raises, so the guard can say plainly that the hang-up failed. A 404
        means the call had already ended, which is what was wanted.
        """
        auth_id, auth_token, call_id = self._forced_hangup
        if not (auth_id and auth_token and call_id):
            raise RuntimeError("no Plivo credentials or call id to hang up with")
        url = f"https://api.plivo.com/v1/Account/{auth_id}/Call/{call_id}/"

        # Built by hand: aiohttp's helpers for this have changed across versions.
        basic = base64.b64encode(f"{auth_id}:{auth_token}".encode()).decode()

        async def delete() -> None:
            async with aiohttp.ClientSession() as session:
                async with session.delete(url, headers={"Authorization": f"Basic {basic}"}) as r:
                    if r.status not in (204, 404):
                        raise RuntimeError(f"Plivo answered HTTP {r.status} to the hang-up")

        try:
            await asyncio.wait_for(delete(), HANGUP_TIMEOUT_SECS)
        except TimeoutError:
            raise RuntimeError(
                f"Plivo did not answer the hang-up within {HANGUP_TIMEOUT_SECS:g}s"
            ) from None


def authorized(token: str | None) -> bool:
    secret = env("WEBHOOK_SECRET")
    return bool(secret and token) and hmac.compare_digest(token, secret)


def clean_caller(raw: str | None) -> str | None:
    """A phone number as digits with an optional +, or None. It arrives from the network."""
    digits = re.sub(r"[^\d+]", "", raw or "")[:20]
    return digits or None


def answer_xml(
    host: str,
    token: str,
    caller: str | None = None,
    apology: str = DEFAULT_APOLOGY,
    agent: str | None = None,
    max_secs: float | None = None,
    studio_agent: str | None = None,
) -> str:
    """The Plivo XML that connects a live call to our websocket.

    The caller's number arrives on this webhook and not on the websocket, so it
    rides along on the stream URL for the tools to use, as do an outbound call's
    agent and maximum duration.
    """
    query = f"token={token}" + (f"&from={quote(caller)}" if caller else "")
    if agent:
        query += f"&agent={quote(agent)}"
    if studio_agent:
        query += f"&studio_agent={quote(studio_agent)}"
    if max_secs is not None:
        query += f"&max={max_secs:g}"
    url = escape(f"wss://{host}/ws?{query}")
    return (
        '<?xml version="1.0" encoding="UTF-8"?>'
        "<Response>"
        '<Stream bidirectional="true" keepCallAlive="true" '
        f'contentType="audio/x-mulaw;rate={PHONE_LINE_RATE}">{url}</Stream>'
        # Reached only if the stream ends without the call being hung up, which is
        # what a provider failure that stops us speaking does on purpose.
        f'<Speak language="en-IN">{escape(apology)}</Speak>'
        "</Response>"
    )


def transfer_number() -> str | None:
    """The human line the agent may hand calls to, from TRANSFER_NUMBER only."""
    number = clean_caller(env("TRANSFER_NUMBER"))
    return number if number and len(re.sub(r"\D", "", number)) >= 7 else None


def transfer_xml(number: str, message: str = "Connecting you now.") -> str:
    return (
        '<?xml version="1.0" encoding="UTF-8"?>'
        f'<Response><Speak language="en-IN">{escape(message)}</Speak>'
        f"<Dial><Number>{escape(number)}</Number></Dial></Response>"
    )


@app.api_route("/transfer", methods=["GET", "POST"])
async def transfer(token: str | None = Query(None)):
    """Plivo fetches this after a transfer request and dials the human."""
    number = transfer_number()
    if not authorized(token) or not number:
        return Response(status_code=403)
    return Response(transfer_xml(number), media_type="text/xml")


async def request_transfer(
    auth_id: str, auth_token: str, call_id: str, url: str, api_base: str = "https://api.plivo.com"
) -> None:
    """Ask Plivo to move the live call onto `url`. Raises unless Plivo accepts it."""
    api = f"{api_base}/v1/Account/{auth_id}/Call/{call_id}/"
    timeout = aiohttp.ClientTimeout(total=TRANSFER_TIMEOUT_SECS)
    async with aiohttp.ClientSession(timeout=timeout) as session:
        async with session.post(
            api,
            json={"legs": "aleg", "aleg_url": url, "aleg_method": "POST"},
            headers={"Authorization": aiohttp.encode_basic_auth(auth_id, auth_token)},
        ) as r:
            if r.status not in (200, 201, 202):
                raise RuntimeError(f"Plivo refused the transfer (HTTP {r.status})")


@app.api_route("/answer", methods=["GET", "POST"])
async def answer(request: Request, token: str | None = Query(None)):
    if not authorized(token):
        return Response(status_code=403)
    # Plivo posts its parameters as a form body; a GET carries them in the query.
    body = await read_capped(request)
    if body is None:
        logger.warning("Refusing an oversized /answer body")
        return Response(status_code=413)
    params = parse_qs(body.decode("utf-8", "replace"))
    params.update(parse_qs(request.url.query))
    first = lambda key: (params.get(key) or [None])[0]  # noqa: E731

    # An outbound call is dialled by scripts/call.py, which names the agent, the
    # party being called (`peer`) and a maximum duration in the answer URL.
    agent = first("agent")
    if agent:
        try:
            personas.resolve(agent)
        except ValueError as e:
            logger.error(f"Refusing the call: {e}")
            return Response(str(e), status_code=400)
    try:
        requested = float(first("max")) if first("max") else None
        max_secs = resolve_max_duration(requested)
    except ValueError as e:
        logger.error(f"Refusing the call: {e}")
        return Response(str(e), status_code=400)

    peer = clean_caller(first("peer"))
    # A Studio agent: named by an outbound call from the Studio, or the one our
    # number routes to for an inbound call. Checked here, so a bad id never rings.
    studio_agent = first("studio_agent")
    if studio_agent:
        config = agents_store.default_store().call_config(studio_agent)
        if config is None:
            logger.error("Refusing the call: unknown Studio agent")
            return Response("unknown agent", status_code=400)
    elif not peer:
        studio_agent = agents_store.default_store().agent_for_number(first("To"))
        config = agents_store.default_store().call_config(studio_agent)
    else:
        config = None
    if config:
        max_secs = min(max_secs, config["max_secs"])
    caller = peer or clean_caller(first("From"))
    logger.info(f"{'Outbound call to' if peer else 'Inbound call from'} {caller or 'unknown'}")
    apology = env("FAILURE_MESSAGE") or DEFAULT_APOLOGY
    return Response(
        answer_xml(env("PUBLIC_HOST"), token, caller, apology, agent, max_secs,
                   config["agent_id"] if config else None),
        media_type="text/xml",
    )


MAX_WEBHOOK_BODY = 16 * 1024  # Plivo's form posts are well under 2KB


async def read_capped(request: Request, limit: int = MAX_WEBHOOK_BODY) -> bytes | None:
    """The request body, or None if it is over `limit`. Stops reading at the limit,
    so a huge body (with or without a Content-Length) is never held in memory."""
    try:
        if int(request.headers.get("content-length") or 0) > limit:
            return None
    except ValueError:
        return None
    body = bytearray()
    async for chunk in request.stream():
        body += chunk
        if len(body) > limit:
            return None
    return bytes(body)


def verify_signatures() -> bool:
    """Plivo's signature is checked unless PLIVO_VERIFY_SIGNATURE=false (tests)."""
    return (env("PLIVO_VERIFY_SIGNATURE") or "true").strip().lower() != "false"


def signed_by_plivo(request: Request, body: dict) -> bool:
    """Whether Plivo signed this webhook. The URL is rebuilt with PUBLIC_HOST, as
    Plivo called it through the tunnel, not as it arrives here."""
    url = f"https://{env('PUBLIC_HOST')}{request.url.path}"
    if request.url.query:
        url += f"?{request.url.query}"
    return plivo_signature.valid(
        request.method, url, body, request.headers.get("x-plivo-signature-v3-nonce"),
        request.headers.get("x-plivo-signature-v3"), plivo_auth()[1])


@app.api_route("/hangup", methods=["GET", "POST"])
async def hangup(request: Request, token: str | None = Query(None)):
    """Plivo's report of how an outbound call ended (picked up, busy, no answer).

    It arrives from the internet, so only the fields we use are kept, each one
    checked; anything else in it is dropped. Junk is answered 200 and ignored, so
    Plivo does not retry it."""
    if not authorized(token):
        return Response(status_code=403)
    body = await read_capped(request)
    if body is None:
        return Response(status_code=413)
    form = parse_qs(body.decode("utf-8", "replace"), keep_blank_values=True)
    if verify_signatures() and not signed_by_plivo(request, form):
        # The shared secret alone is not enough: it rides in URLs and logs.
        logger.warning("Refusing a /hangup report without a valid Plivo signature")
        return Response(status_code=403)
    params = {**form, **parse_qs(request.url.query)}
    first = lambda key: (params.get(key) or [None])[0]  # noqa: E731
    call_id = first("CallUUID") or first("RequestUUID")
    try:
        call_outcomes.default_log().record(
            call_id or "",
            status=call_outcomes.classify(first("CallStatus"), first("HangupCauseName"),
                                          first("BillDuration")),
            cause=first("HangupCauseName"), duration_secs=first("BillDuration"),
            request_uuid=first("RequestUUID"), peer=clean_caller(first("peer")),
            direction=first("Direction"), agent_id=first("studio_agent"))
    except ValueError:
        logger.warning("Ignoring a hangup report with no usable call id")
    return Response(status_code=200)


async def read_start(websocket: WebSocket) -> dict:
    """Plivo opens the stream with a start event naming the stream and call."""
    while True:
        message = json.loads(await websocket.receive_text())
        if message.get("event") == "start":
            logger.debug(f"Plivo start event: {message}")
            return message.get("start") or message


@app.websocket("/ws")
async def stream(
    websocket: WebSocket,
    token: str | None = Query(None),
    caller: str | None = Query(None, alias="from"),
    agent: str | None = Query(None),
    max_secs: float | None = Query(None, alias="max"),
    studio_agent: str | None = Query(None),
):
    if not authorized(token):
        await websocket.close(code=1008)
        return
    ip = client_ip(websocket)
    if reason := ws_limiter().try_accept(ip):
        # loguru's own line already carries a timestamp; name the IP and the
        # limit explicitly so a real spike and a probing attacker both show up
        # on a plain grep of this log, not just as an unexplained close code.
        logger.warning(f"Rejecting /ws from {ip}: {reason}")
        await websocket.close(code=1013)
        return
    # The query string is not trusted just because the token matched: an unknown
    # agent must reject this one call, never take the server down (load_system_prompt
    # exits the process on a missing file).
    persona_path = None
    if agent:
        try:
            persona_path = personas.resolve(agent)
        except ValueError as e:
            logger.error(f"Rejecting the stream: {e}")
            await websocket.close(code=1008)
            return
    try:
        limit = resolve_max_duration(max_secs if max_secs and math.isfinite(max_secs) else None)
    except ValueError as e:
        logger.error(f"Rejecting the stream: {e}")
        await websocket.close(code=1011)
        return
    # Read again, not trusted from the URL: an agent deleted while the phone rang
    # leaves this call on the default persona rather than failing it.
    agent_config = agents_store.default_store().call_config(studio_agent)
    if agent_config:
        limit = min(limit, agent_config["max_secs"])
    try:
        await _run_call(websocket, token, caller, persona_path, limit, agent_config=agent_config)
    finally:
        ws_limiter().release()


def persona_text_for_call(agent_config: dict | None = None) -> str | None:
    """The prompt this call uses, read fresh for each call: the Studio agent's
    prompt in use, else the prompt saved for our number before agents existed.

    It wins over an outbound call's --agent: the Studio is where the owner
    decides what callers hear. None (nothing saved, or the store unreadable)
    keeps the persona the call would have had anyway.
    """
    if agent_config and agent_config.get("prompt"):
        logger.info(f"Using the Studio agent {agent_config['agent_id']}")
        return agent_config["prompt"]
    text = prompt_store.prompt_for_our_number()
    if text:
        logger.info(f"Using the prompt saved for {prompt_store.our_number()}")
    return text


def plivo_auth() -> tuple[str | None, str | None]:
    """Plivo credentials for hanging up and transferring: the ones saved on the
    admin page if any, else .env, so a token rotated there is used here too."""
    return numbers_store.plivo_credentials()


async def _run_call(
    websocket: WebSocket,
    token: str | None,
    caller: str | None,
    persona_path: str | None,
    limit: float,
    agent_config: dict | None = None,
) -> None:
    await websocket.accept()

    start = await read_start(websocket)
    stream_id, call_id = start.get("streamId"), start.get("callId")
    logger.info(f"Call {call_id} connected on stream {stream_id}")

    auth_id, auth_token = plivo_auth()
    serializer = FailOpenPlivoSerializer(
        stream_id=stream_id,
        call_id=call_id,
        auth_id=auth_id,
        auth_token=auth_token,
        params=PlivoFrameSerializer.InputParams(sample_rate=PIPELINE_INPUT_RATE),
    )
    transport = FastAPIWebsocketTransport(
        websocket,
        FastAPIWebsocketParams(
            audio_in_enabled=True,
            audio_out_enabled=True,
            add_wav_header=False,
            serializer=serializer,
        ),
    )
    async def hand_to_human() -> None:
        await request_transfer(
            auth_id, auth_token, call_id,
            f"https://{env('PUBLIC_HOST')}/transfer?token={quote(token)}",
        )

    async def abort(spoken: bool) -> None:
        # Not spoken means the caller heard nothing: leave the line to Plivo.
        serializer.fail_open = not spoken
        await worker.cancel(reason="provider failure")

    worker = build_worker(
        transport, PipelineParams(audio_in_sample_rate=PIPELINE_INPUT_RATE), call_id=call_id,
        caller_number=clean_caller(caller),
        on_abort=abort,
        persona_path=persona_path,
        transfer=hand_to_human if transfer_number() else None,
        recording_sample_rate=PHONE_LINE_RATE,
        persona_text=persona_text_for_call(agent_config),
        tool_names=agent_config["tools"] if agent_config else None,
        opening_line=agent_config["opening_line"] if agent_config else None,
    )
    if agent_config:
        worker.transcript.event("call_agent", agent_id=agent_config["agent_id"])

    async def cancel_pipeline() -> None:
        await worker.cancel(reason="maximum call duration")

    # The ceiling runs beside the call, not inside it, so a stuck pipeline cannot
    # stop it. Order: stop the billing at Plivo first, then tear down our side.
    # If the hang-up request fails, closing the stream still ends the call: Plivo
    # moves on to the <Speak> after it, then finishes.
    cutoff_fired = asyncio.Event()

    def on_cutoff(name: str, **fields) -> None:
        cutoff_fired.set()  # first, so a failing transcript cannot hide that it fired
        worker.transcript.event(name, **fields)

    guard = asyncio.create_task(
        enforce_max_duration(
            limit,
            [
                ("hang up via Plivo", serializer.hang_up),
                ("cancel the pipeline", cancel_pipeline),
                ("close the stream", websocket.close),
            ],
            record=on_cutoff,
        )
    )
    logger.info(f"Call {call_id} will be ended after at most {limit:g}s")

    @transport.event_handler("on_client_disconnected")
    async def hung_up(transport, client):
        logger.info(f"Call {call_id} ended by the caller")
        await worker.cancel()

    # uvicorn owns the process's signals; a runner per call must not steal them.
    try:
        await WorkerRunner(handle_sigint=False).run(worker)
    finally:
        if cutoff_fired.is_set():
            # Cancelling the pipeline is how the cutoff ends this handler, but it is
            # only part-way through its steps: the stream still has to be closed
            # explicitly, and returning from here does not do that reliably. Let it
            # finish, within the time its own step timeouts allow.
            try:
                await asyncio.wait_for(guard, CUTOFF_FINISH_SECS)
            except TimeoutError:
                logger.error("The maximum-duration cutoff did not finish; leaving it")
        else:
            guard.cancel()
    logger.info(f"Call {call_id} finished")


WARMUP_TIMEOUT_SECS = 5.0


async def warm_up() -> None:
    """Pay the first-use costs at startup, not on the first caller's first turn.

    Loads the VAD and turn-analysis models and makes one free authenticated request
    to Groq, so DNS, TLS and the credentials are known good before a call arrives.
    Each call still opens its own provider connections (Pipecat owns those); this
    does not pool them. A failure is logged, never fatal: the server is still useful.
    """
    import time

    from main import build_turn_strategies, build_vad

    started = time.perf_counter()
    build_vad()
    build_turn_strategies().stop  # noqa: B018 - constructs the turn-analysis model
    key = env("GROQ_API_KEY")
    if key:
        log_groq_call("server.warm_up", "GET /openai/v1/models (no chat model)")
        try:
            timeout = aiohttp.ClientTimeout(total=WARMUP_TIMEOUT_SECS)
            async with aiohttp.ClientSession(timeout=timeout) as session:
                async with session.get(
                    "https://api.groq.com/openai/v1/models",
                    headers={"Authorization": f"Bearer {key}"},
                ) as r:
                    if r.status != 200:
                        logger.warning(f"Warm-up: Groq answered HTTP {r.status}; check the key")
        except (TimeoutError, aiohttp.ClientError) as e:
            logger.warning(f"Warm-up: Groq not reachable ({type(e).__name__})")
    logger.info(f"Warm-up finished in {time.perf_counter() - started:.2f}s")


def check_region() -> None:
    """Real calls belong in Mumbai: every turn crosses the network three times."""
    region = env("DEPLOY_REGION")
    if region == "ap-south-1":
        logger.info("Deploy region: ap-south-1")
    else:
        logger.warning(
            f"DEPLOY_REGION is {region or 'unset'}, not ap-south-1. Fine for local "
            "testing; before real traffic, host in Mumbai (see CLAUDE.md)."
        )


def main() -> None:
    load_dotenv()
    ensure_ca_bundle()
    require_env("WEBHOOK_SECRET", "PUBLIC_HOST", "PLIVO_AUTH_ID", "PLIVO_AUTH_TOKEN")
    try:
        logger.info(f"Calls are capped at {configured_ceiling():g}s")
        recording_retention_days()  # checked here so a bad value stops the server at once
    except ValueError as e:
        logger.error(str(e))
        raise SystemExit(1) from e
    check_region()
    if transfer_number():
        logger.info("Transfer to a human is available")
    try:
        asyncio.run(warm_up())
    except Exception as e:
        logger.warning(f"Warm-up failed: {type(e).__name__}")
    uvicorn.run(app, host="0.0.0.0", port=int(os.getenv("PORT") or 8000))


if __name__ == "__main__":
    main()

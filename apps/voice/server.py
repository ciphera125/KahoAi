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
from html import escape
from urllib.parse import parse_qs, quote

import aiohttp
import personas
import uvicorn
from dotenv import load_dotenv
from duration_limit import configured_ceiling, enforce_max_duration, resolve_max_duration
from fastapi import FastAPI, Query, Request, Response, WebSocket
from loguru import logger
from main import build_worker, ensure_ca_bundle, env, require_env
from pipecat.pipeline.worker import PipelineParams
from pipecat.serializers.plivo import PlivoFrameSerializer
from pipecat.transports.websocket.fastapi import FastAPIWebsocketParams, FastAPIWebsocketTransport
from pipecat.workers.runner import WorkerRunner
from resilience import DEFAULT_APOLOGY

# Pipecat's own hang-up request has no timeout, and a hang-up that stalls is a call
# that keeps running, so it gets one here.
HANGUP_TIMEOUT_SECS = 10.0
# Three cutoff steps, each bounded by duration_limit.STEP_TIMEOUT_SECS, plus slack.
CUTOFF_FINISH_SECS = 35.0

# Silero VAD only accepts 8kHz or 16kHz. The phone line is 8kHz, and the
# serializer upsamples it to this before it reaches VAD and STT.
PIPELINE_INPUT_RATE = 16000

app = FastAPI()


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
) -> str:
    """The Plivo XML that connects a live call to our websocket.

    The caller's number arrives on this webhook and not on the websocket, so it
    rides along on the stream URL for the tools to use, as do an outbound call's
    agent and maximum duration.
    """
    query = f"token={token}" + (f"&from={quote(caller)}" if caller else "")
    if agent:
        query += f"&agent={quote(agent)}"
    if max_secs is not None:
        query += f"&max={max_secs:g}"
    url = escape(f"wss://{host}/ws?{query}")
    return (
        '<?xml version="1.0" encoding="UTF-8"?>'
        "<Response>"
        '<Stream bidirectional="true" keepCallAlive="true" '
        f'contentType="audio/x-mulaw;rate=8000">{url}</Stream>'
        # Reached only if the stream ends without the call being hung up, which is
        # what a provider failure that stops us speaking does on purpose.
        f'<Speak language="en-IN">{escape(apology)}</Speak>'
        "</Response>"
    )


@app.api_route("/answer", methods=["GET", "POST"])
async def answer(request: Request, token: str | None = Query(None)):
    if not authorized(token):
        return Response(status_code=403)
    # Plivo posts its parameters as a form body; a GET carries them in the query.
    params = parse_qs((await request.body()).decode("utf-8", "replace"))
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
    caller = peer or clean_caller(first("From"))
    logger.info(f"{'Outbound call to' if peer else 'Inbound call from'} {caller or 'unknown'}")
    apology = env("FAILURE_MESSAGE") or DEFAULT_APOLOGY
    return Response(
        answer_xml(env("PUBLIC_HOST"), token, caller, apology, agent, max_secs),
        media_type="text/xml",
    )


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
):
    if not authorized(token):
        await websocket.close(code=1008)
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
    await websocket.accept()

    start = await read_start(websocket)
    stream_id, call_id = start.get("streamId"), start.get("callId")
    logger.info(f"Call {call_id} connected on stream {stream_id}")

    auth_id, auth_token = env("PLIVO_AUTH_ID"), env("PLIVO_AUTH_TOKEN")
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
    async def abort(spoken: bool) -> None:
        # Not spoken means the caller heard nothing: leave the line to Plivo.
        serializer.fail_open = not spoken
        await worker.cancel(reason="provider failure")

    worker = build_worker(
        transport, PipelineParams(audio_in_sample_rate=PIPELINE_INPUT_RATE), call_id=call_id,
        caller_number=clean_caller(caller),
        on_abort=abort,
        persona_path=persona_path,
    )

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


def main() -> None:
    load_dotenv()
    ensure_ca_bundle()
    require_env("WEBHOOK_SECRET", "PUBLIC_HOST", "PLIVO_AUTH_ID", "PLIVO_AUTH_TOKEN")
    try:
        logger.info(f"Calls are capped at {configured_ceiling():g}s")
    except ValueError as e:
        logger.error(str(e))
        raise SystemExit(1) from e
    uvicorn.run(app, host="0.0.0.0", port=int(os.getenv("PORT") or 8000))


if __name__ == "__main__":
    main()

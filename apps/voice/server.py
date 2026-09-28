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

import hmac
import json
import os
import re
from html import escape
from urllib.parse import parse_qs, quote

import uvicorn
from dotenv import load_dotenv
from fastapi import FastAPI, Query, Request, Response, WebSocket
from loguru import logger
from main import build_worker, ensure_ca_bundle, env, require_env
from pipecat.pipeline.worker import PipelineParams
from pipecat.serializers.plivo import PlivoFrameSerializer
from pipecat.transports.websocket.fastapi import FastAPIWebsocketParams, FastAPIWebsocketTransport
from pipecat.workers.runner import WorkerRunner
from resilience import DEFAULT_APOLOGY

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

    async def _hang_up_call(self):
        if self.fail_open:
            logger.warning("Leaving the call open for Plivo's own apology")
            return
        await super()._hang_up_call()


def authorized(token: str | None) -> bool:
    secret = env("WEBHOOK_SECRET")
    return bool(secret and token) and hmac.compare_digest(token, secret)


def clean_caller(raw: str | None) -> str | None:
    """A phone number as digits with an optional +, or None. It arrives from the network."""
    digits = re.sub(r"[^\d+]", "", raw or "")[:20]
    return digits or None


def answer_xml(
    host: str, token: str, caller: str | None = None, apology: str = DEFAULT_APOLOGY
) -> str:
    """The Plivo XML that connects a live call to our websocket.

    The caller's number arrives on this webhook and not on the websocket, so it
    rides along on the stream URL for the tools to use.
    """
    query = f"token={token}" + (f"&from={quote(caller)}" if caller else "")
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
    caller = clean_caller((params.get("From") or [None])[0])
    logger.info(f"Inbound call from {caller or 'unknown'}")
    apology = env("FAILURE_MESSAGE") or DEFAULT_APOLOGY
    return Response(
        answer_xml(env("PUBLIC_HOST"), token, caller, apology), media_type="text/xml"
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
):
    if not authorized(token):
        await websocket.close(code=1008)
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
    )

    @transport.event_handler("on_client_disconnected")
    async def hung_up(transport, client):
        logger.info(f"Call {call_id} ended by the caller")
        await worker.cancel()

    # uvicorn owns the process's signals; a runner per call must not steal them.
    await WorkerRunner(handle_sigint=False).run(worker)
    logger.info(f"Call {call_id} finished")


def main() -> None:
    load_dotenv()
    ensure_ca_bundle()
    require_env("WEBHOOK_SECRET", "PUBLIC_HOST", "PLIVO_AUTH_ID", "PLIVO_AUTH_TOKEN")
    uvicorn.run(app, host="0.0.0.0", port=int(os.getenv("PORT") or 8000))


if __name__ == "__main__":
    main()

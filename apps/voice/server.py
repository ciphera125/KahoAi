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
from html import escape

import uvicorn
from dotenv import load_dotenv
from fastapi import FastAPI, Query, Request, Response, WebSocket
from loguru import logger
from main import build_worker, ensure_ca_bundle, env, require_env
from pipecat.pipeline.worker import PipelineParams
from pipecat.serializers.plivo import PlivoFrameSerializer
from pipecat.transports.websocket.fastapi import FastAPIWebsocketParams, FastAPIWebsocketTransport
from pipecat.workers.runner import WorkerRunner

# Silero VAD only accepts 8kHz or 16kHz. The phone line is 8kHz, and the
# serializer upsamples it to this before it reaches VAD and STT.
PIPELINE_INPUT_RATE = 16000

app = FastAPI()


def authorized(token: str | None) -> bool:
    secret = env("WEBHOOK_SECRET")
    return bool(secret and token) and hmac.compare_digest(token, secret)


def answer_xml(host: str, token: str) -> str:
    """The Plivo XML that connects a live call to our websocket."""
    url = escape(f"wss://{host}/ws?token={token}")
    return (
        '<?xml version="1.0" encoding="UTF-8"?>'
        "<Response>"
        '<Stream bidirectional="true" keepCallAlive="true" '
        f'contentType="audio/x-mulaw;rate=8000">{url}</Stream>'
        "</Response>"
    )


@app.api_route("/answer", methods=["GET", "POST"])
async def answer(request: Request, token: str | None = Query(None)):
    if not authorized(token):
        return Response(status_code=403)
    logger.info(f"Inbound call from {request.query_params.get('From', 'unknown')}")
    return Response(answer_xml(env("PUBLIC_HOST"), token), media_type="text/xml")


async def read_start(websocket: WebSocket) -> dict:
    """Plivo opens the stream with a start event naming the stream and call."""
    while True:
        message = json.loads(await websocket.receive_text())
        if message.get("event") == "start":
            logger.debug(f"Plivo start event: {message}")
            return message.get("start") or message


@app.websocket("/ws")
async def stream(websocket: WebSocket, token: str | None = Query(None)):
    if not authorized(token):
        await websocket.close(code=1008)
        return
    await websocket.accept()

    start = await read_start(websocket)
    stream_id, call_id = start.get("streamId"), start.get("callId")
    logger.info(f"Call {call_id} connected on stream {stream_id}")

    auth_id, auth_token = env("PLIVO_AUTH_ID"), env("PLIVO_AUTH_TOKEN")
    serializer = PlivoFrameSerializer(
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
    worker = build_worker(
        transport, PipelineParams(audio_in_sample_rate=PIPELINE_INPUT_RATE), call_id=call_id
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

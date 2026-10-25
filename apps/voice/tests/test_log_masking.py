"""The phone server's own logs never carry a secret.

uvicorn's access log wrote every webhook's full URL, `/answer?token=<WEBHOOK_SECRET>`,
so anyone who could read the log (or a grep of it pasted somewhere) had the
secret. It leaked that way twice on 2026-10-25.
"""

import logging
import logging.config

import server

SECRET = "s3cret-value-123"


def access_record(path: str) -> logging.LogRecord:
    # The shape uvicorn's access logger uses: client, method, path, version, status.
    return logging.LogRecord("uvicorn.access", logging.INFO, __file__, 1,
                             '%s - "%s %s HTTP/%s" %d',
                             ("127.0.0.1:5000", "POST", path, "1.1", 200), None)


def test_the_filter_masks_the_secret_and_stream_token_in_access_lines():
    record = access_record(f"/answer?token={SECRET}&agent=default&peer=%2B91")
    assert server.MaskSecrets().filter(record) is True
    line = record.getMessage()
    assert SECRET not in line
    assert "token=***" in line and "agent=default" in line
    ws = access_record("/ws?stream=abcDEF123")
    server.MaskSecrets().filter(ws)
    assert "abcDEF123" not in ws.getMessage()


def test_a_plain_message_is_masked_too():
    record = logging.LogRecord("uvicorn.error", logging.INFO, __file__, 1,
                               f"GET /hangup?secret={SECRET}", None, None)
    server.MaskSecrets().filter(record)
    assert SECRET not in record.getMessage()


def test_uvicorns_logging_as_the_server_configures_it_writes_no_secret(capsys):
    logging.config.dictConfig(server.uvicorn_log_config())
    logging.getLogger("uvicorn.access").info('%s - "%s %s HTTP/%s" %d', "127.0.0.1:5000", "GET",
                                             f"/answer?token={SECRET}&agent=default", "1.1", 200)
    logging.getLogger("uvicorn.error").info("Invalid HTTP request: /x?token=%s", SECRET)
    out = capsys.readouterr()
    both = out.out + out.err
    assert '"GET /answer?token=***&agent=default HTTP/1.1" 200' in both  # the access line, intact
    assert "Invalid HTTP request: /x?token=***" in both
    assert SECRET not in both and "Logging error" not in both


def test_the_server_starts_uvicorn_with_that_config(monkeypatch):
    seen = {}
    monkeypatch.setattr(server.uvicorn, "run", lambda app, **kw: seen.update(kw))

    async def no_warm_up():
        return None

    monkeypatch.setattr(server, "warm_up", no_warm_up)
    for key in ("WEBHOOK_SECRET", "PUBLIC_HOST", "PLIVO_AUTH_ID", "PLIVO_AUTH_TOKEN"):
        monkeypatch.setenv(key, "x")
    server.main()
    assert seen["log_config"] == server.uvicorn_log_config()

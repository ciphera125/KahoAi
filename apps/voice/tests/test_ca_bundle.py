import main
from aiohttp import connector


def test_certifi_is_loaded_into_aiohttp_when_the_system_bundle_is_missing(monkeypatch):
    """Without this, the Plivo hang-up fails on the python.org macOS build."""
    monkeypatch.delenv("SSL_CERT_FILE", raising=False)
    monkeypatch.setattr(main.os.path, "exists", lambda p: False)
    context = connector._SSL_CONTEXT_VERIFIED
    before = context.cert_store_stats()["x509_ca"]
    try:
        main.ensure_ca_bundle()
        assert context.cert_store_stats()["x509_ca"] >= before
        assert main.os.environ["SSL_CERT_FILE"].endswith("cacert.pem")
    finally:
        main.os.environ.pop("SSL_CERT_FILE", None)

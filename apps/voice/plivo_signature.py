"""Check Plivo's V3 signature on a webhook, so only Plivo can post one.

Plivo signs every callback with the account's auth token: HMAC-SHA256 over the
URL it called (query sorted) and, for a POST, the form fields as key+value pairs
in key order, then "." and a per-request nonce, base64-encoded. It sends the
result in X-Plivo-Signature-V3 (several, comma-separated, when the token was
rotated) and the nonce in X-Plivo-Signature-V3-Nonce. Rebuilt here from the
rules in plivo-python's plivo/utils/signature_v3.py; the SDK is not a dependency.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
from urllib.parse import parse_qs, urlsplit, urlunsplit


def _query(params: dict) -> str:
    return "&".join(f"{k}={v}" for k in sorted(params) for v in sorted(params[k]))


def _fields(params: dict) -> str:
    return "".join(f"{k}{v}" for k in sorted(params) for v in sorted(params[k]))


def base_string(method: str, url: str, body: dict) -> str:
    parts = urlsplit(url)
    bare = urlunsplit((parts.scheme, parts.netloc, parts.path, "", ""))
    query = _query(parse_qs(parts.query, keep_blank_values=True))
    if method.upper() == "GET" or not body:
        return f"{bare}?{query}" if query else bare
    return f"{bare}?{query}" + ("." if query else "") + _fields(body)


def sign(method: str, url: str, body: dict, nonce: str, auth_token: str) -> str:
    """The signature Plivo would send; used by our own preflight request, which
    must pass the same check as Plivo's."""
    message = f"{base_string(method, url, body or {})}.{nonce}".encode("utf-8")
    return base64.b64encode(
        hmac.new(auth_token.encode("utf-8"), message, hashlib.sha256).digest()).decode()


def valid(method: str, url: str, body: dict, nonce: str | None, signature: str | None,
          auth_token: str | None) -> bool:
    """Whether `signature` is Plivo's for this request. `body` is the parsed form,
    as parse_qs gives it (a list per key)."""
    if not (nonce and signature and auth_token):
        return False
    expected = sign(method, url, body, nonce, auth_token)
    return any(hmac.compare_digest(expected, s.strip()) for s in signature.split(","))

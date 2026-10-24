"""Plivo's V3 webhook signature, so a forged /hangup cannot write an outcome.

The expected strings are built by hand from Plivo's rules (plivo-python,
plivo/utils/signature_v3.py): for a POST, the URL with its query sorted, then
".", then the body's keys and values concatenated in key order; that, ".",
the nonce, HMAC-SHA256 with the auth token, base64.
"""

import base64
import hashlib
import hmac

import plivo_signature
import pytest

TOKEN = "auth-token-123"


def sign(base: str, nonce: str) -> str:
    return base64.b64encode(hmac.new(TOKEN.encode(), f"{base}.{nonce}".encode(),
                                     hashlib.sha256).digest()).decode()


URL = "https://kaho.example.com/hangup?token=s3cret&peer=%2B919876543210"
BODY = {"CallUUID": ["abc-1"], "CallStatus": ["completed"], "BillDuration": ["12"]}
BASE = ("https://kaho.example.com/hangup?peer=+919876543210&token=s3cret."
        "BillDuration12CallStatuscompletedCallUUIDabc-1")


def test_a_genuine_post_signature_is_accepted():
    assert plivo_signature.valid("POST", URL, BODY, "n0nce", sign(BASE, "n0nce"), TOKEN)


def test_any_of_several_signatures_may_match():
    sig = "bogus," + sign(BASE, "n0nce")
    assert plivo_signature.valid("POST", URL, BODY, "n0nce", sig, TOKEN)


def test_a_get_signs_the_sorted_query_only():
    base = "https://kaho.example.com/hangup?peer=+919876543210&token=s3cret"
    assert plivo_signature.valid("GET", URL, {}, "n", sign(base, "n"), TOKEN)


@pytest.mark.parametrize("change", ["body", "url", "nonce", "token"])
def test_anything_changed_breaks_it(change):
    good = sign(BASE, "n0nce")
    body = {**BODY, "CallStatus": ["no-answer"]} if change == "body" else BODY
    url = URL.replace("hangup", "answer") if change == "url" else URL
    nonce = "other" if change == "nonce" else "n0nce"
    token = "other-token" if change == "token" else TOKEN
    assert not plivo_signature.valid("POST", url, body, nonce, good, token)


@pytest.mark.parametrize("sig, nonce, token", [(None, "n", TOKEN), ("x", None, TOKEN),
                                               ("x", "n", None), ("", "", "")])
def test_missing_pieces_are_invalid(sig, nonce, token):
    assert not plivo_signature.valid("POST", URL, BODY, nonce, sig, token)

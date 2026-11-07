"""One-off: lock the recordings bucket down (private, size cap, audio only).

    python scripts/harden_recordings_bucket.py          # show what it would change
    python scripts/harden_recordings_bucket.py --apply  # change it

Reads SUPABASE_URL, SUPABASE_SECRET_KEY and SUPABASE_RECORDINGS_BUCKET from the
environment (the root .env is loaded). The key is never printed.
"""

import argparse
import os
import sys

import httpx
from dotenv import load_dotenv

WANT = {
    "public": False,
    "file_size_limit": 50 * 1024 * 1024,
    "allowed_mime_types": ["audio/opus", "audio/ogg", "audio/wav", "audio/x-wav"],
}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true")
    apply = parser.parse_args().apply
    load_dotenv()
    url = (os.getenv("SUPABASE_URL") or "").rstrip("/")
    key = os.getenv("SUPABASE_SECRET_KEY") or ""
    bucket = os.getenv("SUPABASE_RECORDINGS_BUCKET") or ""
    if not (url and key and bucket):
        print("SUPABASE_URL, SUPABASE_SECRET_KEY and SUPABASE_RECORDINGS_BUCKET must be set")
        return 1
    headers = {"Authorization": f"Bearer {key}", "apikey": key}
    with httpx.Client(timeout=15) as client:
        r = client.get(f"{url}/storage/v1/bucket/{bucket}", headers=headers)
        if r.status_code != 200:
            print(f"could not read the bucket: HTTP {r.status_code}")
            return 1
        now = r.json()
        print("now :", {k: now.get(k) for k in WANT})
        print("want:", WANT)
        if all(now.get(k) == v for k, v in WANT.items()):
            print("already as wanted")
            return 0
        if not apply:
            print("dry run; pass --apply to change it")
            return 0
        r = client.put(f"{url}/storage/v1/bucket/{bucket}", headers=headers, json=WANT)
        print("updated" if r.status_code == 200 else f"refused: HTTP {r.status_code}")
        return 0 if r.status_code == 200 else 1


if __name__ == "__main__":
    sys.exit(main())

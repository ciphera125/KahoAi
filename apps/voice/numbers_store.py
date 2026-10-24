"""Our phone numbers, the provider each is on, and that provider's credentials.

Edited on the local admin page. Plivo is the only provider the call pipeline can
place and take calls on today; Exotel, Twilio and SIP trunk numbers can be saved
but show as not connected until their telephony is built.

Our Plivo number from .env is listed from the start without copying its token
to disk: until a token is saved here, it is read from .env. A token saved here
wins over .env. Secrets never leave this module in full (`list_public` masks
them), so the page can show that one is set without being able to read it.
"""

import json
import os
import uuid
from datetime import UTC, datetime
from pathlib import Path

from loguru import logger
from prompt_store import normalize_number, write_json_atomic

DEFAULT_PATH = Path(__file__).resolve().parent.parent.parent / "data" / "numbers.json"

# field name, label, secret
PROVIDERS = {
    "plivo": {"label": "Plivo", "connected": True, "fields": [
        ("auth_id", "Auth ID", False), ("auth_token", "Auth token", True)]},
    "exotel": {"label": "Exotel", "connected": False, "fields": [
        ("account_sid", "Account SID", False), ("api_key", "API key", False),
        ("api_token", "API token", True), ("subdomain", "Subdomain (api.in.exotel.com)", False)]},
    "twilio": {"label": "Twilio", "connected": False, "fields": [
        ("account_sid", "Account SID", False), ("auth_token", "Auth token", True)]},
    "sip": {"label": "SIP trunk", "connected": False, "fields": [
        ("sip_host", "SIP host or domain", False), ("username", "Username", False),
        ("password", "Password", True), ("transport", "Transport (udp, tcp or tls)", False)]},
}
ENV_PLIVO = {"auth_id": "PLIVO_AUTH_ID", "auth_token": "PLIVO_AUTH_TOKEN"}


def mask(value: str) -> str:
    return f"••••{value[-4:]}" if value else ""


class NumberStore:
    def __init__(self, path: Path):
        self.path = Path(path)

    def _read(self) -> list[dict]:
        if not self.path.exists():
            return self._seed()
        data = json.loads(self.path.read_text(encoding="utf-8"))
        return data.get("numbers", [])

    def _seed(self) -> list[dict]:
        """Our Plivo number from .env, its credentials left in .env."""
        rows = []
        try:
            number = normalize_number(os.getenv("PLIVO_FROM_NUMBER") or "")
        except ValueError:
            number = None
        if number:
            rows.append(self._row("plivo", number, "Main line", {}, env_backed=True,
                                  is_default=True))
            self._write(rows)  # nothing to seed, nothing saved: it is tried again next time
        return rows

    def _write(self, rows: list[dict]) -> None:
        write_json_atomic(self.path, {"numbers": rows})

    @staticmethod
    def _row(provider, number, label, credentials, env_backed=False, is_default=False) -> dict:
        now = datetime.now(UTC).isoformat()
        return {"id": uuid.uuid4().hex[:12], "provider": provider, "number": number,
                "label": label, "credentials": credentials, "env_backed": env_backed,
                "is_default": is_default, "created_at": now, "updated_at": now}

    def _find(self, rows, number_id) -> dict:
        for row in rows:
            if row["id"] == number_id:
                return row
        raise KeyError(number_id)

    def _credentials(self, row: dict) -> dict:
        stored = {k: v for k, v in row.get("credentials", {}).items() if v}
        if row.get("env_backed") and row["provider"] == "plivo":
            env = {k: os.getenv(v) or "" for k, v in ENV_PLIVO.items()}
            return {**env, **stored}
        return stored

    def credentials(self, number_id: str) -> dict:
        return self._credentials(self._find(self._read(), number_id))

    def _status(self, row: dict) -> str:
        provider = PROVIDERS[row["provider"]]
        if not provider["connected"]:
            return "not_connected"
        creds = self._credentials(row)
        complete = all(creds.get(f) for f, _, _ in provider["fields"])
        return "active" if complete else "incomplete"

    def list_public(self) -> list[dict]:
        out = []
        for row in self._read():
            creds = self._credentials(row)
            secret = {f for f, _, s in PROVIDERS[row["provider"]]["fields"] if s}
            out.append({
                "id": row["id"], "provider": row["provider"],
                "provider_label": PROVIDERS[row["provider"]]["label"],
                "number": row["number"], "label": row.get("label", ""),
                "is_default": row.get("is_default", False), "status": self._status(row),
                "credentials_from_env": bool(row.get("env_backed")) and not row.get("credentials"),
                "credentials": {f: (mask(creds.get(f, "")) if f in secret else creds.get(f, ""))
                                for f, _, _ in PROVIDERS[row["provider"]]["fields"]},
                "updated_at": row.get("updated_at"),
            })
        return out

    def add(self, provider: str, number: str, label: str, credentials: dict) -> dict:
        if provider not in PROVIDERS:
            raise ValueError(f"unknown provider {provider!r}")
        number = normalize_number(number)
        rows = self._read()
        if any(r["number"] == number for r in rows):
            raise ValueError(f"{number} is already added")
        clean = {f: str((credentials or {}).get(f) or "").strip()
                 for f, _, _ in PROVIDERS[provider]["fields"]}
        missing = [lbl for f, lbl, _ in PROVIDERS[provider]["fields"] if not clean[f]]
        if missing:
            raise ValueError(f"missing: {', '.join(missing)}")
        row = self._row(provider, number, (label or "").strip(), clean,
                        is_default=not rows)
        rows.append(row)
        self._write(rows)
        return row

    def update(self, number_id: str, label: str | None = None,
               credentials: dict | None = None) -> dict:
        rows = self._read()
        row = self._find(rows, number_id)
        if label is not None:
            row["label"] = label.strip()
        for field, _, _ in PROVIDERS[row["provider"]]["fields"]:
            value = str((credentials or {}).get(field) or "").strip()
            if value:  # blank keeps what is there, so a masked secret is never overwritten
                row.setdefault("credentials", {})[field] = value
        row["updated_at"] = datetime.now(UTC).isoformat()
        self._write(rows)
        return row

    def delete(self, number_id: str) -> None:
        rows = self._read()
        row = self._find(rows, number_id)
        rows.remove(row)
        if row.get("is_default") and rows:
            rows[0]["is_default"] = True
        self._write(rows)

    def set_default(self, number_id: str) -> None:
        rows = self._read()
        self._find(rows, number_id)
        for row in rows:
            row["is_default"] = row["id"] == number_id
        self._write(rows)


def default_store() -> NumberStore:
    return NumberStore(Path(os.getenv("NUMBER_STORE_PATH") or DEFAULT_PATH))


def plivo_credentials(store: NumberStore | None = None) -> tuple[str | None, str | None]:
    """(auth_id, auth_token) for our Plivo number: saved here first, then .env. Never raises."""
    env = (os.getenv("PLIVO_AUTH_ID"), os.getenv("PLIVO_AUTH_TOKEN"))
    try:
        store = store or default_store()
        rows = [r for r in store.list_public()
                if r["provider"] == "plivo" and r["status"] == "active"]
        if not rows:
            return env
        row = next((r for r in rows if r["is_default"]), rows[0])
        creds = store.credentials(row["id"])
        return creds["auth_id"], creds["auth_token"]
    except Exception as e:  # a call must never fail over where its credentials live
        logger.error(f"Number store unreadable, using Plivo credentials from .env: {e!r}")
        return env

"""Accounts for the Studio: sign up, sign in, sessions.

The first account is the workspace's owner. Anyone after that needs the owner's
invite code, so a sign-up page left open is not a way in. Passwords are kept
only as scrypt hashes; a session is a random token the browser holds in an
HttpOnly cookie, and only its SHA-256 is written down, so a copy of the file
signs no one in. Repeated wrong passwords lock an email out for a while, but
only from browsers that have never signed in to it: a browser that has carries a
device cookie (OWASP's "device cookies"), counted on its own, so a stranger
guessing cannot lock the owner out of their own browser. Invite codes work once
and expire after a week.

data/users.json, gitignored, written atomically like the other stores.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import secrets
import threading
import time
from datetime import UTC, datetime
from pathlib import Path

from prompt_store import write_json_atomic

DEFAULT_PATH = Path(__file__).resolve().parent.parent.parent / "data" / "users.json"
SESSION_SECS = 7 * 24 * 3600
MAX_SESSIONS_PER_USER = 10
MAX_FAILURES = 5
LOCKOUT_SECS = 300
INVITE_SECS = 7 * 24 * 3600
MAX_DEVICES_PER_USER = 10
MIN_PASSWORD, MAX_PASSWORD = 8, 200
EMAIL = re.compile(r"^[^@\s]{1,64}@[^@\s]{1,190}\.[^@\s]{2,24}$")
# scrypt at n=2**14 takes ~50ms here: slow to guess, quick to sign in.
SCRYPT = {"n": 2**14, "r": 8, "p": 1, "dklen": 32}


class AuthError(Exception):
    """Wrong password, locked out, or not allowed to sign up. Safe to show."""


def _now() -> str:
    return datetime.now(UTC).isoformat()


def _hash(password: str, salt: bytes) -> str:
    return hashlib.scrypt(password.encode("utf-8"), salt=salt, **SCRYPT).hex()


def _digest(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


# Spent on an unknown email too, so a wrong email takes as long as a wrong password.
_DUMMY_SALT = secrets.token_bytes(16)
_DUMMY_HASH = _hash("not a real password", _DUMMY_SALT)


class AuthStore:
    def __init__(self, path: Path):
        self.path = Path(path)
        self._failures: dict[str, list[float]] = {}
        self._lock = threading.Lock()

    def _read(self) -> dict:
        if not self.path.exists():
            return {"users": [], "sessions": {}, "invite": None}
        data = json.loads(self.path.read_text(encoding="utf-8"))
        data.setdefault("users", [])
        data.setdefault("sessions", {})
        return data

    def _write(self, data: dict) -> None:
        write_json_atomic(self.path, data)

    def has_accounts(self) -> bool:
        return bool(self._read()["users"])

    @staticmethod
    def _live_invite(data: dict) -> dict | None:
        invite = data.get("invite")
        return invite if invite and invite.get("expires", 0) > time.time() else None

    def invite(self, renew: bool = False) -> dict:
        """The current invite ({code, expires}), made fresh if there is none,
        it has expired or been used, or `renew` asks for a new one."""
        with self._lock:
            data = self._read()
            data.pop("invite_code", None)  # the old, never-expiring form
            invite = None if renew else self._live_invite(data)
            if invite is None:
                invite = {"code": secrets.token_urlsafe(9), "expires": time.time() + INVITE_SECS}
                data["invite"] = invite
                self._write(data)
            return dict(invite)

    def invite_code(self) -> str:
        return self.invite()["code"]

    def new_invite_code(self) -> str:
        return self.invite(renew=True)["code"]

    def sign_up(self, name: str, email: str, password: str, company: str = "",
                invite: str | None = None) -> dict:
        name = " ".join(str(name or "").split())
        email = str(email or "").strip().lower()
        company = " ".join(str(company or "").split())
        password = str(password or "")
        if not name or len(name) > 80:
            raise ValueError("enter your name (up to 80 characters)")
        if not EMAIL.match(email):
            raise ValueError("enter a valid email address")
        if len(company) > 80:
            raise ValueError("the company name is over 80 characters")
        if not MIN_PASSWORD <= len(password) <= MAX_PASSWORD:
            raise ValueError(f"the password must be {MIN_PASSWORD} to {MAX_PASSWORD} characters")
        with self._lock:
            data = self._read()
            if data["users"]:
                live = self._live_invite(data)
                code = (live or {}).get("code") or ""
                if not (invite and code and hmac.compare_digest(str(invite), code)):
                    raise AuthError("This workspace already has an owner. Ask them for an "
                                    "invite code, or sign in. Codes work once, for a week.")
            if any(u["email"] == email for u in data["users"]):
                raise ValueError("an account with this email already exists; sign in")
            salt = secrets.token_bytes(16)
            user = {"id": "u_" + secrets.token_hex(6), "name": name, "email": email,
                    "company": company, "role": "member" if data["users"] else "owner",
                    "salt": salt.hex(), "hash": _hash(password, salt), "created_at": _now(),
                    "seen_at": None}
            data["users"].append(user)
            if user["role"] == "member":
                data["invite"] = None  # used: the owner hands out a new one
            self._write(data)
        return self._public(user)

    def check_password(self, email: str, password: str, device: str | None = None) -> dict:
        """The user, if the password is right. Wrong guesses count against the
        email from unknown browsers, and against the device from a browser that
        has signed in to this account before, so each has its own lockout."""
        email = str(email or "").strip().lower()
        password = str(password or "")[:MAX_PASSWORD]
        now = time.time()
        user = next((u for u in self._read()["users"] if u["email"] == email), None)
        trusted = bool(device and isinstance(device, str) and len(device) <= 200 and user
                       and _digest(device) in user.get("devices", []))
        key = f"device:{_digest(device)}" if trusted else f"email:{email}"
        with self._lock:
            recent = [t for t in self._failures.get(key, []) if now - t < LOCKOUT_SECS]
            self._failures[key] = recent
            if len(recent) >= MAX_FAILURES:
                raise AuthError("Too many wrong passwords. Try again in a few minutes.")
        if user is None:
            hmac.compare_digest(_hash(password, _DUMMY_SALT), _DUMMY_HASH)
            ok = False
        else:
            ok = hmac.compare_digest(_hash(password, bytes.fromhex(user["salt"])), user["hash"])
        if not ok:
            with self._lock:
                self._failures.setdefault(key, []).append(now)
            raise AuthError("That email and password do not match.")
        self._failures.pop(key, None)
        return self._public(user)

    def issue_device(self, user_id: str) -> str:
        """A token marking this browser as one that has signed in to this account."""
        token = secrets.token_urlsafe(32)
        with self._lock:
            data = self._read()
            for u in data["users"]:
                if u["id"] == user_id:
                    u["devices"] = (u.get("devices", []) + [_digest(token)])[-MAX_DEVICES_PER_USER:]
            self._write(data)
        return token

    def knows_device(self, user_id: str, device: str | None) -> bool:
        if not device or len(device) > 200:
            return False
        user = next((u for u in self._read()["users"] if u["id"] == user_id), None)
        return bool(user and _digest(device) in user.get("devices", []))

    def change_password(self, user_id: str, current: str, new: str) -> None:
        """Set a new password and end every session of this user."""
        new = str(new or "")
        if not MIN_PASSWORD <= len(new) <= MAX_PASSWORD:
            raise ValueError(
                f"the new password must be {MIN_PASSWORD} to {MAX_PASSWORD} characters")
        with self._lock:
            data = self._read()
            user = next((u for u in data["users"] if u["id"] == user_id), None)
            if user is None or not hmac.compare_digest(
                    _hash(str(current or "")[:MAX_PASSWORD], bytes.fromhex(user["salt"])),
                    user["hash"]):
                raise AuthError("Your current password is not right.")
            salt = secrets.token_bytes(16)
            user.update(salt=salt.hex(), hash=_hash(new, salt))
            data["sessions"] = {k: v for k, v in data["sessions"].items()
                                if v["user_id"] != user_id}
            self._write(data)

    def start_session(self, user_id: str) -> str:
        token = secrets.token_urlsafe(32)
        with self._lock:
            data = self._read()
            now = time.time()
            sessions = {k: v for k, v in data["sessions"].items() if v["expires"] > now}
            mine = sorted((k for k, v in sessions.items() if v["user_id"] == user_id),
                          key=lambda k: sessions[k]["expires"])
            for old in mine[: max(0, len(mine) - MAX_SESSIONS_PER_USER + 1)]:
                del sessions[old]
            sessions[_digest(token)] = {"user_id": user_id, "expires": now + SESSION_SECS}
            data["sessions"] = sessions
            self._write(data)
        return token

    def user_for(self, token: str | None) -> dict | None:
        if not token or not isinstance(token, str) or len(token) > 200:
            return None
        try:
            data = self._read()
        except (OSError, json.JSONDecodeError):
            return None
        session = data["sessions"].get(_digest(token))
        if not session or session["expires"] <= time.time():
            return None
        user = next((u for u in data["users"] if u["id"] == session["user_id"]), None)
        return self._public(user) if user else None

    def end_session(self, token: str | None) -> None:
        if not token:
            return
        with self._lock:
            data = self._read()
            if data["sessions"].pop(_digest(token), None) is not None:
                self._write(data)

    def mark_seen(self, user_id: str, at: str) -> None:
        with self._lock:
            data = self._read()
            for u in data["users"]:
                if u["id"] == user_id:
                    u["seen_at"] = at
            self._write(data)

    def public(self, user_id: str) -> dict | None:
        user = next((u for u in self._read()["users"] if u["id"] == user_id), None)
        return self._public(user) if user else None

    def members(self) -> list[dict]:
        return [self._public(u) for u in self._read()["users"]]

    @staticmethod
    def _public(user: dict) -> dict:
        return {k: user.get(k) for k in ("id", "name", "email", "company", "role",
                                         "created_at", "seen_at")}


_stores: dict[str, AuthStore] = {}


def default_store() -> AuthStore:
    """One store per file, so the lockout counts survive between requests."""
    path = str(Path(os.getenv("USER_STORE_PATH") or DEFAULT_PATH))
    if path not in _stores:
        _stores[path] = AuthStore(Path(path))
    return _stores[path]

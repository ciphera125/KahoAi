"""Contacts for the Studio: people, their numbers, and tags on those numbers.

A JSON file (data/contacts.json, gitignored), like the other Studio stores. It
holds names and phone numbers, so it stays out of git and off any shared drive.
"""

from __future__ import annotations  # `list` is also a method name below

import json
import os
import uuid
from datetime import UTC, datetime
from pathlib import Path

from prompt_store import normalize_number, write_json_atomic

DEFAULT_PATH = Path(__file__).resolve().parent.parent.parent / "data" / "contacts.json"
TAG_COLOURS = ("marigold", "plum", "orchid", "teal", "silver", "rose")
MAX_NAME = 80
MAX_TAG = 30


def _id() -> str:
    return uuid.uuid4().hex[:12]


def _name(raw: str, limit: int, what: str) -> str:
    name = " ".join(str(raw or "").split())
    if not name:
        raise ValueError(f"the {what} is empty")
    if len(name) > limit:
        raise ValueError(f"the {what} is over {limit} characters")
    return name


class ContactStore:
    def __init__(self, path: Path):
        self.path = Path(path)

    def _read(self) -> dict:
        if not self.path.exists():
            return {"contacts": [], "tags": []}
        return json.loads(self.path.read_text(encoding="utf-8"))

    def _write(self, data: dict) -> None:
        write_json_atomic(self.path, data)

    @staticmethod
    def _contact(data: dict, contact_id: str) -> dict:
        for c in data["contacts"]:
            if c["id"] == contact_id:
                return c
        raise KeyError(contact_id)

    @staticmethod
    def _number(contact: dict, number_id: str) -> dict:
        for n in contact["numbers"]:
            if n["id"] == number_id:
                return n
        raise KeyError(number_id)

    # --- contacts --------------------------------------------------------

    def list(self) -> list[dict]:
        return self._read()["contacts"]

    def get(self, contact_id: str) -> dict:
        return self._contact(self._read(), contact_id)

    def create(self, name: str, numbers: list[str]) -> dict:
        name = _name(name, MAX_NAME, "name")
        clean = []
        for raw in numbers or []:
            number = normalize_number(raw)
            if number not in clean:
                clean.append(number)
        data = self._read()
        contact = {"id": _id(), "name": name, "created_at": datetime.now(UTC).isoformat(),
                   "tags": [], "numbers": [{"id": _id(), "number": n, "tags": []} for n in clean]}
        data["contacts"].append(contact)
        self._write(data)
        return contact

    def rename(self, contact_id: str, name: str) -> dict:
        data = self._read()
        contact = self._contact(data, contact_id)
        contact["name"] = _name(name, MAX_NAME, "name")
        self._write(data)
        return contact

    def set_contact_tags(self, contact_id: str, tags: list[str]) -> dict:
        """Tags on the contact itself, as opposed to on one of its numbers."""
        data = self._read()
        contact = self._contact(data, contact_id)
        contact["tags"] = self._valid_tags(data, tags)
        self._write(data)
        return contact

    def set_dnc(self, contact_id: str, dnc: bool) -> dict:
        """Do not call: the Studio refuses to dial any of this contact's numbers."""
        data = self._read()
        contact = self._contact(data, contact_id)
        contact["dnc"] = bool(dnc)
        self._write(data)
        return contact

    def is_dnc(self, number: str) -> bool:
        number = normalize_number(number)
        return any(c.get("dnc") and any(n["number"] == number for n in c["numbers"])
                   for c in self._read()["contacts"])

    def delete(self, contact_id: str) -> None:
        data = self._read()
        data["contacts"].remove(self._contact(data, contact_id))
        self._write(data)

    def delete_many(self, contact_ids: list[str]) -> int:
        data = self._read()
        before = len(data["contacts"])
        data["contacts"] = [c for c in data["contacts"] if c["id"] not in set(contact_ids)]
        self._write(data)
        return before - len(data["contacts"])

    # --- numbers ---------------------------------------------------------

    def add_number(self, contact_id: str, number: str, tags: list[str] | None = None) -> dict:
        data = self._read()
        contact = self._contact(data, contact_id)
        number = normalize_number(number)
        if any(n["number"] == number for n in contact["numbers"]):
            raise ValueError(f"{number} is already on this contact")
        entry = {"id": _id(), "number": number, "tags": self._valid_tags(data, tags or [])}
        contact["numbers"].append(entry)
        self._write(data)
        return entry

    def update_number(self, contact_id: str, number_id: str, number: str | None = None,
                      tags: list[str] | None = None) -> dict:
        data = self._read()
        contact = self._contact(data, contact_id)
        entry = self._number(contact, number_id)
        if number is not None:
            number = normalize_number(number)
            if any(n["number"] == number and n["id"] != number_id for n in contact["numbers"]):
                raise ValueError(f"{number} is already on this contact")
            entry["number"] = number
        if tags is not None:
            entry["tags"] = self._valid_tags(data, tags)
        self._write(data)
        return entry

    def delete_number(self, contact_id: str, number_id: str) -> None:
        data = self._read()
        contact = self._contact(data, contact_id)
        contact["numbers"].remove(self._number(contact, number_id))
        self._write(data)

    # --- tags ------------------------------------------------------------

    @staticmethod
    def _valid_tags(data: dict, tags: list[str]) -> list[str]:
        known = {t["id"] for t in data["tags"]}
        unknown = [t for t in tags if t not in known]
        if unknown:
            raise ValueError("unknown tag")
        return list(dict.fromkeys(tags))

    def tags(self) -> list[dict]:
        return self._read()["tags"]

    def _check_tag(self, data: dict, name: str, colour: str, tag_id: str | None = None) -> str:
        name = _name(name, MAX_TAG, "tag name")
        if colour not in TAG_COLOURS:
            raise ValueError(f"colour must be one of {', '.join(TAG_COLOURS)}")
        if any(t["name"].lower() == name.lower() and t["id"] != tag_id for t in data["tags"]):
            raise ValueError(f"there is already a tag called {name}")
        return name

    def create_tag(self, name: str, colour: str) -> dict:
        data = self._read()
        tag = {"id": _id(), "name": self._check_tag(data, name, colour), "color": colour}
        data["tags"].append(tag)
        self._write(data)
        return tag

    def update_tag(self, tag_id: str, name: str | None = None, color: str | None = None) -> dict:
        data = self._read()
        tag = next((t for t in data["tags"] if t["id"] == tag_id), None)
        if tag is None:
            raise KeyError(tag_id)
        tag["name"] = self._check_tag(data, name or tag["name"], color or tag["color"], tag_id)
        tag["color"] = color or tag["color"]
        self._write(data)
        return tag

    def delete_tag(self, tag_id: str) -> None:
        data = self._read()
        if not any(t["id"] == tag_id for t in data["tags"]):
            raise KeyError(tag_id)
        data["tags"] = [t for t in data["tags"] if t["id"] != tag_id]
        for c in data["contacts"]:
            c["tags"] = [t for t in c.get("tags", []) if t != tag_id]
            for n in c["numbers"]:
                n["tags"] = [t for t in n["tags"] if t != tag_id]
        self._write(data)


def default_store() -> ContactStore:
    return ContactStore(Path(os.getenv("CONTACT_STORE_PATH") or DEFAULT_PATH))

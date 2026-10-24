"""Agents and their prompts, for the Studio's Agents and Prompts pages and for calls.

An agent is a name, a description, the tools it may use, its call settings and
the one of its prompts it uses on calls. A prompt belongs to at most one agent and
keeps every saved version (newest first). Numbers route to an agent, which is what
an inbound call on that number gets.

One JSON file (data/agents.json, gitignored). The phone server reads it at the
start of every call through call_config() and agent_for_number(), which never
raise: a broken store means the default persona, never a failed call.

The first time it is opened it takes over the prompts saved per number before
agents existed (data/number_prompts.json), history included, as one agent each.
"""

from __future__ import annotations

import json
import os
import re
import secrets
from datetime import UTC, datetime
from pathlib import Path

from loguru import logger
from prompt_store import (
    DEFAULT_PATH as LEGACY_PATH,
)
from prompt_store import (
    MAX_PROMPT_CHARS,
    MAX_VERSIONS,
    PromptStore,
    normalize_number,
    write_json_atomic,
)

DEFAULT_PATH = Path(__file__).resolve().parent.parent.parent / "data" / "agents.json"
# The tools in tools.REGISTRY, named here so the Studio need not import the pipeline.
KNOWN_TOOLS = ("end_call", "capture_lead", "transfer_to_human", "call_webhook")
DEFAULT_TOOLS = ["end_call", "capture_lead"]
AGENT_ID = re.compile(r"^ag_[0-9a-f]{12}$")
PROMPT_ID = re.compile(r"^pr_[0-9a-f]{12}$")
MAX_NAME = 60
MAX_DESCRIPTION = 300
MAX_OPENING = 200
MAX_MINUTES = 30
RING_SECS = (15, 60)
DEFAULT_SETTINGS = {"opening_line": "", "max_minutes": 10, "ring_secs": 40}
SETTING_LABELS = {"max_minutes": "Longest call (minutes)", "ring_secs": "Ring for (seconds)"}


def _now() -> str:
    return datetime.now(UTC).isoformat()


def _id(prefix: str) -> str:
    return f"{prefix}_{secrets.token_hex(6)}"


def _clean(raw, limit: int, what: str, required: bool = True) -> str:
    text = " ".join(str(raw or "").split())
    if required and not text:
        raise ValueError(f"the {what} is empty")
    if len(text) > limit:
        raise ValueError(f"the {what} is over {limit} characters")
    return text


def _prompt_text(raw) -> str:
    text = str(raw or "").strip()
    if not text:
        raise ValueError("the prompt is empty")
    if len(text) > MAX_PROMPT_CHARS:
        raise ValueError(f"the prompt is over {MAX_PROMPT_CHARS} characters")
    return text


def _settings(current: dict, changes: dict) -> dict:
    out = {**DEFAULT_SETTINGS, **current}
    for key, value in (changes or {}).items():
        if key == "opening_line":
            out[key] = _clean(value, MAX_OPENING, "opening line", required=False)
        elif key in ("max_minutes", "ring_secs"):
            if isinstance(value, bool):
                raise ValueError(f"{SETTING_LABELS[key]} must be a number")
            try:
                number = int(value)
            except (TypeError, ValueError):
                raise ValueError(f"{SETTING_LABELS[key]} must be a number") from None
            low, high = (1, MAX_MINUTES) if key == "max_minutes" else RING_SECS
            if not low <= number <= high:
                raise ValueError(f"{SETTING_LABELS[key]} must be between {low} and {high}")
            out[key] = number
        else:
            raise ValueError(f"unknown setting {key!r}")
    return out


class AgentStore:
    def __init__(self, path: Path, legacy_path: Path | None = None):
        self.path = Path(path)
        self.legacy_path = Path(legacy_path) if legacy_path else None

    # --- file -----------------------------------------------------------------

    def _read(self) -> dict:
        """The whole store. Raises ValueError if the file exists but is broken."""
        if not self.path.exists():
            return self._migrated()
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as e:
            raise ValueError(f"{self.path} is not valid JSON: {e}") from e
        if not isinstance(data, dict):
            raise ValueError(f"{self.path} does not hold an object")
        for key in ("agents", "prompts", "routes"):
            data.setdefault(key, {})
        return data

    def _write(self, data: dict) -> None:
        write_json_atomic(self.path, data)

    def _migrated(self) -> dict:
        data = {"agents": {}, "prompts": {}, "routes": {}}
        if not self.legacy_path or not self.legacy_path.exists():
            return data
        try:
            legacy = PromptStore(self.legacy_path)
            numbers = list(json.loads(self.legacy_path.read_text(encoding="utf-8")))
            for number in numbers:
                versions = legacy.versions(number)
                if not versions:
                    continue
                agent_id, prompt_id = _id("ag"), _id("pr")
                data["prompts"][prompt_id] = {
                    "id": prompt_id, "name": "Main line prompt", "agent_id": agent_id,
                    "created_at": versions[-1].get("saved_at") or _now(),
                    "updated_at": versions[0].get("saved_at") or _now(),
                    "versions": [{"id": v["id"], "prompt": v["prompt"],
                                  "saved_at": v.get("saved_at")} for v in versions]}
                data["agents"][agent_id] = {
                    "id": agent_id, "name": "Main line agent",
                    "description": f"Answers and calls from {number}",
                    "active_prompt_id": prompt_id, "tools": list(DEFAULT_TOOLS),
                    "settings": dict(DEFAULT_SETTINGS), "created_at": _now(),
                    "updated_at": _now()}
                data["routes"][normalize_number(number)] = agent_id
        except (ValueError, OSError) as e:
            logger.error(f"Could not take over the old per-number prompts: {e}")
            return {"agents": {}, "prompts": {}, "routes": {}}
        if data["agents"]:
            self._write(data)
        return data

    @staticmethod
    def _agent(data: dict, agent_id: str) -> dict:
        agent = data["agents"].get(agent_id) if isinstance(agent_id, str) else None
        if agent is None:
            raise KeyError(agent_id)
        return agent

    @staticmethod
    def _prompt(data: dict, prompt_id: str) -> dict:
        prompt = data["prompts"].get(prompt_id) if isinstance(prompt_id, str) else None
        if prompt is None:
            raise KeyError(prompt_id)
        return prompt

    @staticmethod
    def _show_prompt(data: dict, p: dict) -> dict:
        agent = data["agents"].get(p.get("agent_id") or "")
        return {"id": p["id"], "name": p["name"], "agent_id": p.get("agent_id"),
                "agent_name": agent["name"] if agent else None,
                "in_use": bool(agent and agent.get("active_prompt_id") == p["id"]),
                "prompt": p["versions"][0]["prompt"] if p["versions"] else "",
                "version_count": len(p["versions"]), "created_at": p.get("created_at"),
                "updated_at": p.get("updated_at")}

    @staticmethod
    def _show_agent(data: dict, a: dict) -> dict:
        return {**a, "settings": {**DEFAULT_SETTINGS, **a.get("settings", {})},
                "prompt_ids": [p["id"] for p in data["prompts"].values()
                               if p.get("agent_id") == a["id"]],
                "numbers": sorted(n for n, aid in data["routes"].items() if aid == a["id"])}

    @staticmethod
    def _fix_active(data: dict, agent_id: str | None) -> None:
        """Keep an agent's prompt in use one of its own, or none if it has none."""
        agent = data["agents"].get(agent_id or "")
        if not agent:
            return
        mine = sorted((p for p in data["prompts"].values() if p.get("agent_id") == agent_id),
                      key=lambda p: p.get("updated_at") or "", reverse=True)
        if not any(p["id"] == agent.get("active_prompt_id") for p in mine):
            agent["active_prompt_id"] = mine[0]["id"] if mine else None

    # --- agents -----------------------------------------------------------------

    def list_agents(self) -> list[dict]:
        data = self._read()
        return sorted((self._show_agent(data, a) for a in data["agents"].values()),
                      key=lambda a: a.get("created_at") or "")

    def get_agent(self, agent_id: str) -> dict:
        data = self._read()
        return self._show_agent(data, self._agent(data, agent_id))

    def create_agent(self, name: str, description: str, prompt: str) -> dict:
        name = _clean(name, MAX_NAME, "agent name")
        description = _clean(description, MAX_DESCRIPTION, "description", required=False)
        text = _prompt_text(prompt)
        data = self._read()
        agent_id, prompt_id, now = _id("ag"), _id("pr"), _now()
        data["prompts"][prompt_id] = {
            "id": prompt_id, "name": _clean(f"{name} prompt", MAX_NAME + 7, "prompt name"),
            "agent_id": agent_id, "created_at": now, "updated_at": now,
            "versions": [{"id": _id("v"), "prompt": text, "saved_at": now}]}
        data["agents"][agent_id] = {
            "id": agent_id, "name": name, "description": description,
            "active_prompt_id": prompt_id, "tools": list(DEFAULT_TOOLS),
            "settings": dict(DEFAULT_SETTINGS), "created_at": now, "updated_at": now}
        self._write(data)
        return self._show_agent(data, data["agents"][agent_id])

    def update_agent(self, agent_id: str, name=None, description=None, tools=None,
                     settings=None, active_prompt_id=None) -> dict:
        data = self._read()
        agent = self._agent(data, agent_id)
        if name is not None:
            agent["name"] = _clean(name, MAX_NAME, "agent name")
        if description is not None:
            agent["description"] = _clean(description, MAX_DESCRIPTION, "description",
                                          required=False)
        if tools is not None:
            if not isinstance(tools, list) or any(t not in KNOWN_TOOLS for t in tools):
                raise ValueError(f"tools must be from: {', '.join(KNOWN_TOOLS)}")
            agent["tools"] = [t for t in KNOWN_TOOLS if t in tools]
        if settings is not None:
            if not isinstance(settings, dict):
                raise ValueError("settings must be an object")
            agent["settings"] = _settings(agent.get("settings", {}), settings)
        if active_prompt_id is not None:
            prompt = data["prompts"].get(active_prompt_id)
            if not prompt or prompt.get("agent_id") != agent_id:
                raise ValueError("the prompt in use must be one of this agent's prompts")
            agent["active_prompt_id"] = active_prompt_id
        agent["updated_at"] = _now()
        self._write(data)
        return self._show_agent(data, agent)

    def delete_agent(self, agent_id: str) -> None:
        data = self._read()
        self._agent(data, agent_id)
        del data["agents"][agent_id]
        for p in data["prompts"].values():
            if p.get("agent_id") == agent_id:
                p["agent_id"] = None
        data["routes"] = {n: a for n, a in data["routes"].items() if a != agent_id}
        self._write(data)

    # --- prompts ------------------------------------------------------------------

    def list_prompts(self) -> list[dict]:
        data = self._read()
        return sorted((self._show_prompt(data, p) for p in data["prompts"].values()),
                      key=lambda p: p.get("updated_at") or "", reverse=True)

    def get_prompt(self, prompt_id: str) -> dict:
        data = self._read()
        return self._show_prompt(data, self._prompt(data, prompt_id))

    def create_prompt(self, name: str, text: str, agent_id: str | None = None) -> dict:
        name = _clean(name, MAX_NAME + 7, "prompt name")
        text = _prompt_text(text)
        data = self._read()
        if agent_id:
            self._agent(data, agent_id)
        prompt_id, now = _id("pr"), _now()
        data["prompts"][prompt_id] = {
            "id": prompt_id, "name": name, "agent_id": agent_id or None, "created_at": now,
            "updated_at": now, "versions": [{"id": _id("v"), "prompt": text, "saved_at": now}]}
        self._fix_active(data, agent_id)
        self._write(data)
        return self._show_prompt(data, data["prompts"][prompt_id])

    def update_prompt(self, prompt_id: str, name=None, text=None) -> dict:
        data = self._read()
        prompt = self._prompt(data, prompt_id)
        if name is not None:
            prompt["name"] = _clean(name, MAX_NAME + 7, "prompt name")
        if text is not None:
            text = _prompt_text(text)
            if not prompt["versions"] or prompt["versions"][0]["prompt"] != text:
                prompt["versions"].insert(0, {"id": _id("v"), "prompt": text,
                                              "saved_at": _now()})
                del prompt["versions"][MAX_VERSIONS:]
        prompt["updated_at"] = _now()
        self._write(data)
        return self._show_prompt(data, prompt)

    def assign_prompt(self, prompt_id: str, agent_id: str | None) -> dict:
        data = self._read()
        prompt = self._prompt(data, prompt_id)
        if agent_id:
            self._agent(data, agent_id)
        before = prompt.get("agent_id")
        prompt["agent_id"] = agent_id or None
        self._fix_active(data, before)
        self._fix_active(data, agent_id)
        self._write(data)
        return self._show_prompt(data, prompt)

    def delete_prompt(self, prompt_id: str) -> None:
        data = self._read()
        prompt = self._prompt(data, prompt_id)
        del data["prompts"][prompt_id]
        self._fix_active(data, prompt.get("agent_id"))
        self._write(data)

    def versions(self, prompt_id: str) -> list[dict]:
        return list(self._prompt(self._read(), prompt_id)["versions"])

    def restore_version(self, prompt_id: str, version_id: str) -> dict:
        version = next((v for v in self.versions(prompt_id) if v["id"] == version_id), None)
        if version is None:
            raise KeyError(version_id)
        data = self._read()
        prompt = self._prompt(data, prompt_id)
        prompt["versions"].insert(0, {"id": _id("v"), "prompt": version["prompt"],
                                      "saved_at": _now()})
        del prompt["versions"][MAX_VERSIONS:]
        prompt["updated_at"] = _now()
        self._write(data)
        return self._show_prompt(data, prompt)

    def delete_version(self, prompt_id: str, version_id: str) -> None:
        data = self._read()
        prompt = self._prompt(data, prompt_id)
        ids = [v["id"] for v in prompt["versions"]]
        if version_id not in ids:
            raise KeyError(version_id)
        if ids[0] == version_id:
            raise ValueError("this is the version in use; restore another one first")
        prompt["versions"] = [v for v in prompt["versions"] if v["id"] != version_id]
        self._write(data)

    # --- numbers and calls ----------------------------------------------------------

    def routes(self) -> dict:
        return dict(self._read()["routes"])

    def route_number(self, number: str, agent_id: str | None) -> None:
        number = normalize_number(number)
        data = self._read()
        if agent_id:
            self._agent(data, agent_id)
            data["routes"][number] = agent_id
        else:
            data["routes"].pop(number, None)
        self._write(data)

    def agent_for_number(self, number: str | None) -> str | None:
        """The agent an inbound call on `number` gets. Never raises."""
        try:
            return self._read()["routes"].get(normalize_number(number or ""))
        except (ValueError, OSError) as e:
            logger.debug(f"No agent for {number!r}: {e}")
            return None

    def call_config(self, agent_id) -> dict | None:
        """What a call with this agent needs, or None. Never raises: it is read
        at the start of a live call, and an id can arrive from the network."""
        if not isinstance(agent_id, str) or not AGENT_ID.match(agent_id):
            return None
        try:
            data = self._read()
            agent = data["agents"].get(agent_id)
            if not agent:
                return None
            prompt = data["prompts"].get(agent.get("active_prompt_id") or "")
            settings = {**DEFAULT_SETTINGS, **agent.get("settings", {})}
            return {"agent_id": agent_id, "name": agent["name"],
                    "prompt": prompt["versions"][0]["prompt"]
                    if prompt and prompt["versions"] else None,
                    "tools": [t for t in agent.get("tools", []) if t in KNOWN_TOOLS],
                    "opening_line": settings["opening_line"] or None,
                    "max_secs": float(settings["max_minutes"] * 60),
                    "ring_secs": int(settings["ring_secs"])}
        except (ValueError, OSError, KeyError, TypeError) as e:
            logger.error(f"Agent store unreadable, using the default persona: {e}")
            return None


def default_store() -> AgentStore:
    legacy = Path(os.getenv("PROMPT_STORE_PATH") or LEGACY_PATH)
    return AgentStore(Path(os.getenv("AGENT_STORE_PATH") or DEFAULT_PATH), legacy_path=legacy)

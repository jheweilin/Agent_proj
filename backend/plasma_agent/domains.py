"""Domain profiles: one agent engine, different research domains.

A domain selects the system prompt and which tools are visible. This is the first
step of generalising the agent beyond plasma physics: `plasma` keeps the full
behaviour, `general` is a domain-agnostic research assistant without the COMSOL
tools. The sandbox image is still shared across domains for now (per-domain images
come in a later phase), so a domain only affects the prompt and the tool set.
"""
from __future__ import annotations

from dataclasses import dataclass

from .config import settings


@dataclass(frozen=True)
class Domain:
    name: str
    label: str
    prompt_file: str          # under settings.prompts_dir
    # tools whose name starts with any of these prefixes are hidden from this domain
    exclude_tool_prefixes: tuple[str, ...] = ()

    def allowed_tools(self, all_names) -> set[str] | None:
        """The tool names this domain exposes, or None meaning 'all registered tools'."""
        if not self.exclude_tool_prefixes:
            return None
        return {n for n in all_names if not n.startswith(self.exclude_tool_prefixes)}


# Unified single research profile: all tools available (the agent picks the right engine per task;
# field-specific knowledge comes from the lab/base knowledge base, not a hard-coded domain). The
# per-thread `domain` column is kept for data compatibility but every value resolves here.
RESEARCH = Domain("research", "研究", "general_system.md")
DOMAINS: dict[str, Domain] = {"research": RESEARCH}


def get(name: str | None = None) -> Domain:
    """Every thread uses the single unified research profile (domain selection was removed)."""
    return RESEARCH


def choices() -> list[dict]:
    return [{"name": RESEARCH.name, "label": RESEARCH.label}]

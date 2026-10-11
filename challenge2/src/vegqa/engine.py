"""Rule engine: runs every rule in rules/rules.yaml and collects one result row per evaluated entity.

Each rule is a Python function registered with @rule("ID"). The engine refuses to run if the YAML and
the code disagree (a rule without an implementation, or code for a rule that is not catalogued), so
the published catalogue is always the executed one.

Result rows (one per entity a rule looked at):
  rule_id, status (fail / pass / could_not_check), severity (rule default unless overridden),
  entity_type, entity_key, plot_name, survey_key, source_table, source_key, observed, expected, message
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

import pandas as pd
import yaml

RULES_YAML = Path(__file__).resolve().parents[2] / "rules" / "rules.yaml"
REGISTRY: dict[str, Callable] = {}
RESULT_COLUMNS = ["rule_id", "status", "severity", "entity_type", "entity_key", "plot_name", "survey_key", "source_table", "source_key", "observed", "expected", "message"]


class Row(dict):
    """A record with attribute access that keeps every column name (itertuples() renames `_x` columns)."""

    __getattr__ = dict.__getitem__


def rows(df: pd.DataFrame):
    for rec in df.to_dict("records"):
        yield Row(rec)


def rule(rule_id: str):
    def deco(fn):
        if rule_id in REGISTRY:
            raise ValueError(f"rule {rule_id} registered twice")
        REGISTRY[rule_id] = fn
        return fn
    return deco


def load_catalogue(path: Path = RULES_YAML) -> dict:
    return yaml.safe_load(path.read_text())


@dataclass
class Ctx:
    """Everything a rule needs, plus the result collector."""

    data: object
    occ: pd.DataFrame
    canonical: set
    proj: object
    th: dict
    catalogue: dict
    extras: dict = field(default_factory=dict)  # shared intermediate results (e.g. geometry tables)
    _rows: list = field(default_factory=list)
    _current: str = ""

    def cached(self, name: str, fn):
        """Shared derived tables (geometry, positions...), computed once per run."""
        if name not in self.extras:
            self.extras[name] = fn()
        return self.extras[name]

    def add(self, status: str, entity_type: str, entity_key: str, *, plot_name: str = "", survey_key: str = "", source_table: str = "",
            source_key: str = "", observed="", expected="", message: str = "", severity: str | None = None):
        assert status in ("fail", "pass", "could_not_check"), status
        self._rows.append({
            "rule_id": self._current, "status": status,
            "severity": severity or self.catalogue["rules"][self._current]["severity"],
            "entity_type": entity_type, "entity_key": str(entity_key), "plot_name": plot_name or "", "survey_key": survey_key or "",
            "source_table": source_table, "source_key": str(source_key or ""), "observed": "" if observed is None else str(observed),
            "expected": "" if expected is None else str(expected), "message": message,
        })


def run_all(ctx: Ctx) -> pd.DataFrame:
    from . import checks

    checks.load_all()  # registers the rules

    cat_ids = set(ctx.catalogue["rules"])
    missing, extra = cat_ids - set(REGISTRY), set(REGISTRY) - cat_ids
    if missing or extra:
        raise RuntimeError(f"catalogue and code disagree: not implemented {sorted(missing)}; not catalogued {sorted(extra)}")
    for rid in sorted(cat_ids):
        ctx._current = rid
        REGISTRY[rid](ctx)
    out = pd.DataFrame(ctx._rows, columns=RESULT_COLUMNS)
    return out


def run_id(input_hashes: dict, catalogue: dict, code_version: str) -> str:
    body = json.dumps({"inputs": input_hashes, "rules": catalogue, "code": code_version}, sort_keys=True, default=str)
    return "qa-" + hashlib.sha256(body.encode()).hexdigest()[:16]

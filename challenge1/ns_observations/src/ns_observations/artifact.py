"""The threshold set: the versioned artifact job A publishes and job B reads.

It records everything needed to reproduce and audit the labels: the policy values, the code
version, a hash of the validation snapshot, and per species the status, the curve and the
operative threshold. Serialised as deterministic JSON (sorted keys, no timestamps), so identical
inputs give byte-identical files and the same `threshold_set_id`. The database row that stores it
carries the publication time and the approver (see sql/schema.sql).

Schema: schemas/threshold_set.schema.json.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import asdict, dataclass, field
from importlib import resources
from pathlib import Path

import numpy as np
import pandas as pd

from . import __version__
from .policy import HAS_THRESHOLD, REVIEW_FLAG, Policy

SCHEMA_VERSION = "1.0"


def _clean(v):
    """JSON-safe: numpy scalars to Python, NaN/inf to None, recursively."""
    if isinstance(v, dict):
        return {str(k): _clean(x) for k, x in v.items()}
    if isinstance(v, (list, tuple, np.ndarray)):
        return [_clean(x) for x in v]
    if isinstance(v, (bool, np.bool_)):
        return bool(v)
    if isinstance(v, np.integer):
        return int(v)
    if isinstance(v, (float, np.floating)):
        return None if not np.isfinite(v) else float(v)
    return v


@dataclass
class ReviewFlag:
    recorder: str
    validated_clips: int
    correct: int
    expected_correct: float
    p_value: float
    bonferroni_alpha: float
    flag: str = REVIEW_FLAG


@dataclass
class SpeciesThreshold:
    species: str
    status: str
    gate_reason: str | None
    method: str | None
    n_correct: int
    n_incorrect: int
    validated_min: float | None
    validated_max: float | None
    threshold: float | None  # operative confidence threshold, rounded up; None without one
    curve_identified: bool  # valid and increasing: p_correct may be computed
    beta0: float | None
    beta1: float | None
    review_flags: list[ReviewFlag] = field(default_factory=list)
    species_code: str | None = None
    diagnostics: dict | None = None

    @classmethod
    def from_procedure(cls, species, pr, recorder_table: pd.DataFrame, policy: Policy, species_code=None, diagnostics=None) -> "SpeciesThreshold":
        flags = []
        if len(recorder_table):
            for r in recorder_table[recorder_table.flagged].itertuples():
                flags.append(ReviewFlag(str(r.recorder), int(r.validated_clips), int(r.correct), float(r.expected_correct_loro), float(r.p_value), float(r.bonferroni_alpha)))
        valid = pr.fit is not None and pr.fit.valid
        return cls(
            species=species, status=pr.status, gate_reason=pr.gate_reason, method=pr.method,
            n_correct=pr.n_correct, n_incorrect=pr.n_incorrect,
            validated_min=None if not pr.n else float(pr.vmin), validated_max=None if not pr.n else float(pr.vmax),
            threshold=pr.threshold, curve_identified=bool(pr.curve_identified),
            beta0=float(pr.fit.b0) if valid else None, beta1=float(pr.fit.b1) if valid else None,
            review_flags=flags, species_code=species_code, diagnostics=diagnostics,
        )

    @property
    def has_threshold(self) -> bool:
        return self.status in HAS_THRESHOLD and self.threshold is not None


@dataclass
class ThresholdSet:
    threshold_set_id: str
    schema_version: str
    created_by: str
    code_version: str
    policy: dict
    validation_snapshot: dict
    species: dict[str, SpeciesThreshold]
    status: str = "draft"  # draft -> published (after Biometrics sign-off) -> retired

    # ── serialisation ──
    def to_dict(self) -> dict:
        d = asdict(self)
        d["species"] = {k: asdict(v) for k, v in sorted(self.species.items())}
        return _clean(d)

    def to_json(self) -> str:
        return json.dumps(self.to_dict(), indent=2, sort_keys=True, ensure_ascii=False) + "\n"

    def write(self, path: str | Path) -> Path:
        p = Path(path)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(self.to_json())
        return p

    @classmethod
    def from_dict(cls, d: dict) -> "ThresholdSet":
        validate_threshold_set(d)
        sp = {}
        for k, v in d["species"].items():
            v = dict(v)
            v["review_flags"] = [ReviewFlag(**f) for f in v.get("review_flags", [])]
            sp[k] = SpeciesThreshold(**v)
        return cls(d["threshold_set_id"], d["schema_version"], d["created_by"], d["code_version"], d["policy"], d["validation_snapshot"], sp, d.get("status", "draft"))

    @classmethod
    def read(cls, path: str | Path) -> "ThresholdSet":
        return cls.from_dict(json.loads(Path(path).read_text()))

    def policy_obj(self) -> Policy:
        return Policy(**self.policy)


def validation_hash(validations: pd.DataFrame) -> str:
    """SHA-256 of the validation snapshot in a canonical form (the columns calibrate uses, sorted,
    fixed float formatting), so the same clips give the same hash whatever their row order."""
    cols = ["species", "recorder", "confidence", "outcome"]
    canon = validations[cols].assign(confidence=validations.confidence.map(lambda c: f"{float(c):.6f}"), outcome=validations.outcome.astype(int))
    canon = canon.sort_values(cols, kind="mergesort").to_csv(index=False, lineterminator="\n")
    return hashlib.sha256(canon.encode()).hexdigest()


def build_threshold_set(entries: dict[str, SpeciesThreshold], policy: Policy, validations: pd.DataFrame, code_version: str | None = None) -> ThresholdSet:
    """Assemble the artifact. The id is derived from its content (policy, snapshot, code version and
    species results), so re-running on the same inputs reproduces the same id."""
    snapshot = {"sha256": validation_hash(validations), "n_clips": int(len(validations))}
    code_version = code_version or f"ns-observations {__version__}"
    ts = ThresholdSet("", SCHEMA_VERSION, f"ns-observations {__version__}", code_version, policy.to_dict(), snapshot, entries)
    body = ts.to_dict()
    body.pop("threshold_set_id")
    ts.threshold_set_id = "ts-" + hashlib.sha256(json.dumps(body, sort_keys=True).encode()).hexdigest()[:16]
    validate_threshold_set(ts.to_dict())
    return ts


# ── schemas ──


def load_schema(name: str) -> dict:
    return json.loads(resources.files("ns_observations").joinpath("schemas", name).read_text())


def validate_threshold_set(d: dict) -> None:
    """Validate against the JSON schema when `jsonschema` is installed (it is in the test and
    platform images); otherwise check the minimum structure so a broken artifact never loads."""
    try:
        import jsonschema
    except ImportError:  # pragma: no cover - exercised only without the optional dependency
        for key in ("threshold_set_id", "schema_version", "policy", "validation_snapshot", "species"):
            if key not in d:
                raise ValueError(f"threshold set is missing '{key}'")
        return
    jsonschema.validate(d, load_schema("threshold_set.schema.json"))

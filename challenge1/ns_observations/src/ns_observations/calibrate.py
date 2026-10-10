"""Job A — calibrate: validated clips -> a threshold set (gate, fit, accept, review flags).

Input: a "validations" table with one row per distinct validated prediction:
    species     str    species name (or code) — the key labels are matched on
    confidence  float  BirdNET confidence of the validated prediction
    outcome     int    1 = BirdNET was right, 0 = wrong
    recorder    str    recorder id (for review flags and the recorder bootstrap)
Duplicates must already be removed (on the platform: one row per prediction_id).

Nothing here touches files or databases; adapters (io_csv, io_postgres) do that.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
import pandas as pd

from .estimators import Fit, cluster_resamples, fit_firth, fit_flic, fit_ml, logit_conf, poisson_binomial_cdf, sigmoid, threshold_logit, wilson
from .policy import (
    ACCEPTED,
    ACCEPTED_WHOLE_RANGE,
    INSUFFICIENT,
    NO_VALID_FIT,
    NOT_REACHED,
    SLOPE_NOT_POSITIVE,
    Policy,
    operative,
)

REQUIRED_VALIDATION_COLUMNS = ("species", "confidence", "outcome", "recorder")


def evidence_gate(n_correct: int, n_incorrect: int, k: int) -> tuple[bool, str | None]:
    """D-09. Both outcomes must be observed at least k times. Returns (passed, reason code).

    The 99% point sits where errors become rare, so its location is learned from errors near it:
    with 0 errors the slope is not identified, with 1 error the threshold depends on the estimator."""
    if n_correct + n_incorrect == 0:
        return False, "no_validations"
    if n_incorrect == 0:
        return False, "no_observed_errors"
    if n_correct == 0:
        return False, "no_observed_correct"
    if n_incorrect < k:
        return False, "too_few_errors"
    if n_correct < k:
        return False, "too_few_correct"
    return True, None


def fit_primary(x: np.ndarray, y: np.ndarray, estimator: str = "auto") -> tuple[Fit, str]:
    """D-09. Ordinary maximum likelihood (the paper's glm); Firth only when the data are separated.
    Other estimators are forced only in sensitivity runs. Returns (fit, reason for the choice)."""
    if estimator == "firth":
        return fit_firth(x, y), "forced: Firth (sensitivity run)"
    if estimator == "flic":
        return fit_flic(x, y), "forced: FLIC (sensitivity run)"
    ml = fit_ml(x, y)
    if estimator == "ml" or not ml.separated:
        return ml, "ordinary maximum likelihood (Wood & Kahl)"
    return fit_firth(x, y), "separated data: no finite ML estimate, Firth fallback"


def accept(fit: Fit, xmin: float, xmax: float, target: float) -> tuple[str, float | None, float | None]:
    """D-05. Where the fitted curve crosses the target and whether the data support it.
    Returns (status code, effective threshold on the logit scale or None, raw crossing or None)."""
    if not fit.valid:
        return NO_VALID_FIT, None, None
    t = threshold_logit(fit, target)
    if t is None:  # valid but b1 <= 0: a threshold "score >= t" does not exist
        return SLOPE_NOT_POSITIVE, None, None
    if t > xmax:  # would need extrapolation above the evidence
        return NOT_REACHED, None, t
    if t < xmin:  # already >= target at the lowest validated score: no extrapolation downward
        return ACCEPTED_WHOLE_RANGE, xmin, t
    return ACCEPTED, t, t


@dataclass
class Procedure:
    """The outcome of the procedure for one species on one set of validated clips."""

    n: int
    n_correct: int
    n_incorrect: int
    gate_passed: bool
    gate_reason: str | None
    status: str
    fit: Fit | None
    method: str | None
    method_reason: str | None
    t_raw: float | None  # logit scale: where the curve crosses the target, if it does
    threshold: float | None  # operative confidence threshold (rounded up), None without one
    x: np.ndarray = field(repr=False, default_factory=lambda: np.array([]))
    y: np.ndarray = field(repr=False, default_factory=lambda: np.array([]))
    vmin: float = np.nan  # validated confidence range
    vmax: float = np.nan

    @property
    def curve_identified(self) -> bool:
        """A valid, increasing curve: p_correct may be computed from it."""
        return self.fit is not None and self.fit.valid and self.fit.b1 > 0


def run_procedure(conf: np.ndarray, outcome: np.ndarray, policy: Policy) -> Procedure:
    """Gate, fit, accept for one species. Also replayed inside every bootstrap resample and
    sensitivity run, so those reflect the whole decision procedure, not just the curve.
    `policy` may be any object with the Policy attributes it reads."""
    conf = np.asarray(conf, float)
    y = np.asarray(outcome, int)
    n1, n0 = int(y.sum()), int(len(y) - y.sum())
    passed, reason = evidence_gate(n1, n0, policy.min_each_outcome)
    x = logit_conf(conf, policy.eps)
    base = dict(n=len(y), n_correct=n1, n_incorrect=n0, gate_passed=passed, gate_reason=reason, x=x, y=y,
                vmin=float(conf.min()) if len(conf) else np.nan, vmax=float(conf.max()) if len(conf) else np.nan)
    if not passed:
        return Procedure(**base, status=INSUFFICIENT, fit=None, method=None, method_reason=None, t_raw=None, threshold=None)
    fit, why = fit_primary(x, y, policy.estimator)
    status, eff, t_raw = accept(fit, float(x.min()), float(x.max()), policy.target)
    thr = None
    if eff is not None:
        # at the lower bound use the exact validated score, not a logit round trip
        thr = operative(base["vmin"] if status == ACCEPTED_WHOLE_RANGE else float(sigmoid(eff)), policy.threshold_decimals)
    return Procedure(**base, status=status, fit=fit, method=fit.method, method_reason=why, t_raw=t_raw, threshold=thr)


def n_labelled(conf: np.ndarray, threshold: float | None) -> int:
    return 0 if threshold is None else int(np.sum(np.asarray(conf) >= threshold))


def recorder_checks(d: pd.DataFrame, pr: Procedure, policy: Policy) -> pd.DataFrame:
    """D-11. Is each recorder consistent with the curve fitted on the OTHER recorders?

    Recorders with >= review_min_clips validated clips: refit without the recorder, predict its
    clips, and compute the exact probability (Poisson-binomial) of so few correct ones. Flag at
    review_alpha / (recorders tested). Only species that pass the gate are checked."""
    if not pr.gate_passed:
        return pd.DataFrame(columns=["recorder", "validated_clips", "correct", "tested", "expected_correct_loro", "p_value", "flagged", "bonferroni_alpha"])
    tested = [r for r, g in d.groupby("recorder") if len(g) >= policy.review_min_clips]
    rows = []
    for r, g in d.groupby("recorder"):
        row = {"recorder": r, "validated_clips": len(g), "correct": int(g.outcome.sum()), "tested": r in tested,
               "expected_correct_loro": np.nan, "p_value": np.nan, "flagged": False}
        if r in tested:
            rest = d[d.recorder != r]
            f, _ = fit_primary(logit_conf(rest.confidence.to_numpy(), policy.eps), rest.outcome.to_numpy(), policy.estimator)
            if f.valid:
                p = f.p(logit_conf(g.confidence.to_numpy(), policy.eps))
                row["expected_correct_loro"] = float(p.sum())
                row["p_value"] = poisson_binomial_cdf(row["correct"], p)
                row["flagged"] = bool(row["p_value"] < policy.review_alpha / len(tested))
        rows.append(row)
    out = pd.DataFrame(rows)
    out["bonferroni_alpha"] = policy.review_alpha / max(len(tested), 1)
    return out


def bootstrap(d: pd.DataFrame, pred_conf: np.ndarray | None, cluster_col: str, policy: Policy) -> dict:
    """D-12. Cluster bootstrap replaying the whole procedure (gate, fit, acceptance) per resample.

    threshold_ci is CONDITIONAL on resamples that produce a threshold (share reported alongside);
    labelled_q is UNCONDITIONAL (a resample without a threshold labels nothing). Pass pred_conf
    (the species' prediction scores) to get labelled counts; None skips them."""
    conf, y = d.confidence.to_numpy(), d.outcome.to_numpy()
    thresholds, counts, statuses = [], [], []
    for idx in cluster_resamples(d[cluster_col].to_numpy(), policy.n_boot, policy.seed):
        pr = run_procedure(conf[idx], y[idx], policy)
        statuses.append(pr.status)
        thresholds.append(np.nan if pr.threshold is None else pr.threshold)
        counts.append(n_labelled(pred_conf, pr.threshold) if pred_conf is not None else 0)
    thr, counts, statuses = np.asarray(thresholds), np.asarray(counts), np.asarray(statuses)
    ok = np.isfinite(thr)
    return {
        "cluster": cluster_col,
        "n_resamples": int(policy.n_boot),
        "n_clusters": int(d[cluster_col].nunique()),
        "share_with_threshold": float(ok.mean()),
        "status_shares": {s: float(np.mean(statuses == s)) for s in sorted(set(statuses.tolist()))},
        "threshold_ci": [float(v) for v in np.quantile(thr[ok], [0.025, 0.975])] if ok.mean() >= 0.5 else None,
        "labelled_q": [int(v) for v in np.quantile(counts, [0.025, 0.5, 0.975], method="nearest")] if pred_conf is not None else None,
        "thresholds": thr,
        "counts": counts,
    }


def model_free_check(d: pd.DataFrame, threshold: float | None) -> dict | None:
    """Validated clips at or above the threshold, how many were correct, Wilson 95% bounds."""
    if threshold is None:
        return None
    above = (d.confidence >= threshold).to_numpy()
    k, n = int(d.outcome.to_numpy()[above].sum()), int(above.sum())
    lo, hi = wilson(k, n)
    return {"validated_above_threshold": n, "correct": k, "wilson_lo": lo, "wilson_hi": hi}


def check_validations(validations: pd.DataFrame) -> None:
    missing = [c for c in REQUIRED_VALIDATION_COLUMNS if c not in validations]
    if missing:
        raise ValueError(f"validations table is missing columns: {missing}")
    bad = set(pd.unique(validations.outcome)) - {0, 1, True, False}
    if bad:
        raise ValueError(f"outcome must be 0/1, found {sorted(bad)}")
    if validations.confidence.isna().any() or ((validations.confidence < 0) | (validations.confidence > 1)).any():
        raise ValueError("confidence must be in [0, 1] with no missing values")


def calibrate(
    validations: pd.DataFrame,
    policy: Policy = Policy(),
    *,
    species: list[str] | None = None,
    species_codes: dict[str, str] | None = None,
    diagnostics: bool = False,
    prediction_scores: dict[str, np.ndarray] | None = None,
    code_version: str | None = None,
):
    """Run job A and return a ThresholdSet (see artifact.py).

    species: species to include; defaults to those in `validations`. Pass the species seen in the
    predictions so that a species without validations gets an explicit `no_validations` status.
    diagnostics: add the recorder bootstrap and the model-free check per species (slower).
    prediction_scores: per species, prediction confidences, for bootstrap labelled counts."""
    from .artifact import SpeciesThreshold, build_threshold_set

    check_validations(validations)
    names = list(dict.fromkeys((species or []) + sorted(validations.species.unique().tolist())))
    entries = {}
    for sp in names:
        d = validations[validations.species == sp]
        pr = run_procedure(d.confidence.to_numpy(), d.outcome.to_numpy(), policy)
        rc = recorder_checks(d, pr, policy)
        diag = None
        if diagnostics:
            diag = {"model_free": model_free_check(d, pr.threshold)}
            if pr.gate_passed:
                b = bootstrap(d, None if prediction_scores is None else prediction_scores.get(sp), "recorder", policy)
                diag["bootstrap_recorder"] = {k: v for k, v in b.items() if k not in ("thresholds", "counts")}
        entries[sp] = SpeciesThreshold.from_procedure(sp, pr, rc, policy, species_code=(species_codes or {}).get(sp), diagnostics=diag)
    return build_threshold_set(entries, policy, validations, code_version)

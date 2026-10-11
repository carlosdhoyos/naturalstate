"""Challenge 1: species thresholds and an `observation` label for every BirdNET prediction.

What this script does, in order (each step is a function below; decisions are logged in
docs/challenge1_data_decisions.md, D-01..D-14):

  1. load            read both CSVs, parse recorder / date / hour out of the file names
  2. link            match each validated clip to the prediction(s) it came from (D-02)
  3. deduplicate     drop validated clips that are the same 3-s segment counted twice (D-01)
  4. procedure       per species, the Wood & Kahl (2024) method with explicit safeguards:
       a. evidence gate   both outcomes observed at least MIN_EACH_OUTCOME times, otherwise
                          "insufficient validation" and no model-based labels (D-09)
       b. fit             logistic regression of outcome on logit(confidence), ordinary maximum
                          likelihood, as in the paper; Firth's penalised fit only as a fallback
                          when the data are separated (D-05, D-09)
       c. accept          the 99% point must exist (valid fit, increasing curve) and lie inside the
                          validated score range; no extrapolation (D-05)
  5. uncertainty     cluster bootstrap by recorder (headline) and by audio file, replaying the
                     whole procedure, gate included, in every resample (D-12)
  6. checks          model-free precision above the threshold (Wilson), per-recorder consistency
                     with the pooled curve (review flags, D-11), calibration by score band,
                     validation sampling design (D-12)
  7. sensitivity     logit endpoint, de-duplication, gate size, estimator (ML / Firth / FLIC),
                     dropping flagged recorders; covariate models compared by AIC (D-13)
  8. label           human verdict where a validated clip links to exactly one prediction (D-10),
                     otherwise the species threshold; every source column kept byte-identical
  9. report          CSVs, figures, run_summary.json, and dashboard_results.json for the dashboard

Run:   challenge1/.venv/bin/python challenge1/src/run_challenge1.py [--out DIR] [--n-boot N]
"""

from __future__ import annotations

import argparse
import hashlib
import json
import platform
import sys
from dataclasses import asdict, dataclass, replace
from pathlib import Path

import matplotlib
import numpy as np
import pandas as pd

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "ns_observations" / "src"))
# the production package: decision rules, CSV linkage, label rule and the threshold-set artifact.
# This script imports them, so the research analysis and the platform code cannot drift apart.
from ns_observations import io_csv  # noqa: E402
from ns_observations.artifact import SpeciesThreshold, build_threshold_set  # noqa: E402
from ns_observations.calibrate import (  # noqa: E402,F401
    Procedure,
    accept,
    bootstrap,
    evidence_gate,
    fit_primary,
    model_free_check,
    n_labelled,
    recorder_checks,
    run_procedure,
)
from ns_observations.label import label  # noqa: E402
from ns_observations.policy import (  # noqa: E402,F401
    ACCEPTED,
    ACCEPTED_WHOLE_RANGE,
    INSUFFICIENT,
    NO_VALID_FIT,
    NOT_REACHED,
    REASON_TEXT,
    ROW_BELOW,
    ROW_MODEL,
    ROW_NO_THRESHOLD,
    ROW_VALIDATED_CORRECT,
    ROW_VALIDATED_INCORRECT,
    SLOPE_NOT_POSITIVE,
    STATUS_TEXT,
    Policy,
    operative,
)
from covariates import conditional_threshold, fit_fixed, fit_random_intercept, marginal_threshold  # noqa: E402
from thresholds import (  # noqa: E402
    Fit,
    fit_firth,
    fit_flic,
    fit_ml,
    logit_conf,
    sigmoid,
    threshold_delta_ci,
    wilson,
)

ROOT = Path(__file__).resolve().parents[2]


# ══ configuration ═════════════════════════════════════════════════════════════


@dataclass(frozen=True)
class Config:
    """Every tunable choice in one place. Defaults are the documented policy."""

    pred_csv: Path = ROOT / "Data Birds" / "birdnet_predictions.csv"
    val_csv: Path = ROOT / "Data Birds" / "validation_results.csv"
    out_dir: Path = ROOT / "challenge1" / "outputs"

    # The brief: "Using a 99% probability of correctness cutoff".
    target: float = 0.99
    # Evidence gate (D-09): a curve is only used for decisions when the validated clips contain at
    # least this many correct AND this many incorrect predictions. With fewer, where the curve
    # crosses 99% is set by the estimator's assumptions rather than by observed errors.
    min_each_outcome: int = 5
    # Estimator: "auto" = ordinary ML, Firth only if separated. Others exist for sensitivity runs.
    estimator: str = "auto"
    # Confidence is clamped to [eps, 1 - eps] before the logit, so scores of exactly 1 stay finite.
    eps: float = 1e-4
    # Validation scores have 3 decimals and predictions 4, so a match allows half a 3-dp step.
    link_tol: float = 0.00051
    # Exported thresholds are rounded UP to this many decimals and labels use exactly that value.
    threshold_decimals: int = 6
    # Uncertainty.
    n_boot: int = 2000
    seed: int = 20261010
    # Per-recorder review flags (D-11): recorders with at least this many validated clips of a
    # species are tested against a curve fitted WITHOUT them; Bonferroni over recorders tested.
    review_min_clips: int = 5
    review_alpha: float = 0.05
    # Covariate models (D-13). Recorder clocks inferred in D-03 (hours behind local time) and the
    # local hours counted as "evening" (dusk), used only for the time-of-day covariate.
    clock_correction_h: tuple = (("RBS40", 3), ("RBS71", 3))
    evening_hours: tuple = (16, 21)
    season_start: str = "20230620"
    # File-name patterns (case-insensitive). Recorder ids may be any token without "_" or "/".
    pred_path_pattern: str = r"/(?P<recorder>[^/_]+)_(?P<date>\d{8})_(?P<hour>\d{2})\d{4}\.wav$"
    val_name_pattern: str = r"^(?P<score>\d\.\d{3})_(?P<clip>\d+)_(?P<recorder>[^/_]+)_(?P<date>\d{8})_(?P<hour>\d{2})(?P<mmss>\d{4})\.wav$"
    # Outputs that take time or are only for people.
    write_figures: bool = True
    write_dashboard_json: bool = True


BANDS = [0.1, 0.2, 0.3, 0.5, 0.7, 0.9, 1.0000001]
BAND_LABELS = ["0.1–0.2", "0.2–0.3", "0.3–0.5", "0.5–0.7", "0.7–0.9", "0.9–1.0"]
TEAL, ORANGE, BLUE, GREY, NAVY, SAND = "#1f9e8c", "#eb6834", "#2a78d6", "#9aa8ae", "#00354d", "#c99a2e"


def policy_of(cfg: "Config") -> Policy:
    """The package's Policy from this script's Config (the policy values are the same fields)."""
    return Policy(target=cfg.target, min_each_outcome=cfg.min_each_outcome, estimator=cfg.estimator, eps=cfg.eps,
                  threshold_decimals=cfg.threshold_decimals, review_min_clips=cfg.review_min_clips,
                  review_alpha=cfg.review_alpha, n_boot=cfg.n_boot, seed=cfg.seed)


# ══ 1–3. data: load, link, de-duplicate ══════════════════════════════════════


def load(cfg: Config = Config()) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Both CSVs through the package's CSV adapter (io_csv), plus the columns this script uses."""
    preds = io_csv.read_predictions(cfg.pred_csv)
    pred = pd.read_csv(cfg.pred_csv)
    pred["recorder"], pred["date"], pred["hour"] = preds.table.recorder, preds.table.date, preds.table.hour
    pred["prediction_id"], pred["species"] = preds.table.prediction_id, preds.table.species
    val = io_csv.read_validations(cfg.val_csv)
    return pred, val


def link_validations(pred: pd.DataFrame, val: pd.DataFrame, cfg: Config = Config()) -> pd.DataFrame:
    """D-02, via the package (io_csv.link_validations)."""
    return io_csv.link_validations(pred, val, cfg.link_tol)


def deduplicate(pred: pd.DataFrame, val: pd.DataFrame, reduce_ambiguous: bool = False, cfg: Config = Config()) -> tuple[pd.DataFrame, pd.DataFrame]:
    """D-01, via the package (io_csv.deduplicate); links first if needed."""
    if "n_candidates" not in val:
        val = link_validations(pred, val, cfg)
    return io_csv.deduplicate(val, reduce_ambiguous)


# ══ 4. the per-species procedure ═════════════════════════════════════════════


# evidence_gate, fit_primary, accept, Procedure, run_procedure, n_labelled and bootstrap come from
# ns_observations.calibrate (imported above): one implementation for the analysis and the platform.


# ══ 6. checks ════════════════════════════════════════════════════════════════


# recorder_checks (D-11) comes from ns_observations.calibrate.


def set_level_threshold(fit: Fit | None, pred_conf: np.ndarray, vmin: float, cfg: Config) -> float | None:
    """The other reading of "99%": the lowest score s such that the MEAN fitted probability of all
    predictions scoring >= s is at least the target (precision of the labelled set, as in Tseng et
    al.). Not below the lowest validated score. Reported only; labels use the per-prediction rule."""
    if fit is None or not fit.valid or fit.b1 <= 0:
        return None
    c = np.sort(np.asarray(pred_conf))[::-1]
    c = c[c >= vmin]
    if not len(c):
        return None
    cummean = np.cumsum(fit.p(logit_conf(c, cfg.eps))) / np.arange(1, len(c) + 1)
    # with an increasing curve the running mean only falls as the cut moves down the sorted scores
    ok = np.flatnonzero(cummean >= cfg.target)
    if not len(ok) or ok[0] != 0:
        return None
    return operative(float(c[ok[-1]]), cfg.threshold_decimals)


def covariate_models(d: pd.DataFrame, cfg: Config, pred_species: pd.DataFrame | None = None) -> tuple[pd.DataFrame, dict]:
    """D-13. Wood & Kahl's transferability test: does the curve change with space or time?

    Models, all with logit(score): score only; + evening (dusk, local time); + week of the season;
    + a recorder random intercept; + evening and the random intercept. The only spatial unit is the
    recorder (one grid). Compared by AIC. Diagnostic only: labels use the pooled curve unless a
    covariate model is better (ΔAIC >= 2), identified, and applicable to recorders not yet validated.
    Returns (model table, cross-tab of outcomes by review-flag group and time of day)."""
    clock = dict(cfg.clock_correction_h)

    def is_evening(df: pd.DataFrame) -> np.ndarray:
        local_hour = (df.hour.astype(int) + df.recorder.map(clock).fillna(0).astype(int)) % 24
        return local_hour.between(*cfg.evening_hours).to_numpy(float)

    evening = is_evening(d)
    week = ((pd.to_datetime(d.date) - pd.Timestamp(cfg.season_start)).dt.days / 7).to_numpy(float)
    x = logit_conf(d.confidence.to_numpy(), cfg.eps)
    y = d.outcome.to_numpy(float)
    one = np.ones_like(x)
    designs = {
        "score": (["intercept", "score"], [one, x]),
        "score + evening": (["intercept", "score", "evening"], [one, x, evening]),
        "score + week": (["intercept", "score", "week"], [one, x, week]),
    }
    fits = [fit_fixed(np.column_stack(a), y, c, n) for n, (c, a) in designs.items()]
    for n, base in (("score + (1 | recorder)", "score"), ("score + evening + (1 | recorder)", "score + evening")):
        c, a = designs[base]
        fits.append(fit_random_intercept(np.column_stack(a), y, d.recorder.to_numpy(), c, n))
    rows = []
    ident = {}
    for f in fits:
        big = [c for c, b in zip(f.columns, f.beta) if abs(b) > 15 and c != "intercept"]
        ident[f.name] = f.valid and f.sigma < 10 and not big
    # AIC is ranked only among identified models: a non-converged or boundary fit has no reliable
    # likelihood for model selection (it stays in the table as a diagnostic, without a delta AIC)
    best = min((f.aic for f in fits if ident[f.name]), default=np.nan)
    for f in fits:
        # a recorder SD this large means recorder effects behave like separation (a few recorders
        # systematically wrong), not like a normal spread: thresholds from it would be artefacts
        # a coefficient this large on the logit scale is a fixed effect running off to infinity
        # (e.g. no correct clip in the evening): separation inside the model
        # (the intercept is excluded: when the recorder SD diverges it grows with it)
        big = [c for c, b in zip(f.columns, f.beta) if abs(b) > 15 and c != "intercept"]
        identified = f.valid and f.sigma < 10 and not big
        notes = list(f.notes)
        if f.sigma >= 10:
            notes.append(f"recorder SD diverges (sigma = {f.sigma:.0f}): a boundary fit, not used for AIC ranking or crossings")
        if big and f.valid:
            notes.append(f"separation in {', '.join(big)}: coefficient not identified; crossings not reported")
        extra = [c for c in f.columns if c not in ("intercept", "score")]
        if identified and extra:
            at = {"evening": "evening = 0 (night & dawn)", "week": "week = 0 (first week)"}
            notes.append("crossing shown for " + " and ".join(at[c] for c in extra))
        # sensitivity (D-13): what the evening model would do if adopted — time-dependent thresholds
        sens_cols = {"threshold_night_if_adopted": np.nan, "threshold_evening_if_adopted": np.nan, "labelled_if_adopted": np.nan}
        if identified and f.columns == ["intercept", "score", "evening"] and pred_species is not None:
            b0, b1, be = f.beta
            if b1 > 0:
                tn = operative(float(sigmoid((np.log(cfg.target / (1 - cfg.target)) - b0) / b1)), cfg.threshold_decimals)
                te = operative(float(sigmoid((np.log(cfg.target / (1 - cfg.target)) - b0 - be) / b1)), cfg.threshold_decimals)
                ev_p = is_evening(pred_species).astype(bool)
                conf_p = pred_species.confidence.to_numpy()
                sens_cols = {"threshold_night_if_adopted": tn, "threshold_evening_if_adopted": te,
                             "labelled_if_adopted": int(np.sum(np.where(ev_p, conf_p >= te, conf_p >= tn)))}
        ct = conditional_threshold(f) if identified else None
        mt = marginal_threshold(f) if identified and f.sigma > 0 else None
        rows.append({
            "model": f.name, "k": f.k, "loglik": f.loglik, "aic": f.aic if identified else np.nan, "delta_aic": f.aic - best if identified else np.nan,
            "coefficients": "; ".join(f"{c} {b:.3f}" for c, b in zip(f.columns, f.beta)), "recorder_sd": f.sigma,
            "valid": f.valid, "identified": identified,
            # where the curve crosses the target (not an accepted threshold: no range check here)
            "crossing_typical_recorder": None if ct is None else float(sigmoid(ct)),
            "crossing_new_recorder": None if mt is None else float(sigmoid(mt)),
            "notes": " | ".join(notes),
            **sens_cols,
        })
    flagged = d.recorder.isin(d.attrs.get("flagged", []))
    if not flagged.any():  # the cross-tab exists to show what the flagged recorders contribute
        return pd.DataFrame(rows), {}
    tab = {f"{'flagged' if fl else 'other'} recorders, {'evening' if ev else 'night & dawn'}": {"correct": int(y[(flagged.to_numpy() == fl) & ((evening == 1) == ev)].sum()), "incorrect": int(((1 - y)[(flagged.to_numpy() == fl) & ((evening == 1) == ev)]).sum())}
           for fl in (True, False) for ev in (True, False)}
    return pd.DataFrame(rows), tab


def by_band(conf: pd.Series) -> pd.Categorical:
    return pd.cut(conf, BANDS, right=False, labels=BAND_LABELS)


# ══ 7–8. sensitivity, labels ═════════════════════════════════════════════════


def species_frames(val: pd.DataFrame, pred: pd.DataFrame, sp: str) -> tuple[pd.DataFrame, pd.DataFrame]:
    return val[val.commonName == sp], pred[pred.common_name == sp]


def sensitivity(pred: pd.DataFrame, val_raw: pd.DataFrame, val: pd.DataFrame, flagged: dict, species: list, cfg: Config) -> pd.DataFrame:
    """Re-run the whole procedure under alternative choices. Each row: one species, one variant."""
    val_amb, _ = deduplicate(pred, val_raw, reduce_ambiguous=True, cfg=cfg)
    variants = [
        ("primary", "as documented", val, cfg, None),
        ("endpoint", "eps = 5e-4 (half a 3-decimal step)", val, replace(cfg, eps=5e-4), None),
        ("endpoint", "eps = 1e-5", val, replace(cfg, eps=1e-5), None),
        ("endpoint", "eps = 1e-6", val, replace(cfg, eps=1e-6), None),
        ("endpoint", "validated scores of exactly 1 excluded", val[val.confidence < 1.0], cfg, None),
        ("duplicates", "ambiguous Plover pair also reduced", val_amb, cfg, None),
        ("duplicates", "no de-duplication (all clips)", val_raw, cfg, None),
        ("gate", "gate k = 1 (one error and one correct suffice)", val, replace(cfg, min_each_outcome=1), None),
        ("gate", "gate k = 3", val, replace(cfg, min_each_outcome=3), None),
        ("gate", "gate k = 10", val, replace(cfg, min_each_outcome=10), None),
        ("estimator", "gate k = 1 and Firth for every species", val, replace(cfg, min_each_outcome=1, estimator="firth"), None),
        ("estimator", "gate k = 1 and FLIC for every species", val, replace(cfg, min_each_outcome=1, estimator="flic"), None),
        ("recorders", "review-flagged recorders removed", val, cfg, "drop_flagged"),
        # where the threshold would sit without them, if the gate were not applied
        ("recorders", "review-flagged recorders removed, gate k = 1", val, replace(cfg, min_each_outcome=1), "drop_flagged"),
    ]
    rows = []
    for group, variant, v, c, special in variants:
        for sp in species:
            d, P = species_frames(v, pred, sp)
            if special == "drop_flagged":
                d = d[~d.recorder.isin(flagged.get(sp, []))]
            pr = run_procedure(d.confidence.to_numpy(), d.outcome.to_numpy(), c)
            rows.append({
                "group": group, "variant": variant, "species": sp, "validated_clips": pr.n, "incorrect": pr.n_incorrect,
                "status": pr.status, "gate_reason": pr.gate_reason, "method": pr.method,
                "threshold": pr.threshold, "model_labelled": n_labelled(P.confidence.to_numpy(), pr.threshold),
                "b0": pr.fit.b0 if pr.fit is not None and pr.fit.valid else np.nan,
                "b1": pr.fit.b1 if pr.fit is not None and pr.fit.valid else np.nan,
            })
    return pd.DataFrame(rows)


# Labels (D-10) come from ns_observations.label.label(), the same function the platform runs.


# ══ 9. report ════════════════════════════════════════════════════════════════


def figure(sp: str, r: dict, pr: Procedure, curves: dict, path: Path, cfg: Config) -> None:
    """Left: validated clips and fitted curves (full scale). Right: zoom on 0.95–1.00 where the
    threshold is decided. Curves are solid inside the validated range and dotted outside it."""
    x, y = pr.x, pr.y
    fig, axes = plt.subplots(1, 2, figsize=(11.5, 5.0), dpi=150, gridspec_kw={"width_ratios": [1.15, 1]})
    lo_g = logit_conf(np.array([0.1]), cfg.eps)[0] - 0.3
    grid = np.linspace(lo_g, max(logit_conf(np.array([0.9995]), cfg.eps)[0], x.max() if len(x) else 0), 400)
    inside = (grid >= x.min()) & (grid <= x.max()) if len(x) else np.zeros_like(grid, bool)
    ticks = [0.1, 0.25, 0.5, 0.75, 0.9, 0.97, 0.99, 0.999]
    boot = r.get("_boot_recorder")
    ci = boot["threshold_ci"] if boot else None
    styles = {"ml": ("ordinary ML", NAVY), "firth": ("Firth", SAND), "flic": ("FLIC", BLUE)}
    for ax in axes:
        if len(x):
            ax.axvspan(x.min(), x.max(), color=GREY, alpha=0.12, lw=0, label="validated score range")
        if ci:
            lo, hi = logit_conf(np.array(ci), cfg.eps)
            ax.axvspan(lo, hi, color=BLUE, alpha=0.12, lw=0, label=f"threshold 95% interval (recorder bootstrap; {boot['share_with_threshold']:.0%} of resamples give one)")
        for key, f in curves.items():
            if f is None or not f.valid:
                continue
            main = pr.fit is not None and key == pr.method
            name, col = styles[key]
            role = "primary" if main else ("information only: gate not passed" if not pr.gate_passed else "comparison")
            pg = f.p(grid)
            ax.plot(grid[inside], pg[inside], color=col, lw=2.6 if main else 1.4, zorder=4 if main else 2, label=f"{name} ({role})")
            ax.plot(grid, np.where(inside, np.nan, pg), color=col, lw=1.0, ls=":", zorder=1)
        ax.axhline(cfg.target, color="#555", lw=0.8)
        if pr.threshold is not None:
            ax.axvline(logit_conf(np.array([pr.threshold]), cfg.eps)[0], color=TEAL, lw=2, label=f"threshold {pr.threshold:.4f}")
        ax.set_xticks(logit_conf(np.array(ticks), cfg.eps))
        ax.set_xticklabels([str(t) for t in ticks], fontsize=8)
        ax.set_xlabel("BirdNET confidence (logit scale)")
        for s in ("top", "right"):
            ax.spines[s].set_visible(False)
    ax = axes[0]
    # jitter inward so points never sit outside [0, 1] on a probability axis
    jit = np.random.default_rng(1).uniform(0, 0.06, size=len(y))
    if (y == 1).any():
        ax.scatter(x[y == 1], 1 - jit[y == 1], s=12, color=TEAL, alpha=0.55, label="validated: correct", zorder=3)
    if (y == 0).any():
        ax.scatter(x[y == 0], 0 + jit[y == 0], s=26, color=ORANGE, marker="x", alpha=0.9, label="validated: incorrect", zorder=3)
    ax.set_ylim(-0.02, 1.02)
    ax.set_ylabel("pr(prediction is correct)")
    ax = axes[1]
    ax.set_ylim(0.95, 1.0005)
    ax.set_title("zoom 0.95–1.00 · dotted = outside the validated range", fontsize=8.5, color="#555")
    if pr.status == INSUFFICIENT:
        ax.text(0.5, 0.06, f"{REASON_TEXT[pr.gate_reason]}:\ncurves shown for information only", transform=ax.transAxes, ha="center", fontsize=8, color=ORANGE)
    head = pr.status.replace("_", " ") + (f" ({REASON_TEXT[pr.gate_reason]})" if pr.gate_reason else "")
    fig.suptitle(f"{sp}: {head} — {pr.n_correct}/{pr.n} validated clips correct", fontsize=10)
    # one shared legend under both panels, so it never covers data
    handles, labels = axes[0].get_legend_handles_labels()
    fig.legend(handles, labels, loc="lower center", ncol=4, fontsize=7, frameon=False, bbox_to_anchor=(0.5, 0.0))
    fig.tight_layout(rect=(0, 0.1, 1, 1))
    fig.savefig(path)
    plt.close(fig)


def nan_to_none(v):
    """JSON-safe values: numpy scalars to Python, NaN/inf to null, arrays to lists, private keys out."""
    if isinstance(v, dict):
        return {k: nan_to_none(x) for k, x in v.items() if not str(k).startswith("_")}
    if isinstance(v, (list, tuple, np.ndarray)):
        return [nan_to_none(x) for x in v]
    if isinstance(v, (np.bool_, bool)):
        return bool(v)
    if isinstance(v, np.integer):
        return int(v)
    if isinstance(v, (float, np.floating)):
        return None if not np.isfinite(v) else round(float(v), 8)
    return v


def main(cfg: Config = Config()) -> dict:
    out_dir = Path(cfg.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    pred, val_raw = load(cfg)
    val_raw = link_validations(pred, val_raw, cfg)
    val, dropped = deduplicate(pred, val_raw, cfg=cfg)
    # every species that has predictions, most frequent first; a species with validations only
    # has nothing to label and is ignored, a species with predictions only gets "no_validations"
    species = list(pred.common_name.value_counts().index)

    rows, procs, rec_tables, cov_tables, curves_all, calib, sampling, flagged, rc_by_sp = [], {}, [], [], {}, [], [], {}, {}
    for sp in species:
        d, P = species_frames(val, pred, sp)
        conf_p = P.confidence.to_numpy()
        pr = run_procedure(d.confidence.to_numpy(), d.outcome.to_numpy(), cfg)
        procs[sp] = pr

        # comparison estimators, reported for every species whatever the gate says (D-07)
        curves = {"ml": None, "firth": None, "flic": None}
        comp = {}
        if pr.n >= 2:
            for key, fn in (("ml", fit_ml), ("firth", fit_firth), ("flic", fit_flic)):
                f = fn(pr.x, pr.y)
                curves[key] = f
                st, eff, t_raw = accept(f, float(pr.x.min()), float(pr.x.max()), cfg.target)
                thr = None if eff is None else operative(pr.vmin if st == ACCEPTED_WHOLE_RANGE else float(sigmoid(eff)), cfg.threshold_decimals)
                comp[key] = {"valid": f.valid, "b0": f.b0 if f.valid else None, "b1": f.b1 if f.valid else None, "status": st,
                             "crossing_conf": None if t_raw is None else float(sigmoid(t_raw)), "threshold": thr,
                             "labelled": n_labelled(conf_p, thr), "mean_fitted_p": float(np.mean(f.p(pr.x))) if f.valid else None}
        curves_all[sp] = curves

        increasing = pr.fit is not None and pr.fit.valid and pr.fit.b1 > 0
        r = {
            "species": sp,
            "validated_clips": pr.n, "correct": pr.n_correct, "incorrect": pr.n_incorrect,
            "gate_k": cfg.min_each_outcome, "gate_passed": pr.gate_passed, "gate_reason": pr.gate_reason,
            "status": pr.status, "status_text": STATUS_TEXT[pr.status] + (f" ({REASON_TEXT[pr.gate_reason]})" if pr.gate_reason else ""),
            "method": pr.method, "method_reason": pr.method_reason,
            "b0": pr.fit.b0 if pr.fit is not None else np.nan, "b1": pr.fit.b1 if pr.fit is not None else np.nan,
            "b1_se": pr.fit.se[1] if pr.fit is not None and pr.fit.valid else np.nan,
            "validated_conf_min": pr.vmin, "validated_conf_max": pr.vmax,
            "crossing_conf": float(sigmoid(pr.t_raw)) if pr.t_raw is not None else np.nan,
            "threshold": pr.threshold if pr.threshold is not None else np.nan,
            "predictions": len(P), "model_labelled": n_labelled(conf_p, pr.threshold),
            "model_labelled_above_validated_max": int(np.sum((conf_p > pr.vmax) & (conf_p >= (pr.threshold or np.inf)))),
        }
        p_hat = pr.fit.p(logit_conf(conf_p, cfg.eps)) if increasing else np.full(len(P), np.nan)
        lab = conf_p >= (pr.threshold if pr.threshold is not None else np.inf)
        r["expected_precision_model_labelled"] = float(np.mean(p_hat[lab])) if lab.any() else np.nan
        # model-free: what the validated clips themselves say (Wilson 95%)
        r["observed_precision"] = pr.n_correct / pr.n if pr.n else np.nan
        r["observed_precision_wilson_lo"], r["observed_precision_wilson_hi"] = wilson(pr.n_correct, pr.n)
        if pr.threshold is not None:
            above = (d.confidence >= pr.threshold).to_numpy()
            k, n = int(d.outcome.to_numpy()[above].sum()), int(above.sum())
            r["validated_above_threshold"], r["validated_above_threshold_correct"] = n, k
            r["validated_above_wilson_lo"], r["validated_above_wilson_hi"] = wilson(k, n)
        dci = threshold_delta_ci(pr.fit, cfg.target) if pr.status == ACCEPTED else None
        r["delta_ci_lo"], r["delta_ci_hi"] = (float(sigmoid(dci[0])), float(sigmoid(dci[1]))) if dci else (np.nan, np.nan)
        r["set_level_threshold"] = set_level_threshold(pr.fit, conf_p, pr.vmin, cfg) if pr.threshold is not None else None
        r["set_level_labelled"] = n_labelled(conf_p, r["set_level_threshold"])
        for key in ("ml", "firth", "flic"):
            c = comp.get(key, {})
            r[f"{key}_threshold"], r[f"{key}_labelled"], r[f"{key}_status"] = c.get("threshold"), c.get("labelled"), c.get("status")
        r["_comparison"] = comp

        # uncertainty: only where the gate passed (otherwise there is no fitted decision to vary)
        if pr.gate_passed and pr.fit is not None:
            for cl, tag in (("recorder", "boot_rec"), ("audio_file", "boot_file")):
                b = bootstrap(d, conf_p, cl, cfg)
                r[f"_boot_{cl}"] = b
                r[f"{tag}_clusters"] = b["n_clusters"]
                r[f"{tag}_share_with_threshold"] = b["share_with_threshold"]
                r[f"{tag}_ci_lo"], r[f"{tag}_ci_hi"] = b["threshold_ci"] if b["threshold_ci"] else (np.nan, np.nan)
                r[f"{tag}_labelled_q025"], r[f"{tag}_labelled_median"], r[f"{tag}_labelled_q975"] = b["labelled_q"]

        rc = recorder_checks(d, pr, cfg)
        rc_by_sp[sp] = rc.copy()
        if len(rc):
            rc.insert(0, "species", sp)
            rec_tables.append(rc)
            flagged[sp] = rc.loc[rc.flagged, "recorder"].tolist()
        r["review_flagged_recorders"] = ";".join(flagged.get(sp, []))
        if pr.gate_passed:
            d_cov = d.copy()
            d_cov.attrs["flagged"] = flagged.get(sp, [])
            cm, tab = covariate_models(d_cov, cfg, P)
            cm.insert(0, "species", sp)
            cov_tables.append(cm)
            r["_covariates"], r["_cov_crosstab"] = cm, tab

        # calibration (observed vs fitted by band) and sampling design (validation vs predictions)
        pv = pr.fit.p(pr.x) if increasing else np.full(pr.n, np.nan)
        bv, bp = by_band(d.confidence), by_band(P.confidence)
        for band in BAND_LABELS:
            m = (bv == band).to_numpy()
            if m.any():
                k = int(pr.y[m].sum())
                calib.append({"species": sp, "band": band, "clips": int(m.sum()), "correct": k, "observed_share_correct": k / int(m.sum()),
                              "wilson_lo": wilson(k, int(m.sum()))[0], "wilson_hi": wilson(k, int(m.sum()))[1],
                              "mean_fitted_p": float(np.mean(pv[m])) if increasing else np.nan})
            sampling.append({"species": sp, "band": band, "validated_clips": int(m.sum()), "validated_share": float(m.mean()) if pr.n else np.nan,
                             "predictions": int((bp == band).sum()), "prediction_share": float((bp == band).mean()) if len(P) else np.nan})
        rows.append(r)

    sens = sensitivity(pred, val_raw, val, flagged, species, cfg)

    # ── threshold set (the platform artifact) and labels (D-10), through the production package ──
    policy = policy_of(cfg)
    codes = dict(zip(pred.common_name, pred.species_code))
    entries = {}
    for r in rows:
        sp = r["species"]
        d = val[val.commonName == sp]
        diag = {"model_free": model_free_check(d, procs[sp].threshold)}
        if "_boot_recorder" in r:
            diag["bootstrap_recorder"] = {k: v for k, v in r["_boot_recorder"].items() if k not in ("thresholds", "counts")}
        entries[sp] = SpeciesThreshold.from_procedure(sp, procs[sp], rc_by_sp.get(sp, pd.DataFrame()), policy, species_code=codes.get(sp), diagnostics=diag)
    ts = build_threshold_set(entries, policy, val, scope=io_csv.takehome_scope(val))
    ts.write(out_dir / "threshold_set.json")
    preds = io_csv.read_predictions(cfg.pred_csv)
    labels = label(preds.table, ts, io_csv.verdicts_from_validations(val))
    conflicts = labels.attrs.get("conflicting_verdicts", 0)
    out = io_csv.takehome_output(preds, labels)
    io_csv.write_takehome_output(preds, labels, out_dir / "birdnet_predictions_with_observations.csv")

    # ── tables ──
    pd.DataFrame([{k: v for k, v in r.items() if not k.startswith("_")} for r in rows]).to_csv(out_dir / "species_thresholds.csv", index=False)
    pd.DataFrame([{"species": r["species"], "estimator": k, **c} for r in rows for k, c in r["_comparison"].items()]).to_csv(out_dir / "estimator_comparison.csv", index=False)
    sens.to_csv(out_dir / "sensitivity.csv", index=False)
    pd.DataFrame(calib).to_csv(out_dir / "calibration_by_band.csv", index=False)
    pd.DataFrame(sampling).to_csv(out_dir / "sampling_by_band.csv", index=False)
    rec_all = pd.concat(rec_tables, ignore_index=True) if rec_tables else pd.DataFrame(columns=["species", "recorder", "flagged"])
    rec_all.to_csv(out_dir / "recorder_checks.csv", index=False)
    pd.DataFrame([rec for t in cov_tables for rec in t.to_dict("records")]).to_csv(out_dir / "covariate_models.csv", index=False)
    val.assign(prediction_row=val.candidates.map(lambda c: c[0] if len(c) == 1 else ""), candidate_rows=val.candidates.map(lambda c: ";".join(map(str, c))))[
        ["filename", "commonName", "confidence", "outcome", "recorder", "audio_file", "link", "n_candidates", "prediction_row", "candidate_rows", "duplicate_check"]
    ].to_csv(out_dir / "validation_links.csv", index=False)
    dropped[["filename", "commonName", "confidence", "outcome", "duplicate_check"]].to_csv(out_dir / "dropped_duplicate_validations.csv", index=False)

    if cfg.write_figures:
        (out_dir / "figures").mkdir(exist_ok=True)
        for r in rows:
            sp = r["species"]
            figure(sp, r, procs[sp], curves_all[sp], out_dir / "figures" / f"curve_{sp.lower().replace(' ', '_').replace('-', '_')}.png", cfg)

    # ── summary (no timestamp, so identical inputs give byte-identical outputs) ──
    obs = out.observation != ""
    summary = {
        "python": platform.python_version(),
        "packages": {m: __import__(m).__version__ for m in ["numpy", "pandas", "matplotlib"]},
        "inputs": {Path(p).name: hashlib.sha256(Path(p).read_bytes()).hexdigest() for p in [cfg.pred_csv, cfg.val_csv]},
        "config": {k: v for k, v in asdict(cfg).items() if k not in ("pred_csv", "val_csv", "out_dir")},
        "predictions": len(out),
        "validation_clips_raw": len(val_raw),
        "validation_clips_after_dedup": len(val),
        "dropped_duplicates": len(dropped),
        "validation_links": val.link.value_counts().to_dict(),
        "conflicting_unique_links": conflicts,
        "threshold_set_id": ts.threshold_set_id,
        "observations": int(obs.sum()),
        "observations_by_source": out.observation_source[obs].value_counts().to_dict(),
        "observation_status_counts": out.observation_status.value_counts().to_dict(),
        "model_observations": int((out.model_observation != "").sum()),
        "review_flagged_rows": int((out.review_flag != "").sum()),
        "review_flagged_model_observations": int(((out.review_flag != "") & (out.model_observation != "")).sum()),
        "species": {r["species"]: {
            "status": r["status"], "gate_reason": r["gate_reason"], "method": r["method"], "threshold": r["threshold"],
            "model_labelled": r["model_labelled"],
            "observations": int(obs[pred.common_name == r["species"]].sum()),
            "validated_observations": int((obs & (out.observation_source == "validated"))[pred.common_name == r["species"]].sum()),
            "review_flagged_recorders": flagged.get(r["species"], []),
        } for r in rows},
    }
    (out_dir / "run_summary.json").write_text(json.dumps(nan_to_none(summary), indent=2, ensure_ascii=False) + "\n")

    if cfg.write_dashboard_json:
        dash = dashboard_payload(pred, val, out, rows, procs, curves_all, sens, rec_all, calib, sampling, summary, flagged, cfg)
        (out_dir / "dashboard_results.json").write_text(json.dumps(nan_to_none(dash), ensure_ascii=False, separators=(",", ":")) + "\n")
    return summary


def dashboard_payload(pred, val, out, rows, procs, curves_all, sens, rec_all, calib, sampling, summary, flagged, cfg) -> dict:
    """Everything the dashboard's Thresholds page shows, precomputed here so the page never
    re-implements the statistics. The page re-applies only the published label rule
    (confidence >= species_threshold, then human verdicts) and checks it reproduces our counts."""
    grid = np.linspace(logit_conf(np.array([0.1]), cfg.eps)[0] - 0.2, logit_conf(np.array([0.9999]), cfg.eps)[0], 160)
    edges = np.linspace(0.1, 1.0, 46)
    species = []
    for r in rows:
        sp = r["species"]
        d = val[val.commonName == sp]
        P = pred[pred.common_name == sp]
        boot = {}
        for cl in ("recorder", "audio_file"):
            b = r.get(f"_boot_{cl}")
            if b:
                boot[cl] = {k: v for k, v in b.items() if k not in ("thresholds", "counts")}
                boot[cl]["thresholds"] = [None if not np.isfinite(t) else round(float(t), 6) for t in b["thresholds"]]
                boot[cl]["counts"] = b["counts"].tolist()
        species.append({
            **{k: v for k, v in r.items() if not k.startswith("_")},
            "comparison": r["_comparison"],
            "bootstrap": boot,
            "clips": {"conf": d.confidence.round(4).tolist(), "outcome": d.outcome.astype(int).tolist(), "recorder": d.recorder.tolist(), "link": d.link.tolist()},
            "curves": {k: (f.p(grid).round(6).tolist() if f is not None and f.valid else None) for k, f in curves_all[sp].items()},
            "prediction_hist": np.histogram(P.confidence, bins=edges)[0].tolist(),
            "recorders": rec_all[rec_all.species == sp].drop(columns="species").to_dict("records") if len(rec_all) else [],
            "calibration": [c for c in calib if c["species"] == sp],
            "covariates": r["_covariates"].drop(columns="species").to_dict("records") if "_covariates" in r else [],
            "covariate_crosstab": r.get("_cov_crosstab", {}),
            "sampling": [s for s in sampling if s["species"] == sp],
        })
    v = out.validation_outcome
    return {
        "generated_by": "challenge1/src/run_challenge1.py",
        "config": summary["config"],
        "inputs": summary["inputs"],
        "summary": {k: summary[k] for k in summary if k not in ("species", "config", "inputs", "packages", "python")},
        "grid_logit": grid.round(5).tolist(),
        "prediction_hist_edges": edges.round(3).tolist(),
        "status_text": STATUS_TEXT,
        "reason_text": REASON_TEXT,
        "species": species,
        "sensitivity": sens.to_dict("records"),
        # minimal data for the page to re-apply the label rule and verify it against our counts
        "validated_rows": {"row": v.index[v != ""].tolist(), "outcome": v[v != ""].tolist()},
        "review_flagged": flagged,
    }


def parse_args(argv: list[str] | None = None) -> Config:
    ap = argparse.ArgumentParser(description="Challenge 1: species thresholds and observation labels.")
    ap.add_argument("--out", type=Path, default=Config.out_dir, help="output directory")
    ap.add_argument("--n-boot", type=int, default=Config.n_boot, help="bootstrap resamples")
    ap.add_argument("--seed", type=int, default=Config.seed)
    ap.add_argument("--min-each-outcome", type=int, default=Config.min_each_outcome, help="evidence gate k")
    ap.add_argument("--no-figures", action="store_true")
    a = ap.parse_args(argv)
    return Config(out_dir=a.out, n_boot=a.n_boot, seed=a.seed, min_each_outcome=a.min_each_outcome, write_figures=not a.no_figures)


if __name__ == "__main__":
    s = main(parse_args())
    print(json.dumps(nan_to_none({k: s[k] for k in ("predictions", "observations", "observations_by_source", "model_observations", "species")}), indent=2, ensure_ascii=False))

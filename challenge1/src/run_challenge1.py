"""Challenge 1: species thresholds and observation labels for every BirdNET prediction.

Policies (see docs/challenge1_data_decisions.md, D-01 and D-05..D-08):
  * Fit:    logistic regression of outcome on logit(confidence), one per species (Wood & Kahl).
  * Route:  separation, or fewer than MIN_EVENTS clips in the rarer outcome -> Firth penalised fit
            (primary); otherwise ordinary maximum likelihood. Both fits are always reported.
  * Accept: a "model-supported" threshold needs a valid fit, an increasing curve, and the 99% point
            inside the validated score range. If the fitted probability is already >= 0.99 at the
            lowest validated score, the effective threshold is that lowest validated score (no
            extrapolation below the evidence). If 0.99 is only reached above the highest validated
            score, there is no supported threshold.
  * Rule:   point estimate of the fitted curve >= 0.99 (the brief); uncertainty reported separately.
  * Policy (b), conservative: species whose primary fit is Firth get no automatic observations until
            additional representative validation is available.

Run:  challenge1/.venv/bin/python challenge1/src/run_challenge1.py
"""

from __future__ import annotations

import hashlib
import json
import platform
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

import matplotlib
import numpy as np
import pandas as pd

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402

sys.path.insert(0, str(Path(__file__).resolve().parent))
from thresholds import (  # noqa: E402
    cluster_bootstrap,
    fit_firth,
    fit_ml,
    logit_conf,
    sigmoid,
    threshold_delta_ci,
    threshold_logit,
)

ROOT = Path(__file__).resolve().parents[2]
PRED_CSV = ROOT / "Data Birds" / "birdnet_predictions.csv"
VAL_CSV = ROOT / "Data Birds" / "validation_results.csv"
OUT = ROOT / "challenge1" / "outputs"

TARGET = 0.99
EPS = 1e-4  # logit endpoint: confidence clamped to [EPS, 1 - EPS]
MIN_EVENTS = 10  # rarer outcome below this -> Firth is primary
N_BOOT = 2000
SEED = 20261010
TOL = 0.00051  # validation scores have 3 decimals, predictions 4
BANDS = [0.1, 0.2, 0.3, 0.5, 0.7, 0.9, 1.0000001]
BAND_LABELS = ["0.1–0.2", "0.2–0.3", "0.3–0.5", "0.5–0.7", "0.7–0.9", "0.9–1.0"]

# D-04: every validated Nightjar clip from these recorders was wrong (29 of the species' 33 errors)
NIGHTJAR_REVIEW_RECORDERS = ["RBS75", "RBS79"]

TEAL, ORANGE, BLUE, GREY, NAVY = "#1f9e8c", "#eb6834", "#2a78d6", "#9aa8ae", "#00354d"


# ── data ──────────────────────────────────────────────────────────────────────


def load() -> tuple[pd.DataFrame, pd.DataFrame]:
    pred = pd.read_csv(PRED_CSV)
    stem = pred.begin_path.str.extract(r"/(RBS\d+)_(\d{8})_(\d{2})(\d{4})\.WAV$")
    pred["recorder"], pred["date"], pred["hour"] = stem[0], stem[1], stem[2]

    val = pd.read_csv(VAL_CSV)
    parts = val.filename.str.extract(r"^(\d\.\d{3})_(\d+)_(RBS\d+)_(\d{8})_(\d{2})(\d{4})\.wav$")
    val["score_text"], val["clip_index"] = parts[0], parts[1].astype(int)
    val["recorder"], val["date"], val["hour"], val["mmss"] = parts[2], parts[3], parts[4], parts[5]
    val["audio_file"] = val.recorder + "_" + val.date + "_" + val.hour  # one 1-h file per recorder-hour
    assert parts.notna().all().all(), "unexpected validation file name"
    return pred, val


def deduplicate(pred: pd.DataFrame, val: pd.DataFrame, reduce_ambiguous: bool = False) -> tuple[pd.DataFrame, pd.DataFrame]:
    """D-01: clips whose names differ only by clip number. With fewer matching predictions than
    clips, they are probable duplicates of one segment -> keep the lowest clip number. With at least
    as many matching predictions, the pair is ambiguous and kept."""
    key_pred = pred.groupby(["common_name", "recorder", "date", "hour"]).confidence.apply(np.array).to_dict()
    val = val.copy()
    val["n_candidates"] = [
        int(np.sum(np.abs(key_pred.get((r.commonName, r.recorder, r.date, r.hour), np.array([])) - r.confidence) <= TOL))
        for r in val.itertuples()
    ]
    gkey = ["commonName", "score_text", "recorder", "date", "hour", "mmss"]
    val["group_size"] = val.groupby(gkey).filename.transform("size")
    val["duplicate_check"] = "no"
    multi = val.group_size > 1
    probable = multi & (val.groupby(gkey).n_candidates.transform("max") < val.group_size)
    val.loc[probable, "duplicate_check"] = "probable duplicate"
    val.loc[multi & ~probable, "duplicate_check"] = "ambiguous (kept)"
    reduce = probable | (multi & reduce_ambiguous)
    val = val.sort_values(gkey + ["clip_index"])
    drop = reduce.loc[val.index] & val.duplicated(gkey, keep="first")
    dropped = val[drop].copy()
    return val[~drop].sort_index(), dropped


# ── per-species analysis ──────────────────────────────────────────────────────


def analyse(sp: str, val: pd.DataFrame, pred: pd.DataFrame, eps: float = EPS, boot: bool = True, exclude_exact_one: bool = False) -> dict:
    d = val[val.commonName == sp]
    if exclude_exact_one:
        d = d[d.confidence < 1.0]
    x = logit_conf(d.confidence.to_numpy(), eps)
    y = d.outcome.to_numpy().astype(int)
    ml, fi = fit_ml(x, y), fit_firth(x, y)
    n1, n0 = int(y.sum()), int(len(y) - y.sum())
    events = min(n1, n0)
    if ml.separated:
        method, reason = "firth", "separation: no finite maximum-likelihood estimate"
    elif events < MIN_EVENTS:
        method, reason = "firth", f"rarer outcome has {events} clips (< {MIN_EVENTS}): small-sample bias reduction"
    else:
        method, reason = "ml", "regular: ordinary maximum likelihood"
    prim = fi if method == "firth" else ml
    xmin, xmax = float(x.min()), float(x.max())

    def accept(f):
        t = threshold_logit(f, TARGET)
        if not f.valid:
            return "no valid fit", None, t
        if t is None:
            return "no supported threshold: fitted slope not positive", None, t
        if t > xmax:
            return "not reached within validated range", None, t
        if t < xmin:
            return "accepted: >= 0.99 across validated range (effective threshold = lowest validated score)", xmin, t
        return "accepted", t, t

    status, eff, t_raw = accept(prim)
    status_ml, eff_ml, t_ml = accept(ml)
    status_fi, eff_fi, t_fi = accept(fi)

    P = pred[pred.common_name == sp]
    conf = P.confidence.to_numpy()
    eff_conf = float(sigmoid(eff)) if eff is not None else None
    labelled = conf >= eff_conf if eff_conf is not None else np.zeros(len(P), bool)
    # a probability per prediction only from an identified, increasing curve (not the Oriole's flat penalised level)
    p_hat = prim.p(logit_conf(conf, eps)) if prim.valid and prim.b1 > 0 else np.full(len(P), np.nan)

    grid = np.linspace(xmin, xmax, 200)
    row = {
        "species": sp,
        "validated_clips": len(d),
        "correct": n1,
        "incorrect": n0,
        "rarer_outcome": events,
        "separated": ml.separated,
        "method": method,
        "method_reason": reason,
        "ml_valid": ml.valid,
        "ml_b0": ml.b0 if ml.valid else np.nan,
        "ml_b1": ml.b1 if ml.valid else np.nan,
        "ml_threshold_conf": float(sigmoid(t_ml)) if t_ml is not None else np.nan,
        "ml_status": status_ml,
        "ml_labelled": int(np.sum(conf >= sigmoid(eff_ml))) if eff_ml is not None else 0,
        "firth_valid": fi.valid,
        "firth_b0": fi.b0,
        "firth_b1": fi.b1,
        "firth_threshold_conf": float(sigmoid(t_fi)) if t_fi is not None else np.nan,
        "firth_status": status_fi,
        "firth_labelled": int(np.sum(conf >= sigmoid(eff_fi))) if eff_fi is not None else 0,
        "primary_b0": prim.b0,
        "primary_b1": prim.b1,
        "primary_b1_se": prim.se[1] if prim.valid else np.nan,
        "fitted_p_min_in_validated_range": float(prim.p(grid).min()) if prim.valid else np.nan,
        "fitted_p_max_in_validated_range": float(prim.p(grid).max()) if prim.valid else np.nan,
        "validated_conf_min": float(d.confidence.min()),
        "validated_conf_max": float(d.confidence.max()),
        "threshold_logit_raw": t_raw if t_raw is not None else np.nan,
        "threshold_conf_raw": float(sigmoid(t_raw)) if t_raw is not None else np.nan,
        "status": status,
        "effective_threshold_conf": eff_conf if eff_conf is not None else np.nan,
        "predictions": len(P),
        "labelled_a": int(labelled.sum()),
        "labelled_a_share": float(labelled.mean()) if len(P) else np.nan,
        "labelled_above_validated_max": int(np.sum(labelled & (conf > d.confidence.max()))),
        "expected_precision_labelled": float(np.nanmean(p_hat[labelled])) if labelled.any() else np.nan,
        "policy_b_status": "insufficient evidence: additional representative validation required" if method == "firth" else status,
        "labelled_b": 0 if method == "firth" else int(labelled.sum()),
    }
    dci = threshold_delta_ci(prim, TARGET)
    row["delta_ci_conf_lo"], row["delta_ci_conf_hi"] = (float(sigmoid(dci[0])), float(sigmoid(dci[1]))) if dci else (np.nan, np.nan)
    if boot:
        b = cluster_bootstrap(x, y, d.audio_file.to_numpy(), method, TARGET, N_BOOT, SEED)
        ci = b.ci()
        row["boot_unusable_share"] = b.n_failed / b.n_resamples
        row["boot_ci_conf_lo"], row["boot_ci_conf_hi"] = (float(sigmoid(ci[0])), float(sigmoid(ci[1]))) if ci else (np.nan, np.nan)
        # how many predictions would be labelled at the interval ends (bounded by the validated range)
        if ci and eff_conf is not None:
            vmin, vmax = float(d.confidence.min()), float(d.confidence.max())
            for end, z in (("lo", ci[0]), ("hi", ci[1])):
                c = max(float(sigmoid(z)), vmin)  # same range rules as the point estimate
                row[f"labelled_at_ci_{end}"] = int(np.sum(conf >= c)) if c <= vmax else 0
        else:
            row["labelled_at_ci_lo"] = row["labelled_at_ci_hi"] = np.nan
        # unconditional uncertainty of the labelled count: every resample goes through the same
        # acceptance rules, and a resample without a usable threshold labels nothing
        vmin_l, vmax_l = xmin, xmax
        counts = []
        sorted_conf = np.sort(logit_conf(conf, eps))
        for t in b.all_thresholds:
            if not np.isfinite(t) or t > vmax_l:
                counts.append(0)
            else:
                counts.append(len(sorted_conf) - int(np.searchsorted(sorted_conf, max(t, vmin_l), side="left")))
        counts = np.asarray(counts)
        row["boot_share_with_supported_threshold"] = float(np.mean(counts > 0)) if len(P) else np.nan
        row["boot_labelled_q025"], row["boot_labelled_median"], row["boot_labelled_q975"] = (int(v) for v in np.quantile(counts, [0.025, 0.5, 0.975], method="nearest"))
        row["_boot"] = b
    row["_fits"] = (ml, fi, prim, x, y, d)
    row["_labels"] = (P.index, labelled, p_hat, eff_conf)
    return row


def calibration(rows: list[dict]) -> pd.DataFrame:
    out = []
    for r in rows:
        ml, fi, prim, x, y, d = r["_fits"]
        if not prim.valid:
            continue
        p = prim.p(x)
        band = pd.cut(d.confidence, BANDS, right=False, labels=BAND_LABELS)
        for lab in BAND_LABELS:
            m = (band == lab).to_numpy()
            if m.any():
                out.append({"species": r["species"], "band": lab, "clips": int(m.sum()), "observed_share_correct": float(y[m].mean()), "mean_fitted_p": float(p[m].mean())})
    return pd.DataFrame(out)


# ── figures ───────────────────────────────────────────────────────────────────


def figure(r: dict, path: Path) -> None:
    """Left: validated clips and fitted curves on the full probability scale. Right: the same curves
    zoomed to the region around the 0.99 target, where the threshold is decided."""
    ml, fi, prim, x, y, d = r["_fits"]
    fig, axes = plt.subplots(1, 2, figsize=(11, 4.4), dpi=150, gridspec_kw={"width_ratios": [1.15, 1]})
    grid = np.linspace(logit_conf(np.array([0.1]))[0] - 0.3, max(logit_conf(np.array([0.9995]))[0], x.max()), 400)
    ticks = [0.1, 0.25, 0.5, 0.75, 0.9, 0.97, 0.99, 0.999]
    has_ci = np.isfinite(r.get("boot_ci_conf_lo", np.nan))
    thr = logit_conf(np.array([r["effective_threshold_conf"]]))[0] if np.isfinite(r["effective_threshold_conf"]) else None
    for k, ax in enumerate(axes):
        ax.axvspan(x.min(), x.max(), color=GREY, alpha=0.12, lw=0, label="validated score range")
        if has_ci:
            lo, hi = logit_conf(np.array([r["boot_ci_conf_lo"], r["boot_ci_conf_hi"]]))
            usable = 1 - r["boot_unusable_share"]
            ax.axvspan(lo, hi, color=BLUE, alpha=0.13, lw=0, label=f"threshold 95% CI (file bootstrap, {usable:.0%} of resamples usable)")
        for f, name in ((ml, "ordinary logistic (ML)"), (fi, "Firth penalised")):
            if f.valid:  # primary fit bold and solid, the comparison fit thin and dashed
                main = f.method == r["method"]
                ax.plot(grid, f.p(grid), color=NAVY if main else GREY, lw=2.4 if main else 1.5, ls="-" if main else "--", label=name + (" — primary" if main else " — comparison"), zorder=4 if main else 2)
        ax.axhline(TARGET, color="#555", lw=0.8)
        if thr is not None:
            ax.axvline(thr, color=TEAL, lw=2, label=f"threshold {r['effective_threshold_conf']:.3f}")
        ax.set_xticks(logit_conf(np.array(ticks)))
        ax.set_xticklabels([str(t) for t in ticks], fontsize=8)
        ax.set_xlabel("BirdNET confidence (logit scale)")
        for sp in ("top", "right"):
            ax.spines[sp].set_visible(False)
    ax = axes[0]
    jit = (np.random.default_rng(1).uniform(size=len(y)) - 0.5) * 0.08
    if (y == 1).any():
        ax.scatter(x[y == 1], 1 + jit[y == 1], s=12, color=TEAL, alpha=0.55, label="validated: correct", zorder=3)
    if (y == 0).any():
        ax.scatter(x[y == 0], 0 + jit[y == 0], s=26, color=ORANGE, marker="x", alpha=0.9, label="validated: incorrect", zorder=3)
    ax.set_ylim(-0.1, 1.1)
    ax.set_ylabel("pr(prediction is correct)")
    ax.legend(fontsize=7, loc="lower right", frameon=True, framealpha=0.9, edgecolor="none")
    ax = axes[1]
    ax.set_ylim(0.95, 1.0005)
    ax.set_title("zoom: 0.95–1.00", fontsize=9, color="#555")
    ax.text(grid[0] + 0.1, TARGET + 0.0012, "target 0.99", fontsize=8, color="#555")
    head = r["status"].split(" (")[0].replace("accepted: >= 0.99 across validated range", "accepted (whole range)")
    fig.suptitle(f"{r['species']}: {head} — {r['correct']}/{r['validated_clips']} validated clips correct; primary fit {r['method'].upper()}", fontsize=10)
    fig.tight_layout()
    fig.savefig(path)
    plt.close(fig)


# ── main ──────────────────────────────────────────────────────────────────────


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "figures").mkdir(exist_ok=True)
    pred, val_raw = load()
    val, dropped = deduplicate(pred, val_raw)
    species = list(pred.common_name.value_counts().index)

    rows = [analyse(sp, val, pred) for sp in species]

    # sensitivity analyses (no bootstrap): logit endpoint treatment and the ambiguous Plover pair
    val_amb, _ = deduplicate(pred, val_raw, reduce_ambiguous=True)
    variants = [
        ("primary (eps=1e-4, 4 duplicates dropped)", val, {"eps": 1e-4}),
        ("eps=5e-4 (half a 3-dp rounding step)", val, {"eps": 5e-4}),
        ("eps=1e-5", val, {"eps": 1e-5}),
        ("eps=1e-6", val, {"eps": 1e-6}),
        ("validated scores of exactly 1 excluded", val, {"eps": 1e-4, "exclude_exact_one": True}),
        ("ambiguous Plover pair also reduced", val_amb, {"eps": 1e-4}),
        ("no de-duplication (all 551 clips)", val_raw.assign(audio_file=val_raw.audio_file), {"eps": 1e-4}),
    ]
    sens = []
    for label, v, kw in variants:
        for sp in species:
            r = analyse(sp, v, pred, boot=False, **kw)
            sens.append({"variant": label, "species": sp, "validated_clips": r["validated_clips"], "method": r["method"], "status": r["status"], "b0": r["primary_b0"], "b1": r["primary_b1"], "threshold_conf_raw": r["threshold_conf_raw"], "effective_threshold_conf": r["effective_threshold_conf"], "labelled_a": r["labelled_a"], "ml_threshold_conf": r["ml_threshold_conf"], "ml_labelled": r["ml_labelled"]})
    pd.DataFrame(sens).to_csv(OUT / "sensitivity.csv", index=False)
    (OUT / "endpoint_sensitivity.csv").unlink(missing_ok=True)

    # species table
    public = [{k: v for k, v in r.items() if not k.startswith("_")} for r in rows]
    pd.DataFrame(public).to_csv(OUT / "species_thresholds.csv", index=False)
    calibration(rows).to_csv(OUT / "calibration_by_band.csv", index=False)
    dropped[["filename", "commonName", "confidence", "outcome", "duplicate_check"]].to_csv(OUT / "dropped_duplicate_validations.csv", index=False)

    # labelled predictions: original columns untouched, new columns appended
    src = pd.read_csv(PRED_CSV, dtype=str, keep_default_na=False)  # as text: source values stay byte-identical
    out = src.copy()
    out["observation"] = ""
    out["observation_status"] = ""
    out["p_correct"] = np.nan
    out["species_threshold"] = np.nan
    out["threshold_method"] = ""
    out["observation_policy_b"] = ""
    out["review_flag"] = ""
    for r in rows:
        idx, labelled, p_hat, eff_conf = r["_labels"]
        sp = r["species"]
        out.loc[idx, "p_correct"] = np.round(p_hat, 6)
        out.loc[idx, "threshold_method"] = r["method"]
        if eff_conf is None:
            out.loc[idx, "observation_status"] = f"no supported threshold for species ({r['status']})"
        else:
            out.loc[idx, "species_threshold"] = round(eff_conf, 6)
            out.loc[idx, "observation_status"] = np.where(labelled, "model-supported observation", "below species threshold")
            out.loc[idx[labelled], "observation"] = sp
            if r["method"] != "firth":
                out.loc[idx[labelled], "observation_policy_b"] = sp
    # a flag, not a label change: the pooled threshold still decides the observation
    site = (pred.common_name == "Abyssinian Nightjar") & pred.recorder.isin(NIGHTJAR_REVIEW_RECORDERS)
    out.loc[site, "review_flag"] = "Nightjar at a recorder where all validated Nightjar clips were wrong (D-04)"
    assert len(out) == len(pred) == 29491
    out.to_csv(OUT / "birdnet_predictions_with_observations.csv", index=False)
    back = pd.read_csv(OUT / "birdnet_predictions_with_observations.csv", dtype=str, keep_default_na=False)
    assert back[src.columns].equals(src), "source columns changed in the export"

    for r in rows:
        figure(r, OUT / "figures" / f"curve_{r['species'].lower().replace(' ', '_').replace('-', '_')}.png")

    summary = {
        "run_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "python": platform.python_version(),
        "packages": {m: __import__(m).__version__ for m in ["numpy", "pandas", "matplotlib"]},
        "inputs": {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in [PRED_CSV, VAL_CSV]},
        "settings": {"target": TARGET, "eps": EPS, "min_events_for_ml": MIN_EVENTS, "bootstrap_resamples": N_BOOT, "seed": SEED, "cluster": "audio file (recorder-date-hour)"},
        "validation_clips_raw": len(val_raw),
        "validation_clips_after_dedup": len(val),
        "dropped_duplicates": len(dropped),
        "labelled_policy_a": int((out.observation != "").sum()),
        "labelled_policy_b": int((out.observation_policy_b != "").sum()),
        "review_flagged": int(site.sum()),
        "review_flagged_and_labelled": int((site & (out.observation != "")).sum()),
        "species": {r["species"]: {"method": r["method"], "status": r["status"], "threshold": None if not np.isfinite(r["effective_threshold_conf"]) else round(r["effective_threshold_conf"], 4), "labelled_a": r["labelled_a"], "labelled_b": r["labelled_b"], "boot_labelled_95": [r["boot_labelled_q025"], r["boot_labelled_q975"]]} for r in rows},
        # not adopted: taking the Oriole's flat penalised level (p >= 0.99 across the validated range) at face value
        "oriole_alternative_flat_level_labelled": int((pred[pred.common_name == "African Black-headed Oriole"].confidence >= val[val.commonName == "African Black-headed Oriole"].confidence.min()).sum()),
    }
    (OUT / "run_summary.json").write_text(json.dumps(summary, indent=2))
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()

"""Job B — label: predictions + a published threshold set + human verdicts -> one label per row.

Pure and vectorised: no fitting, no I/O. The rule, in order:
  1. a uniquely linked human verdict decides (correct -> observation, incorrect -> not);
  2. otherwise the prediction is an observation when confidence >= the species threshold;
  3. a species without a supported threshold gets no automatic observations.

Inputs
  predictions: prediction_id, species, confidence, recorder
  verdicts (optional): prediction_id, outcome (1/0; may be missing for tied rows), link
      ("unique" decides the label; "tied" only marks validation_link — a tied clip matched several
      predictions with the same rounded score, so its verdict cannot be attached to one of them).
      If two unique verdicts for one prediction disagree, neither is applied. Ids are matched as text,
      so integer and string ids interoperate; matching is by position, so any index works.

Output (one row per prediction, same order): see schemas/labels.schema.json.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from .artifact import ThresholdSet
from .estimators import logit_conf, sigmoid
from .policy import INSUFFICIENT, ROW_BELOW, ROW_MODEL, ROW_NO_THRESHOLD, ROW_VALIDATED_CORRECT, ROW_VALIDATED_INCORRECT

LABEL_COLUMNS = [
    "prediction_id", "species", "observation", "observation_source", "observation_status", "model_observation",
    "p_correct", "species_threshold", "species_status", "threshold_method", "validation_outcome", "validation_link",
    "review_flag", "threshold_set_id",
]


def _key(v) -> str:
    """Ids are compared as text, so 10, 10.0-free ints and "10" match whatever dtype each table uses."""
    return str(v)


def _verdict_columns(predictions: pd.DataFrame, verdicts: pd.DataFrame | None) -> tuple[np.ndarray, np.ndarray, int, int]:
    """Human verdicts per prediction, by POSITION (works with any index). Returns
    (validation_outcome, validation_link, conflicting verdicts, verdicts whose id is not in predictions)."""
    n = len(predictions)
    outcome = np.full(n, "", dtype=object)
    link = np.full(n, "", dtype=object)
    if verdicts is None or not len(verdicts):
        return outcome, link, 0, 0
    pos = {_key(v): i for i, v in enumerate(predictions.prediction_id.to_numpy())}
    v = verdicts.copy()
    if "link" not in v:
        v["link"] = "unique"
    if "outcome" not in v:
        v["outcome"] = np.nan  # allowed for tied rows
    v["_pos"] = [pos.get(_key(x), -1) for x in v.prediction_id]
    unmatched = int((v._pos < 0).sum())
    v = v[v._pos >= 0]
    for p_ in v.loc[v.link == "tied", "_pos"]:
        link[p_] = "tied"
    uniq = v[(v.link == "unique") & v.outcome.notna()].copy()
    uniq["outcome"] = _outcome01(uniq.outcome)  # 0, "0", 0.0 and False are the same verdict
    agree = uniq.groupby("_pos").outcome.agg(lambda s: s.nunique() == 1)
    conflicts = int((~agree).sum())
    decided = uniq[uniq._pos.isin(agree[agree].index)].drop_duplicates("_pos")
    for p_, o in zip(decided._pos, decided.outcome.astype(int)):
        outcome[p_] = "correct" if o == 1 else "incorrect"
        link[p_] = "unique"
    return outcome, link, conflicts, unmatched


def _outcome01(s: pd.Series) -> pd.Series:
    """Verdict outcomes as numbers: True/False -> 1/0; anything else numeric as given (validated later)."""
    return pd.to_numeric(s.map(lambda v: 1 if v is True or v is np.True_ else 0 if v is False or v is np.False_ else v), errors="coerce")


def check_inputs(predictions: pd.DataFrame, verdicts: pd.DataFrame | None) -> None:
    """Reject malformed inputs instead of turning them into ecological observations."""
    for c in ("prediction_id", "species", "confidence", "recorder"):
        if c not in predictions:
            raise ValueError(f"predictions table is missing column '{c}'")
    ids = predictions.prediction_id
    if ids.isna().any() or (ids.astype(str).str.strip() == "").any():
        raise ValueError("prediction_id must be present and non-empty")
    if ids.map(_key).duplicated().any():  # the same normalisation used for matching verdicts
        raise ValueError("prediction_id must be unique (ids are compared as text, so 1 and '1' are the same id)")
    if predictions.species.isna().any():
        raise ValueError("species must be present")
    conf = pd.to_numeric(predictions.confidence, errors="coerce")
    if conf.isna().any() or not np.all(np.isfinite(conf)) or ((conf < 0) | (conf > 1)).any():
        raise ValueError("confidence must be a finite number in [0, 1]")
    if verdicts is None or not len(verdicts):
        return
    if "prediction_id" not in verdicts or verdicts.prediction_id.isna().any():
        raise ValueError("verdicts need a prediction_id on every row")
    links = verdicts["link"] if "link" in verdicts else pd.Series("unique", index=verdicts.index)
    if not set(links.unique()) <= {"unique", "tied"}:
        raise ValueError("verdict link must be 'unique' or 'tied'")
    uniq = verdicts.loc[links == "unique"]
    if len(uniq):
        if "outcome" not in uniq:
            raise ValueError("unique verdicts need an outcome")
        o = _outcome01(uniq.outcome)
        if not o.isin([0, 1]).all():
            raise ValueError("unique verdict outcome must be exactly 0 or 1 (or True/False)")


def label(predictions: pd.DataFrame, threshold_set: ThresholdSet, verdicts: pd.DataFrame | None = None) -> pd.DataFrame:
    check_inputs(predictions, verdicts)
    pol = threshold_set.policy
    sp = threshold_set.species
    species = predictions.species
    conf = pd.to_numeric(predictions.confidence).to_numpy(float)

    thr = species.map({k: v.threshold if v.has_threshold else np.nan for k, v in sp.items()}).astype(float)
    status = species.map({k: v.status for k, v in sp.items()}).fillna(INSUFFICIENT)  # unseen species: no validations
    method = species.map({k: v.method or "" for k, v in sp.items()}).fillna("")
    has_thr = thr.notna().to_numpy()
    model_obs = has_thr & (conf >= np.where(has_thr, thr.to_numpy(), np.inf))

    # p_correct only from an identified (valid, increasing) curve
    b0 = species.map({k: v.beta0 if v.curve_identified else np.nan for k, v in sp.items()}).astype(float).to_numpy()
    b1 = species.map({k: v.beta1 if v.curve_identified else np.nan for k, v in sp.items()}).astype(float).to_numpy()
    p = np.where(np.isfinite(b0), sigmoid(b0 + b1 * logit_conf(conf, pol["eps"])), np.nan)

    vo, v_link, conflicts, unmatched = _verdict_columns(predictions, verdicts)
    flagged = {(k, str(f.recorder)) for k, v in sp.items() for f in v.review_flags}
    flag = np.array([(s, str(r)) in flagged for s, r in zip(species, predictions.recorder)], dtype=bool)
    decimals = pol["threshold_decimals"]

    out = pd.DataFrame({
        "prediction_id": predictions.prediction_id.to_numpy(),
        "species": species.to_numpy(),
        "observation": (vo == "correct") | ((vo == "") & model_obs),
        "observation_source": np.select([vo != "", model_obs], ["validated", "model"], ""),
        "observation_status": np.select([vo == "correct", vo == "incorrect", model_obs, has_thr],
                                        [ROW_VALIDATED_CORRECT, ROW_VALIDATED_INCORRECT, ROW_MODEL, ROW_BELOW], ROW_NO_THRESHOLD),
        "model_observation": model_obs,
        "p_correct": np.round(p, 6),
        "species_threshold": [f"{t:.{decimals}f}" if np.isfinite(t) else "" for t in thr.to_numpy()],
        "species_status": status.to_numpy(),
        "threshold_method": method.to_numpy(),
        "validation_outcome": vo,
        "validation_link": v_link,
        "review_flag": np.where(flag, "recorder_inconsistent_with_pooled_curve", ""),
        "threshold_set_id": threshold_set.threshold_set_id,
    }, index=predictions.index)
    out.attrs["conflicting_verdicts"] = conflicts
    out.attrs["unmatched_verdicts"] = unmatched  # verdicts for predictions not in this batch (normal when labelling a subset)
    return out[LABEL_COLUMNS]

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
      If two unique verdicts for one prediction disagree, neither is applied.

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


def _verdict_columns(predictions: pd.DataFrame, verdicts: pd.DataFrame | None) -> tuple[pd.Series, pd.Series, int]:
    outcome = pd.Series("", index=predictions.index, dtype=object)
    link = pd.Series("", index=predictions.index, dtype=object)
    if verdicts is None or not len(verdicts):
        return outcome, link, 0
    pos = pd.Series(predictions.index, index=predictions.prediction_id.to_numpy())
    v = verdicts.copy()
    v["link"] = v["link"] if "link" in v else "unique"
    tied = v[v.link == "tied"]
    link.loc[pos.reindex(tied.prediction_id).dropna().astype(int).to_numpy()] = "tied"
    uniq = v[(v.link == "unique") & v.outcome.notna()]
    agree = uniq.groupby("prediction_id").outcome.agg(lambda s: s.nunique() == 1)
    conflicts = int((~agree).sum())
    first = uniq.drop_duplicates("prediction_id").set_index("prediction_id").outcome
    first = first[agree[agree].index]
    rows = pos.reindex(first.index).dropna().astype(int)
    first = first.loc[rows.index]
    outcome.loc[rows.to_numpy()] = np.where(first.astype(int).to_numpy() == 1, "correct", "incorrect")
    link.loc[rows.to_numpy()] = "unique"
    return outcome, link, conflicts


def label(predictions: pd.DataFrame, threshold_set: ThresholdSet, verdicts: pd.DataFrame | None = None) -> pd.DataFrame:
    for c in ("prediction_id", "species", "confidence", "recorder"):
        if c not in predictions:
            raise ValueError(f"predictions table is missing column '{c}'")
    if predictions.prediction_id.duplicated().any():
        raise ValueError("prediction_id must be unique")
    pol = threshold_set.policy
    sp = threshold_set.species
    species = predictions.species
    conf = predictions.confidence.to_numpy(float)

    thr = species.map({k: v.threshold if v.has_threshold else np.nan for k, v in sp.items()}).astype(float)
    status = species.map({k: v.status for k, v in sp.items()}).fillna(INSUFFICIENT)  # unseen species: no validations
    method = species.map({k: v.method or "" for k, v in sp.items()}).fillna("")
    has_thr = thr.notna().to_numpy()
    model_obs = has_thr & (conf >= np.where(has_thr, thr.to_numpy(), np.inf))

    # p_correct only from an identified (valid, increasing) curve
    b0 = species.map({k: v.beta0 if v.curve_identified else np.nan for k, v in sp.items()}).astype(float).to_numpy()
    b1 = species.map({k: v.beta1 if v.curve_identified else np.nan for k, v in sp.items()}).astype(float).to_numpy()
    p = np.where(np.isfinite(b0), sigmoid(b0 + b1 * logit_conf(conf, pol["eps"])), np.nan)

    v_out, v_link, conflicts = _verdict_columns(predictions, verdicts)
    vo = v_out.to_numpy()
    flagged = {(k, f.recorder) for k, v in sp.items() for f in v.review_flags}
    flag = np.array([(s, r) in flagged for s, r in zip(species, predictions.recorder)])
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
        "validation_link": v_link.to_numpy(),
        "review_flag": np.where(flag, "recorder_inconsistent_with_pooled_curve", ""),
        "threshold_set_id": threshold_set.threshold_set_id,
    }, index=predictions.index)
    out.attrs["conflicting_verdicts"] = conflicts
    return out[LABEL_COLUMNS]

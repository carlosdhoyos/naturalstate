"""CSV adapter for the BirdNET exports as delivered in the take-home (birdnet_predictions.csv,
validation_results.csv).

These exports have no shared prediction id, so validated clips are linked to predictions by
species + recorder + date + hour + score (D-02), and validations of the same segment counted twice
are removed (D-01). On the platform, a stable prediction_id in both tables replaces all of this
(see io_postgres.py and the Tech handover, section 8).
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pandas as pd

from .label import LABEL_COLUMNS

# file-name patterns (case-insensitive); recorder ids may be any token without "_" or "/"
PRED_PATH_PATTERN = r"/(?P<recorder>[^/_]+)_(?P<date>\d{8})_(?P<hour>\d{2})\d{4}\.wav$"
VAL_NAME_PATTERN = r"^(?P<score>\d\.\d{3})_(?P<clip>\d+)_(?P<recorder>[^/_]+)_(?P<date>\d{8})_(?P<hour>\d{2})(?P<mmss>\d{4})\.wav$"
LINK_TOL = 0.00051  # validation scores have 3 decimals, predictions 4: allow half a 3-dp step


@dataclass
class Predictions:
    raw: pd.DataFrame  # the source file as text, so it can be written back byte-identical
    table: pd.DataFrame  # canonical: prediction_id, species, species_code, confidence, recorder, date, hour


def read_predictions(path: str | Path) -> Predictions:
    raw = pd.read_csv(path, dtype=str, keep_default_na=False)
    stem = raw.begin_path.str.extract(PRED_PATH_PATTERN, flags=2)  # 2 = re.IGNORECASE
    if stem.isna().any().any():
        raise ValueError(f"unparseable prediction path, e.g. {raw.begin_path[stem.isna().any(axis=1)].iloc[0]}")
    table = pd.DataFrame({
        "prediction_id": np.arange(len(raw)),  # row number: the export has no id (C-6)
        "species": raw.common_name,
        "species_code": raw.species_code,
        "confidence": raw.confidence.astype(float),
        "recorder": stem["recorder"], "date": stem["date"], "hour": stem["hour"],
    })
    return Predictions(raw, table)


def read_validations(path: str | Path) -> pd.DataFrame:
    """Parse validation_results.csv. Fails loudly on a file name it cannot parse."""
    val = pd.read_csv(path)
    parts = val.filename.str.extract(VAL_NAME_PATTERN, flags=2)
    if parts.isna().any().any():
        raise ValueError(f"unparseable validation file name, e.g. {val.filename[parts.isna().any(axis=1)].iloc[0]}")
    if not set(val.outcome.unique()) <= {0, 1}:
        raise ValueError("outcome must be 0/1")
    # bracket access: parts.clip would be DataFrame.clip(), not the column
    return val.assign(
        species=val.commonName, score_text=parts["score"], clip_index=parts["clip"].astype(int),
        recorder=parts["recorder"], date=parts["date"], hour=parts["hour"], mmss=parts["mmss"],
        audio_file=parts["recorder"] + "_" + parts["date"] + "_" + parts["hour"],  # one audio file per recorder-hour
    )


def link_validations(pred: pd.DataFrame, val: pd.DataFrame, tol: float = LINK_TOL) -> pd.DataFrame:
    """D-02. Candidate predictions for each validated clip: same species, recorder, date and hour,
    and a score equal up to the 3-decimal rounding of the validation file name.
    Adds candidates (list of prediction_id), n_candidates, link ("unique" / "tied" / "none")."""
    groups = {k: (g.prediction_id.to_numpy(), g.confidence.to_numpy()) for k, g in pred.groupby(["species", "recorder", "date", "hour"])}
    cands = []
    for r in val.itertuples():
        ids, conf = groups.get((r.species, r.recorder, r.date, r.hour), (np.array([], int), np.array([])))
        cands.append(ids[np.abs(conf - r.confidence) <= tol].tolist())
    val = val.copy()
    val["candidates"] = cands
    val["n_candidates"] = [len(c) for c in cands]
    val["link"] = np.select([val.n_candidates == 1, val.n_candidates > 1], ["unique", "tied"], "none")
    return val


def deduplicate(val: pd.DataFrame, reduce_ambiguous: bool = False) -> tuple[pd.DataFrame, pd.DataFrame]:
    """D-01. Clips whose names differ only by the clip number.
    * fewer matching predictions than clips (but at least one): probable duplicates — keep as many
      clips as there are matching segments (lowest clip numbers), drop the rest;
    * at least as many matching predictions as clips: ambiguous (distinct segments possible), kept
      unless reduce_ambiguous (then one clip is kept);
    * no matching prediction at all: no evidence either way, kept."""
    val = val.copy()
    gkey = ["species", "score_text", "recorder", "date", "hour", "mmss"]
    val["group_size"] = val.groupby(gkey).filename.transform("size")
    multi = val.group_size > 1
    max_c = val.groupby(gkey).n_candidates.transform("max")
    probable = multi & (max_c >= 1) & (max_c < val.group_size)
    ambiguous = multi & (max_c >= val.group_size)
    val["duplicate_check"] = np.select([probable, ambiguous, multi], ["probable duplicate", "ambiguous (distinct segments possible)", "unlinked group (kept)"], "no")
    keep_n = np.where(probable, max_c, np.where(ambiguous & reduce_ambiguous, 1, val.group_size))
    val = val.assign(_keep_n=keep_n).sort_values(gkey + ["clip_index"])
    rank = val.groupby(gkey).cumcount()  # 0 = lowest clip number in its group
    drop = rank >= val._keep_n
    return val[~drop].drop(columns="_keep_n").sort_index(), val[drop].drop(columns="_keep_n").copy()


TAKEHOME_PROJECT = "naturalstate-takehome"


def takehome_scope(validations: pd.DataFrame, project_id: str = TAKEHOME_PROJECT) -> dict:
    """Scope for the take-home exports: the BirdNET version comes from the validation file."""
    versions = sorted(validations["vBirdNET"].astype(str).unique()) if "vBirdNET" in validations else ["unknown"]
    return {"project_id": project_id, "birdnet_config": "BirdNET " + "+".join(versions)}


def load_validations(path: str | Path, predictions: Predictions) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Read, link and de-duplicate. Returns (validations ready for calibrate, dropped duplicates)."""
    val = link_validations(predictions.table, read_validations(path))
    return deduplicate(val)


def verdicts_from_validations(val: pd.DataFrame) -> pd.DataFrame:
    """D-10. Human verdicts for label(): unique links decide, tied links only mark their candidates."""
    uniq = val[val.link == "unique"]
    rows = [pd.DataFrame({"prediction_id": uniq.candidates.str[0].astype(int).to_numpy(), "outcome": uniq.outcome.astype(int).to_numpy(), "link": "unique"})]
    tied = val[val.link == "tied"]
    if len(tied):
        ids = [i for c in tied.candidates for i in c]
        rows.append(pd.DataFrame({"prediction_id": ids, "outcome": np.nan, "link": "tied"}))
    return pd.concat(rows, ignore_index=True)


def takehome_output(predictions: Predictions, labels: pd.DataFrame) -> pd.DataFrame:
    """The Q1 file: the source columns byte-identical, then the label columns, with `observation`
    and `model_observation` holding the species name (or empty) as the brief asks."""
    out = predictions.raw.copy()
    sp = labels.species.to_numpy()
    out["observation"] = np.where(labels.observation.to_numpy(), sp, "")
    for c in ("observation_source", "observation_status"):
        out[c] = labels[c].to_numpy()
    out["model_observation"] = np.where(labels.model_observation.to_numpy(), sp, "")
    out["p_correct"] = labels.p_correct.to_numpy()
    for c in ("species_threshold", "species_status", "threshold_method", "validation_outcome", "validation_link", "review_flag"):
        out[c] = labels[c].to_numpy()
    return out


def write_takehome_output(predictions: Predictions, labels: pd.DataFrame, path: str | Path) -> Path:
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    out = takehome_output(predictions, labels)
    out.to_csv(p, index=False)
    back = pd.read_csv(p, dtype=str, keep_default_na=False)
    if not back[predictions.raw.columns].equals(predictions.raw):
        raise AssertionError("source columns changed in the export")
    return p


def write_labels(labels: pd.DataFrame, path: str | Path) -> Path:
    """Platform-shaped label file (schemas/labels.schema.json), one row per prediction."""
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    labels[LABEL_COLUMNS].to_csv(p, index=False)
    return p

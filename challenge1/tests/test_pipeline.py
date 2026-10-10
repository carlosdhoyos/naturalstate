"""Checks of the labelling pipeline: de-duplication, acceptance rules and the exported file.

Run after the pipeline:  challenge1/.venv/bin/python -m pytest challenge1/tests -q
"""

import sys
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
import run_challenge1 as rc  # noqa: E402

EXPORT = rc.OUT / "birdnet_predictions_with_observations.csv"


@pytest.fixture(scope="module")
def data():
    pred, val_raw = rc.load()
    val, dropped = rc.deduplicate(pred, val_raw)
    return pred, val_raw, val, dropped


def test_deduplication_drops_exactly_the_four_probable_duplicates(data):
    _, val_raw, val, dropped = data
    assert len(val_raw) == 551 and len(val) == 547 and len(dropped) == 4
    assert set(dropped.commonName) == {"Three-banded Plover"}
    assert dropped.outcome.eq(1).all()
    # the Plover's single error survives
    assert "0.264_6_RBS64_20230629_060003.wav" in set(val.filename)
    _, amb = rc.deduplicate(data[0], val_raw, reduce_ambiguous=True)
    assert len(amb) == 5


def test_firth_routing_and_statuses(data):
    pred, _, val, _ = data
    rows = {sp: rc.analyse(sp, val, pred, boot=False) for sp in pred.common_name.unique()}
    assert rows["African Black-headed Oriole"]["method"] == "firth" and rows["African Black-headed Oriole"]["separated"]
    assert rows["Three-banded Plover"]["method"] == "firth" and not rows["Three-banded Plover"]["separated"]
    assert rows["Abyssinian Nightjar"]["method"] == "ml"
    assert rows["Red-billed Firefinch"]["status"].startswith("not reached")
    assert rows["African Black-headed Oriole"]["status"].startswith("no supported threshold")
    for r in rows.values():
        t = r["effective_threshold_conf"]
        if np.isfinite(t):  # an accepted threshold never lies outside the validated range
            assert r["validated_conf_min"] <= t <= r["validated_conf_max"]


@pytest.mark.skipif(not EXPORT.exists(), reason="run the pipeline first")
def test_export_keeps_source_and_labels_consistently():
    src = pd.read_csv(rc.PRED_CSV, dtype=str, keep_default_na=False)
    out = pd.read_csv(EXPORT, dtype=str, keep_default_na=False)
    assert len(out) == len(src) == 29491
    assert out[src.columns].equals(src)
    conf = out.confidence.astype(float)
    labelled = out.observation != ""
    assert (out.observation[labelled] == out.common_name[labelled]).all()
    thr = pd.to_numeric(out.species_threshold, errors="coerce")
    assert (conf[labelled] >= thr[labelled]).all()
    has_thr = thr.notna()
    assert (labelled == (has_thr & (conf >= thr))).all()
    assert (labelled == (out.observation_status == "model-supported observation")).all()
    # policy (b) is a subset of policy (a)
    b = out.observation_policy_b != ""
    assert not (b & ~labelled).any()

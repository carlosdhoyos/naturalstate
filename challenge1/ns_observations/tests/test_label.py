"""Job B: the label rule, verdict handling, and the output schema."""

import json
from importlib import resources

import numpy as np
import pandas as pd
import pytest

from ns_observations import calibrate, label
from ns_observations.label import LABEL_COLUMNS


@pytest.fixture
def ts(synthetic_validations):
    return calibrate(synthetic_validations)


def _preds(ts):
    thr = ts.species["good"].threshold
    return pd.DataFrame({
        "prediction_id": ["p1", "p2", "p3", "p4", "p5", "p6", "p7"],
        "species": ["good", "good", "good", "good", "rare", "unseen", "good"],
        "confidence": [thr, thr - 1e-6, 0.99, 0.2, 0.99, 0.99, 0.99],
        "recorder": ["R1"] * 7,
    })


def test_threshold_rule_including_the_exact_boundary(ts):
    out = label(_preds(ts), ts)
    assert out.observation.tolist() == [True, False, True, False, False, False, True]
    assert out.observation_status.tolist() == ["model_observation", "below_threshold", "model_observation", "below_threshold", "no_species_threshold", "no_species_threshold", "model_observation"]
    assert out.species_status.tolist()[4:6] == ["insufficient_validation", "insufficient_validation"]  # rare: gate; unseen: no validations
    assert list(out.columns) == LABEL_COLUMNS


def test_human_verdicts_override_and_conflicts_do_not(ts):
    verdicts = pd.DataFrame({
        "prediction_id": ["p3", "p4", "p5", "p7", "p7", "p2"],
        "outcome": [0, 1, 1, 1, 0, np.nan],
        "link": ["unique", "unique", "unique", "unique", "unique", "tied"],
    })
    out = label(_preds(ts), ts, verdicts).set_index("prediction_id")
    assert out.loc["p3", "observation_status"] == "validated_incorrect" and not out.loc["p3", "observation"]  # rejected despite 0.99
    assert out.loc["p4", "observation"] and out.loc["p4", "observation_source"] == "validated"  # confirmed despite 0.2
    assert out.loc["p5", "observation"]  # human-confirmed although the species has no threshold
    assert out.loc["p7", "observation_source"] == "model"  # two unique verdicts disagree: none applied
    assert out.loc["p2", "validation_link"] == "tied" and out.loc["p2", "validation_outcome"] == ""
    assert out.attrs["conflicting_verdicts"] == 1


def test_p_correct_only_for_identified_curves(ts):
    out = label(_preds(ts), ts)
    assert out.p_correct.iloc[:4].notna().all()
    assert out.p_correct.iloc[4:6].isna().all()


def test_duplicate_prediction_ids_are_rejected(ts):
    p = _preds(ts)
    p.loc[1, "prediction_id"] = "p1"
    with pytest.raises(ValueError, match="unique"):
        label(p, ts)


def test_rows_match_the_label_schema(ts):
    import jsonschema

    schema = json.loads(resources.files("ns_observations").joinpath("schemas", "labels.schema.json").read_text())
    out = label(_preds(ts), ts)
    for rec in out.to_dict("records"):
        rec = {k: (None if isinstance(v, float) and np.isnan(v) else v.item() if hasattr(v, "item") else v) for k, v in rec.items()}
        jsonschema.validate(rec, schema)

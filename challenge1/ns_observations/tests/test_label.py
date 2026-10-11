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


def test_ids_match_across_int_and_str_and_any_index(ts):
    """Verdict ids as text vs prediction ids as int (and a non-integer index) must still match."""
    p = _preds(ts).assign(prediction_id=[10, 11, 12, 13, 14, 15, 16])
    p.index = list("abcdefg")
    v = pd.DataFrame({"prediction_id": ["12", "13"], "outcome": [0, 1], "link": "unique"})
    out = label(p, ts, v)
    assert out.observation_status.tolist()[2:4] == ["validated_incorrect", "validated_correct"]
    assert out.attrs["unmatched_verdicts"] == 0


def test_conflicts_and_unmatched_only_count_known_predictions(ts):
    v = pd.DataFrame({"prediction_id": ["zzz", "zzz", "p1"], "outcome": [0, 1, 1], "link": "unique"})
    out = label(_preds(ts), ts, v)
    assert out.attrs["conflicting_verdicts"] == 0 and out.attrs["unmatched_verdicts"] == 2


def test_tied_rows_without_an_outcome_column(ts):
    out = label(_preds(ts), ts, pd.DataFrame({"prediction_id": ["p2"], "link": ["tied"]}))
    assert out.validation_link.tolist()[1] == "tied"


def test_review_flags_match_numeric_recorder_ids():
    import numpy as np

    from ns_observations import calibrate

    rng = np.random.default_rng(4)
    conf = rng.uniform(0.1, 0.99, 600)
    y = (rng.uniform(size=600) < 1 / (1 + np.exp(-(1.0 + 2.0 * np.log(conf / (1 - conf)))))).astype(int)
    v = pd.concat([pd.DataFrame({"species": "s", "confidence": conf, "outcome": y, "recorder": rng.choice([1, 2, 3, 4, 5], 600)}),
                   pd.DataFrame({"species": "s", "confidence": rng.uniform(0.3, 0.6, 20), "outcome": 0, "recorder": 99})])
    ts = calibrate(v)
    out = label(pd.DataFrame({"prediction_id": [1, 2], "species": "s", "confidence": [0.9, 0.9], "recorder": [99, 1]}), ts)
    assert out.review_flag.tolist() == ["recorder_inconsistent_with_pooled_curve", ""]


@pytest.mark.parametrize("bad_conf", [1.5, -0.1, float("nan"), float("inf")])
def test_invalid_confidence_is_rejected(ts, bad_conf):
    p = _preds(ts)
    p.loc[0, "confidence"] = bad_conf
    with pytest.raises(ValueError, match="confidence"):
        label(p, ts)


@pytest.mark.parametrize("bad_outcome", [1.9, 2, -1, "yes"])
def test_invalid_verdict_outcome_is_rejected(ts, bad_outcome):
    v = pd.DataFrame({"prediction_id": ["p1"], "outcome": [bad_outcome], "link": ["unique"]})
    with pytest.raises(ValueError, match="outcome"):
        label(_preds(ts), ts, v)


def test_boolean_outcomes_are_accepted(ts):
    v = pd.DataFrame({"prediction_id": ["p1", "p4"], "outcome": [False, True], "link": "unique"})
    out = label(_preds(ts), ts, v)
    assert out.observation_status.tolist()[0] == "validated_incorrect" and out.observation_status.tolist()[3] == "validated_correct"


def test_ids_that_collide_as_text_are_rejected(ts):
    p = _preds(ts).assign(prediction_id=[1, "1", 3, 4, 5, 6, 7])
    with pytest.raises(ValueError, match="unique"):
        label(p, ts)

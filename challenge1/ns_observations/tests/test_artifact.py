"""The threshold set: determinism, round trip, schema enforcement."""

import json

import jsonschema
import pytest

from ns_observations import Policy, ThresholdSet, calibrate
from ns_observations.artifact import validate_threshold_set, validation_hash


def test_same_inputs_same_bytes_and_id(synthetic_validations):
    a, b = calibrate(synthetic_validations), calibrate(synthetic_validations.sample(frac=1, random_state=3))
    assert a.to_json() == b.to_json()  # row order does not matter
    assert a.threshold_set_id.startswith("ts-") and len(a.threshold_set_id) == 19


def test_id_changes_with_policy_or_code_version(synthetic_validations):
    base = calibrate(synthetic_validations).threshold_set_id
    assert calibrate(synthetic_validations, Policy(min_each_outcome=1)).threshold_set_id != base
    assert calibrate(synthetic_validations, code_version="abc123").threshold_set_id != base


def test_round_trip(tmp_path, synthetic_validations):
    ts = calibrate(synthetic_validations)
    p = ts.write(tmp_path / "ts.json")
    back = ThresholdSet.read(p)
    assert back.to_json() == ts.to_json()
    assert back.policy_obj() == Policy()


def test_schema_rejects_inconsistent_artifacts(synthetic_validations):
    d = calibrate(synthetic_validations).to_dict()
    bad = json.loads(json.dumps(d))
    bad["species"]["rare"]["threshold"] = 0.5  # insufficient_validation must not carry a threshold
    with pytest.raises(jsonschema.ValidationError):
        validate_threshold_set(bad)
    bad = json.loads(json.dumps(d))
    bad["species"]["good"]["status"] = "great"
    with pytest.raises(jsonschema.ValidationError):
        validate_threshold_set(bad)


def test_validation_hash_ignores_row_order_but_not_content(synthetic_validations):
    v = synthetic_validations
    assert validation_hash(v) == validation_hash(v.iloc[::-1])
    assert validation_hash(v) != validation_hash(v.assign(outcome=1 - v.outcome))


def test_id_ignores_diagnostics_bootstrap_settings_and_status(synthetic_validations):
    """The id identifies the decisions: diagnostics, n_boot/seed and publication do not change it."""
    from ns_observations.artifact import content_id

    plain = calibrate(synthetic_validations)
    diag = calibrate(synthetic_validations, Policy(n_boot=30, seed=7), diagnostics=True)
    assert diag.threshold_set_id == plain.threshold_set_id
    d = plain.to_dict()
    d["status"] = "published"
    assert content_id(d) == plain.threshold_set_id

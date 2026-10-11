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


def test_tampered_threshold_is_rejected_even_with_a_recomputed_id(synthetic_validations):
    """An edited threshold fails the id check; recomputing the id then fails the invariant check."""
    from ns_observations.artifact import content_id, verify_integrity

    d = calibrate(synthetic_validations).to_dict()
    d["species"]["good"]["threshold"] = 0.15
    with pytest.raises(ValueError, match="does not match its content"):
        ThresholdSet.from_dict(d)
    d["threshold_set_id"] = content_id(d)
    with pytest.raises(ValueError, match="accepted threshold"):
        verify_integrity(d)


def test_write_validates_and_verifies(tmp_path, synthetic_validations):
    ts = calibrate(synthetic_validations)
    ts.species["good"].threshold = 0.15  # edited in memory after calibration
    with pytest.raises(ValueError):
        ts.write(tmp_path / "x.json")
    assert not (tmp_path / "x.json").exists()


def test_scope_is_part_of_the_id(synthetic_validations):
    a = calibrate(synthetic_validations, scope={"project_id": "A", "birdnet_config": "v2.4"})
    b = calibrate(synthetic_validations, scope={"project_id": "B", "birdnet_config": "v2.4"})
    c = calibrate(synthetic_validations, scope={"project_id": "A", "birdnet_config": "v2.5"})
    assert len({a.threshold_set_id, b.threshold_set_id, c.threshold_set_id}) == 3
    assert a.scope == {"project_id": "A", "birdnet_config": "v2.4"}

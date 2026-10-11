"""Job A: gate, fit, acceptance, rounding, review flags."""

import numpy as np
import pandas as pd
import pytest

from ns_observations import Policy, calibrate
from ns_observations.calibrate import evidence_gate, run_procedure
from ns_observations.policy import ACCEPTED, ACCEPTED_WHOLE_RANGE, INSUFFICIENT, NO_VALID_FIT, NOT_REACHED, SLOPE_NOT_POSITIVE, operative


def test_gate_reasons():
    assert evidence_gate(0, 0, 5) == (False, "no_validations")
    assert evidence_gate(10, 0, 5) == (False, "no_observed_errors")
    assert evidence_gate(0, 10, 5) == (False, "no_observed_correct")
    assert evidence_gate(100, 4, 5) == (False, "too_few_errors")
    assert evidence_gate(4, 100, 5) == (False, "too_few_correct")
    assert evidence_gate(5, 5, 5) == (True, None)


def _curve(b0, b1, lo, hi, n, seed):
    rng = np.random.default_rng(seed)
    conf = np.round(rng.uniform(lo, hi, n), 3)
    x = np.log(conf / (1 - conf))
    return conf, (rng.uniform(size=n) < 1 / (1 + np.exp(-(b0 + b1 * x)))).astype(int)


def test_acceptance_branches():
    pol = Policy()
    assert run_procedure(*_curve(1.0, 2.0, 0.1, 0.99, 600, 1), pol).status == ACCEPTED
    assert run_procedure(*_curve(6.15, 1.0, 0.3, 0.99, 20000, 0), pol).status == ACCEPTED_WHOLE_RANGE
    assert run_procedure(*_curve(-1.0, 0.5, 0.1, 0.6, 400, 2), pol).status == NOT_REACHED
    assert run_procedure(*_curve(1.0, -2.0, 0.1, 0.6, 400, 3), pol).status == SLOPE_NOT_POSITIVE
    assert run_procedure(np.full(40, 0.5), np.r_[np.ones(30), np.zeros(10)].astype(int), pol).status == NO_VALID_FIT


def test_whole_range_threshold_is_the_exact_lowest_score():
    conf, y = _curve(6.15, 1.0, 0.3, 0.99, 20000, 0)
    pr = run_procedure(conf, y, Policy())
    assert pr.threshold == conf.min()


def test_operative_rounds_up_and_labels_use_it():
    assert operative(0.66663806) == 0.666639
    assert operative(0.104) == 0.104
    for c in np.random.default_rng(0).uniform(0.1, 1, 500):
        assert c <= operative(c) + 1e-12 and operative(c) - c < 1e-6


def test_calibrate_statuses_and_explicit_no_validations(synthetic_validations):
    ts = calibrate(synthetic_validations, species=["unvalidated", "good", "rare"])
    assert ts.species["good"].status == ACCEPTED and ts.species["good"].threshold is not None
    assert ts.species["rare"].status == INSUFFICIENT and ts.species["rare"].gate_reason == "too_few_errors"
    assert ts.species["unvalidated"].gate_reason == "no_validations"


def test_bad_inputs_are_rejected(synthetic_validations):
    with pytest.raises(ValueError, match="missing columns"):
        calibrate(synthetic_validations.drop(columns="recorder"))
    with pytest.raises(ValueError, match="outcome must be 0/1"):
        calibrate(synthetic_validations.assign(outcome=2))
    with pytest.raises(ValueError, match="confidence"):
        calibrate(synthetic_validations.assign(confidence=1.5))


def test_review_flag_detects_an_all_wrong_recorder():
    rng = np.random.default_rng(4)
    conf = rng.uniform(0.1, 0.99, 600)
    x = np.log(conf / (1 - conf))
    y = (rng.uniform(size=600) < 1 / (1 + np.exp(-(1.0 + 2.0 * x)))).astype(int)
    rec = rng.choice(["A", "B", "C", "D", "E"], 600)
    bad = pd.DataFrame({"species": "s", "confidence": rng.uniform(0.3, 0.6, 20), "outcome": 0, "recorder": "BAD"})
    v = pd.concat([pd.DataFrame({"species": "s", "confidence": conf, "outcome": y, "recorder": rec}), bad])
    flags = calibrate(v).species["s"].review_flags
    assert [f.recorder for f in flags] == ["BAD"]


def test_diagnostics_are_optional_and_deterministic(synthetic_validations):
    pol = Policy(n_boot=50)
    a = calibrate(synthetic_validations, pol, diagnostics=True)
    b = calibrate(synthetic_validations, pol, diagnostics=True)
    assert a.to_json() == b.to_json()
    assert a.species["good"].diagnostics["bootstrap_recorder"]["n_resamples"] == 50
    assert calibrate(synthetic_validations, pol).species["good"].diagnostics is None


def test_missing_recorder_is_rejected(synthetic_validations):
    v = synthetic_validations.copy()
    v.loc[0, "recorder"] = None
    with pytest.raises(ValueError, match="recorder"):
        calibrate(v, diagnostics=True)


def test_deduplication_edge_cases():
    """No matching prediction: keep (no evidence). 3 clips, 2 matching segments: keep 2."""
    from ns_observations.io_csv import deduplicate

    base = dict(species="s", score_text="0.500", recorder="R", date="20230101", hour="01", mmss="0000", confidence=0.5, outcome=1)
    rows = [dict(base, filename=f"a{i}", clip_index=i, n_candidates=0) for i in range(2)]
    rows += [dict(base, score_text="0.600", filename=f"b{i}", clip_index=i, n_candidates=2) for i in range(3)]
    kept, dropped = deduplicate(pd.DataFrame(rows))
    assert sorted(kept.filename) == ["a0", "a1", "b0", "b1"] and dropped.filename.tolist() == ["b2"]

"""Checks of the labelling pipeline: data handling, decision rules, labels, and pinned results.

The pipeline is run fresh into a temporary folder (with fewer bootstrap resamples), so these tests
never pass by reading stale committed outputs. Pinned ("golden") values make any change in a
threshold, status or count fail loudly; update them only together with the decision log.

Run:  challenge1/.venv/bin/python -m pytest challenge1/tests -q
"""

import sys
from dataclasses import replace
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
import run_challenge1 as rc  # noqa: E402

ORIOLE, NIGHTJAR, PLOVER, FIREFINCH = "African Black-headed Oriole", "Abyssinian Nightjar", "Three-banded Plover", "Red-billed Firefinch"


@pytest.fixture(scope="module")
def data():
    cfg = rc.Config()
    pred, val_raw = rc.load(cfg)
    val_raw = rc.link_validations(pred, val_raw, cfg)
    val, dropped = rc.deduplicate(pred, val_raw, cfg=cfg)
    return pred, val_raw, val, dropped


@pytest.fixture(scope="module")
def run(tmp_path_factory):
    out = tmp_path_factory.mktemp("outputs")
    cfg = rc.Config(out_dir=out, n_boot=200, write_figures=False)
    summary = rc.main(cfg)
    return cfg, summary, pd.read_csv(out / "birdnet_predictions_with_observations.csv", dtype=str, keep_default_na=False), pd.read_csv(out / "species_thresholds.csv")


# ── data handling ────────────────────────────────────────────────────────────


def test_deduplication_drops_exactly_the_four_probable_duplicates(data):
    pred, val_raw, val, dropped = data
    assert len(val_raw) == 551 and len(val) == 547 and len(dropped) == 4
    assert set(dropped.commonName) == {PLOVER} and dropped.outcome.eq(1).all()
    assert "0.264_6_RBS64_20230629_060003.wav" in set(val.filename)  # the Plover's only error survives
    amb, _ = rc.deduplicate(pred, val_raw, reduce_ambiguous=True)
    assert len(amb) == 546


def test_linkage_counts(data):
    _, val_raw, val, _ = data
    assert val_raw.link.value_counts().to_dict() == {"unique": 472 + 8, "tied": 69, "none": 2}  # D-02: 8 = the 4 duplicate pairs
    assert val.link.value_counts().to_dict() == {"unique": 476, "tied": 69, "none": 2}


# ── decision rules on synthetic data ─────────────────────────────────────────


def test_evidence_gate_reasons():
    g = rc.evidence_gate
    assert g(0, 0, 5) == (False, "no_validations")
    assert g(10, 0, 5) == (False, "no_observed_errors")
    assert g(0, 10, 5) == (False, "no_observed_correct")
    assert g(100, 4, 5) == (False, "too_few_errors")
    assert g(4, 100, 5) == (False, "too_few_correct")
    assert g(5, 5, 5) == (True, None)


def test_accept_whole_range_branch_uses_exact_lowest_score():
    """True curve >= 99.5% everywhere in the validated range (but with enough errors to pass the
    gate): the threshold is the lowest validated score, not an extrapolation below it."""
    rng = np.random.default_rng(0)
    conf = np.round(rng.uniform(0.3, 0.99, 20000), 3)
    x = np.log(conf / (1 - conf))
    y = (rng.uniform(size=20000) < 1 / (1 + np.exp(-(6.15 + 1.0 * x)))).astype(int)
    pr = rc.run_procedure(conf, y, rc.Config())
    assert pr.n_incorrect >= 5 and pr.gate_passed
    assert pr.status == rc.ACCEPTED_WHOLE_RANGE
    assert pr.threshold == conf.min()


def test_not_reached_and_slope_not_positive():
    rng = np.random.default_rng(1)
    conf = rng.uniform(0.1, 0.6, 400)
    x = np.log(conf / (1 - conf))
    y = (rng.uniform(size=400) < 1 / (1 + np.exp(-(-1 + 0.5 * x)))).astype(int)
    assert rc.run_procedure(conf, y, rc.Config()).status == rc.NOT_REACHED
    y_rev = (rng.uniform(size=400) < 1 / (1 + np.exp(-(1 - 2 * x)))).astype(int)  # accuracy falls with score
    assert rc.run_procedure(conf, y_rev, rc.Config()).status == rc.SLOPE_NOT_POSITIVE


def test_constant_scores_do_not_produce_a_threshold():
    conf = np.full(40, 0.5)
    y = np.r_[np.ones(30), np.zeros(10)].astype(int)
    pr = rc.run_procedure(conf, y, rc.Config())
    assert pr.threshold is None


def test_species_without_validations_gets_a_status_not_a_crash(tmp_path, data):
    pred, *_ = data
    extra = pd.read_csv(rc.Config().pred_csv).head(3).assign(common_name="Imaginary Bird", species_code="imabir1")
    p = tmp_path / "pred.csv"
    pd.concat([pd.read_csv(rc.Config().pred_csv), extra]).to_csv(p, index=False)
    cfg = rc.Config(pred_csv=p, out_dir=tmp_path / "out", n_boot=20, write_figures=False, write_dashboard_json=False)
    s = rc.main(cfg)
    assert s["species"]["Imaginary Bird"]["status"] == rc.INSUFFICIENT
    assert s["species"]["Imaginary Bird"]["gate_reason"] == "no_validations"
    assert s["predictions"] == len(pred) + 3


def test_operative_threshold_rounds_up_without_bumping_exact_values():
    assert rc.operative(0.66663806) == 0.666639
    assert rc.operative(0.104) == 0.104
    assert rc.operative(0.1) == 0.1
    for c in np.random.default_rng(0).uniform(0.1, 1, 1000):
        assert c <= rc.operative(c) + 1e-12 and rc.operative(c) - c < 1e-6


def test_bootstrap_is_deterministic_and_replays_the_gate(data):
    pred, _, val, _ = data
    d = val[val.commonName == NIGHTJAR]
    conf_p = pred.confidence[pred.common_name == NIGHTJAR].to_numpy()
    cfg = rc.Config(n_boot=100)
    a, b = rc.bootstrap(d, conf_p, "recorder", cfg), rc.bootstrap(d, conf_p, "recorder", cfg)
    assert np.array_equal(a["counts"], b["counts"])
    # resamples that miss both flagged recorders keep < 5 errors and must fail the gate
    assert a["status_shares"].get(rc.INSUFFICIENT, 0) > 0
    assert np.all(a["counts"][~np.isfinite(a["thresholds"])] == 0)


def test_set_level_threshold_is_below_the_per_prediction_threshold(data):
    pred, _, val, _ = data
    d = val[val.commonName == NIGHTJAR]
    pr = rc.run_procedure(d.confidence.to_numpy(), d.outcome.to_numpy(), rc.Config())
    s = rc.set_level_threshold(pr.fit, pred.confidence[pred.common_name == NIGHTJAR].to_numpy(), pr.vmin, rc.Config())
    assert s < pr.threshold


# ── pinned results (update together with docs/challenge1_data_decisions.md) ──


def test_species_results_are_pinned(run):
    _, s, _, t = run
    sp = s["species"]
    assert sp[NIGHTJAR]["status"] == rc.ACCEPTED and sp[NIGHTJAR]["method"] == "ml"
    assert sp[NIGHTJAR]["threshold"] == pytest.approx(0.666639, abs=1e-6)
    assert sp[NIGHTJAR]["model_labelled"] == 3147
    assert sp[ORIOLE]["status"] == rc.INSUFFICIENT and sp[ORIOLE]["gate_reason"] == "no_observed_errors"
    assert sp[PLOVER]["status"] == rc.INSUFFICIENT and sp[PLOVER]["gate_reason"] == "too_few_errors"
    assert sp[FIREFINCH]["status"] == rc.NOT_REACHED
    assert {k: v["observations"] for k, v in sp.items()} == {ORIOLE: 132, NIGHTJAR: 3185, PLOVER: 137, FIREFINCH: 6}
    assert s["observations"] == 3460 and s["observations_by_source"] == {"model": 3097, "validated": 363}
    assert sp[NIGHTJAR]["review_flagged_recorders"] == ["RBS75", "RBS79"]
    row = t.set_index("species")
    # estimator comparison for the Plover (D-07): information only, the gate decides
    assert row.loc[PLOVER, "ml_threshold"] == pytest.approx(0.261073, abs=1e-6)
    assert row.loc[PLOVER, "firth_threshold"] == pytest.approx(0.848478, abs=1e-6)
    assert row.loc[PLOVER, "flic_threshold"] == pytest.approx(0.156245, abs=1e-6)


def test_export_keeps_source_and_labels_consistently(run):
    cfg, _, out, _ = run
    src = pd.read_csv(cfg.pred_csv, dtype=str, keep_default_na=False)
    assert out[src.columns].equals(src)
    conf = out.confidence.astype(float)
    thr = pd.to_numeric(out.species_threshold, errors="coerce")
    model = thr.notna() & (conf >= thr)
    # the model label is exactly the published rule
    assert ((out.model_observation != "") == model).all()
    # human verdicts override; everything else follows the model
    v = out.validation_outcome
    expected = (v == "correct") | ((v == "") & model)
    assert ((out.observation != "") == expected).all()
    assert (out.observation[out.observation != ""] == out.common_name[out.observation != ""]).all()
    assert set(out.observation_status) <= {rc.ROW_VALIDATED_CORRECT, rc.ROW_VALIDATED_INCORRECT, rc.ROW_MODEL, rc.ROW_BELOW, rc.ROW_NO_THRESHOLD}
    assert set(out.observation_source) <= {"validated", "model", ""}
    # p_correct only from an increasing, valid curve: empty for species that failed the gate
    assert (out.p_correct[out.common_name.isin([ORIOLE, PLOVER])] == "").all()


def test_reproducible_outputs(tmp_path):
    """Same inputs and seed give byte-identical outputs (no timestamps)."""
    a, b = tmp_path / "a", tmp_path / "b"
    for d in (a, b):
        rc.main(rc.Config(out_dir=d, n_boot=50, write_figures=False))
    for name in ("birdnet_predictions_with_observations.csv", "species_thresholds.csv", "run_summary.json", "dashboard_results.json"):
        assert (a / name).read_bytes() == (b / name).read_bytes(), name

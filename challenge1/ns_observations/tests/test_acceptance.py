"""End-to-end acceptance test: the CLI on the take-home exports must reproduce the numbers the
Tech handover (section 9) lists, and the research pipeline's published outputs, exactly."""

import json
from pathlib import Path

import pandas as pd
import pytest

from ns_observations.cli import main

from .conftest import PRED_CSV, VAL_CSV

RESEARCH_OUT = Path(__file__).resolve().parents[2] / "outputs"


@pytest.fixture(scope="module")
def run(tmp_path_factory):
    out = tmp_path_factory.mktemp("acceptance")
    main(["run", "--predictions", str(PRED_CSV), "--validations", str(VAL_CSV), "--out", str(out / "ts.json"),
          "--labels-out", str(out / "labels.csv"), "--takehome-out", str(out / "takehome.csv")])
    return out


def test_handover_numbers(run):
    ts = json.loads((run / "ts.json").read_text())
    sp = ts["species"]
    assert sp["Abyssinian Nightjar"]["status"] == "accepted" and sp["Abyssinian Nightjar"]["method"] == "ml"
    assert sp["Abyssinian Nightjar"]["threshold"] == 0.666639
    assert (sp["African Black-headed Oriole"]["status"], sp["African Black-headed Oriole"]["gate_reason"]) == ("insufficient_validation", "no_observed_errors")
    assert (sp["Three-banded Plover"]["status"], sp["Three-banded Plover"]["gate_reason"]) == ("insufficient_validation", "too_few_errors")
    assert sp["Red-billed Firefinch"]["status"] == "not_reached"
    assert [f["recorder"] for f in sp["Abyssinian Nightjar"]["review_flags"]] == ["RBS75", "RBS79"]
    assert ts["validation_snapshot"]["n_clips"] == 547

    labels = pd.read_csv(run / "labels.csv", keep_default_na=False)
    obs = labels.observation.astype(str) == "True"
    assert obs.sum() == 3460
    assert labels.observation_source[obs].value_counts().to_dict() == {"model": 3097, "validated": 363}
    assert labels.observation_status.value_counts().to_dict() == {
        "no_species_threshold": 18933, "below_threshold": 6985, "model_observation": 3097, "validated_correct": 363, "validated_incorrect": 113}
    assert (labels.review_flag != "").sum() == 2277
    assert ((labels.species == "Abyssinian Nightjar") & (labels.model_observation.astype(str) == "True")).sum() == 3147


@pytest.mark.skipif(not (RESEARCH_OUT / "birdnet_predictions_with_observations.csv").exists(), reason="research outputs not generated")
def test_identical_to_the_research_pipeline(run):
    """One core: the CLI's Q1-format file is byte-identical to the research pipeline's."""
    assert (run / "takehome.csv").read_bytes() == (RESEARCH_OUT / "birdnet_predictions_with_observations.csv").read_bytes()


def test_source_columns_untouched(run):
    src = pd.read_csv(PRED_CSV, dtype=str, keep_default_na=False)
    out = pd.read_csv(run / "takehome.csv", dtype=str, keep_default_na=False)
    assert out[src.columns].equals(src)


@pytest.mark.skipif(not (RESEARCH_OUT / "threshold_set.json").exists(), reason="research outputs not generated")
def test_threshold_set_identical_to_the_research_pipeline(tmp_path):
    """calibrate --diagnostics reproduces the research pipeline's threshold set byte for byte, and the
    plain run (no diagnostics) has the same id: the same decisions."""
    main(["calibrate", "--predictions", str(PRED_CSV), "--validations", str(VAL_CSV), "--out", str(tmp_path / "d.json"), "--diagnostics"])
    assert (tmp_path / "d.json").read_bytes() == (RESEARCH_OUT / "threshold_set.json").read_bytes()
    main(["calibrate", "--predictions", str(PRED_CSV), "--validations", str(VAL_CSV), "--out", str(tmp_path / "p.json")])
    assert json.loads((tmp_path / "p.json").read_text())["threshold_set_id"] == json.loads((tmp_path / "d.json").read_text())["threshold_set_id"]


def test_row_order_does_not_change_the_threshold_set():
    """The same validated clips in any order give a byte-identical threshold set (and id), diagnostics included."""
    from ns_observations import calibrate, io_csv

    preds = io_csv.read_predictions(PRED_CSV)
    val, _ = io_csv.load_validations(VAL_CSV, preds)
    kw = dict(species=list(preds.table.species.value_counts().index), scope=io_csv.takehome_scope(val), diagnostics=True)
    docs = {calibrate(val, **kw).to_json()} | {calibrate(val.sample(frac=1, random_state=r), **kw).to_json() for r in (1, 7)}
    assert len(docs) == 1

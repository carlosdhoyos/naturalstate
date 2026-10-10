"""Command line: ns-observations calibrate | label | run | validate.

Examples (take-home CSVs):
  ns-observations calibrate --predictions birdnet_predictions.csv --validations validation_results.csv \
      --out threshold_set.json --diagnostics
  ns-observations label --predictions birdnet_predictions.csv --validations validation_results.csv \
      --threshold-set threshold_set.json --out labels.csv --takehome-out birdnet_predictions_with_observations.csv
  ns-observations run ...            # calibrate then label, same arguments as both
  ns-observations validate --threshold-set threshold_set.json
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from . import __version__
from . import io_csv
from .artifact import ThresholdSet
from .calibrate import calibrate
from .label import label
from .policy import Policy


def _policy(a) -> Policy:
    d = Policy()
    return Policy(
        target=a.target if a.target is not None else d.target,
        min_each_outcome=a.min_each_outcome if a.min_each_outcome is not None else d.min_each_outcome,
        n_boot=a.n_boot if a.n_boot is not None else d.n_boot,
        seed=a.seed if a.seed is not None else d.seed,
    )


def cmd_calibrate(a) -> ThresholdSet:
    preds = io_csv.read_predictions(a.predictions)
    val, dropped = io_csv.load_validations(a.validations, preds)
    t = preds.table
    ts = calibrate(
        val, _policy(a),
        species=list(t.species.value_counts().index),  # every species with predictions gets a status
        species_codes=dict(zip(t.species, t.species_code)),
        diagnostics=a.diagnostics,
        prediction_scores={s: g.confidence.to_numpy() for s, g in t.groupby("species")},
        code_version=a.code_version,
    )
    ts.write(a.out)
    print(json.dumps({"threshold_set_id": ts.threshold_set_id, "out": str(a.out), "validations": len(val), "dropped_duplicates": len(dropped),
                      "species": {k: {"status": v.status, "gate_reason": v.gate_reason, "threshold": v.threshold} for k, v in sorted(ts.species.items())}}, indent=2))
    return ts


def cmd_label(a, ts: ThresholdSet | None = None):
    ts = ts or ThresholdSet.read(a.threshold_set)
    preds = io_csv.read_predictions(a.predictions)
    verdicts = None
    if a.validations:
        val, _ = io_csv.load_validations(a.validations, preds)
        verdicts = io_csv.verdicts_from_validations(val)
    labels = label(preds.table, ts, verdicts)
    if a.out:
        io_csv.write_labels(labels, a.out)
    if a.takehome_out:
        io_csv.write_takehome_output(preds, labels, a.takehome_out)
    summary = {
        "threshold_set_id": ts.threshold_set_id, "predictions": len(labels), "observations": int(labels.observation.sum()),
        "observations_by_source": labels.observation_source[labels.observation].value_counts().to_dict(),
        "observation_status_counts": labels.observation_status.value_counts().to_dict(),
        "conflicting_verdicts": labels.attrs.get("conflicting_verdicts", 0),
    }
    print(json.dumps(summary, indent=2))
    return labels


def cmd_validate(a) -> None:
    ts = ThresholdSet.read(a.threshold_set)  # raises if the schema check fails
    print(f"valid threshold set {ts.threshold_set_id} (schema {ts.schema_version}, {len(ts.species)} species)")


def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(prog="ns-observations", description="BirdNET predictions -> species thresholds -> observation labels.")
    ap.add_argument("--version", action="version", version=f"ns-observations {__version__}")
    sub = ap.add_subparsers(dest="command", required=True)

    def inputs(p, validations_required=True):
        p.add_argument("--predictions", type=Path, required=True, help="BirdNET predictions CSV")
        p.add_argument("--validations", type=Path, required=validations_required, help="validation results CSV")

    def policy_args(p):
        p.add_argument("--target", type=float, help="probability of correctness (default 0.99)")
        p.add_argument("--min-each-outcome", type=int, help="evidence gate k (default 5)")
        p.add_argument("--n-boot", type=int, help="bootstrap resamples for --diagnostics (default 2000)")
        p.add_argument("--seed", type=int)
        p.add_argument("--diagnostics", action="store_true", help="add recorder bootstrap and model-free checks")
        p.add_argument("--code-version", help="recorded in the artifact, e.g. a git sha")

    c = sub.add_parser("calibrate", help="job A: validations -> threshold set (JSON)")
    inputs(c)
    policy_args(c)
    c.add_argument("--out", type=Path, required=True, help="threshold set JSON to write")

    lb = sub.add_parser("label", help="job B: predictions + threshold set (+ verdicts) -> labels")
    inputs(lb, validations_required=False)
    lb.add_argument("--threshold-set", type=Path, required=True)
    lb.add_argument("--out", type=Path, help="platform-shaped labels CSV")
    lb.add_argument("--takehome-out", type=Path, help="Q1-format CSV: source columns + observation columns")

    r = sub.add_parser("run", help="calibrate then label")
    inputs(r)
    policy_args(r)
    r.add_argument("--out", type=Path, required=True, help="threshold set JSON to write")
    r.add_argument("--labels-out", type=Path, help="platform-shaped labels CSV")
    r.add_argument("--takehome-out", type=Path, help="Q1-format CSV")

    v = sub.add_parser("validate", help="check a threshold set against its JSON schema")
    v.add_argument("--threshold-set", type=Path, required=True)
    return ap


def main(argv: list[str] | None = None) -> int:
    a = build_parser().parse_args(argv)
    if a.command == "calibrate":
        cmd_calibrate(a)
    elif a.command == "label":
        cmd_label(a)
    elif a.command == "run":
        ts = cmd_calibrate(a)
        a.out, a.threshold_set = a.labels_out, None
        cmd_label(a, ts)
    elif a.command == "validate":
        cmd_validate(a)
    return 0


if __name__ == "__main__":
    sys.exit(main())

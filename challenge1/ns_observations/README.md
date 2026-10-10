# ns-observations

This package turns BirdNET predictions into **observations**. The method is Wood & Kahl (2024): a per-species logistic regression of the human verdict on the logit of the confidence, with a 99% cutoff. On top of that come the safeguards documented in the decision log ([`docs/challenge1_data_decisions.md`](../../docs/challenge1_data_decisions.md)): the evidence gate, no extrapolation outside the validated scores, human verdicts as labels, and recorder review flags.

This package is the **deployable** part of Challenge 1, the code to run on NS Analytics. The research analysis that motivated each decision lives in [`challenge1/src/`](../src/). That analysis imports this package, so the decision rules exist in one place only.

## Two jobs

| Job | Function | Input | Output |
|---|---|---|---|
| **A. Calibrate** | `calibrate(validations, policy) → ThresholdSet` | Validated clips: `species`, `confidence`, `outcome` (1 = BirdNET right), `recorder` | A versioned, deterministic JSON artifact (`schemas/threshold_set.schema.json`) |
| **B. Label** | `label(predictions, threshold_set, verdicts) → DataFrame` | Predictions: `prediction_id`, `species`, `confidence`, `recorder`; optional human verdicts | One row per prediction (`schemas/labels.schema.json`) |

**Job A**, per species:

1. **Evidence gate.** At least 5 correct **and** at least 5 incorrect validated clips. Otherwise the status is `insufficient_validation`.
2. **Fit.** Ordinary maximum-likelihood logistic regression; Firth's method only if the data are separated.
3. **Accept** the 99% point only if the fit is valid, the curve increases, and the point lies inside the validated score range.
4. **Round up.** The threshold is rounded up to 6 decimals.
5. **Review flags.** Flag recorders whose clips disagree with a curve fitted without them (leave-one-recorder-out, Poisson-binomial test, Bonferroni).

`--diagnostics` adds a recorder-level bootstrap and the model-free check.

**Job B never fits anything.** For each prediction:

1. A uniquely linked human verdict decides the label.
2. Otherwise the prediction is an observation when `confidence >= species_threshold`.
3. A species without a threshold gets no automatic observations.

## Install and run

```bash
pip install "challenge1/ns_observations[schema]"          # numpy, pandas, jsonschema; Python 3.13
ns-observations run \
  --predictions "Data Birds/birdnet_predictions.csv" --validations "Data Birds/validation_results.csv" \
  --out threshold_set.json --labels-out labels.csv --takehome-out birdnet_predictions_with_observations.csv
```

The commands, separately:

```bash
ns-observations calibrate --predictions P.csv --validations V.csv --out threshold_set.json [--diagnostics] [--code-version <git sha>]
ns-observations label     --predictions P.csv [--validations V.csv] --threshold-set threshold_set.json --out labels.csv
ns-observations validate  --threshold-set threshold_set.json
```

Policy overrides for calibration: `--target`, `--min-each-outcome`, `--n-boot` and `--seed`. A changed policy produces a new threshold set with a new id.

From Python:

```python
from ns_observations import Policy, calibrate, label
ts = calibrate(validations, Policy(), species=all_species, diagnostics=True)
ts.write("threshold_set.json")
labels = label(predictions, ts, verdicts)
```

**Docker** (Python 3.13 slim; runs as a non-root user):

```bash
docker build -t ns-observations:1.0.0 challenge1/ns_observations
docker run --rm -v "$PWD/Data Birds:/data" -v "$PWD/out:/out" ns-observations:1.0.0 \
  run --predictions /data/birdnet_predictions.csv --validations /data/validation_results.csv \
      --out /out/threshold_set.json --labels-out /out/labels.csv
```

## Layout

| Path | Content |
|---|---|
| `src/ns_observations/policy.py` | Policy values (owned by Biometrics), status codes, the rounding rule |
| `src/ns_observations/estimators.py` | Ordinary logistic regression (IRLS), Firth, FLIC, separation check, Wilson interval, Poisson-binomial tail, cluster resampling. numpy only |
| `src/ns_observations/calibrate.py` | Job A: gate, fit, accept, review flags, optional bootstrap |
| `src/ns_observations/label.py` | Job B: the label rule, vectorised |
| `src/ns_observations/artifact.py` | `ThresholdSet`: deterministic JSON, content-derived id, validation-snapshot hash, schema validation |
| `src/ns_observations/io_csv.py` | Adapter for the take-home exports. With no shared prediction id, it links clips by score and de-duplicates them (D-01, D-02) and writes the Q1-format file |
| `src/ns_observations/io_postgres.py` | **Stub** adapter for the tables in `sql/schema.sql`. It takes any DB-API connection, and its calls are checked with a fake connection, but it has **not been run against a live database** |
| `src/ns_observations/schemas/` | JSON Schemas for the threshold set and the label rows |
| `sql/schema.sql` | PostgreSQL DDL: predictions, validations, threshold sets, species thresholds, prediction labels |
| `tests/` | Unit tests, the PostgreSQL stub tests, and the end-to-end acceptance test |
| `Dockerfile` | The worker image |

## Guarantees, and the tests that hold them

- **Deterministic.** Identical inputs and policy give a byte-identical artifact and the same `threshold_set_id`, whatever the row order (`test_artifact.py`).
- **The artifact is validated** against its schema on write and on read. The schema also enforces consistency: a species without an accepted status cannot carry a threshold (`test_artifact.py`).
- **Labels follow the published rule exactly,** including at the threshold boundary. Human verdicts override; conflicting verdicts are not applied; tied clips only mark their rows (`test_label.py`).
- **Acceptance** (`test_acceptance.py`). On the take-home data the CLI reproduces the Tech handover's numbers:
  - 3,460 observations: 3,097 model + 363 validated
  - Nightjar threshold 0.666639, 3,147 predictions above it
  - the five status counts
  - review flags at RBS75 and RBS79

  Its Q1-format file is byte-identical to the research pipeline's.

Run the tests: `pip install "challenge1/ns_observations[test]" && pytest challenge1/ns_observations`

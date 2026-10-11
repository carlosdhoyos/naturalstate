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
docker run --rm --user "$(id -u):$(id -g)" -v "$PWD/Data Birds:/data" -v "$PWD/out:/out" ns-observations:1.0.0 \
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
| `src/ns_observations/io_postgres.py` | **Stub** adapter for the tables in `sql/schema.sql`. It takes any DB-API connection, and its calls are checked with a fake connection, but it has **not been run against a live database** (see Verification status) |
| `src/ns_observations/schemas/` | JSON Schemas for the threshold set and the label rows |
| `sql/schema.sql` | PostgreSQL DDL: predictions, validations, threshold sets, species thresholds, prediction labels |
| `tests/` | Unit tests, the PostgreSQL stub tests, and the end-to-end acceptance test |
| `Dockerfile` | The worker image (written; not yet built, see Verification status) |

## Verification status

| Part | Status | Evidence / how to check |
|---|---|---|
| Decision rules, label rule, threshold-set artifact, CLI | **Verified** | 50 package tests, including the end-to-end acceptance test on the take-home data. The CLI's labelled file is byte-identical to the research pipeline's, and so is its threshold set when run with `--diagnostics` (without it: same id and decisions) |
| Packaging (wheel, entry point, bundled schemas) | **Verified** | The wheel was built and installed into a fresh Python 3.13 environment outside the repo. `ns-observations run` gave byte-identical output there, with the same threshold-set id |
| Docker image | **Written, not built** | The Docker daemon was not running on the development machine. The image installs the same package with `pip install ".[schema]"`. To check: `docker build -t ns-observations:1.0.0 challenge1/ns_observations`, then the `docker run` command in the package README |
| PostgreSQL adapter (`io_postgres.py`, `sql/schema.sql`) | **Stub** | The SQL and functions match the handover's tables, including configuration scoping, the label upsert with an append-only history, and the immutability triggers. Their calls are checked with a fake connection, but neither the SQL nor the triggers have **ever run against a database**. Before production: apply `schema.sql` to a staging database and add integration tests |
| R cross-check snippet (section 9) | **Not run** | R is not installed on the development machine. The expected value, 0.6666381, was confirmed with statsmodels' binomial GLM, the same estimator as R's `glm` |

## Guarantees, and the tests that hold them

- **Deterministic.** Identical inputs and policy give a byte-identical artifact, whatever the row order. The `threshold_set_id` identifies the decisions: it does not change with diagnostics, bootstrap settings or publication (`test_artifact.py`).
- **The artifact is checked on write and on read:**
  - the schema, which also enforces consistency: a species without an accepted status cannot carry a threshold
  - the id against its content
  - every species result against what the procedure would produce from its stored curve, status and gate

  A hand-edited threshold is refused (`test_artifact.py`). This guards against accidental edits; database triggers make published sets immutable.
- **Scoped.** Each threshold set records its project and BirdNET configuration, which are part of its id.
- **Inputs are validated.** `label()` rejects confidence outside [0, 1], non-finite scores, verdict outcomes other than 0/1/True/False, and ids that collide as text (`test_label.py`).
- **Labels follow the published rule exactly,** including at the threshold boundary. Human verdicts override; conflicting verdicts are not applied; tied clips only mark their rows (`test_label.py`).
- **Acceptance** (`test_acceptance.py`). On the take-home data the CLI reproduces the Tech handover's numbers:
  - 3,460 observations: 3,097 model + 363 validated
  - Nightjar threshold 0.666639, 3,147 predictions above it
  - the five status counts
  - review flags at RBS75 and RBS79

  Its Q1-format file is byte-identical to the research pipeline's, and `calibrate --diagnostics` reproduces the research pipeline's threshold set byte for byte.

Run the tests: `pip install "challenge1/ns_observations[test]" && pytest challenge1/ns_observations`

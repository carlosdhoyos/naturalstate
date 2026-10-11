# Challenge 1: species thresholds and observation labels

This folder contains a reproducible workflow. It does three things:

- fits a Wood & Kahl (2024) probability-of-correctness curve for each species
- applies a 99% cutoff to all 29,491 BirdNET predictions
- writes an `observation` label for each prediction

**The two answers to the brief:**

- **[Q1_report.md](Q1_report.md):** the labels, how they were derived, the decisions, the limitations, the confirmation items for Natural State (C-1 to C-7), and a discussion and conclusions section (section 10): whether we followed Wood & Kahl, and how the other papers were used.
- **[Q2_tech_handover.md](Q2_tech_handover.md):** what the Tech team needs to run this automatically on NS Analytics.

**Two code bases, one core:**

- **[`ns_observations/`](ns_observations/README.md)** is the **deployable package**.
  - Commands: `ns-observations calibrate` (validations → versioned threshold set) and `ns-observations label` (predictions → labels).
  - It comes with JSON schemas, a CSV adapter, a PostgreSQL adapter stub, a Dockerfile and 24 tests.
- **[`src/`](src/)** is the **research analysis.** Every decision was made and checked here: sensitivity, the bootstrap, the covariate tests, figures, the dashboard data.
  - It imports the package's decision rules, linking and label rule, so the two cannot drift apart.
  - Its labelled file and threshold set are byte-identical to the package CLI's (tested).

**Verification status.** The package logic, CLI and wheel were run and tested here. Three parts were not:
- **The Docker image** is written but not built: the Docker daemon was not running.
- **The PostgreSQL adapter** is a stub, checked with a fake connection, never against a database.
- **The R cross-check snippet** has not been run: R is not installed. Its value was confirmed with the equivalent Python fit.

Details and how to check each one: [Q2, section 9](Q2_tech_handover.md#what-has-and-has-not-been-run).

Related documents:

- [docs/challenge1_data_decisions.md](../docs/challenge1_data_decisions.md): every decision (D-01 to D-14), with what was measured.
- [docs/challenge1_paper_alignment.md](../docs/challenge1_paper_alignment.md): how the analysis follows the paper and where it extends it.
- The dashboard page **Birds → Thresholds & observations** shows all results interactively.

## Run

```bash
python3.13 -m venv challenge1/.venv
challenge1/.venv/bin/pip install -r challenge1/requirements-lock.txt      # or requirements.txt for direct dependencies only
challenge1/.venv/bin/pip install -e "challenge1/ns_observations[test]"   # the deployable package (the research script also finds it without installing)
challenge1/.venv/bin/python challenge1/src/run_challenge1.py               # about 5 s; writes challenge1/outputs/
challenge1/.venv/bin/python -m pytest challenge1/tests -q                  # 37 research tests
challenge1/.venv/bin/python -m pytest challenge1/ns_observations -q        # 24 package tests (incl. end-to-end acceptance)
```

Options: `--out DIR`, `--n-boot N`, `--seed S`, `--min-each-outcome K` (the evidence gate) and `--no-figures`. The same inputs and seed always produce byte-identical outputs. The summary contains no timestamp; it records input checksums and package versions instead.

## How a prediction becomes an observation

1. **Link and de-duplicate.** Each validated clip is matched to its prediction by species, recorder, date, hour and score, to within the 3-decimal rounding of the validation file name (D-02). Four Plover clips that duplicate another validation are dropped (D-01).
2. **Evidence gate.** A species needs at least 5 correct **and** at least 5 incorrect validated clips. Otherwise its status is `insufficient_validation` and it gets no threshold (D-09).
3. **Fit.** Logistic regression of the verdict on logit(confidence), by ordinary maximum likelihood, exactly the paper's `glm`. Firth is used only if the data are separated.
4. **Accept** the 99% point only if the fit is valid, the curve increases with the score, and the point lies inside the validated score range (D-05).
5. **Label.** If a validated clip links to exactly one prediction, the human verdict is the label. Otherwise the prediction is an observation when `confidence >= species_threshold` (D-10).
6. **Flag for review.** Each species' predictions at recorders whose validated clips disagree with the curve fitted without them (D-11). A flag never changes a label.
7. **Test transferability.** Covariate models (evening, week, recorder random intercept) compared by AIC, as Wood & Kahl recommend (D-13). This is diagnostic; the labels keep the pooled curve.

## Results

| Species | Status | Threshold | Above threshold | Human-confirmed | Observations |
|---|---|---:|---:|---:|---:|
| Abyssinian Nightjar | accepted (ordinary ML) | 0.666639 | 3,147 of 10,187 | 88 | 3,185 |
| African Black-headed Oriole | insufficient validation: no observed errors (150/150 correct) | — | 0 of 18,054 | 132 | 132 |
| Three-banded Plover | insufficient validation: too few errors (145/146 correct) | — | 0 of 1,015 | 137 | 137 |
| Red-billed Firefinch | 99% not reached within the validated range (6/101 correct) | — | 0 of 235 | 6 | 6 |
| **Total** | | | **3,147** | **363** | **3,460 of 29,491** |

**Nightjar uncertainty.** The recorder-level bootstrap gives a threshold in 93% of resamples, with a 95% interval of 0.471–0.835. The labelled count ranges from 0 to 4,109, median 3,123. The resamples without a threshold are exactly those that leave out RBS75 and RBS79, which hold 29 of the 33 errors.

**Nightjar model-free check.** All 74 validated clips at or above the threshold are correct, with a Wilson 95% lower bound of 95.1%. The 99% comes from the logistic shape.

**Review flags.** The flagged recorders are RBS75 and RBS79, for the Nightjar only. They cover 2,277 predictions; 9 of them are above the threshold.

**Plover estimators.** Information only, because the Plover fails the gate. The three estimators give 0.261 (ordinary ML), 0.848 (Firth) and 0.156 (FLIC). That spread is why the gate exists.

## Files

| Path | Content |
|---|---|
| `src/thresholds.py` | A compatibility shim that re-exports the estimators from `ns_observations.estimators`: ordinary logistic regression (IRLS), Firth and FLIC, the separation check, the threshold, the delta-method interval, the cluster resampler, Wilson intervals and the exact Poisson-binomial tail |
| `src/run_challenge1.py` | The workflow, organised into the numbered steps in its docstring. All policy values are in `Config` |
| `src/covariates.py` | Covariate models: ordinary logistic regression with several predictors, and a random-intercept logistic regression fitted by adaptive Gauss–Hermite quadrature; gives the 99% crossing for a typical recorder and for a new one |
| `tests/` | Estimators checked against statsmodels, an analytic Firth result and direct numerical optimisation. The pipeline is run fresh into a temporary folder. Results are pinned, the edge cases covered are a species without validations, constant scores and the whole-range branch, and outputs are checked to be reproducible |
| `requirements.txt` / `requirements-lock.txt` | Direct dependencies / the full frozen environment |
| `outputs/birdnet_predictions_with_observations.csv` | The 13 source columns (byte-identical) plus the added columns below |
| `outputs/species_thresholds.csv` | One row per species: gate, fit, status, threshold, counts, intervals, model-free checks, comparison estimators |
| `outputs/estimator_comparison.csv` | Ordinary ML, Firth and FLIC for every species |
| `outputs/sensitivity.csv` | The whole procedure re-run under 14 variants: logit endpoint, duplicates, gate size, estimator, flagged recorders |
| `outputs/recorder_checks.csv` | The per-recorder leave-one-out test behind the review flags |
| `outputs/covariate_models.csv` | AIC comparison of the covariate models, per species that passes the gate |
| `outputs/calibration_by_band.csv` | Observed share correct (Wilson) and mean fitted probability, by score band |
| `outputs/sampling_by_band.csv` | Validation design: share of validated clips vs share of predictions, by score band |
| `outputs/validation_links.csv` | Each validated clip and the prediction row(s) it links to |
| `outputs/dropped_duplicate_validations.csv` | The 4 clips removed by D-01 |
| `outputs/figures/curve_*.png` | One figure per species: clips, curves (solid inside the validated range, dotted outside), threshold and interval |
| `outputs/threshold_set.json` | The versioned threshold-set artifact (with diagnostics) that the platform would publish; identical to `ns-observations calibrate --diagnostics` |
| `outputs/run_summary.json` | Settings, package versions, input checksums, totals and the threshold-set id |
| `outputs/dashboard_results.json` | Everything the dashboard page shows, embedded at build time |

### Added columns

| Column | Values | Meaning |
|---|---|---|
| `observation` | species name or empty | **The answer to Q1.** The species if this prediction is an observation |
| `observation_source` | `validated`, `model` or empty | Where the decision came from: a human verdict, or the threshold |
| `observation_status` | `validated_correct`, `validated_incorrect`, `model_observation`, `below_threshold`, `no_species_threshold` | Why the row has that label |
| `model_observation` | species name or empty | Threshold-only label, ignoring human verdicts |
| `p_correct` | 0–1 or empty | Fitted probability that the prediction is correct. Empty when the species' curve is not identified or not increasing |
| `species_threshold` | e.g. `0.666639`, or empty | The operative threshold, rounded **up** to 6 decimals. `confidence >= species_threshold` reproduces the model labels exactly |
| `species_status` | `accepted`, `insufficient_validation`, `not_reached`, … | The species-level status code |
| `threshold_method` | `ml`, `firth` or empty | The estimator behind the threshold |
| `validation_outcome` | `correct`, `incorrect` or empty | The human verdict, for predictions with a uniquely linked validated clip |
| `validation_link` | `unique`, `tied` or empty | Whether a validated clip links to this prediction alone, or ties with others of the same rounded score |
| `review_flag` | `recorder_inconsistent_with_pooled_curve` or empty | This species at this recorder disagrees with the pooled curve (D-11) |

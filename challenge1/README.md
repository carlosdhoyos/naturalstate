# Challenge 1: species thresholds and observation labels

This folder contains a reproducible workflow. It does three things:

- fits a Wood & Kahl (2024) probability-of-correctness curve for each species
- applies a 99% cutoff to all 29,491 BirdNET predictions
- writes an `observation` label for each prediction

The decisions behind each step are logged in [docs/challenge1_data_decisions.md](../docs/challenge1_data_decisions.md): D-01 to D-04 for the data, D-05 to D-08 for the modelling.

## Run

```bash
python3.13 -m venv challenge1/.venv
challenge1/.venv/bin/pip install -r challenge1/requirements.txt
challenge1/.venv/bin/python challenge1/src/run_challenge1.py     # about 10 s
challenge1/.venv/bin/python -m pytest challenge1/tests -q        # 12 tests
```

## Baseline results (policy a)

| Species | Primary fit | Status | Threshold | Model-supported observations |
|---|---|---|---:|---:|
| Abyssinian Nightjar | ordinary ML | accepted | 0.6666 | 3,147 of 10,187 |
| Three-banded Plover | Firth | accepted, provisional | 0.8485 | 100 of 1,015 |
| African Black-headed Oriole | Firth | no supported threshold (no observed errors; slope not identified) | — | 0 of 18,054 |
| Red-billed Firefinch | Firth | 99% not reached within the validated range | — | 0 of 235 |

- **Policy (a)** labels 3,247 predictions in total.
- **Policy (b)** is the conservative alternative: no automatic observations for species fitted with Firth, until more representative validation is available. It labels 3,147, all Nightjar.
- The uncertainty, the comparison between methods and the sensitivity analyses are in D-05 to D-08.

## Files

| Path | Content |
|---|---|
| `src/thresholds.py` | Estimators: ordinary logistic regression (IRLS), Firth's penalised regression, separation check, threshold, delta-method interval, cluster bootstrap |
| `src/run_challenge1.py` | The workflow: load, de-duplicate (D-01), fit, accept, label, sensitivity, figures |
| `tests/` | Estimators checked against statsmodels, an analytic Firth result and direct numerical optimisation; checks on the pipeline and the export |
| `outputs/birdnet_predictions_with_observations.csv` | The 13 source columns, byte-identical, plus the columns below |
| `outputs/species_thresholds.csv` | One row per species: both fits, status, threshold, counts, intervals |
| `outputs/sensitivity.csv` | Logit endpoint, duplicate handling and the ambiguous Plover pair |
| `outputs/calibration_by_band.csv` | Observed share correct and mean fitted probability, by score band |
| `outputs/dropped_duplicate_validations.csv` | The 4 validation clips removed by D-01 |
| `outputs/figures/curve_*.png` | Fitted curves, validated clips, threshold and its interval, one figure per species |
| `outputs/run_summary.json` | Settings, package versions, input checksums and totals |

### Added columns

| Column | Meaning |
|---|---|
| `observation` | Species name if the prediction is a model-supported observation under policy (a), otherwise empty |
| `observation_status` | `model-supported observation`, `below species threshold`, or `no supported threshold for species: <reason>`. The reason is `fitted slope not positive` (Oriole) or `not reached within validated range` (Firefinch) |
| `p_correct` | Fitted probability that the prediction is correct, from the species' primary fit. It is empty when that fit is invalid or not increasing, which is the case for the Oriole (D-06) |
| `species_threshold` | The operative confidence threshold, rounded **up** to 6 decimals. A prediction is labelled exactly when `confidence >= species_threshold`. Empty when the species has no supported threshold |
| `threshold_method` | `firth` or `ml`: the species' primary fit |
| `observation_policy_b` | Same as `observation`, under conservative policy (b) |
| `review_flag` | Nightjar predictions at RBS75 and RBS79, the two recorders whose validated Nightjar clips were all wrong (D-04). The flag does not change the label |

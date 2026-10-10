# Challenge 1, Q2: automating observations on NS Analytics (Tech handover)

**For:** the Tech team (Python / SQL) and Biometrics (R), who own the policy values.
**Scope:** everything after BirdNET predictions are stored. The SD-card-to-BirdNET pipeline is assumed to work.
**Reference implementation:**
- [`src/run_challenge1.py`](src/run_challenge1.py): procedure, labels, reports
- [`src/thresholds.py`](src/thresholds.py) and [`src/covariates.py`](src/covariates.py): estimators
- [`tests/`](tests/): 37 tests
- The method and its decisions: [Q1 report](Q1_report.md) and [decision log](../docs/challenge1_data_decisions.md).

---

## 1. What the platform has to do, in one paragraph

**Per species, per deployment context:** fit a logistic regression of the ornithologist's verdict on the logit of the BirdNET confidence. A species gets a **threshold** only when its validation data contain at least 5 correct and at least 5 incorrect clips, the fit is valid and increasing, and the score where the fitted probability reaches 0.99 lies inside the range of validated scores.

**Then label every prediction, in this order:**
1. If an ornithologist validated it, their verdict decides.
2. Otherwise it is an **observation** when `confidence >= species_threshold`.
3. Species without a threshold get no automatic observations.

**Flag for review** the predictions from recorders whose validated clips disagree with the curve. Never silently drop or relabel them.

## 2. Two jobs, two triggers

| Job | Trigger | Work | Cost |
|---|---|---|---|
| **A. Calibrate** | New validations are committed for a project, or a re-validation trigger fires (section 7) | Re-run the procedure per species → a new, immutable **threshold set** with diagnostics | Seconds per species. The bootstrap (2,000 resamples) dominates; run it async |
| **B. Label** | New predictions arrive, or a new threshold set is published | Apply the current threshold set and the human verdicts to predictions | A vectorised comparison; trivial |

Job B must never fit anything. It only reads the published threshold set, so labels are cheap, deterministic and traceable to a version.

## 3. Data model (PostgreSQL sketch)

```sql
-- existing: one row per BirdNET detection. Needs a stable id that survives re-exports (section 8).
predictions (
  prediction_id     uuid primary key,
  project_id        uuid not null,
  deployment_id     uuid not null,            -- recorder deployment (ODK metadata)
  recorder_id       text not null,
  audio_file_id     uuid not null,            -- with the TRUE file start time
  begin_time_s      numeric not null,         -- offset within the audio file, not within the hour
  species_code      text not null,
  confidence        numeric(5,4) not null,
  birdnet_run_id    uuid not null              -- model version, sensitivity, min score, locale
);

-- one row per ornithologist verdict, linked by id, never by file name
validations (
  validation_id     uuid primary key,
  prediction_id     uuid not null references predictions,
  outcome           boolean not null,           -- true = BirdNET was right
  validator_id      text,
  validated_at      timestamptz not null,
  sampling_stratum  text not null,              -- e.g. 'random:0.3-0.5', 'recorder_acceptance'
  unique (prediction_id, validator_id)          -- the same clip cannot be counted twice (cf. D-01)
);

-- immutable output of job A
threshold_sets (
  threshold_set_id  uuid primary key,
  project_id        uuid not null,
  created_at        timestamptz not null,
  code_version      text not null,              -- git sha of the procedure
  config            jsonb not null,             -- policy values used (section 5)
  validation_hash   text not null,              -- hash of the validation snapshot used
  status            text not null check (status in ('draft','published','retired')),
  approved_by       text                         -- Biometrics sign-off before publishing
);

species_thresholds (
  threshold_set_id  uuid references threshold_sets,
  species_code      text,
  status            text not null,              -- enum, section 4
  gate_reason       text,                       -- enum, section 4
  method            text,                       -- 'ml' | 'firth' | null
  beta0             double precision,
  beta1             double precision,
  threshold         numeric(7,6),               -- operative value, rounded UP to 6 dp; null if none
  validated_min     numeric, validated_max numeric,
  n_correct         int, n_incorrect int,
  diagnostics       jsonb,                      -- bootstrap, model-free checks, comparison estimators
  primary key (threshold_set_id, species_code)
);

-- output of job B (or a view): one row per prediction per published threshold set
prediction_labels (
  prediction_id      uuid references predictions,
  threshold_set_id   uuid references threshold_sets,
  observation        boolean not null,
  observation_source text,                      -- 'validated' | 'model' | null
  observation_status text not null,             -- enum, section 4
  p_correct          double precision,          -- null when the curve is not identified
  review_flag        text,
  primary key (prediction_id, threshold_set_id)
);

review_flags (threshold_set_id uuid, species_code text, recorder_id text, p_value double precision,
              expected_correct double precision, observed_correct int, validated_clips int);
```

Keep `prediction_labels` per threshold set, or keep history another way, so a dashboard figure can always be traced to the threshold set and validation snapshot behind it.

## 4. The procedure, exactly (job A)

For each project and species, take the validated clips (one row per `prediction_id`), with `x = ln(c / (1 − c))` and `c` clamped to [10⁻⁴, 1 − 10⁻⁴]. Then:

1. **Evidence gate.** Let n₁ be the number of correct clips and n₀ the number of incorrect ones.
   - If n₁ + n₀ = 0: `insufficient_validation`, reason `no_validations`.
   - Else if n₀ = 0: `insufficient_validation`, reason `no_observed_errors`.
   - Else if n₁ = 0: `insufficient_validation`, reason `no_observed_correct`.
   - Else if n₀ < k: `insufficient_validation`, reason `too_few_errors`.
   - Else if n₁ < k: `insufficient_validation`, reason `too_few_correct`.
   - Stop here for any of these.
2. **Fit.** Ordinary maximum-likelihood logistic regression, `outcome ~ x` (IRLS; equals R `glm(binomial)` and statsmodels `GLM(Binomial)`).
   - If the data are separated (one score cut divides correct from incorrect, ties allowed), ML has no finite estimate. Use Firth's penalised regression instead, and set `method = 'firth'`.
3. **Accept.**
   - Invalid fit (not converged, or non-finite coefficients or covariance) → `no_valid_fit`.
   - β₁ ≤ 0 → `slope_not_positive`.
   - Otherwise t = (ln(0.99/0.01) − β₀) / β₁:
     - t > max validated x → `not_reached`
     - t < min validated x → `accepted_whole_range`, with the threshold = the lowest validated confidence
     - otherwise → `accepted`, with the threshold = sigmoid(t)
4. **Round up.** `threshold = ceil(threshold × 10⁶ − 10⁻⁶) / 10⁶`. Store this value; labels use exactly it.
5. **Review flags.** For accepted species: for each recorder with ≥ 5 validated clips, refit step 2 without that recorder. Compute p = P(X ≤ observed correct), where X is Poisson-binomial with the refit probabilities of that recorder's clips. Flag if p < 0.05 / (number of recorders tested).
6. **Diagnostics,** stored in `diagnostics` and shown to Biometrics before publishing:
   - **Bootstrap:** resample whole recorders 2,000 times (fixed seed) and re-run steps 1–4 in each resample, gate included. Store the share of resamples with a threshold, the 2.5–97.5% range of the threshold among those resamples, and the 2.5/50/97.5% points of the labelled count (a resample without a threshold counts 0).
   - **Model-free check:** validated clips at or above the threshold, how many were correct, and the Wilson 95% lower bound on that share.
   - **Comparison estimators:** ML, Firth and FLIC thresholds.
   - **Calibration by score band.**
   - **Covariate models compared by AIC:** evening, week, and a recorder random intercept (`covariates.py`). Diagnostic only.

**Labels (job B), per prediction:**

```python
def label(pred, species_threshold, human_verdict):          # human_verdict: True / False / None
    above = species_threshold is not None and pred.confidence >= species_threshold
    if human_verdict is True:   return Observation(True,  source="validated", status="validated_correct")
    if human_verdict is False:  return Observation(False, source="validated", status="validated_incorrect")
    if above:                   return Observation(True,  source="model",     status="model_observation")
    if species_threshold is not None:
                                return Observation(False, source=None,        status="below_threshold")
    return                             Observation(False, source=None,        status="no_species_threshold")
```

`p_correct = sigmoid(β₀ + β₁ x)` is filled only when the species fit is valid and β₁ > 0.

**Status codes (enums; use them as keys, with display text kept separately):**

| Level | Code | Meaning |
|---|---|---|
| species | `accepted` | 99% reached inside the validated range |
| species | `accepted_whole_range` | ≥ 99% already at the lowest validated score; threshold = that score |
| species | `not_reached` | 99% only above the highest validated score |
| species | `slope_not_positive` | Fitted curve does not increase with score (treat as "relationship not identified") |
| species | `no_valid_fit` | Fit failed |
| species | `insufficient_validation` | Gate not passed; see `gate_reason` |
| row | `validated_correct` / `validated_incorrect` | Human verdict |
| row | `model_observation` / `below_threshold` | Threshold decision |
| row | `no_species_threshold` | Species has no supported threshold |

## 5. Policy values (owned by Biometrics; stored in `threshold_sets.config`)

| Key | Value | Meaning |
|---|---|---|
| `target` | 0.99 | Per-prediction probability of correctness |
| `min_each_outcome` | 5 | Evidence gate k |
| `eps` | 1e-4 | Logit clamp for scores of 0 or 1 |
| `threshold_decimals` | 6 | Rounding (always up) |
| `n_boot`, `seed` | 2000, 20261010 | Bootstrap |
| `review_min_clips`, `review_alpha` | 5, 0.05 | Recorder review flags (Bonferroni) |

Changing any of these creates a new threshold set. Nothing is edited in place.

## 6. Implementation notes

- **Reuse, don't rewrite.** The estimator module has no web or database dependencies: it uses numpy only, and scipy for the covariate models. It can be wrapped as a worker task (e.g. a Redis queue consumer) that reads validations from PostgreSQL and writes a draft threshold set.
- **Numerics.**
  - ML is standard IRLS.
  - Firth accepts only steps that strictly increase the penalised likelihood, damps overshooting steps, and declares convergence on the modified score (|U*| < 10⁻⁸). That avoids false convergence on small or separated data.
  - These are tested against statsmodels, an analytic result and direct optimisation.
- **Determinism.** Same validations + config + code version ⇒ byte-identical outputs. The summary carries input checksums, not timestamps, and the bootstrap seed is fixed.
- **Per deployment context.** Calibrate per project, which in practice means per hardware and BirdNET configuration. Pool across projects only after Biometrics has shown that their curves agree; the covariate test in `covariates.py` is the tool for that.
- **Do not interpret the absence of an observation as an absence of the species.** Observations are high-precision and low-recall. Dashboards should say so.

## 7. When to re-validate (automatic triggers for job A)

| Trigger | Action |
|---|---|
| **New recorder** in a project | **Recorder acceptance check:** before its predictions can be model-labelled, validate a random sample (suggested: 10 per species with predictions, spread across score bands). Run the review-flag test on it. This is what would have caught RBS75/RBS79 |
| New season, site or ecosystem | Validate a fresh stratified sample; Wood & Kahl: thresholds hold only for "the range of conditions encompassed by data from which they were drawn" |
| New recorder hardware, sample rate or BirdNET version/settings | Treat as a new context: scores are not comparable |
| A species is `insufficient_validation` or `not_reached` | Queue validation requests for it (sampling below) |
| A recorder is flagged | Queue a validation sample of its **high-scoring** predictions for that species |

**Validation sampling (requests sent to ornithologists):**
- **Draw random predictions within score bands** (e.g. 0.1–0.2, 0.2–0.3, 0.3–0.5, 0.5–0.7, 0.7–0.9, 0.9–1.0), **without replacement**, across recorders. Record the stratum.
- **Top up high-score bands** when most predictions score low, as Wood & Kahl recommend.
- **Never target likely errors.** That would bias the curve.
- **Stopping rule for zero-error species:** keep sampling until either errors appear (the gate can pass) or enough correct clips accumulate. 381 correct in a row gives a model-free 99% Wilson lower bound.

## 8. Upstream data-contract fixes (found while doing this)

1. **A stable `prediction_id`, carried into the validation export.** Today validated clips are linked by species + recorder + hour + a 3-decimal score. That leaves 69 tied clips and 2 unmatched ones, and it allowed the same segment to be validated twice (D-01, D-02).
2. **The true audio-file start time.** The predictions export renames files to HH:00:00 and counts `begin_time_s` from the hour, while the validation names keep the true start second.
3. **Sample validation clips without replacement,** and enforce `unique (prediction_id, validator_id)`.
4. **Recorder clock and time zone at deployment** (ODK). Activity patterns suggest two recorders ran on UTC (D-03).
5. **BirdNET run metadata per prediction:** model version, sensitivity, minimum score, locale and species list.
6. **Scores at full precision in the validation file** (currently 3 decimals in the file name).

### Confirmation items that affect the implementation

These are listed in full, with the working assumptions, in [Q1 report, section 9](Q1_report.md#9-confirmation-items-for-natural-state). Four of them shape what the platform has to store or check:

- **C-1, validation sampling.** Store the sampling stratum per validation (`validations.sampling_stratum`), and keep sampling random within score bands.
- **C-2, BirdNET settings.** Store the run settings per prediction (`birdnet_run_id`), and calibrate separately per configuration.
- **C-3, recorder clocks.** Store the clock and time zone at deployment, before any time-of-day analysis.
- **C-6, linkage.** A stable `prediction_id` makes the score-based linkage, and its 69 ties, unnecessary.

## 9. Acceptance tests for the platform implementation

Run the platform job on this take-home dataset. It must reproduce:

| Check | Expected |
|---|---|
| Validated clips after de-duplication | 547 (551 − 4 duplicates), until stable ids make de-duplication unnecessary |
| Nightjar | `accepted`, `ml`, threshold **0.666639**, 3,147 predictions ≥ threshold |
| Oriole | `insufficient_validation` / `no_observed_errors` |
| Plover | `insufficient_validation` / `too_few_errors` |
| Firefinch | `not_reached` |
| Observations | **3,460** = 3,097 model + 363 validated |
| Row statuses | validated_correct 363, validated_incorrect 113, model_observation 3,097, below_threshold 6,985, no_species_threshold 18,933 |
| Review flags | Nightjar at RBS75 and RBS79 (2,277 rows) |

Unit-level checks to port, from `tests/`:
- ML against statsmodels
- Firth against the Haldane-corrected odds ratio and against direct maximisation
- separation detection, including the quasi-separated case
- the gate reasons
- the whole-range branch
- rounding up
- a species without validations produces a status, not a crash
- a reproducible run

**Cross-check for Biometrics (R).** These lines should reproduce the Nightjar threshold:

```r
v <- subset(read.csv("Data Birds/validation_results.csv"), commonName == "Abyssinian Nightjar")
x <- qlogis(pmin(pmax(v$confidence, 1e-4), 1 - 1e-4))
m <- glm(v$outcome ~ x, family = binomial)
plogis((qlogis(0.99) - coef(m)[1]) / coef(m)[2])        # 0.6666381 (statsmodels, same estimator); stored rounded up: 0.666639
```

## 10. Optional downstream uses (not part of labelling)

- **Site-level presence** (Wood & Kahl): require observations on two or more days before marking a species present at a site.
- **Occupancy with false positives:** use `p_correct` per detection (Clare et al. 2021). Only species with an identified curve have it.
- **Review queues:** flagged recorders, `no_species_threshold` species with high scores, and the top-scoring Firefinch predictions are natural targets for ornithologist time.

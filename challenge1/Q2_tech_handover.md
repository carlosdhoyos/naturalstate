# Challenge 1, Q2: automating observations on NS Analytics (Tech handover)

**For:** the Tech team (Python / SQL) and Biometrics (R), who own the policy values.
**Scope:** everything after BirdNET predictions are stored. The SD-card-to-BirdNET pipeline is assumed to work.
**What to deploy: [`ns_observations/`](ns_observations/README.md),** an installable Python 3.13 package with a Dockerfile.
- `ns-observations calibrate` (job A) and `ns-observations label` (job B), as a CLI and a Python API.
- A versioned threshold-set artifact, with JSON schemas.
- A CSV adapter, plus a PostgreSQL adapter stub matching section 3.
- 50 tests, including an end-to-end acceptance test.

**Where the decisions were made:**
- [`src/run_challenge1.py`](src/run_challenge1.py): the research analysis. It covers sensitivity, the bootstrap, the covariate tests and the figures, and imports the package's decision rules, so the two cannot drift apart.
- [Q1 report](Q1_report.md) and [decision log](../docs/challenge1_data_decisions.md).

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
| **B. Label** | New predictions arrive, a new threshold set is published, **or human verdicts change** (a new validation can confirm or reject a prediction that already has a label) | Apply the current threshold set and the human verdicts to predictions | A vectorised comparison; trivial |

Job B must never fit anything. It only reads the published threshold set, so labels are cheap, deterministic and traceable to a version.

## 3. Data model (PostgreSQL sketch)

The DDL below is [`ns_observations/sql/schema.sql`](ns_observations/sql/schema.sql), verbatim: the same tables, constraints and "one published threshold set per project" index that `io_postgres.py` reads and writes. The adapter is a stub, tested with a fake connection and not against a live database.

```sql
-- PostgreSQL 15+ schema for ns-observations, read and written by io_postgres.py (the Tech handover,
-- section 3, shows the same tables). Existing platform tables are shown with the columns this package uses.
-- Status: written for the platform; NOT yet applied to a live database (see the verification table).

-- BirdNET runs and their configuration: scores are only comparable within one configuration (C-2),
-- so every read and every threshold set is scoped to one config_id.
CREATE TABLE IF NOT EXISTS birdnet_runs (
  birdnet_run_id  uuid PRIMARY KEY,
  config_id       text NOT NULL,          -- e.g. 'BirdNET v2.4 | sensitivity 1.0 | min 0.1 | hardware X'
  model_version   text NOT NULL,
  sensitivity     numeric,
  min_score       numeric
);

CREATE TABLE IF NOT EXISTS predictions (
  prediction_id   uuid PRIMARY KEY,
  project_id      uuid NOT NULL,
  deployment_id   uuid NOT NULL,
  recorder_id     text NOT NULL,
  audio_file_id   uuid NOT NULL,          -- with the TRUE file start time
  begin_time_s    numeric NOT NULL,       -- offset within the audio file, not within the hour
  species_code    text NOT NULL,
  confidence      numeric(5,4) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  birdnet_run_id  uuid NOT NULL REFERENCES birdnet_runs
);

CREATE TABLE IF NOT EXISTS validations (
  validation_id    uuid PRIMARY KEY,
  prediction_id    uuid NOT NULL REFERENCES predictions,
  outcome          boolean NOT NULL,      -- true = BirdNET was right (C-7)
  validator_id     text NOT NULL,         -- NULLs would let one clip be counted twice
  validated_at     timestamptz NOT NULL,
  sampling_stratum text NOT NULL,         -- e.g. 'random:0.3-0.5', 'recorder_acceptance' (C-1)
  UNIQUE (prediction_id, validator_id)    -- one verdict per validator per clip (D-01); several validators
                                          -- of one clip are collapsed to one row by io_postgres (agreeing) or left out (disagreeing)
);

CREATE TABLE IF NOT EXISTS threshold_sets (
  threshold_set_id text PRIMARY KEY,      -- ts-<16 hex>, derived from the decision content AND the scope
  project_id       uuid NOT NULL,         -- scope (also inside the artifact)
  birdnet_config   text NOT NULL,         -- scope (also inside the artifact)
  created_at       timestamptz NOT NULL DEFAULT now(),
  code_version     text NOT NULL,
  config           jsonb NOT NULL,
  validation_hash  text NOT NULL,
  artifact         jsonb NOT NULL,        -- the full threshold set (schemas/threshold_set.schema.json)
  status           text NOT NULL CHECK (status IN ('draft', 'published', 'retired')),
  approved_by      text,
  published_at     timestamptz,
  CHECK (status <> 'published' OR (approved_by IS NOT NULL AND published_at IS NOT NULL))
);
-- at most one published threshold set per project and BirdNET configuration
CREATE UNIQUE INDEX IF NOT EXISTS one_published_per_scope ON threshold_sets (project_id, birdnet_config) WHERE status = 'published';

CREATE TABLE IF NOT EXISTS species_thresholds (
  threshold_set_id text REFERENCES threshold_sets,
  species_code     text,
  status           text NOT NULL CHECK (status IN ('accepted','accepted_whole_range','not_reached','slope_not_positive','no_valid_fit','insufficient_validation')),
  gate_reason      text CHECK (gate_reason IN ('no_validations','no_observed_errors','no_observed_correct','too_few_errors','too_few_correct')),
  method           text CHECK (method IN ('ml','firth','flic')),   -- 'flic' only in sensitivity runs
  beta0            double precision,
  beta1            double precision,
  threshold        numeric(7,6),          -- operative value, rounded UP to 6 dp (policy threshold_decimals <= 6); NULL without a threshold
  validated_min    numeric,
  validated_max    numeric,
  n_correct        int NOT NULL,
  n_incorrect      int NOT NULL,
  diagnostics      jsonb,
  PRIMARY KEY (threshold_set_id, species_code)
);

-- Immutability (requirement): a threshold set's content never changes after it is written; only its
-- lifecycle moves forward (draft -> published -> retired). Species rows cannot be changed or deleted.
CREATE OR REPLACE FUNCTION threshold_set_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'threshold sets are never deleted (retire them instead)';
  END IF;
  IF (NEW.threshold_set_id, NEW.project_id, NEW.birdnet_config, NEW.code_version, NEW.config, NEW.validation_hash, NEW.artifact)
     IS DISTINCT FROM (OLD.threshold_set_id, OLD.project_id, OLD.birdnet_config, OLD.code_version, OLD.config, OLD.validation_hash, OLD.artifact) THEN
    RAISE EXCEPTION 'threshold set % is immutable; write a new set instead', OLD.threshold_set_id;
  END IF;
  IF NOT ((OLD.status = NEW.status) OR (OLD.status = 'draft' AND NEW.status IN ('published', 'retired')) OR (OLD.status = 'published' AND NEW.status = 'retired')) THEN
    RAISE EXCEPTION 'invalid status change % -> %', OLD.status, NEW.status;
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER threshold_sets_immutable BEFORE UPDATE OR DELETE ON threshold_sets
  FOR EACH ROW EXECUTE FUNCTION threshold_set_guard();

CREATE OR REPLACE FUNCTION species_threshold_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'species thresholds are immutable; write a new threshold set instead';
END $$;
CREATE OR REPLACE TRIGGER species_thresholds_immutable BEFORE UPDATE OR DELETE ON species_thresholds
  FOR EACH ROW EXECUTE FUNCTION species_threshold_guard();

-- Current label per prediction and threshold set: upserted, so a later human verdict replaces an
-- earlier model label (job B re-runs when verdicts change).
CREATE TABLE IF NOT EXISTS prediction_labels (
  prediction_id      uuid REFERENCES predictions,
  threshold_set_id   text REFERENCES threshold_sets,
  observation        boolean NOT NULL,
  observation_source text CHECK (observation_source IN ('validated','model')),
  observation_status text NOT NULL CHECK (observation_status IN ('validated_correct','validated_incorrect','model_observation','below_threshold','no_species_threshold')),
  p_correct          double precision,
  review_flag        text,
  validation_outcome text CHECK (validation_outcome IN ('correct','incorrect')),
  labelled_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (prediction_id, threshold_set_id)
);

-- Audit trail: every label write is appended here and never updated, so the labels a prediction has
-- had (and why) remain auditable after upserts.
CREATE TABLE IF NOT EXISTS prediction_label_history (
  history_id         bigserial PRIMARY KEY,
  prediction_id      uuid NOT NULL REFERENCES predictions,
  threshold_set_id   text NOT NULL REFERENCES threshold_sets,
  observation        boolean NOT NULL,
  observation_source text,
  observation_status text NOT NULL,
  p_correct          double precision,
  review_flag        text,
  validation_outcome text,
  labelled_at        timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION label_history_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'label history is append-only';
END $$;
CREATE OR REPLACE TRIGGER prediction_label_history_append_only BEFORE UPDATE OR DELETE ON prediction_label_history
  FOR EACH ROW EXECUTE FUNCTION label_history_guard();
```

Review flags are stored inside the threshold set (`artifact` → `species` → `review_flags`) and on each label row (`review_flag`); there is no separate table. Three design points:

- **Scope.** Every threshold set, and every read, is scoped to one project **and one BirdNET configuration** (`birdnet_runs.config_id`), because scores are not comparable across configurations. The scope is part of the threshold-set id, so identical results for two projects never collide.
- **Immutability is a requirement, enforced by triggers.** A threshold set's content and its species rows can never be changed or deleted; only the status moves forward (draft → published → retired). These triggers are written but not yet run against a live database.
- **Current label + audit trail.** `prediction_labels` holds the current label and is upserted, so a later human verdict replaces an earlier model label. Every write is also appended to `prediction_label_history`, which is append-only. That way the upsert does not lose history. Keep `prediction_labels` per threshold set, or keep history another way, so a dashboard figure can always be traced to the threshold set and validation snapshot behind it.

## 4. The procedure, exactly (job A)

For each project and species, take the validated clips: one row per `prediction_id`, where several validators who agree count once and a prediction whose validators disagree is left out (as `io_postgres.read_validations` does), with `x = ln(c / (1 − c))` and `c` clamped to [10⁻⁴, 1 − 10⁻⁴]. Then:

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
5. **Review flags.** For every species that passes the gate: for each recorder with ≥ 5 validated clips, refit step 2 without that recorder. Compute p = P(X ≤ observed correct), where X is Poisson-binomial with the refit probabilities of that recorder's clips. Flag if p < 0.05 / (number of recorders tested).
6. **Diagnostics,** shown to Biometrics before publishing. The package stores the first two in the threshold set's `diagnostics` (with `--diagnostics`). The others come from the research pipeline (`challenge1/src/run_challenge1.py`) and are reviewed alongside:
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

- **Deploy the package; don't rewrite it.** `ns_observations` depends only on numpy and pandas (jsonschema is optional), with no web or database code in the core. The suggested wiring:
  - **A worker task, e.g. a Redis queue consumer, for job A:** `io_postgres.read_validations` → `calibrate(..., diagnostics=True)` → `io_postgres.write_threshold_set`. This writes a **draft**.
  - **Publishing** is a separate, approved step: Biometrics signs off, and the status changes to `published`.
  - **A second task for job B:** `read_predictions` + `read_verdicts` → `label(..., published_set)` → `write_labels`.
  - **The image:** `docker build -t ns-observations:1.0.0 challenge1/ns_observations`. It runs as a non-root user, with the CLI as entrypoint.
- **The threshold set is the contract between the jobs.** It is deterministic JSON validated against `threshold_set.schema.json` (version 1.1). Its id is derived from the decision content and the scope (policy, validation snapshot, code version, species results, project and BirdNET configuration). Re-running calibration on unchanged inputs reproduces it, and neither diagnostics nor publication changes it.
- **Integrity on read and write.** Loading or writing a threshold set checks two things:
  - The id matches the content.
  - Every species result is what the procedure would produce from its own stored curve, status and gate. For example, an accepted threshold must be the curve's 99% point inside the validated range.

  A hand-edited threshold is refused. This catches accidental edits, not deliberate tampering; database immutability covers that.
- **Input validation in `label()`.** Predictions need a finite confidence in [0, 1] and unique, non-empty ids (compared as text, so 1 and "1" count as the same id). Unique verdicts need an outcome of exactly 0/1 or True/False. Malformed input raises an error instead of becoming an observation.
- **The covariate models** (`challenge1/src/covariates.py`) stay in the research code. They are a Biometrics diagnostic, not part of either job.
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

1. **A stable `prediction_id`, carried into the validation export.** Today validated clips are linked by species + recorder + date + hour + a 3-decimal score. That leaves 69 tied clips and 2 unmatched ones, and it allowed the same segment to be validated twice (D-01, D-02).
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

Run the platform job on this take-home dataset. It must reproduce the values below. `pytest challenge1/ns_observations` checks them automatically (`tests/test_acceptance.py`), and also checks that the output is byte-identical to the research pipeline's.

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

Unit-level checks already in `ns_observations/tests/` (the estimator checks are in `challenge1/tests/`):
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

### What has and has not been run

Everything the Tech team would deploy was written and tested here. Three parts could not be run on the development machine. None of them affects the results, but each should be checked once on the platform side:

| Part | Status | Evidence / how to check |
|---|---|---|
| Decision rules, label rule, threshold-set artifact, CLI | **Verified** | 50 package tests, including the end-to-end acceptance test on the take-home data. The CLI's labelled file is byte-identical to the research pipeline's, and so is its threshold set when run with `--diagnostics` (without it: same id and decisions) |
| Packaging (wheel, entry point, bundled schemas) | **Verified** | The wheel was built and installed into a fresh Python 3.13 environment outside the repo. `ns-observations run` gave byte-identical output there, with the same threshold-set id |
| Docker image | **Written, not built** | The Docker daemon was not running on the development machine. The image installs the same package with `pip install ".[schema]"`. To check: `docker build -t ns-observations:1.0.0 challenge1/ns_observations`, then the `docker run` command in the package README (`challenge1/ns_observations/README.md`) |
| PostgreSQL adapter (`io_postgres.py`, `sql/schema.sql`) | **Stub** | The SQL and functions match the handover's tables, including configuration scoping, the label upsert with an append-only history, and the immutability triggers. Their calls are checked with a fake connection, but neither the SQL nor the triggers have **ever run against a database**. Before production: apply `schema.sql` to a staging database and add integration tests |
| R cross-check snippet (section 9) | **Not run** | R is not installed on the development machine. The expected value, 0.6666381, was confirmed with statsmodels' binomial GLM, the same estimator as R's `glm` |

## 10. Optional downstream uses (not part of labelling)

- **Site-level presence** (Wood & Kahl): require observations on two or more days before marking a species present at a site.
- **Occupancy with false positives:** use `p_correct` per detection (Clare et al. 2021). Only species with an identified curve have it.
- **Review queues:** flagged recorders, `no_species_threshold` species with high scores, and the top-scoring Firefinch predictions are natural targets for ornithologist time.
- **Call density, threshold-free** (Navine et al. 2024). Estimate the share of audio windows that contain the species, by validating within score-quantile bins. It needs no errors, so it suits species without a threshold, such as the Oriole, and gives a vocal-activity measure for dashboards. Its quantile-bin design is also a good template for validation requests.
- **Partial pooling across species** (Thompson et al. 2025). Once many species are validated, a mixed model would let a new or rarely validated species start from the community curve and move away from it as evidence accumulates. It was not used here (D-14): with four species it would mostly reflect the pooling assumption.

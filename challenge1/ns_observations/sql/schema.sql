-- PostgreSQL 15+ schema for ns-observations, read and written by io_postgres.py (the Tech handover, section 3, shows the same tables).
-- Existing platform tables (predictions) are shown with the columns this package reads.

CREATE TABLE IF NOT EXISTS predictions (
  prediction_id   uuid PRIMARY KEY,
  project_id      uuid NOT NULL,
  deployment_id   uuid NOT NULL,
  recorder_id     text NOT NULL,
  audio_file_id   uuid NOT NULL,          -- with the TRUE file start time
  begin_time_s    numeric NOT NULL,       -- offset within the audio file, not within the hour
  species_code    text NOT NULL,
  confidence      numeric(5,4) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  birdnet_run_id  uuid NOT NULL           -- model version, sensitivity, min score (confirmation item C-2)
);

CREATE TABLE IF NOT EXISTS validations (
  validation_id    uuid PRIMARY KEY,
  prediction_id    uuid NOT NULL REFERENCES predictions,
  outcome          boolean NOT NULL,      -- true = BirdNET was right (C-7)
  validator_id     text NOT NULL,          -- NULLs would let one clip be counted twice
  validated_at     timestamptz NOT NULL,
  sampling_stratum text NOT NULL,         -- e.g. 'random:0.3-0.5', 'recorder_acceptance' (C-1)
  UNIQUE (prediction_id, validator_id)    -- the same clip cannot be counted twice (D-01)
);

CREATE TABLE IF NOT EXISTS threshold_sets (
  threshold_set_id text PRIMARY KEY,      -- ts-<16 hex>, derived from the artifact content
  project_id       uuid NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  code_version     text NOT NULL,
  config           jsonb NOT NULL,
  validation_hash  text NOT NULL,
  artifact         jsonb NOT NULL,        -- the full threshold set (schemas/threshold_set.schema.json)
  status           text NOT NULL CHECK (status IN ('draft', 'published', 'retired')),
  approved_by      text,
  published_at     timestamptz
);
-- at most one published threshold set per project
CREATE UNIQUE INDEX IF NOT EXISTS one_published_per_project ON threshold_sets (project_id) WHERE status = 'published';

CREATE TABLE IF NOT EXISTS species_thresholds (
  threshold_set_id text REFERENCES threshold_sets,
  species_code     text,
  status           text NOT NULL CHECK (status IN ('accepted','accepted_whole_range','not_reached','slope_not_positive','no_valid_fit','insufficient_validation')),
  gate_reason      text CHECK (gate_reason IN ('no_validations','no_observed_errors','no_observed_correct','too_few_errors','too_few_correct')),
  method           text CHECK (method IN ('ml','firth','flic')),
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

CREATE TABLE IF NOT EXISTS prediction_labels (
  prediction_id      uuid REFERENCES predictions,
  threshold_set_id   text REFERENCES threshold_sets,
  observation        boolean NOT NULL,
  observation_source text CHECK (observation_source IN ('validated','model')),
  observation_status text NOT NULL CHECK (observation_status IN ('validated_correct','validated_incorrect','model_observation','below_threshold','no_species_threshold')),
  p_correct          double precision,
  review_flag        text,
  PRIMARY KEY (prediction_id, threshold_set_id)
);

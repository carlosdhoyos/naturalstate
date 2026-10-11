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

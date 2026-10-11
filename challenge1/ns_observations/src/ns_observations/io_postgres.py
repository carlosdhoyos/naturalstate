"""PostgreSQL adapter — STUB, matching the tables in sql/schema.sql and the Tech handover.

Not exercised against a live database here (none was available); the SQL is written for
PostgreSQL 15+ and the functions take any DB-API 2.0 connection (e.g. psycopg 3). The unit tests
check the parameters each call sends, with a fake connection. Before production: run against a
staging database and add integration tests.

Unlike the CSV adapter, nothing here links clips by file name: validations reference
predictions.prediction_id directly, so linkage and de-duplication come from the schema.
"""

from __future__ import annotations

import json

import pandas as pd

from .artifact import ThresholdSet
from .label import LABEL_COLUMNS

# One row per validated prediction: several validators of the same prediction count once, and a
# prediction whose validators disagree is left out (label() treats it as a conflict too).
# All reads are scoped to one project AND one BirdNET configuration: scores are not comparable across
# configurations, so a threshold set is calibrated and applied within one configuration only.
SELECT_VALIDATIONS = """
SELECT p.species_code AS species, p.confidence, bool_and(v.outcome)::int AS outcome, p.recorder_id AS recorder,
       p.prediction_id
FROM validations v
JOIN predictions p USING (prediction_id)
JOIN birdnet_runs r USING (birdnet_run_id)
WHERE p.project_id = %(project_id)s AND r.config_id = %(birdnet_config)s
GROUP BY p.prediction_id, p.species_code, p.confidence, p.recorder_id
HAVING count(DISTINCT v.outcome) = 1
"""

SELECT_PREDICTIONS = """
SELECT p.prediction_id, p.species_code AS species, p.confidence, p.recorder_id AS recorder
FROM predictions p
JOIN birdnet_runs r USING (birdnet_run_id)
WHERE p.project_id = %(project_id)s AND r.config_id = %(birdnet_config)s
"""

SELECT_VERDICTS = """
SELECT v.prediction_id, v.outcome::int AS outcome, 'unique' AS link
FROM validations v
JOIN predictions p USING (prediction_id)
JOIN birdnet_runs r USING (birdnet_run_id)
WHERE p.project_id = %(project_id)s AND r.config_id = %(birdnet_config)s
"""

# A threshold set is immutable once written (enforced by triggers in sql/schema.sql). Its id is
# content- and scope-derived, so re-inserting the same set is a no-op, never an overwrite.
INSERT_THRESHOLD_SET = """
INSERT INTO threshold_sets (threshold_set_id, project_id, birdnet_config, code_version, config, validation_hash, artifact, status)
VALUES (%(threshold_set_id)s, %(project_id)s, %(birdnet_config)s, %(code_version)s, %(config)s::jsonb, %(validation_hash)s, %(artifact)s::jsonb, 'draft')
ON CONFLICT (threshold_set_id) DO NOTHING
"""

INSERT_SPECIES_THRESHOLD = """
INSERT INTO species_thresholds (threshold_set_id, species_code, status, gate_reason, method, beta0, beta1, threshold,
                                validated_min, validated_max, n_correct, n_incorrect, diagnostics)
VALUES (%(threshold_set_id)s, %(species_code)s, %(status)s, %(gate_reason)s, %(method)s, %(beta0)s, %(beta1)s, %(threshold)s,
        %(validated_min)s, %(validated_max)s, %(n_correct)s, %(n_incorrect)s, %(diagnostics)s::jsonb)
ON CONFLICT (threshold_set_id, species_code) DO NOTHING
"""

# Current label: UPSERT, so a later human verdict (e.g. a rejection) replaces an earlier model label
# under the same threshold set. History: every write is also appended to prediction_label_history,
# which is never updated, so the sequence of labels a prediction had stays auditable.
UPSERT_LABEL = """
INSERT INTO prediction_labels (prediction_id, threshold_set_id, observation, observation_source, observation_status,
                               p_correct, review_flag, validation_outcome, labelled_at)
VALUES (%(prediction_id)s, %(threshold_set_id)s, %(observation)s, %(observation_source)s, %(observation_status)s,
        %(p_correct)s, %(review_flag)s, %(validation_outcome)s, now())
ON CONFLICT (prediction_id, threshold_set_id) DO UPDATE SET
  observation = EXCLUDED.observation, observation_source = EXCLUDED.observation_source,
  observation_status = EXCLUDED.observation_status, p_correct = EXCLUDED.p_correct,
  review_flag = EXCLUDED.review_flag, validation_outcome = EXCLUDED.validation_outcome, labelled_at = now()
"""

INSERT_LABEL_HISTORY = """
INSERT INTO prediction_label_history (prediction_id, threshold_set_id, observation, observation_source, observation_status,
                                      p_correct, review_flag, validation_outcome)
VALUES (%(prediction_id)s, %(threshold_set_id)s, %(observation)s, %(observation_source)s, %(observation_status)s,
        %(p_correct)s, %(review_flag)s, %(validation_outcome)s)
"""


def _frame(conn, sql: str, params: dict) -> pd.DataFrame:
    with conn.cursor() as cur:
        cur.execute(sql, params)
        cols = [c[0] for c in cur.description]
        return pd.DataFrame(cur.fetchall(), columns=cols)


def read_validations(conn, project_id: str, birdnet_config: str) -> pd.DataFrame:
    return _frame(conn, SELECT_VALIDATIONS, {"project_id": project_id, "birdnet_config": birdnet_config})


def read_predictions(conn, project_id: str, birdnet_config: str) -> pd.DataFrame:
    return _frame(conn, SELECT_PREDICTIONS, {"project_id": project_id, "birdnet_config": birdnet_config})


def read_verdicts(conn, project_id: str, birdnet_config: str) -> pd.DataFrame:
    return _frame(conn, SELECT_VERDICTS, {"project_id": project_id, "birdnet_config": birdnet_config})


def write_threshold_set(conn, ts: ThresholdSet) -> None:
    """Insert the artifact as a draft, in the project and BirdNET configuration it is scoped to.
    Publishing (status -> published) is a separate, approved step."""
    with conn.cursor() as cur:
        cur.execute(INSERT_THRESHOLD_SET, {
            "threshold_set_id": ts.threshold_set_id, "project_id": ts.scope["project_id"], "birdnet_config": ts.scope["birdnet_config"], "code_version": ts.code_version,
            "config": json.dumps(ts.policy, sort_keys=True), "validation_hash": ts.validation_snapshot["sha256"], "artifact": ts.to_json(),
        })
        for name, s in sorted(ts.species.items()):
            cur.execute(INSERT_SPECIES_THRESHOLD, {
                "threshold_set_id": ts.threshold_set_id, "species_code": s.species_code or name, "status": s.status,
                "gate_reason": s.gate_reason, "method": s.method, "beta0": s.beta0, "beta1": s.beta1, "threshold": s.threshold,
                "validated_min": s.validated_min, "validated_max": s.validated_max, "n_correct": s.n_correct,
                "n_incorrect": s.n_incorrect, "diagnostics": json.dumps(s.diagnostics, sort_keys=True) if s.diagnostics else None,
            })
    conn.commit()


def write_labels(conn, labels: pd.DataFrame) -> None:
    """Upsert the current label of each prediction and append the same row to the history table."""
    with conn.cursor() as cur:
        for r in labels[LABEL_COLUMNS].itertuples(index=False):
            row = {
                "prediction_id": r.prediction_id, "threshold_set_id": r.threshold_set_id, "observation": bool(r.observation),
                "observation_source": r.observation_source or None, "observation_status": r.observation_status,
                "p_correct": None if pd.isna(r.p_correct) else float(r.p_correct), "review_flag": r.review_flag or None,
                "validation_outcome": r.validation_outcome or None,
            }
            cur.execute(UPSERT_LABEL, row)
            cur.execute(INSERT_LABEL_HISTORY, row)
    conn.commit()

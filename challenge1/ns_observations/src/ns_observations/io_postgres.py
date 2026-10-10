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

SELECT_VALIDATIONS = """
SELECT p.species_code AS species, p.confidence, v.outcome::int AS outcome, p.recorder_id AS recorder,
       p.prediction_id
FROM validations v
JOIN predictions p USING (prediction_id)
WHERE p.project_id = %(project_id)s
"""

SELECT_PREDICTIONS = """
SELECT p.prediction_id, p.species_code AS species, p.confidence, p.recorder_id AS recorder
FROM predictions p
WHERE p.project_id = %(project_id)s
"""

SELECT_VERDICTS = """
SELECT v.prediction_id, v.outcome::int AS outcome, 'unique' AS link
FROM validations v
JOIN predictions p USING (prediction_id)
WHERE p.project_id = %(project_id)s
"""

INSERT_THRESHOLD_SET = """
INSERT INTO threshold_sets (threshold_set_id, project_id, code_version, config, validation_hash, artifact, status)
VALUES (%(threshold_set_id)s, %(project_id)s, %(code_version)s, %(config)s::jsonb, %(validation_hash)s, %(artifact)s::jsonb, 'draft')
ON CONFLICT (threshold_set_id) DO NOTHING
"""

INSERT_SPECIES_THRESHOLD = """
INSERT INTO species_thresholds (threshold_set_id, species_code, status, gate_reason, method, beta0, beta1, threshold,
                                validated_min, validated_max, n_correct, n_incorrect, diagnostics)
VALUES (%(threshold_set_id)s, %(species_code)s, %(status)s, %(gate_reason)s, %(method)s, %(beta0)s, %(beta1)s, %(threshold)s,
        %(validated_min)s, %(validated_max)s, %(n_correct)s, %(n_incorrect)s, %(diagnostics)s::jsonb)
ON CONFLICT (threshold_set_id, species_code) DO NOTHING
"""

INSERT_LABEL = """
INSERT INTO prediction_labels (prediction_id, threshold_set_id, observation, observation_source, observation_status,
                               p_correct, review_flag)
VALUES (%(prediction_id)s, %(threshold_set_id)s, %(observation)s, %(observation_source)s, %(observation_status)s,
        %(p_correct)s, %(review_flag)s)
ON CONFLICT (prediction_id, threshold_set_id) DO NOTHING
"""


def _frame(conn, sql: str, params: dict) -> pd.DataFrame:
    with conn.cursor() as cur:
        cur.execute(sql, params)
        cols = [c[0] for c in cur.description]
        return pd.DataFrame(cur.fetchall(), columns=cols)


def read_validations(conn, project_id: str) -> pd.DataFrame:
    return _frame(conn, SELECT_VALIDATIONS, {"project_id": project_id})


def read_predictions(conn, project_id: str) -> pd.DataFrame:
    return _frame(conn, SELECT_PREDICTIONS, {"project_id": project_id})


def read_verdicts(conn, project_id: str) -> pd.DataFrame:
    return _frame(conn, SELECT_VERDICTS, {"project_id": project_id})


def write_threshold_set(conn, ts: ThresholdSet, project_id: str) -> None:
    """Insert the artifact as a draft; publishing (status -> published) is a separate, approved step."""
    with conn.cursor() as cur:
        cur.execute(INSERT_THRESHOLD_SET, {
            "threshold_set_id": ts.threshold_set_id, "project_id": project_id, "code_version": ts.code_version,
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
    with conn.cursor() as cur:
        for r in labels[LABEL_COLUMNS].itertuples(index=False):
            cur.execute(INSERT_LABEL, {
                "prediction_id": r.prediction_id, "threshold_set_id": r.threshold_set_id, "observation": bool(r.observation),
                "observation_source": r.observation_source or None, "observation_status": r.observation_status,
                "p_correct": None if pd.isna(r.p_correct) else float(r.p_correct), "review_flag": r.review_flag or None,
            })
    conn.commit()

"""The PostgreSQL adapter is a stub (no database here): check what it sends, with a fake connection."""

import pandas as pd

from ns_observations import calibrate, label
from ns_observations import io_postgres as pg


class FakeCursor:
    def __init__(self, log, rows=(), cols=()):
        self.log, self.rows, self.description = log, list(rows), [(c,) for c in cols]

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def execute(self, sql, params):
        self.log.append((sql, params))

    def fetchall(self):
        return self.rows


class FakeConn:
    def __init__(self, rows=(), cols=()):
        self.log, self.rows, self.cols, self.commits = [], rows, cols, 0

    def cursor(self):
        return FakeCursor(self.log, self.rows, self.cols)

    def commit(self):
        self.commits += 1


def test_reads_return_frames_with_the_expected_columns():
    conn = FakeConn(rows=[("abc", 0.5, 1, "R1", "id1")], cols=["species", "confidence", "outcome", "recorder", "prediction_id"])
    df = pg.read_validations(conn, "proj")
    assert list(df.columns) == ["species", "confidence", "outcome", "recorder", "prediction_id"]
    assert conn.log[0][1] == {"project_id": "proj"}


def test_write_threshold_set_inserts_the_set_then_each_species(synthetic_validations):
    ts = calibrate(synthetic_validations)
    conn = FakeConn()
    pg.write_threshold_set(conn, ts, "proj")
    assert conn.log[0][0] == pg.INSERT_THRESHOLD_SET and conn.log[0][1]["threshold_set_id"] == ts.threshold_set_id
    assert [p["species_code"] for _, p in conn.log[1:]] == sorted(ts.species)
    assert conn.commits == 1


def test_write_labels_maps_empty_strings_to_null(synthetic_validations):
    ts = calibrate(synthetic_validations)
    preds = pd.DataFrame({"prediction_id": ["a", "b"], "species": ["good", "rare"], "confidence": [0.99, 0.99], "recorder": ["R1", "R1"]})
    conn = FakeConn()
    pg.write_labels(conn, label(preds, ts))
    rows = [p for _, p in conn.log]
    assert rows[0]["observation"] is True and rows[0]["observation_source"] == "model"
    assert rows[1]["observation_source"] is None and rows[1]["p_correct"] is None

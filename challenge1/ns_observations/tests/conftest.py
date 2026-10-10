from pathlib import Path

import numpy as np
import pandas as pd
import pytest

DATA = Path(__file__).resolve().parents[3] / "Data Birds"
PRED_CSV = DATA / "birdnet_predictions.csv"
VAL_CSV = DATA / "validation_results.csv"


@pytest.fixture
def synthetic_validations():
    """Two species: 'good' (clear curve, passes the gate) and 'rare' (one error: fails the gate)."""
    rng = np.random.default_rng(0)
    conf = rng.uniform(0.1, 0.99, 400)
    x = np.log(conf / (1 - conf))
    y = (rng.uniform(size=400) < 1 / (1 + np.exp(-(1.0 + 2.0 * x)))).astype(int)
    good = pd.DataFrame({"species": "good", "confidence": conf, "outcome": y, "recorder": rng.choice(["R1", "R2", "R3", "R4"], 400)})
    rare = pd.DataFrame({"species": "rare", "confidence": np.linspace(0.1, 0.9, 50), "outcome": [0] + [1] * 49, "recorder": "R1"})
    return pd.concat([good, rare], ignore_index=True)

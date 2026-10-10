"""Checks of the estimation core against independent references.

Run:  challenge1/.venv/bin/python -m pytest challenge1/tests -q
"""

import sys
from pathlib import Path

import numpy as np
import pandas as pd
import pytest
import statsmodels.api as sm
from scipy.optimize import minimize

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from thresholds import (  # noqa: E402
    LOGIT_99,
    _design,
    _firth_penalised_loglik,
    fit_firth,
    fit_ml,
    logit_conf,
    separation,
    threshold_logit,
)

DATA = Path(__file__).resolve().parents[2] / "Data Birds" / "validation_results.csv"


def species(name: str) -> tuple[np.ndarray, np.ndarray]:
    v = pd.read_csv(DATA)
    v = v[v.commonName == name]
    return logit_conf(v.confidence.to_numpy()), v.outcome.to_numpy()


def test_ml_matches_statsmodels_glm():
    """Ordinary fit equals statsmodels' binomial GLM (same as R's glm) on real Nightjar data."""
    x, y = species("Abyssinian Nightjar")
    ours = fit_ml(x, y)
    ref = sm.GLM(y, sm.add_constant(x), family=sm.families.Binomial()).fit()
    assert ours.valid
    np.testing.assert_allclose([ours.b0, ours.b1], ref.params, rtol=1e-7)
    np.testing.assert_allclose(ours.se, ref.bse, rtol=1e-6)


def test_firth_matches_haldane_correction_for_binary_predictor():
    """With one binary predictor, Firth's estimate equals the log odds ratio with 0.5 added to every
    cell (a known analytic result), including a table with an empty cell (separation)."""
    for a, b, c, d in [(12, 3, 5, 9), (10, 0, 4, 7), (20, 1, 0, 15)]:
        # cells: x=1,y=1 (a); x=1,y=0 (b); x=0,y=1 (c); x=0,y=0 (d)
        x = np.r_[np.ones(a + b), np.zeros(c + d)]
        y = np.r_[np.ones(a), np.zeros(b), np.ones(c), np.zeros(d)]
        f = fit_firth(x, y)
        expected = np.log((a + 0.5) * (d + 0.5) / ((b + 0.5) * (c + 0.5)))
        assert f.valid
        assert f.b1 == pytest.approx(expected, rel=1e-8)


@pytest.mark.parametrize("name", ["Three-banded Plover", "African Black-headed Oriole", "Red-billed Firefinch"])
def test_firth_maximises_the_penalised_likelihood(name):
    """Firth estimate equals a direct numerical maximisation of l(b) + 0.5 log|I(b)| (scipy)."""
    x, y = species(name)
    f = fit_firth(x, y)
    X = _design(x)
    res = minimize(lambda b: -_firth_penalised_loglik(X, y, b), x0=np.zeros(2), method="Nelder-Mead", options={"xatol": 1e-10, "fatol": 1e-12, "maxiter": 20000})
    assert f.valid
    np.testing.assert_allclose([f.b0, f.b1], res.x, atol=1e-4)


def test_separation_detection():
    assert separation(np.array([0, 1, 1, 2.0]), np.array([0, 0, 1, 1]))  # quasi-complete (tie at 1)
    assert separation(np.array([0, 1, 2, 3.0]), np.array([0, 0, 1, 1]))  # complete
    assert separation(np.array([1, 2, 3.0]), np.array([1, 1, 1]))  # one outcome only
    assert not separation(np.array([1, 2, 3, 4.0]), np.array([0, 1, 0, 1]))


def test_ml_invalid_under_separation_firth_valid():
    x, y = np.array([0, 1, 1, 2.0]), np.array([0, 0, 1, 1])
    assert not fit_ml(x, y).valid and threshold_logit(fit_ml(x, y)) is None
    assert fit_firth(x, y).valid


def test_threshold_gives_99_percent():
    x, y = species("Abyssinian Nightjar")
    f = fit_ml(x, y)
    t = threshold_logit(f)
    assert f.p(t) == pytest.approx(0.99, abs=1e-12)
    assert t == pytest.approx((LOGIT_99 - f.b0) / f.b1)


def test_firth_close_to_ml_with_plenty_of_data():
    rng = np.random.default_rng(1)
    x = rng.uniform(-2.2, 7, 5000)
    y = (rng.uniform(size=5000) < 1 / (1 + np.exp(-(-1 + 1.2 * x)))).astype(int)
    a, b = fit_ml(x, y), fit_firth(x, y)
    np.testing.assert_allclose([a.b0, a.b1], [b.b0, b.b1], atol=0.02)

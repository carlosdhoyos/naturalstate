"""Checks of the covariate models (Wood & Kahl's transferability test, D-13).

Run:  challenge1/.venv/bin/python -m pytest challenge1/tests -q
"""

import sys
from pathlib import Path

import numpy as np
import pytest
from scipy.integrate import quad
from scipy.special import expit

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
import run_challenge1 as rc  # noqa: E402
from covariates import _cluster_loglik, conditional_threshold, fit_fixed, fit_random_intercept, glmm_loglik, marginal_p, marginal_threshold  # noqa: E402


@pytest.mark.parametrize("sigma", [0.1, 1.0, 4.0])
def test_adaptive_quadrature_matches_brute_force_integration(sigma):
    """The marginal likelihood of one recorder, by adaptive Gauss–Hermite vs scipy.quad, including
    an all-wrong recorder (the case that makes a fixed recorder term diverge)."""
    rng = np.random.default_rng(0)
    for y in (rng.integers(0, 2, 8).astype(float), np.zeros(10)):
        eta = rng.normal(1, 1.5, len(y))

        def f(u):
            ll = np.sum(y * np.log(expit(eta + u)) + (1 - y) * np.log(expit(-(eta + u))))
            return np.exp(ll - 0.5 * (u / sigma) ** 2) / (sigma * np.sqrt(2 * np.pi))

        ref = np.log(quad(f, -80, 80, points=[0], limit=500, epsabs=0, epsrel=1e-12)[0])
        assert _cluster_loglik(eta, y, sigma) == pytest.approx(ref, abs=1e-6)


def test_small_sigma_reduces_to_ordinary_logistic():
    rng = np.random.default_rng(2)
    x = rng.normal(0, 2, 200)
    y = (rng.uniform(size=200) < expit(0.3 + x)).astype(float)
    X = np.column_stack([np.ones_like(x), x])
    g = np.repeat(np.arange(20), 10)
    fx = fit_fixed(X, y, ["intercept", "score"], "fixed")
    assert glmm_loglik(fx.beta, 1e-4, X, y, g) == pytest.approx(fx.loglik, abs=1e-5)


def test_random_intercept_recovers_simulated_parameters():
    rng = np.random.default_rng(1)
    J, n = 40, 40
    g = np.repeat(np.arange(J), n)
    x = rng.normal(0, 2, J * n)
    u = rng.normal(0, 1.0, J)
    y = (rng.uniform(size=J * n) < expit(0.5 + 1.0 * x + u[g])).astype(float)
    f = fit_random_intercept(np.column_stack([np.ones_like(x), x]), y, g, ["intercept", "score"], "ri")
    assert f.beta[1] == pytest.approx(1.0, abs=0.15)
    assert f.sigma == pytest.approx(1.0, abs=0.35)


def test_new_recorder_needs_a_higher_score_than_a_typical_one():
    """With recorder variation, averaging over recorders flattens the curve, so reaching 99% at an
    unknown recorder needs a higher score than at a typical (u = 0) one."""
    from covariates import CovFit

    f = CovFit("ri", 3, 0.0, np.array([0.5, 1.0]), ["intercept", "score"], 1.0, True)
    ct, mt = conditional_threshold(f), marginal_threshold(f)
    assert mt > ct
    assert marginal_p(f, mt) == pytest.approx(0.99, abs=1e-9)


def test_nightjar_covariate_results_are_pinned():
    """D-13 (revised): only converged, identified fits are ranked by AIC. The recorder random-intercept
    fits do not converge and are not ranked; among identified models score + evening is best; adopting
    it would label 3,715 Nightjar predictions (a sensitivity result; labels keep the pooled curve)."""
    cfg = rc.Config()
    pred, val = rc.load(cfg)
    val = rc.link_validations(pred, val, cfg)
    val, _ = rc.deduplicate(pred, val, cfg=cfg)
    d = val[val.commonName == "Abyssinian Nightjar"].copy()
    d.attrs["flagged"] = ["RBS75", "RBS79"]
    t, tab = rc.covariate_models(d, cfg, pred[pred.common_name == "Abyssinian Nightjar"])
    t = t.set_index("model")
    assert t.loc["score", "aic"] == pytest.approx(79.59, abs=0.01)
    assert not t.loc["score + (1 | recorder)", "identified"] and np.isnan(t.loc["score + (1 | recorder)", "aic"])
    assert not t.loc["score + evening + (1 | recorder)", "valid"]  # not converged
    assert t.loc["score + evening", "delta_aic"] == 0 and t.loc["score", "delta_aic"] == pytest.approx(14.61, abs=0.01)
    assert t.loc["score + evening", "labelled_if_adopted"] == 3715
    assert t.loc["score + evening", "threshold_night_if_adopted"] == pytest.approx(0.420780, abs=1e-6)
    assert t.loc["score + evening", "threshold_evening_if_adopted"] == pytest.approx(0.727211, abs=1e-6)
    assert tab["other recorders, night & dawn"] == {"correct": 68, "incorrect": 0}
    assert tab["flagged recorders, evening"] == {"correct": 0, "incorrect": 26}

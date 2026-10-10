"""Species-specific BirdNET thresholds (Wood & Kahl 2024): estimation core.

    logit(p) = b0 + b1 * logit(confidence)        p = pr(BirdNET prediction is correct)
    threshold(q) = (ln(q / (1 - q)) - b0) / b1     q = target probability (0.99)

Two estimators share one interface:
  * ordinary maximum likelihood (IRLS), identical to R's glm(outcome ~ score, binomial);
  * Firth's penalised likelihood (Jeffreys prior), which stays finite under separation and
    reduces small-sample bias when one outcome is rare.

Every fit carries validity flags. Probabilities and thresholds are only derived from valid fits;
an invalid fit yields None, never an accidental number.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

LOGIT_99 = float(np.log(0.99 / 0.01))


def logit_conf(conf: np.ndarray, eps: float = 1e-4) -> np.ndarray:
    """logit of a confidence score, clamped to [eps, 1 - eps] so scores of exactly 0 or 1 stay finite."""
    c = np.clip(np.asarray(conf, dtype=float), eps, 1 - eps)
    return np.log(c / (1 - c))


def sigmoid(z: np.ndarray | float) -> np.ndarray | float:
    return 1.0 / (1.0 + np.exp(-np.asarray(z, dtype=float)))


def separation(x: np.ndarray, y: np.ndarray) -> bool:
    """Complete or quasi-complete separation for one predictor.

    True if every outcome is the same, or a cut c exists with all y = 0 at x <= c and all y = 1 at
    x >= c (or the reverse), ties at c allowed. Then no finite ordinary ML estimate exists.
    """
    x = np.asarray(x, float)
    y = np.asarray(y, int)
    ones = int(y.sum())
    if ones == 0 or ones == len(y):
        return True
    x0, x1 = x[y == 0], x[y == 1]
    return bool(x0.max() <= x1.min() or x1.max() <= x0.min())


@dataclass
class Fit:
    method: str  # "ml" or "firth"
    b0: float
    b1: float
    cov: np.ndarray  # inverse Fisher information at the estimate
    converged: bool
    separated: bool
    valid: bool
    iterations: int
    n: int
    loglik: float
    notes: list[str] = field(default_factory=list)

    @property
    def se(self) -> tuple[float, float]:
        return float(np.sqrt(self.cov[0, 0])), float(np.sqrt(self.cov[1, 1]))

    def p(self, x: np.ndarray | float) -> np.ndarray | float:
        return sigmoid(self.b0 + self.b1 * np.asarray(x, float))


def _design(x: np.ndarray) -> np.ndarray:
    return np.column_stack([np.ones(len(x)), np.asarray(x, float)])


def _eta(X: np.ndarray, b: np.ndarray) -> np.ndarray:
    # b0 + b1 * x written out: avoids BLAS (macOS Accelerate emits spurious matmul warnings)
    return b[0] * X[:, 0] + b[1] * X[:, 1]


def _info(X: np.ndarray, w: np.ndarray) -> np.ndarray:
    """Fisher information X'WX for the two-column design, as exact sums."""
    x = X[:, 1]
    s0, s1, s2 = float(np.sum(w)), float(np.sum(w * x)), float(np.sum(w * x * x))
    return np.array([[s0, s1], [s1, s2]])


def _score(X: np.ndarray, r: np.ndarray) -> np.ndarray:
    """X'r for the two-column design."""
    return np.array([float(np.sum(r)), float(np.sum(r * X[:, 1]))])


def _loglik(X: np.ndarray, y: np.ndarray, b: np.ndarray) -> float:
    eta = _eta(X, b)
    # log(1 + exp(eta)) computed stably
    return float(np.sum(y * eta - np.logaddexp(0.0, eta)))


def _finite(b: np.ndarray, cov: np.ndarray) -> bool:
    return bool(np.all(np.isfinite(b)) and np.all(np.isfinite(cov)) and cov[0, 0] > 0 and cov[1, 1] > 0)


def fit_ml(x: np.ndarray, y: np.ndarray, max_iter: int = 100, tol: float = 1e-10) -> Fit:
    """Ordinary maximum likelihood by IRLS. Invalid (no finite MLE) under separation."""
    X = _design(x)
    y = np.asarray(y, float)
    sep = separation(x, y)
    b = np.zeros(2)
    converged = False
    cov = np.full((2, 2), np.nan)
    it = 0
    for it in range(1, max_iter + 1):
        p = sigmoid(_eta(X, b))
        w = np.clip(p * (1 - p), 1e-12, None)
        info = _info(X, w)
        try:
            cov = np.linalg.inv(info)
        except np.linalg.LinAlgError:
            break
        step = cov @ _score(X, y - p)
        b = b + step
        if not np.all(np.isfinite(b)):
            break
        if np.max(np.abs(step)) < tol:
            converged = True
            break
    p = sigmoid(_eta(X, b))
    w = np.clip(p * (1 - p), 1e-12, None)
    try:
        cov = np.linalg.inv(_info(X, w))
    except np.linalg.LinAlgError:
        cov = np.full((2, 2), np.nan)
    valid = converged and not sep and _finite(b, cov)
    notes = []
    if sep:
        notes.append("separation: no finite maximum-likelihood estimate")
    elif not converged:
        notes.append("did not converge")
    return Fit("ml", float(b[0]), float(b[1]), cov, converged, sep, valid, it, len(y), _loglik(X, y, b), notes)


def _firth_penalised_loglik(X: np.ndarray, y: np.ndarray, b: np.ndarray) -> float:
    p = sigmoid(_eta(X, b))
    w = np.clip(p * (1 - p), 1e-300, None)
    sign, logdet = np.linalg.slogdet(_info(X, w))
    return _loglik(X, y, b) + 0.5 * logdet if sign > 0 else -np.inf


def fit_firth(x: np.ndarray, y: np.ndarray, max_iter: int = 200, tol: float = 1e-10) -> Fit:
    """Firth's penalised maximum likelihood (Heinze & Schemper 2002), Newton steps on the modified
    score U*(b) = X'(y - p + h (1/2 - p)), with step halving on the penalised log-likelihood.
    Finite even under separation; valid when it converges with a finite covariance."""
    X = _design(x)
    y = np.asarray(y, float)
    sep = separation(x, y)
    b = np.zeros(2)
    converged = False
    it = 0
    pl = _firth_penalised_loglik(X, y, b)
    for it in range(1, max_iter + 1):
        p = sigmoid(_eta(X, b))
        w = np.clip(p * (1 - p), 1e-12, None)
        info = _info(X, w)
        try:
            inv = np.linalg.inv(info)
        except np.linalg.LinAlgError:
            break
        x1 = X[:, 1]
        h = w * (inv[0, 0] + 2 * inv[0, 1] * x1 + inv[1, 1] * x1 * x1)  # diagonal of the hat matrix
        step = inv @ _score(X, y - p + h * (0.5 - p))
        # step halving keeps the penalised likelihood from decreasing
        t = 1.0
        for _ in range(30):
            cand = b + t * step
            pl_new = _firth_penalised_loglik(X, y, cand)
            if pl_new >= pl - 1e-12:
                break
            t /= 2
        b = b + t * step
        pl = _firth_penalised_loglik(X, y, b)
        if not np.all(np.isfinite(b)):
            break
        if np.max(np.abs(t * step)) < tol:
            converged = True
            break
    p = sigmoid(_eta(X, b))
    w = np.clip(p * (1 - p), 1e-12, None)
    try:
        cov = np.linalg.inv(_info(X, w))
    except np.linalg.LinAlgError:
        cov = np.full((2, 2), np.nan)
    valid = converged and _finite(b, cov)
    notes = ["separated data: estimate exists only because of the penalty"] if sep else []
    if not converged:
        notes.append("did not converge")
    return Fit("firth", float(b[0]), float(b[1]), cov, converged, sep, valid, it, len(y), _loglik(X, y, b), notes)


def fit_method(x: np.ndarray, y: np.ndarray, method: str) -> Fit:
    return fit_firth(x, y) if method == "firth" else fit_ml(x, y)


def threshold_logit(fit: Fit, q: float = 0.99) -> float | None:
    """Score (logit scale) where the fitted probability equals q. None unless valid and increasing."""
    if not fit.valid or not fit.b1 > 0:
        return None
    return (float(np.log(q / (1 - q))) - fit.b0) / fit.b1


def threshold_delta_ci(fit: Fit, q: float = 0.99, z: float = 1.96) -> tuple[float, float] | None:
    """Wald / delta-method interval for the threshold on the logit scale (ignores clustering)."""
    t = threshold_logit(fit, q)
    if t is None:
        return None
    L = float(np.log(q / (1 - q)))
    g = np.array([-1.0 / fit.b1, -(L - fit.b0) / fit.b1**2])
    se = float(np.sqrt(max(g @ fit.cov @ g, 0.0)))
    return t - z * se, t + z * se


@dataclass
class Bootstrap:
    thresholds: np.ndarray  # logit-scale thresholds of successful resamples
    n_resamples: int
    n_failed: int  # resamples without a valid, increasing fit
    all_thresholds: np.ndarray = field(default_factory=lambda: np.array([]))  # every resample, NaN where unusable

    def ci(self, level: float = 0.95) -> tuple[float, float] | None:
        if len(self.thresholds) < 0.5 * self.n_resamples:
            return None  # too many failures for a meaningful interval
        a = (1 - level) / 2
        lo, hi = np.quantile(self.thresholds, [a, 1 - a])
        return float(lo), float(hi)


def cluster_bootstrap(x: np.ndarray, y: np.ndarray, clusters: np.ndarray, method: str, q: float = 0.99, n_resamples: int = 2000, seed: int = 20261010) -> Bootstrap:
    """Resample whole clusters (audio files) with replacement and refit, so the interval reflects
    that clips from the same file are not independent."""
    rng = np.random.default_rng(seed)
    x = np.asarray(x, float)
    y = np.asarray(y, int)
    labels, inv = np.unique(np.asarray(clusters), return_inverse=True)
    members = [np.flatnonzero(inv == k) for k in range(len(labels))]
    every = np.full(n_resamples, np.nan)
    for i in range(n_resamples):
        pick = rng.integers(0, len(labels), len(labels))
        idx = np.concatenate([members[k] for k in pick])
        t = threshold_logit(fit_method(x[idx], y[idx], method), q)
        if t is not None:
            every[i] = t
    ok = every[np.isfinite(every)]
    return Bootstrap(ok, n_resamples, n_resamples - len(ok), every)

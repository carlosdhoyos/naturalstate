"""Species-specific BirdNET thresholds (Wood & Kahl 2024): estimation core.

    logit(p) = b0 + b1 * logit(confidence)        p = pr(BirdNET prediction is correct)
    threshold(q) = (ln(q / (1 - q)) - b0) / b1     q = target probability (0.99)

Two estimators share one interface:
  * ordinary maximum likelihood (IRLS), identical to R's glm(outcome ~ score, binomial);
  * Firth's penalised likelihood (Jeffreys prior), which stays finite under separation and
    reduces small-sample bias when one outcome is rare.

Every fit carries validity flags. Probabilities and thresholds are only derived from valid fits;
an invalid fit yields None, never an accidental number.

Also here: FLIC (Firth with intercept correction, a comparison estimator), Wilson intervals, an
exact Poisson-binomial tail (for per-recorder checks), and cluster-bootstrap resampling. The
decision rules that use these (evidence gate, acceptance, labels) live in run_challenge1.py.
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


def fit_firth(x: np.ndarray, y: np.ndarray, max_iter: int = 200, gtol: float = 1e-8) -> Fit:
    """Firth's penalised maximum likelihood (Firth 1993; Heinze & Schemper 2002).

    Maximises l(b) + 0.5 log|I(b)|, the log-likelihood plus a Jeffreys-prior penalty. Its score is
    the modified score U*(b) = X'(y - p + h (1/2 - p)), where h is the diagonal of the hat matrix.

    Iteration: Fisher-scoring steps, inverse information times U*. That inverse is not the exact
    Jacobian of U*, so a full step can overshoot. On tiny or saturated data it can bounce between
    two mirror points with the same penalised likelihood. To prevent that:
      * a step is accepted only if it strictly increases the penalised log-likelihood; otherwise it
        is halved, up to 30 times;
      * if the full step improves, its half is also tried and the better one kept, which damps the
        overshoot instead of bouncing;
      * convergence is judged on the modified score itself, |U*| < gtol, the quantity that must be
        zero at the solution (logistf uses the same idea), never on the size of a halved step. When
        the penalised likelihood is flat to float precision, |U*| < 1000 gtol is accepted (logistf's
        default score tolerance is 1e-5).

    Finite even under separation. Valid when converged with a finite covariance."""
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
        try:
            inv = np.linalg.inv(_info(X, w))
        except np.linalg.LinAlgError:
            break
        x1 = X[:, 1]
        h = w * (inv[0, 0] + 2 * inv[0, 1] * x1 + inv[1, 1] * x1 * x1)  # diagonal of the hat matrix
        u = _score(X, y - p + h * (0.5 - p))  # modified score: zero at the Firth estimate
        if np.max(np.abs(u)) < gtol:
            converged = True
            break
        step = inv @ u
        t, improved = 1.0, False
        for _ in range(30):
            pl_new = _firth_penalised_loglik(X, y, b + t * step)
            if pl_new > pl:
                improved = True
                # an overshooting step can still improve; take its half instead if that is better
                pl_half = _firth_penalised_loglik(X, y, b + 0.5 * t * step)
                if pl_half > pl_new:
                    t, pl_new = 0.5 * t, pl_half
                break
            t /= 2
        if not improved:
            # no ascent direction left within float precision: accept only if the score is ~0 anyway
            converged = bool(np.max(np.abs(u)) < 1e3 * gtol)
            break
        b = b + t * step
        pl = pl_new
        if not np.all(np.isfinite(b)):
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
    return {"firth": fit_firth, "flic": fit_flic}.get(method, fit_ml)(x, y)


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


def cluster_resamples(clusters: np.ndarray, n_resamples: int, seed: int):
    """Yield index arrays of a cluster bootstrap: whole clusters (audio files or recorders) are drawn
    with replacement, so dependence within a cluster is kept. Deterministic for a given seed."""
    rng = np.random.default_rng(seed)
    labels, inv = np.unique(np.asarray(clusters), return_inverse=True)
    members = [np.flatnonzero(inv == k) for k in range(len(labels))]
    for _ in range(n_resamples):
        pick = rng.integers(0, len(labels), len(labels))
        yield np.concatenate([members[k] for k in pick])


# ── comparison estimator and model-free checks ────────────────────────────────


def fit_flic(x: np.ndarray, y: np.ndarray) -> Fit:
    """FLIC: Firth's logistic regression with intercept correction (Puhr et al. 2017, Stat Med).

    Firth reduces bias in the *coefficients*, but it biases *predicted probabilities* toward 0.5
    when events are rare: the penalty acts like adding sum(h)/2 = 1 pseudo-event of each outcome.
    FLIC keeps Firth's slope and re-estimates the intercept by ordinary ML with the slope fixed,
    so the mean fitted probability equals the observed share of correct predictions again.

    Used here only as a comparison estimator, to show how much a threshold depends on the
    estimator when errors are rare. The covariance is Firth's, an approximation."""
    fi = fit_firth(x, y)
    x = np.asarray(x, float)
    y = np.asarray(y, float)
    if not fi.valid or y.sum() in (0, len(y)):
        # with one outcome only, sum(y - p) = 0 has no finite intercept
        return Fit("flic", fi.b0, fi.b1, fi.cov, False, fi.separated, False, fi.iterations, len(y), np.nan, ["intercept correction undefined"])
    b0 = fi.b0
    for _ in range(100):  # Newton on the intercept alone: sum(y - p) = 0
        p = sigmoid(b0 + fi.b1 * x)
        g, hss = float(np.sum(y - p)), float(np.sum(p * (1 - p)))
        step = g / hss
        b0 += step
        if abs(step) < 1e-12:
            break
    X = _design(x)
    return Fit("flic", float(b0), fi.b1, fi.cov, True, fi.separated, bool(np.isfinite(b0)), fi.iterations, len(y), _loglik(X, y, np.array([b0, fi.b1])), [])


def wilson(k: int, n: int, z: float = 1.96) -> tuple[float, float]:
    """Wilson score interval for a binomial proportion k/n. (nan, nan) when n == 0."""
    if n == 0:
        return float("nan"), float("nan")
    ph = k / n
    den = 1 + z * z / n
    centre = (ph + z * z / (2 * n)) / den
    half = z * np.sqrt(ph * (1 - ph) / n + z * z / (4 * n * n)) / den
    return float(centre - half), float(centre + half)


def poisson_binomial_cdf(k: int, p: np.ndarray) -> float:
    """P(X <= k) where X is a sum of independent Bernoulli(p_i). Exact, by dynamic programming.

    Used to ask: if the pooled curve were right at this recorder, how likely is it to see this few
    correct predictions among its validated clips?"""
    dist = np.zeros(len(p) + 1)
    dist[0] = 1.0
    for pi in np.asarray(p, float):
        dist[1:] = dist[1:] * (1 - pi) + dist[:-1] * pi
        dist[0] *= 1 - pi
    return float(dist[: k + 1].sum())

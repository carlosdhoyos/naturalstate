"""Covariate models for the score–correctness curve (Wood & Kahl 2024, "testing transferability").

Wood & Kahl suggest testing whether the outcome–score relationship generalises by adding spatial
or temporal covariates and comparing models with AIC. Here the only spatial unit is the recorder
(all recorders are in one grid). A plain recorder term separates — two recorders have only wrong
Nightjar clips, so their coefficients run to minus infinity — so recorders enter as a *random
intercept*, which shrinks such recorders toward the others instead of diverging:

    logit p_ij = b0 + b1 * logit(score_ij) + covariates_ij + u_j,     u_j ~ Normal(0, sigma^2)

The marginal likelihood integrates u_j out per recorder with adaptive Gauss–Hermite quadrature
(the integrand is centred on its mode and scaled by its curvature, so a handful of nodes is
accurate even when sigma is large). Fixed-effect-only models are ordinary logistic regressions.

Two thresholds follow from a random-intercept model:
  * conditional (typical recorder, u = 0): where b0 + b1 x (+ covariates) = logit(0.99);
  * marginal (a NEW recorder, u unknown): where E_u[sigmoid(b0 + b1 x + u)] = 0.99, i.e. the
    score at which a prediction from a recorder we have never validated is 99% likely correct.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
from scipy.optimize import brentq, minimize
from scipy.special import expit, log_expit

GH_NODES, GH_WEIGHTS = np.polynomial.hermite.hermgauss(40)  # ∫ e^{-z²} f(z) dz ≈ Σ w f(z)


@dataclass
class CovFit:
    name: str
    k: int  # number of estimated parameters (AIC penalty)
    loglik: float
    beta: np.ndarray  # fixed effects, in the order of `columns`
    columns: list[str]
    sigma: float  # random-intercept SD (0 for fixed-effect-only models)
    valid: bool
    notes: list[str] = field(default_factory=list)

    @property
    def aic(self) -> float:
        return -2 * self.loglik + 2 * self.k if self.valid else np.nan


def _bernoulli_ll(eta: np.ndarray, y: np.ndarray) -> np.ndarray:
    """log P(y | eta) per observation, stable for large |eta|."""
    return y * log_expit(eta) + (1 - y) * log_expit(-eta)


def fit_fixed(X: np.ndarray, y: np.ndarray, columns: list[str], name: str) -> CovFit:
    """Ordinary logistic regression by Newton–Raphson. Invalid if it does not converge or if any
    fitted probability is numerically 0 or 1 at an observed outcome of the other kind
    (separation), since its likelihood and AIC would then be meaningless."""
    X = np.asarray(X, float)
    y = np.asarray(y, float)
    b = np.zeros(X.shape[1])
    converged = False
    with np.errstate(all="ignore"):  # macOS Accelerate emits spurious matmul warnings on clean data
        for _ in range(100):
            eta = X @ b
            p = expit(eta)
            w = np.clip(p * (1 - p), 1e-12, None)
            H = (X * w[:, None]).T @ X
            g = X.T @ (y - p)
            try:
                step = np.linalg.solve(H, g)
            except np.linalg.LinAlgError:
                break
            b = b + step
            if not np.all(np.isfinite(b)):
                break
            if np.max(np.abs(step)) < 1e-10:
                converged = True
                break
        eta = X @ b
    ll = float(np.sum(_bernoulli_ll(eta, y)))
    notes = []
    separated = bool(np.any(np.abs(eta) > 30))
    if separated:
        notes.append("separation: some fitted probabilities are 0 or 1; likelihood not reliable")
    if not converged:
        notes.append("did not converge")
    return CovFit(name, X.shape[1], ll, b, columns, 0.0, converged and not separated and np.isfinite(ll), notes)


def _cluster_loglik(eta_fixed: np.ndarray, y: np.ndarray, sigma: float) -> float:
    """log ∫ Π_i P(y_i | eta_i + u) φ(u; 0, sigma) du for one cluster, adaptive Gauss–Hermite."""
    def g(u):  # log integrand, vectorised over u (shape [m])
        return np.sum(_bernoulli_ll(eta_fixed[None, :] + u[:, None], y[None, :]), axis=1) - 0.5 * (u / sigma) ** 2 - np.log(sigma * np.sqrt(2 * np.pi))

    # mode of the integrand by Newton on u (scalar)
    u = 0.0
    for _ in range(50):
        p = expit(eta_fixed + u)
        d1 = np.sum(y - p) - u / sigma**2
        d2 = -np.sum(p * (1 - p)) - 1 / sigma**2
        step = d1 / d2
        u -= step
        if abs(step) < 1e-10:
            break
    p = expit(eta_fixed + u)
    s = 1.0 / np.sqrt(np.sum(p * (1 - p)) + 1 / sigma**2)  # sd of the Laplace approximation
    nodes = u + np.sqrt(2) * s * GH_NODES
    vals = g(nodes) + GH_NODES**2  # undo the e^{-z²} weight
    m = vals.max()
    return float(m + np.log(np.sum(GH_WEIGHTS * np.exp(vals - m))) + np.log(np.sqrt(2) * s))


def glmm_loglik(beta: np.ndarray, sigma: float, X: np.ndarray, y: np.ndarray, groups: np.ndarray) -> float:
    eta = X @ beta
    return float(sum(_cluster_loglik(eta[groups == gk], y[groups == gk], sigma) for gk in np.unique(groups)))


def fit_random_intercept(X: np.ndarray, y: np.ndarray, groups: np.ndarray, columns: list[str], name: str) -> CovFit:
    """Random-intercept logistic regression by maximum marginal likelihood (adaptive GH).
    Parameters: the fixed effects and log(sigma). Starts from the fixed-effect fit."""
    X = np.asarray(X, float)
    y = np.asarray(y, float)
    groups = np.asarray(groups)
    start = fit_fixed(X, y, columns, "start")
    theta0 = np.r_[start.beta if start.valid else np.zeros(X.shape[1]), np.log(0.5)]

    def nll(theta):
        with np.errstate(all="ignore"):
            v = -glmm_loglik(theta[:-1], float(np.exp(theta[-1])), X, y, groups)
        return v if np.isfinite(v) else 1e12

    res = minimize(nll, theta0, method="Nelder-Mead", options={"xatol": 1e-7, "fatol": 1e-9, "maxiter": 20000, "maxfev": 40000})
    res = minimize(nll, res.x, method="BFGS", options={"gtol": 1e-6})  # polish
    beta, sigma = res.x[:-1], float(np.exp(res.x[-1]))
    # converged = the optimiser says so AND the gradient of the objective is ~0 (checked independently
    # by central differences, since BFGS can stop with "precision loss" far from a stationary point)
    h = 1e-5
    grad = np.array([(nll(res.x + h * e) - nll(res.x - h * e)) / (2 * h) for e in np.eye(len(res.x))])
    converged = bool(res.success and np.all(np.isfinite(grad)) and np.max(np.abs(grad)) < 1e-3)
    notes = [] if res.success else [f"optimiser: {res.message}"]
    if not converged:
        notes.append(f"not converged (max |gradient| = {np.max(np.abs(grad)):.2g})")
    if sigma < 1e-3:
        notes.append("sigma at the boundary (~0): no detectable recorder variation")
    return CovFit(name, X.shape[1] + 1, -float(res.fun), beta, columns, sigma, bool(np.isfinite(res.fun) and converged), notes)


def conditional_threshold(fit: CovFit, offset: float = 0.0, q: float = 0.99) -> float | None:
    """Logit-scale score where a typical recorder (u = 0) reaches q. `offset` adds covariate terms.
    Requires the score coefficient (column "score") to be positive."""
    i = fit.columns.index("score")
    b1 = fit.beta[i]
    if not fit.valid or b1 <= 0:
        return None
    return (np.log(q / (1 - q)) - fit.beta[0] - offset) / b1


def marginal_p(fit: CovFit, x: float, offset: float = 0.0) -> float:
    """pr(correct) at logit-score x for a recorder drawn at random: E_u[sigmoid(b0 + b1 x + u)]."""
    eta = fit.beta[0] + fit.beta[fit.columns.index("score")] * x + offset
    if fit.sigma <= 0:
        return float(expit(eta))
    u = np.sqrt(2) * fit.sigma * GH_NODES
    return float(np.sum(GH_WEIGHTS * expit(eta + u)) / np.sqrt(np.pi))


def marginal_threshold(fit: CovFit, offset: float = 0.0, q: float = 0.99, hi: float = 30.0) -> float | None:
    """Logit-scale score where a NEW recorder reaches q on average over recorders."""
    i = fit.columns.index("score")
    if not fit.valid or fit.beta[i] <= 0:
        return None
    f = lambda x: marginal_p(fit, x, offset) - q  # noqa: E731
    lo = -30.0
    if f(lo) > 0:
        return lo
    if f(hi) < 0:
        return None
    return float(brentq(f, lo, hi, xtol=1e-10))

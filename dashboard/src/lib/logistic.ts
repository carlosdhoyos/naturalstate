/**
 * Logistic regression with one predictor, fitted by IRLS (Newton–Raphson), the same
 * maximum-likelihood fit as R's glm(outcome ~ score, family = "binomial").
 *
 *   logit(p) = b0 + b1·x        threshold(q) = (ln(q / (1 − q)) − b0) / b1, q = target probability   (Wood & Kahl 2024)
 */

export interface LogitFit {
  b0: number
  b1: number
  /** Covariance matrix of (b0, b1): inverse of the Fisher information. */
  cov: [[number, number], [number, number]]
  /** Newton iterations reached the tolerance (raw convergence, regardless of separation). */
  converged: boolean
  /**
   * True when the outcomes are completely or quasi-completely separated by x: every clip correct
   * (or every clip wrong), or some score c splits them with all incorrect clips at x ≤ c and all
   * correct ones at x ≥ c (ties at c allowed). No finite maximum-likelihood estimate exists; the
   * reported coefficients are just where the iterations stopped.
   */
  separated: boolean
  /**
   * The fit can be used: converged, not separated, finite coefficients and covariance. Probabilities,
   * thresholds and intervals must only be derived from valid fits.
   */
  valid: boolean
  iterations: number
  n: number
}

export const sigmoid = (z: number) => 1 / (1 + Math.exp(-z))
export const logit = (p: number) => Math.log(p / (1 - p))

export function fitLogistic(x: number[], y: number[], maxIter = 60): LogitFit {
  const n = x.length
  const ones = y.filter((v) => v === 1).length
  // Perfect separation check (also covers "all 1s" / "all 0s").
  let max0 = -Infinity
  let min1 = Infinity
  let max1 = -Infinity
  let min0 = Infinity
  for (let i = 0; i < n; i++) {
    if (y[i] === 1) {
      min1 = Math.min(min1, x[i])
      max1 = Math.max(max1, x[i])
    } else {
      max0 = Math.max(max0, x[i])
      min0 = Math.min(min0, x[i])
    }
  }
  // ≤ (not <) also catches quasi-complete separation, where the two outcomes only meet at one score
  const separated = ones === 0 || ones === n || max0 <= min1 || max1 <= min0

  let b0 = 0
  let b1 = 0
  let converged = false
  let it = 0
  let cov: LogitFit['cov'] = [
    [NaN, NaN],
    [NaN, NaN],
  ]
  for (; it < maxIter; it++) {
    // Fisher information H = X'WX and score g = X'(y − p)
    let h00 = 0
    let h01 = 0
    let h11 = 0
    let g0 = 0
    let g1 = 0
    for (let i = 0; i < n; i++) {
      const p = sigmoid(b0 + b1 * x[i])
      const w = Math.max(p * (1 - p), 1e-12)
      h00 += w
      h01 += w * x[i]
      h11 += w * x[i] * x[i]
      g0 += y[i] - p
      g1 += (y[i] - p) * x[i]
    }
    const det = h00 * h11 - h01 * h01
    if (!(Math.abs(det) > 1e-300)) break
    cov = [
      [h11 / det, -h01 / det],
      [-h01 / det, h00 / det],
    ]
    const d0 = cov[0][0] * g0 + cov[0][1] * g1
    const d1 = cov[1][0] * g0 + cov[1][1] * g1
    b0 += d0
    b1 += d1
    if (!Number.isFinite(b0) || !Number.isFinite(b1) || Math.abs(b0) > 50 || Math.abs(b1) > 50) break
    if (Math.abs(d0) < 1e-9 && Math.abs(d1) < 1e-9) {
      converged = true
      break
    }
  }
  const finite = [b0, b1, cov[0][0], cov[0][1], cov[1][1]].every(Number.isFinite) && cov[0][0] > 0 && cov[1][1] > 0
  return { b0, b1, cov, converged, separated, valid: converged && !separated && finite, iterations: it + 1, n }
}

/**
 * Score at which the fitted probability equals pStar, with a delta-method 95% interval.
 * Returns null for an invalid fit (separated / not converged) or a non-increasing curve.
 */
export function thresholdFor(fit: LogitFit, pStar: number): { x: number; lo: number; hi: number } | null {
  if (!fit.valid || !(fit.b1 > 0)) return null
  const L = logit(pStar)
  const x = (L - fit.b0) / fit.b1
  // gradient of x w.r.t. (b0, b1)
  const g0 = -1 / fit.b1
  const g1 = -(L - fit.b0) / (fit.b1 * fit.b1)
  const v = g0 * g0 * fit.cov[0][0] + 2 * g0 * g1 * fit.cov[0][1] + g1 * g1 * fit.cov[1][1]
  const se = Math.sqrt(Math.max(v, 0))
  return { x, lo: x - 1.96 * se, hi: x + 1.96 * se }
}

/** Small seeded PRNG (mulberry32) so simulations are reproducible. */
export function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

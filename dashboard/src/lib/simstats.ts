/** Small numerical helpers for the method simulations (all deterministic given a seeded RNG). */

export type RNG = () => number

/** Standard normal via Box–Muller. */
export function normal(r: RNG): number {
  const u = Math.max(r(), 1e-12)
  const v = r()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

/** Gamma(shape, 1) — Marsaglia & Tsang (2000); shape < 1 handled by the boost trick. */
export function gamma(r: RNG, shape: number): number {
  if (shape < 1) return gamma(r, shape + 1) * Math.pow(Math.max(r(), 1e-12), 1 / shape)
  const d = shape - 1 / 3
  const c = 1 / Math.sqrt(9 * d)
  for (;;) {
    let x: number
    let v: number
    do {
      x = normal(r)
      v = 1 + c * x
    } while (v <= 0)
    v = v * v * v
    const u = r()
    if (u < 1 - 0.0331 * x ** 4 || Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v
  }
}

export function beta(r: RNG, a: number, b: number): number {
  const x = gamma(r, a)
  const y = gamma(r, b)
  return x / (x + y)
}

/** Standard normal CDF (Abramowitz–Stegun 7.1.26). */
export function phi(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2)
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(x * x) / 2)
  return x >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y)
}

const lnFact: number[] = [0]
function logFactorial(n: number): number {
  for (let i = lnFact.length; i <= n; i++) lnFact[i] = lnFact[i - 1] + Math.log(i)
  return lnFact[n]
}

export function binomPmf(k: number, n: number, p: number): number {
  if (p <= 0) return k === 0 ? 1 : 0
  if (p >= 1) return k === n ? 1 : 0
  return Math.exp(logFactorial(n) - logFactorial(k) - logFactorial(n - k) + k * Math.log(p) + (n - k) * Math.log(1 - p))
}

/** Nelder–Mead minimiser (unconstrained; transform parameters before calling). */
export function nelderMead(f: (x: number[]) => number, x0: number[], step = 0.5, iters = 400): number[] {
  const n = x0.length
  let pts = [x0, ...x0.map((_, i) => x0.map((v, j) => (i === j ? v + step : v)))]
  let vals = pts.map(f)
  for (let it = 0; it < iters; it++) {
    const order = vals.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0]).map(([, i]) => i)
    pts = order.map((i) => pts[i])
    vals = order.map((i) => vals[i])
    if (Math.abs(vals[n] - vals[0]) < 1e-10) break
    const cen = Array.from({ length: n }, (_, j) => pts.slice(0, n).reduce((a, p) => a + p[j], 0) / n)
    const along = (t: number) => cen.map((c, j) => c + t * (pts[n][j] - c))
    const xr = along(-1)
    const fr = f(xr)
    if (fr < vals[0]) {
      const xe = along(-2)
      const fe = f(xe)
      ;[pts[n], vals[n]] = fe < fr ? [xe, fe] : [xr, fr]
    } else if (fr < vals[n - 1]) {
      ;[pts[n], vals[n]] = [xr, fr]
    } else {
      const xc = along(0.5)
      const fc = f(xc)
      if (fc < vals[n]) [pts[n], vals[n]] = [xc, fc]
      else {
        pts = pts.map((p, i) => (i === 0 ? p : p.map((v, j) => pts[0][j] + 0.5 * (v - pts[0][j]))))
        vals = pts.map(f)
      }
    }
  }
  return pts[vals.indexOf(Math.min(...vals))]
}

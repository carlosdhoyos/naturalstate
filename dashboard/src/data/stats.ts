/** Small, dependency-free statistics and formatting helpers. */

export type Transform = 'none' | 'log10' | 'logit'

/** Confidence scores of exactly 0 or 1 would map to ±∞ under logit; clamp to [ε, 1-ε]. */
export const LOGIT_EPS = 1e-4

export function applyTransform(v: number, t: Transform): number {
  if (t === 'log10') return v > 0 ? Math.log10(v) : NaN
  if (t === 'logit') {
    const p = Math.min(1 - LOGIT_EPS, Math.max(LOGIT_EPS, v))
    return Math.log(p / (1 - p))
  }
  return v
}

export function invertTransform(v: number, t: Transform): number {
  if (t === 'log10') return 10 ** v
  if (t === 'logit') return 1 / (1 + Math.exp(-v))
  return v
}

export const TRANSFORM_LABEL: Record<Transform, string> = { none: '', log10: 'log₁₀', logit: 'logit' }

export function quantileSorted(s: number[], p: number): number {
  if (!s.length) return NaN
  const i = (s.length - 1) * p
  const lo = Math.floor(i)
  const hi = Math.ceil(i)
  return s[lo] + (s[hi] - s[lo]) * (i - lo)
}

export interface Summary {
  n: number
  min: number
  q1: number
  median: number
  q3: number
  max: number
  mean: number
  sd: number
}

export function summarize(values: number[]): Summary {
  const s = values.filter(Number.isFinite).sort((a, b) => a - b)
  const n = s.length
  if (!n) return { n: 0, min: NaN, q1: NaN, median: NaN, q3: NaN, max: NaN, mean: NaN, sd: NaN }
  let sum = 0
  for (const v of s) sum += v
  const mean = sum / n
  let ss = 0
  for (const v of s) ss += (v - mean) ** 2
  return {
    n,
    min: s[0],
    q1: quantileSorted(s, 0.25),
    median: quantileSorted(s, 0.5),
    q3: quantileSorted(s, 0.75),
    max: s[n - 1],
    mean,
    sd: n > 1 ? Math.sqrt(ss / (n - 1)) : 0,
  }
}

/** A "nice" step (1, 2, 2.5, 5 × 10^k) so bin edges land on readable numbers. */
export function niceStep(span: number, target: number): number {
  if (!(span > 0)) return 1
  const raw = span / Math.max(1, target)
  const mag = 10 ** Math.floor(Math.log10(raw))
  const norm = raw / mag
  const step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10
  return step * mag
}

/** Bin edges covering [min, max] with roughly `target` bins on nice boundaries. */
export function binEdges(min: number, max: number, target: number): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return []
  if (min === max) return [min - 0.5, max + 0.5]
  const step = niceStep(max - min, target)
  const start = Math.floor(min / step) * step
  const edges: number[] = []
  for (let e = start; e <= max + step * 1e-9; e += step) edges.push(+e.toPrecision(12))
  if (edges[edges.length - 1] <= max) edges.push(+(edges[edges.length - 1] + step).toPrecision(12))
  return edges
}

export function binIndex(v: number, edges: number[]): number {
  if (edges.length < 2 || v < edges[0] || v > edges[edges.length - 1]) return -1
  let lo = 0
  let hi = edges.length - 2
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (edges[mid] <= v) lo = mid
    else hi = mid - 1
  }
  return lo
}

/** Wilson score interval for a binomial proportion (95% by default) — sane at p = 0 or 1. */
export function wilson(k: number, n: number, z = 1.96): [number, number] {
  if (!n) return [NaN, NaN]
  const p = k / n
  const d = 1 + (z * z) / n
  const c = (p + (z * z) / (2 * n)) / d
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d
  return [Math.max(0, c - h), Math.min(1, c + h)]
}

export type Agg = 'count' | 'share' | 'mean' | 'median' | 'sum' | 'min' | 'max'

export function aggregate(values: number[], agg: Agg): number {
  const v = values.filter(Number.isFinite)
  if (agg === 'count') return values.length
  if (!v.length) return NaN
  switch (agg) {
    case 'sum':
      return v.reduce((a, b) => a + b, 0)
    case 'mean':
      return v.reduce((a, b) => a + b, 0) / v.length
    case 'median':
      return quantileSorted([...v].sort((a, b) => a - b), 0.5)
    case 'min':
      return Math.min(...v)
    case 'max':
      return Math.max(...v)
    default:
      return v.length
  }
}

// ── formatting ────────────────────────────────────────────────────────────────

const intFmt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 })

export function fmtNum(v: number | null | undefined, digits = 4): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '—'
  if (!Number.isFinite(v)) return v > 0 ? '∞' : '−∞'
  if (Number.isInteger(v) && Math.abs(v) < 1e15) return intFmt.format(v)
  const a = Math.abs(v)
  if (a >= 1e5 || a < 1e-3) return v.toExponential(2)
  return new Intl.NumberFormat('en-US', { maximumSignificantDigits: digits }).format(v)
}

export const fmtInt = (v: number) => intFmt.format(v)

export function fmtPct(v: number, digits = 1): string {
  if (!Number.isFinite(v)) return '—'
  return `${(v * 100).toFixed(digits)}%`
}

/** Datetimes are stored as epoch ms and shown in UTC so nothing shifts with the viewer's timezone. */
export function fmtDate(ms: number | null | undefined, withTime = true): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—'
  const iso = new Date(ms).toISOString()
  return withTime ? `${iso.slice(0, 10)} ${iso.slice(11, 16)}` : iso.slice(0, 10)
}

export function fmtDuration(ms: number): string {
  const h = ms / 3_600_000
  if (h >= 48) return `${(h / 24).toFixed(1)} days`
  if (h >= 1) return `${h.toFixed(1)} h`
  return `${(ms / 60_000).toFixed(0)} min`
}

export const isoUTC = (ms: number) => new Date(ms).toISOString().replace('Z', '')

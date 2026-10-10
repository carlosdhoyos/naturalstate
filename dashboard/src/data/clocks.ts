/**
 * Infer each recorder's clock offset from bird activity. A diurnal singer (Oriole) starts at dawn,
 * a nocturnal species (Nightjar) is active after dusk; a recorder whose activity is shifted by the
 * same amount relative to the rest of the network has a wrong clock, not unusual birds.
 */
import type { Row } from './types'

export const ORIOLE = 'African Black-headed Oriole'
export const NIGHTJAR = 'Abyssinian Nightjar'

export const hourOfMs = (ms: number) => (((ms % 86_400_000) + 86_400_000) % 86_400_000) / 3_600_000

export function circMean(hs: number[]) {
  const s = hs.reduce((a, h) => a + Math.sin((2 * Math.PI * h) / 24), 0)
  const c = hs.reduce((a, h) => a + Math.cos((2 * Math.PI * h) / 24), 0)
  return ((Math.atan2(s, c) * 24) / (2 * Math.PI) + 24) % 24
}
/** 5th percentile of morning (before noon) detections — the dawn onset. Needs ≥ 20. */
export function dawnOnset(hs: number[]) {
  const m = hs.filter((h) => h < 12).sort((a, b) => a - b)
  return m.length >= 20 ? m[Math.floor(0.05 * m.length)] : null
}
/** 5th percentile of evening (after noon) detections — the dusk onset. Needs ≥ 20. */
export function duskOnset(hs: number[]) {
  const m = hs.filter((h) => h >= 12).sort((a, b) => a - b)
  return m.length >= 20 ? m[Math.floor(0.05 * m.length)] : null
}
export const wrapDiff = (a: number, b: number) => ((a - b + 36) % 24) - 12

export interface ClockRow {
  rec: string
  nO: number
  nN: number
  on: number | null
  nm: number | null
  dO: number | null
  dN: number | null
  strong: boolean
  weak: boolean
  /** Hours to ADD to the recorder clock to get network (local) time; 0 unless strong evidence. */
  correction: number
}

/**
 * Rows need: folder (recorder), common_name, and an hour-of-day getter on the recorder clock.
 */
export function inferClocks(rows: Row[], hourOf: (r: Row) => number | null) {
  const recs = new Map<string, { o: number[]; n: number[] }>()
  for (const r of rows) {
    const h = hourOf(r)
    if (h === null) continue
    const k = String(r.folder)
    if (!recs.has(k)) recs.set(k, { o: [], n: [] })
    if (r.common_name === ORIOLE) recs.get(k)!.o.push(h)
    if (r.common_name === NIGHTJAR) recs.get(k)!.n.push(h)
  }
  const allN = [...recs.values()].flatMap((x) => x.n)
  const refN = circMean(allN)
  const onsets = [...recs.values()].map((x) => dawnOnset(x.o)).filter((x): x is number => x !== null).sort((a, b) => a - b)
  const refO = onsets[Math.floor(onsets.length / 2)]
  const clock: ClockRow[] = [...recs.entries()]
    .map(([rec, x]) => {
      const on = dawnOnset(x.o)
      const nm = x.n.length >= 20 ? circMean(x.n) : null
      const dO = on === null ? null : on - refO
      const dN = nm === null ? null : wrapDiff(nm, refN)
      // strong: the sharp indicator (dawn onset) is off by ≥ 2 h, and the nocturnal one agrees or is unavailable
      const strong = dO !== null && Math.abs(dO) >= 2 && (dN === null || (Math.abs(dN) >= 2 && Math.sign(dN) === Math.sign(dO)))
      const weak = !strong && ((dN !== null && Math.abs(dN) >= 2) || (dO !== null && Math.abs(dO) >= 2))
      return { rec, nO: x.o.length, nN: x.n.length, on, nm, dO, dN, strong, weak, correction: strong ? -Math.round(dO!) : 0 }
    })
    .filter((c) => c.on !== null || c.nm !== null)
    .sort((a, b) => a.rec.localeCompare(b.rec))
  return { clock, refO, refN, corrections: new Map(clock.filter((c) => c.strong).map((c) => [c.rec, c.correction])) }
}

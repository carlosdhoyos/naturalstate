/** Sunrise / sunset / solar noon (NOAA approximation, altitude −0.833°), in decimal hours UTC. */
export function sunTimesUTC(lat: number, lon: number, dayUTC: number): { rise: number; set: number; noon: number } {
  const d = new Date(dayUTC)
  const start = Date.UTC(d.getUTCFullYear(), 0, 1)
  const n = Math.floor((dayUTC - start) / 86_400_000) + 1
  const g = ((2 * Math.PI) / 365) * (n - 1)
  const eq = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g))
  const decl =
    0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) - 0.006758 * Math.cos(2 * g) + 0.000907 * Math.sin(2 * g) - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g)
  const rad = Math.PI / 180
  const ha = Math.acos(Math.cos(90.833 * rad) / (Math.cos(lat * rad) * Math.cos(decl)) - Math.tan(lat * rad) * Math.tan(decl)) / rad
  const wrap = (h: number) => ((h % 24) + 24) % 24
  return { rise: wrap((720 - 4 * (lon + ha) - eq) / 60), set: wrap((720 - 4 * (lon - ha) - eq) / 60), noon: wrap((720 - 4 * lon - eq) / 60) }
}

/** Mean sunrise/sunset over a date range (epoch ms, inclusive). */
export function meanSun(lat: number, lon: number, fromMs: number, toMs: number) {
  let r = 0
  let s = 0
  let k = 0
  for (let t = fromMs; t <= toMs; t += 86_400_000) {
    const x = sunTimesUTC(lat, lon, t)
    r += x.rise
    s += x.set
    k++
  }
  return { rise: r / k, set: s / k }
}

export const CANDIDATE_SITES = [
  { key: 'lewa', label: 'Lewa, Kenya', lat: 0.22, lon: 37.48, note: 'site of the vegetation project' },
  { key: 'nairobi', label: 'Nairobi, Kenya', lat: -1.29, lon: 36.82, note: '' },
  { key: 'ntz', label: 'Northern Tanzania', lat: -3.37, lon: 36.68, note: '' },
  { key: 'eth', label: 'Ethiopian highlands', lat: 9.0, lon: 38.7, note: 'Abyssinian Nightjar heartland' },
]

/** East Africa Time: UTC+3 all year (no daylight saving). */
export const EAT_OFFSET_H = 3

export const fmtClock = (h: number) => {
  const w = ((h % 24) + 24) % 24
  const hh = Math.floor(w)
  let mm = Math.round((w - hh) * 60)
  let H = hh
  if (mm === 60) {
    mm = 0
    H = (hh + 1) % 24
  }
  return `${String(H).padStart(2, '0')}:${String(mm).padStart(2, '0')}`
}

/**
 * Chart engine: ChartSpec + filtered rows → Plotly figure + the table behind it.
 *
 * All binning/aggregation happens here (not inside Plotly) so that:
 *  - every chart has an exact "data behind this chart" table twin,
 *  - every bar / bin / cell knows which filter it represents (click → filter),
 *  - colors follow the entity (category order from the full dataset), never its rank.
 */
import { categoryOrder, isDiscrete, keyOf, naturalCompare, type Filter } from '../data/filter'
import { tokens } from '../data/load'
import {
  aggregate,
  applyTransform,
  binEdges,
  binIndex,
  fmtDate,
  fmtNum,
  invertTransform,
  isoUTC,
  summarize,
  TRANSFORM_LABEL,
  wilson,
  type Agg,
  type Transform,
} from '../data/stats'
import { NULL_KEY, type Column, type Dataset, type Row } from '../data/types'
import { MAX_SERIES, OTHER, SERIES, SYMBOLS, sequentialScale, type ThemeTokens } from '../lib/palette'

export type ChartKind = 'histogram' | 'bar' | 'line' | 'box' | 'violin' | 'strip' | 'scatter' | 'ecdf' | 'heatmap'
export type TimeUnit = 'hour' | 'day' | 'week' | 'month'

export interface ChartSpec {
  kind: ChartKind
  x: string | null
  y: string | null
  z: string | null
  color: string | null
  facet: string | null
  agg: Agg
  bins: number
  xTransform: Transform
  yTransform: Transform
  norm: 'count' | 'percent' | 'density'
  barmode: 'overlay' | 'stack' | 'group'
  logY: boolean
  topN: number
  sort: 'value' | 'label'
  horizontal: boolean
  timeUnit: TimeUnit
  jitterX: number
  jitterY: number
  opacity: number
  trend: boolean
  /** Binned mean per color group instead of over all points in the panel. */
  trendByGroup: boolean
  sharedY: boolean
}

export const DEFAULT_SPEC: ChartSpec = {
  kind: 'histogram',
  x: null,
  y: null,
  z: null,
  color: null,
  facet: null,
  agg: 'count',
  bins: 30,
  xTransform: 'none',
  yTransform: 'none',
  norm: 'count',
  barmode: 'overlay',
  logY: false,
  topN: 25,
  sort: 'value',
  horizontal: false,
  timeUnit: 'day',
  jitterX: 0,
  jitterY: 0,
  opacity: 0.7,
  trend: false,
  trendByGroup: false,
  sharedY: true,
}

/** A filter without its id (distributes over the Filter union so each variant keeps its fields). */
export type FilterSeed = Filter extends infer F ? (F extends Filter ? Omit<F, 'id'> : never) : never
type Cell = string | number | null

export interface Figure {
  data: object[]
  layout: Record<string, unknown>
  table: { columns: string[]; rows: Cell[][] }
  /** customdata index → filters to add when that mark is clicked. */
  clicks: FilterSeed[][]
  message?: string
  height: number
}

// ── column roles ──────────────────────────────────────────────────────────────

export type Role = 'x' | 'y' | 'z' | 'color' | 'facet'

export function allowedColumns(ds: Dataset, kind: ChartKind, role: Role): Column[] {
  const ok = (c: Column): boolean => {
    const num = c.type === 'number'
    const cont = num || c.type === 'datetime'
    const disc = isDiscrete(c)
    switch (role) {
      case 'color':
        return disc || (kind === 'scatter' && num)
      case 'facet':
        return disc
      case 'z':
        return num
      case 'x':
        if (kind === 'histogram' || kind === 'ecdf' || kind === 'scatter') return cont
        if (kind === 'line') return cont
        if (kind === 'box' || kind === 'violin' || kind === 'strip') return disc
        return c.type !== 'text' || c.distinct <= 2000 // bar, heatmap
      case 'y':
        if (kind === 'heatmap') return c.type !== 'text' || c.distinct <= 2000
        if (kind === 'scatter') return cont
        return num
    }
  }
  return ds.columns.filter((c) => c.nonNull > 0 && c.distinct > 0 && ok(c))
}

export const KIND_NEEDS: Record<ChartKind, Role[]> = {
  histogram: ['x'],
  ecdf: ['x'],
  bar: ['x'],
  line: ['x'],
  box: ['y'],
  violin: ['y'],
  strip: ['y'],
  scatter: ['x', 'y'],
  heatmap: ['x', 'y'],
}

// ── grouping (color / facet) ──────────────────────────────────────────────────

interface Grouping {
  keys: string[] // keys present, in stable order
  keyOf: (r: Row) => string
  color: (k: string) => string
  symbol: (k: string) => string
  label: (k: string) => string
}

const OTHER_KEY = 'Other'

function grouping(ds: Dataset, colName: string | null, rows: Row[], t: ThemeTokens, cap = MAX_SERIES): Grouping {
  const series = SERIES[t.theme]
  if (!colName) {
    return { keys: ['all'], keyOf: () => 'all', color: () => series[0], symbol: () => SYMBOLS[0], label: () => 'All rows' }
  }
  const col = ds.columns.find((c) => c.name === colName)!
  const order = categoryOrder(ds, colName).filter((k) => k !== NULL_KEY)
  const top = order.slice(0, cap)
  const slot = new Map(top.map((k, i) => [k, i]))
  const kOf = (r: Row) => {
    const k = keyOf(r[colName])
    return k === NULL_KEY ? NULL_KEY : slot.has(k) ? k : OTHER_KEY
  }
  const present = new Set(rows.map(kOf))
  const keys = [...top.filter((k) => present.has(k)), ...[OTHER_KEY, NULL_KEY].filter((k) => present.has(k))]
  const fmt = (k: string) => (col.type === 'number' && k !== NULL_KEY && k !== OTHER_KEY ? fmtNum(Number(k)) : k)
  return {
    keys,
    keyOf: kOf,
    color: (k) => (slot.has(k) && slot.get(k)! < series.length ? series[slot.get(k)!] : k === NULL_KEY ? (t.theme === 'dark' ? '#8a9ba3' : '#5f6f77') : OTHER[t.theme]),
    symbol: (k) => (slot.has(k) ? SYMBOLS[slot.get(k)!] : 'circle-open'),
    label: (k) => (k === OTHER_KEY ? `Other (${order.length - top.length})` : fmt(k)),
  }
}

// ── buckets (x / y axis of bar, line, histogram, heatmap) ─────────────────────

interface Bucket {
  label: string
  pos: string | number
  seed: FilterSeed | null
  width?: number
}
interface Buckets {
  list: Bucket[]
  ids: (r: Row) => number[]
  kind: 'category' | 'numeric' | 'time'
  edges?: number[]
}

const UNIT_MS: Record<TimeUnit, number> = { hour: 3_600_000, day: 86_400_000, week: 7 * 86_400_000, month: 30 * 86_400_000 }

function floorTime(ms: number, u: TimeUnit): number {
  const d = new Date(ms)
  if (u === 'hour') return Math.floor(ms / 3_600_000) * 3_600_000
  if (u === 'day') return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
  if (u === 'week') {
    const day = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
    return day - ((d.getUTCDay() + 6) % 7) * 86_400_000 // Monday
  }
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)
}
function nextTime(ms: number, u: TimeUnit): number {
  if (u === 'month') {
    const d = new Date(ms)
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)
  }
  return ms + UNIT_MS[u]
}

function isSmallInteger(rows: Row[], col: Column): boolean {
  if (col.type !== 'number' || col.distinct > 40) return false
  return rows.every((r) => r[col.name] === null || Number.isInteger(r[col.name] as number))
}

function bucketize(
  rows: Row[],
  col: Column,
  spec: ChartSpec,
  transform: Transform,
  opts: { continuous?: boolean; valueOrder?: Map<string, number> } = {},
): Buckets {
  const name = col.name
  // time buckets
  if (col.type === 'datetime') {
    let unit = spec.timeUnit
    const vals = rows.map((r) => r[name]).filter((v): v is number => typeof v === 'number')
    const min = Math.min(...vals)
    const max = Math.max(...vals)
    const units: TimeUnit[] = ['hour', 'day', 'week', 'month']
    while ((max - min) / UNIT_MS[unit] > 1500 && unit !== 'month') unit = units[units.indexOf(unit) + 1]
    const list: Bucket[] = []
    const idx = new Map<number, number>()
    if (vals.length) {
      for (let s = floorTime(min, unit); s <= max; s = nextTime(s, unit)) {
        idx.set(s, list.length)
        const e = nextTime(s, unit)
        list.push({
          label: unit === 'hour' ? fmtDate(s) : unit === 'month' ? fmtDate(s, false).slice(0, 7) : fmtDate(s, false),
          pos: isoUTC(s),
          width: e - s,
          seed: { column: name, kind: 'range', min: s, max: e - 1 },
        })
      }
    }
    return {
      list,
      kind: 'time',
      ids: (r) => {
        const v = r[name]
        return typeof v === 'number' ? [idx.get(floorTime(v, unit))!] : []
      },
    }
  }

  // numeric bins
  if (col.type === 'number' && (opts.continuous || !isSmallInteger(rows, col)) && !(col.distinct <= 12 && !opts.continuous)) {
    const tv = rows.map((r) => (typeof r[name] === 'number' ? applyTransform(r[name] as number, transform) : NaN)).filter(Number.isFinite)
    let min = Infinity
    let max = -Infinity
    for (const v of tv) {
      if (v < min) min = v
      if (v > max) max = v
    }
    const edges = binEdges(min, max, spec.bins)
    const list: Bucket[] = []
    for (let i = 0; i < edges.length - 1; i++) {
      const lo = edges[i]
      const hi = edges[i + 1]
      const rawLo = invertTransform(lo, transform)
      const rawHi = invertTransform(hi, transform)
      list.push({
        label: transform === 'none' ? `${fmtNum(lo)} – ${fmtNum(hi)}` : `${fmtNum(rawLo, 3)} – ${fmtNum(rawHi, 3)} (${TRANSFORM_LABEL[transform]} ${fmtNum(lo, 3)} – ${fmtNum(hi, 3)})`,
        pos: (lo + hi) / 2,
        width: hi - lo,
        seed: { column: name, kind: 'range', min: rawLo, max: rawHi },
      })
    }
    return {
      list,
      edges,
      kind: 'numeric',
      ids: (r) => {
        const v = r[name]
        if (typeof v !== 'number') return []
        const i = binIndex(applyTransform(v, transform), edges)
        return i >= 0 ? [i] : []
      },
    }
  }

  // categories (incl. multi-select tokens and small integer codes)
  const counts = new Map<string, number>()
  const keysOf = (r: Row): string[] => {
    if (col.type === 'multi') {
      const t = tokens(r[name], col.sep)
      return t.length ? t : [NULL_KEY]
    }
    return [keyOf(r[name])]
  }
  for (const r of rows) for (const k of keysOf(r)) counts.set(k, (counts.get(k) ?? 0) + 1)
  let keys = [...counts.keys()]
  const numericKeys = col.type === 'number'
  if (spec.sort === 'label' || numericKeys) keys.sort(naturalCompare)
  else if (opts.valueOrder) keys.sort((a, b) => (opts.valueOrder!.get(b) ?? -Infinity) - (opts.valueOrder!.get(a) ?? -Infinity))
  else keys.sort((a, b) => counts.get(b)! - counts.get(a)! || naturalCompare(a, b))
  // keep (empty) visible but last
  keys = [...keys.filter((k) => k !== NULL_KEY), ...keys.filter((k) => k === NULL_KEY)]
  const top = keys.slice(0, spec.topN)
  const folded = keys.length - top.length
  const idx = new Map(top.map((k, i) => [k, i]))
  const list: Bucket[] = top.map((k) => {
    const label = numericKeys && k !== NULL_KEY ? fmtNum(Number(k)) : k
    let seed: FilterSeed | null
    if (col.type === 'number') {
      seed = k === NULL_KEY ? null : { column: name, kind: 'in', values: [k] }
    } else seed = { column: name, kind: 'in', values: [k] }
    return { label, pos: label, seed }
  })
  if (folded > 0) list.push({ label: `Other (${folded})`, pos: `Other (${folded})`, seed: null })
  return {
    list,
    kind: 'category',
    ids: (r) => keysOf(r).map((k) => (idx.has(k) ? idx.get(k)! : folded > 0 ? list.length - 1 : -1)).filter((i) => i >= 0),
  }
}

// ── layout helpers ────────────────────────────────────────────────────────────

function axisStyle(t: ThemeTokens): Record<string, unknown> {
  return {
    gridcolor: t.grid,
    linecolor: t.axis,
    zeroline: false,
    showline: true,
    ticks: 'outside',
    ticklen: 3,
    tickcolor: t.axis,
    tickfont: { color: t.muted, size: 11 },
    title: { font: { color: t.ink2, size: 12 }, standoff: 8 },
    automargin: true,
  }
}

function baseLayout(t: ThemeTokens): Record<string, unknown> {
  return {
    paper_bgcolor: t.surface,
    plot_bgcolor: t.surface,
    font: { family: t.font, color: t.ink2, size: 12 },
    margin: { l: 56, r: 20, t: 36, b: 48 },
    hoverlabel: { bgcolor: t.surface, bordercolor: t.axis, font: { family: t.font, color: t.ink, size: 12 }, align: 'left' },
    legend: { orientation: 'h', x: 0, y: 1.0, yanchor: 'bottom', font: { color: t.ink2, size: 12 }, bgcolor: 'rgba(0,0,0,0)', itemclick: 'toggle', itemdoubleclick: 'toggleothers' },
    hovermode: 'closest',
    bargap: 0.08,
    bargroupgap: 0.04,
    dragmode: 'zoom',
  }
}

interface Panel {
  key: string | null
  title: string
  rows: Row[]
  xa: string
  ya: string
  first: boolean
  bottom: boolean
  left: boolean
}

function panels(ds: Dataset, spec: ChartSpec, rows: Row[], t: ThemeTokens, layout: Record<string, unknown>, xBase: object, yBase: object) {
  if (!spec.facet) {
    layout.xaxis = { ...axisStyle(t), ...xBase }
    layout.yaxis = { ...axisStyle(t), ...yBase }
    return { list: [{ key: null, title: '', rows, xa: 'x', ya: 'y', first: true, bottom: true, left: true }] as Panel[], gridRows: 1 }
  }
  const g = grouping(ds, spec.facet, rows, t, 12)
  const byKey = new Map<string, Row[]>()
  for (const r of rows) {
    const k = g.keyOf(r)
    if (!byKey.has(k)) byKey.set(k, [])
    byKey.get(k)!.push(r)
  }
  const keys = g.keys.filter((k) => byKey.has(k))
  const n = keys.length
  const cols = n <= 1 ? 1 : n <= 4 ? 2 : 3
  const nrows = Math.ceil(n / cols)
  layout.grid = { rows: nrows, columns: cols, pattern: 'independent', xgap: 0.08, ygap: n > cols ? 0.22 : 0.1 }
  const annotations: object[] = []
  const list: Panel[] = keys.map((k, i) => {
    const sfx = i === 0 ? '' : String(i + 1)
    const xa = `x${sfx}`
    const ya = `y${sfx}`
    const bottom = i >= n - cols
    const left = i % cols === 0
    layout[`xaxis${sfx}`] = { ...axisStyle(t), ...xBase, ...(i ? { matches: 'x' } : {}), ...(bottom ? {} : { title: { text: '' } }) }
    layout[`yaxis${sfx}`] = { ...axisStyle(t), ...yBase, ...(i && spec.sharedY ? { matches: 'y' } : {}), ...(left ? {} : { title: { text: '' } }) }
    const col = ds.columns.find((c) => c.name === spec.facet)
    annotations.push({
      text: `<b>${g.label(k)}</b> <span style="color:${t.muted}">· ${byKey.get(k)!.length.toLocaleString('en-US')} rows</span>`,
      xref: `${xa} domain`,
      yref: `${ya} domain`,
      x: 0,
      y: 1.02,
      xanchor: 'left',
      yanchor: 'bottom',
      showarrow: false,
      font: { size: 12, color: t.ink },
      hovertext: col?.name,
    })
    return { key: k, title: g.label(k), rows: byKey.get(k)!, xa, ya, first: i === 0, bottom, left }
  })
  layout.annotations = annotations
  // Facet titles sit just above each panel; push the legend clear of the first row's titles.
  layout.margin = { l: 56, r: 20, t: 64, b: 48 }
  layout.legend = { ...(layout.legend as object), y: 1 + 52 / (nrows * 260), yanchor: 'bottom' }
  return { list, gridRows: nrows }
}

const colLabel = (ds: Dataset, name: string | null, tr: Transform = 'none') => {
  const c = ds.columns.find((x) => x.name === name)
  const base = c?.label ?? name ?? ''
  return tr === 'none' ? base : `${TRANSFORM_LABEL[tr]}(${base})`
}

/** Deterministic jitter so points don't dance on every re-render. */
function hash01(i: number, salt: number): number {
  let h = (i + 1) * 374761393 + salt * 668265263
  h = (h ^ (h >>> 13)) * 1274126177
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295
}

const AGG_LABEL: Record<Agg, string> = { count: 'Count', share: 'Share (%)', mean: 'Mean', median: 'Median', sum: 'Sum', min: 'Min', max: 'Max' }

function isBinary(rows: Row[], col: string): boolean {
  let seen = false
  for (const r of rows) {
    const v = r[col]
    if (v === null) continue
    if (v !== 0 && v !== 1) return false
    seen = true
  }
  return seen
}

// ── main ──────────────────────────────────────────────────────────────────────

export function buildFigure(ds: Dataset, rows: Row[], spec: ChartSpec, t: ThemeTokens): Figure {
  const col = (n: string | null) => (n ? ds.columns.find((c) => c.name === n) ?? null : null)
  const empty = (message: string): Figure => ({ data: [], layout: baseLayout(t), table: { columns: [], rows: [] }, clicks: [], message, height: 420 })
  for (const role of KIND_NEEDS[spec.kind])
    if (!col(spec[role as 'x' | 'y']))
      return empty(
        allowedColumns(ds, spec.kind, role).length
          ? `Choose ${role.toUpperCase()} to draw this chart.`
          : `This table has no column a ${spec.kind} can use for ${role.toUpperCase()} — try a Bar chart or the Table tab.`,
      )
  if (!rows.length) return empty('No rows match the current filters.')

  const layout = baseLayout(t)
  const clicks: FilterSeed[][] = []
  const click = (seeds: (FilterSeed | null)[]) => {
    const s = seeds.filter(Boolean) as FilterSeed[]
    if (!s.length) return null
    clicks.push(s)
    return clicks.length - 1
  }
  const groups = grouping(ds, spec.color && col(spec.color) && isDiscrete(col(spec.color)!) ? spec.color : null, rows, t)
  const facetHeader = spec.facet ? [colLabel(ds, spec.facet)] : []
  const table: Figure['table'] = { columns: [], rows: [] }
  const data: Record<string, unknown>[] = []
  const shown = new Set<string>()
  const legendOnce = (k: string) => {
    const first = !shown.has(k)
    shown.add(k)
    return first && (groups.keys.length > 1 || k !== 'all')
  }
  const gName = (k: string) => (k === 'all' ? 'All rows' : groups.label(k))

  let gridRows = 1

  switch (spec.kind) {
    // ── histogram & bar & line: bucketed x, aggregated y ──
    case 'histogram':
    case 'bar':
    case 'line': {
      const xc = col(spec.x)!
      const yc = col(spec.y)
      const agg: Agg = spec.kind === 'histogram' ? 'count' : yc || spec.agg === 'share' || spec.agg === 'count' ? spec.agg : 'count'
      const xT = xc.type === 'number' ? spec.xTransform : 'none'
      const buckets = bucketize(rows, xc, spec, xT, { continuous: spec.kind === 'histogram' || spec.kind === 'line' })
      const rowB = new Map<Row, number[]>()
      for (const r of rows) rowB.set(r, buckets.ids(r))
      const isCat = buckets.kind === 'category'
      const horizontal = spec.kind === 'bar' && spec.horizontal
      const binaryY = !!yc && isBinary(rows, yc.name)
      const valueTitle =
        spec.kind === 'histogram'
          ? spec.norm === 'percent'
            ? 'Percent of group (%)'
            : spec.norm === 'density'
              ? 'Density'
              : 'Count'
          : agg === 'count' || agg === 'share'
            ? AGG_LABEL[agg]
            : `${AGG_LABEL[agg]} of ${colLabel(ds, spec.y)}`
      const catAxis = isCat ? { type: 'category', categoryorder: 'array', categoryarray: buckets.list.map((b) => b.pos) } : {}
      const xAxis = { title: { text: colLabel(ds, spec.x, xT) }, ...(buckets.kind === 'time' ? { type: 'date' } : {}), ...catAxis }
      const vAxis = { title: { text: valueTitle }, ...(spec.logY ? { type: 'log' } : {}), rangemode: 'tozero' }
      const pl = panels(ds, spec, rows, t, layout, horizontal ? { ...vAxis } : xAxis, horizontal ? { ...xAxis, autorange: 'reversed' } : vAxis)
      gridRows = pl.gridRows
      table.columns = [...facetHeader, colLabel(ds, spec.x, xT), ...(groups.keys.length > 1 ? [colLabel(ds, spec.color)] : []), 'n', valueTitle, ...(agg === 'mean' ? ['95% CI low', '95% CI high'] : [])]
      for (const p of pl.list) {
        const nB = buckets.list.length
        const perGroup = new Map<string, { n: number[]; vals: number[][] }>()
        for (const k of groups.keys) perGroup.set(k, { n: new Array(nB).fill(0), vals: Array.from({ length: nB }, () => []) })
        for (const r of p.rows) {
          const g = perGroup.get(groups.keyOf(r))!
          for (const b of rowB.get(r)!) {
            g.n[b]++
            if (yc && agg !== 'count' && agg !== 'share') {
              const v = r[yc.name]
              if (typeof v === 'number') g.vals[b].push(applyTransform(v, spec.yTransform))
            }
          }
        }
        const bucketTotals = new Array(nB).fill(0)
        for (const g of perGroup.values()) g.n.forEach((c, i) => (bucketTotals[i] += c))
        for (const k of groups.keys) {
          const g = perGroup.get(k)!
          const total = g.n.reduce((a, b) => a + b, 0)
          if (!total) continue
          const vals: (number | null)[] = []
          const lo: number[] = []
          const hi: number[] = []
          const text: string[] = []
          const cd: (number | null)[] = []
          buckets.list.forEach((b, i) => {
            let v: number | null
            if (spec.kind === 'histogram') {
              v = spec.norm === 'percent' ? (g.n[i] / total) * 100 : spec.norm === 'density' && b.width ? g.n[i] / (total * b.width) : g.n[i]
            } else if (agg === 'count') v = g.n[i]
            else if (agg === 'share') v = bucketTotals[i] ? (g.n[i] / bucketTotals[i]) * 100 : null
            else v = g.vals[i].length ? aggregate(g.vals[i], agg) : null
            let ci: [number, number] = [NaN, NaN]
            if (agg === 'mean' && g.vals[i].length) {
              if (binaryY && spec.yTransform === 'none') ci = wilson(g.vals[i].filter((x) => x === 1).length, g.vals[i].length)
              else {
                const s = summarize(g.vals[i])
                const h = s.n > 1 ? (1.96 * s.sd) / Math.sqrt(s.n) : NaN
                ci = [s.mean - h, s.mean + h]
              }
            }
            vals.push(v)
            lo.push(v !== null && Number.isFinite(ci[0]) ? v - ci[0] : 0)
            hi.push(v !== null && Number.isFinite(ci[1]) ? ci[1] - v : 0)
            const ciTxt = agg === 'mean' && Number.isFinite(ci[0]) ? `<br>95% CI ${fmtNum(ci[0], 3)} – ${fmtNum(ci[1], 3)}${binaryY ? ' (Wilson)' : ''}` : ''
            text.push(
              `<b>${b.label}</b>${groups.keys.length > 1 ? `<br>${gName(k)}` : ''}${p.key ? `<br>${p.title}` : ''}<br>${valueTitle}: <b>${fmtNum(v, 4)}</b>${
                spec.kind !== 'histogram' && agg !== 'count' ? `<br>n = ${g.n[i].toLocaleString('en-US')}` : ''
              }${ciTxt}`,
            )
            const seeds: (FilterSeed | null)[] = [b.seed]
            if (spec.color && k !== 'all' && k !== OTHER_KEY) seeds.push({ column: spec.color, kind: 'in', values: [k] })
            if (spec.facet && p.key && p.key !== OTHER_KEY) seeds.push({ column: spec.facet, kind: 'in', values: [p.key] })
            cd.push(click(seeds))
            if (g.n[i] > 0 || spec.kind !== 'histogram')
              table.rows.push([...(p.key ? [p.title] : []), b.label, ...(groups.keys.length > 1 ? [gName(k)] : []), g.n[i], v, ...(agg === 'mean' ? [Number.isFinite(ci[0]) ? ci[0] : null, Number.isFinite(ci[1]) ? ci[1] : null] : [])])
          })
          const pos = buckets.list.map((b) => b.pos)
          const color = groups.color(k)
          const multi = groups.keys.length > 1
          const common = {
            name: gName(k),
            legendgroup: k,
            showlegend: legendOnce(k),
            xaxis: p.xa,
            yaxis: p.ya,
            text,
            hovertemplate: '%{text}<extra></extra>',
            customdata: cd,
          }
          if (spec.kind === 'line') {
            data.push({
              ...common,
              type: 'scatter',
              mode: nB <= 80 ? 'lines+markers' : 'lines',
              x: pos,
              y: vals,
              line: { color, width: 2 },
              marker: { color, size: 6, line: { color: t.surface, width: 1 } },
              connectgaps: false,
              ...(agg === 'mean' ? { error_y: { type: 'data', symmetric: false, array: hi, arrayminus: lo, color, thickness: 1, width: 0 } } : {}),
            })
          } else {
            const errs = agg === 'mean' && spec.barmode !== 'stack' ? { type: 'data', symmetric: false, array: hi, arrayminus: lo, color: t.ink2, thickness: 1, width: 3 } : undefined
            data.push({
              ...common,
              type: 'bar',
              ...(horizontal ? { y: pos, x: vals, orientation: 'h', error_x: errs } : { x: pos, y: vals, error_y: errs }),
              textposition: 'none', // `text` feeds the tooltip only — never print it inside bars
              marker: { color, line: { width: 0 }, cornerradius: 3 },
              opacity: multi && spec.barmode === 'overlay' ? 0.6 : 1,
            })
          }
        }
      }
      if (spec.kind !== 'line') layout.barmode = groups.keys.length > 1 ? spec.barmode : 'overlay'
      if (spec.kind === 'histogram') layout.bargap = 0.03
      break
    }

    // ── distributions per category ──
    case 'box':
    case 'violin':
    case 'strip': {
      const yc = col(spec.y)!
      const xc = col(spec.x)
      const xG = xc ? grouping(ds, xc.name, rows, t, Math.max(1, Math.min(spec.topN, 30))) : null
      const colorIsX = !spec.color || spec.color === spec.x
      const yAxis = { title: { text: colLabel(ds, spec.y, spec.yTransform) }, ...(spec.logY ? { type: 'log' } : {}) }
      const xKeys = xG ? xG.keys : ['all']
      const xAxis = { title: { text: xc ? colLabel(ds, spec.x) : '' }, type: 'category', categoryorder: 'array', categoryarray: xKeys.map((k) => (xG ? xG.label(k) : '')) }
      if (spec.kind === 'strip') Object.assign(xAxis, { type: 'linear', tickvals: xKeys.map((_, i) => i), ticktext: xKeys.map((k) => (xG ? xG.label(k) : 'All rows')), range: [-0.6, xKeys.length - 0.4] })
      const pl = panels(ds, spec, rows, t, layout, xAxis, yAxis)
      gridRows = pl.gridRows
      table.columns = [...facetHeader, ...(xc ? [colLabel(ds, spec.x)] : []), ...(!colorIsX ? [colLabel(ds, spec.color)] : []), 'n', 'min', 'q1', 'median', 'mean', 'q3', 'max', 'sd']
      const traceGroups = colorIsX ? xKeys : groups.keys
      const xKeyOf = (r: Row) => (xG ? xG.keyOf(r) : 'all')
      const groupOf = (r: Row) => (colorIsX ? xKeyOf(r) : groups.keyOf(r))
      for (const p of pl.list) {
        for (const gk of traceGroups) {
          const rs = p.rows.filter((r) => groupOf(r) === gk && typeof r[yc.name] === 'number')
          if (!rs.length) continue
          // One series → one color: x categories are already named on the axis, so they are not re-encoded as hue.
          const color = colorIsX ? SERIES[t.theme][0] : groups.color(gk)
          const name = colorIsX ? (xG ? xG.label(gk) : 'All rows') : gName(gk)
          const yv = rs.map((r) => applyTransform(r[yc.name] as number, spec.yTransform))
          const xv = rs.map((r) => (xG ? xG.label(xKeyOf(r)) : ''))
          const base = { name, legendgroup: gk, showlegend: !colorIsX && legendOnce(gk), xaxis: p.xa, yaxis: p.ya }
          if (spec.kind === 'strip') {
            const xi = new Map(xKeys.map((k, i) => [k, i]))
            const offs = colorIsX ? 0 : (traceGroups.indexOf(gk) - (traceGroups.length - 1) / 2) * (0.7 / traceGroups.length)
            data.push({
              ...base,
              type: rs.length > 3000 ? 'scattergl' : 'scatter',
              mode: 'markers',
              x: rs.map((r, i) => xi.get(xKeyOf(r))! + offs + (hash01(i, 7) - 0.5) * (colorIsX ? 0.6 : 0.6 / traceGroups.length)),
              y: yv,
              marker: { color, size: 6, opacity: spec.opacity, line: { color: t.surface, width: 0.5 }, symbol: traceGroups.length > 3 ? groups.symbol(gk) : 'circle' },
              text: rs.map((r) => `${ds.labelColumn && r[ds.labelColumn] ? `<b>${r[ds.labelColumn]}</b><br>` : ''}${name}<br>${colLabel(ds, spec.y)}: ${fmtNum(r[yc.name] as number)}`),
              hovertemplate: '%{text}<extra></extra>',
            })
          } else if (spec.kind === 'box') {
            data.push({ ...base, type: 'box', x: xv, y: yv, marker: { color, size: 4, opacity: 0.6 }, line: { color, width: 1.5 }, fillcolor: `${color}33`, boxpoints: rs.length > 5000 ? false : 'outliers', boxmean: true, offsetgroup: colorIsX ? undefined : gk })
          } else {
            data.push({ ...base, type: 'violin', x: xv, y: yv, line: { color, width: 1.5 }, fillcolor: `${color}40`, points: false, box: { visible: true, width: 0.15 }, meanline: { visible: true }, spanmode: 'hard', offsetgroup: colorIsX ? undefined : gk, scalegroup: gk })
          }
          // summary per x within this trace group
          const byX = new Map<string, number[]>()
          rs.forEach((r, i) => {
            const k = xKeyOf(r)
            if (!byX.has(k)) byX.set(k, [])
            byX.get(k)!.push(yv[i])
          })
          for (const [xk, vals] of byX) {
            const s = summarize(vals)
            table.rows.push([...(p.key ? [p.title] : []), ...(xc ? [xG!.label(xk)] : []), ...(!colorIsX ? [name] : []), s.n, s.min, s.q1, s.median, s.mean, s.q3, s.max, s.sd])
          }
        }
      }
      if (spec.kind === 'box') layout.boxmode = colorIsX ? 'overlay' : 'group'
      if (spec.kind === 'violin') layout.violinmode = colorIsX ? 'overlay' : 'group'
      if (colorIsX) layout.showlegend = false
      break
    }

    // ── ECDF ──
    case 'ecdf': {
      const xc = col(spec.x)!
      const xT = xc.type === 'number' ? spec.xTransform : 'none'
      const isDate = xc.type === 'datetime'
      const pl = panels(ds, spec, rows, t, layout, { title: { text: colLabel(ds, spec.x, xT) }, ...(isDate ? { type: 'date' } : {}) }, { title: { text: 'Cumulative share (%)' }, range: [0, 101] })
      gridRows = pl.gridRows
      table.columns = [...facetHeader, ...(groups.keys.length > 1 ? [colLabel(ds, spec.color)] : []), 'n', 'p10', 'p25', 'median', 'p75', 'p90']
      for (const p of pl.list) {
        for (const k of groups.keys) {
          const v = p.rows
            .filter((r) => groups.keyOf(r) === k && typeof r[xc.name] === 'number')
            .map((r) => applyTransform(r[xc.name] as number, xT))
            .filter(Number.isFinite)
            .sort((a, b) => a - b)
          if (!v.length) continue
          const step = Math.max(1, Math.floor(v.length / 1500))
          const xs: (number | string)[] = []
          const ys: number[] = []
          for (let i = 0; i < v.length; i += step) {
            xs.push(isDate ? isoUTC(v[i]) : v[i])
            ys.push(((i + 1) / v.length) * 100)
          }
          xs.push(isDate ? isoUTC(v[v.length - 1]) : v[v.length - 1])
          ys.push(100)
          data.push({
            type: 'scatter',
            mode: 'lines',
            name: gName(k),
            legendgroup: k,
            showlegend: legendOnce(k),
            x: xs,
            y: ys,
            line: { color: groups.color(k), width: 2, shape: 'hv' },
            xaxis: p.xa,
            yaxis: p.ya,
            hovertemplate: `${gName(k)}<br>%{x}<br>%{y:.1f}% of rows ≤ x<extra></extra>`,
          })
          const q = (pp: number) => v[Math.min(v.length - 1, Math.floor(pp * (v.length - 1)))]
          table.rows.push([...(p.key ? [p.title] : []), ...(groups.keys.length > 1 ? [gName(k)] : []), v.length, q(0.1), q(0.25), q(0.5), q(0.75), q(0.9)])
        }
      }
      break
    }

    // ── scatter ──
    case 'scatter': {
      const xc = col(spec.x)!
      const yc = col(spec.y)!
      const xT = xc.type === 'number' ? spec.xTransform : 'none'
      const yT = yc.type === 'number' ? spec.yTransform : 'none'
      const cc = col(spec.color)
      const continuousColor = !!cc && !isDiscrete(cc) && cc.type === 'number'
      const xDate = xc.type === 'datetime'
      const yDate = yc.type === 'datetime'
      const pl = panels(
        ds,
        spec,
        rows,
        t,
        layout,
        { title: { text: colLabel(ds, spec.x, xT) }, ...(xDate ? { type: 'date' } : {}) },
        { title: { text: colLabel(ds, spec.y, yT) }, ...(yDate ? { type: 'date' } : {}), ...(spec.logY ? { type: 'log' } : {}) },
      )
      gridRows = pl.gridRows
      const pts = rows.filter((r) => typeof r[xc.name] === 'number' && typeof r[yc.name] === 'number')
      const tx = (r: Row) => applyTransform(r[xc.name] as number, xT)
      const ty = (r: Row) => applyTransform(r[yc.name] as number, yT)
      const range = (f: (r: Row) => number) => {
        const v = pts.map(f).filter(Number.isFinite)
        return v.length ? Math.max(...v) - Math.min(...v) || 1 : 1
      }
      const rx = range(tx)
      const ry = range(ty)
      const gl = pts.length > 4000
      const useSymbols = groups.keys.length > 3
      const edges = spec.trend ? binEdges(Math.min(...pts.map(tx).filter(Number.isFinite)), Math.max(...pts.map(tx).filter(Number.isFinite)), spec.bins) : []
      const binaryY = isBinary(pts, yc.name) && yT === 'none'
      table.columns = spec.trend
        ? [...facetHeader, ...(spec.trendByGroup && !continuousColor && groups.keys.length > 1 ? [colLabel(ds, spec.color)] : []), `${colLabel(ds, spec.x, xT)} bin`, 'n', `mean ${colLabel(ds, spec.y, yT)}`, '95% CI low', '95% CI high']
        : [...facetHeader, ...(groups.keys.length > 1 ? [colLabel(ds, spec.color)] : []), 'n', `mean ${colLabel(ds, spec.x, xT)}`, `mean ${colLabel(ds, spec.y, yT)}`, 'Pearson r']
      for (const p of pl.list) {
        const keys = continuousColor ? ['all'] : groups.keys
        for (const k of keys) {
          const rs = p.rows.filter((r) => typeof r[xc.name] === 'number' && typeof r[yc.name] === 'number' && (continuousColor || groups.keyOf(r) === k))
          if (!rs.length) continue
          const xs = rs.map((r, i) => {
            const v = tx(r) + (spec.jitterX ? (hash01(i, 1) - 0.5) * spec.jitterX * rx : 0)
            return xDate ? isoUTC(v) : v
          })
          const ys = rs.map((r, i) => {
            const v = ty(r) + (spec.jitterY ? (hash01(i, 2) - 0.5) * spec.jitterY * ry : 0)
            return yDate ? isoUTC(v) : v
          })
          const color = continuousColor ? rs.map((r) => r[cc!.name] as number) : groups.color(k)
          data.push({
            type: gl ? 'scattergl' : 'scatter',
            mode: 'markers',
            name: continuousColor ? colLabel(ds, spec.color) : gName(k),
            legendgroup: k,
            showlegend: !continuousColor && legendOnce(k),
            x: xs,
            y: ys,
            xaxis: p.xa,
            yaxis: p.ya,
            marker: {
              color,
              size: 7,
              opacity: spec.opacity,
              symbol: useSymbols && !continuousColor ? groups.symbol(k) : 'circle',
              line: { color: t.surface, width: 1 },
              ...(continuousColor ? { colorscale: sequentialScale(t.theme), showscale: p.first, colorbar: { title: { text: colLabel(ds, spec.color), side: 'right' }, thickness: 10, outlinewidth: 0, tickfont: { color: t.muted } } } : {}),
            },
            text: rs.map(
              (r) =>
                `${ds.labelColumn && r[ds.labelColumn] ? `<b>${r[ds.labelColumn]}</b><br>` : ''}${!continuousColor && k !== 'all' ? `${gName(k)}<br>` : ''}${colLabel(ds, spec.x)}: ${
                  xDate ? fmtDate(r[xc.name] as number) : fmtNum(r[xc.name] as number)
                }<br>${colLabel(ds, spec.y)}: ${yDate ? fmtDate(r[yc.name] as number) : fmtNum(r[yc.name] as number)}${continuousColor ? `<br>${colLabel(ds, spec.color)}: ${fmtNum(r[cc!.name] as number)}` : ''}`,
            ),
            hovertemplate: '%{text}<extra></extra>',
          })
          const groupCells = groups.keys.length > 1 && !continuousColor ? [gName(k)] : []
          if (!spec.trend) {
            const xv = rs.map(tx)
            const yv = rs.map(ty)
            const sx = summarize(xv)
            const sy = summarize(yv)
            let cov = 0
            let m = 0
            xv.forEach((v, i) => {
              if (Number.isFinite(v) && Number.isFinite(yv[i])) {
                cov += (v - sx.mean) * (yv[i] - sy.mean)
                m++
              }
            })
            const r = m > 2 && sx.sd && sy.sd ? cov / (m - 1) / (sx.sd * sy.sd) : NaN
            table.rows.push([...(p.key ? [p.title] : []), ...groupCells, rs.length, sx.mean, sy.mean, Number.isFinite(r) ? r : null])
          }
        }

        // Binned mean of Y: over ALL points of the panel by default (e.g. empirical precision when
        // Y is a 0/1 outcome), or per color group when explicitly asked for.
        if (spec.trend && edges.length > 1) {
          const perGroup = spec.trendByGroup && !continuousColor && groups.keys.length > 1
          const trendKeys = perGroup ? groups.keys : ['__all__']
          for (const k of trendKeys) {
            const rs = p.rows.filter((r) => typeof r[xc.name] === 'number' && typeof r[yc.name] === 'number' && (k === '__all__' || groups.keyOf(r) === k))
            if (!rs.length) continue
            const lineColor = k === '__all__' ? t.ink : groups.color(k)
            const who = k === '__all__' ? 'all points' : gName(k)
            const bx: number[] = []
            const by: (number | null)[] = []
            const lo: number[] = []
            const hi: number[] = []
            const tt: string[] = []
            for (let i = 0; i < edges.length - 1; i++) {
              const inBin = rs.filter((r) => binIndex(tx(r), edges) === i).map(ty)
              if (!inBin.length) continue
              const s = summarize(inBin)
              const ci = binaryY ? wilson(inBin.filter((v) => v === 1).length, inBin.length) : ([s.mean - (1.96 * s.sd) / Math.sqrt(s.n), s.mean + (1.96 * s.sd) / Math.sqrt(s.n)] as [number, number])
              bx.push((edges[i] + edges[i + 1]) / 2)
              by.push(s.mean)
              lo.push(Number.isFinite(ci[0]) ? s.mean - ci[0] : 0)
              hi.push(Number.isFinite(ci[1]) ? ci[1] - s.mean : 0)
              const rawLbl = xT === 'none' ? `${fmtNum(edges[i])} – ${fmtNum(edges[i + 1])}` : `${fmtNum(invertTransform(edges[i], xT), 3)} – ${fmtNum(invertTransform(edges[i + 1], xT), 3)}`
              tt.push(`<b>Binned mean</b> · ${who}${p.key ? ` · ${p.title}` : ''}<br>${colLabel(ds, spec.x)} ${rawLbl}<br>mean ${colLabel(ds, spec.y)} = <b>${fmtNum(s.mean, 3)}</b> (n = ${s.n})<br>95% CI ${fmtNum(ci[0], 3)} – ${fmtNum(ci[1], 3)}${binaryY ? ' (Wilson)' : ''}`)
              table.rows.push([...(p.key ? [p.title] : []), ...(perGroup ? [who] : []), rawLbl, s.n, s.mean, Number.isFinite(ci[0]) ? ci[0] : null, Number.isFinite(ci[1]) ? ci[1] : null])
            }
            const legendKey = `trend:${k}`
            data.push({
              type: 'scatter',
              mode: 'lines+markers',
              name: k === '__all__' ? 'Binned mean ± 95% CI' : `${gName(k)} · binned mean`,
              legendgroup: legendKey,
              showlegend: k === '__all__' && legendOnce(legendKey),
              x: bx,
              y: by,
              xaxis: p.xa,
              yaxis: p.ya,
              line: { color: lineColor, width: 2 },
              marker: { color: lineColor, size: 8, symbol: 'diamond', line: { color: t.surface, width: 1.5 } },
              error_y: { type: 'data', symmetric: false, array: hi, arrayminus: lo, color: lineColor, thickness: 1.2, width: 4 },
              text: tt,
              hovertemplate: '%{text}<extra></extra>',
            })
          }
        }
      }
      layout.dragmode = 'select'
      break
    }

    // ── heatmap ──
    case 'heatmap': {
      const xc = col(spec.x)!
      const yc = col(spec.y)!
      const zc = col(spec.z)
      const agg: Agg = zc && spec.agg !== 'count' && spec.agg !== 'share' ? spec.agg : 'count'
      const xb = bucketize(rows, xc, spec, xc.type === 'number' ? spec.xTransform : 'none')
      const yb = bucketize(rows, yc, spec, yc.type === 'number' ? spec.yTransform : 'none')
      const zTitle = agg === 'count' ? 'Count' : `${AGG_LABEL[agg]} of ${colLabel(ds, spec.z)}`
      const pl = panels(
        ds,
        spec,
        rows,
        t,
        layout,
        { title: { text: colLabel(ds, spec.x) }, type: 'category', categoryorder: 'array', categoryarray: xb.list.map((b) => b.label), showgrid: false },
        { title: { text: colLabel(ds, spec.y) }, type: 'category', categoryorder: 'array', categoryarray: yb.list.map((b) => b.label), autorange: 'reversed', showgrid: false },
      )
      gridRows = pl.gridRows
      table.columns = [...facetHeader, colLabel(ds, spec.x), colLabel(ds, spec.y), 'n', zTitle]
      for (const p of pl.list) {
        const cells = yb.list.map(() => xb.list.map(() => [] as number[]))
        const counts = yb.list.map(() => xb.list.map(() => 0))
        for (const r of p.rows) {
          for (const yi of yb.ids(r))
            for (const xi of xb.ids(r)) {
              counts[yi][xi]++
              if (zc && typeof r[zc.name] === 'number') cells[yi][xi].push(r[zc.name] as number)
            }
        }
        const z = counts.map((row, yi) => row.map((c, xi) => (agg === 'count' ? (c ? c : null) : cells[yi][xi].length ? aggregate(cells[yi][xi], agg) : null)))
        const cd = yb.list.map((ybk) => xb.list.map((xbk) => click([xbk.seed, ybk.seed])))
        const text = yb.list.map((ybk, yi) =>
          xb.list.map((xbk, xi) => `${colLabel(ds, spec.x)}: <b>${xbk.label}</b><br>${colLabel(ds, spec.y)}: <b>${ybk.label}</b><br>${zTitle}: <b>${fmtNum(z[yi][xi])}</b>${agg !== 'count' ? `<br>n = ${counts[yi][xi]}` : ''}`),
        )
        yb.list.forEach((ybk, yi) => xb.list.forEach((xbk, xi) => counts[yi][xi] && table.rows.push([...(p.key ? [p.title] : []), xbk.label, ybk.label, counts[yi][xi], z[yi][xi]])))
        data.push({
          type: 'heatmap',
          x: xb.list.map((b) => b.label),
          y: yb.list.map((b) => b.label),
          z,
          text,
          customdata: cd,
          hovertemplate: '%{text}<extra></extra>',
          coloraxis: 'coloraxis',
          xgap: 2,
          ygap: 2,
          xaxis: p.xa,
          yaxis: p.ya,
        })
      }
      layout.coloraxis = { colorscale: sequentialScale(t.theme), colorbar: { title: { text: zTitle, side: 'right' }, thickness: 10, outlinewidth: 0, tickfont: { color: t.muted } } }
      break
    }
  }

  const height = Math.max(420, gridRows * (spec.facet ? 260 : 420) + 80)
  return { data, layout, table, clicks, height }
}

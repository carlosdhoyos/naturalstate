import { tokens } from './load'
import { fmtDate, fmtNum } from './stats'
import { NULL_KEY, type Column, type Dataset, type Row, type Value } from './types'

export type Filter =
  | { id: string; column: string; kind: 'range'; min: number | null; max: number | null; keepNull?: boolean }
  | { id: string; column: string; kind: 'in'; values: string[]; exclude?: boolean }
  | { id: string; column: string; kind: 'text'; op: TextOp; query: string }

export type TextOp = 'contains' | 'not_contains' | 'equals' | 'regex' | 'empty' | 'not_empty'

export const newId = () => Math.random().toString(36).slice(2, 9)

/** Category key of a value: nulls get an explicit bucket so missing data stays visible. */
export const keyOf = (v: Value): string => (v === null || v === undefined || v === '' ? NULL_KEY : String(v))

/** Columns that behave like categories (small numeric codes such as outcome 0/1 included). */
export function isDiscrete(c: Column): boolean {
  return c.type === 'category' || c.type === 'boolean' || (c.type === 'number' && c.distinct <= 12)
}

export function isNumeric(c: Column): boolean {
  return c.type === 'number' || c.type === 'datetime'
}

/** The filter kind a column gets by default. */
export function defaultFilterKind(c: Column): Filter['kind'] {
  if (c.type === 'number' && c.distinct <= 12) return 'in'
  if (isNumeric(c)) return 'range'
  if (c.type === 'text') return 'text'
  return 'in'
}

function predicate(f: Filter, col: Column | undefined): (r: Row) => boolean {
  const name = f.column
  if (f.kind === 'range') {
    return (r) => {
      const v = r[name]
      if (typeof v !== 'number') return !!f.keepNull
      return (f.min === null || v >= f.min) && (f.max === null || v <= f.max)
    }
  }
  if (f.kind === 'in') {
    const set = new Set(f.values)
    const multi = col?.type === 'multi'
    return (r) => {
      const v = r[name]
      const hit = multi
        ? (() => {
            const t = tokens(v, col?.sep)
            return t.length ? t.some((x) => set.has(x)) : set.has(NULL_KEY)
          })()
        : set.has(keyOf(v))
      return f.exclude ? !hit : hit
    }
  }
  const q = f.query.toLowerCase()
  let re: RegExp | null = null
  if (f.op === 'regex') {
    try {
      re = new RegExp(f.query, 'i')
    } catch {
      re = null
    }
  }
  return (r) => {
    const v = r[name]
    const s = v === null || v === undefined ? '' : String(v)
    switch (f.op) {
      case 'empty':
        return s === ''
      case 'not_empty':
        return s !== ''
      case 'equals':
        return s.toLowerCase() === q
      case 'not_contains':
        return !s.toLowerCase().includes(q)
      case 'regex':
        return re ? re.test(s) : true
      default:
        return s.toLowerCase().includes(q)
    }
  }
}

export function applyFilters(ds: Dataset, filters: Filter[], skipId?: string): Row[] {
  const active = filters.filter((f) => f.id !== skipId && ds.columns.some((c) => c.name === f.column))
  if (!active.length) return ds.rows
  const preds = active.map((f) => predicate(f, ds.columns.find((c) => c.name === f.column)))
  return ds.rows.filter((r) => preds.every((p) => p(r)))
}

export function describeFilter(f: Filter, col: Column | undefined): string {
  const label = col?.label ?? f.column
  const fmt = (v: number) => (col?.type === 'datetime' ? fmtDate(v) : fmtNum(v))
  if (f.kind === 'range') {
    if (f.min !== null && f.max !== null) return `${label}: ${fmt(f.min)} – ${fmt(f.max)}`
    if (f.min !== null) return `${label} ≥ ${fmt(f.min)}`
    if (f.max !== null) return `${label} ≤ ${fmt(f.max)}`
    return `${label}: any`
  }
  if (f.kind === 'in') {
    const shown = f.values.slice(0, 2).join(', ') + (f.values.length > 2 ? ` +${f.values.length - 2}` : '')
    return `${label} ${f.exclude ? 'is not' : 'is'} ${shown || '—'}`
  }
  const ops: Record<TextOp, string> = {
    contains: 'contains',
    not_contains: 'does not contain',
    equals: 'equals',
    regex: 'matches',
    empty: 'is empty',
    not_empty: 'is not empty',
  }
  return `${label} ${ops[f.op]}${f.op === 'empty' || f.op === 'not_empty' ? '' : ` “${f.query}”`}`
}

/** Value counts over a row set (multi columns count each token). Sorted by count, desc. */
export function valueCounts(rows: Row[], col: Column): [string, number][] {
  const m = new Map<string, number>()
  for (const r of rows) {
    if (col.type === 'multi') {
      const t = tokens(r[col.name], col.sep)
      if (!t.length) m.set(NULL_KEY, (m.get(NULL_KEY) ?? 0) + 1)
      for (const x of t) m.set(x, (m.get(x) ?? 0) + 1)
    } else {
      const k = keyOf(r[col.name])
      m.set(k, (m.get(k) ?? 0) + 1)
    }
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1] || naturalCompare(a[0], b[0]))
}

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' })
export const naturalCompare = (a: string, b: string) => collator.compare(a, b)

/**
 * Stable category order for a column, computed on the FULL dataset (not the filtered slice),
 * so a category keeps its color slot no matter how the data is filtered.
 */
const orderCache = new WeakMap<Dataset, Map<string, string[]>>()
export function categoryOrder(ds: Dataset, colName: string): string[] {
  let byCol = orderCache.get(ds)
  if (!byCol) orderCache.set(ds, (byCol = new Map()))
  const hit = byCol.get(colName)
  if (hit) return hit
  const col = ds.columns.find((c) => c.name === colName)
  if (!col) return []
  let order = valueCounts(ds.rows, col).map(([k]) => k)
  // Small ordered codes (0/1, hours) read better in natural order than by frequency.
  if (col.type === 'number') order = order.sort(naturalCompare)
  byCol.set(colName, order)
  return order
}

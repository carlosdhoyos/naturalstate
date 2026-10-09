import Papa from 'papaparse'
import type { ColType, Column, Dataset, Row, Value } from './types'

const NUM = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/
const ISO = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/
const BOOL = new Set(['yes', 'no', 'true', 'false'])
/** Tokens of an ODK multi-select: snake_case choice names, uuids, pipe-joined labels. */
const MULTI_TOKEN = /^[a-z0-9_|.-]+$/

export interface RawTable {
  fields: string[]
  data: Record<string, string>[]
}

export function parseCsv(text: string): RawTable {
  const res = Papa.parse<Record<string, string>>(text.replace(/^﻿/, ''), {
    header: true,
    skipEmptyLines: 'greedy',
    dynamicTyping: false,
  })
  return { fields: res.meta.fields ?? [], data: res.data }
}

/**
 * Infer a column type from its raw strings. Rules are deliberately conservative:
 * a column is numeric/datetime only if *every* non-empty value parses.
 */
export function inferType(name: string, raw: string[]): ColType {
  const vals = raw.map((v) => v?.trim() ?? '').filter((v) => v !== '')
  if (!vals.length) return 'text'
  if (vals.every((v) => NUM.test(v))) return 'number'
  if (vals.every((v) => ISO.test(v) && !Number.isNaN(Date.parse(v)))) return 'datetime'
  if (vals.every((v) => BOOL.has(v.toLowerCase()))) return 'boolean'

  const distinct = new Set(vals)
  const multiByName = /(_multi|_uuids)$/.test(name)
  const tokens = new Set<string>()
  let multiShaped = true
  let anyMultiple = false
  for (const v of distinct) {
    const parts = v.split(/\s+/)
    if (parts.length > 1) anyMultiple = true
    for (const p of parts) {
      if (!MULTI_TOKEN.test(p)) multiShaped = false
      tokens.add(p)
    }
    if (!multiShaped) break
  }
  if (multiByName || (multiShaped && anyMultiple && tokens.size <= 120)) return 'multi'
  if (distinct.size <= 60 || (distinct.size <= 500 && distinct.size / vals.length <= 0.2)) return 'category'
  return 'text'
}

export function convert(v: string | undefined, type: ColType): Value {
  const s = v?.trim() ?? ''
  if (s === '') return null
  if (type === 'number') return Number(s)
  if (type === 'datetime') return Date.parse(s.length === 10 ? `${s}T00:00:00Z` : s)
  if (type === 'boolean') return s.toLowerCase() === 'true' ? 'yes' : s.toLowerCase() === 'false' ? 'no' : s.toLowerCase()
  return v ?? null
}

/** Short label = last ODK path segment; falls back to the last two when that would be ambiguous. */
function labelsFor(fields: string[]): { label: string; section: string }[] {
  const split = fields.map((f) => f.split('-'))
  const last = split.map((p) => p[p.length - 1])
  const counts = new Map<string, number>()
  last.forEach((l) => counts.set(l, (counts.get(l) ?? 0) + 1))
  return split.map((p, i) => {
    const ambiguous = (counts.get(last[i]) ?? 0) > 1 && p.length > 1
    const label = ambiguous ? `${p[p.length - 2]} · ${p[p.length - 1]}` : last[i]
    const section = p.slice(0, ambiguous ? -2 : -1).join(' › ')
    return { label, section }
  })
}

export function columnStats(rows: Row[], name: string): { distinct: number; nonNull: number } {
  const seen = new Set<Value>()
  let nonNull = 0
  for (const r of rows) {
    const v = r[name]
    if (v === null || v === undefined) continue
    nonNull++
    seen.add(v)
  }
  return { distinct: seen.size, nonNull }
}

export function buildDataset(
  meta: Pick<Dataset, 'id' | 'title' | 'group' | 'file' | 'description' | 'challenge'>,
  raw: RawTable,
): Dataset {
  const labels = labelsFor(raw.fields)
  const types = raw.fields.map((f) => inferType(f, raw.data.map((r) => r[f])))
  const rows: Row[] = raw.data.map((r) => {
    const out: Row = {}
    raw.fields.forEach((f, i) => (out[f] = convert(r[f], types[i])))
    return out
  })
  const columns: Column[] = raw.fields.map((f, i) => ({
    name: f,
    label: labels[i].label,
    section: labels[i].section,
    type: types[i],
    ...columnStats(rows, f),
  }))
  return { ...meta, notes: [], columns, rows, geo: [], paths: [] }
}

/** Add a computed column. Derived columns are always marked so they never pass as source data. */
export function addColumn(
  ds: Dataset,
  col: { name: string; label?: string; type: ColType; description: string; sep?: string },
  fn: (r: Row, i: number) => Value,
): void {
  ds.rows.forEach((r, i) => {
    const v = fn(r, i)
    r[col.name] = v === undefined || (typeof v === 'number' && Number.isNaN(v)) ? null : v
  })
  ds.columns.push({
    name: col.name,
    label: col.label ?? col.name,
    section: 'derived',
    type: col.type,
    derived: true,
    description: col.description,
    sep: col.sep,
    ...columnStats(ds.rows, col.name),
  })
}

export function tokens(v: Value, sep?: string): string[] {
  if (v === null || v === undefined) return []
  return String(v)
    .split(sep ?? /\s+/)
    .map((t) => t.trim())
    .filter(Boolean)
}

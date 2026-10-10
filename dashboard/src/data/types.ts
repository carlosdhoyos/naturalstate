/**
 * Column types the explorer understands.
 * - number    finite numeric values (ints and floats)
 * - datetime  stored as epoch milliseconds (UTC) in the row
 * - category  low-cardinality strings (≤ ~60 distinct, or repetitive)
 * - boolean   yes/no, true/false
 * - multi     ODK multi-select: several tokens in one cell (split by `sep`)
 * - text      everything else (ids, free text, file names)
 */
export type ColType = 'number' | 'datetime' | 'category' | 'boolean' | 'multi' | 'text'

export type Value = string | number | null
export type Row = Record<string, Value>

export interface Column {
  name: string
  /** Short display name (last path segment of an ODK column). */
  label: string
  /** ODK group path, e.g. "plot_metadata › collect_points". Empty for top-level columns. */
  section: string
  type: ColType
  /** True when the column was computed by the explorer, not present in the CSV. */
  derived?: boolean
  description?: string
  /** Token separator for multi columns (whitespace by default). */
  sep?: string
  distinct: number
  nonNull: number
  /** Date-time columns: explicit UTC offsets found in the raw text (e.g. {"+02:00": 32}); "none" = no offset written. */
  tz?: Record<string, number>
  /**
   * What a date-time value means: "instant" = a true moment (source text had an offset; stored as UTC),
   * "wall" = clock reading with no known time zone (recorder clock, offset-less CSV values),
   * "eat" = wall-clock time assumed to be East Africa Time (UTC+3).
   */
  timeBasis?: 'instant' | 'wall' | 'eat'
}

export interface GeoLayer {
  id: string
  label: string
  lat: string
  lon: string
  accuracy?: string
}

/** A polyline drawn per row through several lat/lon column pairs (e.g. transect A → midpoint → B). */
export interface GeoPath {
  id: string
  label: string
  points: { lat: string; lon: string }[]
}

export interface Dataset {
  id: string
  title: string
  group: string
  /** Which take-home challenge the table belongs to ('other' for user-opened CSVs). */
  challenge: 'birds' | 'vegetation' | 'other'
  file: string
  description: string
  /** Facts worth surfacing next to the data (e.g. join coverage). */
  notes: string[]
  columns: Column[]
  rows: Row[]
  /** Column used to name a row in tooltips and on the map. */
  labelColumn?: string
  geo: GeoLayer[]
  paths: GeoPath[]
}

export const NULL_KEY = '(empty)'

import type { ReactNode } from 'react'
import type { ColType, Column } from '../data/types'

export const TYPE_GLYPH: Record<ColType, string> = {
  number: '#',
  datetime: '◷',
  category: '◆',
  boolean: '◐',
  multi: '☰',
  text: 'T',
}
export const TYPE_NAME: Record<ColType, string> = {
  number: 'number',
  datetime: 'date-time',
  category: 'category',
  boolean: 'yes / no',
  multi: 'multi-select',
  text: 'text',
}

export function TypeBadge({ type }: { type: ColType }) {
  return (
    <span className={`type-badge t-${type}`} title={TYPE_NAME[type]}>
      {TYPE_GLYPH[type]}
    </span>
  )
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="field">
      <span className="field-label" title={hint}>
        {label}
      </span>
      {children}
    </label>
  )
}

/** Column picker grouped by ODK section, labelled with type glyphs. */
export function ColumnSelect({
  columns,
  value,
  onChange,
  allowNone,
  noneLabel = '— none —',
}: {
  columns: Column[]
  value: string | null
  onChange: (v: string | null) => void
  allowNone?: boolean
  noneLabel?: string
}) {
  const sections = new Map<string, Column[]>()
  for (const c of columns) {
    const s = c.derived ? 'derived (computed here)' : c.section || 'columns'
    if (!sections.has(s)) sections.set(s, [])
    sections.get(s)!.push(c)
  }
  const missing = value && !columns.some((c) => c.name === value)
  return (
    <select className="select" value={value ?? ''} onChange={(e) => onChange(e.target.value || null)}>
      {(allowNone || !value || missing) && <option value="">{allowNone ? noneLabel : 'Choose…'}</option>}
      {[...sections.entries()].map(([s, cols]) => (
        <optgroup key={s} label={s}>
          {cols.map((c) => (
            <option key={c.name} value={c.name} title={c.name}>
              {TYPE_GLYPH[c.type]}  {c.label}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  )
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  size = 'md',
}: {
  value: T
  options: { value: T; label: ReactNode; title?: string }[]
  onChange: (v: T) => void
  size?: 'sm' | 'md'
}) {
  return (
    <div className={`segmented ${size}`} role="radiogroup">
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={value === o.value} className={value === o.value ? 'on' : ''} title={o.title} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label className="toggle">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="toggle-track" aria-hidden />
      <span>{label}</span>
    </label>
  )
}

export function Range({ value, min, max, step, onChange, format }: { value: number; min: number; max: number; step: number; onChange: (v: number) => void; format?: (v: number) => string }) {
  return (
    <div className="range">
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
      <span className="range-val">{format ? format(value) : value}</span>
    </div>
  )
}

export function Stat({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  )
}

export function Icon({ name, size = 16 }: { name: 'filter' | 'plus' | 'x' | 'download' | 'chart' | 'table' | 'grid' | 'map' | 'sun' | 'moon' | 'auto' | 'search' | 'info' | 'upload' | 'chev'; size?: number }) {
  const p: Record<string, ReactNode> = {
    filter: <path d="M3 5h18l-7 8v6l-4 2v-8z" />,
    plus: <path d="M12 5v14M5 12h14" />,
    x: <path d="M6 6l12 12M18 6L6 18" />,
    download: <path d="M12 4v11m0 0l-4-4m4 4l4-4M5 20h14" />,
    chart: <path d="M4 20V10m6 10V4m6 16v-7m4 7H3" />,
    table: <path d="M3 5h18v14H3zM3 10h18M9 5v14" />,
    grid: <path d="M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z" />,
    map: <path d="M12 21s-6-5.5-6-11a6 6 0 1112 0c0 5.5-6 11-6 11zm0-8.5a2.5 2.5 0 100-5 2.5 2.5 0 000 5z" />,
    sun: <path d="M12 4V2m0 20v-2m8-8h2M2 12h2m13.7-5.7l1.4-1.4M4.9 19.1l1.4-1.4m0-11.4L4.9 4.9m14.2 14.2l-1.4-1.4M12 17a5 5 0 100-10 5 5 0 000 10z" />,
    moon: <path d="M20 14.5A8 8 0 019.5 4a8 8 0 1010.5 10.5z" />,
    auto: <path d="M12 3a9 9 0 100 18V3z M12 3a9 9 0 110 18" />,
    search: <path d="M11 18a7 7 0 100-14 7 7 0 000 14zm9 3l-4.5-4.5" />,
    info: <path d="M12 21a9 9 0 100-18 9 9 0 000 18zm0-5v-5m0-3h.01" />,
    upload: <path d="M12 20V9m0 0l-4 4m4-4l4 4M5 4h14" />,
    chev: <path d="M9 6l6 6-6 6" />,
  }
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {p[name]}
    </svg>
  )
}

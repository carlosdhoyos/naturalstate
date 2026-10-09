import { useEffect, useMemo, useRef, useState } from 'react'
import { applyFilters, defaultFilterKind, describeFilter, newId, valueCounts, type Filter, type TextOp } from '../data/filter'
import { fmtDate, fmtInt, fmtNum, isoUTC } from '../data/stats'
import type { Column, Dataset } from '../data/types'
import { HELP, tip, tipText } from '../lib/help'
import { Icon, Segmented, Toggle, TypeBadge } from './ui'

interface Props {
  ds: Dataset
  filters: Filter[]
  shown: number
  onChange: (f: Filter[]) => void
  /** Column requested from elsewhere (e.g. a profile card's "Filter" button). */
  request: { column: string; nonce: number } | null
}

export function FilterBar({ ds, filters, shown, onChange, request }: Props) {
  const [editing, setEditing] = useState<{ filter: Filter | null; column: string | null } | null>(null)

  useEffect(() => {
    if (request) setEditing({ filter: filters.find((f) => f.column === request.column) ?? null, column: request.column })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request?.nonce])

  const colOf = (n: string) => ds.columns.find((c) => c.name === n)
  const upsert = (f: Filter) => {
    const i = filters.findIndex((x) => x.id === f.id)
    onChange(i >= 0 ? filters.map((x) => (x.id === f.id ? f : x)) : [...filters, f])
    setEditing(null)
  }

  return (
    <div className="filterbar">
      <div className="filterbar-count" aria-live="polite" {...tip('filter.count', true)}>
        <strong>{fmtInt(shown)}</strong> <span>of {fmtInt(ds.rows.length)} rows</span>
      </div>
      <div className="chips">
        {filters.map((f) => (
          <span key={f.id} className={`chip ${colOf(f.column) ? '' : 'stale'}`}>
            <button type="button" className="chip-body" onClick={() => setEditing({ filter: f, column: f.column })} {...tip('filter.chip')}>
              <Icon name="filter" size={12} />
              {describeFilter(f, colOf(f.column))}
            </button>
            <button type="button" className="chip-x" aria-label="Remove filter" onClick={() => onChange(filters.filter((x) => x.id !== f.id))}>
              <Icon name="x" size={12} />
            </button>
          </span>
        ))}
        <div className="popover-anchor">
          <button type="button" className="btn ghost sm" {...tip('filter.add')} onClick={() => setEditing(editing ? null : { filter: null, column: null })}>
            <Icon name="plus" size={14} /> Add filter
          </button>
          {editing && (
            <FilterEditor
              ds={ds}
              rows={applyFilters(ds, filters, editing.filter?.id)}
              initial={editing.filter}
              column={editing.column}
              onApply={upsert}
              onClose={() => setEditing(null)}
            />
          )}
        </div>
        {filters.length > 0 && (
          <button type="button" className="btn link sm" {...tip('filter.clear')} onClick={() => onChange([])}>
            Clear all
          </button>
        )}
      </div>
    </div>
  )
}

function FilterEditor({
  ds,
  rows,
  initial,
  column,
  onApply,
  onClose,
}: {
  ds: Dataset
  rows: Dataset['rows']
  initial: Filter | null
  column: string | null
  onApply: (f: Filter) => void
  onClose: () => void
}) {
  const [colName, setColName] = useState<string | null>(column)
  const [q, setQ] = useState('')
  const ref = useRef<HTMLDivElement>(null)
  const col = ds.columns.find((c) => c.name === colName) ?? null

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    const onDown = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && onClose()
    window.addEventListener('keydown', onKey)
    window.addEventListener('mousedown', onDown)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mousedown', onDown)
    }
  }, [onClose])

  const cols = ds.columns.filter((c) => c.nonNull > 0 && (`${c.label} ${c.name}`.toLowerCase().includes(q.toLowerCase())))

  return (
    <div className="popover" ref={ref} role="dialog" aria-label="Filter editor">
      {!col ? (
        <>
          <div className="popover-head">
            <Icon name="search" size={14} />
            <input autoFocus className="input bare" placeholder="Filter by column…" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <div className="col-list">
            {cols.map((c) => (
              <button key={c.name} type="button" className="col-item" onClick={() => setColName(c.name)} {...tipText(c.description ? `${c.description}\n\nCSV column: ${c.name}` : `CSV column: ${c.name}`, c.label)}>
                <TypeBadge type={c.type} />
                <span className="col-item-label">{c.label}</span>
                {c.derived && <span className="tag">derived</span>}
                <span className="col-item-sub">{c.section}</span>
              </button>
            ))}
          </div>
        </>
      ) : (
        <ColumnFilter key={col.name} col={col} rows={rows} initial={initial?.column === col.name ? initial : null} onApply={onApply} onBack={initial ? undefined : () => setColName(null)} />
      )}
    </div>
  )
}

function ColumnFilter({ col, rows, initial, onApply, onBack }: { col: Column; rows: Dataset['rows']; initial: Filter | null; onApply: (f: Filter) => void; onBack?: () => void }) {
  const [kind, setKind] = useState<Filter['kind']>(initial?.kind ?? defaultFilterKind(col))
  const id = initial?.id ?? newId()
  const isDate = col.type === 'datetime'

  // range state
  const nums = useMemo(() => rows.map((r) => r[col.name]).filter((v): v is number => typeof v === 'number'), [rows, col.name])
  const dmin = nums.length ? Math.min(...nums) : NaN
  const dmax = nums.length ? Math.max(...nums) : NaN
  const toInput = (v: number | null) => (v === null || !Number.isFinite(v) ? '' : isDate ? isoUTC(v).slice(0, 16) : String(v))
  const fromInput = (s: string) => (s.trim() === '' ? null : isDate ? Date.parse(`${s}:00Z`) : Number(s))
  const [lo, setLo] = useState(toInput(initial?.kind === 'range' ? initial.min : null))
  const [hi, setHi] = useState(toInput(initial?.kind === 'range' ? initial.max : null))
  const [keepNull, setKeepNull] = useState(initial?.kind === 'range' ? !!initial.keepNull : false)

  // in state
  const counts = useMemo(() => valueCounts(rows, col), [rows, col])
  const [sel, setSel] = useState<Set<string>>(new Set(initial?.kind === 'in' ? initial.values : []))
  const [exclude, setExclude] = useState(initial?.kind === 'in' ? !!initial.exclude : false)
  const [search, setSearch] = useState('')

  // text state
  const [op, setOp] = useState<TextOp>(initial?.kind === 'text' ? initial.op : 'contains')
  const [query, setQuery] = useState(initial?.kind === 'text' ? initial.query : '')

  const apply = () => {
    if (kind === 'range') onApply({ id, column: col.name, kind, min: fromInput(lo), max: fromInput(hi), keepNull })
    else if (kind === 'in') onApply({ id, column: col.name, kind, values: [...sel], exclude })
    else onApply({ id, column: col.name, kind, op, query })
  }

  const canRange = col.type === 'number' || isDate
  const kinds: { value: Filter['kind']; label: string; title: string }[] = [
    ...(canRange ? [{ value: 'range' as const, label: 'Range', title: HELP['filter.range'].text }] : []),
    ...(col.type !== 'text' || col.distinct <= 500 ? [{ value: 'in' as const, label: 'Values', title: HELP['filter.values'].text }] : []),
    { value: 'text', label: 'Text', title: HELP['filter.text'].text },
  ]
  const shownCounts = counts.filter(([k]) => k.toLowerCase().includes(search.toLowerCase())).slice(0, 300)

  return (
    <div className="colfilter">
      <div className="colfilter-head">
        {onBack && (
          <button type="button" className="btn link sm" onClick={onBack}>
            ← Columns
          </button>
        )}
        <TypeBadge type={col.type} />
        <strong {...tipText(col.description ? `${col.description}\n\nCSV column: ${col.name}` : `CSV column: ${col.name}`, col.label)}>{col.label}</strong>
      </div>
      {kinds.length > 1 && <Segmented size="sm" value={kind} options={kinds} onChange={setKind} />}

      {kind === 'range' && (
        <div className="colfilter-body">
          <div className="muted small" {...tip('filter.datarange')}>
            Data range: {isDate ? fmtDate(dmin) : fmtNum(dmin)} → {isDate ? fmtDate(dmax) : fmtNum(dmax)} {isDate && '(UTC)'}
          </div>
          <div className="range-inputs">
            <input className="input" type={isDate ? 'datetime-local' : 'number'} step="any" placeholder="min" value={lo} onChange={(e) => setLo(e.target.value)} />
            <span>to</span>
            <input className="input" type={isDate ? 'datetime-local' : 'number'} step="any" placeholder="max" value={hi} onChange={(e) => setHi(e.target.value)} />
          </div>
          <Toggle tipKey="filter.keepNull" checked={keepNull} onChange={setKeepNull} label="Keep empty values" />
        </div>
      )}

      {kind === 'in' && (
        <div className="colfilter-body">
          <input className="input" placeholder="Search values…" value={search} onChange={(e) => setSearch(e.target.value)} />
          <div className="row gap-sm">
            <button type="button" className="btn link sm" onClick={() => setSel(new Set(shownCounts.map(([k]) => k)))}>
              Select shown
            </button>
            <button type="button" className="btn link sm" onClick={() => setSel(new Set())}>
              None
            </button>
            <span className="grow" />
            <Toggle tipKey="filter.exclude" checked={exclude} onChange={setExclude} label="Exclude" />
          </div>
          <div className="value-list">
            {shownCounts.map(([k, n]) => (
              <label key={k} className="value-item">
                <input
                  type="checkbox"
                  checked={sel.has(k)}
                  onChange={(e) => {
                    const s = new Set(sel)
                    if (e.target.checked) s.add(k)
                    else s.delete(k)
                    setSel(s)
                  }}
                />
                <span className="value-label" title={k}>
                  {col.type === 'number' && k !== '(empty)' ? fmtNum(Number(k)) : k}
                </span>
                <span className="value-count">{fmtInt(n)}</span>
              </label>
            ))}
            {counts.length > shownCounts.length && <div className="muted small">Showing {shownCounts.length} of {counts.length} values — refine the search.</div>}
          </div>
        </div>
      )}

      {kind === 'text' && (
        <div className="colfilter-body">
          <select className="select" value={op} onChange={(e) => setOp(e.target.value as TextOp)}>
            <option value="contains">contains</option>
            <option value="not_contains">does not contain</option>
            <option value="equals">equals</option>
            <option value="regex">matches regex</option>
            <option value="empty">is empty</option>
            <option value="not_empty">is not empty</option>
          </select>
          {op !== 'empty' && op !== 'not_empty' && <input className="input" autoFocus value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && apply()} />}
        </div>
      )}

      <div className="colfilter-foot">
        <button type="button" className="btn primary sm" onClick={apply} disabled={kind === 'in' && sel.size === 0}>
          Apply filter
        </button>
      </div>
    </div>
  )
}

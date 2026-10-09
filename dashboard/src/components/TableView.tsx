import Papa from 'papaparse'
import { useMemo, useState } from 'react'
import { naturalCompare } from '../data/filter'
import { fmtDate, fmtInt, fmtNum, isoUTC } from '../data/stats'
import type { Column, Dataset, Row, Value } from '../data/types'
import { Icon, Toggle, TypeBadge } from './ui'

export function downloadCsv(name: string, columns: string[], rows: (Value | undefined)[][]) {
  const csv = Papa.unparse({ fields: columns, data: rows.map((r) => r.map((v) => (v === null || v === undefined ? '' : v))) })
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
  const a = document.createElement('a')
  a.href = url
  a.download = name.endsWith('.csv') ? name : `${name}.csv`
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function exportRows(ds: Dataset, rows: Row[]) {
  const cols = ds.columns
  downloadCsv(
    `${ds.id}_filtered`,
    cols.map((c) => (c.derived ? `derived:${c.name}` : c.name)),
    rows.map((r) => cols.map((c) => (c.type === 'datetime' && typeof r[c.name] === 'number' ? `${isoUTC(r[c.name] as number)}Z` : r[c.name]))),
  )
}

const PAGE = 100

export function cellText(c: Column, v: Value): string {
  if (v === null || v === undefined) return ''
  if (c.type === 'datetime' && typeof v === 'number') return fmtDate(v)
  if (c.type === 'number' && typeof v === 'number') return fmtNum(v, 6)
  return String(v)
}

export function TableView({ ds, rows }: { ds: Dataset; rows: Row[] }) {
  const [sort, setSort] = useState<{ col: string; dir: 1 | -1 } | null>(null)
  const [page, setPage] = useState(0)
  const [q, setQ] = useState('')
  const [hideBoring, setHideBoring] = useState(true)
  const [showDerived, setShowDerived] = useState(true)

  const cols = ds.columns.filter((c) => (!hideBoring || (c.nonNull > 0 && c.distinct > 1)) && (showDerived || !c.derived))

  const searched = useMemo(() => {
    if (!q.trim()) return rows
    const s = q.toLowerCase()
    return rows.filter((r) => cols.some((c) => r[c.name] !== null && String(r[c.name]).toLowerCase().includes(s)))
  }, [rows, q, cols])

  const sorted = useMemo(() => {
    if (!sort) return searched
    const { col, dir } = sort
    return [...searched].sort((a, b) => {
      const x = a[col]
      const y = b[col]
      if (x === null && y === null) return 0
      if (x === null) return 1
      if (y === null) return -1
      if (typeof x === 'number' && typeof y === 'number') return (x - y) * dir
      return naturalCompare(String(x), String(y)) * dir
    })
  }, [searched, sort])

  const pages = Math.max(1, Math.ceil(sorted.length / PAGE))
  const p = Math.min(page, pages - 1)
  const slice = sorted.slice(p * PAGE, (p + 1) * PAGE)

  return (
    <div className="tableview">
      <div className="toolbar">
        <div className="search">
          <Icon name="search" size={14} />
          <input
            className="input bare"
            placeholder="Search visible columns…"
            value={q}
            onChange={(e) => {
              setQ(e.target.value)
              setPage(0)
            }}
          />
        </div>
        <Toggle checked={hideBoring} onChange={setHideBoring} label="Hide empty & constant columns" />
        <Toggle checked={showDerived} onChange={setShowDerived} label="Show derived columns" />
        <span className="grow" />
        <button type="button" className="btn ghost sm" onClick={() => exportRows(ds, sorted)} title="All columns, current filters and search">
          <Icon name="download" size={14} /> CSV ({fmtInt(sorted.length)} rows)
        </button>
      </div>
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th className="rownum">#</th>
              {cols.map((c) => (
                <th
                  key={c.name}
                  className={`${c.type === 'number' ? 'num' : ''} ${c.derived ? 'derived' : ''}`}
                  title={`${c.name}${c.description ? `\n${c.description}` : ''}\nClick to sort`}
                  onClick={() => setSort(sort?.col === c.name ? (sort.dir === 1 ? { col: c.name, dir: -1 } : null) : { col: c.name, dir: 1 })}
                >
                  <span className="th-inner">
                    <TypeBadge type={c.type} />
                    {c.label}
                    {sort?.col === c.name && <span className="sort">{sort.dir === 1 ? '▲' : '▼'}</span>}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {slice.map((r, i) => (
              <tr key={p * PAGE + i}>
                <td className="rownum">{fmtInt(p * PAGE + i + 1)}</td>
                {cols.map((c) => {
                  const v = r[c.name]
                  const t = cellText(c, v)
                  return (
                    <td key={c.name} className={`${c.type === 'number' ? 'num' : ''} ${v === null ? 'null' : ''}`} title={t.length > 40 ? t : undefined}>
                      {v === null ? '—' : t}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
        {!slice.length && <div className="empty">No rows match.</div>}
      </div>
      <div className="pager">
        <span className="muted small">
          {fmtInt(sorted.length)} rows · {cols.length} of {ds.columns.length} columns shown
        </span>
        <span className="grow" />
        <button type="button" className="btn ghost sm" disabled={p === 0} onClick={() => setPage(0)}>
          «
        </button>
        <button type="button" className="btn ghost sm" disabled={p === 0} onClick={() => setPage(p - 1)}>
          ‹ Prev
        </button>
        <span className="small">
          Page {p + 1} / {pages}
        </span>
        <button type="button" className="btn ghost sm" disabled={p >= pages - 1} onClick={() => setPage(p + 1)}>
          Next ›
        </button>
        <button type="button" className="btn ghost sm" disabled={p >= pages - 1} onClick={() => setPage(pages - 1)}>
          »
        </button>
      </div>
    </div>
  )
}

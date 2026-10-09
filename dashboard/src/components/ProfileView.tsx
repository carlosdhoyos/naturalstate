import { memo, useMemo, useState } from 'react'
import { valueCounts } from '../data/filter'
import { binEdges, binIndex, fmtDate, fmtDuration, fmtInt, fmtNum, fmtPct, summarize } from '../data/stats'
import { NULL_KEY, type Column, type Dataset, type Row } from '../data/types'
import { Icon, Segmented, Stat, Toggle, TypeBadge, TYPE_NAME } from './ui'

interface Props {
  ds: Dataset
  rows: Row[]
  onPlot: (col: Column) => void
  onFilter: (col: Column) => void
}

type SortKey = 'file' | 'missing' | 'distinct'

export function ProfileView({ ds, rows, onPlot, onFilter }: Props) {
  const [hideBoring, setHideBoring] = useState(true)
  const [q, setQ] = useState('')
  const [sort, setSort] = useState<SortKey>('file')

  const boring = (c: Column) => c.nonNull === 0 || c.distinct <= 1
  const nBoring = ds.columns.filter(boring).length
  const nDerived = ds.columns.filter((c) => c.derived).length
  const cells = rows.length * ds.columns.filter((c) => !c.derived).length
  const missing = useMemo(() => {
    let m = 0
    for (const c of ds.columns) if (!c.derived) for (const r of rows) if (r[c.name] === null) m++
    return m
  }, [ds, rows])

  let cols = ds.columns.filter((c) => (!hideBoring || !boring(c)) && `${c.label} ${c.name}`.toLowerCase().includes(q.toLowerCase()))
  if (sort === 'missing') cols = [...cols].sort((a, b) => a.nonNull - b.nonNull)
  if (sort === 'distinct') cols = [...cols].sort((a, b) => b.distinct - a.distinct)

  return (
    <div className="profile">
      <div className="stats-row">
        <Stat label="Rows" value={fmtInt(rows.length)} sub={rows.length !== ds.rows.length ? `of ${fmtInt(ds.rows.length)} (filtered)` : 'all rows'} />
        <Stat label="Columns" value={fmtInt(ds.columns.length - nDerived)} sub={nDerived ? `+ ${nDerived} derived` : 'from the CSV'} />
        <Stat label="Empty cells" value={fmtPct(cells ? missing / cells : NaN)} sub={`${fmtInt(missing)} of ${fmtInt(cells)}`} />
        <Stat label="Empty or constant columns" value={fmtInt(nBoring)} sub="ODK notes, unused fields" />
      </div>

      {ds.notes.length > 0 && (
        <div className="notes">
          {ds.notes.map((n) => (
            <div key={n} className="note">
              <Icon name="info" size={16} />
              <span>{n}</span>
            </div>
          ))}
        </div>
      )}

      <div className="toolbar">
        <div className="search">
          <Icon name="search" size={14} />
          <input className="input bare" placeholder="Search columns…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <Segmented
          size="sm"
          value={sort}
          onChange={setSort}
          options={[
            { value: 'file', label: 'File order' },
            { value: 'missing', label: 'Most empty' },
            { value: 'distinct', label: 'Most distinct' },
          ]}
        />
        <span className="grow" />
        <Toggle checked={hideBoring} onChange={setHideBoring} label={`Hide empty & constant (${nBoring})`} />
      </div>

      <div className="card-grid">
        {cols.map((c) => (
          <ColumnCard key={c.name} col={c} rows={rows} onPlot={onPlot} onFilter={onFilter} />
        ))}
      </div>
    </div>
  )
}

const ColumnCard = memo(function ColumnCard({ col, rows, onPlot, onFilter }: { col: Column; rows: Row[]; onPlot: (c: Column) => void; onFilter: (c: Column) => void }) {
  const nonNull = useMemo(() => rows.reduce((n, r) => n + (r[col.name] === null ? 0 : 1), 0), [rows, col.name])
  const missingShare = rows.length ? 1 - nonNull / rows.length : 0

  return (
    <article className={`col-card ${col.derived ? 'derived' : ''}`}>
      <header>
        <TypeBadge type={col.type} />
        <div className="col-card-title">
          <h3 title={col.name}>{col.label}</h3>
          <div className="col-card-sub" title={col.name}>
            {col.derived ? 'derived · ' : ''}
            {col.section || TYPE_NAME[col.type]}
          </div>
        </div>
        <div className="col-card-actions">
          <button type="button" className="icon-btn" title="Plot this column" onClick={() => onPlot(col)}>
            <Icon name="chart" size={15} />
          </button>
          <button type="button" className="icon-btn" title="Filter on this column" onClick={() => onFilter(col)}>
            <Icon name="filter" size={15} />
          </button>
        </div>
      </header>
      {col.description && <p className="col-card-desc">{col.description}</p>}
      <div className="col-card-meta">
        <span>
          <b>{fmtInt(nonNull)}</b> values
        </span>
        <span className={missingShare > 0 ? 'warn-text' : ''}>
          <b>{fmtPct(missingShare, 0)}</b> empty
        </span>
        <span>
          <b>{fmtInt(col.distinct)}</b> distinct
        </span>
      </div>
      <ColumnBody col={col} rows={rows} />
    </article>
  )
})

function ColumnBody({ col, rows }: { col: Column; rows: Row[] }) {
  const content = useMemo(() => {
    if (col.type === 'number' || col.type === 'datetime') {
      const v = rows.map((r) => r[col.name]).filter((x): x is number => typeof x === 'number')
      if (!v.length) return <div className="muted small">No values in this slice.</div>
      const s = summarize(v)
      const f = (x: number) => (col.type === 'datetime' ? fmtDate(x) : fmtNum(x))
      return (
        <>
          <Spark values={v} />
          <dl className="mini-stats">
            <div>
              <dt>min</dt>
              <dd>{f(s.min)}</dd>
            </div>
            <div>
              <dt>median</dt>
              <dd>{f(s.median)}</dd>
            </div>
            <div>
              <dt>max</dt>
              <dd>{f(s.max)}</dd>
            </div>
            {col.type === 'number' ? (
              <>
                <div>
                  <dt>mean</dt>
                  <dd>{fmtNum(s.mean)}</dd>
                </div>
                <div>
                  <dt>sd</dt>
                  <dd>{fmtNum(s.sd)}</dd>
                </div>
                <div>
                  <dt>IQR</dt>
                  <dd>
                    {fmtNum(s.q1)} – {fmtNum(s.q3)}
                  </dd>
                </div>
              </>
            ) : (
              <div className="span-3">
                <dt>span</dt>
                <dd>{fmtDuration(s.max - s.min)} (UTC)</dd>
              </div>
            )}
          </dl>
        </>
      )
    }
    const counts = valueCounts(rows, col).filter(([k]) => k !== NULL_KEY)
    if (!counts.length) return <div className="muted small">No values in this slice.</div>
    const total = counts.reduce((a, [, n]) => a + n, 0)
    const top = counts.slice(0, col.type === 'text' ? 4 : 6)
    const maxN = top[0][1]
    return (
      <div className="topk">
        {top.map(([k, n]) => (
          <div key={k} className="topk-row" title={`${k}: ${n}`}>
            <span className="topk-label">{k}</span>
            <span className="topk-bar">
              <span style={{ width: `${(n / maxN) * 100}%` }} />
            </span>
            <span className="topk-n">{fmtInt(n)}</span>
          </div>
        ))}
        {counts.length > top.length && (
          <div className="muted small">
            + {fmtInt(counts.length - top.length)} more {col.type === 'multi' ? 'tokens' : 'values'} ({fmtPct(1 - top.reduce((a, [, n]) => a + n, 0) / total, 0)} of {col.type === 'multi' ? 'tokens' : 'rows'})
          </div>
        )}
      </div>
    )
  }, [col, rows])
  return <div className="col-card-body">{content}</div>
}

/** Tiny histogram: 1px gaps, rounded data-ends, no axes (the stats beneath carry the numbers). */
function Spark({ values }: { values: number[] }) {
  let min = Infinity
  let max = -Infinity
  for (const v of values) {
    if (v < min) min = v
    if (v > max) max = v
  }
  const edges = binEdges(min, max, 24)
  const n = new Array(Math.max(1, edges.length - 1)).fill(0)
  for (const v of values) {
    const i = binIndex(v, edges)
    if (i >= 0) n[i]++
  }
  const top = Math.max(...n)
  const W = 240
  const H = 44
  const bw = W / n.length
  return (
    <svg className="spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label="Distribution">
      <line x1={0} x2={W} y1={H - 0.5} y2={H - 0.5} className="spark-base" />
      {n.map((c, i) => {
        const h = top ? (c / top) * (H - 2) : 0
        return c > 0 ? <rect key={i} x={i * bw + 1} y={H - 1 - Math.max(h, 1.5)} width={Math.max(1, bw - 2)} height={Math.max(h, 1.5)} rx={1.5} /> : null
      })}
    </svg>
  )
}

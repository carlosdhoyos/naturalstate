import { useCallback, useMemo, useState } from 'react'
import { allowedColumns, buildFigure, DEFAULT_SPEC, KIND_NEEDS, type ChartKind, type ChartSpec, type FilterSeed, type Role } from '../charts/build'
import { PRESETS } from '../charts/presets'
import { readingGuide } from '../charts/describe'
import { HELP, tip, type HelpKey } from '../lib/help'
import { isDiscrete } from '../data/filter'
import { fmtInt, fmtNum, invertTransform, type Agg, type Transform } from '../data/stats'
import type { Dataset, Row } from '../data/types'
import type { ThemeTokens } from '../lib/palette'
import { Plot, type SelectRange } from './Plot'
import { downloadCsv } from './TableView'
import { ColumnSelect, Field, Icon, Range, Segmented, Toggle } from './ui'

const KINDS: { kind: ChartKind; label: string; hint: string; icon: string }[] = [
  { kind: 'histogram', label: 'Histogram', hint: 'Distribution of one numeric or date column', icon: 'M3 20h18M5 20v-6h3v6M10 20V8h3v12M15 20v-9h3v9' },
  { kind: 'bar', label: 'Bar', hint: 'Counts or an aggregate per category / bin', icon: 'M3 20h18M6 20V10M11 20V5M16 20v-7' },
  { kind: 'line', label: 'Line', hint: 'Aggregate over time or along a numeric axis', icon: 'M3 20h18M4 16l5-6 4 3 7-8' },
  { kind: 'box', label: 'Box', hint: 'Quartiles of a numeric column per category', icon: 'M7 4v4M7 16v4M4 8h6v8H4zM4 12h6M17 6v3M17 15v3M14 9h6v6h-6z' },
  { kind: 'violin', label: 'Violin', hint: 'Density shape per category', icon: 'M8 3c-3 4 2 6-1 9s-1 5 1 9c2-4 4-6 1-9s2-5-1-9zM17 5c-2 3 1 5-1 7s-1 4 1 7c2-3 3-5 1-7s2-4-1-7z' },
  { kind: 'strip', label: 'Strip', hint: 'Every value as a jittered dot per category', icon: 'M6 6h.01M8 10h.01M5 14h.01M7 18h.01M16 5h.01M18 9h.01M15 12h.01M17 16h.01' },
  { kind: 'scatter', label: 'Scatter', hint: 'Two numeric columns; drag to select → filter', icon: 'M3 20h18M3 20V3M7 15h.01M10 11h.01M13 13h.01M15 7h.01M18 9h.01' },
  { kind: 'ecdf', label: 'ECDF', hint: 'Cumulative share ≤ x — compares whole distributions', icon: 'M3 20h18M3 20h4v-4h4v-5h4V7h6' },
  { kind: 'heatmap', label: 'Heatmap', hint: 'Counts or an aggregate across two columns', icon: 'M4 4h5v5H4zM10 4h5v5h-5zM16 4h4v5h-4zM4 10h5v5H4zM10 10h5v5h-5zM16 10h4v5h-4zM4 16h5v4H4zM10 16h5v4h-5z' },
]

const AGGS: { value: Agg; label: string }[] = [
  { value: 'count', label: 'Count' },
  { value: 'share', label: 'Share %' },
  { value: 'mean', label: 'Mean' },
  { value: 'median', label: 'Median' },
  { value: 'sum', label: 'Sum' },
  { value: 'min', label: 'Min' },
  { value: 'max', label: 'Max' },
]

/** Keep a spec valid for the chosen chart kind: drop columns the kind can't use, fill required ones. */
export function normalizeSpec(ds: Dataset, spec: ChartSpec): ChartSpec {
  const s = { ...DEFAULT_SPEC, ...spec }
  for (const role of ['x', 'y', 'z', 'color', 'facet'] as Role[]) {
    const v = s[role]
    if (v && !allowedColumns(ds, s.kind, role).some((c) => c.name === v)) s[role] = null
  }
  for (const role of KIND_NEEDS[s.kind]) {
    if (!s[role as 'x' | 'y']) {
      const opts = allowedColumns(ds, s.kind, role).filter((c) => c.distinct > 1)
      const pick = opts.find((c) => !c.derived && c.name !== s.x) ?? opts[0]
      s[role as 'x' | 'y'] = pick?.name ?? null
    }
  }
  return s
}

interface Props {
  ds: Dataset
  rows: Row[]
  spec: ChartSpec
  onSpec: (s: ChartSpec) => void
  onAddFilters: (seeds: FilterSeed[]) => void
  tokens: ThemeTokens
}

export function ChartBuilder({ ds, rows, spec, onSpec, onAddFilters, tokens }: Props) {
  const [showTable, setShowTable] = useState(false)
  const set = (patch: Partial<ChartSpec>) => onSpec(normalizeSpec(ds, { ...spec, ...patch }))
  const fig = useMemo(() => buildFigure(ds, rows, spec, tokens), [ds, rows, spec, tokens])
  const col = (n: string | null) => ds.columns.find((c) => c.name === n) ?? null
  const xc = col(spec.x)
  const yc = col(spec.y)
  const presets = PRESETS[ds.id] ?? []

  const onClickIndex = useCallback(
    (cd: unknown) => {
      if (typeof cd === 'number' && fig.clicks[cd]) onAddFilters(fig.clicks[cd])
    },
    [fig, onAddFilters],
  )

  const onSelectRange = useCallback(
    (r: SelectRange) => {
      if (spec.kind !== 'scatter' || !xc || !yc) return
      const parse = (v: number | string, isDate: boolean, tr: Transform) =>
        isDate ? Date.parse(`${String(v).replace(' ', 'T')}Z`) : invertTransform(Number(v), tr)
      const seeds: FilterSeed[] = []
      if (r.x) {
        const a = parse(r.x[0], xc.type === 'datetime', spec.xTransform)
        const b = parse(r.x[1], xc.type === 'datetime', spec.xTransform)
        seeds.push({ column: xc.name, kind: 'range', min: Math.min(a, b), max: Math.max(a, b) })
      }
      if (r.y && !spec.jitterY) {
        const a = parse(r.y[0], yc.type === 'datetime', spec.yTransform)
        const b = parse(r.y[1], yc.type === 'datetime', spec.yTransform)
        seeds.push({ column: yc.name, kind: 'range', min: Math.min(a, b), max: Math.max(a, b) })
      }
      if (seeds.length) onAddFilters(seeds)
    },
    [spec, xc, yc, onAddFilters],
  )

  const needs = (role: Role) => KIND_NEEDS[spec.kind].includes(role)
  const k = spec.kind
  const hasNumX = xc?.type === 'number'
  const hasDateX = xc?.type === 'datetime'
  const binnedX = (k === 'histogram' || k === 'line' || k === 'bar' || k === 'heatmap') && hasNumX && !(k === 'bar' && xc && xc.distinct <= 40 && isDiscrete(xc))
  const usesAgg = k === 'bar' || k === 'line' || k === 'heatmap'
  const aggNeedsValue = spec.agg !== 'count' && spec.agg !== 'share'

  const tr: { value: Transform; label: string; title: string }[] = [
    { value: 'none', label: 'Linear', title: 'Raw values, evenly spaced.' },
    { value: 'log10', label: 'log₁₀', title: 'Each step is ×10. For positive values spanning orders of magnitude.' },
    { value: 'logit', label: 'logit', title: HELP['c.logit'].text },
  ]

  return (
    <div className="builder">
      {presets.length > 0 && (
        <div className="presets">
          <span className="presets-label has-tip" {...tip('ex.presets', true)}>
            Quick views
          </span>
          {presets.map((p) => (
            <button key={p.label} type="button" className="preset" data-tip={p.hint} data-tip-title={p.label} onClick={() => onSpec(normalizeSpec(ds, { ...DEFAULT_SPEC, ...p.spec }))}>
              {p.label}
            </button>
          ))}
        </div>
      )}

      <div className="builder-grid">
        <aside className="controls" aria-label="Chart settings">
          <div className="kind-grid" role="radiogroup" aria-label="Chart type">
            {KINDS.map((x) => (
              <button key={x.kind} type="button" role="radio" aria-checked={k === x.kind} className={`kind ${k === x.kind ? 'on' : ''}`} {...tip(`kind.${x.kind}` as HelpKey)} onClick={() => set({ kind: x.kind })}>
                <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d={x.icon} />
                </svg>
                <span>{x.label}</span>
              </button>
            ))}
          </div>

          <div className="control-group">
            <Field label={k === 'box' || k === 'violin' || k === 'strip' ? 'Group (x)' : 'X'} tipKey={k === 'box' || k === 'violin' || k === 'strip' ? 'ctl.group' : 'ctl.x'}>
              <ColumnSelect columns={allowedColumns(ds, k, 'x')} value={spec.x} onChange={(v) => set({ x: v })} allowNone={!needs('x')} noneLabel="— all rows —" />
            </Field>
            {(hasNumX && k !== 'box' && k !== 'violin' && k !== 'strip') && (
              <Field label="X scale" tipKey="ctl.xscale">
                <Segmented size="sm" value={spec.xTransform} options={tr} onChange={(v) => set({ xTransform: v })} />
              </Field>
            )}
            {(needs('y') || (usesAgg && aggNeedsValue && k !== 'heatmap')) && (
              <Field label={usesAgg && k !== 'heatmap' ? `Value (${spec.agg})` : 'Y'} tipKey={usesAgg && k !== 'heatmap' ? 'ctl.value' : 'ctl.y'}>
                <ColumnSelect columns={allowedColumns(ds, k, 'y')} value={spec.y} onChange={(v) => set({ y: v })} allowNone={!needs('y')} />
              </Field>
            )}
            {(k === 'scatter' || k === 'box' || k === 'violin' || k === 'strip') && yc?.type === 'number' && (
              <Field label="Y scale" tipKey="ctl.yscale">
                <Segmented size="sm" value={spec.yTransform} options={tr} onChange={(v) => set({ yTransform: v })} />
              </Field>
            )}
            {usesAgg && (
              <Field label={k === 'heatmap' ? 'Cell value' : 'Aggregate'} tipKey={k === 'heatmap' ? 'ctl.cell' : 'ctl.agg'}>
                <select className="select" value={spec.agg} onChange={(e) => set({ agg: e.target.value as Agg })}>
                  {AGGS.filter((a) => !(k === 'heatmap' && a.value === 'share')).map((a) => (
                    <option key={a.value} value={a.value}>
                      {a.label}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            {k === 'heatmap' && aggNeedsValue && (
              <Field label={`Value (${spec.agg})`} tipKey="ctl.value">
                <ColumnSelect columns={allowedColumns(ds, k, 'z')} value={spec.z} onChange={(v) => set({ z: v })} />
              </Field>
            )}
          </div>

          <div className="control-group">
            {k !== 'heatmap' && (
              <Field label="Color by" tipKey="ctl.color">
                <ColumnSelect columns={allowedColumns(ds, k, 'color')} value={spec.color} onChange={(v) => set({ color: v })} allowNone />
              </Field>
            )}
            <Field label="Small multiples by" tipKey="ctl.facet">
              <ColumnSelect columns={allowedColumns(ds, k, 'facet')} value={spec.facet} onChange={(v) => set({ facet: v })} allowNone />
            </Field>
            {spec.facet && <Toggle tipKey="ctl.sharedY" checked={spec.sharedY} onChange={(v) => set({ sharedY: v })} label="Same y-axis in every panel" />}
          </div>

          <div className="control-group">
            {(binnedX || (k === 'scatter' && spec.trend)) && (
              <Field label="Bins" tipKey="ctl.bins">
                <Range value={spec.bins} min={3} max={100} step={1} onChange={(v) => set({ bins: v })} />
              </Field>
            )}
            {(hasDateX || (k === 'heatmap' && (xc?.type === 'datetime' || yc?.type === 'datetime'))) && (
              <Field label="Time unit" tipKey="ctl.timeunit">
                <Segmented
                  size="sm"
                  value={spec.timeUnit}
                  onChange={(v) => set({ timeUnit: v })}
                  options={[
                    { value: 'hour', label: 'Hour' },
                    { value: 'day', label: 'Day' },
                    { value: 'week', label: 'Week' },
                    { value: 'month', label: 'Month' },
                  ]}
                />
              </Field>
            )}
            {k === 'histogram' && (
              <Field label="Normalize" tipKey="ctl.norm">
                <Segmented
                  size="sm"
                  value={spec.norm}
                  onChange={(v) => set({ norm: v })}
                  options={[
                    { value: 'count', label: 'Count', title: 'Rows per bin.' },
                    { value: 'percent', label: '% of group', title: 'Each group sums to 100% — compares shapes of groups with different sizes.' },
                    { value: 'density', label: 'Density', title: 'Share per unit of x; bar areas sum to 1.' },
                  ]}
                />
              </Field>
            )}
            {(k === 'histogram' || k === 'bar') && spec.color && (
              <Field label="Groups" tipKey="ctl.barmode">
                <Segmented
                  size="sm"
                  value={spec.barmode}
                  onChange={(v) => set({ barmode: v })}
                  options={[
                    { value: 'overlay', label: 'Overlay', title: 'Series drawn on top of each other, semi-transparent.' },
                    { value: 'stack', label: 'Stack', title: 'Series piled up; the top of the pile is the total.' },
                    { value: 'group', label: 'Side by side', title: 'Series next to each other within each position.' },
                  ]}
                />
              </Field>
            )}
            {(k === 'bar' || k === 'heatmap' || k === 'box' || k === 'violin' || k === 'strip') && (
              <Field label="Max categories" tipKey="ctl.topn">
                <Range value={spec.topN} min={3} max={80} step={1} onChange={(v) => set({ topN: v })} />
              </Field>
            )}
            {k === 'bar' && (
              <>
                <Field label="Order" tipKey="ctl.order">
                  <Segmented
                    size="sm"
                    value={spec.sort}
                    onChange={(v) => set({ sort: v })}
                    options={[
                      { value: 'value', label: 'By count', title: 'Largest first.' },
                      { value: 'label', label: 'A → Z', title: 'Alphabetical / natural order (numbers in numeric order).' },
                    ]}
                  />
                </Field>
                <Toggle tipKey="ctl.horizontal" checked={spec.horizontal} onChange={(v) => set({ horizontal: v })} label="Horizontal bars" />
              </>
            )}
            {(k === 'histogram' || k === 'bar' || k === 'line' || k === 'box' || k === 'violin' || k === 'strip' || k === 'scatter') && (
              <Toggle tipKey="ctl.logy" checked={spec.logY} onChange={(v) => set({ logY: v })} label="Log y-axis" />
            )}
            {k === 'scatter' && (
              <>
                <Toggle tipKey="ctl.trend" checked={spec.trend} onChange={(v) => set({ trend: v })} label="Binned mean of Y (± 95% CI)" />
                {spec.trend && spec.color && <Toggle tipKey="ctl.trendByGroup" checked={spec.trendByGroup} onChange={(v) => set({ trendByGroup: v })} label="One binned mean per color group" />}
                <Field label="Jitter X" tipKey="ctl.jitterx">
                  <Range value={spec.jitterX} min={0} max={0.2} step={0.01} onChange={(v) => set({ jitterX: v })} format={(v) => `${Math.round(v * 100)}%`} />
                </Field>
                <Field label="Jitter Y" tipKey="ctl.jittery">
                  <Range value={spec.jitterY} min={0} max={0.2} step={0.01} onChange={(v) => set({ jitterY: v })} format={(v) => `${Math.round(v * 100)}%`} />
                </Field>
              </>
            )}
            {(k === 'scatter' || k === 'strip') && (
              <Field label="Point opacity" tipKey="ctl.opacity">
                <Range value={spec.opacity} min={0.1} max={1} step={0.05} onChange={(v) => set({ opacity: v })} format={(v) => `${Math.round(v * 100)}%`} />
              </Field>
            )}
          </div>
          <button type="button" className="btn link sm" {...tip('ctl.reset')} onClick={() => onSpec(normalizeSpec(ds, { ...DEFAULT_SPEC, kind: spec.kind }))}>
            Reset chart settings
          </button>
        </aside>

        <section className="chart-area">
          <div className="chart-card">
            {fig.message ? (
              <div className="empty tall">{fig.message}</div>
            ) : (
              <Plot data={fig.data} layout={fig.layout} height={fig.height} onClickIndex={onClickIndex} onSelectRange={spec.kind === 'scatter' ? onSelectRange : undefined} filename={`${ds.id}_${spec.kind}`} />
            )}
          </div>
          {!fig.message && (
            <p className="reading">
              <span className="reading-label">How to read this chart</span> {readingGuide(ds, spec)}
            </p>
          )}
          <div className="chart-hint muted small has-tip" {...tip('ex.hint', true)}>
            {k === 'scatter'
              ? 'Drag a box on the chart to filter to that region · double-click to reset zoom.'
              : fig.clicks.length
                ? 'Click a bar or cell to filter to it · click legend items to hide/show series · double-click a legend item to isolate it.'
                : 'Click legend items to hide/show series · double-click a legend item to isolate it.'}
            {spec.xTransform === 'logit' && ' · logit clamps scores to [0.0001, 0.9999] so 1.0 stays finite.'}
          </div>

          {fig.table.rows.length > 0 && (
            <div className="data-twin">
              <div className="data-twin-head">
                <button type="button" className="btn link sm" {...tip('ex.twin')} onClick={() => setShowTable(!showTable)} aria-expanded={showTable}>
                  <Icon name="table" size={14} /> Data behind this chart ({fmtInt(fig.table.rows.length)} rows) {showTable ? '▾' : '▸'}
                </button>
                <span className="grow" />
                <button type="button" className="btn ghost sm" onClick={() => downloadCsv(`${ds.id}_${spec.kind}_summary`, fig.table.columns, fig.table.rows)}>
                  <Icon name="download" size={14} /> CSV
                </button>
              </div>
              {showTable && (
                <div className="table-wrap short">
                  <table className="data-table compact">
                    <thead>
                      <tr>
                        {fig.table.columns.map((c) => (
                          <th key={c} className="">
                            {c}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {fig.table.rows.slice(0, 1000).map((r, i) => (
                        <tr key={i}>
                          {r.map((v, j) => (
                            <td key={j} className={typeof v === 'number' ? 'num' : ''}>
                              {typeof v === 'number' ? fmtNum(v, 4) : v ?? '—'}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </section>
      </div>
    </div>
  )
}

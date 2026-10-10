import { useMemo, useState } from 'react'
import { categoryOrder, isDiscrete, keyOf } from '../data/filter'
import { fmtNum, maxOf, minOf } from '../data/stats'
import { NULL_KEY, type Dataset, type Row } from '../data/types'
import { MAX_SERIES, OTHER, SERIES, type ThemeTokens } from '../lib/palette'
import { Plot } from './Plot'
import { tip } from '../lib/help'
import { ColumnSelect, Field, Segmented, Toggle } from './ui'

type Basemap = 'light' | 'dark' | 'satellite' | 'streets' | 'none'

const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'

function mapStyle(b: Basemap): Record<string, unknown> {
  switch (b) {
    case 'light':
      return { style: 'carto-positron' }
    case 'dark':
      return { style: 'carto-darkmatter' }
    case 'streets':
      return { style: 'open-street-map' }
    case 'satellite':
      return { style: 'white-bg', layers: [{ sourcetype: 'raster', source: [ESRI], below: 'traces', sourceattribution: 'Esri World Imagery' }] }
    default:
      return { style: 'white-bg' }
  }
}

/**
 * Center + zoom that fit every plotted point. MapLibre's world is 512·2^z px wide, so the zoom
 * that fits a span of Δ degrees into W px is log2(W·360 / (512·Δ)); near the equator latitude
 * degrees are ~the same size as longitude degrees, so the same formula works for height.
 */
function fit(lats: number[], lons: number[], w = 820, h = 620) {
  if (!lats.length) return { center: { lat: 0, lon: 0 }, zoom: 1 }
  const [a, b] = [minOf(lats), maxOf(lats)]
  const [c, d] = [minOf(lons), maxOf(lons)]
  const latSpan = Math.max((b - a) * 1.15, 0.002)
  const lonSpan = Math.max((d - c) * 1.15, 0.002)
  const z = Math.log2(Math.min(w / lonSpan, h / latSpan) * (360 / 512))
  return { center: { lat: (a + b) / 2, lon: (c + d) / 2 }, zoom: Math.max(1, Math.min(19, z)) }
}

export function MapView({ ds, rows, tokens }: { ds: Dataset; rows: Row[]; tokens: ThemeTokens }) {
  const [on, setOn] = useState<Record<string, boolean>>(() => Object.fromEntries([...ds.geo.map((g) => [g.id, true]), ...ds.paths.map((p) => [p.id, true])]))
  const [color, setColor] = useState<string | null>(null)
  const [basemap, setBasemap] = useState<Basemap>(tokens.theme === 'dark' ? 'dark' : 'light')

  const fig = useMemo(() => {
    const data: object[] = []
    const lats: number[] = []
    const lons: number[] = []
    const series = SERIES[tokens.theme]
    const order = color ? categoryOrder(ds, color).filter((k) => k !== NULL_KEY).slice(0, MAX_SERIES) : []
    const slot = new Map(order.map((k, i) => [k, i]))
    const keyFor = (r: Row) => {
      if (!color) return 'all'
      const k = keyOf(r[color])
      return slot.has(k) ? k : k === NULL_KEY ? NULL_KEY : 'Other'
    }
    const keys = color ? [...order, 'Other', NULL_KEY] : ['all']
    const label = (r: Row) => (ds.labelColumn && r[ds.labelColumn] !== null ? String(r[ds.labelColumn]) : '')

    for (const p of ds.paths) {
      if (!on[p.id]) continue
      const la: (number | null)[] = []
      const lo: (number | null)[] = []
      for (const r of rows) {
        const pts = p.points.map((pt) => [r[pt.lat], r[pt.lon]]).filter(([a, b]) => typeof a === 'number' && typeof b === 'number') as [number, number][]
        if (pts.length < 2) continue
        for (const [a, b] of pts) {
          la.push(a)
          lo.push(b)
        }
        la.push(null)
        lo.push(null)
      }
      data.push({ type: 'scattermap', mode: 'lines', lat: la, lon: lo, name: p.label, line: { color: tokens.theme === 'dark' || basemap === 'satellite' ? '#ffffff' : '#00354D', width: 2 }, hoverinfo: 'skip' })
    }

    ds.geo.forEach((g, gi) => {
      if (!on[g.id]) return
      for (const k of keys) {
        const rs = rows.filter((r) => typeof r[g.lat] === 'number' && typeof r[g.lon] === 'number' && keyFor(r) === k)
        if (!rs.length) continue
        const la = rs.map((r) => r[g.lat] as number)
        const lo = rs.map((r) => r[g.lon] as number)
        lats.push(...la)
        lons.push(...lo)
        const c = !color ? series[gi % series.length] : slot.has(k) ? series[slot.get(k)!] : OTHER[tokens.theme]
        data.push({
          type: 'scattermap',
          mode: 'markers',
          lat: la,
          lon: lo,
          name: color ? `${k} · ${g.label}` : g.label,
          legendgroup: color ? k : g.id,
          marker: { size: g.id.includes('quadrat') ? 7 : 10, color: c, opacity: 0.9, symbol: 'circle' },
          text: rs.map(
            (r) =>
              `<b>${label(r) || g.label}</b><br>${g.label}${color ? `<br>${ds.columns.find((x) => x.name === color)?.label}: ${k}` : ''}${
                typeof r.quadrat_number === 'number' ? `<br>quadrat ${r.quadrat_number}` : ''
              }<br>${fmtNum(r[g.lat] as number, 8)}, ${fmtNum(r[g.lon] as number, 8)}${g.accuracy && typeof r[g.accuracy] === 'number' ? `<br>± ${fmtNum(r[g.accuracy] as number)} m` : ''}`,
          ),
          hovertemplate: '%{text}<extra></extra>',
        })
      }
    })
    const view = fit(lats, lons)
    const layout = {
      paper_bgcolor: tokens.surface,
      font: { family: tokens.font, color: tokens.ink2, size: 12 },
      margin: { l: 0, r: 0, t: 0, b: 0 },
      map: { ...mapStyle(basemap), center: view.center, zoom: view.zoom },
      legend: { x: 0.01, y: 0.99, bgcolor: tokens.surface, bordercolor: tokens.grid, borderwidth: 1, font: { size: 12 } },
      hoverlabel: { bgcolor: tokens.surface, bordercolor: tokens.axis, font: { family: tokens.font, color: tokens.ink } },
      showlegend: true,
    }
    return { data, layout, points: lats.length }
  }, [ds, rows, on, color, basemap, tokens])

  return (
    <div className="mapview">
      <aside className="controls">
        <div className="control-group">
          <div className="field-label has-tip" {...tip('map.layers', true)}>
            Layers
          </div>
          {ds.paths.map((p) => (
            <Toggle key={p.id} checked={!!on[p.id]} onChange={(v) => setOn({ ...on, [p.id]: v })} label={p.label} />
          ))}
          {ds.geo.map((g) => (
            <Toggle key={g.id} checked={!!on[g.id]} onChange={(v) => setOn({ ...on, [g.id]: v })} label={g.label} />
          ))}
        </div>
        <div className="control-group">
          <Field label="Color by" tipKey="map.color">
            <ColumnSelect columns={ds.columns.filter((c) => isDiscrete(c) && c.distinct > 1)} value={color} onChange={setColor} allowNone noneLabel="— by layer —" />
          </Field>
          <Field label="Basemap" tipKey="map.basemap">
            <Segmented
              size="sm"
              value={basemap}
              onChange={setBasemap}
              options={[
                { value: 'light', label: 'Light', title: 'CARTO Positron — quiet grey basemap.' },
                { value: 'dark', label: 'Dark', title: 'CARTO Dark Matter.' },
                { value: 'satellite', label: 'Satellite', title: 'Esri World Imagery — see vegetation, tracks and clearings.' },
                { value: 'streets', label: 'Streets', title: 'OpenStreetMap standard tiles.' },
                { value: 'none', label: 'None', title: 'No background: points only (works offline).' },
              ]}
            />
          </Field>
        </div>
        <p className="muted small has-tip" {...tip('map.how', true)}>
          {fig.points.toLocaleString('en-US')} points from the filtered rows. Basemap tiles load from the internet; points and transects draw offline.
        </p>
      </aside>
      <section className="chart-area">
        <div className="chart-card map-card">
          <Plot data={fig.data} layout={fig.layout} height={620} filename={`${ds.id}_map`} />
        </div>
      </section>
    </div>
  )
}

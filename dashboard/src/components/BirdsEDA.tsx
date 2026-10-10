/**
 * Exploratory analysis of the bird data: evidence by recorder, data flow, calendar & effort, daily
 * clock, detection bouts, a threshold preview, and co-detection. All computed from the CSVs; times
 * are local (EAT) using the inferred recorder clock corrections.
 */
import { useMemo, useState, type ReactNode } from 'react'
import { axisStyle, baseLayout } from '../charts/build'
import { categoryOrder } from '../data/filter'
import { CONF_BAND_LABELS, confBandOf, fmtDate, fmtInt, fmtNum, fmtPct, maxOf, medianOf, minOf, quantileSorted, wilson } from '../data/stats'
import { CANDIDATE_SITES, EAT_OFFSET_H, fmtClock, meanSun } from '../data/sun'
import type { Dataset, Row } from '../data/types'
import { OTHER, SERIES, sequentialScale, type ThemeTokens } from '../lib/palette'
import { Plot } from './Plot'
import { Range, Segmented } from './ui'

const BAND_LABELS = CONF_BAND_LABELS
const bandOf = confBandOf
const median = medianOf

type Tab = 'evidence' | 'flow' | 'calendar' | 'clock' | 'bouts' | 'thresholds' | 'codetect'
const TABS: { key: Tab; label: string; sub: string }[] = [
  { key: 'evidence', label: 'Evidence by recorder', sub: 'matrix · score ridges' },
  { key: 'flow', label: 'Data flow', sub: 'Sankey' },
  { key: 'calendar', label: 'Calendar & effort', sub: 'date × hour · trends' },
  { key: 'clock', label: 'Daily clock', sub: 'polar' },
  { key: 'bouts', label: 'Bouts', sub: 'runs · intervals' },
  { key: 'thresholds', label: 'Threshold preview', sub: 'retention · precision' },
  { key: 'codetect', label: 'Co-detection', sub: 'species overlap' },
]

/** Diverging scale for a proportion correct: orange-red (wrong) ↔ neutral ↔ teal (correct). */
function correctScale(t: ThemeTokens): [number, string][] {
  const s = SERIES[t.theme]
  return [
    [0, s[3]],
    [0.5, t.theme === 'dark' ? '#383835' : '#f0efec'],
    [1, s[0]],
  ]
}

function Section({ title, sub, children, right }: { title: string; sub?: ReactNode; children: ReactNode; right?: ReactNode }) {
  return (
    <section className="sum-section">
      <div className="sum-section-head">
        <div>
          <h2>{title}</h2>
          {sub && <p className="muted">{sub}</p>}
        </div>
        {right}
      </div>
      {children}
    </section>
  )
}

const Takeaway = ({ children }: { children: ReactNode }) => (
  <div className="for-us">
    <div className="pipe-col-label">What it shows</div>
    {children}
  </div>
)

interface Ctx {
  pred: Dataset
  val: Dataset
  t: ThemeTokens
  species: string[]
  color: (sp: string) => string
}

// ── 1 + 2. evidence by recorder ───────────────────────────────────────────────

function Evidence({ pred, val, t, species, color }: Ctx) {
  const [metric, setMetric] = useState<'share' | 'median' | 'npred'>('share')
  const [sp, setSp] = useState(species[1] ?? species[0])
  const m = useMemo(() => {
    const cells = new Map<string, { nP: number; conf: number[]; nV: number; ok: number }>()
    const key = (r: string, s: string) => `${r}|${s}`
    pred.rows.forEach((r) => {
      const k = key(String(r.folder), String(r.common_name))
      const c = cells.get(k) ?? { nP: 0, conf: [], nV: 0, ok: 0 }
      c.nP++
      c.conf.push(r.confidence as number)
      cells.set(k, c)
    })
    val.rows.forEach((r) => {
      const k = key(String(r.recorder), String(r.commonName))
      const c = cells.get(k) ?? { nP: 0, conf: [], nV: 0, ok: 0 }
      c.nV++
      if (r.outcome === 1) c.ok++
      cells.set(k, c)
    })
    const totals = new Map<string, number>()
    pred.rows.forEach((r) => totals.set(String(r.folder), (totals.get(String(r.folder)) ?? 0) + 1))
    const recs = [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k)
    return { cells, recs, key }
  }, [pred, val])

  const matrix = useMemo(() => {
    const xs: string[] = []
    const ys: string[] = []
    const val: number[] = []
    const size: number[] = []
    const text: string[] = []
    const hollowX: string[] = []
    const hollowY: string[] = []
    const hollowT: string[] = []
    for (const rec of m.recs)
      for (const s of species) {
        const c = m.cells.get(m.key(rec, s))
        if (!c) continue
        const med = median(c.conf)
        const info = `<b>${rec} · ${s}</b><br>${fmtInt(c.nP)} predictions · median confidence ${fmtNum(med, 2)}<br>${c.nV ? `validated ${c.ok}/${c.nV} correct (${fmtPct(c.ok / c.nV, 0)})` : 'not validated'}`
        if (metric === 'share' && !c.nV) {
          hollowX.push(s)
          hollowY.push(rec)
          hollowT.push(info)
          continue
        }
        xs.push(s)
        ys.push(rec)
        val.push(metric === 'share' ? c.ok / c.nV : metric === 'median' ? med : Math.log10(c.nP))
        size.push(metric === 'share' ? 7 + Math.sqrt(c.nV) * 3.2 : 7 + Math.sqrt(c.nP) * 0.35)
        text.push(info)
      }
    const cs = metric === 'share' ? correctScale(t) : sequentialScale(t.theme)
    const data: object[] = [
      {
        type: 'scatter',
        mode: 'markers',
        x: xs,
        y: ys,
        marker: {
          color: val,
          colorscale: cs,
          cmin: metric === 'npred' ? 0 : 0,
          cmax: metric === 'npred' ? Math.log10(6000) : 1,
          size: size.map((s) => Math.min(s, 46)),
          line: { color: t.axis, width: 1 },
          colorbar: {
            title: { text: metric === 'share' ? 'share correct' : metric === 'median' ? 'median confidence' : 'predictions', side: 'right' },
            thickness: 10,
            outlinewidth: 0,
            tickfont: { color: t.muted },
            ...(metric === 'npred' ? { tickvals: [0, 1, 2, 3], ticktext: ['1', '10', '100', '1,000'] } : { tickformat: metric === 'share' ? '.0%' : '.1f' }),
          },
        },
        text,
        hovertemplate: '%{text}<extra></extra>',
        showlegend: false,
      },
    ]
    if (hollowX.length)
      data.push({ type: 'scatter', mode: 'markers', x: hollowX, y: hollowY, marker: { size: 6, color: 'rgba(0,0,0,0)', line: { color: t.muted, width: 1 } }, text: hollowT, hovertemplate: '%{text}<extra></extra>', showlegend: false })
    return {
      data,
      layout: {
        ...baseLayout(t),
        margin: { l: 70, r: 20, t: 20, b: 40 },
        xaxis: { ...axisStyle(t), type: 'category', categoryorder: 'array', categoryarray: species, side: 'top', showgrid: true },
        yaxis: { ...axisStyle(t), type: 'category', categoryorder: 'array', categoryarray: m.recs, autorange: 'reversed', tickfont: { size: 10, color: t.muted } },
        hovermode: 'closest',
      },
    }
  }, [m, metric, species, t])

  const ridges = useMemo(() => {
    const recs = m.recs.filter((r) => (m.cells.get(m.key(r, sp))?.nP ?? 0) >= 20)
    const med = new Map(recs.map((r) => [r, median(m.cells.get(m.key(r, sp))!.conf)]))
    recs.sort((a, b) => (med.get(a)! - med.get(b)!))
    const data: object[] = recs.map((r) => ({
      type: 'violin',
      orientation: 'h',
      side: 'positive',
      y0: r,
      x: m.cells.get(m.key(r, sp))!.conf,
      name: r,
      width: 1.9,
      points: false,
      line: { color: color(sp), width: 1 },
      fillcolor: `${color(sp)}38`,
      meanline: { visible: false },
      spanmode: 'hard',
      hoverinfo: 'skip',
      showlegend: false,
    }))
    const vals = val.rows.filter((r) => r.commonName === sp && recs.includes(String(r.recorder)))
    const s = SERIES[t.theme]
    for (const [ok, nm, col, sym] of [
      [1, 'validated: correct', s[0], 'circle'],
      [0, 'validated: incorrect', s[3], 'x-thin-open'],
    ] as const) {
      const v = vals.filter((r) => r.outcome === ok)
      data.push({ type: 'scatter', mode: 'markers', x: v.map((r) => r.confidence), y: v.map((r) => r.recorder), name: nm, marker: { color: col, size: 7, symbol: sym, line: { color: col, width: 1.5 }, opacity: 0.85 }, hovertemplate: `%{y} · confidence %{x:.3f}<extra>${nm}</extra>` })
    }
    return {
      n: recs.length,
      data,
      layout: {
        ...baseLayout(t),
        margin: { l: 70, r: 16, t: 36, b: 44 },
        legend: { orientation: 'h', x: 0, y: 1.0, yanchor: 'bottom' },
        xaxis: { ...axisStyle(t), title: { text: 'confidence' }, range: [0.08, 1.01] },
        yaxis: { ...axisStyle(t), type: 'category', categoryorder: 'array', categoryarray: recs, tickfont: { size: 10, color: t.muted } },
        violingap: 0,
      },
    }
  }, [m, sp, val, t, color])

  // Site problems: recorders where every validated clip (≥ 5) was wrong, for a species that is
  // mostly right elsewhere (≥ 70% correct at the other recorders). Otherwise it is not a site effect.
  const problems = [...m.cells.entries()].filter(([, c]) => c.nV >= 5 && c.ok === 0).map(([k, c]) => ({ k, c }))
  const elsewhere = (s: string, exclude: string[]) => {
    let n = 0
    let ok = 0
    m.cells.forEach((c, k) => {
      const [rec, sp] = k.split('|')
      if (sp === s && !exclude.includes(rec)) {
        n += c.nV
        ok += c.ok
      }
    })
    return { n, ok, share: n ? ok / n : NaN }
  }
  const siteInfo = (s: string) => {
    const ps = problems.filter((x) => x.k.endsWith(`|${s}`))
    const recs = ps.map((x) => x.k.split('|')[0])
    return { ps, other: elsewhere(s, recs), overall: elsewhere(s, []) }
  }

  return (
    <>
      <Section
        title="1 · Recorder × species evidence matrix"
        sub="One bubble per recorder (rows, most predictions first) and species. Size: number of validated clips (or predictions). Colour: share correct, median confidence or prediction volume. Hollow rings: predicted but never validated."
        right={
          <Segmented
            size="sm"
            value={metric}
            onChange={setMetric}
            options={[
              { value: 'share', label: 'Share correct', title: 'Validated clips marked correct' },
              { value: 'median', label: 'Median confidence', title: 'Of all predictions' },
              { value: 'npred', label: 'Predictions', title: 'Prediction volume (log scale)' },
            ]}
          />
        }
      >
        <div className="chart-card">
          <Plot data={matrix.data} layout={matrix.layout} height={Math.max(560, m.recs.length * 19 + 80)} filename="recorder_species_evidence" />
        </div>
      </Section>

      <Section
        title="2 · Score distributions by recorder"
        sub={`Ridgelines of confidence for one species at each recorder with ≥ 20 predictions (${ridges.n} recorders), sorted by median; validated clips overlaid (✓ correct, ✗ incorrect).`}
        right={<Segmented size="sm" value={sp} onChange={setSp} options={species.map((s) => ({ value: s, label: s.split(' ').slice(-1)[0], title: s }))} />}
      >
        <div className="chart-card">
          <Plot data={ridges.data} layout={ridges.layout} height={Math.max(420, ridges.n * 30 + 100)} filename="score_ridgelines_by_recorder" />
        </div>
      </Section>

      <Takeaway>
        <ul>
          {species.map((s) => {
            const x = siteInfo(s)
            if (!x.ps.length) return null
            const list = x.ps.map((q) => `${q.k.split('|')[0]} (${q.c.nV} clips, median confidence ${fmtNum(median(q.c.conf), 2)})`).join(', ')
            return x.other.share >= 0.7 ? (
              <li key={s}>
                <b>{s}</b>: every validated clip was wrong at {list}, while {fmtPct(x.other.share, 0)} of its clips at other recorders were correct — a <b>site-specific</b> false-positive source; those recorders’ score distributions sit far to the left.
              </li>
            ) : (
              <li key={s}>
                <b>{s}</b>: wrong almost everywhere ({fmtPct(x.overall.share, 0)} correct overall), so the all-wrong recorders ({x.ps.map((q) => q.k.split('|')[0]).join(', ')}) reflect the species, not particular sites.
              </li>
            )
          })}
          <li>Recorders differ in score distributions even for the same species — consistent with Wood &amp; Kahl’s warning that scores are not transferable across recording setups or sites.</li>
        </ul>
      </Takeaway>
    </>
  )
}

// ── 3. data flow ──────────────────────────────────────────────────────────────

function Flow({ pred, val, t, species, color }: Ctx) {
  const [mode, setMode] = useState<'validation' | 'pipeline'>('validation')
  const fig = useMemo(() => {
    const s = SERIES[t.theme]
    const labels: string[] = []
    const colors: string[] = []
    const idx = new Map<string, number>()
    const node = (k: string, label: string, c: string) => {
      if (!idx.has(k)) {
        idx.set(k, labels.length)
        labels.push(label)
        colors.push(c)
      }
      return idx.get(k)!
    }
    const src: number[] = []
    const tgt: number[] = []
    const value: number[] = []
    const lcol: string[] = []
    const link = (a: number, b: number, v: number, c: string) => {
      if (v <= 0) return
      src.push(a)
      tgt.push(b)
      value.push(v)
      lcol.push(c)
    }
    if (mode === 'validation') {
      const correct = node('ok', `correct (${val.rows.filter((r) => r.outcome === 1).length})`, s[0])
      const wrong = node('bad', `incorrect (${val.rows.filter((r) => r.outcome === 0).length})`, s[3])
      species.forEach((sp) => {
        const V = val.rows.filter((r) => r.commonName === sp)
        const a = node(`sp:${sp}`, `${sp} (${V.length})`, color(sp))
        BAND_LABELS.forEach((bl, i) => {
          const inB = V.filter((r) => bandOf(r.confidence as number) === i)
          const b = node(`band:${i}`, `confidence ${bl}`, OTHER[t.theme])
          link(a, b, inB.length, `${color(sp)}66`)
        })
      })
      BAND_LABELS.forEach((_, i) => {
        const inB = val.rows.filter((r) => bandOf(r.confidence as number) === i)
        const b = idx.get(`band:${i}`)
        if (b === undefined) return
        link(b, correct, inB.filter((r) => r.outcome === 1).length, `${s[0]}55`)
        link(b, wrong, inB.filter((r) => r.outcome === 0).length, `${s[3]}66`)
      })
    } else {
      // Prediction rows, not review rows: a prediction is "validated" only when a review resolves to it
      // uniquely (shared duplicate reviews count once); tied-score candidates are kept apart because the
      // exact reviewed segment is unknown, and no outcome is assigned to them.
      const all = node('all', `All predictions (${fmtInt(pred.rows.length)})`, t.ink2)
      const notVal = node('nv', 'not validated', OTHER[t.theme])
      const tied = node('tied', 'candidate of a tied-score review', SERIES[t.theme][5])
      const resolved = node('lk', 'validated (resolved)', s[2])
      const correct = node('ok', 'correct', s[0])
      const wrong = node('bad', 'incorrect', s[3])
      species.forEach((sp) => {
        const P = pred.rows.filter((r) => r.common_name === sp)
        const a = node(`sp:${sp}`, `${sp} (${fmtInt(P.length)})`, color(sp))
        link(all, a, P.length, `${color(sp)}44`)
        const res = P.filter((r) => r.validated === 'yes')
        const cand = P.filter((r) => r.validated === 'tied')
        link(a, notVal, P.length - res.length - cand.length, `${OTHER[t.theme]}55`)
        link(a, tied, cand.length, `${SERIES[t.theme][5]}66`)
        link(a, resolved, res.length, `${color(sp)}88`)
        link(resolved, correct, res.filter((r) => r.validation_outcome === 'correct').length, `${s[0]}55`)
        link(resolved, wrong, res.filter((r) => r.validation_outcome === 'incorrect').length, `${s[3]}66`)
      })
    }
    return {
      data: [
        {
          type: 'sankey',
          arrangement: 'snap',
          node: { label: labels, color: colors, pad: 14, thickness: 16, line: { color: t.surface, width: 1 } },
          link: { source: src, target: tgt, value, color: lcol, hovertemplate: '%{source.label} → %{target.label}: %{value}<extra></extra>' },
          textfont: { color: t.ink, size: 12, family: t.font },
        },
      ],
      layout: { ...baseLayout(t), margin: { l: 10, r: 10, t: 10, b: 10 } },
    }
  }, [mode, pred, val, t, species, color])
  return (
    <>
      <Section
        title="3 · Data flow"
        sub={mode === 'validation' ? 'The validation sample: species → confidence band → ornithologist’s verdict. Width = number of clips.' : 'Distinct prediction rows: resolved validated predictions (duplicate reviews count once), candidates of tied-score reviews (exact segment unknown, no outcome assigned), and the rest. Validation is under 2% of predictions — hover for exact numbers.'}
        right={
          <Segmented
            size="sm"
            value={mode}
            onChange={setMode}
            options={[
              { value: 'validation', label: 'Validation sample', title: 'species → band → outcome' },
              { value: 'pipeline', label: 'Whole pipeline', title: 'predictions → validated → outcome' },
            ]}
          />
        }
      >
        <div className="chart-card">
          <Plot data={fig.data} layout={fig.layout} height={520} filename="data_flow_sankey" />
        </div>
      </Section>
      <Takeaway>
        <ul>
          {species.map((sp) => {
            const V = val.rows.filter((r) => r.commonName === sp)
            const wrong = V.filter((r) => r.outcome === 0).map((r) => r.confidence as number)
            const low = V.filter((r) => (r.confidence as number) < 0.3).length
            return (
              <li key={sp}>
                <b>{sp}</b>: {wrong.length ? `${wrong.length} incorrect clips, the highest-scoring at ${fmtNum(Math.max(...wrong), 3)}` : 'no incorrect clips'}; {fmtPct(V.length ? low / V.length : NaN, 0)} of its validated clips score below 0.3.
              </li>
            )
          })}
        </ul>
      </Takeaway>
    </>
  )
}

// ── 4, 5, 8. calendar & effort ────────────────────────────────────────────────

function Calendar({ pred, t, species, color }: Ctx) {
  const [sp, setSp] = useState<string>('all')
  const [norm, setNorm] = useState<'raw' | 'perRec'>('perRec')
  const d = useMemo(() => {
    const rows = pred.rows.filter((r) => typeof r.date_local === 'number' && typeof r.hour_local === 'number')
    const days = [...new Set(rows.map((r) => r.date_local as number))].sort((a, b) => a - b)
    const dayIdx = new Map(days.map((x, i) => [x, i]))
    const recs = [...new Set(rows.map((r) => String(r.folder)))].sort()
    // effort proxy: audio files with ≥ 1 prediction per recorder per day (recorder clock day)
    const filesPer = new Map<string, Set<string>>()
    rows.forEach((r) => {
      const k = `${r.folder}|${r.recording_date}`
      if (!filesPer.has(k)) filesPer.set(k, new Set())
      filesPer.get(k)!.add(String(r.recording_file))
    })
    const recDays = [...new Set(pred.rows.map((r) => r.recording_date as number))].sort((a, b) => a - b)
    // one pass: active recorders per day, and count / confidence sum per species × day
    const recsByDay = new Map<number, Set<unknown>>()
    const bySpDay = new Map<string, { n: number; sum: number }>()
    pred.rows.forEach((r) => {
      const dd = r.recording_date as number
      if (!recsByDay.has(dd)) recsByDay.set(dd, new Set())
      recsByDay.get(dd)!.add(r.folder)
      const k = `${r.common_name}|${dd}`
      const x = bySpDay.get(k) ?? { n: 0, sum: 0 }
      x.n++
      x.sum += r.confidence as number
      bySpDay.set(k, x)
    })
    const activeRecs = recDays.map((dd) => recsByDay.get(dd)?.size ?? 0)
    return { rows, days, dayIdx, recs, filesPer, recDays, activeRecs, bySpDay }
  }, [pred])

  const cal = useMemo(() => {
    const rows = sp === 'all' ? d.rows : d.rows.filter((r) => r.common_name === sp)
    const z = d.days.map(() => new Array(24).fill(0))
    rows.forEach((r) => z[d.dayIdx.get(r.date_local as number)!][r.hour_local as number]++)
    return {
      data: [{ type: 'heatmap', x: Array.from({ length: 24 }, (_, h) => h), y: d.days.map((x) => fmtDate(x, false)), z: z.map((row) => row.map((v) => (v ? v : null))), colorscale: sequentialScale(t.theme), xgap: 1, ygap: 1, colorbar: { title: { text: 'detections', side: 'right' }, thickness: 10, outlinewidth: 0, tickfont: { color: t.muted } }, hovertemplate: '%{y} %{x}h: %{z} detections<extra></extra>' }],
      layout: { ...baseLayout(t), margin: { l: 90, r: 16, t: 16, b: 44 }, xaxis: { ...axisStyle(t), title: { text: 'hour of day (local, EAT)' }, dtick: 2, showgrid: false }, yaxis: { ...axisStyle(t), autorange: 'reversed', showgrid: false, tickfont: { size: 10, color: t.muted } } },
    }
  }, [d, sp, t])

  const effort = useMemo(() => {
    const z = d.recs.map((rec) => d.recDays.map((dd) => d.filesPer.get(`${rec}|${dd}`)?.size ?? null))
    return {
      data: [{ type: 'heatmap', x: d.recDays.map((x) => fmtDate(x, false)), y: d.recs, z, colorscale: sequentialScale(t.theme), xgap: 1, ygap: 1, colorbar: { title: { text: 'audio files with ≥ 1 prediction', side: 'right' }, thickness: 10, outlinewidth: 0, tickfont: { color: t.muted } }, hovertemplate: '%{y} · %{x}: %{z} files<extra></extra>' }],
      layout: { ...baseLayout(t), margin: { l: 64, r: 16, t: 16, b: 70 }, xaxis: { ...axisStyle(t), tickangle: -45, showgrid: false, tickfont: { size: 10, color: t.muted } }, yaxis: { ...axisStyle(t), autorange: 'reversed', showgrid: false, tickfont: { size: 10, color: t.muted } } },
    }
  }, [d, t])

  const trend = useMemo(() => {
    const per = species.map((s) => ({ s, counts: d.recDays.map((dd) => d.bySpDay.get(`${s}|${dd}`) ?? { n: 0, sum: 0 }) }))
    const x = d.recDays.map((dd) => fmtDate(dd, false))
    const det = per.map((p) => ({ type: 'scatter', mode: 'lines+markers', x, y: p.counts.map((c, i) => (norm === 'perRec' ? c.n / Math.max(1, d.activeRecs[i]) : c.n)), name: p.s, line: { color: color(p.s), width: 2 }, marker: { color: color(p.s), size: 5 }, hovertemplate: `${p.s}<br>%{x}: %{y:.1f}<extra></extra>` }))
    const conf = per.map((p) => ({ type: 'scatter', mode: 'lines+markers', x, y: p.counts.map((c) => (c.n >= 10 ? c.sum / c.n : null)), name: p.s, showlegend: false, connectgaps: false, line: { color: color(p.s), width: 2 }, marker: { color: color(p.s), size: 5 }, hovertemplate: `${p.s}<br>%{x}: mean %{y:.3f}<extra></extra>` }))
    const lay = (yt: string) => ({ ...baseLayout(t), margin: { l: 56, r: 16, t: 36, b: 60 }, legend: { orientation: 'h', x: 0, y: 1.02, yanchor: 'bottom' }, xaxis: { ...axisStyle(t), tickangle: -45, tickfont: { size: 10, color: t.muted } }, yaxis: { ...axisStyle(t), title: { text: yt } } })
    return { det, conf, layDet: lay(norm === 'perRec' ? 'detections per active recorder' : 'detections'), layConf: { ...lay('mean confidence'), showlegend: false } }
  }, [d, species, norm, t, color])

  return (
    <>
      <Section title="4 · Calendar: date × hour of day" sub="Detections per local day and hour. Shows the daily rhythm, the recording schedule (empty hours), and day-to-day changes." right={<Segmented size="sm" value={sp} onChange={setSp} options={[{ value: 'all', label: 'All species' }, ...species.map((s) => ({ value: s, label: s.split(' ').slice(-1)[0], title: s }))]} />}>
        <div className="chart-card">
          <Plot data={cal.data} layout={cal.layout} height={Math.max(420, d.days.length * 20 + 80)} filename="calendar_date_hour" />
        </div>
      </Section>
      <Section title="5 · Recording effort: recorder × date" sub="Audio files with at least one prediction, per recorder and day (recorder clock). Caveat: files with no predictions are not in the export, so this is a lower bound on effort — the file inventory would give true effort.">
        <div className="chart-card">
          <Plot data={effort.data} layout={effort.layout} height={Math.max(480, d.recs.length * 15 + 110)} filename="effort_recorder_date" />
        </div>
      </Section>
      <Section title="8 · Daily trends" sub="Detections and mean confidence per day for each species. Two separate charts — different measures never share an axis." right={<Segmented size="sm" value={norm} onChange={setNorm} options={[{ value: 'perRec', label: 'Per active recorder', title: 'Divide by the number of recorders with any prediction that day' }, { value: 'raw', label: 'Raw counts' }]} />}>
        <div className="bal-grid">
          <div className="chart-card">
            <Plot data={trend.det} layout={trend.layDet} height={330} filename="daily_detections" />
          </div>
          <div className="chart-card">
            <Plot data={trend.conf} layout={trend.layConf} height={330} filename="daily_mean_confidence" />
          </div>
        </div>
      </Section>
      <Takeaway>
        <ul>
          {(() => {
            const byHour = new Array(24).fill(0)
            d.rows.forEach((r) => byHour[r.hour_local as number]++)
            const empty = byHour.map((n, h) => (n === 0 ? h : -1)).filter((h) => h >= 0)
            const few = d.recDays.map((dd, i) => ({ dd, n: d.activeRecs[i] })).filter((x) => x.n <= 3)
            const maxRec = Math.max(...d.activeRecs)
            return (
              <>
                <li>{empty.length ? `No detections at all at ${empty.map((h) => `${String(h).padStart(2, '0')}h`).join(', ')} (local) on any day — most likely a gap in the recording schedule, not silence.` : 'Every hour of the day has detections on some day.'}</li>
                <li>
                  Deployment is staggered: between {Math.min(...d.activeRecs)} and {maxRec} recorders have predictions on a given day.{' '}
                  {few.length ? `On ${few.map((x) => `${fmtDate(x.dd, false)} (${x.n})`).join(', ')} only a few recorders were active, so “per active recorder” values there rest on one or two sites — read spikes at the ends of the period with care.` : ''}
                </li>
              </>
            )
          })()}
        </ul>
      </Takeaway>
    </>
  )
}

// ── 9. daily clock (polar) ────────────────────────────────────────────────────

function Clock({ pred, t, species, color }: Ctx) {
  const [metric, setMetric] = useState<'share' | 'conf'>('share')
  const fig = useMemo(() => {
    const days = pred.rows.map((r) => r.recording_date).filter((x): x is number => typeof x === 'number')
    const lo = minOf(days)
    const hi = maxOf(days)
    const sun = meanSun(CANDIDATE_SITES[0].lat, CANDIDATE_SITES[0].lon, lo, hi)
    const rise = sun.rise + EAT_OFFSET_H
    const set = sun.set + EAT_OFFSET_H
    const theta = Array.from({ length: 24 }, (_, h) => h * 15 + 7.5)
    const data: object[] = []
    const layout: Record<string, unknown> = { ...baseLayout(t), margin: { l: 30, r: 30, t: 40, b: 30 }, showlegend: false, annotations: [] as object[] }
    species.forEach((s, i) => {
      const P = pred.rows.filter((r) => r.common_name === s && typeof r.hour_local === 'number')
      const by = Array.from({ length: 24 }, (_, h) => P.filter((r) => r.hour_local === h))
      const mu = P.reduce((a, r) => a + (r.confidence as number), 0) / P.length
      // relative confidence is unknown (null), not zero, for hours with < 20 predictions
      const r = by.map((x) => (metric === 'share' ? x.length / P.length : x.length >= 20 ? x.reduce((a, q) => a + (q.confidence as number), 0) / x.length / mu : null))
      const pid = i === 0 ? 'polar' : `polar${i + 1}`
      const col = i % 2
      const row = Math.floor(i / 2)
      layout[pid] = {
        domain: { x: [col * 0.5 + 0.04, col * 0.5 + 0.46], y: [1 - (row + 1) * 0.5 + 0.06, 1 - row * 0.5 - 0.08] },
        bgcolor: t.surface,
        angularaxis: { direction: 'clockwise', rotation: 90, tickmode: 'array', tickvals: [0, 45, 90, 135, 180, 225, 270, 315], ticktext: ['00h', '03h', '06h', '09h', '12h', '15h', '18h', '21h'], gridcolor: t.grid, linecolor: t.axis, tickfont: { color: t.muted, size: 10 } },
        // ring labels would collide with the 06h label; exact values are in the hover
        radialaxis: { gridcolor: t.grid, linecolor: t.axis, showticklabels: false, ticks: '' },
      }
      ;(layout.annotations as object[]).push({ text: `<b>${s}</b>`, x: col * 0.5 + 0.25, y: 1 - row * 0.5 - 0.01, xref: 'paper', yref: 'paper', showarrow: false, font: { size: 12, color: t.ink } })
      data.push({ type: 'barpolar', r, theta, width: 14, subplot: pid, marker: { color: color(s), line: { color: t.surface, width: 1 } }, hovertemplate: metric === 'share' ? `${s}<br>%{theta}: %{r:.1%}<extra></extra>` : `${s}<br>relative confidence %{r:.2f}<extra></extra>` })
      const rmax = maxOf(r.filter((v): v is number => v !== null)) * 1.05 || 1
      for (const [h, c] of [
        [rise, SERIES[t.theme][5]],
        [set, SERIES[t.theme][4]],
      ] as const)
        data.push({ type: 'scatterpolar', mode: 'lines', r: [0, rmax], theta: [h * 15, h * 15], subplot: pid, line: { color: c, width: 2 }, hoverinfo: 'skip' })
    })
    return { data, layout, rise, set }
  }, [pred, species, metric, t, color])
  return (
    <>
      <Section
        title="9 · Daily clock"
        sub={`Share of each species’ detections by local hour (or relative mean confidence), on a 24-hour clock: midnight at the top, noon at the bottom. Yellow / violet spokes: sunrise ${fmtClock(fig.rise)} and sunset ${fmtClock(fig.set)} EAT at Lewa.`}
        right={
          <Segmented
            size="sm"
            value={metric}
            onChange={setMetric}
            options={[
              { value: 'share', label: 'Detections', title: 'Share of the species’ detections per hour' },
              { value: 'conf', label: 'Relative confidence', title: 'Hourly mean ÷ species mean (hours with ≥ 20 predictions)' },
            ]}
          />
        }
      >
        <div className="chart-card">
          <Plot data={fig.data} layout={fig.layout} height={720} filename="daily_clock_polar" />
        </div>
      </Section>
    </>
  )
}

// ── 6. bouts ──────────────────────────────────────────────────────────────────

function Bouts({ pred, t, species, color }: Ctx) {
  const [gap, setGap] = useState('3')
  const g = Number(gap)
  const d = useMemo(() => {
    return species.map((s) => {
      const byFile = new Map<string, number[]>()
      pred.rows.forEach((r) => {
        if (r.common_name !== s) return
        const k = String(r.recording_file)
        if (!byFile.has(k)) byFile.set(k, [])
        byFile.get(k)!.push(r.begin_time_s as number)
      })
      const lengths: number[] = []
      const gaps: number[] = []
      byFile.forEach((xs) => {
        xs.sort((a, b) => a - b)
        let run = 1
        for (let i = 1; i < xs.length; i++) {
          const dt = xs[i] - xs[i - 1]
          gaps.push(dt)
          if (dt <= g) run++
          else {
            lengths.push(run)
            run = 1
          }
        }
        lengths.push(run)
      })
      lengths.sort((a, b) => a - b)
      gaps.sort((a, b) => a - b)
      const n = lengths.reduce((a, b) => a + b, 0)
      return { s, n, bouts: lengths.length, lengths, gaps, medLen: quantileSorted(lengths, 0.5), p90: quantileSorted(lengths, 0.9), maxLen: lengths[lengths.length - 1] ?? 0, single: lengths.filter((x) => x === 1).length / Math.max(1, lengths.length) }
    })
  }, [pred, species, g])
  const lenFig = useMemo(() => {
    const maxL = 20
    const data = d.map((x) => {
      const counts = Array.from({ length: maxL }, (_, i) => x.lengths.filter((l) => (i === maxL - 1 ? l >= maxL : l === i + 1)).length / Math.max(1, x.bouts))
      return { type: 'scatter', mode: 'lines+markers', x: Array.from({ length: maxL }, (_, i) => (i === maxL - 1 ? `${maxL}+` : String(i + 1))), y: counts, name: x.s, line: { color: color(x.s), width: 2 }, marker: { color: color(x.s), size: 6 }, hovertemplate: `${x.s}<br>%{x} segments: %{y:.1%} of bouts<extra></extra>` }
    })
    return { data, layout: { ...baseLayout(t), margin: { l: 56, r: 16, t: 36, b: 48 }, legend: { orientation: 'h', x: 0, y: 1.02, yanchor: 'bottom' }, xaxis: { ...axisStyle(t), type: 'category', title: { text: g === 3 ? 'bout length (consecutive 3-s segments)' : `bout length (detections ≤ ${g} s apart)` } }, yaxis: { ...axisStyle(t), type: 'log', title: { text: 'share of bouts (log)' } } } }
  }, [d, t, color, g])
  const gapFig = useMemo(() => {
    const data = d.map((x) => {
      const step = Math.max(1, Math.floor(x.gaps.length / 600))
      const xs: number[] = []
      const ys: number[] = []
      for (let i = 0; i < x.gaps.length; i += step) {
        xs.push(x.gaps[i])
        ys.push((i + 1) / x.gaps.length)
      }
      return { type: 'scatter', mode: 'lines', x: xs, y: ys, name: x.s, line: { color: color(x.s), width: 2, shape: 'hv' }, hovertemplate: `${x.s}<br>≤ %{x:.0f} s: %{y:.0%} of intervals<extra></extra>` }
    })
    return { data, layout: { ...baseLayout(t), margin: { l: 56, r: 16, t: 36, b: 48 }, showlegend: false, xaxis: { ...axisStyle(t), type: 'log', title: { text: 'seconds to the next detection of the same species in the file (log)' } }, yaxis: { ...axisStyle(t), tickformat: '.0%', title: { text: 'cumulative share' } } } }
  }, [d, t, color])
  return (
    <>
      <Section
        title="6 · Detection bouts"
        sub="A bout = detections of the same species in the same file separated by at most the chosen gap (3 s = back-to-back segments). Calls and songs span several segments, so segments are not independent events."
        right={<Segmented size="sm" value={gap} onChange={setGap} options={['3', '6', '15', '60'].map((v) => ({ value: v, label: `≤ ${v} s`, title: `merge detections ≤ ${v} s apart` }))} />}
      >
        <div className="bal-grid">
          <div className="chart-card">
            <Plot data={lenFig.data} layout={lenFig.layout} height={330} filename="bout_lengths" />
          </div>
          <div className="chart-card">
            <Plot data={gapFig.data} layout={gapFig.layout} height={330} filename="inter_detection_intervals" />
          </div>
        </div>
        <div className="table-wrap auto">
          <table className="data-table sum-table">
            <thead>
              <tr>
                <th>Species</th>
                <th className="num">Detections (segments)</th>
                <th className="num">Bouts</th>
                <th className="num">{g === 3 ? 'Segments per bout' : 'Detections per bout'}</th>
                <th className="num">Single-segment bouts</th>
                <th className="num">Median · 90th pct · longest</th>
              </tr>
            </thead>
            <tbody>
              {d.map((x) => (
                <tr key={x.s}>
                  <td>
                    <b>{x.s}</b>
                  </td>
                  <td className="num">{fmtInt(x.n)}</td>
                  <td className="num">{fmtInt(x.bouts)}</td>
                  <td className="num">{fmtNum(x.n / Math.max(1, x.bouts), 3)}</td>
                  <td className="num">{fmtPct(x.single, 0)}</td>
                  <td className="num">
                    {x.medLen} · {x.p90} · {x.maxLen}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>
      <Takeaway>
        <ul>
          <li>Detections cluster: many are part of multi-segment bouts. Counting segments overstates the number of independent vocal events; any activity index should count bouts (or detection-positive minutes / days).</li>
          <li>Validated clips from the same bout share sound conditions — another reason to treat clips from the same file as clustered when fitting thresholds.</li>
        </ul>
      </Takeaway>
    </>
  )
}

// ── 7. threshold preview ──────────────────────────────────────────────────────

function Thresholds({ pred, val, t, species, color }: Ctx) {
  const [T, setT] = useState(0.5)
  const grid = useMemo(() => Array.from({ length: 91 }, (_, i) => +(0.1 + i * 0.01).toFixed(2)), [])
  const d = useMemo(
    () =>
      species.map((s) => {
        const pc = pred.rows.filter((r) => r.common_name === s).map((r) => r.confidence as number)
        const V = val.rows.filter((r) => r.commonName === s)
        // Coarse band-standardised precision above T (exploratory, not Tseng's fitted curve): each kept
        // prediction gets the share correct among reviewed clips in its band that are also ≥ T. Kept
        // predictions in a band with no such reviews are UNSUPPORTED: no estimate is made for the whole
        // kept set then, only bounds (unsupported all wrong … all right). Never borrows reviews below T.
        const at = (thr: number) => {
          const keptP = pc.filter((c) => c >= thr)
          const keptV = V.filter((r) => (r.confidence as number) >= thr)
          const ok = keptV.filter((r) => r.outcome === 1).length
          const bandPrec = BAND_LABELS.map((_, i) => {
            const above = keptV.filter((r) => bandOf(r.confidence as number) === i)
            return above.length ? above.filter((r) => r.outcome === 1).length / above.length : NaN
          })
          let num = 0
          let supported = 0
          for (const c of keptP) {
            const p = bandPrec[bandOf(c)]
            if (Number.isFinite(p)) {
              num += p
              supported++
            }
          }
          const unsupported = keptP.length - supported
          return {
            retained: pc.length ? keptP.length / pc.length : NaN,
            nKept: keptP.length,
            nV: keptV.length,
            ok,
            raw: keptV.length ? ok / keptV.length : NaN,
            ci: wilson(ok, keptV.length),
            supported,
            unsupported,
            reweighted: keptP.length && unsupported === 0 ? num / keptP.length : NaN,
            rwLo: keptP.length ? num / keptP.length : NaN,
            rwHi: keptP.length ? (num + unsupported) / keptP.length : NaN,
          }
        }
        // the curves do not depend on the slider: compute them once per species
        const curve = grid.map((g) => at(g))
        return { s, at, curve, n: pc.length }
      }),
    [pred, val, species, grid],
  )
  const curves = useMemo(() => {
    const ret = d.map((x) => ({ type: 'scatter', mode: 'lines', x: grid, y: x.curve.map((a) => a.retained), name: x.s, line: { color: color(x.s), width: 2.5 }, hovertemplate: `${x.s}<br>T %{x:.2f}: %{y:.0%} kept<extra></extra>` }))
    const prec = d.flatMap((x) => {
      const ys = x.curve
      return [
        { type: 'scatter', mode: 'lines', x: grid, y: ys.map((a) => (a.nV >= 5 ? a.raw : null)), name: `${x.s} · validated above T`, legendgroup: x.s, line: { color: color(x.s), width: 2.5 }, hovertemplate: `${x.s}<br>T %{x:.2f}: validated precision %{y:.3f}<extra></extra>` },
        { type: 'scatter', mode: 'lines', x: grid, y: ys.map((a) => (a.nV >= 5 && a.unsupported === 0 ? a.reweighted : null)), name: `${x.s} · re-weighted`, legendgroup: x.s, showlegend: false, line: { color: color(x.s), width: 1.5, dash: 'dot' }, hovertemplate: `${x.s}<br>T %{x:.2f}: re-weighted precision %{y:.3f}<extra></extra>` },
      ]
    })
    return { ret, prec }
  }, [d, grid, color])
  // only the vertical line moves with the slider
  const figs = useMemo(() => {
    const vline = { type: 'line', x0: T, x1: T, yref: 'paper', y0: 0, y1: 1, line: { color: t.ink, width: 1 } }
    const lay = (yt: string, extra: object = {}) => ({ ...baseLayout(t), margin: { l: 56, r: 16, t: 40, b: 48 }, legend: { orientation: 'h', x: 0, y: 1.02, yanchor: 'bottom', font: { size: 11 } }, xaxis: { ...axisStyle(t), title: { text: 'threshold T (confidence)' }, range: [0.1, 1] }, yaxis: { ...axisStyle(t), title: { text: yt }, ...extra }, shapes: [vline] })
    return { ...curves, layRet: lay('share of predictions kept (≥ T)', { tickformat: '.0%', range: [0, 1.02] }), layPrec: { ...lay('precision of kept predictions', { range: [0, 1.03] }), showlegend: false } }
  }, [curves, T, t])
  return (
    <>
      <Section title="7 · Threshold preview: what a threshold keeps, and how precise the kept set looks" sub="Before any model: the share of predictions retained at each threshold, and the precision of the kept set — raw (validated clips ≥ T) and a coarse band-standardised estimate (share correct of reviewed clips ≥ T in each band × how many kept predictions fall in it; in the spirit of Tseng et al., not their fitted curve). Kept predictions without review support are counted, never hidden. This is set-level precision, not the per-prediction 99% the brief asks for, and it is not used for the labels.">
        <label className="field threshold-slider">
          <span className="field-label">Try a threshold T</span>
          <Range value={T} min={0.1} max={0.99} step={0.01} onChange={setT} format={(v) => fmtNum(v, 2)} />
        </label>
        <div className="bal-grid">
          <div className="chart-card">
            <Plot data={figs.ret} layout={figs.layRet} height={340} filename="retention_curves" />
          </div>
          <div className="chart-card">
            <Plot data={figs.prec} layout={figs.layPrec} height={340} filename="precision_above_threshold" />
          </div>
        </div>
        <p className="muted small">Solid: raw validated precision above T (shown where ≥ 5 validated clips remain). Dotted: coarse band-standardised estimate, shown only where every kept prediction’s band has reviewed clips ≥ T. Exploratory — not used for the 99% labels.</p>
        <div className="table-wrap auto">
          <table className="data-table sum-table">
            <thead>
              <tr>
                <th>Species at T = {fmtNum(T, 2)}</th>
                <th className="num">Predictions kept</th>
                <th className="num">Validated ≥ T</th>
                <th className="num">Raw precision (Wilson 95%)</th>
                <th className="num has-tip" data-tip="Kept predictions whose confidence band has reviewed clips at or above T.">Supported predictions</th>
                <th className="num has-tip" data-tip="Band-standardised estimate for all kept predictions. If some kept predictions have no review support, no estimate is made; the range treats them as all wrong … all right (a support range, not a confidence interval).">Re-weighted precision</th>
              </tr>
            </thead>
            <tbody>
              {d.map((x) => {
                const a = x.at(T)
                return (
                  <tr key={x.s}>
                    <td>
                      <b>{x.s}</b>
                    </td>
                    <td className="num">
                      {fmtInt(a.nKept)} ({fmtPct(a.retained, 0)})
                    </td>
                    <td className="num">{a.nV}</td>
                    <td className="num">{a.nV ? `${fmtPct(a.raw, 1)} [${fmtPct(a.ci[0], 0)}–${fmtPct(a.ci[1], 0)}]` : '—'}</td>
                    <td className="num">
                      {a.nKept ? `${fmtInt(a.supported)} / ${fmtInt(a.nKept)}` : '—'}
                    </td>
                    <td className="num">
                      {!a.nKept ? '—' : a.unsupported === 0 ? fmtPct(a.reweighted, 1) : <span className="warn-text">not estimable · range {fmtPct(a.rwLo, 1)}–{fmtPct(a.rwHi, 1)}</span>}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </Section>
      <Takeaway>
        <ul>
          <li>The trade-off is steep and species-specific: a threshold that keeps half the Nightjar’s predictions keeps a much smaller share of the Firefinch’s, whose scores are mostly below 0.3.</li>
          <li>Where raw and re-weighted precision differ, the validation sample’s score mix (over-sampled high scores) is doing the work — which is why the per-prediction model in the next step conditions on the score.</li>
        </ul>
      </Takeaway>
    </>
  )
}

// ── 10. co-detection ──────────────────────────────────────────────────────────

function CoDetection({ pred, t, species }: Ctx) {
  const [level, setLevel] = useState<'segment' | 'file'>('segment')
  const d = useMemo(() => {
    const segKey = (r: Row) => `${r.recording_file}|${r.begin_time_s}`
    const unit = (r: Row) => (level === 'segment' ? segKey(r) : String(r.recording_file))
    const sets = new Map<string, Set<string>>()
    pred.rows.forEach((r) => {
      const k = unit(r)
      if (!sets.has(k)) sets.set(k, new Set())
      sets.get(k)!.add(String(r.common_name))
    })
    // one pass over the units: pair counts (diagonal = units with that species), units with ≥ 2 targets
    const pos = new Map(species.map((s, i) => [s, i]))
    const z = species.map(() => species.map(() => 0))
    let multi = 0
    sets.forEach((set) => {
      const ids = [...set].map((s) => pos.get(s)).filter((i): i is number => i !== undefined)
      if (ids.length >= 2) multi++
      for (const i of ids) for (const j of ids) z[i][j]++
    })
    // validated predictions (unique link, computed in enrichment): another target in the same segment?
    const segSets = level === 'segment' ? sets : new Map<string, Set<string>>()
    if (level !== 'segment')
      pred.rows.forEach((r) => {
        const k = segKey(r)
        if (!segSets.has(k)) segSets.set(k, new Set())
        segSets.get(k)!.add(String(r.common_name))
      })
    const vstats = species.map((s) => {
      const res = { ok: { n: 0, co: 0 }, bad: { n: 0, co: 0 } }
      pred.rows.forEach((r) => {
        if (r.common_name !== s || r.validated !== 'yes') return
        const co = [...(segSets.get(segKey(r)) ?? [])].some((x) => x !== s)
        const bucket = r.validation_outcome === 'correct' ? res.ok : res.bad
        bucket.n++
        if (co) bucket.co++
      })
      return { s, ...res }
    })
    return { z, vstats, units: sets.size, multi }
  }, [pred, species, level])
  const fig = useMemo(() => {
    const short = species.map((s) => s.split(' ').slice(-1)[0])
    const text = d.z.map((row, i) => row.map((v, j) => (i === j ? `${fmtInt(v)} ${level}s` : `${fmtInt(v)} shared (${fmtPct(v / Math.max(1, d.z[i][i]), 1)} of ${short[i]})`)))
    const zOff = d.z.map((row, i) => row.map((v, j) => (i === j ? null : v / Math.max(1, d.z[i][i]))))
    return {
      data: [
        { type: 'heatmap', x: short, y: short, z: zOff, text, colorscale: sequentialScale(t.theme), xgap: 3, ygap: 3, colorbar: { title: { text: `share of row species’ ${level}s`, side: 'right' }, tickformat: '.0%', thickness: 10, outlinewidth: 0, tickfont: { color: t.muted } }, hovertemplate: '%{y} with %{x}: %{text}<extra></extra>' },
        { type: 'scatter', mode: 'text', x: short.flatMap((x) => short.map(() => x)), y: short.flatMap(() => short), text: short.flatMap((_, j) => short.map((__, i) => (i === j ? `${fmtInt(d.z[i][i])}` : fmtPct(d.z[i][j] / Math.max(1, d.z[i][i]), 1)))), textfont: { color: t.ink, size: 12 }, hoverinfo: 'skip', showlegend: false },
      ],
      layout: { ...baseLayout(t), margin: { l: 90, r: 16, t: 16, b: 50 }, xaxis: { ...axisStyle(t), type: 'category', showgrid: false }, yaxis: { ...axisStyle(t), type: 'category', autorange: 'reversed', showgrid: false } },
    }
  }, [d, species, level, t])
  return (
    <>
      <Section
        title="10 · Co-detection"
        sub={`How often two species are predicted in the same ${level} (row species’ share; diagonal = total ${level}s with that species). With only 4 target species this is a partial view of the soundscape.`}
        right={
          <Segmented
            size="sm"
            value={level}
            onChange={setLevel}
            options={[
              { value: 'segment', label: 'Same 3-s segment', title: 'Both predicted in exactly the same segment' },
              { value: 'file', label: 'Same audio file', title: 'Both predicted somewhere in the same 1-h file' },
            ]}
          />
        }
      >
        <div className="bal-grid">
          <div className="chart-card">
            <Plot data={fig.data} layout={fig.layout} height={380} filename="codetection_matrix" />
          </div>
          <div>
            <h3 className="small-h">Validated clips with another species predicted in the same segment</h3>
            <div className="table-wrap auto">
              <table className="data-table sum-table">
                <thead>
                  <tr>
                    <th>Species</th>
                    <th className="num">Correct clips: co-detected</th>
                    <th className="num">Incorrect clips: co-detected</th>
                  </tr>
                </thead>
                <tbody>
                  {d.vstats.map((x) => (
                    <tr key={x.s}>
                      <td>
                        <b>{x.s}</b>
                      </td>
                      <td className="num">{x.ok.n ? `${x.ok.co} / ${x.ok.n} (${fmtPct(x.ok.co / x.ok.n, 0)})` : '—'}</td>
                      <td className="num">{x.bad.n ? `${x.bad.co} / ${x.bad.n} (${fmtPct(x.bad.co / x.bad.n, 0)})` : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="muted small">Uniquely linked validated clips only. If incorrect clips are co-detected with another target species far more often than correct ones, that species’ song may be what BirdNET mislabels.</p>
          </div>
        </div>
      </Section>
      <Takeaway>
        <ul>
          <li>
            {(() => {
              const off = d.multi // units carrying two or more target species (each counted once)
              return level === 'segment'
                ? `Only ${fmtInt(off)} segment${off === 1 ? '' : 's'} carry predictions of two target species at once — the four targets are almost never predicted together, so errors cannot be blamed on the other targets’ songs.`
                : `${fmtInt(off)} audio files contain predictions of two target species: they share hours and sites even though they rarely call in the same 3-s segment.`
            })()}
          </li>
          <li>With only 4 of BirdNET’s ~6,000 classes in the export, the true source of false positives (e.g. at the Nightjar’s problem recorders) is outside this data — listening to a few clips, or exporting all classes for those segments, would identify it.</li>
        </ul>
      </Takeaway>
    </>
  )
}

// ── page ──────────────────────────────────────────────────────────────────────

export function BirdsEDA({ reg, tokens: t }: { reg: Map<string, Dataset>; tokens: ThemeTokens }) {
  const pred = reg.get('birdnet_predictions')
  const val = reg.get('validation_results')
  const [tab, setTab] = useState<Tab>('evidence')
  const ctx = useMemo(() => {
    if (!pred || !val) return null
    const order = categoryOrder(pred, 'common_name')
    const species = order.filter((s) => s !== '(empty)')
    const s = SERIES[t.theme]
    return { pred, val, t, species, color: (sp: string) => s[Math.max(0, order.indexOf(sp)) % s.length] } as Ctx
  }, [pred, val, t])
  if (!ctx) return <div className="empty">Bird files not found.</div>
  return (
    <div className="summary">
      <div className="task-card">
        <div className="ds-eyebrow">Challenge 1 · Exploratory analysis</div>
        <h1>Looking at the bird data from every angle</h1>
        <p className="task-sub">Ten descriptive views in seven tabs — where the evidence comes from, how the data flow from predictions to verdicts, when and where recorders were active, how detections cluster, what thresholds would keep, and which species co-occur. Times are local (EAT) with inferred clock corrections. No model is fitted here.</p>
      </div>
      <div className="paper-tabs" role="tablist" aria-label="Exploratory views">
        {TABS.map((x) => (
          <button key={x.key} type="button" role="tab" aria-selected={tab === x.key} className={`paper-tab ${tab === x.key ? 'on' : ''}`} onClick={() => setTab(x.key)}>
            <span>{x.label}</span>
            <span className="role-dot">{x.sub}</span>
          </button>
        ))}
      </div>
      {tab === 'evidence' && <Evidence {...ctx} />}
      {tab === 'flow' && <Flow {...ctx} />}
      {tab === 'calendar' && <Calendar {...ctx} />}
      {tab === 'clock' && <Clock {...ctx} />}
      {tab === 'bouts' && <Bouts {...ctx} />}
      {tab === 'thresholds' && <Thresholds {...ctx} />}
      {tab === 'codetect' && <CoDetection {...ctx} />}
    </div>
  )
}

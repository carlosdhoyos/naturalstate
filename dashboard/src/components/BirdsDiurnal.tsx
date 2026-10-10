/**
 * Diurnal cycles: relative average confidence by hour of day, and the diurnal cycle of the
 * validation sample (when validated clips were recorded, and the share correct by hour).
 * Hours are local (EAT) by default, using the inferred recorder clock corrections.
 */
import { useMemo, useState } from 'react'
import { axisStyle, baseLayout } from '../charts/build'
import { fmtInt, fmtNum, fmtPct, maxOf, minOf, summarize, wilson } from '../data/stats'
import { EAT_OFFSET_H, CANDIDATE_SITES, fmtClock, meanSun } from '../data/sun'
import type { Dataset, Row } from '../data/types'
import { OTHER, SERIES, type ThemeTokens } from '../lib/palette'
import { Plot } from './Plot'
import type { OpenView } from './Summary'
import { Segmented } from './ui'

type Metric = 'relative' | 'mean' | 'logit' | 'high'
const METRICS: { value: Metric; label: string; title: string }[] = [
  { value: 'relative', label: 'Relative mean', title: 'Hourly mean confidence ÷ the species’ overall mean (1 = typical for that species). Removes species differences so cycles are comparable.' },
  { value: 'mean', label: 'Mean', title: 'Hourly mean confidence (0–1).' },
  { value: 'logit', label: 'Mean logit', title: 'Hourly mean of logit(confidence) — the scale used by Wood & Kahl.' },
  { value: 'high', label: 'Share ≥ 0.5', title: 'Share of the hour’s predictions with confidence ≥ 0.5 (Wilson 95% CI).' },
]
const PERIODS = [
  { key: 'dawn', label: 'Dawn 05–08', test: (h: number) => h >= 5 && h < 8 },
  { key: 'day', label: 'Day 08–17', test: (h: number) => h >= 8 && h < 17 },
  { key: 'evening', label: 'Evening 17–22', test: (h: number) => h >= 17 && h < 22 },
  { key: 'night', label: 'Night 22–05', test: (h: number) => h >= 22 || h < 5 },
]
const HOURS = Array.from({ length: 24 }, (_, h) => h)

export function BirdsDiurnal({ reg, tokens: t, onOpen }: { reg: Map<string, Dataset>; tokens: ThemeTokens; onOpen: OpenView }) {
  const pred = reg.get('birdnet_predictions')
  const val = reg.get('validation_results')
  const [metric, setMetric] = useState<Metric>('relative')
  const [clock, setClock] = useState<'local' | 'recorded'>('local')
  const [minN, setMinN] = useState('20')
  const series = SERIES[t.theme]
  const nMin = Number(minN)

  const d = useMemo(() => {
    if (!pred || !val) return null
    const hp = (r: Row) => (clock === 'local' ? r.hour_local : r.hour_of_day) as number | null
    const hv = (r: Row) => (clock === 'local' ? r.hour_local : r.file_start_hour) as number | null
    const counts = new Map<string, number>()
    pred.rows.forEach((r) => counts.set(String(r.common_name), (counts.get(String(r.common_name)) ?? 0) + 1))
    const species = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k)
    const days = pred.rows.map((r) => r.recording_date).filter((x): x is number => typeof x === 'number')
    const sun = meanSun(CANDIDATE_SITES[0].lat, CANDIDATE_SITES[0].lon, minOf(days), maxOf(days))
    const per = species.map((sp) => {
      const P = pred.rows.filter((r) => r.common_name === sp && typeof hp(r) === 'number')
      const V = val.rows.filter((r) => r.commonName === sp && typeof hv(r) === 'number')
      const conf = P.map((r) => r.confidence as number)
      const lconf = P.map((r) => r.logit_confidence as number)
      const mu = summarize(conf).mean
      const muL = summarize(lconf).mean
      const hourly = HOURS.map((h) => {
        const ph = P.filter((r) => hp(r) === h)
        const c = ph.map((r) => r.confidence as number)
        const s = summarize(c)
        const sl = summarize(ph.map((r) => r.logit_confidence as number))
        const hi = c.filter((x) => x >= 0.5).length
        const vh = V.filter((r) => hv(r) === h)
        const ok = vh.filter((r) => r.outcome === 1).length
        const se = s.n > 1 ? s.sd / Math.sqrt(s.n) : NaN
        const seL = sl.n > 1 ? sl.sd / Math.sqrt(sl.n) : NaN
        const share = wilson(hi, s.n)
        return {
          h,
          n: s.n,
          mean: s.mean,
          rel: s.mean / mu,
          relLo: (s.mean - 1.96 * se) / mu,
          relHi: (s.mean + 1.96 * se) / mu,
          meanLo: s.mean - 1.96 * se,
          meanHi: s.mean + 1.96 * se,
          logit: sl.mean,
          logitLo: sl.mean - 1.96 * seL,
          logitHi: sl.mean + 1.96 * seL,
          high: s.n ? hi / s.n : NaN,
          highLo: share[0],
          highHi: share[1],
          vn: vh.length,
          vok: ok,
          vci: wilson(ok, vh.length),
          pShare: P.length ? ph.length / P.length : 0,
          vShare: V.length ? vh.length / V.length : 0,
        }
      })
      const periods = PERIODS.map((pd) => {
        const ph = P.filter((r) => pd.test(hp(r) as number))
        const vh = V.filter((r) => pd.test(hv(r) as number))
        const ok = vh.filter((r) => r.outcome === 1).length
        return { ...pd, n: ph.length, rel: ph.length ? summarize(ph.map((r) => r.confidence as number)).mean / mu : NaN, vn: vh.length, ok, wrong: vh.length - ok, ci: wilson(ok, vh.length) }
      })
      // Recorders where every validated clip of this species was wrong (≥ 5 clips): a site-specific
      // false-positive source, which can masquerade as a time-of-day effect.
      const byRec = new Map<string, { n: number; wrong: number }>()
      V.forEach((r) => {
        const k = String(r.recorder)
        const x = byRec.get(k) ?? { n: 0, wrong: 0 }
        x.n++
        if (r.outcome === 0) x.wrong++
        byRec.set(k, x)
      })
      const problem = [...byRec.entries()].filter(([, x]) => x.n >= 5 && x.wrong === x.n).map(([k]) => k)
      const problemWrong = problem.reduce((a, k) => a + byRec.get(k)!.wrong, 0)
      const Pok = P.filter((r) => !problem.includes(String(r.folder)))
      const muOk = summarize(Pok.map((r) => r.confidence as number)).mean
      const evRel = (rows: Row[], m: number) => {
        const e = rows.filter((r) => { const h = hp(r) as number; return h >= 19 && h < 22 })
        return e.length ? summarize(e.map((r) => r.confidence as number)).mean / m : NaN
      }
      const problemPreds = P.length - Pok.length
      const valHours = new Set(V.map((r) => hv(r)))
      const gaps = hourly.filter((x) => x.n >= nMin && !valHours.has(x.h)).map((x) => x.h)
      return { sp, mu, muL, hourly, periods, gaps, nP: P.length, nV: V.length, wrong: V.filter((r) => r.outcome === 0).length, problem, problemWrong, problemPreds, evRelAll: evRel(P, mu), evRelOk: evRel(Pok, muOk) }
    })
    return { per, sun }
  }, [pred, val, clock, nMin])

  const grid = (title: (i: number) => string, yTitle: string, yExtra: Record<string, unknown> = {}) => {
    const layout: Record<string, unknown> = {
      ...baseLayout(t),
      grid: { rows: 2, columns: 2, pattern: 'independent', xgap: 0.08, ygap: 0.24 },
      margin: { l: 56, r: 16, t: 60, b: 44 },
      legend: { orientation: 'h', x: 0, y: 1.1, yanchor: 'bottom', font: { size: 11.5 } },
      annotations: [] as object[],
      shapes: [] as object[],
    }
    if (!d) return layout
    const rise = d.sun.rise + EAT_OFFSET_H
    const set = d.sun.set + EAT_OFFSET_H
    d.per.forEach((_, i) => {
      const sfx = i === 0 ? '' : String(i + 1)
      layout[`xaxis${sfx}`] = { ...axisStyle(t), range: [-0.5, 23.5], dtick: 3, ...(i >= 2 ? { title: { text: `hour of day — ${clock === 'local' ? 'local time (EAT)' : 'recorder clock'}` } } : {}) }
      layout[`yaxis${sfx}`] = { ...axisStyle(t), ...yExtra, ...(i % 2 === 0 ? { title: { text: yTitle } } : {}) }
      ;(layout.annotations as object[]).push({ text: title(i), xref: `x${sfx} domain`, yref: `y${sfx} domain`, x: 0, y: 1.03, xanchor: 'left', yanchor: 'bottom', showarrow: false, font: { size: 11.5, color: t.ink } })
      const night = t.theme === 'dark' ? 'rgba(255,255,255,0.035)' : 'rgba(0,53,77,0.05)'
      ;(layout.shapes as object[]).push(
        { type: 'rect', xref: `x${sfx}`, yref: `y${sfx} domain`, x0: -0.5, x1: rise, y0: 0, y1: 1, fillcolor: night, line: { width: 0 }, layer: 'below' },
        { type: 'rect', xref: `x${sfx}`, yref: `y${sfx} domain`, x0: set, x1: 23.5, y0: 0, y1: 1, fillcolor: night, line: { width: 0 }, layer: 'below' },
      )
    })
    return layout
  }

  const confFig = useMemo(() => {
    if (!d) return null
    const data: object[] = []
    const key = { relative: ['rel', 'relLo', 'relHi'], mean: ['mean', 'meanLo', 'meanHi'], logit: ['logit', 'logitLo', 'logitHi'], high: ['high', 'highLo', 'highHi'] }[metric] as ['rel', 'relLo', 'relHi']
    d.per.forEach((p, i) => {
      const sfx = i === 0 ? '' : String(i + 1)
      // All 24 hours, with gaps (null) where there are too few predictions — so the line breaks
      // instead of drawing a trend across hours with no data.
      const pts = p.hourly
      const ok = (x: (typeof pts)[number]) => x.n >= nMin
      const c = series[i]
      data.push({
        type: 'scatter',
        mode: 'lines+markers',
        x: pts.map((x) => x.h + 0.5),
        y: pts.map((x) => (ok(x) ? x[key[0]] : null)),
        error_y: { type: 'data', symmetric: false, array: pts.map((x) => (ok(x) ? x[key[2]] - x[key[0]] : 0)), arrayminus: pts.map((x) => (ok(x) ? x[key[0]] - x[key[1]] : 0)), color: c, thickness: 1.2, width: 3 },
        name: p.sp,
        showlegend: false,
        xaxis: `x${sfx}`,
        yaxis: `y${sfx}`,
        line: { color: c, width: 2 },
        marker: { color: c, size: 7, line: { color: t.surface, width: 1 } },
        text: pts.map((x) => `${String(x.h).padStart(2, '0')}–${String(x.h + 1).padStart(2, '0')} h · n = ${fmtInt(x.n)}<br>mean ${fmtNum(x.mean, 3)} · relative ${fmtNum(x.rel, 3)} · share ≥ 0.5 ${fmtPct(x.high, 0)}`),
        hovertemplate: '%{text}<extra></extra>',
        connectgaps: false,
      })
      if (metric === 'relative') data.push({ type: 'scatter', mode: 'lines', x: [-0.5, 23.5], y: [1, 1], xaxis: `x${sfx}`, yaxis: `y${sfx}`, line: { color: t.muted, width: 1 }, hoverinfo: 'skip', showlegend: false })
    })
    const yTitle = metric === 'relative' ? 'mean confidence ÷ species mean' : metric === 'mean' ? 'mean confidence' : metric === 'logit' ? 'mean logit(confidence)' : 'share with confidence ≥ 0.5'
    return { data, layout: grid((i) => `<b>${d.per[i].sp}</b> · species mean ${fmtNum(d.per[i].mu, 3)} · ${fmtInt(d.per[i].nP)} predictions`, yTitle, metric === 'high' ? { tickformat: '.0%', range: [0, 1] } : {}) }
  }, [d, metric, nMin, t, series, clock])

  const covFig = useMemo(() => {
    if (!d) return null
    const data: object[] = []
    d.per.forEach((p, i) => {
      const sfx = i === 0 ? '' : String(i + 1)
      data.push(
        { type: 'bar', x: HOURS.map((h) => h + 0.5), y: p.hourly.map((x) => x.pShare), name: 'share of predictions', legendgroup: 'p', showlegend: i === 0, xaxis: `x${sfx}`, yaxis: `y${sfx}`, marker: { color: OTHER[t.theme] }, hovertemplate: '%{x:.0f}h: %{y:.1%} of predictions<extra></extra>' },
        { type: 'bar', x: HOURS.map((h) => h + 0.5), y: p.hourly.map((x) => x.vShare), name: 'share of validated clips', legendgroup: 'v', showlegend: i === 0, xaxis: `x${sfx}`, yaxis: `y${sfx}`, marker: { color: series[0] }, text: p.hourly.map((x) => `${x.vn} clips`), hovertemplate: '%{x:.0f}h: %{y:.1%} of validated clips (%{text})<extra></extra>', textposition: 'none' },
      )
    })
    const layout = grid((i) => `<b>${d.per[i].sp}</b> · ${d.per[i].nV} validated clips`, 'share of the species', { tickformat: '.0%' })
    layout.barmode = 'group'
    layout.bargap = 0.2
    layout.bargroupgap = 0.05
    return { data, layout }
  }, [d, t, series, clock])

  const accFig = useMemo(() => {
    if (!d) return null
    const data: object[] = []
    d.per.forEach((p, i) => {
      const sfx = i === 0 ? '' : String(i + 1)
      const pts = p.hourly.filter((x) => x.vn > 0)
      data.push({
        type: 'scatter',
        mode: 'markers',
        x: pts.map((x) => x.h + 0.5),
        y: pts.map((x) => x.vok / x.vn),
        error_y: { type: 'data', symmetric: false, array: pts.map((x) => x.vci[1] - x.vok / x.vn), arrayminus: pts.map((x) => x.vok / x.vn - x.vci[0]), color: series[i], thickness: 1.2, width: 3 },
        xaxis: `x${sfx}`,
        yaxis: `y${sfx}`,
        marker: { color: pts.map((x) => (x.vok < x.vn ? series[1] : series[0])), size: pts.map((x) => Math.min(18, 6 + Math.sqrt(x.vn) * 1.6)), line: { color: t.surface, width: 1 }, symbol: pts.map((x) => (x.vok < x.vn ? 'diamond' : 'circle')) },
        text: pts.map((x) => `${String(x.h).padStart(2, '0')}–${String(x.h + 1).padStart(2, '0')} h<br>${x.vok} of ${x.vn} correct (${fmtPct(x.vok / x.vn, 0)})<br>Wilson 95% CI ${fmtPct(x.vci[0], 0)}–${fmtPct(x.vci[1], 0)}`),
        hovertemplate: '%{text}<extra></extra>',
        showlegend: false,
      })
    })
    return { data, layout: grid((i) => `<b>${d.per[i].sp}</b> · ${d.per[i].nV - d.per[i].wrong} / ${d.per[i].nV} correct overall`, 'share correct (validated)', { range: [-0.05, 1.08], tickformat: '.0%' }) }
  }, [d, t, series, clock])

  if (!d || !confFig || !covFig || !accFig) return <div className="empty">Bird files not found.</div>
  const nj = d.per.find((p) => p.sp.includes('Nightjar'))

  return (
    <div className="summary">
      <div className="task-card">
        <div className="ds-eyebrow">Challenge 1 · Diurnal cycles</div>
        <h1>Confidence and validation through the day</h1>
        <p className="task-sub">
          Hour by hour: how BirdNET’s confidence changes relative to each species’ usual level, when the validated clips were recorded, and how often they were correct. Hours are local time (EAT) using the inferred recorder clock corrections; validated clips are placed exactly in their file’s clock hour (segment times count from the top of that hour). Shaded: night at Lewa, Kenya (sunrise {fmtClock(d.sun.rise + EAT_OFFSET_H)}, sunset {fmtClock(d.sun.set + EAT_OFFSET_H)} EAT).
        </p>
      </div>

      <div className="sim-presets">
        <span className="presets-label">Clock</span>
        <Segmented
          value={clock}
          onChange={setClock}
          options={[
            { value: 'local', label: 'Local time (corrected)', title: 'hour_local: recorder clocks corrected where they ran on UTC' },
            { value: 'recorded', label: 'As recorded', title: 'hour_of_day / file_start_hour: recorder clocks as written' },
          ]}
        />
        <span className="presets-label">Min. predictions per hour</span>
        <Segmented value={minN} onChange={setMinN} options={['10', '20', '50'].map((v) => ({ value: v, label: v, title: 'Hours with fewer predictions are not plotted in the confidence cycle (too noisy).' }))} />
      </div>

      <section className="sum-section">
        <div className="sum-section-head">
          <div>
            <h2>Diurnal cycle of relative average confidence</h2>
            <p className="muted">Each species on its own scale. Error bars: 95% interval of the hourly mean (Wilson for shares). Hours with fewer than {nMin} predictions are hidden.</p>
          </div>
          <Segmented size="sm" value={metric} onChange={setMetric} options={METRICS} />
        </div>
        <div className="chart-card">
          <Plot data={confFig.data} layout={confFig.layout} height={560} filename="diurnal_relative_confidence" />
        </div>
      </section>

      <section className="sum-section">
        <div className="sum-section-head">
          <div>
            <h2>Diurnal cycle of the validation sample</h2>
            <p className="muted">When were the validated clips recorded, compared with when the species is predicted? Bars are shares within each species, so the two can be compared directly.</p>
          </div>
          <button type="button" className="btn ghost sm" onClick={() => onOpen('validation_results', { tab: 'explore', spec: { kind: 'bar', x: 'hour_local', color: 'outcome_label', facet: 'commonName', barmode: 'stack', agg: 'count', sharedY: false } })}>
            Open in Explore
          </button>
        </div>
        <div className="chart-card">
          <Plot data={covFig.data} layout={covFig.layout} height={520} filename="diurnal_validation_coverage" />
        </div>
      </section>

      <section className="sum-section">
        <div className="sum-section-head">
          <div>
            <h2>Share correct by hour</h2>
            <p className="muted">Validated clips per hour that the ornithologist marked correct. Marker size grows with the number of clips; diamonds mark hours with at least one error. Wilson 95% intervals are wide where clips are few.</p>
          </div>
        </div>
        <div className="chart-card">
          <Plot data={accFig.data} layout={accFig.layout} height={520} filename="diurnal_share_correct" />
        </div>
      </section>

      <section className="sum-section">
        <div className="sum-section-head">
          <div>
            <h2>By period of the day</h2>
            <p className="muted">Relative mean confidence of the predictions, and validated clips (correct / wrong) per period, {clock === 'local' ? 'local time' : 'recorder clock'}.</p>
          </div>
        </div>
        <div className="table-wrap auto">
          <table className="data-table sum-table">
            <thead>
              <tr>
                <th>Species</th>
                {PERIODS.map((pd) => (
                  <th key={pd.key} className="num">
                    {pd.label}
                  </th>
                ))}
                <th>Hours predicted (n ≥ {nMin}) but never validated</th>
              </tr>
            </thead>
            <tbody>
              {d.per.map((p) => (
                <tr key={p.sp}>
                  <td>
                    <b>{p.sp}</b>
                  </td>
                  {p.periods.map((pd) => (
                    <td key={pd.key} className="num">
                      {pd.n ? (
                        <>
                          <div>
                            rel. {fmtNum(pd.rel, 2)} <span className="muted small">({fmtInt(pd.n)})</span>
                          </div>
                          <div className={pd.wrong ? 'warn-text' : 'muted'}>{pd.vn ? `${pd.ok} ✓ / ${pd.wrong} ✗` : 'not validated'}</div>
                        </>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                  ))}
                  <td>{p.gaps.length ? p.gaps.map((h) => `${String(h).padStart(2, '0')}h`).join(', ') : <span className="muted">none</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <div className="for-us">
        <div className="pipe-col-label">What this means</div>
        <ul>
          {nj && (
            <li>
              <b>Abyssinian Nightjar — an apparent evening effect that is really a site effect.</b>{' '}
              {(() => {
                const ev = nj.periods.find((x) => x.key === 'evening')!
                return `${ev.wrong} of its ${nj.wrong} validation errors fall in the evening (17–22 h), and its confidence dips at 19–22 h (relative ${fmtNum(nj.evRelAll, 2)}).`
              })()}{' '}
              {nj.problem.length ? (
                <>
                  But {nj.problem.join(' and ')} account for {nj.problemWrong} of the {nj.wrong} errors — every validated Nightjar clip from them was wrong — and they contribute {fmtInt(nj.problemPreds)} mostly low-score predictions concentrated in the evening. Excluding them, the evening dip largely disappears: evening confidence is {fmtNum(nj.evRelOk, 2)}× the remaining recorders’ own mean (vs {fmtNum(nj.evRelAll, 2)}× with them), and the hourly lows of ~0.7 vanish. Something else at those sites (another nightjar, frogs or insects) seems to trigger the Nightjar class. The candidate covariate for the logistic model is therefore the <b>site / recorder</b>, not time of day; and those recorders’ Nightjar predictions deserve review.
                </>
              ) : (
                'Time of day and score are confounded; test a time covariate conditional on score before using it.'
              )}
            </li>
          )}
          <li>Average confidence changes through the day for every species (different mixes of calls, overlapping species and background sound). That alone does not show that a given score is more or less reliable at some hours — only the share-correct panel, conditional on score, can show that.</li>
          <li>The validation sample broadly follows when each species is predicted; hours listed as “never validated” are where any time effect could not be checked.</li>
          <li>Diurnal patterns use corrected local time; switching to “As recorded” shows how the two UTC recorders blur them.</li>
        </ul>
      </div>
    </div>
  )
}

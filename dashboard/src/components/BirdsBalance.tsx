/**
 * How balanced are the bird predictions and the validation sample? Computed live from the CSVs:
 * species, outcomes, confidence range (with a two-sample KS test), recorders/files (clustering), time.
 */
import { useMemo, type ReactNode } from 'react'
import { axisStyle, baseLayout } from '../charts/build'
import { CONF_BANDS, CONF_BAND_LABELS, fmtInt, fmtNum, fmtPct, medianOf } from '../data/stats'
import type { Dataset } from '../data/types'
import { tip, type HelpKey } from '../lib/help'
import { OTHER, SERIES, type ThemeTokens } from '../lib/palette'
import { Plot } from './Plot'

const BANDS = CONF_BANDS
const BAND_LABELS = CONF_BAND_LABELS
const MIN_EVENTS = 20 // ~10 of the rarer outcome per coefficient × 2 coefficients

const shares = (x: number[]) => BANDS.slice(0, -1).map((lo, i) => (x.length ? x.filter((c) => c >= lo && c < BANDS[i + 1]).length / x.length : 0))
const median = medianOf

/** Two-sample Kolmogorov–Smirnov distance and its 5% critical value (large-sample approximation). */
function ks(a: number[], b: number[]) {
  const A = [...a].sort((x, y) => x - y)
  const B = [...b].sort((x, y) => x - y)
  let i = 0
  let j = 0
  let d = 0
  while (i < A.length && j < B.length) {
    const t = Math.min(A[i], B[j])
    while (i < A.length && A[i] <= t) i++
    while (j < B.length && B[j] <= t) j++
    d = Math.max(d, Math.abs(i / A.length - j / B.length))
  }
  const crit = 1.36 * Math.sqrt((A.length + B.length) / (A.length * B.length))
  return { d, crit }
}

function Sub({ title, tipKey, sub, children }: { title: string; tipKey: HelpKey; sub: ReactNode; children: ReactNode }) {
  return (
    <div className="bal-sub">
      <h3 className="has-tip" {...tip(tipKey, true)}>
        {title}
      </h3>
      <p className="muted">{sub}</p>
      {children}
    </div>
  )
}

const Verdict = ({ tone, children }: { tone: 'ok' | 'warn' | 'bad'; children: ReactNode }) => <span className={`verdict v-${tone}`}>{children}</span>

export function BirdsBalance({ pred, val, tokens: t }: { pred: Dataset; val: Dataset; tokens: ThemeTokens }) {
  const series = SERIES[t.theme]

  const s = useMemo(() => {
    const counts = new Map<string, number>()
    pred.rows.forEach((r) => counts.set(String(r.common_name), (counts.get(String(r.common_name)) ?? 0) + 1))
    const species = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k)
    const per = species.map((sp) => {
      const P = pred.rows.filter((r) => r.common_name === sp)
      const V = val.rows.filter((r) => r.commonName === sp)
      const pc = P.map((r) => r.confidence).filter((c): c is number => typeof c === 'number')
      const vc = V.map((r) => r.confidence).filter((c): c is number => typeof c === 'number')
      const ok = V.filter((r) => r.outcome === 1).length
      const recs = new Map<string, number>()
      V.forEach((r) => recs.set(String(r.recorder), (recs.get(String(r.recorder)) ?? 0) + 1))
      const top = [...recs.entries()].sort((a, b) => b[1] - a[1])[0] ?? ['—', 0]
      const files = new Set(V.map((r) => r.recording_file)).size
      return {
        sp,
        nP: P.length,
        nV: V.length,
        ok,
        wrong: V.length - ok,
        minority: Math.min(ok, V.length - ok),
        pShares: shares(pc),
        vShares: shares(vc),
        pMed: median(pc),
        vMed: median(vc),
        ks: ks(pc, vc),
        recorders: recs.size,
        topRec: top[0],
        topN: top[1],
        files,
      }
    })
    const predRecs = new Set(pred.rows.map((r) => r.folder))
    const valRecsCount = new Map<string, number>()
    val.rows.forEach((r) => valRecsCount.set(String(r.recorder), (valRecsCount.get(String(r.recorder)) ?? 0) + 1))
    const never = [...predRecs].filter((r) => !valRecsCount.has(String(r))).map(String).sort()
    const fileCounts = new Map<string, number>()
    val.rows.forEach((r) => fileCounts.set(String(r.recording_file), (fileCounts.get(String(r.recording_file)) ?? 0) + 1))
    const topRecAll = [...valRecsCount.entries()].sort((a, b) => b[1] - a[1])
    const days = (ds: Dataset, col: string) => new Set(ds.rows.map((r) => r[col]).filter((v) => v !== null)).size
    return {
      per,
      predRecs: predRecs.size,
      valRecs: valRecsCount.size,
      never,
      topRecAll,
      nFiles: fileCounts.size,
      multiFiles: [...fileCounts.values()].filter((n) => n > 1).length,
      maxPerFile: Math.max(...fileCounts.values()),
      predDays: days(pred, 'recording_date'),
      valDays: days(val, 'recording_date'),
      matched: val.rows.filter((r) => String(r.link_to_predictions).startsWith('linked')).length,
    }
  }, [pred, val])

  const bandFig = useMemo(() => {
    const layout: Record<string, unknown> = {
      ...baseLayout(t),
      grid: { rows: 2, columns: 2, pattern: 'independent', xgap: 0.08, ygap: 0.26 },
      margin: { l: 52, r: 16, t: 56, b: 44 },
      barmode: 'group',
      bargap: 0.25,
      bargroupgap: 0.06,
      legend: { orientation: 'h', x: 0, y: 1.1, yanchor: 'bottom', font: { size: 11.5 } },
      annotations: [] as object[],
    }
    const data: object[] = []
    s.per.forEach((p, i) => {
      const sfx = i === 0 ? '' : String(i + 1)
      layout[`xaxis${sfx}`] = { ...axisStyle(t), type: 'category', tickfont: { size: 10, color: t.muted } }
      const top = Math.min(1, Math.max(0.2, ...s.per.flatMap((x) => [...x.pShares, ...x.vShares])) * 1.08)
      layout[`yaxis${sfx}`] = { ...axisStyle(t), tickformat: '.0%', range: [0, top], ...(i % 2 === 0 ? { title: { text: 'share of clips' } } : {}), ...(i ? { matches: 'y' } : {}) }
      const mirrors = p.ks.d < p.ks.crit
      const dir = p.vMed > p.pMed ? 'high' : 'low'
      ;(layout.annotations as object[]).push({
        text: `<b>${p.sp}</b> · KS ${fmtNum(p.ks.d, 2)} — ${mirrors ? 'validation mirrors predictions' : `validation over-samples ${dir} scores`}`,
        xref: `x${sfx} domain`,
        yref: `y${sfx} domain`,
        x: 0,
        y: 1.04,
        xanchor: 'left',
        yanchor: 'bottom',
        showarrow: false,
        font: { size: 11.5, color: t.ink },
      })
      data.push(
        { type: 'bar', x: BAND_LABELS, y: p.pShares, name: 'all predictions', legendgroup: 'p', showlegend: i === 0, xaxis: `x${sfx}`, yaxis: `y${sfx}`, marker: { color: OTHER[t.theme], cornerradius: 3 }, hovertemplate: '%{x}: %{y:.0%} of predictions<extra></extra>' },
        { type: 'bar', x: BAND_LABELS, y: p.vShares, name: 'validated clips', legendgroup: 'v', showlegend: i === 0, xaxis: `x${sfx}`, yaxis: `y${sfx}`, marker: { color: series[0], cornerradius: 3 }, hovertemplate: '%{x}: %{y:.0%} of validated clips<extra></extra>' },
      )
    })
    return { data, layout }
  }, [s, t, series])

  const recFig = useMemo(() => {
    const recs = s.topRecAll.slice(0, 15).map(([r]) => r)
    const data = s.per.map((p, i) => ({
      type: 'bar',
      orientation: 'h',
      y: recs,
      x: recs.map((rec) => val.rows.filter((r) => r.recorder === rec && r.commonName === p.sp).length),
      name: p.sp,
      marker: { color: series[i] },
      hovertemplate: `%{y}: %{x} ${p.sp} clips<extra></extra>`,
    }))
    return {
      data,
      layout: {
        ...baseLayout(t),
        barmode: 'stack',
        bargap: 0.25,
        margin: { l: 64, r: 16, t: 44, b: 40 },
        legend: { orientation: 'h', x: 0, y: 1.02, yanchor: 'bottom', font: { size: 11 }, traceorder: 'normal' },
        xaxis: { ...axisStyle(t), title: { text: 'validated clips' } },
        yaxis: { ...axisStyle(t), autorange: 'reversed', type: 'category' },
      },
    }
  }, [s, val, t, series])

  const totP = pred.rows.length
  const totV = val.rows.length

  return (
    <section className="sum-section">
      <div className="sum-section-head">
        <div>
          <h2 className="has-tip" {...tip('sum.b.balance', true)}>
            How balanced are the data and the validation?
          </h2>
          <p className="muted">Five checks that decide how much each species’ threshold can be trusted. {s.matched} of {totV} validated clips link to a prediction in this file, so the two can be compared directly.</p>
        </div>
      </div>

      <div className="bal-grid">
        <Sub title="1 · Across species" tipKey="sum.b.balSpecies" sub="Predictions are very unbalanced; validation effort is roughly equal per species — the right design for one curve per species.">
          <div className="table-wrap auto">
            <table className="data-table sum-table">
              <thead>
                <tr>
                  <th>Species</th>
                  <th className="num">Predictions</th>
                  <th className="num">Validated</th>
                  <th className="num has-tip" data-tip="Validated clips ÷ predictions of that species in this file.">
                    Validated per prediction
                  </th>
                </tr>
              </thead>
              <tbody>
                {s.per.map((p) => (
                  <tr key={p.sp}>
                    <td>
                      <b>{p.sp}</b>
                    </td>
                    <td className="num">
                      {fmtInt(p.nP)} <span className="muted small">({fmtPct(p.nP / totP, 1)})</span>
                      <span className="mini-bar">
                        <span style={{ width: `${(p.nP / s.per[0].nP) * 100}%`, background: OTHER[t.theme] }} />
                      </span>
                    </td>
                    <td className="num">
                      {p.nV} <span className="muted small">({fmtPct(p.nV / totV, 0)})</span>
                      <span className="mini-bar">
                        <span style={{ width: `${(p.nV / Math.max(...s.per.map((x) => x.nV))) * 100}%`, background: series[0] }} />
                      </span>
                    </td>
                    <td className="num">{fmtPct(p.nV / p.nP, 1)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="small muted">
            Most common : rarest species = {fmtInt(Math.round(s.per[0].nP / s.per[s.per.length - 1].nP))} : 1 in predictions, {fmtNum(Math.max(...s.per.map((x) => x.nV)) / Math.min(...s.per.map((x) => x.nV)), 2)} : 1 in validation.
          </p>
        </Sub>

        <Sub title="2 · Correct vs incorrect" tipKey="sum.b.balOutcome" sub={`A logistic regression learns from the rarer outcome. Rule of thumb: ≥ ~10 per coefficient, i.e. ≥ ${MIN_EVENTS} here.`}>
          <div className="table-wrap auto">
            <table className="data-table sum-table">
              <thead>
                <tr>
                  <th>Species</th>
                  <th className="num">Correct</th>
                  <th className="num">Wrong</th>
                  <th className="num">Rarer outcome</th>
                  <th>Consequence</th>
                </tr>
              </thead>
              <tbody>
                {s.per.map((p) => (
                  <tr key={p.sp}>
                    <td>
                      <b>{p.sp}</b>
                    </td>
                    <td className="num">{p.ok}</td>
                    <td className="num">{p.wrong}</td>
                    <td className="num">
                      <b>{p.minority}</b>
                      <span className="outcome-split">
                        <span style={{ width: `${(p.ok / p.nV) * 100}%`, background: series[0] }} />
                        <span style={{ width: `${(p.wrong / p.nV) * 100}%`, background: series[1] }} />
                      </span>
                    </td>
                    <td>
                      {p.minority === 0 ? (
                        <Verdict tone="bad">no {p.wrong === 0 ? 'errors' : 'correct clips'}: perfect separation, no finite fit</Verdict>
                      ) : p.minority < 5 ? (
                        <Verdict tone="bad">curve rests on {p.minority} {p.ok < p.wrong ? 'correct clip' : 'error'}{p.minority > 1 ? 's' : ''}</Verdict>
                      ) : p.minority < MIN_EVENTS ? (
                        <Verdict tone="warn">
                          only {p.minority} {p.ok < p.wrong ? 'correct clips' : 'errors'} — weak evidence
                        </Verdict>
                      ) : (
                        <Verdict tone="ok">enough of both outcomes</Verdict>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Sub>
      </div>

      <Sub title="3 · Across the confidence range" tipKey="sum.b.balScore" sub="Share of each species’ clips per confidence band: all predictions (grey) vs validated clips (teal). A two-sample Kolmogorov–Smirnov test says whether validation mirrors the predictions (a purely random draw) or deliberately over-samples high scores.">
        <div className="chart-card">
          <Plot data={bandFig.data} layout={bandFig.layout} height={470} filename="validation_vs_predictions_by_band" />
        </div>
        <div className="table-wrap auto">
          <table className="data-table sum-table">
            <thead>
              <tr>
                <th>Species</th>
                <th className="num">Median confidence: predictions → validated</th>
                <th className="num has-tip" data-tip="Largest gap between the two cumulative distributions (0 = identical, 1 = no overlap). Compared with the 5% critical value 1.36·√((n+m)/(n·m)).">
                  KS distance (5% critical)
                </th>
                <th>Sampling looks like</th>
              </tr>
            </thead>
            <tbody>
              {s.per.map((p) => {
                const mirrors = p.ks.d < p.ks.crit
                return (
                  <tr key={p.sp}>
                    <td>
                      <b>{p.sp}</b>
                    </td>
                    <td className="num">
                      {fmtNum(p.pMed, 2)} → {fmtNum(p.vMed, 2)}
                    </td>
                    <td className="num">
                      {fmtNum(p.ks.d, 2)} ({fmtNum(p.ks.crit, 2)})
                    </td>
                    <td>
                      {mirrors ? (
                        <Verdict tone="warn">random draw — mirrors the (mostly low) scores; few high-score clips</Verdict>
                      ) : p.vMed > p.pMed ? (
                        <Verdict tone="ok">random + extra high-score clips (as Wood &amp; Kahl advise)</Verdict>
                      ) : (
                        <Verdict tone="warn">over-samples low scores — little evidence where the threshold sits</Verdict>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        <p className="small note-inline">
          Over-sampling high scores does <b>not</b> bias the fitted curve: it models pr(correct | score), and the sampling depends only on the score. It does mean the raw “share correct in the sample” is not the precision across all predictions.
        </p>
      </Sub>

      <div className="bal-grid">
        <Sub title="4 · Across recorders and audio files" tipKey="sum.b.balRecorders" sub="Scores depend on the recorder (Wood & Kahl), and clips from the same file or recorder are not independent.">
          <ul className="facts tight">
            <li>
              <b>{s.valRecs}</b> of {s.predRecs} recorders with predictions appear in the validation; <b>{s.never.length}</b> were never validated
              {s.never.length ? <span className="muted small"> ({s.never.join(', ')})</span> : null}.
            </li>
            <li>
              The busiest recorder, <b>{s.topRecAll[0][0]}</b>, supplies {s.topRecAll[0][1]} of {totV} validated clips ({fmtPct(s.topRecAll[0][1] / totV, 0)}).
            </li>
            <li>
              {totV} clips come from <b>{s.nFiles}</b> audio files; {s.multiFiles} files contributed more than one clip (up to {s.maxPerFile}). Plain logistic-regression standard errors will be somewhat optimistic.
            </li>
          </ul>
          <div className="table-wrap auto">
            <table className="data-table sum-table">
              <thead>
                <tr>
                  <th>Species</th>
                  <th className="num">Recorders</th>
                  <th className="num">Files</th>
                  <th className="num">Largest single recorder</th>
                </tr>
              </thead>
              <tbody>
                {s.per.map((p) => {
                  const share = p.topN / p.nV
                  return (
                    <tr key={p.sp}>
                      <td>
                        <b>{p.sp}</b>
                      </td>
                      <td className="num">{p.recorders}</td>
                      <td className="num">{p.files}</td>
                      <td className="num">
                        <span className={share > 0.5 ? 'warn-text' : ''}>
                          {p.topRec}: {p.topN} ({fmtPct(share, 0)})
                        </span>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </Sub>
        <div className="bal-sub">
          <h3>Validated clips per recorder (top 15)</h3>
          <p className="muted">Stacked by species; hover for counts.</p>
          <div className="chart-card">
            <Plot data={recFig.data} layout={recFig.layout} height={400} filename="validated_clips_per_recorder" />
          </div>
        </div>
      </div>

      <Sub title="5 · Across time" tipKey="sum.b.balTime" sub="Whether validation covers the whole recording period.">
        <ul className="facts tight">
          <li>
            Validation covers <b>{s.valDays}</b> of {s.predDays} recording days.
          </li>
          <li>Within each species, validated clips come from the hours that species is active (e.g. Oriole mornings, Nightjar evenings) — validation follows where the predictions are.</li>
        </ul>
      </Sub>

      <div className="for-us">
        <div className="pipe-col-label">What this means for the thresholds</div>
        <ul>
          {s.per.map((p) => (
            <li key={p.sp}>
              <b>{p.sp}</b>:{' '}
              {p.minority >= MIN_EVENTS
                ? 'enough of both outcomes — a normal, defensible threshold is expected.'
                : p.minority === 0
                  ? `no ${p.wrong === 0 ? 'errors' : 'correct clips'} — needs an explicit rule (e.g. penalised/Firth fit or a zero-error bound) reported with its uncertainty.`
                  : p.ok < p.wrong
                    ? `only ${p.ok} correct clips and ${p.vShares.slice(3).reduce((a, b) => a + b, 0) < 0.05 ? 'almost no validated clips above 0.5' : 'few high-score clips'} — 99% is likely unreachable; targeted validation of its higher-score clips would be needed.`
                    : `the curve rests on ${p.minority} ${p.minority === 1 ? 'error' : 'errors'}${p.topN / p.nV > 0.5 ? ` and ${fmtPct(p.topN / p.nV, 0)} of its clips come from one recorder (${p.topRec})` : ''} — fragile; report with wide intervals.`}
            </li>
          ))}
          <li>Report intervals that allow for clustering by file / recorder.</li>
        </ul>
      </div>
    </section>
  )
}

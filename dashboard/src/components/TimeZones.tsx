/**
 * Are the hours local or UTC? Bird recorders: inferred from sun timing of a dawn singer and a
 * nocturnal species. ODK vegetation forms: time-zone label vs independent references.
 */
import { useMemo, useState, type ReactNode } from 'react'
import { axisStyle, baseLayout } from '../charts/build'
import { dawnOnset, duskOnset, hourOfMs, inferClocks, NIGHTJAR, ORIOLE } from '../data/clocks'
import { fmtNum, fmtPct } from '../data/stats'
import { CANDIDATE_SITES, EAT_OFFSET_H, fmtClock, meanSun } from '../data/sun'
import type { Dataset } from '../data/types'
import { OTHER, SERIES, type ThemeTokens } from '../lib/palette'
import { Plot } from './Plot'
import type { OpenView } from './Summary'
import { Segmented } from './ui'

const Verdict = ({ tone, children }: { tone: 'ok' | 'warn' | 'neutral'; children: ReactNode }) => <span className={`verdict v-${tone}`}>{children}</span>

export function TimeZones({ reg, tokens: t, onOpen }: { reg: Map<string, Dataset>; tokens: ThemeTokens; onOpen: OpenView }) {
  const pred = reg.get('birdnet_predictions')
  const survey = reg.get('herbaceous_veg_survey')
  const regis = reg.get('register_vegetation_plots')
  const quad = reg.get('herbaceous_veg_survey-quadrat_repeat')
  const [site, setSite] = useState('lewa')
  const [view, setView] = useState<'recorded' | 'local'>('recorded')
  const series = SERIES[t.theme]

  const birds = useMemo(() => {
    if (!pred) return null
    const hourRec = (r: (typeof pred.rows)[number]) => (typeof r.detection_time === 'number' ? hourOfMs(r.detection_time) : null)
    const { clock, refO, refN, corrections } = inferClocks(pred.rows, hourRec)
    const flagged = [...corrections.keys()]
    const days = pred.rows.map((r) => r.recording_date).filter((x): x is number => typeof x === 'number')
    const from = Math.min(...days)
    const to = Math.max(...days)
    const pick = (sp: string, keep: (rec: string) => boolean, local: boolean) =>
      pred.rows
        .filter((r) => r.common_name === sp && keep(String(r.folder)))
        .map((r) => (local ? (typeof r.detection_time_local === 'number' ? hourOfMs(r.detection_time_local) : null) : hourRec(r)))
        .filter((h): h is number => h !== null)
    const others = (k: string) => !flagged.includes(k)
    const isFlagged = (k: string) => flagged.includes(k)
    const indicators = (keep: (k: string) => boolean, local: boolean) => {
      const o = pick(ORIOLE, keep, local)
      const n = pick(NIGHTJAR, keep, local)
      const nm = n.filter((h) => h < 12).sort((a, b) => a - b)
      return { dawn: dawnOnset(o), dusk: duskOnset(n), lastNight: nm.length >= 20 ? nm[Math.floor(0.95 * (nm.length - 1))] : null, nO: o.length, nN: n.length }
    }
    const nFlaggedPreds = pred.rows.filter((r) => isFlagged(String(r.folder))).length
    const dateChanges = pred.rows.filter((r) => typeof r.recording_date === 'number' && typeof r.date_local === 'number' && r.date_local !== Math.floor((r.detection_time as number) / 86_400_000) * 86_400_000).length
    return { clock, refO, refN, corrections, flagged, from, to, pick, others, isFlagged, indicators, nFlaggedPreds, dateChanges, total: pred.rows.length }
  }, [pred])

  const sun = useMemo(() => {
    if (!birds) return null
    const s = CANDIDATE_SITES.find((x) => x.key === site)!
    const m = meanSun(s.lat, s.lon, birds.from, birds.to)
    const all = CANDIDATE_SITES.map((c) => ({ ...c, ...meanSun(c.lat, c.lon, birds.from, birds.to) }))
    return { site: s, riseUTC: m.rise, setUTC: m.set, all }
  }, [birds, site])

  const fig = useMemo(() => {
    if (!birds || !sun) return null
    const local = view === 'local'
    const hours = Array.from({ length: 24 }, (_, h) => h)
    const dist = (sp: string, keep: (k: string) => boolean) => {
      const xs = birds.pick(sp, keep, local).map(Math.floor)
      return hours.map((h) => (xs.length ? xs.filter((x) => x === h).length / xs.length : 0))
    }
    const riseEAT = sun.riseUTC + EAT_OFFSET_H
    const setEAT = sun.setUTC + EAT_OFFSET_H
    const sunShapes = (xref: string) => [
      { type: 'line', xref, yref: 'paper', x0: riseEAT, x1: riseEAT, y0: 0, y1: 1, line: { color: series[5], width: 2 } },
      { type: 'line', xref, yref: 'paper', x0: setEAT, x1: setEAT, y0: 0, y1: 1, line: { color: series[4], width: 2 } },
      { type: 'line', xref, yref: 'paper', x0: sun.riseUTC, x1: sun.riseUTC, y0: 0, y1: 1, line: { color: series[5], width: 1, dash: 'dot' } },
      { type: 'line', xref, yref: 'paper', x0: sun.setUTC, x1: sun.setUTC, y0: 0, y1: 1, line: { color: series[4], width: 1, dash: 'dot' } },
      { type: 'rect', xref, yref: 'paper', x0: -0.5, x1: riseEAT, y0: 0, y1: 1, fillcolor: t.theme === 'dark' ? 'rgba(255,255,255,0.03)' : 'rgba(0,53,77,0.04)', line: { width: 0 }, layer: 'below' },
      { type: 'rect', xref, yref: 'paper', x0: setEAT, x1: 23.5, y0: 0, y1: 1, fillcolor: t.theme === 'dark' ? 'rgba(255,255,255,0.03)' : 'rgba(0,53,77,0.04)', line: { width: 0 }, layer: 'below' },
    ]
    const panel = (sp: string, i: number) => {
      const sfx = i === 0 ? '' : '2'
      return [
        { type: 'bar', x: hours.map((h) => h + 0.5), y: dist(sp, birds.others), name: `${43 - birds.flagged.length > 0 ? 'other recorders' : ''}`, legendgroup: 'o', showlegend: i === 0, xaxis: `x${sfx}`, yaxis: `y${sfx}`, marker: { color: OTHER[t.theme] }, width: 0.85, hovertemplate: `${sp}<br>%{x:.0f}h: %{y:.1%} (other recorders)<extra></extra>` },
        ...birds.flagged.filter((rec) => birds.pick(sp, (k) => k === rec, local).length > 0).map((rec) => ({ rec, j: birds.flagged.indexOf(rec) })).map(({ rec, j }) => ({
          type: 'scatter',
          mode: 'lines+markers',
          x: hours.map((h) => h + 0.5),
          y: dist(sp, (k) => k === rec),
          name: `${rec}${local ? ' (corrected)' : ' (as recorded)'}`,
          legendgroup: rec,
          showlegend: i === 0 || !birds.pick(ORIOLE, (k) => k === rec, local).length,
          xaxis: `x${sfx}`,
          yaxis: `y${sfx}`,
          line: { color: series[j + 1], width: 2 },
          marker: { color: series[j + 1], size: 6, symbol: j ? 'square' : 'circle' },
          hovertemplate: `${rec} ${sp}<br>%{x:.0f}h: %{y:.1%}<extra></extra>`,
        })),
      ]
    }
    const ax = { ...axisStyle(t), dtick: 3, range: [0, 24], title: { text: local ? 'hour of day — local time (EAT)' : 'hour of day — as recorded' } }
    return {
      data: [...panel(ORIOLE, 0), ...panel(NIGHTJAR, 1)],
      layout: {
        ...baseLayout(t),
        grid: { rows: 1, columns: 2, pattern: 'independent', xgap: 0.08 },
        margin: { l: 52, r: 16, t: 70, b: 48 },
        legend: { orientation: 'h', x: 0, y: 1.16, yanchor: 'bottom' },
        xaxis: ax,
        xaxis2: ax,
        yaxis: { ...axisStyle(t), tickformat: '.0%', title: { text: 'share of detections' } },
        yaxis2: { ...axisStyle(t), tickformat: '.0%' },
        shapes: [...sunShapes('x'), ...sunShapes('x2')],
        annotations: [
          { text: `<b>${ORIOLE}</b> — sings from dawn`, xref: 'x domain', yref: 'y domain', x: 0, y: 1.02, xanchor: 'left', yanchor: 'bottom', showarrow: false, font: { size: 12, color: t.ink } },
          { text: `<b>${NIGHTJAR}</b> — calls after dusk`, xref: 'x2 domain', yref: 'y2 domain', x: 0, y: 1.02, xanchor: 'left', yanchor: 'bottom', showarrow: false, font: { size: 12, color: t.ink } },
        ],
      },
    }
  }, [birds, sun, view, t, series])

  const odk = useMemo(() => {
    if (!survey || !regis) return null
    const forms = [
      { ds: survey, name: 'Herbaceous surveys' },
      { ds: regis, name: 'Plot registrations' },
    ]
    const rows = forms.map(({ ds, name }) => {
      const tz = Object.entries(ds.columns.find((c) => c.name === 'survey_end-end_time')?.tz ?? {})
      const d = ds.rows
        .map((r) => (typeof r.SubmissionDate === 'number' && typeof r['survey_end-end_time'] === 'number' ? (r.SubmissionDate - (r['survey_end-end_time'] as number)) / 3_600_000 : null))
        .filter((x): x is number => x !== null)
        .sort((a, b) => a - b)
      return { name, tz, n: ds.rows.length, minDelay: d[0], medDelay: d[Math.floor(d.length / 2)] }
    })
    let inside = 0
    let total = 0
    if (quad) {
      const byKey = new Map(survey.rows.map((r) => [r.KEY, r]))
      for (const r of quad.rows) {
        const m = /^(\d{13})\.jpg$/.exec(String(r.quadrat_image ?? ''))
        const s = byKey.get(r.PARENT_KEY)
        if (!m || !s || typeof s['survey_begin-start_time'] !== 'number' || typeof s['survey_end-end_time'] !== 'number') continue
        total++
        const ts = Number(m[1])
        if (ts >= (s['survey_begin-start_time'] as number) && ts <= (s['survey_end-end_time'] as number)) inside++
      }
    }
    const tzCols = [survey, regis].flatMap((ds) => ds.columns.filter((c) => c.tz).map((c) => ({ ds: ds.title, col: c.label, tz: c.tz! })))
    return { rows, inside, total, tzCols }
  }, [survey, regis, quad])

  if (!birds || !sun || !fig) return <div className="empty">Bird files not found.</div>
  const loc = birds.indicators(birds.others, false)
  const flg = birds.indicators(birds.isFlagged, false)
  const flgLocal = birds.indicators(birds.isFlagged, true)
  const riseEAT = sun.riseUTC + EAT_OFFSET_H
  const setEAT = sun.setUTC + EAT_OFFSET_H
  const near = (x: number | null, ref: number, tol = 1) => x !== null && Math.abs(((x - ref + 36) % 24) - 12) <= tol

  return (
    <div className="summary">
      <section className="sum-section">
        <div className="sum-section-head">
          <div>
            <h2>Are the hours local or UTC?</h2>
            <p className="muted">
              The bird files carry no time zone and no location. Birds keep to the sun, so the question can be tested: on local East Africa Time (UTC+3, no daylight saving) a dawn singer starts near local sunrise and a nocturnal species after local sunset; on UTC clocks everything appears 3 hours earlier. The site is unknown — all four species occur in the East African highlands, and the vegetation project is at Lewa, Kenya — so sunrise/sunset is computed for several candidate sites over the recording period.
            </p>
          </div>
        </div>
        <div className="sim-presets">
          <span className="presets-label">Site for sun times</span>
          <Segmented value={site} onChange={setSite} options={CANDIDATE_SITES.map((s) => ({ value: s.key, label: s.label, title: s.note || `${s.lat}°, ${s.lon}°` }))} />
          <span className="presets-label">Clock</span>
          <Segmented
            value={view}
            onChange={setView}
            options={[
              { value: 'recorded', label: 'As recorded', title: 'Hours exactly as in the file names' },
              { value: 'local', label: 'Corrected to local', title: `Flagged recorders shifted by their inferred correction (${[...birds.corrections.entries()].map(([k, h]) => `${k} +${h} h`).join(', ')})` },
            ]}
          />
        </div>
        <div className="chart-card">
          <Plot data={fig.data} layout={fig.layout} height={360} filename="clock_vs_sun" />
        </div>
        <p className="muted small">
          Solid lines: sunrise (yellow) and sunset (violet) in local time at {sun.site.label}; dotted: the same instants in UTC. Shaded: night (local). Switch to “Corrected to local” to see the flagged recorders fall in line with the rest.
        </p>
      </section>

      <section className="sum-section">
        <div className="sum-section-head">
          <div>
            <h2>Activity vs the sun</h2>
            <p className="muted">
              Sun times averaged over {new Date(birds.from).toISOString().slice(0, 10)} – {new Date(birds.to).toISOString().slice(0, 10)} at {sun.site.label}: sunrise {fmtClock(riseEAT)} EAT = {fmtClock(sun.riseUTC)} UTC; sunset {fmtClock(setEAT)} EAT = {fmtClock(sun.setUTC)} UTC.
            </p>
          </div>
        </div>
        <div className="table-wrap auto">
          <table className="data-table sum-table">
            <thead>
              <tr>
                <th>Indicator</th>
                <th className="num">{43 - birds.flagged.length} other recorders</th>
                <th className="num">{birds.flagged.join(' + ')} as recorded</th>
                <th className="num">{birds.flagged.join(' + ')} corrected</th>
                <th>Expected (sun)</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>
                  <b>Oriole dawn onset</b> <span className="muted small">5th pct of morning detections</span>
                </td>
                <td className="num">{loc.dawn === null ? '—' : fmtClock(loc.dawn)}</td>
                <td className="num">{flg.dawn === null ? '—' : fmtClock(flg.dawn)}</td>
                <td className="num">{flgLocal.dawn === null ? '—' : fmtClock(flgLocal.dawn)}</td>
                <td>
                  sunrise {fmtClock(riseEAT)} EAT / {fmtClock(sun.riseUTC)} UTC
                </td>
              </tr>
              <tr>
                <td>
                  <b>Nightjar evening onset</b> <span className="muted small">5th pct of evening detections</span>
                </td>
                <td className="num">{loc.dusk === null ? '—' : fmtClock(loc.dusk)}</td>
                <td className="num">{flg.dusk === null ? '—' : fmtClock(flg.dusk)}</td>
                <td className="num">{flgLocal.dusk === null ? '—' : fmtClock(flgLocal.dusk)}</td>
                <td>
                  after sunset {fmtClock(setEAT)} EAT / {fmtClock(sun.setUTC)} UTC
                </td>
              </tr>
              <tr>
                <td>
                  <b>Nightjar last activity before dawn</b> <span className="muted small">95th pct of morning detections</span>
                </td>
                <td className="num">{loc.lastNight === null ? '—' : fmtClock(loc.lastNight)}</td>
                <td className="num">{flg.lastNight === null ? `— (n=${flg.nN})` : fmtClock(flg.lastNight)}</td>
                <td className="num">{flgLocal.lastNight === null ? '—' : fmtClock(flgLocal.lastNight)}</td>
                <td>before sunrise {fmtClock(riseEAT)} EAT</td>
              </tr>
              <tr>
                <td>
                  <b>Verdict</b>
                </td>
                <td className="num">{near(loc.dawn, riseEAT) ? <Verdict tone="ok">local time (EAT)</Verdict> : <Verdict tone="neutral">unclear</Verdict>}</td>
                <td className="num">{near(flg.dawn, sun.riseUTC) ? <Verdict tone="warn">UTC</Verdict> : <Verdict tone="neutral">unclear</Verdict>}</td>
                <td className="num">{near(flgLocal.dawn, riseEAT) ? <Verdict tone="ok">matches local</Verdict> : <Verdict tone="neutral">unclear</Verdict>}</td>
                <td />
              </tr>
            </tbody>
          </table>
        </div>
        <div className="table-wrap auto">
          <table className="data-table sum-table compact-table">
            <thead>
              <tr>
                <th>Candidate site</th>
                <th className="num">Sunrise EAT (UTC)</th>
                <th className="num">Sunset EAT (UTC)</th>
              </tr>
            </thead>
            <tbody>
              {sun.all.map((s) => (
                <tr key={s.key} className={s.key === site ? 'row-on' : ''}>
                  <td>
                    {s.label} <span className="muted small">{s.note}</span>
                  </td>
                  <td className="num">
                    {fmtClock(s.rise + EAT_OFFSET_H)} ({fmtClock(s.rise)})
                  </td>
                  <td className="num">
                    {fmtClock(s.set + EAT_OFFSET_H)} ({fmtClock(s.set)})
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="sum-section">
        <div className="sum-section-head">
          <div>
            <h2>Recorder by recorder</h2>
            <p className="muted">
              Each recorder’s activity against the network (Oriole dawn onset {fmtNum(birds.refO, 2)} h, Nightjar mean hour {fmtNum(birds.refN, 3)} h). A correction is applied only where the sharp indicator (dawn onset) is off by ≥ 2 h and the nocturnal one agrees or is missing.
            </p>
          </div>
          <button type="button" className="btn ghost sm" onClick={() => onOpen('birdnet_predictions', { tab: 'explore', spec: { kind: 'heatmap', x: 'hour_local', y: 'folder', agg: 'count', topN: 60 } })}>
            Open recorder × local hour heatmap
          </button>
        </div>
        <div className="table-wrap auto">
          <table className="data-table sum-table">
            <thead>
              <tr>
                <th>Recorder</th>
                <th className="num">Oriole dawn onset (Δ)</th>
                <th className="num">Nightjar mean hour (Δ)</th>
                <th className="num">Correction</th>
                <th>Verdict</th>
              </tr>
            </thead>
            <tbody>
              {birds.clock.map((c) => (
                <tr key={c.rec} className={c.strong ? 'row-on' : ''}>
                  <td>
                    <b>{c.rec}</b>
                  </td>
                  <td className="num">{c.on === null ? `— (n=${c.nO})` : `${fmtClock(c.on)} (${c.dO! >= 0 ? '+' : ''}${fmtNum(c.dO!, 2)} h)`}</td>
                  <td className="num">{c.nm === null ? `— (n=${c.nN})` : `${fmtClock(c.nm)} (${c.dN! >= 0 ? '+' : ''}${fmtNum(c.dN!, 2)} h)`}</td>
                  <td className="num">{c.correction ? `+${c.correction} h` : '0'}</td>
                  <td>{c.strong ? <Verdict tone="warn">clock on UTC → corrected</Verdict> : c.weak ? <Verdict tone="neutral">inconclusive (one noisy indicator) — not corrected</Verdict> : <Verdict tone="ok">local time</Verdict>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="muted small">
          Derived columns added to BirdNET predictions: <code>clock_correction_h</code>, <code>detection_time_local</code>, <code>hour_local</code>, <code>date_local</code>. The correction is an inference from bird activity, not recorder metadata.
        </p>
      </section>

      {odk && (
        <section className="sum-section">
          <div className="sum-section-head">
            <div>
              <h2>Vegetation forms (ODK): the +02:00 label</h2>
              <p className="muted">Every ODK timestamp is written with an offset. Kenya is UTC+3 — so is the label right, and are the instants right?</p>
            </div>
          </div>
          <div className="table-wrap auto">
            <table className="data-table sum-table">
              <thead>
                <tr>
                  <th>Check</th>
                  <th>Result</th>
                  <th>Reading</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>
                    <b>Offsets written by the devices</b>
                  </td>
                  <td>{odk.tzCols.map((c) => `${c.ds} · ${c.col}: ${Object.entries(c.tz).map(([k, n]) => `${k} ×${n}`).join(', ')}`).join(' · ')}</td>
                  <td>
                    <Verdict tone="warn">+02:00 ≠ Kenya (+03:00)</Verdict>
                  </td>
                </tr>
                {odk.rows.map((r) => (
                  <tr key={r.name}>
                    <td>
                      <b>Server receipt vs form end — {r.name}</b>
                    </td>
                    <td>
                      SubmissionDate (server clock) − end_time: min {fmtNum(r.minDelay, 2)} h, median {fmtNum(r.medDelay, 2)} h over {r.n} forms
                    </td>
                    <td>{r.minDelay >= 0 ? <Verdict tone="ok">never before the form ended → instants consistent</Verdict> : <Verdict tone="warn">some forms “received before finished”</Verdict>}</td>
                  </tr>
                ))}
                <tr>
                  <td>
                    <b>Quadrat photos inside their survey window</b>
                  </td>
                  <td>
                    {odk.inside} / {odk.total} photos (file names are device epoch-milliseconds) fall between the survey’s start and end
                  </td>
                  <td>{odk.inside === odk.total ? <Verdict tone="ok">consistent</Verdict> : <Verdict tone="warn">{fmtPct(1 - odk.inside / Math.max(1, odk.total), 0)} outside</Verdict>}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <div className="note-inline small">
            <b>Reading:</b> the instants are right (the server never receives a form before it ended, and photos sit inside their surveys); only the time-zone label is wrong. Wall-clock times read off the stamps are <b>1 hour behind</b> local Kenyan time — a survey stamped 15:00 started at 16:00 EAT. Durations, delays and ordering are unaffected (they are differences of instants), and the explorer shows ODK times in UTC. Derived column <code>start_hour_eat</code> gives the local start hour.
          </div>
        </section>
      )}

      <section className="sum-section">
        <div className="sum-section-head">
          <div>
            <h2>Could it change conclusions?</h2>
          </div>
        </div>
        <div className="table-wrap auto">
          <table className="data-table sum-table">
            <thead>
              <tr>
                <th>Conclusion</th>
                <th>Affected?</th>
                <th>Why</th>
              </tr>
            </thead>
            <tbody>
              {[
                ['Per-species thresholds and observation labels (Challenge 1)', 'No', 'They use only the score and the correct/wrong outcome; time is not in the model.', 'ok'],
                ['Validation balance, data-quality checks', 'No', `Only ${pred ? pred.rows.filter((r) => birds.isFlagged(String(r.folder)) && r.validated === 'yes').length : 0} uniquely linked validated predictions come from the corrected recorders.`, 'ok'],
                ['Time-of-day patterns (hour_of_day, detection_time, “Hour of day” views)', `Yes — ${fmtPct(birds.nFlaggedPreds / birds.total, 1)} of predictions`, 'The corrected recorders appear 3 h early on the recorder clock; use hour_local / detection_time_local.', 'warn'],
                ['Daily summaries, e.g. the “detected on ≥ 2 days” rule', `Slightly — ${birds.dateChanges} predictions change day`, 'Late-evening detections on UTC clocks belong to the next local day; use date_local.', 'warn'],
                ['Models with time or season covariates (a Wood & Kahl extension)', 'Yes, if uncorrected', 'Fix clocks first.', 'warn'],
                ['Vegetation: durations, submission delays, ordering', 'No', 'Differences of correct instants.', 'ok'],
                ['Vegetation: local time of day', 'By 1 h if read from the stamps', 'Use start_hour_eat (UTC + 3).', 'warn'],
              ].map(([a, b, c, tone]) => (
                <tr key={a}>
                  <td>
                    <b>{a}</b>
                  </td>
                  <td>
                    <Verdict tone={tone as 'ok' | 'warn'}>{b}</Verdict>
                  </td>
                  <td className="small">{c}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="for-us">
          <div className="pipe-col-label">For the Tech team</div>
          <ul>
            <li>Record each recorder’s clock and time zone at deployment (ODK deployment form), and store timestamps with an explicit offset.</li>
            <li>Check clocks automatically after each upload: dawn onset of diurnal singers and dusk onset of nocturnal species vs computed sunrise/sunset at the deployment coordinates.</li>
            <li>Set the field devices’ time zone to Africa/Nairobi (UTC+3) so ODK stamps carry the right offset.</li>
          </ul>
        </div>
      </section>
    </div>
  )
}

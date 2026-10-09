/**
 * Schwinger et al. (2025, preprint): calibration of multi-label bird-sound classifiers
 * (Perch v2, ConvNeXt_BS, AudioProtoPNet, BirdMAE on BirdSet) and post-hoc Platt scaling.
 * Platt scaling: p = σ(a · logit(score) + b) — the same functional form as Wood & Kahl's curve.
 */
import { useMemo, useState } from 'react'
import { axisStyle, baseLayout } from '../../charts/build'
import { fmtNum } from '../../data/stats'
import { fitLogistic, logit, rng, sigmoid } from '../../lib/logistic'
import { OTHER, SERIES, type ThemeTokens } from '../../lib/palette'
import { normal } from '../../lib/simstats'
import { Plot } from '../Plot'
import { Range } from '../ui'
import { Block, FlowChart, ForUs, PAPERS, PaperHeader, Readout, SimBadge, type FlowStep } from './shared'

const STEPS: FlowStep[] = [
  { lane: 'data', title: 'Four classifiers', sub: 'Perch v2 · ConvNeXt_BS · AudioProtoPNet · BirdMAE', detail: <p>Multi-label bird-sound classifiers evaluated on the BirdSet benchmark. BirdNET is <b>not</b> among them.</p> },
  { lane: 'model', title: 'Reliability per class & dataset', sub: 'score vs observed frequency', detail: <p>Calibration means: among clips scored ≈ 0.8, about 80% truly contain the species. Plotting observed frequency against score (a reliability diagram) shows over- or under-confidence.</p> },
  { lane: 'model', title: 'Threshold-free metrics', sub: 'ECE, MCS · cmAP', detail: <p>Calibration is summarised with threshold-free metrics (Expected Calibration Error, ECE, and MCS); discrimination with class-mean average precision (cmAP).</p> },
  { lane: 'human', title: 'Small labelled set', sub: 'calibration data', detail: <p>A small set of labelled clips from the target data is used to fit the correction.</p> },
  { lane: 'model', title: 'Platt scaling', sub: 'p = σ(a·logit(s) + b)', detail: <p>Post-hoc recalibration: a logistic regression of the true label on the logit of the classifier score. A small labelled set was sufficient to significantly improve calibration; global (shared) parameters were affected by dataset variability.</p> },
]

export function Schwinger({ tokens: t }: { tokens: ThemeTokens }) {
  const meta = PAPERS.find((p) => p.key === 'schwinger')!
  const [k, setK] = useState(0.55)
  const [shift, setShift] = useState(-0.5)
  const [n, setN] = useState(150)
  const [seed, setSeed] = useState(1)
  const series = SERIES[t.theme]

  const sim = useMemo(() => {
    const r = rng(500 + seed)
    // Classifier output s; reality: pr(true) = σ(k·logit(s) + shift).  k < 1 → overconfident, k > 1 → underconfident.
    const draw = (m: number) =>
      Array.from({ length: m }, () => {
        const z = normal(r) * 2.4
        const s = sigmoid(z)
        return { s, y: r() < sigmoid(k * z + shift) ? 1 : 0 }
      })
    const test = draw(6000)
    const cal = draw(n)
    const fit = fitLogistic(cal.map((d) => logit(Math.min(Math.max(d.s, 1e-6), 1 - 1e-6))), cal.map((d) => d.y))
    const platt = (s: number) => sigmoid(fit.b0 + fit.b1 * logit(Math.min(Math.max(s, 1e-6), 1 - 1e-6)))
    const bins = (score: (s: number) => number) => {
      const B = 10
      const acc = Array.from({ length: B }, () => ({ n: 0, conf: 0, pos: 0 }))
      for (const d of test) {
        const c = score(d.s)
        const b = Math.min(B - 1, Math.floor(c * B))
        acc[b].n++
        acc[b].conf += c
        acc[b].pos += d.y
      }
      const ece = acc.reduce((a, b) => a + (b.n ? (b.n / test.length) * Math.abs(b.pos / b.n - b.conf / b.n) : 0), 0)
      return { pts: acc.filter((b) => b.n >= 15).map((b) => ({ conf: b.conf / b.n, freq: b.pos / b.n, n: b.n })), ece }
    }
    return { raw: bins((s) => s), cal: bins(platt), fit }
  }, [k, shift, n, seed])

  const fig = useMemo(() => {
    const pts = (b: typeof sim.raw, name: string, color: string, symbol: string) => ({
      type: 'scatter',
      mode: 'lines+markers',
      x: b.pts.map((p) => p.conf),
      y: b.pts.map((p) => p.freq),
      name,
      line: { color, width: 2 },
      marker: { color, size: 9, symbol, line: { color: t.surface, width: 1.5 } },
      text: b.pts.map((p) => `n = ${p.n}`),
      hovertemplate: 'mean score %{x:.2f} → observed %{y:.2f}<br>%{text}<extra>' + name + '</extra>',
    })
    return {
      data: [
        { type: 'scatter', mode: 'lines', x: [0, 1], y: [0, 1], name: 'perfect calibration', line: { color: OTHER[t.theme], width: 1.5 }, hoverinfo: 'skip' },
        pts(sim.raw, `classifier score (ECE ${fmtNum(sim.raw.ece, 3)})`, series[1], 'circle'),
        pts(sim.cal, `after Platt scaling (ECE ${fmtNum(sim.cal.ece, 3)})`, series[0], 'diamond'),
      ],
      layout: {
        ...baseLayout(t),
        margin: { l: 56, r: 16, t: 48, b: 48 },
        xaxis: { ...axisStyle(t), title: { text: 'predicted probability (mean of bin)' }, range: [0, 1] },
        yaxis: { ...axisStyle(t), title: { text: 'observed frequency of the species' }, range: [0, 1] },
        annotations: [
          { x: 0.22, y: 0.88, text: 'under-confident<br>(reality above the score)', showarrow: false, font: { size: 11, color: t.muted } },
          { x: 0.8, y: 0.12, text: 'over-confident<br>(reality below the score)', showarrow: false, font: { size: 11, color: t.muted } },
        ],
      },
    }
  }, [sim, t, series])

  return (
    <div className="summary method">
      <PaperHeader meta={meta}>
        A preprint that benchmarks <b>calibration</b> — whether a score of 0.8 means “right 80% of the time” — for four multi-label bird-sound classifiers on BirdSet. Calibration varied significantly across datasets and classes; Perch v2 and ConvNeXt_BS were consistently under-confident, AudioProtoPNet and BirdMAE mostly over-confident, and calibration seemed better for less frequent classes. A small labelled calibration set with Platt scaling significantly improved calibration.
      </PaperHeader>

      <Block n={1} title="Evaluation workflow" sub="Click a step.">
        <FlowChart steps={STEPS} initial={4} />
      </Block>

      <Block n={2} title="Reliability diagram and Platt scaling" sub="A simulated classifier whose scores are miscalibrated. Bend reality away from the diagonal, choose how many labelled clips are available, and watch Platt scaling — a logistic regression on the logit of the score — pull the curve back to the diagonal.">
        <div className="sim-presets">
          <span className="grow" />
          <button type="button" className="btn primary sm" onClick={() => setSeed(seed + 1)}>
            ↻ New calibration sample
          </button>
          <SimBadge />
        </div>
        <div className="m-two wide">
          <div className="m-controls">
            <label className="field">
              <span className="field-label has-tip" data-tip="Slope linking the classifier’s logit to reality. Below 1: scores are more extreme than reality (over-confident). Above 1: scores are too timid (under-confident).">
                Confidence distortion
              </span>
              <Range value={k} min={0.25} max={2.5} step={0.05} onChange={setK} format={(v) => (v < 0.95 ? `over ×${fmtNum(v, 2)}` : v > 1.05 ? `under ×${fmtNum(v, 2)}` : 'calibrated')} />
            </label>
            <label className="field">
              <span className="field-label has-tip" data-tip="Overall shift: negative values mean the species is present less often than the scores suggest (e.g. a new site with lower prevalence).">
                Bias (prevalence shift)
              </span>
              <Range value={shift} min={-2} max={2} step={0.1} onChange={setShift} format={(v) => fmtNum(v, 2)} />
            </label>
            <label className="field">
              <span className="field-label">Labelled clips for calibration: {n}</span>
              <Range value={n} min={20} max={1000} step={10} onChange={setN} format={(v) => String(v)} />
            </label>
            <div className="readouts">
              <Readout label="ECE before" value={fmtNum(sim.raw.ece, 3)} sub="avg |observed − score|" tone={sim.raw.ece > 0.05 ? 'warn' : 'ok'} />
              <Readout label="ECE after Platt" value={fmtNum(sim.cal.ece, 3)} sub={`fitted a = ${fmtNum(sim.fit.b1, 2)}, b = ${fmtNum(sim.fit.b0, 2)}`} tone={sim.cal.ece > 0.05 ? 'warn' : 'ok'} />
            </div>
            <p className="muted small">ECE: bin predictions by score (10 bins), take the gap between mean score and observed frequency in each bin, average weighted by bin size. Evaluated on 6,000 held-out simulated clips.</p>
          </div>
          <div className="m-chart">
            <div className="chart-card">
              <Plot data={fig.data} layout={fig.layout} height={420} filename="schwinger_reliability" />
            </div>
          </div>
        </div>
        <ForUs>
          <ul>
            <li>
              Wood & Kahl’s species curve <b>is</b> Platt scaling: logit(p) = β₀ + β·logit(confidence). Calibration diagnostics (reliability diagram, ECE per species) are a natural check on our fitted curves.
            </li>
            <li>“Global calibration parameters are affected by dataset variability” echoes Wood & Kahl: recalibrate per species and per deployment context, not once for everything.</li>
            <li>Evidence is about other classifiers, not BirdNET — useful for diagnostics, not as proof of BirdNET’s behaviour on our recorders.</li>
          </ul>
        </ForUs>
      </Block>
    </div>
  )
}

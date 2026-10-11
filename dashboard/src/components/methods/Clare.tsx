/**
 * Clare, Townsend & Zuckerberg (2021): a generalized model structure for false-positive error in
 * detection/nondetection data (occupancy, abundance, phenology). The schematic uses the simplest
 * member — occupancy with false positives and a site-confirmation design — fitted by maximum likelihood.
 */
import { useMemo, useState } from 'react'
import { axisStyle, baseLayout } from '../../charts/build'
import { fmtNum, fmtPct } from '../../data/stats'
import { rng, sigmoid } from '../../lib/logistic'
import { SERIES, type ThemeTokens } from '../../lib/palette'
import { binomPmf, nelderMead } from '../../lib/simstats'
import { Plot } from '../Plot'
import { Range } from '../ui'
import { Block, FlowChart, ForUs, PAPERS, PaperHeader, Readout, SimBadge, type FlowStep } from './shared'

const STEPS: FlowStep[] = [
  { lane: 'data', title: 'Detection / non-detection', sub: 'repeat surveys per site', detail: <p>Each site is surveyed on several occasions; each occasion records detected / not detected — e.g. “species observed by BirdNET on this day”. Some detections are false.</p> },
  { lane: 'model', title: 'State process', sub: 'occupancy · abundance · phenology', detail: <p>The ecological quantity of interest: whether a site is occupied, how many individuals are there, or when a migrant arrives. The generalized structure covers all three; earlier false-positive occupancy models are special cases.</p> },
  { lane: 'model', title: 'Observation process', sub: 'true- and false-positive parts', detail: <p>A detection can come from a true signal (probability p₁₁ when present) or be a false positive (p₁₀, possible even when absent). Ignoring p₁₀ attributes every detection to presence.</p> },
  { lane: 'human', title: 'Confirmation data', sub: 'site- or observation-confirmation', detail: <p>Site-confirmation: the true state is known at some sites. Observation-confirmation: some individual detections are confirmed as true or false (e.g. an expert listens). Either identifies the false-positive rate.</p> },
  { lane: 'ecology', title: 'Unbiased estimates', sub: 'even with few confirmations', detail: <p>In simulations, ignoring false positives biased abundance and arrival-time estimates by 20–70% even when only 5–10% of detections were false; bias was worse when false positives occurred where true detections were unlikely. Models with confirmation data reduced bias substantially, even with few confirmations or a misspecified false-positive process. Empirical example: gray fox abundance in Wisconsin.</p> },
]

const K_MAX = 20

function fitIgnoringFP(y: number[], K: number) {
  const nll = ([a, b]: number[]) => {
    const psi = sigmoid(a)
    const p = sigmoid(b)
    return -y.reduce((s, yi) => s + Math.log(Math.max(1e-300, psi * binomPmf(yi, K, p) + (1 - psi) * (yi === 0 ? 1 : 0))), 0)
  }
  const [a] = nelderMead(nll, [0, 0])
  return sigmoid(a)
}

function fitWithFP(y: number[], K: number, known: (0 | 1 | null)[]) {
  const nll = ([a, b, c]: number[]) => {
    const psi = sigmoid(a)
    const p10 = sigmoid(b)
    const p11 = p10 + (1 - p10) * sigmoid(c) // enforce p11 > p10 (identifiability)
    return -y.reduce((s, yi, i) => {
      const on = psi * binomPmf(yi, K, p11)
      const off = (1 - psi) * binomPmf(yi, K, p10)
      const l = known[i] === 1 ? on : known[i] === 0 ? off : on + off
      return s + Math.log(Math.max(1e-300, l))
    }, 0)
  }
  const [a, b, c] = nelderMead(nll, [0, -2, 0])
  const p10 = sigmoid(b)
  return { psi: sigmoid(a), p10, p11: p10 + (1 - p10) * sigmoid(c) }
}

export function Clare({ tokens: t }: { tokens: ThemeTokens }) {
  const meta = PAPERS.find((p) => p.key === 'clare')!
  const [psi, setPsi] = useState(0.35)
  const [p11, setP11] = useState(0.4)
  const [p10, setP10] = useState(0.04)
  const [K, setK] = useState(10)
  const [conf, setConf] = useState(0.1)
  const [seed, setSeed] = useState(1)
  const series = SERIES[t.theme]
  const S = 300

  const sim = useMemo(() => {
    const r = rng(1300 + seed)
    const z = Array.from({ length: S }, () => (r() < psi ? 1 : 0))
    const y = z.map((zi) => {
      let d = 0
      for (let k = 0; k < K; k++) if (r() < (zi ? p11 : p10)) d++
      return d
    })
    const known = z.map((zi) => (r() < conf ? (zi as 0 | 1) : null))
    const det = y.reduce((a, yi) => a + yi, 0)
    const falseDet = y.reduce((a, yi, i) => a + (z[i] ? 0 : yi), 0)
    return {
      trueOcc: z.filter(Boolean).length / S,
      any: y.filter((v) => v >= 1).length / S,
      two: y.filter((v) => v >= 2).length / S,
      ignore: fitIgnoringFP(y, K),
      fp: fitWithFP(y, K, known),
      fpShare: det ? falseDet / det : 0,
      nKnown: known.filter((v) => v !== null).length,
    }
  }, [psi, p11, p10, K, conf, seed])

  const dots = useMemo(() => {
    const rows = [
      { name: 'true occupancy', v: sim.trueOcc, c: t.ink, s: 'line-ns-open' },
      { name: '≥ 1 detection (naive)', v: sim.any, c: series[1], s: 'circle' },
      { name: '≥ 2 detections (W&K rule)', v: sim.two, c: series[5], s: 'square' },
      { name: 'occupancy model, ignores FP', v: sim.ignore, c: series[3], s: 'triangle-up' },
      { name: `model with FP + ${sim.nKnown} confirmed sites`, v: sim.fp.psi, c: series[0], s: 'diamond' },
    ]
    return {
      data: [{ type: 'scatter', mode: 'markers', x: rows.map((r) => r.v), y: rows.map((r) => r.name), marker: { color: rows.map((r) => r.c), size: 13, symbol: rows.map((r) => r.s), line: { width: 3, color: rows.map((r) => r.c) } }, hovertemplate: '%{y}: %{x:.3f}<extra></extra>', showlegend: false }],
      layout: {
        ...baseLayout(t),
        margin: { l: 230, r: 20, t: 16, b: 44 },
        xaxis: { ...axisStyle(t), title: { text: 'estimated share of occupied sites' }, range: [0, 1] },
        yaxis: { ...axisStyle(t), autorange: 'reversed', showgrid: false },
        shapes: [{ type: 'line', x0: sim.trueOcc, x1: sim.trueOcc, yref: 'paper', y0: 0, y1: 1, line: { color: t.ink, width: 1 } }],
      },
    }
  }, [sim, t, series])

  const curve = useMemo(() => {
    const xs = Array.from({ length: 41 }, (_, i) => i * 0.005)
    const naive = xs.map((f) => psi * (1 - (1 - p11) ** K) + (1 - psi) * (1 - (1 - f) ** K))
    return {
      data: [
        { type: 'scatter', mode: 'lines', x: xs, y: naive, name: '≥ 1 detection (expected)', line: { color: series[1], width: 2.5 }, hovertemplate: 'p₁₀ %{x:.3f}: %{y:.2f}<extra></extra>' },
        { type: 'scatter', mode: 'lines', x: [0, 0.2], y: [psi, psi], name: 'true ψ', line: { color: t.ink, width: 1.5 }, hoverinfo: 'skip' },
      ],
      layout: {
        ...baseLayout(t),
        margin: { l: 56, r: 16, t: 36, b: 44 },
        xaxis: { ...axisStyle(t), title: { text: 'false-positive rate per survey (p₁₀)' }, range: [0, 0.2] },
        yaxis: { ...axisStyle(t), title: { text: 'share of sites' }, range: [0, 1] },
        shapes: [{ type: 'line', x0: p10, x1: p10, y0: 0, y1: 1, line: { color: t.muted, width: 1 } }],
      },
    }
  }, [psi, p11, p10, K, t, series])

  return (
    <div className="summary method">
      <PaperHeader meta={meta}>
        Detection/non-detection data are imperfect in both directions. Clare et al. describe a <b>generalized model structure</b> that accounts for false-positive error across occupancy, abundance and phenology models, show earlier false-positive occupancy models are special cases, and find that ignoring false positives causes severe bias (20–70% relative bias for abundance and arrival time with only 5–10% false detections). Site- or observation-confirmation designs fix most of it.
      </PaperHeader>

      <Block n={1} title="Model structure" sub="Click a step.">
        <FlowChart steps={STEPS} initial={2} />
      </Block>

      <Block n={2} title="Occupancy with false positives" sub="The simplest member of the family. Simulated sites, each surveyed K times; occupied sites are detected with p₁₁ per survey, unoccupied ones produce false detections with p₁₀. Compare naive summaries and models with and without false positives.">
        <div className="sim-presets">
          <span className="grow" />
          <button type="button" className="btn primary sm" onClick={() => setSeed(seed + 1)}>
            ↻ New survey data
          </button>
          <SimBadge />
        </div>
        <div className="m-two wide">
          <div className="m-controls">
            <label className="field">
              <span className="field-label">True occupancy ψ: {fmtPct(psi, 0)}</span>
              <Range value={psi} min={0.05} max={0.95} step={0.05} onChange={setPsi} format={(v) => fmtPct(v, 0)} />
            </label>
            <label className="field">
              <span className="field-label">Detection when present p₁₁</span>
              <Range value={p11} min={0.05} max={0.95} step={0.05} onChange={setP11} format={(v) => fmtNum(v, 2)} />
            </label>
            <label className="field">
              <span className="field-label has-tip" data-tip="Probability that a survey of an unoccupied site still records a detection — e.g. a BirdNET false positive accepted as an observation.">
                False positive when absent p₁₀
              </span>
              <Range value={p10} min={0} max={0.2} step={0.005} onChange={setP10} format={(v) => fmtNum(v, 3)} />
            </label>
            <label className="field">
              <span className="field-label">Surveys per site K: {K}</span>
              <Range value={K} min={2} max={K_MAX} step={1} onChange={setK} format={(v) => String(v)} />
            </label>
            <label className="field">
              <span className="field-label has-tip" data-tip="Share of sites whose true status is confirmed independently (site-confirmation design).">
                Sites confirmed
              </span>
              <Range value={conf} min={0} max={0.5} step={0.02} onChange={setConf} format={(v) => fmtPct(v, 0)} />
            </label>
            <div className="readouts">
              <Readout label="False detections" value={fmtPct(sim.fpShare, 1)} sub="of all detections" tone={sim.fpShare > 0.05 ? 'warn' : 'ok'} />
              <Readout label="FP model: p₁₀, p₁₁" value={`${fmtNum(sim.fp.p10, 3)}, ${fmtNum(sim.fp.p11, 2)}`} sub={`true ${fmtNum(p10, 3)}, ${fmtNum(p11, 2)}`} />
            </div>
          </div>
          <div className="m-chart">
            <div className="chart-card">
              <Plot data={dots.data} layout={dots.layout} height={250} filename="clare_estimates" />
            </div>
            <div className="chart-card">
              <Plot data={curve.data} layout={curve.layout} height={260} filename="clare_bias_curve" />
            </div>
          </div>
        </div>
        <ForUs>
          <ul>
            <li>A 99% threshold reduces but does not remove false positives; with many surveys per site even a small per-survey false-positive rate inflates naive occupancy — more surveys make it worse.</li>
            <li>What we hand to the Tech team should keep each observation’s score and estimated pr(correct), so downstream models can account for false positives instead of treating labels as certain.</li>
            <li>The validated clips are exactly the “observation-confirmation” data these models need.</li>
          </ul>
          <p className="final-note small">
            <b>In the final analysis:</b> Downstream: the labelled file exports p_correct for every prediction with an identified curve, and the validated clips are kept as confirmation data, so occupancy models can account for the false positives a 99% threshold still leaves.
          </p>
        </ForUs>
      </Block>
    </div>
  )
}

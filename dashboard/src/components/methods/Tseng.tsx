/**
 * Tseng, Hodder & Otter (2025). Species-specific thresholds chosen so that the PRECISION OF ALL
 * PREDICTIONS KEPT above the threshold reaches a target (0.9 in the paper), computed as
 *   precision(T) = Σ_{i ≥ T} TPR_i · N_i  /  Σ_{i ≥ T} N_i
 * with TPR from a binomial GLM on raw confidence fitted to a stratified validation sample.
 */
import { useMemo, useState } from 'react'
import { axisStyle, baseLayout } from '../../charts/build'
import { fmtNum, fmtPct } from '../../data/stats'
import { fitLogistic, logit, rng, sigmoid } from '../../lib/logistic'
import { OTHER, SERIES, type ThemeTokens } from '../../lib/palette'
import { Plot } from '../Plot'
import { Range, Segmented } from '../ui'
import { Block, FlowChart, ForUs, PAPERS, PaperHeader, Readout, SimBadge, type FlowStep } from './shared'

const STEPS: FlowStep[] = [
  { lane: 'data', title: 'Run BirdNET', sub: '19 species · 66 sites · 2 seasons', detail: <p>Two breeding seasons (2020–2021) of AudioMoth recordings from 66 sites in northern British Columbia, processed with BirdNET (default settings: sensitivity 1.0, minimum confidence 0.1).</p> },
  { lane: 'human', title: 'Stratified validation', sub: '10 clips per 0.05 class', detail: <p>For each species, 10 random 3-s clips from every confidence class of width 0.05 (0.10–0.15 … 0.95–1.00): 180 clips per species, verified by ear and spectrogram. A pilot showed 10 per class gave curves comparable to 25 or 50; 5 per class diverged.</p> },
  { lane: 'model', title: 'Calibration curve', sub: 'binomial GLM on confidence', detail: <p>Logistic regression of true (1) / false (0) positive on the <b>raw confidence value</b> (not the logit). Back-transformed predictions give the true-positive rate TPR at every confidence value.</p> },
  { lane: 'model', title: 'Expected TP and FP', sub: 'N_TP,i = TPR_i × N_i', detail: <p>Apply the curve to <b>every</b> prediction: at each confidence value i with N<sub>i</sub> predictions, expected true positives = TPR<sub>i</sub>·N<sub>i</sub>, false positives = (1 − TPR<sub>i</sub>)·N<sub>i</sub>.</p> },
  { lane: 'decision', title: 'Precision above T', sub: 'Σ TP / Σ (TP + FP), i ≥ T', detail: <p>For a candidate threshold T, precision of the retained set is the sum of expected TPs above T divided by all predictions above T. Also report the share of predictions retained.</p> },
  { lane: 'decision', title: 'Pick the threshold', sub: 'lowest T with precision ≥ 0.9', detail: <p>Species-specific threshold = the minimum T whose retained set reaches precision ≥ 0.9 (a demonstration value; users choose their own). Compared against a universal threshold of 0.7 for all species.</p> },
]

interface Sp {
  name: string
  a: number
  b: number
  low: number
}
const SPECIES: Sp[] = [
  { name: 'Easy species', a: 4, b: 1, low: 0.55 },
  { name: 'Medium species', a: 0.6, b: 1.1, low: 0.6 },
  { name: 'Hard species', a: -2.2, b: 0.9, low: 0.75 },
]
const GRID = Array.from({ length: 90 }, (_, i) => +(0.1 + i * 0.01).toFixed(2)) // confidence values 0.10 … 0.99

function simulate(sp: Sp, seed: number) {
  const r = rng(seed)
  // Number of predictions at each confidence value: a pile of low scores plus a flat tail.
  const N = GRID.map((c) => Math.round(4000 * (sp.low * Math.exp(-(c - 0.1) / 0.08) * 0.13 + (1 - sp.low) * 0.011)))
  const trueTPR = GRID.map((c) => sigmoid(sp.a + sp.b * logit(Math.min(c, 0.999))))
  // Stratified validation: 10 random clips per 0.05 class (paper design), outcome from the true curve.
  const vx: number[] = []
  const vy: number[] = []
  for (let k = 0; k < 18; k++) {
    for (let j = 0; j < 10; j++) {
      const c = 0.1 + k * 0.05 + r() * 0.05
      vx.push(c)
      vy.push(r() < sigmoid(sp.a + sp.b * logit(Math.min(c, 0.999))) ? 1 : 0)
    }
  }
  const fit = fitLogistic(vx, vy) // on RAW confidence, as in the paper
  // An invalid fit (separation / no convergence) gives no curve: fall back to the observed share
  // correct in each 0.05 class (the stratified design gives 10 clips per class).
  const classShare = (c: number) => {
    const k = Math.min(17, Math.floor((c - 0.1) / 0.05))
    const idx = vx.map((_, i) => i).filter((i) => Math.min(17, Math.floor((vx[i] - 0.1) / 0.05)) === k)
    return idx.length ? idx.filter((i) => vy[i] === 1).length / idx.length : NaN
  }
  const tpr = GRID.map((c) => (fit.valid ? sigmoid(fit.b0 + fit.b1 * c) : classShare(c)))
  const total = N.reduce((a, b) => a + b, 0)
  const above = (T: number, rate: number[]) => {
    let n = 0
    let tp = 0
    GRID.forEach((c, i) => {
      if (c >= T - 1e-9) {
        n += N[i]
        tp += rate[i] * N[i]
      }
    })
    return { n, tp, precision: n ? tp / n : NaN, retained: n / total }
  }
  return { N, trueTPR, tpr, fit, vx, vy, total, above }
}

function thresholds(sim: ReturnType<typeof simulate>, target: number) {
  const aggregate = GRID.find((c) => sim.above(c, sim.tpr).precision >= target) ?? null
  const perPrediction = GRID.find((_, i) => sim.tpr[i] >= target) ?? null
  return { aggregate, perPrediction }
}

export function Tseng({ tokens: t }: { tokens: ThemeTokens }) {
  const meta = PAPERS.find((p) => p.key === 'tseng')!
  const [spIdx, setSpIdx] = useState(1)
  const [target, setTarget] = useState('0.9')
  const [T, setT] = useState(0.5)
  const [universal, setUniversal] = useState(0.7)
  const [seed, setSeed] = useState(1)
  const tgt = Number(target)
  const series = SERIES[t.theme]

  const sims = useMemo(() => SPECIES.map((sp, i) => simulate(sp, 50 + seed * 7 + i)), [seed])
  const sim = sims[spIdx]
  const th = thresholds(sim, tgt)

  const bars = useMemo(() => {
    const classes = Array.from({ length: 18 }, (_, k) => 0.1 + k * 0.05)
    const agg = (rate: (i: number) => number) =>
      classes.map((lo) => GRID.reduce((a, c, i) => (c >= lo - 1e-9 && c < lo + 0.05 - 1e-9 ? a + rate(i) : a), 0))
    const tp = agg((i) => sim.tpr[i] * sim.N[i])
    const fp = agg((i) => (1 - sim.tpr[i]) * sim.N[i])
    const x = classes.map((c) => c + 0.025)
    const lines = [
      { x: T, color: t.ink, name: `your T = ${fmtNum(T, 2)}` },
      ...(th.aggregate !== null ? [{ x: th.aggregate, color: series[0], name: 'Tseng: aggregate precision' }] : []),
      ...(th.perPrediction !== null ? [{ x: th.perPrediction, color: series[2], name: 'per-prediction pr(correct)' }] : []),
      { x: universal, color: series[4], name: `universal ${fmtNum(universal, 2)}` },
    ]
    return {
      data: [
        { type: 'bar', x, y: tp, name: 'expected true positives', marker: { color: series[0] }, hovertemplate: '%{x:.3f}: %{y:.0f} TP<extra></extra>' },
        { type: 'bar', x, y: fp, name: 'expected false positives', marker: { color: series[1] }, hovertemplate: '%{x:.3f}: %{y:.0f} FP<extra></extra>' },
      ],
      layout: {
        ...baseLayout(t),
        barmode: 'stack',
        bargap: 0.08,
        margin: { l: 56, r: 16, t: 40, b: 44 },
        xaxis: { ...axisStyle(t), title: { text: 'BirdNET confidence (0.05 classes)' }, range: [0.1, 1] },
        yaxis: { ...axisStyle(t), title: { text: 'predictions' } },
        shapes: lines.map((l) => ({ type: 'line', x0: l.x, x1: l.x, yref: 'paper', y0: 0, y1: 1, line: { color: l.color, width: 2 } })),
        annotations: lines.map((l, i) => ({ x: l.x, yref: 'paper', y: 1 - i * 0.09, text: l.name, showarrow: false, xanchor: 'left', xshift: 4, font: { size: 10.5, color: l.color }, bgcolor: t.surface })),
      },
    }
  }, [sim, T, th, universal, t, series])

  const curves = useMemo(() => {
    const agg = GRID.map((c) => sim.above(c, sim.tpr).precision)
    const retained = GRID.map((c) => sim.above(c, sim.tpr).retained)
    return {
      data: [
        { type: 'scatter', mode: 'lines', x: GRID, y: sim.trueTPR, name: 'true pr(correct) at this score (simulation only)', line: { color: OTHER[t.theme], width: 1.5 }, hoverinfo: 'skip' },
        { type: 'scatter', mode: 'lines', x: GRID, y: sim.tpr, name: 'fitted pr(correct) at this score — the Wood & Kahl / NS quantity', line: { color: series[2], width: 2.5 }, hovertemplate: 'T %{x:.2f}: pr(correct at T) %{y:.3f}<extra></extra>' },
        { type: 'scatter', mode: 'lines', x: GRID, y: agg, name: 'precision of everything kept above T — Tseng’s quantity', line: { color: series[0], width: 2.5 }, hovertemplate: 'T %{x:.2f}: precision above T %{y:.3f}<extra></extra>' },
        { type: 'scatter', mode: 'lines', x: GRID, y: retained, name: 'share of predictions kept', line: { color: series[4], width: 1.5 }, hovertemplate: 'T %{x:.2f}: %{y:.0%} kept<extra></extra>' },
      ],
      layout: {
        ...baseLayout(t),
        margin: { l: 56, r: 16, t: 70, b: 44 },
        legend: { orientation: 'h', x: 0, y: 1.02, yanchor: 'bottom', font: { size: 11 } },
        xaxis: { ...axisStyle(t), title: { text: 'threshold T (confidence)' }, range: [0.1, 1] },
        yaxis: { ...axisStyle(t), title: { text: 'proportion' }, range: [0, 1.03] },
        shapes: [
          { type: 'line', x0: 0.1, x1: 1, y0: tgt, y1: tgt, line: { color: t.muted, width: 1 } },
          { type: 'line', x0: T, x1: T, y0: 0, y1: 1.03, line: { color: t.ink, width: 1 } },
        ],
        annotations: [{ x: 0.1, y: tgt, xanchor: 'left', yanchor: 'bottom', text: `target ${tgt}`, showarrow: false, font: { size: 11, color: t.muted } }],
      },
    }
  }, [sim, T, tgt, t, series])

  const atT = sim.above(T, sim.tpr)
  const iT = GRID.findIndex((c) => c >= T - 1e-9)

  return (
    <div className="summary method">
      <PaperHeader meta={meta}>
        Tseng et al. validate 19 species and compare a universal threshold (0.7) with species-specific thresholds defined as the <b>lowest confidence at which the predictions kept reach precision ≥ 0.9</b>. Universal 0.7 gave precision 0.70–1.00 but kept only 17 ± 14% (SE) of predictions; species-specific thresholds kept 70 ± 37% while keeping precision above 0.9. Most species-specific thresholds were below 0.35; two species (Varied Thrush, Brown Creeper) never reached 0.9 even at 0.95. No clear link was found between BirdNET performance and song/call complexity.
      </PaperHeader>

      <Block n={1} title="Workflow" sub="Click a step.">
        <FlowChart steps={STEPS} initial={4} />
      </Block>

      <Block n={2} title="Two different targets: precision of the kept set vs pr(correct) of each prediction" sub="Both use the same calibration curve. Tseng asks: “of everything I keep above T, what share is right?”. Wood & Kahl — and Natural State’s brief — ask: “is a prediction at score T right with probability ≥ p?”. Because predictions above T include many with much higher scores, the kept set’s precision is higher than pr(correct) at T, so Tseng’s threshold is lower (more permissive).">
        <div className="sim-presets">
          <span className="presets-label">Species</span>
          <Segmented value={String(spIdx)} onChange={(v) => setSpIdx(Number(v))} options={SPECIES.map((s, i) => ({ value: String(i), label: s.name }))} />
          <span className="presets-label">Target</span>
          <Segmented value={target} onChange={setTarget} options={[{ value: '0.9', label: '0.90', title: 'Tseng et al.’s demonstration value' }, { value: '0.95', label: '0.95' }, { value: '0.99', label: '0.99', title: 'Natural State’s target' }]} />
          <span className="grow" />
          <button type="button" className="btn primary sm" onClick={() => setSeed(seed + 1)}>
            ↻ New validation sample
          </button>
          <SimBadge />
        </div>
        <div className="m-two wide">
          <div className="m-controls">
            <label className="field">
              <span className="field-label">Try a threshold T</span>
              <Range value={T} min={0.1} max={0.99} step={0.01} onChange={setT} format={(v) => fmtNum(v, 2)} />
            </label>
            <label className="field">
              <span className="field-label">Universal threshold</span>
              <Range value={universal} min={0.1} max={0.99} step={0.01} onChange={setUniversal} format={(v) => fmtNum(v, 2)} />
            </label>
            <div className="readouts">
              <Readout label="pr(correct) at T" value={fmtNum(sim.tpr[iT] ?? NaN, 3)} sub="a prediction scoring exactly T" />
              <Readout label="Precision above T" value={fmtNum(atT.precision, 3)} sub={`all ${atT.n.toLocaleString('en-US')} kept`} />
            </div>
            <div className="readouts">
              <Readout label="Tseng threshold" value={th.aggregate === null ? 'not reached' : fmtNum(th.aggregate, 2)} sub={`kept set ≥ ${tgt}`} tone={th.aggregate === null ? 'warn' : 'ok'} />
              <Readout label="Per-prediction threshold" value={th.perPrediction === null ? 'not reached' : fmtNum(th.perPrediction, 2)} sub={`each ≥ ${tgt} (W&K / NS)`} tone={th.perPrediction === null ? 'warn' : 'ok'} />
            </div>
            <p className="muted small">Fitted on a simulated stratified sample of 180 clips (10 per 0.05 class) with a GLM on raw confidence, exactly the paper’s design. {!sim.fit.valid ? 'This sample gives no valid logistic fit (separation or no convergence) — the observed share correct per class is used instead.' : ''}</p>
          </div>
          <div className="m-chart">
            <div className="chart-card">
              <Plot data={curves.data} layout={curves.layout} height={360} filename="tseng_targets" />
            </div>
            <div className="chart-card">
              <Plot data={bars.data} layout={bars.layout} height={280} filename="tseng_tp_fp" />
            </div>
          </div>
        </div>
      </Block>

      <Block n={3} title="Universal vs species-specific, across three species" sub="The paper’s headline comparison, on the simulated species above, at the target you chose.">
        <div className="table-wrap auto">
          <table className="data-table sum-table">
            <thead>
              <tr>
                <th>Species</th>
                <th className="num">Universal threshold</th>
                <th className="num">precision · kept</th>
                <th className="num">Tseng (kept set ≥ target)</th>
                <th className="num">precision · kept</th>
                <th className="num">Per prediction ≥ target</th>
                <th className="num">precision · kept</th>
              </tr>
            </thead>
            <tbody>
              {sims.map((s, i) => {
                const h = thresholds(s, tgt)
                const cell = (T0: number | null) => {
                  if (T0 === null) return <span className="warn-text">not reached</span>
                  const a = s.above(T0, s.tpr)
                  return `${fmtNum(a.precision, 3)} · ${fmtPct(a.retained, 0)}`
                }
                return (
                  <tr key={i} className={i === spIdx ? 'row-on' : ''}>
                    <td>
                      <b>{SPECIES[i].name}</b>
                    </td>
                    <td className="num">{fmtNum(universal, 2)}</td>
                    <td className="num">{cell(universal)}</td>
                    <td className="num">{h.aggregate === null ? '—' : fmtNum(h.aggregate, 2)}</td>
                    <td className="num">{cell(h.aggregate)}</td>
                    <td className="num">{h.perPrediction === null ? '—' : fmtNum(h.perPrediction, 2)}</td>
                    <td className="num">{cell(h.perPrediction)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        <ForUs>
          <ul>
            <li>The brief’s example (“when BirdNET predicts Olive Thrush with 0.56 we can be 99% sure that prediction is correct”) is a <b>per-prediction</b> statement — Wood & Kahl’s target, not Tseng’s.</li>
            <li>Tseng’s quantity is still useful as a <b>report</b>: once thresholds are set, the expected precision and retention of the observations we label can be computed the same way (Σ TPR·N over kept predictions).</li>
            <li>The stratified design (equal clips per score class) gives the curve information across the whole range — relevant because our validation sample is concentrated at low scores for some species.</li>
            <li>Tseng fits on raw confidence; Wood & Kahl recommend the logit. On our data both can be compared.</li>
          </ul>
          <p className="final-note small">
            <b>In the final analysis:</b> Reported as the alternative reading of “99%” (confirmation item C-5): set-level precision would give the Nightjar a threshold of 0.4316 and 4,355 labels, against 0.6666 and 3,147 under the per-prediction rule, which is kept because it is Wood & Kahl’s definition and the brief’s wording.
          </p>
        </ForUs>
      </Block>
    </div>
  )
}

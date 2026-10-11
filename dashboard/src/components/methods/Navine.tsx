/**
 * Navine et al. (2024): estimate call density P(+) — the share of windows containing the call —
 * without a threshold. Logarithmic quantile bins (50%, 25%, 12.5%, …), k random clips validated per
 * bin, per-bin Beta(pos + c, neg + c) with c = 0.1, P(+) = Σ_b P(+|b)·P(b), bootstrap 90% interval.
 */
import { useMemo, useState } from 'react'
import { axisStyle, baseLayout } from '../../charts/build'
import { fmtNum, fmtPct } from '../../data/stats'
import { rng, sigmoid } from '../../lib/logistic'
import { OTHER, SERIES, type ThemeTokens } from '../../lib/palette'
import { beta, normal, phi } from '../../lib/simstats'
import { Plot } from '../Plot'
import { Range, Segmented } from '../ui'
import { Block, FlowChart, ForUs, PAPERS, PaperHeader, Readout, SimBadge, type FlowStep } from './shared'

const STEPS: FlowStep[] = [
  { lane: 'data', title: 'Score every window', sub: 'classifier logits', detail: <p>Every detection window of the study gets a classifier score — no threshold is applied.</p> },
  { lane: 'data', title: 'Logarithmic quantile bins', sub: '50% · 25% · 12.5% · …', detail: <p>Windows are sorted by score: the lowest 50% go to bin 1, the next 25% to bin 2, and so on, the last bin taking the remainder. Bin weights P(b) are therefore known by design (four bins: 0.50, 0.25, 0.125, 0.125). The top bins are small, so validation concentrates where calls are.</p> },
  { lane: 'human', title: 'Validate k per bin', sub: 'positive / negative / unsure', detail: <p>k random windows from each bin are reviewed. The paper used 4 bins × 50 windows for most species (200 per bin for a rare one).</p> },
  { lane: 'model', title: 'Beta per bin', sub: 'P(+|b) with uncertainty', detail: <p>Each bin’s counts define a Beta distribution for the probability that a window in that bin contains the call, with a small constant c = 0.1 added (chosen from coverage experiments).</p> },
  { lane: 'model', title: 'Call density', sub: 'P(+) = Σ P(+|b)·P(b)', detail: <p>Law of total probability. A 90% interval comes from bootstrap draws of the per-bin Betas (5th–95th percentiles).</p> },
  { lane: 'ecology', title: 'Sites under shift', sub: 'strategies 1–3', detail: <p>Site-level density when score distributions change between sites: assume P(+|b) transfers (strategy 1), assume the score distribution of positives transfers and fit a mixture (strategy 2), or their geometric mean (strategy 3, which balanced the other two well). Validating each site directly is accurate but costly.</p> },
]

const BIN_WEIGHTS: Record<string, number[]> = {
  '4': [0.5, 0.25, 0.125, 0.125],
  '5': [0.5, 0.25, 0.125, 0.0625, 0.0625],
  '6': [0.5, 0.25, 0.125, 0.0625, 0.03125, 0.03125],
}

export function Navine({ tokens: t }: { tokens: ThemeTokens }) {
  const meta = PAPERS.find((p) => p.key === 'navine')!
  const [density, setDensity] = useState(0.15)
  const [sep, setSep] = useState(2.2)
  const [k, setK] = useState(50)
  const [nb, setNb] = useState('4')
  const [seed, setSeed] = useState(1)
  const series = SERIES[t.theme]
  const auc = phi(sep / Math.SQRT2)

  const sim = useMemo(() => {
    const r = rng(800 + seed)
    const N = 20000
    const win = Array.from({ length: N }, () => {
      const pos = r() < density
      return { pos, z: pos ? sep / 2 + normal(r) : -sep / 2 + normal(r) }
    }).sort((a, b) => a.z - b.z)
    const trueDensity = win.filter((w) => w.pos).length / N
    const w = BIN_WEIGHTS[nb]
    const bins: { lo: number; hi: number; weight: number; k: number; pos: number; mean: number; zlo: number; zhi: number }[] = []
    let start = 0
    w.forEach((wt, i) => {
      const end = i === w.length - 1 ? N : start + Math.round(wt * N)
      const slice = win.slice(start, end)
      let pos = 0
      for (let j = 0; j < k; j++) pos += slice[Math.floor(r() * slice.length)].pos ? 1 : 0
      const c = 0.1
      bins.push({ lo: start, hi: end, weight: (end - start) / N, k, pos, mean: (pos + c) / (k + 2 * c), zlo: slice[0].z, zhi: slice[slice.length - 1].z })
      start = end
    })
    const est = bins.reduce((a, b) => a + b.weight * b.mean, 0)
    const boots = Array.from({ length: 2000 }, () => bins.reduce((a, b) => a + b.weight * beta(r, b.pos + 0.1, b.k - b.pos + 0.1), 0)).sort((a, b) => a - b)
    const ci = [boots[Math.floor(0.05 * boots.length)], boots[Math.floor(0.95 * boots.length)]]
    const thresholds = [0.5, 0.7, 0.9].map((th) => ({ th, share: win.filter((w0) => sigmoid(w0.z) >= th).length / N }))
    return { win, trueDensity, bins, est, ci, thresholds }
  }, [density, sep, k, nb, seed])

  const hist = useMemo(() => {
    const edges = Array.from({ length: 41 }, (_, i) => -5 + i * 0.25)
    const count = (pos: boolean) => edges.slice(0, -1).map((lo, i) => sim.win.filter((w) => w.pos === pos && w.z >= lo && w.z < edges[i + 1]).length)
    const mid = edges.slice(0, -1).map((lo) => lo + 0.125)
    return {
      data: [
        { type: 'bar', x: mid, y: count(false), name: 'windows without the call', marker: { color: OTHER[t.theme] }, hovertemplate: '%{y}<extra>negative</extra>' },
        { type: 'bar', x: mid, y: count(true), name: 'windows with the call', marker: { color: series[0] }, hovertemplate: '%{y}<extra>positive</extra>' },
      ],
      layout: {
        ...baseLayout(t),
        barmode: 'stack',
        bargap: 0.05,
        margin: { l: 56, r: 16, t: 44, b: 84 },
        legend: { orientation: 'h', x: 0, y: -0.3, yanchor: 'top', font: { size: 11 } },
        xaxis: { ...axisStyle(t), title: { text: 'classifier logit score' }, range: [-5, 5] },
        yaxis: { ...axisStyle(t), title: { text: 'windows' } },
        shapes: sim.bins.slice(1).map((b) => ({ type: 'line', x0: b.zlo, x1: b.zlo, yref: 'paper', y0: 0, y1: 1, line: { color: t.ink2, width: 1.5 } })),
        annotations: sim.bins.map((b, i) => ({ x: (Math.max(b.zlo, -5) + Math.min(b.zhi, 5)) / 2, yref: 'paper', y: 1.0, yanchor: 'bottom', text: `bin ${i + 1}<br>${fmtPct(b.weight, 1)}`, showarrow: false, font: { size: 10.5, color: t.ink2 } })),
      },
    }
  }, [sim, t, series])

  const comp = useMemo(() => {
    const rows = [
      { name: 'true density', v: sim.trueDensity, lo: NaN, hi: NaN, color: t.ink },
      { name: 'Navine estimate (90% CI)', v: sim.est, lo: sim.ci[0], hi: sim.ci[1], color: series[0] },
      ...sim.thresholds.map((th) => ({ name: `share with score ≥ ${th.th}`, v: th.share, lo: NaN, hi: NaN, color: series[1] })),
    ]
    return {
      data: [
        {
          type: 'scatter',
          mode: 'markers',
          y: rows.map((r) => r.name),
          x: rows.map((r) => r.v),
          marker: { color: rows.map((r) => r.color), size: 12, symbol: rows.map((_, i) => (i === 0 ? 'line-ns-open' : i === 1 ? 'diamond' : 'circle')), line: { width: 3, color: rows.map((r) => r.color) } },
          error_x: { type: 'data', symmetric: false, array: rows.map((r) => (Number.isFinite(r.hi) ? r.hi - r.v : 0)), arrayminus: rows.map((r) => (Number.isFinite(r.lo) ? r.v - r.lo : 0)), color: series[0], thickness: 2, width: 6 },
          hovertemplate: '%{y}: %{x:.3f}<extra></extra>',
          showlegend: false,
        },
      ],
      layout: {
        ...baseLayout(t),
        margin: { l: 190, r: 20, t: 16, b: 44 },
        xaxis: { ...axisStyle(t), title: { text: 'proportion of windows with the call' }, rangemode: 'tozero' },
        yaxis: { ...axisStyle(t), autorange: 'reversed', showgrid: false },
        shapes: [{ type: 'line', x0: sim.trueDensity, x1: sim.trueDensity, yref: 'paper', y0: 0, y1: 1, line: { color: t.ink, width: 1 } }],
      },
    }
  }, [sim, t, series])

  return (
    <div className="summary method">
      <PaperHeader meta={meta}>
        Navine et al. argue that choosing a threshold produces <b>biased counts</b>, because false-positive and false-negative rates vary across subsets of the data. They propose estimating <b>call density</b> — the proportion of detection windows containing the target vocalization, regardless of score — with a validation scheme over score quantile bins and Bayesian reasoning about score distributions, including at sites whose distributions shift. Tested on Hawaiian bird data and in simulations with fully annotated datasets.
      </PaperHeader>

      <Block n={1} title="Validation scheme" sub="Click a step.">
        <FlowChart steps={STEPS} initial={1} />
      </Block>

      <Block n={2} title="Estimate density from binned validation — no threshold" sub="Simulated windows with a known share of calls. Change the true density and the classifier’s quality, validate k windows per bin, and compare the estimate with naive “share above a threshold” counts.">
        <div className="sim-presets">
          <span className="presets-label">Bins</span>
          <Segmented value={nb} onChange={setNb} options={['4', '5', '6'].map((v) => ({ value: v, label: v, title: `${v} logarithmic quantile bins` }))} />
          <span className="grow" />
          <button type="button" className="btn primary sm" onClick={() => setSeed(seed + 1)}>
            ↻ New validation sample
          </button>
          <SimBadge />
        </div>
        <div className="m-two wide">
          <div className="m-controls">
            <label className="field">
              <span className="field-label">True call density: {fmtPct(density, 0)}</span>
              <Range value={density} min={0.01} max={0.6} step={0.01} onChange={setDensity} format={(v) => fmtPct(v, 0)} />
            </label>
            <label className="field">
              <span className="field-label has-tip" data-tip="Separation between the score distributions of windows with and without the call, shown as ROC-AUC (0.5 = useless, 1 = perfect).">
                Classifier quality
              </span>
              <Range value={sep} min={0.3} max={5} step={0.1} onChange={setSep} format={() => `AUC ${fmtNum(auc, 3)}`} />
            </label>
            <label className="field">
              <span className="field-label">Validated per bin: {k}</span>
              <Range value={k} min={10} max={200} step={10} onChange={setK} format={(v) => `${v} × ${nb} = ${v * Number(nb)}`} />
            </label>
            <div className="readouts">
              <Readout label="Estimate" value={fmtPct(sim.est, 1)} sub={`90% CI ${fmtPct(sim.ci[0], 1)} – ${fmtPct(sim.ci[1], 1)}`} tone={sim.trueDensity >= sim.ci[0] && sim.trueDensity <= sim.ci[1] ? 'ok' : 'warn'} />
              <Readout label="Truth" value={fmtPct(sim.trueDensity, 1)} sub="known only in a simulation" />
            </div>
            <table className="mini-compare">
              <thead>
                <tr>
                  <th>bin</th>
                  <th>P(b)</th>
                  <th>positive / k</th>
                  <th>P(+|b)</th>
                </tr>
              </thead>
              <tbody>
                {sim.bins.map((b, i) => (
                  <tr key={i}>
                    <td>{i + 1}</td>
                    <td>{fmtPct(b.weight, 1)}</td>
                    <td>
                      {b.pos} / {b.k}
                    </td>
                    <td>{fmtNum(b.mean, 3)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="m-chart">
            <div className="chart-card">
              <Plot data={hist.data} layout={hist.layout} height={330} filename="navine_bins" />
            </div>
            <div className="chart-card">
              <Plot data={comp.data} layout={comp.layout} height={210} filename="navine_estimates" />
            </div>
          </div>
        </div>
        <ForUs>
          <ul>
            <li>
              A <b>different endpoint</b>: the share of windows containing a call (vocal activity), not a label for each prediction. The brief asks for per-prediction observation labels, so this does not replace Wood & Kahl.
            </li>
            <li>Call density is not individual-bird density, but it is a strong candidate for platform dashboards about vocal activity per site and period, without threshold bias.</li>
            <li>The quantile-bin validation design is a useful idea for future validation rounds: it guarantees clips in the rare, high-score region.</li>
          </ul>
          <p className="final-note small">
            <b>In the final analysis:</b> Recommended as a downstream product (Tech handover, section 10): a vocal-activity measure that needs no errors, so it suits species without a threshold such as the Oriole; its quantile-bin design is a template for future validation.
          </p>
        </ForUs>
      </Block>
    </div>
  )
}

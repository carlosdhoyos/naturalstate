/**
 * Thompson et al. (2025): GLMMs to set species-specific thresholds, then community composition
 * compared with point counts. The schematic illustrates what a mixed model adds — partial pooling
 * of species curves — using an empirical-Bayes shrinkage approximation, not the paper's exact model.
 */
import { useMemo, useState } from 'react'
import { axisStyle, baseLayout } from '../../charts/build'
import { fmtNum } from '../../data/stats'
import { fitLogistic, logit, rng, sigmoid, type LogitFit } from '../../lib/logistic'
import { OTHER, SERIES, type ThemeTokens } from '../../lib/palette'
import { normal } from '../../lib/simstats'
import { Plot } from '../Plot'
import { Range, Segmented } from '../ui'
import { Block, FlowChart, ForUs, PAPERS, PaperHeader, SimBadge, type FlowStep } from './shared'

const STEPS: FlowStep[] = [
  { lane: 'data', title: 'BirdNET on all audio', sub: 'many species at once', detail: <p>Passive acoustic recordings processed with BirdNET; predictions for the whole community, not one species.</p> },
  { lane: 'human', title: 'Validate a sample', sub: 'correct / incorrect', detail: <p>Expert-verified predictions across species and confidence scores — the same kind of evidence Wood & Kahl use, but analysed jointly.</p> },
  { lane: 'model', title: 'One mixed model', sub: 'GLMM across species', detail: <p>A generalized linear mixed model (binomial) relates verification outcome to confidence score for all species in one fit. Species-level effects let each species have its own curve while sharing information — species with little validation borrow strength from the others.</p> },
  { lane: 'decision', title: 'Species thresholds', sub: 'solve per species', detail: <p>Each species’ fitted curve gives its own confidence threshold, as in Wood & Kahl.</p> },
  { lane: 'ecology', title: 'Community composition', sub: 'vs point counts', detail: <p>Species lists from the post-processed BirdNET data were compared with co-located point-count surveys in northeastern Vermont. The framework outperformed another post-processing approach and gave species composition similar to the point counts.</p> },
]

interface SimSpecies {
  name: string
  n: number
  b0: number
  b1: number
}

const N_PER = [12, 20, 35, 60, 120, 250]
const X_MIN = logit(0.1)
const X_MAX = logit(0.999)

/** Empirical-Bayes partial pooling of per-species (b0, b1) toward a precision-weighted mean. */
function shrink(fits: LogitFit[], tau: number) {
  const T = [tau * tau, (0.5 * tau) ** 2] // between-species variance of intercept, slope
  const covOf = (f: LogitFit) => (!f.valid ? [[1e4, 0], [0, 1e4]] : f.cov)
  const inv2 = (m: number[][]) => {
    const d = m[0][0] * m[1][1] - m[0][1] * m[1][0]
    return [[m[1][1] / d, -m[0][1] / d], [-m[1][0] / d, m[0][0] / d]]
  }
  const W = fits.map((f) => {
    const V = covOf(f)
    return inv2([[V[0][0] + T[0], V[0][1]], [V[1][0], V[1][1] + T[1]]])
  })
  // precision-weighted mean
  const sumW = W.reduce((a, w) => [[a[0][0] + w[0][0], a[0][1] + w[0][1]], [a[1][0] + w[1][0], a[1][1] + w[1][1]]], [[0, 0], [0, 0]])
  const sumWb = fits.reduce((a, f, i) => [a[0] + W[i][0][0] * f.b0 + W[i][0][1] * f.b1, a[1] + W[i][1][0] * f.b0 + W[i][1][1] * f.b1], [0, 0])
  const iS = inv2(sumW)
  const m = [iS[0][0] * sumWb[0] + iS[0][1] * sumWb[1], iS[1][0] * sumWb[0] + iS[1][1] * sumWb[1]]
  const pooled = fits.map((f, i) => {
    // b̂ = m + T (T + V)^-1 (b − m) = m + T W (b − m)
    const d = [f.b0 - m[0], f.b1 - m[1]]
    const TW = [[T[0] * W[i][0][0], T[0] * W[i][0][1]], [T[1] * W[i][1][0], T[1] * W[i][1][1]]]
    return { b0: m[0] + TW[0][0] * d[0] + TW[0][1] * d[1], b1: m[1] + TW[1][0] * d[0] + TW[1][1] * d[1] }
  })
  return { mean: { b0: m[0], b1: m[1] }, pooled }
}

const thr = (b0: number, b1: number, p: number) => (b1 > 0 ? (logit(p) - b0) / b1 : NaN)
const fmtThr = (x: number) => (!Number.isFinite(x) ? '—' : x > X_MAX ? 'not reached' : x < X_MIN ? '< 0.1 (all)' : fmtNum(sigmoid(x), 3))

export function Thompson({ tokens: t }: { tokens: ThemeTokens }) {
  const meta = PAPERS.find((p) => p.key === 'thompson')!
  const [tau, setTau] = useState(0.8)
  const [spread, setSpread] = useState(0.6)
  const [p, setP] = useState('0.99')
  const [seed, setSeed] = useState(1)
  const series = SERIES[t.theme]
  const target = Number(p)

  const sim = useMemo(() => {
    const r = rng(1000 + seed)
    const species: SimSpecies[] = N_PER.map((n, i) => ({ name: `Species ${String.fromCharCode(65 + i)}`, n, b0: -0.5 + spread * 2.2 * normal(r), b1: Math.max(0.3, 1.3 + spread * 0.5 * normal(r)) }))
    const data = species.map((s) => {
      const x: number[] = []
      const y: number[] = []
      for (let k = 0; k < s.n; k++) {
        const xi = X_MIN + (r() ** 1.4) * (X_MAX - X_MIN)
        x.push(xi)
        y.push(r() < sigmoid(s.b0 + s.b1 * xi) ? 1 : 0)
      }
      return { x, y }
    })
    const fits = data.map((d) => fitLogistic(d.x, d.y))
    return { species, data, fits }
  }, [seed, spread])

  const eb = useMemo(() => shrink(sim.fits, tau), [sim, tau])

  const fig = useMemo(() => {
    const grid = Array.from({ length: 120 }, (_, i) => X_MIN + (i / 119) * (X_MAX - X_MIN))
    const ticks = [0.1, 0.5, 0.9, 0.99, 0.999]
    const layout: Record<string, unknown> = {
      ...baseLayout(t),
      grid: { rows: 2, columns: 3, pattern: 'independent', xgap: 0.08, ygap: 0.22 },
      margin: { l: 50, r: 16, t: 64, b: 44 },
      legend: { orientation: 'h', x: 0, y: 1.12, yanchor: 'bottom', font: { size: 11 } },
      annotations: [] as object[],
    }
    const data: object[] = []
    sim.species.forEach((s, i) => {
      const sfx = i === 0 ? '' : String(i + 1)
      const xa = `x${sfx}`
      const ya = `y${sfx}`
      layout[`xaxis${sfx}`] = { ...axisStyle(t), tickvals: ticks.map(logit), ticktext: ticks.map(String), range: [X_MIN - 0.2, X_MAX + 0.2], ...(i >= 3 ? { title: { text: 'confidence (logit scale)' } } : {}) }
      layout[`yaxis${sfx}`] = { ...axisStyle(t), range: [-0.08, 1.08], ...(i % 3 === 0 ? { title: { text: 'pr(correct)' } } : {}) }
      const f = sim.fits[i]
      const errs = sim.data[i].y.filter((y) => y === 0).length
      ;(layout.annotations as object[]).push({ text: `<b>${s.name}</b> · n = ${s.n} · ${errs} wrong${f.separated ? ' · separated' : !f.valid ? ' · no convergence' : ''}`, xref: `${xa} domain`, yref: `${ya} domain`, x: 0, y: 1.04, xanchor: 'left', yanchor: 'bottom', showarrow: false, font: { size: 11.5, color: t.ink } })
      const show = i === 0
      data.push({ type: 'scatter', mode: 'lines', x: grid, y: grid.map((x) => sigmoid(s.b0 + s.b1 * x)), xaxis: xa, yaxis: ya, name: 'true curve', legendgroup: 'true', showlegend: show, line: { color: OTHER[t.theme], width: 1.5 }, hoverinfo: 'skip' })
      if (f.valid) data.push({ type: 'scatter', mode: 'lines', x: grid, y: grid.map((x) => sigmoid(f.b0 + f.b1 * x)), xaxis: xa, yaxis: ya, name: 'separate fit (no pooling)', legendgroup: 'sep', showlegend: show, line: { color: series[1], width: 1.5 }, hoverinfo: 'skip' })
      const pb = eb.pooled[i]
      data.push({ type: 'scatter', mode: 'lines', x: grid, y: grid.map((x) => sigmoid(pb.b0 + pb.b1 * x)), xaxis: xa, yaxis: ya, name: 'partial pooling', legendgroup: 'pp', showlegend: show, line: { color: series[0], width: 2.5 }, hovertemplate: 'pr(correct) %{y:.3f}<extra>partial pooling</extra>' })
      const r = rng(77 + i)
      data.push({ type: 'scatter', mode: 'markers', x: sim.data[i].x, y: sim.data[i].y.map((y) => y + (r() - 0.5) * 0.08), xaxis: xa, yaxis: ya, name: 'validated clips', legendgroup: 'pts', showlegend: show, marker: { size: 5, color: sim.data[i].y.map((y) => (y ? series[2] : series[1])), opacity: 0.55, symbol: sim.data[i].y.map((y) => (y ? 'circle' : 'x-thin-open')), line: { width: 1, color: sim.data[i].y.map((y) => (y ? t.surface : series[1])) } }, hoverinfo: 'skip' })
    })
    return { data, layout }
  }, [sim, eb, t, series])

  return (
    <div className="summary method">
      <PaperHeader meta={meta}>
        Thompson et al. propose a post-processing framework that uses <b>generalized linear mixed models</b> to set species-specific BirdNET confidence thresholds, and test it against co-located point-count surveys in northeastern Vermont. Their framework outperformed another post-processing approach and produced species composition similar to the point counts — highlighting the mismatch between accuracy and confidence score and the need for species-specific thresholds.
      </PaperHeader>

      <Block n={1} title="Framework" sub="Click a step.">
        <FlowChart steps={STEPS} initial={2} />
      </Block>

      <Block
        n={2}
        title="What a mixed model adds: partial pooling between species"
        sub="Six simulated species with very different amounts of validation. A separate logistic regression per species (orange) is noisy for small samples and undefined under perfect separation; one curve for all species ignores real differences. A mixed model sits between: each species’ curve is pulled toward the community average in proportion to how little evidence it has."
      >
        <div className="sim-presets">
          <span className="presets-label">Target</span>
          <Segmented value={p} onChange={setP} options={['0.9', '0.95', '0.99'].map((v) => ({ value: v, label: v }))} />
          <span className="grow" />
          <button type="button" className="btn primary sm" onClick={() => setSeed(seed + 1)}>
            ↻ New species &amp; samples
          </button>
          <SimBadge />
        </div>
        <div className="m-two wide">
          <div className="m-controls">
            <label className="field">
              <span className="field-label has-tip" data-tip="Between-species standard deviation of the curves (τ). Left: complete pooling — every species gets the community curve. Right: no pooling — every species keeps its own fit. A real mixed model estimates τ from the data.">
                Pooling: complete ↔ none
              </span>
              <Range value={tau} min={0.02} max={4} step={0.02} onChange={setTau} format={(v) => `τ = ${fmtNum(v, 2)}`} />
            </label>
            <label className="field">
              <span className="field-label has-tip" data-tip="How different the true species curves are from each other in this simulation.">
                True differences between species
              </span>
              <Range value={spread} min={0} max={1.5} step={0.05} onChange={setSpread} format={(v) => fmtNum(v, 2)} />
            </label>
            <div className="table-wrap auto">
              <table className="data-table sum-table compact-table">
                <thead>
                  <tr>
                    <th>Species</th>
                    <th className="num">n</th>
                    <th className="num">true</th>
                    <th className="num">separate</th>
                    <th className="num">pooled</th>
                  </tr>
                </thead>
                <tbody>
                  {sim.species.map((s, i) => (
                    <tr key={i}>
                      <td>{s.name.replace('Species ', '')}</td>
                      <td className="num">{s.n}</td>
                      <td className="num">{fmtThr(thr(s.b0, s.b1, target))}</td>
                      <td className="num">{!sim.fits[i].valid ? <span className="warn-text">{sim.fits[i].separated ? 'separated' : 'no fit'}</span> : fmtThr(thr(sim.fits[i].b0, sim.fits[i].b1, target))}</td>
                      <td className="num">
                        <b>{fmtThr(thr(eb.pooled[i].b0, eb.pooled[i].b1, target))}</b>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="muted small">Thresholds (confidence) for pr(correct) ≥ {p}. “pooled” uses an empirical-Bayes shrinkage approximation of a mixed model with the τ you set — an illustration of the idea, not the paper’s exact model.</p>
          </div>
          <div className="m-chart">
            <div className="chart-card">
              <Plot data={fig.data} layout={fig.layout} height={560} filename="thompson_partial_pooling" />
            </div>
          </div>
        </div>
        <ForUs>
          <ul>
            <li>With only 4 species, the community average is poorly estimated, so the extra complexity of a mixed model needs a justification.</li>
            <li>It would give the Oriole (no errors, perfect separation) a finite curve — but only by assuming it behaves like the other species, which is exactly what its data cannot confirm. That assumption must be stated if used.</li>
            <li>It becomes attractive on the platform once many species are validated: new or rarely validated species start from the community curve and move away as evidence accumulates.</li>
          </ul>
          <p className="final-note small">
            <b>In the final analysis:</b> Not adopted for labels (D-14): with four species, pooling would give the Oriole and Plover a curve only by assuming they behave like the others, against Wood & Kahl’s point that scores do not transfer between species. Recommended for the platform once many species are validated.
          </p>
        </ForUs>
      </Block>
    </div>
  )
}

/**
 * Wood & Kahl (2024), "Guidelines for appropriate use of BirdNET scores and other detector
 * outputs", J. Ornithol. — explained with interactive schematics.
 *
 * Everything interactive on this page uses SIMULATED data so the method can be explored
 * freely; the real per-species fits are a separate step.
 */
import { useMemo, useState, type ReactNode } from 'react'
import { axisStyle, baseLayout } from '../charts/build'
import { fmtInt, fmtNum, fmtPct } from '../data/stats'
import { fitLogistic, logit, rng, sigmoid, thresholdFor, type LogitFit } from '../lib/logistic'
import { OTHER, SERIES, type ThemeTokens } from '../lib/palette'
import { Plot } from './Plot'
import type { OpenView } from './Summary'
import { Icon, Range, Segmented } from './ui'

const DOI = 'https://doi.org/10.1007/s10336-024-02144-5'
const X_MIN = logit(0.1) // the export kept confidence ≥ 0.1
const X_MAX = logit(0.9999)
const CONF_TICKS = [0.1, 0.25, 0.5, 0.75, 0.9, 0.97, 0.99, 0.999]

// ── layout helpers ────────────────────────────────────────────────────────────

function Block({ n, title, sub, children }: { n?: number; title: string; sub?: ReactNode; children: ReactNode }) {
  return (
    <section className="m-block">
      <header className="m-block-head">
        {n !== undefined && <span className="m-num">{n}</span>}
        <div>
          <h2>{title}</h2>
          {sub && <p className="muted">{sub}</p>}
        </div>
      </header>
      {children}
    </section>
  )
}

function Readout({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: 'ok' | 'warn' }) {
  return (
    <div className={`readout ${tone ?? ''}`}>
      <div className="readout-label">{label}</div>
      <div className="readout-value">{value}</div>
      {sub && <div className="readout-sub">{sub}</div>}
    </div>
  )
}

const SimBadge = () => (
  <span className="sim-badge" data-tip="This panel uses simulated predictions and outcomes so you can explore the method. It does not use the challenge data." data-tip-title="Simulated data">
    Simulated data
  </span>
)

// ── 1. pipeline ───────────────────────────────────────────────────────────────

type Phase = 'birdnet' | 'validation' | 'threshold'
const PHASES: Record<Phase, { label: string; who: string }> = {
  birdnet: { label: 'BirdNET', who: 'automatic · already on the platform' },
  validation: { label: 'Validation', who: 'human · a sample of clips' },
  threshold: { label: 'Thresholding', who: 'statistics · what this challenge asks for' },
}

interface Step {
  phase: Phase
  title: string
  short: string
  paper: string
  data: string
  open?: Parameters<OpenView>
}

const STEPS: Step[] = [
  {
    phase: 'birdnet',
    title: 'Record audio',
    short: 'Passive acoustic recorders',
    paper: 'Scores depend on the recording: the same song recorded on different hardware, or at a different sample rate, gets different BirdNET scores. Keep recording settings consistent, or validate again.',
    data: '43 recorders (RBS02 …) wrote 1-hour WAV files named RECORDER_YYYYMMDD_HHMMSS.',
    open: ['birdnet_predictions', { tab: 'explore', spec: { kind: 'heatmap', x: 'common_name', y: 'folder', agg: 'count', topN: 60 } }],
  },
  {
    phase: 'birdnet',
    title: 'Score every 3-s segment',
    short: 'One score per species',
    paper: 'BirdNET (a convolutional neural network) cuts audio into 3-second segments and outputs an unbounded "logit score" for every species it knows, typically about −4 to 7. A sigmoid squeezes it into a 0–1 "confidence score". The score is not a probability.',
    data: 'begin_time_s / end_time_s are 3-s windows; confidence is the 0–1 score.',
  },
  {
    phase: 'birdnet',
    title: 'Keep predictions above a minimum',
    short: 'Predictions ≠ observations',
    paper: 'By default BirdNET hides scores below 0.01. Everything kept is a prediction — a candidate, not yet an observation.',
    data: 'This export kept scores ≥ 0.1: 29,491 predictions for 4 species.',
    open: ['birdnet_predictions', { tab: 'overview' }],
  },
  {
    phase: 'validation',
    title: 'Draw a validation sample',
    short: 'Random, across the score range',
    paper: 'For each species, randomly select predictions spanning the full range of scores. A purely random sample mirrors the score distribution, which for rare or poorly classified species is mostly low scores — so add a second random sample from higher scores, where false positives turn into true positives.',
    data: 'validation_results.csv: 551 clips. See "Validation coverage by confidence band" on the Summary.',
    open: ['validation_results', { tab: 'explore', spec: { kind: 'histogram', x: 'confidence', color: 'commonName', barmode: 'stack', bins: 20 } }],
  },
  {
    phase: 'validation',
    title: 'Listen and mark correct / incorrect',
    short: 'Expert review',
    paper: 'An expert reviews each clip and records whether BirdNET was right. BirdNET’s "segments" tool writes the confidence score at the start of each clip’s file name, so outcome and score stay linked.',
    data: 'File names like 0.107_4_RBS21_20230630_190000.wav start with the score; outcome = 1 / 0.',
    open: ['validation_results', { tab: 'table' }],
  },
  {
    phase: 'threshold',
    title: 'Back-transform to the logit scale',
    short: 'logit = ln(c / (1 − c)) / sensitivity',
    paper: 'Either score can be used, but the authors recommend the logit score: high confidence values are compressed near 1, while logit scores are spread out and better suited to logistic regression.',
    data: 'Derived column logit_confidence (assumes BirdNET’s default sensitivity, so logit = ln(c/(1−c))).',
  },
  {
    phase: 'threshold',
    title: 'Fit a logistic regression per species',
    short: 'logit(p) = β₀ + β·score',
    paper: 'Relate the binary outcome to the score: p is the probability that a prediction is correct. Optional covariates (season, latitude, ecosystem) compared with AIC test whether the relationship transfers across space and time.',
    data: 'One model per species, fitted on that species’ validated clips.',
    open: ['validation_results', { tab: 'explore', spec: { kind: 'scatter', x: 'confidence', xTransform: 'logit', y: 'outcome', jitterY: 0.08, color: 'outcome_label', facet: 'commonName', trend: true, bins: 8, opacity: 0.55 } }],
  },
  {
    phase: 'threshold',
    title: 'Solve for the threshold',
    short: 'score* = (ln(p/(1−p)) − β₀) / β',
    paper: 'The fitted model can be solved for any desired p. The score is no longer unitless: "a prediction above score* is correct with probability ≥ p".',
    data: 'Natural State’s target: p = 0.99.',
  },
  {
    phase: 'threshold',
    title: 'Label predictions as observations',
    short: 'score ≥ score* → observation',
    paper: 'Describe the dataset in consistent terms ("all species: pr(tp) ≥ 0.99"), disclose the estimated error rates, and optionally require detections on ≥ 2 days before calling a species present.',
    data: 'The new "observation" field in birdnet_predictions.',
  },
]

function Pipeline({ onOpen }: { onOpen: OpenView }) {
  const [sel, setSel] = useState(6)
  const s = STEPS[sel]
  return (
    <div className="pipeline">
      <div className="pipe-row" role="tablist" aria-label="Method steps">
        {(Object.keys(PHASES) as Phase[]).map((ph) => (
          <div key={ph} className={`pipe-phase ph-${ph}`}>
            <div className="pipe-phase-head">
              <b>{PHASES[ph].label}</b>
              <span>{PHASES[ph].who}</span>
            </div>
            <div className="pipe-steps">
              {STEPS.map((st, i) =>
                st.phase !== ph ? null : (
                  <button key={i} type="button" role="tab" aria-selected={sel === i} className={`pipe-step ${sel === i ? 'on' : ''}`} onClick={() => setSel(i)}>
                    <span className="pipe-step-n">{i + 1}</span>
                    <span className="pipe-step-title">{st.title}</span>
                    <span className="pipe-step-short">{st.short}</span>
                  </button>
                ),
              )}
            </div>
          </div>
        ))}
      </div>
      <div className={`pipe-detail ph-${s.phase}`} role="tabpanel">
        <div className="pipe-detail-head">
          <span className="pipe-step-n lg">{sel + 1}</span>
          <div>
            <div className="pipe-detail-phase">
              {PHASES[s.phase].label} · {PHASES[s.phase].who}
            </div>
            <h3>{s.title}</h3>
          </div>
          <span className="grow" />
          <button type="button" className="btn ghost sm" disabled={sel === 0} onClick={() => setSel(sel - 1)}>
            ‹ Prev
          </button>
          <button type="button" className="btn ghost sm" disabled={sel === STEPS.length - 1} onClick={() => setSel(sel + 1)}>
            Next ›
          </button>
        </div>
        <div className="pipe-detail-cols">
          <div>
            <div className="pipe-col-label">What the paper says</div>
            <p>{s.paper}</p>
          </div>
          <div>
            <div className="pipe-col-label">In this dataset</div>
            <p>{s.data}</p>
            {s.open && (
              <button type="button" className="btn ghost sm" onClick={() => onOpen(...s.open!)}>
                <Icon name="chart" size={14} /> Show me
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

// ── 2. logit ↔ confidence ─────────────────────────────────────────────────────

function ScoreScale({ t }: { t: ThemeTokens }) {
  const [x, setX] = useState(2.2)
  const [s, setS] = useState(1)
  const c = sigmoid(s * x)
  const series = SERIES[t.theme]

  const fig = useMemo(() => {
    const xs = Array.from({ length: 241 }, (_, i) => -6 + i * 0.065)
    const layout = {
      ...baseLayout(t),
      margin: { l: 56, r: 16, t: 30, b: 48 },
      xaxis: { ...axisStyle(t), title: { text: 'logit score (BirdNET’s raw output)' }, range: [-6, 9.6], zeroline: false },
      yaxis: { ...axisStyle(t), title: { text: 'confidence score' }, range: [-0.02, 1.04] },
      showlegend: true,
      shapes: [
        { type: 'line', x0: x, x1: x, y0: 0, y1: c, line: { color: t.muted, width: 1 } },
        { type: 'line', x0: -6, x1: x, y0: c, y1: c, line: { color: t.muted, width: 1 } },
        { type: 'rect', x0: logit(0.9), x1: 9.6, y0: 0.9, y1: 1.04, fillcolor: `${series[1]}22`, line: { width: 0 }, layer: 'below' },
      ],
      annotations: [
        { x: 6.4, y: 0.86, text: 'every logit above 2.2 is squeezed<br>into confidence 0.9 → 1.0', showarrow: false, font: { size: 11, color: t.ink2 }, align: 'center' },
      ],
    }
    const data = [
      ...(s !== 1 ? [{ type: 'scatter', mode: 'lines', x: xs, y: xs.map((v) => sigmoid(v)), name: 'default slope (s = 1)', line: { color: OTHER[t.theme], width: 1.5 }, hoverinfo: 'skip' }] : []),
      { type: 'scatter', mode: 'lines', x: xs, y: xs.map((v) => sigmoid(s * v)), name: `confidence = 1 / (1 + e^(−${fmtNum(s, 2)}·logit))`, line: { color: series[0], width: 2.5 }, hovertemplate: 'logit %{x:.2f} → confidence %{y:.4f}<extra></extra>' },
      { type: 'scatter', mode: 'markers', x: [x], y: [c], name: 'your point', marker: { color: series[1], size: 12, line: { color: t.surface, width: 2 } }, hovertemplate: 'logit %{x:.2f} → confidence %{y:.4f}<extra></extra>' },
    ]
    return { data, layout }
  }, [t, x, s, c, series])

  return (
    <div className="m-two">
      <div className="m-controls">
        <label className="field">
          <span className="field-label has-tip" data-tip="BirdNET’s unbounded output for one species in one 3-s segment. Drag to see the confidence it maps to.">
            Logit score
          </span>
          <Range value={x} min={-5} max={9} step={0.05} onChange={setX} format={(v) => fmtNum(v, 3)} />
        </label>
        <label className="field">
          <span className="field-label has-tip" data-tip="Steepness of the sigmoid. BirdNET’s user ‘sensitivity’ setting changes it; per Wood & Kahl, higher sensitivity gives a shallower curve and more intermediate scores. With the default (s = 1) the logit score is exactly ln(c / (1 − c)).">
            Sigmoid slope s
          </span>
          <Range value={s} min={0.5} max={2} step={0.05} onChange={setS} format={(v) => fmtNum(v, 3)} />
        </label>
        <div className="readouts">
          <Readout label="confidence" value={fmtNum(c, 4)} sub={`= 1 / (1 + e^(−${fmtNum(s, 2)} × ${fmtNum(x, 2)}))`} />
          <Readout label="back-transformed" value={fmtNum(Math.log(c / (1 - c)) / s, 3)} sub="ln(c / (1 − c)) / s — recovers the logit" />
        </div>
        <p className="muted small">
          Moving confidence from 0.90 to 0.99 takes the logit from {fmtNum(logit(0.9), 3)} to {fmtNum(logit(0.99), 3)} — a {fmtNum(logit(0.99) - logit(0.9), 2)}-unit step, as large as going from {fmtNum(sigmoid(-(logit(0.99) - logit(0.9))), 2)} to 0.5. That compression is why the paper fits the regression on the logit score.
        </p>
      </div>
      <div className="m-chart">
        <div className="chart-card">
          <Plot data={fig.data} layout={fig.layout} height={330} filename="logit_vs_confidence" />
        </div>
        <Ruler t={t} />
      </div>
    </div>
  )
}

/** Two aligned rulers: equal steps of confidence vs where they land on the logit scale. */
function Ruler({ t }: { t: ThemeTokens }) {
  const W = 640
  const pad = 24
  const cx = (c: number) => pad + ((c - 0.1) / 0.9) * (W - 2 * pad)
  const lx = (l: number) => pad + ((l - X_MIN) / (logit(0.999) - X_MIN)) * (W - 2 * pad)
  const ticks = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 0.99, 0.999]
  return (
    <figure className="ruler" aria-label="Confidence vs logit scale">
      <svg viewBox={`0 0 ${W} 128`} width="100%" role="img">
        <text x={pad} y={10} className="ruler-title">confidence (0.1 – 1)</text>
        <line x1={pad} x2={W - pad} y1={28} y2={28} stroke={t.axis} />
        <text x={pad} y={124} className="ruler-title">logit score ({fmtNum(X_MIN, 3)} – {fmtNum(logit(0.999), 3)})</text>
        <line x1={pad} x2={W - pad} y1={82} y2={82} stroke={t.axis} />
        {ticks.map((c) => {
          const high = c >= 0.9
          return (
            <g key={c}>
              <line x1={cx(Math.min(c, 1))} x2={lx(logit(c))} y1={30} y2={80} stroke={high ? SERIES[t.theme][1] : t.grid} strokeWidth={high ? 1.5 : 1} />
              <circle cx={cx(Math.min(c, 1))} cy={28} r={2.5} fill={t.ink2} />
              <circle cx={lx(logit(c))} cy={82} r={2.5} fill={t.ink2} />
              {(c <= 0.9 ? [0.1, 0.5, 0.9].includes(c) : c === 0.999) && (
                <text x={cx(Math.min(c, 1))} y={22} textAnchor="middle" className="ruler-tick">{c}</text>
              )}
 <text x={lx(logit(c))} y={98} textAnchor="middle" className="ruler-tick">{[0.1, 0.5, 0.9, 0.99, 0.999].includes(c) ? c : ''}</text>
            </g>
          )
        })}
      </svg>
      <figcaption className="muted small">Equal steps of confidence (top) spread out on the logit scale (bottom). The last 10% of confidence (orange) covers more than half of the logit range.</figcaption>
    </figure>
  )
}

// ── simulation model shared by sections 3 and 4 ──────────────────────────────

interface Scenario {
  key: string
  label: string
  hint: string
  b0: number
  b1: number
  low: number
}
const SCENARIOS: Scenario[] = [
  { key: 'transition', label: 'Clear transition', hint: 'Wrong at low scores, right at high scores — the textbook case.', b0: -1.2, b1: 1.6, low: 0.6 },
  { key: 'gradual', label: 'Gradual', hint: 'Accuracy rises slowly with score: the threshold is high and uncertain.', b0: -0.4, b1: 0.75, low: 0.6 },
  { key: 'almostAlways', label: 'Almost always right', hint: 'Errors are very rare at every score. A validation sample often contains no errors at all, and then the logistic regression has no finite solution (perfect separation). Draw a few samples.', b0: 5.5, b1: 0.5, low: 0.55 },
  { key: 'rarelyRight', label: 'Rarely right', hint: 'Mostly false positives and mostly low scores; the 99% level may not be reached anywhere in the score range.', b0: -3.6, b1: 0.45, low: 0.9 },
]

type Design = 'random' | 'plusHigh' | 'stratified'
const DESIGNS: { value: Design; label: string; title: string }[] = [
  { value: 'random', label: 'Random', title: 'Draw clips at random from all predictions: the sample mirrors the score distribution (mostly low scores).' },
  { value: 'plusHigh', label: 'Random + high', title: 'Half random, half random from confidence ≥ 0.5 — the paper’s fix for rare / poorly classified species.' },
  { value: 'stratified', label: 'Per band', title: 'Equal numbers from each confidence band (0.1–0.2 … 0.9–1.0).' },
]

/** Population of logit scores for one simulated species: a pile of low scores plus a long tail. */
function population(low: number, seed: number, N = 4000): number[] {
  const r = rng(seed)
  const out: number[] = []
  for (let i = 0; i < N; i++) {
    let x: number
    if (r() < low) x = X_MIN - Math.log(1 - r()) * 0.9
    else x = X_MIN + r() * (X_MAX - X_MIN)
    out.push(Math.min(X_MAX, x))
  }
  return out
}

function drawSample(pop: number[], design: Design, n: number, seed: number): number[] {
  const r = rng(seed)
  const pick = (pool: number[], k: number) => Array.from({ length: k }, () => pool[Math.floor(r() * pool.length)])
  if (design === 'random') return pick(pop, n)
  if (design === 'plusHigh') {
    const high = pop.filter((x) => x >= 0)
    return [...pick(pop, Math.ceil(n / 2)), ...(high.length ? pick(high, Math.floor(n / 2)) : [])]
  }
  const edges = [0.1, 0.2, 0.3, 0.5, 0.7, 0.9, 1.0001].map((c) => (c >= 1 ? Infinity : logit(c)))
  const per = Math.max(1, Math.round(n / 6))
  return edges.slice(0, -1).flatMap((lo, i) => {
    const pool = pop.filter((x) => x >= lo && x < edges[i + 1])
    return pool.length ? pick(pool, per) : []
  })
}

// ── 3. approach A: review down to a threshold ────────────────────────────────

function ReviewDown({ t, sc }: { t: ThemeTokens; sc: Scenario }) {
  const [stop, setStop] = useState(0.7)
  const items = useMemo(() => {
    const pop = population(sc.low, 11)
    const r = rng(23)
    return drawSample(pop, 'random', 60, 5)
      .map((x) => ({ x, c: sigmoid(x), ok: r() < sigmoid(sc.b0 + sc.b1 * x) }))
      .sort((a, b) => b.x - a.x)
  }, [sc])
  const reviewed = items.filter((d) => d.c >= stop)
  const okN = reviewed.filter((d) => d.ok).length
  const series = SERIES[t.theme]
  return (
    <div className="m-two">
      <div className="m-controls">
        <p>
          Sort every prediction of a species by score and listen from the top down. Where to stop is a judgement call that balances <b>analyst time</b> against <b>data quality</b>. Everything above the stopping point is verified; everything below is discarded (or reviewed later).
        </p>
        <label className="field">
          <span className="field-label has-tip" data-tip="Clips with a confidence at or above this value are reviewed by a person.">
            Review down to confidence
          </span>
          <Range value={stop} min={0.1} max={1} step={0.01} onChange={setStop} format={(v) => fmtNum(v, 2)} />
        </label>
        <div className="readouts">
          <Readout label="Clips reviewed" value={`${reviewed.length} / ${items.length}`} sub="analyst effort" />
          <Readout label="Correct among reviewed" value={reviewed.length ? fmtPct(okN / reviewed.length, 0) : '—'} sub="verified observations: every one checked" tone="ok" />
        </div>
        <p className="muted small">Strength: every kept observation is verified. Limit: it does not scale to many species or hundreds of thousands of hours, and the stopping score has no meaning for another species or recorder.</p>
      </div>
      <div className="m-chart">
        <div className="chart-card review-grid-card">
          <div className="review-head">
            <span>60 predictions, highest score first</span>
            <SimBadge />
          </div>
          <div className="review-grid">
            {items.map((d, i) => {
              const done = d.c >= stop
              return (
                <span
                  key={i}
                  className={`rv ${done ? (d.ok ? 'ok' : 'bad') : 'todo'}`}
                  style={done ? { background: d.ok ? series[0] : series[1] } : undefined}
                  data-tip={`confidence ${fmtNum(d.c, 3)} · ${done ? (d.ok ? 'reviewed: correct' : 'reviewed: wrong') : 'not reviewed — outcome unknown'}`}
                >
                  {done ? (d.ok ? '✓' : '✗') : ''}
                </span>
              )
            })}
          </div>
          <div className="review-legend muted small">
            <span>
              <i className="rv ok" style={{ background: series[0] }}>✓</i> reviewed, correct
            </span>
            <span>
              <i className="rv bad" style={{ background: series[1] }}>✗</i> reviewed, wrong
            </span>
            <span>
              <i className="rv todo" /> not reviewed
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── 4. approach B: logistic regression simulator ─────────────────────────────

function Simulator({ t, sc, setSc }: { t: ThemeTokens; sc: Scenario; setSc: (s: Scenario) => void }) {
  const [b0, setB0] = useState(sc.b0)
  const [b1, setB1] = useState(sc.b1)
  const [low, setLow] = useState(sc.low)
  const [design, setDesign] = useState<Design>('random')
  const [n, setN] = useState(150)
  const [pStar, setPStar] = useState('0.99')
  const [scale, setScale] = useState<'logit' | 'confidence'>('logit')
  const [seed, setSeed] = useState(1)
  const series = SERIES[t.theme]
  const p = Number(pStar)

  const choose = (s: Scenario) => {
    setSc(s)
    setB0(s.b0)
    setB1(s.b1)
    setLow(s.low)
  }

  const sim = useMemo(() => {
    const pop = population(low, 100 + seed)
    const xs = drawSample(pop, design, n, 200 + seed)
    const r = rng(300 + seed)
    const ys = xs.map((x) => (r() < sigmoid(b0 + b1 * x) ? 1 : 0))
    const fitL = fitLogistic(xs, ys)
    const fitC = fitLogistic(xs.map(sigmoid), ys)
    const thrL = fitL.b1 > 0 ? thresholdFor(fitL, p) : null
    const thrC = fitC.b1 > 0 ? thresholdFor(fitC, p) : null
    const trueX = b1 > 0 ? (logit(p) - b0) / b1 : NaN
    // Consequences on the whole simulated population, using the logit-scale threshold
    const cut = thrL ? thrL.x : Infinity
    const kept = pop.filter((x) => x >= cut)
    const tpAll = pop.reduce((a, x) => a + sigmoid(b0 + b1 * x), 0)
    const tpKept = kept.reduce((a, x) => a + sigmoid(b0 + b1 * x), 0)
    return { pop, xs, ys, fitL, fitC, thrL, thrC, trueX, kept, precisionKept: kept.length ? tpKept / kept.length : NaN, recall: tpAll ? tpKept / tpAll : NaN }
  }, [b0, b1, low, design, n, seed, p])

  const status = (fit: LogitFit, thr: { x: number; lo: number; hi: number } | null, onLogit: boolean) => {
    const max = onLogit ? X_MAX : 0.9999
    const min = onLogit ? X_MIN : 0.1
    if (fit.separated) return { tone: 'warn' as const, text: 'Perfect separation: no finite fit. Every clip on one side of some score is correct (or the sample has no errors at all), so the likelihood keeps improving as the curve gets steeper. The threshold is undefined — more validation (especially errors) or a different rule is needed.' }
    if (!thr) return { tone: 'warn' as const, text: 'The fitted curve does not increase with score — no threshold exists.' }
    if (thr.x > max) return { tone: 'warn' as const, text: `The ${p} level is above the highest possible score: no prediction qualifies as an observation.` }
    if (thr.x < min) return { tone: 'ok' as const, text: `Even the lowest exported score exceeds ${p}: every prediction qualifies.` }
    if (thr.hi - thr.lo > (onLogit ? 3 : 0.3)) return { tone: 'warn' as const, text: 'Threshold found, but its 95% interval is wide — the sample has little information near the threshold.' }
    return { tone: 'ok' as const, text: 'Threshold found with a reasonably narrow interval.' }
  }
  const stL = status(sim.fitL, sim.thrL, true)
  const stC = status(sim.fitC, sim.thrC, false)

  const fig = useMemo(() => {
    const onL = scale === 'logit'
    const fit = onL ? sim.fitL : sim.fitC
    const thr = onL ? sim.thrL : sim.thrC
    const toAxis = (x: number) => (onL ? x : sigmoid(x))
    const grid = Array.from({ length: 200 }, (_, i) => X_MIN + (i / 199) * (X_MAX - X_MIN))
    const r = rng(900 + seed)
    const jit = sim.ys.map((y) => y + (r() - 0.5) * 0.07)
    const pts = (want: number) => sim.xs.map((x, i) => ({ x, y: jit[i], o: sim.ys[i] })).filter((d) => d.o === want)
    const xr = onL ? [X_MIN - 0.3, X_MAX + 0.3] : [0.08, 1.01]
    const shapes: object[] = [{ type: 'line', x0: xr[0], x1: xr[1], y0: p, y1: p, line: { color: t.muted, width: 1 } }]
    if (thr && !sim[onL ? 'fitL' : 'fitC'].separated && thr.x >= (onL ? X_MIN : 0.1) && thr.x <= (onL ? X_MAX : 1)) {
      shapes.push(
        { type: 'rect', x0: thr.x, x1: xr[1], y0: -0.1, y1: 1.1, fillcolor: `${series[0]}14`, line: { width: 0 }, layer: 'below' },
        { type: 'rect', x0: Math.max(xr[0], thr.lo), x1: Math.min(xr[1], thr.hi), y0: -0.1, y1: 1.1, fillcolor: `${series[2]}1f`, line: { width: 0 }, layer: 'below' },
        { type: 'line', x0: thr.x, x1: thr.x, y0: -0.1, y1: 1.1, line: { color: series[0], width: 2 } },
      )
    }
    const layout = {
      ...baseLayout(t),
      margin: { l: 56, r: 16, t: 40, b: 52 },
      xaxis: {
        ...axisStyle(t),
        range: xr,
        title: { text: onL ? 'BirdNET score on the logit scale (tick labels = confidence)' : 'confidence score' },
        ...(onL ? { tickvals: CONF_TICKS.map(logit), ticktext: CONF_TICKS.map(String) } : {}),
      },
      yaxis: { ...axisStyle(t), range: [-0.1, 1.1], title: { text: 'pr(prediction is correct)' }, tickvals: [0, 0.25, 0.5, 0.75, 1], ticktext: ['0 · incorrect', '0.25', '0.5', '0.75', '1 · correct'] },
      shapes,
      annotations: [{ x: xr[0], y: p, xanchor: 'left', yanchor: 'top', text: `target p = ${p}`, showarrow: false, font: { size: 11, color: t.muted }, yshift: -2 }],
    }
    const data = [
      { type: 'scatter', mode: 'lines', x: grid.map(toAxis), y: grid.map((x) => sigmoid(b0 + b1 * x)), name: 'true curve (known only in a simulation)', line: { color: OTHER[t.theme], width: 1.5 }, hoverinfo: 'skip' },
      ...(fit.separated
        ? []
        : [{ type: 'scatter', mode: 'lines', x: grid.map(toAxis), y: grid.map((x) => sigmoid(fit.b0 + fit.b1 * (onL ? x : sigmoid(x)))), name: `fitted on ${onL ? 'logit score' : 'confidence'}`, line: { color: series[0], width: 3 }, hovertemplate: 'score %{x:.3f} → pr(correct) %{y:.3f}<extra></extra>' }]),
      { type: 'scatter', mode: 'markers', x: pts(1).map((d) => toAxis(d.x)), y: pts(1).map((d) => d.y), name: 'validated: correct', marker: { color: series[0], size: 7, opacity: 0.6, symbol: 'circle', line: { color: t.surface, width: 1 } }, hovertemplate: 'confidence %{customdata:.3f}<br>correct<extra></extra>', customdata: pts(1).map((d) => sigmoid(d.x)) },
      { type: 'scatter', mode: 'markers', x: pts(0).map((d) => toAxis(d.x)), y: pts(0).map((d) => d.y), name: 'validated: incorrect', marker: { color: series[1], size: 8, opacity: 0.8, symbol: 'x-thin-open', line: { color: series[1], width: 2 } }, hovertemplate: 'confidence %{customdata:.3f}<br>incorrect<extra></extra>', customdata: pts(0).map((d) => sigmoid(d.x)) },
    ]
    return { data, layout }
  }, [sim, scale, t, b0, b1, p, seed, series])

  const hist = useMemo(() => {
    const onL = scale === 'logit'
    const thr = sim.thrL && !sim.fitL.separated ? sim.thrL.x : Infinity
    const edges = Array.from({ length: 24 }, (_, i) => X_MIN + (i * (X_MAX - X_MIN)) / 23)
    const cnt = (keep: boolean) =>
      edges.slice(0, -1).map((lo, i) => sim.pop.filter((x) => x >= lo && x < edges[i + 1] + (i === edges.length - 2 ? 1e-9 : 0) && (x >= thr) === keep).length)
    const mid = edges.slice(0, -1).map((lo, i) => (onL ? (lo + edges[i + 1]) / 2 : sigmoid((lo + edges[i + 1]) / 2)))
    return {
      data: [
        { type: 'bar', x: mid, y: cnt(false), name: 'stays a prediction', marker: { color: OTHER[t.theme] }, hovertemplate: '%{y} predictions<extra>below threshold</extra>' },
        { type: 'bar', x: mid, y: cnt(true), name: 'labelled observation', marker: { color: series[0] }, hovertemplate: '%{y} predictions<extra>labelled observation</extra>' },
      ],
      layout: {
        ...baseLayout(t),
        barmode: 'stack',
        bargap: 0.08,
        margin: { l: 56, r: 16, t: 34, b: 40 },
        xaxis: { ...axisStyle(t), range: onL ? [X_MIN - 0.3, X_MAX + 0.3] : [0.08, 1.01], ...(onL ? { tickvals: CONF_TICKS.map(logit), ticktext: CONF_TICKS.map(String) } : {}), title: { text: '' } },
        yaxis: { ...axisStyle(t), title: { text: 'predictions' } },
      },
    }
  }, [sim, scale, t, series])

  const fmtThr = (thr: { x: number; lo: number; hi: number } | null, fit: LogitFit, onLogit: boolean) => {
    if (fit.separated) return 'undefined (separation)'
    if (!thr) return '—'
    if (thr.x > (onLogit ? X_MAX : 1)) return 'beyond every score'
    if (thr.x < (onLogit ? X_MIN : 0.1)) return 'below 0.1 — all qualify'
    const c = onLogit ? sigmoid(thr.x) : thr.x
    return fmtNum(c, 4)
  }

  return (
    <div className="sim">
      <div className="sim-presets">
        <span className="presets-label">Scenario</span>
        {SCENARIOS.map((s) => (
          <button key={s.key} type="button" className={`preset ${sc.key === s.key && b0 === s.b0 && b1 === s.b1 && low === s.low ? 'on' : ''}`} data-tip={s.hint} data-tip-title={s.label} onClick={() => choose(s)}>
            {s.label}
          </button>
        ))}
        <span className="grow" />
        <button type="button" className="btn primary sm" onClick={() => setSeed(seed + 1)} data-tip="Draw a fresh validation sample (and outcomes) with the same settings. Watch how much the threshold moves: that is sampling uncertainty.">
          ↻ Draw a new sample
        </button>
        <SimBadge />
      </div>

      <div className="sim-grid">
        <aside className="controls sim-controls">
          <div className="control-group">
            <div className="field-label has-tip" data-tip="The relationship between score and correctness that, in reality, is unknown. Here you set it, so you can check whether the method recovers it.">
              True species behaviour
            </div>
            <label className="field">
              <span className="small muted">intercept β₀ (accuracy at logit 0 = confidence 0.5): {fmtPct(sigmoid(b0), 0)}</span>
              <Range value={b0} min={-5} max={6} step={0.1} onChange={setB0} format={(v) => fmtNum(v, 3)} />
            </label>
            <label className="field">
              <span className="small muted">slope β (how fast accuracy rises with score)</span>
              <Range value={b1} min={0.1} max={3} step={0.05} onChange={setB1} format={(v) => fmtNum(v, 3)} />
            </label>
            <label className="field">
              <span className="small muted">share of low-score predictions</span>
              <Range value={low} min={0.1} max={0.95} step={0.05} onChange={setLow} format={(v) => fmtPct(v, 0)} />
            </label>
          </div>
          <div className="control-group">
            <div className="field-label has-tip" data-tip="How the clips sent to the ornithologist are chosen (step 4 of the pipeline).">
              Validation sample
            </div>
            <Segmented size="sm" value={design} onChange={setDesign} options={DESIGNS} />
            <label className="field">
              <span className="small muted">clips validated: {n}</span>
              <Range value={n} min={30} max={400} step={10} onChange={setN} format={(v) => String(v)} />
            </label>
          </div>
          <div className="control-group">
            <div className="field-label has-tip" data-tip="The probability a prediction must reach to count as an observation. Natural State uses 0.99.">
              Target pr(correct)
            </div>
            <Segmented
              size="sm"
              value={pStar}
              onChange={setPStar}
              options={['0.9', '0.95', '0.99', '0.999'].map((v) => ({ value: v, label: v, title: v === '0.99' ? 'Natural State’s target' : `p = ${v}` }))}
            />
            <div className="field-label has-tip" data-tip="Which version of the score goes into the regression. The paper recommends the logit score.">
              Regress on
            </div>
            <Segmented
              size="sm"
              value={scale}
              onChange={setScale}
              options={[
                { value: 'logit', label: 'logit score', title: 'Recommended by Wood & Kahl.' },
                { value: 'confidence', label: 'confidence', title: 'The raw 0–1 score, compressed near 1.' },
              ]}
            />
          </div>
        </aside>

        <div className="sim-main">
          <div className="chart-card">
            <Plot data={fig.data} layout={fig.layout} height={400} filename="wood_kahl_simulation" />
          </div>
          <div className="chart-card">
            <div className="sim-hist-title small muted">All {fmtInt(sim.pop.length)} simulated predictions of this species, split by the threshold</div>
            <Plot data={hist.data} layout={hist.layout} height={190} filename="wood_kahl_population" />
          </div>
        </div>

        <aside className="sim-out">
          <Readout
            label={`Threshold for p = ${p}`}
            value={fmtThr(scale === 'logit' ? sim.thrL : sim.thrC, scale === 'logit' ? sim.fitL : sim.fitC, scale === 'logit')}
            sub={(() => {
              const thr = scale === 'logit' ? sim.thrL : sim.thrC
              const fit = scale === 'logit' ? sim.fitL : sim.fitC
              if (!thr || fit.separated) return 'confidence score'
              if (thr.x > (scale === 'logit' ? X_MAX : 1) || thr.x < (scale === 'logit' ? X_MIN : 0.1)) return `fitted ${scale === 'logit' ? 'logit' : 'confidence'} ${fmtNum(thr.x, 3)} — outside the exported range`
              return scale === 'logit'
                ? `confidence · logit ${fmtNum(thr.x, 3)} · 95% CI ${fmtNum(sigmoid(thr.lo), 3)}–${fmtNum(sigmoid(thr.hi), 3)}`
                : `confidence · 95% CI ${fmtNum(thr.lo, 3)}–${fmtNum(thr.hi, 3)}`
            })()}
            tone={(scale === 'logit' ? stL : stC).tone}
          />
          <p className={`sim-status ${(scale === 'logit' ? stL : stC).tone}`}>{(scale === 'logit' ? stL : stC).text}</p>
          <Readout
            label="True threshold"
            value={!Number.isFinite(sim.trueX) || sim.trueX > X_MAX ? 'never reached' : sim.trueX < X_MIN ? 'below 0.1 — all qualify' : fmtNum(sigmoid(sim.trueX), 4)}
            sub="from the true curve — unknowable with real data"
          />
          <Readout label="Fitted model" value={sim.fitL.separated ? '—' : `β₀ ${fmtNum(sim.fitL.b0, 3)} · β ${fmtNum(sim.fitL.b1, 3)}`} sub={`on logit score · ${sim.xs.length} clips · ${sim.ys.filter((y) => y === 0).length} incorrect`} />
          <div className="readout-pair">
            <Readout label="Labelled observations" value={sim.fitL.separated || !sim.thrL ? '—' : fmtPct(sim.kept.length / sim.pop.length, 1)} sub={sim.fitL.separated || !sim.thrL ? '' : `${fmtInt(sim.kept.length)} of ${fmtInt(sim.pop.length)}`} />
            <Readout label="True precision of those" value={Number.isFinite(sim.precisionKept) ? fmtPct(sim.precisionKept, 2) : '—'} sub="≥ p: everything above the threshold is at least that good" tone={sim.precisionKept >= p ? 'ok' : sim.precisionKept ? 'warn' : undefined} />
          </div>
          <Readout label="True detections kept (recall)" value={Number.isFinite(sim.recall) ? fmtPct(sim.recall, 1) : '—'} sub="the price of a strict threshold: real calls left as predictions" />
          <table className="mini-compare">
            <thead>
              <tr>
                <th>Regressing on</th>
                <th>threshold (confidence)</th>
              </tr>
            </thead>
            <tbody>
              <tr className={scale === 'logit' ? 'on' : ''}>
                <td>logit score</td>
                <td>{fmtThr(sim.thrL, sim.fitL, true)}</td>
              </tr>
              <tr className={scale === 'confidence' ? 'on' : ''}>
                <td>confidence</td>
                <td>{fmtThr(sim.thrC, sim.fitC, false)}</td>
              </tr>
            </tbody>
          </table>
        </aside>
      </div>
    </div>
  )
}

// ── page ──────────────────────────────────────────────────────────────────────

export function Methodology({ tokens, onOpen }: { tokens: ThemeTokens; onOpen: OpenView }) {
  const [sc, setSc] = useState<Scenario>(SCENARIOS[0])
  return (
    <div className="summary method">
      <div className="task-card">
        <div className="ds-eyebrow">Challenge 1 · Methodology</div>
        <h1>Wood &amp; Kahl (2024): from BirdNET scores to observations</h1>
        <p>
          <i>Guidelines for appropriate use of BirdNET scores and other detector outputs.</i> Journal of Ornithology.{' '}
          <a href={DOI} target="_blank" rel="noreferrer">
            doi:10.1007/s10336-024-02144-5
          </a>
        </p>
        <p className="task-sub">
          BirdNET’s confidence scores look like probabilities but are not. They are unitless, species-specific, and depend on the recording setup. The paper gives two appropriate ways to use them: review predictions down to a chosen score, or validate a random sample and use logistic regression to turn scores into the probability that a prediction is correct. Natural State uses the second, with p = 0.99.
        </p>
      </div>

      <Block n={1} title="The method, step by step" sub="Click a step. Colours mark who does the work; “Show me” opens the matching view of the challenge data.">
        <Pipeline onOpen={onOpen} />
      </Block>

      <Block n={2} title="What a BirdNET score is (and is not)" sub="BirdNET’s network outputs an unbounded logit score; a sigmoid turns it into a 0–1 confidence. Drag the sliders.">
        <div className="isnot">
          <div>
            <div className="pipe-col-label">Is not</div>
            <ul>
              <li>a probability, nor related to confidence intervals</li>
              <li>comparable between species — the same score can mean very different precision</li>
              <li>transferable between recorders, sample rates, seasons or studies</li>
            </ul>
          </div>
          <div>
            <div className="pipe-col-label">Is</div>
            <ul>
              <li>a unitless expression of the network’s “confidence” in one 3-s segment</li>
              <li>almost always positively related to accuracy (the authors had not seen a species where it is not, across ~1,000)</li>
              <li>with a relationship whose shape differs for every species — so evaluate it species by species</li>
            </ul>
          </div>
        </div>
        <ScoreScale t={tokens} />
      </Block>

      <Block n={3} title="Approach A — use scores as they are: review down to a threshold" sub="Practical with a few species; every kept observation is checked by a person.">
        <ReviewDown t={tokens} sc={sc} />
      </Block>

      <Block
        n={4}
        title="Approach B — convert scores to probabilities (Natural State’s method)"
        sub="Validate a random sample, fit logit(p) = β₀ + β·score, then solve for the score where p reaches the target. Change the true behaviour, the sampling design and the target, and watch what the method recovers."
      >
        <div className="formula-row">
          <code className="formula">logit(p) = ln(p / (1 − p)) = β₀ + β · score</code>
          <span className="formula-arrow">→</span>
          <code className="formula">score* = (ln(p / (1 − p)) − β₀) / β</code>
        </div>
        <Simulator t={tokens} sc={sc} setSc={setSc} />
        <div className="m-notes">
          <div>
            <div className="pipe-col-label">What to look for</div>
            <ul>
              <li>
                <b>Clear transition</b>: the fit recovers the true threshold; “Draw a new sample” shows how much it moves by chance.
              </li>
              <li>
                <b>Random vs Random + high</b>: with mostly low scores, a random sample has few clips where false positives turn into true positives; adding high-score clips narrows the interval.
              </li>
              <li>
                <b>Almost always right</b>: samples often contain no errors → perfect separation → no finite threshold.
              </li>
              <li>
                <b>Rarely right</b>: p = 0.99 may never be reached within the score range → no observations for that species.
              </li>
              <li>
                <b>logit vs confidence</b>: compare the two thresholds in the table. On the compressed 0–1 scale the curve cannot rise steeply enough near 1, so the confidence fit gives a different threshold — sometimes one that is never reached.
              </li>
            </ul>
          </div>
          <div>
            <div className="pipe-col-label">The paper’s R code</div>
            <pre className="code">{`model <- glm(outcome ~ score, family = "binomial",
             data = validation)
p <- 0.9   # desired pr(true positive)
threshold <- (log(p / (1 - p)) - model$coefficients[1]) /
              model$coefficients[2]

# recommended: regress on the logit score
validation$score <- log(validation$confidence /
                        (1 - validation$confidence))`}</pre>
          </div>
        </div>
      </Block>

      <Block n={5} title="Caveats the paper stresses" sub="These shape how the thresholds should be used and maintained on the platform.">
        <div className="caveats">
          {[
            ['Valid only where validated', 'A threshold applies to the conditions its validation data came from. A new season, site, ecoregion, recorder or sample rate may need new validation.'],
            ['Test transferability', 'Add covariates (season, latitude, ecosystem) to the logistic regression and compare models with AIC.'],
            ['Precision vs recall', 'Which matters depends on the use: occupancy models tolerate low recall; call counts and behaviour need high recall. The same p can give very different recall per species.'],
            ['Disclose error rates', 'If not every observation can be checked, report the estimated error. Options: also require detections on ≥ 2 days, or use models that allow false positives.'],
            ['Report the process', 'The numeric threshold is of little use to others; how it was derived (validation, precision, recall, analyst time) is what matters.'],
            ['Use the logit score', 'High confidence values are compressed near 1; logit scores are spread out and better suited to logistic regression.'],
          ].map(([h, b]) => (
            <div key={h} className="caveat">
              <b>{h}</b>
              <p>{b}</p>
            </div>
          ))}
        </div>
      </Block>
    </div>
  )
}

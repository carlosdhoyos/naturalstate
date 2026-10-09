import { useState } from 'react'
import { Block, PAPERS, type PaperMeta } from './shared'

const STAGES = [
  { key: 'calibrate', title: 'Score → probability', sub: 'What does a score mean for this species?', papers: ['wood', 'thompson', 'schwinger'] },
  { key: 'decide', title: 'Probability → decision', sub: 'Which predictions become observations?', papers: ['wood', 'tseng'] },
  { key: 'ecology', title: 'Observations → ecology', sub: 'What do we conclude about birds?', papers: ['navine', 'clare'] },
]

const ROWS: Record<string, { question: string; validation: string; model: string; output: string; us: string }> = {
  wood: { question: 'What score makes a prediction correct with probability ≥ p?', validation: 'Random sample across the score range (+ extra high scores for rare species)', model: 'Logistic regression on the logit score, per species', output: 'Per-species threshold; pr(correct) per prediction', us: 'Required baseline — implement as specified' },
  thompson: { question: 'Can species share information when setting thresholds?', validation: 'Verified predictions across many species', model: 'Generalized linear mixed model', output: 'Species-specific thresholds; community composition', us: 'Extension once many species are validated; with 4 species, justify first' },
  tseng: { question: 'What precision does the kept set reach above a threshold?', validation: 'Stratified: 10 clips per 0.05 confidence class', model: 'Binomial GLM on raw confidence × score distribution', output: 'Precision and retention per threshold; species vs universal', us: 'Different target (set-level precision); use for reporting' },
  schwinger: { question: 'Are classifier scores calibrated, and can a small labelled set fix them?', validation: 'Small labelled calibration set', model: 'Platt scaling (logistic on logit score); ECE, MCS', output: 'Calibration diagnostics; recalibrated scores', us: 'Diagnostics for our curves (other classifiers, not BirdNET)' },
  navine: { question: 'What share of windows contain the call — without a threshold?', validation: 'k per logarithmic quantile bin', model: 'Per-bin Beta, law of total probability, bootstrap', output: 'Call density with CI; site-level strategies', us: 'Different endpoint — candidate for vocal-activity dashboards' },
  clare: { question: 'How do false positives bias ecological estimates, and how to correct them?', validation: 'Site- or observation-confirmation', model: 'Generalized false-positive models (occupancy, abundance, phenology)', output: 'Bias-corrected ecological parameters', us: 'Downstream: keep pr(correct) with each observation' },
}

export function Overview({ onOpen }: { onOpen: (key: string) => void }) {
  const [hover, setHover] = useState<string | null>('wood')
  const meta = (k: string) => PAPERS.find((p) => p.key === k) as PaperMeta
  const sel = hover ? meta(hover) : null
  return (
    <div className="summary method">
      <div className="task-card">
        <div className="ds-eyebrow">Challenge 1 · Methodology</div>
        <h1>How six papers fit together</h1>
        <p className="task-sub">
          The brief requires Wood &amp; Kahl (2024). The other five papers come from a literature search (2026-10-09). They are candidates for discussion — extensions, alternative decision rules, diagnostics, a different endpoint, and downstream modelling — <b>not</b> methods we have substituted for the requested approach. Each tab explains a paper with a flowchart and an interactive schematic on simulated data.
        </p>
      </div>

      <Block n={1} title="Where each paper plugs in" sub="From a BirdNET score to an ecological conclusion. Hover or tap a paper; click to open its tab.">
        <div className="stages">
          {STAGES.map((st, i) => (
            <div key={st.key} className="stage">
              <div className="stage-head">
                <span className="m-num">{i + 1}</span>
                <div>
                  <b>{st.title}</b>
                  <div className="muted small">{st.sub}</div>
                </div>
              </div>
              <div className="stage-papers">
                {st.papers.map((k) => (
                  <button key={k} type="button" className={`paper-chip role-${meta(k).role.replace(' ', '-')} ${hover === k ? 'on' : ''}`} onMouseEnter={() => setHover(k)} onFocus={() => setHover(k)} onClick={() => onOpen(k)}>
                    <b>{meta(k).short}</b>
                    <span>{meta(k).role}</span>
                  </button>
                ))}
              </div>
              {i < STAGES.length - 1 && <span className="stage-arrow" aria-hidden>→</span>}
            </div>
          ))}
        </div>
        <div className="bypass" onMouseEnter={() => setHover('navine')}>
          <span className="bypass-line" />
          <span className="bypass-label">Navine et al. skip stage 2: scores → call density directly, without any threshold</span>
        </div>
        {sel && (
          <div className="stage-detail">
            <span className={`role-badge role-${sel.role.replace(' ', '-')}`}>{sel.role}</span>
            <b>{sel.short}</b> — {sel.oneLine}
            <button type="button" className="btn link sm" onClick={() => onOpen(sel.key)}>
              Open tab →
            </button>
          </div>
        )}
      </Block>

      <Block n={2} title="Side by side">
        <div className="table-wrap auto">
          <table className="data-table sum-table">
            <thead>
              <tr>
                <th>Paper</th>
                <th>Question</th>
                <th>Validation design</th>
                <th>Model</th>
                <th>Output</th>
                <th>For this challenge</th>
                <th className="num has-tip" data-tip="OpenAlex cited_by_count, checked 2026-10-09. Measures uptake, not quality.">
                  Citations
                </th>
              </tr>
            </thead>
            <tbody>
              {PAPERS.map((p) => (
                <tr key={p.key}>
                  <td>
                    <button type="button" className="btn link sm" onClick={() => onOpen(p.key)}>
                      {p.short}
                    </button>
                    <div>
                      <span className={`role-badge sm role-${p.role.replace(' ', '-')}`}>{p.role}</span>
                    </div>
                  </td>
                  <td>{ROWS[p.key].question}</td>
                  <td>{ROWS[p.key].validation}</td>
                  <td>{ROWS[p.key].model}</td>
                  <td>{ROWS[p.key].output}</td>
                  <td>{ROWS[p.key].us}</td>
                  <td className="num">{p.citations}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="muted small">
          Recommendation so far: keep Wood &amp; Kahl as the baseline; add uncertainty intervals, calibration diagnostics and checks for unsupported extrapolation before considering a more complex model. These are methodological recommendations, not claims that the papers establish 99% reliability for this dataset.
        </p>
      </Block>
    </div>
  )
}

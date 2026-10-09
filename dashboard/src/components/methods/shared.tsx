import { useState, type ReactNode } from 'react'

export function Block({ n, title, sub, children }: { n?: number; title: string; sub?: ReactNode; children: ReactNode }) {
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

export function Readout({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: 'ok' | 'warn' }) {
  return (
    <div className={`readout ${tone ?? ''}`}>
      <div className="readout-label">{label}</div>
      <div className="readout-value">{value}</div>
      {sub && <div className="readout-sub">{sub}</div>}
    </div>
  )
}

export const SimBadge = () => (
  <span className="sim-badge" data-tip="This panel uses simulated data so you can explore the method. It does not use the challenge data, and it is not a reproduction of the paper’s results." data-tip-title="Simulated data">
    Simulated data
  </span>
)

export type Lane = 'data' | 'human' | 'model' | 'decision' | 'ecology'
export const LANE_LABEL: Record<Lane, string> = {
  data: 'Data',
  human: 'Human review',
  model: 'Model',
  decision: 'Decision',
  ecology: 'Ecological inference',
}

export interface FlowStep {
  lane: Lane
  title: string
  sub: string
  detail: ReactNode
}

/** Horizontal, clickable flowchart; the selected step's detail is shown underneath. */
export function FlowChart({ steps, initial = 0 }: { steps: FlowStep[]; initial?: number }) {
  const [sel, setSel] = useState(initial)
  const s = steps[sel]
  return (
    <div className="flow">
      <div className="flow-row" role="tablist">
        {steps.map((st, i) => (
          <button key={i} type="button" role="tab" aria-selected={sel === i} className={`flow-node lane-${st.lane} ${sel === i ? 'on' : ''}`} onClick={() => setSel(i)}>
            <span className="flow-lane">{LANE_LABEL[st.lane]}</span>
            <span className="flow-title">
              <span className="flow-n">{i + 1}</span>
              {st.title}
            </span>
            <span className="flow-sub">{st.sub}</span>
          </button>
        ))}
      </div>
      <div className={`flow-detail lane-${s.lane}`} role="tabpanel">
        <div className="flow-detail-head">
          <b>
            {sel + 1}. {s.title}
          </b>
          <span className="grow" />
          <button type="button" className="btn ghost sm" disabled={sel === 0} onClick={() => setSel(sel - 1)}>
            ‹
          </button>
          <button type="button" className="btn ghost sm" disabled={sel === steps.length - 1} onClick={() => setSel(sel + 1)}>
            ›
          </button>
        </div>
        <div className="flow-detail-body">{s.detail}</div>
      </div>
    </div>
  )
}

export interface PaperMeta {
  key: string
  short: string
  title: string
  authors: string
  year: string
  venue: string
  url: string
  citations: string
  role: 'baseline' | 'extension' | 'decision rule' | 'diagnostics' | 'different endpoint' | 'downstream'
  oneLine: string
}

export const PAPERS: PaperMeta[] = [
  {
    key: 'wood',
    short: 'Wood & Kahl 2024',
    title: 'Guidelines for appropriate use of BirdNET scores and other detector outputs',
    authors: 'C. M. Wood, S. Kahl',
    year: '2024',
    venue: 'Journal of Ornithology',
    url: 'https://doi.org/10.1007/s10336-024-02144-5',
    citations: '120',
    role: 'baseline',
    oneLine: 'Validate a random sample, fit logistic regression of outcome on (logit) score, solve for the score where pr(correct) reaches the target.',
  },
  {
    key: 'thompson',
    short: 'Thompson et al. 2025',
    title: 'A post-processing framework for assessing BirdNET identification accuracy and community composition',
    authors: 'Thompson et al.',
    year: '2025 (online 2024)',
    venue: 'Ibis',
    url: 'https://doi.org/10.1111/ibi.13357',
    citations: '13',
    role: 'extension',
    oneLine: 'Generalized linear mixed models give species-specific thresholds; community composition compared with co-located point counts.',
  },
  {
    key: 'tseng',
    short: 'Tseng et al. 2025',
    title: 'Setting BirdNET confidence thresholds: species-specific vs. universal approaches',
    authors: 'S. Tseng, D. P. Hodder, K. A. Otter',
    year: '2025',
    venue: 'Journal of Ornithology',
    url: 'https://doi.org/10.1007/s10336-025-02260-w',
    citations: '16',
    role: 'decision rule',
    oneLine: 'Calibration curve × score distribution → precision of everything kept above a threshold; species-specific thresholds beat a universal 0.7.',
  },
  {
    key: 'schwinger',
    short: 'Schwinger et al. 2025',
    title: 'Uncertainty Calibration of Multi-Label Bird Sound Classifiers',
    authors: 'Schwinger et al.',
    year: '2025 (preprint)',
    venue: 'arXiv 2511.08261',
    url: 'https://arxiv.org/abs/2511.08261',
    citations: '0 indexed',
    role: 'diagnostics',
    oneLine: 'Benchmarks calibration of four bird-sound classifiers (not BirdNET); a small labelled set with Platt scaling markedly improves calibration.',
  },
  {
    key: 'navine',
    short: 'Navine et al. 2024',
    title: 'All Thresholds Barred: Direct Estimation of Call Density in Bioacoustic Data',
    authors: 'Navine et al.',
    year: '2024',
    venue: 'Frontiers in Bird Science (also arXiv)',
    url: 'https://doi.org/10.3389/fbirs.2024.1380636',
    citations: '28',
    role: 'different endpoint',
    oneLine: 'Skip thresholds: validate within score quantile bins and estimate the share of windows that contain the call, with uncertainty.',
  },
  {
    key: 'clare',
    short: 'Clare et al. 2021',
    title: 'Generalized model-based solutions to false-positive error in species detection/nondetection data',
    authors: 'J. D. J. Clare, P. A. Townsend, B. Zuckerberg',
    year: '2021 (online 2020)',
    venue: 'Ecology',
    url: 'https://doi.org/10.1002/ecy.3241',
    citations: '29',
    role: 'downstream',
    oneLine: 'Model false positives inside occupancy, abundance and phenology models; ignoring them biases estimates badly even when they are rare.',
  },
]

export function PaperHeader({ meta, children }: { meta: PaperMeta; children?: ReactNode }) {
  return (
    <div className="task-card paper-card">
      <div className="paper-card-top">
        <span className={`role-badge role-${meta.role.replace(' ', '-')}`}>{meta.role}</span>
        <span className="paper-cites" data-tip="OpenAlex cited_by_count, checked 2026-10-09. Measures uptake, not quality; counts change over time.">
          {meta.citations} citations (OpenAlex)
        </span>
      </div>
      <h1>{meta.title}</h1>
      <p className="paper-ref">
        {meta.authors} · {meta.year} · <i>{meta.venue}</i> ·{' '}
        <a href={meta.url} target="_blank" rel="noreferrer">
          {meta.url.replace('https://', '')}
        </a>
      </p>
      {children && <div className="task-sub">{children}</div>}
    </div>
  )
}

/** "What it means for our challenge" box. */
export function ForUs({ children }: { children: ReactNode }) {
  return (
    <div className="for-us">
      <div className="pipe-col-label">What it means for this challenge</div>
      {children}
    </div>
  )
}

/**
 * Challenge 1 results: species thresholds and observation labels.
 *
 * Everything statistical on this page is precomputed by challenge1/src/run_challenge1.py and
 * embedded at build time from challenge1/outputs/dashboard_results.json, so the page never
 * re-implements the estimators. The one thing it does compute is the published label rule
 * (human verdict, else confidence ≥ species threshold), applied to the embedded predictions CSV,
 * to show that the rule the Tech team will implement reproduces the pipeline's counts exactly.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import results from '../../../challenge1/outputs/dashboard_results.json'
import { axisStyle, baseLayout } from '../charts/build'
import { fmtInt, fmtNum, fmtPct } from '../data/stats'
import type { Dataset } from '../data/types'
import { OTHER, SERIES, type ThemeTokens } from '../lib/palette'
import { FlowChart, type FlowStep } from './methods/shared'
import { Plot } from './Plot'
import { Segmented, Stat } from './ui'

// ── types of the embedded results ────────────────────────────────────────────

type Status = 'accepted' | 'accepted_whole_range' | 'not_reached' | 'slope_not_positive' | 'no_valid_fit' | 'insufficient_validation'
type Est = 'ml' | 'firth' | 'flic'
interface Comparison {
  valid: boolean
  b0: number | null
  b1: number | null
  status: Status
  crossing_conf: number | null
  threshold: number | null
  labelled: number
  mean_fitted_p: number | null
}
interface Boot {
  cluster: string
  n_clusters: number
  share_with_threshold: number
  status_shares: Record<string, number>
  threshold_ci: [number, number] | null
  labelled_q: [number, number, number]
  thresholds: (number | null)[]
  counts: number[]
}
interface RecorderCheck {
  recorder: string
  validated_clips: number
  correct: number
  tested: boolean
  expected_correct_loro: number | null
  p_value: number | null
  flagged: boolean
  bonferroni_alpha: number
}
interface CovModel {
  model: string
  k: number
  loglik: number
  aic: number | null
  delta_aic: number | null
  coefficients: string
  recorder_sd: number
  valid: boolean
  identified: boolean
  crossing_typical_recorder: number | null
  crossing_new_recorder: number | null
  notes: string | null
}
interface Band {
  band: string
  clips?: number
  correct?: number
  observed_share_correct?: number
  wilson_lo?: number
  wilson_hi?: number
  mean_fitted_p?: number | null
  validated_clips?: number
  validated_share?: number | null
  predictions?: number
  prediction_share?: number | null
}
interface SpeciesResult {
  species: string
  validated_clips: number
  correct: number
  incorrect: number
  gate_k: number
  gate_passed: boolean
  gate_reason: string | null
  status: Status
  status_text: string
  method: Est | null
  method_reason: string | null
  b0: number | null
  b1: number | null
  b1_se: number | null
  validated_conf_min: number
  validated_conf_max: number
  crossing_conf: number | null
  threshold: number | null
  predictions: number
  model_labelled: number
  expected_precision_model_labelled: number | null
  observed_precision: number
  observed_precision_wilson_lo: number
  observed_precision_wilson_hi: number
  validated_above_threshold?: number | null
  validated_above_threshold_correct?: number | null
  validated_above_wilson_lo?: number | null
  delta_ci_lo: number | null
  delta_ci_hi: number | null
  set_level_threshold: number | null
  set_level_labelled: number
  review_flagged_recorders: string | null
  comparison: Partial<Record<Est, Comparison>>
  bootstrap: Partial<Record<'recorder' | 'audio_file', Boot>>
  clips: { conf: number[]; outcome: number[]; recorder: string[]; link: string[] }
  curves: Record<Est, number[] | null>
  prediction_hist: number[]
  recorders: RecorderCheck[]
  calibration: Band[]
  sampling: Band[]
  covariates: CovModel[]
  covariate_crosstab: Record<string, { correct: number; incorrect: number }>
}
interface SensRow {
  group: string
  variant: string
  species: string
  validated_clips: number
  incorrect: number
  status: Status
  gate_reason: string | null
  method: string | null
  threshold: number | null
  model_labelled: number
}
interface Results {
  config: Record<string, unknown> & { target: number; min_each_outcome: number; eps: number; n_boot: number; seed: number; review_alpha: number; review_min_clips: number }
  inputs: Record<string, string>
  summary: {
    predictions: number
    validation_clips_raw: number
    validation_clips_after_dedup: number
    dropped_duplicates: number
    validation_links: Record<string, number>
    observations: number
    observations_by_source: Record<string, number>
    observation_status_counts: Record<string, number>
    model_observations: number
    review_flagged_rows: number
    review_flagged_model_observations: number
  }
  grid_logit: number[]
  prediction_hist_edges: number[]
  status_text: Record<string, string>
  reason_text: Record<string, string>
  species: SpeciesResult[]
  sensitivity: SensRow[]
  validated_rows: { row: number[]; outcome: string[] }
  review_flagged: Record<string, string[]>
}
const R = results as unknown as Results

// ── helpers ──────────────────────────────────────────────────────────────────

const EPS = R.config.eps
const logit = (c: number) => {
  const v = Math.min(Math.max(c, EPS), 1 - EPS)
  return Math.log(v / (1 - v))
}
const TICKS = [0.1, 0.25, 0.5, 0.75, 0.9, 0.97, 0.99, 0.999]
const EST_NAME: Record<Est, string> = { ml: 'Ordinary ML', firth: 'Firth', flic: 'FLIC' }
const EST_TIP: Record<Est, string> = {
  ml: 'Ordinary maximum-likelihood logistic regression: exactly the paper’s glm(outcome ~ score, family = binomial). The primary estimator.',
  firth: 'Firth’s penalised likelihood (Jeffreys prior). Finite even when the data are separated, so it is the fallback in that case. It reduces bias in the coefficients but pulls predicted probabilities toward 0.5 when one outcome is rare — as if one extra error and one extra correct clip had been observed.',
  flic: 'FLIC (Puhr et al. 2017): Firth’s slope, with the intercept re-estimated so the mean fitted probability equals the observed share correct. Shown only to illustrate how much a threshold depends on the estimator when errors are rare.',
}
const STATUS_LABEL: Record<Status, string> = {
  accepted: 'Threshold accepted',
  accepted_whole_range: 'Accepted (whole range)',
  not_reached: '99% not reached',
  slope_not_positive: 'Slope not positive',
  no_valid_fit: 'No valid fit',
  insufficient_validation: 'Insufficient validation',
}
/** Fixed decimals (fmtNum uses significant digits, right for thresholds but not for counts). */
const dec = (v: number | null | undefined, d: number) => (v == null || !Number.isFinite(v) ? '—' : v.toFixed(d))
const short = (sp: string) => sp.split(' ').slice(-1)[0]
const hasThr = (s: Status) => s === 'accepted' || s === 'accepted_whole_range'

function StatusPill({ s }: { s: Status }) {
  const cls = hasThr(s) ? 'qa-pass' : s === 'insufficient_validation' ? 'qa-flag' : 'qa-info'
  return (
    <span className={`qa-chip ${cls}`} data-tip={R.status_text[s]} data-tip-title={STATUS_LABEL[s]}>
      {hasThr(s) ? '✓ ' : s === 'insufficient_validation' ? '⚑ ' : 'ℹ '}
      {STATUS_LABEL[s]}
    </span>
  )
}

function Section({ title, sub, children, right }: { title: string; sub?: ReactNode; children: ReactNode; right?: ReactNode }) {
  return (
    <section className="sum-section">
      <div className="sum-section-head">
        <div>
          <h2>{title}</h2>
          {sub && <p className="muted">{sub}</p>}
        </div>
        {right}
      </div>
      {children}
    </section>
  )
}

const Note = ({ label = 'What it shows', children }: { label?: string; children: ReactNode }) => (
  <div className="for-us">
    <div className="pipe-col-label">{label}</div>
    {children}
  </div>
)

const Tip = ({ tip, title, children }: { tip: string; title?: string; children: ReactNode }) => (
  <span className="has-tip" data-tip={tip} data-tip-title={title}>
    {children}
  </span>
)

function logitAxis(t: ThemeTokens, title = 'BirdNET confidence (logit scale)') {
  return { ...axisStyle(t), title: { text: title }, tickvals: TICKS.map(logit), ticktext: TICKS.map(String), range: [logit(0.1) - 0.3, logit(0.9999)] }
}

// ── label rule reproduced in the browser ─────────────────────────────────────

interface Reproduced {
  observations: number
  model: number
  validated: number
  byStatus: Record<string, number>
  matches: boolean
}

/** The published rule, applied to the embedded predictions CSV (row order = file order). */
function reproduce(pred: Dataset | undefined): Reproduced | null {
  if (!pred) return null
  const thr = new Map(R.species.map((s) => [s.species, s.threshold]))
  const human = new Map(R.validated_rows.row.map((r, i) => [r, R.validated_rows.outcome[i]]))
  let model = 0
  let validated = 0
  const byStatus: Record<string, number> = {}
  pred.rows.forEach((row, i) => {
    const sp = String(row.common_name)
    const conf = Number(row.confidence)
    const t = thr.get(sp)
    const isModel = t != null && conf >= t
    const h = human.get(i)
    const status = h === 'correct' ? 'validated_correct' : h === 'incorrect' ? 'validated_incorrect' : isModel ? 'model_observation' : t != null ? 'below_threshold' : 'no_species_threshold'
    byStatus[status] = (byStatus[status] ?? 0) + 1
    if (h === 'correct') validated++
    else if (!h && isModel) model++
  })
  const s = R.summary
  const matches =
    model + validated === s.observations &&
    model === (s.observations_by_source.model ?? 0) &&
    validated === (s.observations_by_source.validated ?? 0) &&
    Object.entries(s.observation_status_counts).every(([k, v]) => byStatus[k] === v)
  return { observations: model + validated, model, validated, byStatus, matches }
}

// ── page ─────────────────────────────────────────────────────────────────────

type Tab = 'results' | 'curves' | 'uncertainty' | 'gate' | 'recorders' | 'sensitivity' | 'sampling' | 'paper' | 'discussion'
const TABS: { key: Tab; label: string; sub: string }[] = [
  { key: 'results', label: 'Results', sub: 'labels · rule' },
  { key: 'curves', label: 'Species curves', sub: 'fit · threshold' },
  { key: 'uncertainty', label: 'Uncertainty', sub: 'bootstrap' },
  { key: 'gate', label: 'Evidence gate & estimators', sub: 'why 0 or 1 error is not enough' },
  { key: 'recorders', label: 'Recorders', sub: 'review flags' },
  { key: 'sensitivity', label: 'Sensitivity', sub: '14 variants' },
  { key: 'sampling', label: 'Validation design', sub: 'score bands' },
  { key: 'paper', label: 'Wood & Kahl alignment', sub: 'what we kept, extended' },
  { key: 'discussion', label: 'Discussion & conclusions', sub: 'other papers · take-aways' },
]

/** The tab named in a URL like #/thresholds:birds/curves, or null. */
function tabFromHash(hash: string): Tab | null {
  const [, page, want] = hash.split('/')
  return page === 'thresholds:birds' && TABS.some((x) => x.key === want) ? (want as Tab) : null
}
/** Captured at load too: on first load the data are parsed before this page mounts. */
let LINKED_TAB: Tab | null = tabFromHash(window.location.hash)

export function BirdsThresholds({ reg, tokens: t }: { reg: Map<string, Dataset>; tokens: ThemeTokens }) {
  // a deep link like #/thresholds:birds/curves opens that tab (read once, see LINKED_TAB)
  const [tab, setTabState] = useState<Tab>(() => {
    // the current URL wins (cross-page links, re-entry); the load-time capture covers the first load
    const want = tabFromHash(window.location.hash) ?? LINKED_TAB
    LINKED_TAB = null
    return want ?? 'results'
  })
  const setTab = (next: Tab) => {
    setTabState(next)
    window.history.replaceState(null, '', `#/thresholds:birds/${next}`) // keep the URL shareable
  }
  // follow later URL changes too (a pasted link or the back button while the page is open)
  useEffect(() => {
    const on = () => {
      const want = tabFromHash(window.location.hash)
      if (want) setTabState(want)
    }
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])
  const [sp, setSp] = useState(R.species.find((s) => s.status === 'accepted')?.species ?? R.species[0].species)
  const repro = useMemo(() => reproduce(reg.get('birdnet_predictions')), [reg])
  const ctx = { t, sp, setSp, repro }
  return (
    <div className="summary">
      <div className="task-card">
        <div className="ds-eyebrow">Challenge 1 · Thresholds &amp; observations</div>
        <h1>Which predictions are observations?</h1>
        <p className="task-sub">
          For each species, a logistic regression of the ornithologist’s verdict on the logit of the BirdNET confidence (Wood &amp; Kahl 2024) gives the probability that a prediction is correct. A prediction becomes an observation when that probability is at least {fmtPct(R.config.target, 0)} — but only where the validation data can actually locate that point. Human verdicts are kept as labels for the clips they cover. Every number here comes from <code>challenge1/src/run_challenge1.py</code>; the decisions behind it are logged in <code>docs/challenge1_data_decisions.md</code>.
        </p>
      </div>
      <div className="paper-tabs" role="tablist" aria-label="Threshold views">
        {TABS.map((x) => (
          <button key={x.key} type="button" role="tab" aria-selected={tab === x.key} className={`paper-tab ${tab === x.key ? 'on' : ''}`} onClick={() => setTab(x.key)}>
            <span>{x.label}</span>
            <span className="role-dot">{x.sub}</span>
          </button>
        ))}
      </div>
      {tab === 'results' && <ResultsTab {...ctx} />}
      {tab === 'curves' && <CurvesTab {...ctx} />}
      {tab === 'uncertainty' && <UncertaintyTab {...ctx} />}
      {tab === 'gate' && <GateTab {...ctx} />}
      {tab === 'recorders' && <RecordersTab {...ctx} />}
      {tab === 'sensitivity' && <SensitivityTab />}
      {tab === 'sampling' && <SamplingTab {...ctx} />}
      {tab === 'paper' && <PaperTab />}
      {tab === 'discussion' && <DiscussionTab />}
    </div>
  )
}

interface Ctx {
  t: ThemeTokens
  sp: string
  setSp: (s: string) => void
  repro: Reproduced | null
}

function SpeciesPicker({ sp, setSp, only }: { sp: string; setSp: (s: string) => void; only?: (s: SpeciesResult) => boolean }) {
  const opts = R.species.filter(only ?? (() => true))
  const value = opts.some((o) => o.species === sp) ? sp : opts[0]?.species
  return <Segmented value={value} onChange={setSp} options={opts.map((s) => ({ value: s.species, label: short(s.species), title: `${s.species}: ${STATUS_LABEL[s.status]}` }))} />
}

// ── tab: results ─────────────────────────────────────────────────────────────

const FLOW: FlowStep[] = [
  {
    lane: 'data',
    title: 'Link & de-duplicate',
    sub: '551 → 547 validated clips',
    detail: (
      <>
        <p>
          Each validated clip is matched to the prediction it came from: same species, recorder, date and hour, and a score equal up to the 3-decimal rounding in the validation file name (D-02). {R.summary.validation_links.unique} clips link to exactly one prediction, {R.summary.validation_links.tied} tie with another prediction of the same rounded score, {R.summary.validation_links.none ?? 0} are not found.
        </p>
        <p>Four Plover clip pairs point to the same single segment — the same audio validated twice — so one clip of each pair is dropped before fitting (D-01).</p>
      </>
    ),
  },
  {
    lane: 'decision',
    title: 'Evidence gate',
    sub: `≥ ${R.config.min_each_outcome} correct and ≥ ${R.config.min_each_outcome} incorrect`,
    detail: (
      <>
        <p>
          The 99% point sits where errors become rare, so its location is learned from errors. A species needs at least {R.config.min_each_outcome} correct <b>and</b> {R.config.min_each_outcome} incorrect validated clips; otherwise it is reported as <b>insufficient validation</b> and gets no model-based labels (D-09).
        </p>
        <p>With 0 errors the slope of the curve is not identified at all (Oriole). With 1 error, three defensible estimators put the Plover’s threshold anywhere from 0.16 to 0.85. Wood &amp; Kahl do not discuss this case; the gate is our extension.</p>
      </>
    ),
  },
  {
    lane: 'model',
    title: 'Fit the curve',
    sub: 'glm(outcome ~ logit(score))',
    detail: (
      <>
        <p>
          logit p = β₀ + β₁ · logit(confidence), fitted by ordinary maximum likelihood — the paper’s own recipe. Scores of exactly 1 are clamped to 1 − 10⁻⁴ so the logit stays finite (immaterial: the threshold changes in the 8th decimal). If the data are separated (no finite ML estimate), Firth’s penalised fit is the fallback.
        </p>
      </>
    ),
  },
  {
    lane: 'decision',
    title: 'Accept the 99% point',
    sub: 'inside the validated range',
    detail: (
      <>
        <p>
          t = (ln(0.99/0.01) − β₀) / β₁ is the 99% point on the logit scale; the confidence threshold is its inverse logit, 1 / (1 + e^−t). It is accepted only if the fit is valid, the curve increases with the score, and the point lies inside the range of validated scores. If 99% is reached only above the highest validated score, there is <b>no supported threshold</b> (Firefinch). If the curve is already above 99% at the lowest validated score, the threshold is that score — never an extrapolation below it.
        </p>
        <p>The exported threshold is rounded up to 6 decimals and labels use exactly that value.</p>
      </>
    ),
  },
  {
    lane: 'human',
    title: 'Label every row',
    sub: 'human verdict, else threshold',
    detail: (
      <>
        <p>
          A prediction with a uniquely linked validated clip takes the ornithologist’s verdict (correct → observation; incorrect → not). Every other prediction is an observation when its confidence ≥ the species threshold (D-10). Predictions of species without a supported threshold are not observations unless a human confirmed them.
        </p>
      </>
    ),
  },
  {
    lane: 'ecology',
    title: 'Flag for review',
    sub: 'recorders off the pooled curve',
    detail: (
      <>
        <p>
          For each species with a fitted curve, each recorder with ≥ {R.config.review_min_clips} validated clips is compared with a curve fitted <i>without</i> it. If it has far fewer correct clips than expected (exact Poisson-binomial test, Bonferroni at {R.config.review_alpha}), its predictions are flagged for human review (D-11). The flag never changes a label.
        </p>
      </>
    ),
  },
]

function ResultsTab({ repro }: Ctx) {
  const s = R.summary
  const obsBySpecies = (sp: string) => {
    const r = R.species.find((x) => x.species === sp)!
    return r
  }
  return (
    <>
      <div className="stats-row">
        <Stat label="Predictions labelled" value={fmtInt(s.predictions)} sub="every row gets an observation value" />
        <Stat label="Observations" value={fmtInt(s.observations)} sub={`${fmtInt(s.observations_by_source.model ?? 0)} from a threshold · ${fmtInt(s.observations_by_source.validated ?? 0)} human-confirmed`} />
        <Stat label="Species with a threshold" value={`${R.species.filter((x) => hasThr(x.status)).length} of ${R.species.length}`} sub="the others need more validation" />
        <Stat label="Flagged for review" value={fmtInt(s.review_flagged_rows)} sub={`${fmtInt(s.review_flagged_model_observations)} of them above the threshold`} />
      </div>

      <Section title="Species results" sub="One card per species. Hover a status for its definition. “Observations” counts the final labels: threshold-based plus human-confirmed.">
        <div className="sum-grid thr-cards">
          {R.species.map((r) => {
            const sum = obsBySpecies(r.species)
            const validatedObs = r.clips.link.filter((l, i) => l === 'unique' && r.clips.outcome[i] === 1).length
            return (
              <div key={r.species} className={`thr-card thr-${r.status}`}>
                <div className="thr-card-top">
                  <h3>{r.species}</h3>
                  <StatusPill s={r.status} />
                </div>
                <div className="thr-big">
                  {r.threshold != null ? (
                    <Tip tip="Operative confidence threshold: predictions scoring at or above it are observations. Rounded up to 6 decimals; labels use exactly this value." title="Species threshold">
                      ≥ {fmtNum(r.threshold, 4)}
                    </Tip>
                  ) : (
                    <span className="muted">no threshold</span>
                  )}
                </div>
                <p className="small">{r.gate_reason ? R.reason_text[r.gate_reason] : r.status_text.split(': ').slice(1).join(': ')}</p>
                <table className="data-table compact">
                  <tbody>
                    <tr>
                      <td className="muted">Validated clips</td>
                      <td>
                        {r.correct} correct · {r.incorrect} incorrect
                      </td>
                    </tr>
                    <tr>
                      <td className="muted">Predictions</td>
                      <td>{fmtInt(r.predictions)}</td>
                    </tr>
                    <tr>
                      <td className="muted">
                        <Tip tip="Predictions at or above the species threshold, before human verdicts are applied.">Above threshold</Tip>
                      </td>
                      <td>
                        {fmtInt(sum.model_labelled)} ({fmtPct(sum.model_labelled / r.predictions)})
                      </td>
                    </tr>
                    <tr>
                      <td className="muted">
                        <Tip tip="Validated clips that link to exactly one prediction and were judged correct. They are observations whatever the threshold says.">Human-confirmed</Tip>
                      </td>
                      <td>{fmtInt(validatedObs)}</td>
                    </tr>
                    {r.expected_precision_model_labelled != null && (
                      <tr>
                        <td className="muted">
                          <Tip tip="Mean fitted probability of the predictions above the threshold. Model-based, not an observed rate.">Expected precision</Tip>
                        </td>
                        <td>{fmtPct(r.expected_precision_model_labelled, 2)}</td>
                      </tr>
                    )}
                    {r.review_flagged_recorders && (
                      <tr>
                        <td className="muted">Review flags</td>
                        <td>{r.review_flagged_recorders.replace(';', ', ')}</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            )
          })}
        </div>
      </Section>

      <Section title="How a prediction becomes an observation" sub="Click a step for the detail. Colours mark who does what: data handling, decisions, the model, human review, ecological checks.">
        <FlowChart steps={FLOW} initial={1} />
      </Section>

      <Section title="Labels in the output file" sub={<>Counts of <code>observation_status</code> in <code>challenge1/outputs/birdnet_predictions_with_observations.csv</code>, and an independent re-application of the published rule to the predictions embedded in this page.</>}>
        <div className="table-wrap auto">
          <table className="data-table sum-table">
            <thead>
              <tr>
                <th>observation_status</th>
                <th>Meaning</th>
                <th className="num">Pipeline</th>
                <th className="num">Re-applied here</th>
              </tr>
            </thead>
            <tbody>
              {(
                [
                  ['validated_correct', 'A human confirmed this prediction: observation.'],
                  ['validated_incorrect', 'A human rejected this prediction: not an observation, whatever its score.'],
                  ['model_observation', 'Confidence ≥ species threshold, no human verdict: observation.'],
                  ['below_threshold', 'Species has a threshold; this prediction is below it.'],
                  ['no_species_threshold', 'Species has no supported threshold (insufficient validation or 99% not reached).'],
                ] as const
              ).map(([k, m]) => (
                <tr key={k}>
                  <td>
                    <code>{k}</code>
                  </td>
                  <td className="small">{m}</td>
                  <td className="num">{fmtInt(s.observation_status_counts[k] ?? 0)}</td>
                  <td className="num">{repro ? fmtInt(repro.byStatus[k] ?? 0) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {repro && (
          <p className="small">
            <span className={`qa-chip ${repro.matches ? 'qa-pass' : 'qa-flag'}`}>{repro.matches ? '✓ reproduced' : '⚑ mismatch'}</span>{' '}
            Applying “human verdict, else confidence ≥ species threshold” to the {fmtInt(s.predictions)} embedded predictions gives {fmtInt(repro.observations)} observations ({fmtInt(repro.model)} from a threshold, {fmtInt(repro.validated)} human-confirmed){repro.matches ? ' — identical to the pipeline, so the rule handed to the Tech team is complete.' : ' — this differs from the pipeline and needs investigating.'}
          </p>
        )}
      </Section>

      <Note label="Reading the results">
        <ul>
          <li>
            <b>Only the Nightjar gets a threshold.</b> Its curve rests on 33 errors and 117 correct clips; every one of the 74 validated clips at or above 0.6666 is correct (Wilson 95% lower bound 95%). The 99% itself comes from the logistic shape, which the validation supports directly only to about 95%.
          </li>
          <li>
            <b>The Oriole and Plover are not “bad” species — they are under-tested for this question.</b> Nearly every validated clip was correct (150/150 and 145/146), but a 99% threshold is located by errors, and there are none (Oriole) or one (Plover). Their 132 + 137 human-confirmed clips are kept as observations.
          </li>
          <li>
            <b>The Firefinch is the opposite case:</b> 95 of 101 validated clips are wrong and the curve reaches 99% only above every score observed. No prediction can be trusted automatically.
          </li>
          <li>
            Observations are <b>high-precision, low-recall</b>: they are meant to be trusted, not to count every vocalisation. A missing observation does not mean a species was absent.
          </li>
        </ul>
      </Note>

      <DeployablePackage />

      <ConfirmationItems />
    </>
  )
}

// ── confirmation items (same IDs and wording as challenge1/Q1_report.md, section 9) ──

const CONFIRMATIONS: { id: string; item: string; assumed: string; ifNot: string }[] = [
  { id: 'C-1', item: 'How validation clips were sampled (random within score bands? high-score top-up? with replacement?)', assumed: 'Random within score bands with a high-score top-up (fits the data, D-12); duplicates are accidental re-draws (D-01)', ifNot: 'Selection on anything but score could bias the curves; refit with the real design' },
  { id: 'C-2', item: 'BirdNET run settings: version, minimum score, sensitivity', assumed: 'v2.4, minimum 0.1, default sensitivity', ifNot: 'Sensitivity does not change confidence-scale thresholds; other versions or settings need their own calibration' },
  { id: 'C-3', item: 'Recorder clocks: RBS40 and RBS71 on UTC (≈ 3 h behind)', assumed: 'Inferred from bird activity (D-03); used only in the time-of-day test', ifNot: 'Labels unaffected; only the evening covariate (D-13) changes' },
  { id: 'C-4', item: 'What the wrong Nightjar detections at RBS75/RBS79 are', assumed: 'Site-specific false positives; flagged for review, not removed', ifNot: 'If another species calls there, treat the 9 flagged observations as unconfirmed until validated' },
  { id: 'C-5', item: 'Meaning of “99%”: per prediction or set-level precision', assumed: 'Per prediction (Wood & Kahl): Nightjar 0.666639, 3,147 labels', ifNot: 'Set-level: 0.4316, 4,355 labels (already computed)' },
  { id: 'C-6', item: 'How the two exports name the same audio (hour rounding, clip index)', assumed: 'Linked on species + recorder + date + hour + score: 476 unique, 69 tied, 2 not found (D-02)', ifNot: 'A few verdicts could attach to the wrong prediction; a stable prediction id removes the issue' },
  { id: 'C-7', item: 'Outcome coding: 1 = BirdNET was right', assumed: 'As stated; consistent with the data (share correct rises with score)', ifNot: 'Everything would invert (sanity check)' },
]

// ── the deployable package and what has been verified (same table as Q2 section 9 and the package README) ──

const VERIFICATION: { part: string; status: 'verified' | 'written' | 'stub' | 'not run'; evidence: string }[] = [
  { part: 'Decision rules, label rule, threshold-set artifact, CLI', status: 'verified', evidence: '50 package tests, including an end-to-end acceptance test on the take-home data. The CLI’s labelled file is byte-identical to the research pipeline’s, and so is its threshold set when run with --diagnostics (without it: same id and decisions).' },
  { part: 'Packaging (wheel, entry point, bundled schemas)', status: 'verified', evidence: 'The wheel was built and installed into a fresh Python 3.13 environment; the ns-observations run command gave byte-identical output, with the same threshold-set id.' },
  { part: 'Docker image', status: 'written', evidence: 'Not built: the Docker daemon was not running on the development machine. It installs the same package; check with: docker build -t ns-observations:1.0.0 challenge1/ns_observations' },
  { part: 'PostgreSQL adapter (io_postgres.py, sql/schema.sql)', status: 'stub', evidence: 'The SQL and functions match the handover’s tables, including configuration scoping, the label upsert with an append-only history, and the immutability triggers; calls are checked with a fake connection, but neither the SQL nor the triggers have run against a database. Before production: a staging database and integration tests.' },
  { part: 'R cross-check snippet (handover)', status: 'not run', evidence: 'R is not installed on the development machine. The expected value 0.6666381 was confirmed with statsmodels’ binomial GLM, the same estimator as R’s glm.' },
]

function DeployablePackage() {
  return (
    <Section
      title="For the Tech team: the deployable package"
      sub={
        <>
          <code>challenge1/ns_observations/</code> is an installable Python 3.13 package. <code>ns-observations calibrate</code> turns validations into a versioned, schema-checked threshold set; <code>ns-observations label</code> applies it to predictions, with no fitting. It ships with a CSV adapter, a PostgreSQL adapter stub, a Dockerfile and 50 tests. The research analysis behind this page imports the same decision rules, so the two cannot drift apart. Details: <code>challenge1/Q2_tech_handover.md</code>.
        </>
      }
    >
      <div className="table-wrap auto">
        <table className="data-table sum-table qa-table">
          <thead>
            <tr>
              <th>Part</th>
              <th>Status</th>
              <th>Evidence / how to check</th>
            </tr>
          </thead>
          <tbody>
            {VERIFICATION.map((v) => (
              <tr key={v.part}>
                <td>
                  <b>{v.part}</b>
                </td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  <span className={`qa-chip ${v.status === 'verified' ? 'qa-pass' : 'qa-info'}`}>{v.status === 'verified' ? '✓ verified' : v.status === 'written' ? 'written, not built' : v.status === 'stub' ? 'stub' : 'not run'}</span>
                </td>
                <td className="small">{v.evidence}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted small">None of the unverified parts affects the labels or thresholds on this page; each should be checked once on the platform side.</p>
    </Section>
  )
}

function ConfirmationItems() {
  return (
    <Section title="Confirmation items for Natural State" sub="Assumptions the analysis runs on. None blocks the result; each has the working assumption used today and what would change if Natural State confirms otherwise. All are to confirm. Same list as the Q1 report, section 9.">
      <div className="table-wrap auto">
        <table className="data-table sum-table qa-table">
          <thead>
            <tr>
              <th>ID</th>
              <th>To confirm</th>
              <th>Working assumption</th>
              <th>If different</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {CONFIRMATIONS.map((c) => (
              <tr key={c.id}>
                <td style={{ whiteSpace: 'nowrap' }}>
                  <b>{c.id}</b>
                </td>
                <td>{c.item}</td>
                <td className="small">{c.assumed}</td>
                <td className="small muted">{c.ifNot}</td>
                <td>
                  <span className="qa-chip qa-info">to confirm</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Section>
  )
}

// ── tab: species curves ──────────────────────────────────────────────────────

function CurvesTab({ t, sp, setSp }: Ctx) {
  const [zoom, setZoom] = useState<'full' | 'zoom'>('full')
  const r = R.species.find((x) => x.species === sp)!
  const series = SERIES[t.theme]
  const estColor: Record<Est, string> = { ml: t.theme === 'dark' ? '#e7eef2' : '#00354d', firth: series[5], flic: series[2] }

  const fig = useMemo(() => {
    const vx = r.clips.conf.map(logit)
    // deterministic inward jitter so points stay inside [0, 1]
    const jit = r.clips.conf.map((_, i) => ((Math.sin(i * 12.9898) * 43758.5453) % 1 + 1) % 1 * 0.05)
    const data: object[] = []
    for (const k of ['ml', 'firth', 'flic'] as Est[]) {
      const c = r.curves[k]
      if (!c) continue
      const primary = r.method === k
      const role = primary ? 'primary' : r.gate_passed ? 'comparison' : 'information only (gate not passed)'
      data.push({
        type: 'scatter',
        mode: 'lines',
        x: R.grid_logit,
        y: c,
        name: `${EST_NAME[k]} — ${role}`,
        line: { color: estColor[k], width: primary ? 3.2 : 1.6, dash: primary ? 'solid' : 'dash' },
        hovertemplate: `${EST_NAME[k]}: p = %{y:.4f}<extra></extra>`,
      })
    }
    const pts = (o: number, name: string, color: string, symbol: string) => {
      const idx = r.clips.outcome.map((v, i) => (v === o ? i : -1)).filter((i) => i >= 0)
      return {
        type: 'scatter',
        mode: 'markers',
        name,
        x: idx.map((i) => vx[i]),
        y: idx.map((i) => (o === 1 ? 1 - jit[i] : jit[i])),
        marker: { color, size: o ? 6 : 8, symbol, opacity: 0.7, line: { color: t.surface, width: 0.5 } },
        text: idx.map((i) => `score ${r.clips.conf[i].toFixed(3)} · ${r.clips.recorder[i]} · link: ${r.clips.link[i]}`),
        hovertemplate: '%{text}<extra>' + name + '</extra>',
      }
    }
    if (zoom === 'full') {
      data.push(pts(1, 'validated: correct', series[0], 'circle'))
      data.push(pts(0, 'validated: incorrect', series[1], 'x'))
    }
    const shapes: object[] = [
      { type: 'rect', xref: 'x', yref: 'paper', x0: logit(r.validated_conf_min), x1: logit(r.validated_conf_max), y0: 0, y1: 1, fillcolor: OTHER[t.theme], opacity: 0.12, line: { width: 0 }, layer: 'below' },
      { type: 'line', xref: 'paper', x0: 0, x1: 1, y0: R.config.target, y1: R.config.target, line: { color: t.muted, width: 1, dash: 'dot' } },
    ]
    const ci = r.bootstrap.recorder?.threshold_ci
    if (ci) shapes.push({ type: 'rect', xref: 'x', yref: 'paper', x0: logit(ci[0]), x1: logit(ci[1]), y0: 0, y1: 1, fillcolor: series[2], opacity: 0.12, line: { width: 0 }, layer: 'below' })
    if (r.threshold != null) shapes.push({ type: 'line', xref: 'x', yref: 'paper', x0: logit(r.threshold), x1: logit(r.threshold), y0: 0, y1: 1, line: { color: series[0], width: 2.5 } })
    const ann: object[] = [
      { x: logit(r.validated_conf_min), y: 1.02, xref: 'x', yref: 'paper', xanchor: 'left', showarrow: false, text: 'validated score range', font: { size: 10, color: t.muted } },
      { x: 1, xref: 'paper', y: R.config.target, xanchor: 'right', yanchor: 'bottom', showarrow: false, text: `target ${R.config.target}`, font: { size: 10, color: t.muted } },
    ]
    if (r.threshold != null) ann.push({ x: logit(r.threshold), y: zoom === 'zoom' ? 0.955 : 0.45, xanchor: 'left', showarrow: false, text: ` threshold ${fmtNum(r.threshold, 4)}`, font: { size: 11, color: series[0] } })
    if (ci) ann.push({ x: logit(ci[1]), y: zoom === 'zoom' ? 0.97 : 0.3, xanchor: 'left', showarrow: false, text: ` 95% interval (recorder bootstrap)`, font: { size: 10, color: series[2] } })
    return {
      data,
      layout: {
        ...baseLayout(t),
        margin: { l: 60, r: 20, t: 54, b: 52 },
        xaxis: logitAxis(t),
        yaxis: { ...axisStyle(t), title: { text: 'pr(prediction is correct)' }, range: zoom === 'zoom' ? [0.95, 1.0005] : [-0.03, 1.03] },
        shapes,
        annotations: ann,
      },
    }
  }, [r, t, zoom, series, estColor])

  const hist = useMemo(() => {
    const e = R.prediction_hist_edges
    const mids = r.prediction_hist.map((_, i) => (e[i] + e[i + 1]) / 2)
    const lab = mids.map((_, i) => r.threshold != null && e[i] >= r.threshold)
    return {
      data: [
        { type: 'bar', x: mids, y: r.prediction_hist.map((v, i) => (lab[i] ? 0 : v)), name: 'below threshold / no threshold', marker: { color: OTHER[t.theme] }, width: e[1] - e[0], hovertemplate: '%{x:.2f}: %{y} predictions<extra></extra>' },
        { type: 'bar', x: mids, y: r.prediction_hist.map((v, i) => (lab[i] ? v : 0)), name: 'above threshold', marker: { color: series[0] }, width: e[1] - e[0], hovertemplate: '%{x:.2f}: %{y} predictions<extra></extra>' },
      ],
      layout: {
        ...baseLayout(t),
        barmode: 'stack',
        margin: { l: 56, r: 16, t: 36, b: 44 },
        xaxis: { ...axisStyle(t), title: { text: 'BirdNET confidence' }, range: [0.1, 1] },
        yaxis: { ...axisStyle(t), title: { text: 'predictions' } },
        shapes: r.threshold != null ? [{ type: 'line', xref: 'x', yref: 'paper', x0: r.threshold, x1: r.threshold, y0: 0, y1: 1, line: { color: series[0], width: 2 } }] : [],
      },
    }
  }, [r, t, series])

  const calib = useMemo(() => {
    const c = r.calibration
    return {
      data: [
        {
          type: 'scatter',
          mode: 'markers',
          name: 'observed share correct (Wilson 95%)',
          x: c.map((b) => b.band),
          y: c.map((b) => b.observed_share_correct),
          error_y: { type: 'data', symmetric: false, array: c.map((b) => (b.wilson_hi ?? 0) - (b.observed_share_correct ?? 0)), arrayminus: c.map((b) => (b.observed_share_correct ?? 0) - (b.wilson_lo ?? 0)), color: series[0], thickness: 1.5 },
          marker: { color: series[0], size: 10 },
          text: c.map((b) => `${b.correct}/${b.clips} correct`),
          hovertemplate: '%{x}: %{y:.3f} (%{text})<extra></extra>',
        },
        ...(c.some((b) => b.mean_fitted_p != null)
          ? [{ type: 'scatter', mode: 'markers', name: 'mean fitted probability (primary fit)', x: c.map((b) => b.band), y: c.map((b) => b.mean_fitted_p), marker: { color: estColor.ml, size: 9, symbol: 'diamond-open', line: { width: 2 } }, hovertemplate: '%{x}: fitted %{y:.3f}<extra></extra>' }]
          : []),
      ],
      layout: { ...baseLayout(t), margin: { l: 56, r: 16, t: 36, b: 44 }, xaxis: { ...axisStyle(t), title: { text: 'confidence band' } }, yaxis: { ...axisStyle(t), title: { text: 'share correct' }, range: [0, 1.05] } },
    }
  }, [r, t, series, estColor])

  return (
    <>
      <Section
        title="Fitted curve and threshold"
        sub="Validated clips (correct at the top, incorrect at the bottom), the fitted probability that a prediction is correct, and where it crosses 99%. The grey band is the range of validated scores: a threshold outside it would be an extrapolation and is not accepted."
        right={
          <div className="sim-presets">
            <SpeciesPicker sp={sp} setSp={setSp} />
            <Segmented size="sm" value={zoom} onChange={setZoom} options={[{ value: 'full', label: 'Full scale' }, { value: 'zoom', label: 'Zoom 0.95–1', title: 'Where the threshold is decided' }]} />
          </div>
        }
      >
        <div className="chart-card">
          <Plot data={fig.data} layout={fig.layout} height={460} filename={`threshold_curve_${short(sp)}`} />
        </div>
        <div className="sum-grid two thr-detail">
          <div>
            <div className="readouts">
              <div className="readout">
                <div className="readout-label">Status</div>
                <div className="readout-value">
                  <StatusPill s={r.status} />
                </div>
                <div className="readout-sub">{r.gate_reason ? R.reason_text[r.gate_reason] : r.method_reason}</div>
              </div>
              <div className={`readout ${r.gate_passed ? 'ok' : 'warn'}`}>
                <div className="readout-label">
                  <Tip tip={`At least ${r.gate_k} correct and ${r.gate_k} incorrect validated clips are needed before a curve is used for decisions.`}>Evidence gate</Tip>
                </div>
                <div className="readout-value">
                  {r.correct} ✓ · {r.incorrect} ✗
                </div>
                <div className="readout-sub">{r.gate_passed ? `passed (k = ${r.gate_k})` : `not passed (k = ${r.gate_k})`}</div>
              </div>
              <div className="readout">
                <div className="readout-label">Threshold</div>
                <div className="readout-value">{r.threshold != null ? fmtNum(r.threshold, 4) : '—'}</div>
                <div className="readout-sub">{r.crossing_conf != null && r.threshold == null ? `curve reaches 99% only at ${fmtNum(r.crossing_conf, 4)}, above the highest validated score (${fmtNum(r.validated_conf_max, 3)})` : r.bootstrap.recorder?.threshold_ci ? `95% interval ${fmtNum(r.bootstrap.recorder.threshold_ci[0], 3)}–${fmtNum(r.bootstrap.recorder.threshold_ci[1], 3)} (recorder bootstrap)` : 'validated range ' + fmtNum(r.validated_conf_min, 3) + '–' + fmtNum(r.validated_conf_max, 3)}</div>
              </div>
              {r.validated_above_threshold != null && (
                <div className="readout ok">
                  <div className="readout-label">
                    <Tip tip="Model-free check: the validated clips at or above the threshold, and the Wilson 95% lower bound for their share correct.">Validated above it</Tip>
                  </div>
                  <div className="readout-value">
                    {r.validated_above_threshold_correct}/{r.validated_above_threshold} correct
                  </div>
                  <div className="readout-sub">Wilson lower bound {fmtPct(r.validated_above_wilson_lo ?? NaN, 1)}</div>
                </div>
              )}
            </div>
          </div>
          <div>
            <table className="data-table compact">
              <thead>
                <tr>
                  <th>Estimator</th>
                  <th className="num">β₀</th>
                  <th className="num">β₁</th>
                  <th className="num">99% at</th>
                  <th className="num">Labels</th>
                </tr>
              </thead>
              <tbody>
                {(['ml', 'firth', 'flic'] as Est[]).map((k) => {
                  const c = r.comparison[k]
                  return (
                    <tr key={k} className={r.method === k ? 'row-strong' : ''}>
                      <td>
                        <Tip tip={EST_TIP[k]} title={EST_NAME[k]}>
                          {EST_NAME[k]}
                        </Tip>
                        {r.method === k ? ' ★' : ''}
                      </td>
                      <td className="num">{dec(c?.b0, 2)}</td>
                      <td className="num">{dec(c?.b1, 2)}</td>
                      <td className="num">{c?.threshold != null ? fmtNum(c.threshold, 4) : c?.status === 'not_reached' ? '> range' : '—'}</td>
                      <td className="num">{c ? fmtInt(c.labelled) : '—'}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
            <p className="muted small">★ primary. Comparison estimators are shown for every species{r.gate_passed ? '' : '; here they are information only, because the evidence gate was not passed'}. “Labels” = predictions at or above that estimator’s threshold.</p>
          </div>
        </div>
      </Section>
      <div className="sum-grid two">
        <Section title="Where the predictions fall" sub="All predictions of this species by confidence. Teal bins are at or above the threshold (bins straddling it are drawn by their left edge).">
          <div className="chart-card">
            <Plot data={hist.data} layout={hist.layout} height={300} filename={`predictions_${short(sp)}`} />
          </div>
        </Section>
        <Section title="Calibration by score band" sub="Share of validated clips that were correct in each band, with Wilson 95% intervals, against the curve’s mean fitted probability. Close agreement means the logistic shape fits.">
          <div className="chart-card">
            <Plot data={calib.data} layout={calib.layout} height={300} filename={`calibration_${short(sp)}`} />
          </div>
        </Section>
      </div>
      <Note>
        <ul>
          {r.species.includes('Nightjar') && (
            <li>
              The curve rises steeply from 0.2 to 0.6: below 0.3 most Nightjar predictions are wrong (largely from RBS75 and RBS79), above 0.6 virtually all are right. The threshold 0.6666 lies well inside the validated range, and the three estimators agree within 0.042.
            </li>
          )}
          {r.species.includes('Plover') && (
            <li>
              With a single error (score 0.264, recorder RBS64), the curves disagree completely in the zoom: ordinary ML crosses 99% at 0.26, Firth at 0.85, FLIC at 0.16. That disagreement — not any one estimate — is the result, and the reason the evidence gate holds the Plover back.
            </li>
          )}
          {r.species.includes('Oriole') && (
            <li>
              No validated clip was wrong, so ordinary ML has no finite estimate and Firth’s curve is flat (slope −0.06 ± 0.53): its level (≈ 0.993) is set by the penalty, not by data. 150/150 correct supports a share correct of at least 97.5% (Wilson) — encouraging, but not a 99% threshold.
            </li>
          )}
          {r.species.includes('Firefinch') && (
            <li>
              Only 6 of 101 validated clips are correct; the curve reaches 99% only at about 0.998, above the highest validated (and highest predicted) score of 0.907. At that top score the fitted probability is only 0.67.
            </li>
          )}
        </ul>
      </Note>
    </>
  )
}

// ── tab: uncertainty ─────────────────────────────────────────────────────────

function UncertaintyTab({ t, sp, setSp }: Ctx) {
  const withBoot = (s: SpeciesResult) => !!s.bootstrap.recorder
  const r = R.species.find((x) => x.species === sp && withBoot(x)) ?? R.species.find(withBoot)!
  const series = SERIES[t.theme]
  const figs = useMemo(() => {
    const thr = (b?: Boot) => (b?.thresholds ?? []).filter((v): v is number => v != null)
    const rec = r.bootstrap.recorder
    const file = r.bootstrap.audio_file
    const h = (name: string, v: number[], color: string) => ({ type: 'histogram', x: v, name, opacity: 0.6, marker: { color }, nbinsx: 40, hovertemplate: '%{x}: %{y} resamples<extra>' + name + '</extra>' })
    const lines = r.threshold != null ? [{ type: 'line', xref: 'x', yref: 'paper', x0: r.threshold, x1: r.threshold, y0: 0, y1: 1, line: { color: t.ink, width: 2 } }] : []
    return {
      thr: {
        data: [h(`by recorder (${rec?.n_clusters} clusters)`, thr(rec), series[2]), h(`by audio file (${file?.n_clusters} clusters)`, thr(file), series[1])],
        layout: { ...baseLayout(t), barmode: 'overlay', margin: { l: 56, r: 16, t: 40, b: 44 }, xaxis: { ...axisStyle(t), title: { text: 'threshold in the resample (confidence)' } }, yaxis: { ...axisStyle(t), title: { text: 'resamples' } }, shapes: lines },
      },
      counts: {
        data: [h('by recorder', rec?.counts ?? [], series[2]), h('by audio file', file?.counts ?? [], series[1])],
        layout: { ...baseLayout(t), barmode: 'overlay', margin: { l: 56, r: 16, t: 40, b: 44 }, xaxis: { ...axisStyle(t), title: { text: 'predictions labelled by the threshold in the resample' } }, yaxis: { ...axisStyle(t), title: { text: 'resamples' } }, shapes: r.threshold != null ? [{ type: 'line', xref: 'x', yref: 'paper', x0: r.model_labelled, x1: r.model_labelled, y0: 0, y1: 1, line: { color: t.ink, width: 2 } }] : [] },
      },
    }
  }, [r, t, series])
  const rows = (['recorder', 'audio_file'] as const).map((k) => [k, r.bootstrap[k]] as const)
  return (
    <>
      <Section
        title="How stable is the threshold?"
        sub="The whole procedure — evidence gate, fit, acceptance — is re-run on each of the bootstrap resamples, drawing whole recorders (headline) or whole audio files with replacement. Clips from the same recorder share conditions, so resampling recorders is the honest unit."
        right={<SpeciesPicker sp={r.species} setSp={setSp} only={withBoot} />}
      >
        <div className="table-wrap auto">
          <table className="data-table sum-table">
            <thead>
              <tr>
                <th>Resampling unit</th>
                <th className="num">Clusters</th>
                <th className="num">
                  <Tip tip="Share of resamples in which the procedure produced a threshold. The rest failed the gate or did not reach 99%: they label nothing.">With a threshold</Tip>
                </th>
                <th className="num">
                  <Tip tip="2.5th–97.5th percentiles of the threshold, among resamples that produced one. Conditional, so read it together with the previous column.">Threshold 95% (conditional)</Tip>
                </th>
                <th className="num">
                  <Tip tip="2.5th, 50th and 97.5th percentiles of the number of predictions labelled, counting resamples without a threshold as 0. Unconditional.">Labelled 2.5% · 50% · 97.5%</Tip>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map(([k, b]) => (
                <tr key={k}>
                  <td>{k === 'recorder' ? 'Recorder (headline)' : 'Audio file'}</td>
                  <td className="num">{b?.n_clusters ?? '—'}</td>
                  <td className="num">{b ? fmtPct(b.share_with_threshold, 1) : '—'}</td>
                  <td className="num">{b?.threshold_ci ? `${fmtNum(b.threshold_ci[0], 3)} – ${fmtNum(b.threshold_ci[1], 3)}` : 'n/a'}</td>
                  <td className="num">{b ? b.labelled_q.map((v) => fmtInt(v)).join(' · ') : '—'}</td>
                </tr>
              ))}
              {r.delta_ci_lo != null && (
                <tr className="muted">
                  <td>Delta method (Wald, ignores clustering)</td>
                  <td className="num">—</td>
                  <td className="num">—</td>
                  <td className="num">
                    {fmtNum(r.delta_ci_lo, 3)} – {fmtNum(r.delta_ci_hi, 3)}
                  </td>
                  <td className="num">—</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Section>
      <div className="sum-grid two">
        <Section title="Threshold across resamples" sub="Only resamples that produced a threshold. Black line: the point estimate used for labels.">
          <div className="chart-card">
            <Plot data={figs.thr.data} layout={figs.thr.layout} height={300} filename={`bootstrap_threshold_${short(r.species)}`} />
          </div>
        </Section>
        <Section title="Labelled predictions across resamples" sub="Every resample; a resample without a threshold labels 0. Black line: the count at the point estimate.">
          <div className="chart-card">
            <Plot data={figs.counts.data} layout={figs.counts.layout} height={300} filename={`bootstrap_counts_${short(r.species)}`} />
          </div>
        </Section>
      </div>
      <Note>
        <ul>
          <li>
            <b>The rule is the point estimate</b> (fitted p ≥ 0.99, as the brief asks). Uncertainty is reported beside it and never changes a label. A cautious alternative — labelling only above the upper end of the interval — is a policy choice for Natural State.
          </li>
          {r.species.includes('Nightjar') && (
            <li>
              For the Nightjar, {fmtPct(1 - (r.bootstrap.recorder?.share_with_threshold ?? 1), 0)} of recorder resamples produce no threshold: every one of them leaves out both RBS75 and RBS79, which hold 29 of the 33 errors, so the remaining errors fall below the gate. That is why the lower end of the labelled count is 0. Where a threshold exists, it sits between {fmtNum(r.bootstrap.recorder?.threshold_ci?.[0], 2)} and {fmtNum(r.bootstrap.recorder?.threshold_ci?.[1], 2)}.
            </li>
          )}
          {r.species.includes('Firefinch') && <li>For the Firefinch, almost no resample reaches 99% inside its validated range: the “no supported threshold” result is robust.</li>}
          <li>Resampling audio files gives almost the same interval as treating clips as independent; the dependence that matters is between recorders.</li>
        </ul>
      </Note>
    </>
  )
}

// ── tab: evidence gate & estimators ──────────────────────────────────────────

function GateTab({ t }: Ctx) {
  const ks = [1, 3, 5, 10]
  const [k, setK] = useState(R.config.min_each_outcome)
  const series = SERIES[t.theme]
  const rowsFor = (kk: number) => R.sensitivity.filter((s) => (kk === R.config.min_each_outcome ? s.group === 'primary' : s.variant.startsWith(`gate k = ${kk}`) && s.group === 'gate'))
  const sel = rowsFor(k)
  const plover = R.species.find((s) => s.species.includes('Plover'))
  const estFig = useMemo(() => {
    const sps = R.species.filter((s) => (['ml', 'firth', 'flic'] as Est[]).some((e) => s.comparison[e]?.threshold != null))
    return {
      data: (['ml', 'firth', 'flic'] as Est[]).map((e, i) => ({
        type: 'bar',
        name: EST_NAME[e],
        x: sps.map((s) => short(s.species)),
        y: sps.map((s) => s.comparison[e]?.threshold ?? null),
        marker: { color: [t.theme === 'dark' ? '#e7eef2' : '#00354d', series[5], series[2]][i] },
        text: sps.map((s) => `${fmtInt(s.comparison[e]?.labelled ?? 0)} labels`),
        textposition: 'outside',
        hovertemplate: '%{x} · ' + EST_NAME[e] + ': %{y:.4f} (%{text})<extra></extra>',
      })),
      layout: { ...baseLayout(t), barmode: 'group', margin: { l: 56, r: 16, t: 40, b: 44 }, yaxis: { ...axisStyle(t), title: { text: '99% threshold (confidence)' }, range: [0, 1.05] }, xaxis: { ...axisStyle(t) } },
    }
  }, [t, series])
  return (
    <>
      <Section title="Why the evidence policy asks for errors before a species gets a threshold" sub="The gate is a chosen evidence policy, not a requirement of logistic regression or of the brief. A 99% threshold is the score above which fewer than 1 in 100 predictions are wrong. Where that happens is learned from the wrong predictions near it — so a species with no, or almost no, validated errors cannot locate it, however good it looks.">
        <div className="table-wrap auto">
          <table className="data-table sum-table">
            <thead>
              <tr>
                <th>Species</th>
                <th className="num">Correct</th>
                <th className="num">Incorrect</th>
                <th>Gate (k = {R.config.min_each_outcome})</th>
                <th className="num">Observed share correct (Wilson 95%)</th>
                <th>What it means</th>
              </tr>
            </thead>
            <tbody>
              {R.species.map((s) => (
                <tr key={s.species}>
                  <td>
                    <b>{s.species}</b>
                  </td>
                  <td className="num">{s.correct}</td>
                  <td className="num">{s.incorrect}</td>
                  <td>{s.gate_passed ? <span className="qa-chip qa-pass">✓ passed</span> : <span className="qa-chip qa-flag">⚑ {R.reason_text[s.gate_reason ?? ''] ?? 'not passed'}</span>}</td>
                  <td className="num">
                    {fmtPct(s.observed_precision, 1)} ({fmtPct(s.observed_precision_wilson_lo, 1)}–{fmtPct(s.observed_precision_wilson_hi, 1)})
                  </td>
                  <td className="small">
                    {s.species.includes('Oriole') && 'No errors: the slope of the curve is not identified. Even without a model, 381 correct clips in a row would be needed for a Wilson 95% lower bound of 99% (300 by the one-sided rule of three).'}
                    {s.species.includes('Plover') && 'One error: the threshold depends entirely on the estimator (0.16, 0.26 or 0.85).'}
                    {s.species.includes('Nightjar') && 'Enough of both outcomes; the three estimators agree within 0.042.'}
                    {s.species.includes('Firefinch') && 'Passes the gate (6 correct), but the curve never reaches 99% within the validated scores.'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <Section
        title="What if the gate were different?"
        sub="The full procedure re-run with other values of k. Each row is a species; the labels column counts predictions above the threshold (before human verdicts)."
        right={<Segmented value={String(k)} onChange={(v) => setK(Number(v))} options={ks.map((x) => ({ value: String(x), label: `k = ${x}`, title: x === R.config.min_each_outcome ? 'documented policy' : 'sensitivity run' }))} />}
      >
        <div className="table-wrap auto">
          <table className="data-table sum-table">
            <thead>
              <tr>
                <th>Species</th>
                <th>Status</th>
                <th className="num">Threshold</th>
                <th className="num">Labelled by threshold</th>
              </tr>
            </thead>
            <tbody>
              {sel.map((s) => (
                <tr key={s.species}>
                  <td>{s.species}</td>
                  <td>
                    <StatusPill s={s.status} />
                  </td>
                  <td className="num">{s.threshold != null ? fmtNum(s.threshold, 4) : '—'}</td>
                  <td className="num">{fmtInt(s.model_labelled)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="muted small">k = 1 would admit the Plover with the ordinary ML threshold 0.26 (536 labels) — a number driven by a single clip. k = 10 would also stop the Firefinch at the gate, which changes nothing because its curve never reaches 99%.</p>
      </Section>

      <div className="sum-grid two">
        <Section title="Three estimators, three thresholds" sub="The 99% point under ordinary ML, Firth and FLIC, ignoring the gate. Where both outcomes are plentiful (Nightjar) they agree; with one error (Plover) they do not.">
          <div className="chart-card">
            <Plot data={estFig.data} layout={estFig.layout} height={320} filename="estimator_comparison" />
          </div>
        </Section>
        <Section title="Why Firth moved the Plover to 0.85" sub="Firth is often recommended for rare events, but it reduces bias in the coefficients, not in the predicted probabilities.">
          {plover && (
            <table className="data-table compact">
              <thead>
                <tr>
                  <th>Plover</th>
                  <th className="num">Mean fitted p</th>
                  <th className="num">99% at</th>
                  <th className="num">Labels</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td className="muted">Observed (145/146)</td>
                  <td className="num">{fmtNum(plover.observed_precision, 4)}</td>
                  <td className="num">—</td>
                  <td className="num">—</td>
                </tr>
                {(['ml', 'firth', 'flic'] as Est[]).map((e) => (
                  <tr key={e}>
                    <td>
                      <Tip tip={EST_TIP[e]} title={EST_NAME[e]}>
                        {EST_NAME[e]}
                      </Tip>
                    </td>
                    <td className="num">{fmtNum(plover.comparison[e]?.mean_fitted_p ?? NaN, 4)}</td>
                    <td className="num">{fmtNum(plover.comparison[e]?.threshold ?? NaN, 4)}</td>
                    <td className="num">{fmtInt(plover.comparison[e]?.labelled ?? 0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="small">
            Firth’s penalty acts like adding about one extra error (and one extra correct clip) at the most influential scores. With one real error that doubles the error count: its mean fitted probability, 0.9865 ≈ 1 − 2/147, is below the observed 0.9932, so the whole curve sits lower and crosses 99% late. FLIC restores the observed mean and crosses at 0.16. The shrunken slope alone would have <i>lowered</i> the threshold.
          </p>
        </Section>
      </div>
    </>
  )
}

// ── tab: recorders ───────────────────────────────────────────────────────────

function RecordersTab({ t, sp, setSp }: Ctx) {
  const withChecks = (s: SpeciesResult) => s.recorders.some((r) => r.tested)
  const r = R.species.find((x) => x.species === sp && withChecks(x)) ?? R.species.find(withChecks)!
  const series = SERIES[t.theme]
  const tested = r.recorders.filter((x) => x.tested)
  const fig = useMemo(
    () => ({
      data: [
        { type: 'bar', name: 'observed correct', x: tested.map((x) => x.recorder), y: tested.map((x) => x.correct), marker: { color: tested.map((x) => (x.flagged ? series[1] : series[0])) }, hovertemplate: '%{x}: %{y} correct<extra></extra>' },
        { type: 'scatter', mode: 'markers', name: 'expected (curve fitted without this recorder)', x: tested.map((x) => x.recorder), y: tested.map((x) => x.expected_correct_loro), marker: { color: t.ink, symbol: 'line-ew-open', size: 26, line: { width: 3 } }, hovertemplate: '%{x}: expected %{y:.1f}<extra></extra>' },
      ],
      layout: { ...baseLayout(t), margin: { l: 56, r: 16, t: 40, b: 44 }, yaxis: { ...axisStyle(t), title: { text: 'validated clips judged correct' } }, xaxis: { ...axisStyle(t) } },
    }),
    [tested, t, series],
  )
  const sens = R.sensitivity.filter((s) => s.group === 'recorders' && s.species === r.species)
  return (
    <>
      <Section
        title="Are some recorders off the pooled curve?"
        sub={`Each recorder with ≥ ${R.config.review_min_clips} validated clips is compared with a curve fitted on the other recorders. The p-value is the exact probability of seeing so few correct clips if that curve were right there. Flagged at p < ${R.config.review_alpha} / number of recorders tested (Bonferroni).`}
        right={<SpeciesPicker sp={r.species} setSp={setSp} only={withChecks} />}
      >
        <div className="sum-grid two">
          <div>
            <div className="chart-card">
              <Plot data={fig.data} layout={fig.layout} height={340} filename={`recorder_checks_${short(r.species)}`} />
            </div>
          </div>
          <div>
            <table className="data-table compact">
              <thead>
                <tr>
                  <th>Recorder</th>
                  <th className="num">Clips</th>
                  <th className="num">Correct</th>
                  <th className="num">Expected</th>
                  <th className="num">p</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {tested.map((x) => (
                  <tr key={x.recorder} className={x.flagged ? 'qa-row-flag' : ''}>
                    <td>{x.recorder}</td>
                    <td className="num">{x.validated_clips}</td>
                    <td className="num">{x.correct}</td>
                    <td className="num">{dec(x.expected_correct_loro, 1)}</td>
                    <td className="num">{x.p_value != null ? (x.p_value < 0.001 ? x.p_value.toExponential(1) : fmtNum(x.p_value, 3)) : '—'}</td>
                    <td>{x.flagged && <span className="qa-chip qa-flag">⚑ flag</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="muted small">
              Bonferroni level here: {fmtNum(tested[0]?.bonferroni_alpha ?? NaN, 4)} ({tested.length} recorders tested). {r.recorders.length - tested.length} recorders have fewer than {R.config.review_min_clips} validated clips and are not tested.
            </p>
          </div>
        </div>
      </Section>
      {sens.length > 0 && (
        <Section title="Does the threshold depend on the flagged recorders?" sub="The procedure re-run without them.">
          <div className="table-wrap auto">
            <table className="data-table sum-table">
              <thead>
                <tr>
                  <th>Variant</th>
                  <th className="num">Validated clips</th>
                  <th className="num">Errors</th>
                  <th>Status</th>
                  <th className="num">Threshold</th>
                  <th className="num">Labelled</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>All recorders (documented)</td>
                  <td className="num">{r.validated_clips}</td>
                  <td className="num">{r.incorrect}</td>
                  <td>
                    <StatusPill s={r.status} />
                  </td>
                  <td className="num">{r.threshold != null ? fmtNum(r.threshold, 4) : '—'}</td>
                  <td className="num">{fmtInt(r.model_labelled)}</td>
                </tr>
                {sens.map((s) => (
                  <tr key={s.variant}>
                    <td>{s.variant}</td>
                    <td className="num">{s.validated_clips}</td>
                    <td className="num">{s.incorrect}</td>
                    <td>
                      <StatusPill s={s.status} />
                    </td>
                    <td className="num">{s.threshold != null ? fmtNum(s.threshold, 4) : '—'}</td>
                    <td className="num">{fmtInt(s.model_labelled)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      )}
      {r.covariates.length > 0 && (
        <Section
          title="Does the curve change with recorder or time? (Wood & Kahl’s AIC test)"
          sub="The paper suggests adding spatial or temporal covariates and comparing models with AIC. All recorders are in one grid, so the spatial unit is the recorder; it enters as a random intercept, because a plain recorder term runs to infinity for all-wrong recorders. Lower AIC is better; ΔAIC < 2 means no real difference. AIC is ranked only among identified models; fits that did not converge are shown as diagnostics, without an AIC."
        >
          <div className="table-wrap auto">
            <table className="data-table sum-table">
              <thead>
                <tr>
                  <th>Model (all with logit score)</th>
                  <th className="num">Parameters</th>
                  <th className="num">log-likelihood</th>
                  <th className="num">AIC</th>
                  <th className="num">ΔAIC</th>
                  <th className="num">
                    <Tip tip="Standard deviation of the recorder random intercept on the logit scale. Above ~10 the estimate is diverging: a few recorders behave as if always wrong, which a normal spread cannot represent.">Recorder SD</Tip>
                  </th>
                  <th className="num">
                    <Tip tip="Where the curve crosses 99% for a typical recorder (and, for random-intercept models, for a new recorder averaged over recorders). Not an accepted threshold: shown only when the model is identified.">99% crossing</Tip>
                  </th>
                  <th>Note</th>
                </tr>
              </thead>
              <tbody>
                {r.covariates.map((m) => (
                  <tr key={m.model} className={m.delta_aic === 0 ? 'row-strong' : ''}>
                    <td>{m.model}</td>
                    <td className="num">{m.k}</td>
                    <td className="num">{dec(m.loglik, 2)}</td>
                    <td className="num">{dec(m.aic, 1)}</td>
                    <td className="num">{dec(m.delta_aic, 1)}</td>
                    <td className="num">{m.recorder_sd > 0 ? dec(m.recorder_sd, 1) : '—'}</td>
                    <td className="num">
                      {m.crossing_typical_recorder != null ? fmtNum(m.crossing_typical_recorder, 4) : '—'}
                      {m.crossing_new_recorder != null ? ` · new: ${fmtNum(m.crossing_new_recorder, 4)}` : ''}
                    </td>
                    <td className="small muted">{m.notes ? m.notes.split(' | ').filter((n) => !n.startsWith('optimiser')).join('; ') : m.identified ? '' : 'not identified'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {Object.keys(r.covariate_crosstab).length > 0 && (
            <div className="table-wrap auto">
              <table className="data-table compact">
                <thead>
                  <tr>
                    <th>Validated clips</th>
                    <th className="num">Correct</th>
                    <th className="num">Incorrect</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(r.covariate_crosstab).map(([k, v]) => (
                    <tr key={k}>
                      <td>{k}</td>
                      <td className="num">{v.correct}</td>
                      <td className="num">{v.incorrect}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {r.species.includes('Nightjar') && (
            <p className="small">
              <b>Reading it:</b> most observed Nightjar errors concentrate at two recorders whose validated clips are predominantly evening recordings (26 of their 29). Recorder and time effects are difficult to separate in this sample; an evening effect remains plausible. Among models that fit properly, score + evening is best (ΔAIC 14.6), but its evening term comes almost entirely from RBS75/RBS79 and cannot be estimated without them (all 4 remaining errors are evening clips). The recorder random-intercept fits did not converge, so they are inconclusive. The evening model meets the original adoption rule; labels keep the pooled curve because its transferability is unresolved (D-13). <b>Sensitivity:</b> adopting it would set thresholds of 0.4208 (night &amp; dawn) and 0.7272 (evening) and label 3,715 Nightjar predictions instead of 3,147.
            </p>
          )}
          {r.species.includes('Firefinch') && <p className="small">For the Firefinch no covariate improves the model by 2 AIC units or more, and every crossing stays above the highest validated score.</p>}
        </Section>
      )}
      <Note>
        <ul>
          <li>
            <b>Flags are for review, not removal.</b> At RBS75 and RBS79 every validated Nightjar clip was wrong, but all of those scored ≤ 0.273 — the validation says nothing about high-scoring Nightjar predictions there, so the 9 above the threshold (all at RBS79) stay observations and carry <code>review_flag</code>.
          </li>
          {r.species.includes('Nightjar') && (
            <li>
              Without the two flagged recorders only 4 Nightjar errors remain, below the gate — yet the threshold would barely move (0.686 vs 0.667 with k = 1). The location is robust; the evidence count is not. More validation away from RBS75/RBS79 would make the Nightjar threshold stand on its own.
            </li>
          )}
          <li>The leave-one-recorder-out test shows that RBS75/RBS79 disagree with the pooled curve; neither it nor the AIC comparison can separate a recorder effect from an evening effect, because the two overlap in this sample.</li>
        </ul>
      </Note>
    </>
  )
}

// ── tab: sensitivity ─────────────────────────────────────────────────────────

function SensitivityTab() {
  const species = R.species.map((s) => s.species)
  const variants = [...new Map(R.sensitivity.map((s) => [s.variant, s.group])).entries()]
  const primary = new Map(R.sensitivity.filter((s) => s.group === 'primary').map((s) => [s.species, s]))
  const cell = (v: string, sp: string) => R.sensitivity.find((s) => s.variant === v && s.species === sp)
  return (
    <>
      <Section title="Every choice, varied" sub="The whole procedure re-run under each alternative. Each cell: threshold (labels above it). Cells that differ from the documented result are highlighted.">
        <div className="table-wrap auto">
          <table className="data-table sum-table sens-table">
            <thead>
              <tr>
                <th>Choice</th>
                <th>Variant</th>
                {species.map((s) => (
                  <th key={s}>{short(s)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {variants.map(([v, g]) => (
                <tr key={v} className={g === 'primary' ? 'row-strong' : ''}>
                  <td className="muted small">{g}</td>
                  <td>{v}</td>
                  {species.map((sp) => {
                    const c = cell(v, sp)
                    const p = primary.get(sp)
                    const differs = c && p && (c.status !== p.status || c.model_labelled !== p.model_labelled)
                    return (
                      <td key={sp} className={differs ? 'cell-diff' : ''} data-tip={c ? `${R.status_text[c.status]}${c.gate_reason ? ` (${R.reason_text[c.gate_reason]})` : ''} · ${c.validated_clips} clips, ${c.incorrect} errors` : ''}>
                        {c ? (c.threshold != null ? `${fmtNum(c.threshold, 4)} (${fmtInt(c.model_labelled)})` : <span className="muted">{STATUS_LABEL[c.status]}</span>) : '—'}
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>
      <Note>
        <ul>
          <li>
            <b>Logit endpoint and duplicates:</b> no effect on any decision. Clamping scores of exactly 1 at 5×10⁻⁴, 10⁻⁵ or 10⁻⁶ instead of 10⁻⁴, or dropping them, changes the Nightjar threshold only in the 8th decimal: those clips sit where the curve is already ≈ 1.
          </li>
          <li>
            <b>Gate:</b> k = 1 would admit the Plover on a single error (0.26, 536 labels); k = 3 changes nothing; k = 10 also stops the Firefinch, which has no threshold anyway.
          </li>
          <li>
            <b>Estimator:</b> forcing Firth or FLIC moves the Nightjar from 0.667 to about 0.71 (≈ 200 fewer labels) — modest, because both outcomes are plentiful. For the Plover the same switch spans 0.16 to 0.85, which is why it is gated.
          </li>
          <li>
            <b>Flagged recorders:</b> removing them leaves the Nightjar below the gate (4 errors), although its threshold would hardly move (0.686).
          </li>
        </ul>
      </Note>
    </>
  )
}

// ── tab: validation design ───────────────────────────────────────────────────

function SamplingTab({ t, sp, setSp }: Ctx) {
  const r = R.species.find((x) => x.species === sp)!
  const series = SERIES[t.theme]
  const fig = useMemo(
    () => ({
      data: [
        { type: 'bar', name: 'share of predictions', x: r.sampling.map((b) => b.band), y: r.sampling.map((b) => b.prediction_share), marker: { color: OTHER[t.theme] }, text: r.sampling.map((b) => `${fmtInt(b.predictions ?? 0)} predictions`), textposition: 'none', hovertemplate: '%{x}: %{y:.1%} (%{text})<extra></extra>' },
        { type: 'bar', name: 'share of validated clips', x: r.sampling.map((b) => b.band), y: r.sampling.map((b) => b.validated_share), marker: { color: series[0] }, text: r.sampling.map((b) => `${b.validated_clips} clips`), textposition: 'none', hovertemplate: '%{x}: %{y:.1%} (%{text})<extra></extra>' },
      ],
      layout: { ...baseLayout(t), barmode: 'group', margin: { l: 56, r: 16, t: 40, b: 44 }, yaxis: { ...axisStyle(t), title: { text: 'share' }, tickformat: '.0%' }, xaxis: { ...axisStyle(t), title: { text: 'confidence band' } } },
    }),
    [r, t, series],
  )
  return (
    <>
      <Section title="How were clips chosen for validation?" sub="Share of each species’ predictions and of its validated clips in each confidence band. If validation were a simple random sample of predictions, the two bars would match." right={<SpeciesPicker sp={sp} setSp={setSp} />}>
        <div className="chart-card">
          <Plot data={fig.data} layout={fig.layout} height={320} filename={`validation_design_${short(sp)}`} />
        </div>
      </Section>
      <Note label="Why it matters, and why it does not bias the curve">
        <ul>
          <li>For the Oriole, Plover and Nightjar the validation over-represents high scores (Oriole: 26% of validated clips score ≥ 0.9, against 3% of predictions). The Firefinch validation mirrors its predictions.</li>
          <li>
            This matches Wood &amp; Kahl’s own advice: when random samples are dominated by low scores, add “a second set of randomly selected validation samples from a higher range of scores … providing additional resolution in the range of scores where false positives transition to true positives.”
          </li>
          <li>
            Choosing clips <i>by score</i> does not bias a model of correctness <i>given</i> the score, so the curves and thresholds are unaffected. It does bias any raw precision computed over all validated clips, which is why this page never reports one without the model or a score band.
          </li>
          <li>
            <b>Confirmation item C-1:</b> the sampling protocol is not documented in the data. The working assumption is random sampling within score bands with a high-score top-up, possibly with replacement (see the duplicate pairs, D-01).
          </li>
        </ul>
      </Note>
    </>
  )
}

// ── tab: Wood & Kahl alignment ───────────────────────────────────────────────

type Align = 'aligned' | 'extended' | 'adjusted' | 'pending' | 'downstream'
const ALIGN_LABEL: Record<Align, string> = { aligned: '✓ aligned', extended: '+ extended', adjusted: '~ adjusted', pending: '… pending', downstream: '→ for the platform' }
const ALIGNMENT: { topic: string; paper: string; ours: string; status: Align }[] = [
  { topic: 'Scores are not probabilities', paper: '“BirdNET confidence scores are not probabilities … not transferrable among species.” Species-specific evaluation is required.', ours: 'One curve per species; no score is interpreted as a probability until calibrated.', status: 'aligned' },
  { topic: 'Validation sample', paper: 'A random selection of predictions spanning the full score range; for rare or poorly performing species, add a second random set from higher scores.', ours: 'Uses the provided validations. Their score distribution is consistent with a high-score top-up (Validation design tab); score-dependent sampling does not bias the conditional model.', status: 'aligned' },
  { topic: 'Model', paper: 'glm(outcome ~ score, family = "binomial") — ordinary logistic regression.', ours: 'Ordinary maximum likelihood, identical to R’s glm (tested against statsmodels to 1e-7).', status: 'aligned' },
  { topic: 'Logit-transformed score', paper: '“We suggest transforming confidence scores back into the original logit scale, because the highest scores tend to be compressed.”', ours: 'Predictor is ln(c / (1 − c)). The paper also divides by BirdNET’s sensitivity setting; that rescales β₁ but leaves the threshold in confidence units unchanged, so the unknown setting does not matter.', status: 'aligned' },
  { topic: 'Threshold formula', paper: 'threshold = (ln(p / (1 − p)) − β₀) / β₁ for the desired p.', ours: 'Same formula with p = 0.99 (the brief); with the logit score as predictor it gives the threshold on the logit scale, converted to a confidence by the inverse logit; the paper’s examples use 0.90 and 0.95. At 0.99 errors near the threshold are rare, which is why the evidence gate matters.', status: 'aligned' },
  { topic: 'Range of applicability', paper: '“Probabilistic score thresholds will be applicable to the range of conditions encompassed by data from which they were drawn.”', ours: 'Thresholds are accepted only inside the validated score range (no extrapolation); recorders inconsistent with the pooled curve are flagged.', status: 'extended' },
  { topic: 'Covariates and AIC', paper: 'Test generalisability by adding spatial or temporal covariates (season, latitude, ecosystem) and compare models with AIC.', ours: 'Done (D-13): evening, week and a recorder random intercept compared by AIC (only converged, identified fits ranked), plus a leave-one-recorder-out test. Most errors sit at two recorders whose clips are mostly evening, so recorder and time effects cannot be separated; an evening effect remains plausible. The evening model met the original adoption rule; labels keep the pooled curve because its transferability is unresolved, and it is reported as a sensitivity analysis.', status: 'aligned' },
  { topic: 'Disclose error rates', paper: '“If all putative observations cannot be validated, it is very important to understand (and disclose) the estimated error rates.”', ours: 'Expected precision of the labelled set, model-free Wilson bounds above the threshold, bootstrap uncertainty, all reported per species.', status: 'aligned' },
  { topic: 'Accuracy increases with score', paper: '“We have yet to encounter a class in BirdNET for which prediction accuracy does not increase with confidence score.”', ours: 'A fitted curve that does not increase is treated as a failure to identify the relationship (status slope_not_positive), not as a real negative effect.', status: 'aligned' },
  { topic: 'Species with no or very few errors', paper: 'Not discussed.', ours: 'Evidence gate: ≥ 5 correct and ≥ 5 incorrect validated clips before a curve is used for labels; Firth only as a fallback for separated data. Human-confirmed clips kept as observations.', status: 'extended' },
  { topic: 'Human verdicts', paper: 'Validation can take the form of manual verification of results.', ours: 'Validated clips that link to exactly one prediction keep the ornithologist’s verdict as their label.', status: 'extended' },
  { topic: 'Precision vs per-prediction probability', paper: 'Thresholds are defined by pr(prediction is correct) at the threshold score.', ours: 'Per-prediction rule, as in the paper. The brief’s “precision ≥ 0.99” (set-level) would give the Nightjar 0.4316 and 4,355 labels instead of 0.6666 and 3,147; reported, not used.', status: 'adjusted' },
  { topic: 'Temporal confirmation', paper: 'Optionally require pr(tp) ≥ 0.95 on two or more days before declaring a species present at a site.', ours: 'Out of scope for clip labels; recommended to the Tech team as a site-level presence rule.', status: 'downstream' },
  { topic: 'Probabilities for occupancy models', paper: 'Observation-specific probabilities are compatible with false-positive occupancy models.', ours: 'p_correct is exported for every prediction of a species with an identified, increasing curve.', status: 'aligned' },
  { topic: 'Transferability', paper: 'Scores depend on hardware and recording settings; re-validate for new locations, seasons or equipment.', ours: 'Thresholds are tied to this deployment; the Tech handover specifies re-validation triggers.', status: 'downstream' },
  { topic: 'Precision and recall still matter', paper: 'Probabilistic scores are not a substitute for precision, recall and ROC.', ours: 'Recall cannot be estimated here: the data contain no information on missed vocalisations. Observations are high-precision and should not be read as absences.', status: 'adjusted' },
]

function PaperTab() {
  return (
    <>
      <Section title="Are we following Wood & Kahl (2024)?" sub="The paper’s recommendations, quoted or paraphrased, against what this analysis does. “Extended” means the paper is silent and we added a safeguard; “adjusted” means a deliberate, documented difference.">
        <div className="table-wrap auto">
          <table className="data-table sum-table qa-table align-table">
            <thead>
              <tr>
                <th>Topic</th>
                <th>Wood &amp; Kahl</th>
                <th>This analysis</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {ALIGNMENT.map((a) => (
                <tr key={a.topic}>
                  <td>
                    <b>{a.topic}</b>
                  </td>
                  <td className="small">{a.paper}</td>
                  <td className="small">{a.ours}</td>
                  <td>
                    <span className={`qa-chip ${a.status === 'aligned' ? 'qa-pass' : a.status === 'pending' ? 'qa-flag' : 'qa-info'}`}>{ALIGN_LABEL[a.status]}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>
      <Note label="In one paragraph">
        <p>
          The core is the paper’s method unchanged: per-species ordinary logistic regression of the verdict on the logit score, solved for the target probability. What we added addresses situations the paper does not discuss but this dataset contains — a species with no errors, a species with one, separated data, scores of exactly 1, duplicate validations, site-specific false positives — and every addition errs toward fewer automatic observations, never more. The full write-up is in <code>docs/challenge1_paper_alignment.md</code>.
        </p>
      </Note>
    </>
  )
}

// ── tab: discussion & conclusions (same content as challenge1/Q1_report.md, section 10, and D-14) ──

const OTHER_PAPERS: { paper: string; offers: string; use: string; verdict: 'reported' | 'used' | 'not adopted' | 'downstream' }[] = [
  {
    paper: 'Tseng et al. 2025',
    offers: 'Thresholds from the precision of the whole set of kept predictions, not per prediction',
    use: 'Reported as the alternative reading of “99%” (C-5): Nightjar 0.4316 and 4,355 labels vs 0.6666 and 3,147 — about 38% more observations, each individually less certain. The per-prediction rule is kept because it is Wood & Kahl’s definition and the brief’s wording; the choice is a policy decision for Natural State.',
    verdict: 'reported',
  },
  {
    paper: 'Schwinger et al. 2025',
    offers: 'Calibration diagnostics (Platt scaling, reliability diagrams)',
    use: 'Used as a check. Wood & Kahl’s curve is Platt scaling; calibration by score band (Species curves tab) confirms the Nightjar fit across the range. Their finding that calibration varies across datasets supports recalibrating per species and per deployment.',
    verdict: 'used',
  },
  {
    paper: 'Thompson et al. 2025',
    offers: 'Mixed models that pool species curves, so rarely validated species borrow strength',
    use: 'Not adopted for labels. It would give the Oriole and Plover a curve only by assuming they behave like the other species — which their data cannot confirm, and which cuts against Wood & Kahl’s “scores are not transferable among species”. With four species, one of them the near-useless Firefinch, the pooled curve would mostly reflect the assumption. Attractive on the platform once many species are validated.',
    verdict: 'not adopted',
  },
  {
    paper: 'Navine et al. 2024',
    offers: 'Threshold-free call density (share of audio windows containing the species)',
    use: 'A different product, not clip labels. It needs no errors, so it suits exactly the species without a threshold (the Oriole). Recommended to the Tech team as a future vocal-activity measure; its quantile-bin validation design is a model for future validation rounds.',
    verdict: 'downstream',
  },
  {
    paper: 'Clare et al. 2021',
    offers: 'Occupancy models that account for false positives',
    use: 'Downstream. A 99% threshold reduces false positives but does not remove them, and ignoring them biases occupancy. That is why p_correct is exported per prediction and the validated clips should be kept as confirmation data.',
    verdict: 'downstream',
  },
]

const CONCLUSIONS: ReactNode[] = [
  <>
    <b>The answer to Q1:</b> 3,460 of 29,491 predictions are observations — 3,097 above the Nightjar’s 99% threshold (0.666639) and 363 confirmed directly by the ornithologist. Every row carries its label, the reason for it and, where the curve is identified, its probability of being correct.
  </>,
  <>
    <b>Under the chosen evidence policy, only one of four species gets an automatic 99% threshold.</b> That is about the evidence, not BirdNET: a 99% threshold is located by the errors near it. The Oriole (0 errors in 150) has no estimable curve; the Plover (1 in 146) has an ordinary ML threshold (0.261) that the policy declines because it rests on one error and moves from 0.16 to 0.85 with the estimator; the Firefinch’s curve never reaches 99% within its validated scores.
  </>,
  <>
    <b>The Nightjar’s 99% is model-based.</b> Its location is robust to the estimator, de-duplication, the treatment of scores of 1 and removing the two problem recorders; direct validation supports about 95% (74/74 validated clips above the threshold correct, Wilson lower bound 95.1%).
  </>,
  <>
    <b>Most Nightjar errors come from two recorders whose validated clips are mostly evening recordings,</b> so recorder and time effects cannot be separated here. RBS75/RBS79 are flagged, not removed; an evening effect remains plausible — the evening model met the original adoption rule but is reported as a sensitivity analysis (3,715 vs 3,147 labels) because its transferability is unresolved; every new recorder should pass a small acceptance check.
  </>,
  <>
    <b>Only the gate and the estimator move the answer,</b> and only for species with one error or none; data-handling choices change nothing. That is the reason for the evidence gate.
  </>,
  <>
    <b>The lever is more validation,</b> designed as Wood &amp; Kahl recommend: random within score bands, spread across recorders, never targeted at errors.
  </>,
  <>
    <b>The procedure is ready to automate:</b> the ns_observations package runs the same decision rules as this analysis and reproduces these numbers exactly.
  </>,
  <>
    <b>From the wider literature,</b> set-level precision (Tseng) is the one real policy alternative (C-5); partial pooling (Thompson) belongs on the platform once many species are validated; call density (Navine) and false-positive occupancy models (Clare) are the natural next uses of these outputs.
  </>,
]

function DiscussionTab() {
  return (
    <>
      <Section title="Did we follow Wood & Kahl (2024)?" sub="Yes on the method; extended where the paper is silent; two recommendations could not be carried out with these data. Point by point: the Wood & Kahl alignment tab and docs/challenge1_paper_alignment.md.">
        <div className="sum-grid three-col">
          <div className="for-us">
            <div className="pipe-col-label">Followed as written</div>
            <ul>
              <li>One curve per species</li>
              <li>Ordinary logistic regression of the verdict on the logit-transformed score (the paper’s glm and the logit its text recommends)</li>
              <li>Threshold solved from the curve at p = 0.99</li>
              <li>Transferability tested with covariates and AIC</li>
              <li>Error rates disclosed; p_correct exported for occupancy models</li>
            </ul>
          </div>
          <div className="for-us">
            <div className="pipe-col-label">Extended where the paper is silent</div>
            <ul>
              <li>Evidence gate for species with zero or one error</li>
              <li>Firth only as a fallback for separated data</li>
              <li>No extrapolation outside the validated scores</li>
              <li>Recorder review flags</li>
            </ul>
            <p className="small">These make the automatic labels more conservative, never more permissive. One addition works the other way by design: <b>human verdicts are kept as labels</b>, adding 313 observations that no threshold supports, each backed by direct confirmation.</p>
          </div>
          <div className="for-us">
            <div className="pipe-col-label">Could not be done with these data</div>
            <ul>
              <li>
                <b>Designing the validation sample:</b> we used the clips provided; their score distribution fits the paper’s recommended high-score top-up (C-1).
              </li>
              <li>
                <b>Recall:</b> the files hold no record of missed vocalisations, so observations are high-precision, not a complete count.
              </li>
            </ul>
          </div>
        </div>
      </Section>

      <Section title="How the other papers informed this analysis" sub="The five related papers on the Methodology page. None replaces Wood & Kahl, which the brief prescribes; each shaped a specific part of the work (D-14).">
        <div className="table-wrap auto">
          <table className="data-table sum-table qa-table align-table">
            <thead>
              <tr>
                <th>Paper</th>
                <th>What it offers</th>
                <th>How it was used here</th>
                <th>Verdict</th>
              </tr>
            </thead>
            <tbody>
              {OTHER_PAPERS.map((p) => (
                <tr key={p.paper}>
                  <td>
                    <b>{p.paper}</b>
                  </td>
                  <td className="small">{p.offers}</td>
                  <td className="small">{p.use}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <span className={`qa-chip ${p.verdict === 'used' || p.verdict === 'reported' ? 'qa-pass' : p.verdict === 'not adopted' ? 'qa-flag' : 'qa-info'}`}>{p.verdict}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <Section title="Conclusions" sub="The same conclusions as the Q1 report, section 10.">
        <ol className="conclusions">
          {CONCLUSIONS.map((c, i) => (
            <li key={i}>{c}</li>
          ))}
        </ol>
      </Section>
    </>
  )
}

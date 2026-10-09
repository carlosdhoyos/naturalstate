/**
 * Challenge landing pages. Every number is computed from the loaded CSVs at runtime —
 * nothing is typed in by hand — so the page always matches the data.
 */
import { useMemo, type ReactNode } from 'react'
import { buildFigure, DEFAULT_SPEC, type ChartSpec } from '../charts/build'
import { keyOf } from '../data/filter'
import { tokens as splitTokens } from '../data/load'
import { CHALLENGES, type Challenge } from '../data/registry'
import { fmtDate, fmtInt, fmtNum, fmtPct, quantileSorted, wilson } from '../data/stats'
import type { Dataset, Row } from '../data/types'
import { tip, tipText, type HelpKey } from '../lib/help'
import type { ThemeTokens } from '../lib/palette'
import { BirdsBalance } from './BirdsBalance'
import { Plot } from './Plot'
import { Icon, Stat } from './ui'

export type OpenView = (id: string, patch?: { tab?: 'overview' | 'explore' | 'table' | 'map'; spec?: Partial<ChartSpec> }) => void

interface Props {
  reg: Map<string, Dataset>
  tokens: ThemeTokens
  onOpen: OpenView
}

// ── small building blocks ─────────────────────────────────────────────────────

function Section({ title, sub, tipKey, children, action }: { title: string; sub?: ReactNode; tipKey?: HelpKey; children: ReactNode; action?: ReactNode }) {
  return (
    <section className="sum-section">
      <div className="sum-section-head">
        <div>
          <h2 className={tipKey ? 'has-tip' : ''} {...(tipKey ? tip(tipKey, true) : {})}>
            {title}
          </h2>
          {sub && <p className="muted">{sub}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  )
}

interface Col {
  key: string
  label: string
  tip?: string
  num?: boolean
}

function SumTable({ cols, rows, foot }: { cols: Col[]; rows: Record<string, ReactNode>[]; foot?: Record<string, ReactNode> }) {
  return (
    <div className="table-wrap auto">
      <table className="data-table sum-table">
        <thead>
          <tr>
            {cols.map((c) => (
              <th key={c.key} className={`${c.num ? 'num' : ''} ${c.tip ? 'has-tip' : ''}`} {...tipText(c.tip, c.label)}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {cols.map((c) => (
                <td key={c.key} className={c.num ? 'num' : ''}>
                  {r[c.key] ?? '—'}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
        {foot && (
          <tfoot>
            <tr>
              {cols.map((c) => (
                <td key={c.key} className={c.num ? 'num' : ''}>
                  {foot[c.key] ?? ''}
                </td>
              ))}
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  )
}

function OpenLink({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" className="btn ghost sm" onClick={onClick}>
      <Icon name="chart" size={14} /> {children}
    </button>
  )
}

function TaskCard({ challenge }: { challenge: Challenge }) {
  const c = CHALLENGES[challenge]
  return (
    <div className="task-card">
      <div className="ds-eyebrow">Challenge {c.number}</div>
      <h1>{c.title}</h1>
      <p>{c.task}</p>
    </div>
  )
}

const num = (rows: Row[], col: string) => rows.map((r) => r[col]).filter((v): v is number => typeof v === 'number')
const distinct = (rows: Row[], col: string) => new Set(rows.map((r) => r[col]).filter((v) => v !== null)).size
const range = (v: number[]) => {
  let lo = Infinity
  let hi = -Infinity
  for (const x of v) {
    if (x < lo) lo = x
    if (x > hi) hi = x
  }
  return [lo, hi] as const
}
const median = (v: number[]) => quantileSorted([...v].sort((a, b) => a - b), 0.5)

// ── Birds ─────────────────────────────────────────────────────────────────────

const BANDS = [0.1, 0.2, 0.3, 0.5, 0.7, 0.9, 1.0000001]
const bandLabel = (i: number) => `${BANDS[i].toFixed(1)}–${i === BANDS.length - 2 ? '1.0' : BANDS[i + 1].toFixed(1)}`
const bandOf = (c: number) => BANDS.findIndex((b, i) => i < BANDS.length - 1 && c >= b && c < BANDS[i + 1])

export function BirdsSummary({ reg, tokens, onOpen }: Props) {
  const pred = reg.get('birdnet_predictions')
  const val = reg.get('validation_results')

  const s = useMemo(() => {
    if (!pred || !val) return null
    const counts = new Map<string, number>()
    pred.rows.forEach((r) => counts.set(String(r.common_name), (counts.get(String(r.common_name)) ?? 0) + 1))
    val.rows.forEach((r) => counts.has(String(r.commonName)) || counts.set(String(r.commonName), 0))
    const species = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k)
    const per = species.map((sp) => {
      const p = pred.rows.filter((r) => r.common_name === sp)
      const v = val.rows.filter((r) => r.commonName === sp)
      const pc = num(p, 'confidence')
      const vc = num(v, 'confidence')
      const k = v.filter((r) => r.outcome === 1).length
      const [lo, hi] = wilson(k, v.length)
      return {
        sp,
        sci: String(v[0]?.scientificName ?? '—'),
        code: String(p[0]?.species_code ?? '—'),
        nPred: p.length,
        recorders: distinct(p, 'folder'),
        files: distinct(p, 'begin_path'),
        pc,
        vc,
        nVal: v.length,
        k,
        wrong: v.length - k,
        prec: v.length ? k / v.length : NaN,
        ci: [lo, hi] as const,
        matched: v.filter((r) => r.link_to_predictions === 'matched').length,
        predBands: BANDS.slice(0, -1).map((_, i) => pc.filter((c) => bandOf(c) === i).length),
        valBands: BANDS.slice(0, -1).map((_, i) => {
          const inB = v.filter((r) => typeof r.confidence === 'number' && bandOf(r.confidence as number) === i)
          return { n: inB.length, k: inB.filter((r) => r.outcome === 1).length }
        }),
      }
    })
    const allPc = num(pred.rows, 'confidence')
    const allVc = num(val.rows, 'confidence')
    const dates = num(pred.rows, 'recording_date')
    const vdates = num(val.rows, 'recording_date')
    return {
      species,
      per,
      allPc,
      allVc,
      dates: range(dates),
      vdates: range(vdates),
      recorders: distinct(pred.rows, 'folder'),
      vRecorders: distinct(val.rows, 'recorder'),
      files: distinct(pred.rows, 'begin_path'),
      vFiles: distinct(val.rows, 'recording_file'),
      versions: [...new Set(val.rows.map((r) => keyOf(r.vBirdNET)))].join(', '),
      matched: val.rows.filter((r) => r.link_to_predictions === 'matched').length,
      notInPred: val.rows.filter((r) => r.link_to_predictions === 'file not in predictions').length,
      validatedPreds: pred.rows.filter((r) => r.validated === 'yes').length,
      hours: [...new Set(num(pred.rows, 'hour_of_day'))].sort((a, b) => a - b),
    }
  }, [pred, val])

  const ecdf = useMemo(
    () => (pred ? buildFigure(pred, pred.rows, { ...DEFAULT_SPEC, kind: 'ecdf', x: 'confidence', color: 'common_name' }, tokens) : null),
    [pred, tokens],
  )

  if (!pred || !val || !s) return <div className="empty">Bird files not found.</div>
  const [pmin, pmax] = range(s.allPc)
  const [vmin, vmax] = range(s.allVc)

  return (
    <div className="summary">
      <TaskCard challenge="birds" />

      <div className="stats-row">
        <Stat tipKey="sum.b.preds" label="BirdNET predictions" value={fmtInt(pred.rows.length)} sub={`${fmtInt(s.files)} audio files · ${s.recorders} recorders`} />
        <Stat tipKey="sum.b.vals" label="Validated clips" value={fmtInt(val.rows.length)} sub={`${s.vRecorders} recorders · BirdNET ${s.versions}`} />
        <Stat tipKey="sum.b.species" label="Species" value={s.species.length} sub="same 4 in both files" />
        <Stat tipKey="sum.b.conf" label="Confidence range" value={`${fmtNum(pmin, 2)} – ${fmtNum(pmax, 2)}`} sub={`median ${fmtNum(median(s.allPc), 3)} · validations ${fmtNum(vmin, 2)}–${fmtNum(vmax, 2)}`} />
        <Stat tipKey="sum.b.dates" label="Recording dates" value={`${fmtDate(s.dates[0], false).slice(5)} → ${fmtDate(s.dates[1], false).slice(5)}`} sub={`${fmtDate(s.dates[0], false).slice(0, 4)} · ${Math.round((s.dates[1] - s.dates[0]) / 86_400_000) + 1} days · recorder clock`} />
      </div>

      <Section
        title="Species included"
        tipKey="sum.b.speciesTable"
        sub="Per species: how much BirdNET predicted, the confidence it gave, and what the ornithologist found in the validated sample."
        action={<OpenLink onClick={() => onOpen('validation_results', { tab: 'explore', spec: { kind: 'scatter', x: 'confidence', xTransform: 'logit', y: 'outcome', jitterY: 0.08, color: 'outcome_label', facet: 'commonName', trend: true, bins: 8, opacity: 0.55 } })}>Open Wood &amp; Kahl view</OpenLink>}
      >
        <SumTable
          cols={[
            { key: 'sp', label: 'Species', tip: 'Common name, scientific name and eBird code.' },
            { key: 'nPred', label: 'Predictions', num: true, tip: 'Rows in birdnet_predictions for this species, and their share of all predictions.' },
            { key: 'where', label: 'Recorders / files', num: true, tip: 'Number of recorders and audio files with at least one prediction of this species.' },
            { key: 'conf', label: 'Confidence min · median · max', num: true, tip: 'BirdNET confidence of this species’ predictions. Only scores ≥ 0.1 were exported.' },
            { key: 'nVal', label: 'Validated', num: true, tip: 'Clips of this species the ornithologist listened to.' },
            { key: 'cw', label: 'Correct / wrong', num: true, tip: 'outcome = 1 (species really present) / outcome = 0 (BirdNET was wrong).' },
            { key: 'prec', label: 'Correct in sample', num: true, tip: 'Correct ÷ validated, with a Wilson 95% interval. This is NOT the threshold: it mixes all confidence levels in whatever proportion the clips were sampled.' },
            { key: 'vconf', label: 'Validated confidence', num: true, tip: 'Confidence range of the validated clips.' },
            { key: 'matched', label: 'In predictions file', num: true, tip: 'Validated clips that match a row in birdnet_predictions (same species, audio file and confidence). The rest come from audio files that are not in that file.' },
          ]}
          rows={s.per.map((p) => ({
            sp: (
              <div className="sp-cell">
                <b>{p.sp}</b>
                <span className="muted small">
                  <i>{p.sci}</i> · {p.code}
                </span>
              </div>
            ),
            nPred: (
              <>
                {fmtInt(p.nPred)} <span className="muted small">({fmtPct(p.nPred / pred.rows.length, 0)})</span>
              </>
            ),
            where: `${p.recorders} / ${fmtInt(p.files)}`,
            conf: p.pc.length ? `${fmtNum(range(p.pc)[0], 3)} · ${fmtNum(median(p.pc), 3)} · ${fmtNum(range(p.pc)[1], 3)}` : '—',
            nVal: fmtInt(p.nVal),
            cw: (
              <>
                {p.k} / <span className={p.wrong ? 'warn-text' : ''}>{p.wrong}</span>
              </>
            ),
            prec: (
              <>
                <b>{fmtPct(p.prec, 0)}</b> <span className="muted small">[{fmtPct(p.ci[0], 0)}–{fmtPct(p.ci[1], 0)}]</span>
              </>
            ),
            vconf: p.vc.length ? `${fmtNum(range(p.vc)[0], 3)} – ${fmtNum(range(p.vc)[1], 3)}` : '—',
            matched: `${p.matched} / ${p.nVal}`,
          }))}
          foot={{
            sp: <b>All species</b>,
            nPred: <b>{fmtInt(pred.rows.length)}</b>,
            where: `${s.recorders} / ${fmtInt(s.files)}`,
            conf: `${fmtNum(pmin, 3)} · ${fmtNum(median(s.allPc), 3)} · ${fmtNum(pmax, 3)}`,
            nVal: <b>{fmtInt(val.rows.length)}</b>,
            cw: `${s.per.reduce((a, p) => a + p.k, 0)} / ${s.per.reduce((a, p) => a + p.wrong, 0)}`,
            prec: '',
            vconf: `${fmtNum(vmin, 3)} – ${fmtNum(vmax, 3)}`,
            matched: `${s.matched} / ${val.rows.length}`,
          }}
        />
      </Section>

      <Section title="Validation coverage by confidence band" tipKey="sum.b.coverage" sub="Correct / validated clips in each confidence band. Bands with few clips give weak evidence; cells with errors are highlighted. Predictions per band show how many clips a threshold in that band would affect.">
        <SumTable
          cols={[
            { key: 'sp', label: 'Species' },
            { key: 'kind', label: '' },
            ...BANDS.slice(0, -1).map((_, i) => ({ key: `b${i}`, label: bandLabel(i), num: true, tip: `Confidence ≥ ${BANDS[i].toFixed(1)} and < ${i === BANDS.length - 2 ? '1.0 (inclusive)' : BANDS[i + 1].toFixed(1)}` })),
          ]}
          rows={s.per.flatMap((p) => [
            {
              sp: <b>{p.sp}</b>,
              kind: <span className="muted small">validated: correct / n</span>,
              ...Object.fromEntries(
                p.valBands.map((b, i) => [
                  `b${i}`,
                  b.n ? <span className={b.k < b.n ? 'band-cell warn' : 'band-cell'}>{`${b.k} / ${b.n}`}</span> : <span className="muted">·</span>,
                ]),
              ),
            },
            {
              sp: '',
              kind: <span className="muted small">predictions</span>,
              ...Object.fromEntries(p.predBands.map((n, i) => [`b${i}`, <span className="muted">{fmtInt(n)}</span>])),
            },
          ])}
        />
      </Section>

      <BirdsBalance pred={pred} val={val} tokens={tokens} />

      <div className="sum-grid">
        <Section title="How confident is BirdNET, per species?" tipKey="sum.b.ecdf" sub="Cumulative share of each species’ predictions at or below a confidence score. A curve that rises early means most predictions are low-confidence.">
          <div className="chart-card">{ecdf && <Plot data={ecdf.data} layout={{ ...ecdf.layout, margin: { l: 56, r: 16, t: 48, b: 44 } }} height={340} filename="birdnet_confidence_ecdf" />}</div>
        </Section>

        <Section title="The two files" tipKey="sum.b.files" sub="What one row means and how the files relate.">
          <SumTable
            cols={[
              { key: 'f', label: 'File' },
              { key: 'rows', label: 'Rows', num: true },
              { key: 'cols', label: 'Columns', num: true, tip: 'Columns in the CSV (derived columns not counted).' },
              { key: 'row', label: 'One row is' },
            ]}
            rows={[
              {
                f: (
                  <button type="button" className="btn link sm" onClick={() => onOpen('birdnet_predictions')}>
                    birdnet_predictions.csv
                  </button>
                ),
                rows: fmtInt(pred.rows.length),
                cols: pred.columns.filter((c) => !c.derived).length,
                row: 'one 3-s segment × predicted species (score ≥ 0.1)',
              },
              {
                f: (
                  <button type="button" className="btn link sm" onClick={() => onOpen('validation_results')}>
                    validation_results.csv
                  </button>
                ),
                rows: fmtInt(val.rows.length),
                cols: val.columns.filter((c) => !c.derived).length,
                row: 'one clip an ornithologist listened to, with outcome 1/0',
              },
            ]}
          />
          <ul className="facts">
            <li>
              Recordings are 1-hour files from <b>{s.recorders}</b> recorders, {fmtDate(s.dates[0], false)} → {fmtDate(s.dates[1], false)}; predictions fall in hours{' '}
              {s.hours.length > 12 ? `${s.hours[0]}–${s.hours[s.hours.length - 1]}` : s.hours.join(', ')} (recorder clock).
            </li>
            <li>
              <b>{s.matched}</b> of {val.rows.length} validated clips link to a prediction (same species, file, confidence); <b>{s.notInPred}</b> come from audio files that are not in the predictions file — so the predictions are a <b>subset</b> of the full BirdNET run.
            </li>
            <li>
              Validations span <b>{s.vRecorders}</b> recorders and {fmtInt(s.vFiles)} audio files, {fmtDate(s.vdates[0], false)} → {fmtDate(s.vdates[1], false)}.
            </li>
            <li>The audio itself was not provided — only file names, scores and verdicts.</li>
            <li>A confidence score is not a probability: the same score means different reliability for different species, which is why each species needs its own threshold.</li>
          </ul>
        </Section>
      </div>
    </div>
  )
}

// ── Vegetation ────────────────────────────────────────────────────────────────

export function VegetationSummary({ reg, onOpen }: Props) {
  const g = (id: string) => reg.get(id)
  const survey = g('herbaceous_veg_survey')
  const quad = g('herbaceous_veg_survey-quadrat_repeat')
  const extra = g('herbaceous_veg_survey-additional_species_repeat')
  const regis = g('register_vegetation_plots')
  const cent = g('centroids')
  const vp = g('vegplots')
  const sp = g('species')
  const se = g('species_extra')
  const sei = g('species_extra_ids')
  const team = g('project_team')

  const s = useMemo(() => {
    if (!survey || !quad || !extra || !regis || !cent || !vp || !sp || !se || !sei || !team) return null
    const ids = (ds: Dataset, col: string) => new Set(ds.rows.map((r) => r[col]).filter((v) => v !== null))
    const rate = (vals: (string | number | null)[], target: Set<unknown>) => {
      const v = vals.filter((x) => x !== null && x !== '')
      return { k: v.filter((x) => target.has(x)).length, n: v.length }
    }
    const seKey = new Set(se.rows.filter((r) => typeof r.unknown_index === 'number').map((r) => `${r.group_type === 'woody' ? 'wood' : r.group_type}_${String(r.unknown_index).padStart(3, '0')}`))
    const joins = [
      { from: 'Quadrats', to: 'Herbaceous surveys', key: 'PARENT_KEY → KEY', ...rate(quad.rows.map((r) => r.PARENT_KEY as string), ids(survey, 'KEY')), id: 'herbaceous_veg_survey-quadrat_repeat' },
      { from: 'Additional species', to: 'Quadrats', key: 'PARENT_KEY → KEY', ...rate(extra.rows.map((r) => r.PARENT_KEY as string), ids(quad, 'KEY')), id: 'herbaceous_veg_survey-additional_species_repeat' },
      { from: 'Herbaceous surveys', to: 'Veg plots', key: 'selected_plot_uuid → __id', ...rate(survey.rows.map((r) => r['plot_selection-selected_plot_uuid'] as string), ids(vp, '__id')), id: 'herbaceous_veg_survey' },
      { from: 'Plot registrations', to: 'Centroids', key: 'selected_plot_uuid → __id', ...rate(regis.rows.map((r) => r['plot_selection-selected_plot_uuid'] as string), ids(cent, '__id')), id: 'register_vegetation_plots' },
      { from: 'Veg plots', to: 'Centroids', key: 'plot_uuid → __id', ...rate(vp.rows.map((r) => r.plot_uuid as string), ids(cent, '__id')), id: 'vegplots' },
      { from: 'Quadrats (list species)', to: 'Species list', key: 'selected_herb_species_uuids → __id (each token)', ...rate(quad.rows.flatMap((r) => splitTokens(r['herb_species-selected_herb_species_uuids'])), ids(sp, '__id')), id: 'herbaceous_veg_survey-quadrat_repeat' },
      { from: 'Additional species (re-used)', to: 'Species extra', key: 'select_reuse_unknown / select_reuse_missing → __id', ...rate(extra.rows.flatMap((r) => [r.select_reuse_unknown as string, r.select_reuse_missing as string]), ids(se, '__id')), id: 'herbaceous_veg_survey-additional_species_repeat' },
      { from: 'Species extra IDs', to: 'Species extra', key: 'species_number → group_type + unknown_index (e.g. herb_040)', ...rate(sei.rows.map((r) => r.species_number as string), seKey), id: 'species_extra_ids' },
      { from: 'Herbaceous surveys', to: 'Project team', key: 'recorder_uuid → __id', ...rate(survey.rows.map((r) => r['field_team_specifics-recorder_uuid'] as string), ids(team, '__id')), id: 'herbaceous_veg_survey' },
    ]
    const starts = num(survey.rows, 'survey_begin-start_time')
    const regStarts = num(regis.rows, 'survey_begin-start_time')
    return {
      joins,
      plotsSurveyed: distinct(survey.rows, 'plot_selection-plot_name'),
      primary: cent.rows.filter((r) => r.sample_status === 'primary').length,
      backup: cent.rows.filter((r) => r.sample_status === 'backup').length,
      herbSp: sp.rows.filter((r) => splitTokens(r.groups).includes('herbaceous')).length,
      seActive: se.rows.filter((r) => r.choice_status === 'active').length,
      listOcc: num(quad.rows, 'n_list_species').reduce((a, b) => a + b, 0),
      devices: distinct(survey.rows, 'DeviceID'),
      dates: range([...starts, ...regStarts]),
      rejected: survey.rows.filter((r) => r.ReviewState === 'rejected').length,
    }
  }, [survey, quad, extra, regis, cent, vp, sp, se, sei, team])

  if (!s || !survey || !quad || !extra || !regis || !cent || !sp || !se) return <div className="empty">Vegetation files not found.</div>

  const files: { id: string; row: string }[] = [
    { id: 'register_vegetation_plots', row: 'one plot set up in the field: transect endpoints A/B, midpoint, habitat' },
    { id: 'herbaceous_veg_survey', row: 'one herbaceous survey of one plot (a form submission)' },
    { id: 'herbaceous_veg_survey-quadrat_repeat', row: 'one quadrat of a survey (20 per survey) with the list species seen' },
    { id: 'herbaceous_veg_survey-additional_species_repeat', row: 'one species in a quadrat that was not on the project list' },
    { id: 'centroids', row: 'one prescribed plot location from the sampling design' },
    { id: 'vegplots', row: 'one registered plot (written by the registration form)' },
    { id: 'species', row: 'one species on the project list' },
    { id: 'species_extra', row: 'one provisional taxon slot (unknown or missing species)' },
    { id: 'species_extra_ids', row: 'one curated identification of a provisional taxon' },
    { id: 'project_team', row: 'one field team member' },
    { id: 'surveys', row: 'one survey definition (project | area | target group | method)' },
  ]

  return (
    <div className="summary">
      <TaskCard challenge="vegetation" />

      <div className="stats-row">
        <Stat tipKey="sum.v.surveys" label="Herbaceous surveys" value={survey.rows.length} sub={`${s.plotsSurveyed} plots · ${s.rejected} rejected in review`} />
        <Stat tipKey="sum.v.quadrats" label="Quadrats" value={fmtInt(quad.rows.length)} sub={`${fmtInt(s.listOcc)} list-species records`} />
        <Stat tipKey="sum.v.extra" label="Additional species records" value={fmtInt(extra.rows.length)} sub={`${s.seActive} provisional taxa in use`} />
        <Stat tipKey="sum.v.plots" label="Plots registered" value={regis.rows.length} sub={`of ${s.primary} primary + ${s.backup} backup centroids`} />
        <Stat tipKey="sum.v.dates" label="Field dates" value={`${fmtDate(s.dates[0], false).slice(5)} → ${fmtDate(s.dates[1], false).slice(5)}`} sub={`${fmtDate(s.dates[0], false).slice(0, 4)} · ${s.devices} devices (UTC)`} />
      </div>

      <Section title="Files and what one row means" tipKey="sum.v.files" sub="Field submissions first (what the teams recorded), then the reference tables the forms read and write.">
        <SumTable
          cols={[
            { key: 'f', label: 'Table' },
            { key: 'g', label: 'Group' },
            { key: 'rows', label: 'Rows', num: true },
            { key: 'cols', label: 'Columns', num: true, tip: 'Columns in the CSV (derived columns not counted).' },
            { key: 'row', label: 'One row is' },
          ]}
          rows={files
            .map((f) => ({ f, ds: reg.get(f.id) }))
            .filter((x) => x.ds)
            .map(({ f, ds }) => ({
              f: (
                <button type="button" className="btn link sm" onClick={() => onOpen(f.id)}>
                  {ds!.title}
                </button>
              ),
              g: <span className="muted small">{ds!.group}</span>,
              rows: fmtInt(ds!.rows.length),
              cols: ds!.columns.filter((c) => !c.derived).length,
              row: f.row,
            }))}
        />
      </Section>

      <Section title="How the tables join" tipKey="sum.v.joins" sub="Each child table points to its parent with an id. The match column counts how many references resolve — anything below 100% is a referential problem to flag.">
        <SumTable
          cols={[
            { key: 'from', label: 'From' },
            { key: 'to', label: 'To' },
            { key: 'key', label: 'Key' },
            { key: 'm', label: 'Resolved', num: true, tip: 'References that find a matching row in the target table, out of all non-empty references.' },
          ]}
          rows={s.joins.map((j) => ({
            from: (
              <button type="button" className="btn link sm" onClick={() => onOpen(j.id)}>
                {j.from}
              </button>
            ),
            to: j.to,
            key: <code>{j.key}</code>,
            m: (
              <span className={j.k < j.n ? 'warn-text' : 'ok-text'}>
                {fmtInt(j.k)} / {fmtInt(j.n)} ({fmtPct(j.n ? j.k / j.n : NaN, 0)})
              </span>
            ),
          }))}
        />
        <ul className="facts">
          <li>
            The project species list has <b>{fmtInt(sp.rows.length)}</b> species ({s.herbSp} herbaceous). Species seen in a quadrat but not on that list are recorded as <i>additional species</i> and create or re-use a provisional taxon in <i>Species extra</i> ({s.seActive} of {fmtInt(se.rows.length)} slots in use).
          </li>
          <li>Species extra IDs is the curated table that resolves provisional taxa (herb_NNN / wood_NNN) to names.</li>
          <li>QA/QC findings will be flagged here as the analysis progresses — the source data is never edited.</li>
        </ul>
      </Section>
    </div>
  )
}

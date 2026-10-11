/**
 * Challenge 2: the Vegetation QA/QC dashboard (the views specified in challenge2/Q2_tech_handover.md §6).
 *
 * Every number and flag is precomputed by challenge2/src/run_challenge2.py and embedded at build time
 * from challenge2/outputs/dashboard_results.json. The page never re-implements a rule or a statistic:
 * it filters, plots and links what the pipeline produced, so what you see here is what the Tech team's
 * job would publish. Flags never change data; each one links back to its source table and key.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import R from '../../../challenge2/outputs/dashboard_results.json'
import { axisStyle, baseLayout } from '../charts/build'
import { fmtInt, fmtPct } from '../data/stats'
import { SERIES, type ThemeTokens } from '../lib/palette'
import type { Dataset } from '../data/types'
import { Plot } from './Plot'
import { Segmented, Stat, Toggle } from './ui'

// ── embedded data ────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>
interface ColTable {
  columns: string[]
  rows: unknown[][]
}
const rowsOf = (t: ColTable): Row[] => t.rows.map((r) => Object.fromEntries(t.columns.map((c, i) => [c, r[i]])))

const D = R as unknown as {
  run_id: string
  catalogue_version: string
  status_counts: Record<string, number>
  fail_by_severity: Record<string, number>
  overview: Row
  thresholds: Record<string, unknown>
  [k: string]: unknown
}
const T = (k: string) => rowsOf(D[k] as ColTable)
const FLAGS = T('flags')
const RULES = T('rules')
const SUBS = T('submissions')
const TIMELINE = T('timeline')
const PLOTS = T('plots')
const TRANSECTS = T('transects')
const QUADRATS = T('quadrats')
const EFF_PLAN = T('effort_plan')
const EFF_PLOTS = T('effort_plots')
const EFF_CURVES = T('effort_curves')
const EFF_PROJECT = T('effort_project')
const EFF_REPEAT = T('effort_repeatability')
const EFF_SENS = T('effort_sensitivity')
const TAXA = T('taxa')
const SUGG = T('suggestions')
const O = D.overview

type Sev = 'error' | 'warning' | 'info'
const SEVS: Sev[] = ['error', 'warning', 'info']
const SEV_COLOR: Record<Sev | 'pass', string> = { error: '#e34948', warning: '#eda100', info: '#2a78d6', pass: '#1f9e8c' }
const SEV_RANK: Record<string, number> = { info: 1, warning: 2, error: 3 }
const GROUPS: Record<string, string> = {
  A: 'Structure & references', B: 'Submission lifecycle', C: 'Form rules', D: 'Registration geometry', E: 'Quadrats: position & timing',
  F: 'Taxonomy', G: 'Plausibility', J: 'Plan vs execution', K: 'Form & platform', X: 'Entity vs form', P: 'Column profiling',
}
/** Fixed decimals (fmtNum in data/stats takes significant digits); '—' for missing values. */
const fx = (v: unknown, d = 2): string => (typeof v === 'number' && Number.isFinite(v) ? v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }) : '—')
/** Project-wide findings that hit every plot alike (layout, walking order, time-zone label, altitude offset, geohash centres, deployed-form differences): left out of per-plot colouring so plots stay comparable. */
const SYSTEMIC = new Set(['D05', 'E13', 'B12', 'C14', 'C17', 'E14', 'J04'])
const plotFlags = (flags: Row[], plot: string) => flags.filter((f) => f.plot_name === plot && f.canonical && !SYSTEMIC.has(f.rule_id))
const short = (p: string | null | undefined) => (p ? String(p).replace('SavMon_LW_', '') : '')
const ruleTitle = Object.fromEntries(RULES.map((r) => [r.rule_id, r.title as string]))

// ── tabs & routing (#/qa:vegetation/<tab>) ───────────────────────────────────

type Tab = 'overview' | 'flags' | 'submissions' | 'map' | 'plots' | 'taxonomy' | 'effort' | 'rules' | 'tonight'
const TABS: { key: Tab; label: string; sub: string }[] = [
  { key: 'overview', label: 'Overview', sub: 'headline' },
  { key: 'flags', label: 'All flags', sub: `${FLAGS.length}` },
  { key: 'submissions', label: 'Submissions', sub: 'timeline' },
  { key: 'map', label: 'Map', sub: 'transects' },
  { key: 'plots', label: 'Plots', sub: `${PLOTS.filter((p) => p.registered).length}` },
  { key: 'taxonomy', label: 'Taxonomy', sub: 'curation queue' },
  { key: 'effort', label: 'Sampling effort', sub: 'completeness' },
  { key: 'rules', label: 'Rules', sub: `${RULES.length}` },
  { key: 'tonight', label: 'Field feedback', sub: 'check tonight' },
]
const tabFromHash = (h: string): Tab | null => {
  const m = /^#\/qa:vegetation\/(\w+)/.exec(h)
  return m && TABS.some((t) => t.key === m[1]) ? (m[1] as Tab) : null
}

export interface FlagFilter {
  rule?: string
  plot?: string
  group?: string
}

/** Shared filters: they apply to every view built from flags, submissions or plots (Overview, All flags,
 * Submissions, Map, Plots, Taxonomy queue, Field feedback). An active filter keeps only items that HAVE the
 * attribute and match it, so project-level flags without a device or date are hidden while it is on. */
interface Shared {
  replicate: string
  stratum: string
  device: string
  recorder: string
  from: string
  to: string
}
const NO_FILTER: Shared = { replicate: '', stratum: '', device: '', recorder: '', from: '', to: '' }
export interface View {
  F: Row[]
  S: Row[]
  TL: Row[]
  P: Row[]
  active: boolean // any shared filter set: whole-run figures must say so
}
const localDay = (iso: unknown) => (iso ? new Date(new Date(String(iso)).getTime() + 3 * 3.6e6).toISOString().slice(0, 10) : '') // EAT = UTC + 3 h
const strataOf = Object.fromEntries(PLOTS.map((p) => [p.plot_name, p.stratum]))

function applyShared(g: Shared): View {
  const inDays = (day: string) => (!g.from || (day && day >= g.from)) && (!g.to || (day && day <= g.to))
  const F = FLAGS.filter((f) => (!g.replicate || f.replicate === g.replicate) && (!g.stratum || f.stratum === g.stratum) && (!g.device || f.device === g.device) && (!g.recorder || f.recorder === g.recorder) && inDays(f.day))
  const S = SUBS.filter((r) => (!g.replicate || r.replicate === g.replicate) && (!g.stratum || strataOf[r.plot_name] === g.stratum) && (!g.device || r.device === g.device) && (!g.recorder || r.recorder === g.recorder) && inDays(localDay(r.start_utc)))
  const TL = TIMELINE.filter((r) => (!g.replicate || r.replicate === g.replicate) && (!g.stratum || strataOf[r.plot_name] === g.stratum) && (!g.device || r.device === g.device) && (!g.recorder || r.recorder === g.recorder) && inDays(localDay(r.start)))
  // device / recorder / date describe visits: keep the plots visited (surveyed or registered) under them
  const visit = Boolean(g.device || g.recorder || g.from || g.to)
  // a plot row is one replicate: it is visited if its survey in THAT replicate passes, or its registration does
  const surveyed = new Set(S.map((r) => `${r.plot_name}|${r.replicate}`))
  const registered = new Set(TL.filter((r) => r.form === 'registration').map((r) => r.plot_name))
  const P = PLOTS.filter((p) => (!g.stratum || p.stratum === g.stratum) && (!g.replicate || p.replicate === g.replicate) && (!visit || surveyed.has(`${p.plot_name}|${p.replicate}`) || registered.has(p.plot_name)))
  return { F, S, TL, P, active: Object.values(g).some(Boolean) }
}

function SharedFilters({ g, setG }: { g: Shared; setG: (g: Shared) => void }) {
  const opts = (vals: unknown[]) => [...new Set(vals.filter(Boolean).map(String))].sort()
  const sel = (key: keyof Shared, label: string, values: string[]) => (
    <select className="select" value={g[key]} onChange={(e) => setG({ ...g, [key]: e.target.value })} aria-label={label}>
      <option value="">All {label}</option>
      {values.map((v) => (
        <option key={v} value={v}>
          {v.replace('demo-device-', 'device ')}
        </option>
      ))}
    </select>
  )
  const days = opts(FLAGS.map((f) => f.day))
  const active = Object.values(g).some(Boolean)
  return (
    <div className="qa-filters qa-shared">
      <span className="small muted">Filters for all views:</span>
      {sel('replicate', 'replicates', opts(SUBS.map((r) => r.replicate)))}
      {sel('stratum', 'strata', opts(PLOTS.map((p) => p.stratum)))}
      {sel('device', 'devices', opts(TIMELINE.map((r) => r.device)))}
      {sel('recorder', 'recorders', opts(TIMELINE.map((r) => r.recorder)))}
      {sel('from', 'days (from)', days)}
      {sel('to', 'days (to)', days)}
      {active && (
        <button type="button" className="btn ghost sm" onClick={() => setG(NO_FILTER)}>
          Clear filters
        </button>
      )}
    </div>
  )
}

/** Where each flag's source table lives in the embedded data, and its key column. */
const SOURCE_DATASET: Record<string, [string, string]> = {
  survey: ['herbaceous_veg_survey', 'KEY'],
  quadrat_repeat: ['herbaceous_veg_survey-quadrat_repeat', 'KEY'],
  additional_species_repeat: ['herbaceous_veg_survey-additional_species_repeat', 'KEY'],
  registration: ['register_vegetation_plots', 'KEY'],
  centroids: ['centroids', '__id'],
  vegplots: ['vegplots', '__id'],
  species: ['species', '__id'],
  species_extra: ['species_extra', '__id'],
  species_extra_ids: ['species_extra_ids', 'species_number'],
}
export interface RecordRef {
  table: string
  key: string
  flag?: Row
}

/** The original record behind a flag, exactly as exported (from the CSVs embedded in this page). */
function RecordPanel({ rec, reg, onOpen, onClose }: { rec: RecordRef; reg: Map<string, Dataset>; onOpen: (id: string) => void; onClose: () => void }) {
  const src = SOURCE_DATASET[rec.table]
  const ds = src ? reg.get(src[0]) : undefined
  const row = ds?.rows.find((r) => String(r[src![1]]) === rec.key || (src![1] === 'KEY' && String(r[src![1]]) === rec.key))
  const cols = ds ? ds.columns.filter((c) => !c.derived) : []
  return (
    <section className="sum-section qa-record">
      <div className="sum-section-head">
        <div>
          <h2>Source record</h2>
          <p className="muted small">
            <code>{rec.table}</code> · <code>{rec.key}</code>
            {rec.flag ? ` · flag ${rec.flag.flag_id} (${rec.flag.rule_id})` : ''}
          </p>
        </div>
        <div className="qa-filters">
          {ds && (
            <button type="button" className="btn ghost sm" onClick={() => onOpen(ds.id)}>
              Open the {ds.title} table
            </button>
          )}
          <button type="button" className="btn ghost sm" onClick={() => navigator.clipboard?.writeText(rec.key)}>
            Copy key
          </button>
          <button type="button" className="btn ghost sm" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
      {!src && <p className="muted">This flag refers to {rec.table === 'form' ? 'the form definition' : rec.table.startsWith('reference/') ? 'a cached reference file' : 'a derived or project-level item'}, not a data record.</p>}
      {src && !row && <p className="muted">Record not found in the embedded {src[0]}.csv (the dashboard embeds the take-home files).</p>}
      {row && (
        <div className="table-wrap auto qa-record-table">
          <table className="data-table compact">
            <tbody>
              {cols.map((c) => (
                <tr key={c.name}>
                  <td className="muted small">{c.name}</td>
                  <td className="small">{row[c.name] == null ? '' : c.type === 'datetime' && typeof row[c.name] === 'number' ? new Date(row[c.name] as number).toISOString() : String(row[c.name])}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

export function VegetationQA({ tokens: t, reg, onOpen }: { tokens: ThemeTokens; reg: Map<string, Dataset>; onOpen: (id: string) => void }) {
  const [tab, setTabState] = useState<Tab>(() => tabFromHash(window.location.hash) ?? 'overview')
  const [ff, setFf] = useState<FlagFilter>({})
  const [g, setG] = useState<Shared>(NO_FILTER)
  const [rec, setRec] = useState<RecordRef | null>(null)
  const d = useMemo(() => applyShared(g), [g])
  const setTab = (next: Tab) => {
    setTabState(next)
    window.history.replaceState(null, '', `#/qa:vegetation/${next}`)
  }
  useEffect(() => {
    const on = () => {
      const want = tabFromHash(window.location.hash)
      if (want) setTabState(want)
    }
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])
  const showFlags = (f: FlagFilter) => {
    setFf(f)
    setTab('flags')
  }
  const ctx = { t, showFlags, d, openRecord: (r: RecordRef) => setRec(r) }
  return (
    <div className="summary">
      <div className="task-card">
        <div className="ds-eyebrow">Challenge 2 · Vegetation QA/QC dashboard</div>
        <h1>Is the herbaceous survey data fit for richness and diversity?</h1>
        <p className="task-sub">
          {RULES.length} rules (each with its SOP / form source, severity and metric impact) run over every submission, plot, quadrat and record. Each flag points to its source row; nothing is corrected. Every number on this page comes from <code>challenge2/src/run_challenge2.py</code> (run <code>{D.run_id}</code>); the report is <code>challenge2/Q1_data_quality_report.md</code> and the specification of this dashboard is <code>challenge2/Q2_tech_handover.md</code>.
        </p>
      </div>
      <div className="paper-tabs" role="tablist" aria-label="QA/QC views">
        {TABS.map((x) => (
          <button key={x.key} type="button" role="tab" aria-selected={tab === x.key} className={`paper-tab ${tab === x.key ? 'on' : ''}`} onClick={() => setTab(x.key)}>
            <span>{x.label}</span>
            <span className="role-dot">{x.sub}</span>
          </button>
        ))}
      </div>
      {tab !== 'rules' && tab !== 'effort' ? (
        <SharedFilters g={g} setG={setG} />
      ) : (
        <p className="small muted">This view covers the whole run; the shared filters apply to the other views.</p>
      )}
      {rec && <RecordPanel rec={rec} reg={reg} onOpen={onOpen} onClose={() => setRec(null)} />}
      {tab === 'overview' && <OverviewTab {...ctx} />}
      {tab === 'flags' && <FlagsTab {...ctx} initial={ff} />}
      {tab === 'submissions' && <SubmissionsTab {...ctx} />}
      {tab === 'map' && <MapTab {...ctx} />}
      {tab === 'plots' && <PlotsTab {...ctx} />}
      {tab === 'taxonomy' && <TaxonomyTab {...ctx} />}
      {tab === 'effort' && <EffortTab {...ctx} />}
      {tab === 'rules' && <RulesTab {...ctx} />}
      {tab === 'tonight' && <TonightTab {...ctx} />}
    </div>
  )
}

interface Ctx {
  t: ThemeTokens
  showFlags: (f: FlagFilter) => void
  d: View
  openRecord: (r: RecordRef) => void
}

// ── shared bits ──────────────────────────────────────────────────────────────

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

export function SevChip({ s }: { s: string }) {
  const cls = s === 'error' ? 'qa-error' : s === 'warning' ? 'qa-flag' : s === 'pass' ? 'qa-pass' : 'qa-info'
  const glyph = s === 'error' ? '✕ ' : s === 'warning' ? '⚑ ' : s === 'pass' ? '✓ ' : 'ℹ '
  return (
    <span className={`qa-chip ${cls}`} data-tip={s === 'error' ? 'Violates a documented requirement or prevents reliable interpretation' : s === 'warning' ? 'Plausible, needs review' : s === 'pass' ? 'Checked and passed' : 'Context'}>
      {glyph}
      {s}
    </span>
  )
}

function RuleLink({ id, onClick }: { id: string; onClick: () => void }) {
  return (
    <button type="button" className="link-btn" data-tip={ruleTitle[id]} data-tip-title={id} onClick={onClick}>
      {id}
    </button>
  )
}

interface ColSpec {
  key: string
  label: string
  num?: boolean
  render?: (r: Row) => ReactNode
  sortValue?: (r: Row) => number | string
  tip?: string
}

/** Sortable table (click a header), capped at `limit` rows with a "show all" button. */
function DataTable({ cols, rows, limit = 60, initialSort, className = '' }: { cols: ColSpec[]; rows: Row[]; limit?: number; initialSort?: { key: string; desc?: boolean }; className?: string }) {
  const [sort, setSort] = useState(initialSort ?? null)
  const [all, setAll] = useState(false)
  const sorted = useMemo(() => {
    if (!sort) return rows
    const c = cols.find((x) => x.key === sort.key)
    const val = (r: Row) => (c?.sortValue ? c.sortValue(r) : r[sort.key])
    return [...rows].sort((a, b) => {
      const x = val(a)
      const y = val(b)
      if (x == null || y == null) return x == null && y == null ? 0 : x == null ? 1 : -1 // missing values last, in both directions
      const cmp = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true })
      return sort.desc ? -cmp : cmp
    })
  }, [rows, sort, cols])
  const shown = all ? sorted : sorted.slice(0, limit)
  return (
    <>
      <div className="table-wrap auto">
        <table className={`data-table sum-table ${className}`}>
          <thead>
            <tr>
              {cols.map((c) => (
                <th key={c.key} className={`${c.num ? 'num' : ''} sortable`} data-tip={c.tip} onClick={() => setSort((s) => (s?.key === c.key ? { key: c.key, desc: !s.desc } : { key: c.key, desc: !!c.num }))}>
                  {c.label}
                  {sort?.key === c.key ? (sort.desc ? ' ▾' : ' ▴') : ''}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((r, i) => (
              <tr key={i}>
                {cols.map((c) => (
                  <td key={c.key} className={c.num ? 'num' : ''}>
                    {c.render ? c.render(r) : r[c.key] == null ? '' : typeof r[c.key] === 'number' ? (Number.isInteger(r[c.key]) ? fmtInt(r[c.key]) : fx(r[c.key], 3)) : String(r[c.key])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {sorted.length > limit && (
        <button type="button" className="btn ghost sm" onClick={() => setAll(!all)}>
          {all ? `Show the first ${limit}` : `Show all ${fmtInt(sorted.length)} rows`}
        </button>
      )}
    </>
  )
}

function downloadCsv(name: string, rows: Row[], cols: string[]) {
  const esc = (v: unknown) => {
    const s = v == null ? '' : String(v)
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const text = [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n')
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv' }))
  a.download = name
  a.click()
  URL.revokeObjectURL(a.href)
}

const worstOf = (rows: Row[]): Sev | null => {
  let w = 0
  for (const r of rows) w = Math.max(w, SEV_RANK[r.severity] ?? 0)
  return w ? (['info', 'warning', 'error'][w - 1] as Sev) : null
}

// ── overview ─────────────────────────────────────────────────────────────────

const HEADLINES: { title: string; text: string; rules: string[] }[] = [
  { title: 'Shrubland stratum not sampled', text: '0 of 6 primary points registered: no richness for shrubland.', rules: ['J01'] },
  { title: 'The data’s provenance needs confirming', text: 'The whole dataset, NS’s own prescribed points included, sits ~705 m below the SRTM terrain at its coordinates; 20 of the 90 identified taxa GBIF could check have no Kenyan record; the transport list offers "Mokoro". A reason to question provenance, not proof of origin: NS to confirm (C-7).', rules: ['E14', 'F10'] },
  { title: 'Taxon names need curation', text: '23 likely misspellings (GBIF-checked); curation-table typos and kept misspellings; several ids for one species; 23 unresolved unknowns (15% of records).', rules: ['F03', 'F13', 'F08', 'F07'] },
  { title: 'Species possibly lost', text: '10 quadrats declare additional species but have no rows; one row has no taxon.', rules: ['C04', 'C08'] },
  { title: 'Transects off their registration', text: 'Plot 05 offset 20 m; Plot 14 midpoint 33.6 m out; Plots 19/27 far too short; Plots 07/15 partly covered.', rules: ['E03', 'D01', 'D03', 'E05'] },
  { title: 'Systematic E–W layout and out-and-back walking', text: '30/30 transects 49–89° off N–S; 32/32 surveys out-and-back. A protocol question (C-3), not 30 field errors.', rules: ['D05', 'E13'] },
  { title: 'Form calculation bug', text: '"Quadrats with species" wrong in 23/32 surveys: a path error in the form.', rules: ['C07', 'K02'] },
  { title: 'Deployed form differs from the form file', text: 'Every registration stores its measured midpoint’s geohash (the form file copies the centroid’s), and every survey a lower-case replicate label. Edits = 0 everywhere: no sign of manual edits.', rules: ['C17', 'C14'] },
  { title: 'Late uploads: provisional-id risk', text: 'Devices 02/03 started from an outdated species list; here the reused ids were the same plants, so no record is wrong.', rules: ['B06', 'B10', 'F09', 'K03'] },
]

function OverviewTab({ d, t, showFlags }: Ctx) {
  const byGroup = useMemo(() => {
    const groups = Object.keys(GROUPS)
    return SEVS.map((s) => ({
      type: 'bar',
      orientation: 'h',
      name: s,
      y: groups.map((g) => GROUPS[g]),
      x: groups.map((g) => d.F.filter((f) => f.group === g && f.severity === s).length),
      marker: { color: SEV_COLOR[s], line: { color: t.surface, width: 1 } },
      customdata: groups,
      hovertemplate: `%{y}: %{x} ${s}<extra></extra>`,
    }))
  }, [t, d.F])
  const clean = RULES.filter((r) => r.fail === 0 && r.could_not_check === 0 && r.pass > 0) // checked everywhere AND passed
  const canon = d.S.filter((r) => r.canonical)
  const sevCount = (sv: Sev) => d.F.filter((f) => f.severity === sv).length
  const cnc = D.status_counts.could_not_check ?? 0
  return (
    <>
      <div className="stats-row">
        <Stat
          label={d.active ? 'Plots surveyed (filtered)' : 'Plots surveyed'}
          value={`${new Set(canon.map((r) => r.plot_name)).size} of ${O.primary_points_planned}`}
          sub={d.active ? `canonical surveys under the filters · ${O.plots_registered} registered in the whole run` : `primary points planned · ${O.plots_registered} registered, ${O.plots_viable} viable`}
        />
        <Stat label={d.active ? 'Quadrats (filtered)' : 'Quadrats'} value={fmtInt(canon.reduce((a, r) => a + (r.n_quadrats ?? 0), 0))} sub={`${canon.length} canonical surveys of ${d.S.length} submissions${d.active ? ' under the filters' : ''}`} />
        <Stat label={d.active ? 'Taxa (whole run)' : 'Taxa'} value={`${O.taxa_raw} → ${O.taxa_resolved}`} sub={`raw → resolved · ${O.taxa_resolved_identified} identified${d.active ? ' · not filtered (a union of taxa needs the records)' : ''}`} />
        <Stat
          label={d.active ? 'Flags (filtered)' : 'Flags'}
          value={<span>{fmtInt(sevCount('error'))} <span className="muted small">err</span> · {fmtInt(sevCount('warning'))} <span className="muted small">warn</span> · {fmtInt(sevCount('info'))} <span className="muted small">info</span></span>}
          sub={d.active ? `${fmtInt(d.F.length)} of ${fmtInt(FLAGS.length)} flags · checks passed: whole run` : `${fmtInt(D.status_counts.pass ?? 0)} checks passed · ${cnc} could not be checked`}
        />
      </div>
      <Section title="What matters for richness and diversity" sub="Ranked as in the report. Click a rule to see its flags.">
        <div className="qa-headlines">
          {HEADLINES.map((h, i) => {
            const fl = d.F.filter((f) => h.rules.includes(f.rule_id))
            const w = worstOf(fl)
            return (
              <div key={h.title} className="qa-headline">
                <div className="qa-headline-num">{i + 1}</div>
                <div>
                  <div className="qa-headline-title">
                    {h.title} {w && <SevChip s={w} />}
                  </div>
                  <p className="small">{h.text}</p>
                  <div className="qa-headline-rules">
                    {h.rules.map((r) => (
                      <RuleLink key={r} id={r} onClick={() => showFlags({ rule: r })} />
                    ))}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      </Section>
      <div className="sum-grid two">
        <Section title="Flags by rule group" sub="Click a bar to list that group's flags.">
          <div className="chart-card">
            <Plot
              data={byGroup}
              layout={{ ...baseLayout(t), barmode: 'stack', margin: { l: 190, r: 16, t: 28, b: 40 }, xaxis: { ...axisStyle(t), title: { text: 'flags' } }, yaxis: { ...axisStyle(t), autorange: 'reversed' } }}
              height={360}
              onClickIndex={(g) => showFlags({ group: g as string })}
              filename="flags_by_group"
            />
          </div>
        </Section>
        <Section title="What passed everywhere" sub={`${clean.length} of ${RULES.length} rules were run on every entity and found nothing (rules with any “could not check” result are not listed). Whole run, not filtered.`}>
          <div className="qa-pass-list">
            {clean.map((r) => (
              <span key={r.rule_id} className="qa-chip qa-pass" data-tip={`${r.source}\n${r.pass} entities checked`} data-tip-title={r.rule_id}>
                ✓ {r.rule_id} {r.title}
              </span>
            ))}
          </div>
        </Section>
      </div>
    </>
  )
}

// ── all flags ────────────────────────────────────────────────────────────────

function FlagsTab({ d, showFlags, openRecord, initial }: Ctx & { initial: FlagFilter }) {
  const [sev, setSev] = useState<Record<Sev, boolean>>({ error: true, warning: true, info: true })
  const [group, setGroup] = useState(initial.group ?? '')
  const [rule, setRule] = useState(initial.rule ?? '')
  const [plot, setPlot] = useState(initial.plot ?? '')
  const [q, setQ] = useState('')
  const [canonOnly, setCanonOnly] = useState(true)
  useEffect(() => {
    setGroup(initial.group ?? '')
    setRule(initial.rule ?? '')
    setPlot(initial.plot ?? '')
  }, [initial])
  const rows = useMemo(
    () =>
      d.F.filter(
        (f) =>
          sev[f.severity as Sev] &&
          (!group || f.group === group) &&
          (!rule || f.rule_id === rule) &&
          (!plot || f.plot_name === plot) &&
          (!canonOnly || f.canonical) &&
          (!q || `${f.rule_id} ${f.title} ${f.plot_name} ${f.observed} ${f.message} ${f.entity_key}`.toLowerCase().includes(q.toLowerCase())),
      ),
    [d.F, sev, group, rule, plot, q, canonOnly],
  )
  const plots = [...new Set(d.F.map((f) => f.plot_name).filter(Boolean))].sort()
  const rules = [...new Set(d.F.map((f) => f.rule_id))].sort()
  return (
    <>
      <div className="qa-filters">
        {SEVS.map((s) => (
          <Toggle key={s} checked={sev[s]} onChange={(v) => setSev({ ...sev, [s]: v })} label={`${s} (${d.F.filter((f) => f.severity === s).length})`} />
        ))}
        <select className="select" value={group} onChange={(e) => setGroup(e.target.value)}>
          <option value="">All groups</option>
          {Object.entries(GROUPS).map(([k, v]) => (
            <option key={k} value={k}>
              {k} · {v}
            </option>
          ))}
        </select>
        <select className="select" value={rule} onChange={(e) => setRule(e.target.value)}>
          <option value="">All rules</option>
          {rules.map((r) => (
            <option key={r} value={r}>
              {r} · {ruleTitle[r]}
            </option>
          ))}
        </select>
        <select className="select" value={plot} onChange={(e) => setPlot(e.target.value)}>
          <option value="">All plots</option>
          {plots.map((p) => (
            <option key={p} value={p}>
              {short(p)}
            </option>
          ))}
        </select>
        <input className="input" placeholder="Search text…" value={q} onChange={(e) => setQ(e.target.value)} />
        <Toggle checked={canonOnly} onChange={setCanonOnly} label="Canonical surveys only" />
        <button type="button" className="btn ghost sm" onClick={() => downloadCsv('qa_flags_filtered.csv', rows, ['rule_id', 'severity', 'title', 'plot_name', 'entity_type', 'entity_key', 'source_table', 'source_key', 'observed', 'expected', 'message'])}>
          Download {fmtInt(rows.length)} rows (CSV)
        </button>
      </div>
      <p className="muted small">
        {fmtInt(rows.length)} of {fmtInt(d.F.length)} flags. Click a source to see the original record (as exported) and copy its full key for ODK Central. “Canonical surveys only” hides flags on the two rejected repeat surveys.
      </p>
      <DataTable
        className="qa-table"
        rows={rows}
        limit={100}
        initialSort={{ key: 'sev', desc: true }}
        cols={[
          { key: 'rule_id', label: 'Rule', render: (r) => <RuleLink id={r.rule_id} onClick={() => setRule(r.rule_id)} /> },
          { key: 'sev', label: 'Severity', render: (r) => <SevChip s={r.severity} />, sortValue: (r) => SEV_RANK[r.severity] },
          { key: 'plot_name', label: 'Plot', render: (r) => (r.plot_name ? <button type="button" className="link-btn" onClick={() => setPlot(r.plot_name)}>{short(r.plot_name)}</button> : <span className="muted">{r.entity_type}</span>) },
          { key: 'observed', label: 'Observed', render: (r) => <span className="small">{r.observed}</span> },
          { key: 'expected', label: 'Expected', render: (r) => <span className="small muted">{r.expected}</span> },
          { key: 'message', label: 'Why / action', render: (r) => <span className="small">{r.message}</span> },
          {
            key: 'source',
            label: 'Source row',
            render: (r) => (
              <button type="button" className="link-btn small" data-tip={`Open the original record\n${r.source_table} · ${r.source_key || r.entity_key}\nflag ${r.flag_id}`} onClick={() => openRecord({ table: r.source_table, key: r.source_key || r.entity_key, flag: r })}>
                {r.source_table}
                {r.source_key ? ` · …${String(r.source_key).slice(-14)}` : ''}
              </button>
            ),
            sortValue: (r) => `${r.source_table}${r.source_key}`,
          },
        ]}
      />
      <p className="small muted">Tip: the Overview, Plots and Field feedback views link here with a filter already set ({rule || group || plot ? 'one is active now' : 'none active'}). <button type="button" className="link-btn" onClick={() => showFlags({})}>Clear all filters</button></p>
    </>
  )
}

// ── submissions ──────────────────────────────────────────────────────────────

function SubmissionsTab({ d, t }: Ctx) {
  const days = [...new Set(d.TL.map((r) => String(r.start).slice(0, 10)))].sort()
  const [day, setDay] = useState('2026-05-26')
  const fig = useMemo(() => {
    const sel = day === 'all' ? d.TL : d.TL.filter((r) => String(r.start).slice(0, 10) === day || String(r.end).slice(0, 10) === day)
    const devices = [...new Set(d.TL.map((r) => r.device))].sort()
    const data: object[] = []
    for (const form of ['survey', 'registration']) {
      for (const rej of [false, true]) {
        const s = sel.filter((r) => r.form === form && (r.review === 'rejected') === rej)
        if (!s.length) continue
        data.push({
          type: 'bar',
          orientation: 'h',
          name: `${form}${rej ? ' (rejected)' : ''}`,
          y: s.map((r) => `${r.device.replace('demo-device-', 'device ')} · ${form === 'survey' ? 'survey' : 'reg.'}`),
          base: s.map((r) => r.start),
          x: s.map((r) => new Date(r.end).getTime() - new Date(r.start).getTime()),
          marker: { color: form === 'survey' ? SERIES[t.theme][0] : '#2b5672', opacity: rej ? 0.45 : 1, pattern: rej ? { shape: '/' } : undefined },
          text: s.map((r) => short(r.plot_name)),
          textposition: 'inside',
          customdata: s.map((r) => [r.plot_name, r.recorder, r.review, r.base_active_herb_count, ((new Date(r.submitted).getTime() - new Date(r.end).getTime()) / 3.6e6).toFixed(1)]),
          hovertemplate: '%{customdata[0]}<br>%{base|%d %b %H:%M} UTC, %{customdata[1]}<br>review: %{customdata[2]}<br>upload %{customdata[4]} h after the end<br>base active slots: %{customdata[3]}<extra></extra>',
        })
      }
    }
    const up = sel.filter((r) => r.submitted)
    data.push({
      type: 'scatter',
      mode: 'markers',
      name: 'upload',
      y: up.map((r) => `${r.device.replace('demo-device-', 'device ')} · ${r.form === 'survey' ? 'survey' : 'reg.'}`),
      x: up.map((r) => r.submitted),
      marker: { symbol: 'triangle-up', size: 9, color: t.ink },
      text: up.map((r) => short(r.plot_name)),
      hovertemplate: '%{text} uploaded %{x|%d %b %H:%M} UTC<extra></extra>',
    })
    return { data, devices }
  }, [day, t, d.TL])
  return (
    <>
      <Section title="Who was where, when" sub="Each bar is a form from opening to finalising (UTC; local EAT = UTC + 3 h). Triangles are uploads. A long gap between a bar and its upload leaves other devices with an outdated species list (B06, B10). 26 May shows the late device-01 uploads and the two rejected repeats.">
        <Segmented value={day} onChange={setDay} size="sm" options={[{ value: 'all', label: 'all days' }, ...days.map((d) => ({ value: d, label: d.slice(5) }))]} />
        <div className="chart-card">
          <Plot data={fig.data} layout={{ ...baseLayout(t), barmode: 'overlay', margin: { l: 130, r: 16, t: 30, b: 40 }, xaxis: { ...axisStyle(t), type: 'date', title: { text: 'UTC' } }, yaxis: { ...axisStyle(t), categoryorder: 'category descending' } }} height={340} filename="timeline" />
        </div>
      </Section>
      <Section title="Submissions" sub="One row per survey submission. E/W/I = error / warning / info flags on that submission.">
        <DataTable
          rows={d.S}
          initialSort={{ key: 'start_utc' }}
          cols={[
            { key: 'plot_name', label: 'Plot', render: (r) => short(r.plot_name) },
            { key: 'start_utc', label: 'Start (UTC)', render: (r) => String(r.start_utc).slice(0, 16).replace('T', ' ') },
            { key: 'device', label: 'Device', render: (r) => String(r.device).replace('demo-device-', 'd') },
            { key: 'recorder', label: 'Recorder' },
            { key: 'review_state', label: 'Review' },
            { key: 'canonical', label: 'Canonical', render: (r) => (r.canonical ? 'yes' : 'no') },
            { key: 'duration_min', label: 'Minutes', num: true, render: (r) => fx(r.duration_min, 0) },
            { key: 'upload_delay_h', label: 'Upload h', num: true, render: (r) => fx(r.upload_delay_h, 1) },
            { key: 'base_active_herb_count', label: 'Active slots', num: true, render: (r) => fx(r.base_active_herb_count, 0), tip: 'base_active_herb_count: provisional species slots active on the device when the form opened' },
            { key: 'richness_resolved', label: 'Taxa', num: true, render: (r) => fx(r.richness_resolved, 0) },
            { key: 'ewi', label: 'E/W/I', render: (r) => `${r.n_error ?? 0}/${r.n_warning ?? 0}/${r.n_info ?? 0}`, sortValue: (r) => (r.n_error ?? 0) * 1e4 + (r.n_warning ?? 0) * 100 + (r.n_info ?? 0) },
          ]}
        />
      </Section>
    </>
  )
}

// ── map ──────────────────────────────────────────────────────────────────────

type Basemap = 'light' | 'satellite' | 'none'
const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'
const mapStyle = (b: Basemap, dark: boolean) =>
  b === 'light' ? { style: dark ? 'carto-darkmatter' : 'carto-positron' } : b === 'satellite' ? { style: 'white-bg', layers: [{ sourcetype: 'raster', source: [ESRI], below: 'traces', sourceattribution: 'Esri World Imagery' }] } : { style: 'white-bg' }

function plotStatus(p: Row): string {
  if (p.surveyed) return p.sample_status === 'backup' ? 'surveyed (backup)' : 'surveyed'
  if (p.registered && p.viable === 'no') return 'registered, not viable'
  return p.sample_status === 'primary' ? 'primary, never registered' : 'backup, unused'
}
const STATUS_STYLE: Record<string, { color: string; symbol: string; size: number }> = {
  surveyed: { color: '#1f9e8c', symbol: 'circle', size: 11 },
  'surveyed (backup)': { color: '#1f9e8c', symbol: 'circle', size: 11 },
  'registered, not viable': { color: '#eda100', symbol: 'circle', size: 11 },
  'primary, never registered': { color: '#2b5672', symbol: 'circle', size: 9 },
  'backup, unused': { color: '#9aa8ae', symbol: 'circle', size: 6 },
}

function MapTab({ d, t, showFlags }: Ctx) {
  const [basemap, setBasemap] = useState<Basemap>('light')
  const [colorBy, setColorBy] = useState<'status' | 'worst'>('status')
  const [sel, setSel] = useState<string>('SavMon_LW_Plot_05')
  const worstByPlot = useMemo(() => {
    const m: Record<string, Sev | null> = {}
    for (const p of d.P) m[p.plot_name] = worstOf(plotFlags(d.F, p.plot_name))
    return m
  }, [d.F, d.P])
  const fig = useMemo(() => {
    const data: object[] = []
    for (const tr of TRANSECTS)
      data.push({ type: 'scattermap', mode: 'lines', lat: [tr.endpoint_a_lat, tr.midpoint_lat, tr.endpoint_b_lat], lon: [tr.endpoint_a_lon, tr.midpoint_lon, tr.endpoint_b_lon], line: { color: basemap === 'satellite' || t.theme === 'dark' ? '#ffffff' : '#00354d', width: 3 }, hoverinfo: 'skip', showlegend: false })
    // a registered plot's marker sits on its registered midpoint (where the transect IS); the prescribed point stays as a small grey dot
    const mid = Object.fromEntries(TRANSECTS.map((tr) => [tr.plot_name, tr]))
    const at = (p: Row): [number, number] => (mid[p.plot_name] ? [mid[p.plot_name].midpoint_lat, mid[p.plot_name].midpoint_lon] : [p.prescribed_lat, p.prescribed_lon])
    const reg = d.P.filter((p) => mid[p.plot_name])
    data.push({ type: 'scattermap', mode: 'markers', name: 'prescribed point of a registered plot', lat: reg.map((p) => p.prescribed_lat), lon: reg.map((p) => p.prescribed_lon), marker: { color: '#9aa8ae', size: 5 }, text: reg.map((p) => `${p.plot_name}: prescribed point (registered midpoint ${fx(mid[p.plot_name].midpoint_offset_m, 1)} m away)`), hovertemplate: '%{text}<extra></extra>' })
    const groups = colorBy === 'status' ? Object.keys(STATUS_STYLE) : ['error', 'warning', 'info', 'none']
    const noneLabel = d.active ? 'no flags under the current filters' : 'no plot-level flags' // not the same as "passed every check"
    for (const g of groups) {
      const ps = d.P.filter((p) => (colorBy === 'status' ? plotStatus(p) === g : (worstByPlot[p.plot_name] ?? 'none') === g))
      if (!ps.length) continue
      const st = colorBy === 'status' ? STATUS_STYLE[g] : { color: g === 'none' ? '#1f9e8c' : SEV_COLOR[g as Sev], symbol: 'circle', size: 11 }
      data.push({
        type: 'scattermap',
        mode: 'markers',
        name: `${colorBy === 'worst' && g === 'none' ? noneLabel : g} (${ps.length})`,
        lat: ps.map((p) => at(p)[0]),
        lon: ps.map((p) => at(p)[1]),
        marker: { color: st.color, size: ps.map((p) => (p.plot_name === sel ? st.size + 7 : st.size)), opacity: 0.95 },
        customdata: ps.map((p) => p.plot_name),
        text: ps.map((p) => `<b>${p.plot_name}</b><br>${plotStatus(p)} · ${p.stratum}<br>${mid[p.plot_name] ? `registered midpoint, ${fx(mid[p.plot_name].midpoint_offset_m, 1)} m from the prescribed point` : 'prescribed point (no transect)'}<br>${p.n_error ?? 0} errors · ${p.n_warning ?? 0} warnings`),
        hovertemplate: '%{text}<extra></extra>',
      })
    }
    const around = d.P.length ? d.P : PLOTS // keep the view on the project when a filter leaves no plot
    const lats = around.map((p) => p.prescribed_lat as number)
    const lons = around.map((p) => p.prescribed_lon as number)
    return { data, center: { lat: (Math.min(...lats) + Math.max(...lats)) / 2, lon: (Math.min(...lons) + Math.max(...lons)) / 2 } }
  }, [basemap, colorBy, sel, t, worstByPlot, d.P, d.active])
  return (
    <>
      <div className="qa-filters">
        <Segmented value={colorBy} onChange={setColorBy} size="sm" options={[{ value: 'status', label: 'Colour: plan status' }, { value: 'worst', label: 'Colour: worst flag' }]} />
        <Segmented value={basemap} onChange={setBasemap} size="sm" options={[{ value: 'light', label: 'Map' }, { value: 'satellite', label: 'Satellite' }, { value: 'none', label: 'No basemap' }]} />
        <span className="muted small">Markers sit on the registered midpoint (grey dots: prescribed points); zoom in to see each transect line at true scale. Basemap tiles need a connection; points and transects draw without them. Click a plot. “Worst flag” leaves out project-wide findings that hit every plot alike ({[...SYSTEMIC].join(', ')}).</span>
      </div>
      <div className="sum-grid two">
        <div className="chart-card">
          <Plot data={fig.data} layout={{ ...baseLayout(t), map: { ...mapStyle(basemap, t.theme === 'dark'), center: fig.center, zoom: 11.6 }, margin: { l: 0, r: 0, t: 0, b: 0 }, legend: { ...((baseLayout(t).legend as object) ?? {}), y: 0.02, yanchor: 'bottom', bgcolor: t.surface } }} height={560} onClickIndex={(p) => setSel(p as string)} filename="plots_map" />
        </div>
        <PlotPanel t={t} plot={sel} flags={d.F} showFlags={showFlags} />
      </div>
    </>
  )
}

/** One plot in local metres: registered A–M–B line, 5 m belt, 25 m circle, quadrats by worst flag. */
function PlotPanel({ t, plot, flags, showFlags }: { t: ThemeTokens; plot: string; flags: Row[]; showFlags: (f: FlagFilter) => void }) {
  const p = PLOTS.find((x) => x.plot_name === plot)
  const tr = TRANSECTS.find((x) => x.plot_name === plot)
  const qs = QUADRATS.filter((q) => q.plot_name === plot && q.canonical)
  const fl = plotFlags(flags, plot).filter((f) => ['D', 'E', 'J', 'C'].includes(f.group) && f.severity !== 'info').sort((a, b) => SEV_RANK[b.severity] - SEV_RANK[a.severity])
  const fig = useMemo(() => {
    if (!tr) return null
    const cx = tr.cx as number
    const cy = tr.cy as number
    const A = [tr.endpoint_a_x - cx, tr.endpoint_a_y - cy]
    const M = [tr.midpoint_x - cx, tr.midpoint_y - cy]
    const B = [tr.endpoint_b_x - cx, tr.endpoint_b_y - cy]
    const L = Math.hypot(B[0] - A[0], B[1] - A[1]) || 1
    const u = [(B[0] - A[0]) / L, (B[1] - A[1]) / L]
    const n = [-u[1], u[0]]
    const belt = [
      [A[0] + 2.5 * n[0], A[1] + 2.5 * n[1]],
      [B[0] + 2.5 * n[0], B[1] + 2.5 * n[1]],
      [B[0] - 2.5 * n[0], B[1] - 2.5 * n[1]],
      [A[0] - 2.5 * n[0], A[1] - 2.5 * n[1]],
      [A[0] + 2.5 * n[0], A[1] + 2.5 * n[1]],
    ]
    const navy = t.theme === 'dark' ? '#e9f1f4' : '#00354d'
    const circ = Array.from({ length: 73 }, (_, i) => [25 * Math.cos((i * Math.PI) / 36), 25 * Math.sin((i * Math.PI) / 36)])
    const data: object[] = [
      { type: 'scatter', mode: 'lines', x: circ.map((c) => c[0]), y: circ.map((c) => c[1]), line: { color: t.muted, dash: 'dash', width: 1 }, name: '25 m from the prescribed point', hoverinfo: 'skip' },
      { type: 'scatter', mode: 'lines', x: belt.map((c) => c[0]), y: belt.map((c) => c[1]), fill: 'toself', fillcolor: t.theme === 'dark' ? 'rgba(134,209,199,0.28)' : 'rgba(134,209,199,0.45)', line: { width: 0 }, name: '5 m belt along A–B', hoverinfo: 'skip' },
      { type: 'scatter', mode: 'lines+markers+text', x: [A[0], M[0], B[0]], y: [A[1], M[1], B[1]], text: ['A', 'M', 'B'], textposition: 'bottom right', textfont: { color: t.ink, size: 12 }, line: { color: navy, width: 3 }, marker: { size: 9, color: navy }, name: 'registered A–M–B', hovertemplate: '%{text}<extra></extra>' },
      { type: 'scatter', mode: 'markers', x: [0], y: [0], marker: { symbol: 'cross', size: 12, color: t.ink }, name: 'prescribed point', hoverinfo: 'name' },
    ]
    for (const w of ['pass', 'info', 'warning', 'error'] as const) {
      const s = qs.filter((q) => (q.worst ?? 'pass') === w)
      if (!s.length) continue
      data.push({
        type: 'scatter',
        mode: 'markers',
        x: s.map((q) => q.x - cx),
        y: s.map((q) => q.y - cy),
        marker: { size: 9, color: SEV_COLOR[w], line: { color: t.surface, width: 1 } },
        name: `quadrats: ${w === 'pass' ? 'no position flag' : w} (${s.length})`,
        customdata: s.map((q) => [q.n, fx(q.lateral, 1), fx(q.acc, 1), q.rules || '—']),
        hovertemplate: 'quadrat %{customdata[0]}<br>lateral %{customdata[1]} m · accuracy %{customdata[2]} m<br>flags: %{customdata[3]}<extra></extra>',
      })
    }
    return data
  }, [tr, qs, t])
  if (!p) return null
  return (
    <div className="chart-card qa-plot-panel">
      <div className="qa-plot-head">
        <h3>{plot}</h3>
        <span className="muted small">
          {plotStatus(p)} · {p.stratum}
          {p.ecosystem ? ` · ${p.ecosystem}` : ''}
        </span>
      </div>
      {tr && fig ? (
        <Plot data={fig} layout={{ ...baseLayout(t), margin: { l: 44, r: 10, t: 10, b: 36 }, xaxis: { ...axisStyle(t), title: { text: 'm east of the prescribed point' }, range: [-65, 65], constrain: 'domain' }, yaxis: { ...axisStyle(t), title: { text: 'm north' }, scaleanchor: 'x', range: [-65, 65], constrain: 'domain' }, legend: { orientation: 'h', y: -0.25, font: { size: 10, color: t.ink2 } } }} height={430} filename={`plot_${short(plot)}`} />
      ) : (
        <p className="muted">{p.registered ? `Not viable: ${p.establishment_notes || 'no note'}` : 'Never registered: no transect.'}</p>
      )}
      {tr && (
        <p className="small">
          Midpoint {fx(p.midpoint_offset_m, 1)} m from the prescribed point · A–B {fx(p.transect_length_m, 1)} m · angle A–M–B {fx(p.angle_amb_deg, 0)}° · {fx(p.deviation_ns_deg, 0)}° off N–S · {p.richness_resolved ?? '—'} taxa (resolved)
        </p>
      )}
      {fl.length > 0 && (
        <ul className="qa-plot-flags small">
          {fl.slice(0, 8).map((f, i) => (
            <li key={i}>
              <SevChip s={f.severity} /> <b>{f.rule_id}</b> {f.observed}
            </li>
          ))}
        </ul>
      )}
      <button type="button" className="btn ghost sm" onClick={() => showFlags({ plot })}>
        All flags for {short(plot)}
      </button>
    </div>
  )
}

// ── plots ────────────────────────────────────────────────────────────────────

function PlotsTab({ d, t, showFlags }: Ctx) {
  const reg = d.P.filter((p) => p.registered).sort((a, b) => String(a.plot_name).localeCompare(String(b.plot_name)))
  const cov = Object.fromEntries(EFF_PLOTS.filter((e) => e.layer === 'resolved').map((e) => [effKey(e.plot_name, e.replicate), e])) // per plot AND replicate
  const groups = Object.keys(GROUPS).filter((g) => g !== 'K')
  const heat = useMemo(() => {
    const z = reg.map((p) => groups.map((g) => SEV_RANK[worstOf(plotFlags(d.F, p.plot_name).filter((f) => f.group === g)) ?? ''] ?? 0))
    const txt = reg.map((p) => groups.map((g) => plotFlags(d.F, p.plot_name).filter((f) => f.group === g).length || ''))
    return [
      {
        type: 'heatmap',
        z,
        x: groups.map((g) => `${g} · ${GROUPS[g]}`),
        y: reg.map((p) => short(p.plot_name)),
        text: txt,
        texttemplate: '%{text}',
        zmin: 0,
        zmax: 3,
        colorscale: [
          [0, t.theme === 'dark' ? '#1d2f3b' : '#f3f6f7'],
          [0.25, t.theme === 'dark' ? '#1d2f3b' : '#f3f6f7'],
          [0.25, SEV_COLOR.info],
          [0.5, SEV_COLOR.info],
          [0.5, SEV_COLOR.warning],
          [0.75, SEV_COLOR.warning],
          [0.75, SEV_COLOR.error],
          [1, SEV_COLOR.error],
        ],
        showscale: false,
        xgap: 2,
        ygap: 2,
        customdata: reg.map((p) => groups.map(() => p.plot_name)),
        hovertemplate: '%{y} · %{x}: %{text} flags<extra></extra>',
      },
    ]
  }, [t, d.F, reg])
  return (
    <>
      <Section title="Flags per plot and rule group" sub={`Colour = worst severity (blue info, amber warning, red error); number = count. Canonical surveys only; project-wide findings that hit every plot alike are left out (${[...SYSTEMIC].join(', ')}). Click a cell to list a plot's flags.`}>
        <div className="chart-card">
          <Plot data={heat} layout={{ ...baseLayout(t), margin: { l: 70, r: 10, t: 10, b: 150 }, xaxis: { ...axisStyle(t), tickangle: -35, side: 'bottom' }, yaxis: { ...axisStyle(t), autorange: 'reversed' } }} height={760} onClickIndex={(p) => showFlags({ plot: p as string })} filename="flags_heatmap" />
        </div>
      </Section>
      <Section title="Registered plots" sub="Geometry from the registration; richness and coverage from the canonical survey (resolved taxa); provisional effort metrics are marked.">
        <DataTable
          rows={reg}
          limit={40}
          initialSort={{ key: 'plot_name' }}
          cols={[
            { key: 'plot_name', label: 'Plot', render: (r) => <button type="button" className="link-btn" onClick={() => showFlags({ plot: r.plot_name })}>{short(r.plot_name)}</button> },
            { key: 'sample_status', label: 'Status' },
            { key: 'viable', label: 'Viable' },
            { key: 'ecosystem', label: 'Ecosystem' },
            { key: 'midpoint_offset_m', label: 'Offset m', num: true, render: (r) => fx(r.midpoint_offset_m, 1), tip: 'Registered midpoint to prescribed point (SOP limit 25 m)' },
            { key: 'transect_length_m', label: 'A–B m', num: true, render: (r) => fx(r.transect_length_m, 1) },
            { key: 'deviation_ns_deg', label: '° off N–S', num: true, render: (r) => fx(r.deviation_ns_deg, 0) },
            { key: 'richness_raw', label: 'Taxa raw', num: true, render: (r) => fx(r.richness_raw, 0) },
            { key: 'richness_resolved', label: 'Taxa resolved', num: true, render: (r) => fx(r.richness_resolved, 0) },
            { key: 'quadrats_all_unknown', label: 'All-unknown q.', num: true, render: (r) => fx(r.quadrats_all_unknown, 0) },
            { key: 'coverage', label: 'Coverage', num: true, render: (r) => fx(cov[effKey(r.plot_name, r.replicate)]?.coverage, 2), sortValue: (r) => cov[effKey(r.plot_name, r.replicate)]?.coverage ?? -1 },
            { key: 'metrics_status', label: 'Effort metrics', render: (r) => (cov[effKey(r.plot_name, r.replicate)] ? <MetricsStatus s={cov[effKey(r.plot_name, r.replicate)].metrics_status} /> : <span className="muted small">no canonical survey</span>), sortValue: (r) => String(cov[effKey(r.plot_name, r.replicate)]?.metrics_status ?? 'z') },
            { key: 'ewi', label: 'E/W/I', render: (r) => `${r.n_error ?? 0}/${r.n_warning ?? 0}/${r.n_info ?? 0}`, sortValue: (r) => (r.n_error ?? 0) * 1e4 + (r.n_warning ?? 0) * 100 + (r.n_info ?? 0) },
          ]}
        />
      </Section>
    </>
  )
}

// ── taxonomy ─────────────────────────────────────────────────────────────────

const QUEUES: { key: string; label: string; rules: string[]; sub: string }[] = [
  { key: 'spelling', label: 'Names to check', rules: ['F03'], sub: 'Likely misspellings, checked against the GBIF backbone (cached). The resolved layer keeps NS’s names; fix them in curation.' },
  { key: 'curation', label: 'Curation table', rules: ['F13'], sub: 'Problems in species_extra_ids itself: introduced typos, kept field misspellings, merges only in free text, label ≠ number.' },
  { key: 'unknowns', label: 'Unresolved unknowns', rules: ['F07'], sub: 'Provisional taxa still “Unknown” after curation, by records: the voucher identification queue.' },
  { key: 'range', label: 'Range', rules: ['F10'], sub: 'Identified taxa with no GBIF record in Kenya (count in southern Africa shown). Weak evidence alone; a pattern across a fifth of the list.' },
  { key: 'duplicates', label: 'Duplicates', rules: ['F04', 'F08', 'F02', 'F05'], sub: 'One species under several ids, typed “missing” species that are on the list, the same taxon twice in a quadrat.' },
  { key: 'woody', label: 'Woody & format', rules: ['F06', 'F01', 'F12'], sub: 'Woody taxa in herbaceous data (excluded in the resolved layer), canonical-format problems, named “unknown” woody species.' },
]

function TaxonomyTab({ d, showFlags }: Ctx) {
  const [qk, setQk] = useState('spelling')
  const [q, setQ] = useState('')
  const queue = QUEUES.find((x) => x.key === qk)!
  const rows = d.F.filter((f) => queue.rules.includes(f.rule_id) && f.canonical)
  const recs = (r: Row) => {
    const m = /\((\d+) records?\)|: (\d+) records/.exec(String(r.observed))
    return m ? Number(m[1] ?? m[2]) : 0
  }
  const taxa = TAXA.filter((x) => !q || `${x.taxon} ${x.raw_keys} ${x.raw_names}`.toLowerCase().includes(q.toLowerCase()))
  return (
    <>
      <div className="stats-row">
        <Stat label="Taxa (resolved, whole run)" value={fmtInt(O.taxa_resolved)} sub={`${O.taxa_resolved_identified} identified · ${O.taxa_resolved - O.taxa_resolved_identified} unresolved unknowns`} />
        <Stat label="Raw keys (whole run)" value={fmtInt(O.taxa_raw)} sub="list species + provisional slots as recorded" />
        <Stat label="Names to check (whole run)" value={fmtInt(FLAGS.filter((f) => f.rule_id === 'F03').length)} sub="GBIF fuzzy or no species match; a name is not tied to one visit" />
        <Stat label="No Kenyan record (whole run)" value={FLAGS.find((f) => f.rule_id === 'F10' && f.entity_type === 'project')?.observed.split(' ')[0] ?? '—'} sub="identified taxa (GBIF)" />
      </div>
      <Section
        title="Curation queue"
        sub={d.active ? `${queue.sub} Filtered: items tied to a name or an entity (not to a visit) are hidden while a device, recorder or date filter is on.` : queue.sub}
        right={<button type="button" className="btn ghost sm" onClick={() => showFlags({ rule: queue.rules[0] })}>Open in All flags</button>}>
        <Segmented value={qk} onChange={setQk} size="sm" options={QUEUES.map((x) => ({ value: x.key, label: `${x.label} (${d.F.filter((f) => x.rules.includes(f.rule_id) && f.canonical).length})` }))} />
        <DataTable
          className="qa-table"
          rows={rows}
          limit={50}
          initialSort={{ key: 'recs', desc: true }}
          cols={[
            { key: 'rule_id', label: 'Rule', render: (r) => <span data-tip={ruleTitle[r.rule_id]}>{r.rule_id}</span> },
            { key: 'sev', label: 'Severity', render: (r) => <SevChip s={r.severity} />, sortValue: (r) => SEV_RANK[r.severity] },
            { key: 'entity_key', label: 'Taxon / item', render: (r) => <b className="small">{String(r.entity_key).split('|')[0].slice(0, 60)}</b> },
            { key: 'observed', label: 'Evidence', render: (r) => <span className="small">{r.observed}</span> },
            { key: 'recs', label: 'Records', num: true, render: (r) => (recs(r) ? fmtInt(recs(r)) : ''), sortValue: recs },
            { key: 'message', label: 'Action', render: (r) => <span className="small muted">{r.message}</span> },
          ]}
        />
      </Section>
      <Section
        title="Suggested species-list updates (whole run)"
        sub="For NS’s curators, from challenge2/outputs/species_list_suggestions.csv: names to add to the project list, spellings to confirm (GBIF’s spelling suggested), provisional ids to merge, taxa to check for range. Suggestions only: no data or list is changed."
        right={<button type="button" className="btn ghost sm" onClick={() => downloadCsv('species_list_suggestions.csv', SUGG, Object.keys(SUGG[0] ?? {}))}>Download CSV</button>}
      >
        <DataTable
          rows={SUGG}
          limit={25}
          initialSort={{ key: 'records', desc: true }}
          cols={[
            { key: 'action', label: 'Action', render: (r) => <span className="qa-chip qa-info">{String(r.action).replace(/_/g, ' ')}</span> },
            { key: 'name_as_recorded', label: 'As recorded', render: (r) => <b>{r.name_as_recorded}</b> },
            { key: 'suggested_name', label: 'Suggested', render: (r) => r.suggested_name || <span className="muted">—</span> },
            { key: 'provisional_ids', label: 'Provisional ids', render: (r) => <span className="small">{r.provisional_ids}</span> },
            { key: 'records', label: 'Records', num: true, render: (r) => fmtInt(r.records) },
            { key: 'gbif_records_country', label: 'GBIF KE', num: true, render: (r) => (r.gbif_records_country == null ? '—' : fmtInt(r.gbif_records_country)) },
            { key: 'evidence', label: 'Evidence', render: (r) => <span className="small muted">{r.evidence}</span> },
          ]}
        />
      </Section>
      <Section title="Raw → resolved taxa (whole run)" sub="Every resolved taxon in the canonical surveys and the raw keys (list labels or provisional slots) behind it. Several raw keys per row = a merge by NS’s curation." right={<input className="input" placeholder="Find a taxon…" value={q} onChange={(e) => setQ(e.target.value)} />}>
        <DataTable
          rows={taxa}
          limit={40}
          initialSort={{ key: 'records', desc: true }}
          cols={[
            { key: 'taxon', label: 'Resolved taxon', render: (r) => <b>{r.taxon}</b> },
            { key: 'status', label: 'Status' },
            { key: 'records', label: 'Records', num: true, render: (r) => fmtInt(r.records) },
            { key: 'plots', label: 'Plots', num: true, render: (r) => fmtInt(r.plots) },
            { key: 'raw_keys', label: 'Raw keys', render: (r) => <span className="small">{r.raw_keys}</span> },
            { key: 'raw_names', label: 'Names as recorded', render: (r) => <span className="small muted">{r.raw_names}</span> },
            { key: 'curation', label: 'Curation', render: (r) => <span className="small muted">{r.curation}</span> },
          ]}
        />
      </Section>
    </>
  )
}

// ── effort ───────────────────────────────────────────────────────────────────

/** Monitoring rounds in this run. Every effort mart is per replicate; rounds are never pooled. */
const REPLICATES = [...new Set(EFF_PROJECT.map((r) => String(r.replicate)))].sort()
const effKey = (plot: unknown, rep: unknown) => `${plot}|${rep}`
/** Rule ids named in a metrics_status ("provisional: C04", "provisional: 7 of 30 plots provisional (C04)"). */
const statusRules = (s: string) => (s.startsWith('provisional') ? [...new Set(s.match(/\b[A-KPX]\d{2}\b/g) ?? [])] : [])

function MetricsStatus({ s }: { s: string | null | undefined }) {
  if (!s || s === 'ok') return <span className="qa-chip qa-pass">ok</span>
  if (s === 'suppressed') return <span className="qa-chip qa-flag" data-tip="Records are missing or none is an analytical taxon: there are no metrics to read. See the plot's note.">suppressed</span>
  const rules = statusRules(s)
  return (
    <span className="qa-chip qa-flag" data-tip-title="Provisional" data-tip={`Shown, but conditional on records that a rule found incomplete:\n${rules.map((r) => `${r}: ${ruleTitle[r]}`).join('\n')}`}>
      provisional · {rules.join(' ')}
    </span>
  )
}

function EffortTab({ t, showFlags }: Ctx) {
  const [layer, setLayer] = useState<'resolved' | 'raw'>('resolved')
  const [repPicked, setRep] = useState(REPLICATES[REPLICATES.length - 1])
  const rep = REPLICATES.includes(repPicked) ? repPicked : REPLICATES[0]
  const plotsHere = useMemo(() => EFF_PLOTS.filter((x) => x.layer === layer && x.replicate === rep), [layer, rep])
  const statusOf = useMemo(() => Object.fromEntries(plotsHere.map((x) => [x.plot_name, String(x.metrics_status)])), [plotsHere])
  const qualified = plotsHere.filter((x) => x.metrics_status !== 'ok').sort((a, b) => String(a.plot_name).localeCompare(String(b.plot_name)))
  const suppressed = qualified.filter((x) => x.metrics_status === 'suppressed')
  const curves = useMemo(() => {
    const c = EFF_CURVES.filter((x) => x.layer === layer && x.replicate === rep)
    const plots = [...new Set(c.map((x) => x.plot_name))].filter((p) => statusOf[p] !== 'suppressed')
    let shownProv = false
    const data: object[] = plots.map((p) => {
      const pc = c.filter((x) => x.plot_name === p)
      const prov = statusOf[p]?.startsWith('provisional')
      const first = prov && !shownProv
      if (prov) shownProv = true
      return {
        type: 'scatter',
        mode: 'lines',
        x: pc.map((x) => x.quadrats),
        y: pc.map((x) => x.expected_taxa),
        name: prov ? 'provisional plot' : short(p),
        legendgroup: prov ? 'prov' : 'ok',
        showlegend: first,
        line: { color: prov ? SEV_COLOR.warning : SERIES[t.theme][0], width: prov ? 1.5 : 1, dash: prov ? 'dash' : 'solid' },
        opacity: prov ? 0.8 : 0.45,
        hovertemplate: `${short(p)}${prov ? ` (${statusOf[p]})` : ''}: %{y:.1f} taxa in %{x} quadrats<extra></extra>`,
      }
    })
    const okPlots = new Set(plots.filter((p) => statusOf[p] === 'ok'))
    const maxT = Math.max(0, ...c.map((x) => x.quadrats as number))
    const med = Array.from({ length: maxT }, (_, i) => median(c.filter((x) => okPlots.has(x.plot_name) && x.quadrats === i + 1).map((x) => x.expected_taxa as number)))
    data.push({ type: 'scatter', mode: 'lines', x: med.map((_, i) => i + 1), y: med, name: 'median of ok plots', line: { color: t.theme === 'dark' ? '#e9f1f4' : '#00354d', width: 3 } })
    return data
  }, [layer, rep, statusOf, t])
  const comp = useMemo(() => {
    const e = plotsHere.filter((x) => x.metrics_status !== 'suppressed').sort((a, b) => a.coverage - b.coverage)
    const prov = e.map((x) => String(x.metrics_status).startsWith('provisional'))
    const y = e.map((x, i) => `${short(x.plot_name)}${prov[i] ? ' *' : ''}`)
    const st = e.map((x) => String(x.metrics_status))
    return [
      { type: 'scatter', mode: 'markers', x: e.map((x) => x.coverage), y, name: 'sample coverage', marker: { color: '#1f9e8c', size: 9, symbol: prov.map((p) => (p ? 'circle-open' : 'circle')), line: { width: 2, color: '#1f9e8c' } }, customdata: st, hovertemplate: '%{y}: coverage %{x:.2f} · %{customdata}<extra></extra>' },
      {
        type: 'scatter',
        mode: 'markers',
        x: e.map((x) => x.completeness),
        y,
        name: 'observed / Chao2 (95% CI)',
        marker: { color: '#2b5672', size: 8, symbol: prov.map((p) => (p ? 'square-open' : 'square')), line: { width: 2, color: '#2b5672' } },
        error_x: { type: 'data', symmetric: false, array: e.map((x) => (x.chao2_lo95 ? x.S_obs / x.chao2_lo95 - x.completeness : 0)), arrayminus: e.map((x) => (x.chao2_hi95 ? x.completeness - x.S_obs / x.chao2_hi95 : 0)), color: '#2b5672', thickness: 1 },
        customdata: e.map((x, i) => [x.S_obs, x.chao2, x.chao2_lo95 ?? 'n/a', x.chao2_hi95 ?? 'no upper limit', st[i]]),
        hovertemplate: '%{y}: %{customdata[0]} of Chao2 %{customdata[1]} (%{customdata[2]}–%{customdata[3]}) · %{customdata[4]}<extra></extra>',
      },
    ]
  }, [plotsHere])
  const proj = EFF_PROJECT.find((x) => x.layer === layer && x.replicate === rep)
  if (!proj) return <p className="muted">No canonical survey in replicate {rep}: no effort metrics.</p>
  const projOk = proj.metrics_status === 'ok'
  return (
    <>
      <div className="qa-filters">
        {REPLICATES.length > 1 ? (
          <Segmented value={rep} onChange={setRep} size="sm" options={REPLICATES.map((r) => ({ value: r, label: r }))} />
        ) : (
          <span className="qa-chip qa-info">replicate {rep}</span>
        )}
        <Segmented value={layer} onChange={setLayer} size="sm" options={[{ value: 'resolved', label: 'Resolved taxa' }, { value: 'raw', label: 'Raw keys' }]} />
        <span className="muted small">
          Every number on this tab is for one monitoring round{REPLICATES.length > 1 ? '' : ' (the only one in this run)'}; rounds are never pooled. Raw keys over-count (several provisional ids = one species); resolved follows NS’s curation.
        </span>
      </div>
      {!projOk && (
        <div className="note">
          <span>
            <b>These effort metrics are provisional.</b> {String(proj.metrics_status).replace(/^provisional:\s*/, '')}: those plots have quadrats that declare additional species without species rows, so their lists may be incomplete, and every project figure below includes them. As a sensitivity comparison (not an estimate of the missing-record bias, because it also changes which plots are sampled), on the {proj.units_ok_plots} plots whose own metrics are ok: {fmtInt(proj.S_obs_ok_plots)} taxa, Chao2 {fx(proj.chao2_ok_plots, 0)} (95% CI {fx(proj.chao2_lo95_ok_plots, 0)}–{fx(proj.chao2_hi95_ok_plots, 0)}), coverage {fx(proj.coverage_ok_plots, 3)}. Provisional plots are marked * and drawn dashed or open below.{' '}
            {statusRules(String(proj.metrics_status)).map((r) => (
              <button key={r} type="button" className="link-btn" onClick={() => showFlags({ rule: r })}>
                {r} flags
              </button>
            ))}
          </span>
        </div>
      )}
      <div className="stats-row">
        <Stat label="Metrics status" value={<MetricsStatus s={projOk ? 'ok' : `provisional: ${statusRules(String(proj.metrics_status)).join(' ')}`} />} sub={projOk ? `all ${proj.units} plots ok` : `${proj.plots_provisional} provisional, ${proj.plots_suppressed} suppressed of ${proj.units} plots`} />
        <Stat label="Project taxa observed" value={fmtInt(proj.S_obs)} sub={`Chao2 ${fx(proj.chao2, 0)} (95% CI ${fx(proj.chao2_lo95, 0)}–${fx(proj.chao2_hi95, 0)})${projOk ? '' : ' · provisional'}`} />
        <Stat label="Project coverage" value={fx(proj.coverage, 3)} sub={`plots as sampling units · ${fx(proj.new_taxa_next_quadrat, 1)} new taxa expected in one more plot`} />
        <Stat label="Diversity (Hill)" value={`${fx(proj.hill_q1, 0)} / ${fx(proj.hill_q2, 0)}`} sub="q1 exp(Shannon) / q2 inverse Simpson, effective number of taxa (plot incidence)" />
        <Stat label="Median plot coverage" value={fx(median(plotsHere.filter((x) => x.metrics_status === 'ok').map((x) => x.coverage)), 2)} sub="ok plots only · share of a plot's incidences from taxa already seen" />
      </div>
      <Section title="Planned against done" sub="Primary and backup points per stratum (centroids), registrations and canonical surveys, for the selected replicate.">
        <DataTable
          rows={EFF_PLAN.filter((x) => x.replicate === rep)}
          cols={[
            { key: 'replicate', label: 'Replicate' },
            { key: 'stratum', label: 'Stratum' },
            { key: 'primary_planned', label: 'Primary planned', num: true },
            { key: 'primary_registered', label: 'Registered', num: true },
            { key: 'primary_non_viable', label: 'Non-viable', num: true },
            { key: 'primary_surveyed', label: 'Surveyed', num: true },
            { key: 'backups_used', label: 'Backups used', num: true },
            { key: 'share_of_primary_surveyed', label: 'Primary surveyed', num: true, render: (r) => fmtPct(r.share_of_primary_surveyed, 0) },
          ]}
        />
      </Section>
      <div className="sum-grid two">
        <Section title="Species accumulation per plot" sub="Expected taxa in t random quadrats (sample-based rarefaction). Curves still rising at 20 quadrats mean rare species remain. Dashed: provisional plots; the median uses ok plots only.">
          <div className="chart-card">
            <Plot data={curves} layout={{ ...baseLayout(t), xaxis: { ...axisStyle(t), title: { text: 'quadrats' } }, yaxis: { ...axisStyle(t), title: { text: 'expected taxa' } } }} height={420} filename="accumulation" />
          </div>
        </Section>
        <Section title="How complete is each plot's list?" sub="Coverage (stable) and observed / bias-corrected Chao2 with its 95% interval (wide at 20 quadrats). * and open markers: provisional plots.">
          <div className="chart-card">
            <Plot data={comp} layout={{ ...baseLayout(t), margin: { l: 80, r: 16, t: 30, b: 40 }, xaxis: { ...axisStyle(t), range: [0, 1.02], title: { text: 'share' } }, yaxis: { ...axisStyle(t), tickfont: { size: 9, color: t.muted } } }} height={560} filename="completeness" />
          </div>
          {suppressed.length > 0 && <p className="small muted">Not shown (suppressed): {suppressed.map((x) => `${short(x.plot_name)}: ${x.note}`).join('; ')}.</p>}
        </Section>
      </div>
      <Section title="Plots whose effort metrics are qualified" sub="Provisional: shown, but conditional on records a rule found incomplete. Suppressed: no metrics to read. Click a plot for its flags.">
        {qualified.length ? (
          <DataTable
            rows={qualified}
            cols={[
              { key: 'plot_name', label: 'Plot', render: (r) => <button type="button" className="link-btn" onClick={() => showFlags({ plot: r.plot_name })}>{short(r.plot_name)}</button> },
              { key: 'metrics_status', label: 'Status', render: (r) => <MetricsStatus s={r.metrics_status} /> },
              { key: 'why', label: 'Why', render: (r) => <span className="small">{r.metrics_status === 'suppressed' ? r.note : statusRules(String(r.metrics_status)).map((x) => `${x}: ${ruleTitle[x]}`).join('; ')}</span> },
              { key: 'S_obs', label: 'Taxa', num: true, render: (r) => fx(r.S_obs, 0) },
              { key: 'coverage', label: 'Coverage', num: true, render: (r) => fx(r.coverage, 2) },
            ]}
          />
        ) : (
          <p className="small muted">None: every plot's metrics are ok in this replicate.</p>
        )}
      </Section>
      <div className="sum-grid two">
        <Section title="Repeatability" sub="Plots surveyed more than once within this replicate. Indicative only: few pairs, and recorder and effort can differ between the visits (see the report).">
          <DataTable
            rows={EFF_REPEAT.filter((x) => x.layer === layer && x.replicate === rep)}
            cols={[
              { key: 'plot_name', label: 'Plot', render: (r) => short(r.plot_name) },
              { key: 'rec', label: 'Recorders', render: (r) => `${r.recorder_first} / ${r.recorder_second}` },
              { key: 'taxa', label: 'Taxa', render: (r) => `${r.taxa_first} / ${r.taxa_second}` },
              { key: 'plot_jaccard', label: 'Plot Jaccard', num: true, render: (r) => fx(r.plot_jaccard, 2) },
              { key: 'mean_quadrat_jaccard', label: 'Quadrat Jaccard', num: true, render: (r) => fx(r.mean_quadrat_jaccard, 2) },
              { key: 'min', label: 'Minutes', render: (r) => `${fx(r.duration_first_min, 0)} / ${fx(r.duration_second_min, 0)}` },
            ]}
          />
        </Section>
        <Section title="How richness depends on data decisions" sub="A sensitivity analysis, not bounds: each row is one defensible definition, and unresolved unknowns can hide both split and merged species, so true richness may lie outside this range.">
          <DataTable rows={EFF_SENS.filter((x) => x.replicate === rep)} cols={[{ key: 'definition', label: 'Definition' }, { key: 'taxa', label: 'Taxa', num: true, render: (r) => fmtInt(r.taxa) }]} />
        </Section>
      </div>
    </>
  )
}

const median = (v: number[]) => {
  const s = [...v].sort((a, b) => a - b)
  return s.length ? s[Math.floor(s.length / 2)] : NaN
}

// ── rules ────────────────────────────────────────────────────────────────────

function RulesTab({ showFlags }: Ctx) {
  const [group, setGroup] = useState('')
  const rows = RULES.filter((r) => !group || r.group === group)
  const th = Object.entries(D.thresholds)
  return (
    <>
      <Section title="Rule catalogue" sub="Every rule that ran, its source (SOP step, form row, entity list, or our judgement), default severity, whether it can change richness, and its results. A result can carry another severity than the default, with its reason in the flag (E/W/I split).">
        <Segmented value={group} onChange={setGroup} size="sm" options={[{ value: '', label: 'all' }, ...Object.keys(GROUPS).map((g) => ({ value: g, label: g, title: GROUPS[g] }))]} />
        <DataTable
          className="qa-table"
          rows={rows}
          limit={120}
          initialSort={{ key: 'rule_id' }}
          cols={[
            { key: 'rule_id', label: 'Rule', render: (r) => (r.fail ? <RuleLink id={r.rule_id} onClick={() => showFlags({ rule: r.rule_id })} /> : <span>{r.rule_id}</span>) },
            { key: 'title', label: 'Check', render: (r) => <span data-tip={`${r.why}\n\nAction: ${r.action}`}>{r.title}</span> },
            { key: 'severity', label: 'Default', render: (r) => <SevChip s={r.severity} />, sortValue: (r) => SEV_RANK[r.severity] },
            { key: 'metric_impact', label: 'Richness impact' },
            { key: 'source', label: 'Source', render: (r) => <span className="small muted">{r.source}</span> },
            { key: 'fail', label: 'Fail', num: true, render: (r) => (r.fail ? <b>{fmtInt(r.fail)}</b> : '0') },
            { key: 'ewi', label: 'E/W/I', render: (r) => `${r.fail_error ?? 0}/${r.fail_warning ?? 0}/${r.fail_info ?? 0}` },
            { key: 'pass', label: 'Pass', num: true, render: (r) => fmtInt(r.pass) },
            { key: 'could_not_check', label: 'Not checked', num: true, render: (r) => fmtInt(r.could_not_check) },
          ]}
        />
      </Section>
      <Section title="Thresholds" sub="Read by the rules from rules/rules.yaml; changing one is a catalogue change (new run id).">
        <div className="qa-thresholds">
          {th.map(([k, v]) => (
            <span key={k} className="qa-chip qa-info">
              {k} = {Array.isArray(v) ? v.join(', ') : String(v)}
            </span>
          ))}
        </div>
      </Section>
    </>
  )
}

// ── field feedback ───────────────────────────────────────────────────────────

const FIELD_RULES = new Set(['A03', 'A04', 'C01', 'C02', 'C03', 'C04', 'C08', 'C09', 'C13', 'C15', 'E01', 'E02', 'E04', 'E05', 'E06', 'E09', 'E10', 'B05', 'B06', 'B10', 'D01', 'D02', 'D03', 'D04', 'D06', 'F01', 'F02', 'F04', 'F05', 'F12'])

function TonightTab({ d, showFlags }: Ctx) {
  const days = [...new Set(d.F.map((f) => f.day).filter(Boolean))].sort()
  const toCheck = (x: string) => d.F.filter((f) => f.day === x && FIELD_RULES.has(f.rule_id) && f.severity !== 'info').length
  const busiest = days.reduce((a, b) => (toCheck(b) > toCheck(a) ? b : a), days[0])
  const [picked, setDay] = useState<string>(busiest) // open on the busiest day
  const day = days.includes(picked) ? picked : busiest // the shared filters may remove the picked day
  const fl = d.F.filter((f) => f.day === day && FIELD_RULES.has(f.rule_id) && f.severity !== 'info')
  const byPlot = new Map<string, Row[]>()
  for (const f of fl) byPlot.set(f.plot_name || '(project)', [...(byPlot.get(f.plot_name || '(project)') ?? []), f])
  const subs = d.TL.filter((r) => String(new Date(new Date(r.start).getTime() + 3 * 3.6e6).toISOString()).slice(0, 10) === day)
  return (
    <>
      <Section title="Check tonight" sub="What a team lead would review at the end of a field day: errors and warnings the team can still fix while near the plots (missing rows, empty records, position and length problems, late uploads). Pick a day.">
        <Segmented value={day} onChange={setDay} size="sm" options={days.map((d) => ({ value: d, label: d.slice(5) }))} />
        <p className="small">
          {subs.length} forms that day ({subs.filter((s) => s.form === 'survey').length} surveys, {subs.filter((s) => s.form === 'registration').length} registrations) on {new Set(subs.map((s) => s.device)).size} device(s). {fl.length ? `${fl.length} items to check.` : 'Nothing to check.'}
        </p>
        <div className="qa-tonight">
          {[...byPlot.entries()].map(([plot, items]) => (
            <div key={plot} className="chart-card qa-tonight-card">
              <div className="qa-plot-head">
                <h3>{short(plot)}</h3>
                <button type="button" className="link-btn small" onClick={() => showFlags({ plot })}>all flags</button>
              </div>
              <ul className="small">
                {items.map((f, i) => (
                  <li key={i}>
                    <SevChip s={f.severity} /> <b data-tip={f.title}>{f.rule_id}</b> {f.observed}
                    {f.message && <span className="muted"> · {f.message}</span>}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </Section>
      <Section title="Every evening" sub="Process reminders that prevent the issues found in this campaign.">
        <ul className="small">
          <li>Upload every finalised form as soon as there is a connection, and refresh forms and entity lists before the next survey (B06, B10: provisional ids).</li>
          <li>Check that each quadrat marked “additional species present” has its species rows (C04), and that no additional-species row is empty (C08).</li>
          <li>Pick species from the list before typing a “missing” name, and reuse provisional ids already created (F02, F04).</li>
          <li>Set the device time zone to Africa/Nairobi (B12).</li>
        </ul>
      </Section>
    </>
  )
}

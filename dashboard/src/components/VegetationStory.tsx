/**
 * The vegetation story in plain language, for a reader who has never seen the data: a verdict, the key
 * numbers, five things to know, what is in good order and what to do next. Every number is computed from
 * the embedded pipeline results (challenge2/outputs/dashboard_results.json), so the text stays true when
 * the pipeline is re-run. Used in full on the Vegetation Summary page and briefly on the QA/QC Overview.
 */
import R from '../../../challenge2/outputs/dashboard_results.json'
import { fmtInt } from '../data/stats'
import { Stat } from './ui'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>
interface ColTable {
  columns: string[]
  rows: unknown[][]
}
const D = R as unknown as { overview: Row; status_counts: Record<string, number>; [k: string]: unknown }
const rows = (k: string): Row[] => {
  const t = D[k] as ColTable
  return t.rows.map((r) => Object.fromEntries(t.columns.map((c, i) => [c, r[i]])))
}

/** Project-wide findings that repeat on every plot or submission (as counted in the report). */
const PROJECT_WIDE = ['B12', 'J04', 'E13', 'C14', 'D05', 'A10', 'K04', 'C17', 'K01', 'E14']
const GEOMETRY = ['D01', 'D02', 'D03', 'D04', 'E03', 'E05']

function facts() {
  const O = D.overview
  const F = rows('flags')
  const rule = Object.fromEntries(rows('rules').map((r) => [r.rule_id, r]))
  const fails = (id: string) => Number(rule[id]?.fail ?? 0)
  const plan = rows('effort_plan')
  const stratum = (s: string) => plan.find((p) => p.stratum === s && p.replicate === O.replicate) ?? plan.find((p) => p.stratum === s)
  const sav = stratum('savanna')
  const shr = stratum('shrubland')
  const proj = rows('effort_project').find((p) => p.layer === 'resolved' && p.replicate === O.replicate)
  const effPlots = rows('effort_plots').filter((p) => p.layer === 'resolved')
  const provisional = effPlots.filter((p) => String(p.metrics_status).startsWith('provisional')).length
  const taxa = rows('taxa')
  const records = taxa.reduce((a, t) => a + Number(t.records ?? 0), 0)
  const unknownRecords = taxa.filter((t) => String(t.status).startsWith('unknown')).reduce((a, t) => a + Number(t.records ?? 0), 0)
  const altitude = /median (-?\d+) m/.exec(String(F.find((f) => f.rule_id === 'E14')?.observed ?? ''))?.[1]
  const noKenya = F.filter((f) => f.rule_id === 'F10' && f.entity_type === 'taxon_name').length
  const badTransects = new Set(F.filter((f) => GEOMETRY.includes(f.rule_id) && f.severity === 'error').map((f) => f.plot_name)).size
  const plots = rows('plots').filter((p) => p.registered && typeof p.deviation_ns_deg === 'number')
  const eastWest = plots.filter((p) => p.deviation_ns_deg > 45).length
  const repeated = F.filter((f) => PROJECT_WIDE.includes(f.rule_id))
  const individual = F.filter((f) => !PROJECT_WIDE.includes(f.rule_id))
  const bySev = (fl: Row[], s: string) => fl.filter((f) => f.severity === s).length
  return {
    O,
    sav,
    shr,
    proj,
    provisional,
    unknownShare: records ? unknownRecords / records : NaN,
    altitude: altitude ? Math.abs(Number(altitude)) : null,
    noKenya,
    misspelled: fails('F03'),
    unresolved: fails('F07'),
    missingRows: fails('C04'),
    emptyRecords: fails('C08'),
    badTransects,
    eastWest,
    transects: plots.length,
    flags: F.length,
    repeated: repeated.length,
    patterns: new Set(repeated.map((f) => f.rule_id)).size,
    individual: { all: individual.length, error: bySev(individual, 'error'), warning: bySev(individual, 'warning'), info: bySev(individual, 'info') },
    errors: bySev(F, 'error'),
    good: {
      quadrats: fails('A03') === 0,
      attachments: fails('A08') === 0,
      references: fails('A05') === 0,
      gps: fails('D06') === 0 && fails('E01') === 0,
      edits: F.some((f) => /Edits = 0/.test(String(f.message))),
    },
  }
}

const pct = (v: number) => (Number.isFinite(v) ? `${Math.round(v * 100)}%` : '—')
const n0 = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v).toLocaleString('en-US') : '—')

/** The one-sentence verdict, shared by both variants. */
function Verdict({ f }: { f: ReturnType<typeof facts> }) {
  return (
    <p className="story-verdict">
      The field data are <b>complete and carefully recorded</b>, but they are <b>not yet ready</b> for species-richness and diversity results. Three things must be settled first: <b>where the data come from</b>, <b>the species names</b>, and <b>some missing species records</b>. The shrubland stratum was <b>not surveyed</b> ({f.shr?.primary_surveyed ?? 0} of {f.shr?.primary_planned ?? '—'} planned plots).
    </p>
  )
}

/** How to read the flag total: not 697 mistakes. */
function FlagCounts({ f }: { f: ReturnType<typeof facts> }) {
  return (
    <p className="small">
      <b>{fmtInt(f.flags)} flags are not {fmtInt(f.flags)} mistakes.</b> {fmtInt(f.repeated)} of them are {f.patterns} project-wide patterns repeated on every plot or form (for example the same time-zone label on every submission). The other <b>{fmtInt(f.individual.all)} are individual issues</b>: {f.individual.error} errors (break a documented requirement), {f.individual.warning} warnings (need a look) and {f.individual.info} for information.
    </p>
  )
}

export function VegetationStoryBrief() {
  const f = facts()
  return (
    <div className="note story-brief">
      <div>
        <Verdict f={f} />
        <FlagCounts f={f} />
        <a className="small" href="#/summary:vegetation">
          The whole story in one minute →
        </a>
      </div>
    </div>
  )
}

export function VegetationStory() {
  const f = facts()
  const O = f.O
  const p = f.proj
  const items: { title: string; text: string; href: string; link: string }[] = [
    {
      title: 'Shrubland was not surveyed',
      text: `None of its ${f.shr?.primary_planned ?? '—'} planned plots was set up, so the project cannot report shrubland plants. In savanna, ${f.sav?.primary_surveyed ?? '—'} of ${f.sav?.primary_planned ?? '—'} planned plots were surveyed, plus ${f.sav?.backups_used ?? 0} backup.`,
      href: '#/qa:vegetation/effort',
      link: 'Planned against done',
    },
    {
      title: 'Where the data come from is uncertain',
      text: `The recorded altitudes are about ${f.altitude ?? '—'} m below the real terrain at these coordinates, including Natural State's own planned points, and ${f.noKenya} species have no record in Kenya (GBIF) but many in southern Africa. Confirm the origin before using any result.`,
      href: '#/qa:vegetation/taxonomy',
      link: 'Out-of-range species',
    },
    {
      title: 'Species names need cleaning',
      text: `${f.misspelled} names look misspelled and ${f.unresolved} plants are still unidentified (${pct(f.unknownShare)} of all records). With Natural State's own corrections, ${O.taxa_raw} recorded names become ${O.taxa_resolved} species.`,
      href: '#/qa:vegetation/taxonomy',
      link: 'Curation queue',
    },
    {
      title: 'Some species records are missing',
      text: `In ${f.missingRows} quadrats the team ticked "other species present" but recorded none, and ${f.emptyRecords} record has no species. The completeness figures of the ${f.provisional} plots involved are therefore provisional.`,
      href: '#/qa:vegetation/effort',
      link: 'Sampling effort',
    },
    {
      title: 'Some transects are not where or what the protocol says',
      text: `${f.badTransects} transects have a serious problem: too far from the planned point, far too short, bent, or only partly walked. All ${f.eastWest} of ${f.transects} run east–west instead of north–south, which looks like local practice to confirm, not ${f.transects} field errors.`,
      href: '#/qa:vegetation/map',
      link: 'Map of transects',
    },
  ]
  const good = [
    f.good.quadrats && 'every survey has all 20 quadrats',
    f.good.attachments && 'every photo and attachment is present',
    f.good.references && 'every link between tables resolves',
    f.good.gps && 'every GPS reading meets the 5 m instruction',
    f.good.edits && 'no submission was edited after upload',
  ].filter(Boolean) as string[]
  return (
    <section className="story">
      <div className="ds-eyebrow">The story in one minute</div>
      <Verdict f={f} />
      <div className="stats-row">
        <Stat label="Plots surveyed" value={`${O.plots_surveyed} of ${O.primary_points_planned}`} sub={`savanna ${f.sav?.primary_surveyed ?? '—'}/${f.sav?.primary_planned ?? '—'} + ${f.sav?.backups_used ?? 0} backup · shrubland ${f.shr?.primary_surveyed ?? 0}/${f.shr?.primary_planned ?? '—'}`} />
        <Stat label="Quadrats" value={fmtInt(O.quadrats_canonical)} sub={`${O.canonical_surveys} surveys × 20 · ${O.field_days} field days`} />
        <Stat label="Species" value={fmtInt(O.taxa_resolved)} sub={`${O.taxa_raw} names as recorded · ${O.taxa_resolved_identified} identified`} />
        <Stat label="Individual issues" value={fmtInt(f.individual.all)} sub={`${f.individual.error} errors · plus ${fmtInt(f.repeated)} repeats of ${f.patterns} project-wide patterns`} />
        <Stat label="Estimated total species" value={p ? `${n0(p.chao2)}` : '—'} sub={p ? `95% CI ${n0(p.chao2_lo95)}–${n0(p.chao2_hi95)} · coverage ${Number(p.coverage).toFixed(3)} · provisional` : ''} />
      </div>
      <h3 className="story-h">Five things to know</h3>
      <ol className="story-list">
        {items.map((it) => (
          <li key={it.title}>
            <b>{it.title}.</b> {it.text}{' '}
            <a href={it.href} className="small">
              {it.link} →
            </a>
          </li>
        ))}
      </ol>
      <div className="sum-grid two">
        <div>
          <h3 className="story-h">In good order</h3>
          <ul className="story-good">
            {good.map((g) => (
              <li key={g}>✓ {g}</li>
            ))}
          </ul>
        </div>
        <div>
          <h3 className="story-h">What to do next</h3>
          <ol className="story-list small">
            <li><b>Confirm where the data were collected</b> and the altitude reference (project lead).</li>
            <li><b>Clean the species names</b> with the suggested list in the Taxonomy view (botanist).</li>
            <li><b>Recover the missing species records</b> from field sheets or photos (field team).</li>
            <li><b>Decide on shrubland</b>: survey it next round or drop it from reporting (project lead).</li>
          </ol>
        </div>
      </div>
      <FlagCounts f={f} />
      <p className="small muted">
        Detail: the <a href="#/qa:vegetation/overview">QA/QC dashboard</a> (every flag with its source row) and the data quality report, <code>challenge2/Q1_data_quality_report.md</code>. Nothing in the data was changed; problems are flagged, not fixed.
      </p>
    </section>
  )
}

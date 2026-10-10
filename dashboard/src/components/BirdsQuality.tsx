/**
 * Data-quality checks of the bird files themselves (not confidence biases): structure, segment
 * integrity, file naming / lineage between the two exports, recorder clocks, ecological plausibility.
 * Everything is computed from the loaded CSVs.
 */
import { useMemo, useState, type ReactNode } from 'react'
import { fmtInt, fmtNum, fmtPct } from '../data/stats'
import type { Dataset, Row } from '../data/types'
import { hourOfMs as hourOf, inferClocks, NIGHTJAR, ORIOLE } from '../data/clocks'
import { type ThemeTokens } from '../lib/palette'
import type { OpenView } from './Summary'
import { TimeZones } from './TimeZones'
import { Stat } from './ui'

type Status = 'pass' | 'info' | 'flag'
interface Check {
  area: string
  check: string
  result: ReactNode
  status: Status
  why: string
}

const StatusChip = ({ s }: { s: Status }) => <span className={`qa-chip qa-${s}`}>{s === 'pass' ? '✓ pass' : s === 'flag' ? '⚑ flag' : 'ℹ info'}</span>

export function BirdsQuality({ reg, tokens: t, onOpen }: { reg: Map<string, Dataset>; tokens: ThemeTokens; onOpen: OpenView }) {
  const pred = reg.get('birdnet_predictions')
  const val = reg.get('validation_results')

  const q = useMemo(() => {
    if (!pred || !val) return null
    const P = pred.rows
    const V = val.rows
    const srcCols = (ds: Dataset) => ds.columns.filter((c) => !c.derived)
    const emptyCells = (ds: Dataset) => srcCols(ds).reduce((a, c) => a + ds.rows.filter((r) => r[c.name] === null).length, 0)
    const constant = (ds: Dataset) => srcCols(ds).filter((c) => c.distinct === 1).map((c) => c.name)
    const rowKey = (ds: Dataset, r: Row) => srcCols(ds).map((c) => String(r[c.name])).join('\u0001')
    const dupRows = (ds: Dataset) => ds.rows.length - new Set(ds.rows.map((r) => rowKey(ds, r))).size
    const dupSeg = P.length - new Set(P.map((r) => `${r.begin_path}|${r.common_name}|${r.begin_time_s}`)).size
    const durations = new Set(P.map((r) => (r.end_time_s as number) - (r.begin_time_s as number)))
    const past3600 = P.filter((r) => (r.end_time_s as number) > 3600).length

    // overlapping windows and selection completeness
    const byFileSp = new Map<string, number[]>()
    const selByFile = new Map<string, number[]>()
    P.forEach((r) => {
      const k = `${r.begin_path}|${r.common_name}`
      if (!byFileSp.has(k)) byFileSp.set(k, [])
      byFileSp.get(k)!.push(r.begin_time_s as number)
      if (!selByFile.has(String(r.begin_path))) selByFile.set(String(r.begin_path), [])
      selByFile.get(String(r.begin_path))!.push(r.selection as number)
    })
    let overlaps = 0
    let adjacent = 0
    byFileSp.forEach((xs) => {
      xs.sort((a, b) => a - b)
      for (let i = 1; i < xs.length; i++) {
        const d = xs[i] - xs[i - 1]
        if (d < 3) overlaps++
        if (d === 3) adjacent++
      }
    })
    let selGaps = 0
    selByFile.forEach((s) => {
      const max = Math.max(...s)
      if (new Set(s).size !== max) selGaps++
    })

    // naming / lineage
    const files = [...new Set(P.map((r) => String(r.begin_path)))]
    const roundedNames = files.filter((f) => /_\d{2}0000\.WAV$/i.test(f)).length
    const folderOk = P.filter((r) => String(r.begin_path).split('/')[1] === r.folder).length
    const gridByFile = new Map<string, number>()
    P.forEach((r) => gridByFile.set(String(r.recording_file), r.segment_grid as number))
    const gridsPerFile = new Map<string, Set<number>>()
    P.forEach((r) => {
      const k = String(r.begin_path)
      if (!gridsPerFile.has(k)) gridsPerFile.set(k, new Set())
      gridsPerFile.get(k)!.add(r.segment_grid as number)
    })
    const multiGridFiles = [...gridsPerFile.values()].filter((g) => g.size > 1).length
    const gridCounts = [0, 1, 2].map((g) => [...gridByFile.values()].filter((x) => x === g).length)
    let gridChecked = 0
    let gridAgree = 0
    V.forEach((r) => {
      const rf = String(r.recording_file ?? '')
      const stem = rf.replace(/\d{4}$/, '0000')
      if (gridByFile.has(stem) && typeof r.file_start_offset_s === 'number') {
        gridChecked++
        if (gridByFile.get(stem) === r.file_start_offset_s % 3) gridAgree++
      }
    })
    const offsets = V.map((r) => r.file_start_offset_s).filter((x): x is number => typeof x === 'number')
    const bigOffsets = offsets.filter((x) => x > 60).length
    const scoreName = V.filter((r) => Math.abs(Number(String(r.filename).split('_')[0]) - (r.confidence as number)) < 1e-9).length
    const namePairs = new Set(V.map((r) => `${r.scientificName}|${r.commonName}`)).size
    const species = new Set(V.map((r) => r.commonName)).size
    const link = (k: string) => V.filter((r) => r.link_to_predictions === k).length

    // recorder clocks from species activity (shared inference, see data/clocks.ts)
    const { clock, refO, refN } = inferClocks(P, (r) => (typeof r.detection_time === 'number' ? hourOf(r.detection_time) : null))
    const strongRecs = clock.filter((c) => c.strong).map((c) => c.rec)

    // plausibility
    const hourShare = (sp: string, test: (h: number) => boolean, rows = P) => {
      const xs = rows.filter((r) => r.common_name === sp && typeof r.detection_time === 'number').map((r) => hourOf(r.detection_time as number))
      return { share: xs.length ? xs.filter(test).length / xs.length : NaN, n: xs.filter(test).length }
    }
    const isNight = (h: number) => h >= 19 || h < 5
    const isDay = (h: number) => h >= 7 && h < 17
    const nightjarDay = hourShare(NIGHTJAR, isDay)
    const orioleNight = hourShare(ORIOLE, isNight)
    const orioleNightOk = hourShare(ORIOLE, isNight, P.filter((r) => !strongRecs.includes(String(r.folder))))

    const recDays = new Map<string, Set<number>>()
    P.forEach((r) => {
      const k = String(r.folder)
      if (!recDays.has(k)) recDays.set(k, new Set())
      if (typeof r.recording_date === 'number') recDays.get(k)!.add(r.recording_date)
    })
    const daysPer = [...recDays.entries()].map(([k, d]) => [k, d.size] as const).sort((a, b) => a[1] - b[1])

    const checks: Check[] = [
      { area: 'Structure', check: 'Empty cells', result: `${emptyCells(pred)} in predictions, ${emptyCells(val)} in validations`, status: emptyCells(pred) + emptyCells(val) ? 'flag' : 'pass', why: 'Missing values would silently drop rows from a model.' },
      { area: 'Structure', check: 'Duplicate rows', result: `${dupRows(pred)} exact duplicates in predictions (${dupSeg} duplicate file × species × segment), ${dupRows(val)} in validations`, status: dupRows(pred) + dupSeg + dupRows(val) ? 'flag' : 'pass', why: 'Duplicates inflate counts and give some clips double weight.' },
      { area: 'Structure', check: 'Constant columns', result: [...constant(pred), ...constant(val)].join(', ') || 'none', status: 'info', why: 'Raven/BirdNET defaults (one view, mono channel, full band 0–15 kHz) and a single model version (v2.4). Fine, but nothing to learn from them.' },
      { area: 'Segments', check: 'Segment length', result: [...durations].map((d) => `${d} s`).join(', '), status: durations.size === 1 && durations.has(3) ? 'pass' : 'flag', why: 'BirdNET scores 3-s windows; any other length would indicate a different export.' },
      { area: 'Segments', check: 'Overlapping windows (same species, same file)', result: `${overlaps} overlaps; ${fmtInt(adjacent)} back-to-back pairs (3 s apart)`, status: overlaps ? 'flag' : 'pass', why: 'No overlap setting was used. Back-to-back windows are often the same call or song bout — relevant if predictions are ever counted as vocalisations.' },
      { area: 'Segments', check: 'Selection numbers complete per file', result: `${selGaps} of ${fmtInt(selByFile.size)} files have gaps`, status: selGaps ? 'flag' : 'pass', why: 'Gaps would mean rows were removed after export.' },
      { area: 'Segments', check: 'Segments ending after 3,600 s', result: `${past3600} segments end at 3,601–3,602 s`, status: 'info', why: 'Explained by the naming issue below: times are counted from the top of the hour, so a file that started at :00:02 runs to 3,602 s.' },
      { area: 'File naming', check: 'Path format and recorder', result: `${fmtInt(folderOk)} of ${fmtInt(P.length)} rows: folder = recorder in path`, status: folderOk === P.length ? 'pass' : 'flag', why: 'The recorder id is the key to deployment metadata.' },
      { area: 'File naming', check: 'Prediction file names rounded to the hour', result: `${fmtInt(roundedNames)} of ${fmtInt(files.length)} file names end in HH0000`, status: 'flag', why: 'Validation file names for the same recordings keep the true start second (040002), and a few start minutes past the hour. Both exports name the same audio differently.' },
      { area: 'File naming', check: '3-s grid per file = true start second mod 3', result: `grids 0 / 1 / 2: ${gridCounts.join(' / ')} files; ${gridAgree} of ${gridChecked} validated clips agree with their file’s grid; ${multiGridFiles} files mix grids`, status: 'flag', why: 'Strongly supports that begin_time_s (and file_offset_s) count seconds from the top of the hour, not from the start of the audio. It does not prove the full offset: start times that differ by multiples of 3 s share a grid, which matters most for files starting minutes after the hour. Do not change clip-cutting offsets on this evidence alone — confirm with the exporter or audio headers.' },
      { area: 'File naming', check: 'Validation file-name score = confidence column', result: `${scoreName} of ${V.length}`, status: scoreName === V.length ? 'pass' : 'flag', why: 'The score is written into the clip name (BirdNET segments tool); a mismatch would break the score–outcome pairing.' },
      { area: 'File naming', check: 'Files starting well after the hour (validation names)', result: `${bigOffsets} validated clips from files that started > 1 min after the hour`, status: bigOffsets ? 'info' : 'pass', why: 'Recorder restarts or schedule changes; their predictions are still filed under HH:00:00.' },
      { area: 'Linkage', check: 'Validation ↔ prediction link', result: `${link('linked (unique)')} unique, ${link('linked (shared prediction)')} sharing a prediction, ${link('linked (tied score)')} tied score, ${link('not found')} not found (of ${V.length})`, status: link('not found') ? 'info' : 'pass', why: 'Validated clips must point to real predictions. Ties: several predictions in the same hour share the 3-decimal score — a shared clip id would remove the ambiguity.' },
      (() => {
        const prob = V.filter((r) => r.duplicate_check === 'probable duplicate')
        const amb = V.filter((r) => String(r.duplicate_check).startsWith('ambiguous'))
        const all = [...prob, ...amb]
        const sp = [...new Set(all.map((r) => String(r.commonName)))]
        const recs = [...new Set(all.map((r) => String(r.recorder)))]
        return {
          area: 'Linkage',
          check: 'Validated clips whose file names differ only by clip number',
          result: all.length
            ? `${prob.length / 2} probable duplicate pair(s) (one matching prediction) and ${amb.length / 2} ambiguous pair(s) (two same-score predictions in that hour) — ${sp.join(', ')}, ${recs.join(', ')}; outcomes ${new Set(all.map((r) => r.outcome)).size === 1 ? 'all agree' : 'differ'}`
            : 'none',
          status: (all.length ? 'flag' : 'pass') as Status,
          why: 'The same segment validated twice would count twice as evidence. Probable duplicates are dropped before fitting; ambiguous pairs are kept (more likely distinct segments) and the result is checked both ways. See docs/challenge1_data_decisions.md.',
        }
      })(),
      { area: 'Linkage', check: 'Species names consistent', result: `${namePairs} scientific–common name pairs for ${species} species`, status: namePairs === species ? 'pass' : 'flag', why: 'One taxon, one name.' },
      { area: 'Time', check: 'Recording coverage per recorder', result: `${daysPer.length} recorders; days with predictions range ${daysPer[0][1]}–${daysPer[daysPer.length - 1][1]} (fewest: ${daysPer.slice(0, 3).map(([k, d]) => `${k} ${d}`).join(', ')})`, status: 'info', why: 'Unequal deployment effort matters for any per-site comparison.' },
      {
        area: 'Time',
        check: 'Recorder clocks (from species activity)',
        result: (() => {
          const ev = clock.filter((c) => c.strong).map((c) => `${c.rec} (dawn onset ${c.dO! >= 0 ? '+' : ''}${fmtNum(c.dO!, 2)} h${c.dN !== null ? `, Nightjar ${c.dN >= 0 ? '+' : ''}${fmtNum(c.dN, 2)} h` : ', no Nightjar data'})`)
          const assessable = clock.length
          const consistent = clock.filter((c) => !c.strong && !c.weak).length
          return ev.length
            ? `Inferred, not confirmed: ${ev.join('; ')} — activity ~3 h early, consistent with a UTC clock (local is UTC+3). ${consistent} other recorders are consistent with local time; ${assessable} of ${new Set(P.map((r) => r.folder)).size} recorders have enough data to assess at all.`
            : 'no recorder deviates ≥ 2 h on clear evidence'
        })(),
        status: strongRecs.length ? 'flag' : 'pass',
        why: 'Wrong clocks shift every time-of-day result (hour_of_day, detection_time). They do not affect the score thresholds.',
      },
      { area: 'Plausibility', check: 'Nocturnal Nightjar detected in daytime (07–17 h)', result: `${fmtPct(nightjarDay.share, 1)} (${nightjarDay.n} predictions)`, status: nightjarDay.share > 0.02 ? 'flag' : 'pass', why: 'A quick ecological sanity check of species and clocks.' },
      {
        area: 'Plausibility',
        check: 'Diurnal Oriole detected at night (19–05 h)',
        result: `${fmtPct(orioleNight.share, 1)} (${orioleNight.n}); ${fmtPct(orioleNightOk.share, 1)} (${orioleNightOk.n}) excluding ${strongRecs.join(', ') || '—'}`,
        status: orioleNightOk.share > 0.02 ? 'flag' : 'info',
        why: 'Most night-time Oriole detections come from the recorders with suspected UTC clocks — they are really dawn song.',
      },
    ]
    return { checks, clock, refO, refN, strongRecs, orioleNight, gridCounts, files: files.length }
  }, [pred, val])

  const [tab, setTab] = useState<'checks' | 'time'>('checks')
  if (!q || !pred || !val) return <div className="empty">Bird files not found.</div>
  const n = (s: Status) => q.checks.filter((c) => c.status === s).length

  return (
    <div className="summary">
      <div className="task-card">
        <div className="ds-eyebrow">Challenge 1 · Data quality</div>
        <h1>Is the bird data itself sound?</h1>
        <p className="task-sub">Checks of the files themselves — structure, segment integrity, how the two exports name the same recordings, recorder clocks and ecological plausibility — independent of how confidence relates to correctness. Every result is computed from the CSVs; nothing is edited.</p>
      </div>

      <div className="paper-tabs" role="tablist" aria-label="Data quality views">
        <button type="button" role="tab" aria-selected={tab === 'checks'} className={`paper-tab ${tab === 'checks' ? 'on' : ''}`} onClick={() => setTab('checks')}>
          <span>All checks</span>
          <span className="role-dot">{q.checks.length} automated</span>
        </button>
        <button type="button" role="tab" aria-selected={tab === 'time'} className={`paper-tab ${tab === 'time' ? 'on' : ''}`} onClick={() => setTab('time')}>
          <span>Time zones &amp; clocks</span>
          <span className="role-dot">local or UTC?</span>
        </button>
      </div>

      {tab === 'time' && <TimeZones reg={reg} tokens={t} onOpen={onOpen} />}
      {tab === 'checks' && (
      <>
      <div className="stats-row">
        <Stat label="Checks run" value={q.checks.length} sub={`${q.checks.length} automated, from the CSVs`} />
        <Stat label="Pass" value={n('pass')} sub="no issue found" />
        <Stat label="Flags" value={n('flag')} sub="issues to report / fix upstream" />
        <Stat label="Info" value={n('info')} sub="worth knowing, not errors" />
      </div>

      <section className="sum-section">
        <div className="sum-section-head">
          <div>
            <h2>All checks</h2>
            <p className="muted">Hover a row’s “why” for context. Flags are issues to raise with whoever produces the exports; none of them changes the source data here.</p>
          </div>
        </div>
        <div className="table-wrap auto">
          <table className="data-table sum-table qa-table">
            <thead>
              <tr>
                <th>Area</th>
                <th>Check</th>
                <th>Result</th>
                <th>Status</th>
                <th>Why it matters</th>
              </tr>
            </thead>
            <tbody>
              {q.checks.map((c, i) => (
                <tr key={i} className={`qa-row-${c.status}`}>
                  <td className="muted small">{c.area}</td>
                  <td>
                    <b>{c.check}</b>
                  </td>
                  <td>{c.result}</td>
                  <td>
                    <StatusChip s={c.status} />
                  </td>
                  <td className="small muted">{c.why}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <div className="for-us">
        <div className="pipe-col-label">What to send upstream (and what it means for the thresholds)</div>
        <ul>
          <li>
            <b>Keep the true file start time.</b> The predictions export renames files to HH:00:00 and counts segment times from the hour. Store the real start timestamp and offsets relative to the audio file, so clips can be cut from the WAV correctly and both exports share one key.
          </li>
          <li>
            <b>Give every prediction a stable id</b> and carry it into the validation export. Today validated clips are linked by species + recorder + hour + a 3-decimal score, which leaves ties.
          </li>
          <li>
            <b>Record each recorder’s clock / time zone at deployment</b> (the ODK deployment form is the natural place) and check it against species activity automatically. {q.strongRecs.length ? `By inference from bird activity, ${q.strongRecs.join(' and ')} look about ${fmtNum(Math.abs(q.clock.find((c) => c.strong)?.dO ?? 0), 1)} h behind (possibly UTC) — deployment metadata should confirm this before it is used as fact.` : ''}
          </li>
          <li>For fitting thresholds, the score–outcome pairs themselves are intact: every clip’s score matches its confidence column, there are no duplicate prediction rows and segments are complete. Two issues still affect the inference and are handled in the fitting step: probable duplicate reviews (4 Plover pairs, plus 1 ambiguous pair) and clustering of clips by file and recorder. The naming and clock issues matter for time-of-day analyses, clip retrieval and future validation linkage.</li>
        </ul>
      </div>
      </>
      )}
    </div>
  )
}

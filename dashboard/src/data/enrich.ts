/**
 * Dataset-specific enrichment: parse keys that are hidden inside strings (file names,
 * ODK geopoints) and carry parent attributes down to child tables so data can be sliced.
 *
 * Rule: enrichment only *adds* derived columns (flagged `derived: true`). It never edits,
 * fixes or drops a source value — QA/QC findings must be flagged, not resolved.
 */
import { addColumn, tokens } from './load'
import { applyTransform, fmtInt } from './stats'
import type { Dataset, Row, Value } from './types'

type Registry = Map<string, Dataset>

// ── shared helpers ────────────────────────────────────────────────────────────

/** "RBS02_20230622_170000" → recorder, date, start (epoch ms, recorder clock read as UTC). */
function parseRecordingStem(stem: string) {
  const m = /^([A-Za-z0-9]+)_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})$/.exec(stem)
  if (!m) return null
  const [, recorder, y, mo, d, h, mi, s] = m
  const start = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s)
  return { recorder, start, day: Date.UTC(+y, +mo - 1, +d), hour: +h, secOfDay: +h * 3600 + +mi * 60 + +s }
}

const stemOf = (path: string) => path.split('/').pop()!.replace(/\.[^.]+$/, '')

/** ODK geopoint string "lat lon alt acc" (entity `geometry`) → numbers. */
function parseGeopoint(v: Value): [number, number, number, number] | null {
  if (typeof v !== 'string') return null
  const p = v.trim().split(/\s+/).map(Number)
  if (p.length < 2 || !p.slice(0, 2).every(Number.isFinite)) return null
  return [p[0], p[1], p[2] ?? NaN, p[3] ?? NaN]
}

function addGeometryColumns(ds: Dataset, col: string, layerLabel: string) {
  if (!ds.columns.some((c) => c.name === col)) return
  const parsed = ds.rows.map((r) => parseGeopoint(r[col]))
  const part = (i: number) => (_: Row, k: number) => parsed[k]?.[i] ?? null
  addColumn(ds, { name: `${col}_lat`, type: 'number', description: `Latitude parsed from ${col}` }, part(0))
  addColumn(ds, { name: `${col}_lon`, type: 'number', description: `Longitude parsed from ${col}` }, part(1))
  addColumn(ds, { name: `${col}_alt`, type: 'number', description: `Altitude (m) parsed from ${col}` }, part(2))
  addColumn(ds, { name: `${col}_accuracy`, type: 'number', description: `GPS accuracy (m) parsed from ${col}` }, part(3))
  ds.geo.push({ id: col, label: layerLabel, lat: `${col}_lat`, lon: `${col}_lon`, accuracy: `${col}_accuracy` })
}

/** Register every "<prefix>-Latitude / <prefix>-Longitude" pair ODK exported as a map layer. */
function detectOdkGeopoints(ds: Dataset, names: Record<string, string> = {}) {
  for (const c of ds.columns) {
    if (!c.name.endsWith('-Latitude')) continue
    const prefix = c.name.slice(0, -'-Latitude'.length)
    if (!ds.columns.some((x) => x.name === `${prefix}-Longitude`)) continue
    const short = prefix.split('-').pop()!
    ds.geo.push({
      id: prefix,
      label: names[short] ?? short.replace(/_/g, ' '),
      lat: `${prefix}-Latitude`,
      lon: `${prefix}-Longitude`,
      accuracy: ds.columns.some((x) => x.name === `${prefix}-Accuracy`) ? `${prefix}-Accuracy` : undefined,
    })
  }
}

function addDurations(ds: Dataset, start: string, end: string) {
  const has = (n: string) => ds.columns.some((c) => c.name === n)
  if (has(start) && has(end)) {
    addColumn(
      ds,
      { name: 'duration_min', type: 'number', description: 'Form open time: end_time − start_time, in minutes.' },
      (r) => (typeof r[start] === 'number' && typeof r[end] === 'number' ? ((r[end] as number) - (r[start] as number)) / 60000 : null),
    )
  }
  if (has(end) && has('SubmissionDate')) {
    addColumn(
      ds,
      {
        name: 'submission_delay_h',
        type: 'number',
        description: 'Hours between finishing the form (end_time) and the server receiving it (SubmissionDate).',
      },
      (r) =>
        typeof r[end] === 'number' && typeof r.SubmissionDate === 'number'
          ? ((r.SubmissionDate as number) - (r[end] as number)) / 3_600_000
          : null,
    )
  }
}

function indexBy(ds: Dataset | undefined, key: string): Map<Value, Row> {
  const m = new Map<Value, Row>()
  ds?.rows.forEach((r) => m.set(r[key], r))
  return m
}

// ── birds ─────────────────────────────────────────────────────────────────────

function enrichBirds(reg: Registry) {
  const pred = reg.get('birdnet_predictions')
  const val = reg.get('validation_results')

  if (pred) {
    const parsed = pred.rows.map((r) => parseRecordingStem(stemOf(String(r.begin_path ?? ''))))
    addColumn(pred, { name: 'grid', type: 'category', description: 'First folder of begin_path (deployment grid).' }, (r) =>
      String(r.begin_path ?? '').split('/')[0] || null,
    )
    addColumn(pred, { name: 'recording_file', type: 'text', description: 'Audio file name (without extension) from begin_path.' }, (r) =>
      stemOf(String(r.begin_path ?? '')),
    )
    addColumn(
      pred,
      { name: 'recording_start', type: 'datetime', description: 'Start of the audio file, from its name (recorder clock).' },
      (_, i) => parsed[i]?.start ?? null,
    )
    addColumn(
      pred,
      { name: 'detection_time', type: 'datetime', description: 'recording_start + begin_time_s (recorder clock).' },
      (r, i) => (parsed[i] && typeof r.begin_time_s === 'number' ? parsed[i]!.start + r.begin_time_s * 1000 : null),
    )
    addColumn(pred, { name: 'recording_date', type: 'datetime', description: 'Calendar day of the recording.' }, (_, i) => parsed[i]?.day ?? null)
    addColumn(
      pred,
      { name: 'hour_of_day', type: 'number', description: 'Hour (0–23, recorder clock) at which the segment starts.' },
      (r, i) => (parsed[i] && typeof r.begin_time_s === 'number' ? Math.floor((parsed[i]!.secOfDay + r.begin_time_s) / 3600) % 24 : null),
    )
    addColumn(
      pred,
      { name: 'logit_confidence', type: 'number', description: 'ln(c / (1 − c)), with c clamped to [1e-4, 1 − 1e-4]. The x-axis of Wood & Kahl (2024).' },
      (r) => (typeof r.confidence === 'number' ? applyTransform(r.confidence, 'logit') : null),
    )
  }

  if (val) {
    const parts = val.rows.map((r) => {
      const name = String(r.filename ?? '').replace(/\.[^.]+$/, '')
      const [, idx, ...rest] = name.split('_')
      return { idx: Number(idx), stem: rest.join('_'), rec: parseRecordingStem(rest.join('_')) }
    })
    addColumn(val, { name: 'outcome_label', type: 'category', description: 'outcome as a label: 1 → correct, 0 → incorrect.' }, (r) =>
      r.outcome === 1 ? 'correct' : r.outcome === 0 ? 'incorrect' : null,
    )
    addColumn(
      val,
      { name: 'logit_confidence', type: 'number', description: 'ln(c / (1 − c)), with c clamped to [1e-4, 1 − 1e-4].' },
      (r) => (typeof r.confidence === 'number' ? applyTransform(r.confidence, 'logit') : null),
    )
    addColumn(val, { name: 'recorder', type: 'category', description: 'Recorder id parsed from filename.' }, (_, i) => parts[i].rec?.recorder ?? null)
    addColumn(val, { name: 'recording_file', type: 'text', description: 'Source audio file parsed from filename.' }, (_, i) => parts[i].stem || null)
    addColumn(val, { name: 'clip_index', type: 'number', description: 'Second number in filename (clip index; not the prediction “selection”).' }, (_, i) =>
      Number.isFinite(parts[i].idx) ? parts[i].idx : null,
    )
    addColumn(val, { name: 'recording_start', type: 'datetime', description: 'Start of the source audio file (recorder clock).' }, (_, i) => parts[i].rec?.start ?? null)
    addColumn(val, { name: 'recording_date', type: 'datetime', description: 'Calendar day of the source recording.' }, (_, i) => parts[i].rec?.day ?? null)
    addColumn(val, { name: 'file_start_hour', type: 'number', description: 'Hour the source audio file starts (the clip offset inside the file is unknown).' }, (_, i) =>
      parts[i].rec ? parts[i].rec!.hour : null,
    )

    // Link validations ↔ predictions: same species, same audio file, confidence equal at 3 dp.
    if (pred) {
      const byKey = new Map<string, number[]>()
      pred.rows.forEach((r, i) => {
        const k = `${r.common_name}|${r.recording_file}`
        if (!byKey.has(k)) byKey.set(k, [])
        byKey.get(k)!.push(i)
      })
      const matchOf: (number | null)[] = val.rows.map((r) => {
        const cands = byKey.get(`${r.commonName}|${r.recording_file}`) ?? []
        let best: number | null = null
        let bestD = 0.0006
        for (const i of cands) {
          const d = Math.abs((pred.rows[i].confidence as number) - (r.confidence as number))
          if (d < bestD) {
            bestD = d
            best = i
          }
        }
        return best
      })
      const predOutcome = new Map<number, Value>()
      matchOf.forEach((pi, vi) => pi !== null && predOutcome.set(pi, val.rows[vi].outcome_label))
      const fileSet = new Set(pred.rows.map((r) => r.recording_file))

      addColumn(
        val,
        { name: 'link_to_predictions', type: 'category', description: 'Whether this clip was found in birdnet_predictions (species + file + confidence).' },
        (r, i) => (matchOf[i] !== null ? 'matched' : fileSet.has(r.recording_file) ? 'file present, no match' : 'file not in predictions'),
      )
      addColumn(pred, { name: 'validated', type: 'boolean', description: 'yes = an ornithologist validated this exact prediction.' }, (_, i) =>
        predOutcome.has(i) ? 'yes' : 'no',
      )
      addColumn(pred, { name: 'validation_outcome', type: 'category', description: 'correct / incorrect for validated predictions, empty otherwise.' }, (_, i) =>
        predOutcome.get(i) ?? null,
      )

      const matched = matchOf.filter((m) => m !== null).length
      const missingFile = val.rows.filter((r) => !fileSet.has(r.recording_file)).length
      const note = `${fmtInt(matched)} of ${fmtInt(val.rows.length)} validated clips match a row in birdnet_predictions (same species, file and confidence). ${fmtInt(
        missingFile,
      )} come from audio files that are not in the predictions file, so the predictions are a subset of the full BirdNET run.`
      val.notes.push(note)
      pred.notes.push(note)
    }
    val.notes.push('The audio clips themselves were not provided; only file names, scores and verdicts.')
  }
}

// ── vegetation ────────────────────────────────────────────────────────────────

function enrichVegetation(reg: Registry) {
  const survey = reg.get('herbaceous_veg_survey')
  const quad = reg.get('herbaceous_veg_survey-quadrat_repeat')
  const extra = reg.get('herbaceous_veg_survey-additional_species_repeat')
  const register = reg.get('register_vegetation_plots')
  const species = reg.get('species')

  if (survey) {
    addDurations(survey, 'survey_begin-start_time', 'survey_end-end_time')
    detectOdkGeopoints(survey, { background_geopoint: 'Background point (at submission)' })
    survey.labelColumn = 'plot_selection-plot_name'
  }

  if (register) {
    addDurations(register, 'survey_begin-start_time', 'survey_end-end_time')
    detectOdkGeopoints(register, {
      location_endpoint_a: 'Endpoint A',
      location_midpoint: 'Midpoint',
      location_endpoint_b: 'Endpoint B',
      background_geopoint: 'Background point (at submission)',
    })
    const p = 'plot_metadata-collect_points-'
    register.paths.push({
      id: 'transect',
      label: 'Transect A → midpoint → B',
      points: ['endpoint_a-location_endpoint_a', 'midpoint-location_midpoint', 'endpoint_b-location_endpoint_b'].map((k) => ({
        lat: `${p}${k}-Latitude`,
        lon: `${p}${k}-Longitude`,
      })),
    })
    register.labelColumn = 'plot_selection-plot_name'
  }

  const surveyByKey = indexBy(survey, 'KEY')
  if (quad) {
    const parent = (r: Row) => surveyByKey.get(r.PARENT_KEY)
    addColumn(quad, { name: 'plot_name', type: 'category', description: 'Plot of the parent survey (PARENT_KEY → survey KEY).' }, (r) =>
      parent(r)?.['plot_selection-plot_name'] ?? null,
    )
    addColumn(quad, { name: 'survey_review_state', type: 'category', description: 'ReviewState of the parent survey.' }, (r) =>
      parent(r) ? (parent(r)!.ReviewState ?? '(none)') : null,
    )
    addColumn(quad, { name: 'survey_device', type: 'category', description: 'DeviceID of the parent survey.' }, (r) => parent(r)?.DeviceID ?? null)
    addColumn(quad, { name: 'survey_recorder', type: 'category', description: 'Recorder of the parent survey.' }, (r) =>
      parent(r)?.['field_team_specifics-recorder_label'] ?? null,
    )
    const uuidCol = 'herb_species-selected_herb_species_uuids'
    const spByUuid = indexBy(species, '__id')
    addColumn(quad, { name: 'n_list_species', type: 'number', description: 'Number of uuids in selected_herb_species_uuids.' }, (r) =>
      tokens(r[uuidCol]).length,
    )
    addColumn(
      quad,
      { name: 'list_species_names', type: 'multi', sep: '|', description: 'selected_herb_species_uuids resolved to names via species.csv (unresolved uuids kept as-is).' },
      (r) => {
        const t = tokens(r[uuidCol])
        return t.length ? t.map((u) => String(spByUuid.get(u)?.label ?? u)).join('|') : null
      },
    )
    detectOdkGeopoints(quad, { location_quadrat: 'Quadrat location' })
    quad.labelColumn = 'plot_name'
  }

  const quadByKey = indexBy(quad, 'KEY')
  if (extra) {
    const q = (r: Row) => quadByKey.get(r.PARENT_KEY)
    addColumn(extra, { name: 'plot_name', type: 'category', description: 'Plot of the parent quadrat’s survey.' }, (r) => q(r)?.plot_name ?? null)
    addColumn(extra, { name: 'quadrat_number', type: 'number', description: 'quadrat_number of the parent quadrat.' }, (r) => q(r)?.quadrat_number ?? null)
    addColumn(extra, { name: 'survey_review_state', type: 'category', description: 'ReviewState of the parent survey.' }, (r) =>
      q(r)?.survey_review_state ?? null,
    )
    extra.labelColumn = 'validated_name'
  }

  for (const id of ['centroids', 'vegplots']) {
    const ds = reg.get(id)
    if (!ds) continue
    addGeometryColumns(ds, 'geometry', id === 'centroids' ? 'Prescribed centroid' : 'Registered plot')
    ds.labelColumn = 'label'
  }
}

export function enrichAll(reg: Registry): void {
  enrichBirds(reg)
  enrichVegetation(reg)
}

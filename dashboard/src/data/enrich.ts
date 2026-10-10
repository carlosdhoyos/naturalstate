/**
 * Dataset-specific enrichment: parse keys that are hidden inside strings (file names,
 * ODK geopoints) and carry parent attributes down to child tables so data can be sliced.
 *
 * Rule: enrichment only *adds* derived columns (flagged `derived: true`). It never edits,
 * fixes or drops a source value — QA/QC findings must be flagged, not resolved.
 */
import { inferClocks, hourOfMs } from './clocks'
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
  // Clock corrections per recorder (inferred from the predictions), reused for the validated clips.
  let corrections = new Map<string, number>()

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

    // Recorder clocks: most recorders run on local time (EAT, UTC+3); a few look like UTC.
    // The correction is inferred from bird activity (see data/clocks.ts), never hard-coded.
    corrections = inferClocks(pred.rows, (r) => (typeof r.detection_time === 'number' ? hourOfMs(r.detection_time) : null)).corrections
    const corr = (r: Row) => corrections.get(String(r.folder)) ?? 0
    addColumn(
      pred,
      { name: 'clock_correction_h', type: 'number', description: 'Hours added to this recorder’s clock to express it in local time (EAT, UTC+3). 0 for recorders consistent with local sunrise/sunset; +3 where bird activity shows the clock on UTC. An inference, not metadata.' },
      (r) => corr(r),
    )
    addColumn(
      pred,
      { name: 'detection_time_local', type: 'datetime', description: 'detection_time + clock_correction_h: best estimate of local time (EAT). Shown without time-zone conversion.' },
      (r) => (typeof r.detection_time === 'number' ? r.detection_time + corr(r) * 3_600_000 : null),
    )
    addColumn(pred, { name: 'hour_local', type: 'number', description: 'Hour of day (0–23) of detection_time_local.' }, (r) =>
      typeof r.detection_time_local === 'number' ? Math.floor(hourOfMs(r.detection_time_local)) : null,
    )
    addColumn(pred, { name: 'date_local', type: 'datetime', description: 'Calendar day of detection_time_local (can differ from recording_date for late-evening detections on corrected recorders).' }, (r) =>
      typeof r.detection_time_local === 'number' ? Math.floor(r.detection_time_local / 86_400_000) * 86_400_000 : null,
    )
    if (corrections.size)
      pred.notes.push(
        `Clock check: ${[...corrections.entries()].map(([k, h]) => `${k} (${h > 0 ? '+' : ''}${h} h)`).join(', ')} look like they ran on UTC instead of local time (UTC+3); all other recorders match local sunrise/sunset. Use hour_local / detection_time_local for time-of-day work. Thresholds are unaffected.`,
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
    addColumn(val, { name: 'file_start_hour', type: 'number', description: 'Clock hour of the source audio file (recorder clock). Segment times count from the top of this hour, so the validated clip lies within it.' }, (_, i) =>
      parts[i].rec ? parts[i].rec!.hour : null,
    )
    addColumn(
      val,
      { name: 'hour_local', type: 'number', description: 'Hour of day of the clip in local time (EAT): file_start_hour + the recorder’s inferred clock correction (+3 h for recorders whose clocks look like UTC).' },
      (_, i) => (parts[i].rec ? (((parts[i].rec!.hour + (corrections.get(parts[i].rec!.recorder) ?? 0)) % 24) + 24) % 24 : null),
    )

    addColumn(
      val,
      { name: 'file_start_offset_s', type: 'number', description: 'Seconds after the hour at which the source audio file started, from the validation file name (e.g. 040002 → 2). The predictions export rounds file names down to the hour instead.' },
      (_, i) => (parts[i].rec ? parts[i].rec!.secOfDay - parts[i].rec!.hour * 3600 : null),
    )

    // Link validations ↔ predictions. The two exports name the same audio file differently:
    // validation names keep the true start second (…_040002), the predictions export rounds the
    // name down to the hour (…_040000) and adds the offset to begin_time_s. So match on
    // species + recorder + day + hour + score (validation scores have 3 dp, predictions 4 dp).
    if (pred) {
      const hourKey = (sp: Value, rec: ReturnType<typeof parseRecordingStem>) => (rec ? `${sp}|${rec.recorder}|${rec.day}|${rec.hour}` : '')
      const byKey = new Map<string, number[]>()
      pred.rows.forEach((r, i) => {
        const k = hourKey(r.common_name, parseRecordingStem(stemOf(String(r.begin_path ?? ''))))
        if (!byKey.has(k)) byKey.set(k, [])
        byKey.get(k)!.push(i)
      })
      const cands: number[][] = val.rows.map((r, vi) =>
        (byKey.get(hourKey(r.commonName, parts[vi].rec)) ?? []).filter((i) => Math.abs((pred.rows[i].confidence as number) - (r.confidence as number)) <= 0.00051),
      )
      const status = cands.map((c) => (c.length === 1 ? 'linked (unique)' : c.length > 1 ? 'linked (tied score)' : 'not found'))
      const predOutcome = new Map<number, Value>()
      const tied = new Set<number>()
      cands.forEach((c, vi) => {
        if (c.length === 1) predOutcome.set(c[0], val.rows[vi].outcome_label)
        else c.forEach((i) => tied.add(i))
      })

      addColumn(
        val,
        { name: 'link_to_predictions', type: 'category', description: 'Link to birdnet_predictions on species + recorder + day + hour + score. “tied score”: several predictions in that hour share the same 3-decimal score, so the exact segment cannot be identified.' },
        (_, i) => status[i],
      )
      addColumn(pred, { name: 'validated', type: 'category', description: 'yes = an ornithologist validated this prediction (unique link); tied = one of several same-score candidates for a validated clip; no = not validated.' }, (_, i) =>
        predOutcome.has(i) ? 'yes' : tied.has(i) ? 'tied' : 'no',
      )
      addColumn(pred, { name: 'validation_outcome', type: 'category', description: 'correct / incorrect for uniquely linked validated predictions, empty otherwise.' }, (_, i) =>
        predOutcome.get(i) ?? null,
      )
      addColumn(pred, { name: 'segment_grid', type: 'number', description: 'begin_time_s mod 3. Each file sits on one 3-s grid (0, 1 or 2) — it equals the file’s true start second mod 3, because begin_time_s counts from the top of the hour, not from the file start.' }, (r) =>
        typeof r.begin_time_s === 'number' ? r.begin_time_s % 3 : null,
      )

      const n = (k: string) => status.filter((x) => x === k).length
      const note = `${fmtInt(n('linked (unique)') + n('linked (tied score)'))} of ${fmtInt(val.rows.length)} validated clips link to a prediction (same species, recorder, day, hour and score): ${fmtInt(
        n('linked (unique)'),
      )} uniquely, ${fmtInt(n('linked (tied score)'))} tied with other same-score predictions in that hour, ${fmtInt(n('not found'))} not found. The two files name the same audio differently: validation names keep the true start second (e.g. 04:00:02), the predictions export rounds names down to the hour and adds the offset to begin_time_s.`
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

  // ODK stamps every time with +02:00, but Kenya is UTC+3. The instants are right (see Data quality),
  // so the local hour is UTC + 3.
  const addLocalHour = (ds: Dataset, col: string) => {
    if (!ds.columns.some((c) => c.name === col)) return
    addColumn(
      ds,
      { name: 'start_hour_eat', type: 'number', description: 'Hour the form was opened in local Kenyan time (EAT, UTC+3). The device stamped times with +02:00, i.e. one hour behind local wall-clock time.' },
      (r) => (typeof r[col] === 'number' ? Math.floor(hourOfMs((r[col] as number) + 3 * 3_600_000)) : null),
    )
  }

  if (survey) {
    addDurations(survey, 'survey_begin-start_time', 'survey_end-end_time')
    addLocalHour(survey, 'survey_begin-start_time')
    detectOdkGeopoints(survey, { background_geopoint: 'Background point (at submission)' })
    survey.labelColumn = 'plot_selection-plot_name'
  }

  if (register) {
    addDurations(register, 'survey_begin-start_time', 'survey_end-end_time')
    addLocalHour(register, 'survey_begin-start_time')
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

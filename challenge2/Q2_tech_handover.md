# Vegetation QA/QC: handover to the Tech team

**For:** the Natural State Tech team building the automatic Vegetation QA/QC dashboard on the Analytics platform.
**Assumes:** the ODK submissions, entity lists and form definitions already arrive on the platform as tables. This document covers everything after that.
**Reference implementation:** `challenge2/` (Python 3.11 or later; tested with 3.13). It is the executable specification: same rules, same outputs, acceptance and mutation test suites, and a full run in about 3 seconds.

**Deployment model (recommended):** run the reference implementation as a scheduled container job, not a re-write. `challenge2/Dockerfile` builds it (`docker build -t vegqa:1.0.0 challenge2`). The job reads three mounted input folders (`/data/exports`, `/data/entities`, `/data/forms`), writes every output to `/out`, runs as a non-root user and needs no network. Outside a container the same flags apply: `--exports`, `--entities`, `--forms`, `--out`. The run id hashes inputs by role and file name, not path, so the same data give the same id wherever they are mounted (tested). If the team prefers to re-implement the rules in SQL or another stack, the acceptance and mutation suites define what "equivalent" means.

---

## 1. What to build, in one paragraph

On every new submission or entity change, rebuild the QA/QC outputs from the raw tables:

1. **Stage** the raw tables without changing any value.
2. **Join** them into four grains: submission, plot, quadrat, occurrence.
3. **Resolve** taxa through Natural State's curation table.
4. **Evaluate** every rule, writing one result row per rule × entity (`fail` / `pass` / `could_not_check`). The catalogue (`rules/rules.yaml`) holds each rule's metadata and thresholds; its logic is a Python function in `vegqa/checks/`.
5. **Publish** marts that the dashboard reads.

Flags never change data. Reviewers acknowledge them in a separate, append-only table that survives reruns.

```
raw (ODK tables, entity lists, form XLSX)        untouched; load id + content hash
 └─ staging      raw text + interpreted `_` columns (UTC times, numbers, token lists, geopoints)
     └─ core     submissions · plots (centroid + registration + geometry) · quadrats (+ transect position) · occurrences
         └─ resolved   occurrence taxon via species_extra_ids (merge chains, exclusions); canonical-survey flag
             ├─ qa_results    rule_id, status, severity, entity, plot, survey, source_table, source_key, observed, expected, message, run_id
             ├─ marts         survey_overview, submissions, plots, quadrats, occurrences, effort_*
             └─ flag_reviews  (dashboard writes) flag_id + evidence_hash -> decision, by, at, note   [append-only]
```

## 2. Inputs and how they join

| Table | Grain | Key | Joins to |
|---|---|---|---|
| `herbaceous_veg_survey` | survey submission | `KEY` | `plot_selection-selected_plot_uuid` → `vegplots.__id`; `survey_begin-selected_survey_uuid` → `surveys.__id`; team and recorder → `project_team.__id`; transport → `transport.__id` |
| `…-quadrat_repeat` | quadrat | `KEY` | `PARENT_KEY` → survey `KEY` |
| `…-additional_species_repeat` | additional-species row | `KEY` | `PARENT_KEY` → quadrat `KEY`; `target_extra_name` / `select_reuse_*` → `species_extra.__id` |
| `register_vegetation_plots` | plot registration | `KEY` | `plot_selection-selected_plot_uuid` → `centroids.__id` |
| `vegplots` (entity) | registered plot | `__id` | `plot_uuid` → `centroids.__id` (**the link between a survey and its registration**) |
| `centroids` (entity) | prescribed point | `__id` | primary/backup, stratum |
| `species` (entity) | project species list | `__id` | `groups` = herbaceous / woody |
| `species_extra` (entity) | provisional taxon slot | `__id` | `group_type` + `unknown_index` → curation key `herb_NNN` / `wood_NNN` |
| `species_extra_ids` (entity) | NS curation | `species_number` | resolved name; free-text notes ("duplicate of herb_011", "should be excluded") |
| form XLSX (`survey`, `choices`, `settings`) | form definition | field `name` | used for versions, choice lists and form rules; parse them, do not hard-code |

**Watch for these:**

- A survey points to a **vegplot**; a registration points to a **centroid**. Use `vegplots.plot_uuid` to link the two.
- Multi-selects are space-separated uuids.
- Repeat groups are separate tables linked by `PARENT_KEY`.
- Some choice names contain spaces ('loam soils'), so they cannot be split on spaces safely (K04).
- Timestamps carry a +02:00 label, but the instants are correct. Convert to UTC, and derive local days as UTC + 3 h (V-07).

## 3. Staging and core: rules for the build

- **Never overwrite a source value.**
  - Read every column as text.
  - Add interpreted values as new columns (prefixed `_` in the reference implementation): `_start`, `_end` and `_submitted` (UTC), `_lat`, `_lon`, `_acc`, `_species` (token list), `_photo_time`.
  - A value that cannot be interpreted becomes null in the new column, and a rule turns that into a flag.
- **Photo capture time** comes from the image file name. ODK names images by epoch milliseconds, e.g. `1779868793110.jpg`.
- **Canonical survey (V-01):** for each plot × replicate, at most one: among submissions whose ODK review state is not excluded (`rejected`, `hasIssues`; configurable as `canonical_excluded_review_states`), the latest by `_end`. A plot whose submissions are all excluded has **no** canonical survey, and J03 reports it.

  Keep every submission, with `canonical` true/false and the reason. Only canonical surveys count for richness and effort.
- **Never assume what a rule checks.** Every lookup by key keeps the first row of a duplicated key (`load.by_key`), so duplicates reach A02 instead of crashing an earlier step. Repeat visits are paired, and plots summarised, within one replicate. A survey with no quadrats, or with no taxa, gets an explicit effort row (`note`), with undefined ratios rather than 100% or infinity. `tests/test_robustness.py` runs the whole workflow on such inputs.
- **Occurrences:** one row per list species picked in a quadrat (`source = list`), plus one row per additional-species row (`source = extra`). The slot is chosen by `species_entry_mode`: `new_*` → `target_extra_name`; `reuse_unknown` → `select_reuse_unknown`; `reuse_missing` → `select_reuse_missing`.
- **Resolved taxon (V-02):**
  1. Map the slot to `herb_NNN` using its `group_type` and `unknown_index`.
  2. Follow "duplicate of X" merges until there are none left.
  3. If the slot is excluded, the status is `excluded`.
  4. If curated to a name, use the name; if curated to "Unknown", the slot stays its own unresolved taxon.
  5. List species keep their list label.

  The resolved key is the lower-cased name with single spaces. **Never correct spellings.** Spelling problems are flags (F03, F13).
- **Geometry:**
  - A local equirectangular projection around the project is enough (error ≪ GPS error); the reference uses the centroid mean.
  - Per plot: the A–M–B points, the midpoint offset, the lengths, the angle A–M–B and the bearing.
  - Per quadrat: the along and signed lateral position relative to the registered A→B segment, and the residual from the survey's own robust (trimmed total-least-squares) line.

## 4. The rule catalogue (`rules/rules.yaml`)

The catalogue is the contract. It has 94 rules, in groups:

| Group | Covers |
|---|---|
| A | Structure and references |
| B | Submission lifecycle |
| C | The form's own rules, re-checked |
| D | Registration geometry |
| E | Quadrat geometry and timing |
| F | Taxonomy |
| G | Plausibility |
| J | Plan vs execution |
| K | Form and platform feedback |
| X | Entity vs what the forms wrote |
| P | Column profiling |

The YAML holds each rule's **metadata and thresholds**, not its logic. The logic is one Python function per rule, so changing a threshold needs no code, but a new rule does. Each rule has:

```yaml
D01: {group: D, level: plot, severity: error, metric_impact: indirect,
      source: "Registration SOP step 5 (midpoint <= 25 m from prescribed)",
      title: "Midpoint too far from the prescribed point",
      why: "The plot is not where the design placed it (sampling bias)",
      action: "Confirm the location; re-register if needed"}
```

Thresholds live in the same file, under `thresholds:`, each commented with its source or with "judgement".

**Engine contract** (what the reference `vegqa/engine.py` enforces):

- **One implementation per catalogued rule.** The run refuses to start if the catalogue and the code disagree, so the published catalogue is always the executed one.
- **One result row per evaluated entity**, including passes. `could_not_check` is used when the needed data are missing; it is never shown as a pass.
- **Severity defaults to the rule's.** A rule may raise or lower it per row with a documented reason, for example GPS z-score tiers or info for context.
- **A value the form could not have produced is an error** with action "investigate (possible manual edit)". Examples: a broken constraint, a missing required field, an out-of-list choice.
- **Deterministic.** Rows are sorted, and `run_id` is a hash of the input file hashes, the catalogue and the code version. The same inputs give the same `run_id` and identical results (tested).

**Three systematic sweeps** are rule groups in their own right, because they catch problems no hand-written domain rule anticipates:

| Sweep | Rules | What it checks |
|---|---|---|
| C (form rules) | C01–C17 | The form rules re-checked on the export. C01–C16 are hand-written from the forms' required, relevant, constraint and calculation rows. C17 is generic: it parses every `instance('list')/root/item[name = ${field}]/column` calculation from the XLSForm and recomputes it from the entity list. More complex expressions (counts, joins and positions inside repeats) have their own rules: C05–C07, C14, F14 |
| P | P01–P03 | Profiling of every column: padding, mixed types, duplicate labels, values outside their choice list |
| X | X01 | Entity state compared with what the last submission wrote |

**Adding a rule:**

1. Add the YAML entry.
2. Add a function decorated with `@rule("ID")` in the matching `checks/` module.
3. Add a test that pins a case it must flag.

**Formulas that need care:**

- **GPS-aware z (V-04):** z = |measured − design| / √(Σ reported accuracy²); z > 2 is a warning, z > 3 is an error.
  - Midpoint offset: error beyond 25 m + 2 × the midpoint accuracy.
  - Whole-transect offset: trimmed mean of the signed lateral offsets, with z computed against √(line accuracy² + median quadrat accuracy²).
- **Stale entity list (B10):** compare `base_active_herb_count` with the number of distinct slots activated (`new_*` rows) by surveys that **ended** before this one **started**, on any device. Separately, say whether those slots were already on the server, which tells a late upload from a device that was not refreshed.
- **Form calculation bug (C07):** recompute "quadrats with species" correctly and also as the form literally computes it. A stored value equal to the literal version identifies the form bug (K02).
- **Spelling (F03, F13):** use the GBIF backbone match from the cached reference file. A GBIF exact match outranks similarity to another list name. Never call GBIF during a QA run (§7).
- **Lookup calculations (C17):** a stored value different from the entity value its calculation reads could not come from the form file. It points to an edit, or to a deployed form that differs from the file. A pattern shared by every submission, together with ODK Central's `Edits` field, tells them apart; here every registration takes the geohash from the measured midpoint, so it is reported as info (C-12). Entity lists the forms themselves write to (`species_extra`) are excluded, because their values legitimately change after the form read them; F14 and X01 check those slots.
- **Terrain (E14):** GPS altitude minus SRTM elevation, from the cached elevation file. One project row compares the whole dataset, NS's centroid altitudes included, with the terrain. A submission is flagged only when it departs from that dataset offset by more than 100 m, so a dataset-wide offset is not blamed on the field.

## 5. Effort statistics (marts `effort_*`)

These use incidence data per canonical plot (T = 20 quadrats), on both the raw and the resolved layer:

- **Rarefaction curve:** S(t) = Σᵢ [1 − C(T−Yᵢ, t) / C(T, t)].
- **Bias-corrected Chao2:** S_obs + (T−1)/T · Q1(Q1−1) / (2(Q2+1)), with the log-normal 95% interval (Chao 1987).
- **Sample coverage:** 1 − Q1/U · [(T−1)Q1 / ((T−1)Q1 + 2Q2)]. No interval; a valid one needs iNEXT's assemblage bootstrap.
- **New taxa in one more quadrat:** Q0 · Q1 / (T·Q0 + Q1), with Q0 = (T−1)/T · Q1²/(2Q2) (Chao et al. 2014).
- **Diversity:** observed incidence-based Hill numbers q = 0, 1, 2 from relative quadrat frequencies.
- **Metric status per plot (`metrics_status`):**
  - `ok`.
  - `provisional: <rules>`: shown, but conditional on records that a structural or record rule found incomplete (A01–A04, C02, C04, C08, C13).
  - `suppressed`: records are missing or none is analytical, so there is nothing to read. Suppressed takes precedence over provisional.
- **Project level:** the same statistics with plots as the sampling units, per replicate (rounds are never pooled).
  - Its `metrics_status` inherits from its plots: provisional when any plot is provisional or suppressed (here "7 of 30 plots provisional (C04)").
  - The `*_ok_plots` columns repeat the estimate on the ok plots only, so readers see how much the qualified plots move it.
- **Planned vs done:** per stratum, from `centroids` (primary/backup), registrations and canonical surveys.
- **Repeatability:** plot and mean quadrat Jaccard for any plot with two or more submissions in a replicate.
- **Richness sensitivity (per replicate):** raw, canonical, resolved, resolved with GBIF spelling variants collapsed, identified only, unknowns only. A sensitivity analysis over defensible definitions, not bounds on true richness.

Show coverage first. Chao2 intervals are wide with 20 quadrats (V-10). Wherever a metric is displayed, display its `metrics_status` with it.

## 6. The dashboard

A working reference of every view is the **QA/QC dashboard** page of the Data Explorer (`dashboard/standalone/index.html`). It embeds `outputs/dashboard_results.json`, which `vegqa/dashboard.py` writes on every run, and never recomputes a rule, so the page shows exactly what the job publishes. Every view reads the marts and `qa_results`.

- **Source records:** clicking a flag's source shows the original record from the embedded export, with its full key to copy (for ODK Central) and a link to the full table.
- **Shared filters**, in one row above the views: replicate, stratum, device, recorder and date range. They apply to every view built from flags, submissions or plots.
  - **Overview:** the headline counts (plots surveyed, quadrats, flags) follow the filters.
  - **Map and Plots:** device, recorder and date keep the plots visited under them; stratum and replicate filter directly.
  - **Whole-run figures** are labelled "whole run" while a filter is on. These are the taxon totals (a union of taxa needs the records), the taxonomy headline cards, and the Rules and Effort views.
- **View filters:** each view adds its own (severity, rule group, rule, plot, text, canonical only).
- **"Passed everywhere":** lists only rules with no failure **and** no could-not-check result.

| View | Shows | Source |
|---|---|---|
| **Overview** | Headline numbers (plots planned / registered / surveyed, quadrats, taxa raw / resolved); flags by severity and group; the top open errors; a "not checked" counter | `survey_overview`, `rule_summary`, `qa_results` |
| **All flags** | Every failure with severity, observed and expected values, action, and source table + key; filters by severity, group, rule, plot and text; canonical-only toggle; CSV download | `qa_results` |
| **Submissions** | Timeline per device (form open → upload), upload delay, duration against the median, review state, canonical choice, flags per submission | `submissions`, `canonical_choice` |
| **Map** | Prescribed points by status (surveyed / not viable / never registered / backup); click a plot to see its registered A–M–B line, the 5 m belt, the 25 m circle, and quadrats coloured by flag | `plots`, `quadrats` |
| **Plots** | One row per plot: geometry (offset, length, bearing), richness raw / resolved, all-unknown quadrats, coverage, flag counts; a heatmap of plots × rule groups | `plots`, `effort_plots` (coverage is joined by plot **and** replicate, with its metrics status) |
| **Taxonomy** | A curation queue: names to check (F03), curation-table issues (F13), unresolved unknowns by record count (F07), out-of-range taxa (F10), duplicate entities (F04); suggested species-list updates (downloadable); raw → resolved mapping per taxon | `occurrences`, `qa_results`, `species_list_suggestions` |
| **Effort** | One replicate at a time (a selector appears when a run has several). Shows: the metrics status (a banner when provisional, with the ok-plots-only estimate); planned vs done per replicate and stratum; accumulation curves (provisional plots dashed, median of ok plots); coverage and completeness per plot (provisional plots marked); the list of qualified plots with the rule behind each; project completeness; repeatability; richness sensitivity | `effort_*` |
| **Rules** | The catalogue with fail / pass / not-checked counts and its thresholds, so reviewers see what *was* checked | `rule_summary` |
| **Field feedback** | "Check tonight": the day's submissions with errors and warnings the team can still fix in the field (missing rows, empty occurrences, position outliers, late uploads), plus process reminders (upload, refresh lists) | `qa_results` filtered by date |

**Multiple monitoring rounds.** Every effort mart is computed per replicate (tested with a synthetic second round), and the Effort view filters by it. The supplied data has a single round, so the reference page's multi-round display has not been checked in a browser. Treat it as built for one round and ready for more, not as a finished multi-year monitoring interface; trends across rounds are out of scope.

**Flag reviews (specified; not implemented in the reference page).** Reviewers mark a flag as `acknowledged`, `accepted as is`, `fixed upstream` or `false positive`, with a note. Every result row already carries the keys this needs:

- `project_id`: the survey entity the run covers (here `savmon|lw|herbs|ho`).
- `flag_id`: a hash of (project, rule, entity type, entity key). It is stable across runs, so a decision re-attaches to the same flag in every later run.
- `evidence_hash`: a hash of the evidence (observed, expected, severity) and of the rule's definition (its catalogue entry and the thresholds). A decision applies only while both are unchanged; if either changes (new evidence, or a rule whose meaning or threshold changed), the flag shows as reopened.

Store decisions in `flag_reviews`:

- append-only, so the history is kept;
- a flag whose entity no longer fails shows as "resolved by data".

Data are never edited from the dashboard.

```sql
create table qa_results (
  run_id text not null, project_id text not null, flag_id text not null, evidence_hash text not null,
  rule_id text not null, status text not null check (status in ('fail','pass','could_not_check')),
  severity text not null check (severity in ('error','warning','info')), entity_type text not null, entity_key text not null,
  plot_name text, survey_key text, source_table text, source_key text, observed text, expected text, message text,
  primary key (run_id, rule_id, entity_type, entity_key));
create table qa_runs (run_id text primary key, started_at timestamptz not null, code_version text, catalogue_version text,
  input_hashes jsonb not null, status_counts jsonb);
create table flag_reviews (id bigserial primary key, project_id text not null, flag_id text not null, evidence_hash text not null,
  rule_id text not null, entity_type text not null, entity_key text not null,          -- denormalised for reading
  decision text not null check (decision in ('acknowledged','accepted_as_is','fixed_upstream','false_positive')),
  note text, reviewed_by text not null, reviewed_at timestamptz not null default now());  -- append-only: no updates or deletes
-- a flag's current decision: the latest review with the same flag_id AND evidence_hash; otherwise the flag is open
```

## 7. Running it on the platform

- **Triggers:**
  - a new or changed submission;
  - a review-state change;
  - an entity-list update, especially `species_extra_ids`;
  - a nightly full run.

  A full run takes seconds, so incremental logic is not needed at this scale. Rebuild everything per project and replicate, which keeps results consistent.
- **Input contract (implemented):** `vegqa/contracts.py` checks every required file and column before analysis. A broken export stops with one message listing what is missing; nothing is half-written.
- **Staged publication (implemented, with a stated limit):**
  - A run writes to `out/.staging-<run_id>/` and validates the staged results. A failure up to that point leaves `out/` exactly as it was (tested).
  - Publication then moves the files into `out/` one by one, with `run_manifest.json` last. Each move is atomic, but the set is not, so a crash during those moves can leave new files beside old ones.
  - That state is detectable, never silent: a `.publishing-<run_id>` marker stays in `out/`, the manifest lists a hash for every output, and `run_challenge2.py --out <dir> --verify` reports every file that does not match. Re-running repairs it (tested).
  - Consumers should read `out/` only when `--verify` passes.
- **Atomic publication (specified for the platform):** write each run to its own folder, `runs/<run_id>/`, and switch one pointer to it as the last step (a symlink replaced with `rename`, or a `current_run_id` row updated in one transaction). Readers then always see one complete run. This was not built here because `out/` may be a mounted folder that cannot itself be renamed, and the committed outputs are read in place by the report and the dashboard.
- **Runtime provenance (implemented):** the manifest records the Python, platform, package versions and the image tag (`VEGQA_IMAGE`). The run id covers inputs, catalogue and code, not the environment.
- **Idempotent:** the same inputs give the same `run_id`, so a rerun replaces nothing.
- **Keep runs:** retain `qa_runs` with input hashes; the dashboard shows the latest and can diff two runs.
- **External references stay outside the run:**
  - A separate job refreshes `reference/gbif_cache.json`: the backbone match plus presence-only (`occurrenceStatus=PRESENT`) counts by country, with a retrieval date and query version per name. It fetches new names, entries from an older query, and entries older than `--max-age-days` (suggested: 180). The same applies to `reference/elevation_cache.json` (`python -m vegqa.dem`) for new points; SRTM is static, so one dataset-level date suffices.
  - The QA run reads only the cache, so it is offline and reproducible.
  - A name missing from the cache is `could_not_check`.
- **Form versions:** parse the XLSForm on each run (versions, choice lists, rule expressions). When a new version is deployed, rules that read the form follow it automatically. A07 flags submissions made with an older version.
- **Thresholds** are configuration (`rules.yaml`), versioned with the code. A threshold change is a catalogue change, so the `run_id` changes.

## 8. Acceptance tests and verification status

`challenge2/tests` (161 tests, run with `pytest`) holds the acceptance and mutation suites to port:

| Area | What the tests pin |
|---|---|
| Exploration findings | All 35 findings of the exploratory review (S1–S10, R1–R6, Q1–Q9, T1–T10), each pinned to the rule that must re-find it |
| Passed checks | The 12 checks that passed must still report `pass` |
| Differences | Deliberate differences from the exploration (`docs/challenge2_decisions.md`) |
| New findings | N1–N13 |
| Robustness | The whole workflow (rules, marts, effort, figures, dashboard export) runs on invalid inputs, reports them, and gives semantically valid summaries. Covered: duplicate keys in every table (no copy canonical, no double count), a duplicated quadrat (still 20 sampling units, provisional metrics), a survey with no quadrats, no vegetation, or missing species records (valid zero vs suppressed), rejected-only and hasIssues plots, a fractional quadrat number, a second replicate, missing registration coordinates or accuracies (could not check), a broken export (stops before analysis), a run that fails before publication (previous outputs intact), and a crash during publication (detected by the marker and the manifest hashes, repaired by a re-run) (`test_robustness.py`) |
| Mutations | 35 rules must create a new failing entity on a copy of the data with one injected error, compared with an unmutated baseline (`test_mutations.py`); J04 must pass at a cell centre |
| Properties | Determinism (identical results and `run_id` on rerun); inputs never modified (file hashes before and after); raw columns identical to the export; row counts; one canonical survey per plot; every result field is text; catalogue = code |
| Unit tests | Projection, bearings, segment frame, robust line, Chao2 / coverage / rarefaction formulas, curation parsing |

| Item | Status |
|---|---|
| All rules implemented and run on the provided data | Done (run `qa-46e4adc99ee099c0`) |
| Acceptance, mutation, robustness and unit tests | 161 passing |
| GBIF cache | 99 names, retrieved 2026-10-10 |
| Elevation cache | 770 points (SRTM 90 m), retrieved 2026-10-10 |
| Container job | **Built and run** (`docker build -t vegqa:1.0.0 challenge2`). On the take-home data (rebuilt 2026-10-11): same run id; every table and the dashboard JSON are byte-identical to a local run. The figure PNGs are re-rendered on Linux and are not byte-identical. Its `out/` passes `--verify` |
| Dashboard views | Reference page built: Data Explorer → Vegetation → QA/QC dashboard (`dashboard/src/components/VegetationQA.tsx`), reading `outputs/dashboard_results.json`. All nine views of section 6 run on the provided data |
| Effort-metric qualification | Shown where the numbers are read: per-plot and project `metrics_status` in the Effort and Plots views (7 of 30 plots provisional, C04) |
| Publication | Staged; a failure before publication leaves the previous run intact; a crash during publication is detected (`--verify`) and repaired by a re-run (tested). **One atomic pointer switch: specified only** (§7) |
| Multiple monitoring rounds | Marts kept apart per replicate (tested with a synthetic second round); the Effort view filters by replicate, but its multi-round display has not been browser-checked (one round in the data) |
| Flag-review workflow | **Specified only** (DDL above): review keys exist on every result; decisions are not stored or shown |
| Scheduling, database persistence, run comparison | **Specified only** (§7); the reference writes files |
| Structured curation fields | **Specified only** (§9); defensive parsing of free-text notes in place |
| Statistical cross-check against iNEXT | **Not run** (R unavailable here); closed-form unit tests only. The custom Chao2 interval and coverage code should be checked against iNEXT before the numbers are used operationally |
| Platform integration (triggers, storage) | To build |

## 9. Platform and form issues to fix upstream

These are flagged by the K rules, but a QA dashboard cannot fix them:

1. **Rejected submissions keep their entity writes** (K03). ODK Central does not roll back entity updates on rejection: herb_100–102 still carry what the rejected Plot 21 survey wrote. The review process needs a manual revert step, or a platform check.
2. **Upload discipline** (B06, B10). Devices must upload after each survey and refresh entity lists before the next. Otherwise two devices can give the same provisional id to different plants. On 26 May this happened only for repeats of the same plants, so no record is wrong, but the process allowed it. Add a dashboard alert when `base_active_herb_count` is below the server's active count at form start.
3. **Form fix** (K02). `quadrats_with_species` should use `herb_species/selected_herb_species_uuids`.
4. **Form hygiene** (K01, K04):
   - choice names without spaces;
   - one name per field;
   - consistent image `max-pixels`;
   - a quadrat GPS warning at 5 m, as in registration;
   - a filter so a plot cannot be registered twice;
   - align the SOP's `Genus_species` with the form's spaces.
5. **Device time zone** (B12): set Africa/Nairobi.
6. **Curation table** (F13): replace free-text notes with structured fields:
   - `merge_into`: target slot, validated to exist and not to form a cycle;
   - `exclude`: yes/no;
   - `reason`;
   - `curator`;
   - `decided_on`;
   - labels that match their numbers.

   Until then the parser applies only non-negated phrases and flags negated or ambiguous notes for a curator (V-13).

## 10. Files

| Path | What it is |
|---|---|
| `challenge2/rules/rules.yaml` | Rule catalogue and thresholds |
| `challenge2/src/run_challenge2.py` | Entry point: build everything, write `outputs/` |
| `challenge2/src/vegqa/load.py` | Staging: raw text plus interpreted columns |
| `challenge2/src/vegqa/forms.py` | XLSForm parser (versions, choices, fields, design issues) |
| `challenge2/src/vegqa/model.py` | Canonical survey, registration geometry, quadrat positions |
| `challenge2/src/vegqa/taxonomy.py` | Occurrences and the resolved layer |
| `challenge2/src/vegqa/engine.py` | Rule registry, result rows, run id |
| `challenge2/src/vegqa/checks/` | One module per rule group |
| `challenge2/src/vegqa/effort.py` | Effort statistics |
| `challenge2/src/vegqa/tables.py` | Marts |
| `challenge2/src/vegqa/figures.py` | Report figures |
| `challenge2/src/vegqa/gbif.py` | GBIF cache refresh (network) |
| `challenge2/src/vegqa/dem.py` | Elevation cache refresh (network) |
| `challenge2/src/vegqa/report_tables.py` | Refreshes the report's generated tables |
| `challenge2/src/vegqa/suggestions.py` | Suggested species-list and curation updates |
| `challenge2/src/vegqa/dashboard.py` | Writes `outputs/dashboard_results.json` for the dashboard |
| `dashboard/src/components/VegetationQA.tsx` | Reference dashboard page (React + Plotly) |
| `challenge2/reference/gbif_cache.json` | Cached GBIF reference |
| `challenge2/reference/elevation_cache.json` | Cached SRTM elevations |
| `challenge2/tests/` | Acceptance, mutation, robustness and unit tests |
| `challenge2/Dockerfile` | Job image: the pipeline on mounted inputs, outputs to `/out` |
| `docs/challenge2_decisions.md` | Decisions V-01 to V-11, differences, new findings, independent review, confirmation items |

**To run:**

```bash
python -m venv challenge2/.venv && challenge2/.venv/bin/pip install -r challenge2/requirements.txt
challenge2/.venv/bin/python challenge2/src/run_challenge2.py          # outputs/ and figures (--exports/--entities/--out for other data)
(cd challenge2/src && ../.venv/bin/python -m vegqa.report_tables)     # refresh the report's tables
(cd challenge2/tests && ../.venv/bin/python -m pytest -q)            # acceptance, mutation and unit tests
(cd dashboard && npm install && npm run build)                       # rebuild the dashboard with the new outputs
```

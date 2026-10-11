# Vegetation QA/QC: handover to the Tech team

**For:** the Natural State Tech team building the automatic Vegetation QA/QC dashboard on the Analytics platform.
**Assumes:** the ODK submissions, entity lists and form definitions already arrive on the platform as tables. This document covers everything after that.
**Reference implementation:** `challenge2/` (Python 3.11). It is the executable specification: same rules, same outputs, an acceptance test suite, and a full run in about 3 seconds.

---

## 1. What to build, in one paragraph

On every new submission or entity change, rebuild the QA/QC outputs from the raw tables:

1. **Stage** the raw tables without changing any value.
2. **Join** them into four grains: submission, plot, quadrat, occurrence.
3. **Resolve** taxa through Natural State's curation table.
4. **Evaluate** every rule in a declarative catalogue (`rules/rules.yaml`), writing one result row per rule × entity (`fail` / `pass` / `could_not_check`).
5. **Publish** marts that the dashboard reads.

Flags never change data. Reviewers acknowledge them in a separate, append-only table that survives reruns.

```
raw (ODK tables, entity lists, form XLSX)        untouched; load id + content hash
 └─ staging      raw text + interpreted `_` columns (UTC times, numbers, token lists, geopoints)
     └─ core     submissions · plots (centroid + registration + geometry) · quadrats (+ transect position) · occurrences
         └─ resolved   occurrence taxon via species_extra_ids (merge chains, exclusions); canonical-survey flag
             ├─ qa_results    rule_id, status, severity, entity, plot, survey, source_table, source_key, observed, expected, message, run_id
             ├─ marts         survey_overview, submissions, plots, quadrats, occurrences, effort_*
             └─ flag_reviews  (dashboard writes) rule_id + entity_key -> decision, by, at, note   [append-only]
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
- **Canonical survey (V-01):** for each plot × replicate, take the first by
  1. `ReviewState != rejected`,
  2. then the latest `_end`.

  Keep every submission, with `canonical` true/false. Only canonical surveys count for richness and effort.
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

The catalogue is the contract. It has 91 rules, in groups:

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

Each rule has:

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
| H | C01–C16 | Every required / relevant / constraint / calculation expression of both forms re-evaluated on the export |
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

## 5. Effort statistics (marts `effort_*`)

These use incidence data per canonical plot (T = 20 quadrats), on both the raw and the resolved layer:

- **Rarefaction curve:** S(t) = Σᵢ [1 − C(T−Yᵢ, t) / C(T, t)].
- **Chao2:** S_obs + (T−1)/T · Q1² / (2 Q2), or (T−1)/T · Q1(Q1−1)/2 when Q2 = 0.
- **Sample coverage:** 1 − Q1/U · [(T−1)Q1 / ((T−1)Q1 + 2Q2)].
- **Project level:** the same statistics with plots as the sampling units.
- **Planned vs done:** per stratum, from `centroids` (primary/backup), registrations and canonical surveys.
- **Repeatability:** plot and mean quadrat Jaccard for any plot with two or more submissions in a replicate.
- **Richness sensitivity:** raw, canonical, resolved, identified only, unknowns only.

Show coverage first. Chao2 is unstable with 20 quadrats when Q2 is small (V-10).

## 6. The dashboard

Every view reads the marts and `qa_results`. Every flag links to its source row through `source_table` + `source_key`. Shared filters, in one row: replicate, stratum, plot, device, recorder, date range, severity, rule group, and canonical only (on by default).

| View | Shows | Source |
|---|---|---|
| **Overview** | Headline numbers (plots planned / registered / surveyed, quadrats, taxa raw / resolved); flags by severity and group; the top open errors; a "not checked" counter | `survey_overview`, `rule_summary`, `qa_results` |
| **Submissions** | Timeline per device (form open → upload), upload delay, duration against the median, review state, canonical choice, flags per submission | `submissions`, `canonical_choice` |
| **Map** | Prescribed points by status (surveyed / not viable / never registered / backup); click a plot to see its registered A–M–B line, the 5 m belt, the 25 m circle, and quadrats coloured by flag | `plots`, `quadrats` |
| **Plots** | One row per plot: geometry (offset, length, bearing), richness raw / resolved, all-unknown quadrats, coverage, flag counts; a heatmap of plots × rule groups | `plots`, `effort_plots` |
| **Taxonomy** | A curation queue: names to check (F03), curation-table issues (F13), unresolved unknowns by record count (F07), out-of-range taxa (F10), duplicate entities (F04); raw → resolved mapping per occurrence | `occurrences`, `qa_results` |
| **Effort** | Planned vs done per stratum, accumulation curves, coverage per plot, project-level completeness, repeatability | `effort_*` |
| **Rules** | The catalogue with fail / pass / not-checked counts and its thresholds, so reviewers see what *was* checked | `rule_summary` |
| **Field feedback** | "Check tonight": the day's submissions with errors and warnings the team can still fix in the field (missing rows, empty occurrences, position outliers, late uploads), plus process reminders (upload, refresh lists) | `qa_results` filtered by date |

**Flag reviews.** Reviewers mark a flag as `acknowledged`, `accepted as is`, `fixed upstream` or `false positive`, with a note. Store this in `flag_reviews`, keyed by (`rule_id`, `entity_key`):

- append-only, so the history is kept;
- re-attached to new runs by key;
- a flag whose entity no longer fails shows as "resolved by data".

Data are never edited from the dashboard.

```sql
create table qa_results (
  run_id text not null, rule_id text not null, status text not null check (status in ('fail','pass','could_not_check')),
  severity text not null check (severity in ('error','warning','info')), entity_type text not null, entity_key text not null,
  plot_name text, survey_key text, source_table text, source_key text, observed text, expected text, message text,
  primary key (run_id, rule_id, entity_type, entity_key));
create table qa_runs (run_id text primary key, started_at timestamptz not null, code_version text, catalogue_version text,
  input_hashes jsonb not null, status_counts jsonb);
create table flag_reviews (id bigserial primary key, rule_id text not null, entity_key text not null,
  decision text not null check (decision in ('acknowledged','accepted_as_is','fixed_upstream','false_positive')),
  note text, reviewed_by text not null, reviewed_at timestamptz not null default now());  -- append-only: no updates or deletes
```

## 7. Running it on the platform

- **Triggers:**
  - a new or changed submission;
  - a review-state change;
  - an entity-list update, especially `species_extra_ids`;
  - a nightly full run.

  A full run takes seconds, so incremental logic is not needed at this scale. Rebuild everything per project and replicate, which keeps results consistent.
- **Idempotent:** the same inputs give the same `run_id`, so a rerun replaces nothing.
- **Keep runs:** retain `qa_runs` with input hashes; the dashboard shows the latest and can diff two runs.
- **External references stay outside the run:**
  - A separate job refreshes `reference/gbif_cache.json` (backbone match plus occurrence counts by country) for names not yet cached, for example weekly or when new names appear.
  - The QA run reads only the cache, so it is offline and reproducible.
  - A name missing from the cache is `could_not_check`.
- **Form versions:** parse the XLSForm on each run (versions, choice lists, rule expressions). When a new version is deployed, rules that read the form follow it automatically. A07 flags submissions made with an older version.
- **Thresholds** are configuration (`rules.yaml`), versioned with the code. A threshold change is a catalogue change, so the `run_id` changes.

## 8. Acceptance tests and verification status

`challenge2/tests` (91 tests, run with `pytest`) is the acceptance suite to port:

| Area | What the tests pin |
|---|---|
| Exploration findings | All 35 findings of the exploratory review (S1–S10, R1–R6, Q1–Q9, T1–T10), each pinned to the rule that must re-find it |
| Passed checks | The 12 checks that passed must still report `pass` |
| Differences | Deliberate differences from the exploration (`docs/challenge2_decisions.md`) |
| New findings | N1–N9 |
| Properties | Determinism (identical results and `run_id` on rerun); inputs never modified (file hashes before and after); raw columns identical to the export; row counts; one canonical survey per plot; every result field is text; catalogue = code |
| Unit tests | Projection, bearings, segment frame, robust line, Chao2 / coverage / rarefaction formulas, curation parsing |

| Item | Status |
|---|---|
| All rules implemented and run on the provided data | Done (run `qa-89f6067444a485d6`) |
| Acceptance tests | 91 passing |
| GBIF cache | 99 names, retrieved 2026-10-10 |
| Dashboard views | Specified here; reference figures in `outputs/figures/` |
| Flag-review workflow | Specified (DDL above); not implemented in the reference |
| Platform integration (triggers, storage) | To build |

## 9. Platform and form issues to fix upstream

These are flagged by the K rules, but a QA dashboard cannot fix them:

1. **Rejected submissions keep their entity writes** (K03). ODK Central does not roll back entity updates on rejection: herb_100–102 still carry what the rejected Plot 21 survey wrote. The review process needs a manual revert step, or a platform check.
2. **Upload discipline** (B06, B10). Devices must upload after each survey and refresh entity lists before the next. Otherwise two devices claim the same provisional id. Add a dashboard alert when `base_active_herb_count` is below the server's active count at form start.
3. **Form fix** (K02). `quadrats_with_species` should use `herb_species/selected_herb_species_uuids`.
4. **Form hygiene** (K01, K04):
   - choice names without spaces;
   - one name per field;
   - consistent image `max-pixels`;
   - a quadrat GPS warning at 5 m, as in registration;
   - a filter so a plot cannot be registered twice;
   - align the SOP's `Genus_species` with the form's spaces.
5. **Device time zone** (B12): set Africa/Nairobi.
6. **Curation table** (F13): structured `merge_into` and `exclude` columns instead of free-text notes, and labels that match their numbers.

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
| `challenge2/src/vegqa/gbif.py` | GBIF cache refresh (the only network code) |
| `challenge2/src/vegqa/report_tables.py` | Refreshes the report's generated tables |
| `challenge2/reference/gbif_cache.json` | Cached GBIF reference |
| `challenge2/tests/` | Acceptance and unit tests |
| `docs/challenge2_decisions.md` | Decisions V-01 to V-11, differences, new findings, confirmation items |

**To run:**

```bash
python -m venv challenge2/.venv && challenge2/.venv/bin/pip install -r challenge2/requirements.txt
challenge2/.venv/bin/python challenge2/src/run_challenge2.py          # outputs/ and figures
cd challenge2/src && ../.venv/bin/python -m vegqa.report_tables       # refresh the report's tables
cd challenge2/tests && ../.venv/bin/python -m pytest -q              # acceptance suite
```

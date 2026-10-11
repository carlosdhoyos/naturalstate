/**
 * Challenge 2 (vegetation QA/QC) diagrams: architecture, logic and code map of challenge2/src.
 * Numbers come from the committed run (challenge2/outputs/run_manifest.json).
 */
import type { Diagram } from './Schematic'

const V = 'challenge2/src/vegqa'

export const VEG_ARCHITECTURE: Diagram = {
  id: 'veg-arch',
  title: 'Architecture: from ODK tables to flags, marts and the dashboard',
  sub: 'One batch run (challenge2/src/run_challenge2.py, or the vegqa:1.0.0 container): offline, deterministic, never changing a source value. External lookups are fetched by separate jobs into cached reference files.',
  order: ['exports', 'entities', 'forms', 'refs', 'contract', 'load', 'canon', 'occ', 'geom', 'formparse', 'catalogue', 'engine', 'results', 'marts', 'effort', 'sugg', 'figs', 'publish', 'outputs', 'report', 'dash', 'fetch'],
  bands: [
    { label: 'Inputs (mounted read-only in the container)', row0: 0, row1: 0 },
    { label: 'Check, stage and model the data', row0: 1, row1: 3 },
    { label: 'Evaluate every rule on every entity', row0: 4, row1: 5 },
    { label: 'Derive, publish and present', row0: 6, row1: 9 },
  ],
  nodes: [
    { id: 'exports', label: 'ODK exports', sub: 'surveys · quadrats · additional species · registrations', kind: 'input', tag: 'data', col: 0, row: 0, detail: { what: 'Four CSVs from ODK Central: the herbaceous survey and its two repeat tables (linked by KEY → PARENT_KEY), and the plot registrations. Read as text, never modified.', numbers: '32 surveys, 640 quadrats, 1,296 additional-species rows, 31 registrations.' } },
    { id: 'entities', label: 'Entity lists', sub: 'centroids, vegplots, species, species_extra, curation…', kind: 'input', tag: 'data', col: 1, row: 0, detail: { what: 'Eleven ODK entity lists: the design (centroids), the registered plots (vegplots), the species list, the provisional taxa (species_extra), Natural State’s curation (species_extra_ids) and lookups.', numbers: '51 prescribed points; 370 list species; 250 provisional slots; 109 curation rows.' } },
    { id: 'forms', label: 'XLSForms', sub: 'herbaceous survey · registration', kind: 'input', tag: 'data', col: 2, row: 0, detail: { what: 'The two form definitions. The pipeline parses them (versions, choice lists, required / relevant / constraint / calculation rows) so the rules check the data against the form itself, not a hard-coded copy.' } },
    { id: 'refs', label: 'Cached references', sub: 'GBIF names & counts · SRTM elevations', kind: 'store', tag: 'reference', col: 3, row: 0, detail: { what: 'Versioned JSON files the run reads: GBIF backbone matches and presence-only (occurrenceStatus=PRESENT) counts per country, with a retrieval date per name; SRTM 90 m terrain elevation per recorded point.', code: ['challenge2/reference/gbif_cache.json', 'challenge2/reference/elevation_cache.json'], numbers: '99 names; 770 points.' } },
    { id: 'fetch', label: 'Refresh jobs', sub: 'the only network code', kind: 'external', tag: 'reference', col: 4, row: 0, detail: { what: 'Separate commands, never part of a QA run: fetch new names, names fetched under an older query, or entries older than --max-age-days; and new points for the DEM.', code: [`${V}/gbif.py`, `${V}/dem.py`], functions: ['python -m vegqa.gbif [--max-age-days N]', 'python -m vegqa.dem'] } },
    { id: 'contract', label: 'Input contract', sub: 'files and columns, before anything else', kind: 'decision', tag: 'pipeline', col: 1, row: 1, detail: { what: 'Every required file and column must be present. A broken export stops the run with one message listing everything missing; nothing is analysed or half-written. Values are not judged here: that is what the rules are for.', code: [`${V}/contracts.py`], functions: ['check_inputs'], decisions: ['V-13'] } },
    { id: 'load', label: 'Stage the data', sub: 'raw text + interpreted “_” columns', kind: 'step', tag: 'pipeline', col: 1, row: 2, detail: { what: 'Every source value stays as exported text; interpreted values are added beside it: UTC timestamps, numbers, coordinates, token lists, photo capture times from file names. A value that cannot be interpreted leaves the new column empty, and a rule turns that into a flag. Lookups by key keep the first row of a duplicated key, so duplicates reach rule A02 instead of crashing an earlier step.', code: [`${V}/load.py`], functions: ['load', 'by_key'], decisions: ['V-12'], checks: ['Raw columns identical to the export; inputs unchanged (file hashes before/after)'] } },
    { id: 'canon', label: 'Canonical survey', sub: 'at most one per plot and replicate', kind: 'step', tag: 'pipeline', col: 0, row: 3, detail: { what: 'Which submission counts for metrics: the latest one not rejected and not “has issues”; a duplicated KEY makes no copy eligible. A plot with no eligible submission has no canonical survey (rule J03 reports it). Every submission stays in every table with the reason.', code: [`${V}/model.py`], functions: ['canonical_survey_keys'], decisions: ['V-01'], outputs: ['canonical_choice.csv'], numbers: '30 canonical of 32 submissions (the two rejected repeats of Plots 18 and 21 excluded).' } },
    { id: 'occ', label: 'Occurrences, two layers', sub: 'raw as recorded · resolved by NS curation', kind: 'step', tag: 'pipeline', col: 1, row: 3, detail: { what: 'One row per recorded taxon in a quadrat: list species and provisional slots. The resolved layer follows Natural State’s curation table (merge chains, exclusions, curated names); spellings are never corrected.', code: [`${V}/taxonomy.py`], functions: ['build_occurrences', 'curation_actions', 'slot_number'], decisions: ['V-02, V-03'], numbers: '2,243 occurrences (2,093 in canonical surveys); 132 raw taxa → 115 resolved (92 identified, 23 unresolved unknowns).' } },
    { id: 'geom', label: 'Geometry', sub: 'transects and quadrat positions in metres', kind: 'step', tag: 'pipeline', col: 2, row: 3, detail: { what: 'A local projection around the project; per plot the A–M–B points, midpoint offset, lengths, angle and bearing; per quadrat the along / lateral position on the registered segment and the residual from the survey’s own robust line.', code: [`${V}/geo.py`, `${V}/model.py`], functions: ['LocalProjection', 'registration_geometry', 'quadrat_positions', 'robust_line', 'geohash'] } },
    { id: 'formparse', label: 'Form parser', sub: 'versions, choices, calculations', kind: 'step', tag: 'pipeline', col: 3, row: 3, detail: { what: 'Reads the XLSForm sheets so rules can compare stored values with what the form allows or computes (e.g. C17 recomputes every lookup calculation; P03 checks values against choice lists).', code: [`${V}/forms.py`], functions: ['sheet', 'fields', 'choices', 'select_fields', 'design_issues', 'set_forms_dir'] } },
    { id: 'catalogue', label: 'Rule catalogue', sub: 'rules.yaml: 94 rules + thresholds', kind: 'store', tag: 'config', col: 0, row: 4, detail: { what: 'Each rule’s source (SOP step, form row, entity list, or our judgement), default severity, whether it can change richness, why it matters and the action; plus every threshold. The run refuses to start if the catalogue and the code disagree.', code: ['challenge2/rules/rules.yaml'] } },
    { id: 'engine', label: 'Rule engine', sub: '94 rules × every entity', kind: 'step', tag: 'pipeline', col: 1, row: 4, w: 2, detail: { what: 'Runs one Python function per catalogued rule (groups A–K, P, X) and collects one result row per entity it looked at: fail, pass or could_not_check (“not checked” is never shown as a pass). See the Logic tab for how one rule decides.', code: [`${V}/engine.py`, `${V}/checks/`], functions: ['run_all', 'rule (decorator)', 'Ctx.add'], numbers: '24,829 results: 24,110 pass, 697 fail, 22 could not check.' } },
    { id: 'results', label: 'Results with review keys', sub: 'qa_results / qa_flags', kind: 'store', tag: 'pipeline', col: 1, row: 5, w: 2, detail: { what: 'Every result row carries run_id, project_id, a stable flag_id (project, rule, entity type, entity key) and an evidence_hash (evidence + rule definition), so a future review decision re-attaches to the same flag and reopens when its evidence or the rule changes.', code: ['challenge2/src/run_challenge2.py'], functions: ['add_review_keys', 'run_id'], outputs: ['qa_results.csv', 'qa_flags.csv', 'rule_summary.csv'], numbers: '697 flags: 24 error, 222 warning, 451 info; 241 come from 10 project-wide findings.' } },
    { id: 'marts', label: 'Joined tables', sub: 'survey, submissions, plots, quadrats, occurrences', kind: 'step', tag: 'pipeline', col: 0, row: 6, detail: { what: 'The cleaned and joined deliverables (interpreted, never corrected), each with its flag counts. Plots have one row per plot and replicate.', code: [`${V}/tables.py`], functions: ['survey_overview', 'submissions', 'plots', 'quadrats', 'occurrences'] } },
    { id: 'effort', label: 'Sampling effort', sub: 'coverage, Chao2, Hill numbers, eligibility', kind: 'step', tag: 'pipeline', col: 1, row: 6, detail: { what: 'Per canonical survey and per replicate: rarefaction, bias-corrected Chao2 with its interval, sample coverage, one-quadrat extrapolation, incidence Hill numbers, repeatability and richness sensitivity. Each survey gets a metrics status: ok, provisional (structural or record flags) or suppressed (no analytical data).', code: [`${V}/effort.py`], functions: ['stats', 'chao2_bc', 'coverage', 'per_plot', 'project_level', 'plan_vs_done', 'repeatability'], decisions: ['V-10, V-12'], numbers: 'Median plot coverage 0.89; 7 plots provisional (C04).' } },
    { id: 'sugg', label: 'Species-list suggestions', sub: 'for NS curators', kind: 'step', tag: 'pipeline', col: 2, row: 6, detail: { what: 'Grouped by GBIF species: spellings to confirm, names to verify, merges, additions (only with a species match and Kenyan presence records) and range checks. Suggestions only: no data or list is changed.', code: [`${V}/suggestions.py`], outputs: ['species_list_suggestions.csv'] } },
    { id: 'figs', label: 'Figures & dashboard export', sub: 'PNG maps and charts · dashboard JSON', kind: 'step', tag: 'pipeline', col: 3, row: 6, detail: { what: 'Static figures for the report and one JSON file with everything the dashboard page embeds.', code: [`${V}/figures.py`, `${V}/dashboard.py`], outputs: ['figures/*.png', 'dashboard_results.json'] } },
    { id: 'publish', label: 'Staged publication', sub: 'validate, then replace files, manifest last', kind: 'decision', tag: 'pipeline', col: 1, row: 7, w: 2, detail: { what: 'Everything is written to a staging folder and validated; a failure up to there leaves the previous run untouched. Files are then moved in one by one (each move atomic, the set not), with run_manifest.json last. A crash during the moves is detectable: a .publishing marker remains and --verify checks every file against the manifest hashes; a re-run repairs it. One atomic pointer switch is specified for the platform, not built. The manifest records input hashes, code version and the runtime (Python, packages, image).', code: ['challenge2/src/run_challenge2.py'], functions: ['main', 'verify_outputs', 'runtime', 'file_hashes', 'code_version'], decisions: ['V-13'] } },
    { id: 'outputs', label: 'challenge2/outputs/', sub: 'one complete run', kind: 'output', tag: 'data', col: 1, row: 8, w: 2, detail: { what: 'Flags, rule summary, joined tables, effort tables, suggestions, figures, dashboard JSON, manifest. The container writes the same files to /out; on the take-home data its tables and dashboard JSON are byte-identical to a local run (figures are re-rendered on Linux).' } },
    { id: 'report', label: 'Q1 report & Q2 handover', sub: 'tables refreshed from outputs', kind: 'output', tag: 'data', col: 0, row: 9, detail: { what: 'The prose is written by hand; every table between markers is rebuilt from the outputs and the run id is stamped, so numbers never drift from the run.', code: [`${V}/report_tables.py`, 'challenge2/Q1_data_quality_report.md', 'challenge2/Q2_tech_handover.md'] } },
    { id: 'dash', label: 'QA/QC dashboard', sub: 'nine views, embedded JSON', kind: 'output', tag: 'dashboard', col: 2, row: 9, detail: { what: 'Overview, all flags (with source records), submissions timeline, map with transect panels, plots, taxonomy queue, effort, rules, field feedback; shared filters. It never recomputes a rule.', code: ['dashboard/src/components/VegetationQA.tsx'] } },
  ],
  edges: [
    { from: 'exports', to: 'contract' }, { from: 'entities', to: 'contract' }, { from: 'forms', to: 'contract' }, { from: 'fetch', to: 'refs', dashed: true }, { from: 'contract', to: 'load', label: 'passes' },
    { from: 'load', to: 'canon' }, { from: 'load', to: 'occ' }, { from: 'load', to: 'geom' }, { from: 'forms', to: 'formparse' }, { from: 'canon', to: 'occ' },
    { from: 'canon', to: 'engine' }, { from: 'occ', to: 'engine' }, { from: 'geom', to: 'engine' }, { from: 'formparse', to: 'engine' }, { from: 'refs', to: 'engine' }, { from: 'catalogue', to: 'engine' },
    { from: 'engine', to: 'results' }, { from: 'results', to: 'marts' }, { from: 'results', to: 'effort' }, { from: 'occ', to: 'sugg', dashed: true }, { from: 'refs', to: 'sugg', dashed: true }, { from: 'results', to: 'figs' },
    { from: 'marts', to: 'publish' }, { from: 'effort', to: 'publish' }, { from: 'sugg', to: 'publish' }, { from: 'figs', to: 'publish' }, { from: 'publish', to: 'outputs' }, { from: 'outputs', to: 'report' }, { from: 'outputs', to: 'dash' },
  ],
}

export const VEG_RULE_LOGIC: Diagram = {
  id: 'veg-rule',
  title: 'Logic: how one rule decides about one entity',
  sub: 'The contract every rule function follows inside the engine. Example in the details: D03 (transect length) on one registered plot.',
  order: ['cat', 'agree', 'refuse', 'entity', 'have', 'cnc', 'violate', 'pass', 'sev', 'fail'],
  nodes: [
    { id: 'cat', label: 'Catalogue and code loaded', kind: 'input', col: 1, row: 0, detail: { what: 'rules.yaml and the @rule functions in checks/.', code: ['challenge2/rules/rules.yaml', `${V}/engine.py`] } },
    { id: 'agree', label: 'Catalogue and code match one-to-one?', kind: 'decision', col: 1, row: 1, detail: { what: 'The published catalogue is always the executed one.', functions: ['engine.run_all'] } },
    { id: 'refuse', label: 'Refuse to run', kind: 'stop', col: 3, row: 1, detail: { what: 'A rule without code, or code without a catalogue entry, stops the run with the list of mismatches.' } },
    { id: 'entity', label: 'For each entity the rule covers', sub: 'survey, plot, quadrat, occurrence, entity, project', kind: 'step', col: 1, row: 2, detail: { what: 'The rule iterates its own level. D03 iterates viable registered plots.' } },
    { id: 'have', label: 'Data needed present and interpretable?', kind: 'decision', col: 1, row: 3, detail: { what: 'Missing coordinates or accuracies, an unparseable value, an entity absent from a cached reference.', checks: ['A registration with a missing endpoint gives could_not_check in D01–D06 (tested)'] } },
    { id: 'cnc', label: 'could_not_check', sub: 'with the reason', kind: 'stop', col: 0, row: 4, detail: { what: 'Never shown as a pass; “passed everywhere” requires no could-not-check result.', numbers: '22 such results in this run.' } },
    { id: 'violate', label: 'Violates the rule?', sub: 'SOP / form / threshold', kind: 'decision', col: 2, row: 4, detail: { what: 'D03 example: z = |A–B − 50 m| / √(accA² + accB²), a screening score (not a calibrated test); a fail beyond z = 2.', decisions: ['V-04'] } },
    { id: 'pass', label: 'pass', kind: 'stop', col: 3, row: 5, detail: { what: 'Recorded with what was observed and expected, so a pass is evidence too.', numbers: '24,110 passes.' } },
    { id: 'sev', label: 'Severity', sub: 'rule default, or a stated per-row tier', kind: 'step', col: 1, row: 5, detail: { what: 'The catalogue’s default (error / warning / info) unless the rule sets another with a reason: GPS z tiers (z > 3 error, z > 2 warning), identical repeat writes (info), aggregate rows.', decisions: ['V-05'] } },
    { id: 'fail', label: 'fail', sub: 'observed · expected · message · source row', kind: 'stop', col: 1, row: 6, detail: { what: 'One flag pointing to its source table and key, with project_id, flag_id and evidence_hash added after the run.', numbers: '697 flags.' } },
  ],
  edges: [
    { from: 'cat', to: 'agree' }, { from: 'agree', to: 'refuse', label: 'no' }, { from: 'agree', to: 'entity', label: 'yes' }, { from: 'entity', to: 'have' }, { from: 'have', to: 'cnc', label: 'no' }, { from: 'have', to: 'violate', label: 'yes' },
    { from: 'violate', to: 'pass', label: 'no' }, { from: 'violate', to: 'sev', label: 'yes' }, { from: 'sev', to: 'fail' },
  ],
}

export const VEG_CANON_LOGIC: Diagram = {
  id: 'veg-canon',
  title: 'Logic: which survey counts (V-01)',
  sub: 'Applied per plot and replicate; every submission stays in every table with its reason.',
  order: ['subs', 'dup', 'exdup', 'state', 'exstate', 'latest', 'any', 'none', 'canon'],
  nodes: [
    { id: 'subs', label: 'All submissions of one plot in one replicate', kind: 'input', col: 1, row: 0, detail: { what: 'Grouped by plot and replicate (a second monitoring round is a separate group).' } },
    { id: 'dup', label: 'KEY duplicated?', kind: 'decision', col: 1, row: 1, detail: { what: 'The same submission KEY on more than one row is ambiguous.', decisions: ['V-12'] } },
    { id: 'exdup', label: 'Excluded: duplicated KEY', sub: 'no copy counts (A02)', kind: 'stop', col: 3, row: 1, detail: { what: 'Neither copy can count, so the plot’s metrics are suppressed rather than double counted (tested).' } },
    { id: 'state', label: 'Review state rejected or hasIssues?', kind: 'decision', col: 1, row: 2, detail: { what: 'Configurable as canonical_excluded_review_states in rules.yaml.' } },
    { id: 'exstate', label: 'Excluded: review state', sub: 'kept for repeatability (G04)', kind: 'stop', col: 3, row: 2, detail: { what: 'Never counts towards richness or effort; still checked like any submission.', numbers: 'The two rejected device-02 repeats of Plots 18 and 21.' } },
    { id: 'latest', label: 'Latest eligible by end time', kind: 'step', col: 1, row: 3, detail: { what: 'Among the eligible submissions of the group.' } },
    { id: 'any', label: 'Any eligible submission?', kind: 'decision', col: 1, row: 4, detail: { what: '' } },
    { id: 'none', label: 'No canonical survey', sub: 'J03: viable plot without an accepted survey', kind: 'stop', col: 0, row: 5, detail: { what: 'A rejected-only or hasIssues-only plot does not count (tested).' } },
    { id: 'canon', label: 'Canonical survey', sub: 'counts for richness and effort', kind: 'stop', col: 2, row: 5, detail: { what: 'Exactly one per plot and replicate.', numbers: '30 canonical surveys.' } },
  ],
  edges: [
    { from: 'subs', to: 'dup' }, { from: 'dup', to: 'exdup', label: 'yes' }, { from: 'dup', to: 'state', label: 'no' }, { from: 'state', to: 'exstate', label: 'yes' }, { from: 'state', to: 'latest', label: 'no' }, { from: 'latest', to: 'any' },
    { from: 'any', to: 'none', label: 'no' }, { from: 'any', to: 'canon', label: 'yes' },
  ],
}

export const VEG_TAXON_LOGIC: Diagram = {
  id: 'veg-taxon',
  title: 'Logic: the resolved taxon of one record (V-02)',
  sub: 'taxonomy.build_occurrences: only Natural State’s curation is applied; names are never corrected.',
  order: ['rec', 'src', 'list', 'slot', 'merge', 'follow', 'excl', 'excluded', 'named', 'ident', 'unknown'],
  nodes: [
    { id: 'rec', label: 'One recorded taxon in a quadrat', kind: 'input', col: 1, row: 0, detail: { what: 'Either a species picked from the list or an additional-species row.' } },
    { id: 'src', label: 'From the project list?', kind: 'decision', col: 1, row: 1, detail: { what: '' } },
    { id: 'list', label: 'Identified: list label', kind: 'stop', col: 3, row: 1, detail: { what: 'The list species’ label; woody list species are flagged by A06 / F06.' } },
    { id: 'slot', label: 'Provisional slot → herb_NNN', sub: 'group type + unknown index', kind: 'step', col: 1, row: 2, detail: { what: 'new_* rows use the slot they created; reuse rows the slot they picked. No slot → unresolvable (C08).', functions: ['taxonomy.slot_number'] } },
    { id: 'merge', label: 'Curation says “duplicate of X” (not negated)?', kind: 'decision', col: 1, row: 3, detail: { what: 'Parsed from free-text notes; a negated phrase (“not a duplicate of”) is not applied and is flagged by F13.', functions: ['taxonomy.curation_actions'], decisions: ['V-13'] } },
    { id: 'follow', label: 'Follow the merge chain', kind: 'step', col: 3, row: 3, detail: { what: 'herb_033 → herb_011, herb_072 → herb_036, …; cycles are guarded.' } },
    { id: 'excl', label: 'Curation says exclude (not negated)?', kind: 'decision', col: 1, row: 4, detail: { what: 'E.g. “woody but below 40 cm, so should be excluded”.' } },
    { id: 'excluded', label: 'Excluded', sub: 'not counted in the resolved layer', kind: 'stop', col: 3, row: 5, detail: { what: 'Kept in the raw layer and flagged (F06).', numbers: '4 records (3 canonical).' } },
    { id: 'named', label: 'Curated to a species name?', kind: 'decision', col: 1, row: 5, detail: { what: '“Unknown” keeps the slot as its own unresolved taxon.' } },
    { id: 'ident', label: 'Identified: curated name', kind: 'stop', col: 0, row: 6, detail: { what: 'As NS wrote it; spelling problems are flagged (F03, F13) and suggested in species_list_suggestions.csv.', numbers: '92 identified taxa.' } },
    { id: 'unknown', label: 'Unresolved unknown', sub: 'its own taxon', kind: 'stop', col: 2, row: 6, detail: { what: 'Counted separately from identified taxa.', numbers: '23 unresolved taxa, 15% of canonical records.' } },
  ],
  edges: [
    { from: 'rec', to: 'src' }, { from: 'src', to: 'list', label: 'yes' }, { from: 'src', to: 'slot', label: 'no' }, { from: 'slot', to: 'merge' }, { from: 'merge', to: 'follow', label: 'yes' }, { from: 'follow', to: 'excl' },
    { from: 'merge', to: 'excl', label: 'no' }, { from: 'excl', to: 'excluded', label: 'yes' }, { from: 'excl', to: 'named', label: 'no' }, { from: 'named', to: 'ident', label: 'yes' }, { from: 'named', to: 'unknown', label: 'no' },
  ],
}

export const VEG_METRIC_LOGIC: Diagram = {
  id: 'veg-metric',
  title: 'Logic: may a survey’s effort metrics be read as evidence? (V-12)',
  sub: 'effort.per_plot: surviving bad input is not enough; it must not produce valid-looking summaries.',
  order: ['s', 'q', 'noq', 'taxa', 'zero', 'zz', 'miss', 'excl2', 'flags', 'prov', 'ok'],
  nodes: [
    { id: 's', label: 'One canonical survey', kind: 'input', col: 1, row: 0, detail: { what: 'Sampling units = distinct quadrat KEYs (a duplicated row is not a 21st quadrat).' } },
    { id: 'q', label: 'Any quadrats?', kind: 'decision', col: 1, row: 1, detail: { what: '' } },
    { id: 'noq', label: 'Suppressed: incomplete survey', sub: 'metrics undefined (A03)', kind: 'stop', col: 3, row: 1, detail: { what: 'No division by zero; the row says why.' } },
    { id: 'taxa', label: 'Any analytical taxa?', kind: 'decision', col: 1, row: 2, detail: { what: 'Taxa in the layer (raw or resolved) after exclusions.' } },
    { id: 'zero', label: 'Why empty?', kind: 'decision', col: 0, row: 3, detail: { what: 'An empty incidence table cannot by itself distinguish absence from missing data.' } },
    { id: 'zz', label: 'Valid zero', sub: 'every quadrat: no herbs', kind: 'stop', col: 0, row: 5, detail: { what: 'Richness 0; ratios undefined (not 100% coverage or infinite diversity).' } },
    { id: 'miss', label: 'Suppressed: missing records', sub: 'herbs present, no species (C02)', kind: 'stop', col: 1, row: 5, detail: { what: 'Tested with a survey whose species records were removed.' } },
    { id: 'excl2', label: 'Suppressed: records not analytical', sub: 'excluded or unresolvable', kind: 'stop', col: 2, row: 5, detail: { what: 'Records exist, but none is a taxon of this layer.' } },
    { id: 'flags', label: 'Structural or record flags?', sub: 'A01–A04, C02, C04, C08, C13', kind: 'decision', col: 3, row: 3, detail: { what: 'Failures that put the records or the sampling units in doubt.' } },
    { id: 'prov', label: 'Provisional', sub: 'metrics shown, marked with the rules', kind: 'stop', col: 2, row: 4, detail: { what: 'The numbers are computed but must not be read as definitive. The project row inherits the status (provisional when any plot is) and repeats its estimate on the ok plots only; the dashboard shows the status wherever these numbers appear.', numbers: '7 of 30 plots, all for C04 (declared additional species without rows). Resolved layer: 115 taxa, Chao2 145 (128–185) on all 30 plots; 104 taxa, Chao2 139 (119–186) on the 23 ok plots.' } },
    { id: 'ok', label: 'ok', sub: 'conditional on the analytical data', kind: 'stop', col: 4, row: 4, detail: { what: 'Still estimates under assumptions: coverage is not data quality, and quadrats are spatially dependent.', numbers: '23 plots.' } },
  ],
  edges: [
    { from: 's', to: 'q' }, { from: 'q', to: 'noq', label: 'no' }, { from: 'q', to: 'taxa', label: 'yes' }, { from: 'taxa', to: 'zero', label: 'no' }, { from: 'taxa', to: 'flags', label: 'yes' },
    { from: 'zero', to: 'zz', label: 'no herbs' }, { from: 'zero', to: 'miss', label: 'no records' }, { from: 'zero', to: 'excl2', label: 'not analytical' }, { from: 'flags', to: 'prov', label: 'yes' }, { from: 'flags', to: 'ok', label: 'no' },
  ],
}

export const VEG_CODE_MAP: Diagram = {
  id: 'veg-code',
  title: 'Code map: challenge2/src and who uses what',
  sub: 'Arrows point from a module to the module it imports. checks/ is one package of nine rule-group modules.',
  order: ['run', 'contracts', 'load', 'forms', 'geo', 'model', 'taxonomy', 'engine', 'checks', 'effort', 'tables', 'sugg', 'figs', 'dashj', 'gbif', 'dem', 'rt', 'rules', 'tests', 'docker', 'page'],
  bands: [
    { label: 'Entry points', row0: 0, row1: 0 },
    { label: 'Foundations', row0: 1, row1: 2 },
    { label: 'Rules and derived outputs', row0: 3, row1: 4 },
    { label: 'Configuration, tests, presentation', row0: 5, row1: 5 },
  ],
  nodes: [
    { id: 'run', label: 'run_challenge2.py', sub: 'build · main (staged publish) · CLI', kind: 'module', tag: 'pipeline', col: 1, row: 0, w: 2, detail: { what: 'Checks inputs, builds everything in memory (build), writes and publishes it (main); flags get review keys; the manifest gets hashes and runtime.', code: ['challenge2/src/run_challenge2.py'], functions: ['build', 'main', 'add_review_keys', 'runtime', 'file_hashes', 'code_version', 'project_id'] } },
    { id: 'docker', label: 'Dockerfile', sub: 'vegqa:1.0.0', kind: 'module', tag: 'pipeline', col: 0, row: 0, detail: { what: 'Python 3.13 slim, pinned requirements, non-root, entry point with mounted /data and /out.', code: ['challenge2/Dockerfile'] } },
    { id: 'rt', label: 'report_tables.py', sub: 'refresh report tables', kind: 'module', tag: 'pipeline', col: 3, row: 0, detail: { what: 'Rebuilds the tables between markers in the Q1 report from the outputs and stamps the run id into the documents; idempotent and prose-preserving (tested).', code: [`${V}/report_tables.py`] } },
    { id: 'contracts', label: 'contracts.py', sub: 'input contract', kind: 'module', tag: 'pipeline', col: 0, row: 1, detail: { what: 'Required files and columns.', code: [`${V}/contracts.py`] } },
    { id: 'load', label: 'load.py', sub: 'staging, by_key', kind: 'module', tag: 'pipeline', col: 1, row: 1, detail: { what: 'Reads text, adds interpreted columns; by_key for duplicate-safe lookups.', code: [`${V}/load.py`] } },
    { id: 'forms', label: 'forms.py', sub: 'XLSForm parser', kind: 'module', tag: 'pipeline', col: 2, row: 1, detail: { what: 'Sheets, fields, choices, design issues.', code: [`${V}/forms.py`] } },
    { id: 'geo', label: 'geo.py', sub: 'projection, lines, geohash', kind: 'module', tag: 'pipeline', col: 3, row: 1, detail: { what: 'Pure geometry; no GIS dependency.', code: [`${V}/geo.py`] } },
    { id: 'model', label: 'model.py', sub: 'canonical, geometry, positions', kind: 'module', tag: 'pipeline', col: 1, row: 2, detail: { what: 'Derived tables shared by rules and outputs.', code: [`${V}/model.py`] } },
    { id: 'taxonomy', label: 'taxonomy.py', sub: 'occurrences, curation', kind: 'module', tag: 'pipeline', col: 2, row: 2, detail: { what: 'Raw and resolved layers.', code: [`${V}/taxonomy.py`] } },
    { id: 'engine', label: 'engine.py', sub: 'registry, Ctx, run_all', kind: 'module', tag: 'pipeline', col: 0, row: 3, detail: { what: 'Rule registry, result collector, catalogue/code agreement, run id.', code: [`${V}/engine.py`] } },
    { id: 'checks', label: 'checks/ (9 modules)', sub: 'A · B · C · D · E · F · G · JKP · X', kind: 'module', tag: 'pipeline', col: 1, row: 3, w: 2, detail: { what: 'One function per rule: a_structure, b_lifecycle, c_form, d_registration, e_quadrats, f_taxonomy, g_plausibility, jkp_plan_platform_profile, x_crossref.', code: [`${V}/checks/`] } },
    { id: 'gbif', label: 'gbif.py · dem.py', sub: 'reference caches (network)', kind: 'module', tag: 'reference', col: 3, row: 3, detail: { what: 'Fetch and read the cached references; the run only reads.', code: [`${V}/gbif.py`, `${V}/dem.py`] } },
    { id: 'effort', label: 'effort.py', sub: 'statistics, eligibility', kind: 'module', tag: 'pipeline', col: 0, row: 4, detail: { what: 'Coverage, Chao2, Hill numbers, plan vs done, repeatability, sensitivity; metrics status.', code: [`${V}/effort.py`] } },
    { id: 'tables', label: 'tables.py', sub: 'joined deliverables', kind: 'module', tag: 'pipeline', col: 1, row: 4, detail: { what: 'Survey overview, submissions, plots, quadrats, occurrences.', code: [`${V}/tables.py`] } },
    { id: 'sugg', label: 'suggestions.py', sub: 'curator suggestions', kind: 'module', tag: 'pipeline', col: 2, row: 4, detail: { what: 'Species-list and curation suggestions.', code: [`${V}/suggestions.py`] } },
    { id: 'figs', label: 'figures.py', sub: 'report PNGs', kind: 'module', tag: 'pipeline', col: 3, row: 4, detail: { what: 'Map, transect grid, orientation, accumulation, timeline, heatmap.', code: [`${V}/figures.py`] } },
    { id: 'dashj', label: 'dashboard.py', sub: 'dashboard JSON', kind: 'module', tag: 'pipeline', col: 4, row: 4, detail: { what: 'Column-oriented export of every table the page needs.', code: [`${V}/dashboard.py`] } },
    { id: 'rules', label: 'rules.yaml', sub: '94 rules + thresholds', kind: 'store', tag: 'config', col: 0, row: 5, detail: { what: 'The catalogue (metadata and thresholds; the logic is in checks/).', code: ['challenge2/rules/rules.yaml'] } },
    { id: 'tests', label: 'tests/ (161)', sub: 'acceptance · mutation · robustness · unit', kind: 'test', tag: 'pipeline', col: 1, row: 5, w: 2, detail: { what: 'The 35 exploration findings and 12 passes; new findings; 35 rules must fire on an injected error; the whole workflow on invalid inputs with semantic checks; determinism; inputs unchanged; formulas.', code: ['challenge2/tests/test_acceptance.py', 'challenge2/tests/test_mutations.py', 'challenge2/tests/test_robustness.py', 'challenge2/tests/test_pipeline.py'] } },
    { id: 'page', label: 'VegetationQA.tsx', sub: 'dashboard page', kind: 'module', tag: 'dashboard', col: 3, row: 5, w: 2, detail: { what: 'Reads challenge2/outputs/dashboard_results.json at build time.', code: ['dashboard/src/components/VegetationQA.tsx'] } },
  ],
  edges: [
    { from: 'run', to: 'contracts' }, { from: 'run', to: 'load' }, { from: 'run', to: 'forms' }, { from: 'run', to: 'model' }, { from: 'run', to: 'taxonomy' }, { from: 'run', to: 'engine' },
    { from: 'run', to: 'effort' }, { from: 'run', to: 'tables' }, { from: 'run', to: 'sugg' }, { from: 'run', to: 'figs' }, { from: 'run', to: 'dashj' }, { from: 'run', to: 'gbif' },
    { from: 'contracts', to: 'load' }, { from: 'forms', to: 'load' }, { from: 'model', to: 'geo' }, { from: 'model', to: 'load' }, { from: 'taxonomy', to: 'load' },
    { from: 'engine', to: 'checks' }, { from: 'checks', to: 'engine' }, { from: 'checks', to: 'model' }, { from: 'checks', to: 'taxonomy' }, { from: 'checks', to: 'forms' }, { from: 'checks', to: 'geo' }, { from: 'checks', to: 'gbif' },
    { from: 'effort', to: 'taxonomy' }, { from: 'effort', to: 'gbif' }, { from: 'tables', to: 'model' }, { from: 'sugg', to: 'gbif' }, { from: 'sugg', to: 'taxonomy' }, { from: 'figs', to: 'model' }, { from: 'dashj', to: 'model' },
    { from: 'engine', to: 'rules', dashed: true }, { from: 'tests', to: 'run', dashed: true }, { from: 'dashj', to: 'page', label: 'JSON', dashed: true }, { from: 'rt', to: 'run', dashed: true },
  ],
}

export const VEG_DIAGRAMS = [VEG_ARCHITECTURE, VEG_RULE_LOGIC, VEG_CANON_LOGIC, VEG_TAXON_LOGIC, VEG_METRIC_LOGIC, VEG_CODE_MAP]

/**
 * Challenge 1 (birds) diagrams: architecture, logic and code map of the threshold workflow.
 * Numbers come from challenge1/outputs/run_summary.json (threshold set ts-8fae4456dc6301a1).
 */
import type { Diagram } from './Schematic'

const PKG = 'challenge1/ns_observations/src/ns_observations'
const RES = 'challenge1/src'

export const BIRDS_ARCHITECTURE: Diagram = {
  id: 'birds-arch',
  title: 'Architecture: from BirdNET predictions to observations',
  sub: 'The research workflow (run_challenge1.py) and the deployable package (ns_observations) share one implementation of every decision rule. Green outline = package code the platform runs; purple = research-only analysis.',
  order: ['pred', 'val', 'load', 'link', 'dedup', 'gate', 'fit', 'accept', 'tset', 'checks', 'boot', 'sens', 'label', 'labels', 'report', 'dash', 'platform'],
  bands: [
    { label: 'Inputs', row0: 0, row1: 0 },
    { label: 'Prepare the validation evidence', row0: 1, row1: 3 },
    { label: 'Per species: the Wood & Kahl procedure (job A, calibrate)', row0: 4, row1: 6 },
    { label: 'Publish, label (job B) and report', row0: 7, row1: 9 },
  ],
  nodes: [
    { id: 'pred', label: 'birdnet_predictions.csv', sub: 'every BirdNET prediction', kind: 'input', tag: 'data', col: 1, row: 0, detail: { what: 'Every segment BirdNET scored at or above its minimum confidence, with species, confidence and the audio file path (recorder, date and hour are encoded in the file name). It is never modified: the labelled output keeps every source column byte-identical.', numbers: '29,491 predictions of 4 species.' } },
    { id: 'val', label: 'validation_results.csv', sub: 'ornithologist verdicts', kind: 'input', tag: 'data', col: 3, row: 0, detail: { what: 'Clips an ornithologist listened to, each with a verdict (correct / incorrect). The file name carries the 3-decimal score, clip number, recorder, date and the true start time; there is no shared prediction id.', numbers: '551 validated clips.' } },
    { id: 'load', label: 'Load & parse', sub: 'recorder, date, hour from file names', kind: 'step', tag: 'package', col: 2, row: 1, detail: { what: 'Reads both files and parses recorder, date and hour out of the file names with explicit patterns (the predictions export rounds the file name down to the hour; validation names keep the true start).', code: [`${PKG}/io_csv.py`, `${RES}/run_challenge1.py`], functions: ['io_csv.read_predictions', 'io_csv.read_validations', 'run_challenge1.load'], inputs: ['birdnet_predictions.csv', 'validation_results.csv'] } },
    { id: 'link', label: 'Link validations to predictions', sub: 'D-02', kind: 'step', tag: 'package', col: 2, row: 2, detail: { what: 'Matches each validated clip to the prediction it came from by species + recorder + date + hour + a score equal within the 3-decimal rounding of the file name. Each clip is unique, tied (several predictions share the rounded score) or not found. On the platform a stable prediction_id replaces all of this.', code: [`${PKG}/io_csv.py`], functions: ['io_csv.link_validations'], decisions: ['D-02 linkage rule; ties keep the clip for fitting (its score is known) but not as a verdict for one row'], outputs: ['validation_links.csv'], numbers: '476 unique, 69 tied, 2 not found.' } },
    { id: 'dedup', label: 'De-duplicate', sub: 'D-01', kind: 'step', tag: 'package', col: 2, row: 3, detail: { what: 'Drops validated clips that are the same 3-second segment counted twice (identical names apart from the clip number), so one segment never counts as two pieces of evidence.', code: [`${PKG}/io_csv.py`], functions: ['io_csv.deduplicate'], decisions: ['D-01'], outputs: ['dropped_duplicate_validations.csv'], numbers: '4 duplicates dropped: 547 clips remain.' } },
    { id: 'gate', label: 'Evidence gate', sub: '≥ 5 correct and ≥ 5 incorrect', kind: 'decision', tag: 'package', col: 2, row: 4, detail: { what: 'A fitted curve may set a threshold only when the species has at least k = 5 validated clips of each outcome. With fewer errors the curve cannot locate a 99% point; the species gets “insufficient validation” and only human-confirmed observations.', code: [`${PKG}/calibrate.py`, `${PKG}/policy.py`], functions: ['calibrate.evidence_gate'], decisions: ['D-09 (gate as a policy value, recorded in every threshold set)'], numbers: 'Oriole (150 correct / 0 incorrect) and Plover (145 / 1) stop here.' } },
    { id: 'fit', label: 'Fit the curve', sub: 'logit(p) = b0 + b1 · logit(confidence)', kind: 'step', tag: 'package', col: 2, row: 5, detail: { what: 'Logistic regression of the verdict on the logit of the confidence, by ordinary maximum likelihood as in Wood & Kahl (2024). Firth’s penalised likelihood is used only as a fallback when the data are separated; FLIC is reported as a sensitivity.', code: [`${PKG}/estimators.py`, `${PKG}/calibrate.py`], functions: ['estimators.fit_ml (IRLS)', 'estimators.fit_firth', 'estimators.separation', 'calibrate.fit_primary'], decisions: ['D-05, D-09'], checks: ['Score equations ≈ 0 at the optimum; recovery of known coefficients on simulated data (tests)'] } },
    { id: 'accept', label: 'Accept the 99% point?', sub: 'valid, increasing, inside the validated range', kind: 'decision', tag: 'package', col: 2, row: 6, detail: { what: 'The threshold is where the fitted probability reaches 0.99: (ln(0.99/0.01) − b0) / b1 back on the confidence scale. It is accepted only if the fit is valid, the slope positive and the crossing inside the validated score range: no extrapolation.', code: [`${PKG}/calibrate.py`, `${PKG}/estimators.py`], functions: ['calibrate.accept', 'estimators.threshold_logit', 'calibrate.run_procedure'], decisions: ['D-05'], numbers: 'Nightjar accepted at 0.666639; Firefinch never reaches 0.99 inside its range.' } },
    { id: 'tset', label: 'Threshold set', sub: 'versioned artifact, content id', kind: 'store', tag: 'package', col: 1, row: 7, detail: { what: 'The artifact job A publishes and job B reads: policy values, code version, a hash of the validation snapshot and, per species, status, curve and operative threshold. Deterministic JSON (sorted keys, no timestamps) with a content-hash id, so identical inputs give byte-identical files; tampering is detected.', code: [`${PKG}/artifact.py`, `${PKG}/schemas/`], functions: ['artifact.build_threshold_set', 'artifact.content_id', 'artifact.verify_integrity', 'artifact.validate_threshold_set'], outputs: ['threshold_set.json', 'species_thresholds.csv'], numbers: 'ts-8fae4456dc6301a1.' } },
    { id: 'checks', label: 'Checks & review flags', sub: 'D-11, D-12', kind: 'step', tag: 'package', col: 2, row: 7, detail: { what: 'Model-free precision above the threshold (Wilson interval); calibration by score band; and a leave-one-recorder-out test: is each recorder’s number of correct clips consistent with the curve fitted without it (Poisson-binomial, Bonferroni)? Inconsistent recorders are flagged for review; flags never change a label.', code: [`${PKG}/calibrate.py`, `${PKG}/estimators.py`], functions: ['calibrate.recorder_checks', 'calibrate.model_free_check', 'estimators.wilson', 'estimators.poisson_binomial_cdf'], outputs: ['recorder_checks.csv', 'calibration_by_band.csv'], numbers: 'RBS75 and RBS79 flagged for the Nightjar; 2,277 predictions carry a review flag.' } },
    { id: 'boot', label: 'Uncertainty', sub: 'cluster bootstrap, 2,000 resamples', kind: 'step', tag: 'package', col: 3, row: 7, detail: { what: 'Resamples recorders (headline) or audio files with replacement and replays the whole procedure, gate included, in every resample: the share of resamples with a threshold, the conditional threshold interval and the interval of labelled counts. The delta-method interval is shown for comparison.', code: [`${PKG}/calibrate.py`, `${PKG}/estimators.py`], functions: ['calibrate.bootstrap', 'estimators.cluster_resamples', 'estimators.threshold_delta_ci'], decisions: ['D-12'] } },
    { id: 'sens', label: 'Sensitivity & covariates', sub: 'D-13 (AIC), 14 variants', kind: 'step', tag: 'research', col: 4, row: 7, detail: { what: 'Re-runs the procedure under alternative choices (logit endpoint, de-duplication, gate size, estimator, without flagged recorders) and tests transferability as Wood & Kahl suggest: recorder (random intercept, adaptive Gauss–Hermite) and time covariates compared by AIC. The evening model met the adoption rule, but labels keep the pooled curve because recorder–time confounding leaves its transferability unresolved; the evening thresholds are a sensitivity.', code: [`${RES}/run_challenge1.py`, `${RES}/covariates.py`], functions: ['run_challenge1.sensitivity', 'run_challenge1.covariate_models', 'covariates.fit_random_intercept'], outputs: ['sensitivity.csv', 'covariate_models.csv', 'estimator_comparison.csv'], decisions: ['D-13, D-14'] } },
    { id: 'label', label: 'Label every prediction', sub: 'job B: pure, no fitting', kind: 'step', tag: 'package', col: 1, row: 8, detail: { what: 'One label per prediction, in order: a uniquely linked human verdict decides; otherwise confidence ≥ the species threshold; a species without a supported threshold gets no automatic observations. Vectorised and side-effect free.', code: [`${PKG}/label.py`], functions: ['label.label', 'io_csv.verdicts_from_validations'], decisions: ['D-10 (human verdicts as labels)'], numbers: '3,460 observations = 3,097 above the threshold + 363 human-confirmed.' } },
    { id: 'labels', label: 'Labelled predictions', sub: 'observation column added', kind: 'output', tag: 'data', col: 1, row: 9, detail: { what: 'The predictions file with an observation label (and its source: model, validated, below threshold, no threshold) for every row; every original column byte-identical. The research script and the package CLI produce byte-identical files (tested).', code: [`${PKG}/io_csv.py`], functions: ['io_csv.write_takehome_output'], outputs: ['birdnet_predictions_with_observations.csv'] } },
    { id: 'report', label: 'Report outputs', sub: 'CSVs, figures, run summary, dashboard JSON', kind: 'output', tag: 'research', col: 3, row: 8, detail: { what: 'Everything the report and the dashboard read: per-species results, bootstrap, recorder checks, sensitivity, covariate models, calibration and sampling by band, figures, run_summary.json (inputs hashed, packages) and dashboard_results.json.', code: [`${RES}/run_challenge1.py`], functions: ['run_challenge1.main', 'run_challenge1.dashboard_payload', 'run_challenge1.figure'], outputs: ['challenge1/outputs/*'] } },
    { id: 'dash', label: 'Dashboard', sub: 'Birds → Thresholds & observations', kind: 'output', tag: 'dashboard', col: 3, row: 9, detail: { what: 'Embeds dashboard_results.json at build time and never re-implements an estimator. It re-applies the published label rule to the embedded predictions as a check, and reproduces the pipeline’s counts exactly.', code: ['dashboard/src/components/BirdsThresholds.tsx'] } },
    { id: 'platform', label: 'NS Analytics (handover)', sub: 'job A on new validations, job B on new predictions', kind: 'external', tag: 'platform', col: 0, row: 8, detail: { what: 'How the Tech team runs it: job A (calibrate) when validations change publishes a new threshold set; job B (label) labels each new prediction batch with the latest set; PostgreSQL tables with an append-only label history and immutability triggers. The CLI and Dockerfile exist; the PostgreSQL adapter is a stub never run against a database.', code: ['challenge1/ns_observations/src/ns_observations/cli.py', 'challenge1/ns_observations/sql/schema.sql', 'challenge1/ns_observations/Dockerfile', 'challenge1/Q2_tech_handover.md'], functions: ['ns-observations calibrate | label | run | validate'] } },
  ],
  edges: [
    { from: 'pred', to: 'load' }, { from: 'val', to: 'load' }, { from: 'load', to: 'link' }, { from: 'link', to: 'dedup' }, { from: 'dedup', to: 'gate' },
    { from: 'gate', to: 'fit', label: 'passes' }, { from: 'fit', to: 'accept' }, { from: 'accept', to: 'tset' }, { from: 'gate', to: 'tset', label: 'fails: no threshold', dashed: true },
    { from: 'accept', to: 'checks' }, { from: 'accept', to: 'boot' }, { from: 'accept', to: 'sens' }, { from: 'tset', to: 'label' }, { from: 'dedup', to: 'label', label: 'verdicts', dashed: true },
    { from: 'label', to: 'labels' }, { from: 'tset', to: 'report' }, { from: 'checks', to: 'report' }, { from: 'boot', to: 'report' }, { from: 'sens', to: 'report' }, { from: 'report', to: 'dash' },
    { from: 'tset', to: 'platform', dashed: true },
  ],
}

export const BIRDS_THRESHOLD_LOGIC: Diagram = {
  id: 'birds-logic',
  title: 'Logic: does a species get a threshold?',
  sub: 'The per-species decision, as calibrate.run_procedure applies it (and the bootstrap replays it in every resample). Each outcome is a status recorded in the threshold set.',
  order: ['start', 'g1', 'insuff', 'g2', 'firth', 'ml', 'g3', 'nofit', 'g4', 'notreached', 'accepted'],
  nodes: [
    { id: 'start', label: 'Validated clips of one species', sub: 'linked and de-duplicated', kind: 'input', col: 1, row: 0, detail: { what: 'Input to the procedure: confidence and verdict of each distinct validated prediction of the species, in a canonical order (so results do not depend on row order).', functions: ['calibrate.canonical'] } },
    { id: 'g1', label: '≥ 5 correct and ≥ 5 incorrect?', kind: 'decision', col: 1, row: 1, detail: { what: 'The evidence gate (k = 5 each outcome, a policy value). Without enough errors, any fitted curve is determined by a handful of clips and cannot locate a 99% point.', functions: ['calibrate.evidence_gate'], decisions: ['D-09'] } },
    { id: 'insuff', label: 'Insufficient validation', sub: 'no threshold; human verdicts only', kind: 'stop', col: 0, row: 2, detail: { what: 'No model-based observations for this species; validated-correct clips still count as observations.', numbers: 'African Black-headed Oriole (no errors) and Three-banded Plover (1 error).' } },
    { id: 'g2', label: 'Outcomes separated by score?', kind: 'decision', col: 2, row: 2, detail: { what: 'Perfect or quasi-complete separation makes the maximum-likelihood slope run to infinity.', functions: ['estimators.separation'] } },
    { id: 'firth', label: 'Firth penalised fit', sub: 'fallback only', kind: 'step', col: 3, row: 3, detail: { what: 'Bias-reduced estimates that stay finite under separation.', functions: ['estimators.fit_firth'], decisions: ['D-09'] } },
    { id: 'ml', label: 'Ordinary ML fit', sub: 'as in Wood & Kahl', kind: 'step', col: 1, row: 3, detail: { what: 'Iteratively reweighted least squares on logit(p) = b0 + b1·logit(conf).', functions: ['estimators.fit_ml'] } },
    { id: 'g3', label: 'Valid fit with b1 > 0?', kind: 'decision', col: 2, row: 4, detail: { what: 'Converged, finite covariance, and the probability of being correct increases with the score.', functions: ['calibrate.accept'] } },
    { id: 'nofit', label: 'No valid fit / slope not positive', kind: 'stop', col: 3, row: 5, detail: { what: 'No threshold: the score does not order correct and incorrect predictions in a usable way.' } },
    { id: 'g4', label: 'p = 0.99 reached inside the validated range?', kind: 'decision', col: 1, row: 5, detail: { what: 'The crossing (ln 99 − b0)/b1, mapped back to confidence, must fall between the lowest and highest validated score: the curve is never extrapolated.', functions: ['estimators.threshold_logit', 'calibrate.accept'], decisions: ['D-05'] } },
    { id: 'notreached', label: '99% not reached', sub: 'within the validated scores', kind: 'stop', col: 0, row: 6, detail: { what: 'No threshold: even the best-scoring validated clips are not 99% likely to be right.', numbers: 'Red-billed Firefinch (6 correct / 95 incorrect).' } },
    { id: 'accepted', label: 'Accepted: threshold = the crossing', sub: 'rounded up to 6 decimals', kind: 'stop', col: 2, row: 6, detail: { what: 'Predictions at or above the threshold become observations (unless a human verdict says otherwise). Uncertainty comes from the recorder bootstrap; review flags come from the recorder checks.', numbers: 'Abyssinian Nightjar: 0.666639 (117 correct / 33 incorrect validated); 3,147 predictions at or above it.' } },
  ],
  edges: [
    { from: 'start', to: 'g1' }, { from: 'g1', to: 'insuff', label: 'no' }, { from: 'g1', to: 'g2', label: 'yes' }, { from: 'g2', to: 'firth', label: 'yes' }, { from: 'g2', to: 'ml', label: 'no' },
    { from: 'ml', to: 'g3' }, { from: 'firth', to: 'g3' }, { from: 'g3', to: 'nofit', label: 'no' }, { from: 'g3', to: 'g4', label: 'yes' }, { from: 'g4', to: 'notreached', label: 'no' }, { from: 'g4', to: 'accepted', label: 'yes' },
  ],
}

export const BIRDS_LABEL_LOGIC: Diagram = {
  id: 'birds-label',
  title: 'Logic: the label of one prediction',
  sub: 'Job B (label.label): the same rule in the research script, the package CLI and the dashboard check.',
  order: ['p', 'h', 'hv', 'thr', 'obs', 'not', 'none'],
  nodes: [
    { id: 'p', label: 'One prediction', sub: 'species, confidence, file', kind: 'input', col: 1, row: 0, detail: { what: 'Any row of birdnet_predictions.csv (or a new platform batch).' } },
    { id: 'h', label: 'Uniquely linked human verdict?', kind: 'decision', col: 1, row: 1, detail: { what: 'A validated clip that links to exactly this one prediction (not a tie, not a duplicate).', decisions: ['D-10'] } },
    { id: 'hv', label: 'The verdict decides', sub: 'correct → observation · incorrect → not', kind: 'stop', col: 0, row: 2, detail: { what: 'Direct human evidence beats the model in both directions.', numbers: '363 validated-correct, 113 validated-incorrect predictions.' } },
    { id: 'thr', label: 'Species threshold exists and confidence ≥ it?', kind: 'decision', col: 2, row: 2, detail: { what: 'Only species whose threshold was accepted can produce automatic observations.' } },
    { id: 'obs', label: 'Observation (model)', kind: 'stop', col: 3, row: 3, detail: { what: 'Labelled as an observation from the threshold.', numbers: '3,097 model observations.' } },
    { id: 'not', label: 'Below threshold', sub: 'not an observation', kind: 'stop', col: 2, row: 4, detail: { what: 'The species has a threshold and the prediction scores below it.', numbers: '6,985 predictions.' } },
    { id: 'none', label: 'No species threshold', sub: 'not an observation', kind: 'stop', col: 1, row: 3, detail: { what: 'Species without an accepted threshold get no automatic observations.', numbers: '18,933 predictions.' } },
  ],
  edges: [
    { from: 'p', to: 'h' }, { from: 'h', to: 'hv', label: 'yes' }, { from: 'h', to: 'thr', label: 'no' }, { from: 'thr', to: 'obs', label: 'yes' }, { from: 'thr', to: 'not', label: 'below' }, { from: 'thr', to: 'none', label: 'no threshold' },
  ],
}

export const BIRDS_CODE_MAP: Diagram = {
  id: 'birds-code',
  title: 'Code map: modules and who uses what',
  sub: 'Arrows point from a module to the module it imports. The research analysis imports the package’s decision rules, so the two cannot drift apart.',
  order: ['policy', 'estimators', 'io', 'calibrate', 'artifact', 'label', 'cli', 'pg', 'run', 'cov', 'shim', 'tests_pkg', 'tests_res', 'dashb'],
  bands: [
    { label: 'ns_observations (deployable package, 50 tests)', row0: 0, row1: 2 },
    { label: 'Research analysis (38 tests) and dashboard', row0: 3, row1: 4 },
  ],
  nodes: [
    { id: 'policy', label: 'policy.py', sub: 'policy values, status codes', kind: 'module', tag: 'package', col: 0, row: 0, detail: { what: 'Target probability, gate size, estimator choice, linkage tolerance and the status vocabulary. Biometrics owns the values; every threshold set records them; changing one makes a new set.', code: [`${PKG}/policy.py`] } },
    { id: 'estimators', label: 'estimators.py', sub: 'ML, Firth, FLIC, thresholds', kind: 'module', tag: 'package', col: 1, row: 0, detail: { what: 'The numerical core: logistic fits (IRLS, Firth, FLIC), separation test, threshold and delta-method interval, cluster resamples, Wilson and Poisson-binomial.', code: [`${PKG}/estimators.py`], functions: ['fit_ml', 'fit_firth', 'fit_flic', 'threshold_logit', 'threshold_delta_ci', 'cluster_resamples', 'wilson', 'poisson_binomial_cdf'] } },
    { id: 'io', label: 'io_csv.py', sub: 'take-home CSV adapter', kind: 'module', tag: 'package', col: 2, row: 0, detail: { what: 'Reads the two exports, links and de-duplicates validations, writes the labelled file.', code: [`${PKG}/io_csv.py`], functions: ['read_predictions', 'read_validations', 'link_validations', 'deduplicate', 'verdicts_from_validations', 'write_takehome_output'] } },
    { id: 'calibrate', label: 'calibrate.py', sub: 'job A', kind: 'module', tag: 'package', col: 1, row: 1, detail: { what: 'Gate, fit, accept, bootstrap, recorder checks, model-free precision; calibrate() builds the threshold set.', code: [`${PKG}/calibrate.py`], functions: ['evidence_gate', 'fit_primary', 'accept', 'run_procedure', 'bootstrap', 'recorder_checks', 'model_free_check', 'calibrate'] } },
    { id: 'artifact', label: 'artifact.py + schemas/', sub: 'threshold set', kind: 'module', tag: 'package', col: 2, row: 1, detail: { what: 'Threshold-set data model, content id, integrity verification, JSON-schema validation.', code: [`${PKG}/artifact.py`, `${PKG}/schemas/`] } },
    { id: 'label', label: 'label.py', sub: 'job B', kind: 'module', tag: 'package', col: 3, row: 1, detail: { what: 'The pure, vectorised label rule.', code: [`${PKG}/label.py`], functions: ['label'] } },
    { id: 'cli', label: 'cli.py', sub: 'ns-observations', kind: 'module', tag: 'package', col: 0, row: 2, detail: { what: 'Command line: calibrate, label, run, validate. Entry point of the Docker image.', code: [`${PKG}/cli.py`, 'challenge1/ns_observations/Dockerfile'] } },
    { id: 'pg', label: 'io_postgres.py + schema.sql', sub: 'stub', kind: 'module', tag: 'spec', col: 3, row: 2, detail: { what: 'PostgreSQL adapter for the handover’s tables (runs, predictions, validations, threshold sets, labels, append-only label history, immutability triggers). Checked with a fake connection only; never run against a database.', code: [`${PKG}/io_postgres.py`, 'challenge1/ns_observations/sql/schema.sql'] } },
    { id: 'run', label: 'run_challenge1.py', sub: 'the full analysis', kind: 'module', tag: 'research', col: 1, row: 3, detail: { what: 'Orchestrates the nine steps (load → report), the sensitivity analyses and the dashboard payload. Imports the package for every decision rule.', code: [`${RES}/run_challenge1.py`] } },
    { id: 'cov', label: 'covariates.py', sub: 'AIC model comparison', kind: 'module', tag: 'research', col: 2, row: 3, detail: { what: 'Fixed-effect and random-intercept (adaptive Gauss–Hermite) logistic models for the transferability test (D-13).', code: [`${RES}/covariates.py`] } },
    { id: 'shim', label: 'thresholds.py', sub: 'compatibility shim', kind: 'module', tag: 'research', col: 0, row: 3, detail: { what: 'Re-exports the package estimators so older imports keep working; no logic of its own.', code: [`${RES}/thresholds.py`] } },
    { id: 'tests_pkg', label: 'package tests', sub: '50 tests', kind: 'test', tag: 'package', col: 3, row: 3, detail: { what: 'Gate, fits, acceptance, artifact determinism and tamper detection, label rule, the PostgreSQL stub’s calls, end-to-end acceptance.', code: ['challenge1/ns_observations/tests/'] } },
    { id: 'tests_res', label: 'research tests', sub: '38 tests', kind: 'test', tag: 'research', col: 0, row: 4, detail: { what: 'Pipeline determinism, byte-identical output vs the CLI, estimator recovery, covariate models.', code: ['challenge1/tests/'] } },
    { id: 'dashb', label: 'BirdsThresholds.tsx', sub: 'dashboard page', kind: 'module', tag: 'dashboard', col: 2, row: 4, detail: { what: 'Reads challenge1/outputs/dashboard_results.json; re-applies the label rule as a check.', code: ['dashboard/src/components/BirdsThresholds.tsx'] } },
  ],
  edges: [
    { from: 'calibrate', to: 'estimators' }, { from: 'calibrate', to: 'policy' }, { from: 'calibrate', to: 'artifact' }, { from: 'label', to: 'artifact' }, { from: 'label', to: 'estimators' },
    { from: 'label', to: 'policy' }, { from: 'artifact', to: 'policy' }, { from: 'io', to: 'label' }, { from: 'cli', to: 'calibrate' }, { from: 'cli', to: 'label' }, { from: 'cli', to: 'artifact' },
    { from: 'cli', to: 'io' }, { from: 'cli', to: 'policy' }, { from: 'pg', to: 'artifact' }, { from: 'pg', to: 'label' }, { from: 'run', to: 'calibrate' }, { from: 'run', to: 'io' }, { from: 'run', to: 'label' }, { from: 'run', to: 'cov' }, { from: 'shim', to: 'estimators' },
    { from: 'tests_pkg', to: 'calibrate', dashed: true }, { from: 'tests_res', to: 'run', dashed: true }, { from: 'run', to: 'dashb', label: 'dashboard JSON', dashed: true },
  ],
}

export const BIRDS_DIAGRAMS = [BIRDS_ARCHITECTURE, BIRDS_THRESHOLD_LOGIC, BIRDS_LABEL_LOGIC, BIRDS_CODE_MAP]

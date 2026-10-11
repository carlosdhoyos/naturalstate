# Natural State — Senior Data Scientist take-home

Two challenges:

1. **Birds:** turn BirdNET predictions into species observations using per-species confidence thresholds, and specify how the Tech team can automate it. A threshold is the score at which a prediction has a 99% fitted probability of being correct (Wood & Kahl 2024).
2. **Vegetation:** QA/QC herbaceous survey data from ODK, flagging issues without fixing them. Then report on data quality and specify the automated QA/QC dashboard.

This page leads with the answers. It then gives the main findings and decisions, how to reproduce and what has been verified, and finally the supporting code.

## 1. The answers

| Challenge | Question | Answer |
|---|---|---|
| Birds | Q1: thresholds and labelled observations | [`challenge1/Q1_report.md`](challenge1/Q1_report.md). Every prediction is labelled in `challenge1/outputs/` (`observation` column) |
| Birds | Q2: how the Tech team automates it | [`challenge1/Q2_tech_handover.md`](challenge1/Q2_tech_handover.md) |
| Vegetation | Q1: data quality report: (a) surveys, (b) plots, (c) sampling effort, (d) transect map | [`challenge2/Q1_data_quality_report.md`](challenge2/Q1_data_quality_report.md). It opens with a TL;DR and an action table. The transects are also in `challenge2/outputs/transects.geojson` for GIS |
| Vegetation | Q2: the QA/QC dashboard and its pipeline, for the Tech team | [`challenge2/Q2_tech_handover.md`](challenge2/Q2_tech_handover.md). It opens with an "At a glance" build plan. A working reference is the **QA/QC dashboard** page of the Data Explorer (below) |

## 2. Principal findings and decisions

### Birds

| Species | Result | Observations |
|---|---|---:|
| Abyssinian Nightjar | threshold 0.666639 (ordinary ML) | 3,185 |
| African Black-headed Oriole | insufficient validation (0 errors in 150 validated clips) | 132 human-confirmed |
| Three-banded Plover | insufficient validation (1 error in 146) | 137 human-confirmed |
| Red-billed Firefinch | 99% not reached within the validated scores | 6 human-confirmed |

The decisions that shape these results are in [`docs/challenge1_data_decisions.md`](docs/challenge1_data_decisions.md):

- **Validation linkage and de-duplication (D-01, D-02):** validated clips are linked to predictions on species, recorder, date, hour and score (±0.0005). 549 of 551 link, and probable duplicate validations count once. A human verdict replaces a prediction's label only where the link is unique.
- **Evidence gate (D-09):** a fitted curve may set a threshold only with at least 5 correct and 5 incorrect validated clips. Firth regression is a fallback for separated data, not a way around the gate.
- **Acceptance (D-05):** the 99% point counts only if the fit is valid, the curve increases, and the point lies inside the validated score range.
- **Labels (D-10):** the human verdict wins where a validated clip links to exactly one prediction; otherwise the label comes from confidence ≥ the species threshold.
- **Uncertainty (D-12):** a recorder-level bootstrap. Recorder and time covariates are compared by AIC (D-13), and the evening thresholds are reported as a sensitivity analysis, not adopted.

### Vegetation

- **Record completeness:** the 30 surveyed plots are complete at record level, apart from 10 quadrats that declare additional species without species rows. With one additional-species row that has no taxon, this makes the effort metrics of 8 plots **provisional** (C04, C08). The dashboard shows this status next to those numbers.
- **Sampling design:** the shrubland stratum was not sampled.
- **Provenance:** the dataset's provenance needs confirming.
  - The whole dataset, NS's prescribed points included, sits about 705 m below the terrain at its coordinates.
  - 20 identified taxa have no Kenyan GBIF record.
- **Taxon names:** names need curation. Raw richness is 132 taxa and resolved richness 115; 23 names are probably misspelled.
- **Forms:** the deployed forms differ from the form files (the geohash is taken from the measured midpoint; the replicate label is in lower case). No record was edited.
- **Transects:** several are offset, too short or bent.
- **Provisional ids:** a late upload let two devices claim the same provisional species ids. Here they were the same plants, so it is a process risk that did not change the data.

The decisions behind these findings are in [`docs/challenge2_decisions.md`](docs/challenge2_decisions.md):

- **Canonical survey (V-01):** at most one survey per plot and replicate counts. A duplicated KEY and rejected or hasIssues submissions never count.
- **Raw vs resolved taxonomy (V-02, V-03):** only NS's own curation is applied, and names are never corrected.
- **Effort statistics (V-10):** coverage first, then bias-corrected Chao2 with intervals and incidence Hill numbers, per replicate.
- **Analytical eligibility (V-12):** effort metrics are `ok`, `provisional` (conditional on records a rule found incomplete) or `suppressed` (nothing to read). The project figure inherits the status of its plots.
- **Deployment guarantees (V-13):**
  - an input contract checked before any analysis;
  - staged publication that a `--verify` command can check;
  - runtime provenance and review keys on every result.

## 3. Reproduce and verify

```bash
# Challenge 1 (about 5 s)
python3.13 -m venv challenge1/.venv && challenge1/.venv/bin/pip install -r challenge1/requirements-lock.txt
challenge1/.venv/bin/pip install -e "challenge1/ns_observations[test]"
challenge1/.venv/bin/python challenge1/src/run_challenge1.py
challenge1/.venv/bin/python -m pytest challenge1/tests -q              # 38 research tests
challenge1/.venv/bin/python -m pytest challenge1/ns_observations -q    # 50 package tests

# Challenge 2 (about 3 s)
python -m venv challenge2/.venv && challenge2/.venv/bin/pip install -r challenge2/requirements.txt
challenge2/.venv/bin/python challenge2/src/run_challenge2.py
challenge2/.venv/bin/python challenge2/src/run_challenge2.py --verify   # outputs/ holds one complete run
(cd challenge2/tests && ../.venv/bin/python -m pytest -q)               # 165 tests

# Data Explorer (single HTML file)
(cd dashboard && npm install && npm run build)
```

Both runs are offline and deterministic: the same inputs give the same outputs and the same run id. Each challenge README has the details and the container commands.

| Verified | Not verified, or specified only |
|---|---|
| **Tests:** 38 + 50 (birds) and 165 (vegetation), all passing. | **iNEXT cross-check not run:** the custom Chao2 intervals and coverage were not compared with iNEXT (R unavailable here). This should be done before the numbers are used operationally. |
| **Bird estimators** checked against statsmodels, an analytic Firth result and direct optimisation. | **Atomic publication not built:** one atomic switch over versioned run folders is specified only. Today's publication is staged and checkable, but not atomic across files (Challenge 2 Q2 §7). |
| **Vegetation:** 35 rules mutation-tested; the whole workflow tested on invalid inputs; a crash during publication is detected and repaired. | **Multi-round dashboard not browser-checked:** the marts are kept per replicate and tested, but the data has one round, so the dashboard's multi-round display has not been seen in a browser. |
| **Vegetation container** (`vegqa:1.0.0`) built and run: same run id, and its tables and dashboard JSON are byte-identical to a local run. | **Specified only, for the Tech team:** flag-review storage, structured curation fields, scheduling and database persistence. |
| **Dashboard in a real browser:** checked in Chrome (source panels, filters, map). Later changes were checked in headless screenshots. | **Out of reach of the data:** the dataset's origin, unidentified plants, missing observations, and the field layout as walked. These are flagged as uncertainties. |

## 4. Supporting implementation and appendices

- **Data Explorer** ([`dashboard/standalone/index.html`](dashboard/standalone/index.html)): one self-contained file you can download and double-click. It explores all 17 input CSVs and holds the results pages for both challenges:
  - Birds → Thresholds & observations;
  - Vegetation → QA/QC dashboard;
  - a **How it works** page per challenge: interactive diagrams of the architecture, the decision logic and the code map.

  See [`dashboard/README.md`](dashboard/README.md).
- **Challenge 1 code** ([`challenge1/`](challenge1/README.md)):
  - the research analysis (`src/`);
  - the deployable package [`ns_observations`](challenge1/ns_observations/README.md), with its CLI, JSON schemas and Dockerfile.
- **Challenge 2 code** ([`challenge2/`](challenge2/README.md)):
  - the QA/QC pipeline;
  - the rule catalogue [`rules/rules.yaml`](challenge2/rules/rules.yaml): 94 rules, each with its source, severity and metric impact;
  - the Dockerfile.
- **Decision logs:**
  - [`docs/challenge1_data_decisions.md`](docs/challenge1_data_decisions.md): D-01 to D-14. Each entry separates the policy from its measured consequences; superseded parts are marked, not deleted.
  - [`docs/challenge1_paper_alignment.md`](docs/challenge1_paper_alignment.md): Wood & Kahl's recommendations, point by point.
  - Challenge 1 confirmation items C-1 to C-7: [`challenge1/Q1_report.md`](challenge1/Q1_report.md), section 9.
  - [`docs/challenge2_decisions.md`](docs/challenge2_decisions.md): V-01 to V-13, differences from the exploratory review, new findings N1–N13, five independent reviews and a bug check, and confirmation items C-1 to C-12.

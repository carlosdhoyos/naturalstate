# Natural State — Senior Data Scientist take-home

Two challenges:

1. **Birds**: turn BirdNET predictions into species observations using per-species confidence thresholds (Wood & Kahl 2024: the score at which a prediction has a 99% fitted probability of being correct), and specify how the Tech team can automate it.
2. **Vegetation**: clean, join and QA/QC herbaceous vegetation survey data from ODK (flag issues, don't fix them), produce a data quality report, and specify the automated QA/QC dashboard pipeline.

Each challenge has its own folder with code and a Markdown write-up.

## Challenge 1

[`challenge1/`](challenge1/README.md) holds the reproducible threshold workflow (Python), its tests, and its outputs. The main output labels every prediction with an `observation` column.

| Species | Result | Observations |
|---|---|---:|
| Abyssinian Nightjar | threshold 0.666639 (ordinary ML) | 3,185 |
| African Black-headed Oriole | insufficient validation (0 errors in 150 validated clips) | 132 human-confirmed |
| Three-banded Plover | insufficient validation (1 error in 146) | 137 human-confirmed |
| Red-billed Firefinch | 99% not reached within the validated scores | 6 human-confirmed |

- **Q1 answer:** [`challenge1/Q1_report.md`](challenge1/Q1_report.md).
- **Q2 answer, for the Tech team:** [`challenge1/Q2_tech_handover.md`](challenge1/Q2_tech_handover.md).
- **Deployable package:** [`challenge1/ns_observations/`](challenge1/ns_observations/README.md), with the `ns-observations calibrate` / `label` CLI, JSON schemas and a Dockerfile.
- **How the analysis follows Wood & Kahl:** [`docs/challenge1_paper_alignment.md`](docs/challenge1_paper_alignment.md).

## Challenge 2

[`challenge2/`](challenge2/README.md) holds the reproducible QA/QC pipeline (Python), its rule catalogue, tests and outputs. No source value is changed: every problem is a flag pointing to its source row.

- **Q1 answer:** [`challenge2/Q1_data_quality_report.md`](challenge2/Q1_data_quality_report.md): (a) survey-level summary, (b) plot-level summary, (c) sampling effort, (d) map of transect locations.
- **Q2 answer, for the Tech team:** [`challenge2/Q2_tech_handover.md`](challenge2/Q2_tech_handover.md), with a working reference of the dashboard: the **QA/QC dashboard** page of the Data Explorer (Vegetation → QA/QC dashboard).
- **Rule catalogue:** [`challenge2/rules/rules.yaml`](challenge2/rules/rules.yaml): 94 rules, each with its source, severity and metric impact.
- **Headline:**
  - The 30 surveyed plots are complete at record level.
  - The shrubland stratum was not sampled.
  - The data do not fit Lewa: the whole dataset, NS's prescribed points included, sits about 705 m below the terrain, and 20 identified taxa have no Kenyan GBIF record.
  - Taxon names need curation: raw richness is 132 taxa, resolved 115; 23 names are probably misspelled.
  - The deployed forms differ from the form files (geohash taken from the measured midpoint; replicate label in lower case); no record was edited.
  - Several transects are offset, too short or bent.
  - A late upload let two devices claim the same provisional species ids. Here they were the same plants, so it is a process risk that did not change the data.

## Data Explorer

[`dashboard/standalone/index.html`](dashboard/standalone/index.html) is a single self-contained file. Download it and double-click to explore all 17 input CSVs of the take-home (profiles, charts, filters, table, map) with no server. See [`dashboard/README.md`](dashboard/README.md) for what it does and the decisions behind it.

## Decision logs

- [`docs/challenge1_data_decisions.md`](docs/challenge1_data_decisions.md): Challenge 1 decisions.
  - D-01 to D-04 are data decisions: duplicate validations, linkage, recorder clocks, Nightjar site effects.
  - D-05 to D-08 record the first modelling pass: method routing and acceptance, Oriole, Plover, uncertainty and endpoints.
  - D-09 to D-12 come from an independent review: the evidence gate, human verdicts as labels, data-driven review flags, and the meaning of "99%" and of the uncertainty.
  - D-13 is Wood & Kahl's covariate test, compared by AIC; D-14 records how the five other papers were used (reported, used as a check, not adopted, or downstream).
  - Each entry separates the policy from its measured consequences; superseded parts are marked, not deleted.
- [`docs/challenge1_paper_alignment.md`](docs/challenge1_paper_alignment.md): Wood & Kahl's recommendations, point by point, against what the analysis does.
- Challenge 1 confirmation items C-1 to C-7: [`challenge1/Q1_report.md`](challenge1/Q1_report.md), section 9.
- [`docs/challenge2_decisions.md`](docs/challenge2_decisions.md): Challenge 2 decisions (V-01 to V-11), differences from the exploratory review, new findings (N1–N13), the independent review, and confirmation items (C-1 to C-12).

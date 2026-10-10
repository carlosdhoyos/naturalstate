# Natural State — Senior Data Scientist take-home

Two challenges:

1. **Birds**: turn BirdNET predictions into species observations using per-species confidence thresholds (Wood & Kahl 2024: the score at which a prediction has a 99% fitted probability of being correct), and specify how the Tech team can automate it.
2. **Vegetation**: clean, join and QA/QC herbaceous vegetation survey data from ODK (flag issues, don't fix them), produce a data quality report, and specify the automated QA/QC dashboard pipeline.

Challenge 1 is complete. Challenge 2 is in progress. Each challenge has its own folder with code and a Markdown write-up.

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

## Data Explorer

[`dashboard/standalone/index.html`](dashboard/standalone/index.html) is a single self-contained file. Download it and double-click to explore every CSV in this repo (profiles, charts, filters, table, map) with no server. See [`dashboard/README.md`](dashboard/README.md) for what it does and the decisions behind it.

## Decision logs

- [`docs/challenge1_data_decisions.md`](docs/challenge1_data_decisions.md): Challenge 1 decisions.
  - D-01 to D-04 are data decisions: duplicate validations, linkage, recorder clocks, Nightjar site effects.
  - D-05 to D-08 record the first modelling pass: method routing and acceptance, Oriole, Plover, uncertainty and endpoints.
  - D-09 to D-12 come from an independent review: the evidence gate, human verdicts as labels, data-driven review flags, and the meaning of "99%" and of the uncertainty.
  - D-13 is Wood & Kahl's covariate test, compared by AIC.
  - Each entry separates the policy from its measured consequences; superseded parts are marked, not deleted.
- [`docs/challenge1_paper_alignment.md`](docs/challenge1_paper_alignment.md): Wood & Kahl's recommendations, point by point, against what the analysis does.

# Natural State — Senior Data Scientist take-home

Two challenges:

1. **Birds**: turn BirdNET predictions into species observations using per-species confidence thresholds (Wood & Kahl 2024: the score at which a prediction has a 99% fitted probability of being correct), and specify how the Tech team can automate it.
2. **Vegetation**: clean, join and QA/QC herbaceous vegetation survey data from ODK (flag issues, don't fix them), produce a data quality report, and specify the automated QA/QC dashboard pipeline.

Work in progress. Each challenge gets its own folder with code and a Markdown write-up.

## Challenge 1

[`challenge1/`](challenge1/README.md) holds the reproducible threshold workflow (Python), its tests, and its outputs. The outputs include every prediction labelled with an `observation` column. The Q1 report and the Tech handover (Q2) are in progress.

## Data Explorer

[`dashboard/standalone/index.html`](dashboard/standalone/index.html) is a single self-contained file. Download it and double-click to explore every CSV in this repo (profiles, charts, filters, table, map) with no server. See [`dashboard/README.md`](dashboard/README.md) for what it does and the decisions behind it.

## Decision logs

- [`docs/challenge1_data_decisions.md`](docs/challenge1_data_decisions.md): Challenge 1 decisions.
  - D-01 to D-04 are data decisions: duplicate validations, linkage, recorder clocks, Nightjar site effects.
  - D-05 to D-08 are modelling decisions: method routing and acceptance, Oriole, Plover, uncertainty and endpoints. Each separates the policy from its measured consequences.

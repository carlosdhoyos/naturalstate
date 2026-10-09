# Natural State — Senior Data Scientist take-home

Two challenges:

1. **Birds**: turn BirdNET predictions into species observations using per-species confidence thresholds (Wood & Kahl 2024, precision ≥ 0.99), and specify how the Tech team can automate it.
2. **Vegetation**: clean, join and QA/QC herbaceous vegetation survey data from ODK (flag issues, don't fix them), produce a data quality report, and specify the automated QA/QC dashboard pipeline.

Work in progress. Each challenge will get its own folder with code and a Markdown write-up.

## Data Explorer

[`dashboard/standalone/index.html`](dashboard/standalone/index.html) is a single self-contained file. Download it and double-click to explore every CSV in this repo (profiles, charts, filters, table, map) with no server. See [`dashboard/README.md`](dashboard/README.md) for what it does and the decisions behind it.

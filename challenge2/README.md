# Challenge 2: herbaceous vegetation QA/QC

This folder holds a reproducible QA/QC pipeline for the ODK herbaceous vegetation data. It does three things:

- cleans and joins the data **without changing any value**;
- runs a declarative rule catalogue over it;
- writes the flags, the joined tables, the sampling-effort statistics and the report figures.

**The two answers to the brief:**

- **[Q1_data_quality_report.md](Q1_data_quality_report.md):** the data quality report.
  - Sections: (a) survey-level summary, (b) plot-level summary, (c) sampling effort, (d) map of transect locations.
  - Also: the headline issues, decisions, confirmation items, and the full rule catalogue with results.
- **[Q2_tech_handover.md](Q2_tech_handover.md):** what the Tech team needs to run this automatically and build the Vegetation QA/QC dashboard.
- **The dashboard itself:** [`dashboard/standalone/index.html`](../dashboard/standalone/index.html) → Vegetation → **QA/QC dashboard**. It has nine views (overview, all flags, submissions timeline, map with transect panels, plots, taxonomy curation queue, sampling effort, rules, field feedback), all read from `outputs/dashboard_results.json`.
- **For NS's curators:** [`outputs/species_list_suggestions.csv`](outputs/species_list_suggestions.csv), with spellings to confirm, taxa to add to the list, merges and range checks, each with its evidence.

**How it works:**

- **Inputs are read as text and never modified.** Interpreted values (UTC times, numbers, coordinates, token lists) are added as new columns.
- **[`rules/rules.yaml`](rules/rules.yaml)** holds 94 rules, each with its source (SOP step, form row, entity list, or judgement), severity, metric impact and thresholds. The engine refuses to run if the catalogue and the code disagree.
- **Every rule × entity gets a result:** `fail`, `pass` or `could_not_check`. A missing check is never shown as a pass.
- **Taxa are kept in two layers:** raw (as recorded) and resolved (through Natural State's curation table). Spellings are never corrected; they are flagged.
- **Geometry is tested against the reported GPS accuracy**, so GPS noise is not flagged as field error.
- **GBIF name matches and range counts, and SRTM terrain elevations, are cached** in [`reference/`](reference/). The run itself is offline and deterministic.

**Run it:**

```bash
python -m venv challenge2/.venv && challenge2/.venv/bin/pip install -r challenge2/requirements.txt
challenge2/.venv/bin/python challenge2/src/run_challenge2.py         # writes outputs/ and outputs/figures/ (about 3 s)
challenge2/.venv/bin/python challenge2/src/run_challenge2.py --verify  # checks outputs/ holds one complete run (manifest hashes)
(cd challenge2/src && ../.venv/bin/python -m vegqa.report_tables)    # refreshes the report's tables from outputs/
(cd challenge2/tests && ../.venv/bin/python -m pytest -q)            # 162 tests (acceptance, mutation, robustness, unit)
(cd challenge2/src && ../.venv/bin/python -m vegqa.gbif)             # optional: fetch GBIF data for new names (network)
(cd challenge2/src && ../.venv/bin/python -m vegqa.dem)              # optional: fetch terrain elevations for new points (network)
(cd dashboard && npm install && npm run build)                        # rebuild the dashboard page with the new outputs
```

**Or as a container job** (the deployment the handover recommends; no network needed). Built and run here (2026-10-11): same run id, and every table and the dashboard JSON are byte-identical to a local run. The figure PNGs are re-rendered on Linux, so they match in content but not byte for byte.

```bash
docker build -t vegqa:1.0.0 challenge2
docker run --rm \
  -v "$PWD/Data Vegetation/ODK Data Exports:/data/exports:ro" \
  -v "$PWD/Data Vegetation/Entity lists:/data/entities:ro" \
  -v "$PWD/Data Vegetation/ODK Data Collection Forms:/data/forms:ro" \
  -v "$PWD/challenge2/out:/out" vegqa:1.0.0
```

**What the tests pin:**

- every finding of the earlier exploratory review: 35 findings and 12 passed checks;
- the deliberate differences from it;
- the new findings N1–N13;
- that each of 35 rules creates a new failure on a copy of the data with one injected error (mutation tests);
- that the whole workflow survives invalid inputs (duplicate keys, empty surveys, rejected-only plots, fractional quadrat numbers, a second replicate) and reports them;
- determinism, and that the inputs are never modified.

**Related documents:**

- [`docs/challenge2_decisions.md`](../docs/challenge2_decisions.md): decisions V-01 to V-13, differences from the exploration, new findings, the independent review and what changed, confirmation items C-1 to C-12.
- [`outputs/`](outputs/): `qa_flags.csv` (every failure), `rule_summary.csv`, the joined tables, the effort tables, `figures/`, `transects.geojson` (registered transects, prescribed points and quadrats for GIS), and `run_manifest.json` (run id, input hashes and a hash for every output).

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
(cd challenge2/src && ../.venv/bin/python -m vegqa.report_tables)    # refreshes the report's tables from outputs/
(cd challenge2/tests && ../.venv/bin/python -m pytest -q)            # 131 tests (acceptance, mutation, unit)
(cd challenge2/src && ../.venv/bin/python -m vegqa.gbif)             # optional: fetch GBIF data for new names (network)
(cd challenge2/src && ../.venv/bin/python -m vegqa.dem)              # optional: fetch terrain elevations for new points (network)
```

**What the tests pin:**

- every finding of the earlier exploratory review: 35 findings and 12 passed checks;
- the deliberate differences from it;
- the new findings N1–N13;
- that 34 rules fire on a copy of the data with one injected error (mutation tests);
- determinism, and that the inputs are never modified.

**Related documents:**

- [`docs/challenge2_decisions.md`](../docs/challenge2_decisions.md): decisions V-01 to V-11, differences from the exploration, new findings, the independent review and what changed, confirmation items C-1 to C-11.
- [`outputs/`](outputs/): `qa_flags.csv` (every failure), `rule_summary.csv`, the joined tables, the effort tables, `figures/`, and `run_manifest.json` (run id and input hashes).

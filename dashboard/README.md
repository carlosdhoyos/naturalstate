# NS Data Explorer

An interactive explorer for every CSV in this take-home: the bird data (BirdNET predictions and ornithologist validations) and the vegetation data (ODK exports and entity lists). It's a tool for *looking* at the data before modelling or QA/QC, so that later decisions are based on what is actually in the files.

**Open `standalone/index.html` in any browser by double-clicking it.** No server, no install and no network are needed. The JavaScript, styles, font and all 17 CSVs are inlined in that one ~10 MB file. The only thing fetched online is the map's basemap tiles. Points and transects draw without them.

## Layout: one section per challenge

The header switch picks **1 · Birds** or **2 · Vegetation**. Each challenge has its own sidebar, which shows only its files, and its own **Summary** page. Every number on a Summary page is computed from the CSVs when the page loads.

- **Birds summary:**
  - Headline counts: predictions, validated clips, species, confidence range, dates.
  - **Species included:** volume, recorders/files, confidence min·median·max, validated correct/wrong, raw share correct with a Wilson CI, and the link to the predictions file.
  - **Validation coverage by confidence band:** correct/validated, next to the number of predictions in each band.
  - **How balanced are the data and the validation?** Five live checks:
    1. Species: prediction volume vs validation effort.
    2. Correct vs incorrect: the rarer outcome, flagged against a ≥ 20 rule of thumb, with separation called out.
    3. Confidence range: predictions vs validated shares per band, plus a two-sample KS test of whether validation mirrors the predictions or over-samples high scores.
    4. Recorders and files: never-validated recorders, recorder concentration per species, files contributing several clips (clustering).
    5. Time coverage.

    It ends with the consequences for each species' threshold.
  - A confidence ECDF per species.
  - The two files and how they relate.
- **Birds methodology:** one tab per paper, plus an **Overview** that shows where each paper plugs in (score → probability → decision → ecology) and compares them side by side. Every tab has a paper header (citation, link, OpenAlex citations as of 2026-10-09, and its role relative to the brief), a clickable flowchart, an interactive schematic on **simulated data**, and a "what it means for this challenge" note.
  - *Thompson 2025 (extension):* partial pooling of species curves, from complete pooling to none. It uses an empirical-Bayes approximation of a mixed model, labelled as such.
  - *Tseng 2025 (decision rule):* the precision of the whole kept set above T (Σ TPR·N / Σ N) vs pr(correct) at T. It follows the paper's stratified 10-per-class design with a GLM on raw confidence, and compares universal vs species-specific thresholds.
  - *Schwinger 2025 (diagnostics):* a reliability diagram and ECE before and after Platt scaling.
  - *Navine 2024 (different endpoint):* log-quantile bins, per-bin Beta (c = 0.1) and a bootstrap 90% CI for call density, compared with threshold counts.
  - *Clare 2021 (downstream):* occupancy with false positives. It compares naive estimates, a model that ignores false positives, and an MLE that accounts for them using site confirmation.
  - Paper descriptions were checked against the papers themselves (full text, or abstracts via OpenAlex where the publisher blocks access).
- **Wood & Kahl tab (the baseline the brief requires):**
  - A clickable 9-step pipeline (BirdNET → validation → thresholding). Each step shows what the paper says next to where it appears in our data, with a "Show me" link.
  - A logit ↔ confidence explorer with a compression ruler.
  - Approach A, *review down to a threshold*.
  - An Approach B simulator. You set the true score–accuracy curve, the sampling design (random / random + high / per band), the sample size and the target p. It draws validation clips, fits `logit(p) = β₀ + β·score` live, and solves the threshold with a delta-method 95% CI. It also shows the consequences: share of predictions labelled, their true precision, and recall. It reproduces perfect separation and unreachable targets. **The simulator uses synthetic data only.**
  - The fitter (`src/lib/logistic.ts`, IRLS, same maximum-likelihood estimate as R's `glm(binomial)`) was checked on synthetic data: score equations ≈ 1e-15, it recovers the true coefficients, and the threshold CI covers the truth.
- **Birds data quality:** 18 automated checks of the files themselves (pass / info / flag), with evidence and recommendations:
  - **Structure:** empty cells, duplicates, constant columns.
  - **Segment integrity:** 3-s length, overlaps, complete selection numbers.
  - **File naming between the two exports:** the predictions export rounds file names down to the hour and counts `begin_time_s` from the hour. The validation names keep the true start second; this is confirmed on 550 of 550 clips.
  - **Linkage:** 549 of 551 validated clips link to a prediction.
  - **Recorder clocks:** inferred from the activity of a diurnal and a nocturnal species. RBS40 and RBS71 run about 3 h behind, likely on UTC.
  - **Ecological plausibility:** e.g. the nocturnal Nightjar in daytime, the diurnal Oriole at night.
- **Data quality → Time zones & clocks tab:** whether the hours are local or UTC.
  - **Birds:** the files carry no time zone. Oriole dawn onset and Nightjar dusk onset are compared with sunrise and sunset computed (NOAA approximation) for candidate East African sites over the recording period. 41 recorders match local time (EAT, UTC+3); RBS40 and RBS71 match UTC. There is a toggle between the hours as recorded and corrected to local time.
  - **Vegetation (ODK):** every form time is stamped +02:00, although Kenya is +03:00. The instants are correct: the server never receives a form before it ended, and all 640 photos fall inside their survey window. Only the label is wrong, so wall-clock times read off the stamps are 1 h behind local time.
  - **Impact table:** thresholds are unaffected; time-of-day and daily views are affected.
- **Birds diurnal cycles:** hour by hour, in corrected local time (with an "as recorded" toggle).
  - Relative average confidence: the hourly mean ÷ the species' mean, with 95% CIs. Mean, mean logit and share ≥ 0.5 are also available.
  - The diurnal cycle of the validation sample vs the predictions.
  - The share correct by hour, with Wilson CIs.
  - A period table (dawn / day / evening / night) and the hours that were predicted but never validated.
  - Validated clips are placed exactly in their file's clock hour, because segment times count from the top of the hour.
- **Derived time columns:**
  - Birds: `clock_correction_h`, `detection_time_local`, `hour_local`, `date_local`; validations: `hour_local`. The correction is inferred from bird activity in `src/data/clocks.ts`, not hard-coded.
  - Vegetation: `start_hour_eat`.
  - Every date-time column now records the UTC offsets found in its raw text, shown on its Overview card.
- **Vegetation summary:**
  - Headline counts.
  - Every table, with what one row means.
  - **How the tables join:** each key and the % of references that resolve.

The vegetation tables are grouped as *Field submissions (ODK forms)*, *Plots & sampling design*, *Taxonomy* and *Lookups*.

## What you can do

| Tab | Purpose |
|---|---|
| **Overview** | Profiles every column: inferred type, % empty, distinct values, a mini distribution, summary stats or top values. Hides the empty/constant ODK note fields by default. Each card has *Plot* and *Filter* shortcuts. |
| **Explore** | A chart builder with histogram, bar, line, box, violin, strip, scatter, ECDF and heatmap. Options include color-by, small multiples, log / log₁₀ / logit scales, aggregates (count, share, mean, median, sum, min, max), bins, time units and jitter. A scatter can add a binned mean of Y with a 95% CI (a Wilson interval when Y is 0/1). **Quick views** are per-dataset starting points, such as the Wood & Kahl outcome-vs-logit(confidence) plot. |
| **Table** | Sortable, searchable, paginated raw rows. *CSV* exports the current slice. |
| **Map** | Appears for datasets with coordinates: transects (A → midpoint → B), quadrats, centroids and background points. Basemaps: light, dark, satellite or streets. |

Filters sit in one bar above every tab and apply to all of them. You can add a filter from the bar, from a column card, **by clicking a bar, histogram bin or heatmap cell**, or **by dragging a box on a scatter**. Filters, chart settings and the open tab are remembered per dataset in your browser. The URL hash (`#/<dataset>/<tab>`) links to a view.

Every chart has a **"Data behind this chart"** table, with CSV export, holding the exact numbers that were plotted. Each chart also has a one-line **"How to read this chart"** caption, written from the current settings.

## Built-in explanations

- **Hover (or keyboard-focus) any label** for a tooltip explaining it. Labels with a dotted underline have one, as do buttons, chart types, every setting, stat tiles, mini-stat names, type badges and filter options.
- **Hover a column name** (card title, table header, filter list) for what that *data* column means:
  - *ODK exports:* the form question, hint, ODK type and choice list, read from Natural State's XLSForms by [`scripts/build_odk_dictionary.py`](scripts/build_odk_dictionary.py) into `src/data/odk_dictionary.json`. Re-run the script if the forms change.
  - *ODK Central system columns, entity-list system columns, BirdNET/Raven columns and entity attributes:* written by hand in `src/data/dictionary.ts`. Claims were checked against the data (e.g. every segment is 3 s, `file_offset_s` = `begin_time_s`, `selection` is unique within an audio file). Meanings that the provided files don't document are marked as such.
- **Guide** (top right): every explanation in one searchable panel, grouped by section. It reads the same entries as the tooltips (`src/lib/help.ts`), so the two never disagree.

## Data handling decisions

- **Nothing is fixed or dropped.** Raw values are shown as they are. The vegetation challenge says errors are to be *flagged, not resolved*, and the explorer follows the same rule.
- **Derived columns are marked.** They have a dashed card, a `derived` group in the pickers, and a `derived:` prefix in exports. They only parse keys or join parents to children:
  - *Predictions:* grid, recording file, recording start, detection time, date, hour of day (recorder clock), `logit_confidence`, `validated` and `validation_outcome`.
  - *Validations:* `outcome_label`, recorder, file, clip index, `link_to_predictions`.
  - *Quadrats / additional species:* plot name, review state, device and recorder carried down from the parent survey via `PARENT_KEY`. Also the species uuids resolved to names.
  - *Surveys / registrations:* form duration and submission delay.
  - *Entity lists:* lat/lon/alt/accuracy parsed from the `geometry` geopoint.
- **Validation ↔ prediction link.** Matching on species, recorder, day, hour and score links 549 of 551 validated clips to a prediction: most uniquely, some tied with other same-score predictions in that hour, and 2 not found. Matching on the exact file name does *not* work, because the two exports name the same audio differently:
  - the validation file names keep the true start second (`…_040002`)
  - the predictions export rounds the name down to the hour (`…_040000`) and adds the offset to `begin_time_s`

  An earlier version of this page said "only 263 match; the predictions are a subset of the BirdNET run". That was wrong, and it was corrected after the data-quality checks.
- **Type inference is conservative.** A column is numeric or date-time only if *every* non-empty value parses. ODK multi-selects (space-separated choice names or uuids) are detected and counted per token.
- **Datetimes display in UTC.** ODK timestamps carry their device offset (+02:00 here). Bird recording times come from file names and are shown on the recorder's clock.
- **logit** clamps scores to [1e-4, 1 − 1e-4] so a confidence of 1.0 stays finite.

## Design decisions

- **Stack:** Vite 5, React 18 and TypeScript, matching Natural State's front-end stack. Plotly.js handles charts and maps. PapaParse parses the CSVs.
- **Colors:** taken from naturalstate.org (navy `#00354D`, teal `#34BAA8`, mist `#DFE6E9`).
  - The 8-slot categorical palette starts with NS teal. Its order was chosen by running a colorblind-safety validator over every permutation and keeping only orders that pass in light and dark mode: adjacent CVD ΔE ≥ 8, normal-vision ΔE ≥ 15, and lightness/chroma bands.
  - Scatters with more than 3 groups also use marker shapes.
  - A color always belongs to its category, never to its rank, so filtering never repaints the remaining series.
  - Only one hue (teal) is used for sequential scales.
- **Typeface:** Figtree, an open-source stand-in for the site's Avenir/DIN light faces.
- **Light/dark/system theme**, keyboard-reachable controls, and a table twin for every chart.

## Develop

```bash
cd dashboard
npm install
npm run dev        # http://localhost:5173, live reload, reads ../Data * directly
npm run build      # → standalone/index.html (single self-contained file)
npm run typecheck
```

```
src/
  data/registry.ts   finds every ../Data */**/*.csv at build time and embeds its text
  data/load.ts       CSV parse, type inference, column labels from ODK paths
  data/enrich.ts     derived columns and joins (all flagged as derived)
  data/filter.ts     filter model, value counts, stable category order
  data/stats.ts      binning, quantiles, Wilson interval, formatting
  charts/build.ts    ChartSpec + rows → Plotly figure + table twin + click-to-filter map
  charts/presets.ts  quick views per dataset
  charts/describe.ts "How to read this chart" sentence from the current settings
  data/sun.ts        sunrise/sunset (NOAA approximation), candidate sites
  data/clocks.ts     recorder clock inference from species activity
  lib/logistic.ts    logistic regression (IRLS), threshold + delta-method CI, seeded RNG
  lib/simstats.ts    Beta/Gamma/normal samplers, Nelder–Mead, binomial pmf (unit-checked)
  components/Methodology.tsx  paper tabs; components/methods/* one file per paper + Overview
  data/dictionary.ts column meanings (ODK form questions + documented formats)
  lib/help.ts        every tooltip and Guide entry (single source)
  components/        Overview, Explore, Table, Map, FilterBar, Plot wrapper, UI atoms
  lib/palette.ts     validated palette and theme tokens
```

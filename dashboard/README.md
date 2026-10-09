# NS Data Explorer

An interactive explorer for every CSV in this take-home: the bird data (BirdNET predictions and ornithologist validations) and the vegetation data (ODK exports and entity lists). It's a tool for *looking* at the data before modelling or QA/QC, so that later decisions are based on what is actually in the files.

**Open `standalone/index.html` in any browser by double-clicking it.** No server, no install and no network are needed. The JavaScript, styles, font and all 17 CSVs are inlined in that one ~10 MB file. The only thing fetched online is the map's basemap tiles. Points and transects draw without them.

## Layout: one section per challenge

The header switch picks **1 · Birds** or **2 · Vegetation**. Each challenge has its own sidebar, which shows only its files, and its own **Summary** page. Every number on a Summary page is computed from the CSVs when the page loads.

- **Birds summary:**
  - Headline counts: predictions, validated clips, species, confidence range, dates.
  - **Species included:** volume, recorders/files, confidence min·median·max, validated correct/wrong, raw share correct with a Wilson CI, and the link to the predictions file.
  - **Validation coverage by confidence band:** correct/validated, next to the number of predictions in each band.
  - A confidence ECDF per species.
  - The two files and how they relate.
- **Birds methodology (Wood & Kahl 2024):** the paper's method, with interactive schematics.
  - A clickable 9-step pipeline (BirdNET → validation → thresholding). Each step shows what the paper says next to where it appears in our data, with a "Show me" link.
  - A logit ↔ confidence explorer with a compression ruler.
  - Approach A, *review down to a threshold*.
  - An Approach B simulator. You set the true score–accuracy curve, the sampling design (random / random + high / per band), the sample size and the target p. It draws validation clips, fits `logit(p) = β₀ + β·score` live, and solves the threshold with a delta-method 95% CI. It also shows the consequences: share of predictions labelled, their true precision, and recall. It reproduces perfect separation and unreachable targets. **The simulator uses synthetic data only.**
  - The fitter (`src/lib/logistic.ts`, IRLS, same maximum-likelihood estimate as R's `glm(binomial)`) was checked on synthetic data: score equations ≈ 1e-15, it recovers the true coefficients, and the threshold CI covers the truth.
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
- **Validation ↔ prediction link.** The link uses the same species, the same audio file, and confidence equal to 3 decimals. Only 263 of 551 validated clips match. The other 288 come from audio files that aren't in `birdnet_predictions.csv`, so the predictions file is a subset of the full BirdNET run. The clip's second filename number is *not* the prediction's `selection` id.
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
  lib/logistic.ts    logistic regression (IRLS), threshold + delta-method CI, seeded RNG
  components/Methodology.tsx  Wood & Kahl page and interactive schematics
  data/dictionary.ts column meanings (ODK form questions + documented formats)
  lib/help.ts        every tooltip and Guide entry (single source)
  components/        Overview, Explore, Table, Map, FilterBar, Plot wrapper, UI atoms
  lib/palette.ts     validated palette and theme tokens
```

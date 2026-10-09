/**
 * Every explanation shown in the explorer lives here — hover/focus tooltips (via `tip(key)`)
 * and the Guide panel read the same entries, so the two can never disagree.
 */

export interface HelpEntry {
  label: string
  text: string
}

export const HELP = {
  // ── header ──
  'app.brand': { label: 'Data Explorer', text: 'An interactive view of every CSV provided for the Natural State take-home (birds and vegetation). It is for looking at the data as-is before modelling or QA/QC — nothing here changes the source files.' },
  'app.author': { label: 'Author', text: 'Built by Carlos Hoyos for the Senior Data Scientist take-home.' },
  'app.theme': { label: 'Theme', text: 'Light, follow your system setting, or dark. Chart colours switch to their dark-mode steps too.' },
  'app.guide': { label: 'Guide', text: 'Opens this guide: what every section, label and control means.' },

  // ── sidebar ──
  'nav.find': { label: 'Find a dataset', text: 'Type to filter the list by dataset title or file name.' },
  'app.challenge': { label: 'Challenge', text: 'Switch between the two parts of the take-home. Each challenge has its own summary page and only shows its own files in the sidebar.' },
  'nav.summary': { label: 'Summary', text: 'Landing page of the challenge: the task, headline numbers and how the files fit together — all computed from the CSVs.' },
  'nav.method': { label: 'Methodology', text: 'Wood & Kahl (2024) — the method the brief requires — plus five related papers (Thompson, Tseng, Schwinger, Navine, Clare), one tab each, with flowcharts and interactive schematics on simulated data, and an overview of how they fit together.' },
  'nav.birdfiles': { label: 'BirdNET files', text: 'The two bird files: every BirdNET prediction kept (score ≥ 0.1), and the clips an ornithologist checked by ear.' },
  'nav.submissions': { label: 'Field submissions (ODK forms)', text: 'What field teams recorded with the ODK app: plot registrations and herbaceous surveys. A form with repeated sections exports one table per repeat (quadrats, additional species), linked by KEY → PARENT_KEY.' },
  'nav.plots': { label: 'Plots & sampling design', text: 'Entity lists describing where to sample: prescribed centroids from the design, and plots as registered in the field.' },
  'nav.taxonomy': { label: 'Taxonomy', text: 'Entity lists of species: the project list, provisional taxa created in the field (unknown / missing species), and the curated identification of those taxa.' },
  'nav.lookups': { label: 'Lookups', text: 'Small reference lists the forms offer as choices (team, surveys, ecosystem types, transport, area, project).' },
  'nav.uploaded': { label: 'Uploaded', text: 'CSV files you opened in this browser session. They are parsed locally and disappear when you reload.' },
  'nav.counts': { label: 'rows × columns', text: 'Number of rows and the number of columns in the original CSV (derived columns not counted). A dot means the dataset has active filters.' },
  'nav.upload': { label: 'Open another CSV', text: 'Explore any other CSV with the same tools. The file is read in your browser only — nothing is uploaded.' },

  // ── dataset header & tabs ──
  'ds.group': { label: 'Group', text: 'Which family of data this table belongs to.' },
  'ds.file': { label: 'Source file', text: 'Path of the CSV inside the repository. Its text is embedded in this page unchanged.' },
  'tab.overview': { label: 'Overview', text: 'A profile of every column: its type, how complete it is, how many distinct values it has and what its values look like.' },
  'tab.explore': { label: 'Explore', text: 'Build charts: distributions, comparisons between groups, relationships between two columns, trends over time.' },
  'tab.table': { label: 'Table', text: 'The raw rows, sortable and searchable, with CSV export of the current slice.' },
  'tab.map': { label: 'Map', text: 'Plots the GPS points of this table (and transect lines for plot registrations). Only shown for tables with coordinates.' },

  // ── filter bar ──
  'filter.count': { label: 'Rows shown', text: 'Rows that pass all active filters, out of all rows in the table. Every tab — profiles, charts, table, map — uses this same slice.' },
  'filter.add': { label: 'Add filter', text: 'Pick a column, then keep a numeric/date range, a set of values, or rows whose text matches. You can also filter by clicking a bar, bin or heatmap cell, or by dragging a box on a scatter plot.' },
  'filter.chip': { label: 'Active filter', text: 'Click to edit, × to remove. Filters on different columns combine with AND. A faded chip refers to a column this table does not have.' },
  'filter.clear': { label: 'Clear all', text: 'Remove every filter on this table.' },
  'filter.range': { label: 'Range', text: 'Keep rows whose value is between min and max (inclusive). Leave a side empty for “no limit”. Dates are entered and shown in UTC.' },
  'filter.values': { label: 'Values', text: 'Keep rows whose value is one of the ticked ones. For multi-select columns a row is kept if any of its tokens is ticked. Counts are within the other active filters.' },
  'filter.text': { label: 'Text', text: 'Keep rows whose text contains / does not contain / equals / matches a regular expression, or is (not) empty. Case-insensitive.' },
  'filter.keepNull': { label: 'Keep empty values', text: 'Also keep rows where this column is empty. Off by default, so a range filter drops empty cells.' },
  'filter.exclude': { label: 'Exclude', text: 'Invert the selection: keep every row except those with the ticked values.' },
  'filter.datarange': { label: 'Data range', text: 'Smallest and largest value of this column within the other active filters.' },

  // ── column types ──
  'type.number': { label: '# number', text: 'Every non-empty value is numeric.' },
  'type.datetime': { label: '◷ date-time', text: 'Every non-empty value is an ISO date or timestamp. Shown in UTC.' },
  'type.category': { label: '◆ category', text: 'Text with few distinct values (labels, codes, names).' },
  'type.boolean': { label: '◐ yes / no', text: 'Only yes/no (or true/false) values.' },
  'type.multi': { label: '☰ multi-select', text: 'ODK multi-select: several choices in one cell, separated by spaces (or | for derived name lists). Counted per choice.' },
  'type.text': { label: 'T text', text: 'Free text or identifiers with many distinct values (uuids, file names, comments).' },

  // ── overview ──
  'kpi.rows': { label: 'Rows', text: 'Rows in the current slice (after filters), and the total when filtered.' },
  'kpi.columns': { label: 'Columns', text: 'Columns in the CSV, plus the derived columns this explorer adds (parsed or joined, never edited).' },
  'kpi.empty': { label: 'Empty cells', text: 'Share of cells in the original columns that are empty, within the current slice. ODK leaves notes and skipped questions empty, so some emptiness is expected.' },
  'kpi.boring': { label: 'Empty or constant columns', text: 'Columns with no values at all, or the same value in every row (form notes, unused fields, fixed settings). Hidden from the cards by default.' },
  'ov.notes': { label: 'Notes', text: 'Facts about this table found while loading it, e.g. how well it joins to another table.' },
  'ov.search': { label: 'Search columns', text: 'Filter the cards by column name.' },
  'ov.sort': { label: 'Card order', text: 'File order: as in the CSV. Most empty: least complete first. Most distinct: highest cardinality first.' },
  'ov.hide': { label: 'Hide empty & constant', text: 'Hide columns that carry no information (no values, or one value everywhere).' },
  'card.type': { label: 'Type badge', text: 'Type detected for this column — see the type list in the Guide.' },
  'card.section': { label: 'Form section', text: 'ODK group the question sits in (the column name is section-path-field). “derived” marks columns computed by the explorer.' },
  'card.values': { label: 'values', text: 'Non-empty cells in the current slice.' },
  'card.empty': { label: 'empty', text: 'Share of rows in the current slice where this column is empty.' },
  'card.distinct': { label: 'distinct', text: 'Number of different values in the whole table.' },
  'card.spark': { label: 'Mini histogram', text: 'Distribution of the values in the current slice, ~24 bins from min to max. Shape only — the numbers below give the scale.' },
  'card.topk': { label: 'Top values', text: 'Most frequent values with their counts (multi-select: most frequent choices). The bar is relative to the most frequent value.' },
  'card.plot': { label: 'Plot', text: 'Open this column in Explore with a sensible default chart.' },
  'card.filter': { label: 'Filter', text: 'Open the filter editor for this column.' },
  'stat.min': { label: 'min', text: 'Smallest value.' },
  'stat.median': { label: 'median', text: 'Middle value: half the rows are below it, half above. Robust to outliers.' },
  'stat.max': { label: 'max', text: 'Largest value.' },
  'stat.mean': { label: 'mean', text: 'Arithmetic average. Pulled by outliers — compare with the median.' },
  'stat.sd': { label: 'sd', text: 'Standard deviation: typical distance of values from the mean.' },
  'stat.iqr': { label: 'IQR', text: 'Interquartile range: from the 25th to the 75th percentile — where the middle half of the values lie.' },
  'stat.span': { label: 'span', text: 'Time between the earliest and latest value.' },

  // ── explore ──
  'ex.presets': { label: 'Quick views', text: 'Ready-made starting points for this table. Each one just fills in the chart settings — change anything afterwards.' },
  'kind.histogram': { label: 'Histogram', text: 'Splits a numeric or date column into equal-width bins and shows how many rows fall in each. Answers “what values are common, rare, skewed?”' },
  'kind.bar': { label: 'Bar', text: 'One bar per category (or per numeric bin / time unit). Height = count, share, or an aggregate of another column.' },
  'kind.line': { label: 'Line', text: 'An aggregate traced along time or a numeric axis — for trends and daily/hourly patterns.' },
  'kind.box': { label: 'Box', text: 'Per group: the box spans the 25th–75th percentiles, the line is the median, the dashed line the mean, whiskers reach 1.5×IQR, dots beyond are outliers.' },
  'kind.violin': { label: 'Violin', text: 'Like a box plot, but the outline shows the full density shape — reveals two peaks a box would hide.' },
  'kind.strip': { label: 'Strip', text: 'Every row as one dot per group, spread sideways (jitter) so dots don’t hide each other. Best when groups are small.' },
  'kind.scatter': { label: 'Scatter', text: 'One dot per row with two numeric columns as x and y. Drag a box to filter to those rows.' },
  'kind.ecdf': { label: 'ECDF', text: 'Empirical cumulative distribution: for each x, the % of rows with a value ≤ x. The cleanest way to compare whole distributions between groups.' },
  'kind.heatmap': { label: 'Heatmap', text: 'A grid of two columns (categories or bins); colour = count or an aggregate. Darker = more.' },
  'ctl.x': { label: 'X', text: 'Column on the horizontal axis. Only columns that suit the chart type are listed (# number, ◷ date, ◆ category …).' },
  'ctl.group': { label: 'Group (x)', text: 'Category to split the distribution by — one box/violin/strip per value. Leave empty for all rows together.' },
  'ctl.xscale': { label: 'X scale', text: 'Linear: raw values. log₁₀: spreads out values spanning orders of magnitude (positive only). logit: ln(p/(1−p)) for scores between 0 and 1 — stretches both ends, as in Wood & Kahl (2024).' },
  'ctl.y': { label: 'Y', text: 'Column on the vertical axis.' },
  'ctl.value': { label: 'Value', text: 'Numeric column the aggregate (mean, median …) is computed on, per bar / point / cell.' },
  'ctl.yscale': { label: 'Y scale', text: 'Transform applied to Y before plotting: linear, log₁₀ or logit.' },
  'ctl.agg': { label: 'Aggregate', text: 'Count: rows per bar. Share %: each colour group’s % of the rows in that bar (bars sum to 100 when stacked). Mean / median / sum / min / max: of the Value column. Mean shows a 95% interval (Wilson when the value is 0/1).' },
  'ctl.cell': { label: 'Cell value', text: 'What each heatmap cell shows: count of rows, or an aggregate of a numeric column.' },
  'ctl.color': { label: 'Color by', text: 'Split into coloured series by a category. The 8 most frequent values get their own colour; the rest fold into grey “Other”; missing values get their own grey “(empty)”. A value keeps its colour whatever you filter.' },
  'ctl.facet': { label: 'Small multiples by', text: 'Draw one small panel per value of a category (up to 12), on the same axes, so groups can be compared side by side without overlap.' },
  'ctl.sharedY': { label: 'Same y-axis', text: 'On: every panel uses the same y range (honest comparison of heights). Off: each panel zooms to its own data (see shape in small groups).' },
  'ctl.bins': { label: 'Bins', text: 'Target number of bins. Edges are rounded to readable numbers, so the actual count can differ slightly.' },
  'ctl.timeunit': { label: 'Time unit', text: 'Bucket size for date columns. Coarsened automatically if there would be more than ~1,500 buckets.' },
  'ctl.norm': { label: 'Normalize', text: 'Count: rows per bin. % of group: each group sums to 100%, so groups of very different size can be compared. Density: % per unit of x (area sums to 1).' },
  'ctl.barmode': { label: 'Groups', text: 'How coloured series share a bar position: overlay (semi-transparent on top of each other), stack (piled up — totals visible), side by side.' },
  'ctl.topn': { label: 'Max categories', text: 'Show at most this many categories (most frequent first); the rest are combined into one “Other (n)” bar.' },
  'ctl.order': { label: 'Order', text: 'By count: largest first. A → Z: alphabetical / natural order (numbers in numeric order).' },
  'ctl.horizontal': { label: 'Horizontal bars', text: 'Turn bars sideways — easier to read long category names.' },
  'ctl.logy': { label: 'Log y-axis', text: 'Logarithmic vertical axis: makes small and large counts visible together. Zero values are not drawn.' },
  'ctl.trend': { label: 'Binned mean of Y', text: 'Splits x into bins and plots the mean of y in each, with a 95% interval. When y is a 0/1 outcome this is the observed precision per confidence bin; the interval is a Wilson interval, which stays sensible at 0% or 100% and widens when a bin has few clips.' },
  'ctl.trendByGroup': { label: 'One binned mean per color group', text: 'Compute the binned mean separately for each colour series instead of over all points in the panel. Don’t use it when colour is the outcome itself.' },
  'ctl.jitterx': { label: 'Jitter X', text: 'Random sideways nudge, as a % of the x range, so overlapping points become visible. Display only — values and filters use the true numbers.' },
  'ctl.jittery': { label: 'Jitter Y', text: 'Random vertical nudge, as a % of the y range. Useful for 0/1 outcomes, where every point would otherwise sit on two lines.' },
  'ctl.opacity': { label: 'Point opacity', text: 'Lower values let dense clusters show as darker areas.' },
  'ctl.reset': { label: 'Reset chart settings', text: 'Back to defaults for the current chart type.' },
  'ex.hint': { label: 'Interaction', text: 'Hover any mark for exact values. Click a bar/bin/cell to filter to it. Click a legend item to hide it, double-click to show only it. Use the toolbar at the top right of the chart to zoom, pan, reset axes or download a PNG.' },
  'ex.twin': { label: 'Data behind this chart', text: 'The exact numbers that were plotted (counts, means, intervals, quartiles …). Use it to quote values or check the chart; CSV downloads it.' },
  'ex.other': { label: '“Other” and “(empty)”', text: 'Other (n) combines categories beyond the colour/category limit. (empty) collects rows where the column has no value — kept visible on purpose, because missing data matters for QA.' },

  // ── table ──
  'tb.search': { label: 'Search', text: 'Keep rows where any visible column contains this text (on top of the filters).' },
  'tb.hide': { label: 'Hide empty & constant columns', text: 'Hide columns with no values or a single value everywhere.' },
  'tb.derived': { label: 'Show derived columns', text: 'Show the columns computed by the explorer (marked in teal). Exports always include them, prefixed with derived:.' },
  'tb.csv': { label: 'CSV', text: 'Download the current slice (filters + search, all columns) as CSV. Date-times are written as ISO UTC.' },
  'tb.header': { label: 'Column header', text: 'Click to sort ascending, again for descending, a third time to clear. Hover a header to see what the column means.' },
  'tb.rownum': { label: '#', text: 'Row position in the current sorted view (not an id from the data).' },
  'tb.null': { label: '—', text: 'Empty cell.' },

  // ── map ──
  'map.layers': { label: 'Layers', text: 'Switch each set of GPS points on or off. Each ODK geopoint question becomes a layer.' },
  'map.color': { label: 'Color by', text: 'Colour points by a category instead of by layer.' },
  'map.basemap': { label: 'Basemap', text: 'Background map: light, dark, satellite imagery (Esri), streets (OpenStreetMap) or none. Tiles need internet; points draw without it.' },
  'map.points': { label: 'Points', text: 'Number of GPS points drawn from the filtered rows.' },
  'map.how': { label: 'Map interaction', text: 'Scroll to zoom, drag to pan. Hover a point for the plot name, coordinates and GPS accuracy. Click legend items to hide layers.' },

  // ── summaries ──
  'sum.b.preds': { label: 'BirdNET predictions', text: 'Rows in birdnet_predictions.csv: each is a 3-second segment where BirdNET scored a species ≥ 0.1.' },
  'sum.b.vals': { label: 'Validated clips', text: 'Clips an ornithologist listened to and marked correct (1) or wrong (0). They are the evidence used to fit each species’ threshold.' },
  'sum.b.species': { label: 'Species', text: 'Distinct species across both files.' },
  'sum.b.conf': { label: 'Confidence range', text: 'Smallest and largest BirdNET confidence in the predictions (the export kept scores ≥ 0.1), the median, and the range among validated clips.' },
  'sum.b.dates': { label: 'Recording dates', text: 'First and last recording day, parsed from the audio file names (recorder clock).' },
  'sum.b.speciesTable': { label: 'Species included', text: 'One row per species: prediction volume, where it was detected, its confidence distribution, and the validated sample. “Correct in sample” is a raw proportion, not the 99% threshold — that comes from the fitted curve.' },
  'sum.b.coverage': { label: 'Validation coverage', text: 'How the validated clips are spread over confidence bands, and how many were correct. The threshold can only be trusted where there are enough validated clips; the prediction counts show how many clips each band would label.' },
  'sum.b.ecdf': { label: 'Confidence ECDF', text: 'For each species, the share of its predictions at or below each confidence score. Hover to read exact percentages.' },
  'sum.b.files': { label: 'The two files', text: 'What one row means in each bird file, and the facts that matter when combining them.' },
  'sum.v.surveys': { label: 'Herbaceous surveys', text: 'Submissions of the herbaceous survey form (one plot visit each), the number of distinct plots surveyed, and how many submissions were rejected in ODK Central review.' },
  'sum.v.quadrats': { label: 'Quadrats', text: 'Quadrat rows (the SOP asks for 20 per survey) and the number of species-from-the-list records across them.' },
  'sum.v.extra': { label: 'Additional species records', text: 'Species recorded outside the project list, and how many provisional taxon slots are in use.' },
  'sum.v.plots': { label: 'Plots registered', text: 'Plot registration submissions, compared with the prescribed primary and backup centroids of the sampling design.' },
  'sum.v.dates': { label: 'Field dates', text: 'First and last form start time across registrations and surveys (UTC), and the number of devices used.' },
  'sum.v.files': { label: 'Files', text: 'Every vegetation table, what one row represents, and its size.' },
  'sum.v.joins': { label: 'How the tables join', text: 'Every key linking a table to another, and the share of references that resolve. These are the joins the QA/QC pipeline relies on.' },

  // ── concepts ──
  'c.derived': { label: 'Derived column', text: 'Added by the explorer by parsing a value (e.g. recorder and date from a file name) or copying a parent attribute down to a child table (e.g. plot name onto each quadrat). Never edits a source value. Marked with dashed cards, a derived group in pickers and a derived: prefix in exports.' },
  'c.utc': { label: 'UTC', text: 'Timestamps are shown in UTC so nothing shifts with the viewer’s timezone. ODK times carry the device offset (+02:00 here).' },
  'c.recorderclock': { label: 'Recorder clock', text: 'Times parsed from audio file names, as set on the recorder. Shown without timezone conversion.' },
  'c.logit': { label: 'logit', text: 'ln(c / (1 − c)). Maps 0–1 scores to the whole number line: 0.5 → 0, 0.9 → 2.2, 0.99 → 4.6. Wood & Kahl fit precision against logit(confidence). Scores of 0 or 1 are clamped to 0.0001 / 0.9999.' },
  'c.wilson': { label: 'Wilson interval', text: 'A 95% confidence interval for a proportion that behaves well with small samples and at 0% or 100% (unlike ±1.96·SE).' },
  'c.keys': { label: 'KEY / PARENT_KEY', text: 'ODK’s join keys. A quadrat’s PARENT_KEY is its survey’s KEY; an additional-species row’s PARENT_KEY is its quadrat’s KEY.' },
} satisfies Record<string, HelpEntry>

export type HelpKey = keyof typeof HELP

/** Spread onto any element: `<span {...tip('kpi.rows')}>Rows</span>` → hover/focus tooltip. */
export function tip(key: HelpKey, focusable = false): Record<string, string | number> {
  const e = HELP[key]
  return { 'data-tip': e.text, 'data-tip-title': e.label, ...(focusable ? { tabIndex: 0 } : {}) }
}

/** Free-text tooltip (e.g. a column's dictionary entry). */
export function tipText(text: string | undefined, title?: string): Record<string, string> {
  return text ? { 'data-tip': text, ...(title ? { 'data-tip-title': title } : {}) } : {}
}

export const GUIDE: { title: string; intro: string; keys: HelpKey[] }[] = [
  { title: 'Header & navigation', intro: 'The top bar and the dataset list on the left.', keys: ['app.brand', 'app.challenge', 'app.author', 'app.theme', 'app.guide', 'nav.find', 'nav.summary', 'nav.method', 'nav.birdfiles', 'nav.submissions', 'nav.plots', 'nav.taxonomy', 'nav.lookups', 'nav.uploaded', 'nav.counts', 'nav.upload'] },
  { title: 'Challenge summaries', intro: 'Landing page of each challenge. Every number is computed from the CSVs.', keys: ['sum.b.preds', 'sum.b.vals', 'sum.b.species', 'sum.b.conf', 'sum.b.dates', 'sum.b.speciesTable', 'sum.b.coverage', 'sum.b.ecdf', 'sum.b.files', 'sum.v.surveys', 'sum.v.quadrats', 'sum.v.extra', 'sum.v.plots', 'sum.v.dates', 'sum.v.files', 'sum.v.joins'] },
  { title: 'Dataset header & tabs', intro: 'What you see at the top of every table.', keys: ['ds.group', 'ds.file', 'tab.overview', 'tab.explore', 'tab.table', 'tab.map'] },
  { title: 'Filters', intro: 'One filter bar scopes every tab of the current table.', keys: ['filter.count', 'filter.add', 'filter.chip', 'filter.clear', 'filter.range', 'filter.values', 'filter.text', 'filter.keepNull', 'filter.exclude', 'filter.datarange'] },
  { title: 'Column types', intro: 'Detected automatically; a column is numeric or date only if every non-empty value parses.', keys: ['type.number', 'type.datetime', 'type.category', 'type.boolean', 'type.multi', 'type.text'] },
  { title: 'Overview tab', intro: 'Profiles every column of the current slice.', keys: ['kpi.rows', 'kpi.columns', 'kpi.empty', 'kpi.boring', 'ov.notes', 'ov.search', 'ov.sort', 'ov.hide', 'card.type', 'card.section', 'card.values', 'card.empty', 'card.distinct', 'card.spark', 'card.topk', 'card.plot', 'card.filter', 'stat.min', 'stat.median', 'stat.max', 'stat.mean', 'stat.sd', 'stat.iqr', 'stat.span'] },
  { title: 'Explore tab — chart types', intro: 'Pick the chart by the question you are asking.', keys: ['ex.presets', 'kind.histogram', 'kind.bar', 'kind.line', 'kind.box', 'kind.violin', 'kind.strip', 'kind.scatter', 'kind.ecdf', 'kind.heatmap'] },
  { title: 'Explore tab — settings', intro: 'Only the settings that apply to the current chart type are shown.', keys: ['ctl.x', 'ctl.group', 'ctl.xscale', 'ctl.y', 'ctl.value', 'ctl.yscale', 'ctl.agg', 'ctl.cell', 'ctl.color', 'ctl.facet', 'ctl.sharedY', 'ctl.bins', 'ctl.timeunit', 'ctl.norm', 'ctl.barmode', 'ctl.topn', 'ctl.order', 'ctl.horizontal', 'ctl.logy', 'ctl.trend', 'ctl.trendByGroup', 'ctl.jitterx', 'ctl.jittery', 'ctl.opacity', 'ctl.reset', 'ex.hint', 'ex.twin', 'ex.other'] },
  { title: 'Table tab', intro: 'The rows themselves.', keys: ['tb.search', 'tb.hide', 'tb.derived', 'tb.csv', 'tb.header', 'tb.rownum', 'tb.null'] },
  { title: 'Map tab', intro: 'For tables with GPS coordinates.', keys: ['map.layers', 'map.color', 'map.basemap', 'map.points', 'map.how'] },
  { title: 'Concepts', intro: 'Terms used across the explorer.', keys: ['c.derived', 'c.utc', 'c.recorderclock', 'c.logit', 'c.wilson', 'c.keys'] },
]

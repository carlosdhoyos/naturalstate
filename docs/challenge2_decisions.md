# Challenge 2: QA/QC decisions

This log records the decisions behind the vegetation QA/QC. Each entry gives what we observed, what we decided, and how the decision changes the results. **No source value is ever changed.** Every decision acts on how values are interpreted, joined or flagged.

The pipeline is `challenge2/src/run_challenge2.py`. The rules and thresholds are in `challenge2/rules/rules.yaml`, and the outputs are in `challenge2/outputs/`. Run `qa-798e59b8855cb9d1` produced the numbers below; the run id changes whenever an input, the catalogue or the code changes.

- **V-01 to V-11** are decisions.
- **"Differences from the exploration"** lists where the pipeline deliberately disagrees with the earlier exploratory review.
- **N1 to N13** are findings the systematic sweeps and the independent review added.
- **"Independent review"** records what the review found and what changed.
- **C-1 to C-11** are confirmation items for Natural State.

---

## V-01. One canonical survey per plot

**Observed.** Plots 18 and 21 were each surveyed twice on 26 May: in the morning on device-01, and in the afternoon on device-02. Natural State marked the two device-02 submissions `rejected` in ODK Central.

**Decision.** For each plot and replicate, the canonical survey is the first one in this order:

1. not rejected;
2. then the latest end time.

Non-canonical submissions stay in every table with `canonical = False`. They are checked like any other submission, but they never count towards richness or effort. The two pairs are reused to measure repeatability (G04, effort section).

**Consequence.** 30 canonical surveys out of 32 submissions. The choice and its reason for every submission are in `outputs/canonical_choice.csv`. Rule B02 flags both plots, so the choice is visible, not silent.

## V-02. Two taxonomy layers: raw and resolved

**Observed.** Field teams record new taxa as provisional slots in `species_extra` (`herb_001`, `herb_002`, …), either as unknowns or as typed names of species missing from the list. On 5 June Natural State curated these slots in `species_extra_ids`, giving names and, in free-text notes, "duplicate of herb_011" or "should be excluded".

**Decision.** Every occurrence carries both layers:

- **Raw:** the taxon as recorded, that is, the list species or the provisional slot.
- **Resolved:** the slot followed through NS's curation. Merge chains are followed, exclusions are applied, and the curated name is used. Unresolved unknowns remain separate taxa.

Resolution applies only Natural State's own reference table. It **never corrects a spelling**: "Crotolaria sphaerocarpa" stays as written and is flagged (F03, F13).

**Consequence.** Raw richness is 132 taxa; resolved richness is 115 (92 identified plus 23 unresolved unknowns). Both are reported everywhere (`effort_richness_sensitivity.csv`).

## V-03. Woody taxa are excluded only in the resolved herbaceous layer

**Observed.** Curation marks two slots as woody "below 40 cm, should be excluded": herb_100 (a duplicate of wood_005) and herb_071 (Rhus tenuinervis).

**Decision.** These occurrences stay in the raw layer and are flagged as an error (F06), because they inflate herbaceous richness. The resolved layer has status `excluded` and does not count them.

**Consequence.** 4 occurrences, 3 of them in canonical surveys.

## V-04. GPS-aware geometry tests

**Observed.** Every GPS point reports an accuracy of 1.5–5 m. The SOP's geometry is finer than that: a 5 m belt, with the quadrat frame 1.5–2.5 m from the tape. Testing positions at face value would flag most quadrats for GPS noise alone.

**Decision.** A measured distance is compared with its design value relative to the combined reported accuracy:

> z = |measured − design| / √(Σ accuracy²)

- z > 2 is a warning.
- z > 3 is an error, or the rule's own severity for single-quadrat rules.

The reported accuracy is used as one standard deviation. That is conservative: ODK reports a ~68% radius, which overstates the per-axis error, so fewer plots are flagged. The midpoint offset (D01) is an error only beyond 25 m + 2 × the midpoint accuracy. Whole-transect offsets (E03) use the trimmed mean of the signed lateral offsets, because GPS errors within one survey are correlated and averaging does not remove them. An offset wider than the belt but within GPS error is reported as **info**, and a walked line rotated more than 30° from the registered one is a **warning**.

**Consequence.** Plot 29's 61.8 m transect is within GPS error, so it passes (see Differences). Plots 13, 07 and 01, offset 9–10 m, are kept as info, or as a warning when rotated (Plot 13 at 34°). They are not called errors.

## V-05. Severity, metric impact and three result statuses

**Decision.** Every rule declares a severity:

- **error:** violates a documented requirement or prevents reliable interpretation;
- **warning:** plausible, but needs review;
- **info:** context.

Every rule also declares whether it can change richness or diversity (`metric_impact`: yes / indirect / no) and its source. The source is an SOP step, a form row, an entity list, or "judgement" when the threshold is ours.

Every evaluated entity gets a row with status `fail`, `pass` or `could_not_check`, so "not checked" is never reported as "fine". A value the form could not have produced, such as one that breaks a constraint or differs from the entity value a calculation copies, is an **error with "investigate"**. It points to an edit after collection or to an export problem.

A single result may carry a different severity from its rule's default, always with the reason in its message. The cases are:

- GPS z-score tiers (V-04);
- duplicate entity writes that hold identical values (F09: info);
- the aggregate range row (F10: warning, while each taxon row is info).

The one exception to "could not have come from the app" is C14's letter-case difference (`lw_baseline` stored against `LW_baseline` computed by the form file). It is consistent across all 32 submissions, so it is far more likely a difference between the deployed form and the form file than 32 edits. It is reported as info. The report's appendix splits every rule's failures by the severity actually given.

## V-06. Quadrats without herbs count as samples

**Decision.** The 7 quadrats with `herbs_present = no` are valid observations of zero. They stay in the denominator for frequency and effort, and are flagged as info (G02) so a reviewer can see them.

## V-07. Time-zone label

**Observed.** All 63 timestamps carry `+02:00`. Lewa is on East Africa Time, `+03:00`.

**Decision.** The instants are correct: uploads never precede form ends, and all photos fall inside their survey windows. All arithmetic uses UTC. Local calendar days are UTC + 3 h. The label itself is flagged as info (B12), because a wall-clock time read off the stamp is 1 h behind.

## V-08. GBIF as a cached reference, so the run stays offline

**Observed.** The project species list cannot confirm several correct genera (Crotalaria, Brachiaria, Oldenlandia are not on it), so a list-only spelling check misses those misspellings.

**Decision.** `python -m vegqa.gbif` fetches, once, for every taxon name in the data:

- the GBIF backbone match (EXACT / FUZZY / HIGHERRANK);
- the occurrence counts in Kenya and, as a contrast, in Botswana, Namibia, South Africa and Zimbabwe.

The results are stored in `challenge2/reference/gbif_cache.json` (99 names, retrieved 2026-10-10). The QA run reads only this file. A name missing from it is `could_not_check`. A GBIF exact match outranks similarity to another list name, because two valid species of one genus are often similar (Eragrostis pilosa / E. viscosa).

Having no GBIF record in the country is weak evidence for a single taxon, because GBIF is incomplete, so each taxon row is info. The aggregate is a warning when a fifth of the list shows it. Native-range data (POWO/WCVP) would be the stronger reference.

Terrain elevation is handled the same way. `python -m vegqa.dem` caches SRTM 90 m elevations (OpenTopoData) for every recorded point in `challenge2/reference/elevation_cache.json` (770 points). Rule E14 compares GPS altitudes with it.

## V-09. Relative thresholds where the SOP gives none

**Decision.**

- **Durations:** short is below 0.5 × the median, a warning; long is above 2.5 × the median, info. Medians are taken separately for surveys and registrations.
- **Overnight forms:** a form open across two local days is a warning.
- **Upload delay:** watch at 8 h (info), late at 24 h (warning).

Every threshold of ours is labelled `judgement` in the catalogue and can be changed in `rules.yaml` without code.

## V-10. Effort statistics: coverage first, bias-corrected Chao2 with intervals, Hill numbers

**Observed.** With only 20 quadrats, richness estimators are uncertain when few taxa occupy exactly two quadrats. The first version used the classic Chao2 whenever Q2 ≥ 1, which gave Plot 10 (Q1 = 11, Q2 = 1) an estimate of 78.5 against 21 observed.

**Decision.**

- The report leads with **sample coverage** (Chao & Jost 2012), which is stable at these sample sizes.
- Chao2 is the **bias-corrected** form (Chao 2005; always defined), with the log-normal 95% interval (Chao 1987). Plot 10 is now 47 (27–129).
- The expected number of new taxa in one more quadrat is the extrapolation of Chao et al. (2014), not the slope of the rarefaction curve.
- Diversity is given as observed incidence-based Hill numbers (q = 0, 1, 2) from quadrat frequencies.
- No interval is given for coverage: a naive bootstrap over quadrats is biased upwards (Plot 10's interval did not contain its estimate). A valid one needs iNEXT's assemblage bootstrap.
- Project-level estimates use plots as the sampling units.

## V-11. The walking order is not assumed

**Observed.** All 32 surveys walk out-and-back (A→B on one side, B→A on the other), not the SOP's pairs at each 5 m mark (E13).

**Decision.** No position rule relies on the quadrat order. Positions are tested against the registered segment and against the survey's own robust line. Walking order is reported once, as a project-level procedural note.

---

## Differences from the exploration

The exploration's numbers were approximate. The pipeline re-derives them, and the acceptance tests pin both the agreements and these differences.

| Exploration | Pipeline | Why |
|---|---|---|
| Plot 05 midpoint "20–24 m" (R2) | 19.98 m: pass, listed among the near-limit offsets | Rounding; the watch line is > 20 m |
| Plot 29 transect 61.8 m (R3) | Pass | 11.8 m from 50 m is within GPS error (z = 1.9) (V-04) |
| Whole-transect offsets: Plots 13, 07, 01 at 10–12 m (Q2) | Info; Plot 13 a warning for its 34° rotation | Within GPS error of the registered line (V-04) |
| Plot 19/27 altitude runs (Q4) | Found by a step test (> 15 m between consecutive quadrats) | A run of glitches shifts the median, so a robust z misses it |
| centroids `survey_year` missing for 13 (R6) | 19 | The exploration counted only part of the list |
| 28 'Unknown' rows, 342 records (T7) | 23 unresolved taxa, 316 records in canonical surveys | Counted after merges, in the canonical surveys only |
| Grace recorder 26/32 (S8) | 25/30 canonical | Canonical surveys only |
| Canavalia rosea "coastal" (T10) | Not flagged | GBIF has Kenyan records; a coastal-vs-inland test needs habitat data |
| Background geopoint 12–44 m (S9) | Reported as distances; pass (≤ 50 m) | Missing points are `could_not_check` |
| Slot collision "between different plants" (S3; also this report's first version) | The repeats reused herb_100–102 for the same plants in the same plots | Checked plant by plant (F09); it is a process risk that did not change any record |

## New findings from the systematic sweeps

| Id | Finding | Rule |
|---|---|---|
| N1 | device-03 (Plot 11) also worked from the stale species list | B10 |
| N2 | The **shrubland stratum** (Plots 31–36 and backups 47–51) is entirely unsampled: 0 of 6 primary points | J01 |
| N3 | Plot 16's registration form was open for 17 h, from 26 May 17:35 to 27 May 10:36 EAT | B05 |
| N4 | More curation misspellings: Duosperma "cretanum" (crenatum), Leucas "tettenesis" (tettensis), "Polygalaerioptera" (Polygala erioptera). Melosperma bracteatum (41 canonical records) does not exist at species level in GBIF | F03, F13 |
| N5 | Every survey stores replicate `lw_baseline`, but the form as written computes `LW_baseline`. The centroid list uses `baseline` | C14, X01 |
| N6 | The non-viable Plot 23 was confirmed 157 m from its prescribed point, consistent with "on private property" | E12 |
| N7 | Form design: macro photos at max-pixels 4097–4100 (copy-paste drift); quadrat GPS warning at 10 m against 5 m elsewhere; the registration plot list has no filter, so a plot can be registered twice | K01, K04 |
| N8 | The curation table's label disagrees with its number for herb_039 (labelled herb_011) and herb_072 (labelled herb_036) | F13 |
| N9 | 20 of 90 identified taxa have no GBIF record in Kenya but hundreds in southern Africa. The species list (Acacia galpinii, Pechuel-loeschea) and the transport options ("Mokoro", an Okavango dugout) suggest the list was built for a southern-African project | F10 |
| N10 | **Three registrations edited after collection.** Plots 01, 04 and 15 store a geohash equal to the geohash-7 of their measured midpoint, not the centroid geohash the form copies; the edited value also reached `vegplots` | C17 |
| N11 | Every GPS altitude is about 705 m below the SRTM terrain at its position (range −785 to −631 m), consistent with data from a site near 1,000 m | E14 |
| N12 | The 51 prescribed points are 9–104 m (median 66 m) from the centres of their geohash cells, although the SOP defines the midpoint as the cell centre | J04 |
| N13 | 29 of 30 savanna plots are recorded as "Scrub"; the ecosystem list has no savanna option | D08 |

## Confirmation items for Natural State

| Id | Question | Why it matters |
|---|---|---|
| C-1 | Is ReviewState authoritative for the canonical survey? Should the rejected submissions' entity writes (herb_100–102) be reverted? | V-01, F09, K03 |
| C-2 | What is the backup-selection rule? Plot 46 replaced Plot 23, but Plot 42 was nearer (2.1 km against 3.8 km). | D09 |
| C-3 | Are the east–west transects (30 of 30) and the out-and-back walking order accepted local practice? | D05, E13 |
| C-4 | What positional tolerance does NS use for endpoints and quadrats, given ±5 m GPS? | V-04 |
| C-5 | Is `species_extra_ids` the authoritative resolution table? Can merges and exclusions move to structured columns? | V-02, F13 |
| C-6 | Is the shrubland stratum (Plots 31–36) still planned for this replicate? | J01, N2 |
| C-7 | Where were the data collected, and is the species list (including its life-form groups) the right one for Lewa? | F10, E14, N9, N11 |
| C-8 | Can the device time zone be set to Africa/Nairobi? | B12 |
| C-9 | Should Plot 04 ("Forest" in a savanna stratum) stay in the savanna sample? | D08 |
| C-10 | Which ecosystem types are compatible with each stratum? | D08, N13 |
| C-11 | Which defines a plot: the prescribed coordinates or the geohash-cell centre? | J04, N12 |

---

## Independent review

An independent reviewer, given no context, re-ran the pipeline and the tests, explored the raw data, and mutation-tested the rules on a copy of the data. Its confirmed findings and what changed:

| Finding | Change |
|---|---|
| Registration geohash edited in 3 plots; no rule checked form lookups | New rule C17 recomputes every simple entity-lookup calculation of both forms from the parsed XLSForm (N10) |
| The slot-collision narrative overstated the effect | Rewritten as a process risk; F09 now says whether duplicate writes are identical; B10's metric impact lowered to "indirect" |
| Times labelled EAT were read off the +02:00 stamps | Corrected (+1 h) |
| Resolved richness includes a certain duplicate (Polygalaerioptera) | A sensitivity row collapses names GBIF matches to one species (114) |
| The stratum mapping hides that savanna plots are all "Scrub" | A D08 project row discloses it; C-10 |
| Classic Chao2; slope reported as an extrapolation; no intervals | Bias-corrected Chao2 with a log-normal CI; Chao et al. 2014 extrapolation; Hill numbers (V-10) |
| Repeatability overreached (Plot 18 has the same recorder; effort confounded) | Caveats added; recorders shown |
| The handover overclaimed: "every expression re-evaluated", "declarative" logic | Wording corrected; deployment model stated |
| Tests pinned this dataset only | `tests/test_mutations.py`: 34 rules must fire on an injected error |
| Hard-coded paths, 20 quadrats, country | Input folders are arguments; quadrats and countries read from `rules.yaml` |
| Suggestions taken up | The altitude/terrain check (E14), geohash-centre check (J04), shared app user, life-form caveat |
| Suggestion not taken up | SOP version history naming another project: not found in the SOP text |

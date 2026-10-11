# Challenge 2: QA/QC decisions

This log records the decisions behind the vegetation QA/QC. Each entry gives what we observed, what we decided, and how the decision changes the results. **No source value is ever changed.** Every decision acts on how values are interpreted, joined or flagged.

The pipeline is `challenge2/src/run_challenge2.py`. The rules and thresholds are in `challenge2/rules/rules.yaml`, and the outputs are in `challenge2/outputs/`. Run `qa-f5bc7da8f18dcce8` produced the numbers below; the run id changes whenever an input, the catalogue or the code changes.

- **V-01 to V-13** are decisions.
- **"Differences from the exploration"** lists where the pipeline deliberately disagrees with the earlier exploratory review.
- **N1 to N13** are findings the systematic sweeps and the independent review added.
- **"Independent review"** records what the review found and what changed.
- **C-1 to C-12** are confirmation items for Natural State.

---

## V-01. One canonical survey per plot

**Observed.** Plots 18 and 21 were each surveyed twice on 26 May: in the morning on device-01, and in the afternoon on device-02. Natural State marked the two device-02 submissions `rejected` in ODK Central.

**Decision.** For each plot and replicate there is **at most one** canonical survey: among submissions whose ODK review state is not excluded, the latest by end time. Excluded states are `rejected` and `hasIssues`, configurable in `rules.yaml` as `canonical_excluded_review_states`. An excluded submission never counts towards richness or effort; this matches what B01 tells the reviewer. A plot whose submissions are all excluded has **no** canonical survey, and J03 reports it as "viable plot without an accepted survey". (The first version always chose one submission per plot, so a rejected-only plot would have counted. The third review caught it.)

Non-canonical submissions stay in every table with `canonical = False` and the reason. They are checked like any other submission, but they never count towards richness or effort. The two pairs are reused to measure repeatability (G04, effort section).

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

**What the z values are (fourth review).** They are screening scores, not calibrated significance tests. ODK's accuracy is Android's ~68% horizontal radius, and how two points' errors combine depends on assumptions about their direction and correlation. The 5 m limit (D06, E01) comes from the Herbaceous SOP's instruction to set devices to "5 m or better". The form's `capture-accuracy=5` only triggers automatic capture and enforces nothing, so a point worse than 5 m is a warning, not an error. A missing coordinate or accuracy gives "could not check" in every geometry rule that needs it, never a silent omission or a pass.

## V-05. Severity, metric impact and three result statuses

**Decision.** Every rule declares a severity:

- **error:** violates a documented requirement or prevents reliable interpretation;
- **warning:** plausible, but needs review;
- **info:** context.

Every rule also declares whether it can change richness or diversity (`metric_impact`: yes / indirect / no) and its source. The source is an SOP step, a form row, an entity list, or "judgement" when the threshold is ours.

Every evaluated entity gets a row with status `fail`, `pass` or `could_not_check`, so "not checked" is never reported as "fine". A value the form could not have produced, such as one that breaks a constraint or differs from the entity value a calculation copies, is an **error with "investigate"**. It points to an edit after collection or to an export problem.

A single result may carry a different severity from its rule's default, always with the reason in its message. Examples:

- GPS z-score tiers (V-04);
- duplicate entity writes that hold identical values (F09: info);
- the aggregate range row (F10: warning, while each taxon row is info).

There are two exceptions to "could not have come from the app", both reported as info:

- **C14:** the letter-case difference (`lw_baseline` stored against `LW_baseline` computed by the form file).
- **C17:** the geohash, which every registration takes from its measured midpoint instead of the centroid.

Both patterns hold for every submission, and ODK Central's `Edits` field is 0 everywhere. So they are differences between the deployed form and the form file, not edits (C-12). A rule that finds a mismatch in only some records, with no such pattern, still reports an error. The report's appendix splits every rule's failures by the severity actually given.

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

**Query definition (fourth review).** Country counts use `occurrenceStatus=PRESENT`, since GBIF also stores absence records. Re-fetching all 99 names with that filter changed no Kenya count. Every entry now records its retrieval date and query version. `python -m vegqa.gbif --max-age-days N` re-fetches stale entries; entries fetched under an older query are always re-fetched. "No Kenyan record" means no presence record found by this query, not absence.

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

**Limits (fourth review).** When no unseen taxa are estimated (Q1 ≤ 1 with Q2 = 0), the point estimate equals S_obs, but **no upper bound** is reported: a 10–10 interval would wrongly imply certainty that nothing was missed. The estimators are checked by closed-form unit tests on hard cases (no duplicates, no uniques, all uniques, Q2 = 0). They have **not** been validated against iNEXT, because R is not installed in this environment; that comparison remains a recommended step.

## V-11. The walking order is not assumed

**Observed.** All 32 surveys walk out-and-back (A→B on one side, B→A on the other), not the SOP's pairs at each 5 m mark (E13).

**Decision.** No position rule relies on the quadrat order. Positions are tested against the registered segment and against the survey's own robust line. Walking order is reported once, as a project-level procedural note.

## V-12. The workflow never assumes what a rule checks

**Observed (third review).** Several steps assumed invariants that rules exist to check:

- a duplicated survey or registration key crashed the run before A02 could report it;
- a survey with no quadrats divided by zero;
- a survey with no taxa reported 100% coverage and infinite diversity;
- A04 truncated 1.5 to 1 and passed it;
- plot summaries and repeatability merged replicates.

**Decision.**

- Every lookup by key keeps the first row of a duplicated key (`load.by_key`); the tables themselves keep every row, and A02 reports the duplicate.
- A survey with no quadrats or no taxa gets an explicit effort row: richness 0 where it was observed, ratios undefined (not 0%, 100% or infinity), and a `note`.
- A04 requires whole numbers before comparing the sequence.
- Plot summaries have one row per plot **and replicate**, and repeat visits are only paired within a replicate.
- `tests/test_robustness.py` runs the **whole** workflow (rules, marts, effort, figures, dashboard export) on each of these inputs and checks that the right rule reports it.

**Analytical eligibility (fourth review).** Surviving bad input is not enough; it must not produce valid-looking summaries.

- **Duplicated survey KEY:** no copy is canonical, so that plot's metrics are suppressed and J03 reports it.
- **Sampling units:** effort counts distinct quadrat KEYs, so a duplicated row is not a 21st quadrat.
- **Provisional metrics:** a survey with structural or record failures (A01–A04, C02, C04, C08, C13) carries `metrics_status = provisional: <rules>`. Here 8 plots are provisional: 7 for C04 and Plot 28 for C08. C08 took effect only after the bug check, which gave additional-species results their survey key.
- **Empty incidence table:** it is told apart as a valid ecological zero (every quadrat recorded no herbs), missing species records, or records that are not analytical taxa (excluded or unresolvable). The last two are marked "suppressed".
- **Replicates:** project richness and planned-vs-done are computed per replicate, so monitoring rounds are never pooled and a missing later visit is never hidden by an earlier one.

**Where the qualification is read (fifth review).**

- **Precedence:** suppressed takes precedence over provisional.
- **Project row:** it inherits the status of its plots: provisional when any plot is provisional or suppressed. Its `*_ok_plots` columns repeat the estimate on the ok plots only.
- **Dashboard:** the status appears in the Effort and Plots views wherever these numbers are shown.
- **Richness sensitivity:** computed per replicate, like every other effort mart.

## V-13. Deployment guarantees

**Decision.**

- **Input contract** (`vegqa/contracts.py`): required files and columns are checked before any analysis. A broken export stops with one message listing everything missing.
- **Staged publication, with a stated limit:**
  - A run writes to a staging folder and validates it; a failure before publication leaves the previous run untouched (tested).
  - Publication moves files one by one, with the manifest last, so a crash during it can mix two runs.
  - The mix is detectable: a `.publishing-*` marker remains, and `--verify` checks every file against the hashes in the manifest. A re-run repairs it (tested).
  - One atomic pointer switch over versioned run folders is specified for the platform (Q2 §7), not implemented.
- **Runtime provenance:** the manifest records the Python, platform, package and image versions. They are not part of the run id, which covers inputs, catalogue and code.
- **Review validity:** `evidence_hash` covers the evidence (observed, expected, severity) and the rule's definition (its catalogue entry and the thresholds). A review reopens when either changes.
- **Curation notes:** they are parsed defensively. A negated phrase ("do not exclude", "not a duplicate of") is not applied and F13 flags it. Production needs structured curation fields: merge target, exclusion, reason, curator, date, with validated merge chains.

---

## Differences from the exploration

The exploration's numbers were approximate. The pipeline re-derives them, and the acceptance tests pin both the agreements and these differences.

| Exploration | Pipeline | Why |
|---|---|---|
| Plot 05 midpoint "20–24 m" (R2) | 19.98 m: pass, just below the 20 m watch line | Rounding; the watch line is > 20 m |
| Plot 29 transect 61.8 m (R3) | Pass | 11.8 m from 50 m is within GPS error (z = 1.9) (V-04) |
| Whole-transect offsets: Plots 13, 07, 01 at 10–12 m (Q2) | Info; Plot 13 a warning for its 34° rotation | Within GPS error of the registered line (V-04) |
| Plot 19/27 altitude runs (Q4) | Found by a step test (> 15 m between consecutive quadrats) | A run of glitches shifts the median, so a robust z misses it |
| centroids `survey_year` missing for 13 (R6) | 19 | The exploration counted only part of the list |
| 28 'Unknown' rows, 342 records (T7) | 23 unresolved taxa, 316 records in canonical surveys | Counted after merges, in the canonical surveys only |
| Grace recorder 26/32 (S8) | 25/30 canonical | Canonical surveys only |
| Canavalia rosea "coastal" (T10) | Not flagged | GBIF has Kenyan records; a coastal-vs-inland test needs habitat data |
| Background geopoint 12–44 m (S9) | Reported as distances; pass (≤ 50 m) | Missing points are `could_not_check` |
| Three registrations "edited after collection" (this log's first version, N10) | A deployed-form difference: every registration stores the midpoint's geohash, `Edits` = 0 | Checked against all 30 registrations and the platform's audit field |
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
| N7 | Form design: macro photos at max-pixels 4096–4100 (copy-paste drift); quadrat GPS warning at 10 m against 5 m elsewhere; the registration plot list has no filter, so a plot can be registered twice | K01, K04 |
| N8 | The curation table's label disagrees with its number for herb_039 (labelled herb_011) and herb_072 (labelled herb_036) | F13 |
| N9 | 20 of the 90 identified taxa GBIF could check have no GBIF record in Kenya but many in southern Africa. The species list (Acacia galpinii, Pechuel-loeschea) and the transport options ("Mokoro", an Okavango dugout) suggest the list was built for a southern-African project | F10 |
| N10 | **The deployed registration form computes the geohash from the measured midpoint**, not from the centroid as the form file says: the stored geohash equals the midpoint's geohash-7 in 30/30 registrations, and `Edits` = 0 everywhere. It differs from the centroid list only for Plots 01, 04 and 15, whose midpoint lies in a neighbouring cell. (The first version of this log called these three "edited after collection"; the independent review showed that was wrong.) | C17 |
| N11 | The whole dataset sits about 705 m below the SRTM terrain at its coordinates: field GPS −704 m (median of 62 submissions), and NS's own prescribed points −703 m (centroid altitudes). Not a field error. With the species-range pattern (N9) and the transport list, it is a reason to question the dataset's provenance; one hypothesis among others is relocated demonstration data from a site near 1,000 m. It does not establish where the coordinates or altitudes come from (C-7) | E14 |
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
| C-12 | Which form versions were deployed? The stored geohash and replicate label follow a different calculation from the form files under the same version numbers | C14, C17, N5, N10 |

---

## Independent review

An independent reviewer, given no context, re-ran the pipeline and the tests, explored the raw data, and mutation-tested the rules on a copy of the data. Its confirmed findings and what changed:

| Finding | Change |
|---|---|
| Registration geohash differs from the centroid list in 3 plots; no rule checked form lookups | New rule C17 recomputes every simple entity-lookup calculation of both forms from the parsed XLSForm (N10) |
| The slot-collision narrative overstated the effect | Rewritten as a process risk; F09 now says whether duplicate writes are identical; B10's metric impact lowered to "indirect" |
| Times labelled EAT were read off the +02:00 stamps | Report wall-clock times re-derived from UTC as EAT (+1 h); source timestamps unchanged |
| Resolved richness includes a certain duplicate (Polygalaerioptera) | A sensitivity row collapses names GBIF matches to one species (114) |
| The stratum mapping hides that savanna plots are all "Scrub" | A D08 project row discloses it; C-10 |
| Classic Chao2; slope reported as an extrapolation; no intervals | Bias-corrected Chao2 with a log-normal CI; Chao et al. 2014 extrapolation; Hill numbers (V-10) |
| Repeatability overreached (Plot 18 has the same recorder; effort confounded) | Caveats added; recorders shown |
| The handover overclaimed: "every expression re-evaluated", "declarative" logic | Wording corrected; deployment model stated |
| Tests pinned this dataset only | `tests/test_mutations.py`: 34 rules must fire on an injected error |
| Hard-coded paths, 20 quadrats, country | Input folders are arguments; quadrats and countries read from `rules.yaml` |
| Suggestions taken up | The altitude/terrain check (E14), geohash-centre check (J04), shared app user, life-form caveat |
| Suggestion not taken up | SOP version history naming another project: not found in the SOP text |

### Second independent review (after C17, E14, J04, the effort rewrite, the mutation tests and the dashboard)

| Finding | Change |
|---|---|
| "Three registrations edited" is contradicted by `Edits` = 0 and by the midpoint's geohash in 30/30 registrations | C17 reports a systematic, midpoint-derived geohash as a deployed-form difference (info), says so in its message, and reports `Edits`; report, decisions (N10) and dashboard reworded; C-12 added |
| C17 silently skipped 6 of the 18 lookups it parses (ambiguous alias columns) | Lookups are matched against the raw export columns only; all are recomputed (all 6 match), and any lookup that cannot be is `could_not_check` |
| E14 blamed field submissions for an offset that NS's own centroid list shares | One project finding with both offsets; a submission is flagged only if it departs from the dataset's own offset (none does); ranges corrected |
| Mutation tests only checked "fails somewhere" | Each mutation must add a new failing entity against an unmutated baseline; new cases for E14, a survey-form C17 lookup and J04 (must pass at a cell centre) |
| Field feedback missed flags on additional-species rows (C08); canonical toggle could miss them | Those flags are resolved to their survey through the quadrat |
| Species suggestions could add one species twice (Polygala) and add taxa with no Kenyan record | Grouped by GBIF species; additions only with a GBIF species match and Kenyan records, otherwise "verify name" or "verify before adding" |
| F09 single rejected writer would be called "identical repeat"; F10 message hard-coded "a fifth" | Fixed |
| Per-plot "worst flag" coloured every plot by project-wide rules | Project-wide rules (D05, E13, B12, C14, C17, E14, J04) are left out of per-plot colouring, and the UI says so |
| Coverage with Q2 = 0 | The Chao & Jost (2012) form for Q2 = 0 |
| Suggestion not taken up | Folding J04's 51 per-point rows into one: kept, so each point can be inspected |

### Third independent review (whole-workflow robustness)

| Finding | Change |
|---|---|
| A duplicated survey or registration key crashed the run before A02 | `load.by_key` for every lookup; robustness tests for duplicates in surveys, registrations, quadrats, additional species, species and vegplot entities (V-12) |
| Rejected-only plots still counted; `hasIssues` could be canonical | At most one canonical survey per plot and replicate, from non-excluded review states only (V-01) |
| Zero quadrats divided by zero; no taxa gave 100% coverage and infinite diversity | Explicit empty-survey effort rows with a note (V-12) |
| A04 passed 1.5 as 1 | Whole numbers required first |
| Replicates merged in plot summaries and repeatability | One row per plot and replicate; pairs within a replicate |
| Dashboard: source keys not openable; no shared filters; review identity too weak; "passed everywhere" ignored could-not-check | Source records open from each flag; shared replicate / stratum / device / recorder / date filters; `project_id`, `flag_id`, `evidence_hash` on every result (DDL updated); "passed everywhere" requires no could-not-check |
| Provenance stated too firmly | Worded as a hypothesis for NS to confirm (N11, C-7, report, dashboard) |

### Fourth independent review (scientific interpretation and deployment)

| Finding | Change |
|---|---|
| z values presented as tests; 5 m called a requirement | Screening scores; 5 m sourced to the SOP's device instruction (D06, E01 now warnings) (V-04) |
| Missing endpoint coordinate or accuracy: D01–D06 silent or a pass with `nan` | "could not check" from every applicable geometry rule (tested) |
| Duplicated canonical survey counted twice; a duplicated quadrat raised effort to 21 | No copy of a duplicated KEY is canonical; sampling units are distinct quadrat KEYs; provisional metrics status (V-12) |
| Empty incidence called "a valid zero" regardless of cause | Valid zero, missing records or non-analytical records told apart; the latter two suppressed (V-12) |
| Replicates pooled in project richness and planned-vs-done | Both per replicate (V-12) |
| Chao2 10–10 with Q1 = 1, Q2 = 0 | No upper bound reported (V-10); iNEXT validation still to do (R unavailable) |
| GBIF counts included absence records; cache had no per-entry dates | `occurrenceStatus=PRESENT`, retrieval dates, refresh policy; no count changed (V-08) |
| Free-text curation parser applied "do not exclude" | Negated phrases not applied and flagged; structured fields specified (V-13) |
| Altitude vertical reference | Report notes ellipsoid vs geoid differences of at most about ±100 m; reference still to confirm |
| No input contract, non-atomic outputs, no runtime versions, evidence hash blind to rule changes | V-13 |
| Report overclaimed ("internally consistent", "three-quarters of true richness") | Softened; estimates conditional on the analytical data; coverage is not quality; spatial dependence; Hill-number scales; sensitivity not bounds; 697 flags grouped (241 from 10 systemic findings) |
| Dashboard: timeline ignored replicate; plot filter by name only; scope labels; "no flags" vs passed | All fixed |
| Not done | iNEXT cross-validation (no R); structured curation fields and persisted reviews (specified, not built); scheduling and database persistence (handover) |

### Fifth independent review (consistency between pipeline, dashboard and claims)

| Finding | Change |
|---|---|
| The dashboard's effort charts did not show `metrics_status`; the project level had no aggregate status | The project row inherits its plots' status and repeats the estimate on the ok plots only. After the bug check below, that is "8 of 30 plots provisional (C04 C08)" and 22 ok plots (resolved: 101 taxa, Chao2 129 (113–167), against 115 and 145 (128–185) on all 30). The Effort view shows a banner, a status card, provisional plots dashed or marked, and a table of qualified plots; the Plots view shows each plot's status (V-12) |
| A survey with missing records that also failed C02 was labelled "provisional: C02" | Suppressed takes precedence over provisional (tested) |
| Publication claimed to be atomic; the interruption test failed before publication | Claim narrowed. A crash during publication leaves a `.publishing-*` marker, the manifest lists a hash for every output, `--verify` reports mismatches, and a re-run repairs them (tested). One atomic pointer switch is specified for the platform, not built (V-13) |
| Effort view assumed one round: first project row by layer, no replicate in planned-vs-done, curves pooled across rounds, "31st plot", the GBIF row called a "bound" | Replicate selector, and every table and chart filtered by replicate. The richness sensitivity is computed per replicate. Wording: "one more plot", "a sensitivity analysis, not bounds". The multi-round display is not browser-checked (one round in the data) |
| Container "byte-identical" claim | Rebuilt: same run id, and the tables and dashboard JSON are identical; the figure PNGs are re-rendered on Linux and are not byte-identical. Wording narrowed |
| README made the reader dig for the answers | Root README reordered: answers, findings and decisions, reproduction and verification status, then supporting material |

### Bug check (three parallel reviews: pipeline, dashboard, documents)

| Bug | Fix |
|---|---|
| C08 listed as making metrics provisional but never applied: additional-species results had no survey key | The engine fills `survey_key` from the parent chain for every quadrat and additional-species result. Plot 28 is now provisional (C08): 8 of 30 plots, 22 ok plots (resolved: 101 taxa, Chao2 129 (113–167)). Every document is updated |
| A plot registered twice could mix registrations: GIS coordinates and key from the first, length from the second; a null coordinate in a LineString; the report table crashed | One rule picks the plot's registration everywhere (`model.chosen_registrations`: not rejected, then complete A/M/B, then latest). Tables, figures, GIS, quadrat positions and E rules all use it (tested with a re-registration) |
| `--verify` passed with stale files from another run, or a leftover staging folder | Both are reported. Publication also removes our own files from the previous run that the new run does not write (tested) |
| With one sampling unit, coverage 1, completeness 1 and Chao2 = observed (every estimator has a T − 1 factor) | Undefined (NaN) with a note (tested) |
| Map: a registered plot with incomplete coordinates drew no marker or was counted as "not viable" | Its own category, "registered, transect coordinates incomplete" |
| Map colours could include a rejected survey's flags | Survey-level flags count only for the canonical survey |
| One test read the committed outputs | It uses the fresh build |
| Dashboard: a walk-through step pointing at a missing node; banner always citing C04; empty chip text; Space scrolled the page; walk-through could not restart from the end; screen readers could not reach diagram boxes; 29 edges ran behind other boxes; error bar when Chao2 has no upper bound; median of an even count; duplicate rows and markers with several replicates | All fixed. Edges that would cross a box now run through the gaps between rows and columns |
| Documents | Wrong survey named for K03 (herb_100 came from Plot 18); GBIF retrieval date; "declarative"; run comparison described as built; V-13 missing from the report's table; "hundreds" of southern-African records (some have 26); file size; review count |


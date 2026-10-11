# Challenge 1: data and modelling decisions

This log records the decisions behind the Challenge 1 thresholds. Each entry gives what we observed, the evidence, what we decided, and how the decision affects the result. The source CSVs are never edited.

- **D-01 to D-04** are data decisions, made **before** fitting any species curve.
- **D-05 to D-08** record the first modelling pass. Each one separates the **policy** (chosen before seeing its result) from the **measured consequence** (what the fitting workflow produced).
- **D-09 to D-12** come from an independent review of that pass (2026-10-10). **D-13** is the covariate test Wood & Kahl recommend. **D-14** records how the other papers were used. D-09 replaces part of D-05; the replaced parts are marked rather than deleted, so the log shows how the decisions evolved.

Each entry also has a **status**, which says what has been decided, what is implemented, and where. The fitting workflow is `challenge1/src/run_challenge1.py`, and its outputs are in `challenge1/outputs/`. The dashboard page **Birds → Thresholds & observations** shows every result below.

### Current policy at a glance

1. **Link and de-duplicate** the validated clips (D-01, D-02).
2. **Evidence gate:** a species needs at least 5 correct **and** 5 incorrect validated clips before a fitted curve can set its threshold. Otherwise its status is **insufficient validation** (D-09).
3. **Fit:** ordinary logistic regression of the verdict on logit(confidence), as in Wood & Kahl. Firth is used only as a fallback for separated data (D-09).
4. **Accept** the 99% point only if the fit is valid, the curve increases, and the point lies inside the validated score range (D-05).
5. **Label:** the human verdict for validated clips that link to exactly one prediction; otherwise confidence ≥ the species threshold (D-10).
6. **Flag** recorders whose validated clips are inconsistent with the curve fitted without them (D-11).
7. **Report** uncertainty from a recorder-level bootstrap, model-free checks, and sensitivity analyses (D-12).
8. **Test transferability** with recorder and time covariates compared by AIC. The evening model meets the original adoption rule, but labels keep the pooled curve because recorder–time confounding leaves its transferability unresolved; the evening thresholds are reported as a sensitivity analysis (D-13).

| Species | Validated (correct / incorrect) | Status | Threshold | Above threshold | Human-confirmed | Observations |
|---|---|---|---:|---:|---:|---:|
| Abyssinian Nightjar | 117 / 33 | accepted (ordinary ML) | **0.666639** | 3,147 of 10,187 | 88 | 3,185 |
| African Black-headed Oriole | 150 / 0 | insufficient validation: no observed errors | — | 0 of 18,054 | 132 | 132 |
| Three-banded Plover | 145 / 1 | insufficient validation: too few errors | — | 0 of 1,015 | 137 | 137 |
| Red-billed Firefinch | 6 / 95 | 99% not reached within the validated range | — | 0 of 235 | 6 | 6 |
| **Total** | | | | **3,147** | **363** | **3,460 of 29,491** |

"Observations" counts the final labels. Human-confirmed clips that also score above the threshold are counted once, so for the Nightjar 3,147 + 88 − 50 = 3,185.

Checks were run on 2026-10-10 against `birdnet_predictions.csv` (29,491 rows) and `validation_results.csv` (551 rows). The same checks appear live in the dashboard under **Birds → Data quality → All checks**.

---

## D-01. Validated clips that appear twice (probable duplicate validations)

### What we observed

In `validation_results.csv`, some groups of clips have file names that are **identical except for the clip number**. That means the same species, the same 3-decimal score, the same recorder and the same audio file. For example, `0.884_4_RBS75_20230702_080002.wav` and `0.884_18_RBS75_20230702_080002.wav` differ only in the clip number, 4 and 18.

### How we checked

1. **Directly on the validation file.** We grouped the clips by species, score, recorder, date and file start time, which is the whole file name except the clip number. No other file is involved in this step.
2. **Against the predictions file.** For each group, we counted how many predictions in the matching recorder-hour have that same score. We matched on recorder + date + hour, because the two exports name the same audio file differently (see D-02).
   - **Exactly one matching prediction:** both clips must point to the same 3-second segment. That segment was probably validated twice.
   - **Two or more matching predictions:** the clips may be different segments whose scores round to the same 3 decimals.

### What we found

5 groups, each a pair. All are Three-banded Plover clips from recorder RBS75, and all are marked correct.

| Score | Recorder | Audio file start | Clip numbers | Matching predictions in that hour | Classification |
|---|---|---|---|---|---|
| 0.884 | RBS75 | 2023-07-02 08:00:02 | 4, 18 | 1 (t = 2000 s, 0.8836) | **probable duplicate** |
| 0.885 | RBS75 | 2023-06-30 23:00:00 | 1, 7 | 1 (t = 1926 s, 0.8848) | **probable duplicate** |
| 0.899 | RBS75 | 2023-06-28 16:00:00 | 2, 12 | 1 (t = 3363 s, 0.8989) | **probable duplicate** |
| 0.957 | RBS75 | 2023-07-01 11:00:02 | 2, 7 | 1 (t = 3572 s, 0.9571) | **probable duplicate** |
| 0.963 | RBS75 | 2023-07-02 08:00:02 | 5, 7 | 2 (t = 1973 s, 0.9632; t = 1991 s, 0.9627) | **ambiguous**, more likely two distinct segments |

No other species has such a group.

For scale: there are 380 pairs of same-species clips from the same audio file, and only these 5 share a score to three decimals.

### What we cannot prove

- The meaning of the clip number (the second field of the file name) is not documented.
- The validation file keeps only 3 decimals, so the ambiguous pair can't be resolved from the data.
- A likely explanation is that clips were drawn **with replacement**, so the same segment could be picked twice. Natural State, or whoever produced the validation set, could confirm this.

### Decision

**Status:** decided and implemented. The duplicates are **flagged** in the dashboard (`duplicate_check`) and **dropped in the fitting workflow** (`deduplicate()` in `run_challenge1.py`; the dropped clips are listed in `outputs/dropped_duplicate_validations.csv`). Exploratory views keep the raw counts, so the evidence stays visible.

- **Probable duplicates (4 pairs):** keep one clip of each pair and drop the other before fitting.
- **Ambiguous pair (1):** keep both. They are more likely two different segments. We repeat the fit without it to check sensitivity.
- **No other species is affected.**

### Effect

| Species | Validated clips | Distinct clips after D-01 | Errors |
|---|---:|---:|---:|
| African Black-headed Oriole | 150 | 150 | 0 |
| Abyssinian Nightjar | 150 | 150 | 33 |
| Three-banded Plover | 150 | **146** (145 if the ambiguous pair is also a duplicate) | 1 |
| Red-billed Firefinch | 101 | 101 | 95 |

The Plover's only error is `0.264_6_RBS64_20230629_060003.wav`. It is in none of these groups, so its error count is unchanged.

**Sensitivity of the Plover's 99% threshold.** Regenerated by the fitting workflow (`outputs/sensitivity.csv`). Labelled counts are out of 1,015 Plover predictions. This table was computed when Firth was the Plover's primary method (D-05, D-07). **Since D-09 the Plover gets no threshold** (one error is below the evidence gate), so the table now documents only how sensitive a one-error threshold is.

| Data used | Clips | Errors | Firth threshold (primary) | Labelled | Ordinary threshold | Labelled |
|---|---:|---:|---:|---:|---:|---:|
| All 150 clips | 150 | 1 | 0.8174 | 114 | 0.2588 | 538 |
| 4 probable duplicates dropped (**decision**) | 146 | 1 | **0.8485** | **100** | 0.2611 | 536 |
| All 5 pairs reduced to one clip | 145 | 1 | 0.8554 | 99 | 0.2614 | 536 |

Under the ordinary fit, the decision moves the threshold by about 0.002. Under Firth it moves it by about 0.03 and changes 14 labels. Firth reacts more because, with a single error, the penalty carries weight comparable to the data: removing four correct high-score clips increases its relative influence and flattens the curve. The choice between the two methods matters far more than the de-duplication (D-07).

### "Distinct" is not "independent"

Removing duplicates gives **distinct** clips, not **independent** ones:

- 551 validated clips come from 353 audio files.
- 104 of those files contribute more than one clip, up to 13.
- 93% of the Plover's clips come from one recorder (RBS75).

Clips from the same file or recorder share recording conditions, so plain logistic-regression intervals will be somewhat optimistic. The fitting step has to account for this clustering.

### How to see it

- **Dashboard → Birds → Data quality → All checks**, row "Validated clips whose file names differ only by clip number".
- **Ornithologist validations table:** derived column `duplicate_check`, with values `probable duplicate`, `ambiguous (distinct segments possible)` or `no`.
- The logic lives in `dashboard/src/data/enrich.ts`, in the block marked "Duplicate check straight from the validation file names".

### Recommendation for the platform

Give every prediction a stable id, carry it into the validation export, and sample validation clips without replacement. Duplicates and ties then become impossible by construction.

---

## D-02. Linking validated clips to predictions

- **Observation:** the two exports name the same recordings differently. Validation file names keep the true start second, e.g. `…_040002`. The predictions export appears to round the name down to the hour (`…_040000`) and add the offset to `begin_time_s`.
- **Strength of the evidence:** strongly supported, not proven. In all 550 checkable clips, each file's 3-second segment grid matches the true start second mod 3. But start times that differ by multiples of 3 s produce the same grid, so this can't establish the full offset. That matters most for the few files that start minutes after the hour. Without the audio, file headers or the exporter code, we don't change clip-cutting offsets on this evidence alone.
- **Decision:** link on species + recorder + date + hour + score. The validation score has 3 decimals, the prediction score 4, so the tolerance is ±0.0005.
- **Result:** 549 of 551 clips link to a prediction.
  - 472 link uniquely.
  - 8 are the 4 probable-duplicate pairs from D-01.
  - 69 tie with another prediction of the same 3-decimal score in that hour.
  - 2 are not found.
- **Correction of an earlier statement:** an earlier version of the dashboard said only 263 clips matched and that the predictions were "a subset of the full BirdNET run". That came from matching on the exact file name, and it was wrong.

## D-03. Recorder clocks

- **Observation:** bird activity at two recorders is about 3 hours early, consistent with a UTC clock (local time is East Africa Time, UTC+3).
  - **RBS40:** both indicators agree. Oriole dawn onset is −3.0 h and the Nightjar mean hour is −3.5 h.
  - **RBS71:** only the dawn singer can be used (−2.8 h), because it has **no Nightjar predictions**.
- **What the evidence covers:** only **22 of 43 recorders** have enough data for at least one indicator.
  - 2 are consistent with UTC: RBS40 and RBS71.
  - 5 are inconclusive, because only the noisier Nightjar indicator deviates.
  - 15 are consistent with local time.
  - The other 21 recorders can't be assessed, and **no claim is made about their clocks**.
- **Why it's only a hypothesis:** the activity data also contain known Nightjar false-positive sources and unequal recording schedules. An activity shift is suggestive, but it can't prove a time zone.
- **Decision:** add derived local-time columns (`clock_correction_h`, `detection_time_local`, `hour_local`, `date_local`), labelled as an **assumed scenario**. The correction is inferred from activity, not hard-coded. The recorded view stays available, and the source timestamps are unchanged. Exports write these columns with `+03:00`; recorder-clock columns carry no time zone.
- **Recommendation:** confirm each recorder's clock against deployment metadata before using the correction as fact.
- **Effect on thresholds:** none. The thresholds use only score and outcome. The correction matters for time-of-day work and any time covariate.

## D-04. Site-specific false positives for the Nightjar

- **Observation:** all 29 validated Nightjar clips from RBS75 (10) and RBS79 (19) are wrong, while 97% of its clips elsewhere are correct. Together they account for 29 of the Nightjar's 33 errors.
- **Effect on the time-of-day pattern:** these two recorders account for most of an apparent "evening effect". Without them, the evening dip in confidence largely disappears. This does **not** rule out an additional time-of-day effect, which would need score, recorder and time compared together.
- **Decision:**
  - The baseline uses one pooled Nightjar threshold (D-05).
  - Flag those recorders' Nightjar predictions for review. **Implemented:** the `review_flag` column marks all 2,277 Nightjar predictions at RBS75 and RBS79. The flag does not change the label. **Since D-11** the flagged recorders are no longer hard-coded: a leave-one-recorder-out test selects them, and it selects exactly these two.
  - **Measured:** only 9 of those predictions are labelled, all at RBS79, with scores from 0.689 to 0.968. All 29 validated clips at the two recorders scored at most 0.273, so the validation says nothing about high scores there. That is why they are flagged rather than removed.
  - **Measured (D-11):** without the two recorders, only 4 Nightjar errors remain, which is below the evidence gate. The ordinary threshold would hardly move, though: 0.686 instead of 0.667 (3,047 labels instead of 3,147).
  - **Done (D-13):** covariate models compared with AIC, as Wood & Kahl suggest. A plain recorder term separates (the two recorders are all wrong; coefficient about −25, SE about 1.5 × 10⁴), and the recorder random-intercept fits do not converge, so they are reported as inconclusive. Recorder and evening effects overlap in this sample and cannot be separated; an evening effect remains plausible.

---

## D-05. Fitting method and acceptance rules (all species)

**Status:** first modelling pass. **Partly superseded by D-09 (2026-10-10):** method routing (point 2) and the two policies (point 6) are replaced by the evidence gate. The model (1), the validity gates (3), the acceptance rules (4) and the label rounding (5) remain in force. The table below is the first pass's result, kept for the record.

### Policy

1. **Model.** One logistic regression per species of the validated outcome on logit(confidence), as in Wood & Kahl (2024). The 99% threshold is the score where the fitted probability equals 0.99.
2. **Method routing.** The data decide which estimator is primary. The rule is the same for every species:
   - **Separation** (all clips have the same outcome, or one score cut divides correct from incorrect) → **Firth** penalised likelihood. Ordinary maximum likelihood has no finite estimate there. Separation **routes** the species to Firth; it doesn't by itself mean "no threshold".
   - **Fewer than 10 clips in the rarer outcome** → **Firth**, because ordinary estimates are biased with so few events. *(Correction, see D-09: Firth reduces bias in the coefficients, not in the predicted probabilities that set the threshold.)*
   - **Otherwise** → ordinary maximum likelihood.
   - Both fits are always computed and reported, so the method's effect is visible.
3. **Validity gates.** A fit counts only if it converged with finite coefficients and covariance. An ordinary fit on separated data is invalid. An invalid fit produces no probability and no threshold.
4. **Acceptance.** A **model-supported threshold** needs all of:
   - a valid primary fit
   - a **positive slope**, so a higher BirdNET score means a higher chance of being right (a threshold is only meaningful then)
   - the 99% point **within the validated score range**. If the curve reaches 0.99 only above the highest validated score, the result is "not reached within validated range", with no threshold. If it is already at or above 0.99 at the lowest validated score, the effective threshold is that lowest score, so there is no extrapolation downward.

   Otherwise the result is **no supported threshold**, and the species gets no automatic observations. A finite Firth estimate is not enough.
5. **Labels.** A prediction becomes a **model-supported observation** if its confidence is at least the species' effective threshold. The threshold is rounded **up** to 6 decimals, and the labels are computed from that exported value. Anyone applying `confidence >= species_threshold` therefore reproduces them exactly, and the fitted probability at the threshold stays at least 0.99.
6. **Two policies are reported.**
   - **(a) Primary:** the rules above.
   - **(b) Conservative sensitivity:** any species whose primary fit is Firth gets no automatic observations until **additional representative validation** is available. That means more clips sampled the same way across scores and sites, not a search for errors to make fitting possible.

### Measured consequences

| Species | Validated clips (correct / incorrect) | Separated | Primary method | Status | Threshold | Labelled, policy (a) | Labelled, policy (b) |
|---|---|---|---|---|---:|---:|---:|
| Abyssinian Nightjar | 117 / 33 | no | ordinary ML | accepted | **0.6666** | 3,147 of 10,187 | 3,147 |
| Three-banded Plover | 145 / 1 | no | Firth (1 error) | accepted | **0.8485** | 100 of 1,015 | 0 |
| African Black-headed Oriole | 150 / 0 | yes | Firth (separation) | no supported threshold: slope not positive | — | 0 of 18,054 | 0 |
| Red-billed Firefinch | 6 / 95 | no | Firth (6 correct) | not reached within validated range | — | 0 of 235 | 0 |
| **Total** | | | | | | **3,247 of 29,491** | **3,147** |

- The routing rule also sends the **Firefinch** to Firth, because it has only 6 correct clips. This changes nothing: both methods put its 99% point above its validated range (D-08).
- The Nightjar's comparison Firth fit gives 0.7086 (2,931 labelled). The two methods agree closely when both outcomes are well represented.
- The Oriole result was not anticipated when the policy was written. See D-06.

---

## D-06. African Black-headed Oriole: no observed errors

**Status:** superseded by D-09. The Oriole's status is now **insufficient validation: no observed errors**, decided by the evidence gate rather than by the sign of a penalty artefact. That resolves the open question below. Its 132 human-confirmed clips are observations (D-10). The measurements below still hold.

### Policy

D-05 applies unchanged: separation → Firth; acceptance needs a valid fit, a positive slope and a 99% point within the validated range. The Oriole's estimated probabilities depend on the penalty and on the model's assumptions. **None of the 150 validated clips was wrong**, so the data alone cannot say where, or whether, correctness falls below 99%.

### Measured consequences

- **The Firth fit is valid but flat, and slightly decreasing:** slope −0.057, SE 0.53. Its fitted probability is 0.992–0.994 across the whole validated range (0.104–0.989).
- That level comes from the penalty, not from observed errors. Firth's penalty is equivalent to adding pseudo-observations, half correct and half incorrect, at each clip in proportion to its leverage. With two coefficients, that totals about one pseudo-error, concentrated at the scores that most influence the fit. The fitted level reflects that pseudo-data.
- **The slope is not identified.** In the cluster bootstrap, 17% of resamples (343 of 2,000) give a positive slope. Every resample has zero errors, like the data, so the sign of the slope is an artefact of the penalty.
- Because the slope isn't positive, the acceptance rule gives **no supported threshold**. That holds under both policies: 0 automatic Oriole observations.
- **For scale:** 150 of 150 correct gives a 95% Wilson lower bound of about **97.5%**. Even without a model, the validation can't confirm 99% correctness at any score.
- **Alternative not adopted:** taking the flat penalised level at face value (p ≥ 0.99 everywhere in the range) would label every Oriole prediction scoring at least 0.104. That's **17,646 of 18,054**. That outcome would rest entirely on the penalty, with zero observed errors to calibrate it.

### Open question: the rule is sign-dependent with zero errors

The bug check on 2026-10-10 found that the "positive slope" condition is a **sign check, not an identification check**:

- The 343 bootstrap resamples with a positive slope pass the acceptance rule. They get thresholds within the validated range, labelling up to 17,646 predictions. That is where the upper end of the Oriole's bootstrap count interval comes from.
- So the Oriole is rejected because its slope happened to come out negative, not because the rule recognises missing evidence. A slightly different validation sample could have flipped the label decision for 18,054 predictions without any new errors being observed.
- The same mechanism affects 17 Plover resamples that leave out the single error.

A candidate fix, pending a decision: **no supported threshold when one outcome is never observed.** The reason would then be "no observed errors" rather than the slope's sign. It would not change the current labels for any species. It would remove the penalty-only thresholds from the bootstrap.

A stricter option would require the slope to be clearly positive, not just positive. That would also affect the Plover: its Firth slope is 0.20 with SE 0.38. That is a larger policy change.

### Recommendation

Validate more Oriole clips, chosen as before: stratified across scores and recorders, not targeted at likely errors. With a few hundred more clips, either errors appear and the curve becomes estimable, or the lower bound rises above 99% and a defensible blanket threshold becomes possible.

---

## D-07. Three-banded Plover: one error, and the method matters

**Status:** superseded by D-09. With one error the Plover fails the evidence gate and gets **no threshold**; its 137 human-confirmed clips are observations (D-10). The three estimators are still reported as information only. The measurements below are from the first pass. **The mechanism explanation is corrected below.**

### Policy

The Plover's threshold was **recomputed** under Firth, not carried over from the exploratory ordinary fit (~0.26 in D-01).

### Measured consequences

| Method | Slope | 99% threshold | Labelled (of 1,015) |
|---|---:|---:|---:|
| **Firth (primary)** | 0.20 | **0.8485** | **100** |
| Ordinary ML (comparison) | 0.53 | 0.2611 | 536 |

- **The single error drives everything.** It is `0.264_6_RBS64_20230629_060003.wav`, scoring 0.264.
  - The ordinary fit puts the 99% point just above that error.
  - ~~Firth shrinks the slope toward zero, so the curve rises more slowly and crosses 0.99 much higher.~~ **Correction (independent review, verified):** the slope shrinkage alone would *lower* the threshold. What moves it up is the intercept. Firth's penalty acts like one extra error, doubling the Plover's single one: its mean fitted probability is 0.9865 ≈ 1 − 2/147, against the observed 0.9932. FLIC (Firth's slope with the intercept re-estimated so the mean matches the observed share) crosses 99% at **0.156** (785 labels).
  - With one event, neither estimate is precise.
- **Uncertainty.** These come from the cluster bootstrap by audio file, with 2,000 resamples.
  - **35%** of resamples (701 of 2,000) leave out the audio file with the single error.
    - In 684 of them the Firth slope is not positive, so there is no threshold.
    - In the other 17 the slope is positive by chance, and the rule accepts a threshold set only by the penalty (see the open question in D-06).
    - 2 resamples that contain the error also give no usable threshold. In total, 34.3% of resamples are unusable.
  - Among the usable resamples, the 95% interval for the threshold is **0.666–0.991**.
  - Counting every resample, with "no threshold" counted as 0 labels, the 95% interval for the labelled count is **0–187** (median 51).
  - The Wald (delta-method) interval, 0.0003–1.0, is uninformative here and is not used.
- **Location.** All 100 labelled predictions are from RBS75, which also supplied 93% of the validated Plover clips. Two have scores above the highest validated score (0.994).
- **Policy (b)** gives 0 Plover observations.
- **De-duplication:** see D-01. It changes the Firth threshold by about 0.03, which is small next to the method difference.

### Recommendation

Three defensible estimators give 0.156, 0.261 and 0.848, and removing the one error gives no threshold at all. That spread is the reason for the evidence gate (D-09). More validation, especially from recorders other than RBS75, is the only way to locate a Plover threshold.

---

## D-08. The 99% rule, uncertainty, endpoints, and the remaining species

**Status:** decided and implemented. The rule, the endpoint treatment and the expected-precision definition remain in force. **Updated by D-12:** the headline bootstrap now resamples recorders, the bootstrap replays the whole procedure including the gate, and model-free checks are reported for every species. The Firefinch is now fitted by ordinary ML; it reaches 99% only at 0.9984, still above its range.

### Policy

- **The rule** is the point estimate: fitted p ≥ 0.99, as the brief asks. Uncertainty is reported **separately** and doesn't change labels.
- **Uncertainty** is reported in three ways:
  - a cluster bootstrap by audio file (2,000 resamples, seed 20261010). Clips from the same file share conditions (D-01, "Distinct is not independent").
  - a delta-method interval, for comparison only
  - the number of predictions that would be labelled at each end of the bootstrap interval, under the same range rules
- **Logit endpoint.** Confidence is clamped to [10⁻⁴, 1 − 10⁻⁴] before the logit, so scores of exactly 1 stay finite. 4 predictions and 2 validated clips, all Nightjar, score exactly 1.
- **Expected precision** of the labelled set is the mean fitted probability of the labelled predictions. It is model-based and is not an observed rate.

### Measured consequences

**Nightjar (accepted, 0.6666).**
- Bootstrap 95% interval: **0.444–0.824**. The delta-method interval, 0.403–0.856, is similar.
- At those ends, **4,280** or **2,332** predictions would be labelled, against 3,147 at the point estimate.
- Expected precision of the labelled set: 0.9985. All 74 validated clips at or above the threshold are correct.
- Labelled predictions come from 16 recorders. The 9 at RBS79 carry a review flag (D-04).

**Firefinch (not reached).**
- The fitted curve reaches 0.99 only at 0.9990 (Firth) or 0.9984 (ordinary). Both are above the highest validated score (0.907), and the highest Firefinch prediction is also 0.907.
- At its highest validated score, the fitted probability is only 0.67 (ordinary ML; 0.63 under Firth).
- Only 6 of 101 validated clips are correct. Result: no observations under either policy.
- **Recommendation:** targeted validation of high-scoring Firefinch clips. There are very few, so validating them all is feasible.

**Endpoint sensitivity** (`outputs/sensitivity.csv`).
- Using 5×10⁻⁴, 10⁻⁵ or 10⁻⁶, or excluding the two validated clips scoring exactly 1, changes the Nightjar threshold only in the 8th decimal.
- No label changes.
- Those clips sit where the fitted probability is already about 1, so they carry almost no weight in the fit.

### Open items

- **Nightjar recorder-term sensitivity (D-04).** Done: D-11 (leave-one-recorder-out test and refit without flagged recorders) and D-13 (covariate models compared by AIC).

---

## D-09. Evidence gate replaces estimator routing

**Status:** decided and implemented (2026-10-10), after the independent review. Replaces D-05 points 2 and 6. Implemented in `evidence_gate()`, `fit_primary()` and `run_procedure()` in `ns_observations/calibrate.py`, which the research script imports.

### Why the first pass was changed

The independent review (verified by reproduction) found that, for species with no or one error, the first pass gave answers that depended on the estimator rather than on the data:

- **The Plover's 0.85 came from the penalty.** Firth reduces bias in the coefficients, but it pulls predicted probabilities toward 0.5 when one outcome is rare (Puhr et al. 2017). The threshold depends on predicted probabilities. Three defensible estimators gave 0.156, 0.261 and 0.848 (785, 536 or 100 labels). Removing the one error gave no threshold at all.
- **The rule was not monotone in evidence.** Zero errors gave the Oriole 0 labels, one error gave the Plover 100.
- **With zero errors, the Oriole's decision rested on the sign of an unidentified slope** (D-06, open question).
- **The "fewer than 10 events → Firth" switch** was a discontinuity: near 10 errors, one more or one fewer error changed the estimator and moved the threshold.

### Policy

1. **Evidence gate.** A species needs at least **k = 5** correct **and** at least 5 incorrect validated clips (after de-duplication) before a fitted curve may set its threshold. Below that, its status is `insufficient_validation`, with a reason code: `no_validations`, `no_observed_errors`, `no_observed_correct`, `too_few_errors` or `too_few_correct`.
   - *Why 5:* a pragmatic minimum, chosen to reduce dependence on extremely sparse outcomes (the Plover's one error moves its threshold from 0.16 to 0.85 depending on the estimator), while staying low enough not to block species with a clear signal. It is not a statistical minimum: a species with exactly five errors would fail the gate if one were removed. It is a policy value, varied in the sensitivity analysis (k = 1, 3, 10).
   - *Why errors matter:* the 99% point is where errors become rare, so its location is learned from errors near it. Wood & Kahl do not discuss this case; the gate is our extension.
2. **One estimator.** Species that pass the gate are fitted by ordinary maximum likelihood, the paper's own `glm`. Firth is used **only** when the data are separated (no finite ML estimate). Firth and FLIC remain comparison estimators, reported for every species.
3. **The former policy (b) is now the primary policy, generalised.** "No automatic observations without enough representative validation" now applies to every species, decided by the gate, not by which estimator was used.
4. Acceptance (D-05 point 4) is unchanged.

### Measured consequences

| Species | Gate | Status | Threshold | Above threshold |
|---|---|---|---:|---:|
| Abyssinian Nightjar | passed (117 / 33) | accepted, ordinary ML | 0.666639 | 3,147 |
| African Black-headed Oriole | not passed: no observed errors | insufficient validation | — | 0 |
| Three-banded Plover | not passed: too few errors (1) | insufficient validation | — | 0 |
| Red-billed Firefinch | passed (6 / 95) | 99% not reached (curve reaches it at 0.9984; highest validated score 0.907) | — | 0 |

- **Gate sensitivity** (`sensitivity.csv`):
  - k = 1 would admit the Plover with the ordinary threshold 0.261 (536 labels), a number driven by a single clip.
  - k = 3 gives the same result as k = 5.
  - k = 10 would also stop the Firefinch at the gate, which changes nothing because its curve never reaches 99%.
- **The Nightjar passes the gate thanks to the two flagged recorders** (D-11): without them only 4 errors remain. Its threshold location is robust to them (0.686 vs 0.667); its evidence count is not.

---

## D-10. Human verdicts are labels

**Status:** decided and implemented (2026-10-10), in `ns_observations.label.label()`, with verdicts from `io_csv.verdicts_from_validations()`.

### Policy

- A prediction with a **uniquely linked** validated clip (D-02) takes the ornithologist's verdict:
  - **correct** → observation (`observation_status = validated_correct`)
  - **incorrect** → not an observation, whatever its score (`validated_incorrect`)
- **Tied** links match several predictions with the same 3-decimal score in that hour. Their verdict can't be attached to one of them, so those rows keep the model label and are marked `validation_link = tied`.
- If two unique links ever disagree for one prediction, no override is made. The count is reported in `run_summary.json`; it is 0 here.
- `model_observation` keeps the threshold-only label, so the two sources stay separable.

### Measured consequences

- **363 human-confirmed observations:** Oriole 132, Plover 137, Nightjar 88, Firefinch 6.
- **Oriole, Plover and Firefinch:** these are their only observations.
- **Nightjar:** 50 of its 88 confirmed clips also score above the threshold. So 3,147 + 88 − 50 = 3,185 observations.
- **17 Nightjar predictions are human-rejected**, all below the threshold. No validated-incorrect prediction lies above any threshold today. On new data the override matters: a rejected clip will not become an observation because of a high score.
- **Totals:** 3,460 observations, 3,097 from the threshold plus 363 human-confirmed.

---

## D-11. Review flags chosen by a test, not by hand

**Status:** decided and implemented (2026-10-10), in `recorder_checks()` (`ns_observations/calibrate.py`). Replaces the hard-coded RBS75/RBS79 list of D-04.

### Policy

The rule was fixed before looking at which recorders it selects:

- **Who is checked:** every species that passes the gate. Within it, every recorder with at least 5 validated clips is tested.
- **The test:**
  - Fit the primary estimator **without** that recorder, so it can't pull the curve toward itself.
  - Predict the recorder's clips with that curve.
  - Compute the exact probability (Poisson-binomial) of seeing so few correct clips.
- **Flag** the recorder when p < 0.05 / (number of recorders tested), a Bonferroni correction.
- **Effect of a flag:** all of that species' predictions at the recorder get `review_flag = recorder_inconsistent_with_pooled_curve`. The flag never changes a label.

### Measured consequences (`recorder_checks.csv`)

- **Nightjar:** 7 recorders tested, Bonferroni level 0.0071.
  - **RBS79:** 0 of 19 correct, against 10.9 expected (p = 2.5 × 10⁻⁸).
  - **RBS75:** 0 of 10 correct, against 4.4 expected (p = 0.0026).
  - All others are consistent (p = 1).
  - The two flagged recorders cover 2,277 predictions; 9 of them, all at RBS79, are above the threshold.
- **Firefinch:** 8 recorders tested, none flagged.
- **Oriole and Plover:** not checked, because they fail the gate.
- **Refit without the flagged recorders** (`sensitivity.csv`): 121 clips with 4 errors fail the gate. With k = 1, the threshold is 0.686 (3,047 labels).

---

## D-12. Meaning of "99%", validation design, and how uncertainty is reported

**Status:** decided and implemented (2026-10-10).

### "99%" is per prediction

- The brief uses both phrases: "precision ≥ 0.99" (a set-level quantity) and "99% sure that that prediction is correct" (per prediction). Wood & Kahl define the threshold per prediction: the score at which pr(correct) reaches the target. We follow the paper. It is the more conservative reading, because every automatic (model) observation has fitted p ≥ 0.99, not only their average. Human-confirmed observations follow the verdict instead: 44 have fitted p below 0.99, and 269 belong to species without a fitted curve.
- **Set-level alternative, reported but not used:** take the lowest score at which the mean fitted probability of everything above it is ≥ 0.99. For the Nightjar that gives **0.4316 and 4,355 labels**, against 0.6666 and 3,147.

### Validation design

- **Over-representation of high scores.** For the Oriole, Plover and Nightjar, the validation set has more high-score clips than the predictions do (`sampling_by_band.csv`).
  - Oriole: 26% of validated clips score ≥ 0.9, against 3% of predictions.
  - Plover: 28% vs 7%.
  - Nightjar: 36% vs 18%.
  - The Firefinch validation mirrors its predictions.
- **This matches Wood & Kahl's advice** to add a second random sample from higher scores when random samples are dominated by low ones.
- **What it affects:** sampling by score does not bias a model of correctness *given* the score, so the curves are unaffected. It does bias any raw precision pooled over all validated clips, so none is reported without a model or a score band.
- **Confirmation item C-1** (Q1 report, section 9): the protocol itself is undocumented. The working assumption is random sampling within score strata, possibly with replacement (D-01).

### Uncertainty

- **Recorder-level cluster bootstrap (headline).** Resamples whole recorders, 2,000 times (seed 20261010), and replays the **whole procedure, gate included**.
  - **Threshold interval:** conditional on resamples that produce a threshold, and reported with that share.
  - **Labelled-count interval:** unconditional; a resample without a threshold labels nothing.
- **Audio-file bootstrap.** Kept for comparison. It is almost identical to treating clips as independent.
- **Nightjar:**
  - Recorder bootstrap: a threshold in 93% of resamples, 95% interval **0.471–0.835**, labelled count **0 / 3,123 / 4,109** (2.5% / 50% / 97.5%).
  - All 139 resamples without a threshold leave out both RBS75 and RBS79.
  - Audio-file bootstrap: 0.444–0.824, labelled count 2,332 / 3,215 / 4,280.
  - Delta method: 0.403–0.856.
- **Firefinch:** a threshold in 0.55% of recorder resamples, so "not reached" is robust.

### Model-free checks, for every species

- The fitted 99% comes from the logistic shape. Direct validation supports less.
- **Nightjar:** all 74 validated clips at or above the threshold are correct. Wilson 95% lower bound: **95.1%**.
- **Oriole:** 150 of 150 correct, lower bound 97.5%. A lower bound of 99% would need 381 consecutive correct clips (Wilson), or 300 by the one-sided rule of three.
- These are reported beside the model results in `species_thresholds.csv` and on the dashboard.

### Estimator robustness

- Firth's convergence rule was strengthened. It now accepts only steps that strictly increase the penalised likelihood, damps overshooting steps, and judges convergence on the modified score, as logistf does.
- In 2,000 tiny random problems it converges every time, to the optimum found by direct numerical maximisation. The original rule failed on 5 of 2,000 such problems (independent review). An intermediate fix failed on 28%, because Fisher-scoring steps can bounce between two mirror points; that is what the damping solves.
- None of this changed a result on the real data: the four species' fits converge under every version.

---

## D-13. Covariates and AIC: does the curve change with recorder or time?

**Status:** decided and implemented (2026-10-10), in `covariate_models()` (`run_challenge1.py`) and `covariates.py`. Diagnostic: it does not change labels.

### Why

Wood & Kahl: "The generalizability of the logistic regression-based outcome–score relationship can be tested explicitly by simply including spatial and/or temporal prediction covariates … The support for competing logistic regression models can be evaluated with Akaike's Information Criterion."

### Policy

- **Which species.** Those that pass the evidence gate: the Nightjar and the Firefinch.
- **Models.** All include logit(score):
  1. score only (the primary model)
  2. \+ **evening**: local hour 16:00–21:59, using the clock corrections of D-03 (RBS40 and RBS71 +3 h)
  3. \+ **week** of the season (the data span 23 days)
  4. \+ a **recorder random intercept**
  5. \+ evening and the recorder random intercept
- **Why the recorder is the spatial unit.** All recorders are in one grid, so there is no other spatial covariate.
- **Why a random intercept.** A fixed recorder term diverges for recorders whose clips are all wrong. A random intercept shrinks such recorders toward the others instead.
- **How it is fitted.** The marginal likelihood integrates the intercept out per recorder with adaptive Gauss–Hermite quadrature (40 nodes). Tests check it against brute-force numerical integration (agreement to 10⁻⁶), against ordinary logistic regression as the recorder SD goes to 0, and against simulated parameters.
- **When a model counts as identified:** its fit converged (for random-intercept models: the optimiser reports success *and* the numerical gradient of the objective is ≈ 0), the recorder SD is below 10 on the logit scale, and no fixed-effect coefficient exceeds 15 in absolute value (separation). **AIC is ranked only among identified models**; the others stay in the table as diagnostics, without an AIC or ΔAIC. The 99% crossing is reported only for identified models.
- **Adoption rule, fixed before the results:** a covariate model would replace the pooled curve for labels only if it is
  - better by ΔAIC ≥ 2,
  - identified, and
  - applicable to predictions from recorders that have not been validated.

### Measured consequences (`covariate_models.csv`; revised 2026-10-10 after a follow-up review)

The first version of this entry ranked the two Nightjar random-intercept fits by AIC and read them as "recorder differences dominate (ΔAIC ≈ 55)" and "the time effects are the flagged recorders in disguise". A follow-up review showed those fits had **not converged**: the optimiser stopped with precision loss, the gradients are up to 1.8 × 10⁸, and the recorder SD is running off to infinity. Their likelihoods are not usable for model selection, so they no longer enter the ranking, and both claims are withdrawn.

**Nightjar.**

| Model | log-lik | AIC | ΔAIC (identified models) | 99% crossing |
|---|---:|---:|---:|---|
| score (the pooled curve) | −37.80 | 79.6 | 14.6 | 0.6666 |
| **score + evening** | −29.49 | 65.0 | **0.0** | 0.4208 at night & dawn, 0.7272 in the evening |
| score + week | −32.77 | 71.5 | 6.5 | 0.3585 (first week) |
| score + (1 \| recorder) | −9.55 | — | not ranked | not converged; recorder SD diverging (25) |
| score + evening + (1 \| recorder) | −8.27 | — | not ranked | not converged; recorder SD diverging (34) |

| Validated Nightjar clips | Correct | Incorrect |
|---|---:|---:|
| RBS75/RBS79, evening | 0 | 26 |
| RBS75/RBS79, night & dawn | 0 | 3 |
| other recorders, evening | 49 | 4 |
| other recorders, night & dawn | 68 | 0 |

- **Most observed Nightjar errors concentrate at two recorders whose validated clips are predominantly evening recordings.** 29 of the 33 errors are at RBS75/RBS79, and 26 of those 29 clips are evening clips.
- **Recorder and time effects are difficult to separate in this sample; an evening effect remains plausible.**
  - The cross-tab shows that recorder and evening overlap.
  - The recorder tests (D-11) show that RBS75/RBS79 disagree with the pooled curve.
  - Neither separates a recorder effect from a time effect. Without the two recorders, the evening term cannot be estimated at all: all 4 remaining errors are evening clips, so the data separate.
- **The week term is not supported** among the other recorders (adding it raises AIC by 1.7). That says nothing about an evening effect.
- **The recorder random-intercept models are inconclusive,** not evidence either way.

**Firefinch.**

- No identified covariate model improves on score only by 2 AIC units or more.
- The evening models separate (no correct evening clip).
- Every identified crossing stays above the highest validated score (0.907), so "not reached" stands.

### Decision: departing from the original adoption rule

- **The rule is met.** Score + evening meets the adoption rule this entry fixed before the results: it is better by ΔAIC ≥ 2 (14.6), identified, and computable for any recorder.
- **We depart from the rule and keep the pooled curve as the primary result.** The reason: recorder–time confounding leaves the evening model's **transferability unresolved**.
  - Its evening coefficient is estimated almost entirely from two recorders whose clips are both evening and all wrong.
  - The term cannot be estimated without them.
  - So we cannot tell whether the model would describe an evening effect at recorders that have not been validated, or the two recorders.
  - "Applicable to unvalidated recorders" was meant as a substantive condition, not just a computable one. In this sample it cannot be shown to hold.
- **This is a judgement made after seeing the result,** and it is recorded as such.
- **The evening model is reported as a sensitivity analysis:**
  - night & dawn threshold 0.420780
  - evening threshold 0.727211
  - **3,715** Nightjar predictions labelled, instead of 3,147 (+568)
- **We do not claim that an evening effect is absent.**
- **Recorder problems are handled** by the review flags (D-11) and, on the platform, by a **recorder acceptance check**: validate a small random sample of each species' predictions at every new recorder before automatic labelling.
- **What would resolve it:** validating evening and night Nightjar clips at recorders other than RBS75/RBS79. That is the same validation that would test the dusk hypothesis.

---

## D-14. Other methods from the literature: how each was used

**Status:** decided (2026-10-10). This changes no labels; it records what was considered and why.

### Policy

- **Labels come from Wood & Kahl's method,** which the brief prescribes, together with the extensions in D-05 to D-13.
- **Each of the other papers reviewed** on the dashboard's Methodology page is used only where it adds something, and never as a competing source of labels.

### Measured consequences and decisions

| Paper | Decision | Why |
|---|---|---|
| Tseng et al. 2025: precision of the kept set | **Reported** as the alternative reading of "99%" (C-5) | It gives the Nightjar 0.4316 and 4,355 labels, against 0.6666 and 3,147 (+38%). The per-prediction rule is Wood & Kahl's definition and matches the brief's wording; the choice between the two is a policy decision for Natural State |
| Schwinger et al. 2025: calibration diagnostics | **Used** as a check (calibration by score band) | Wood & Kahl's curve is Platt scaling. The banded check confirms the Nightjar fit across the range |
| Thompson et al. 2025: partial pooling across species | **Not adopted** for labels | It would give the Oriole and Plover a curve only by assuming they behave like the other species, which their data cannot confirm, against Wood & Kahl's "scores are not transferable among species". With four species, one of them the Firefinch, the pooled curve would mostly reflect the assumption. It is recommended for the platform once many species are validated |
| Navine et al. 2024: threshold-free call density | **Recommended downstream** (Tech handover, section 10) | It is a different endpoint (vocal activity), not clip labels. It needs no errors, so it suits species without a threshold. Its quantile-bin validation design is a model for future validation rounds |
| Clare et al. 2021: false-positive occupancy | **Recommended downstream** | Thresholds reduce false positives but don't remove them. `p_correct` and the validated clips are the inputs these models need |

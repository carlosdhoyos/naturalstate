# Challenge 1: data decisions before fitting

These are the decisions about the bird data that we made **before** fitting any species curve. Each entry gives what we observed, the evidence, what we decided, and how the decision affects the result. The source CSVs are never edited.

Each entry also has a **status**, which separates three things:

- what has been decided
- what is already implemented (in the dashboard)
- what is still pending in the fitting workflow, which has not been written yet

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

**Status:** the policy is decided. The duplicates are **flagged** in the dashboard (`duplicate_check`). They will be **dropped in the fitting workflow (pending)**. Exploratory views keep the raw counts, so the evidence stays visible.

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

**Sensitivity of the Plover's 99% threshold.** This uses an exploratory logistic regression of outcome on logit(confidence), run as an ad-hoc check with the same estimator as the dashboard. It is for sensitivity only: the fitting workflow will regenerate these numbers, and the final method is set there.

| Data used | Clips | Errors | 99% threshold (confidence) |
|---|---:|---:|---:|
| All 150 clips | 150 | 1 | 0.2588 |
| 4 probable duplicates dropped (**decision**) | 146 | 1 | 0.2611 |
| All 5 pairs reduced to one clip | 145 | 1 | 0.2614 |

The decision moves the threshold by about 0.002, which is negligible. It matters for honesty about sample size more than for the result.

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

## D-04. Site-specific false positives for the Nightjar (to consider when fitting)

- **Observation:** all 29 validated Nightjar clips from RBS75 (10) and RBS79 (19) are wrong, while 97% of its clips elsewhere are correct. Together they account for 29 of the Nightjar's 33 errors.
- **Effect on the time-of-day pattern:** these two recorders account for most of an apparent "evening effect". Without them, the evening dip in confidence largely disappears. This does **not** rule out an additional time-of-day effect, which would need score, recorder and time compared together.
- **Decision (pending the fitting step):**
  - Test a site / recorder term first. A recorder term can itself create separation and won't carry over to new recorders.
  - Consider time of day only conditional on score and recorder.
  - Flag those recorders' Nightjar predictions for review.

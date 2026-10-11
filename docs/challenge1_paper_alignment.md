# Challenge 1: alignment with Wood & Kahl (2024)

The brief asks us to follow Wood & Kahl (2024), *Guidelines for appropriate use of BirdNET scores and other detector outputs*, Journal of Ornithology, [doi:10.1007/s10336-024-02144-5](https://doi.org/10.1007/s10336-024-02144-5). This note checks each of the paper's recommendations against what `challenge1/src/run_challenge1.py` does.

**Summary.** The core is the paper's method, unchanged. For each species, we fit an ordinary logistic regression of the human verdict on the logit-transformed BirdNET score, then solve it for the target probability. What we added covers situations the paper does not discuss, but which this dataset contains:

- a species with no errors
- a species with one error
- separated data
- scores of exactly 1
- duplicate validations
- site-specific false positives

Every addition errs toward **fewer** automatic observations, never more. The exception is point 11: keeping human verdicts adds 313 directly confirmed observations. Decisions are referenced to the log in [challenge1_data_decisions.md](challenge1_data_decisions.md). The same table is on the dashboard: **Birds → Thresholds & observations → Wood & Kahl alignment**.

Status key:

- **Aligned:** we do what the paper says.
- **Extended:** the paper is silent, and we added a safeguard.
- **Adjusted:** a deliberate, documented difference.
- **For the platform:** belongs to the Tech handover rather than to clip labels.

## Point by point

### 1. Scores are not probabilities, and they are species-specific — aligned

> "BirdNET confidence scores are not probabilities … BirdNET confidence scores are not transferrable among species."

We fit one curve per species and never read a confidence score as a probability until it has been calibrated against validated clips.

### 2. How to choose validation clips — aligned (confirmation item C-1)

> "For each desired species or class, generate a random selection of BirdNET predictions spanning the full range of BirdNET scores. … for infrequently encountered species … it can be valuable to generate a second set of randomly selected validation samples from a higher range of scores and add these to the original dataset."

- We use the validations provided.
- For three species they over-represent high scores. For example, 26% of validated Oriole clips score ≥ 0.9, against 3% of Oriole predictions (D-12, `outputs/sampling_by_band.csv`). That is what the recommended top-up would produce.
- Selecting clips by score does not bias a model of correctness *given* the score, provided that, within a score, clips were not chosen by their outcome or by factors the model leaves out (such as the recorder), so the curves are unaffected.
- **Confirmation item C-1** (Q1 report, section 9): the actual protocol. The working assumption is random sampling within score strata. Whether clips were drawn with replacement is also to confirm; the duplicate pairs suggest they may have been (D-01).

### 3. The model — aligned

> `glm(outcome ~ score, family = "binomial", data = validation)`

- The primary estimator is ordinary maximum likelihood.
- It is tested against statsmodels' binomial GLM, which is equivalent to R's `glm`: coefficients agree to a relative 10⁻⁷, standard errors to 10⁻⁶.

### 4. Logit-transformed score — aligned

> "We suggest transforming confidence scores back into the original logit scale, because the highest scores tend to be compressed in the [0–1] scale."

- The predictor is ln(c / (1 − c)).
- The paper also divides by BirdNET's *sensitivity* setting. That is a constant rescaling: it changes β₁ but not the threshold expressed as a confidence score. So the unknown sensitivity setting does not affect any result.
- Scores of exactly 1 are clamped to 1 − 10⁻⁴. The effect is immaterial: the threshold changes in the 8th decimal (D-08).

### 5. Threshold formula — aligned

> threshold = (ln(p / (1 − p)) − β₀) / β₁

- Same formula, with p = 0.99 as the brief requires. Because the predictor is the logit score, the formula gives the threshold **on the logit scale**; the confidence threshold is its inverse logit, 1 / (1 + e^(−t)). The paper's examples use 0.90 and 0.95.
- At 0.99, errors near the threshold are rare by construction, so locating the threshold needs errors in the validation set. That is the reason for the evidence gate (point 10).
- The exported threshold is rounded up to 6 decimals, and labels use exactly that value.

### 6. Range of applicability — extended

> "Probabilistic score thresholds will be applicable to the range of conditions encompassed by data from which they were drawn."

We apply this to the **score** dimension as well:

- A threshold is accepted only inside the range of validated scores.
- If 99% is reached only above the highest validated score, there is no supported threshold (Firefinch).
- If the curve is above 99% even at the lowest validated score, the threshold is that score, never an extrapolation below it (D-05).

### 7. Covariates and AIC — aligned (D-13)

> "The generalizability of the logistic regression-based outcome–score relationship can be tested explicitly by simply including spatial and/or temporal prediction covariates … The support for competing logistic regression models can be evaluated with Akaike's Information Criterion."

**What we compared, by AIC.** All recorders are in one grid, so the recorder is the spatial unit. The models add evening, week of the season, and a recorder random intercept (fitted by adaptive Gauss–Hermite quadrature). The random intercept is used because a plain recorder term diverges for all-wrong recorders. A leave-one-recorder-out test with exact p-values complements it (D-11).

**Nightjar findings:**

- Most errors concentrate at two recorders whose validated clips are predominantly evening recordings.
- Recorder and time effects can't be separated in this sample, and an evening effect remains plausible.
- Score + evening is the best model that fits properly (ΔAIC 14.6). The recorder random-intercept fits did not converge and are inconclusive.

**Decision.** The evening model meets the original adoption rule, but labels keep the pooled curve, because recorder–time confounding leaves its transferability unresolved. This departure from the rule is documented in D-13. The evening thresholds are reported as a sensitivity analysis: 0.4208 at night & dawn, 0.7272 in the evening, 3,715 labels vs 3,147. Recorder problems are handled by review flags, and on the platform by a recorder acceptance check.

### 8. Disclose error rates — aligned

> "If all putative observations cannot be validated, it is very important to understand (and disclose) the estimated error rates."

Reported per species:

- the expected precision of the labelled set (model-based; Nightjar 99.85%)
- the model-free share correct among validated clips above the threshold (Nightjar 74/74, Wilson 95% lower bound 95.1%)
- a recorder-level bootstrap for the threshold and the number of labels (D-12)

We state plainly that the 99% comes from the logistic shape, and that direct validation supports about 95%.

### 9. Accuracy increases with score — aligned

> "After analyzing the performance of nearly 1000 species, we have yet to encounter a class in BirdNET for which prediction accuracy does not increase with confidence score."

A fitted curve that does not increase is therefore treated as a failure to identify the relationship (status `slope_not_positive`), not as evidence of a real negative effect.

### 10. Species with no or very few errors — extended

The paper does not discuss this case. Here it decides two of the four species.

- **Oriole:** 0 errors in 150 clips. Ordinary ML has no finite estimate. Firth's curve is flat, and its level is set by the penalty.
- **Plover:** 1 error in 146 clips. Three defensible estimators give 0.156, 0.261 and 0.848, and removing the one error gives no threshold.

**Policy (D-09):**

- A species needs at least 5 correct **and** at least 5 incorrect validated clips before a curve may set its threshold. Otherwise its status is `insufficient_validation`.
- Firth is used only as a fallback when the data are separated.
- The gate size is varied in the sensitivity analysis (k = 1, 3, 10).

### 11. Human verdicts — extended

The paper treats manual verification as a way to use scores directly. We keep the ornithologist's verdict as the label for every validated clip that links to exactly one prediction (D-10). That gives 363 human-confirmed observations, including all of the Oriole's (132) and the Plover's (137).

### 12. Per-prediction probability vs precision — adjusted (documented)

- The paper defines a threshold by pr(prediction is correct) at that score. The brief says both "precision ≥ 0.99" and "99% sure that that prediction is correct".
- We follow the paper's per-prediction definition, the more conservative one.
- A set-level reading (mean fitted p of everything above the threshold ≥ 0.99) would give the Nightjar 0.4316 and 4,355 labels, instead of 0.6666 and 3,147. It is reported, not used (D-12).

### 13. Temporal confirmation — for the platform

> "users can apply both a probabilistic threshold … and a temporal one, such that, for example, observations with a pr(tp) ≥ 0.95 are required on two or more days of a survey in order to consider a species 'present'."

This is a site-level presence rule, outside clip labelling. It is recommended to the Tech team as an optional downstream step.

### 14. Probabilities for false-positive models — aligned

> "observation-specific probabilities are compatible with population models designed to accommodate false positives."

- `p_correct` is exported for every prediction of a species with an identified, increasing curve (Nightjar, Firefinch).
- It is left empty where the curve is not identified, so nobody feeds an artefact into an occupancy model.

### 15. Transferability across hardware, sites and seasons — for the platform

> "BirdNET scores … will be sensitive to recording hardware rendering outcome–score relationships non-transferrable."

The thresholds belong to this deployment. The Tech handover specifies re-validation triggers: new site, season, hardware or BirdNET version.

### 16. Precision and recall still matter — adjusted (documented)

> "probabilistic scores are not necessarily a substitute for these metrics."

- Recall cannot be estimated from these files: they contain predictions above BirdNET's minimum score and verdicts on some of them, but no information on missed vocalisations.
- The observations are high-precision by design. A missing observation is not evidence of absence.

## Other methods considered (D-14)

Five related papers are reviewed on the dashboard's Methodology page. None of them replaces Wood & Kahl.

| Paper | How it was used |
|---|---|
| Tseng et al. 2025 | Its set-level precision is reported as the alternative reading of "99%": Nightjar 0.4316 and 4,355 labels instead of 0.6666 and 3,147. The choice is a policy decision (C-5) |
| Schwinger et al. 2025 | Calibration diagnostics. Wood & Kahl's curve is Platt scaling, and calibration by score band checks the fit |
| Thompson et al. 2025 | Partial pooling across species. **Not adopted:** it would give the Oriole and Plover curves only by assuming they behave like the other species, against Wood & Kahl's "not transferable among species". It is worth revisiting on the platform once many species are validated |
| Navine et al. 2024 | Threshold-free call density. A downstream product for species without thresholds, and a model for future validation designs |
| Clare et al. 2021 | False-positive occupancy models. A downstream use of `p_correct` and of the validated clips |

## Conclusion

The analysis follows Wood & Kahl wherever the paper gives guidance, and extends it conservatively where it doesn't. Two of its recommendations could not be carried out with these data: designing the validation sample (we had to use the clips provided), and reporting recall (there is no record of missed vocalisations). Both are disclosed. The other papers informed the reporting (Tseng), the diagnostics (Schwinger) and the platform roadmap (Thompson, Navine, Clare), without changing how labels are made.

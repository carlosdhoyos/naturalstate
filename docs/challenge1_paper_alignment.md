# Challenge 1: alignment with Wood & Kahl (2024)

The brief asks us to follow Wood & Kahl (2024), *Guidelines for appropriate use of BirdNET scores and other detector outputs*, Journal of Ornithology, [doi:10.1007/s10336-024-02144-5](https://doi.org/10.1007/s10336-024-02144-5). This note checks each of the paper's recommendations against what `challenge1/src/run_challenge1.py` does.

**Summary.** The core is the paper's method, unchanged. For each species, we fit an ordinary logistic regression of the human verdict on the logit-transformed BirdNET score, then solve it for the target probability. What we added covers situations the paper does not discuss, but which this dataset contains:

- a species with no errors
- a species with one error
- separated data
- scores of exactly 1
- duplicate validations
- site-specific false positives

Every addition errs toward **fewer** automatic observations, never more. Decisions are referenced to the log in [challenge1_data_decisions.md](challenge1_data_decisions.md). The same table is on the dashboard: **Birds → Thresholds & observations → Wood & Kahl alignment**.

Status key:

- **Aligned:** we do what the paper says.
- **Extended:** the paper is silent, and we added a safeguard.
- **Adjusted:** a deliberate, documented difference.
- **Pending:** planned, not yet done.
- **For the platform:** belongs to the Tech handover rather than to clip labels.

## Point by point

### 1. Scores are not probabilities, and they are species-specific — aligned

> "BirdNET confidence scores are not probabilities … BirdNET confidence scores are not transferrable among species."

We fit one curve per species and never read a confidence score as a probability until it has been calibrated against validated clips.

### 2. How to choose validation clips — aligned (with an open question)

> "For each desired species or class, generate a random selection of BirdNET predictions spanning the full range of BirdNET scores. … for infrequently encountered species … it can be valuable to generate a second set of randomly selected validation samples from a higher range of scores and add these to the original dataset."

- We use the validations provided.
- For three species they over-represent high scores. For example, 26% of validated Oriole clips score ≥ 0.9, against 3% of Oriole predictions (D-12, `outputs/sampling_by_band.csv`). That is what the recommended top-up would produce.
- Selecting clips by score does not bias a model of correctness *given* the score, so the curves are unaffected.
- **Open question for Natural State:** the actual protocol. Was sampling random within score strata, and were clips drawn with replacement? The duplicate pairs suggest they may have been (D-01).

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

- Same formula, with p = 0.99 as the brief requires. The paper's examples use 0.90 and 0.95.
- At 0.99, errors near the threshold are rare by construction, so locating the threshold needs errors in the validation set. That is the reason for the evidence gate (point 10).
- The exported threshold is rounded up to 6 decimals, and labels use exactly that value.

### 6. Range of applicability — extended

> "Probabilistic score thresholds will be applicable to the range of conditions encompassed by data from which they were drawn."

We apply this to the **score** dimension as well:

- A threshold is accepted only inside the range of validated scores.
- If 99% is reached only above the highest validated score, there is no supported threshold (Firefinch).
- If the curve is above 99% even at the lowest validated score, the threshold is that score, never an extrapolation below it (D-05).

### 7. Covariates and AIC — pending (partly addressed)

> "The generalizability of the logistic regression-based outcome–score relationship can be tested explicitly by simply including spatial and/or temporal prediction covariates … The support for competing logistic regression models can be evaluated with Akaike's Information Criterion."

- **Done:** a leave-one-recorder-out test with exact Poisson-binomial p-values and a Bonferroni correction. It flags RBS75 and RBS79 for the Nightjar (D-11), and a refit without them shows the threshold location is robust (0.686 vs 0.667).
- **Why not a plain covariate:** a recorder term separates, because the two flagged recorders are all wrong, so it needs a penalised or grouped form.
- **Pending:** a covariate model compared with AIC.

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

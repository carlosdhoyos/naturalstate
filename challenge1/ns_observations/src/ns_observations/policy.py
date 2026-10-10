"""Policy values and status codes. Biometrics owns the values; every threshold set records them.

Changing any value creates a new threshold set — nothing is edited in place. The meaning of each
value is documented in docs/challenge1_data_decisions.md (decision ids in brackets).
"""

from __future__ import annotations

from dataclasses import asdict, dataclass

import numpy as np


@dataclass(frozen=True)
class Policy:
    target: float = 0.99  # per-prediction probability of correctness (D-12)
    min_each_outcome: int = 5  # evidence gate k: correct AND incorrect validated clips (D-09)
    estimator: str = "auto"  # "auto" = ordinary ML, Firth only if separated (D-09); others for sensitivity runs
    eps: float = 1e-4  # confidence clamped to [eps, 1 - eps] before the logit (D-08)
    threshold_decimals: int = 6  # exported threshold rounded UP; labels use exactly that value (D-05)
    review_min_clips: int = 5  # recorders with at least this many validated clips are tested (D-11)
    review_alpha: float = 0.05  # family-wise level, Bonferroni over recorders tested (D-11)
    n_boot: int = 2000  # bootstrap resamples, diagnostics only (D-12)
    seed: int = 20261010

    def to_dict(self) -> dict:
        return asdict(self)


# species-level status codes
ACCEPTED = "accepted"  # 99% point inside the validated score range
ACCEPTED_WHOLE_RANGE = "accepted_whole_range"  # >= 99% already at the lowest validated score
NOT_REACHED = "not_reached"  # 99% only above the highest validated score
SLOPE_NOT_POSITIVE = "slope_not_positive"  # fitted curve does not increase with the score
NO_VALID_FIT = "no_valid_fit"
INSUFFICIENT = "insufficient_validation"  # evidence gate not passed (see gate_reason)
SPECIES_STATUSES = (ACCEPTED, ACCEPTED_WHOLE_RANGE, NOT_REACHED, SLOPE_NOT_POSITIVE, NO_VALID_FIT, INSUFFICIENT)
HAS_THRESHOLD = (ACCEPTED, ACCEPTED_WHOLE_RANGE)

GATE_REASONS = ("no_validations", "no_observed_errors", "no_observed_correct", "too_few_errors", "too_few_correct")

STATUS_TEXT = {
    ACCEPTED: "accepted: the fitted probability reaches 99% inside the validated score range",
    ACCEPTED_WHOLE_RANGE: "accepted: the fitted probability is at least 99% across the whole validated range; threshold = lowest validated score",
    NOT_REACHED: "no supported threshold: 99% is reached only above the highest validated score",
    SLOPE_NOT_POSITIVE: "no supported threshold: the fitted curve does not increase with the score",
    NO_VALID_FIT: "no supported threshold: the logistic fit did not converge to a valid estimate",
    INSUFFICIENT: "insufficient validation: too few correct or incorrect validated clips to locate a 99% point",
}
REASON_TEXT = {
    "no_validations": "no validated clips for this species",
    "no_observed_errors": "no validated clip was incorrect",
    "no_observed_correct": "no validated clip was correct",
    "too_few_errors": "fewer incorrect validated clips than the gate requires",
    "too_few_correct": "fewer correct validated clips than the gate requires",
}

# row-level observation status codes
ROW_VALIDATED_CORRECT = "validated_correct"
ROW_VALIDATED_INCORRECT = "validated_incorrect"
ROW_MODEL = "model_observation"
ROW_BELOW = "below_threshold"
ROW_NO_THRESHOLD = "no_species_threshold"
ROW_STATUSES = (ROW_VALIDATED_CORRECT, ROW_VALIDATED_INCORRECT, ROW_MODEL, ROW_BELOW, ROW_NO_THRESHOLD)

REVIEW_FLAG = "recorder_inconsistent_with_pooled_curve"


def operative(c: float, decimals: int = 6) -> float:
    """Round a confidence threshold UP to `decimals`, so the exported number is the one that decides
    labels and the fitted probability at it stays >= the target. The tiny offset keeps a value that
    is already exact (e.g. a 3-decimal validated score) from being bumped by float error."""
    k = 10**decimals
    return float(np.ceil(c * k - 1e-6) / k)

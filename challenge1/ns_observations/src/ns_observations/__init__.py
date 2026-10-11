"""ns_observations: BirdNET predictions -> species thresholds -> observation labels.

Two jobs (see the Tech handover, challenge1/Q2_tech_handover.md):
  calibrate(validations, policy) -> ThresholdSet      job A: gate, fit, accept, review flags
  label(predictions, threshold_set, verdicts) -> df  job B: pure, vectorised, no fitting

Method: Wood & Kahl (2024) with the safeguards in docs/challenge1_data_decisions.md (D-01..D-14).
"""

__version__ = "1.0.0"

from .artifact import ThresholdSet  # noqa: E402
from .calibrate import calibrate  # noqa: E402
from .label import label  # noqa: E402
from .policy import Policy  # noqa: E402

__all__ = ["Policy", "ThresholdSet", "calibrate", "label", "__version__"]

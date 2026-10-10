"""Compatibility shim: the estimators now live in the production package `ns_observations`
(challenge1/ns_observations/src/ns_observations/estimators.py), so the research analysis and the
platform code share one implementation. Import from here or from ns_observations.estimators."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "ns_observations" / "src"))

from ns_observations.estimators import *  # noqa: E402,F401,F403
from ns_observations.estimators import (  # noqa: E402,F401  (private helpers used by tests)
    _design,
    _eta,
    _firth_penalised_loglik,
    _info,
    _score,
)

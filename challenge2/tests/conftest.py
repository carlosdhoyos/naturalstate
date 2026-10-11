import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))


@pytest.fixture(scope="session")
def b():
    import run_challenge2

    return run_challenge2.build()


@pytest.fixture(scope="session")
def results(b):
    return b["results"]

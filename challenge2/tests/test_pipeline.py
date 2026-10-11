"""Engine, determinism, data-safety and unit tests."""

from __future__ import annotations

import hashlib

import numpy as np
import pandas as pd
import pytest

from vegqa import engine
from vegqa.effort import stats
from vegqa.geo import LocalProjection, angle_at, bearing_deg, deviation_from_ns, robust_line, segment_frame
from vegqa.load import DATA
from vegqa.taxonomy import curation_actions, norm_name, slot_number


def test_catalogue_and_code_agree(b):
    assert set(b["catalogue"]["rules"]) == set(engine.REGISTRY)


def test_every_rule_ran_and_statuses_valid(results, b):
    assert set(results.rule_id) == set(b["catalogue"]["rules"])
    assert set(results.status) <= {"fail", "pass", "could_not_check"}
    assert set(results.severity) <= {"error", "warning", "info"}
    for c in engine.RESULT_COLUMNS:
        assert results[c].map(type).eq(str).all(), f"non-text value in {c}"


def test_every_catalogue_rule_documented(b):
    for rid, r in b["catalogue"]["rules"].items():
        for k in ("group", "level", "severity", "metric_impact", "source", "title", "why", "action"):
            assert r.get(k), f"{rid} lacks {k}"


def test_deterministic(b):
    import run_challenge2

    again = run_challenge2.build()
    pd.testing.assert_frame_equal(b["results"], again["results"])
    assert b["run_id"] == again["run_id"]


def test_inputs_never_modified(b):
    before = {p: hashlib.sha256(p.read_bytes()).hexdigest() for p in DATA.rglob("*") if p.is_file()}
    import run_challenge2

    run_challenge2.build()
    after = {p: hashlib.sha256(p.read_bytes()).hexdigest() for p in DATA.rglob("*") if p.is_file()}
    assert before == after


def test_raw_values_untouched(b):
    d = b["ctx"].data
    for k in ("survey", "quadrat", "extra", "registration"):
        raw = d.raw[k]
        staged = getattr(d, k)
        pd.testing.assert_frame_equal(staged[raw.columns], raw)


def test_row_counts(b):
    d = b["ctx"].data
    assert (len(d.survey), len(d.quadrat), len(d.extra), len(d.registration)) == (32, 640, 1296, 31)
    o = b["ctx"].occ
    assert (o.source == "list").sum() == 947 and (o.source == "extra").sum() == 1296


def test_one_canonical_per_plot(b):
    s = b["ctx"].data.survey
    canon = s[s.KEY.isin(b["ctx"].canonical)]
    assert len(canon) == 30 and canon.plot_name.is_unique
    assert not (canon.ReviewState == "rejected").any()


def test_flag_counts_join_back(b):
    subs = b["tables"]["submissions"]
    assert len(subs) == 32 and subs.survey_key.is_unique


# ── unit tests ──────────────────────────────────────────────────────────
def test_projection_scale():
    p = LocalProjection(0.22, 37.4)
    x, y = p.xy(0.22 + 1 / 111.195, 37.4)
    assert abs(y - 1000) < 1 and abs(x) < 1e-6


def test_bearings_and_angles():
    assert bearing_deg((0, 0), (0, 10)) == 0
    assert bearing_deg((0, 0), (10, 0)) == 90
    assert bearing_deg((0, 0), (0, -10)) == 0  # folded: a transect has no direction
    assert deviation_from_ns(100) == 80
    assert abs(angle_at((0, -25), (0, 0), (0, 25)) - 180) < 1e-9


def test_segment_frame_signed_lateral():
    L, proj = segment_frame((0, 0), (0, 50))
    al, la = proj([2, -2], [10, 40])
    assert L == 50 and list(al) == [10, 40] and la[0] < 0 < la[1]


def test_robust_line_ignores_outlier():
    x = np.r_[np.zeros(19), 30.0]
    y = np.r_[np.linspace(0, 45, 19), 20.0]
    c, u, res = robust_line(x, y)
    assert abs(abs(u[1]) - 1) < 1e-6 and res[-1] > 25


def test_chao2_and_coverage_formulas():
    # T=10 quadrats; taxa a, b in one quadrat each, c in two, d in five: Q1=2, Q2=1, U=9
    inc = pd.DataFrame({"taxon": ["a", "b", "c", "c", "d", "d", "d", "d", "d"], "quadrat_number": [1, 2, 3, 4, 5, 6, 7, 8, 9]})
    s = stats(inc, 10)
    assert (s["S_obs"], s["Q1_uniques"], s["Q2_duplicates"], s["incidences"]) == (4, 2, 1, 9)
    assert s["chao2"] == pytest.approx(4 + 0.9 * 2 ** 2 / 2, abs=0.05)
    assert s["coverage"] == pytest.approx(1 - (2 / 9) * (9 * 2 / (9 * 2 + 2)), abs=1e-3)
    assert s["curve"][-1] == pytest.approx(4) and s["curve"][0] == pytest.approx(0.9)  # one random quadrat holds 9/10 taxa on average


def test_slot_number_and_names():
    assert slot_number("herb", "72") == "herb_072" and slot_number("woody", 3) == "wood_003" and slot_number("herb", "") == ""
    assert norm_name("  Justicia_divaricata ") == "justicia divaricata"


def test_curation_parsing():
    si = pd.DataFrame({"species_number": ["herb_001", "herb_002", "herb_003"], "species_name": ["Unknown", "X y", "Unknown"],
                       "notes": ["duplicate of herb_036", "woody but below 40cm so should be excluded", ""]})
    c = curation_actions(si)
    assert c.loc["herb_001", "merge_into"] == "herb_036" and c.loc["herb_002", "exclude"] and c.loc["herb_003", "unresolved"]


def test_report_tables_refresh_is_idempotent_and_keeps_prose(tmp_path):
    from vegqa import report_tables

    src = report_tables.REPORT.read_text()
    p = tmp_path / "r.md"
    p.write_text(src)
    report_tables.refresh(p)
    once = p.read_text()
    report_tables.refresh(p)
    assert p.read_text() == once
    prose = lambda t: [line for line in t.splitlines() if not line.startswith("|")]
    assert prose(once) == prose(src)
    assert once.count("<!-- table:") == len(report_tables.TABLES)

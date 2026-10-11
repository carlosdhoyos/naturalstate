"""Engine, determinism, data-safety and unit tests."""

from __future__ import annotations

import hashlib
import math

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
    assert s["chao2"] == pytest.approx(4 + 0.9 * 2 * 1 / (2 * 2), abs=0.05)  # bias-corrected Chao2
    assert s["chao2_lo95"] <= s["chao2"] <= s["chao2_hi95"]
    assert s["coverage"] == pytest.approx(1 - (2 / 9) * (9 * 2 / (9 * 2 + 2)), abs=1e-3)
    q0 = 0.9 * 2 ** 2 / 2
    assert s["new_taxa_next_quadrat"] == pytest.approx(q0 * 2 / (10 * q0 + 2), abs=0.01)
    assert s["curve"][-1] == pytest.approx(4) and s["curve"][0] == pytest.approx(0.9)  # one random quadrat holds 9/10 taxa on average
    assert s["hill_q0"] == 4 and s["hill_q0"] >= s["hill_q1"] >= s["hill_q2"]


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
    import re

    prose = lambda t: [re.sub(r"qa-[0-9a-f]{16}", "RUN", line) for line in t.splitlines() if not line.startswith("|")]
    assert prose(once) == prose(src)
    assert once.count("<!-- table:") == len(report_tables.TABLES)


def test_geohash_roundtrip():
    from vegqa.geo import geohash, geohash_centre

    g = geohash(0.2278005, 37.3591777, 7)
    lat, lon = geohash_centre(g)
    assert geohash(lat, lon, 7) == g and abs(lat - 0.2278) < 0.001 and abs(lon - 37.3592) < 0.001


def test_same_results_wherever_the_data_are_mounted(b, tmp_path):
    """The container mounts the inputs elsewhere: copied folders must give the same run id and results."""
    import shutil

    import run_challenge2
    from vegqa.load import ENTITIES, EXPORTS, FORMS

    dirs = {}
    for name, src in (("exp", EXPORTS), ("ent", ENTITIES), ("frm", FORMS)):
        dirs[name] = tmp_path / f"mounted_{name}"
        shutil.copytree(src, dirs[name])
    try:
        moved = run_challenge2.build(dirs["exp"], dirs["ent"], dirs["frm"])
    finally:
        from vegqa.forms import set_forms_dir

        set_forms_dir(FORMS)  # later tests read the repository copy again
    assert moved["run_id"] == b["run_id"]
    pd.testing.assert_frame_equal(moved["results"], b["results"])


def test_review_keys(b):
    """flag_id is one identity per (project, rule, entity type, entity key); evidence_hash follows the evidence."""
    r = b["results"]
    assert r.flag_id.is_unique and r.flag_id.str.len().eq(16).all()
    assert (r.project_id == "savmon|lw|herbs|ho").all()
    assert r.groupby(["observed", "expected"]).evidence_hash.nunique().eq(1).all()


def test_curation_notes_negation_is_not_applied():
    si = pd.DataFrame({"species_number": ["herb_001", "herb_002", "herb_003"], "species_name": ["X y", "Unknown", "Z w"],
                       "notes": ["do not exclude, it is herbaceous", "not a duplicate of herb_036", "should be excluded"]})
    c = curation_actions(si)
    assert not c.loc["herb_001", "exclude"] and c.loc["herb_001", "ambiguous_note"]
    assert c.loc["herb_002", "merge_into"] == "" and c.loc["herb_002", "ambiguous_note"]
    assert c.loc["herb_003", "exclude"] and not c.loc["herb_003", "ambiguous_note"]


def test_chao2_without_estimated_unseen_taxa_claims_no_upper_bound():
    """10 taxa, Q1 = 1, Q2 = 0, T = 20: the point estimate is 10, but certainty that nothing is missing is not
    implied: no upper bound is reported (iNEXT could not be run here; these are closed-form checks)."""
    from vegqa.effort import chao2_bc

    est, lo, hi = chao2_bc(10, 1, 0, 20)
    assert est == 10 and lo == 10 and math.isnan(hi)
    est, lo, hi = chao2_bc(10, 0, 3, 20)  # no uniques at all: nothing suggests unseen taxa
    assert (est, lo, hi) == (10, 10, 10)
    est, lo, hi = chao2_bc(10, 5, 0, 20)  # many uniques, no duplicates: bias-corrected form stays finite
    assert est == pytest.approx(10 + 0.95 * 5 * 4 / 2) and lo < est < hi


def test_coverage_cases():
    from vegqa.effort import coverage

    assert coverage(np.array([3, 4, 5]), 20) == 1.0                         # no uniques
    assert coverage(np.array([1, 1, 1, 1]), 20) < 0.5                       # all uniques
    assert 0 < coverage(np.array([1, 1, 3]), 20) < 1                         # Q2 = 0 branch


def test_transect_geojson_matches_the_registrations(b, results):
    """Section (d)'s GIS file: one A-M-B line per registered transect at the exported coordinates
    (lon, lat order), all prescribed points, canonical quadrats only, no altitudes."""
    from vegqa.gis import transects_geojson
    from vegqa.load import by_key

    gj = transects_geojson(b["ctx"], b["tables"]["plots"], results)
    kinds = pd.Series([f["properties"]["kind"] for f in gj["features"]]).value_counts().to_dict()
    assert kinds == {"quadrat": 600, "prescribed_point": 51, "transect": 30}
    reg = by_key(b["ctx"].data.registration, "plot_uuid")
    for f in gj["features"]:
        if f["properties"]["kind"] != "transect":
            continue
        a, m, bb = f["geometry"]["coordinates"]
        assert len(a) == 2  # no altitude
        r = reg[reg.KEY == f["properties"]["registration_key"]].iloc[0]
        assert m == [round(float(r._midpoint_lon), 7), round(float(r._midpoint_lat), 7)]
    errors = sorted(f["properties"]["plot_name"][-2:] for f in gj["features"] if f["properties"].get("worst_geometry_flag") == "error")
    assert errors == ["05", "14", "15", "19", "22", "27"]

"""Acceptance tests: the pipeline must re-find every finding of the exploratory review
(Ideas/vegetation_qaqc_review.md: S1-S10, R1-R6, Q1-Q9, T1-T10), report its 12 passed checks as "pass",
and keep the new findings (N-ids) of the systematic sweeps. If a rule stops finding its issue, a test fails.
Deliberate differences from the exploration are pinned too (see docs/challenge2_decisions.md, "Differences").
"""

from __future__ import annotations

import numpy as np
import pytest

P = "SavMon_LW_Plot_"


def fails(r, rule, plot=None, severity=None):
    f = r[(r.rule_id == rule) & (r.status == "fail")]
    if plot:
        f = f[f.plot_name == P + plot]
    if severity:
        f = f[f.severity == severity]
    return f


def status_set(r, rule):
    return set(r.loc[r.rule_id == rule, "status"])


# ── Survey / submission level ───────────────────────────────────────────
def test_S1_resurveys_and_rejections(results, b):
    assert set(fails(results, "B02").plot_name) == {P + "18", P + "21"}
    rej = fails(results, "B01")
    assert len(rej) == 2 and set(rej.plot_name) == {P + "18", P + "21"}
    rep = b["tables"]["effort_repeatability"]
    assert set(rep.plot_name) == {P + "18", P + "21"}
    assert rep.mean_quadrat_jaccard.between(0.4, 0.6).all()  # exploration: per-quadrat Jaccard ~ 0.5


def test_S2_rejected_submissions_wrote_entities(results):
    assert set(fails(results, "F09").entity_key) == {"herb_100", "herb_101", "herb_102"}
    assert len(fails(results, "K03")) == 1


def test_S3_late_upload_and_stale_lists(results):
    late = fails(results, "B06")
    assert {P + "18", P + "21"} <= set(late.plot_name)
    stale = fails(results, "B10")
    assert set(stale.plot_name) == {P + "29", P + "18", P + "21", P + "11"}
    assert stale.message.str.contains("late upload").all()


def test_S4_quadrats_with_species_form_bug(results):
    c07 = fails(results, "C07")
    assert len(c07) == 23
    assert c07.message.str.contains("expression as written").all()
    p14 = c07[c07.plot_name == P + "14"].iloc[0]
    assert p14.observed == "stored 11" and p14.expected.startswith("20")
    assert len(fails(results, "K02")) == 1


def test_S5_delays_and_durations(results):
    b05 = fails(results, "B05")
    assert {P + "08", P + "12"} <= set(b05[b05.severity == "info"].plot_name)
    assert len(b05[(b05.entity_type == "survey") & (b05.severity == "warning")]) == 2  # the two 25-26 min resurveys
    assert fails(results, "B06").observed.str.contains("16.8 h").any()


def test_S6_backup_not_nearest(results):
    d09 = fails(results, "D09", "46")
    assert len(d09) == 1 and "Plot_42 at 2.1 km" in d09.observed.iloc[0] and "3.8 km" in d09.observed.iloc[0]
    assert len(fails(results, "J02")) == 1


def test_S7_primary_points_never_registered(results):
    j = fails(results, "J01")
    assert {P + str(i) for i in range(31, 37)} <= set(j.plot_name)


def test_S8_recorder_imbalance(results):
    g = fails(results, "G03")
    assert g.observed.str.contains("Grace 25").any()  # 25 of the 30 canonical surveys (26 of all 32)


def test_S9_background_geopoint(results):
    e = results[(results.rule_id == "E12") & (results.entity_type == "survey")]
    missing = e[e.status == "could_not_check"]
    assert len(missing) == 3  # the three device-02 surveys
    dist = e[e.status == "pass"].observed.str.extract(r"^(\d+) m")[0].astype(int)
    assert dist.min() >= 10 and dist.max() <= 45


def test_S10_same_device_before_upload_is_a_pass(results):
    b04 = results[results.rule_id == "B04"]
    assert status_set(results, "B04") == {"pass"}
    same = b04[b04.message.str.contains("same device")]
    assert {P + "08", P + "22", P + "03"} <= set(same.plot_name)


# ── Plot registration level ─────────────────────────────────────────────
def test_R1_orientation(results):
    proj = fails(results, "D05")
    assert proj[proj.entity_type == "project"].observed.str.startswith("30/30").all()


def test_R2_midpoint_offset(results):
    assert len(fails(results, "D01", "14", "error")) == 1
    assert {P + "17", P + "27"} <= set(fails(results, "D01", severity="info").plot_name)
    p05 = results[(results.rule_id == "D01") & (results.plot_name == P + "05")].iloc[0]
    assert p05.status == "pass" and p05.observed.startswith("20.0 m")  # 19.98 m: just under the 20 m watch line (difference)


def test_R3_lengths_and_bends(results):
    d03 = fails(results, "D03")
    assert {P + "19", P + "27"} <= set(d03[d03.severity == "error"].plot_name)
    assert {P + "22", P + "01", P + "15"} <= set(d03.plot_name)
    assert P + "29" not in set(d03.plot_name)  # 61.8 m is within GPS error (difference, V-04)
    assert {P + "02", P + "11", P + "15"} <= set(fails(results, "D04").plot_name)
    assert len(fails(results, "D02", "27", "error")) == 1


def test_R4_forest_in_savanna(results):
    d08 = fails(results, "D08")
    assert set(d08[d08.entity_type == "plot"].plot_name) == {P + "04"}
    assert d08[d08.entity_type == "project"].observed.str.contains("Scrub 29").all()  # no 'savanna' option in the ecosystem list


def test_R5_unknown_woody_named(results):
    assert set(fails(results, "F12").plot_name) == {P + "14"}


def test_R6_entity_hygiene(results):
    a10 = fails(results, "A10")
    assert a10.observed.str.contains("survey_year missing").sum() >= 13  # 19 found (difference: the exploration counted 13)
    assert len(fails(results, "X01")[lambda x: x.entity_key == "replicate labels"]) == 1


# ── Quadrat level ───────────────────────────────────────────────────────
def test_Q1_out_and_back(results):
    e13 = fails(results, "E13")
    assert e13[e13.entity_type == "project"].observed.str.startswith("32/32").all()


def test_Q2_transect_offsets_and_coverage(results):
    assert len(fails(results, "E03", "05", "error")) == 1
    assert {P + "13", P + "07", P + "01"} <= set(fails(results, "E03").plot_name)  # within GPS error -> info/warning (difference)
    assert P + "15" in set(fails(results, "E05").plot_name)


def test_Q3_position_outliers_and_duplicates(results, b):
    e06 = fails(results, "E06", "01")
    assert len(e06) == 2
    q, p = b["tables"]["quadrats"], b["tables"]["plots"].set_index("plot_name")
    L = q.plot_name.map(p.transect_length_m)
    beyond = (q.along_registered_m - L).clip(lower=0) + (-q.along_registered_m).clip(lower=0)
    far = q[np.hypot(beyond, q.lateral_registered_m) > 25]
    assert len(far) == 18  # exploration: 18 quadrats > 25 m from the registered segment
    top = far.assign(n=far.quadrat_number.astype(int)).set_index(["plot_name", "n"]).index
    assert {(P + "01", 18), (P + "30", 20), (P + "19", 3), (P + "11", 4)} <= set(top)
    assert set(far.quadrat_key) <= set(fails(results, "E02").entity_key)
    assert len(fails(results, "E04")) >= 18


def test_Q4_altitude(results):
    plots = set(fails(results, "E07").plot_name)
    assert {P + p for p in ("08", "22", "19", "27", "12")} <= plots


def test_Q5_photo_order(results):
    e09 = fails(results, "E09")
    assert len(e09) == 1 and e09.plot_name.iloc[0] == P + "03" and e09.entity_key.iloc[0].endswith("[13]")


def test_Q6_quadrats_without_herbs(results):
    assert len(fails(results, "G02")) == 7
    assert status_set(results, "C01") == {"pass"}


def test_Q7_additional_declared_no_rows(results):
    assert len(fails(results, "C04")) == 10


def test_Q8_junk_comments(results):
    assert len(fails(results, "P02")) == 15


def test_Q9_all_unknown_burden(results, b):
    q = b["ctx"].data.quadrat
    assert int((q.all_unknown == "yes").sum()) == 139
    assert {P + "03", P + "24"} <= set(fails(results, "F11").plot_name)
    assert status_set(results, "C03") == {"pass"}


# ── Species / taxonomy level ────────────────────────────────────────────
def test_T1_empty_occurrence(results):
    c08 = fails(results, "C08")
    assert len(c08) == 1 and c08.plot_name.iloc[0] == P + "28" and "quadrat_repeat[6]" in c08.entity_key.iloc[0]


def test_T2_same_id_twice_in_quadrat(results):
    f05 = fails(results, "F05", severity="warning")
    assert len(f05) == 7


@pytest.mark.parametrize("name", ["Crotolaria sphaerocarpa", "Ipomea dichroa", "Brachiara dura", "Abitulum ramosum", "Oldenladia corymbosa",
                                  "Zornia glochidiala", "Phyllanthus pantandrus", "Jacquemontia tannifolia", "Macrotalyma daltonii", "Cenchrus bifloris"])
def test_T3_misspellings(results, name):
    assert name in set(fails(results, "F03").entity_key)


def test_T3_padding(results):
    assert len(fails(results, "F01")) == 2


def test_T4_reregistered_species(results):
    assert set(fails(results, "F04").entity_key) == {"herb_040", "herb_067", "herb_059", "herb_104"}


def test_T5_missing_species_on_list(results):
    f02 = fails(results, "F02")
    assert f02.observed.str.contains("Pechuel-loeschea").any()
    curated = set(f02[f02.entity_type == "curated_taxon"].observed.str.extract(r"'(.+)'")[0])
    assert {"Chloris virgata", "Cenchrus ciliaris", "Corchorus tridens", "Indigofera tinctoria", "Kyphocarpa angustifolia", "Ocimum americanum"} <= curated


def test_T6_woody_taxa(results):
    f06 = fails(results, "F06")
    assert len(f06) == 4 and f06.observed.str.contains("wood_005").any() and f06.observed.str.contains("woody but below").any()


def test_T7_curation_table(results):
    f13 = fails(results, "F13")
    obs = " ".join(f13.observed)
    assert "introducing a likely typo" in obs and "Hibiscuc" in obs
    assert "keeps the field spelling 'Crotolaria" in obs
    notes_only = set(f13[f13.observed.str.contains("free-text notes")].entity_key)
    assert {"herb_033", "herb_039", "herb_058", "herb_072"} <= notes_only
    assert len(fails(results, "F07")) == 23  # unresolved taxa used in canonical surveys (difference: 28 'Unknown' rows in the table)


def test_T8_several_ids_one_species(results):
    f08 = fails(results, "F08")
    assert f08.observed.str.contains("4 provisional ids -> 'Ipomea dichroa'").any()


def test_T9_sop_vs_form_separator(results):
    k = fails(results, "K01")
    assert k.observed.str.contains("45 typed canonicals use spaces, 0 underscores").any()


@pytest.mark.parametrize("name", ["Pogonarthria fleckii", "Hermbstaedtia linearis", "Pechuel-loeschea leubnitziae", "Citrullus naudinianus", "Hermannia eenii"])
def test_T10_out_of_range(results, name):
    assert name in set(fails(results, "F10").entity_key)


# ── Passed checks that must stay "pass" ─────────────────────────────────
@pytest.mark.parametrize("rule", ["A03", "A04", "E01", "D06", "E11", "E08", "A08", "A05", "A06", "C05", "C06", "F14", "C09", "B08"])
def test_passes(results, rule):
    assert status_set(results, rule) == {"pass"}


def test_pass_entity_labels_equal_form_writes(results):
    x = results[(results.rule_id == "X01") & (results.entity_type == "species_extra")]
    assert len(x) > 100 and set(x.status) == {"pass"}


def test_all_submissions_herbs_baseline(results):
    assert status_set(results, "B03") == {"pass"}


# ── New findings from the systematic sweeps (N-ids) ─────────────────────
def test_N1_device03_stale_list(results):
    b10 = fails(results, "B10", "11")
    assert b10.observed.str.contains("demo-device-03").all()


def test_N2_shrubland_stratum_unsampled(results):
    j = fails(results, "J01")
    assert j[j.entity_key == "stratum shrubland"].observed.str.startswith("0/6").all()


def test_N3_registration_open_overnight(results):
    b05 = fails(results, "B05", "16")
    assert (b05.entity_type == "registration").any() and b05.message.str.contains("across days").any()


def test_N4_curation_misspellings_beyond_exploration(results):
    names = set(fails(results, "F03").entity_key)
    assert {"Duosperma cretanum", "Leucas tettenesis", "Polygalaerioptera", "Melosperma bracteatum"} <= names


def test_N5_replicate_case_differs_from_form(results):
    c14 = fails(results, "C14")
    assert len(c14) == 32 and set(c14.severity) == {"info"}


def test_N6_nonviable_confirmed_away_from_point(results):
    e12 = fails(results, "E12", "23")
    assert e12.observed.str.contains("157 m").any()


def test_N7_form_design(results):
    obs = " ".join(fails(results, "K04").observed)
    assert "max-pixels differ" in obs and "no choice filter" in obs and "plot_establishment_notes" in obs


def test_N8_curation_label_mismatch(results):
    f13 = fails(results, "F13")
    assert f13[f13.entity_key == "herb_039"].observed.str.contains("label 'herb_011'").all()


def test_N9_species_list_region(results):
    f10 = fails(results, "F10")
    assert f10[f10.entity_type == "project"].observed.str.startswith("20/90").all()


def test_N10_registration_geohash_edited(results):
    """The registration copies the centroid geohash; three stored values are the geohash of the measured
    midpoint instead, which the form cannot produce (found by the independent review)."""
    c17 = fails(results, "C17")
    assert set(c17.plot_name) == {P + "01", P + "04", P + "15"}
    assert c17.observed.str.contains("= geohash of the registered midpoint").all()


def test_N11_altitudes_inconsistent_with_terrain(results):
    e14 = fails(results, "E14")
    proj = e14[e14.entity_type == "project"]
    assert len(proj) == 1 and "median -7" in proj.observed.iloc[0]
    assert (e14.entity_type != "project").sum() == 62  # every submission with altitudes (Plot 23 has none)


def test_repeat_surveys_reused_same_slots_for_same_plants(b):
    """Correction of the first narrative: the rejected repeats wrote herb_100-102 for the same plants in the
    same plots as the device-01 surveys, so no two different plants share an id."""
    d = b["ctx"].data
    e = d.extra[d.extra.entry_mode.isin(["new_unknown", "new_missing"])]
    e = e.assign(plot_of=e.PARENT_KEY.map(d.quadrat.set_index("KEY").PARENT_KEY).map(d.survey.set_index("KEY").plot_name))
    shared = e[e.assigned_unknown_index.isin(["100", "101", "102"])]
    assert shared.groupby("target_extra_name").plot_of.nunique().eq(1).all()


def test_N12_prescribed_points_not_geohash_centres(results):
    j = fails(results, "J04")
    assert j[j.entity_type == "project"].observed.str.startswith("51/51").all()

"""Whole-workflow robustness: the COMPLETE pipeline (rules, marts, effort, suggestions, figures, dashboard
export) must survive invalid future submissions and report them, not crash before the rule that detects
them runs. Each case edits a copy of the data, runs main() into a temporary folder, and checks both that
the run completed and that the right rule reports the problem.

The rule-level mutation tests (test_mutations.py) show that each rule CAN fire; these show the workflow
around the rules does not assume the very invariants the rules are there to check.
"""

from __future__ import annotations

import shutil

import pandas as pd
import pytest

from vegqa.load import ENTITIES, EXPORTS, FORMS, read_text

SURVEY, QUADRAT = "herbaceous_veg_survey.csv", "herbaceous_veg_survey-quadrat_repeat.csv"
EXTRA, REG = "herbaceous_veg_survey-additional_species_repeat.csv", "register_vegetation_plots.csv"


def run_workflow(tmp_path, edits):
    import run_challenge2
    from vegqa.forms import set_forms_dir

    ex, en, out = tmp_path / "exports", tmp_path / "entities", tmp_path / "out"
    shutil.copytree(EXPORTS, ex)
    shutil.copytree(ENTITIES, en)
    for fname, fn in edits.items():
        path = (ex if (ex / fname).exists() else en) / fname
        fn(read_text(path)).to_csv(path, index=False)  # every editor returns the edited frame
    try:
        run_challenge2.main(ex, en, out, FORMS)
    finally:
        set_forms_dir(FORMS)
        run_challenge2.OUT = run_challenge2.Path(run_challenge2.__file__).resolve().parents[1] / "outputs"  # main() rebinds OUT
    return pd.read_csv(out / "qa_results.csv", dtype=str, keep_default_na=False), out


def fails(r, rule):
    return r[(r.rule_id == rule) & (r.status == "fail")]


# ── editors (return the edited frame) ────────────────────────────────────
def dup_survey(df):
    return pd.concat([df, df.iloc[[0]]], ignore_index=True)


def dup_registration(df):
    return pd.concat([df, df.iloc[[0]]], ignore_index=True)


def dup_quadrat(df):
    return pd.concat([df, df.iloc[[0]]], ignore_index=True)


def dup_extra(df):
    return pd.concat([df, df.iloc[[0]]], ignore_index=True)


def dup_species(df):
    return pd.concat([df, df.iloc[[0]]], ignore_index=True)


def dup_vegplot(df):
    return pd.concat([df, df.iloc[[0]]], ignore_index=True)


def test_duplicated_canonical_survey_counts_nowhere(tmp_path):
    """A duplicated survey KEY is ambiguous: neither copy is canonical, effort has no rows for it, and the plot
    shows as not surveyed (J03), instead of being counted twice."""
    s = read_text(EXPORTS / SURVEY)
    key = s.loc[0, "KEY"]
    plot = s.loc[0, "plot_selection-plot_name"]
    r, out = run_workflow(tmp_path, {SURVEY: dup_survey})
    subs = pd.read_csv(out / "submissions.csv")
    assert (subs.survey_key == key).sum() == 2 and not subs[subs.survey_key == key].canonical.any()
    e = pd.read_csv(out / "effort_plots.csv")
    assert (e.survey_key == key).sum() == 0
    assert plot in set(fails(r, "J03").plot_name)


def test_duplicated_quadrat_row_is_one_sampling_unit(tmp_path):
    q = read_text(EXPORTS / QUADRAT)
    key = q.loc[0, "PARENT_KEY"]
    r, out = run_workflow(tmp_path, {QUADRAT: dup_quadrat})
    e = pd.read_csv(out / "effort_plots.csv")
    row = e[(e.survey_key == key) & (e.layer == "resolved")].iloc[0]
    assert row["T"] == 20  # distinct quadrats, not rows
    assert row["metrics_status"].startswith("provisional")  # A03 (21 rows) and A04 mark it; A02 reports the key at table level


def test_missing_species_records_suppress_metrics(tmp_path):
    """Herbs present, but every species record removed: not a valid zero; metrics suppressed."""
    s = read_text(EXPORTS / SURVEY)
    key = s.loc[0, "KEY"]
    qkeys = set(read_text(EXPORTS / QUADRAT).query("PARENT_KEY == @key").KEY)

    def drop_list(q):
        m = q.PARENT_KEY == key
        q.loc[m, "herb_species-selected_herb_species_uuids"] = ""
        return q

    r, out = run_workflow(tmp_path, {QUADRAT: drop_list, EXTRA: lambda x: x[~x.PARENT_KEY.isin(qkeys)].reset_index(drop=True)})
    e = pd.read_csv(out / "effort_plots.csv")
    row = e[(e.survey_key == key) & (e.layer == "resolved")].iloc[0]
    assert row["S_obs"] == 0 and "missing records" in row["note"] and row["metrics_status"] != "ok"


def test_missing_registration_geometry_is_could_not_check(tmp_path):
    reg = read_text(EXPORTS / REG)
    plot = reg.loc[reg["plot_selection-is_plot_viable"] == "yes", "plot_selection-plot_name"].iloc[0]

    def drop_endpoint(df):
        m = df["plot_selection-plot_name"] == plot
        df.loc[m, "plot_metadata-collect_points-endpoint_b-location_endpoint_b-Latitude"] = ""
        return df

    r, _ = run_workflow(tmp_path, {REG: drop_endpoint})
    for rule in ("D01", "D02", "D03", "D04", "D05", "D06"):
        st = set(r[(r.rule_id == rule) & (r.plot_name == plot)].status)
        assert st == {"could_not_check"}, (rule, st)


def test_missing_accuracy_is_not_a_pass(tmp_path):
    reg = read_text(EXPORTS / REG)
    plot = reg.loc[reg["plot_selection-is_plot_viable"] == "yes", "plot_selection-plot_name"].iloc[0]

    def drop_acc(df):
        df.loc[df["plot_selection-plot_name"] == plot, "plot_metadata-collect_points-endpoint_a-location_endpoint_a-Accuracy"] = ""
        return df

    r, _ = run_workflow(tmp_path, {REG: drop_acc})
    assert set(r[(r.rule_id == "D06") & (r.plot_name == plot)].status) == {"could_not_check"}


def test_broken_export_stops_before_analysis(tmp_path):
    from vegqa.contracts import InputContractError

    with pytest.raises(InputContractError, match="missing columns"):
        run_workflow(tmp_path, {SURVEY: lambda d: d.drop(columns=["KEY"])})


def test_interrupted_run_leaves_previous_outputs(tmp_path, monkeypatch):
    """Publication is staged: a failure mid-run leaves the previous complete run in place, no mixture."""
    import run_challenge2

    r, out = run_workflow(tmp_path / "first", {})
    before = {p.name: p.read_bytes() for p in out.glob("*.csv")} | {"m": (out / "run_manifest.json").read_bytes()}

    def boom(*a, **k):
        raise RuntimeError("simulated crash while drawing figures")

    monkeypatch.setattr(run_challenge2.figures, "make_all", boom)
    with pytest.raises(RuntimeError):
        run_challenge2.main(EXPORTS, ENTITIES, out, FORMS)
    run_challenge2.OUT = run_challenge2.Path(run_challenge2.__file__).resolve().parents[1] / "outputs"
    after = {p.name: p.read_bytes() for p in out.glob("*.csv")} | {"m": (out / "run_manifest.json").read_bytes()}
    assert before == after and not list(out.glob(".staging-*"))


@pytest.mark.parametrize("fname,edit,rule", [
    (SURVEY, dup_survey, "A02"), (REG, dup_registration, "A02"), (QUADRAT, dup_quadrat, "A02"),
    (EXTRA, dup_extra, "A02"), ("species.csv", dup_species, "A02"), ("vegplots.csv", dup_vegplot, "A02"),
], ids=["survey", "registration", "quadrat", "additional-species", "species-entity", "vegplot-entity"])
def test_duplicate_keys_are_reported_not_fatal(tmp_path, fname, edit, rule):
    r, _ = run_workflow(tmp_path, {fname: edit})
    assert len(fails(r, rule)), f"{rule} did not report the duplicate"


def test_empty_survey_is_reported(tmp_path):
    """A survey with no quadrat rows: A03 reports it, effort marks it, nothing divides by zero."""
    s = read_text(EXPORTS / SURVEY)
    key = s.loc[0, "KEY"]
    r, out = run_workflow(tmp_path, {QUADRAT: lambda q: q[q.PARENT_KEY != key].reset_index(drop=True)})
    assert key in set(fails(r, "A03").entity_key)
    e = pd.read_csv(out / "effort_plots.csv")
    row = e[e.survey_key == key].iloc[0]
    assert row["T"] == 0 and pd.isna(row["coverage"]) and "no quadrats" in row["note"]


def test_survey_without_vegetation_has_explicit_metrics(tmp_path):
    """20 quadrats, no herbs anywhere: a valid zero, with richness 0 and undefined (not 100% / infinite) metrics."""
    s = read_text(EXPORTS / SURVEY)
    key = s.loc[0, "KEY"]

    def strip(q):
        m = q.PARENT_KEY == key
        q.loc[m, "herbs_present"] = "no"
        for c in ("herb_species-all_unknown_unidentifiable", "herb_species-selected_herb_species_uuids", "herb_species-count_herb_species", "additional_species_present",
                  "species_list-known_species_list", "species_list-additional_species_list", "species_list-all_species_list"):
            q.loc[m, c] = ""
        return q

    qkeys = set(read_text(EXPORTS / QUADRAT).query("PARENT_KEY == @key").KEY)
    r, out = run_workflow(tmp_path, {QUADRAT: strip, EXTRA: lambda x: x[~x.PARENT_KEY.isin(qkeys)].reset_index(drop=True)})
    e = pd.read_csv(out / "effort_plots.csv")
    row = e[(e.survey_key == key) & (e.layer == "resolved")].iloc[0]
    assert row["S_obs"] == 0 and row["T"] == 20
    assert pd.isna(row["coverage"]) and pd.isna(row["hill_q1"]) and pd.isna(row["hill_q2"]) and row["note"].startswith("valid zero")


def test_rejected_only_plot_is_not_canonical(tmp_path):
    s = read_text(EXPORTS / SURVEY)
    plot = s.loc[0, "plot_selection-plot_name"]

    def reject(df):
        df.loc[df["plot_selection-plot_name"] == plot, "ReviewState"] = "rejected"
        return df

    r, out = run_workflow(tmp_path, {SURVEY: reject})
    subs = pd.read_csv(out / "submissions.csv")
    assert not subs[subs.plot_name == plot].canonical.any()
    assert plot in set(fails(r, "J03").plot_name)  # viable plot without an accepted survey


def test_has_issues_submission_is_not_canonical(tmp_path):
    s = read_text(EXPORTS / SURVEY)
    plot = s.loc[0, "plot_selection-plot_name"]

    def issues(df):
        df.loc[df["plot_selection-plot_name"] == plot, "ReviewState"] = "hasIssues"
        return df

    r, out = run_workflow(tmp_path, {SURVEY: issues})
    subs = pd.read_csv(out / "submissions.csv")
    assert not subs[subs.plot_name == plot].canonical.any()
    assert plot in set(fails(r, "B01").plot_name)


def test_fractional_quadrat_number_fails_A04(tmp_path):
    q = read_text(EXPORTS / QUADRAT)
    key = q.loc[0, "PARENT_KEY"]

    def frac(df):
        df.loc[0, "quadrat_number"] = "1.5"
        return df

    r, _ = run_workflow(tmp_path, {QUADRAT: frac})
    assert key in set(fails(r, "A04").entity_key)


def test_second_replicate_is_kept_apart(tmp_path):
    """A second monitoring round of one plot: one canonical survey per replicate, one plot row per
    replicate, and no repeatability pair across replicates."""
    s = read_text(EXPORTS / SURVEY)
    q = read_text(EXPORTS / QUADRAT)
    plot = "SavMon_LW_Plot_16"
    src = s[(s["plot_selection-plot_name"] == plot)].copy()
    old = src.KEY.iloc[0]
    new = old + "-yr1"
    src["KEY"] = new
    src["meta-instanceID"] = new
    src["survey_begin-replicate"] = "lw_yr1"
    src["survey_begin-replicate_index"] = "1"
    for c in ("survey_begin-start_time", "survey_end-end_time", "SubmissionDate"):
        src[c] = src[c].str.replace("2026-", "2027-", regex=False)
    qq = q[q.PARENT_KEY == old].copy()
    qq["KEY"] = qq.KEY.str.replace(old, new, regex=False)
    qq["PARENT_KEY"] = new
    r, out = run_workflow(tmp_path, {SURVEY: lambda d: pd.concat([d, src], ignore_index=True), QUADRAT: lambda d: pd.concat([d, qq], ignore_index=True)})
    subs = pd.read_csv(out / "submissions.csv")
    assert subs[subs.plot_name == plot].canonical.sum() == 2
    plots = pd.read_csv(out / "plots.csv")
    assert set(plots[plots.plot_name == plot].replicate) == {"lw_baseline", "lw_yr1"}
    rep = pd.read_csv(out / "effort_repeatability.csv")
    assert plot not in set(rep.plot_name)

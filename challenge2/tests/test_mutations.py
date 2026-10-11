"""Mutation tests: each rule must FIRE on a copy of the data with one injected error.

The acceptance tests pin what the rules find in the provided data; for rules that find nothing there
(all-pass rules), only these tests show that the rule can fail at all. Each case copies the exports and
entity lists to a temporary folder, edits one value with pandas, reruns that single rule, and requires a
failure on the edited entity (or at least one failure, for project-level rules).
"""

from __future__ import annotations

import shutil

import pandas as pd
import pytest

from vegqa import checks, engine
from vegqa.load import ENTITIES, EXPORTS, load, read_text
from vegqa.model import canonical_survey_keys, projection
from vegqa.taxonomy import build_occurrences

SURVEY, QUADRAT = "herbaceous_veg_survey.csv", "herbaceous_veg_survey-quadrat_repeat.csv"
EXTRA, REG = "herbaceous_veg_survey-additional_species_repeat.csv", "register_vegetation_plots.csv"


def run_rule(tmp_path, rule_id, edits):
    ex, en = tmp_path / "exports", tmp_path / "entities"
    shutil.copytree(EXPORTS, ex)
    shutil.copytree(ENTITIES, en)
    for fname, fn in edits.items():
        path = (ex if (ex / fname).exists() else en) / fname
        df = read_text(path)
        fn(df)
        df.to_csv(path, index=False)
    d = load(ex, en)
    keys, _ = canonical_survey_keys(d)
    cat = engine.load_catalogue()
    ctx = engine.Ctx(d, build_occurrences(d, keys), keys, projection(d), cat["thresholds"], cat)
    checks.load_all()
    ctx._current = rule_id
    engine.REGISTRY[rule_id](ctx)
    return pd.DataFrame(ctx._rows, columns=engine.RESULT_COLUMNS)


def first(df, mask):
    return df.index[mask][0]


def set_(df, idx, col, value):
    df.loc[idx, col] = value


# ── edits: (file, function(df)) and the key the failure must carry (None = any failure) ──
def e_orphan(df):
    set_(df, 0, "PARENT_KEY", "uuid:does-not-exist")


def e_drop_quadrat(df):
    df.drop(index=0, inplace=True)


def e_quadrat_number(df):
    set_(df, 0, "quadrat_number", "25")


def e_transport(df):
    set_(df, 0, "field_team_specifics-selected_transport_type_uuid", "bogus-uuid")


def e_form_version(df):
    set_(df, 0, "FormVersion", "1")


def e_attachments(df):
    set_(df, 0, "AttachmentsPresent", "0")


def e_instance(df):
    set_(df, 0, "meta-instanceName", "wrong_name")


def e_survey_uuid(df):
    set_(df, 0, "survey_begin-selected_survey_uuid", "586215d7-a037-471f-9b4c-a866f8066278")  # the woody survey


def e_date(df):
    set_(df, 0, "survey_begin-start_time", "2025-01-01T10:00:00.000+02:00")


def e_overlap(df):
    for c in ("survey_begin-start_time", "survey_end-end_time"):
        set_(df, 1, c, df.loc[2, c])  # two visits by the same team at the same time


def e_recorder(df):
    team = df.loc[0, "field_team_specifics-selected_project_team_uuid_multi"].split()
    others = [u for u in ("6cf2cf07-1005-47a3-925d-3d5ac90f72f4", "1bddc7d5-e01b-4155-b940-2e7a5a2deed0", "69eaf9dd-2138-4048-b18d-df95d9cb6411",
                          "de30f3c5-5f70-4f87-b9c7-a8cf6919daca", "3d8e9574-9d4d-4af3-90dd-bd381203f80a", "32c9ea24-1a8d-41d6-8f2e-4a94b08ffacc") if u not in team]
    set_(df, 0, "field_team_specifics-recorder_uuid", others[0])


def herb_id():
    sp = read_text(ENTITIES / "species.csv")
    return sp.loc[sp.groups == "herbaceous", "__id"].iloc[0]


def woody_id():
    sp = read_text(ENTITIES / "species.csv")
    return sp.loc[sp.groups == "woody", "__id"].iloc[0]


def e_woody_pick(df):
    i = first(df, df["herb_species-selected_herb_species_uuids"] != "")
    set_(df, i, "herb_species-selected_herb_species_uuids", df.loc[i, "herb_species-selected_herb_species_uuids"] + " " + woody_id())


def e_herbs_no_with_species(df):
    set_(df, first(df, df.herbs_present == "no"), "herb_species-selected_herb_species_uuids", herb_id())


def e_list_required(df):
    set_(df, first(df, df["herb_species-all_unknown_unidentifiable"] == "no"), "herb_species-selected_herb_species_uuids", "")


def e_all_unknown_with_list(df):
    set_(df, first(df, df["herb_species-all_unknown_unidentifiable"] == "yes"), "herb_species-selected_herb_species_uuids", herb_id())


def e_count(df):
    set_(df, first(df, df.herbs_present == "yes"), "herb_species-count_herb_species", "99")


def e_label_list(df):
    set_(df, first(df, df["species_list-known_species_list"] != ""), "species_list-known_species_list", "Not a species")


def e_macro(df):
    set_(df, first(df, df.species_entry_mode == "new_unknown"), "macro_images-macro_1", "")


def e_canonical_chars(df):
    set_(df, first(df, df.species_entry_mode == "new_missing"), "new_missing_canonical", "Genus (species)")


def e_confirm(df):
    set_(df, 0, "survey_end-confirm_submission", "no")


def e_required_survey(df):
    set_(df, 0, "field_team_specifics-selected_transport_type_uuid", "")


def e_image(df):
    set_(df, 0, "quadrat_image", "")


def e_all_unknown_no_additional(df):
    set_(df, first(df, df["herb_species-all_unknown_unidentifiable"] == "yes"), "additional_species_present", "no")


def e_canopy(df):
    set_(df, first(df, df["plot_metadata-woody_species_present"] == "yes"), "plot_metadata-canopy_height_m", "75")


def e_geohash(df):
    set_(df, first(df, df["plot_selection-plot_name"] == "SavMon_LW_Plot_02"), "plot_selection-geohash", "zzzzzzz")


def e_reg_accuracy(df):
    set_(df, first(df, df["plot_selection-is_plot_viable"] == "yes"), "plot_metadata-collect_points-endpoint_a-location_endpoint_a-Accuracy", "9")


def e_vegplot_geometry(df):
    parts = df.loc[0, "geometry"].split()
    parts[0] = f"{float(parts[0]) + 0.001:.7f}"
    set_(df, 0, "geometry", " ".join(parts))


def e_quadrat_accuracy(df):
    set_(df, 0, "location_quadrat-Accuracy", "12")


def e_photo_outside(df):
    set_(df, 0, "quadrat_image", "1000000000000.jpg")


def e_photo_gap(df):
    a = df[df.PARENT_KEY == df.loc[0, "PARENT_KEY"]].sort_values("quadrat_image")
    i, j = a.index[0], a.index[1]
    set_(df, j, "quadrat_image", f"{int(df.loc[i, 'quadrat_image'].split('.')[0]) + 5000}.jpg")


def e_photo_dup(df):
    set_(df, 1, "quadrat_image", df.loc[0, "quadrat_image"])


def e_index(df):
    set_(df, first(df, df.species_entry_mode == "new_unknown"), "assigned_unknown_index", "999")


def e_choice(df):
    set_(df, first(df, df["plot_metadata-soil_type"] != ""), "plot_metadata-soil_type", "lava")


def e_entity_label(df):
    set_(df, first(df, (df.choice_status == "active") & (df.new_record_reason == "missing_species")), "label", "Edited outside the form")


CASES = [
    ("A01", QUADRAT, e_orphan), ("A03", QUADRAT, e_drop_quadrat), ("A04", QUADRAT, e_quadrat_number), ("A05", SURVEY, e_transport),
    ("A06", QUADRAT, e_woody_pick), ("A07", SURVEY, e_form_version), ("A08", SURVEY, e_attachments), ("A09", SURVEY, e_instance),
    ("B03", SURVEY, e_survey_uuid), ("B07", SURVEY, e_date), ("B08", SURVEY, e_overlap), ("B11", SURVEY, e_recorder),
    ("C01", QUADRAT, e_herbs_no_with_species), ("C02", QUADRAT, e_list_required), ("C03", QUADRAT, e_all_unknown_with_list),
    ("C05", QUADRAT, e_count), ("C06", QUADRAT, e_label_list), ("C09", EXTRA, e_macro), ("C10", EXTRA, e_canonical_chars),
    ("C11", SURVEY, e_confirm), ("C12", SURVEY, e_required_survey), ("C13", QUADRAT, e_image), ("C15", QUADRAT, e_all_unknown_no_additional),
    ("C16", REG, e_canopy), ("C17", REG, e_geohash), ("D06", REG, e_reg_accuracy), ("D07", "vegplots.csv", e_vegplot_geometry),
    ("E01", QUADRAT, e_quadrat_accuracy), ("E08", QUADRAT, e_photo_outside), ("E10", QUADRAT, e_photo_gap), ("E11", QUADRAT, e_photo_dup),
    ("F14", EXTRA, e_index), ("P03", REG, e_choice), ("X01", "species_extra.csv", e_entity_label),
]


@pytest.mark.parametrize("rule_id,fname,edit", CASES, ids=[c[0] for c in CASES])
def test_rule_fires_on_injected_error(tmp_path, rule_id, fname, edit):
    out = run_rule(tmp_path, rule_id, {fname: edit})
    assert (out.status == "fail").any(), f"{rule_id} did not fire on its injected error"


def test_unmutated_copy_gives_no_extra_failures(tmp_path):
    """Control: copying the data alone does not create failures in an all-pass rule."""
    out = run_rule(tmp_path, "C17", {})
    assert set(out[out.status == "fail"].plot_name) == {"SavMon_LW_Plot_01", "SavMon_LW_Plot_04", "SavMon_LW_Plot_15"}

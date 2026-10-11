"""Load the ODK exports and entity lists, untouched, and add interpreted ("staged") columns.

Principle: never change a source value. Every table is read as text (so the raw values are exactly
what the export contains); interpreted values (timestamps, numbers, lists, coordinates) are added as
NEW columns with a `_` prefix next to the raw ones. A value that cannot be interpreted leaves the new
column empty; the checks turn that into a flag. Nothing is guessed or repaired.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[3]
DATA = ROOT / "Data Vegetation"
EXPORTS = DATA / "ODK Data Exports"
ENTITIES = DATA / "Entity lists"
FORMS = DATA / "ODK Data Collection Forms"

EXPORT_FILES = {
    "survey": "herbaceous_veg_survey.csv",
    "quadrat": "herbaceous_veg_survey-quadrat_repeat.csv",
    "extra": "herbaceous_veg_survey-additional_species_repeat.csv",
    "registration": "register_vegetation_plots.csv",
}
ENTITY_FILES = ["areas", "centroids", "ecosystem_types", "project_team", "projects", "species", "species_extra", "species_extra_ids", "surveys", "transport", "vegplots"]

# short names for the long ODK column paths used throughout (raw names stay in the tables too)
SURVEY_COLS = {
    "transport_uuid": "field_team_specifics-selected_transport_type_uuid",
    "team_uuids": "field_team_specifics-selected_project_team_uuid_multi",
    "recorder_uuid": "field_team_specifics-recorder_uuid",
    "recorder_label": "field_team_specifics-recorder_label",
    "start_time": "survey_begin-start_time",
    "survey_year": "survey_begin-survey_year",
    "survey_uuid": "survey_begin-selected_survey_uuid",
    "survey_label": "survey_begin-get_survey_label",
    "baseline_year": "survey_begin-baseline_year",
    "replicate_index": "survey_begin-replicate_index",
    "replicate": "survey_begin-replicate",
    "target_group": "survey_begin-target_group",
    "area_label": "survey_begin-area_label",
    "plot_uuid": "plot_selection-selected_plot_uuid",
    "plot_name": "plot_selection-plot_name",
    "plot_status": "plot_selection-get_plot_status",
    "quadrat_repeat_count": "observations-quadrat_repeat_count",
    "base_active_herb_count": "base_active_herb_count",
    "new_unknown_index_list": "new_unknown_index_list",
    "new_missing_index_list": "new_missing_index_list",
    "quadrats_with_species": "survey_end-quadrats_with_species",
    "bg_lat": "survey_end-background_geopoint-Latitude",
    "bg_lon": "survey_end-background_geopoint-Longitude",
    "bg_alt": "survey_end-background_geopoint-Altitude",
    "bg_acc": "survey_end-background_geopoint-Accuracy",
    "confirm": "survey_end-confirm_submission",
    "notes": "survey_end-herbaceous_veg_notes",
    "end_time": "survey_end-end_time",
}
QUADRAT_COLS = {
    "quadrat_number": "quadrat_number",
    "herbs_present": "herbs_present",
    "all_unknown": "herb_species-all_unknown_unidentifiable",
    "species_uuids": "herb_species-selected_herb_species_uuids",
    "count_herb_species": "herb_species-count_herb_species",
    "additional_present": "additional_species_present",
    "known_species_list": "species_list-known_species_list",
    "additional_species_list": "species_list-additional_species_list",
    "all_species_list": "species_list-all_species_list",
    "image": "quadrat_image",
    "lat": "location_quadrat-Latitude",
    "lon": "location_quadrat-Longitude",
    "alt": "location_quadrat-Altitude",
    "acc": "location_quadrat-Accuracy",
    "comment": "quadrat_comment",
}
REG_PT = "plot_metadata-collect_points-{p}-location_{p}-{c}"
REG_COLS = {
    "transport_uuid": "field_team_specifics-selected_transport_type_uuid",
    "team_uuids": "field_team_specifics-selected_project_team_uuid_multi",
    "recorder_uuid": "field_team_specifics-recorder_uuid",
    "start_time": "survey_begin-start_time",
    "survey_uuids": "survey_begin-selected_survey_uuid_multi",
    "plot_uuid": "plot_selection-selected_plot_uuid",
    "plot_name": "plot_selection-plot_name",
    "sample_status": "plot_selection-sample_status",
    "stratum": "plot_selection-stratum_label",
    "viable": "plot_selection-is_plot_viable",
    "establishment_notes": "plot_selection-plot_establishment_notes",
    "establishment_notes_end": "survey_end-plot_establishment_notes",
    "ecosystem_uuid": "plot_metadata-selected_ecosystem_type_uuid",
    "ecosystem": "plot_metadata-ecosystem_type_name",
    "woody_present": "plot_metadata-woody_species_present",
    "known_woody_present": "plot_metadata-known_dominant_woody_species_present",
    "known_woody": "plot_metadata-known_dominant_woody_species",
    "unknown_woody_present": "plot_metadata-unknown_dominant_woody_species_present",
    "unknown_woody": "plot_metadata-unknown_dominant_woody_species",
    "canopy_height_m": "plot_metadata-canopy_height_m",
    "canopy_structure": "plot_metadata-canopy_structure",
    "soil_type": "plot_metadata-soil_type",
    "ground_cover": "plot_metadata-ground_cover",
    "water_present": "plot_metadata-water_present",
    "disturbance": "plot_metadata-disturbance_types",
    "transect": "plot_metadata-collect_points-vegplot_transect",
    "confirm": "survey_end-confirm_submission",
    "bg_lat": "survey_end-background_geopoint-Latitude",
    "bg_lon": "survey_end-background_geopoint-Longitude",
    "bg_acc": "survey_end-background_geopoint-Accuracy",
    "end_time": "survey_end-end_time",
}


def _ts(s: pd.Series) -> pd.Series:
    """ODK timestamps (with an offset or Z) as UTC instants; unparseable -> NaT (flagged later)."""
    return pd.to_datetime(s.replace("", np.nan), utc=True, errors="coerce", format="ISO8601")


def _num(s: pd.Series) -> pd.Series:
    return pd.to_numeric(s.replace("", np.nan), errors="coerce")


def _photo_time(s: pd.Series) -> pd.Series:
    """ODK names images by capture time in epoch milliseconds (e.g. 1779868793110.jpg)."""
    return pd.to_datetime(_num(s.str.extract(r"^(\d{12,13})\.")[0]), unit="ms", utc=True, errors="coerce")


def _tokens(s: pd.Series) -> pd.Series:
    """Space-separated ODK multi-selects as lists (empty -> [])."""
    return s.fillna("").map(lambda v: v.split() if v.strip() else [])


@dataclass
class Data:
    raw: dict[str, pd.DataFrame] = field(default_factory=dict)  # exactly as exported (text)
    ent: dict[str, pd.DataFrame] = field(default_factory=dict)  # entity lists (text)
    survey: pd.DataFrame | None = None  # staged views: raw columns + interpreted `_` columns
    quadrat: pd.DataFrame | None = None
    extra: pd.DataFrame | None = None
    registration: pd.DataFrame | None = None


def read_text(path: Path) -> pd.DataFrame:
    return pd.read_csv(path, dtype=str, keep_default_na=False)


def load(exports: Path = EXPORTS, entities: Path = ENTITIES) -> Data:
    d = Data()
    for k, f in EXPORT_FILES.items():
        d.raw[k] = read_text(exports / f)
    for k in ENTITY_FILES:
        d.ent[k] = read_text(entities / f"{k}.csv")

    # survey submissions
    s = d.raw["survey"].copy()
    for short, col in SURVEY_COLS.items():
        s[short] = s[col]
    s["_start"], s["_end"], s["_submitted"] = _ts(s.start_time), _ts(s.end_time), _ts(s.SubmissionDate)
    s["_offset"] = s.start_time.str.extract(r"([+-]\d{2}:\d{2}|Z)$")[0]
    for c in ("bg_lat", "bg_lon", "bg_alt", "bg_acc", "quadrat_repeat_count", "base_active_herb_count", "quadrats_with_species", "replicate_index", "survey_year", "baseline_year"):
        s["_" + c] = _num(s[c])
    s["_team"] = _tokens(s.team_uuids)
    s["_duration_min"] = (s._end - s._start).dt.total_seconds() / 60
    s["_delay_h"] = (s._submitted - s._end).dt.total_seconds() / 3600
    s["_device"] = s.DeviceID.str.replace("collect:", "", regex=False)
    d.survey = s

    # quadrats
    q = d.raw["quadrat"].copy()
    for short, col in QUADRAT_COLS.items():
        q[short] = q[col]
    for c in ("quadrat_number", "count_herb_species", "lat", "lon", "alt", "acc"):
        q["_" + c] = _num(q[c])
    q["_species"] = _tokens(q.species_uuids)
    q["_photo_time"] = _photo_time(q.image)
    d.quadrat = q

    # additional species rows
    e = d.raw["extra"].copy()
    e["entry_mode"] = e.species_entry_mode  # not "mode": DataFrame.mode is a method
    for c in ("observation_index", "count_prior_new_in_submission", "assigned_unknown_index"):
        e["_" + c] = _num(e[c])
    d.extra = e

    # plot registrations
    r = d.raw["registration"].copy()
    for short, col in REG_COLS.items():
        r[short] = r[col]
    for p in ("endpoint_a", "midpoint", "endpoint_b"):
        for c in ("Latitude", "Longitude", "Altitude", "Accuracy"):
            r[f"_{p}_{c[:3].lower()}"] = _num(r[REG_PT.format(p=p, c=c)])
    r["_start"], r["_end"], r["_submitted"] = _ts(r.start_time), _ts(r.end_time), _ts(r.SubmissionDate)
    r["_survey_uuids"] = _tokens(r.survey_uuids)
    r["_team"] = _tokens(r.team_uuids)
    for c in ("bg_lat", "bg_lon", "bg_acc"):
        r["_" + c] = _num(r[c])
    r["_device"] = r.DeviceID.str.replace("collect:", "", regex=False)
    for p, col in (("endpoint_a", "image_endpoint_a"), ("midpoint", "image_midpoint_toward_a"), ("endpoint_b", "image_endpoint_b")):
        r[f"_{p}_photo_time"] = _photo_time(r[f"plot_metadata-collect_points-{p}-{col}"])
    d.registration = r

    # entity geometries ("lat lon alt acc") as numbers
    c = d.ent["centroids"]
    g = c.geometry.str.split(expand=True)
    c["_lat"], c["_lon"] = _num(g[0]), _num(g[1])
    v = d.ent["vegplots"]
    g = v.geometry.str.split(expand=True)
    v["_lat"], v["_lon"] = _num(g[0]), _num(g[1])
    v["_survey_uuids"] = _tokens(v.survey_uuids)
    # a survey selects a vegplot entity; a registration selects a centroid. vegplots.plot_uuid links them.
    d.survey["_centroid_uuid"] = d.survey.plot_uuid.map(v.set_index("__id").plot_uuid).fillna("")
    return d

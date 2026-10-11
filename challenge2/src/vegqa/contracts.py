"""Input contract: the files and columns the pipeline needs, checked BEFORE any analysis.

A missing file or column is a broken export, not a data-quality finding: the run stops with one message
listing everything that is missing, instead of failing half-way or producing partial outputs. Values
inside the columns are never judged here; that is what the rules are for.
"""

from __future__ import annotations

from pathlib import Path

from .load import ENTITY_FILES, EXPORT_FILES, QUADRAT_COLS, REG_COLS, REG_PT, SURVEY_COLS, read_text

FORM_FILES = ("herbaceous_veg_survey.xlsx", "register_vegetation_plots.xlsx")

REQUIRED_COLUMNS = {
    "survey": set(SURVEY_COLS.values()) | {"KEY", "SubmissionDate", "ReviewState", "DeviceID", "FormVersion", "AttachmentsPresent", "AttachmentsExpected", "meta-instanceName"},
    "quadrat": set(QUADRAT_COLS.values()) | {"KEY", "PARENT_KEY"},
    "extra": {"KEY", "PARENT_KEY", "species_entry_mode", "target_extra_name", "select_reuse_unknown", "select_reuse_missing", "validated_name",
              "new_missing_canonical", "assigned_unknown_index", "count_prior_new_in_submission", "observation_index", "entity_label_to_write"},
    "registration": set(REG_COLS.values()) | {REG_PT.format(p=p, c=c) for p in ("endpoint_a", "midpoint", "endpoint_b") for c in ("Latitude", "Longitude", "Altitude", "Accuracy")}
    | {"KEY", "SubmissionDate", "ReviewState", "DeviceID", "FormVersion", "Edits"},
}
REQUIRED_ENTITY_COLUMNS = {
    "centroids": {"__id", "choice_name", "geometry", "sample_status", "stratum_label", "geohash"},
    "vegplots": {"__id", "plot_uuid", "geometry", "survey_uuids", "is_viable", "replicate"},
    "species": {"__id", "label", "groups"},
    "species_extra": {"__id", "label", "group_type", "unknown_index", "choice_status", "new_record_reason"},
    "species_extra_ids": {"species_number", "species_name", "notes", "label"},
    "surveys": {"__id", "label", "target_group", "baseline_year"},
    "project_team": {"__id", "label", "choice_status"},
}


class InputContractError(RuntimeError):
    pass


def check_inputs(exports: Path, entities: Path, forms: Path) -> None:
    problems = []
    for key, fname in EXPORT_FILES.items():
        p = Path(exports) / fname
        if not p.exists():
            problems.append(f"missing export {fname}")
            continue
        cols = set(read_text(p).columns)
        miss = sorted(REQUIRED_COLUMNS[key] - cols)
        if miss:
            problems.append(f"{fname}: missing columns {miss}")
    for name in ENTITY_FILES:
        p = Path(entities) / f"{name}.csv"
        if not p.exists():
            problems.append(f"missing entity list {name}.csv")
            continue
        miss = sorted(REQUIRED_ENTITY_COLUMNS.get(name, {"__id"}) - set(read_text(p).columns))
        if miss:
            problems.append(f"{name}.csv: missing columns {miss}")
    for fname in FORM_FILES:
        if not (Path(forms) / fname).exists():
            problems.append(f"missing form {fname}")
    if problems:
        raise InputContractError("input contract not met; nothing was analysed:\n  - " + "\n  - ".join(problems))

"""Parse the ODK XLSForms, so checks compare the data against the form's own definitions
(versions, choice lists, required / constraint / relevant expressions) instead of hard-coded copies."""

from __future__ import annotations

import warnings
from functools import lru_cache

import pandas as pd

from .load import FORMS

FORM_FILES = {"herbaceous_veg_survey": "herbaceous_veg_survey.xlsx", "register_vegetation_plots": "register_vegetation_plots.xlsx"}


@lru_cache(maxsize=None)
def sheet(form: str, name: str) -> pd.DataFrame:
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")  # openpyxl: "Data Validation extension is not supported"
        return pd.read_excel(FORMS / FORM_FILES[form], sheet_name=name, dtype=str).fillna("")


def form_version(form: str) -> str:
    return sheet(form, "settings").version.iloc[0]


def choices(form: str) -> dict[str, list[str]]:
    c = sheet(form, "choices")
    return {k: g.name.tolist() for k, g in c.groupby("list_name")}


def fields(form: str) -> pd.DataFrame:
    """Survey rows with a parsed type: base type and choice list (select_one yes_no -> ('select_one', 'yes_no'))."""
    s = sheet(form, "survey").copy()
    t = s["type"].str.strip().str.split(r"\s+", n=1, expand=True)
    s["base_type"], s["list_name"] = t[0], t[1].fillna("") if 1 in t else ""
    return s


def select_fields(form: str) -> pd.DataFrame:
    """Select questions whose choices come from the form's own choices sheet (not from a CSV file)."""
    f = fields(form)
    return f[f.base_type.isin(["select_one", "select_multiple"]) & ~f.list_name.str.endswith(".csv")][["name", "base_type", "list_name"]]


def design_issues(form: str) -> list[str]:
    """XLSForm design problems worth reporting to NS (not data errors)."""
    issues = []
    f = fields(form)
    named = f[f.name.str.strip() != ""]
    dup = named[named.name.duplicated(keep=False)]
    for n in sorted(dup.name.unique()):
        issues.append(f"{form}: field name '{n}' used {int((named.name == n).sum())} times")
    for list_name, names in choices(form).items():
        for n in names:
            if " " in str(n).strip():
                issues.append(f"{form}: choice name '{n}' in list '{list_name}' contains a space")
    return issues

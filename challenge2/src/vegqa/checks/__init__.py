"""All QA/QC rules, one function per rule id in rules/rules.yaml (registered when their module is imported)."""

import importlib

MODULES = ["a_structure", "b_lifecycle", "c_form", "d_registration", "e_quadrats", "f_taxonomy", "g_plausibility", "jkp_plan_platform_profile", "x_crossref"]


def load_all():
    for m in MODULES:
        importlib.import_module(f"{__name__}.{m}")

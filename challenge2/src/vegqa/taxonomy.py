"""Occurrences (quadrat x taxon) in two layers: raw (as recorded) and resolved (via NS's curation).

Sources of an occurrence:
  * "list":  a species picked from the project list (quadrat.selected_herb_species_uuids -> species.csv)
  * "extra": an additional-species row: a new or reused provisional entity in species_extra
             (herb_NNN unknowns, or typed canonicals for species missing from the list)

Resolution uses only NS's own curation table (species_extra_ids, keyed by herb_NNN/wood_NNN): its
species_name, plus its free-text notes parsed into structured actions ("duplicate of X" -> merge into
X; "should be excluded" -> exclude). Resolution applies provided reference data; it never corrects a
name. Misspellings stay as recorded and are flagged by the checks (F01/F03/F13).
"""

from __future__ import annotations

import re

import numpy as np
import pandas as pd

from .load import Data


def norm_name(s: str) -> str:
    """Matching key only (never shown as a correction): lower-case, underscores as spaces, single spaces."""
    return re.sub(r"\s+", " ", str(s).replace("_", " ")).strip().lower()


def slot_number(group_type: str, unknown_index) -> str:
    """species_extra slot -> curation key, e.g. ('herb', 72) -> 'herb_072'."""
    try:
        return f"{'wood' if group_type == 'woody' else 'herb'}_{int(float(unknown_index)):03d}"
    except (TypeError, ValueError):
        return ""


def curation_actions(si: pd.DataFrame) -> pd.DataFrame:
    """species_extra_ids with its notes parsed into merge_into / exclude columns."""
    c = si.copy()
    c["merge_into"] = c.notes.str.extract(r"duplicate of\s+((?:herb|wood)_\d{3})", flags=re.I)[0].fillna("")
    c["exclude"] = c.notes.str.contains(r"exclud", case=False, regex=True)
    c["unresolved"] = c.species_name.str.strip().str.lower().eq("unknown")
    return c.set_index("species_number")


def build_occurrences(d: Data, canonical_keys: set[str] | None = None) -> pd.DataFrame:
    """One row per recorded occurrence, with raw and resolved taxon. `canonical_keys`: submission KEYs
    used for metrics (others are kept, marked canonical=False)."""
    s = d.survey.set_index("KEY")
    q = d.quadrat
    sp = d.ent["species"].set_index("__id")
    se = d.ent["species_extra"].set_index("__id")
    cur = curation_actions(d.ent["species_extra_ids"])

    rows = []
    # list occurrences
    # (zip over columns: itertuples() renames columns that start with "_")
    for parent, key, species in zip(q.PARENT_KEY, q.KEY, q._species):
        for u in species:
            known = u in sp.index
            rows.append({
                "source": "list", "survey_key": parent, "quadrat_key": key, "extra_key": "", "entry_mode": "list",
                "taxon_ref": u, "raw_name": sp.label.get(u, "") if known else "", "raw_group": sp.groups.get(u, "") if known else "",
                "slot_number": "", "ref_resolves": known,
            })
    # additional-species occurrences
    e = d.extra
    for r in e.itertuples():
        slot = r.target_extra_name if r.entry_mode in ("new_unknown", "new_missing") else (r.select_reuse_unknown if r.entry_mode == "reuse_unknown" else r.select_reuse_missing)
        known = bool(slot) and slot in se.index
        num = slot_number(se.group_type.get(slot, ""), se.unknown_index.get(slot, "")) if known else ""
        rows.append({
            "source": "extra", "survey_key": "", "quadrat_key": r.PARENT_KEY, "extra_key": r.KEY, "entry_mode": r.entry_mode,
            "taxon_ref": slot, "raw_name": r.validated_name, "raw_group": se.group_type.get(slot, "") if known else "",
            "slot_number": num, "ref_resolves": known,
        })
    o = pd.DataFrame(rows)
    qk = q.set_index("KEY")
    o.loc[o.source == "extra", "survey_key"] = o.loc[o.source == "extra", "quadrat_key"].map(qk.PARENT_KEY)
    o["quadrat_number"] = o.quadrat_key.map(qk._quadrat_number)
    o["plot_name"] = o.survey_key.map(s.plot_name)
    o["canonical_survey"] = o.survey_key.isin(canonical_keys) if canonical_keys is not None else True
    o.insert(0, "occurrence_id", o.quadrat_key + "|" + np.where(o.source == "list", "L:" + o.taxon_ref, "X:" + o.extra_key))

    # resolution
    def resolve(r):
        if r.source == "list":
            name = r.raw_name
            return name, norm_name(name), "identified" if name else "unresolvable", ""
        if not r.slot_number:
            return "", "", "unresolvable", "slot not found"
        num, note, seen = r.slot_number, "", set()
        while num in cur.index and cur.loc[num, "merge_into"] and num not in seen:  # follow merge chains
            seen.add(num)
            note += f"{num} merged into {cur.loc[num, 'merge_into']}; "
            num = cur.loc[num, "merge_into"]
        if num in cur.index and cur.loc[num, "exclude"] or (r.slot_number in cur.index and cur.loc[r.slot_number, "exclude"]):
            return "", "", "excluded", note + "curation: exclude"
        if num in cur.index and not cur.loc[num, "unresolved"]:
            name = cur.loc[num, "species_name"]
            return name, norm_name(name), "identified", note.strip()
        if num in cur.index:
            return num, num, "unknown_unresolved", note.strip()
        # not in the curation table: keep the recorded name (a typed canonical) or the slot number
        if r.entry_mode in ("new_missing", "reuse_missing") and r.raw_name:
            return r.raw_name, norm_name(r.raw_name), "identified_uncurated", note.strip()
        return num, num, "unknown_uncurated", note.strip()

    res = o.apply(resolve, axis=1, result_type="expand")
    o["resolved_name"], o["resolved_key"], o["resolved_status"], o["curation_note"] = res[0], res[1], res[2], res[3]
    o["raw_key"] = np.where(o.source == "list", o.taxon_ref, o.slot_number.where(o.slot_number != "", o.taxon_ref))
    return o

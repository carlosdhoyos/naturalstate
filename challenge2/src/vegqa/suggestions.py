"""Suggested updates to the project species list and the curation table, for Natural State's curators.

A suggestion file, never an edit: every row names the evidence (rule ids, GBIF match and counts, records)
and leaves the decision to NS. Actions:

  add_to_list          identified taxon recorded as "missing" (typed in the field or curated from an
                       unknown) that is not on the project list; suggested name = GBIF accepted spelling
  confirm_spelling     the name as recorded or curated differs from the GBIF backbone (fuzzy match) or
                       has no species-level match
  merge_with_list      a provisional id whose curated name is already a list species (merge in the
                       resolved layer; reuse the list species in the field)
  merge_provisional    several provisional ids resolve to one name
  check_range          an identified taxon with no GBIF record in the project country
"""

from __future__ import annotations

import pandas as pd

from .gbif import load_cache
from .taxonomy import norm_name

COLUMNS = ["action", "name_as_recorded", "suggested_name", "provisional_ids", "records", "plots", "gbif_match", "gbif_status",
           "gbif_records_country", "gbif_records_contrast", "rules", "evidence"]


def build(ctx) -> pd.DataFrame:
    th = ctx.th
    country = th["range_country"]
    g = load_cache()["names"]
    sp = ctx.data.ent["species"]
    on_list = {norm_name(x) for x in sp.label}
    occ = ctx.occ[ctx.occ.canonical_survey]
    ident = occ[occ.resolved_status.isin(["identified", "identified_uncurated"])]

    def gb(name):
        c = g.get(str(name).strip(), {})
        return c, (c.get("canonicalName") if c.get("matchType") in ("EXACT", "FUZZY") and c.get("rank") in ("SPECIES", "SUBSPECIES", "VARIETY") else "")

    rows = []
    for name, grp in ident.groupby("resolved_name"):
        c, can = gb(name)
        ids = " ".join(sorted(set(grp.slot_number) - {""}))
        base = {"name_as_recorded": name, "provisional_ids": ids, "records": len(grp), "plots": grp.plot_name.nunique(), "gbif_match": c.get("matchType", "not cached"),
                "gbif_status": c.get("status", ""), "gbif_records_country": c.get(f"count_{country}"), "gbif_records_contrast": c.get("count_contrast")}
        listed = norm_name(name) in on_list
        if ids and not listed and not (can and norm_name(can) in on_list):
            rows.append({**base, "action": "add_to_list", "suggested_name": can or name, "rules": "F02",
                         "evidence": "recorded as a provisional taxon and identified; not on the project list" + (f"; GBIF spelling {can!r}" if can and norm_name(can) != norm_name(name) else "")})
        if c.get("matchType") == "FUZZY" and can and norm_name(can) != norm_name(name):
            rows.append({**base, "action": "confirm_spelling", "suggested_name": can, "rules": "F03 F13", "evidence": f"GBIF backbone fuzzy match: {can!r}"})
        elif c.get("matchType") in ("HIGHERRANK", "NONE"):
            rows.append({**base, "action": "confirm_spelling", "suggested_name": "", "rules": "F03 F13",
                         "evidence": f"no species-level match in GBIF (matched only at {str(c.get('rank', 'no')).lower()} rank)"})
        if ids and listed:
            rows.append({**base, "action": "merge_with_list", "suggested_name": name, "rules": "F02",
                         "evidence": f"provisional id(s) {ids} curated to a species already on the list: reuse the list species in the field"})
        if len(set(grp.slot_number) - {""}) > 1:
            rows.append({**base, "action": "merge_provisional", "suggested_name": can or name, "rules": "F04 F08",
                         "evidence": f"{len(set(grp.slot_number) - {''})} provisional ids resolve to one name"})
        if c.get(f"count_{country}") == 0:
            rows.append({**base, "action": "check_range", "suggested_name": can or name, "rules": "F10",
                         "evidence": f"no GBIF record in {country}; {c.get('count_contrast')} in {'/'.join(th['range_contrast_countries'])}: verify the identification"})
    out = pd.DataFrame(rows, columns=COLUMNS)
    order = {"confirm_spelling": 0, "add_to_list": 1, "merge_with_list": 2, "merge_provisional": 3, "check_range": 4}
    return out.sort_values(["action", "records"], key=lambda s: s.map(order) if s.name == "action" else -s).reset_index(drop=True)

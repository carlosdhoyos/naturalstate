"""Suggested updates to the project species list and the curation table, for Natural State's curators.

A suggestion file, never an edit: every row names the evidence (rule ids, GBIF match and counts, records)
and leaves the decision to NS. Actions:

  confirm_spelling     the name as recorded or curated differs from the GBIF backbone (fuzzy match)
  verify_name          no species-level match in GBIF: the name itself must be checked before any use
  add_to_list          a provisional taxon, identified, not on the project list, with a GBIF species
                       match and GBIF records in the project country
  verify_before_adding as add_to_list, but with no GBIF record in the project country: confirm the
                       identification (and the source of the list) before adding it
  merge_with_list      a provisional id whose taxon is already a list species (merge in the resolved
                       layer; reuse the list species in the field)
  merge_provisional    several provisional ids are one species (grouped by GBIF species, so spelling
                       variants such as Polygalaerioptera / Polygala erioptera count as one)
  check_range          a list species recorded here with no GBIF record in the project country

Taxa are grouped by their GBIF species (accepted spelling), falling back to the name as written when
GBIF has no species-level match, so one species never gets two contradictory rows.
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
    on_list = {norm_name(x) for x in ctx.data.ent["species"].label}
    occ = ctx.occ[ctx.occ.canonical_survey]
    ident = occ[occ.resolved_status.isin(["identified", "identified_uncurated"])].copy()

    def gb(name):
        c = g.get(str(name).strip(), {})
        sp = c.get("matchType") in ("EXACT", "FUZZY") and c.get("rank") in ("SPECIES", "SUBSPECIES", "VARIETY")
        return c, (c.get("canonicalName") if sp else "")

    ident["gbif_name"] = ident.resolved_name.map(lambda n: gb(n)[1])
    ident["group"] = [norm_name(gn or n) for gn, n in zip(ident.gbif_name, ident.resolved_name)]
    rows = []
    for key, grp in ident.groupby("group"):
        names = sorted(set(grp.resolved_name))
        c, can = gb(names[0])
        for n in names[1:]:  # prefer the name GBIF matches exactly
            cn, _ = gb(n)
            if cn.get("matchType") == "EXACT":
                c, can = cn, gb(n)[1]
        ids = sorted(set(grp.slot_number) - {""})
        listed = key in on_list or any(norm_name(n) in on_list for n in names)
        here = c.get(f"count_{country}")
        base = {"name_as_recorded": " / ".join(names), "provisional_ids": " ".join(ids), "records": len(grp), "plots": grp.plot_name.nunique(),
                "gbif_match": c.get("matchType", "not cached"), "gbif_status": c.get("status", ""), "gbif_records_country": here,
                "gbif_records_contrast": c.get("count_contrast")}
        for n in names:
            cn, cann = gb(n)
            if cn.get("matchType") == "FUZZY" and cann and norm_name(cann) != norm_name(n):
                rows.append({**base, "name_as_recorded": n, "action": "confirm_spelling", "suggested_name": cann, "rules": "F03 F13", "evidence": f"GBIF backbone fuzzy match: {cann!r}"})
        if not can:
            rows.append({**base, "action": "verify_name", "suggested_name": "", "rules": "F03 F13",
                         "evidence": f"no species-level match in GBIF (matched only at {str(c.get('rank', 'no')).lower()} rank): check the name before adding or merging"})
            continue
        if len(ids) > 1:
            rows.append({**base, "action": "merge_provisional", "suggested_name": can, "rules": "F04 F08", "evidence": f"{len(ids)} provisional ids are one species"})
        if ids and listed:
            rows.append({**base, "action": "merge_with_list", "suggested_name": can, "rules": "F02",
                         "evidence": f"provisional id(s) {' '.join(ids)} are a species already on the list: reuse the list species in the field"})
        elif ids:
            if here:
                rows.append({**base, "action": "add_to_list", "suggested_name": can, "rules": "F02", "evidence": f"identified provisional taxon, not on the list; {here} GBIF records in {country}"})
            else:
                rows.append({**base, "action": "verify_before_adding", "suggested_name": can, "rules": "F02 F10",
                             "evidence": f"identified provisional taxon, not on the list, but no GBIF record in {country} ({c.get('count_contrast')} in {'/'.join(th['range_contrast_countries'])}): confirm the identification first"})
        elif here == 0:
            rows.append({**base, "action": "check_range", "suggested_name": can, "rules": "F10",
                         "evidence": f"list species with no GBIF record in {country}; {c.get('count_contrast')} in {'/'.join(th['range_contrast_countries'])}: verify the identification or the list"})
    out = pd.DataFrame(rows, columns=COLUMNS)
    order = {"confirm_spelling": 0, "verify_name": 1, "merge_provisional": 2, "merge_with_list": 3, "add_to_list": 4, "verify_before_adding": 5, "check_range": 6}
    return out.assign(_o=out.action.map(order)).sort_values(["_o", "records"], ascending=[True, False]).drop(columns="_o").reset_index(drop=True)

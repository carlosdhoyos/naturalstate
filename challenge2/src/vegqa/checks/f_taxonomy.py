"""F. Species and taxonomy, on two layers (V-02): raw (as recorded) and resolved (NS's curation table).

Spelling evidence comes from three independent sources, so a name is never "corrected" by us:
  * the GBIF backbone match, read from the cached reference file (vegqa.gbif; never called during a run),
  * similarity to a name on the project species list,
  * the curators' own change of the name in species_extra_ids.
"""

from __future__ import annotations

import re
from difflib import SequenceMatcher

import pandas as pd

from ..engine import rows, rule
from ..gbif import load_cache
from ..taxonomy import curation_actions, norm_name, slot_number

NEW_MODES = ("new_unknown", "new_missing")
BINOMIAL = re.compile(r"^[A-Z][a-z-]+ [a-z-]+( [a-z-]+)*$")
WOODY_NOTE = re.compile(r"wood", re.I)


def _ratio(a: str, b: str) -> float:
    return SequenceMatcher(None, norm_name(a), norm_name(b)).ratio()


def _gbif(ctx) -> dict:
    return ctx.cached("gbif", lambda: load_cache()["names"])


def _list_names(ctx) -> dict:
    sp = ctx.data.ent["species"]
    return ctx.cached("list_names", lambda: {norm_name(l): l for l in sp.label})


def _closest(name: str, candidates, min_ratio: float):
    best, score = None, 0.0
    for c in candidates:
        s = _ratio(name, c)
        if s > score and norm_name(c) != norm_name(name):
            best, score = c, s
    return (best, score) if score >= min_ratio else (None, score)


def _extra(ctx) -> pd.DataFrame:
    """Additional-species rows with survey key, plot, quadrat number, slot number, and the survey's review state."""
    def build():
        d = ctx.data
        q = d.quadrat.set_index("KEY")
        s = d.survey.set_index("KEY")
        se = d.ent["species_extra"].set_index("__id")
        e = d.extra.copy()
        e["survey"] = e.PARENT_KEY.map(q.PARENT_KEY)
        e["qn"] = e.PARENT_KEY.map(q._quadrat_number)
        e["plot_name"] = e.survey.map(s.plot_name)
        e["review"] = e.survey.map(s.ReviewState)
        e["start"] = e.survey.map(s._start)
        e["base"] = e.survey.map(s._base_active_herb_count)
        e["slot"] = [t if m in NEW_MODES else (u if m == "reuse_unknown" else (x if m == "reuse_missing" else ""))
                     for m, t, u, x in zip(e.entry_mode, e.target_extra_name, e.select_reuse_unknown, e.select_reuse_missing)]
        e["num"] = [slot_number(se.group_type.get(k, ""), se.unknown_index.get(k, "")) if k in se.index else "" for k in e.slot]
        return e.sort_values(["start", "survey", "qn", "_observation_index"])
    return ctx.cached("extra_enriched", build)


def _occ_add(ctx, status, r, observed, expected, message="", severity=None):
    ctx.add(status, "occurrence", r.occurrence_id, plot_name=r.plot_name, survey_key=r.survey_key,
            source_table="quadrat_repeat" if r.source == "list" else "additional_species_repeat", source_key=r.extra_key or r.quadrat_key,
            observed=observed, expected=expected, message=message, severity=severity)


@rule("F01")
def canonical_format(ctx):
    for r in rows(_extra(ctx)[lambda x: x.entry_mode == "new_missing"]):
        n = r.new_missing_canonical
        p = []
        if n != n.strip():
            p.append("leading/trailing space")
        if "  " in n:
            p.append("double space")
        if "_" in n:
            p.append("underscore (SOP style; the form/data use spaces)")
        core = n.strip().replace("_", " ")
        if not BINOMIAL.match(core):
            p.append("not 'Genus epithet' (capitalised genus, lower-case epithet, letters/hyphen only)")
        ctx.add("fail" if p else "pass", "additional_species", r.KEY, plot_name=r.plot_name, survey_key=r.survey, source_table="additional_species_repeat",
                source_key=r.KEY, observed=repr(n) + (": " + "; ".join(p) if p else ""), expected="Genus epithet, single spaces, no padding")


@rule("F02")
def missing_but_on_list(ctx):
    names = _list_names(ctx)
    for r in rows(_extra(ctx)[lambda x: x.entry_mode == "new_missing"]):
        hit = names.get(norm_name(r.new_missing_canonical))
        ctx.add("fail" if hit else "pass", "additional_species", r.KEY, plot_name=r.plot_name, survey_key=r.survey, source_table="additional_species_repeat",
                source_key=r.KEY, observed=f"typed {r.new_missing_canonical!r}" + (f" = list species {hit!r}" if hit else ""), expected="not on the project list",
                message="should have been selected from the list; one taxon split into two keys" if hit else "")
    cur = curation_actions(ctx.data.ent["species_extra_ids"])
    for num, c in cur.iterrows():
        if c.unresolved:
            continue
        hit = names.get(norm_name(c.species_name))
        ctx.add("fail" if hit else "pass", "curated_taxon", num, source_table="species_extra_ids", source_key=num,
                observed=f"{num} curated as {c.species_name!r}" + (" (on the project list)" if hit else ""), expected="provisional taxa not already on the list",
                message="merges with the list taxon in the resolved layer" if hit else "", severity="info" if hit else None)


def _spelling_evidence(ctx, name: str):
    """Return (evidence, could_check, gbif_exact) for one name. A GBIF exact match outranks similarity to
    another name (two valid species of one genus are often similar, e.g. Eragrostis pilosa / viscosa)."""
    ev, could = [], False
    g = _gbif(ctx).get(name.strip())
    exact = bool(g) and g.get("matchType") == "EXACT"
    if g:
        could = True
        mt, can = g.get("matchType"), g.get("canonicalName") or ""
        if mt == "FUZZY" and norm_name(can) != norm_name(name):
            ev.append(f"GBIF fuzzy match: {can!r}")
        elif mt in ("HIGHERRANK", "NONE"):
            ev.append(f"not found in the GBIF backbone (matched only at {(g.get('rank') or 'no').lower()} rank)")
    if not exact:
        near, score = _closest(name, list(_list_names(ctx).values()), ctx.th["fuzzy_name_ratio"])
        could = could or near is not None
        if near:
            ev.append(f"{score:.2f} similar to list species {near!r}")
    return ev, could, exact


@rule("F03")
def misspelled_names(ctx):
    """One row per distinct name (as typed in the field, curated by NS, or picked from the list)."""
    occ = ctx.occ
    e = _extra(ctx)
    roles: dict[str, dict] = {}
    for role, counts in (("typed", e[e.entry_mode == "new_missing"].new_missing_canonical.str.strip().value_counts()),
                         ("list", occ[occ.source == "list"].raw_name.value_counts()),
                         ("curated", occ[occ.resolved_status == "identified"].groupby("resolved_name").size())):
        for name, n in counts.items():
            if name:
                roles.setdefault(name.strip(), {})[role] = int(n)
    for name, rl in sorted(roles.items()):
        ev, could, _ = _spelling_evidence(ctx, name)
        if set(rl) == {"list"}:
            ev = [x for x in ev if "similar to list" not in x]  # a list name is its own reference
        status = "fail" if ev else ("pass" if could else "could_not_check")
        where = ", ".join(f"{k} ({v} records)" for k, v in rl.items())
        ctx.add(status, "taxon_name", name, source_table="species" if set(rl) == {"list"} else "species_extra_ids / additional_species_repeat",
                observed=f"{name!r}: {where}" + (": " + "; ".join(ev) if ev else ""), expected="name matches the GBIF backbone exactly",
                message="confirm spelling in curation (the resolved layer keeps NS's name)" if ev else ("" if could else "not in the GBIF cache"))


@rule("F04")
def same_canonical_two_entities(ctx):
    se = ctx.data.ent["species_extra"]
    m = se[se.new_record_reason == "missing_species"].copy()
    m["key"] = m.label.map(norm_name)
    m["num"] = [slot_number(g, i) for g, i in zip(m.group_type, m.unknown_index)]
    for _, r in m.iterrows():
        others = m[(m.key == r.key) & (m["__id"] != r["__id"])]
        ctx.add("fail" if len(others) else "pass", "species_extra", r.num, source_table="species_extra", source_key=r["__id"],
                observed=f"{r.num} {r.label!r}" + (f"; also registered as {', '.join(others.num)}" if len(others) else ""), expected="one entity per canonical",
                message="the field team re-registered instead of reusing" if len(others) else "")


@rule("F05")
def duplicate_in_quadrat(ctx):
    o = ctx.occ
    raw_dup = o.duplicated(["quadrat_key", "raw_key"], keep="first") & (o.raw_key != "")
    res = o[o.resolved_status.isin(["identified", "identified_uncurated", "unknown_unresolved", "unknown_uncurated"])]
    res_dup = res.duplicated(["quadrat_key", "resolved_key"], keep="first").reindex(o.index, fill_value=False)
    for r, rd, sd in zip(rows(o), raw_dup, res_dup):
        if rd:
            _occ_add(ctx, "fail", r, f"{r.raw_name or r.raw_key} recorded twice in quadrat {int(r.quadrat_number)}", "each taxon once per quadrat")
        elif sd:
            _occ_add(ctx, "fail", r, f"{r.resolved_name} twice in quadrat {int(r.quadrat_number)} after curation merges", "each taxon once per quadrat",
                     "expected consequence of merging provisional taxa; counted once in the resolved layer", severity="info")
        else:
            _occ_add(ctx, "pass", r, "unique in quadrat", "each taxon once per quadrat")


@rule("F06")
def woody_in_herbaceous(ctx):
    sp = ctx.data.ent["species"]
    woody_names = set(sp.loc[sp.groups == "woody", "label"].map(norm_name))
    cur = curation_actions(ctx.data.ent["species_extra_ids"])
    for r in rows(ctx.occ):
        why = []
        if r.raw_group == "woody":
            why.append("raw taxon in the woody group")
        if r.slot_number in cur.index and cur.loc[r.slot_number, "exclude"] and WOODY_NOTE.search(cur.loc[r.slot_number, "notes"]):
            why.append(f"curation: {cur.loc[r.slot_number, 'notes']!r}")
        if r.resolved_key and r.resolved_key in woody_names:
            why.append(f"resolved name {r.resolved_name!r} is woody on the project list")
        _occ_add(ctx, "fail" if why else "pass", r, "; ".join(why) or "herbaceous", "non-woody taxa only",
                 "excluded from the resolved herbaceous layer (V-03); kept in the raw layer" if why else "")


@rule("F07")
def unresolved_after_curation(ctx):
    o = ctx.occ[ctx.occ.canonical_survey]
    unk = o[o.resolved_status.isin(["unknown_unresolved", "unknown_uncurated"])].groupby("resolved_key")
    for key, g in unk:
        ctx.add("fail", "curated_taxon", key, source_table="species_extra_ids", source_key=key,
                observed=f"{key} unresolved: {len(g)} records in {g.plot_name.nunique()} plots", expected="identified from vouchers")
    ok = o[o.resolved_status == "identified"].resolved_key.nunique()
    ctx.add("pass", "project", "identified taxa", observed=f"{ok} identified taxa", expected="identified")


@rule("F08")
def curation_actions_applied(ctx):
    cur = curation_actions(ctx.data.ent["species_extra_ids"])
    for num, c in cur.iterrows():
        act = (f"merge into {c.merge_into}" if c.merge_into else "") + ("; exclude" if c.exclude else "")
        ctx.add("fail" if act else "pass", "curated_taxon", num, source_table="species_extra_ids", source_key=num,
                observed=act.strip("; ") or "no merge/exclude", expected="(context)", message=f"note: {c.notes!r}" if act else "")
    # several provisional ids resolving to one species (raw richness over-counts)
    named = cur[~cur.unresolved & ~cur.exclude]
    for name, g in named.groupby(named.species_name.map(norm_name)):
        if len(g) > 1:
            ctx.add("fail", "curated_taxon", f"name:{name}", source_table="species_extra_ids", observed=f"{len(g)} provisional ids -> {g.species_name.iloc[0]!r}: {', '.join(sorted(g.index))}",
                    expected="(context)", message="raw richness counts these as separate taxa")


@rule("F09")
def entity_writers(ctx):
    se = ctx.data.ent["species_extra"].set_index("__id")
    e = _extra(ctx)
    new = e[e.entry_mode.isin(NEW_MODES)]
    for slot, g in new.groupby("slot"):
        writers = g.drop_duplicates("survey")
        rejected = writers[writers.review == "rejected"]
        upd = int(se.__updates.get(slot, 0)) if slot in se.index else -1
        num = g.num.iloc[0]
        p = []
        if len(writers) > 1:
            p.append(f"written by {len(writers)} submissions: " + ", ".join(f"{w.plot_name} ({w.review or 'not reviewed'})" for w in rows(writers)))
        if len(rejected):
            p.append("written by a rejected submission")
        same = len(writers) > 1 and writers.plot_name.nunique() == 1 and writers.entity_label_to_write.nunique() == 1
        if p:
            p.append("identical values from a repeat survey of the same plot (same plant re-recorded)" if same
                     else "different plots or values: two taxa share one provisional id")
        ctx.add("fail" if p else "pass", "species_extra", num, source_table="species_extra", source_key=slot,
                observed="; ".join(p) or f"one writer ({writers.plot_name.iloc[0]})", expected="one accepted writer per slot",
                message=f"entity __updates={upd}; rejection does not roll back entity writes (K03)" if p else "",
                severity=("info" if same else None) if p else None)


@rule("F10")
def range_check(ctx):
    """No GBIF occurrence in the project country is weak evidence on its own (GBIF is incomplete); it is
    reported as info per taxon, with the contrast-region count beside it, and as a warning only in aggregate."""
    g = _gbif(ctx)
    country, contrast = ctx.th["range_country"], "/".join(ctx.th["range_contrast_countries"])
    occ = ctx.occ[ctx.occ.canonical_survey & ctx.occ.resolved_status.isin(["identified", "identified_uncurated"])]
    zero, total = 0, 0
    for name, n in occ.groupby("resolved_name").size().items():
        c = g.get(name.strip())
        if not c or f"count_{country}" not in c:
            ctx.add("could_not_check", "taxon_name", name, source_table="reference/gbif_cache.json", observed=f"{name!r} ({n} records)",
                    message="not in the GBIF cache or not matched to a species")
            continue
        total += 1
        here, there = c[f"count_{country}"], c["count_contrast"]
        bad = here == 0
        zero += bad
        ctx.add("fail" if bad else "pass", "taxon_name", name, source_table="reference/gbif_cache.json",
                observed=f"{name!r} ({n} records): GBIF {here} records in {country}, {there} in {contrast} (as {c.get('canonicalName')!r})",
                expected=f">= 1 GBIF record in {country}",
                message="no GBIF record in the country: verify the identification or the source of the species list (GBIF is incomplete)" if bad else "")
    ctx.add("fail" if zero else "pass", "project", "range summary", source_table="reference/gbif_cache.json",
            observed=f"{zero}/{total} identified taxa have no GBIF record in {country}", expected="0", severity="warning" if zero else None,
            message=f"aggregate raised to warning: one taxon without records is weak evidence, {zero / total:.0%} of the identified taxa is a pattern" if zero else "")


@rule("F11")
def unknown_burden(ctx):
    th = ctx.th
    o = ctx.occ[ctx.occ.canonical_survey]
    q = ctx.data.quadrat
    for s in rows(ctx.data.survey[ctx.data.survey.KEY.isin(ctx.canonical)]):
        so = o[o.survey_key == s.KEY]
        share = float(so.resolved_status.isin(["unknown_unresolved", "unknown_uncurated"]).mean()) if len(so) else 0.0
        n_au = int((q[q.PARENT_KEY == s.KEY].all_unknown == "yes").sum())
        bad = share > th["unknown_share_info"] or n_au > th["all_unknown_quadrats_info"]
        ctx.add("fail" if bad else "pass", "plot", s.plot_name, plot_name=s.plot_name, survey_key=s.KEY, source_table="survey", source_key=s.KEY,
                observed=f"{share:.0%} of records unresolved unknowns; {n_au}/{len(q[q.PARENT_KEY == s.KEY])} all-unknown quadrats",
                expected=f"<= {th['unknown_share_info']:.0%} unknown records and <= {th['all_unknown_quadrats_info']} all-unknown quadrats")


@rule("F12")
def unknown_woody_named(ctx):
    names = _list_names(ctx)
    for _, r in ctx.data.registration.iterrows():
        t = r.unknown_woody.strip()
        if r.unknown_woody_present != "yes":
            continue
        named = bool(BINOMIAL.match(t)) or norm_name(t) in names
        ctx.add("fail" if named else "pass", "plot", r.plot_name, plot_name=r.plot_name, source_table="registration", source_key=r.KEY,
                observed=repr(t), expected="a description, not a species name", message="a named species belongs in known_dominant_woody_species" if named else "")


@rule("F13")
def curation_table(ctx):
    d = ctx.data
    cur = curation_actions(d.ent["species_extra_ids"])
    si = d.ent["species_extra_ids"].set_index("species_number")
    se = d.ent["species_extra"].copy()
    se["num"] = [slot_number(g, i) for g, i in zip(se.group_type, se.unknown_index)]
    active = se[se.choice_status == "active"].set_index("num")
    used = set(_extra(ctx).num) - {""}
    curated_names = [n for n in cur.species_name if n.lower() != "unknown"]
    for num, c in cur.iterrows():
        p = []
        label = si.label[num]
        want = num if c.unresolved else c.species_name
        if label != want:
            p.append(f"label {label!r} != {'number' if c.unresolved else 'species_name'} {want!r}")
        if c.merge_into or c.exclude:
            p.append("merge/exclude stated only in free-text notes (no structured column)")
        if not c.unresolved:
            ev, _, exact = _spelling_evidence(ctx, c.species_name)
            near, score = _closest(c.species_name, curated_names, ctx.th["fuzzy_name_ratio"])
            if near and not exact:
                ev.append(f"{score:.2f} similar to curated {near!r}")
            recorded = active.label.get(num, "")
            if num in active.index and active.new_record_reason[num] == "missing_species":
                if norm_name(recorded) != norm_name(c.species_name):
                    rec_ev, _, _ = _spelling_evidence(ctx, recorded)
                    if ev and not rec_ev:
                        p.append(f"curation changed the field name {recorded!r} to {c.species_name!r}, introducing a likely typo: " + "; ".join(ev))
                        ev = []
                elif ev:
                    p.append(f"curation keeps the field spelling {recorded!r}: " + "; ".join(ev))
                    ev = []
            if ev:
                p.append("likely misspelled: " + "; ".join(ev))
        if num not in active.index:
            p.append("no active species_extra slot with this number")
        ctx.add("fail" if p else "pass", "curated_taxon", num, source_table="species_extra_ids", source_key=num,
                observed="; ".join(p) or f"{num} -> {c.species_name}", expected="clean, structured curation table")
    for num in sorted(used - set(cur.index)):
        ctx.add("fail", "curated_taxon", num, source_table="species_extra_ids", observed=f"{num} used in the data but missing from the curation table", expected="every used slot curated")


@rule("F14")
def unknown_index_chain(ctx):
    """assigned_unknown_index = base_active_herb_count + count_prior_new_in_submission + 1, the target slot's
    unknown_index must equal it, and across accepted submissions the indices form one unbroken sequence."""
    se = ctx.data.ent["species_extra"].set_index("__id")
    e = _extra(ctx)
    new = e[e.entry_mode.isin(NEW_MODES)].copy()
    new["prior_recomputed"] = new.groupby("survey").cumcount()
    for r in rows(new):
        p = []
        if r._count_prior_new_in_submission != r.prior_recomputed:
            p.append(f"count_prior_new_in_submission {r.count_prior_new_in_submission} != {r.prior_recomputed}")
        exp = r.base + r.prior_recomputed + 1
        if r._assigned_unknown_index != exp:
            p.append(f"assigned index {r.assigned_unknown_index} != base {int(r.base)} + {r.prior_recomputed} + 1")
        slot_idx = se.unknown_index.get(r.slot, "")
        if str(slot_idx) != r.assigned_unknown_index:
            p.append(f"target slot has unknown_index {slot_idx!r}")
        ctx.add("fail" if p else "pass", "additional_species", r.KEY, plot_name=r.plot_name, survey_key=r.survey, source_table="additional_species_repeat",
                source_key=r.KEY, observed="; ".join(p) or f"index {r.assigned_unknown_index}", expected="index = base + prior + 1 = target slot index")
    acc = new[new.review != "rejected"]
    idx = sorted(acc._assigned_unknown_index.dropna().astype(int))
    gaps = sorted(set(range(1, max(idx) + 1)) - set(idx)) if idx else []
    dups = sorted({i for i in idx if idx.count(i) > 1})
    rej = new[new.review == "rejected"]
    reused = sorted(set(rej._assigned_unknown_index.dropna().astype(int)) & set(idx))
    ctx.add("fail" if gaps or dups else "pass", "project", "index chain", source_table="additional_species_repeat",
            observed=f"accepted submissions: indices 1..{max(idx) if idx else 0}, gaps {gaps or 'none'}, duplicates {dups or 'none'}",
            expected="one unbroken sequence", message=f"rejected submissions re-used indices {reused} (B10/F09)" if reused else "")

"""C. Form-internal consistency: the ODK form's own required / relevant / constraint / calculation rules,
re-checked on the exported values. A value the app could not have produced points to an edit after
collection (or an export problem), so these are reported as errors with "investigate", never fixed."""

from __future__ import annotations

import re

import pandas as pd

from ..engine import rows, rule

NEW_MODES = ("new_unknown", "new_missing")
CANONICAL_FORBIDDEN = re.compile(r"[,;()]")  # form constraint not(regex(., '[,;()]'))


def _q(ctx, status, r, observed, expected, message="", severity=None):
    ctx.add(status, "quadrat", r.KEY, plot_name=ctx.cached("plot_by_survey", lambda: ctx.data.survey.set_index("KEY").plot_name).get(r.PARENT_KEY, ""),
            survey_key=r.PARENT_KEY, source_table="quadrat_repeat", source_key=r.KEY, observed=observed, expected=expected, message=message, severity=severity)


def _extra_by_quadrat(ctx):
    return ctx.cached("extra_by_quadrat", lambda: ctx.data.extra.groupby("PARENT_KEY"))


def _named_extra_count(ctx) -> pd.Series:
    e = ctx.data.extra
    return ctx.cached("named_extra_count", lambda: e[e.validated_name.str.strip() != ""].groupby("PARENT_KEY").size())


@rule("C01")
def herbs_absent_but_species(ctx):
    n_extra = ctx.data.extra.groupby("PARENT_KEY").size()
    for r in rows(ctx.data.quadrat):
        if r.herbs_present != "no":
            continue
        k = len(r._species) + int(n_extra.get(r.KEY, 0))
        _q(ctx, "fail" if k else "pass", r, f"herbs_present=no; {len(r._species)} list + {int(n_extra.get(r.KEY, 0))} additional", "no species")


@rule("C02")
def herbs_present_but_none(ctx):
    named = _named_extra_count(ctx)
    for r in rows(ctx.data.quadrat):
        if r.herbs_present != "yes":
            continue
        problems = []
        if r.all_unknown == "no" and not r._species:
            problems.append("all_unknown=no but no list species (form requires them)")
        if not r._species and int(named.get(r.KEY, 0)) == 0:
            problems.append("no species at all")
        _q(ctx, "fail" if problems else "pass", r, "; ".join(problems) or f"{len(r._species)} list + {int(named.get(r.KEY, 0))} additional", ">= 1 species")


@rule("C03")
def all_unknown_with_list(ctx):
    for r in rows(ctx.data.quadrat):
        if r.all_unknown != "yes":
            continue
        _q(ctx, "fail" if r._species else "pass", r, f"all_unknown=yes; {len(r._species)} list species", "no list species")


@rule("C04")
def additional_flag_vs_rows(ctx):
    n_extra = ctx.data.extra.groupby("PARENT_KEY").size()
    for r in rows(ctx.data.quadrat):
        n = int(n_extra.get(r.KEY, 0))
        if r.additional_present == "yes":
            ok, msg = n > 0, "additional species declared but no rows: species may have been lost"
        else:
            ok, msg = n == 0, "rows present although additional_species_present != yes"
        _q(ctx, "pass" if ok else "fail", r, f"additional_species_present='{r.additional_present}', {n} rows", "flag and rows agree", "" if ok else msg)


@rule("C05")
def count_herb_species(ctx):
    for r in rows(ctx.data.quadrat):
        if r.herbs_present != "yes":
            continue
        stored, exp = r._count_herb_species, len(r._species)
        ok = (pd.isna(stored) and exp == 0) or stored == exp
        _q(ctx, "pass" if ok else "fail", r, f"stored {r.count_herb_species!r}", f"{exp} (count-selected)")


@rule("C06")
def label_lists(ctx):
    """known_species_list = labels of the selected list species in species-list order; additional list =
    the rows' validated names; all = both joined with <br/>."""
    sp = ctx.data.ent["species"]
    order = {u: i for i, u in enumerate(sp["__id"])}
    label = sp.set_index("__id").label
    e = ctx.data.extra.sort_values(["PARENT_KEY", "_observation_index"])
    add_lists = e[e.validated_name != ""].groupby("PARENT_KEY").validated_name.apply(lambda v: "<br/>".join(v))
    for r in rows(ctx.data.quadrat):
        if r.herbs_present != "yes":
            continue
        known = "<br/>".join(label.get(u, "") for u in sorted(r._species, key=lambda u: order.get(u, 1e9)))
        add = add_lists.get(r.KEY, "")
        allx = f"{known}<br/>{add}" if known and add else (known or add)
        diffs = [n for n, got, exp in (("known", r.known_species_list, known), ("additional", r.additional_species_list, add), ("all", r.all_species_list, allx)) if got != exp]
        _q(ctx, "fail" if diffs else "pass", r, "differs: " + ", ".join(diffs) if diffs else "consistent", "recomputed from the selections")


@rule("C07")
def quadrats_with_species(ctx):
    """The form's calculation uses the relative path `selected_herb_species_uuids` from the quadrat, but the
    field sits inside the herb_species group, so the list part never matches: the stored value counts only
    quadrats with named additional species (K02). Reported per survey; the recomputed value is the correct one."""
    named = _named_extra_count(ctx)
    q = ctx.data.quadrat
    for s in rows(ctx.data.survey):
        sub = q[q.PARENT_KEY == s.KEY]
        correct = int(sum(1 for k, sp in zip(sub.KEY, sub._species) if sp or named.get(k, 0) > 0))
        form_literal = int(sum(1 for k in sub.KEY if named.get(k, 0) > 0))
        stored = s._quadrats_with_species
        ok = stored == correct
        ctx.add("pass" if ok else "fail", "survey", s.KEY, plot_name=s.plot_name, survey_key=s.KEY, source_table="survey", source_key=s.KEY,
                observed=f"stored {s.quadrats_with_species}", expected=f"{correct} (recomputed)",
                message="" if ok else f"stored value equals the form expression as written ({form_literal}): calculation bug (K02)" if stored == form_literal else "stored value matches neither the correct nor the literal form expression")


@rule("C08")
def additional_without_species(ctx):
    for r in rows(ctx.data.extra):
        slot = {"new_unknown": r.target_extra_name, "new_missing": r.target_extra_name, "reuse_unknown": r.select_reuse_unknown, "reuse_missing": r.select_reuse_missing}.get(r.entry_mode, "")
        ok = bool(slot) and bool(r.validated_name.strip())
        ctx.add("pass" if ok else "fail", "additional_species", r.KEY, source_table="additional_species_repeat", source_key=r.KEY, survey_key="",
                plot_name=_plot_of_quadrat(ctx, r.PARENT_KEY), observed=f"mode={r.entry_mode or '(none)'}; slot={'set' if slot else 'empty'}; validated_name={r.validated_name!r}",
                expected="mode and species chosen", message="" if ok else "occurrence with no taxon")


def _plot_of_quadrat(ctx, qkey):
    m = ctx.cached("plot_by_quadrat", lambda: ctx.data.quadrat.set_index("KEY").PARENT_KEY.map(ctx.data.survey.set_index("KEY").plot_name))
    return m.get(qkey, "")


@rule("C09")
def macro_photos(ctx):
    macros = [f"macro_images-macro_{i}" for i in range(1, 6)]
    for _, r in ctx.data.extra.iterrows():
        problems = []
        if r.entry_mode == "new_unknown" and not r[macros[0]]:
            problems.append("new unknown without macro_1")
        for i in range(1, 5):
            if r[macros[i]] and not r[macros[i - 1]]:
                problems.append(f"macro_{i + 1} without macro_{i}")
        if r.entry_mode not in NEW_MODES and any(r[m] for m in macros):
            problems.append("macro photos on a reused species (group not relevant)")
        if r.entry_mode not in NEW_MODES and not problems:
            continue  # only new species carry photos
        ctx.add("fail" if problems else "pass", "additional_species", r.KEY, plot_name=_plot_of_quadrat(ctx, r.PARENT_KEY), source_table="additional_species_repeat",
                source_key=r.KEY, observed="; ".join(problems) or f"{sum(bool(r[m]) for m in macros)} macro photo(s)", expected="macro_1 for new unknowns; photos in sequence")


@rule("C10")
def canonical_characters(ctx):
    for r in rows(ctx.data.extra[ctx.data.extra.entry_mode == "new_missing"]):
        bad = bool(CANONICAL_FORBIDDEN.search(r.new_missing_canonical))
        ctx.add("fail" if bad else "pass", "additional_species", r.KEY, plot_name=_plot_of_quadrat(ctx, r.PARENT_KEY), source_table="additional_species_repeat",
                source_key=r.KEY, observed=repr(r.new_missing_canonical), expected="no , ; ( )")


@rule("C11")
def confirmed(ctx):
    for r in rows(ctx.data.survey):
        ctx.add("pass" if r.confirm == "yes" else "fail", "survey", r.KEY, plot_name=r.plot_name, survey_key=r.KEY, source_table="survey", source_key=r.KEY,
                observed=r.confirm or "(empty)", expected="yes")


@rule("C12")
def survey_required(ctx):
    tr = ctx.data.ent["transport"].set_index("__id")
    req = {"start": "start_time", "end": "end_time", "transport": "transport_uuid", "team": "team_uuids", "recorder": "recorder_uuid",
           "survey": "survey_uuid", "plot": "plot_uuid", "confirm": "confirm"}
    for r in rows(ctx.data.survey):
        missing = [k for k, c in req.items() if not str(r[c]).strip()]
        if r.transport_uuid and tr.choice_status.get(r.transport_uuid, "") != "active":
            missing.append(f"transport '{tr.label.get(r.transport_uuid, '?')}' is inactive (choice filter)")
        ctx.add("fail" if missing else "pass", "survey", r.KEY, plot_name=r.plot_name, survey_key=r.KEY, source_table="survey", source_key=r.KEY,
                observed="; ".join(missing) or "complete", expected="all required fields")


@rule("C13")
def quadrat_required(ctx):
    for r in rows(ctx.data.quadrat):
        missing = []
        if r.herbs_present not in ("yes", "no"):
            missing.append("herbs_present")
        if r.herbs_present == "yes" and r.all_unknown not in ("yes", "no"):
            missing.append("all_unknown_unidentifiable")
        if r.herbs_present == "yes" and r.additional_present not in ("yes", "no"):
            missing.append("additional_species_present")
        if not r.image:
            missing.append("quadrat_image")
        if r.image and (pd.isna(r._lat) or pd.isna(r._lon) or pd.isna(r._acc)):
            missing.append("location_quadrat")
        _q(ctx, "fail" if missing else "pass", r, ", ".join(missing) or "complete", "required fields present")


@rule("C14")
def survey_calculations(ctx):
    d = ctx.data
    sv = d.ent["surveys"].set_index("__id")
    vp = d.ent["vegplots"].set_index("__id")
    team = d.ent["project_team"].set_index("__id")
    tr = d.ent["transport"].set_index("__id")
    for r in rows(d.survey):
        e = sv.loc[r.survey_uuid] if r.survey_uuid in sv.index else None
        year = r.start_time[:4]
        exp = {"survey_year": year}
        if e is not None:
            idx = int(year) - int(e.baseline_year)
            exp.update(baseline_year=e.baseline_year, replicate_index=str(idx), area_label=e.area_label, target_group=e.target_group, survey_label=e.label,
                       replicate=f"{e.area_label}_baseline" if idx == 0 else f"{e.area_label}_yr{idx}")
        if r.plot_uuid in vp.index:
            exp.update(plot_name=vp.label[r.plot_uuid], plot_status=vp.plot_status[r.plot_uuid])
        exp["recorder_label"] = team.label.get(r.recorder_uuid, "")
        diffs = [f"{k}: stored {r[k]!r} != {v!r}" for k, v in exp.items() if str(r[k]).lower() != str(v).lower()]
        case_only = [f"{k}: stored {r[k]!r} vs form {v!r}" for k, v in exp.items() if str(r[k]) != str(v) and str(r[k]).lower() == str(v).lower()]
        tl = r["field_team_specifics-transport_type_label"]
        if tl != tr.label.get(r.transport_uuid, ""):
            diffs.append(f"transport label {tl!r}")
        for col, want in (("new_unknown_index_list", "new_unknown"), ("new_missing_index_list", "new_missing")):
            got = _index_list(ctx, r.KEY, want)
            if r[col] != got:
                diffs.append(f"{col}: stored {r[col]!r} != {got!r}")
        if diffs:
            status, sev, obs, msg = "fail", None, "; ".join(diffs + case_only), ""
        elif case_only:
            status, sev, obs = "fail", "info", "; ".join(case_only)
            msg = "letter case only: the deployed form (or the export) lower-cases what the form file concatenates; consistent across the data, confirm"
        else:
            status, sev, obs, msg = "pass", None, "all consistent", ""
        ctx.add(status, "survey", r.KEY, plot_name=r.plot_name, survey_key=r.KEY, source_table="survey", source_key=r.KEY, severity=sev,
                observed=obs, expected="calculations recomputed from inputs and entity lists", message=msg)


def _index_list(ctx, survey_key, mode):
    e = ctx.cached("extra_with_survey", lambda: ctx.data.extra.assign(
        survey=ctx.data.extra.PARENT_KEY.map(ctx.data.quadrat.set_index("KEY").PARENT_KEY),
        qn=ctx.data.extra.PARENT_KEY.map(ctx.data.quadrat.set_index("KEY")._quadrat_number)).sort_values(["survey", "qn", "_observation_index"]))
    sub = e[(e.survey == survey_key) & (e.entry_mode == mode)]
    return "|".join(sub.assigned_unknown_index)


@rule("C15")
def all_unknown_needs_additional(ctx):
    for r in rows(ctx.data.quadrat):
        if r.all_unknown != "yes":
            continue
        _q(ctx, "pass" if r.additional_present == "yes" else "fail", r, f"all_unknown=yes, additional_species_present={r.additional_present!r}", "yes")


@rule("C16")
def registration_rules(ctx):
    d = ctx.data
    sp = d.ent["species"].set_index("__id")
    sv = d.ent["surveys"].set_index("__id")
    pts = ("endpoint_a", "midpoint", "endpoint_b")
    for _, r in d.registration.iterrows():
        p = []
        for f in ("transport_uuid", "team_uuids", "recorder_uuid", "start_time", "end_time", "survey_uuids", "plot_uuid", "viable"):
            if not str(r[f]).strip():
                p.append(f"{f} missing")
        if r.confirm != "yes":
            p.append("confirm_submission != yes")
        for u in r._survey_uuids:
            if sv.target_parent_taxon.get(u, "") != "plants":
                p.append(f"survey {u[:8]} is not a plant survey")
        meta = ["ecosystem_uuid", "woody_present", "soil_type", "ground_cover", "water_present", "disturbance"]
        if r.viable == "no":
            if not r.establishment_notes.strip():
                p.append("non-viable without establishment notes")
            filled = [f for f in meta + ["canopy_height_m", "known_woody", "unknown_woody"] if str(r[f]).strip()] + [x for x in pts if pd.notna(r[f"_{x}_lat"])]
            if filled:
                p.append("metadata recorded for a non-viable plot: " + ", ".join(filled))
        elif r.viable == "yes":
            p += [f"{f} missing" for f in meta if not str(r[f]).strip()]
            p += [f"{x} location missing" for x in pts if pd.isna(r[f"_{x}_lat"])]
            if r.woody_present == "yes":
                for f in ("known_woody_present", "unknown_woody_present", "canopy_height_m", "canopy_structure"):
                    if not str(r[f]).strip():
                        p.append(f"{f} missing")
                h = str(r.canopy_height_m)
                if h and not (re.fullmatch(r"[0-9]+", h) and int(h) <= 50):
                    p.append(f"canopy_height_m {h!r} violates ^[0-9]+$ and <= 50")
            elif r.woody_present == "no":
                filled = [f for f in ("known_woody_present", "known_woody", "unknown_woody_present", "unknown_woody", "canopy_height_m", "canopy_structure") if str(r[f]).strip()]
                if filled:
                    p.append("woody fields filled although woody_species_present=no: " + ", ".join(filled))
            if r.known_woody_present == "yes" and not r.known_woody.strip():
                p.append("known dominant woody species missing")
            for u in r.known_woody.split():
                if sp.groups.get(u, "") != "woody":
                    p.append(f"known dominant species {sp.label.get(u, u[:8])} not in the woody group")
            if r.unknown_woody_present == "yes" and not r.unknown_woody.strip():
                p.append("unknown dominant woody species text missing")
            dist = r.disturbance.split()
            if "none" in dist and len(dist) > 1:
                p.append("disturbance 'none' combined with other types")
        else:
            p.append(f"is_plot_viable={r.viable!r}")
        ctx.add("fail" if p else "pass", "registration", r.KEY, plot_name=r.plot_name, source_table="registration", source_key=r.KEY,
                observed="; ".join(p) or "consistent with the registration form", expected="registration form required/relevant/constraint rules")

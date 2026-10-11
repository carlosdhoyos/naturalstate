"""A. Structural and referential integrity."""

from __future__ import annotations

import pandas as pd

from ..engine import rows, rule
from ..forms import form_version

SURVEY_INSTANCE_SUFFIX = "_herbs"  # herbaceous form instance_name = concat(plot_name, '_herbs')


@rule("A01")
def orphans(ctx):
    d = ctx.data
    skeys, qkeys = set(d.survey.KEY), set(d.quadrat.KEY)
    for r in rows(d.quadrat):
        ok = r.PARENT_KEY in skeys
        ctx.add("pass" if ok else "fail", "quadrat", r.KEY, survey_key=r.PARENT_KEY, source_table="quadrat_repeat", source_key=r.KEY,
                observed=r.PARENT_KEY, expected="PARENT_KEY in survey KEYs", message="" if ok else "quadrat has no parent survey")
    for r in rows(d.extra):
        ok = r.PARENT_KEY in qkeys
        ctx.add("pass" if ok else "fail", "additional_species", r.KEY, source_table="additional_species_repeat", source_key=r.KEY,
                observed=r.PARENT_KEY, expected="PARENT_KEY in quadrat KEYs", message="" if ok else "additional-species row has no parent quadrat")


@rule("A02")
def key_uniqueness(ctx):
    d = ctx.data
    tables = {"survey (KEY)": d.survey.KEY, "quadrat_repeat (KEY)": d.quadrat.KEY, "additional_species_repeat (KEY)": d.extra.KEY,
              "register_vegetation_plots (KEY)": d.registration.KEY}
    tables.update({f"{k} (__id)": v["__id"] for k, v in d.ent.items()})
    for name, col in tables.items():
        dup = col[col.duplicated(keep=False)]
        ctx.add("fail" if len(dup) else "pass", "table", name, source_table=name.split(" ")[0], observed=f"{dup.nunique()} duplicated keys" if len(dup) else "unique",
                expected="unique", message="; ".join(sorted(dup.unique())[:5]))


@rule("A03")
def twenty_quadrats(ctx):
    d, n = ctx.data, ctx.th["quadrats_per_survey"]
    counts = d.quadrat.groupby("PARENT_KEY").size()
    for r in rows(d.survey):
        c, stored = int(counts.get(r.KEY, 0)), r.quadrat_repeat_count
        ok = c == n and str(stored) == str(n)
        ctx.add("pass" if ok else "fail", "survey", r.KEY, plot_name=r.plot_name, survey_key=r.KEY, source_table="survey", source_key=r.KEY,
                observed=f"{c} quadrat rows; quadrat_repeat_count={stored}", expected=str(n))


@rule("A04")
def quadrat_numbers(ctx):
    d, n = ctx.data, ctx.th["quadrats_per_survey"]
    nums = d.quadrat.groupby("PARENT_KEY")._quadrat_number.apply(lambda s: sorted(s.dropna().astype(int).tolist()))
    for r in rows(d.survey):
        got = nums.get(r.KEY, [])
        ok = got == list(range(1, n + 1))
        ctx.add("pass" if ok else "fail", "survey", r.KEY, plot_name=r.plot_name, survey_key=r.KEY, source_table="quadrat_repeat",
                observed="1..20" if ok else str(got), expected="1..20, each once")


def _ref(ctx, ok_set, value, entity_type, key, what, table, plot="", survey=""):
    if value == "":
        return
    ok = value in ok_set
    ctx.add("pass" if ok else "fail", entity_type, f"{key}:{what}", plot_name=plot, survey_key=survey, source_table=table, source_key=key,
            observed=value, expected=f"{what} in its entity list", message="" if ok else f"{what} does not resolve")


@rule("A05")
def references(ctx):
    d = ctx.data
    ids = {k: set(v["__id"]) for k, v in d.ent.items()}
    for r in rows(d.survey):
        _ref(ctx, ids["transport"], r.transport_uuid, "survey", r.KEY, "transport", "survey", r.plot_name, r.KEY)
        for m in r.team_uuids.split():
            _ref(ctx, ids["project_team"], m, "survey", r.KEY, f"team member {m[:8]}", "survey", r.plot_name, r.KEY)
        _ref(ctx, ids["project_team"], r.recorder_uuid, "survey", r.KEY, "recorder", "survey", r.plot_name, r.KEY)
        _ref(ctx, ids["surveys"], r.survey_uuid, "survey", r.KEY, "survey", "survey", r.plot_name, r.KEY)
        _ref(ctx, ids["vegplots"], r.plot_uuid, "survey", r.KEY, "plot (vegplots)", "survey", r.plot_name, r.KEY)
    for r in rows(d.registration):
        _ref(ctx, ids["transport"], r.transport_uuid, "registration", r.KEY, "transport", "registration", r.plot_name)
        for m in r.team_uuids.split():
            _ref(ctx, ids["project_team"], m, "registration", r.KEY, f"team member {m[:8]}", "registration", r.plot_name)
        _ref(ctx, ids["project_team"], r.recorder_uuid, "registration", r.KEY, "recorder", "registration", r.plot_name)
        for u in r.survey_uuids.split():
            _ref(ctx, ids["surveys"], u, "registration", r.KEY, f"survey {u[:8]}", "registration", r.plot_name)
        _ref(ctx, ids["centroids"], r.plot_uuid, "registration", r.KEY, "plot (centroids)", "registration", r.plot_name)
        _ref(ctx, ids["ecosystem_types"], r.ecosystem_uuid, "registration", r.KEY, "ecosystem type", "registration", r.plot_name)
        for u in r.known_woody.split():
            _ref(ctx, ids["species"], u, "registration", r.KEY, f"woody species {u[:8]}", "registration", r.plot_name)
    o = ctx.occ
    for r in rows(o):
        if r.source == "extra" and r.taxon_ref == "":
            continue  # an occurrence with no taxon at all is C08
        ctx.add("pass" if r.ref_resolves else "fail", "occurrence", r.occurrence_id, plot_name=r.plot_name, survey_key=r.survey_key,
                source_table="quadrat_repeat" if r.source == "list" else "additional_species_repeat", source_key=r.extra_key or r.quadrat_key,
                observed=r.taxon_ref, expected="species / species_extra entity", message="" if r.ref_resolves else "taxon reference does not resolve")


@rule("A06")
def list_species_herbaceous(ctx):
    sp = ctx.data.ent["species"].set_index("__id")
    for r in rows(ctx.occ[ctx.occ.source == "list"]):
        if not r.ref_resolves:
            ctx.add("could_not_check", "occurrence", r.occurrence_id, plot_name=r.plot_name, survey_key=r.survey_key, message="species not found")
            continue
        g = sp.groups.get(r.taxon_ref, "")
        ctx.add("pass" if g == "herbaceous" else "fail", "occurrence", r.occurrence_id, plot_name=r.plot_name, survey_key=r.survey_key,
                source_table="quadrat_repeat", source_key=r.quadrat_key, observed=f"{r.raw_name} [{g}]", expected="groups = herbaceous")


@rule("A07")
def form_versions(ctx):
    d = ctx.data
    for tbl, df, form in (("survey", d.survey, "herbaceous_veg_survey"), ("registration", d.registration, "register_vegetation_plots")):
        cur = form_version(form)
        for r in rows(df):
            ok = r.FormVersion == cur
            ctx.add("pass" if ok else "fail", tbl, r.KEY, plot_name=r.plot_name, survey_key=r.KEY if tbl == "survey" else "", source_table=tbl,
                    source_key=r.KEY, observed=r.FormVersion, expected=cur)


@rule("A08")
def attachments(ctx):
    d = ctx.data
    for tbl, df in (("survey", d.survey), ("registration", d.registration)):
        for r in rows(df):
            ok = r.AttachmentsPresent == r.AttachmentsExpected
            ctx.add("pass" if ok else "fail", tbl, r.KEY, plot_name=r.plot_name, survey_key=r.KEY if tbl == "survey" else "", source_table=tbl,
                    source_key=r.KEY, observed=r.AttachmentsPresent, expected=r.AttachmentsExpected)


@rule("A09")
def instance_names(ctx):
    d = ctx.data
    for _, r in d.survey.iterrows():
        exp, name = r.plot_name + SURVEY_INSTANCE_SUFFIX, r["meta-instanceName"]
        ctx.add("pass" if name == exp else "fail", "survey", r.KEY, plot_name=r.plot_name, survey_key=r.KEY, source_table="survey", source_key=r.KEY,
                observed=name, expected=exp)
    for _, r in d.registration.iterrows():
        name = r["meta-instanceName"]
        ctx.add("pass" if name == r.plot_name else "fail", "registration", r.KEY, plot_name=r.plot_name, source_table="registration", source_key=r.KEY,
                observed=name, expected=r.plot_name)


@rule("A10")
def entity_hygiene(ctx):
    d = ctx.data
    c = d.ent["centroids"]
    reg_plots = set(d.registration.plot_uuid)
    for _, r in c.iterrows():
        problems = []
        if not r.survey_year.strip():
            problems.append("survey_year missing")
        registered = r["__id"] in reg_plots
        if registered and r.vegplot_linked != "yes":
            problems.append("registered but vegplot_linked != yes")
        if not registered and r.vegplot_linked == "yes":
            problems.append("vegplot_linked = yes but never registered")
        if registered and r["marker-color"] != "#c8cbcc":
            problems.append(f"registered but marker-color {r['marker-color']}")
        ctx.add("fail" if problems else "pass", "centroid", r["__id"], plot_name=r.choice_name, source_table="centroids", source_key=r["__id"],
                observed="; ".join(problems) or "consistent", expected="complete, link/marker consistent with registration")

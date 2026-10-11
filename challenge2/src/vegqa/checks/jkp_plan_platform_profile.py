"""J (plan vs execution), K (form / platform / documentation feedback) and P (column profiling sweep)."""

from __future__ import annotations

import re

import pandas as pd

from ..engine import rows, rule
from ..forms import choices, design_issues, fields, select_fields
from ..geo import geohash, geohash_centre

JUNK = re.compile(r"^[\W_]*\w?[\W_]*$")  # empty of words: punctuation / whitespace / one character
FREE_TEXT = {"quadrat_repeat": ["quadrat_comment"], "survey": ["survey_end-herbaceous_veg_notes"],
             "registration": ["plot_selection-plot_establishment_notes", "survey_end-plot_establishment_notes", "plot_metadata-unknown_dominant_woody_species"]}


# ── J. Plan vs execution ─────────────────────────────────────────────────
@rule("J01")
def primary_points(ctx):
    d = ctx.data
    c = d.ent["centroids"]
    reg = set(d.registration.plot_uuid)
    surveyed = set(d.survey.loc[d.survey.KEY.isin(ctx.canonical), "_centroid_uuid"])
    prim = c[c.sample_status == "primary"]
    for r in rows(prim):
        state = "surveyed" if r["__id"] in surveyed else ("registered, not surveyed" if r["__id"] in reg else "not registered")
        ctx.add("pass" if state == "surveyed" else "fail", "centroid", r["__id"], plot_name=r.choice_name, source_table="centroids", source_key=r["__id"],
                observed=f"{state} (stratum {r.stratum_label})", expected="registered and surveyed")
    for stratum, g in prim.groupby("stratum_label"):
        done = g["__id"].isin(surveyed).sum()
        ctx.add("fail" if done < len(g) else "pass", "project", f"stratum {stratum}", source_table="centroids",
                observed=f"{done}/{len(g)} primary points surveyed", expected="all primary points",
                message="entire stratum unsampled: no inference possible for it (confirmation item)" if done == 0 else "")


@rule("J02")
def backups_used(ctx):
    for r in rows(ctx.data.registration[ctx.data.registration.sample_status == "backup"]):
        ctx.add("fail", "plot", r.plot_name, plot_name=r.plot_name, source_table="registration", source_key=r.KEY, observed=f"backup {r.plot_name} registered ({r.viable})",
                expected="(context)", message="see D09 for the choice of backup")


@rule("J03")
def viable_without_survey(ctx):
    d = ctx.data
    surveyed = set(d.survey.loc[d.survey.KEY.isin(ctx.canonical), "_centroid_uuid"])
    for r in rows(d.registration[d.registration.viable == "yes"]):
        ok = r.plot_uuid in surveyed
        ctx.add("pass" if ok else "fail", "plot", r.plot_name, plot_name=r.plot_name, source_table="registration", source_key=r.KEY,
                observed="surveyed" if ok else "no canonical survey", expected="a canonical herbaceous survey")


@rule("J04")
def geohash_centres(ctx):
    tol = ctx.th["geohash_centre_tolerance_m"]
    c = ctx.data.ent["centroids"]
    dists = []
    for r in rows(c):
        glat, glon = geohash_centre(r.geohash)
        x1, y1 = ctx.proj.xy(r._lat, r._lon)
        x2, y2 = ctx.proj.xy(glat, glon)
        dist = float(((x1 - x2) ** 2 + (y1 - y2) ** 2) ** 0.5)
        dists.append(dist)
        inside = geohash(r._lat, r._lon, len(r.geohash)) == r.geohash
        ctx.add("fail" if dist > tol else "pass", "centroid", r["__id"], plot_name=r.choice_name, source_table="centroids", source_key=r["__id"],
                observed=f"{dist:.0f} m from the centre of geohash {r.geohash} ({'inside' if inside else 'outside'} the cell)", expected=f"<= {tol} m")
    n = sum(x > tol for x in dists)
    ctx.add("fail" if n else "pass", "project", "geohash centres", source_table="centroids",
            observed=f"{n}/{len(dists)} prescribed points are not at their geohash-cell centre (median {sorted(dists)[len(dists) // 2]:.0f} m, max {max(dists):.0f} m)",
            expected="midpoint = centroid of a geohash cell (Registration SOP)", message="design rule and coordinates disagree (confirmation item)" if n else "")


# ── K. Form / platform / documentation ───────────────────────────────────
@rule("K01")
def sop_form_conventions(ctx):
    e = ctx.data.extra
    typed = e.loc[e.entry_mode == "new_missing", "new_missing_canonical"]
    n_space, n_us = int(typed.str.contains(" ").sum()), int(typed.str.contains("_").sum())
    ctx.add("fail" if n_space else "pass", "project", "canonical separator", source_table="additional_species_repeat",
            observed=f"{n_space} typed canonicals use spaces, {n_us} underscores", expected="SOP step 7: Genus_species",
            message="SOP and form disagree; data follow the form (spaces). Align the SOP" if n_space else "")
    f = fields("herbaceous_veg_survey").set_index("name")
    par = f.parameters.get("location_quadrat", "")
    warn = re.search(r"warning-accuracy=(\d+)", par)
    ctx.add("fail" if warn and int(warn.group(1)) > ctx.th["max_accuracy_m"] else "pass", "project", "quadrat warning accuracy", source_table="form",
            observed=f"location_quadrat parameters: {par}", expected=f"SOP 4.2: accuracy <= {ctx.th['max_accuracy_m']} m (registration form warns at 5)")


@rule("K02")
def form_calculation_bug(ctx):
    e = ctx.data.extra
    named = e[e.validated_name.str.strip() != ""].groupby("PARENT_KEY").size()
    q = ctx.data.quadrat
    explained = wrong = 0
    for s in rows(ctx.data.survey):
        sub = q[q.PARENT_KEY == s.KEY]
        correct = sum(1 for k, sp in zip(sub.KEY, sub._species) if sp or named.get(k, 0) > 0)
        literal = sum(1 for k in sub.KEY if named.get(k, 0) > 0)
        if s._quadrats_with_species != correct:
            wrong += 1
            explained += s._quadrats_with_species == literal
    ctx.add("fail" if wrong else "pass", "project", "quadrats_with_species", source_table="form",
            observed=f"wrong in {wrong}/{len(ctx.data.survey)} surveys; {explained} equal the expression as written",
            expected="correct in-field summary (SOP step 13)",
            message="relative path `selected_herb_species_uuids` from quadrat_repeat misses the herb_species group: use herb_species/selected_herb_species_uuids" if wrong else "")


@rule("K03")
def rejection_keeps_entity_writes(ctx):
    d = ctx.data
    q = d.quadrat.set_index("KEY")
    s = d.survey.set_index("KEY")
    e = d.extra[d.extra.entry_mode.isin(["new_unknown", "new_missing"])].copy()
    e["review"] = e.PARENT_KEY.map(q.PARENT_KEY).map(s.ReviewState)
    rej = e[e.review == "rejected"]
    se = d.ent["species_extra"].set_index("__id")
    labels = sorted(se.label.get(t, t[:8]) for t in rej.target_extra_name.unique())
    ctx.add("fail" if len(rej) else "pass", "project", "entity writes of rejected submissions", source_table="species_extra",
            observed=f"{len(rej)} entity writes from rejected submissions remain ({', '.join(labels)})" if len(rej) else "none",
            expected="rejected submissions leave no entity state", message="ODK Central does not roll back entity updates on rejection: review/revert manually" if len(rej) else "")


@rule("K04")
def form_design(ctx):
    issues = design_issues("herbaceous_veg_survey") + design_issues("register_vegetation_plots")
    f = fields("herbaceous_veg_survey")
    img = f[f.base_type == "image"]
    px = img.parameters.str.extract(r"max-pixels=(\d+)")[0].dropna()
    if px.nunique() > 1:
        issues.append("herbaceous_veg_survey: image max-pixels differ (" + ", ".join(f"{n}={v}" for n, v in zip(img.name, img.parameters.str.extract(r'max-pixels=(\d+)')[0]) if pd.notna(v)) + ")")
    reg = fields("register_vegetation_plots").set_index("name")
    if not reg.choice_filter.get("selected_plot_uuid", "").strip():
        issues.append("register_vegetation_plots: plot list has no choice filter (an already-registered plot can be registered again)")
    for i in issues:
        ctx.add("fail", "project", i.split(":")[0] + ":" + i.split(":")[1][:40], source_table="form", observed=i, expected="clean form design")
    if not issues:
        ctx.add("pass", "project", "forms", observed="no design issues", expected="clean form design")


# ── P. Column profiling sweep ────────────────────────────────────────────
def _tables(ctx):
    d = ctx.data
    t = {f"export:{k}": v for k, v in d.raw.items()}
    t.update({f"entity:{k}": v for k, v in d.ent.items()})
    return t


@rule("P01")
def column_profile(ctx):
    for tname, df in _tables(ctx).items():
        for col in df.columns:
            if col.startswith("_"):
                continue
            v = df[col].astype(str)
            nonempty = v[v != ""]
            p = []
            pad = nonempty[nonempty != nonempty.str.strip()]
            if len(pad):
                p.append(f"{len(pad)} padded value(s) e.g. {pad.iloc[0]!r}")
            num = pd.to_numeric(nonempty, errors="coerce")
            if len(nonempty) >= 5 and 0.9 <= num.notna().mean() < 1:
                p.append(f"mostly numeric with non-numeric {sorted(nonempty[num.isna()].unique())[:3]}")
            if col in ("label", "choice_name", "species_number") and nonempty.duplicated().any():
                p.append(f"duplicated {col}: {sorted(nonempty[nonempty.duplicated()].unique())[:3]}")
            ctx.add("fail" if p else "pass", "column", f"{tname}.{col}", source_table=tname, observed="; ".join(p) or "ok", expected="clean column")


@rule("P02")
def junk_text(ctx):
    d = ctx.data
    plot_by_survey = d.survey.set_index("KEY").plot_name
    srcs = {"quadrat_repeat": d.raw["quadrat"], "survey": d.raw["survey"], "registration": d.raw["registration"]}
    for tname, cols in FREE_TEXT.items():
        df = srcs[tname]
        for col in cols:
            for _, r in df[df[col] != ""].iterrows():
                junk = bool(JUNK.match(r[col]))
                plot = plot_by_survey.get(r.PARENT_KEY, "") if tname == "quadrat_repeat" else r.get("plot_selection-plot_name", "")
                ctx.add("fail" if junk else "pass", "text", f"{r.KEY}:{col}", plot_name=plot, source_table=tname, source_key=r.KEY,
                        observed=repr(r[col]), expected="meaningful text or empty")


def _export_column(df: pd.DataFrame, name: str):
    hits = [c for c in df.columns if c == name or c.endswith("-" + name)]
    return hits[0] if len(hits) == 1 else None


@rule("P03")
def outside_choice_list(ctx):
    d = ctx.data
    for form, df in (("herbaceous_veg_survey", pd.concat([d.raw["survey"], d.raw["quadrat"], d.raw["extra"]], axis=0, ignore_index=True)),
                     ("register_vegetation_plots", d.raw["registration"])):
        ch = choices(form)
        for _, f in select_fields(form).iterrows():
            col = _export_column(df, f["name"])
            if col is None:
                continue
            allowed = set(map(str, ch.get(f.list_name, [])))
            vals = df[col].dropna().astype(str)
            vals = vals[vals != ""]
            toks = [t for v in vals for t in (v.split() if f.base_type == "select_multiple" else [v])]
            bad = sorted(set(toks) - allowed)
            # choice names that contain spaces are exported split into tokens (K04): accept their parts
            spaced = {p for a in allowed if " " in a for p in a.split()}
            bad = [b for b in bad if b not in spaced]
            ctx.add("fail" if bad else "pass", "column", f"{form}.{f['name']}", source_table=form, observed=f"{len(toks)} values; outside list: {bad}" if bad else f"{len(toks)} values in list '{f.list_name}'",
                    expected=f"choices of '{f.list_name}'")

"""Sampling effort: planned vs done, how complete each plot's species list is, and how repeatable it is.

Incidence data: a plot is T = 20 quadrats; Q_k = number of taxa found in exactly k quadrats; U = total
incidences (taxon x quadrat). Statistics (Chao et al. 2014 / Chao & Jost 2012, incidence form):
  * sample-based rarefaction  S(t) = sum_i [1 - C(T - Y_i, t) / C(T, t)]   (expected taxa in t random quadrats)
  * Chao2 = S_obs + (T-1)/T * Q1^2 / (2 Q2)    (bias-corrected (T-1)/T * Q1 (Q1-1) / 2 when Q2 = 0)
  * sample coverage  C = 1 - Q1/U * [(T-1) Q1 / ((T-1) Q1 + 2 Q2)]
    (share of the community's incidences belonging to taxa already seen; 1 - C = chance that one more
     quadrat's next record is a new taxon)
Both layers are reported: raw keys over-count taxa (several provisional ids = one species) and resolved
keys merge them; unresolved unknowns stay as their own taxa in both. Only canonical surveys count.
"""

from __future__ import annotations

from math import comb

import numpy as np
import pandas as pd

from .engine import rows

RESOLVED_OK = ["identified", "identified_uncurated", "unknown_unresolved", "unknown_uncurated"]


def incidence(occ: pd.DataFrame, survey_key: str, layer: str) -> pd.DataFrame:
    o = occ[occ.survey_key == survey_key]
    if layer == "resolved":
        o = o[o.resolved_status.isin(RESOLVED_OK)].assign(taxon=lambda x: x.resolved_key)
    else:
        o = o[o.raw_key != ""].assign(taxon=lambda x: x.raw_key)
    return o.drop_duplicates(["quadrat_number", "taxon"])[["quadrat_number", "taxon"]]


def stats(inc: pd.DataFrame, T: int) -> dict:
    y = inc.groupby("taxon").size()  # number of quadrats each taxon occupies
    s_obs, U = len(y), int(y.sum())
    q1, q2 = int((y == 1).sum()), int((y == 2).sum())
    if q2 > 0:
        chao2 = s_obs + (T - 1) / T * q1 ** 2 / (2 * q2)
    else:
        chao2 = s_obs + (T - 1) / T * q1 * (q1 - 1) / 2
    cov = 1 - (q1 / U) * ((T - 1) * q1 / ((T - 1) * q1 + 2 * q2)) if U and q1 else 1.0
    curve = [sum(1 - comb(T - yi, t) / comb(T, t) for yi in y) for t in range(1, T + 1)]
    return {"T": T, "S_obs": s_obs, "incidences": U, "Q1_uniques": q1, "Q2_duplicates": q2, "chao2": round(chao2, 1),
            "completeness": round(s_obs / chao2, 3) if chao2 else np.nan, "coverage": round(cov, 3),
            "new_taxa_last_quadrat": round(curve[-1] - curve[-2], 2), "curve": curve}


def plan_vs_done(plots: pd.DataFrame) -> pd.DataFrame:
    rows = []
    for stratum, g in plots.groupby("stratum"):
        prim, back = g[g.sample_status == "primary"], g[g.sample_status == "backup"]
        rows.append({"stratum": stratum, "primary_planned": len(prim), "primary_registered": int(prim.registered.sum()),
                     "primary_non_viable": int((prim.viable == "no").sum()), "primary_surveyed": int(prim.surveyed.sum()),
                     "backups_available": len(back), "backups_used": int(back.registered.sum()), "plots_surveyed": int(g.surveyed.sum()),
                     "share_of_primary_surveyed": round(prim.surveyed.mean(), 3) if len(prim) else np.nan})
    df = pd.DataFrame(rows)
    tot = df.drop(columns=["stratum", "share_of_primary_surveyed"]).sum()
    tot["stratum"] = "all"
    tot["share_of_primary_surveyed"] = round(tot.primary_surveyed / tot.primary_planned, 3)
    return pd.concat([df, tot.to_frame().T], ignore_index=True)


def per_plot(ctx) -> tuple[pd.DataFrame, pd.DataFrame]:
    s = ctx.data.survey[ctx.data.survey.KEY.isin(ctx.canonical)]
    team = ctx.data.ent["project_team"].set_index("__id").label
    recs, curves = [], []
    for r in rows(s):
        T = int((ctx.data.quadrat.PARENT_KEY == r.KEY).sum())
        for layer in ("raw", "resolved"):
            st = stats(incidence(ctx.occ, r.KEY, layer), T)
            curve = st.pop("curve")
            recs.append({"plot_name": r.plot_name, "survey_key": r.KEY, "layer": layer, "recorder": team.get(r.recorder_uuid, ""),
                         "duration_min": round((r._end - r._start).total_seconds() / 60, 1), "team_size": len(r._team), **st})
            curves += [{"plot_name": r.plot_name, "layer": layer, "quadrats": t, "expected_taxa": round(v, 2)} for t, v in enumerate(curve, 1)]
    df = pd.DataFrame(recs)
    df["person_minutes"] = (df.duration_min * df.team_size).round(0)
    return df.sort_values(["layer", "plot_name"]).reset_index(drop=True), pd.DataFrame(curves)


def project_level(ctx) -> pd.DataFrame:
    """Plots as sampling units: how complete is the project's species list after the surveyed plots?"""
    keys = sorted(ctx.canonical)
    rows = []
    for layer in ("raw", "resolved"):
        inc = []
        for i, k in enumerate(keys):
            taxa = incidence(ctx.occ, k, layer).taxon.unique()
            inc += [{"quadrat_number": i, "taxon": t} for t in taxa]  # plot index as the sampling unit
        st = stats(pd.DataFrame(inc), len(keys))
        st.pop("curve")
        rows.append({"layer": layer, "sampling_unit": "plot", **st})
    return pd.DataFrame(rows).rename(columns={"T": "units"})


def repeatability(ctx) -> pd.DataFrame:
    s = ctx.data.survey
    rows = []
    for plot, g in s.groupby("plot_name"):
        if len(g) < 2:
            continue
        g = g.sort_values("_start")
        a, b = g.KEY.iloc[0], g.KEY.iloc[1]
        for layer in ("raw", "resolved"):
            ia, ib = incidence(ctx.occ, a, layer), incidence(ctx.occ, b, layer)
            sa, sb = set(ia.taxon), set(ib.taxon)
            jq = []
            for n in range(1, 21):
                qa, qb = set(ia.taxon[ia.quadrat_number == n]), set(ib.taxon[ib.quadrat_number == n])
                if qa | qb:
                    jq.append(len(qa & qb) / len(qa | qb))
            rows.append({"plot_name": plot, "layer": layer, "first": f"{g._device.iloc[0]} {g._start.iloc[0]:%d %b %H:%M}Z", "second": f"{g._device.iloc[1]} {g._start.iloc[1]:%d %b %H:%M}Z",
                         "taxa_first": len(sa), "taxa_second": len(sb), "shared": len(sa & sb), "plot_jaccard": round(len(sa & sb) / len(sa | sb), 3),
                         "mean_quadrat_jaccard": round(float(np.mean(jq)), 3), "min_quadrat_jaccard": round(float(np.min(jq)), 3),
                         "duration_first_min": round(g._duration_min.iloc[0], 0), "duration_second_min": round(g._duration_min.iloc[1], 0)})
    return pd.DataFrame(rows)


def richness_sensitivity(ctx) -> pd.DataFrame:
    """How the headline richness moves with each data decision (all canonical surveys pooled)."""
    occ = ctx.occ
    canon = occ[occ.canonical_survey]
    res = canon[canon.resolved_status.isin(RESOLVED_OK)]
    rows = [
        ("raw keys, all 32 submissions", occ[occ.raw_key != ""].raw_key.nunique()),
        ("raw keys, canonical surveys", canon[canon.raw_key != ""].raw_key.nunique()),
        ("resolved (curation merges, woody excluded)", res.resolved_key.nunique()),
        ("resolved, identified taxa only", res[res.resolved_status.str.startswith("identified")].resolved_key.nunique()),
        ("resolved, unresolved unknowns only", res[res.resolved_status.str.startswith("unknown")].resolved_key.nunique()),
    ]
    return pd.DataFrame(rows, columns=["definition", "taxa"])


def all_tables(ctx, plots: pd.DataFrame) -> dict:
    pp, curves = per_plot(ctx)
    return {"effort_plan": plan_vs_done(plots), "effort_plots": pp, "effort_curves": curves, "effort_project": project_level(ctx),
            "effort_repeatability": repeatability(ctx), "effort_richness_sensitivity": richness_sensitivity(ctx)}

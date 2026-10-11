"""Sampling effort: planned vs done, how complete each plot's species list is, and how repeatable it is.

Incidence data: a plot is T = 20 quadrats; Y_i = quadrats occupied by taxon i; Q_k = number of taxa found in
exactly k quadrats; U = total incidences. Statistics (incidence form):
  * sample-based rarefaction  S(t) = sum_i [1 - C(T - Y_i, t) / C(T, t)]   (expected taxa in t random quadrats)
  * bias-corrected Chao2 = S_obs + (T-1)/T * Q1 (Q1 - 1) / (2 (Q2 + 1))   (Chao 2005), with the log-normal
    95% interval of Chao (1987)
  * sample coverage  C = 1 - Q1/U * [(T-1) Q1 / ((T-1) Q1 + 2 Q2)]   (Chao & Jost 2012): the share of the
    community's incidences belonging to taxa already seen
  * expected new taxa in one more quadrat  Q0 * Q1 / (T Q0 + Q1), Q0 = (T-1)/T * Q1^2 / (2 Q2)   (Chao et al. 2014)
  * observed incidence-based Hill numbers q = 0, 1, 2 from p_i = Y_i / U (richness, exp Shannon, inverse Simpson)
Both layers are reported: raw keys over-count taxa (several provisional ids = one species) and resolved
keys merge them; unresolved unknowns stay as their own taxa in both. Only canonical surveys count.
"""

from __future__ import annotations

from math import comb

import numpy as np
import pandas as pd

from .engine import rows
from .load import by_key

RESOLVED_OK = ["identified", "identified_uncurated", "unknown_unresolved", "unknown_uncurated"]


def incidence(occ: pd.DataFrame, survey_key: str, layer: str) -> pd.DataFrame:
    o = occ[occ.survey_key == survey_key]
    if layer == "resolved":
        o = o[o.resolved_status.isin(RESOLVED_OK)].assign(taxon=lambda x: x.resolved_key)
    else:
        o = o[o.raw_key != ""].assign(taxon=lambda x: x.raw_key)
    return o.drop_duplicates(["quadrat_number", "taxon"])[["quadrat_number", "taxon"]]


def chao2_bc(s_obs: int, q1: int, q2: int, T: int) -> tuple[float, float, float]:
    """Bias-corrected Chao2 (Chao 2005; always defined) with its log-normal 95% interval (Chao 1987)."""
    k = (T - 1) / T
    f0 = k * q1 * (q1 - 1) / (2 * (q2 + 1))
    var = (k * q1 * (q1 - 1) / (2 * (q2 + 1)) + k ** 2 * q1 * (2 * q1 - 1) ** 2 / (4 * (q2 + 1) ** 2)
           + k ** 2 * q1 ** 2 * q2 * (q1 - 1) ** 2 / (4 * (q2 + 1) ** 4))
    if f0 <= 0:
        return float(s_obs), float(s_obs), float(s_obs)
    c = np.exp(1.96 * np.sqrt(np.log(1 + var / f0 ** 2)))
    return s_obs + f0, s_obs + f0 / c, s_obs + f0 * c


def coverage(y: np.ndarray, T: int) -> float:
    U, q1, q2 = int(y.sum()), int((y == 1).sum()), int((y == 2).sum())
    if not U or not q1:
        return 1.0
    if q2 > 0:
        return 1 - (q1 / U) * ((T - 1) * q1 / ((T - 1) * q1 + 2 * q2))
    return 1 - (q1 / U) * ((T - 1) * (q1 - 1) / ((T - 1) * (q1 - 1) + 2))  # Q2 = 0 (Chao & Jost 2012; iNEXT)


def hill(y: np.ndarray) -> tuple[float, float, float]:
    """Observed incidence-based Hill numbers q = 0, 1, 2 from relative quadrat frequencies p_i = Y_i / U."""
    p = y / y.sum()
    return float(len(y)), float(np.exp(-(p * np.log(p)).sum())), float(1 / (p ** 2).sum())


def empty_stats(T: int, note: str) -> dict:
    """No quadrats, or quadrats without any taxon: richness is what was observed (0), every ratio and
    estimator is undefined (NaN, never 100% or infinity), and the note says why."""
    nan = float("nan")
    return {"T": T, "S_obs": 0, "incidences": 0, "Q1_uniques": 0, "Q2_duplicates": 0, "chao2": 0.0 if T else nan, "chao2_lo95": nan, "chao2_hi95": nan,
            "completeness": nan, "coverage": nan, "new_taxa_next_quadrat": nan, "hill_q0": 0.0 if T else nan, "hill_q1": nan, "hill_q2": nan,
            "note": note, "curve": [0.0] * T}


def stats(inc: pd.DataFrame, T: int) -> dict:
    """No interval is given for coverage: a naive bootstrap over quadrats is biased upwards (resampled
    quadrats turn uniques into duplicates); a valid interval needs Chao's assemblage bootstrap (iNEXT)."""
    if T == 0:
        return empty_stats(0, "no quadrats: survey incomplete, metrics undefined (A03)")
    if inc.empty:
        return empty_stats(T, f"no taxa in {T} quadrats: a valid zero, richness 0, ratios undefined")
    y = inc.groupby("taxon").size().to_numpy()  # number of quadrats each taxon occupies
    s_obs, U = len(y), int(y.sum())
    q1, q2 = int((y == 1).sum()), int((y == 2).sum())
    chao2, lo, hi = chao2_bc(s_obs, q1, q2, T)
    q0_classic = (T - 1) / T * (q1 ** 2 / (2 * q2) if q2 else q1 * (q1 - 1) / 2)
    next_q = q0_classic * (q1 / (T * q0_classic + q1)) if q0_classic else 0.0  # extrapolated S(T+1) - S(T)
    curve = [sum(1 - comb(T - yi, t) / comb(T, t) for yi in y) for t in range(1, T + 1)]
    h0, h1, h2 = hill(y)
    return {"T": T, "S_obs": s_obs, "incidences": U, "Q1_uniques": q1, "Q2_duplicates": q2,
            "chao2": round(chao2, 1), "chao2_lo95": round(lo, 1), "chao2_hi95": round(hi, 1),
            "completeness": round(s_obs / chao2, 3) if chao2 else np.nan, "coverage": round(coverage(y, T), 3),
            "new_taxa_next_quadrat": round(next_q, 2), "hill_q0": h0, "hill_q1": round(h1, 2), "hill_q2": round(h2, 2), "note": "", "curve": curve}


def plan_vs_done(plots: pd.DataFrame) -> pd.DataFrame:
    """Per prescribed point (plots.csv has one row per point and replicate): a point counts as surveyed
    if any replicate surveyed it."""
    plots = plots.sort_values("surveyed", ascending=False).drop_duplicates("plot_uuid")
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
    team = by_key(ctx.data.ent["project_team"], "__id").label
    recs, curves = [], []
    for r in rows(s):
        T = int((ctx.data.quadrat.PARENT_KEY == r.KEY).sum())  # 20 by design; A03 flags any other count
        for layer in ("raw", "resolved"):
            st = stats(incidence(ctx.occ, r.KEY, layer), T)
            curve = st.pop("curve")
            recs.append({"plot_name": r.plot_name, "replicate": r.replicate, "survey_key": r.KEY, "layer": layer, "recorder": team.get(r.recorder_uuid, ""),
                         "duration_min": round((r._end - r._start).total_seconds() / 60, 1), "team_size": len(r._team), **st})
            curves += [{"plot_name": r.plot_name, "replicate": r.replicate, "layer": layer, "quadrats": t, "expected_taxa": round(v, 2)} for t, v in enumerate(curve, 1)]
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
    for (plot, rep), g in s.groupby(["plot_name", "replicate"]):  # repeat visits within ONE monitoring round only
        if len(g) < 2:
            continue
        g = g.sort_values("_start")
        a, b = g.KEY.iloc[0], g.KEY.iloc[1]
        for layer in ("raw", "resolved"):
            ia, ib = incidence(ctx.occ, a, layer), incidence(ctx.occ, b, layer)
            sa, sb = set(ia.taxon), set(ib.taxon)
            jq = []
            for n in sorted(set(ia.quadrat_number) | set(ib.quadrat_number)):
                qa, qb = set(ia.taxon[ia.quadrat_number == n]), set(ib.taxon[ib.quadrat_number == n])
                if qa | qb:
                    jq.append(len(qa & qb) / len(qa | qb))
            team = by_key(ctx.data.ent["project_team"], "__id").label
            union = sa | sb
            rows.append({"plot_name": plot, "replicate": rep, "layer": layer, "first": f"{g._device.iloc[0]} {g._start.iloc[0]:%d %b %H:%M}Z", "second": f"{g._device.iloc[1]} {g._start.iloc[1]:%d %b %H:%M}Z",
                         "recorder_first": team.get(g.recorder_uuid.iloc[0], ""), "recorder_second": team.get(g.recorder_uuid.iloc[1], ""),
                         "taxa_first": len(sa), "taxa_second": len(sb), "shared": len(sa & sb), "plot_jaccard": round(len(sa & sb) / len(union), 3) if union else np.nan,
                         "mean_quadrat_jaccard": round(float(np.mean(jq)), 3) if jq else np.nan, "min_quadrat_jaccard": round(float(np.min(jq)), 3) if jq else np.nan,
                         "duration_first_min": round(g._duration_min.iloc[0], 0), "duration_second_min": round(g._duration_min.iloc[1], 0)})
    return pd.DataFrame(rows)


def richness_sensitivity(ctx) -> pd.DataFrame:
    """How the headline richness moves with each data decision (all canonical surveys pooled)."""
    from .gbif import load_cache
    from .taxonomy import norm_name

    occ = ctx.occ
    canon = occ[occ.canonical_survey]
    res = canon[canon.resolved_status.isin(RESOLVED_OK)]
    n_sub = occ.survey_key.nunique()
    gb = load_cache()["names"]

    def gbif_key(name, key):
        g = gb.get(str(name).strip(), {})
        return norm_name(g["canonicalName"]) if g.get("matchType") in ("EXACT", "FUZZY") and g.get("rank") in ("SPECIES", "SUBSPECIES", "VARIETY") else key

    ident = res[res.resolved_status.str.startswith("identified")]
    rows = [
        (f"raw keys, all {n_sub} submissions", occ[occ.raw_key != ""].raw_key.nunique()),
        ("raw keys, canonical surveys", canon[canon.raw_key != ""].raw_key.nunique()),
        ("resolved (curation merges, woody excluded)", res.resolved_key.nunique()),
        ("resolved, names matched to GBIF species (spelling variants collapsed)",
         len({gbif_key(n, k) for n, k in zip(ident.resolved_name, ident.resolved_key)}) + res[res.resolved_status.str.startswith("unknown")].resolved_key.nunique()),
        ("resolved, identified taxa only", ident.resolved_key.nunique()),
        ("resolved, unresolved unknowns only", res[res.resolved_status.str.startswith("unknown")].resolved_key.nunique()),
    ]
    return pd.DataFrame(rows, columns=["definition", "taxa"])


def all_tables(ctx, plots: pd.DataFrame) -> dict:
    pp, curves = per_plot(ctx)
    return {"effort_plan": plan_vs_done(plots), "effort_plots": pp, "effort_curves": curves, "effort_project": project_level(ctx),
            "effort_repeatability": repeatability(ctx), "effort_richness_sensitivity": richness_sensitivity(ctx)}

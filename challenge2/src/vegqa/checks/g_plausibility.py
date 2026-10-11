"""G. Distribution and plausibility (context flags, severity info)."""

from __future__ import annotations

import numpy as np

from ..engine import rows, rule
from ..load import by_key

RESOLVED_OK = ["identified", "identified_uncurated", "unknown_unresolved", "unknown_uncurated"]


def _richness(occ, survey_key, layer):
    o = occ[occ.survey_key == survey_key]
    if layer == "raw":
        return o.raw_key.replace("", np.nan).dropna().nunique()
    return o[o.resolved_status.isin(RESOLVED_OK)].resolved_key.nunique()


@rule("G01")
def richness_outlier(ctx):
    lim = ctx.th["richness_robust_z"]
    s = ctx.data.survey[ctx.data.survey.KEY.isin(ctx.canonical)]
    for layer in ("resolved", "raw"):
        rich = {k: _richness(ctx.occ, k, layer) for k in s.KEY}
        v = np.array(list(rich.values()), float)
        med, mad = np.median(v), np.median(np.abs(v - np.median(v)))
        for r in rows(s):
            z = 0.6745 * (rich[r.KEY] - med) / mad if mad else 0.0
            ctx.add("fail" if abs(z) > lim else "pass", "plot", f"{r.plot_name}:{layer}", plot_name=r.plot_name, survey_key=r.KEY, source_table="survey", source_key=r.KEY,
                    observed=f"{layer} richness {rich[r.KEY]} (median {med:.0f}, robust z {z:+.1f})", expected=f"|robust z| <= {lim}")


@rule("G02")
def quadrat_without_herbs(ctx):
    plot = by_key(ctx.data.survey, "KEY").plot_name
    for r in rows(ctx.data.quadrat):
        none = r.herbs_present == "no"
        ctx.add("fail" if none else "pass", "quadrat", r.KEY, plot_name=plot.get(r.PARENT_KEY, ""), survey_key=r.PARENT_KEY, source_table="quadrat_repeat", source_key=r.KEY,
                observed=f"herbs_present={r.herbs_present}", expected="herbs present (context)", message="valid zero: counts as a sampled quadrat (V-06)" if none else "")


@rule("G03")
def recorder_balance(ctx):
    th, team = ctx.th, by_key(ctx.data.ent["project_team"], "__id").label
    s = ctx.data.survey[ctx.data.survey.KEY.isin(ctx.canonical)]
    for form, df in (("survey", s), ("registration", ctx.data.registration)):
        counts = df.recorder_uuid.map(team).value_counts()
        top_share = counts.iloc[0] / counts.sum()
        never = sorted(set(team) - set(counts.index))
        detail = ", ".join(f"{k} {v}" for k, v in counts.items())
        if form == "survey":
            stats = []
            for rec, g in s.groupby(s.recorder_uuid.map(team)):
                rich = np.mean([_richness(ctx.occ, k, "resolved") for k in g.KEY])
                o = ctx.occ[ctx.occ.survey_key.isin(g.KEY)]
                unk = o.resolved_status.isin(["unknown_unresolved", "unknown_uncurated"]).mean()
                stats.append(f"{rec}: mean richness {rich:.1f}, {unk:.0%} unknown records")
            detail += " | " + "; ".join(stats)
        ctx.add("fail" if top_share > th["recorder_share_info"] else "pass", "project", f"recorders ({form}s)", source_table=form,
                observed=f"{detail}; never recorder: {', '.join(never) or 'none'}", expected=f"no recorder above {th['recorder_share_info']:.0%}",
                message="recorder and plot effects cannot be separated; cross-check identifications" if top_share > th["recorder_share_info"] else "")


@rule("G04")
def repeat_agreement(ctx):
    lim = ctx.th["repeat_jaccard_info"]
    s = ctx.data.survey
    o = ctx.occ[ctx.occ.resolved_status.isin(RESOLVED_OK)]
    for (plot, _rep), g in s.groupby(["plot_name", "replicate"]):  # repeat visits within one replicate
        if len(g) < 2:
            continue
        a, b = g.KEY.iloc[0], g.KEY.iloc[1]
        sets = {k: set(o.loc[o.survey_key == k, "resolved_key"]) for k in (a, b)}
        jp = len(sets[a] & sets[b]) / len(sets[a] | sets[b]) if sets[a] | sets[b] else float("nan")
        jq = []
        for n in range(1, ctx.th["quadrats_per_survey"] + 1):
            qa = set(o.loc[(o.survey_key == a) & (o.quadrat_number == n), "resolved_key"])
            qb = set(o.loc[(o.survey_key == b) & (o.quadrat_number == n), "resolved_key"])
            if qa | qb:
                jq.append(len(qa & qb) / len(qa | qb))
        ctx.add("fail" if jp < lim else "pass", "plot", plot, plot_name=plot, source_table="survey", source_key=f"{a};{b}",
                observed=f"plot Jaccard {jp:.2f} ({len(sets[a])} vs {len(sets[b])} taxa); mean quadrat Jaccard {np.mean(jq) if jq else float('nan'):.2f}",
                expected=f"plot Jaccard >= {lim}", message="observer/detection noise estimate for the effort section" if jp < lim else "")

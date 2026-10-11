"""Export everything the Vegetation QA/QC dashboard page needs to one JSON file.

The dashboard (dashboard/src/components/VegetationQA.tsx) embeds outputs/dashboard_results.json at
build time, so it never re-implements a rule or a statistic: it filters, plots and links what the
pipeline computed. Each list is a table in column-oriented form ({"columns": [...], "rows": [[...]]})
to keep the file small.
"""

from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np
import pandas as pd

from .model import geometry, positions
from .load import by_key

SEV_ORDER = {"info": 1, "warning": 2, "error": 3}


def _clean(v):
    if v is None:
        return None
    if isinstance(v, (np.integer,)):
        return int(v)
    if isinstance(v, (np.floating, float)):
        return None if math.isnan(v) else round(float(v), 6)
    if isinstance(v, (np.bool_,)):
        return bool(v)
    if isinstance(v, pd.Timestamp):
        return None if pd.isna(v) else v.isoformat()
    if v is pd.NaT:
        return None
    return v


def table(df: pd.DataFrame, cols: list[str] | None = None) -> dict:
    df = df[cols] if cols else df
    return {"columns": list(df.columns), "rows": [[_clean(v) for v in r] for r in df.itertuples(index=False)]}


def _timeline(ctx) -> pd.DataFrame:
    d = ctx.data
    team = by_key(d.ent["project_team"], "__id").label
    s = pd.DataFrame({"key": d.survey.KEY, "form": "survey", "plot_name": d.survey.plot_name, "device": d.survey._device,
                      "recorder": d.survey.recorder_uuid.map(team), "start": d.survey._start, "end": d.survey._end, "submitted": d.survey._submitted,
                      "review": d.survey.ReviewState.replace("", "not reviewed"), "canonical": d.survey.KEY.isin(ctx.canonical),
                      "base_active_herb_count": d.survey._base_active_herb_count})
    r = pd.DataFrame({"key": d.registration.KEY, "form": "registration", "plot_name": d.registration.plot_name, "device": d.registration._device,
                      "recorder": d.registration.recorder_uuid.map(team), "start": d.registration._start, "end": d.registration._end,
                      "submitted": d.registration._submitted, "review": d.registration.ReviewState.replace("", "not reviewed"), "canonical": True,
                      "base_active_herb_count": np.nan})
    return pd.concat([s, r], ignore_index=True).sort_values("start")


def _transects(ctx) -> pd.DataFrame:
    g = geometry(ctx)
    r = by_key(ctx.data.registration, "plot_uuid")
    out = g[g.has_geometry][["plot_uuid", "plot_name", "cx", "cy", "endpoint_a_x", "endpoint_a_y", "midpoint_x", "midpoint_y", "endpoint_b_x", "endpoint_b_y",
                             "endpoint_a_acc", "midpoint_acc", "endpoint_b_acc", "midpoint_offset_m", "ab_m", "angle_amb_deg", "bearing_deg"]].copy()
    for p in ("endpoint_a", "midpoint", "endpoint_b"):
        out[f"{p}_lat"] = out.plot_uuid.map(r[f"_{p}_lat"])
        out[f"{p}_lon"] = out.plot_uuid.map(r[f"_{p}_lon"])
    return out


def _quadrats(ctx, results) -> pd.DataFrame:
    q = positions(ctx)
    f = results[(results.status == "fail") & (results.entity_type == "quadrat")]
    worst = f.assign(o=f.severity.map(SEV_ORDER)).groupby("entity_key").o.max().map({v: k for k, v in SEV_ORDER.items()})
    rules = f.groupby("entity_key").rule_id.apply(lambda x: " ".join(sorted(set(x))))
    return pd.DataFrame({
        "quadrat_key": q.KEY, "survey_key": q.PARENT_KEY, "plot_uuid": q.plot_uuid, "plot_name": q.plot_name, "canonical": q.PARENT_KEY.isin(ctx.canonical),
        "n": q._quadrat_number, "x": q.x, "y": q.y, "lat": q._lat, "lon": q._lon, "acc": q._acc, "alt": q._alt, "lateral": q.lateral_m, "along": q.along_m,
        "herbs": q.herbs_present, "all_unknown": q.all_unknown, "n_list": q._species.map(len), "photo_time": q._photo_time,
        "worst": q.KEY.map(worst), "rules": q.KEY.map(rules).fillna(""),
    })


def _taxa(ctx) -> pd.DataFrame:
    """One row per resolved taxon (canonical surveys): records, plots, raw keys/names behind it, status."""
    o = ctx.occ[ctx.occ.canonical_survey & (ctx.occ.resolved_status != "unresolvable")]
    rows = []
    for key, g in o.groupby(o.resolved_key.where(o.resolved_key != "", "(excluded)")):
        rows.append({"taxon": g.resolved_name.iloc[0] if key != "(excluded)" else "(excluded by curation)", "status": g.resolved_status.mode().iloc[0],
                     "records": len(g), "plots": g.plot_name.nunique(), "quadrats": g.quadrat_key.nunique(),
                     "raw_keys": " · ".join(sorted(set(g.slot_number.where(g.slot_number != "", g.raw_name)))),
                     "raw_names": " · ".join(sorted({n.strip() for n in g.raw_name if n and not n.startswith(("herb_", "wood_"))}))[:200],
                     "curation": " ".join(sorted({c for c in g.curation_note if c}))[:200]})
    return pd.DataFrame(rows).sort_values(["status", "records"], ascending=[True, False])


def export(ctx, tables: dict, results: pd.DataFrame, summary: pd.DataFrame, run_id: str, path: Path) -> Path:
    flags = results[results.status == "fail"].copy()
    s = by_key(ctx.data.survey, "KEY")
    r = by_key(ctx.data.registration, "KEY")
    day = pd.concat([(s._start + pd.Timedelta(hours=3)).dt.strftime("%Y-%m-%d"), (r._start + pd.Timedelta(hours=3)).dt.strftime("%Y-%m-%d")])
    dev = pd.concat([s._device, r._device])
    # flags on additional-species rows carry the row's KEY: resolve it to its survey through the quadrat
    q_parent = by_key(ctx.data.quadrat, "KEY").PARENT_KEY
    x_survey = by_key(ctx.data.extra, "KEY").PARENT_KEY.map(q_parent)
    sk = flags.survey_key.where(flags.survey_key != "", flags.source_key.map(x_survey).fillna(flags.source_key))
    flags["day"] = sk.map(day).fillna("")
    flags["device"] = sk.map(dev).fillna("")
    flags["group"] = flags.rule_id.str[0]
    cat = ctx.catalogue["rules"]
    flags["title"] = flags.rule_id.map(lambda x: cat[x]["title"])
    flags["metric_impact"] = flags.rule_id.map(lambda x: cat[x]["metric_impact"])
    flags["canonical"] = ~sk.isin(set(ctx.data.survey.KEY) - set(ctx.canonical))
    # attributes for the dashboard's shared filters (empty where a flag has no such attribute)
    team = by_key(ctx.data.ent["project_team"], "__id").label
    rep = pd.concat([s.replicate, r["survey_begin-replicate"]])
    rec = pd.concat([s.recorder_uuid, r.recorder_uuid]).map(team)
    strat = by_key(ctx.data.ent["centroids"], "choice_name").stratum_label
    flags["replicate"] = sk.map(rep).fillna("")
    flags["recorder"] = sk.map(rec).fillna("")
    flags["stratum"] = flags.plot_name.map(strat).fillna("")
    out = {
        "generated_by": "challenge2/src/run_challenge2.py",
        "run_id": run_id,
        "catalogue_version": ctx.catalogue["version"],
        "thresholds": {k: v for k, v in ctx.th.items() if not isinstance(v, dict)},
        "status_counts": results.status.value_counts().to_dict(),
        "fail_by_severity": flags.severity.value_counts().to_dict(),
        "overview": tables["survey_overview"].iloc[0].map(_clean).to_dict(),
        "rules": table(summary.fillna(0)),
        "flags": table(flags, ["flag_id", "evidence_hash", "rule_id", "group", "title", "severity", "metric_impact", "entity_type", "entity_key", "plot_name", "survey_key",
                               "source_table", "source_key", "observed", "expected", "message", "day", "device", "recorder", "replicate", "stratum", "canonical"]),
        "submissions": table(tables["submissions"]),
        "timeline": table(_timeline(ctx)),
        "plots": table(tables["plots"]),
        "transects": table(_transects(ctx)),
        "quadrats": table(_quadrats(ctx, results)),
        "effort_plan": table(tables["effort_plan"]),
        "effort_plots": table(tables["effort_plots"]),
        "effort_curves": table(tables["effort_curves"]),
        "effort_project": table(tables["effort_project"]),
        "effort_repeatability": table(tables["effort_repeatability"]),
        "effort_sensitivity": table(tables["effort_richness_sensitivity"]),
        "taxa": table(_taxa(ctx)),
        "suggestions": table(tables["species_list_suggestions"]),
        "projection": {"lat0": ctx.proj.lat0, "lon0": ctx.proj.lon0},
    }
    path.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":"), default=str) + "\n")
    return path

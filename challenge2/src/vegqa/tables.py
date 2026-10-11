"""Deliverable tables (cleaned = interpreted + joined, never corrected), each carrying its QA flag counts.

  survey_overview.csv  one row: the herbaceous survey as a whole (survey entity savmon|lw|herbs|ho, lw_baseline)
  submissions.csv      one row per survey submission (canonical flag, timing, device, flags)
  plots.csv            one row per prescribed point (centroid): plan, registration, geometry, canonical survey, richness
  quadrats.csv         one row per quadrat: position on the transect, photo time, species counts, flags
  occurrences.csv      one row per recorded occurrence, raw and resolved taxon
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from .engine import rows as rows_
from .model import geometry, positions

SEVERITIES = ["error", "warning", "info"]


def flag_counts(results: pd.DataFrame, key_col: str, by: str) -> pd.DataFrame:
    """Failures per entity key and severity, plus the list of failing rule ids."""
    f = results[results.status == "fail"]
    if by == "survey":
        f = f[f.survey_key != ""]
        keys = f.survey_key
    elif by == "plot":
        f = f[f.plot_name != ""]
        keys = f.plot_name
    else:
        keys = f.entity_key
    g = f.assign(_k=keys).groupby("_k")
    out = pd.DataFrame({f"n_{s}": g.severity.apply(lambda x, s=s: int((x == s).sum())) for s in SEVERITIES})
    out["failed_rules"] = g.rule_id.apply(lambda x: " ".join(sorted(set(x))))
    return out.rename_axis(key_col).reset_index()


def _richness(occ: pd.DataFrame, key: str):
    o = occ[occ.survey_key == key]
    raw = o.raw_key.replace("", np.nan).dropna().nunique()
    res = o[o.resolved_status.isin(["identified", "identified_uncurated", "unknown_unresolved", "unknown_uncurated"])]
    return raw, res.resolved_key.nunique(), res[res.resolved_status.str.startswith("identified")].resolved_key.nunique()


def submissions(ctx, results) -> pd.DataFrame:
    s = ctx.data.survey
    team = ctx.data.ent["project_team"].set_index("__id").label
    df = pd.DataFrame({
        "survey_key": s.KEY, "plot_name": s.plot_name, "replicate": s.replicate, "canonical": s.KEY.isin(ctx.canonical),
        "review_state": s.ReviewState.replace("", "not reviewed"), "device": s._device, "recorder": s.recorder_uuid.map(team),
        "team_size": s._team.map(len), "start_utc": s._start, "end_utc": s._end, "submitted_utc": s._submitted,
        "duration_min": s._duration_min.round(1), "upload_delay_h": s._delay_h.round(1), "n_quadrats": s.KEY.map(ctx.data.quadrat.groupby("PARENT_KEY").size()).fillna(0).astype(int),
        "base_active_herb_count": s._base_active_herb_count, "quadrats_with_species_stored": s._quadrats_with_species,
    })
    rich = df.survey_key.map(lambda k: _richness(ctx.occ, k))
    df["richness_raw"], df["richness_resolved"], df["richness_resolved_identified"] = zip(*rich)
    df = df.merge(flag_counts(results, "survey_key", "survey"), on="survey_key", how="left")
    return df.sort_values("start_utc").reset_index(drop=True)


def plots(ctx, results) -> pd.DataFrame:
    d = ctx.data
    c = d.ent["centroids"]
    g = geometry(ctx).set_index("plot_uuid")
    reg = d.registration.set_index("plot_uuid")
    canon = d.survey[d.survey.KEY.isin(ctx.canonical)].set_index("_centroid_uuid")
    q = d.quadrat
    rows = []
    for r in rows_(c):
        pu = r["__id"]
        row = {"plot_uuid": pu, "plot_name": r.choice_name, "sample_status": r.sample_status, "stratum": r.stratum_label,
               "prescribed_lat": r._lat, "prescribed_lon": r._lon}
        row["registered"] = pu in reg.index
        if row["registered"]:
            rr = reg.loc[pu]
            row.update(viable=rr.viable, ecosystem=rr.ecosystem, establishment_notes=rr.establishment_notes, registration_key=rr.KEY,
                       registration_device=rr._device, registered_utc=rr._end)
            if g.loc[pu, "has_geometry"]:
                gg = g.loc[pu]
                row.update(midpoint_lat=rr._midpoint_lat, midpoint_lon=rr._midpoint_lon, midpoint_offset_m=round(gg.midpoint_offset_m, 1),
                           transect_length_m=round(gg.ab_m, 1), half_a_m=round(gg.am_m, 1), half_b_m=round(gg.mb_m, 1),
                           angle_amb_deg=round(gg.angle_amb_deg, 0), bearing_deg=round(gg.bearing_deg, 0), deviation_ns_deg=round(gg.deviation_ns_deg, 0))
        row["surveyed"] = pu in canon.index
        if row["surveyed"]:
            s = canon.loc[pu]
            raw, res, ident = _richness(ctx.occ, s.KEY)
            qq = q[q.PARENT_KEY == s.KEY]
            row.update(canonical_survey_key=s.KEY, survey_date=(s._start + pd.Timedelta(hours=3)).date(), recorder=d.ent["project_team"].set_index("__id").label.get(s.recorder_uuid, ""),
                       n_submissions=int((d.survey._centroid_uuid == pu).sum()), quadrats=len(qq), quadrats_no_herbs=int((qq.herbs_present == "no").sum()),
                       quadrats_all_unknown=int((qq.all_unknown == "yes").sum()), richness_raw=raw, richness_resolved=res, richness_resolved_identified=ident)
        rows.append(row)
    df = pd.DataFrame(rows)
    return df.merge(flag_counts(results, "plot_name", "plot"), on="plot_name", how="left")


def quadrats(ctx, results) -> pd.DataFrame:
    q = positions(ctx)
    n_list = q._species.map(len)
    n_extra = q.KEY.map(ctx.data.extra.groupby("PARENT_KEY").size()).fillna(0).astype(int)
    df = pd.DataFrame({
        "quadrat_key": q.KEY, "survey_key": q.PARENT_KEY, "plot_name": q.plot_name, "canonical": q.PARENT_KEY.isin(ctx.canonical),
        "quadrat_number": q._quadrat_number.astype("Int64"), "herbs_present": q.herbs_present, "all_unknown": q.all_unknown,
        "n_list_species": n_list, "n_additional_rows": n_extra, "lat": q._lat, "lon": q._lon, "altitude_m": q._alt, "accuracy_m": q._acc,
        "along_registered_m": q.along_m.round(1), "lateral_registered_m": q.lateral_m.round(1), "residual_own_line_m": q.own_line_resid_m.round(1),
        "photo": q.image, "photo_time_utc": q._photo_time, "comment": q.comment,
    })
    return df.merge(flag_counts(results, "quadrat_key", "entity"), on="quadrat_key", how="left")


def occurrences(ctx, results) -> pd.DataFrame:
    o = ctx.occ.copy()
    cols = ["occurrence_id", "survey_key", "plot_name", "canonical_survey", "quadrat_key", "quadrat_number", "source", "entry_mode", "raw_key", "raw_name",
            "raw_group", "slot_number", "resolved_name", "resolved_key", "resolved_status", "curation_note"]
    return o[cols].merge(flag_counts(results, "occurrence_id", "entity"), on="occurrence_id", how="left")


def survey_overview(ctx, results, subs, plots_df) -> pd.DataFrame:
    d = ctx.data
    sv = d.ent["surveys"]
    herbs = sv[sv.target_group == "herbs"].iloc[0]
    canon = subs[subs.canonical]
    occ = ctx.occ[ctx.occ.canonical_survey]
    res = occ[occ.resolved_status.isin(["identified", "identified_uncurated", "unknown_unresolved", "unknown_uncurated"])]
    f = results[results.status == "fail"]
    row = {
        "survey_entity": herbs.label, "survey_uuid": herbs["__id"], "replicate": ", ".join(sorted(d.survey.replicate.unique())),
        "first_day": (d.survey._start.min() + pd.Timedelta(hours=3)).date(), "last_day": (d.survey._end.max() + pd.Timedelta(hours=3)).date(),
        "field_days": int((d.survey._start + pd.Timedelta(hours=3)).dt.date.nunique()),
        "primary_points_planned": int((plots_df.sample_status == "primary").sum()), "backup_points": int((plots_df.sample_status == "backup").sum()),
        "plots_registered": int(plots_df.registered.sum()), "plots_viable": int((plots_df.viable == "yes").sum()), "plots_surveyed": int(plots_df.surveyed.sum()),
        "submissions": len(subs), "submissions_rejected": int((subs.review_state == "rejected").sum()), "canonical_surveys": len(canon),
        "quadrats_canonical": int(canon.n_quadrats.sum()), "occurrences_canonical": len(occ),
        "taxa_raw": occ.raw_key.replace("", np.nan).dropna().nunique(), "taxa_resolved": res.resolved_key.nunique(),
        "taxa_resolved_identified": res[res.resolved_status.str.startswith("identified")].resolved_key.nunique(),
        "devices": ", ".join(sorted(d.survey._device.unique())), "recorders": int(d.survey.recorder_uuid.nunique()),
        "flags_error": int((f.severity == "error").sum()), "flags_warning": int((f.severity == "warning").sum()), "flags_info": int((f.severity == "info").sum()),
    }
    return pd.DataFrame([row])

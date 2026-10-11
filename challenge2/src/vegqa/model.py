"""Derived tables shared by checks and reports: canonical survey choice, registration geometry,
quadrat positions relative to the registered transect. Nothing here changes a source value."""

from __future__ import annotations

import numpy as np
import pandas as pd

from .geo import LocalProjection, angle_at, bearing_deg, deviation_from_ns, dist, robust_line, segment_frame
from .load import by_key


def projection(d) -> LocalProjection:
    c = d.ent["centroids"]
    return LocalProjection(c._lat.mean(), c._lon.mean())


EXCLUDED_REVIEW_STATES = ("rejected", "hasIssues")


def canonical_survey_keys(d, excluded=EXCLUDED_REVIEW_STATES) -> tuple[set, pd.DataFrame]:
    """V-01. At most one canonical submission per plot and replicate: among submissions whose ODK review
    state is not excluded (rejected, hasIssues), the latest by end time. A plot whose submissions are all
    excluded has NO canonical survey (J03 reports it): an excluded submission never counts towards
    richness or effort. Returns the canonical KEYs and a table explaining each choice."""
    s = d.survey.copy()
    s["_excluded"] = s.ReviewState.isin(excluded)
    s = s.sort_values(["plot_uuid", "replicate", "_excluded", "_end"], ascending=[True, True, True, False])
    first = ~s.duplicated(["plot_uuid", "replicate"], keep="first")
    s["canonical"] = first & ~s._excluded
    s["n_submissions"] = s.groupby(["plot_uuid", "replicate"]).KEY.transform("size")
    s["canonical_reason"] = np.where(s._excluded, "excluded: review state " + s.ReviewState,
                                     np.where(~s.canonical, "not canonical: an eligible submission ends later",
                                              np.where(s.n_submissions == 1, "only submission", "kept: latest eligible submission")))
    return set(s.loc[s.canonical, "KEY"]), s[["KEY", "plot_name", "replicate", "ReviewState", "_device", "canonical", "n_submissions", "canonical_reason"]]


def registration_geometry(d, proj: LocalProjection) -> pd.DataFrame:
    """Per registration: prescribed point, A/M/B in metres, distances, angle, bearing, accuracies."""
    c = by_key(d.ent["centroids"], "__id")
    rows = []
    for _, r in d.registration.iterrows():
        row = {"KEY": r.KEY, "plot_uuid": r.plot_uuid, "plot_name": r.plot_name, "viable": r.viable, "sample_status": r.sample_status}
        cx, cy = (proj.xy(c.loc[r.plot_uuid, "_lat"], c.loc[r.plot_uuid, "_lon"]) if r.plot_uuid in c.index else (np.nan, np.nan))
        row.update(cx=float(cx), cy=float(cy))
        pts = {}
        for p in ("endpoint_a", "midpoint", "endpoint_b"):
            lat, lon, acc = r[f"_{p}_lat"], r[f"_{p}_lon"], r[f"_{p}_acc"]
            x, y = proj.xy(lat, lon) if pd.notna(lat) and pd.notna(lon) else (np.nan, np.nan)
            pts[p] = (float(x), float(y))
            row.update({f"{p}_x": float(x), f"{p}_y": float(y), f"{p}_acc": acc})
        A, M, B, C = pts["endpoint_a"], pts["midpoint"], pts["endpoint_b"], (row["cx"], row["cy"])
        have = not np.isnan(A[0] + M[0] + B[0])
        row["has_geometry"] = have
        if have:
            row.update(
                midpoint_offset_m=float(dist(M, C)), am_m=float(dist(A, M)), mb_m=float(dist(M, B)), ab_m=float(dist(A, B)),
                angle_amb_deg=angle_at(A, M, B), bearing_deg=bearing_deg(A, B), deviation_ns_deg=deviation_from_ns(bearing_deg(A, B)),
            )
            length, project = segment_frame(A, B)
            row["mid_offline_m"] = float(abs(project([M[0]], [M[1]])[1][0]))  # perpendicular distance of M from line A-B
        rows.append(row)
    return pd.DataFrame(rows)


def quadrat_positions(d, proj: LocalProjection, geom: pd.DataFrame) -> pd.DataFrame:
    """Each quadrat's along-line position and signed lateral offset relative to its plot's registered
    A->B segment, plus its residual from the survey's own robust line."""
    g = by_key(geom, "plot_uuid")
    s = by_key(d.survey, "KEY")
    q = d.quadrat.copy()
    q["plot_uuid"] = q.PARENT_KEY.map(s._centroid_uuid)  # registration geometry is keyed by centroid
    q["plot_name"] = q.PARENT_KEY.map(s.plot_name)
    x, y = proj.xy(q._lat, q._lon)
    q["x"], q["y"] = x, y
    q["along_m"], q["lateral_m"], q["own_line_resid_m"], q["own_along_m"] = np.nan, np.nan, np.nan, np.nan
    for key, idx in q.groupby("PARENT_KEY").groups.items():
        sub = q.loc[idx]
        pu = sub.plot_uuid.iloc[0]
        if pu in g.index and g.loc[pu, "has_geometry"]:
            A = (g.loc[pu, "endpoint_a_x"], g.loc[pu, "endpoint_a_y"])
            B = (g.loc[pu, "endpoint_b_x"], g.loc[pu, "endpoint_b_y"])
            _, project = segment_frame(A, B)
            al, la = project(sub.x.to_numpy(), sub.y.to_numpy())
            q.loc[idx, "along_m"], q.loc[idx, "lateral_m"] = al, la
        ok = sub[["x", "y"]].notna().all(axis=1)
        if ok.sum() >= 5:
            c, u, res = robust_line(sub.x[ok].to_numpy(), sub.y[ok].to_numpy())
            q.loc[sub.index[ok], "own_line_resid_m"] = res
            q.loc[sub.index[ok], "own_along_m"] = (sub.x[ok].to_numpy() - c[0]) * u[0] + (sub.y[ok].to_numpy() - c[1]) * u[1]
    return q


def geometry(ctx) -> pd.DataFrame:
    return ctx.cached("geometry", lambda: registration_geometry(ctx.data, ctx.proj))


def positions(ctx) -> pd.DataFrame:
    return ctx.cached("positions", lambda: quadrat_positions(ctx.data, ctx.proj, geometry(ctx)))


def registration_for(ctx) -> pd.DataFrame:
    """Registration rows indexed by centroid uuid (one registration per plot in this data; A02 checks it)."""
    return ctx.cached("reg_by_plot", lambda: by_key(ctx.data.registration.drop_duplicates("plot_uuid"), "plot_uuid"))

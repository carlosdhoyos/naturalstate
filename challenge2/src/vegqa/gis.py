"""Transect locations for GIS: one GeoJSON file (RFC 7946, WGS84 longitude/latitude) with

- every registered transect as a LineString A -> M -> B, at the registered coordinates;
- every prescribed point (centroid entity) with its plan status;
- every canonical quadrat with its worst position flag.

Coordinates are copied from the exports, never adjusted. Altitudes are left out on purpose: the
dataset's altitudes sit about 705 m below the terrain (E14, C-7) and should not be reused until confirmed.
"""

from __future__ import annotations

import json
from pathlib import Path

import pandas as pd

from .engine import rows
from .model import positions, registration_for, transect_geometry

GEOMETRY_RULES = ["D01", "D02", "D03", "D04", "E03", "E05"]  # where the transect is and what shape it has
SEV = {"info": 1, "warning": 2, "error": 3}


def point_status(p: pd.Series) -> str:
    if p.surveyed:
        return f"surveyed ({p.sample_status})"
    if p.registered:
        return "registered, not viable" if p.viable == "no" else "registered, not surveyed"
    return "primary, never registered" if p.sample_status == "primary" else "backup, unused"


def prescribed_points(plots: pd.DataFrame) -> pd.DataFrame:
    """One row per prescribed point (the plots mart has one row per plot and replicate)."""
    pts = plots.sort_values("surveyed", ascending=False).drop_duplicates("plot_uuid").copy()
    pts["status"] = [point_status(r) for _, r in pts.iterrows()]
    return pts


def worst_flags(results: pd.DataFrame, rule_ids: list[str], key: str, canonical: set | None = None) -> tuple[pd.Series, pd.Series]:
    """Worst severity and rule ids per key. With `canonical`, survey-level results count only for the
    canonical survey (a rejected repeat must not colour the plot); registration-level results always count."""
    f = results[(results.status == "fail") & results.rule_id.isin(rule_ids)]
    if canonical is not None:
        f = f[(f.survey_key == "") | f.survey_key.isin(canonical)]
    worst = f.assign(o=f.severity.map(SEV)).groupby(key).o.max().map({v: k for k, v in SEV.items()})
    which = f.groupby(key).rule_id.apply(lambda x: " ".join(sorted(set(x))))
    return worst, which


def _r(v):
    return None if pd.isna(v) else round(float(v), 7)


def transects_geojson(ctx, plots: pd.DataFrame, results: pd.DataFrame) -> dict:
    g = transect_geometry(ctx)  # one registration per plot, the same as plots.csv and the figures
    g = g[g.has_geometry]
    reg = registration_for(ctx)
    pts = prescribed_points(plots).set_index("plot_uuid")
    worst, which = worst_flags(results, GEOMETRY_RULES, "plot_name", ctx.canonical)
    feats = []
    for r in rows(g):
        rr = reg.loc[r.plot_uuid]
        coords = [[_r(rr[f"_{p}_lon"]), _r(rr[f"_{p}_lat"])] for p in ("endpoint_a", "midpoint", "endpoint_b")]
        p = pts.loc[r.plot_uuid] if r.plot_uuid in pts.index else None
        feats.append({"type": "Feature", "geometry": {"type": "LineString", "coordinates": coords}, "properties": {
            "kind": "transect", "plot_name": r.plot_name, "stratum": None if p is None else p.stratum, "status": None if p is None else p.status,
            "registration_key": rr.KEY, "length_m": round(r.ab_m, 1), "bearing_deg": round(r.bearing_deg, 1), "midpoint_offset_m": round(r.midpoint_offset_m, 1),
            "accuracy_m": [_r(r.endpoint_a_acc), _r(r.midpoint_acc), _r(r.endpoint_b_acc)],
            "worst_geometry_flag": worst.get(r.plot_name, "none"), "geometry_flags": which.get(r.plot_name, ""),
        }})
    for uuid, p in pts.iterrows():
        feats.append({"type": "Feature", "geometry": {"type": "Point", "coordinates": [_r(p.prescribed_lon), _r(p.prescribed_lat)]}, "properties": {
            "kind": "prescribed_point", "plot_name": p.plot_name, "stratum": p.stratum, "sample_status": p.sample_status, "status": p.status}})
    q = positions(ctx)
    q = q[q.PARENT_KEY.isin(ctx.canonical)]
    qw, qr = worst_flags(results[results.entity_type == "quadrat"], ["E01", "E02", "E04", "E06"], "entity_key")
    for r in rows(q):
        if pd.isna(r._lat) or pd.isna(r._lon):
            continue
        feats.append({"type": "Feature", "geometry": {"type": "Point", "coordinates": [_r(r._lon), _r(r._lat)]}, "properties": {
            "kind": "quadrat", "plot_name": r.plot_name, "quadrat_key": r.KEY, "quadrat_number": None if pd.isna(r._quadrat_number) else int(r._quadrat_number),
            "along_m": None if pd.isna(r.along_m) else round(r.along_m, 1), "lateral_m": None if pd.isna(r.lateral_m) else round(r.lateral_m, 1),
            "worst_position_flag": qw.get(r.KEY, "none"), "position_flags": qr.get(r.KEY, "")}})
    return {"type": "FeatureCollection", "name": "vegetation_transects",
            "description": "Registered transects (A-M-B), prescribed points and canonical quadrats; WGS84 lon/lat as exported; altitudes omitted (E14, C-7).",
            "features": feats}


def write(ctx, plots: pd.DataFrame, results: pd.DataFrame, path: Path) -> Path:
    path.write_text(json.dumps(transects_geojson(ctx, plots, results), ensure_ascii=False, separators=(",", ":")) + "\n")
    return path

"""E. Quadrat geometry and timing.

Positions are tested against the registered A->B segment (where the plot is) and against the survey's
own robust line (where the team actually walked), with GPS-aware tolerances (V-04). The walking order
is not assumed: the teams walk out-and-back (E13), so nothing here relies on the SOP's order.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from ..engine import rows, rule
from ..model import geometry, positions


def gps_status(z, th, strong, weak):
    """z beyond gps_z_error -> `strong` severity; beyond gps_z_warning -> `weak`; else pass."""
    if pd.isna(z):
        return "could_not_check", None
    if z > th["gps_z_error"]:
        return "fail", strong
    if z > th["gps_z_warning"]:
        return "fail", weak
    return "pass", None


def _qadd(ctx, status, r, observed, expected, message="", severity=None):
    ctx.add(status, "quadrat", r.KEY, plot_name=r.plot_name, survey_key=r.PARENT_KEY, source_table="quadrat_repeat", source_key=r.KEY,
            observed=observed, expected=expected, message=message, severity=severity)


def _sadd(ctx, status, s, observed, expected, message="", severity=None):
    ctx.add(status, "survey", s.KEY, plot_name=s.plot_name, survey_key=s.KEY, source_table="survey", source_key=s.KEY,
            observed=observed, expected=expected, message=message, severity=severity)


def _line_acc(ctx) -> pd.Series:
    """RMS accuracy of the registered endpoints, per centroid uuid (the error of the registered line)."""
    g = geometry(ctx).set_index("plot_uuid")
    return np.sqrt((g.endpoint_a_acc ** 2 + g.endpoint_b_acc ** 2) / 2)


def _survey_offsets(ctx) -> pd.DataFrame:
    def build():
        q, th = positions(ctx), ctx.th
        la = _line_acc(ctx)
        out = []
        for key, sub in q.groupby("PARENT_KEY"):
            lat = sub.lateral_m.dropna()
            if len(lat) < 5:
                out.append({"KEY": key, "offset_m": np.nan, "z": np.nan})
                continue
            lo, hi = lat.quantile([0.1, 0.9])
            off = float(lat[(lat >= lo) & (lat <= hi)].mean())  # trimmed mean of the signed lateral offsets
            sd = float(np.hypot(la.get(sub.plot_uuid.iloc[0], np.nan), sub._acc.median()))
            out.append({"KEY": key, "offset_m": off, "z": abs(off) / sd, "sd": sd, "median_abs_lateral": float(lat.abs().median())})
        return pd.DataFrame(out).set_index("KEY")
    return ctx.cached("survey_offsets", build)


@rule("E01")
def quadrat_accuracy(ctx):
    lim = ctx.th["max_accuracy_m"]
    for r in rows(positions(ctx)):
        if pd.isna(r._acc):
            _qadd(ctx, "could_not_check", r, "", "", "no accuracy")
            continue
        _qadd(ctx, "fail" if r._acc > lim else "pass", r, f"{r._acc} m", f"<= {lim} m")


@rule("E02")
def quadrat_in_belt(ctx):
    th = ctx.th
    lo, hi = th["quadrat_lateral_min_m"], th["quadrat_lateral_max_m"]
    g = geometry(ctx).set_index("plot_uuid")
    la = _line_acc(ctx)
    offs = _survey_offsets(ctx)
    for r in rows(positions(ctx)):
        if pd.isna(r.lateral_m) or r.plot_uuid not in g.index:
            _qadd(ctx, "could_not_check", r, "", "", "no registered segment or position")
            continue
        L = g.ab_m[r.plot_uuid]
        dl = max(lo - abs(r.lateral_m), abs(r.lateral_m) - hi, 0.0)
        da = max(-r.along_m, r.along_m - L, 0.0)
        excess = float(np.hypot(dl, da))
        z = excess / float(np.hypot(r._acc, la[r.plot_uuid]))
        status, sev = gps_status(z, th, "warning", "info")
        whole = offs.z.get(r.PARENT_KEY, 0) > th["gps_z_warning"]
        _qadd(ctx, status, r, f"lateral {r.lateral_m:+.1f} m, along {r.along_m:.1f} of {L:.1f} m; {excess:.1f} m outside the belt (z={z:.1f})",
              f"{lo}-{hi} m from the registered line, within GPS error", "whole transect offset (E03)" if status == "fail" and whole else "", sev)


@rule("E03")
def transect_offset(ctx):
    th = ctx.th
    offs = _survey_offsets(ctx)
    q = positions(ctx)
    g = geometry(ctx).set_index("plot_uuid")
    for s in rows(ctx.data.survey):
        if s.KEY not in offs.index or pd.isna(offs.z[s.KEY]):
            _sadd(ctx, "could_not_check", s, "", "", "no registered segment or too few positions")
            continue
        o = offs.loc[s.KEY]
        status, sev = gps_status(o.z, th, "error", "warning")
        msg = ""
        sub = q[q.PARENT_KEY == s.KEY]
        reg_b = g.bearing_deg.get(s._centroid_uuid, np.nan)
        ok = sub[["x", "y"]].notna().all(axis=1)
        _, _, vt = np.linalg.svd(sub.loc[ok, ["x", "y"]].to_numpy() - sub.loc[ok, ["x", "y"]].to_numpy().mean(axis=0))
        own_b = float(np.degrees(np.arctan2(vt[0][0], vt[0][1])) % 180)
        dang = abs((own_b - reg_b + 90) % 180 - 90)
        if status == "pass" and abs(o.offset_m) > 2 * th["quadrat_lateral_max_m"]:
            status, sev, msg = "fail", "info", "offset wider than the belt but within GPS error: cannot be separated from GPS bias"
        if dang > th["walked_line_rotation_deg"]:
            msg = (msg + "; " if msg else "") + "walked line rotated against the registered line"
            if status == "pass" or sev == "info":
                status, sev = "fail", "warning"
        _sadd(ctx, status, s, f"mean signed lateral offset {o.offset_m:+.1f} m (z={o.z:.1f}, sd {o.sd:.1f} m); median |lateral| {o.median_abs_lateral:.1f} m; "
              f"walked line {dang:.0f} deg from the registered line", "quadrats centred on and parallel to the registered line, within GPS error", msg, severity=sev)


@rule("E04")
def own_line_outlier(ctx):
    th, hi = ctx.th, ctx.th["quadrat_lateral_max_m"]
    q = positions(ctx)
    med_acc = q.groupby("PARENT_KEY")._acc.median()
    for r in rows(q):
        if pd.isna(r.own_line_resid_m):
            _qadd(ctx, "could_not_check", r, "", "", "too few positions for a line")
            continue
        excess = max(r.own_line_resid_m - hi, 0.0)
        z = excess / float(np.hypot(r._acc, med_acc[r.PARENT_KEY]))
        status, sev = gps_status(z, th, "warning", "info")
        _qadd(ctx, status, r, f"{r.own_line_resid_m:.1f} m from the survey's own line (z={z:.1f})", f"<= {hi} m (both sides of the tape) within GPS error", severity=sev)


@rule("E05")
def coverage(ctx):
    th = ctx.th
    share, L0 = th["coverage_min_share"], th["transect_length_m"]
    q = positions(ctx)
    g = geometry(ctx).set_index("plot_uuid")
    for s in rows(ctx.data.survey):
        sub = q[q.PARENT_KEY == s.KEY]
        if s._centroid_uuid not in g.index or sub.along_m.isna().all():
            _sadd(ctx, "could_not_check", s, "", "", "no registered segment")
            continue
        L = g.ab_m[s._centroid_uuid]
        a = sub.along_m.clip(0, L)
        reg_cov = float((a.max() - a.min()) / L)
        own_span = float(sub.own_along_m.max() - sub.own_along_m.min())
        bad = reg_cov < share or own_span / L0 < share
        half = "A half" if a.median() < L / 2 else "B half"
        _sadd(ctx, "fail" if bad else "pass", s, f"covers {reg_cov:.0%} of the registered {L:.0f} m (mostly the {half}); walked span {own_span:.0f} m",
              f">= {share:.0%} of the transect")


@rule("E06")
def duplicate_coordinates(ctx):
    q = ctx.data.quadrat
    dup = q[q.lat != ""].duplicated(["PARENT_KEY", "lat", "lon"], keep=False)
    dup = dup.reindex(q.index, fill_value=False)
    for r, isdup in zip(rows(positions(ctx)), dup):
        if isdup:
            others = q[(q.PARENT_KEY == r.PARENT_KEY) & (q.lat == r.lat) & (q.lon == r.lon) & (q.KEY != r.KEY)]._quadrat_number.astype(int).tolist()
            _qadd(ctx, "fail", r, f"same coordinates as quadrat(s) {others}", "a fresh GPS fix per quadrat")
        else:
            _qadd(ctx, "pass", r, "unique", "a fresh GPS fix per quadrat")


@rule("E07")
def altitude_outlier(ctx):
    """Robust z within the survey catches isolated glitches; the jump test catches runs of glitched
    quadrats (which shift the median) as a step between consecutive quadrats 5 m apart."""
    lim, jump = ctx.th["altitude_mad_z"], ctx.th["altitude_jump_m"]
    q = positions(ctx).sort_values(["PARENT_KEY", "_quadrat_number"])
    for key, sub in q.groupby("PARENT_KEY"):
        med = sub._alt.median()
        mad = (sub._alt - med).abs().median()
        prev = np.nan
        for r in rows(sub):
            if pd.isna(r._alt):
                _qadd(ctx, "could_not_check", r, "", "", "no altitude")
                continue
            z = 0.6745 * (r._alt - med) / mad if mad else 0.0
            step = r._alt - prev
            bad = abs(z) > lim or abs(step) > jump
            _qadd(ctx, "fail" if bad else "pass", r, f"{r._alt:.0f} m ({r._alt - med:+.0f} m from the survey median, robust z {z:+.1f}; step {step:+.0f} m from the previous quadrat)",
                  f"|robust z| <= {lim} and |step| <= {jump} m")
            prev = r._alt


@rule("E08")
def photo_in_window(ctx):
    s = ctx.data.survey.set_index("KEY")
    for r in rows(positions(ctx)):
        t = r._photo_time
        if pd.isna(t):
            _qadd(ctx, "could_not_check", r, r.image, "", "photo time not readable from the file name")
            continue
        a, b = s._start[r.PARENT_KEY], s._end[r.PARENT_KEY]
        ok = a <= t <= b
        _qadd(ctx, "pass" if ok else "fail", r, f"{t:%d %b %H:%M:%S}Z", f"{a:%H:%M:%S}-{b:%H:%M:%S}Z")


@rule("E09")
def photo_order(ctx):
    q = positions(ctx).sort_values(["PARENT_KEY", "_quadrat_number"])
    for key, sub in q.groupby("PARENT_KEY"):
        prev = None
        for r in rows(sub):
            if prev is not None and pd.notna(r._photo_time) and pd.notna(prev._photo_time):
                back = (r._photo_time - prev._photo_time).total_seconds()
                _qadd(ctx, "fail" if back < 0 else "pass", r, f"photo {back / 60:+.1f} min after quadrat {int(prev._quadrat_number)}'s",
                      "photos in quadrat order", "taken before the previous quadrat's photo" if back < 0 else "")
            prev = r


@rule("E10")
def quadrat_gap(ctx):
    lim = ctx.th["min_seconds_between_quadrats"]
    q = positions(ctx).sort_values(["PARENT_KEY", "_photo_time"])
    for key, sub in q.groupby("PARENT_KEY"):
        prev = None
        for r in rows(sub):
            if prev is not None and pd.notna(r._photo_time) and pd.notna(prev._photo_time):
                gap = (r._photo_time - prev._photo_time).total_seconds()
                _qadd(ctx, "fail" if gap < lim else "pass", r, f"{gap:.0f} s after the previous photo (quadrat {int(prev._quadrat_number)})", f">= {lim} s")
            prev = r


@rule("E11")
def duplicate_photos(ctx):
    d = ctx.data
    files = [("quadrat_repeat", k, f) for k, f in zip(d.quadrat.KEY, d.quadrat.image)]
    files += [("additional_species_repeat", k, f) for c in [f"macro_images-macro_{i}" for i in range(1, 6)] for k, f in zip(d.extra.KEY, d.extra[c])]
    img_cols = [c for c in d.registration.columns if "-image_" in c]
    files += [("registration", k, f) for c in img_cols for k, f in zip(d.registration.KEY, d.registration[c])]
    f = pd.DataFrame(files, columns=["table", "key", "file"])
    f = f[f.file.str.strip() != ""]
    counts = f.file.value_counts()
    for r in rows(f):
        n = int(counts[r.file])
        ctx.add("fail" if n > 1 else "pass", "photo", f"{r.table}:{r.key}:{r.file}", source_table=r.table, source_key=r.key, observed=f"{r.file} used {n}x", expected="each photo file once")


@rule("E12")
def confirmation_location(ctx):
    d, proj, lim = ctx.data, ctx.proj, ctx.th["background_point_max_m"]
    g = geometry(ctx).set_index("plot_uuid")
    items = [("survey", r.KEY, r.plot_name, r._centroid_uuid, r._bg_lat, r._bg_lon, r.KEY) for r in rows(d.survey)]
    items += [("registration", r.KEY, r.plot_name, r.plot_uuid, r._bg_lat, r._bg_lon, "") for r in rows(d.registration)]
    for form, key, plot, pu, lat, lon, skey in items:
        if pd.isna(lat) or pd.isna(lon):
            ctx.add("could_not_check", form, key, plot_name=plot, survey_key=skey, source_table=form, source_key=key, observed="missing",
                    message="background geopoint not captured at confirmation")
            continue
        if pu not in g.index or not g.has_geometry[pu]:
            ref = (g.cx[pu], g.cy[pu]) if pu in g.index else (np.nan, np.nan)
            what = "prescribed point"
        else:
            ref, what = (g.midpoint_x[pu], g.midpoint_y[pu]), "registered midpoint"
        x, y = proj.xy(lat, lon)
        dist = float(np.hypot(x - ref[0], y - ref[1]))
        ctx.add("fail" if dist > lim else "pass", form, key, plot_name=plot, survey_key=skey, source_table=form, source_key=key,
                observed=f"{dist:.0f} m from the {what}", expected=f"<= {lim} m")


@rule("E13")
def walking_order(ctx):
    """Correlate along-line position with quadrat number under two templates: the SOP (both sides at each
    5 m mark: positions 0,0,5,5,...) and out-and-back (one side out, the other back: 0,5,...,45,45,...,0)."""
    q = positions(ctx).sort_values(["PARENT_KEY", "_quadrat_number"])
    N = ctx.th["quadrats_per_survey"]
    n = np.arange(1, N + 1)
    sop = np.floor((n - 1) / 2) * 5
    oab = np.where(n <= N // 2, (n - 1) * 5, (N - n) * 5)
    kinds = []
    for s in rows(ctx.data.survey):
        sub = q[q.PARENT_KEY == s.KEY]
        a = sub.own_along_m.to_numpy()
        if len(a) != N or np.isnan(a).any():
            _sadd(ctx, "could_not_check", s, "", "", f"needs {N} positioned quadrats")
            continue
        c_sop, c_oab = abs(np.corrcoef(a, sop)[0, 1]), abs(np.corrcoef(a, oab)[0, 1])
        kind = "out-and-back" if c_oab > c_sop else "SOP pairs"
        kinds.append(kind)
        _sadd(ctx, "fail" if kind != "SOP pairs" else "pass", s, f"{kind} (corr SOP {c_sop:.2f}, out-and-back {c_oab:.2f})", "SOP order: both sides at each 5 m mark")
    n_oab = kinds.count("out-and-back")
    ctx.add("fail" if n_oab else "pass", "project", "all surveys", source_table="quadrat_repeat", observed=f"{n_oab}/{len(kinds)} surveys walked out-and-back",
            expected="SOP order", message="consistent practice: spatially equivalent; confirm it is accepted (confirmation item)" if n_oab > len(kinds) / 2 else "")


@rule("E14")
def altitude_vs_terrain(ctx):
    """Median (GPS altitude - SRTM terrain) per submission, from the cached DEM reference (vegqa.dem)."""
    from ..dem import key, load_cache

    dem = ctx.cached("dem", lambda: load_cache()["points"])
    tol = ctx.th["dem_altitude_tolerance_m"]
    d = ctx.data
    items = []
    for s in rows(d.survey):
        sub = d.quadrat[d.quadrat.PARENT_KEY == s.KEY]
        items.append(("survey", s.KEY, s.plot_name, s.KEY, list(zip(sub._lat, sub._lon, sub._alt))))
    for r in rows(d.registration):
        pts = [(r[f"_{p}_lat"], r[f"_{p}_lon"], r[f"_{p}_alt"]) for p in ("endpoint_a", "midpoint", "endpoint_b")]
        items.append(("registration", r.KEY, r.plot_name, "", pts))
    all_diffs = []
    for form, key_, plot, skey, pts in items:
        diffs = [alt - dem[key(a, b)] for a, b, alt in pts if pd.notna(a) and pd.notna(alt) and key(a, b) in dem]
        if not diffs:
            ctx.add("could_not_check", form, key_, plot_name=plot, survey_key=skey, source_table=form, source_key=key_, message="no positions with altitude in the DEM cache")
            continue
        med = float(np.median(diffs))
        all_diffs += diffs
        ctx.add("fail" if abs(med) > tol else "pass", form, key_, plot_name=plot, survey_key=skey, source_table=form, source_key=key_,
                observed=f"GPS altitude {med:+.0f} m against SRTM terrain (median of {len(diffs)} points)", expected=f"within {tol} m")
    if all_diffs:
        v = np.array(all_diffs)
        ctx.add("fail" if abs(np.median(v)) > tol else "pass", "project", "altitude vs terrain", source_table="reference/elevation_cache.json",
                observed=f"{len(v)} points: GPS minus terrain median {np.median(v):+.0f} m (range {v.min():+.0f} to {v.max():+.0f} m)",
                expected=f"within {tol} m", message="systematic offset: positions and altitudes do not belong to the same place (confirmation item)" if abs(np.median(v)) > tol else "")

"""D. Registration geometry and plot metadata.

GPS-aware tests (V-04): a measured distance is compared with its design value relative to the GPS error
of the points involved, z = |measured - design| / sqrt(sum of squared reported accuracies). The reported
ODK accuracy is used as one standard deviation, which is conservative (it over-states the error of a
distance, so fewer plots are flagged). z > gps_z_warning -> warning, z > gps_z_error -> error.
"""

from __future__ import annotations

import re

import numpy as np
import pandas as pd

from ..engine import rows, rule
from ..model import geometry

TEMPORARY_REASONS = re.compile(r"rain|wet|flood|weather|dark|late|time|animal|elephant|buffalo|lion|rhino|tired|vehicle|car\b", re.I)


def _z_status(z, th):
    if pd.isna(z):
        return "could_not_check", None
    if z > th["gps_z_error"]:
        return "fail", "error"
    if z > th["gps_z_warning"]:
        return "fail", "warning"
    return "pass", None


def _viable_with_geometry(ctx):
    g = geometry(ctx)
    return g[g.has_geometry]


def _add(ctx, status, r, observed, expected, message="", severity=None):
    ctx.add(status, "plot", r.plot_name, plot_name=r.plot_name, source_table="registration", source_key=r.KEY, observed=observed, expected=expected,
            message=message, severity=severity)


@rule("D01")
def midpoint_offset(ctx):
    th = ctx.th
    lim, watch = th["midpoint_max_offset_m"], th["midpoint_watch_offset_m"]
    for r in rows(_viable_with_geometry(ctx)):
        off, acc = r.midpoint_offset_m, r.midpoint_acc
        if off > lim + 2 * acc:
            status, sev, msg = "fail", "error", f"beyond {lim} m even allowing 2x the midpoint GPS accuracy ({acc} m)"
        elif off > lim:
            status, sev, msg = "fail", "warning", "beyond the SOP limit, within GPS error of it"
        elif off > watch:
            status, sev, msg = "fail", "info", f"within {lim - watch} m of the limit"
        else:
            status, sev, msg = "pass", None, ""
        _add(ctx, status, r, f"{off:.1f} m (midpoint accuracy {acc} m)", f"<= {lim} m from the prescribed point", msg, sev)


@rule("D02")
def half_lengths(ctx):
    th, half = ctx.th, ctx.th["half_length_m"]
    for r in rows(_viable_with_geometry(ctx)):
        za = abs(r.am_m - half) / np.hypot(r.endpoint_a_acc, r.midpoint_acc)
        zb = abs(r.mb_m - half) / np.hypot(r.midpoint_acc, r.endpoint_b_acc)
        status, sev = _z_status(max(za, zb), th)
        _add(ctx, status, r, f"A-M {r.am_m:.1f} m (z={za:.1f}), M-B {r.mb_m:.1f} m (z={zb:.1f})", f"{half} m each, within GPS error", severity=sev)


@rule("D03")
def transect_length(ctx):
    th, L = ctx.th, ctx.th["transect_length_m"]
    for r in rows(_viable_with_geometry(ctx)):
        z = abs(r.ab_m - L) / np.hypot(r.endpoint_a_acc, r.endpoint_b_acc)
        status, sev = _z_status(z, th)
        _add(ctx, status, r, f"A-B {r.ab_m:.1f} m (z={z:.1f}; accuracies {r.endpoint_a_acc}/{r.endpoint_b_acc} m)", f"{L} m within GPS error", severity=sev)


@rule("D04")
def straightness(ctx):
    th = ctx.th
    for r in rows(_viable_with_geometry(ctx)):
        sd = np.sqrt(r.midpoint_acc ** 2 + (r.endpoint_a_acc ** 2 + r.endpoint_b_acc ** 2) / 4)
        z = r.mid_offline_m / sd
        status, sev = _z_status(z, th)
        _add(ctx, status, r, f"midpoint {r.mid_offline_m:.1f} m off the A-B line (z={z:.1f}); angle A-M-B {r.angle_amb_deg:.0f} deg",
             "straight transect (midpoint on A-B) within GPS error", severity=sev)


@rule("D05")
def orientation(ctx):
    lim = ctx.th["ns_deviation_deg"]
    g = _viable_with_geometry(ctx)
    for r in rows(g):
        dev = r.deviation_ns_deg
        _add(ctx, "fail" if dev > lim else "pass", r, f"bearing {r.bearing_deg:.0f} deg, {dev:.0f} deg off north-south", f"<= {lim} deg (laid out N-S)")
    n_bad = int((g.deviation_ns_deg > lim).sum())
    ctx.add("fail" if n_bad else "pass", "project", "all plots", source_table="registration",
            observed=f"{n_bad}/{len(g)} transects more than {lim} deg off N-S (range {g.deviation_ns_deg.min():.0f}-{g.deviation_ns_deg.max():.0f} deg)",
            expected="N-S layout; rotation only for obstacles", message="systematic: a protocol deviation, not obstacles (confirmation item)" if n_bad > len(g) / 2 else "")


@rule("D06")
def point_accuracy(ctx):
    lim = ctx.th["max_accuracy_m"]
    for r in rows(_viable_with_geometry(ctx)):
        accs = {p: r[f"{p}_acc"] for p in ("endpoint_a", "midpoint", "endpoint_b")}
        bad = {p: a for p, a in accs.items() if a > lim}
        _add(ctx, "fail" if bad else "pass", r, ", ".join(f"{p} {a} m" for p, a in accs.items()), f"<= {lim} m")


@rule("D07")
def vegplot_geometry(ctx):
    d = ctx.data
    vp = d.ent["vegplots"].set_index("plot_uuid")
    for _, r in d.registration.iterrows():
        if r.viable != "yes":
            continue
        if r.plot_uuid not in vp.index:
            _add(ctx, "fail", r, "no vegplot entity for the plot", "vegplot written by the registration")
            continue
        v = vp.loc[r.plot_uuid]
        dlat, dlon = abs(v._lat - r._midpoint_lat), abs(v._lon - r._midpoint_lon)
        ok = dlat < 1e-7 and dlon < 1e-7
        _add(ctx, "pass" if ok else "fail", r, "identical" if ok else f"vegplot {v._lat:.7f},{v._lon:.7f} vs midpoint {r._midpoint_lat:.7f},{r._midpoint_lon:.7f}",
             "vegplot geometry = registered midpoint (save_to)")


@rule("D08")
def ecosystem_vs_stratum(ctx):
    allowed = ctx.th["stratum_ecosystems"]
    for _, r in ctx.data.registration.iterrows():
        if r.viable != "yes":
            continue
        ok_list = allowed.get(r.stratum, [])
        ok = r.ecosystem in ok_list
        _add(ctx, "pass" if ok else "fail", r, f"{r.ecosystem} in stratum {r.stratum}", f"one of {ok_list}",
             "" if ok else "obvious stratum mismatch can justify non-viability (Reg. SOP 3); confirm stratum / viability")
    reg = ctx.data.registration[ctx.data.registration.viable == "yes"]
    eco_names = sorted(ctx.data.ent["ecosystem_types"].label)
    for stratum, g in reg.groupby("stratum"):
        counts = g.ecosystem.value_counts()
        top, n = counts.index[0], int(counts.iloc[0])
        same_word = any(stratum.lower() in e.lower() for e in eco_names)
        ctx.add("fail" if not same_word else "pass", "project", f"stratum {stratum}", source_table="registration",
                observed=f"{stratum}: " + ", ".join(f"{k} {v}" for k, v in counts.items()) + f"; ecosystem list: {', '.join(eco_names)}",
                expected="the ecosystem list can express the stratum", severity="info",
                message=f"no '{stratum}' ecosystem option: {n}/{len(g)} plots recorded as {top}; the allowed mapping is our judgement (confirmation item)" if not same_word else "")


@rule("D09")
def backup_choice(ctx):
    d, proj = ctx.data, ctx.proj
    c = d.ent["centroids"].copy()
    c["x"], c["y"] = proj.xy(c._lat, c._lon)
    reg = d.registration
    used = set(reg.plot_uuid)
    nonviable = reg[reg.viable == "no"]
    for _, b in reg[reg.sample_status == "backup"].iterrows():
        bc = c[c["__id"] == b.plot_uuid].iloc[0]
        cands = nonviable[nonviable.stratum == b.stratum]
        if cands.empty:
            _add(ctx, "fail", b, "backup registered but no non-viable primary in its stratum", "backup replaces a non-viable primary", severity="warning")
            continue
        lines = []
        nearest_ok = True
        for _, p in cands.iterrows():
            pc = c[c["__id"] == p.plot_uuid].iloc[0]
            pool = c[(c.sample_status == "backup") & (c.stratum_label == b.stratum) & (~c["__id"].isin(used - {b.plot_uuid}))].copy()
            pool["dist"] = np.hypot(pool.x - pc.x, pool.y - pc.y)
            pool = pool.sort_values("dist")
            chosen = float(np.hypot(bc.x - pc.x, bc.y - pc.y))
            near = pool.iloc[0]
            nearest_ok &= near["__id"] == b.plot_uuid
            lines.append(f"replaces {p.plot_name}: chosen {b.plot_name} at {chosen / 1000:.1f} km; nearest available backup {near.choice_name} at {near.dist / 1000:.1f} km")
        _add(ctx, "pass" if nearest_ok else "fail", b, "; ".join(lines), "a documented backup-selection rule (e.g. nearest available)",
             "" if nearest_ok else "not the nearest available backup: the selection rule is undocumented (confirmation item)")


@rule("D10")
def nonviable_justification(ctx):
    for _, r in ctx.data.registration.iterrows():
        if r.viable != "no":
            continue
        note = r.establishment_notes.strip()
        if not note:
            status, msg = "fail", "no justification"
        elif TEMPORARY_REASONS.search(note):
            status, msg = "fail", "reads as a temporary reason, which the SOP does not accept"
        else:
            status, msg = "pass", "permanent reason recorded (access); confirm NS accepts it"
        _add(ctx, status, r, repr(note), "a permanent reason (Reg. SOP 3)", msg)


@rule("D11")
def registration_survey_link(ctx):
    d = ctx.data
    herbs = set(d.ent["surveys"].loc[d.ent["surveys"].target_group == "herbs", "__id"])
    vp = d.ent["vegplots"].set_index("plot_uuid")
    for _, r in d.registration.iterrows():
        p = []
        if not herbs & set(r._survey_uuids):
            p.append("registration not attached to the herbaceous survey")
        if r.plot_uuid in vp.index:
            v = vp.loc[r.plot_uuid]
            if not herbs & set(v._survey_uuids):
                p.append("vegplot entity not attached to the herbaceous survey")
            if v.replicate != r["survey_begin-replicate"]:
                p.append(f"vegplot replicate {v.replicate!r} != registration replicate {r['survey_begin-replicate']!r}")
            if v.is_viable != r.viable:
                p.append(f"vegplot is_viable {v.is_viable!r} != registration {r.viable!r}")
        elif r.viable == "yes":
            p.append("no vegplot entity")
        _add(ctx, "fail" if p else "pass", r, "; ".join(p) or "attached to the herbaceous survey, replicate consistent", "vegplot visible to the herbaceous form")

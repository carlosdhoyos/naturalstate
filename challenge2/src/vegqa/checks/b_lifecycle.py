"""B. Submission lifecycle: review state, duplicates, timing, devices, entity-list freshness."""

from __future__ import annotations

import numpy as np
import pandas as pd

from ..engine import rows, rule
from ..model import registration_for

LOCAL_OFFSET = "+03:00"  # East Africa Time (Africa/Nairobi), no daylight saving
NEW_MODES = ("new_unknown", "new_missing")


def _submissions(d) -> pd.DataFrame:
    """Surveys and registrations as one timeline (both are field visits by the same teams)."""
    s = d.survey.assign(form="survey")
    r = d.registration.assign(form="registration")
    cols = ["KEY", "form", "plot_name", "_device", "_start", "_end", "_submitted", "_team", "ReviewState", "_offset"]
    r["_offset"] = r.start_time.str.extract(r"([+-]\d{2}:\d{2}|Z)$")[0]
    return pd.concat([s[cols], r[cols]], ignore_index=True)


def _skey(r):
    return r.KEY if r.form == "survey" else ""


@rule("B01")
def review_state(ctx):
    for r in rows(_submissions(ctx.data)):
        bad = r.ReviewState in ("rejected", "hasIssues")
        ctx.add("fail" if bad else "pass", r.form, r.KEY, plot_name=r.plot_name, survey_key=_skey(r), source_table=r.form, source_key=r.KEY,
                observed=r.ReviewState or "(none)", expected="not rejected / no issues",
                message="excluded from metrics (not canonical); its entity writes remain (F09/K03)" if bad else "")


@rule("B02")
def duplicate_surveys(ctx):
    s = ctx.data.survey
    for (plot, rep), g in s.groupby(["plot_name", "replicate"]):
        n = len(g)
        detail = "; ".join(f"{k[-8:]} {dev} {st:%d %b %H:%M} {rs or 'not reviewed'}{' [canonical]' if k in ctx.canonical else ''}"
                           for k, dev, st, rs in zip(g.KEY, g._device, g._start, g.ReviewState))
        ctx.add("fail" if n > 1 else "pass", "plot", plot, plot_name=plot, source_table="survey", source_key=";".join(g.KEY),
                observed=f"{n} submissions: {detail}", expected=f"1 survey per plot in replicate {rep}",
                message="canonical = not rejected, then latest end (V-01); the other is kept for repeatability (G04)" if n > 1 else "")


@rule("B03")
def survey_plot_link(ctx):
    d = ctx.data
    sv = d.ent["surveys"].set_index("__id")
    vp = d.ent["vegplots"].set_index("__id")
    reg = registration_for(ctx)
    for r in rows(d.survey):
        problems = []
        if sv.target_group.get(r.survey_uuid, "") != "herbs":
            problems.append(f"survey {r.survey_uuid[:8]} is not the herbaceous survey")
        if r.plot_uuid not in vp.index:
            problems.append("plot is not a registered vegplot")
        else:
            v = vp.loc[r.plot_uuid]
            if v.is_viable != "yes":
                problems.append("vegplot not viable")
            if r.survey_uuid not in v.survey_uuids.split():
                problems.append("vegplot not attached to this survey")
            if v.replicate != r.replicate:
                problems.append(f"vegplot replicate {v.replicate} != survey replicate {r.replicate}")
            if r._centroid_uuid not in reg.index:
                problems.append("no registration submission for the plot")
        ctx.add("fail" if problems else "pass", "survey", r.KEY, plot_name=r.plot_name, survey_key=r.KEY, source_table="survey", source_key=r.KEY,
                observed="; ".join(problems) or f"herbs survey, viable vegplot, replicate {r.replicate}", expected="registered viable plot of the herbaceous survey")


@rule("B04")
def survey_before_registration(ctx):
    d = ctx.data
    reg = registration_for(ctx)
    vp = d.ent["vegplots"].set_index("__id")
    for r in rows(d.survey):
        if r._centroid_uuid not in reg.index:
            ctx.add("could_not_check", "survey", r.KEY, plot_name=r.plot_name, survey_key=r.KEY, message="no registration (see B03)")
            continue
        g = reg.loc[r._centroid_uuid]
        on_server = pd.to_datetime(vp.__createdAt.get(r.plot_uuid, ""), utc=True, errors="coerce")
        on_server = g._submitted if pd.isna(on_server) else on_server
        same_device = g._device == r._device
        if r._start < g._end:
            status, msg = "fail", "survey started before the registration form was finished"
        elif not same_device and r._start < on_server:
            status, msg = "fail", f"cross-device: plot reached the server {on_server:%d %b %H:%M}Z, after the survey started on {r._device}"
        elif same_device and r._start < on_server:
            status, msg = "pass", "same device: the plot was a local entity on the device (allowed; S10)"
        else:
            status, msg = "pass", ""
        ctx.add(status, "survey", r.KEY, plot_name=r.plot_name, survey_key=r.KEY, source_table="survey", source_key=r.KEY,
                observed=f"survey start {r._start:%d %b %H:%M}Z on {r._device}; registration end {g._end:%d %b %H:%M}Z, on server {on_server:%d %b %H:%M}Z ({g._device})",
                expected="plot registered (and on the device) before the survey", message=msg)


@rule("B05")
def duration(ctx):
    th = ctx.th
    for form, df in (("survey", ctx.data.survey), ("registration", ctx.data.registration)):
        dur = (df._end - df._start).dt.total_seconds() / 60
        med = float(dur.median())
        lo, hi = th["duration_short_factor"] * med, th["duration_long_factor"] * med
        for r, m in zip(rows(df), dur):
            skey = r.KEY if form == "survey" else ""
            if pd.isna(m) or m <= 0:
                ctx.add("fail", form, r.KEY, plot_name=r.plot_name, survey_key=skey, source_table=form, source_key=r.KEY, observed=f"{m}",
                        expected="end after start", message="missing or non-positive duration", severity="error")
                continue
            local_days = (r.start_time[:10], r.end_time[:10])
            overnight = local_days[0] != local_days[1] or m > 60 * th["registration_overnight_hours"]
            if overnight:
                status, sev, msg = "fail", "warning", f"form open across days ({local_days[0]} -> {local_days[1]}): points/photos may come from different visits"
            elif m < lo:
                status, sev, msg = "fail", "warning", "short relative to the median: possibly incomplete"
            elif m > hi:
                status, sev, msg = "fail", "info", "long relative to the median: breaks or a learning day"
            else:
                status, sev, msg = "pass", None, ""
            ctx.add(status, form, r.KEY, plot_name=r.plot_name, survey_key=skey, source_table=form, source_key=r.KEY, observed=f"{m:.1f} min",
                    expected=f"{lo:.0f}-{hi:.0f} min (0.5-2.5 x median {med:.0f} min of {form}s)", message=msg, severity=sev)


@rule("B06")
def submission_delay(ctx):
    th = ctx.th
    for r in rows(_submissions(ctx.data)):
        h = (r._submitted - r._end).total_seconds() / 3600
        if pd.isna(h):
            ctx.add("could_not_check", r.form, r.KEY, plot_name=r.plot_name, survey_key=_skey(r), message="missing timestamp")
            continue
        if h < 0:
            status, sev, msg = "fail", "error", "server received the form before it ended (clock problem or edit)"
        elif h > th["max_submission_delay_h"]:
            status, sev, msg = "fail", "warning", "uploaded more than a day after finishing"
        elif h > th["watch_submission_delay_h"]:
            status, sev, msg = "fail", "info", "uploaded hours after finishing: other devices worked from a stale entity list meanwhile (B10)"
        else:
            status, sev, msg = "pass", None, ""
        ctx.add(status, r.form, r.KEY, plot_name=r.plot_name, survey_key=_skey(r), source_table=r.form, source_key=r.KEY,
                observed=f"{h:.1f} h ({r._device})", expected=f"<= {th['watch_submission_delay_h']} h (watch), <= {th['max_submission_delay_h']} h", message=msg, severity=sev)


@rule("B07")
def campaign_window(ctx):
    a, b = pd.Timestamp(ctx.th["campaign_start"]).date(), pd.Timestamp(ctx.th["campaign_end"]).date()
    for r in rows(_submissions(ctx.data)):
        if pd.isna(r._start):
            ctx.add("could_not_check", r.form, r.KEY, plot_name=r.plot_name, survey_key=_skey(r), message="start time missing")
            continue
        day = (r._start + pd.Timedelta(hours=3)).date()  # local (EAT) calendar day
        ok = a <= day <= b
        ctx.add("pass" if ok else "fail", r.form, r.KEY, plot_name=r.plot_name, survey_key=_skey(r), source_table=r.form, source_key=r.KEY,
                observed=str(day), expected=f"{a} .. {b}")


@rule("B08")
def overlapping_visits(ctx):
    sub = _submissions(ctx.data).sort_values("_start").reset_index(drop=True)
    for i, r in sub.iterrows():
        clashes = []
        for j, o in sub.iterrows():
            if i == j or not (r._start < o._end and o._start < r._end):
                continue
            shared = set(r._team) & set(o._team)
            if shared:
                clashes.append(f"{o.form} {o.plot_name} {o._start:%H:%M}-{o._end:%H:%M} on {o._device} ({len(shared)} shared members)")
        ctx.add("fail" if clashes else "pass", r.form, r.KEY, plot_name=r.plot_name, survey_key=r.KEY if r.form == "survey" else "",
                source_table=r.form, source_key=r.KEY, observed="; ".join(clashes) or "no overlap", expected="no team member on two visits at once")


@rule("B09")
def travel_speed(ctx):
    """Consecutive timed GPS fixes of one device (quadrat photo + position, registration endpoint photo +
    position, confirmation geopoint at the form end). An implausible speed between two submissions points
    to a clock or location problem."""
    d, proj, vmax = ctx.data, ctx.proj, ctx.th["max_travel_speed_kmh"]
    ev = []
    q = d.quadrat.merge(d.survey[["KEY", "_device", "plot_name"]], left_on="PARENT_KEY", right_on="KEY", suffixes=("", "_s"))
    for k, dev, plot, t, lat, lon in zip(q.PARENT_KEY, q._device, q.plot_name, q._photo_time, q._lat, q._lon):
        ev.append((dev, t, lat, lon, "survey", k, plot, "quadrat photo"))
    for r in rows(d.survey):
        ev.append((r._device, r._end, r._bg_lat, r._bg_lon, "survey", r.KEY, r.plot_name, "confirmation geopoint"))
    for _, r in d.registration.iterrows():
        for p in ("endpoint_a", "midpoint", "endpoint_b"):
            ev.append((r._device, r[f"_{p}_photo_time"], r[f"_{p}_lat"], r[f"_{p}_lon"], "registration", r.KEY, r.plot_name, f"{p} photo"))
        ev.append((r._device, r._end, r._bg_lat, r._bg_lon, "registration", r.KEY, r.plot_name, "confirmation geopoint"))
    e = pd.DataFrame(ev, columns=["device", "t", "lat", "lon", "form", "key", "plot_name", "what"]).dropna(subset=["t", "lat", "lon"])
    e["x"], e["y"] = proj.xy(e.lat, e.lon)
    e = e.sort_values(["device", "t"]).reset_index(drop=True)
    seen = set()
    for dev, g in e.groupby("device"):
        g = g.reset_index(drop=True)
        for i in range(1, len(g)):
            a, b = g.loc[i - 1], g.loc[i]
            if a.key == b.key:
                continue
            dt = max((b.t - a.t).total_seconds(), 1.0)
            km = float(np.hypot(b.x - a.x, b.y - a.y)) / 1000
            v = km / (dt / 3600)
            seen.add(b.key)
            ctx.add("fail" if v > vmax else "pass", b.form, b.key, plot_name=b.plot_name, survey_key=b.key if b.form == "survey" else "",
                    source_table=b.form, source_key=b.key, observed=f"{km:.2f} km in {dt / 60:.1f} min = {v:.0f} km/h ({a.plot_name} {a.what} -> {b.plot_name} {b.what}, {dev})",
                    expected=f"<= {vmax} km/h")


@rule("B10")
def stale_entity_list(ctx):
    """base_active_herb_count = active herb slots in the device's species_extra list when the form opened.
    Compare it with slots already activated (new_unknown / new_missing) by surveys that had ENDED before this
    one started, on any device; separate 'not yet on the server' (late upload) from 'device not refreshed'."""
    d = ctx.data
    e = d.extra[d.extra.entry_mode.isin(NEW_MODES)].merge(d.quadrat[["KEY", "PARENT_KEY"]], left_on="PARENT_KEY", right_on="KEY", suffixes=("", "_q"))
    s = d.survey.set_index("KEY")
    e["survey"] = e.PARENT_KEY_q
    e["end"], e["submitted"], e["device"] = e.survey.map(s._end), e.survey.map(s._submitted), e.survey.map(s._device)
    for r in rows(d.survey.sort_values("_start")):
        other = e[e.survey != r.KEY]
        ended = other[other.end < r._start]
        on_server = other[other.submitted < r._start]
        local = ended[ended.device == r._device]
        n_ended = ended.target_extra_name.nunique()
        n_reachable = len(set(on_server.target_extra_name) | set(local.target_extra_name))
        base = r._base_active_herb_count
        if pd.isna(base):
            ctx.add("could_not_check", "survey", r.KEY, plot_name=r.plot_name, survey_key=r.KEY, message="base_active_herb_count missing")
            continue
        if base < n_ended:
            late = ended[~ended.target_extra_name.isin(set(on_server.target_extra_name) | set(local.target_extra_name))]
            if base >= n_reachable and len(late):
                who = ", ".join(sorted({f"{s.loc[k, 'plot_name']} ({s.loc[k, '_device']}, ended {s.loc[k, '_end']:%H:%M}Z, uploaded {s.loc[k, '_submitted']:%d %b %H:%M}Z)" for k in late.survey}))
                msg = f"{n_ended - int(base)} slot(s) activated by surveys not yet uploaded: {who} (late upload, B06)"
            else:
                msg = "device list older than the server: refresh forms/entities before each survey"
            ctx.add("fail", "survey", r.KEY, plot_name=r.plot_name, survey_key=r.KEY, source_table="survey", source_key=r.KEY,
                    observed=f"base_active_herb_count={int(base)} on {r._device}", expected=f">= {n_ended} slots activated by surveys ended before this start", message=msg)
        elif base > n_ended:
            ctx.add("fail", "survey", r.KEY, plot_name=r.plot_name, survey_key=r.KEY, source_table="survey", source_key=r.KEY, severity="error",
                    observed=f"base_active_herb_count={int(base)}", expected=f"<= {n_ended} (slots activated before start)",
                    message="more active slots than any earlier survey activated: check entity edits outside the form")
        else:
            ctx.add("pass", "survey", r.KEY, plot_name=r.plot_name, survey_key=r.KEY, source_table="survey", source_key=r.KEY,
                    observed=f"base_active_herb_count={int(base)}", expected=f"= {n_ended}")


@rule("B11")
def recorder_in_team(ctx):
    team = ctx.data.ent["project_team"].set_index("__id")
    for r in rows(_submissions(ctx.data)):
        src = ctx.data.survey if r.form == "survey" else ctx.data.registration
        rec = src.set_index("KEY").recorder_uuid[r.KEY]
        problems = []
        if rec not in r._team:
            problems.append("recorder not among the selected team")
        inactive = [team.label.get(m, m[:8]) for m in r._team + [rec] if team.choice_status.get(m, "") != "active"]
        if inactive:
            problems.append("inactive or unknown member: " + ", ".join(sorted(set(inactive))))
        ctx.add("fail" if problems else "pass", r.form, r.KEY, plot_name=r.plot_name, survey_key=_skey(r), source_table=r.form, source_key=r.KEY,
                observed="; ".join(problems) or f"recorder {team.label.get(rec, rec[:8])} in team of {len(r._team)}", expected="recorder in selected, active team")


@rule("B12")
def timezone_label(ctx):
    for r in rows(_submissions(ctx.data)):
        ok = r._offset == LOCAL_OFFSET
        ctx.add("pass" if ok else "fail", r.form, r.KEY, plot_name=r.plot_name, survey_key=_skey(r), source_table=r.form, source_key=r.KEY,
                observed=r._offset, expected=f"{LOCAL_OFFSET} (EAT)", message="" if ok else "instant correct; wall-clock time read from the stamp is 1 h behind local time (V-07)")

"""Refresh the generated tables inside the Markdown report, in place.

The report's prose is written by hand; every table between `<!-- table:NAME -->` and `<!-- /table -->` is
rebuilt from challenge2/outputs/, so numbers in tables always match the latest run:

    python -m vegqa.report_tables            # after run_challenge2.py
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import pandas as pd

CH2 = Path(__file__).resolve().parents[2]
OUT = CH2 / "outputs"
REPORT = CH2 / "Q1_data_quality_report.md"


def _md(df: pd.DataFrame, align: dict | None = None) -> str:
    cols = list(df.columns)
    align = align or {}
    head = "| " + " | ".join(cols) + " |"
    sep = "|" + "|".join("---:" if align.get(c) == "r" else "---" for c in cols) + "|"
    cell = lambda v: "" if pd.isna(v) else str(v).replace("|", "\\|")  # a pipe would split the cell
    body = ["| " + " | ".join(cell(v) for v in row) + " |" for row in df.itertuples(index=False)]
    return "\n".join([head, sep, *body])


def _short(p: str) -> str:
    return str(p).replace("SavMon_LW_", "")


def survey_overview() -> str:
    s = pd.read_csv(OUT / "survey_overview.csv").iloc[0]
    rows = [
        ("Survey entity", f"`{s.survey_entity}` (replicate `{s.replicate}`)"),
        ("Field days", f"{s.field_days} ({s.first_day} to {s.last_day})"),
        ("Prescribed points", f"{s.primary_points_planned} primary + {s.backup_points} backup"),
        ("Plots registered / viable / surveyed", f"{s.plots_registered} / {s.plots_viable} / {s.plots_surveyed}"),
        ("Submissions (rejected) / canonical surveys", f"{s.submissions} ({s.submissions_rejected}) / {s.canonical_surveys}"),
        ("Quadrats (canonical)", f"{s.quadrats_canonical:,}"),
        ("Occurrences (canonical)", f"{s.occurrences_canonical:,}"),
        ("Taxa: raw / resolved / resolved and identified", f"{s.taxa_raw} / {s.taxa_resolved} / {s.taxa_resolved_identified}"),
        ("Devices / recorders", f"{s.devices.count(',') + 1} / {s.recorders}"),
        ("Flags: error / warning / info", f"{s.flags_error} / {s.flags_warning} / {s.flags_info}"),
    ]
    return _md(pd.DataFrame(rows, columns=["", "value"]))


def submissions() -> str:
    s = pd.read_csv(OUT / "submissions.csv")
    s["date"] = pd.to_datetime(s.start_utc).dt.tz_convert("Africa/Nairobi").dt.strftime("%d %b %H:%M")
    df = pd.DataFrame({
        "plot": s.plot_name.map(_short), "start (EAT)": s.date, "device": s.device.str.replace("demo-device-", "d"), "recorder": s.recorder,
        "review": s.review_state, "canonical": s.canonical.map({True: "yes", False: "no"}), "min": s.duration_min.round(0).astype(int),
        "upload h": s.upload_delay_h, "taxa (resolved)": s.richness_resolved,
        "E/W/I": s.n_error.fillna(0).astype(int).astype(str) + "/" + s.n_warning.fillna(0).astype(int).astype(str) + "/" + s.n_info.fillna(0).astype(int).astype(str),
        "failed rules": s.failed_rules.fillna(""),
    })
    return _md(df, {c: "r" for c in ("min", "upload h", "taxa (resolved)")})


def plots() -> str:
    p = pd.read_csv(OUT / "plots.csv")
    e = pd.read_csv(OUT / "effort_plots.csv")
    er = e[e.layer == "resolved"].set_index("plot_name")
    cov, h1, h2 = er.coverage, er.hill_q1, er.hill_q2
    p = p[p.registered].sort_values("plot_name")
    df = pd.DataFrame({
        "plot": p.plot_name.map(_short), "status": p.sample_status, "viable": p.viable,
        "offset m": p.midpoint_offset_m, "A-B m": p.transect_length_m, "off N-S deg": p.deviation_ns_deg.astype("Int64"),
        "taxa raw / resolved": p.richness_raw.astype("Int64").astype(str) + " / " + p.richness_resolved.astype("Int64").astype(str),
        "all-unknown quadrats": p.quadrats_all_unknown.astype("Int64"), "coverage": p.plot_name.map(cov),
        "Hill q1 / q2": p.plot_name.map(lambda n: f"{h1[n]:.1f} / {h2[n]:.1f}" if n in h1 else ""),
        "E/W/I": p.n_error.fillna(0).astype(int).astype(str) + "/" + p.n_warning.fillna(0).astype(int).astype(str) + "/" + p.n_info.fillna(0).astype(int).astype(str),
        "failed rules": p.failed_rules.fillna(""),
    }).replace("<NA> / <NA>", "")
    return _md(df, {c: "r" for c in ("offset m", "A-B m", "off N-S deg", "all-unknown quadrats", "coverage")})


def effort_plan() -> str:
    e = pd.read_csv(OUT / "effort_plan.csv")
    e["share_of_primary_surveyed"] = (e.share_of_primary_surveyed * 100).round(0).astype(int).astype(str) + "%"
    e.columns = ["stratum", "primary planned", "registered", "non-viable", "surveyed", "backups available", "backups used", "plots surveyed", "primary surveyed"]
    return _md(e)


def effort_project() -> str:
    e = pd.read_csv(OUT / "effort_project.csv")
    df = pd.DataFrame({"layer": e.layer, "plots": e.units, "taxa observed": e.S_obs, "in 1 plot": e.Q1_uniques, "in 2 plots": e.Q2_duplicates,
                       "Chao2 (95% CI)": [f"{c:.0f} ({lo:.0f}–{hi:.0f})" for c, lo, hi in zip(e.chao2, e.chao2_lo95, e.chao2_hi95)],
                       "observed / Chao2": e.completeness, "coverage": e.coverage, "Hill q1 / q2": [f"{a:.0f} / {b:.0f}" for a, b in zip(e.hill_q1, e.hill_q2)]})
    return _md(df)


def repeatability() -> str:
    r = pd.read_csv(OUT / "effort_repeatability.csv")
    r = r[r.layer == "resolved"]
    df = pd.DataFrame({"plot": r.plot_name.map(_short), "first": r["first"] + " (" + r.recorder_first + ")", "second": r["second"] + " (" + r.recorder_second + ")",
                       "taxa": r.taxa_first.astype(str) + " / " + r.taxa_second.astype(str), "shared": r.shared,
                       "plot Jaccard": r.plot_jaccard, "mean quadrat Jaccard": r.mean_quadrat_jaccard, "minutes": r.duration_first_min.astype(int).astype(str) + " / " + r.duration_second_min.astype(int).astype(str)})
    return _md(df)


def sensitivity() -> str:
    return _md(pd.read_csv(OUT / "effort_richness_sensitivity.csv"))


def rules() -> str:
    s = pd.read_csv(OUT / "rule_summary.csv")
    sev = lambda c: s[c] if c in s else 0
    df = pd.DataFrame({"rule": s.rule_id, "default severity": s.severity, "metric impact": s.metric_impact, "check": s.title, "source": s.source,
                       "fail": s["fail"], "of which E/W/I": [f"{e}/{w}/{i}" for e, w, i in zip(sev("fail_error"), sev("fail_warning"), sev("fail_info"))],
                       "pass": s["pass"], "not checked": s.could_not_check})
    return _md(df, {"fail": "r", "pass": "r", "not checked": "r"})


TABLES = {"survey_overview": survey_overview, "submissions": submissions, "plots": plots, "effort_plan": effort_plan, "effort_project": effort_project,
          "repeatability": repeatability, "sensitivity": sensitivity, "rules": rules}


RUN_ID_DOCS = [CH2 / "Q2_tech_handover.md", CH2.parent / "docs" / "challenge2_decisions.md"]


def current_run_id() -> str | None:
    m = OUT / "run_manifest.json"
    return json.loads(m.read_text())["run_id"] if m.exists() else None


def stamp_run_id(path: Path, run_id: str) -> None:
    path.write_text(re.sub(r"qa-[0-9a-f]{16}", run_id, path.read_text()))


def refresh(path: Path = REPORT, run_id: str | None = None) -> list[str]:
    text = path.read_text()
    run_id = run_id or current_run_id()
    if run_id:
        text = re.sub(r"qa-[0-9a-f]{16}", run_id, text)
    done = []
    for name, fn in TABLES.items():
        # tempered: the block body may not contain an end marker, so a match never spans two blocks
        pat = re.compile(rf"(<!-- table:{name} -->\n)(?:(?!<!-- /table -->).)*?(<!-- /table -->)", re.S)
        if pat.search(text):
            text = pat.sub(lambda m: m.group(1) + fn() + "\n" + m.group(2), text)
            done.append(name)
    path.write_text(text)
    return done


if __name__ == "__main__":
    print("refreshed:", ", ".join(refresh()))
    rid = current_run_id()
    for doc in RUN_ID_DOCS:
        if rid and doc.exists():
            stamp_run_id(doc, rid)

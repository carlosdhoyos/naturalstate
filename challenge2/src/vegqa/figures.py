"""Static figures for the report (PNG). Colours follow the Natural State palette used in the dashboard;
status colours are reserved for QA severity and always come with a legend label."""

from __future__ import annotations

from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402
from matplotlib.lines import Line2D  # noqa: E402

from .engine import rows  # noqa: E402
from .model import geometry, positions  # noqa: E402

NAVY, STEEL, TEAL, TEAL_LIGHT, MIST, INK, MUTED = "#00354d", "#2b5672", "#1f9e8c", "#86d1c7", "#dfe6e9", "#0f2430", "#74868f"
STATUS = {"pass": TEAL, "info": "#2a78d6", "warning": "#eda100", "error": "#e34948"}
plt.rcParams.update({"font.family": "sans-serif", "font.size": 9, "axes.edgecolor": "#c3cfd4", "axes.labelcolor": INK, "xtick.color": MUTED,
                     "ytick.color": MUTED, "axes.titleweight": "bold", "axes.titlesize": 10, "axes.spines.top": False, "axes.spines.right": False,
                     "savefig.dpi": 160, "savefig.bbox": "tight", "figure.facecolor": "white"})


def _worst(results: pd.DataFrame, rule_ids: list[str], key_col: str) -> pd.Series:
    order = {"info": 1, "warning": 2, "error": 3}
    f = results[(results.status == "fail") & results.rule_id.isin(rule_ids)]
    return f.assign(o=f.severity.map(order)).groupby(key_col).o.max().map({v: k for k, v in order.items()})


def map_overview(ctx, plots: pd.DataFrame, results: pd.DataFrame, path: Path):
    """Longitude / latitude axes with the aspect corrected for latitude (1 deg lon = cos(lat) deg lat)."""
    p = plots.assign(x=plots.prescribed_lon, y=plots.prescribed_lat)
    worst = _worst(results, list(ctx.catalogue["rules"]), "plot_name")
    fig, ax = plt.subplots(figsize=(10, 6.4))
    cats = [
        ("surveyed (primary)", (p.surveyed) & (p.sample_status == "primary"), dict(marker="o", s=46, c=TEAL, edgecolors="white", linewidths=0.8)),
        ("surveyed (backup)", (p.surveyed) & (p.sample_status == "backup"), dict(marker="D", s=40, c=TEAL, edgecolors="white", linewidths=0.8)),
        ("registered, not viable", (p.registered) & (p.viable == "no"), dict(marker="X", s=70, c=STATUS["warning"], edgecolors="white", linewidths=0.6)),
        ("primary, never registered", (~p.registered) & (p.sample_status == "primary"), dict(marker="s", s=40, facecolors="white", edgecolors=STEEL, linewidths=1.4)),
        ("backup, unused", (~p.registered) & (p.sample_status == "backup"), dict(marker="D", s=22, facecolors="white", edgecolors=MUTED, linewidths=0.9)),
    ]
    for label, m, kw in cats:
        sub = p[m]
        ax.scatter(sub.x, sub.y, label=f"{label} ({len(sub)})", zorder=3, **kw)
    for r in rows(p[p.surveyed]):
        if worst.get(r.plot_name) == "error":
            ax.scatter(r.x, r.y, s=150, facecolors="none", edgecolors=STATUS["error"], linewidths=1.1, linestyle="--", zorder=2)
    for r in rows(p):
        ax.annotate(r.plot_name.replace("SavMon_LW_Plot_", ""), (r.x, r.y), xytext=(4, 3), textcoords="offset points", fontsize=6.5, color=INK)
    for stratum, g in p.groupby("stratum"):
        ax.annotate(stratum, (g.x.mean(), g.y.max()), xytext=(0, 14), textcoords="offset points", ha="center", fontsize=8, color=STEEL, style="italic")
    ax.scatter([], [], s=150, facecolors="none", edgecolors=STATUS["error"], linestyle="--", label="dashed ring: plot has an error-level flag")
    lat0 = float(p.y.mean())
    km = 1 / (111.32 * np.cos(np.radians(lat0)))  # degrees of longitude per km
    xb, yb = p.x.min(), p.y.min() - 0.006
    ax.plot([xb, xb + km], [yb, yb], color=INK, lw=2)
    ax.text(xb + km / 2, yb + 0.001, "1 km", ha="center", fontsize=8)
    ax.set_aspect(1 / np.cos(np.radians(lat0)))
    ax.set_xlabel("longitude (deg E)")
    ax.set_ylabel("latitude (deg N)")
    ax.set_title("Prescribed points: what was registered and surveyed (Lewa, lw_baseline; WGS84)", loc="left")
    ax.legend(loc="upper left", bbox_to_anchor=(1.01, 1), frameon=False, fontsize=8)
    ax.grid(color="#e9eff1", lw=0.6)
    fig.savefig(path)
    plt.close(fig)


def transects_grid(ctx, results: pd.DataFrame, path: Path):
    g = geometry(ctx)
    g = g[g.has_geometry].sort_values("plot_name")
    q = positions(ctx)
    q = q[q.PARENT_KEY.isin(ctx.canonical)]
    worst_q = _worst(results, ["E01", "E02", "E04", "E06"], "entity_key")
    plot_flags = results[(results.status == "fail") & results.rule_id.isin(["D01", "D02", "D03", "D04", "E03", "E05"]) & (results.severity != "info")]
    n = len(g)
    cols = 6
    rows_ = int(np.ceil(n / cols))
    fig, axes = plt.subplots(rows_, cols, figsize=(cols * 2.3, rows_ * 2.45))
    for ax in axes.flat:
        ax.set_axis_off()
    for ax, r in zip(axes.flat, rows(g)):
        ax.set_axis_on()
        cx, cy = r.cx, r.cy
        A = np.array([r.endpoint_a_x - cx, r.endpoint_a_y - cy])
        M = np.array([r.midpoint_x - cx, r.midpoint_y - cy])
        B = np.array([r.endpoint_b_x - cx, r.endpoint_b_y - cy])
        u = (B - A) / np.linalg.norm(B - A)
        nrm = np.array([-u[1], u[0]])
        belt = np.array([A + 2.5 * nrm, B + 2.5 * nrm, B - 2.5 * nrm, A - 2.5 * nrm])
        ax.fill(belt[:, 0], belt[:, 1], color=TEAL_LIGHT, alpha=0.45, lw=0)
        ax.add_patch(plt.Circle((0, 0), 25, fill=False, ls="--", lw=0.7, color=MUTED))
        ax.plot([A[0], M[0], B[0]], [A[1], M[1], B[1]], color=NAVY, lw=1.4)
        ax.scatter([A[0], B[0]], [A[1], B[1]], s=10, color=NAVY, zorder=4)
        ax.scatter([M[0]], [M[1]], s=14, marker="s", color=NAVY, zorder=4)
        ax.scatter([0], [0], marker="+", s=40, color=INK, zorder=5)
        sub = q[q.plot_uuid == r.plot_uuid]
        cols_ = [STATUS.get(worst_q.get(k), TEAL) for k in sub.KEY]
        ax.scatter(sub.x - cx, sub.y - cy, s=9, c=cols_, edgecolors="white", linewidths=0.3, zorder=6)
        lim = 70
        ax.set_xlim(-lim, lim)
        ax.set_ylim(-lim, lim)
        ax.set_aspect("equal")
        ax.set_xticks([])
        ax.set_yticks([])
        fl = sorted(set(plot_flags[plot_flags.plot_name == r.plot_name].rule_id))
        ax.set_title(r.plot_name.replace("SavMon_LW_", ""), fontsize=8.5, loc="left", pad=2)
        if fl:
            ax.text(0.02, 0.02, " ".join(fl), transform=ax.transAxes, fontsize=6.5, color=STATUS["error"] if any(
                (plot_flags.plot_name == r.plot_name) & (plot_flags.severity == "error")) else "#9a6a00")
    handles = [Line2D([], [], color=NAVY, lw=1.4, label="registered A-M-B"), Line2D([], [], marker="+", ls="", color=INK, label="prescribed point"),
               Line2D([], [], ls="--", color=MUTED, label="25 m limit"), plt.Rectangle((0, 0), 1, 1, color=TEAL_LIGHT, alpha=0.45, label="5 m belt")]
    handles += [Line2D([], [], marker="o", ls="", color=c, label=f"quadrat: {k}") for k, c in STATUS.items()]
    fig.legend(handles=handles, loc="lower center", ncol=8, frameon=False, fontsize=7.5, bbox_to_anchor=(0.5, -0.01))
    fig.suptitle("Registered transects and canonical quadrats (140 m windows centred on the prescribed point; labels = plot-level warnings/errors)",
                 x=0.01, ha="left", fontsize=10, fontweight="bold")
    fig.tight_layout(rect=(0, 0.03, 1, 0.97))
    fig.savefig(path)
    plt.close(fig)


def orientation(ctx, path: Path):
    g = geometry(ctx)
    g = g[g.has_geometry]
    b = np.radians(np.concatenate([g.bearing_deg, g.bearing_deg + 180]))
    fig = plt.figure(figsize=(4.2, 4.2))
    ax = fig.add_subplot(projection="polar")
    ax.set_theta_zero_location("N")
    ax.set_theta_direction(-1)
    bins = np.radians(np.arange(0, 361, 15))
    h, _ = np.histogram(b, bins)
    ax.bar(bins[:-1], h, width=np.radians(15), align="edge", color=TEAL, edgecolor="white", lw=0.8)
    for c in (0, 180):
        ax.bar(np.radians(c - 30), max(h) * 1.05, width=np.radians(60), align="edge", color=MIST, alpha=0.6, zorder=0)
    ax.set_yticklabels([])
    ax.set_title("Transect bearings (both directions)\nshaded: within 30 deg of N-S", fontsize=9)
    fig.savefig(path)
    plt.close(fig)


def accumulation(curves: pd.DataFrame, eff: pd.DataFrame, path: Path):
    fig, (a1, a2) = plt.subplots(1, 2, figsize=(10, 4), gridspec_kw={"width_ratios": [1.2, 1]})
    for (plot, layer), g in curves.groupby(["plot_name", "layer"]):
        if layer == "resolved":
            a1.plot(g.quadrats, g.expected_taxa, color=TEAL, lw=0.9, alpha=0.6)
    med = curves[curves.layer == "resolved"].groupby("quadrats").expected_taxa.median()
    a1.plot(med.index, med.values, color=NAVY, lw=2.2, label="median plot")
    a1.set_xlabel("quadrats (random order)")
    a1.set_ylabel("expected taxa (resolved)")
    a1.set_title("Species accumulation per plot", loc="left")
    a1.legend(frameon=False)
    a1.set_xticks([1, 5, 10, 15, 20])
    a1.grid(color="#e9eff1", lw=0.6)
    r = eff[eff.layer == "resolved"].sort_values("coverage")
    yy = np.arange(len(r))
    a2.hlines(yy, r.completeness, r.coverage, color=MIST, lw=2)
    lo = (r.S_obs / r.chao2_hi95).where(r.chao2_hi95.notna(), np.nan)  # completeness interval from the Chao2 interval
    hi = r.S_obs / r.chao2_lo95
    a2.errorbar(r.completeness, yy, xerr=[(r.completeness - lo).clip(lower=0).fillna(0), (hi - r.completeness).clip(lower=0).fillna(0)],
                fmt="none", ecolor=STEEL, elinewidth=0.8, alpha=0.6, zorder=2)
    a2.scatter(r.completeness, yy, color=STEEL, s=18, label="S_obs / Chao2 (95% CI)", zorder=3)
    a2.scatter(r.coverage, yy, color=TEAL, s=18, label="sample coverage", zorder=3)
    a2.set_yticks(yy)
    a2.set_yticklabels(r.plot_name.str.replace("SavMon_LW_", ""), fontsize=6.5)
    a2.set_xlim(0.1, 1.02)
    a2.set_title("How complete is each plot's list? (resolved)", loc="left")
    a2.legend(frameon=False, loc="upper center", bbox_to_anchor=(0.5, -0.08), ncol=2, fontsize=7.5)
    a2.grid(axis="x", color="#e9eff1", lw=0.6)
    fig.tight_layout()
    fig.savefig(path)
    plt.close(fig)


def timeline(ctx, path: Path):
    """26-27 May: why two devices claimed the same new-species slots."""
    d = ctx.data
    lo, hi = pd.Timestamp("2026-05-26 04:00", tz="UTC"), pd.Timestamp("2026-05-27 09:00", tz="UTC")
    devs = sorted(set(d.survey._device) | set(d.registration._device))
    fig, ax = plt.subplots(figsize=(10, 3.2))
    for i, dev in enumerate(devs):
        for form, df, colr in (("survey", d.survey, TEAL), ("registration", d.registration, STEEL)):
            sub = df[(df._device == dev) & (df._end >= lo) & (df._start <= hi)]
            for r in rows(sub):
                rej = r.get("ReviewState", "") == "rejected"
                ax.barh(i + (0.18 if form == "survey" else -0.18), (min(r._end, hi) - max(r._start, lo)).total_seconds() / 86400, left=max(r._start, lo),
                        height=0.32, color=colr, alpha=0.45 if rej else 1, hatch="///" if rej else None, edgecolor="white")
                if form == "survey":
                    ax.annotate(r.plot_name.replace("SavMon_LW_Plot_", "P"), (max(r._start, lo), i + 0.38), fontsize=6.5, color=INK)
                    if lo <= r._submitted <= hi:
                        ax.plot([r._end, r._submitted], [i + 0.18, i + 0.18], color=MUTED, lw=0.7, ls=":")
                        ax.scatter([r._submitted], [i + 0.18], marker="^", s=18, color=NAVY, zorder=4)
    ax.set_yticks(range(len(devs)))
    ax.set_yticklabels(devs)
    ax.set_xlim(lo, hi)
    ax.set_title("26 May: device-01 uploads its morning surveys at 17:38-17:48 UTC; devices 02/03 work from the older list meanwhile", loc="left", fontsize=9)
    handles = [plt.Rectangle((0, 0), 1, 1, color=TEAL, label="survey"), plt.Rectangle((0, 0), 1, 1, color=STEEL, label="registration"),
               plt.Rectangle((0, 0), 1, 1, color=TEAL, alpha=0.45, hatch="///", label="rejected"), Line2D([], [], marker="^", ls=":", color=NAVY, label="upload")]
    ax.legend(handles=handles, loc="upper left", bbox_to_anchor=(1.0, 1), frameon=False, fontsize=7.5)
    ax.set_xlabel("UTC")
    fig.autofmt_xdate()
    fig.savefig(path)
    plt.close(fig)


def flags_heatmap(results: pd.DataFrame, plots: pd.DataFrame, path: Path):
    order = {"info": 1, "warning": 2, "error": 3}
    f = results[(results.status == "fail") & (results.plot_name != "")].copy()
    f["group"] = f.rule_id.str[0]
    f["o"] = f.severity.map(order)
    names = sorted(plots.loc[plots.registered, "plot_name"])
    groups = ["A", "B", "C", "D", "E", "F", "G", "J", "X", "P"]
    m = f.groupby(["plot_name", "group"]).o.max().unstack().reindex(index=names, columns=groups)
    cnt = f.groupby(["plot_name", "group"]).size().unstack().reindex(index=names, columns=groups)
    from matplotlib.colors import ListedColormap
    cmap = ListedColormap(["#f3f6f7", STATUS["info"], STATUS["warning"], STATUS["error"]])
    fig, ax = plt.subplots(figsize=(6.5, 8.5))
    ax.imshow(m.fillna(0).to_numpy(), cmap=cmap, vmin=0, vmax=3, aspect="auto")
    for i in range(len(names)):
        for j in range(len(groups)):
            c = cnt.iat[i, j]
            if pd.notna(c):
                ax.text(j, i, int(c), ha="center", va="center", fontsize=6.5, color="white" if m.iat[i, j] >= 2 else INK)
    ax.set_xticks(range(len(groups)))
    ax.set_xticklabels(groups)
    ax.set_yticks(range(len(names)))
    ax.set_yticklabels([n.replace("SavMon_LW_", "") for n in names], fontsize=7)
    ax.set_title("Flags per plot and rule group (colour = worst severity, number = count)", loc="left", fontsize=9)
    handles = [plt.Rectangle((0, 0), 1, 1, color=STATUS[k], label=k) for k in ("info", "warning", "error")]
    ax.legend(handles=handles, loc="upper left", bbox_to_anchor=(1.01, 1), frameon=False)
    ax.spines[:].set_visible(False)
    fig.savefig(path)
    plt.close(fig)


def make_all(ctx, tables: dict, results: pd.DataFrame, out: Path) -> list[str]:
    out.mkdir(parents=True, exist_ok=True)
    jobs = {
        "map_overview.png": lambda p: map_overview(ctx, tables["plots"], results, p),
        "transects_grid.png": lambda p: transects_grid(ctx, results, p),
        "orientation.png": lambda p: orientation(ctx, p),
        "accumulation.png": lambda p: accumulation(tables["effort_curves"], tables["effort_plots"], p),
        "timeline_26may.png": lambda p: timeline(ctx, p),
        "flags_heatmap.png": lambda p: flags_heatmap(results, tables["plots"], p),
    }
    for name, fn in jobs.items():
        fn(out / name)
    return sorted(jobs)

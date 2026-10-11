"""Challenge 2: vegetation data QA/QC. One command, deterministic, offline.

    python challenge2/src/run_challenge2.py

Reads the ODK exports, entity lists and forms (never modified), runs every rule in rules/rules.yaml, and
writes to challenge2/outputs/:
  qa_results.csv      every rule x entity evaluated (fail / pass / could_not_check)
  qa_flags.csv        the failures only (the dashboard's main table)
  rule_summary.csv    one row per rule: catalogue fields + counts
  survey_overview.csv, submissions.csv, plots.csv, quadrats.csv, occurrences.csv   (vegqa.tables)
  effort_*.csv        sampling-effort tables (vegqa.effort)
  species_list_suggestions.csv   suggested species-list / curation updates for NS's curators (vegqa.suggestions)
  figures/*.png       static maps and charts for the report (vegqa.figures)
  dashboard_results.json   everything the Vegetation QA/QC dashboard page embeds (vegqa.dashboard)
  run_manifest.json   run id, input hashes, catalogue version, row counts
"""

from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))

from vegqa import dashboard, effort, engine, figures, gis, suggestions, tables  # noqa: E402
from vegqa.gbif import CACHE as GBIF_CACHE  # noqa: E402
from vegqa.contracts import check_inputs  # noqa: E402
from vegqa.forms import set_forms_dir  # noqa: E402
from vegqa.load import ENTITIES, EXPORTS, FORMS, load  # noqa: E402
from vegqa.dem import CACHE as DEM_CACHE  # noqa: E402
from vegqa.model import canonical_survey_keys, projection  # noqa: E402
from vegqa.taxonomy import build_occurrences  # noqa: E402

OUT = Path(__file__).resolve().parents[1] / "outputs"


def file_hashes(exports: Path = EXPORTS, entities: Path = ENTITIES, forms: Path = FORMS) -> dict:
    """Content hashes of every input, keyed by role and file name (not by absolute path), so the same data
    give the same run id wherever they are mounted."""
    out = {}
    for role, folder, suffix in (("exports", exports, ".csv"), ("entities", entities, ".csv"), ("forms", forms, ".xlsx")):
        for p in sorted(Path(folder).glob(f"*{suffix}")):
            out[f"{role}/{p.name}"] = hashlib.sha256(p.read_bytes()).hexdigest()[:16]
    for name, p in (("reference/gbif_cache.json", GBIF_CACHE), ("reference/elevation_cache.json", DEM_CACHE), ("rules/rules.yaml", engine.RULES_YAML)):
        if p.exists():
            out[name] = hashlib.sha256(p.read_bytes()).hexdigest()[:16]
    return out


def project_id(d) -> str:
    """The survey entity the run covers (here savmon|lw|herbs|ho): the project scope of every flag."""
    sv = d.ent["surveys"]
    return "|".join(sorted(set(sv.loc[sv["__id"].isin(set(d.survey.survey_uuid)), "label"]))) or "unknown"


def add_review_keys(results: pd.DataFrame, project: str, catalogue: dict) -> pd.DataFrame:
    """flag_id: a stable identity for review decisions, from (project, rule, entity type, entity key), so a
    decision re-attaches to the same flag in every later run. evidence_hash: from the evidence (observed,
    expected, severity) AND the rule's definition (its catalogue entry and the thresholds), so a decision
    is reopened when the evidence OR the rule's meaning changes, even if the displayed strings do not."""
    h = lambda *parts: hashlib.sha256("\x1f".join(parts).encode()).hexdigest()
    th = json.dumps(catalogue["thresholds"], sort_keys=True, default=str)
    rule_def = {rid: h(json.dumps(r, sort_keys=True), th) for rid, r in catalogue["rules"].items()}
    out = results.copy()
    out.insert(1, "project_id", project)
    out.insert(2, "flag_id", [h(project, r, t, k)[:16] for r, t, k in zip(out.rule_id, out.entity_type, out.entity_key)])
    out["evidence_hash"] = [h(o, e, sv, rule_def[r])[:12] for o, e, sv, r in zip(out.observed, out.expected, out.severity, out.rule_id)]
    return out


def runtime() -> dict:
    """The environment of the run (not part of the run id, which covers inputs, catalogue and code)."""
    import importlib.metadata as md
    import os
    import platform

    pkgs = {p: md.version(p) for p in ("numpy", "pandas", "openpyxl", "matplotlib", "PyYAML")}
    return {"python": platform.python_version(), "platform": platform.platform(), "packages": pkgs, "image": os.environ.get("VEGQA_IMAGE", "")}


def code_version() -> str:
    """Content hash of the pipeline code (not the git commit, so committing outputs does not change the run id)."""
    src = Path(__file__).resolve().parent
    files = sorted([src / "run_challenge2.py", *(src / "vegqa").rglob("*.py")])
    h = hashlib.sha256()
    for f in files:
        h.update(f.relative_to(src).as_posix().encode() + b"\0" + f.read_bytes())
    return "code-" + h.hexdigest()[:12]


def rule_summary(results: pd.DataFrame, catalogue: dict) -> pd.DataFrame:
    counts = results.pivot_table(index="rule_id", columns="status", values="entity_key", aggfunc="count", fill_value=0)
    for c in ("fail", "pass", "could_not_check"):
        if c not in counts:
            counts[c] = 0
    sev = results[results.status == "fail"].pivot_table(index="rule_id", columns="severity", values="entity_key", aggfunc="count", fill_value=0)
    cat = pd.DataFrame(catalogue["rules"]).T.rename_axis("rule_id")
    out = cat.join(counts[["fail", "pass", "could_not_check"]]).join(sev.add_prefix("fail_"), how="left").fillna(0)
    for c in out.columns:
        if c.startswith("fail") or c in ("pass", "could_not_check"):
            out[c] = out[c].astype(int)
    return out.reset_index()


def build(exports: Path = EXPORTS, entities: Path = ENTITIES, forms: Path = FORMS) -> dict:
    """Everything the run produces, in memory (tests use this; main() writes it). Point `exports` and
    `entities` at the platform's tables (same file names as the ODK exports) to run on new data."""
    check_inputs(exports, entities, forms)  # a broken export stops here, before any analysis
    set_forms_dir(forms)
    d = load(exports, entities)
    catalogue = engine.load_catalogue()
    canonical, canon_table = canonical_survey_keys(d, tuple(catalogue["thresholds"]["canonical_excluded_review_states"]))
    occ = build_occurrences(d, canonical)
    ctx = engine.Ctx(d, occ, canonical, projection(d), catalogue["thresholds"], catalogue)
    results = engine.run_all(ctx)
    results = results.sort_values(["rule_id", "entity_type", "entity_key", "observed"], kind="mergesort").reset_index(drop=True)
    results = add_review_keys(results, project_id(d), catalogue)
    hashes = file_hashes(exports, entities, forms)
    rid = engine.run_id(hashes, catalogue, code_version())
    results.insert(0, "run_id", rid)
    subs = tables.submissions(ctx, results)
    plots = tables.plots(ctx, results)
    out_tables = {
        "submissions": subs, "plots": plots, "quadrats": tables.quadrats(ctx, results), "occurrences": tables.occurrences(ctx, results),
        "survey_overview": tables.survey_overview(ctx, results, subs, plots), "canonical_choice": canon_table,
    }
    out_tables.update(effort.all_tables(ctx, plots, results))
    out_tables["species_list_suggestions"] = suggestions.build(ctx)
    return {"ctx": ctx, "results": results, "summary": rule_summary(results, catalogue), "tables": out_tables, "run_id": rid, "hashes": hashes,
            "catalogue": catalogue}


def sha(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()[:16]


def verify_outputs(out: Path) -> list[str]:
    """Problems with a published output folder: an unfinished publication or a leftover staging folder,
    any file that is missing or differs from the hashes in run_manifest.json, and any file the manifest does
    not list (left by another run). An empty list means `out` holds exactly one complete run. Hidden files
    (.DS_Store and the like) are ignored."""
    out = Path(out)
    problems = [f"unfinished publication: {m.name}" for m in sorted(out.glob(".publishing-*"))]
    problems += [f"leftover staging folder {d.name} (an interrupted run)" for d in sorted(out.glob(".staging-*"))]
    mpath = out / "run_manifest.json"
    if not mpath.exists():
        return problems + ["no run_manifest.json"]
    listed = json.loads(mpath.read_text()).get("outputs")
    if listed is None:
        return problems + ["manifest lists no output hashes (written by an older version)"]
    for rel, h in listed.items():
        p = out / rel
        if not p.exists():
            problems.append(f"missing {rel}")
        elif sha(p) != h:
            problems.append(f"{rel} does not match the manifest (another run's file?)")
    for p in sorted(out.rglob("*")):
        rel = p.relative_to(out).as_posix()
        if p.is_file() and rel != "run_manifest.json" and not any(part.startswith(".") for part in p.relative_to(out).parts) and rel not in listed:
            problems.append(f"{rel} is not part of this run (left by another run?)")
    return problems


def main(exports: Path = EXPORTS, entities: Path = ENTITIES, out: Path | None = None, forms: Path = FORMS) -> dict:
    """Build, write everything to a staging folder, validate it, then publish it into `out`.

    What this guarantees, and what it does not:
    - A failure while BUILDING or WRITING (the slow part) leaves `out` exactly as it was; staging is discarded.
    - PUBLICATION moves the staged files into `out` one by one (each move is atomic, the set is not), with
      the manifest last. A crash during those moves can leave new files beside old ones. That state is
      never silent: a `.publishing-<run_id>` marker stays in `out`, and `verify_outputs` reports every file
      whose content does not match the manifest. Re-running repairs it.
    A single atomic switch (versioned run folders behind one pointer) is specified for the platform
    (Q2 §7), not implemented here, because `out` may be a mounted folder that cannot itself be renamed."""
    import shutil

    global OUT
    OUT = out or OUT
    OUT.mkdir(parents=True, exist_ok=True)
    b = build(exports, entities, forms)
    results, catalogue = b["results"], b["catalogue"]
    stage = OUT / f".staging-{b['run_id']}"
    shutil.rmtree(stage, ignore_errors=True)
    stage.mkdir()
    try:
        results.to_csv(stage / "qa_results.csv", index=False)
        flags = results[results.status == "fail"]
        flags.to_csv(stage / "qa_flags.csv", index=False)
        b["summary"].to_csv(stage / "rule_summary.csv", index=False)
        for name, df in b["tables"].items():
            df.to_csv(stage / f"{name}.csv", index=False)
        figs = figures.make_all(b["ctx"], b["tables"], results, stage / "figures")
        gis.write(b["ctx"], b["tables"]["plots"], results, stage / "transects.geojson")
        dashboard.export(b["ctx"], b["tables"], results, b["summary"], b["run_id"], stage / "dashboard_results.json")
        manifest = {
            "run_id": b["run_id"], "code_version": code_version(), "catalogue_version": catalogue["version"], "inputs": b["hashes"], "runtime": runtime(),
            "rows": {"qa_results": len(results), "qa_flags": len(flags), **{k: len(v) for k, v in b["tables"].items()}},
            "status_counts": results.status.value_counts().to_dict(), "fail_by_severity": flags.severity.value_counts().to_dict(), "figures": figs,
        }
        # validate the staged run before publishing it
        assert sum(manifest["status_counts"].values()) == len(pd.read_csv(stage / "qa_results.csv", usecols=["rule_id"])), "staged results incomplete"
        assert all((stage / "figures" / f).exists() for f in figs), "staged figures incomplete"
        files = sorted(p for p in stage.rglob("*") if p.is_file())
        manifest["outputs"] = {p.relative_to(stage).as_posix(): sha(p) for p in files}  # what verify_outputs checks
        (stage / "run_manifest.json").write_text(json.dumps(manifest, indent=1, default=str))
        # publish: file by file (each move atomic), the manifest last; the marker exists only while moving
        old_m = OUT / "run_manifest.json"
        previous = set(json.loads(old_m.read_text()).get("outputs", {})) if old_m.exists() else set()
        marker = OUT / f".publishing-{b['run_id']}"
        marker.write_text("publication in progress; if this file remains, the run was interrupted: re-run\n")
        for p in files + [stage / "run_manifest.json"]:
            dest = OUT / p.relative_to(stage)
            dest.parent.mkdir(parents=True, exist_ok=True)
            p.replace(dest)
        for rel in sorted(previous - set(manifest["outputs"])):  # our own files from the previous run that this run does not write
            (OUT / rel).unlink(missing_ok=True)
        for m in OUT.glob(".publishing-*"):  # this one, and any left by an earlier crashed run: out is whole again
            m.unlink()
    finally:
        shutil.rmtree(stage, ignore_errors=True)
    return manifest


if __name__ == "__main__":
    import argparse

    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--exports", type=Path, default=EXPORTS, help="folder with the ODK export CSVs")
    ap.add_argument("--entities", type=Path, default=ENTITIES, help="folder with the entity list CSVs")
    ap.add_argument("--forms", type=Path, default=FORMS, help="folder with the two XLSForms")
    ap.add_argument("--out", type=Path, default=OUT, help="output folder")
    ap.add_argument("--verify", action="store_true", help="only check that --out holds one complete run, then exit")
    a = ap.parse_args()
    if a.verify:
        bad = verify_outputs(a.out)
        print("\n".join(bad) if bad else f"ok: {a.out} holds one complete run")
        sys.exit(1 if bad else 0)
    m = main(a.exports, a.entities, a.out, a.forms)
    print(json.dumps({k: m[k] for k in ("run_id", "status_counts", "fail_by_severity", "rows")}, indent=1))

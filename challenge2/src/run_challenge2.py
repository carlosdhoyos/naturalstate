"""Challenge 2: vegetation data QA/QC. One command, deterministic, offline.

    python challenge2/src/run_challenge2.py

Reads the ODK exports, entity lists and forms (never modified), runs every rule in rules/rules.yaml, and
writes to challenge2/outputs/:
  qa_results.csv      every rule x entity evaluated (fail / pass / could_not_check)
  qa_flags.csv        the failures only (the dashboard's main table)
  rule_summary.csv    one row per rule: catalogue fields + counts
  survey_overview.csv, submissions.csv, plots.csv, quadrats.csv, occurrences.csv   (vegqa.tables)
  effort_*.csv        sampling-effort tables (vegqa.effort)
  figures/*.png       static maps and charts for the report (vegqa.figures)
  run_manifest.json   run id, input hashes, catalogue version, row counts
"""

from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))

from vegqa import effort, engine, figures, tables  # noqa: E402
from vegqa.gbif import CACHE as GBIF_CACHE  # noqa: E402
from vegqa.load import DATA, ENTITIES, EXPORTS, load  # noqa: E402
from vegqa.model import canonical_survey_keys, projection  # noqa: E402
from vegqa.taxonomy import build_occurrences  # noqa: E402

OUT = Path(__file__).resolve().parents[1] / "outputs"


def file_hashes() -> dict:
    files = sorted(p for p in DATA.rglob("*") if p.is_file() and p.suffix in (".csv", ".xlsx")) + [GBIF_CACHE, engine.RULES_YAML]
    return {str(p.relative_to(DATA.parent)): hashlib.sha256(p.read_bytes()).hexdigest()[:16] for p in files if p.exists()}


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


def build(exports: Path = EXPORTS, entities: Path = ENTITIES) -> dict:
    """Everything the run produces, in memory (tests use this; main() writes it). Point `exports` and
    `entities` at the platform's tables (same file names as the ODK exports) to run on new data."""
    d = load(exports, entities)
    canonical, canon_table = canonical_survey_keys(d)
    occ = build_occurrences(d, canonical)
    catalogue = engine.load_catalogue()
    ctx = engine.Ctx(d, occ, canonical, projection(d), catalogue["thresholds"], catalogue)
    results = engine.run_all(ctx)
    results = results.sort_values(["rule_id", "entity_type", "entity_key", "observed"], kind="mergesort").reset_index(drop=True)
    hashes = file_hashes()
    rid = engine.run_id(hashes, catalogue, code_version())
    results.insert(0, "run_id", rid)
    subs = tables.submissions(ctx, results)
    plots = tables.plots(ctx, results)
    out_tables = {
        "submissions": subs, "plots": plots, "quadrats": tables.quadrats(ctx, results), "occurrences": tables.occurrences(ctx, results),
        "survey_overview": tables.survey_overview(ctx, results, subs, plots), "canonical_choice": canon_table,
    }
    out_tables.update(effort.all_tables(ctx, plots))
    return {"ctx": ctx, "results": results, "summary": rule_summary(results, catalogue), "tables": out_tables, "run_id": rid, "hashes": hashes,
            "catalogue": catalogue}


def main(exports: Path = EXPORTS, entities: Path = ENTITIES, out: Path | None = None) -> dict:
    global OUT
    OUT = out or OUT
    OUT.mkdir(parents=True, exist_ok=True)
    b = build(exports, entities)
    results, catalogue = b["results"], b["catalogue"]
    results.to_csv(OUT / "qa_results.csv", index=False)
    flags = results[results.status == "fail"]
    flags.to_csv(OUT / "qa_flags.csv", index=False)
    b["summary"].to_csv(OUT / "rule_summary.csv", index=False)
    for name, df in b["tables"].items():
        df.to_csv(OUT / f"{name}.csv", index=False)
    figs = figures.make_all(b["ctx"], b["tables"], results, OUT / "figures")
    manifest = {
        "run_id": b["run_id"], "code_version": code_version(), "catalogue_version": catalogue["version"], "inputs": b["hashes"],
        "rows": {"qa_results": len(results), "qa_flags": len(flags), **{k: len(v) for k, v in b["tables"].items()}},
        "status_counts": results.status.value_counts().to_dict(), "fail_by_severity": flags.severity.value_counts().to_dict(), "figures": figs,
    }
    (OUT / "run_manifest.json").write_text(json.dumps(manifest, indent=1, default=str))
    return manifest


if __name__ == "__main__":
    import argparse

    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--exports", type=Path, default=EXPORTS, help="folder with the ODK export CSVs")
    ap.add_argument("--entities", type=Path, default=ENTITIES, help="folder with the entity list CSVs")
    ap.add_argument("--out", type=Path, default=OUT, help="output folder")
    a = ap.parse_args()
    m = main(a.exports, a.entities, a.out)
    print(json.dumps({k: m[k] for k in ("run_id", "status_counts", "fail_by_severity", "rows")}, indent=1))

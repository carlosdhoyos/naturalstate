"""Build a data dictionary for the ODK exports from the XLSForm definitions.

Reads ../Data Vegetation/ODK Data Collection Forms/*.xlsx (standard library only: an .xlsx is a
zip of XML) and writes src/data/odk_dictionary.json, keyed the way ODK Central names CSV exports:

    { "<table>": { "<group>-<subgroup>-<field>": {type, label, hint, calc, choices} } }

where <table> is the form id for the main table and "<form>-<repeat>" for each repeat table,
and column paths are relative to the table (groups joined by "-", repeats start a new table).

Run:  python3 scripts/build_odk_dictionary.py
"""

import json
import re
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path

HERE = Path(__file__).resolve().parent
FORMS = HERE.parent.parent / "Data Vegetation" / "ODK Data Collection Forms"
OUT = HERE.parent / "src" / "data" / "odk_dictionary.json"

NS = {
    "m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
    "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
}


def read_sheets(path: Path) -> dict[str, list[dict[str, str]]]:
    """Return {sheet_name: [row dicts keyed by header]}."""
    z = zipfile.ZipFile(path)
    shared: list[str] = []
    if "xl/sharedStrings.xml" in z.namelist():
        for si in ET.fromstring(z.read("xl/sharedStrings.xml")).findall("m:si", NS):
            shared.append("".join(t.text or "" for t in si.iter(f"{{{NS['m']}}}t")))
    wb = ET.fromstring(z.read("xl/workbook.xml"))
    rels = {r.get("Id"): r.get("Target") for r in ET.fromstring(z.read("xl/_rels/workbook.xml.rels"))}
    out: dict[str, list[dict[str, str]]] = {}
    for s in wb.find("m:sheets", NS):
        target = rels[s.get(f"{{{NS['r']}}}id")].lstrip("/")
        target = target if target.startswith("xl/") else f"xl/{target}"
        grid: list[dict[str, str]] = []
        for row in ET.fromstring(z.read(target)).iter(f"{{{NS['m']}}}row"):
            cells = {}
            for c in row.findall("m:c", NS):
                col = re.match(r"[A-Z]+", c.get("r")).group()
                v = c.find("m:v", NS)
                t = c.get("t")
                if t == "s" and v is not None:
                    val = shared[int(v.text)]
                elif t == "inlineStr":
                    val = "".join(x.text or "" for x in c.iter(f"{{{NS['m']}}}t"))
                else:
                    val = v.text if v is not None else ""
                cells[col] = val
            grid.append(cells)
        if not grid:
            out[s.get("name")] = []
            continue
        header = grid[0]
        out[s.get("name")] = [{header.get(k, k).strip(): v for k, v in r.items()} for r in grid[1:]]
    return out


def clean(text: str) -> str:
    """Strip markdown/HTML so labels read well in a tooltip."""
    text = re.sub(r"<[^>]+>", "", text or "")
    text = re.sub(r"\*\*|__|#+ ", "", text)
    return re.sub(r"\s+", " ", text).strip()


def build(form_path: Path) -> dict[str, dict[str, dict]]:
    sheets = read_sheets(form_path)
    form_id = form_path.stem
    choices: dict[str, list[list[str]]] = {}
    for r in sheets.get("choices", []):
        ln, name, label = r.get("list_name", ""), r.get("name", ""), clean(r.get("label", ""))
        if ln and name:
            choices.setdefault(ln, []).append([name, label])

    tables: dict[str, dict[str, dict]] = {form_id: {}}
    # stack of (kind, name); a repeat starts a new table whose paths restart from it
    stack: list[tuple[str, str]] = []

    def current_table() -> str:
        repeats = [n for k, n in stack if k == "repeat"]
        return f"{form_id}-{repeats[-1]}" if repeats else form_id

    def current_prefix() -> list[str]:
        prefix: list[str] = []
        for k, n in stack:
            if k == "repeat":
                prefix = []
            else:
                prefix.append(n)
        return prefix

    for r in sheets["survey"]:
        typ = (r.get("type") or "").strip()
        name = (r.get("name") or "").strip()
        if not typ:
            continue
        if typ in ("begin_group", "begin group"):
            stack.append(("group", name))
            continue
        if typ in ("begin_repeat", "begin repeat"):
            stack.append(("repeat", name))
            tables.setdefault(current_table(), {})
            continue
        if typ.startswith("end"):
            if stack:
                stack.pop()
            continue
        if not name:
            continue
        entry = {"type": typ}
        if clean(r.get("label", "")):
            entry["label"] = clean(r["label"])
        if clean(r.get("hint", "")):
            entry["hint"] = clean(r["hint"])
        if r.get("calculation"):
            entry["calc"] = r["calculation"].strip()
        list_name = typ.split()[-1] if typ.startswith("select_") and len(typ.split()) > 1 else None
        if list_name and list_name in choices:
            entry["choices"] = choices[list_name][:40]
        elif list_name:
            entry["choices_from"] = list_name  # select_*_from_file → an entity list
        path = "-".join(current_prefix() + [name])
        tables.setdefault(current_table(), {})[path] = entry
    return tables


def main() -> None:
    out: dict[str, dict] = {}
    for f in sorted(FORMS.glob("*.xlsx")):
        out.update(build(f))
    OUT.write_text(json.dumps(out, indent=1, ensure_ascii=False))
    for t, cols in out.items():
        print(f"{t}: {len(cols)} fields")


if __name__ == "__main__":
    main()

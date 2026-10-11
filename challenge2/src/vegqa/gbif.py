"""GBIF reference lookups, fetched once and cached to a versioned JSON file.

The QA run never calls the network: checks F03 (spelling) and F10 (range) read the cache, and a name that
is not in the cache is "could_not_check". Refresh the cache with:

    python -m vegqa.gbif            # fetches only names missing from the cache

For each name: GBIF backbone match (matchType EXACT / FUZZY / HIGHERRANK / NONE, canonical name, status,
accepted key) and occurrence counts in Kenya and, as a contrast, in southern Africa (BW, NA, ZA, ZW).
"""

from __future__ import annotations

import json
import time
import urllib.parse
import urllib.request
from datetime import date
from pathlib import Path

CACHE = Path(__file__).resolve().parents[2] / "reference" / "gbif_cache.json"
API = "https://api.gbif.org/v1"
SOUTHERN_AFRICA = ["BW", "NA", "ZA", "ZW"]


def load_cache(path: Path = CACHE) -> dict:
    return json.loads(path.read_text()) if path.exists() else {"retrieved": None, "names": {}}


def _get(url: str) -> dict:
    with urllib.request.urlopen(url, timeout=30) as r:
        return json.loads(r.read().decode())


def _count(taxon_key: int, countries: list[str]) -> int:
    q = [("taxonKey", taxon_key), ("limit", 0)] + [("country", c) for c in countries]
    return int(_get(f"{API}/occurrence/search?{urllib.parse.urlencode(q)}").get("count", 0))


def lookup(name: str) -> dict:
    m = _get(f"{API}/species/match?{urllib.parse.urlencode({'name': name, 'kingdom': 'Plantae', 'verbose': 'false'})}")
    out = {k: m.get(k) for k in ("matchType", "canonicalName", "scientificName", "rank", "status", "confidence", "usageKey", "acceptedUsageKey", "genus", "species")}
    key = m.get("acceptedUsageKey") or m.get("usageKey")
    if key and m.get("rank") in ("SPECIES", "SUBSPECIES", "VARIETY"):
        out["count_KE"] = _count(key, ["KE"])
        out["count_southern_africa"] = _count(key, SOUTHERN_AFRICA)
    return out


def names_in_data(d) -> list[str]:
    """Every taxon name that appears in the data or in the curation table (as written; whitespace trimmed)."""
    sp = d.ent["species"].set_index("__id")
    used = {u for us in d.quadrat._species for u in us}
    names = {sp.label[u] for u in used if u in sp.index}
    se = d.ent["species_extra"]
    names |= set(se.loc[se.new_record_reason == "missing_species", "label"])
    names |= set(d.extra.loc[d.extra.entry_mode == "new_missing", "new_missing_canonical"])
    si = d.ent["species_extra_ids"]
    names |= set(si.loc[si.species_name.str.lower() != "unknown", "species_name"])
    return sorted({n.strip() for n in names if n and n.strip() and not n.strip().startswith(("herb_", "wood_"))})


def refresh(d, path: Path = CACHE, pause: float = 0.1) -> dict:
    cache = load_cache(path)
    todo = [n for n in names_in_data(d) if n not in cache["names"]]
    for i, n in enumerate(todo, 1):
        try:
            cache["names"][n] = lookup(n)
        except Exception as e:  # network problems leave the name out: the check reports could_not_check
            print(f"  {n}: {e}")
        time.sleep(pause)
        if i % 20 == 0:
            print(f"  {i}/{len(todo)}")
    cache["retrieved"] = str(date.today())
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(cache, indent=1, sort_keys=True))
    return cache


if __name__ == "__main__":
    from .load import load

    c = refresh(load())
    print(f"{len(c['names'])} names cached in {CACHE}")

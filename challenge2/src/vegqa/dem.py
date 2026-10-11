"""Terrain elevation (SRTM 90 m via the OpenTopoData API), fetched once and cached to a versioned JSON file.

Like vegqa.gbif, the QA run never calls the network: rule E14 reads the cache and reports
could_not_check for points that are not in it. Refresh with:

    python -m vegqa.dem            # fetches only points missing from the cache

Points are keyed by "lat,lon" rounded to 5 decimals (about 1 m), far finer than the 90 m DEM cell.
SRTM's vertical error is about 16 m (90% linear error); GPS altitude error is roughly 1.5x the
horizontal accuracy. A difference of hundreds of metres is therefore not measurement noise.
"""

from __future__ import annotations

import json
import time
import urllib.request
from datetime import date
from pathlib import Path

import pandas as pd

CACHE = Path(__file__).resolve().parents[2] / "reference" / "elevation_cache.json"
API = "https://api.opentopodata.org/v1/srtm90m"


def key(lat: float, lon: float) -> str:
    return f"{lat:.5f},{lon:.5f}"


def load_cache(path: Path = CACHE) -> dict:
    return json.loads(path.read_text()) if path.exists() else {"retrieved": None, "dataset": "srtm90m", "points": {}}


def points_in_data(d) -> list[tuple[float, float]]:
    pts = set()
    c = d.ent["centroids"]
    pts |= {(a, b) for a, b in zip(c._lat, c._lon)}
    for p in ("endpoint_a", "midpoint", "endpoint_b"):
        r = d.registration
        pts |= {(a, b) for a, b in zip(r[f"_{p}_lat"], r[f"_{p}_lon"])}
    q = d.quadrat
    pts |= {(a, b) for a, b in zip(q._lat, q._lon)}
    return sorted((a, b) for a, b in pts if pd.notna(a) and pd.notna(b))


def refresh(d, path: Path = CACHE, batch: int = 100, pause: float = 1.1) -> dict:
    cache = load_cache(path)
    todo = [p for p in points_in_data(d) if key(*p) not in cache["points"]]
    for i in range(0, len(todo), batch):
        chunk = todo[i:i + batch]
        url = f"{API}?locations=" + "|".join(f"{a:.6f},{b:.6f}" for a, b in chunk)
        with urllib.request.urlopen(url, timeout=60) as r:
            res = json.loads(r.read().decode())["results"]
        for (a, b), x in zip(chunk, res):
            if x.get("elevation") is not None:
                cache["points"][key(a, b)] = x["elevation"]
        time.sleep(pause)  # the public API allows 1 request per second
    cache["retrieved"] = str(date.today())
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(cache, indent=0, sort_keys=True))
    return cache


if __name__ == "__main__":
    from .load import load

    c = refresh(load())
    print(f"{len(c['points'])} points cached in {CACHE}")

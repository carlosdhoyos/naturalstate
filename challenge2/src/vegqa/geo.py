"""Geometry in metres around the project, without GIS dependencies.

The project spans a few kilometres near the equator (Lewa, Kenya), so a local equirectangular
projection is accurate to well under a centimetre per 100 m — far below GPS error (±5 m).
"""

from __future__ import annotations

import numpy as np

R_EARTH = 6_371_008.8  # mean Earth radius, metres


class LocalProjection:
    """Project lat/lon (degrees) to x (east) / y (north) metres around a reference point."""

    def __init__(self, lat0: float, lon0: float):
        self.lat0, self.lon0 = float(lat0), float(lon0)
        self.kx = np.pi / 180 * R_EARTH * np.cos(np.radians(self.lat0))
        self.ky = np.pi / 180 * R_EARTH

    def xy(self, lat, lon):
        lat, lon = np.asarray(lat, float), np.asarray(lon, float)
        return (lon - self.lon0) * self.kx, (lat - self.lat0) * self.ky


def dist(p, q) -> float | np.ndarray:
    """Euclidean distance between (x, y) tuples/arrays (metres)."""
    return np.hypot(np.asarray(p[0]) - np.asarray(q[0]), np.asarray(p[1]) - np.asarray(q[1]))


def bearing_deg(p, q) -> float:
    """Compass bearing of the line p -> q, folded to [0, 180) (a transect has no direction)."""
    b = np.degrees(np.arctan2(q[0] - p[0], q[1] - p[1])) % 180.0
    return float(b)


def deviation_from_ns(bearing: float) -> float:
    """Angle between a line and the north-south axis, 0..90 degrees."""
    b = bearing % 180.0
    return float(min(b, 180.0 - b))


def angle_at(a, m, b) -> float:
    """Angle A-M-B in degrees (180 = straight transect)."""
    v1 = np.array([a[0] - m[0], a[1] - m[1]])
    v2 = np.array([b[0] - m[0], b[1] - m[1]])
    n = np.linalg.norm(v1) * np.linalg.norm(v2)
    if n == 0:
        return float("nan")
    return float(np.degrees(np.arccos(np.clip(v1 @ v2 / n, -1, 1))))


def segment_frame(a, b):
    """Unit along-vector and normal of segment A->B, its length, and a projector for points:
    returns (along_m, lateral_m) where along is measured from A and lateral is signed."""
    a, b = np.asarray(a, float), np.asarray(b, float)
    v = b - a
    length = float(np.linalg.norm(v))
    u = v / length if length else np.array([0.0, 1.0])
    nrm = np.array([-u[1], u[0]])

    def project(x, y):
        d = np.column_stack([np.asarray(x) - a[0], np.asarray(y) - a[1]])
        return d @ u, d @ nrm

    return length, project


def robust_line(x, y):
    """Total-least-squares line through points after trimming the worst 20% (iteratively), so a few
    position outliers don't tilt it. Returns (centre, unit direction, residuals of all points)."""
    pts = np.column_stack([x, y]).astype(float)
    keep = np.ones(len(pts), bool)
    for _ in range(3):
        c = pts[keep].mean(axis=0)
        _, _, vt = np.linalg.svd(pts[keep] - c)
        u = vt[0]
        res = np.abs((pts - c) @ np.array([-u[1], u[0]]))
        cut = np.quantile(res, 0.8)
        keep = res <= max(cut, 1e-9)
    c = pts[keep].mean(axis=0)
    _, _, vt = np.linalg.svd(pts[keep] - c)
    u = vt[0]
    res = np.abs((pts - c) @ np.array([-u[1], u[0]]))
    return c, u, res


_GH = "0123456789bcdefghjkmnpqrstuvwxyz"


def geohash(lat: float, lon: float, precision: int = 7) -> str:
    """Standard geohash encoding (base-32, alternating longitude/latitude bits)."""
    la, lo = [-90.0, 90.0], [-180.0, 180.0]
    out, ch, bit, even = "", 0, 0, True
    while len(out) < precision:
        rng, v = (lo, lon) if even else (la, lat)
        mid = (rng[0] + rng[1]) / 2
        if v >= mid:
            ch, rng[0] = ch * 2 + 1, mid
        else:
            ch, rng[1] = ch * 2, mid
        even, bit = not even, bit + 1
        if bit == 5:
            out, ch, bit = out + _GH[ch], 0, 0
    return out


def geohash_centre(gh: str) -> tuple[float, float]:
    """Centre (lat, lon) of a geohash cell."""
    la, lo, even = [-90.0, 90.0], [-180.0, 180.0], True
    for ch in gh:
        v = _GH.index(ch)
        for i in range(4, -1, -1):
            rng = lo if even else la
            mid = (rng[0] + rng[1]) / 2
            if (v >> i) & 1:
                rng[0] = mid
            else:
                rng[1] = mid
            even = not even
    return (la[0] + la[1]) / 2, (lo[0] + lo[1]) / 2

"""Treasury curve analytics: slope, curvature, forwards, regime z-scores.

Pure logic over FRED DGS* series (no network here). A curve is a
business-day-aligned DataFrame of par yields in percent.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

# Tenor in years per DGS series (used for forward-rate math).
_TENOR_YEARS = {
    "DGS1MO": 1 / 12, "DGS3MO": 0.25, "DGS6MO": 0.5, "DGS1": 1.0,
    "DGS2": 2.0, "DGS3": 3.0, "DGS5": 5.0, "DGS7": 7.0,
    "DGS10": 10.0, "DGS20": 20.0, "DGS30": 30.0,
}


def assemble_curve(series_map: dict[str, pd.Series]) -> pd.DataFrame:
    """Align DGS series on a common business-day index (ffill, then drop rows
    missing any series so downstream math never mixes partial curves)."""
    df = pd.DataFrame(series_map)
    if df.empty:
        return df
    return df.resample("B").last().ffill().dropna()


def curve_slopes(df: pd.DataFrame) -> pd.DataFrame:
    """2s10s and 3m10s slopes plus 2s5s10s curvature, in bps."""
    out = pd.DataFrame(index=df.index)
    if {"DGS2", "DGS10"}.issubset(df.columns):
        out["Slope_2s10s_bp"] = (df["DGS10"] - df["DGS2"]) * 100
    if {"DGS3MO", "DGS10"}.issubset(df.columns):
        out["Slope_3m10s_bp"] = (df["DGS10"] - df["DGS3MO"]) * 100
    if {"DGS2", "DGS5", "DGS10"}.issubset(df.columns):
        out["Curvature_2s5s10s_bp"] = (df["DGS5"] * 2 - df["DGS2"] - df["DGS10"]) * 100
    return out


def bootstrap_forwards(df: pd.DataFrame) -> pd.DataFrame:
    """Duration-weighted par-curve forward rates between adjacent tenors (bps).

    Approximation (par-to-par, ignoring coupons): fwd(a,b) =
    (y_b * t_b - y_a * t_a) / (t_b - t_a). Documented as an approximation in
    context.md; the exact fitted curve is out of scope for free data.
    """
    cols = [c for c in _TENOR_YEARS if c in df.columns]
    cols = sorted(cols, key=lambda c: _TENOR_YEARS[c])
    out = pd.DataFrame(index=df.index)
    for a, b in zip(cols, cols[1:]):
        ta, tb = _TENOR_YEARS[a], _TENOR_YEARS[b]
        fwd = (df[b] * tb - df[a] * ta) / (tb - ta) * 100
        out[f"Fwd_{a}_to_{b}_bp"] = fwd
    return out


def curve_position(df: pd.DataFrame) -> pd.DataFrame:
    """Rolling z-score of slope/curvature (252d window, 63d minimum).

    Positive z = currently steep relative to its own history. None-safe:
    short histories produce NaN, never a fabricated regime.
    """
    sl = curve_slopes(df)
    reg = pd.DataFrame(index=df.index)
    for c in sl.columns:
        roll = sl[c].rolling(252, min_periods=63)
        mu, sd = roll.mean(), roll.std(ddof=0)
        reg[c.replace("_bp", "_z")] = (sl[c] - mu) / sd.replace(0, np.nan)
    return reg

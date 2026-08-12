"""Global sovereign rates screen: country yield matrix, region aggregates.

Input: dict {country: monthly 10Y gov yield Series} from
sources.fred_ext.fetch_global_sovereign. Countries are bucketed into
regions (config.GLOBAL_RATE_REGIONS). Outputs:

- region_yield_matrix: aligned monthly yields per country (only countries
  whose history overlaps the latest observation — stale series like Russia
  drop out of the merge naturally).
- region z-scores: latest yield vs own 2y history, and 21d momentum z.
- carry vs US: country yield minus the US series (same OECD family), z of
  that spread.

Pure logic; no network. Short histories produce NaN, never a regime.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

import config

Z_WINDOW = 24      # 24 monthly observations = 2y of history
Z_MIN = 12         # minimum months before a z-score is produced
MOM_LB = 3         # 3-month yield momentum


def _align(series_map: dict[str, pd.Series]) -> pd.DataFrame:
    frame = pd.DataFrame(series_map)
    if frame.empty:
        return frame
    frame = frame.resample("ME").last()
    # Never forward-fill a series past its own last observation: a country
    # whose data died years ago (e.g. RU 2018) must not appear "current".
    # Compute cutoffs on the raw (unfilled) series, then ffill (gap-fill)
    # and only afterwards apply the cutoff so no value survives its death.
    cutoffs = {}
    for c in frame.columns:
        last = frame[c].dropna().index.max()
        if pd.notna(last):
            cutoffs[c] = last
    frame = frame.ffill()
    for c, last in cutoffs.items():
        frame.loc[frame.index > last, c] = np.nan
    return frame.dropna(how="all")


def region_of(country: str) -> str | None:
    for region, members in config.GLOBAL_RATE_REGIONS.items():
        if country in members:
            return region
    return None


def country_metrics(country: str, s: pd.Series, us: pd.Series | None) -> dict | None:
    """Latest level, z (level vs own history), 3m momentum z, carry-vs-US z."""
    if s is None or len(s.dropna()) < Z_MIN:
        return None
    y = s.dropna()
    latest = float(y.iloc[-1])
    mu = y.rolling(Z_WINDOW, min_periods=Z_MIN).mean().iloc[-1]
    sd = y.rolling(Z_WINDOW, min_periods=Z_MIN).std(ddof=0).iloc[-1]
    level_z = float((latest - mu) / sd) if sd and sd > 0 else None
    mom = (y / y.shift(MOM_LB) - 1) if len(y) > MOM_LB else None
    mom_z = None
    if mom is not None:
        m = mom.dropna()
        if len(m) >= Z_MIN:
            mom_z = float((m.iloc[-1] - m.rolling(Z_WINDOW, min_periods=Z_MIN).mean().iloc[-1])
                          / m.rolling(Z_WINDOW, min_periods=Z_MIN).std(ddof=0).iloc[-1]) \
                          if m.rolling(Z_WINDOW, min_periods=Z_MIN).std(ddof=0).iloc[-1] > 0 else None
    carry_z = None
    if us is not None and not us.dropna().empty and country != "US":
        spread = y - us.dropna().reindex(y.index).ffill()
        spread = spread.dropna()
        if len(spread) >= Z_MIN:
            c_mu = spread.rolling(Z_WINDOW, min_periods=Z_MIN).mean().iloc[-1]
            c_sd = spread.rolling(Z_WINDOW, min_periods=Z_MIN).std(ddof=0).iloc[-1]
            carry_z = float((spread.iloc[-1] - c_mu) / c_sd) if c_sd and c_sd > 0 else None
    return {
        "country": country, "region": region_of(country),
        "as_of": str(y.index.max().date()), "yield": round(latest, 3),
        "level_z": round(level_z, 2) if level_z is not None else None,
        "mom_3m_z": round(mom_z, 2) if mom_z is not None else None,
        "carry_vs_us_z": round(carry_z, 2) if carry_z is not None else None,
    }


def region_metrics(matrix: pd.DataFrame, region: str, us_col: str = "US") -> dict | None:
    """Equal-weight region average: level, 3m momentum, carry vs US."""
    members = [c for c in config.GLOBAL_RATE_REGIONS[region] if c in matrix.columns]
    if not members:
        return None
    avg = matrix[members].mean(axis=1).dropna()
    if len(avg) < Z_MIN:
        return None
    latest = float(avg.iloc[-1])
    level_z = _z_last(avg)
    mom = (avg / avg.shift(MOM_LB) - 1).dropna()
    mom_z = _z_last(mom)
    carry_z = None
    if us_col in matrix.columns:
        spread = (avg - matrix[us_col].reindex(avg.index).ffill()).dropna()
        if len(spread) >= Z_MIN:
            carry_z = _z_last(spread)
    return {"region": region, "countries": len(members), "as_of": str(avg.index.max().date()),
            "yield": round(latest, 3), "level_z": round(level_z, 2) if level_z is not None else None,
            "mom_3m_z": round(mom_z, 2) if mom_z is not None else None,
            "carry_vs_us_z": round(carry_z, 2) if carry_z is not None else None}


def _z_last(s: pd.Series, window: int = Z_WINDOW, min_periods: int = Z_MIN) -> float | None:
    roll = s.rolling(window, min_periods=min_periods)
    sd = roll.std(ddof=0).iloc[-1]
    if not np.isfinite(sd) or sd <= 0:
        return None
    return float((s.iloc[-1] - roll.mean().iloc[-1]) / sd)


def global_rates_screen(series_map: dict[str, pd.Series]) -> dict:
    """Full screen: aligned matrix, per-country metrics, per-region metrics.

    A country whose data has been dead for >= 6 months vs the freshest
    observation is gated out of `countries` (honest staleness, not a value)."""
    matrix = _align(series_map)
    if matrix.empty:
        return {"status": "UNAVAILABLE: no sovereign yield series", "matrix": matrix}
    freshest = matrix.index.max()
    stale_before = freshest - pd.DateOffset(months=6)
    us = matrix["US"] if "US" in matrix.columns else None
    countries, stale = {}, []
    for c in matrix.columns:
        if c == "US":
            continue
        last = matrix[c].dropna().index.max()
        if pd.isna(last) or last < stale_before:
            stale.append(c)
            continue
        m = country_metrics(c, matrix[c], us)
        if m is not None:
            countries[c] = m
    regions = {r: region_metrics(matrix, r)
               for r in config.GLOBAL_RATE_REGIONS}
    regions = {r: rec for r, rec in regions.items() if rec is not None}
    return {"status": "OK", "matrix": matrix, "countries": countries,
            "regions": regions, "stale": stale,
            "as_of": str(matrix.index.max().date())}

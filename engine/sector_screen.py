"""Sector screens: EM sector OAS z-scores + EDGAR balance-sheet leverage.

Two independent sector lenses (both gated on real data):
1. EM credit by sector/ownership: ICE BofA OAS splits (Financials, Public,
   Private, EM HY, overall) z-scored vs own history -> which EM segment is
   rich/cheap vs its own cycle.
2. Corporate leverage by sector: SEC EDGAR LongTermDebt/TotalAssets medians
   per sector (annual filings) -> which industries are levered into the
   cycle (sector_screen is the engine over sources.sec_edgar output).

Pure logic; the z conventions match the other legs (rolling, threshold-gated).
"""
from __future__ import annotations

import numpy as np
import pandas as pd

import config

Z_WINDOW = 252  # daily OAS history
Z_MIN = 63


def oas_z(series: pd.Series) -> float | None:
    """Latest OAS vs its own 1y rolling history (daily series)."""
    if series is None or len(series.dropna()) < Z_MIN:
        return None
    s = series.dropna()
    roll = s.rolling(Z_WINDOW, min_periods=Z_MIN)
    sd = roll.std(ddof=0).iloc[-1]
    if not np.isfinite(sd) or sd <= 0:
        return None
    return float((s.iloc[-1] - roll.mean().iloc[-1]) / sd)


def em_sector_signals(oas: dict[str, pd.Series]) -> list[dict]:
    """Per EM segment: latest OAS, z, and 21d change."""
    rows = []
    for label, s in oas.items():
        if s is None or s.empty:
            rows.append({"segment": label, "status": "UNAVAILABLE: empty series"})
            continue
        z = oas_z(s)
        chg21 = float(s.iloc[-1] / s.iloc[-21] - 1) if len(s) >= 22 else None
        rows.append({"segment": label, "status": "OK",
                     "as_of": str(s.index.max().date()),
                     "oas": round(float(s.iloc[-1]), 1),
                     "oas_z": round(z, 2) if z is not None else None,
                     "chg_21d": round(chg21, 4) if chg21 is not None else None})
    return rows


def leverage_z(lev: pd.Series, min_obs: int = config.SEC_LEVERAGE_MIN_OBS) -> float | None:
    """Latest annual leverage vs own history (annual points)."""
    s = lev.dropna()
    if len(s) < min_obs:
        return None
    mu = s.mean()
    sd = s.std(ddof=0)
    if not np.isfinite(sd) or sd <= 0:
        return None
    return float((s.iloc[-1] - mu) / sd)


def leverage_signals(screen: dict[str, dict]) -> list[dict]:
    """Normalize the sec_edgar.leverage_screen dict into board rows."""
    rows = []
    for sector, rec in (screen or {}).items():
        if rec.get("status") != "OK":
            continue
        rows.append({"sector": sector, "status": "OK",
                     "as_of": rec["as_of"], "leverage": rec["leverage"],
                     "leverage_z": rec.get("leverage_z"),
                     "chg_3y": rec.get("chg_3y"), "filers": rec.get("filers"),
                     "n_obs": rec.get("n_obs")})
    return rows

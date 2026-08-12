"""Sovereign debt screen: World Bank debt stocks + spot FX overlay.

Unhedged only — free data carries no FX forward points, so hedged-carry math
is explicitly out of scope (R4). FX enters as trend/vol risk overlay on the
unhedged local-yield comparison, never a synthetic forward.
"""
from __future__ import annotations

import numpy as np
import pandas as pd


def latest_by_country(frame: pd.DataFrame, top_n: int = 20) -> pd.DataFrame:
    """Most recent non-null value per country, ranked by value."""
    if frame is None or frame.empty:
        return pd.DataFrame()
    g = frame.dropna(subset=["value"]).sort_values("year")
    latest = g.groupby(["iso3", "country"], sort=False).tail(1)
    return latest.sort_values("value", ascending=False).head(top_n) \
                 .reset_index(drop=True)[["iso3", "country", "year", "value"]]


def trend_cagr(frame: pd.DataFrame, years: int = 5) -> pd.DataFrame:
    """Per-country CAGR of the indicator over `years` (min 2 points, span>0)."""
    if frame is None or frame.empty:
        return pd.DataFrame()
    out = []
    for (iso3, country), g in frame.groupby(["iso3", "country"]):
        g = g.dropna(subset=["value"]).sort_values("year")
        if len(g) < 2 or float(g["value"].iloc[-1]) <= 0:
            continue
        last = g.iloc[-1]
        past = g[g["year"] <= last["year"] - years]
        if past.empty:
            past = g.iloc[0]
        else:
            past = past.iloc[-1]
        span = last["year"] - past["year"]
        if span <= 0 or float(past["value"]) <= 0:
            continue
        cagr = (float(last["value"]) / float(past["value"])) ** (1 / span) - 1
        out.append({"iso3": iso3, "country": country,
                    "span_years": span, "cagr": round(cagr, 4)})
    return pd.DataFrame(out).sort_values("cagr", ascending=False).reset_index(drop=True)


def fx_risk_overlay(fx: dict[str, pd.Series], window: int = 63) -> list[dict]:
    """Per pair: latest level, 20d return, annualized 63d vol."""
    rows = []
    for pair, s in fx.items():
        if s is None or len(s) < 21:
            rows.append({"pair": pair, "status": "UNAVAILABLE: short history"})
            continue
        ret20 = float(s.iloc[-1] / s.iloc[-21] - 1)
        logret = np.log(s / s.shift(1)).dropna()
        vol = (float(logret.tail(window).std(ddof=0) * np.sqrt(252))
               if len(logret) >= 2 else None)
        rows.append({"pair": pair, "as_of": str(s.index.max().date()),
                     "last": round(float(s.iloc[-1]), 4),
                     "ret_20d": round(ret20, 4),
                     "ann_vol_63d": round(vol, 4) if vol is not None else None})
    return rows

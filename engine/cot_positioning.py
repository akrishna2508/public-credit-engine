"""COT positioning: net dealer/leveraged positions and regime z-scores.

Input is the long-form COT frame from sources.cftc (columns: market,
report_date, Dealer_Long/Short, LevMoney_Long/Short, open_interest).
Markets match config.COT_MARKET_QUERIES by prefix (real TFF names carry an
exchange suffix). R4 gate: z-scores are only computed when the market has
>= config.COT_MIN_HISTORY_YEARS of observations — short histories report
UNAVAILABLE rather than a misleading z.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

import config


def _sub(df: pd.DataFrame, name: str) -> pd.DataFrame:
    """Rows for a configured market (prefix match, exchange-suffix tolerant)."""
    if df.empty:
        return df
    sub = df[df["market"].str.startswith(name)]
    return sub.copy()


def net_positions(df: pd.DataFrame) -> pd.DataFrame:
    """Dealer and leveraged-money net positions per market, indexed by date."""
    out = {}
    for name in config.COT_MARKET_QUERIES.values():
        sub = _sub(df, name)
        if sub.empty:
            continue
        sub["report_date"] = pd.to_datetime(sub["report_date"])
        sub = sub.drop_duplicates(subset=["report_date"], keep="last") \
                 .set_index("report_date").sort_index()
        out[name] = pd.DataFrame({
            "dealer_net": sub["Dealer_Long"] - sub["Dealer_Short"],
            "lev_net": sub["LevMoney_Long"] - sub["LevMoney_Short"],
            "open_interest": sub["open_interest"],
        })
    return out


def zscore(s: pd.Series, window: int = 52, min_periods: int = 26) -> pd.Series:
    """Rolling z-score of a weekly series. NaN where history is insufficient —
    never a number derived from a short sample."""
    mu = s.rolling(window, min_periods=min_periods).mean()
    sd = s.rolling(window, min_periods=min_periods).std(ddof=0).replace(0, np.nan)
    return (s - mu) / sd


def positioning_signals(df: pd.DataFrame) -> list[dict]:
    """One signal row per configured market with coverage and z-scores."""
    rows = []
    for name in config.COT_MARKET_QUERIES.values():
        sub = _sub(df, name)
        hist_years = 0.0
        if not sub.empty:
            hist_years = (pd.to_datetime(sub["report_date"]).max()
                          - pd.to_datetime(sub["report_date"]).min()).days / 365.25
        rec = {"market": name, "obs": len(sub), "hist_years": round(hist_years, 2)}
        if sub.empty:
            rec["status"] = "UNAVAILABLE: no COT rows for market"
            rows.append(rec)
            continue
        nets = pd.DataFrame({
            "date": pd.to_datetime(sub["report_date"]),
            "dealer_net": sub["Dealer_Long"] - sub["Dealer_Short"],
            "lev_net": sub["LevMoney_Long"] - sub["LevMoney_Short"],
        }).set_index("date").sort_index()
        if hist_years < config.COT_MIN_HISTORY_YEARS:
            rec["status"] = (f"UNAVAILABLE: history {hist_years:.1f}y < "
                             f"{config.COT_MIN_HISTORY_YEARS:.1f}y minimum")
            rows.append(rec)
            continue
        rec.update({
            "status": "OK",
            "as_of": str(nets.index.max().date()),
            "dealer_net": round(float(nets["dealer_net"].iloc[-1]), 0),
            "lev_net": round(float(nets["lev_net"].iloc[-1]), 0),
            "dealer_z": round(float(zscore(nets["dealer_net"]).iloc[-1]), 2),
            "lev_z": round(float(zscore(nets["lev_net"]).iloc[-1]), 2),
        })
        rows.append(rec)
    return rows

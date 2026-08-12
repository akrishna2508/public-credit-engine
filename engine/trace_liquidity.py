"""TRACE-family liquidity analytics over FINRA public aggregated datasets.

Pure logic over frames returned by sources.finra. Schema drift is detected
and reported — a missing column yields UNAVAILABLE, never a made-up number.
"""
from __future__ import annotations

import pandas as pd


def _to_numeric(df: pd.DataFrame) -> pd.DataFrame:
    out = df.copy()
    for c in out.columns:
        if out[c].dtype == object:
            out[c] = pd.to_numeric(out[c], errors="coerce")
    return out


def breadth_metrics(breadth: pd.DataFrame) -> dict:
    """Latest-date breadth snapshot: active issuers/securities, trade counts."""
    if breadth is None or breadth.empty:
        return {"status": "UNAVAILABLE: no breadth rows"}
    df = breadth.copy()
    date_col = next((c for c in df.columns if c.lower() in ("report_date", "date", "as_of_date")), None)
    if date_col is None:
        return {"status": "UNAVAILABLE: no date column in breadth schema", "n_rows": len(df)}
    df[date_col] = pd.to_datetime(df[date_col], errors="coerce")
    df = df.dropna(subset=[date_col]).sort_values(date_col)
    if df.empty:
        return {"status": "UNAVAILABLE: no parseable dates"}
    latest = df[df[date_col] == df[date_col].max()]
    return {"status": "OK", "as_of": str(df[date_col].max().date()),
            "rows_latest_date": int(len(latest))}


def volume_heat(capped: pd.DataFrame) -> dict:
    """Aggregate volume/trade-size summary from the capped-volume dataset."""
    if capped is None or capped.empty:
        return {"status": "UNAVAILABLE: no capped-volume rows"}
    df = _to_numeric(capped)
    vol_col = next((c for c in df.columns if "volume" in c.lower()), None)
    if vol_col is None:
        return {"status": "UNAVAILABLE: no volume column in schema", "n_rows": len(df)}
    v = df[vol_col].dropna()
    if v.empty:
        return {"status": "UNAVAILABLE: volume column all null"}
    return {"status": "OK", "n_rows": len(df),
            "total_volume": round(float(v.sum()), 0),
            "mean_volume": round(float(v.mean()), 2)}

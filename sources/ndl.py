"""Nasdaq Data Link (ex-Quandl) free tier: daily US Treasury curve + bills.

Optional keyed source (NASDAD_DATA_LINK_API_KEY, free account at
https://data.nasdaq.com). Provides USTREASURY/YIELD (daily nominal + real
par yields across maturities) and USTREASURY/BILL_RATES (weekly T-bill
auction rates) — a cross-validation of the FRED curve and the only free
daily source for the full real curve outside FRED.

Missing key -> UNAVAILABLE with signup instructions. Real data or nothing.
"""
from __future__ import annotations

import pandas as pd
import requests

import config
from sources.registry import SourceUnavailable


def _fetch_dataset(dataset: str, rows: int = 500) -> pd.DataFrame:
    key = config.get_ndl_key()
    if key is None:
        raise SourceUnavailable(
            "ndl", f"{dataset}: NASDAQ_DATA_LINK_API_KEY not set",
            "Free account: https://data.nasdaq.com -> API Keys -> paste into .env")
    url = f"{config.NDL_BASE}/{dataset}.json"
    try:
        resp = requests.get(url, params={"api_key": key, "rows": rows}, timeout=60)
        resp.raise_for_status()
        payload = resp.json()
    except requests.RequestException as e:
        msg = str(e).replace(key, "***")  # never leak the key into logs
        raise SourceUnavailable("ndl", f"{dataset}: {msg}") from e
    data = payload.get("dataset", {})
    cols = data.get("column_names", [])
    vals = data.get("data", [])
    if not cols or not vals:
        raise SourceUnavailable("ndl", f"{dataset}: empty dataset payload")
    return pd.DataFrame(vals, columns=cols)


def fetch_yield_curve(rows: int = 500) -> pd.DataFrame:
    """Daily Treasury par yield curve (nominal 1M-30Y + real 5Y-30Y)."""
    df = _fetch_dataset(config.NDL_YIELD_CURVE_DATASET, rows=rows)
    date_col = df.columns[0]
    df[date_col] = pd.to_datetime(df[date_col], errors="coerce")
    df = df.dropna(subset=[date_col]).set_index(date_col).sort_index()
    for c in df.columns:
        df[c] = pd.to_numeric(df[c], errors="coerce")
    return df.dropna(how="all")


def fetch_bill_rates(rows: int = 300) -> pd.DataFrame:
    """Weekly 13/26/52-week T-bill auction rates (percent)."""
    df = _fetch_dataset(config.NDL_BILL_RATES_DATASET, rows=rows)
    date_col = df.columns[0]
    df[date_col] = pd.to_datetime(df[date_col], errors="coerce")
    df = df.dropna(subset=[date_col]).set_index(date_col).sort_index()
    for c in df.columns:
        df[c] = pd.to_numeric(df[c], errors="coerce")
    return df.dropna(how="all")

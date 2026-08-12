"""yfinance spot FX (free, keyless) — EM local-currency overlay.

Free data has no FX forward points, so hedged-carry math is out of scope
(R4); the sovereign screen uses unhedged local yield plus spot trend/vol.
"""
from __future__ import annotations

import pandas as pd
import yfinance as yf

import config
from sources.registry import SourceUnavailable


def fetch_pair(pair: str, start: str = "2016-01-01") -> pd.Series:
    try:
        df = yf.download(pair, start=start, progress=False, auto_adjust=True)
    except Exception as e:
        raise SourceUnavailable("yf_fx", f"{pair}: {e}") from e
    if df is None or df.empty:
        raise SourceUnavailable("yf_fx", f"{pair}: no data")
    close = df["Close"]
    if isinstance(close, pd.DataFrame):
        close = close.iloc[:, 0]
    close = close.dropna()
    if close.empty:
        raise SourceUnavailable("yf_fx", f"{pair}: no non-null closes")
    return close


def fetch_fx_panel() -> dict[str, pd.Series]:
    out: dict[str, pd.Series] = {}
    for p in config.FX_PAIRS:
        try:
            out[p] = fetch_pair(p)
        except SourceUnavailable as e:
            print(f"  [UNAVAILABLE] yf_fx.{p}: {e}")
    if not out:
        raise SourceUnavailable("yf_fx", "no FX pairs returned data")
    return out

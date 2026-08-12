"""yfinance (free, keyless) rate-futures EOD: ZT/ZF/ZN/ZB/UB/SR3.

Continuous futures strings (=F) carry adjustment seams; consumers use only
EOD closes for momentum/positioning cross-checks, never rolled PnL. Each
ticker is gated: a missing one is reported, the rest still load.
"""
from __future__ import annotations

import pandas as pd
import yfinance as yf

import config
from sources.registry import SourceUnavailable


def fetch_close(ticker: str, start: str = "2018-01-01") -> pd.Series:
    try:
        df = yf.download(ticker, start=start, progress=False, auto_adjust=True)
    except Exception as e:
        raise SourceUnavailable("yf_futures", f"{ticker}: {e}",
                                "yfinance is free/keyless; a delisted ticker is skipped") from e
    if df is None or df.empty:
        raise SourceUnavailable("yf_futures", f"{ticker}: no data returned")
    close = df["Close"]
    if isinstance(close, pd.DataFrame):  # multi-ticker download edge case
        close = close.iloc[:, 0]
    close = close.dropna()
    if close.empty:
        raise SourceUnavailable("yf_futures", f"{ticker}: no non-null closes")
    return close


def fetch_futures_panel() -> dict[str, pd.Series]:
    out: dict[str, pd.Series] = {}
    for t in config.RATE_FUTURES_TICKERS:
        try:
            out[t] = fetch_close(t)
        except SourceUnavailable as e:
            print(f"  [UNAVAILABLE] yf_futures.{t}: {e}")
    if not out:
        raise SourceUnavailable("yf_futures", "no futures tickers returned data")
    return out

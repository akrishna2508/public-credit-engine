"""Rate-futures layer: SOFR-strip implied rates, note-futures momentum.

Futures-implied yields come ONLY from the SOFR strip (SR3=F; price = 100 -
rate, no CTD ambiguity). Note futures (ZT/ZF/ZN/ZB/UB) serve momentum and
positioning cross-checks only — never rolled PnL, since yfinance continuous
strings carry adjustment seams (R3/R4).
"""
from __future__ import annotations

import numpy as np
import pandas as pd


def sofr_implied_rate(close: pd.Series) -> pd.Series:
    """SOFR futures close -> implied 3M rate in bps."""
    if close is None or close.empty:
        return pd.Series(dtype=float)
    return (100.0 - close) * 100.0


def note_momentum(close: pd.Series, lookback: int = 21) -> pd.Series:
    """Price momentum over `lookback` sessions (fractional change)."""
    if close is None or len(close) <= lookback:
        return pd.Series(dtype=float, index=close.index if close is not None else None)
    return close.pct_change(lookback)


def futures_summary(panel: dict[str, pd.Series]) -> dict:
    """Latest close + 21d momentum per ticker, with as-of dates. Tickers
    missing from the panel are omitted — never zero-filled."""
    out = {}
    for ticker, s in panel.items():
        if s is None or s.empty:
            continue
        row = {"as_of": str(s.index.max().date()), "last": float(s.iloc[-1])}
        mom = note_momentum(s)
        if len(mom) and np.isfinite(float(mom.iloc[-1])):
            row["mom_21d"] = float(mom.iloc[-1])
        out[ticker] = row
    return out


def sofr_expected_rate(panel: dict[str, pd.Series]) -> dict:
    """SR3=F implied 3M rate in bps (the cleanest free forward-rate signal)."""
    s = panel.get("SR3=F")
    if s is None or s.empty:
        return {"UNAVAILABLE": "SR3=F not present in the futures panel"}
    imp = sofr_implied_rate(s)
    return {"as_of": str(imp.index.max().date()), "rate_bp": round(float(imp.iloc[-1]), 2)}


# ---------------------------------------------------------------------------
# Index-futures basis/carry leg (multi-asset heatmap spec §3.4). The spec's
# basis formula needs the futures expiry; CME equity futures (ES/NQ) expire on
# the third Friday of the contract month (published CME rule, pure calendar).
# This is a CASH-INDEX basis (same underlying index), so it carries none of
# the CTD ambiguity that excludes note-futures yields.
# ---------------------------------------------------------------------------

def third_friday(year: int, month: int) -> pd.Timestamp:
    """Third Friday of a month (CME rule for index futures expiry day)."""
    first = pd.Timestamp(year, month, 1)
    offset = (4 - first.dayofweek) % 7  # days to the first Friday
    return first + pd.Timedelta(days=offset + 14)


def days_to_third_friday(as_of: pd.Timestamp) -> int:
    """Business rule: days from `as_of` (exclusive) to the next third Friday.
    The third Friday IS this month's when it falls on/after as_of + 1."""
    year, month = as_of.year, as_of.month
    cand = third_friday(year, month)
    if cand <= as_of:
        if month == 12:
            cand = third_friday(year + 1, 1)
        else:
            cand = third_friday(year, month + 1)
    return (cand - as_of).days


def index_futures_basis(fut_close: pd.Series | None, spot_close: pd.Series | None,
                        as_of: pd.Timestamp | None = None) -> dict:
    """Annualized basis yield of a cash-index future vs its index.

    (Futures - Spot) / Spot * (365 / DTE) per the heatmap spec §3.4, all real
    inputs. Future or spot missing -> UNAVAILABLE (never fabricated).
    """
    if fut_close is None or spot_close is None or fut_close.empty or spot_close.empty:
        return {"status": "UNAVAILABLE", "reason": "future or spot series empty"}
    as_of = as_of or spot_close.index.max()
    f = float(fut_close.dropna().iloc[-1])
    s = float(spot_close.dropna().iloc[-1])
    if s <= 0:
        return {"status": "UNAVAILABLE", "reason": "spot <= 0"}
    dte = days_to_third_friday(pd.Timestamp(as_of))
    basis = (f - s) / s * (365.0 / dte)
    return {
        "status": "ok",
        "as_of": str(pd.Timestamp(as_of).date()),
        "future_last": round(f, 2),
        "spot_last": round(s, 2),
        "dte_days": dte,
        "basis_ann": round(basis, 4),
        "note": "CME third-Friday expiry rule; annualized basis yield = "
                "(F-S)/S * 365/DTE (heatmap spec §3.4)",
    }

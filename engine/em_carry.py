"""EM carry screen: local-currency vs hard-currency fund baskets.

Local funds (LEMB/PCY/VWOB) pay local-currency EM sovereign yields; hard
funds (EMB/CEMB) pay hard-currency EM yields. The local-hard distribution
yield differential is the unhedged carry that free data can measure (spot
FX only — no forward points, so hedged carry stays out of scope, R4).

Yield history is reconstructed from real dividend actions: a monthly
distribution yield = 12m trailing distributions / month-end price per fund,
then a basket mean per month, then a local-minus-hard differential z-scored
against its own history. Pure logic over yfinance data.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

import config

Z_WINDOW = 24  # months
Z_MIN = 12


def _tz_naive(s: pd.Series) -> pd.Series:
    """Strip an aware DatetimeIndex to naive wall-clock time so yfinance
    dividend series (tz-aware exchange time) and close series (naive by
    default) can be resampled and aligned in one calendar-year space.
    """
    if getattr(s.index, "tz", None) is not None:
        return s.tz_localize(None)
    return s


def distribution_yield(close: pd.Series, dividends: pd.Series) -> pd.Series:
    """Monthly 12m-trailing distribution yield in percent."""
    if close is None or close.empty or dividends is None or dividends.empty:
        return pd.Series(dtype=float)
    cl, dv = _tz_naive(close.dropna()), _tz_naive(dividends.dropna())
    monthly_price = cl.resample("ME").last().dropna()
    if monthly_price.empty:
        return pd.Series(dtype=float)
    trailing = dv.resample("ME").sum().rolling(12, min_periods=6).sum()
    yield_pct = (trailing / monthly_price * 100.0).dropna()
    return yield_pct


def basket_yield(close_map: dict[str, pd.Series], dividends_map: dict[str, pd.Series],
                 funds: list[str]) -> pd.Series:
    """Equal-weight monthly basket yield over the funds that have data."""
    cols = []
    for f in funds:
        if f not in close_map or f not in dividends_map:
            continue
        y = distribution_yield(close_map[f], dividends_map[f])
        if len(y):
            cols.append(y)
    if not cols:
        return pd.Series(dtype=float)
    frame = pd.concat(cols, axis=1)
    return frame.mean(axis=1).dropna()


def _z_last(s: pd.Series) -> float | None:
    roll = s.rolling(Z_WINDOW, min_periods=Z_MIN)
    sd = roll.std(ddof=0).iloc[-1]
    if not np.isfinite(sd) or sd <= 0:
        return None
    return float((s.iloc[-1] - roll.mean().iloc[-1]) / sd)


def carry_screen(close_map: dict[str, pd.Series],
                 dividends_map: dict[str, pd.Series]) -> dict:
    """Local vs hard carry: differential level + z + 3m change."""
    local = basket_yield(close_map, dividends_map, config.EM_LOCAL_FUNDS)
    hard = basket_yield(close_map, dividends_map, config.EM_HARD_FUNDS)
    if local.empty or hard.empty:
        return {"status": "UNAVAILABLE: EM fund data missing"}
    diff = (local - hard).dropna()
    if diff.empty:
        return {"status": "UNAVAILABLE: no overlapping fund history"}
    z = _z_last(diff)
    chg3 = float(diff.iloc[-1] / diff.iloc[-4] - 1) if len(diff) >= 5 else None
    return {
        "status": "OK",
        "as_of": str(diff.index.max().date()),
        "local_yield": round(float(local.iloc[-1]), 2),
        "hard_yield": round(float(hard.iloc[-1]), 2),
        "carry_diff": round(float(diff.iloc[-1]), 2),
        "carry_diff_z": round(z, 2) if z is not None else None,
        "chg_3m": round(chg3, 4) if chg3 is not None else None,
        "n_months": int(len(diff)),
    }

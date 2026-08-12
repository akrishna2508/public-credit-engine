"""Options surface on credit ETFs: IV level, IV-vs-realized premium.

R4 invariant: realized vol is computed on the SAME underlying as the listed
IV (ETF log returns) — never on spread bps or another instrument. IV history
is accrued by sources.yf_options into data/iv_history.json; this module is
pure (no network).
"""
from __future__ import annotations

import json

import numpy as np
import pandas as pd

import config


def realized_vol_series(close: pd.Series, window: int = 21) -> pd.Series:
    """Annualized RV of log returns per date (Series, for z-scoring)."""
    if close is None or len(close) < 2:
        return pd.Series(dtype=float)
    logret = np.log(close / close.shift(1)).dropna()
    return logret.rolling(window, min_periods=window // 2).std(ddof=0) * np.sqrt(252)


def realized_vol(close: pd.Series, window: int = 21) -> float | None:
    """Latest annualized realized vol over `window` sessions."""
    rv = realized_vol_series(close, window).dropna()
    return float(rv.iloc[-1]) if len(rv) else None


def premium_series(atm_iv: pd.Series, rv: pd.Series) -> pd.Series:
    """Pointwise IV minus RV (vol points), aligned to the IV dates.

    RV is taken as-of each IV date (last realized value at or before it), so
    weekend/holiday accrual dates map to the prior trading day's RV. An empty
    RV (degenerate close history) yields an empty premium, not a crash.
    """
    if rv is None or len(rv) == 0:
        return pd.Series(dtype=float)
    rv_at = rv.asof(atm_iv.index)
    return (atm_iv - rv_at).dropna()


def premium_z(premium: pd.Series, min_obs: int = 20) -> tuple[float | None, int]:
    """z-score of the last IV-RV premium vs its own accrued history.

    Returns (z, n_obs); z is None until >= min_obs days have accrued —
    a 1-day premium cannot support a signal (R4 history gate).
    """
    if len(premium) < min_obs:
        return None, len(premium)
    mu = premium.mean()
    sd = premium.std(ddof=0)
    if not np.isfinite(sd) or sd < 1e-12:
        return None, len(premium)
    return float((premium.iloc[-1] - mu) / sd), len(premium)


def premium_z_series(premium: pd.Series, min_obs: int = 20) -> tuple[pd.Series, int]:
    """Walk-forward IV-RV premium z: at each date, the premium vs its own
    history to date (expanding window, no look-ahead). Empty until min_obs
    days accrue; used by the backtest battery's IVRV leg."""
    if len(premium) < min_obs:
        return pd.Series(dtype=float), len(premium)
    roll = premium.expanding(min_periods=min_obs)
    sd = roll.std(ddof=0).replace(0, np.nan)
    z = ((premium - roll.mean()) / sd).dropna()
    return z, len(premium)


def iv_premium(atm_iv: float | None, realized: float | None) -> float | None:
    """IV minus realized vol, in vol points. None when either leg is missing."""
    if atm_iv is None or realized is None:
        return None
    return atm_iv - realized


def load_iv_history() -> dict:
    if config.IV_HISTORY_FILE.exists():
        try:
            return json.loads(config.IV_HISTORY_FILE.read_text())
        except json.JSONDecodeError:
            return {}
    return {}


def history_to_frame(history: dict) -> pd.DataFrame:
    """Accrued IV history -> wide frame (rows = as_of date, cols = ticker)."""
    rows = []
    for ticker, days in history.items():
        for day, snap in days.items():
            if isinstance(snap, dict) and "atm_iv" in snap:
                rows.append({"date": day, "ticker": ticker, "atm_iv": snap["atm_iv"]})
    if not rows:
        return pd.DataFrame(columns=["date", "ticker", "atm_iv"])
    df = pd.DataFrame(rows)
    df["date"] = pd.to_datetime(df["date"])
    return df.pivot(index="date", columns="ticker", values="atm_iv")


def skew_series(history: dict, ticker: str) -> pd.Series:
    """Accrued 25-delta put skew for one ticker (polygon snapshots only).

    Empty when no snapshots carry `skew_25d` (yfinance snapshots do not).
    """
    rows = []
    for day, snap in (history.get(ticker, {}) or {}).items():
        if isinstance(snap, dict) and snap.get("skew_25d") is not None:
            rows.append((day, float(snap["skew_25d"])))
    if not rows:
        return pd.Series(dtype=float)
    s = pd.Series([v for _, v in rows], index=pd.to_datetime([d for d, _ in rows]))
    return s.sort_index().dropna()


def skew_z(skew: pd.Series, min_obs: int | None = None) -> tuple[float | None, int]:
    """z of the latest put skew vs its own accrued history (min-obs gate).

    Positive z = puts rich (tail risk expensively priced); negative =
    puts cheap (tail risk underpriced — the opportunity signal)."""
    needed = min_obs if min_obs is not None else config.SKEW_Z_MIN_OBS
    if len(skew) < needed:
        return None, len(skew)
    mu = skew.mean()
    sd = skew.std(ddof=0)
    if not np.isfinite(sd) or sd < 1e-12:
        return None, len(skew)
    return float((skew.iloc[-1] - mu) / sd), len(skew)

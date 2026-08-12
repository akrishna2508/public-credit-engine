"""Real-rate / breakeven leg: TIPS real yields vs inflation expectations.

The trade: long TIPS (TIP) when real yields are rich (high real-yield z,
compensation for holding inflation-protected paper) and breakevens are
cheap (low breakeven z, market pricing little future inflation). Both
inputs are FRED constant-maturity series:

  DFII10   10Y TIPS real yield
  T10YIE   10Y nominal-real breakeven (market inflation expectation)
  DFII5/T5YIE, DFII30 for the curve context

Pure logic; a series shorter than the z minimum reports None, never a number.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

Z_WINDOW = 252
Z_MIN = 63


def _z_last(s: pd.Series, window: int = Z_WINDOW, min_periods: int = Z_MIN) -> float | None:
    roll = s.rolling(window, min_periods=min_periods)
    sd = roll.std(ddof=0).iloc[-1]
    if not np.isfinite(sd) or sd <= 0:
        return None
    return float((s.iloc[-1] - roll.mean().iloc[-1]) / sd)


def real_rates_signals(inflation: dict[str, pd.Series]) -> dict:
    """Latest real yield, breakeven, both z-scored; plus the 5s10s slope."""
    out = {"status": "OK", "components": {}}
    for label in ("DFII5", "DFII10", "DFII30", "T5YIE", "T10YIE"):
        s = (inflation or {}).get(label)
        if s is None or s.empty:
            out["components"][label] = None
            continue
        z = _z_last(s.dropna())
        out["components"][label] = {
            "value": round(float(s.iloc[-1]), 3),
            "z": round(z, 2) if z is not None else None,
            "as_of": str(s.index.max().date()),
        }
    # 5s10s real curve slope (bps): rich/steep real curve = cheap long-end TIPS
    if ("DFII5" in out["components"] and out["components"]["DFII5"]
            and "DFII10" in out["components"] and out["components"]["DFII10"]):
        d5 = out["components"]["DFII5"]["value"]
        d10 = out["components"]["DFII10"]["value"]
        out["real_slope_5s10s_bp"] = round((d10 - d5) * 100, 1)
    return out

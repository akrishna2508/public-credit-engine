"""Credit-appetite composite: the LIVE proxy for credit positioning.

The COT Bloomberg IG/HY credit-futures legs are genuinely gated until ~2028
(the contracts only listed 2026-03/05 — no free data can accelerate that).
This composite replaces them TODAY with history-rich, free components, each
z-scored to its own history and averaged with NO weights:

  hy_oas_z          ICE BofA US HY OAS, 1y rolling z (low OAS = risk-on)
  dr_momentum_z     6m change in the HY default rate, z-scored (falling DR =
                    risk-on) — sign flipped so positive = improving credit
  breadth_z         FINRA corporate breadth/volume z (rising breadth = risk-on)
  hyg_ivrv_z        HYG IV-RV premium z when accrued (negative premium = risk-on)

appetite z = mean of the AVAILABLE components (needs >= APPETITE_COMPONENTS_MIN).
Positive z = risk appetite expanding; the board trades it as "appetite
above/below normal". No magic weights — see context.md §6.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

import config

Z_WINDOW = 252
Z_MIN = 63


def _z_last(s: pd.Series, window: int = Z_WINDOW, min_periods: int = Z_MIN) -> float | None:
    roll = s.rolling(window, min_periods=min_periods)
    sd = roll.std(ddof=0).iloc[-1]
    if not np.isfinite(sd) or sd <= 0:
        return None
    return float((s.iloc[-1] - roll.mean().iloc[-1]) / sd)


def hy_oas_component(hy_oas: pd.Series | None) -> float | None:
    """-z of HY OAS: tight spreads = high risk appetite."""
    if hy_oas is None or hy_oas.empty:
        return None
    z = _z_last(hy_oas.dropna())
    return -z if z is not None else None


def default_rate_component(dr_series: pd.Series | None, max_age_days: int | None = None) -> float | None:
    """-z of the 6m change in the HY default rate: falling DR = risk-on.

    DRCCLACBS publishes on quarter-start dates (Jan/Apr/Jul/Oct 1st):
    resample("MS") maps them onto month starts (asfreq("ME") wiped every
    value — fixed 2026-08-11). `max_age_days` (default config) darkens the
    component when the last observation is stale — it must not vote on
    7-month-old data.
    """
    if dr_series is None or len(dr_series.dropna()) < 12:
        return None
    s = dr_series.dropna()
    if not isinstance(s.index, pd.DatetimeIndex):
        s.index = pd.to_datetime(s.index, errors="coerce")
        s = s.dropna()
    max_age_days = max_age_days if max_age_days is not None else config.DR_STALE_MAX_AGE_DAYS
    if (pd.Timestamp.today() - s.index.max()).days > max_age_days:
        return None
    s = s.resample("MS").last().dropna()
    if len(s) < 12:
        return None
    mom = s.diff(6).dropna()
    if len(mom) < 12:
        return None
    z = _z_last(mom)
    return -z if z is not None else None


def breadth_component(breadth_z: float | None) -> float | None:
    """Pre-computed FINRA breadth z (rising breadth = risk-on)."""
    return breadth_z


def ivrv_component(hyg_premium_z: float | None) -> float | None:
    """-z of HYG IV-RV premium: cheap vol = risk-on. None until accrued."""
    return -hyg_premium_z if hyg_premium_z is not None else None


def appetite_z(components: dict[str, float | None], min_components: int | None = None) -> tuple[float | None, dict, int]:
    """Composite z = mean of available components. Returns (z, used, n_used).
    z is None when fewer than `min_components` are live."""
    needed = min_components if min_components is not None else config.APPETITE_COMPONENTS_MIN
    used = {k: round(v, 3) for k, v in components.items() if v is not None}
    if len(used) < needed or not used:
        return None, used, len(used)
    z = float(np.mean(list(used.values())))
    return round(z, 3), used, len(used)

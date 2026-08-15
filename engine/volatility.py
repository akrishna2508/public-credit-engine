"""Volatility-period strategy engine (public credit markets only).

Unifies the former `volatility_trading.py` (spread pairs) and
`pure_volatility_trading.py` (single assets) into one parameterized module.
Audit fixes applied:
  * kappa mean-reversion overrides (25.0 / 40.0) dropped — the fee is now the
    EMPIRICAL expected |T-day move| (rolling realized |delta_T|, no
    look-ahead), which is mean-reversion aware for whipsaw series like the
    fallen-angel TTM yield (see get_empirical_move_fee). calc_ou_straddle
    remains as the analytic Bachelier/OU reference (unwired).
  * Discount rate is live-fetched (no 0.04 fallback).
  * Dealer-markup constant fallback removed (series required).
  * Pair-mode retail cost = ONE netted straddle on the pair series (the
    long-short unit), not the sum of both legs' straddles.
"""
from __future__ import annotations

import json
import os

import numpy as np
import pandas as pd
from arch import arch_model

import config
from engine.data_engine import fetch_treasury_daily_rate


def get_treasury_rates(index: pd.DatetimeIndex) -> pd.Series:
    """Live 13-week T-bill (^IRX) daily rate aligned to `index`; raises if missing."""
    return fetch_treasury_daily_rate(index, ticker=config.TREASURY_PROXY_TICKER)


def get_dealer_volatility(series: pd.Series, window: int = None,
                          freq: str = "days") -> pd.Series:
    """Realized per-period vol of first differences, shifted to avoid look-ahead."""
    window = window or config.freq_profile(freq)["dealer_window"]
    returns = series.diff().dropna()
    dealer_vol = returns.rolling(window).std().shift(1)
    return dealer_vol.reindex(series.index).ffill().bfill()


def fit_garch_volatility(series: pd.Series, label: str = "", min_obs: int = None,
                         freq: str = "days") -> pd.Series:
    """GARCH(1,1) conditional volatility; falls back to rolling std on failure."""
    min_obs = min_obs or config.MIN_OBS_FOR_GARCH
    window = config.freq_profile(freq)["dealer_window"]
    returns = series.diff().dropna()
    fallback = returns.rolling(window).std().reindex(series.index).ffill().bfill()
    if len(returns) < min_obs:
        return fallback
    try:
        mdl = arch_model(returns, vol="GARCH", p=1, q=1, mean="AR", lags=1,
                         dist="Normal", rescale=True)
        res = mdl.fit(disp="off", show_warning=False)
        alpha, beta = res.params.get('alpha[1]', 0), res.params.get('beta[1]', 0)
        if alpha + beta >= 1.0:
            raise ValueError(f"GARCH non-stationary for {label}")
        return res.conditional_volatility.reindex(series.index).ffill().bfill()
    except Exception:
        return fallback


def calc_ou_straddle(dealer_vol_series: pd.Series, r_series: pd.Series,
                     markup_series: pd.Series, T_days: int, kappa: float = 0.0) -> pd.Series:
    """Analytic Bachelier/OU straddle premium of a T-day forward move (reference).

    Not wired into analyze_strategy since 2026-08-11: raw rolling vol ignores
    multi-day reversal, so on whipsaw series (e.g. the fallen-angel TTM yield,
    daily AR(1) ~ -0.3) it overpriced the fee ~2.3x vs realized |move|. The
    strategy fee path uses get_empirical_move_fee instead. kappa = 0 collapses
    the OU variance scaling to the standard sigma^2 * T term.
    """
    T = T_days / config.TRADING_DAYS
    annualized_normal_vol = dealer_vol_series * np.sqrt(config.TRADING_DAYS)
    if kappa < 1e-6:
        ou_variance = (annualized_normal_vol ** 2) * T
    else:
        ou_variance = (annualized_normal_vol ** 2 / (2 * kappa)) * (1 - np.exp(-2 * kappa * T))
    safe_ou_variance = np.where(ou_variance > 0, ou_variance, 1e-12)
    effective_vol = np.sqrt(safe_ou_variance / T)
    priced_vol = effective_vol * markup_series
    discount_factor = np.exp(-r_series * T)
    return discount_factor * priced_vol * np.sqrt(T) * np.sqrt(2 / np.pi)


def get_empirical_move_fee(series: pd.Series, hold_days: int, window: int = None,
                           freq: str = "days") -> pd.Series:
    """Expected |T-day move| estimated from the series' own realized moves.

    Rolling mean of |y_{t+T} - y_t|, each value shifted by T so it is only
    knowable after the window elapses (no look-ahead). This is the fair price
    of a T-day ATM straddle under the series' REAL autocorrelation structure:
    whipsaw series (big daily moves that reverse within T days) price far
    cheaper than a raw-vol Bachelier term, while trending series price at
    parity. Overridden by the dealer markup in analyze_strategy.
    """
    window = window or config.freq_profile(freq)["dealer_window"]
    moves = (series.shift(-hold_days) - series).abs()
    known = moves.shift(hold_days)
    fee = known.rolling(window, min_periods=10).mean()
    return fee.reindex(series.index).ffill().bfill()


def calculate_dynamic_pb_markup(retail_markup_series: pd.Series, daily_vol_bps: pd.Series,
                                trade_size_millions: float = None,
                                freq: str = "days") -> pd.Series:
    """Prime-broker execution discount schedule (config-documented constants).

    PB_VOL_THRESHOLD_BPS is an absolute number of basis points of ANNUAL risk,
    so the vol it is compared against must be annualised at the SERIES' own
    frequency. A monthly series annualised by sqrt(252) is inflated ~4.6x.
    """
    trade_size_millions = trade_size_millions or config.DEFAULT_TRADE_SIZE_M
    volume_discount = np.log10(max(1.0, trade_size_millions)) * config.PB_VOLUME_DISCOUNT_FACTOR
    periods = config.freq_profile(freq)["periods_per_year"]
    annualized_vol_bps = daily_vol_bps * np.sqrt(periods)
    illiquidity_penalty = np.maximum(0.0, (annualized_vol_bps - config.PB_VOL_THRESHOLD_BPS)
                                     / config.PB_ILLIQUIDITY_DIVISOR)
    total_discount = config.PB_BASE_DISCOUNT + volume_discount - illiquidity_penalty
    total_discount = np.clip(total_discount, *config.PB_DISCOUNT_CLIP)
    return retail_markup_series * (1.0 - total_discount)


def calculate_dynamic_execution_friction(base_spread_bps: float, macro_vol_proxy: pd.Series,
                                         shock_percentile: float = None) -> pd.Series:
    """Execution friction: exponential in vol above shock percentile."""
    shock_percentile = shock_percentile or config.FRICTION_PERCENTILE
    threshold = np.percentile(macro_vol_proxy.dropna(), shock_percentile)
    excess = np.maximum(0, macro_vol_proxy - threshold)
    return pd.Series(base_spread_bps * np.exp(config.FRICTION_GROWTH_RATE * excess),
                     index=macro_vol_proxy.index)


def load_dealer_markup(index: pd.DatetimeIndex) -> pd.Series:
    """Required markup series; refuses silent constant fallback."""
    p = config.DEALER_MARKUP_FILE
    if not os.path.exists(p):
        raise FileNotFoundError(
            f"Dealer markup series missing at {p}. Run engine.dealer_markup.run() first."
        )
    with open(p) as f:
        data = json.load(f)
    s = pd.Series(data["Dealer_Multiplier"])
    s.index = pd.to_datetime(s.index)
    return s.reindex(index).ffill().bfill()


def _trade_cost_basis(series: pd.Series, name: str, retail_markup: pd.Series,
                      trade_size_millions: float, percentile: float,
                      freq: str = "days"):
    """Shared shock/calm masks + markup + friction for one traded series.

    Single source of truth used by analyze_strategy and return_curve so the
    fixed-horizon metrics and the hold-horizon curves can never diverge.
    Distressed premium applies to EXACT grade names only (a substring test
    matched "B" inside "BB"/"BBB"/pair names, overcharging retail).
    """
    garch_vol = fit_garch_volatility(series, label=name, freq=freq)
    vol_threshold = float(np.percentile(garch_vol.dropna(), percentile))
    shock_mask = garch_vol >= vol_threshold
    calm_mask = garch_vol < vol_threshold
    dealer_vol = get_dealer_volatility(series, freq=freq)
    distressed = name in config.DISTRESSED_GRADES  # exact, not substring
    markup = retail_markup * (config.FALLEN_ANGEL_LIQUIDITY_PREMIUM if distressed else 1.0)
    hf_markup = calculate_dynamic_pb_markup(markup, dealer_vol,
                                            trade_size_millions=trade_size_millions,
                                            freq=freq)
    friction = calculate_dynamic_execution_friction(config.FRICTION_BASE_SPREAD_BPS, dealer_vol)
    # Every component is anchored to the SERIES' own index: retail_markup is
    # typically aligned to a shared market index (longer than a single
    # country series), so without reindexing a shorter series (e.g. an ECB
    # LTIR country with a later start) misaligns every boolean indexer.
    shock_mask = shock_mask.reindex(series.index, fill_value=False)
    calm_mask = calm_mask.reindex(series.index, fill_value=False)
    markup = markup.reindex(series.index)
    hf_markup = hf_markup.reindex(series.index)
    friction = friction.reindex(series.index)
    return shock_mask, calm_mask, markup, hf_markup, friction, vol_threshold


def return_curve(series: pd.Series, percentile: float, retail_markup: pd.Series,
                 hold_max: int = 21, trade_size_millions: float | None = None,
                 freq: str = "days") -> pd.DataFrame:
    """Net return (bps) vs hold days T = 1..hold_max at one shock percentile.

    Returns are presented as a hold-horizon curve, not a single fixed-period
    metric: each row is a full shock-band straddle evaluation at horizon T
    (gross |ΔT| on shock days minus the empirical |ΔT| fee at T times the
    dealer markup, minus execution friction; fee is look-ahead-shifted).
    Rows are NaN when the series cannot be evaluated (no shock days / too
    short history); the plotter skips those honestly. Columns: Gross_bps
    (mean |T-day move| on shock days), HF_net_bps, Ret_net_bps — the three
    views match the heatmap tiers (Tier 1 gross / Tier 2 HF net / Tier 3
    retail net) so the fixed-horizon matrices and the hold-horizon curves
    tell the same story.
    """
    trade_size_millions = trade_size_millions or config.DEFAULT_TRADE_SIZE_M
    shock_mask, _, markup, hf_markup, friction, _ = _trade_cost_basis(
        series, str(getattr(series, "name", "asset")), retail_markup,
        trade_size_millions, percentile, freq=freq)
    rows = []
    for T in range(1, hold_max + 1):
        gross = (series.shift(-T) - series).abs()
        fee = get_empirical_move_fee(series, T, freq=freq)
        gs = gross[shock_mask].dropna().mean()
        pen = friction[shock_mask].dropna().mean()
        hf = gs - (fee * hf_markup)[shock_mask].dropna().mean() - pen
        rt = gs - (fee * markup)[shock_mask].dropna().mean() - pen
        rows.append({"Gross_bps": float(gs) if np.isfinite(gs) else np.nan,
                     "HF_net_bps": float(hf) if np.isfinite(hf) else np.nan,
                     "Ret_net_bps": float(rt) if np.isfinite(rt) else np.nan})
    return pd.DataFrame(rows, index=pd.RangeIndex(1, hold_max + 1, name="hold_days"))


def first_positive_hold(curve: pd.DataFrame, column: str) -> int | None:
    """First T at which the curve column is >= 0 (None when never)."""
    s = curve[column].dropna()
    pos = s[s >= 0]
    return int(pos.index[0]) if len(pos) else None


def analyze_strategy(series_dict: dict, index: pd.DatetimeIndex,
                     percentile: float, trade_size_millions: float,
                     hold_days: int, retail_markup: pd.Series | None = None) -> list[dict]:
    """Evaluate shock-vs-normal returns for each series (spread pair or asset).

    series_dict: {name: pd.Series in bps}. retail_markup: optional dynamic
    dealer-markup series (MOVE/TNX-derived).     The straddle fee is the empirical
    expected |hold_days-day move| of the TRADED series (one netted straddle
    per position — a pair pays its pair-level straddle, not the sum of both
    legs'). Net returns are also available as hold-horizon curves via
    return_curve() — the fixed-horizon cells here feed the percentile
    heatmap matrices only.
    """
    if retail_markup is None:
        retail_markup = pd.Series(1.0, index=index)
    results: list[dict] = []

    for name, series_seq in series_dict.items():
        shock_mask, calm_mask, markup, hf_markup, friction, vol_threshold = _trade_cost_basis(
            series_seq, name, retail_markup, trade_size_millions, percentile)
        does_shock = shock_mask.any()
        does_normal = calm_mask.any()
        actual_frequency = shock_mask.sum() / max(len(shock_mask), 1)

        gross_hd = (series_seq.shift(-hold_days) - series_seq).abs()
        gross_shock = float(gross_hd[shock_mask].dropna().mean()) if does_shock else 0.0
        gross_normal = float(gross_hd[calm_mask].dropna().mean()) if does_normal else 0.0

        fee_raw = get_empirical_move_fee(series_seq, hold_days)
        hf_cost = fee_raw * hf_markup
        hf_fee_shock = float(hf_cost[shock_mask].dropna().mean()) if does_shock else 0.0
        hf_fee_normal = float(hf_cost[calm_mask].dropna().mean()) if does_normal else 0.0

        ret_cost = fee_raw * markup
        ret_fee_shock = float(ret_cost[shock_mask].dropna().mean()) if does_shock else 0.0
        ret_fee_normal = float(ret_cost[calm_mask].dropna().mean()) if does_normal else 0.0

        avg_shock_penalty = float(friction[shock_mask].dropna().mean()) if does_shock else 0.0

        hf_net_shock = gross_shock - hf_fee_shock - avg_shock_penalty
        hf_net_normal = gross_normal - hf_fee_normal
        hf_mult = hf_net_shock / abs(hf_net_normal) if hf_net_normal else 0.0

        ret_net_shock = gross_shock - ret_fee_shock - avg_shock_penalty
        ret_net_normal = gross_normal - ret_fee_normal
        ret_mult = ret_net_shock / abs(ret_net_normal) if ret_net_normal else 0.0

        results.append({
            "Asset": name, "Pair": name, "Freq": actual_frequency, "VolThreshold": vol_threshold,
            "HF_Gross_Shock": gross_shock, "HF_Gross_Normal": gross_normal,
            "HF_Fee_Shock": hf_fee_shock, "HF_Fee_Normal": hf_fee_normal,
            "HF_Net_Shock": hf_net_shock, "HF_Net_Normal": hf_net_normal, "HF_Mult": hf_mult,
            "Ret_Gross_Shock": gross_shock, "Ret_Gross_Normal": gross_normal,
            "Ret_Fee_Shock": ret_fee_shock, "Ret_Fee_Normal": ret_fee_normal,
            "Ret_Net_Shock": ret_net_shock, "Ret_Net_Normal": ret_net_normal, "Ret_Mult": ret_mult,
        })
    return results
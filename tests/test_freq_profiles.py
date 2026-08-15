"""Observation-frequency profiles for the volatility machinery.

DEALER_PRICING_WINDOW and REALIZED_VOL_LOOKBACK are counts of OBSERVATIONS.
Every caller but one feeds daily series, so 90 and 21 read as "a business
quarter" and "a month". engine/eur_country.py feeds MONTHLY ECB LTIR series
through the same code, where those counts silently mean a 7.5-year fee window
measured against 21-month shocks — and the mean |T-month move| over that
window came out larger than the mean move on the shock periods it was charged
against, so every euro sovereign priced as a guaranteed loss.

These tests pin the two things that fix must not lose: the daily path stays
bit-identical, and the monthly path actually uses monthly windows.
"""
import numpy as np
import pandas as pd
import pytest

import config
from engine import volatility


def _monthly_series(n=240, seed=7):
    rng = np.random.default_rng(seed)
    idx = pd.date_range("2005-01-31", periods=n, freq="ME")
    # a mean-reverting yield in bps with a visible regime shift, so the
    # window length genuinely changes what the cost model sees
    lvl = 300.0
    out = []
    for i in range(n):
        shock = rng.normal(0, 25 if 80 <= i <= 110 else 8)
        lvl += 0.05 * (300 - lvl) + shock
        out.append(lvl)
    return pd.Series(out, index=idx, name="TEST")


def test_profiles_expose_daily_and_monthly_windows():
    d = config.freq_profile("days")
    m = config.freq_profile("months")
    assert d["dealer_window"] == config.DEALER_PRICING_WINDOW
    assert d["rv_lookback"] == config.REALIZED_VOL_LOOKBACK
    assert d["periods_per_year"] == config.TRADING_DAYS
    # monthly keeps the ~1:4 ratio the daily constants encode
    assert m["dealer_window"] == 48 and m["rv_lookback"] == 12
    assert m["periods_per_year"] == 12
    assert m["dealer_window"] < d["dealer_window"]


def test_unknown_frequency_falls_back_to_daily():
    assert config.freq_profile("weekly") == config.freq_profile("days")
    assert config.freq_profile() == config.freq_profile("days")


def test_daily_path_is_unchanged_by_the_new_parameter():
    """The default must reproduce the old constants exactly."""
    s = _monthly_series()
    a = volatility.get_dealer_volatility(s)
    b = volatility.get_dealer_volatility(s, window=config.DEALER_PRICING_WINDOW)
    pd.testing.assert_series_equal(a, b)


def test_monthly_windows_change_the_dealer_vol():
    s = _monthly_series()
    daily = volatility.get_dealer_volatility(s, freq="days")
    monthly = volatility.get_dealer_volatility(s, freq="months")
    # a 48-observation window resolves the regime shift that a 90-observation
    # one smears away, so the two series must not coincide
    assert not np.allclose(daily.to_numpy(), monthly.to_numpy(), equal_nan=True)
    # the shorter window also starts producing values sooner
    assert monthly.notna().sum() >= daily.notna().sum()


def test_monthly_fee_window_is_shorter():
    s = _monthly_series()
    fee_d = volatility.get_empirical_move_fee(s, 12, freq="days")
    fee_m = volatility.get_empirical_move_fee(s, 12, freq="months")
    assert not np.allclose(fee_d.to_numpy(), fee_m.to_numpy(), equal_nan=True)


def test_pb_markup_annualises_at_the_series_frequency():
    """PB_VOL_THRESHOLD_BPS is absolute annual bps, so sqrt(252) on a monthly
    series inflates the vol ~4.6x and wrongly wipes out the volume discount."""
    idx = pd.date_range("2020-01-31", periods=24, freq="ME")
    markup = pd.Series(1.05, index=idx)
    vol = pd.Series(30.0, index=idx)  # 30 bps per period
    daily = volatility.calculate_dynamic_pb_markup(markup, vol, freq="days")
    monthly = volatility.calculate_dynamic_pb_markup(markup, vol, freq="months")
    # annualised at sqrt(252) this is 476 bps and the illiquidity penalty
    # bites; at sqrt(12) it is 104 bps and barely does, so the monthly
    # discount is the larger one (a lower resulting markup)
    assert (monthly <= daily).all()
    assert monthly.iloc[-1] < daily.iloc[-1]


def test_return_curve_accepts_and_uses_the_frequency():
    s = _monthly_series()
    markup = pd.Series(1.05, index=s.index)
    cur_d = volatility.return_curve(s, 90.0, markup, hold_max=6, freq="days")
    cur_m = volatility.return_curve(s, 90.0, markup, hold_max=6, freq="months")
    assert list(cur_d.columns) == list(cur_m.columns)
    assert len(cur_m) == 6
    finite = cur_m["Gross_bps"].dropna()
    assert len(finite) > 0, "monthly curve produced no evaluable horizon"
    # the windows differ, so the two curves must not be identical
    assert not np.allclose(
        cur_d["Ret_net_bps"].to_numpy(), cur_m["Ret_net_bps"].to_numpy(), equal_nan=True
    )


def test_monthly_fee_no_longer_swamps_the_shock_move():
    """The symptom the profile fixes: on monthly data the day-calibrated fee
    window averaged over 7.5 years and exceeded the shock-period move, so
    every net came out negative regardless of the underlying."""
    s = _monthly_series()
    markup = pd.Series(1.0, index=s.index)  # strip the markup to isolate the fee
    cur = volatility.return_curve(s, 90.0, markup, hold_max=6, freq="months")
    gross = cur["Gross_bps"].dropna()
    net = cur["Ret_net_bps"].dropna()
    assert len(gross) and len(net)
    # with the right window the fee is a fraction of the move it prices, not
    # a multiple of it
    assert (net > -gross).all(), "fee still exceeds twice the gross move"


if __name__ == "__main__":
    pytest.main([__file__, "-q"])

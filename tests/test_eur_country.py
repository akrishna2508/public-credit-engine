"""Tests for engine.eur_country: country-panel math + monthly-cadence machinery.

Pure logic, no network: the LTIR fetch is live-gated (per-key UNAVAILABLE),
so these tests cover the panel math (_changes_bps, name coverage) and the
critical consistency property — the shared straddle machinery must produce
the same three-view curves on MONTHLY observations (the country cadence) as
on daily ones.
"""
import numpy as np
import pandas as pd
import pytest

import config
from engine import eur_country, volatility


def test_country_names_cover_configured_keys():
    """Every configured LTIR country key has a display name (table fidelity)."""
    assert set(eur_country.COUNTRY_NAMES) == set(config.ECB_LTIR_COUNTRY_KEYS)


def test_changes_bps():
    """1M/3M/12M changes = (last - last-k) * 100 bps on the monthly series."""
    idx = pd.date_range("2020-01-01", periods=14, freq="MS")
    s = pd.Series(np.arange(14, dtype=float) / 100.0, index=idx)  # 0.00..0.13
    chg = eur_country._changes_bps(s)
    assert chg["1M"] == pytest.approx(1.0)  # (0.13-0.12)*100
    assert chg["3M"] == pytest.approx(3.0)
    assert chg["12M"] == pytest.approx(12.0)


def test_changes_bps_short_history():
    """A series shorter than the window reports None (never an invented value)."""
    idx = pd.date_range("2020-01-01", periods=5, freq="MS")
    s = pd.Series(np.arange(5, dtype=float), index=idx)
    chg = eur_country._changes_bps(s)
    assert chg["1M"] is not None
    assert chg["3M"] is not None
    assert chg["12M"] is None


def test_monthly_machinery_three_views():
    """The shared straddle machinery is frequency-agnostic: monthly country
    series (ECB LTIR cadence) must produce the same three-view curve
    structure and monotonic views as the daily grade panel."""
    idx = pd.date_range("2005-01-01", periods=200, freq="MS")
    rng = np.random.RandomState(21)
    n = len(idx)
    sigma = np.full(n, 0.3)
    for start in range(0, n, 24):  # 2-month vol spikes every 2y
        sigma[start:start + 2] = 2.0
    s = pd.Series(300 + np.cumsum(rng.normal(0, 1, n) * sigma), index=idx)
    rm = pd.Series(1.05, index=idx)
    df = volatility.return_curve(s, percentile=90, retail_markup=rm,
                                 hold_max=6, trade_size_millions=50.0)
    assert list(df.index) == list(range(1, 7))
    assert {"Gross_bps", "HF_net_bps", "Ret_net_bps"} <= set(df.columns)
    ok = df.dropna(subset=["Gross_bps", "HF_net_bps", "Ret_net_bps"])
    assert len(ok) >= 3
    assert (ok["Gross_bps"] >= ok["HF_net_bps"]).all()
    assert (ok["HF_net_bps"] >= ok["Ret_net_bps"]).all()
    # gross payout grows with the horizon; nets may be honestly negative at
    # monthly cadence (the long rolling fee dominates small monthly moves)
    assert df["Gross_bps"].iloc[-1] > df["Gross_bps"].iloc[0]
    fp = volatility.first_positive_hold(df, "HF_net_bps")
    assert fp is None or 1 <= fp <= 6

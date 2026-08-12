"""Tests for engine.dealer_markup and engine.volatility common math - no network."""
import numpy as np
import pandas as pd
import pytest

import config
from engine import dealer_markup, volatility


def test_calculate_realized_volatility_smoke():
    s = pd.Series(np.arange(100.0) / 100.0)  # constant drift -> zero vol
    rv = dealer_markup.calculate_realized_volatility(s, lookback_window=10)
    assert np.isfinite(rv.iloc[-1])
    assert rv.iloc[-1] < 1e-6  # constant drift must produce ~zero realized vol

    noisy = pd.Series(np.cumsum(np.random.RandomState(3).normal(0, 1, 100)))
    rv_noisy = dealer_markup.calculate_realized_volatility(noisy, lookback_window=10)
    assert rv_noisy.iloc[-1] > 1e-3  # a random walk must produce non-trivial vol


def test_dealer_markup_floor_applied():
    idx = pd.date_range("2020-01-01", periods=20, freq="B")
    macro = pd.DataFrame({"^MOVE": np.full(20, 50.0), "^TNX": np.linspace(4.0, 4.5, 20)}, index=idx)
    markup = dealer_markup.calculate_dealer_markup(macro, lookback=5)
    assert (markup >= 1.05).all()


def test_dealer_markup_share_lightens_premium():
    """Dealer comp = DEALER_MARKUP_PREMIUM_SHARE of the IV-RV premium, so the
    shared markup must stay strictly below the full IV/RV ratio (which handed
    the whole short-vol carry to the dealer)."""
    idx = pd.date_range("2020-01-01", periods=40, freq="B")
    tnx = 4.0 + np.cumsum(np.random.RandomState(7).normal(0, 0.02, 40))
    macro = pd.DataFrame({"^MOVE": np.full(40, 60.0), "^TNX": tnx}, index=idx)
    markup = dealer_markup.calculate_dealer_markup(macro, lookback=10)
    rv = dealer_markup.calculate_realized_volatility(macro["^TNX"], lookback_window=10)
    full_ratio = (60.0 / rv).dropna()
    assert (markup >= 1.05).all()
    assert float(markup.max()) < float(full_ratio.max())
    assert float(markup.max()) <= 1.0 + config.DEALER_MARKUP_PREMIUM_SHARE * (float(full_ratio.max()) - 1.0) + 1e-9


def test_ou_straddle_kappa_zero_equals_bachelier():
    idx = pd.bdate_range("2020-01-01", periods=5)
    vol = pd.Series(0.01, index=idx)  # bps daily
    r = pd.Series(0.04, index=idx)
    m = pd.Series(1.0, index=idx)
    T = config.DEFAULT_HOLD_DAYS
    out = volatility.calc_ou_straddle(vol, r, m, T_days=T, kappa=0.0)
    expected = np.exp(-0.04 * T / 252) * (0.01 * np.sqrt(252)) * np.sqrt(T / 252) * np.sqrt(2 / np.pi)
    assert np.allclose(out.values, expected, rtol=1e-9)


def test_analyze_strategy_smoke(monkeypatch):
    """End-to-end strategy run over synthetic-but-realistic series (no network)."""
    idx = pd.bdate_range("2021-01-01", periods=260)
    rng = np.random.RandomState(11)
    levels = 100 + np.cumsum(rng.normal(0, 0.5, len(idx)))
    s1 = pd.Series(levels, index=idx)
    s2 = pd.Series(levels + 50, index=idx)
    monkeypatch.setattr(volatility, "get_treasury_rates",
                        lambda i: pd.Series(0.045, index=i))
    results = volatility.analyze_strategy(
        series_dict={"A - B": s1 - s2}, index=idx,
        percentile=90, trade_size_millions=50.0, hold_days=5)
    assert len(results) == 1
    row = results[0]
    assert 0.0 <= row["Freq"] <= 1.0
    for k in ("HF_Net_Shock", "HF_Net_Normal", "Ret_Net_Shock", "Ret_Net_Normal"):
        assert isinstance(row[k], float) or row[k] is None


def test_empirical_move_fee_no_lookahead():
    """The fee at t must only use |delta_T| values knowable at t (shifted)."""
    idx = pd.bdate_range("2021-01-01", periods=200)
    s = pd.Series(np.cumsum(np.random.RandomState(5).normal(0, 1, len(idx))), index=idx)
    fee = volatility.get_empirical_move_fee(s, hold_days=5, window=20)
    moves = (s.shift(-5) - s).abs()
    expected = moves.shift(5).rolling(20, min_periods=10).mean().dropna()
    assert np.allclose(fee.reindex(expected.index), expected, rtol=1e-9)
    # a spike in |d5| at the very end must NOT leak into earlier fee values
    s2 = s.copy()
    s2.iloc[-5:] += 500.0
    fee2 = volatility.get_empirical_move_fee(s2, hold_days=5, window=20)
    assert np.allclose(fee2.iloc[:-20].dropna(), fee.iloc[:-20].dropna(), rtol=1e-9)


def test_empirical_move_fee_captures_whipsaw():
    """Whipsaw series (negatively autocorrelated daily moves, like the
    fallen-angel TTM yield, AR(1) ~ -0.3) must fee below a raw-vol Bachelier
    straddle — the 2026-08-11 Fallen_Angel regression."""
    idx = pd.bdate_range("2021-01-01", periods=400)
    rng = np.random.RandomState(3)
    eps = rng.normal(0, 8, len(idx))
    steps = [eps[0]]
    for e in eps[1:]:
        steps.append(-0.7 * steps[-1] + e)  # strong daily reversal
    whipsaw = pd.Series(1000 + np.cumsum(steps), index=idx)
    fee = volatility.get_empirical_move_fee(whipsaw, hold_days=5, window=60)
    analytic = volatility.calc_ou_straddle(
        volatility.get_dealer_volatility(whipsaw, window=60),
        pd.Series(0.045, index=idx),
        pd.Series(1.0, index=idx), T_days=5)
    assert float(fee.iloc[-1]) < 0.6 * float(analytic.iloc[-1])


def test_analyze_strategy_pair_netting(monkeypatch):
    """A pair pays ONE netted straddle on the pair series — the retail fee
    must equal the empirical fee of the pair (not the sum of both legs)."""
    idx = pd.bdate_range("2021-01-01", periods=300)
    rng = np.random.RandomState(7)
    a = pd.Series(100 + np.cumsum(rng.normal(0, 0.6, len(idx))), index=idx)
    b = pd.Series(150 + np.cumsum(rng.normal(0, 0.6, len(idx))), index=idx)
    pair = a - b
    monkeypatch.setattr(volatility, "get_treasury_rates",
                        lambda i: pd.Series(0.045, index=i))
    res = volatility.analyze_strategy(
        series_dict={"LONG - SHORT": pair}, index=idx,
        percentile=80, trade_size_millions=50.0, hold_days=5)
    row = res[0]
    garch = volatility.fit_garch_volatility(pair)
    th = float(np.percentile(garch.dropna(), 80))
    shock = garch >= th
    expected_ret_fee = float((volatility.get_empirical_move_fee(pair, 5)
                              * pd.Series(1.0, index=idx))[shock].mean())
    assert row["Ret_Fee_Shock"] == pytest.approx(expected_ret_fee, rel=0.05)
    # netted pair straddle must be smaller than the sum of the two legs'
    # standalone empirical fees
    sum_fee = float((volatility.get_empirical_move_fee(a, 5)
                     + volatility.get_empirical_move_fee(b, 5)).mean())
    assert row["Ret_Fee_Shock"] < sum_fee


def test_fallen_angel_premium_exact_grade_only():
    """Regression: the distressed premium is applied to EXACT grade names
    only — the old substring test matched "B" inside "BB"/"BBB"/pair names,
    overcharging retail on every name containing the letter B."""
    idx = pd.bdate_range("2021-01-01", periods=300)
    rng = np.random.RandomState(9)
    base = 100 + np.cumsum(rng.normal(0, 0.7, len(idx)))
    rm = pd.Series(1.1, index=idx)  # constant dealer markup for the test
    series = {
        "BB": pd.Series(base, index=idx),
        "BBB": pd.Series(base + 10, index=idx),
        "Fallen_Angel": pd.Series(base + 40, index=idx),
        "BB - Fallen_Angel": pd.Series(base - 30, index=idx),
    }
    for name, s in series.items():
        shock, _, markup, _, _, _ = volatility._trade_cost_basis(
            s, name, rm, trade_size_millions=50.0, percentile=80)
        avg_markup = float((markup * rm.notna()).mean())
        if name in ("Fallen_Angel",):
            assert avg_markup == pytest.approx(1.1 * config.FALLEN_ANGEL_LIQUIDITY_PREMIUM, rel=1e-6)
        else:
            assert avg_markup == pytest.approx(1.1, rel=1e-6), \
                f"{name} must NOT pay the distressed premium"


def test_return_curve_shape_and_first_positive():
    """Return curves are the hold-horizon view: one row per T=1..hold_max,
    finite where evaluable; first_positive_hold finds the crossover T."""
    idx = pd.bdate_range("2021-01-01", periods=900)
    rng = np.random.RandomState(13)
    n = len(idx)
    # short sharp vol spikes (10d every 90d, like real OAS vol jumps): the
    # 90d rolling fee lags the spike while shock-day selection lands inside
    # it, so gross clears fee + costs and the edge widens with the horizon
    sigma = np.full(n, 0.3)
    for start in range(0, n, 90):
        sigma[start:start + 10] = 2.3
    s = pd.Series(500 + np.cumsum(rng.normal(0, 1, n) * sigma), index=idx)
    rm = pd.Series(1.0, index=idx)
    df = volatility.return_curve(s, percentile=90, retail_markup=rm, hold_max=15)
    assert list(df.index) == list(range(1, 16))
    assert {"Gross_bps", "HF_net_bps", "Ret_net_bps"} <= set(df.columns)
    assert df["HF_net_bps"].notna().sum() >= 10
    # three-view consistency: gross >= HF net >= retail net pointwise (nets
    # are gross minus fee*markup, and the HF markup is the discounted one)
    ok = df.dropna(subset=["HF_net_bps", "Ret_net_bps"])
    assert (ok["Gross_bps"] >= ok["HF_net_bps"]).all()
    assert (ok["HF_net_bps"] >= ok["Ret_net_bps"]).all()
    first_hf = volatility.first_positive_hold(df, "HF_net_bps")
    assert first_hf is not None and 1 <= first_hf <= 15
    # conditional shock-day move grows with T (the edge widens with horizon)
    garch = volatility.fit_garch_volatility(s)
    thr = float(np.percentile(garch.dropna(), 90))
    shock = garch >= thr
    gross = [float((s.shift(-t) - s).abs()[shock].dropna().mean()) for t in (2, 8, 14)]
    assert gross[2] > gross[0]
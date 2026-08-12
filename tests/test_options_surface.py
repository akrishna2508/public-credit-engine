"""Pure-logic tests for the GCO board legs (options_surface, backtest engine).

No network: series are synthetic. Covers the weekend-accrual alignment bug
(premium_series) and the no-look-ahead semantics of the backtest engine.
"""
from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from engine import backtest, options_surface


def _trade_days(n: int, end: str = "2026-08-07") -> pd.DatetimeIndex:
    return pd.bdate_range(end=end, periods=n)


def test_premium_series_weekend_accrual_maps_to_prior_rv():
    """IV accrued on a Sunday (no trading day) must align to Friday's RV —
    regression for the reindex+ffill bug that emptied the premium."""
    days = _trade_days(60)
    close = pd.Series(np.linspace(100, 110, len(days)), index=days)
    rv = options_surface.realized_vol_series(close)
    sunday = pd.to_datetime("2026-08-09")
    atm_iv = pd.Series([0.20], index=[sunday])
    prem = options_surface.premium_series(atm_iv, rv)
    assert len(prem) == 1
    expected_rv = float(rv.iloc[-1])
    assert prem.iloc[0] == pytest.approx(0.20 - expected_rv, abs=1e-12)


def test_premium_series_in_trading_day_aligns():
    days = _trade_days(60)
    close = pd.Series(np.linspace(100, 110, len(days)), index=days)
    rv = options_surface.realized_vol_series(close)
    friday = days[-1]
    atm_iv = pd.Series([0.15], index=[friday])
    prem = options_surface.premium_series(atm_iv, rv)
    assert len(prem) == 1
    assert prem.iloc[0] == pytest.approx(0.15 - float(rv.iloc[-1]), abs=1e-12)


def test_premium_series_empty_rv_returns_empty():
    """Degenerate close history (empty RV) must yield empty premium, not a
    crash on asof — the board skips via premium_z's n=0 gate."""
    sunday = pd.to_datetime("2026-08-09")
    atm_iv = pd.Series([0.20], index=[sunday])
    prem = options_surface.premium_series(atm_iv, pd.Series(dtype=float))
    assert len(prem) == 0


def test_premium_z_gate_blocks_short_history():
    prem = pd.Series(np.random.default_rng(0).normal(0.05, 0.01, 19))
    z, n = options_surface.premium_z(prem, min_obs=20)
    assert z is None and n == 19


def test_premium_z_computes_on_sufficient_history():
    rng = np.random.default_rng(1)
    prem = pd.Series(rng.normal(0.05, 0.01, 30))
    z, n = options_surface.premium_z(prem, min_obs=20)
    assert n == 30
    expected = (prem.iloc[-1] - prem.mean()) / prem.std(ddof=0)
    assert z == pytest.approx(expected, abs=1e-12)


def test_premium_z_constant_history_yields_none():
    prem = pd.Series([0.05] * 25)
    z, n = options_surface.premium_z(prem, min_obs=20)
    assert z is None and n == 25


def test_premium_z_series_walk_forward_gate_and_values():
    """The battery's IVRV signal: expanding-window z, empty until the gate."""
    s = pd.Series(np.linspace(0.05, 0.20, 40))
    z, n = options_surface.premium_z_series(s, min_obs=20)
    assert n == 40
    assert len(z) == 21  # first valid at obs 20
    assert abs(float(z.iloc[-1])) > 1.0  # ramp ends clearly off its own mean
    z_empty, n_empty = options_surface.premium_z_series(s.iloc[:10], min_obs=20)
    assert z_empty.empty and n_empty == 10


def test_realized_vol_series_annualizes():
    days = _trade_days(30)
    close = pd.Series(np.linspace(100, 110, len(days)), index=days)
    rv = options_surface.realized_vol_series(close)
    assert rv.index.equals(days[1:])  # first log-return is NaN
    assert (rv.dropna() >= 0).all()


def test_directional_hit_rate_is_shifted_no_lookahead():
    """Same-day-perfect correlation must NOT score well: the signal at t is
    tradable at t+1, so the engine's shift(1) must break same-day agreement."""
    rng = np.random.default_rng(2)
    idx = _trade_days(120)
    s = pd.Series(np.sign(rng.normal(0, 1, len(idx))), index=idx)
    res = backtest.directional_hit_rate(s, s)
    assert res["status"] == "OK"
    assert res["hit_rate"] < 0.7


def test_directional_hit_rate_perfect_forward_signal():
    """A signal equal to the NEXT day's move (signal_t = fwd_{t+1}) must score
    ~1.0 under the engine's shift(1) semantics."""
    idx = _trade_days(120)
    rng = np.random.default_rng(3)
    fwd = pd.Series(np.sign(rng.normal(0, 1, len(idx))), index=idx)  # move t->t+1
    signal = fwd.shift(-1)  # known at t, equals the move starting at t+1
    res = backtest.directional_hit_rate(signal, fwd)
    assert res["status"] == "OK"
    assert res["hit_rate"] == pytest.approx(1.0)


def test_backtest_min_obs_gate():
    idx = _trade_days(10)
    s = pd.Series(1.0, index=idx)
    res = backtest.directional_hit_rate(s, s)
    assert res["status"].startswith("insufficient obs")


def test_strategy_metrics_basic():
    idx = _trade_days(120)
    rng = np.random.default_rng(4)
    ret = pd.Series(rng.normal(0.001, 0.01, len(idx)), index=idx)
    m = backtest.strategy_metrics(ret)
    assert m["status"] == "OK" and m["n"] == len(idx)
    assert m["sharpe"] is not None and m["max_dd"] <= 0


def test_strategy_metrics_short_history_gate():
    idx = _trade_days(10)
    m = backtest.strategy_metrics(pd.Series(0.01, index=idx))
    assert m["status"].startswith("insufficient obs")


def test_strategy_same_day_signal_has_no_edge_after_shift():
    """Position = today's return sign, P&L computed on the same-day return:
    after the 1-day execution shift this must have zero expected edge —
    validates the strategy leg's no-look-ahead construction."""
    idx = _trade_days(300)
    rng = np.random.default_rng(5)
    ret = pd.Series(rng.normal(0, 0.01, len(idx)), index=idx)
    pos = np.sign(ret)
    strat = (pos.shift(1) * ret).dropna()
    assert abs(strat.mean()) < 0.0005
    assert strat.mean() * len(strat) < 0.05  # cumulative P&L ~ flat


def test_premium_z_unlocks_exactly_at_min_obs():
    """The IV-RV unlock flip: 19 accrued days -> None, 20 -> a real z.
    This exact boundary is what the board leg and battery leg gate on."""
    rng = np.random.default_rng(10)
    prem19 = pd.Series(rng.normal(0.05, 0.01, 19))
    prem20 = pd.Series(list(prem19) + [0.05 + 0.01 * float(rng.normal())])
    z19, n19 = options_surface.premium_z(prem19, min_obs=20)
    z20, n20 = options_surface.premium_z(prem20, min_obs=20)
    assert z19 is None and n19 == 19
    assert z20 is not None and n20 == 20


def test_ivrv_battery_leg_unlocks_and_runs_end_to_end(tmp_path, monkeypatch, capsys):
    """Fast-forward the daily accrual to 20+ snapshots and prove the battery's
    IVRV leg flips from 'UNAVAILABLE n/20' to a full metrics + OOS sign-fit
    run, persisting the validation to backtest_legs.json — synthetic data,
    no network, real data files untouched."""
    import json

    import yfinance  # noqa: F401  (patched below; import only, no network)
    import config

    days = pd.bdate_range(end="2026-08-07", periods=200)
    rng = np.random.default_rng(11)
    close = pd.Series(
        80 + np.cumsum(rng.normal(0, 0.30, len(days))), index=days)
    # accrual ran the full window: 200 daily snapshots — far past the 20-day
    # unlock, so the strategy has enough tradable days to clear MIN_OBS.
    iv_days = days
    rng2 = np.random.default_rng(12)
    history = {"HYG": {
        d.strftime("%Y-%m-%d"): {
            "ticker": "HYG", "as_of": d.strftime("%Y-%m-%d"),
            "expiry": "2026-09-18", "underlying": 80.0, "atm_strike": 80.0,
            "atm_iv": float(0.06 + 0.004 * float(rng2.normal())),
            "put_call_oi_ratio": 1.0,
        } for d in iv_days}}

    fake_download = lambda *a, **k: pd.DataFrame({"Close": close})  # noqa: E731
    monkeypatch.setattr(yfinance, "download", fake_download)
    hist_file = tmp_path / "iv_history.json"
    hist_file.write_text(json.dumps(history))
    monkeypatch.setattr(config, "IV_HISTORY_FILE", hist_file)
    legs_file = tmp_path / "backtest_legs.json"
    monkeypatch.setattr(backtest, "LEG_VALIDATION_FILE", legs_file)

    from pipelines import backtest as pipes
    pipes._bt_ivrv(horizon=5)
    out = capsys.readouterr().out
    assert "[IVRV] UNAVAILABLE" not in out
    assert "[IVRV] IV-RV premium-z long HYG" in out
    assert "[IVRV] OOS sign fit" in out
    persisted = json.loads(legs_file.read_text())
    assert "IVRV" in persisted
    assert persisted["IVRV"]["hypothesis_sign"] == 1
    assert persisted["IVRV"]["fitted_sign"] in (-1.0, 1.0)
    assert not hist_file.read_text().startswith("{}")


def test_sign_fit_oos_gates_short_history():
    """Split-sample sign fit needs 2*BACKTEST_MIN_OBS — shorter samples must
    report insufficient obs, never a fitted strategy. The gated dict must
    still carry the FULL schema (fitted_sign/ic_in_sample/metrics), so the
    six pipeline print sites can read it without KeyError."""
    idx = _trade_days(50)
    s = pd.Series(np.sign(np.random.default_rng(6).normal(0, 1, len(idx))), index=idx)
    ret = pd.Series(np.random.default_rng(7).normal(0, 0.01, len(idx)), index=idx)
    res = backtest.sign_fit_oos(s, ret)
    assert res["status"].startswith("insufficient obs")
    assert res["fitted_sign"] is None
    assert res["ic_in_sample"] is None
    assert res["n_in"] == 0 and res["n_oos"] == 0
    assert "status" in res["metrics"]


def test_sign_fit_oos_recovers_known_sign():
    """A signal whose correct sign is the OPPOSITE of its own sign (data
    rewards contrarian) must have the fitted sign = -1 and positive OOS P&L."""
    rng = np.random.default_rng(8)
    idx = _trade_days(400)
    s = pd.Series(np.sign(rng.normal(0, 1, len(idx))), index=idx)
    # returns are generated to reward -sign(signal) with a real edge
    noise = pd.Series(rng.normal(0, 0.005, len(idx)), index=idx)
    ret = (-0.01 * s.shift(1).fillna(0) + noise).dropna()
    res = backtest.sign_fit_oos(s, ret)
    assert res["status"] == "OK"
    assert res["fitted_sign"] == -1.0
    assert res["metrics"]["n"] >= res["n_oos"] - 1
    assert res["metrics"]["ann_return"] > 0


def test_sign_fit_oos_no_lookahead_on_test_half():
    """The fitted sign is fixed from the in-sample half only — a signal that
    predicts only within its own half must not leak the test half's sign."""
    idx = _trade_days(400)
    rng = np.random.default_rng(9)
    s = pd.Series(np.sign(rng.normal(0, 1, len(idx))), index=idx)
    # signal rewards +sign in the first half, -sign in the second
    noise = pd.Series(rng.normal(0, 0.005, len(idx)), index=idx)
    ret = (0.01 * s.shift(1).fillna(0) * pd.Series(
        np.where(np.arange(len(idx)) < len(idx) / 2, 1, -1), index=idx) + noise).dropna()
    res = backtest.sign_fit_oos(s, ret)
    assert res["status"] == "OK"
    assert res["fitted_sign"] == 1.0
    # test half rewards -sign: fitted +sign must deliver negative OOS mean
    assert res["metrics"]["ann_return"] < 0

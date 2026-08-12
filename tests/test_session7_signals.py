"""Session 7 engine signals: global_rates, sector_screen, credit_appetite,
em_carry, real_rates, options skew z. Pure logic, no network."""
import numpy as np
import pandas as pd
import pytest

import config


def _mk_series(values, freq="ME", start="2022-01-31"):
    idx = pd.date_range(start, periods=len(values), freq=freq)
    return pd.Series(values, index=idx)


class TestGlobalRates:
    def test_region_of(self):
        from engine import global_rates
        assert global_rates.region_of("JP") == "DM_EX_US"
        assert global_rates.region_of("KR") == "EM_ASIA"
        assert global_rates.region_of("XX") is None

    def test_country_metrics_short_history(self):
        from engine import global_rates
        s = _mk_series([3.0, 3.1, 3.2, 3.3, 3.4], start="2026-01-31")
        assert global_rates.country_metrics("JP", s, None) is None

    def test_country_metrics_normal(self):
        from engine import global_rates
        s = _mk_series([3.0] * 20 + [4.0] * 10)  # big jump at the end
        m = global_rates.country_metrics("JP", s, None)
        assert m is not None and m["level_z"] is not None
        assert m["level_z"] > 1.0  # yields rich vs own history

    def test_carry_vs_us(self):
        from engine import global_rates
        jp = _mk_series([1.0] * 20 + [2.0] * 10)
        us = _mk_series([4.0] * 30)
        m = global_rates.country_metrics("JP", jp, us)
        assert m["carry_vs_us_z"] is not None

    def test_screen_stale_series_excluded_from_regions(self):
        from engine import global_rates
        # Russia-like stale series: ends 2018 -> drops out of the merge
        stale = _mk_series([7.0] * 24, start="2016-01-31")
        live = _mk_series([2.0] * 30)
        screen = global_rates.global_rates_screen({"RU": stale, "US": live})
        assert screen["status"] == "OK"
        assert "RU" not in screen["countries"]
        assert screen["matrix"]["US"].index.max() == live.index.max()


class TestSectorScreen:
    def test_oas_z_short_history(self):
        from engine import sector_screen
        assert sector_screen.oas_z(_mk_series([1.0] * 10, freq="D")) is None

    def test_oas_z_high_spread(self):
        from engine import sector_screen
        s = _mk_series([300.0] * 200 + [600.0] * 100, freq="D")
        z = sector_screen.oas_z(s)
        assert z is not None and z > 1.0

    def test_leverage_signals_skip_unavailable(self):
        from engine import sector_screen
        rows = sector_screen.leverage_signals({
            "Energy": {"status": "OK", "as_of": "2025-12-31", "leverage": 0.25,
                       "leverage_z": -0.8, "chg_3y": -0.03, "filers": 4, "n_obs": 17},
            "Auto": {"status": "UNAVAILABLE", "detail": "fewer filers"},
        })
        assert len(rows) == 1 and rows[0]["sector"] == "Energy"


class TestCreditAppetite:
    def test_component_gates(self):
        from engine import credit_appetite
        assert credit_appetite.hy_oas_component(None) is None
        assert credit_appetite.hy_oas_component(pd.Series(dtype=float)) is None
        assert credit_appetite.ivrv_component(None) is None
        assert credit_appetite.ivrv_component(1.5) == -1.5  # sign flip

    def test_appetite_min_components(self):
        from engine import credit_appetite
        z, used, n = credit_appetite.appetite_z({"a": 1.0, "b": None}, min_components=2)
        assert z is None and n == 1
        z, used, n = credit_appetite.appetite_z({"a": 1.0, "b": -1.0}, min_components=2)
        assert z == 0.0 and n == 2

    def test_hy_oas_sign(self):
        from engine import credit_appetite
        oas = pd.Series([300.0] * 200 + [500.0] * 100)  # widening -> risk-off
        comp = credit_appetite.hy_oas_component(oas)
        assert comp is not None and comp < 0

    def test_default_rate_sign(self):
        from engine import credit_appetite
        idx = pd.date_range("2019-01-31", periods=90, freq="ME")
        dr = pd.Series(3.0, index=idx)  # stable
        dr.iloc[-12:] = np.linspace(3.0, 1.0, 12)  # sharp recent fall
        comp = credit_appetite.default_rate_component(dr)
        assert comp is not None and comp > 0

    def test_default_rate_quarterly_cadence(self):
        """DRCCLACBS publishes on quarter starts; the component must compute
        on that cadence (regression: asfreq('ME') wiped every value)."""
        from engine import credit_appetite
        idx = pd.date_range("2006-01-01", periods=80, freq="QS")  # 20y quarterly
        dr = pd.Series(2.5, index=idx)
        dr.iloc[-4:] = np.linspace(2.5, 1.2, 4)  # recent fall
        comp = credit_appetite.default_rate_component(dr, max_age_days=10_000)
        assert comp is not None and comp > 0

    def test_default_rate_stale_goes_dark(self):
        """A default-rate series whose last observation is 7 months old must
        NOT vote (measured: DRCCLACBS last point 2026-01-01)."""
        from engine import credit_appetite
        idx = pd.date_range("2018-01-31", periods=84, freq="ME")
        dr = pd.Series(3.0, index=idx)  # ends long before "today"
        assert credit_appetite.default_rate_component(dr) is None


class TestEMCarry:
    def test_distribution_yield_empty(self):
        from engine import em_carry
        assert em_carry.distribution_yield(pd.Series(dtype=float), pd.Series(dtype=float)).empty

    def test_distribution_yield_12m(self):
        from engine import em_carry
        idx = pd.date_range("2024-01-31", periods=18, freq="ME")
        close = pd.Series(10.0, index=idx)
        divs = pd.Series(0.5, index=idx)  # 0.5/mo -> 6.0/yr -> 60% of price
        y = em_carry.distribution_yield(close, divs)
        assert float(y.iloc[-1]) == pytest.approx(60.0, rel=0.05)

    def test_distribution_yield_mixed_timezones(self):
        from engine import em_carry
        idx = pd.date_range("2024-01-31", periods=18, freq="ME")
        aware = pd.date_range("2024-01-31", periods=18, freq="ME",
                              tz="America/New_York")
        close = pd.Series(10.0, index=idx)  # naive closes (yf.download default)
        divs = pd.Series(0.5, index=aware)  # aware dividends (yfinance .dividends)
        y = em_carry.distribution_yield(close, divs)
        assert float(y.iloc[-1]) == pytest.approx(60.0, rel=0.05)

    def test_carry_screen_z(self):
        from engine import em_carry
        idx = pd.date_range("2023-01-31", periods=36, freq="ME")
        local = pd.Series(8.0, index=idx)
        hard = pd.Series(7.0, index=idx)
        # local premium widens in the last 6 months
        hard = hard.mask(np.arange(36) >= 30, 5.0)
        closes = {f: pd.Series(100.0, index=idx) for f in config.EM_LOCAL_FUNDS + config.EM_HARD_FUNDS}
        divs = {f: local for f in config.EM_LOCAL_FUNDS}
        divs.update({f: hard for f in config.EM_HARD_FUNDS})
        carry = em_carry.carry_screen(closes, divs)
        assert carry["status"] == "OK"
        assert carry["carry_diff_z"] is not None
        assert carry["carry_diff_z"] > 0  # local carry rich

    def test_carry_screen_missing_data(self):
        from engine import em_carry
        carry = em_carry.carry_screen({}, {})
        assert carry["status"] != "OK"


class TestRealRates:
    def test_signals_gate(self):
        from engine import real_rates
        sig = real_rates.real_rates_signals({})
        assert sig["status"] == "OK" and sig["components"]["DFII10"] is None

    def test_signals_high_real_yield(self):
        from engine import real_rates
        idx = pd.date_range("2023-01-02", periods=300, freq="D")
        d10 = pd.Series(np.linspace(1.5, 2.8, 300), index=idx)  # rising real yield
        be = pd.Series(np.full(300, 2.3), index=idx)
        sig = real_rates.real_rates_signals({"DFII10": d10, "T10YIE": be, "DFII5": d10 / 2})
        assert sig["components"]["DFII10"]["z"] > 1.0
        assert "real_slope_5s10s_bp" in sig


class TestOptionsSkew:
    def test_skew_series_only_polygon(self):
        from engine import options_surface
        hist = {"HYG": {
            "2026-08-06": {"ticker": "HYG", "atm_iv": 0.05},
            "2026-08-07": {"ticker": "HYG", "atm_iv": 0.06, "skew_25d": 0.02},
            "2026-08-08": {"ticker": "HYG", "atm_iv": 0.06, "skew_25d": 0.04},
        }}
        s = options_surface.skew_series(hist, "HYG")
        assert list(s.values) == [0.02, 0.04]

    def test_skew_z_gate(self):
        from engine import options_surface
        import numpy as np
        rng = np.random.default_rng(7)
        s = pd.Series(rng.normal(0.03, 0.01, 30))
        z, n = options_surface.skew_z(s, min_obs=20)
        assert n == 30 and z is not None
        z, n = options_surface.skew_z(s.iloc[:10], min_obs=20)
        assert z is None and n == 10

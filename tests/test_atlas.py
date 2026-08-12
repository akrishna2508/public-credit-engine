"""Unit tests: country atlas pure logic + yield/carry table display units.

The display test guards the EUR "300%+" bug: generate_yield_tables received
bps-valued columns but printed them as percent. After the fix, 350 bps shows
as 3.500% and a 5-day carry as 4.79 bps (not 479).

Heatmap-spec legs (multi_asset_heatmap_spec.md §3/§4) add: straddle yield,
futures basis, real yield, term spread, GeoJSON builder, DB row builder, and
the CME third-Friday calendar rule.
"""
import json
import os

import numpy as np
import pandas as pd
import pytest

from engine import atlas, futures_layer
from engine.volatility_matrix import _format_yield_rows


def _monthly(values, start="2020-01-31"):
    return pd.Series(values, index=pd.date_range(start, periods=len(values), freq="ME"))


class TestYieldChanges:
    def test_falling_yields_give_negative_bps(self):
        s = _monthly(np.linspace(5.0, 3.0, 60))
        ch = atlas.yield_changes_bps(s, horizons=(1, 3))
        assert ch[1] < 0 and ch[3] < 0

    def test_rising_tail_gives_positive_bps(self):
        s = _monthly([2.0] * 59 + [2.5])  # only the last month rises
        ch = atlas.yield_changes_bps(s, horizons=(1,))
        assert abs(ch[1] - 50.0) < 1e-6

    def test_no_look_ahead_uses_only_past_observations(self):
        s = _monthly(np.linspace(1.0, 6.0, 40))  # rising -> positive changes
        ch = atlas.yield_changes_bps(s, horizons=(3, 12))
        for h, v in ch.items():
            assert v > 0  # strictly based on history at/before cutoff


class TestPriceReturnProxy:
    def test_sign_flip_and_duration_scaling(self):
        assert atlas.price_return_proxy(10.0, 8.5) == pytest.approx(-0.85)
        assert atlas.price_return_proxy(-10.0, 8.5) == pytest.approx(0.85)

    def test_none_in_none_out(self):
        assert atlas.price_return_proxy(None) is None


class TestRollingZ:
    def test_recent_outlier_gives_positive_z(self):
        s = _monthly([3.0] * 60)
        s.iloc[-1] = 6.0
        z = atlas.rolling_z_last(s)
        assert z is not None and z > 2

    def test_short_history_is_none(self):
        s = _monthly([3.0] * 10)
        assert atlas.rolling_z_last(s) is None


class TestSovereignSpreadProxy:
    def test_proxy_label_and_math(self):
        proxy = atlas.sovereign_spread_proxy(8.7, 4.47)
        assert proxy["status"] == "proxy"
        assert proxy["sovereign_spread_bps"] == pytest.approx(423.0)

    def test_missing_input_is_unavailable(self):
        assert atlas.sovereign_spread_proxy(None, 4.47)["status"] == "UNAVAILABLE"


class TestHeatScore:
    def test_mean_of_available_only(self):
        assert atlas.heat_score({"a": 1.0, "b": None, "c": 0.0}) == pytest.approx(0.5)

    def test_all_none_is_none(self):
        assert atlas.heat_score({"a": None}) is None


class TestRegionRollup:
    def test_region_mean_and_plain_floats(self):
        heats = {"DE": 0.65, "FR": 0.51, "US": 0.08}
        regions = {"DE": "europe", "FR": "europe", "US": "americas"}
        rolls = atlas.region_rollup(heats, regions)
        assert rolls["europe"] == pytest.approx(0.58)
        assert all(isinstance(v, float) for v in rolls.values())


class TestAssembleCountry:
    def test_full_bundle(self):
        node = atlas.assemble_country("Germany", "DE", "europe", {
            "yield_pct": 2.97, "yields": {1: -7.7, 3: -30.0}, "yield_z": 0.4,
            "bond_1m_pct": 0.65, "etf_1m_pct": 1.0, "us_yield_pct": 4.47})
        inst = node["instruments"]
        assert inst["bonds"]["yield_pct"] == 2.97
        assert inst["yield_spreads"]["vs_us_10y_bps"] == pytest.approx(-150.0)
        assert node["heat"] == pytest.approx(0.825)
        assert inst["cds"]["status"] == "proxy"

    def test_missing_bundle_stays_honest(self):
        node = atlas.assemble_country("X", "XX", "other", {"us_yield_pct": None})
        assert node["instruments"]["bonds"]["status"] == "UNAVAILABLE"
        assert node["instruments"]["cds"]["status"] == "UNAVAILABLE"
        assert node["heat"] is None


class TestYieldTableDisplayRegression:
    """The EUR '300%+' bug: bps-valued columns used to print as percent."""

    def test_bps_shown_as_percent(self):
        t1, _ = _format_yield_rows({"EUR_HY_OAS": 350.0}, 5)
        assert t1[0][1] == "3.500%"

    def test_carry_correct_units(self):
        _, t2 = _format_yield_rows({"EUR_HY_OAS": 350.0}, 5)
        assert t2[0][3] == "0.0479%"
        assert t2[0][4] == "4.79 bps"

    def test_nan_renders_na(self):
        t1, _ = _format_yield_rows({"BROKEN": float("nan")}, 5)
        assert t1[0][1] == "n/a"


class TestAtlasJsonContract:
    def test_portal_contract_shape(self):
        if not os.path.exists("data/atlas.json"):
            pytest.skip("data/atlas.json not present (run `python cli.py --market atlas`)")
        with open("data/atlas.json") as f:
            doc = json.load(f)
        assert "countries" in doc and "regions" in doc
        assert "US" in doc["countries"]
        us = doc["countries"]["US"]["instruments"]
        for sec in ("bonds", "bond_curve", "cds", "futures", "options", "equity_etf"):
            assert sec in us
        # spec legs: index-futures basis present in the futures section
        futures = us.get("futures") or {}
        assert any("basis_ann" in v for v in futures.values() if isinstance(v, dict))
        if "EZ" in doc["countries"]:
            ez_bonds = doc["countries"]["EZ"]["instruments"].get("bonds") or {}
            assert "curve" in ez_bonds  # full ECB AAA term structure
        assert isinstance(doc["regions"], dict)
        assert all(isinstance(v, float) for v in doc["regions"].values())


# ---------------------------------------------------------------------------
# Multi-asset heatmap spec legs (spec §3 formulas on real data).
# ---------------------------------------------------------------------------

class TestStraddleYieldAnn:
    def test_spec_formula(self):
        # P=3.00, S=100, DTE=30 -> (3/100)*sqrt(365/30) = 0.03*3.4876
        y = atlas.straddle_yield_ann(3.0, 100.0, 30.0)
        assert y == pytest.approx(0.03 * (365 / 30) ** 0.5, abs=1e-4)

    def test_longer_dte_smaller_yield(self):
        assert atlas.straddle_yield_ann(3.0, 100.0, 60.0) < atlas.straddle_yield_ann(3.0, 100.0, 30.0)

    def test_missing_inputs_are_none(self):
        assert atlas.straddle_yield_ann(None, 100.0, 30.0) is None
        assert atlas.straddle_yield_ann(3.0, 0.0, 30.0) is None
        assert atlas.straddle_yield_ann(3.0, 100.0, 0.0) is None


class TestFuturesBasisAnn:
    def test_spec_formula(self):
        # F=101, S=100, DTE=30 -> (1/100)*(365/30) = 0.1217 annualized
        b = atlas.futures_basis_ann(101.0, 100.0, 30.0)
        assert b == pytest.approx((1.0 / 100.0) * (365.0 / 30.0), abs=1e-4)

    def test_negative_basis_when_future_below_spot(self):
        assert atlas.futures_basis_ann(99.0, 100.0, 30.0) < 0

    def test_missing_inputs_are_none(self):
        assert atlas.futures_basis_ann(None, 100.0, 30.0) is None
        assert atlas.futures_basis_ann(101.0, 100.0, None) is None


class TestRealYield:
    def test_nominal_minus_breakeven(self):
        assert atlas.real_yield(4.47, 2.25) == pytest.approx(2.22)

    def test_no_inflation_fabrication(self):
        assert atlas.real_yield(4.47, None) is None


class TestTermSpreadBps:
    def test_bps_math(self):
        assert atlas.term_spread_bps(3.8, 2.9) == pytest.approx(90.0)

    def test_inverted_curve(self):
        assert atlas.term_spread_bps(2.5, 4.0) == pytest.approx(-150.0)


class TestThirdFridayRule:
    def test_2026_august_third_friday(self):
        # Aug 2026: 1st is Sat, first Friday = 7th, third = 21st (CME rule)
        assert futures_layer.third_friday(2026, 8) == pd.Timestamp("2026-08-21")

    def test_dte_before_expiry(self):
        assert futures_layer.days_to_third_friday(pd.Timestamp("2026-08-10")) == 11

    def test_rolls_to_next_month_after_expiry(self):
        # 28th of August 2026 -> next third Friday is Sep 18 2026
        assert futures_layer.days_to_third_friday(pd.Timestamp("2026-08-28")) == 21

    def test_year_boundary_rolls(self):
        assert futures_layer.days_to_third_friday(pd.Timestamp("2026-12-31")) > 0


class TestIndexFuturesBasis:
    def _series(self, value, idx):
        return pd.Series([value], index=pd.DatetimeIndex([idx]))

    def test_live_shaped_basis(self):
        fut = self._series(7786.5, "2026-08-10")
        spot = self._series(7757.64, "2026-08-10")
        out = futures_layer.index_futures_basis(fut, spot, pd.Timestamp("2026-08-10"))
        assert out["status"] == "ok"
        assert out["dte_days"] == 11
        assert out["basis_ann"] == pytest.approx((7786.5 - 7757.64) / 7757.64 * (365 / 11), abs=1e-3)

    def test_missing_spot_is_unavailable(self):
        out = futures_layer.index_futures_basis(self._series(1.0, "2026-08-10"), None)
        assert out["status"] == "UNAVAILABLE"


# ---------------------------------------------------------------------------
# Portal serializers (heatmap spec §6 GeoJSON + §4 DB rows).
# ---------------------------------------------------------------------------

def _mini_doc():
    node_us = {
        "name": "United States", "region": "americas", "heat": 0.5,
        "instruments": {
            "bonds": {"yield_pct": 4.47, "yield_chg_bps": {1: -10.0},
                      "curve": {"2y_pct": 4.1, "10y_pct": 4.47}},
            "cds": {"sovereign_spread_bps": 0.0},
            "yield_spreads": {"vs_us_10y_bps": 0.0},
            "equity_etf": {"rv_30d": 0.15},
            "futures": {"ES=F/^GSPC": {"basis_ann": 0.12}},
            "options": {"HYG": {"atm_iv_last": 0.05, "vrp": 0.03, "straddle_yield_ann": 0.6}},
        },
    }
    return {"generated": "2026-08-10", "countries": {"US": node_us}}


class TestGeoJsonBuilder:
    def test_feature_shape_and_properties(self):
        fc = atlas.geojson_feature_collection(_mini_doc(), {"US": [-98.5, 39.8]})
        assert fc["type"] == "FeatureCollection"
        f = fc["features"][0]
        assert f["properties"]["country_code"] == "US"
        assert f["properties"]["heatmap_score"] == 0.5
        assert f["geometry"]["coordinates"] == [-98.5, 39.8]

    def test_missing_latlon_falls_back_without_crashing(self):
        fc = atlas.geojson_feature_collection(_mini_doc(), {})
        assert fc["features"][0]["geometry"]["coordinates"] == [0.0, 0.0]

    def test_non_dict_country_skipped(self):
        doc = {"countries": {"US": "not-a-node"}}
        assert atlas.geojson_feature_collection(doc, {})["features"] == []


class TestCountryMetricRows:
    def test_fields_map_to_spec_columns(self):
        rows = atlas.country_metric_rows(_mini_doc())
        assert len(rows) == 1
        r = rows[0]
        assert r["country_code"] == "US"
        assert r["yield_2y"] == 4.1 and r["yield_10y"] == 4.47
        assert r["index_futures_basis_ann"] == 0.12
        assert r["implied_vol_30d"] == 0.05
        assert r["realized_vol_30d"] == 0.15
        assert r["straddle_yield_ann"] == 0.6
        assert r["composite_heatmap_score"] == 0.5

    def test_missing_legs_stay_none(self):
        doc = {"generated": "2026-08-10", "countries": {"US": {"instruments": {}, "heat": None}}}
        r = atlas.country_metric_rows(doc)[0]
        assert r["yield_2y"] is None and r["straddle_yield_ann"] is None
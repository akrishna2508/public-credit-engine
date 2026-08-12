"""Tests for engine.forecast - pure logic, no network."""
import numpy as np
import pandas as pd

from engine import forecast


def test_build_dataframe_orders_by_hierarchy():
    data = {
        "BBB - A": {"2020-01-02": 5.0, "2020-01-03": 5.1},
        "AA - AAA": {"2020-01-02": 1.0, "2020-01-03": 1.1},
        "ZZ - YY": {"2020-01-02": 9.0},
    }
    df = forecast.build_dataframe(data)
    assert list(df.columns) == ["AA - AAA", "BBB - A"]  # hierarchy order, junk dropped
    assert len(df) == 2


def test_draw_dataframe_empty_on_none():
    assert forecast.build_dataframe({}).empty


def test_ensure_stationarity_diffs_nonstationary():
    # A random-walk series is non-stationary -> should be differenced.
    idx = pd.bdate_range("2020-01-01", periods=30)
    rng = np.random.RandomState(7)  # deterministic test RNG
    s = pd.Series(np.cumsum(rng.normal(0, 1, 30)), index=idx)
    df = pd.DataFrame({"X": s})
    stat_df, was_diff = forecast.ensure_stationarity(df)
    assert was_diff["X"] is True
    assert not stat_df.empty


def test_granger_results_for_single_series():
    assert forecast.run_granger_causality(pd.DataFrame({"X": [1, 2, 3]}), 1) == {}
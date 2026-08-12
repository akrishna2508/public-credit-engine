"""Tests for engine.spreads - pure logic, no network."""
import pytest

from engine import spreads

SAMPLE = {
    "AAA": {"2020-01-02": "4.20", "2020-01-03": "4.30"},
    "BBB": {"2020-01-02": "5.00", "2020-01-03": "5.10"},
}


def test_get_adjacent_pairs():
    assert spreads.get_adjacent_pairs(["AAA", "AA", "A"]) == [("AAA", "AA"), ("AA", "A")]


def test_compute_spreads_pct_basic():
    out = spreads.compute_spreads_pct({"AAA": {"2020-01-02": 4.2, "2020-01-03": 4.3},
                                       "AA": {"2020-01-02": 4.6, "2020-01-03": 4.7}})
    assert "AA - AAA" in out
    assert pytest.approx(out["AA - AAA"]["2020-01-02"]) == 0.4


def test_compute_spreads_requires_common_dates():
    out = spreads.compute_spreads_pct({"AAA": {"2020-01-02": 1.0}, "A": {"2020-01-03": 1.0}})
    assert out == {}


def test_convert_to_bps():
    out = spreads.convert_to_bps({"X": {"2020-01-02": 0.0312}})
    assert out["X"]["2020-01-02"] == 3.12


def test_merge_timeseries_dict_merges_and_sorts(tmp_path):
    f = tmp_path / "a.json"
    f.write_text('{"BBB": {"2020-01-03": 1.0}}')
    merged = spreads.merge_timeseries_dict(f, {"BBB": {"2020-01-02": 2.0}, "AA": {"2020-01-02": 3.0}})
    assert list(merged["BBB"].keys()) == ["2020-01-02", "2020-01-03"]
    assert merged["BBB"]["2020-01-02"] == 2.0
    assert merged["AA"] == {"2020-01-02": 3.0}


def test_prepare_pristine_data_converts_to_bps(tmp_path):
    f = tmp_path / "raw.json"
    f.write_text('{"AAA": {"2020-01-02": "4.2"}, "BBB": {"2020-01-02": "5.0"}, "AA": {"2020-01-02": "4.5"}}')
    df_raw, df_spreads = spreads.prepare_pristine_data(str(f))
    assert float(df_raw.loc["2020-01-02", "AAA"]) == 420.0
    assert "AA - AAA" in df_spreads.columns
    assert float(df_spreads.loc["2020-01-02", "AA - AAA"]) == 450.0 - 420.0
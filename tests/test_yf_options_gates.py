"""Unit tests: yf_options real-quote gates + ATM straddle accrual.

Regressions for the 2026-08-10 yfinance IV-degradation event: the feed served
whole chains at ~1e-5 IV (and degraded TLT/JNK at 0.016/0.004). Guards:
  * ATM IV at/below config.IV_MIN_REAL is rejected (SourceUnavailable) so a
    bad quote never overwrites the day's real snapshot;
  * expiries with <= 1 day to expiry are skipped (degenerate same-day chains);
  * a real chain accrues the ATM straddle price + DTE (heatmap spec §3.3).
"""
from __future__ import annotations

import pandas as pd
import pytest

import config
from sources import yf_options
from sources.registry import SourceUnavailable

TODAY = pd.Timestamp.today().normalize()


def _chain(calls_rows, puts_rows=None):
    calls = pd.DataFrame(calls_rows)
    puts = pd.DataFrame(puts_rows) if puts_rows is not None else pd.DataFrame()
    return type("Chain", (), {"calls": calls, "puts": puts})()


def _market_rows(prefix, strikes, iv=0.12, lasts=None, bidask=(1.0, 1.1)):
    rows = []
    for i, k in enumerate(strikes):
        rows.append({
            "strike": k,
            "impliedVolatility": iv,
            "openInterest": 100 + i,
            "lastPrice": lasts[i] if lasts else 1.0,
            "bid": bidask[0], "ask": bidask[1],
        })
    return {prefix: rows}


class FakeTicker:
    def __init__(self, options, chain_map, close=100.0):
        self._options = options
        self._chains = chain_map
        self._close = close

    @property
    def options(self):
        return self._options

    def history(self, **kwargs):
        idx = pd.date_range(end=TODAY, periods=5, freq="D")
        return pd.DataFrame({"Close": self._close}, index=idx)

    def option_chain(self, expiry):
        return self._chains[expiry]


@pytest.fixture(autouse=True)
def _fake_yf(monkeypatch):
    monkeypatch.setattr(yf_options.yf, "Ticker", FakeTicker)


class TestStubIvGate:
    def test_sub_floor_atm_iv_rejected_keeps_history(self):
        exp = str((TODAY + pd.Timedelta(days=30)).date())
        calls = _market_rows("c", [95.0, 100.0, 105.0], iv=1e-5)
        puts = _market_rows("p", [95.0, 100.0, 105.0], iv=1e-5)
        yf_options.yf.Ticker = lambda t: FakeTicker(
            [exp], {exp: _chain(calls["c"], puts["p"])}, close=100.0)
        with pytest.raises(SourceUnavailable) as ei:
            yf_options.snapshot_ticker("XXX")
        assert "real-quote floor" in str(ei.value)

    def test_real_atm_iv_passes_floor(self):
        exp = str((TODAY + pd.Timedelta(days=30)).date())
        calls = _market_rows("c", [95.0, 100.0, 105.0], iv=0.12)
        puts = _market_rows("p", [95.0, 100.0, 105.0], iv=0.12)
        yf_options.yf.Ticker = lambda t: FakeTicker(
            [exp], {exp: _chain(calls["c"], puts["p"])}, close=100.0)
        snap = yf_options.snapshot_ticker("XXX")
        assert snap["atm_iv"] == 0.12
        assert snap["dte_days"] == 30


class TestSameDayExpirySkipped:
    def test_walk_prefers_longer_dated_expiry(self):
        near = str(TODAY.date())          # today, dte=0 -> must be skipped
        far = str((TODAY + pd.Timedelta(days=40)).date())
        near_calls = _market_rows("c", [98.0, 100.0, 102.0], iv=0.12,
                                  lasts=[2.0, 1.6, 1.2])
        far_calls = _market_rows("c", [98.0, 100.0, 102.0], iv=0.11)
        yf_options.yf.Ticker = lambda t: FakeTicker(
            [near, far],
            {near: _chain(near_calls["c"]), far: _chain(far_calls["c"])},
            close=100.0)
        snap = yf_options.snapshot_ticker("XXX")
        assert snap["expiry"] == far
        assert snap["atm_iv"] == 0.11


class TestStraddleAccrual:
    def test_straddle_price_and_dte_in_snapshot(self):
        exp = str((TODAY + pd.Timedelta(days=30)).date())
        calls = _market_rows("c", [95.0, 100.0, 105.0], iv=0.12,
                             lasts=[2.0, 1.5, 1.0])
        puts = _market_rows("p", [95.0, 100.0, 105.0], iv=0.12,
                            lasts=[2.2, 1.7, 1.2])
        yf_options.yf.Ticker = lambda t: FakeTicker(
            [exp], {exp: _chain(calls["c"], puts["p"])}, close=100.0)
        snap = yf_options.snapshot_ticker("XXX")
        assert snap["atm_straddle_price"] == pytest.approx(1.5 + 1.7)
        assert snap["dte_days"] == 30

    def test_missing_atm_put_means_no_straddle(self):
        exp = str((TODAY + pd.Timedelta(days=30)).date())
        calls = _market_rows("c", [95.0, 100.0, 105.0], iv=0.12)
        puts = _market_rows("p", [95.0, 99.0], iv=0.12)  # no 100 strike put
        yf_options.yf.Ticker = lambda t: FakeTicker(
            [exp], {exp: _chain(calls["c"], puts["p"])}, close=100.0)
        snap = yf_options.snapshot_ticker("XXX")
        assert snap["atm_straddle_price"] is None

    def test_consecutive_floor_snapshots_are_skipped_not_accrued(self, tmp_path, monkeypatch):
        """The accrual overwrites same-date rows: a stub arriving after a real
        snapshot must NOT clobber it (the gate raises before accrue is called)."""
        exp = str((TODAY + pd.Timedelta(days=30)).date())
        calls = _market_rows("c", [100.0], iv=0.12, lasts=[1.5])
        puts = _market_rows("p", [100.0], iv=0.12, lasts=[1.6])
        monkeypatch.setattr(config, "IV_HISTORY_FILE", tmp_path / "iv.json")
        yf_options.yf.Ticker = lambda t: FakeTicker(
            [exp], {exp: _chain(calls["c"], puts["p"])}, close=100.0)
        real = yf_options.snapshot_ticker("XXX")
        yf_options.accrue_snapshot("XXX", real["as_of"], real)

        calls_bad = _market_rows("c", [100.0], iv=1e-5, lasts=[1.5])
        puts_bad = _market_rows("p", [100.0], iv=1e-5, lasts=[1.6])
        yf_options.yf.Ticker = lambda t: FakeTicker(
            [exp], {exp: _chain(calls_bad["c"], puts_bad["p"])}, close=100.0)
        with pytest.raises(SourceUnavailable):
            yf_options.snapshot_ticker("XXX")

        import json
        hist = json.loads((tmp_path / "iv.json").read_text())
        assert hist["XXX"][real["as_of"]]["atm_iv"] == 0.12  # untouchable
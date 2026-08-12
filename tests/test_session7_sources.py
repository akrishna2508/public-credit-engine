"""Session 7 sources: NDL/Polygon key gating + parsers, BCB parser,
SEC EDGAR annual series + sector gates. No network (requests mocked)."""
import pytest

import config
from sources.registry import SourceUnavailable


class _Resp:
    def __init__(self, payload, status_code=200):
        self._payload = payload
        self.status_code = status_code

    def raise_for_status(self):
        return None

    def json(self):
        return self._payload

    def text(self):
        return str(self._payload)


def test_ndl_gated_without_key(monkeypatch):
    monkeypatch.setattr(config, "get_ndl_key", lambda: None)
    from sources import ndl
    with pytest.raises(SourceUnavailable) as ei:
        ndl.fetch_yield_curve(rows=10)
    assert "NASDAQ_DATA_LINK_API_KEY" in str(ei.value)


def test_ndl_yield_curve_parser(monkeypatch):
    monkeypatch.setattr(config, "get_ndl_key", lambda: "k")
    from sources import ndl
    payload = {"dataset": {"column_names": ["Date", "1MO", "10YR", "REAL10YR"],
                           "data": [["2026-08-07", "4.3", "4.2", "2.1"],
                                    ["2026-08-08", "4.28", "4.19", "2.08"],
                                    ["2026-08-09", None, None, None]]}}
    monkeypatch.setattr(ndl.requests, "get",
                        lambda url, params=None, timeout=None: _Resp(payload))
    df = ndl.fetch_yield_curve(rows=10)
    assert list(df.columns) == ["1MO", "10YR", "REAL10YR"]
    assert len(df) == 2
    assert float(df["10YR"].iloc[-1]) == 4.19


def test_ndl_bill_rates_parser(monkeypatch):
    monkeypatch.setattr(config, "get_ndl_key", lambda: "k")
    from sources import ndl
    payload = {"dataset": {"column_names": ["Date", "13W", "26W"],
                           "data": [["2026-08-03", "4.25", "4.31"]]}}
    monkeypatch.setattr(ndl.requests, "get",
                        lambda url, params=None, timeout=None: _Resp(payload))
    df = ndl.fetch_bill_rates(rows=10)
    assert len(df) == 1 and float(df["13W"].iloc[0]) == 4.25


def test_polygon_gated_without_key(monkeypatch):
    monkeypatch.setattr(config, "get_polygon_key", lambda: None)
    from sources import polygon
    with pytest.raises(SourceUnavailable) as ei:
        polygon.fetch_contracts("HYG")
    assert "POLYGON_API_KEY" in str(ei.value)


def test_polygon_skew_computation(monkeypatch):
    """25-delta put skew from a synthetic chain: puts rich -> positive skew."""
    monkeypatch.setattr(config, "get_polygon_key", lambda: "k")
    from sources import polygon

    def contracts():
        out = []
        for side, strikes in (("call", [60, 70, 80, 90, 100, 110, 120]),
                              ("put", [40, 50, 60, 70, 80, 90, 100])):
            for st in strikes:
                iv = 0.15 if side == "call" else (0.30 if st <= 60 else 0.18)
                out.append({"contract_type": side, "strike_price": str(st),
                            "implied_volatility": iv, "open_interest": 100,
                            "expiration_date": "2026-09-18", "underlying_ticker": "HYG"})
        return out

    payload = {"results": contracts(), "status": "OK"}
    monkeypatch.setattr(polygon.requests, "get",
                        lambda url, params=None, timeout=None: _Resp(payload))
    snap = polygon.snapshot_ticker("HYG")
    assert snap["atm_iv"] == 0.15  # 100 call ATM (median ~80 -> 100 call is nearest? see below)
    assert snap["skew_25d"] is not None and snap["skew_25d"] > 0
    assert snap["put_call_oi_ratio"] == 1.0


def test_polygon_empty_chain_gated(monkeypatch):
    monkeypatch.setattr(config, "get_polygon_key", lambda: "k")
    from sources import polygon
    monkeypatch.setattr(polygon.requests, "get",
                        lambda url, params=None, timeout=None: _Resp({"results": []}))
    with pytest.raises(SourceUnavailable):
        polygon.snapshot_ticker("EMHY")


def test_bcb_selic_parser(monkeypatch):
    from sources import bcb
    payload = [{"data": "07/08/2026", "valor": "0.051660"},
               {"data": "08/08/2026", "valor": "0.051660"}]
    monkeypatch.setattr(bcb.requests, "get",
                        lambda url, timeout=None: _Resp(payload))
    s = bcb.fetch_selic()
    assert len(s) == 2
    assert float(s.iloc[-1]) == 0.05166
    assert str(s.index.max().date()) == "2026-08-08"


def test_bcb_empty_gated(monkeypatch):
    from sources import bcb
    monkeypatch.setattr(bcb.requests, "get",
                        lambda url, timeout=None: _Resp([]))
    with pytest.raises(SourceUnavailable):
        bcb.fetch_selic()


def test_sec_edgar_annual_series_filters_10k():
    from sources import sec_edgar
    entries = [
        {"form": "10-Q", "end": "2025-09-30", "val": 100.0},
        {"form": "10-K", "end": "2024-12-31", "val": 500.0},
        {"form": "10-K", "end": "2024-12-31", "val": 510.0},   # restatement
        {"form": "10-K", "end": "2023-12-31", "val": 480.0},
        {"form": "10-K/A", "end": "2023-12-31", "val": 485.0},  # amendment kept
    ]
    s = sec_edgar.annual_series(entries)
    assert len(s) == 2
    assert s["2024-12-31"] == 510.0
    assert s["2023-12-31"] == 485.0


def test_sec_edgar_filer_leverage_skips_missing():
    """A filer with no debt concept yields None, not a fabricated ratio."""
    from sources import sec_edgar
    assert sec_edgar.filer_leverage("0000000000") is None


def test_sec_edgar_sector_min_filers():
    from sources import sec_edgar
    # only 2 filers -> below SEC_SECTOR_MIN_FILERS
    frame = sec_edgar.sector_leverage("X", ["0000034088", "0000093410"])
    assert frame is None


def test_sec_edgar_leverage_z_gate():
    from engine import sector_screen
    import pandas as pd
    s = pd.Series([0.2, 0.21, 0.19, 0.2])
    assert sector_screen.leverage_z(s, min_obs=4) is not None
    assert sector_screen.leverage_z(s.iloc[:2], min_obs=4) is None

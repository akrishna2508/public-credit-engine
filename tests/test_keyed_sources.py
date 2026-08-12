"""Keyed free-tier sources: gating without keys, auth construction with keys.

No network: requests are mocked. Without a key the source must raise
SourceUnavailable with a signup instruction; with keys the request must
carry the documented credential (FIP OAuth2 token for FINRA -> Bearer,
APCA headers for Alpaca).
"""
import base64

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


def test_finra_gated_without_credentials(monkeypatch):
    monkeypatch.setattr(config, "get_finra_credentials", lambda: None)
    from sources import finra
    with pytest.raises(SourceUnavailable) as ei:
        finra.fetch_breadth()
    assert "FINRA_API_CLIENT_ID" in str(ei.value)


def test_finra_token_flow_with_mocked_requests(monkeypatch):
    """Token POST (Basic) -> Bearer GET on the real dataset path."""
    monkeypatch.setattr(config, "get_finra_credentials", lambda: ("mycid", "mysecret"))
    from sources import finra

    captured = {}
    token = "abc123"

    def fake_post(url, params=None, headers=None, timeout=None):
        captured["token_url"] = url
        captured["token_headers"] = headers
        expected = base64.b64encode(b"mycid:mysecret").decode()
        assert headers["Authorization"] == f"Basic {expected}"
        assert params == {"grant_type": "client_credentials"}
        return _Resp({"access_token": token})

    def fake_get(url, params=None, headers=None, timeout=None):
        captured["url"] = url
        captured["headers"] = headers
        assert headers["Authorization"] == f"Bearer {token}"
        return _Resp({"data": [{"tradeReportDate": "2026-08-07", "totalVolume": 1.0}]})

    monkeypatch.setattr(finra.requests, "post", fake_post)
    monkeypatch.setattr(finra.requests, "get", fake_get)
    df = finra.fetch_breadth()
    assert len(df) == 1
    group, dataset = config.FINRA_PUBLIC_DATASETS["breadth"]
    assert captured["url"] == f"{config.FINRA_BASE}/data/group/{group}/name/{dataset}"
    assert captured["token_url"] == config.FINRA_TOKEN_URL


def test_finra_token_failure_gates(monkeypatch):
    monkeypatch.setattr(config, "get_finra_credentials", lambda: ("cid", "sec"))
    from sources import finra

    def fake_post(url, params=None, headers=None, timeout=None):
        return _Resp({"error": "invalid_client"}, status_code=400)

    monkeypatch.setattr(finra.requests, "post", fake_post)
    with pytest.raises(SourceUnavailable) as ei:
        finra.fetch_breadth()
    assert "token endpoint" in str(ei.value)


def test_finra_unknown_dataset_gated():
    from sources import finra
    with pytest.raises(SourceUnavailable):
        finra.fetch_dataset("not_a_dataset")


def test_alpaca_gated_without_keys(monkeypatch):
    monkeypatch.setattr(config, "get_alpaca_keys", lambda: None)
    from sources import optional
    with pytest.raises(SourceUnavailable) as ei:
        optional.fetch_alpaca_quote()
    assert "ALPACA_API_KEY" in str(ei.value)


def test_alpaca_request_headers(monkeypatch):
    monkeypatch.setattr(config, "get_alpaca_keys", lambda: ("pubkey", "privkey"))
    from sources import optional

    captured = {}

    def fake_get(url, params=None, headers=None, timeout=None):
        captured["params"] = params
        captured["headers"] = headers
        return _Resp({"trades": {}})

    monkeypatch.setattr(optional.requests, "get", fake_get)
    optional.fetch_alpaca_quote()
    assert captured["headers"]["APCA-API-KEY-ID"] == "pubkey"
    assert captured["headers"]["APCA-API-SECRET-KEY"] == "privkey"
    assert captured["params"]["symbols"] == "SGOV"


def test_probe_reports_keyed_sources_unavailable_without_keys(monkeypatch):
    monkeypatch.setattr(config, "get_finra_credentials", lambda: None)
    monkeypatch.setattr(config, "get_alpaca_keys", lambda: None)
    from sources import probe
    for name, loader in probe.loaders():
        if name.startswith(("finra", "optional.alpaca")):
            st = probe._probe(name, loader)
            assert st.available is False, f"{name} should be gated without keys"
            assert "not set" in st.detail or "not set" in (st.detail or "")


def test_ecb_url_split_flow_from_key():
    """The data-api needs the flow as a path component (data/YC/B.U2...)."""
    from sources import ecb
    url = ecb.sdmx_url("YC.B.U2.EUR.4F.G_N_A.SV_C_YM.SR_10Y")
    assert url == ("https://data-api.ecb.europa.eu/service/data/"
                   "YC/B.U2.EUR.4F.G_N_A.SV_C_YM.SR_10Y")


def test_ecb_bad_key_gated():
    from sources import ecb
    with pytest.raises(SourceUnavailable):
        ecb.sdmx_url("NOT_A_KEY")


def test_parse_ecb_csvdata():
    """csvdata -> daily Series: row filtering by key, dtype, sort, dedupe."""
    from sources.registry import SourceUnavailable, parse_ecb_csvdata
    csv = ("KEY,FREQ,TIME_PERIOD,OBS_VALUE\n"
           "YC.B.U2.EUR.4F.G_N_A.SV_C_YM.SR_10Y,B,2026-08-05,3.02\n"
           "YC.B.U2.EUR.4F.G_N_A.SV_C_YM.SR_10Y,B,2026-08-06,3.04\n"
           "YC.B.U2.EUR.4F.G_N_A.SV_C_YM.SR_10Y,B,2026-08-06,3.03\n"
           "OTHER.KEY,B,2026-08-06,9.99\n")
    s = parse_ecb_csvdata(csv, "YC.B.U2.EUR.4F.G_N_A.SV_C_YM.SR_10Y")
    assert len(s) == 2  # duplicate date deduped, foreign key dropped
    assert s.iloc[0] == 3.02 and s.iloc[1] == 3.03
    with pytest.raises(SourceUnavailable):
        parse_ecb_csvdata("KEY,TIME_PERIOD,OBS_VALUE\n", "x")


def test_parse_ecb_csvdata_schema_change_gates():
    from sources.registry import SourceUnavailable, parse_ecb_csvdata
    with pytest.raises(SourceUnavailable) as ei:
        parse_ecb_csvdata("KEY,WHATEVER\nA,1\n", "A")
    assert "csvdata schema changed" in str(ei.value)


def _boom(msg):
    import requests
    raise requests.RequestException(msg)


def test_ndl_error_redacts_api_key(monkeypatch):
    """A failed NDL request must never surface the API key in the error."""
    monkeypatch.setattr(config, "get_ndl_key", lambda: "SECRET_NDL_KEY_123")
    from sources import ndl
    monkeypatch.setattr(
        ndl.requests, "get",
        lambda *a, **k: _boom("403 Forbidden for url: https://data.nasdaq.com/"
                              "xxxxx.json?api_key=SECRET_NDL_KEY_123&rows=10"))
    with pytest.raises(SourceUnavailable) as ei:
        ndl.fetch_yield_curve()
    assert "SECRET_NDL_KEY_123" not in str(ei.value)
    assert "***" in str(ei.value)


def test_polygon_error_redacts_api_key(monkeypatch):
    """A failed Polygon request must never surface the API key in the error."""
    monkeypatch.setattr(config, "get_polygon_key", lambda: "SECRET_POLY_KEY_456")
    from sources import polygon
    monkeypatch.setattr(
        polygon.requests, "get",
        lambda *a, **k: _boom("400 Client Error: Bad Request for url: https://"
                              "api.polygon.io/v3/...?apiKey=SECRET_POLY_KEY_456"))
    with pytest.raises(SourceUnavailable) as ei:
        polygon.fetch_contracts("HYG")
    assert "SECRET_POLY_KEY_456" not in str(ei.value)
    assert "***" in str(ei.value)

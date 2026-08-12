"""World Bank Open Data API (keyless, free): sovereign external-debt indicators.

Verified live 2026-08: DT.DOD.DECT.CD, DT.TDS.DECT.CD, DT.DOD.DECT.GN.ZS all
return data. The API returns [meta, rows]; rows carry country/iso3/year/value.
A dataset that returns no data raises UNAVAILABLE — never a placeholder.
"""
from __future__ import annotations

import pandas as pd
import requests

import config
from sources.registry import SourceUnavailable, cache_json


def fetch_indicator(indicator_id: str, years: str = "2010:2026") -> pd.DataFrame:
    """Country-level time series for one indicator: country, iso3, year, value."""
    def _loader() -> list[dict]:
        url = f"{config.WORLD_BANK_BASE}/country/all/indicator/{indicator_id}"
        resp = requests.get(url, params={"format": "json", "per_page": 20000, "date": years}, timeout=60)
        resp.raise_for_status()
        payload = resp.json()
        if not isinstance(payload, list) or len(payload) < 2 or not payload[1]:
            msg = ""
            if isinstance(payload, list) and payload and isinstance(payload[0], dict):
                msg = str(payload[0].get("message"))
            raise SourceUnavailable("world_bank", f"{indicator_id}: {msg or 'no data'}")
        return payload[1]

    raw = cache_json(f"world_bank_{indicator_id}", 7.0, _loader)
    rows = [
        {"country": r["country"]["value"], "iso3": r["country"]["id"],
         "year": int(r["date"]), "value": r["value"]}
        for r in raw
    ]
    df = pd.DataFrame(rows)
    if df.empty:
        raise SourceUnavailable("world_bank", f"{indicator_id}: no rows returned")
    return df


def fetch_debt_snapshot() -> dict[str, pd.DataFrame]:
    """All configured debt indicators as {name: DataFrame}. Failing indicators
    are reported individually and skipped — one 404 never kills the rest."""
    out: dict[str, pd.DataFrame] = {}
    for name, ind in config.WB_DEBT_INDICATORS.items():
        try:
            out[name] = fetch_indicator(ind)
        except SourceUnavailable as e:
            print(f"  [UNAVAILABLE] world_bank.{name}: {e}")
    if not out:
        raise SourceUnavailable("world_bank", "no debt indicators returned data")
    return out


def fetch_credit_gap_proxy() -> pd.DataFrame:
    """Domestic credit to private sector (% of GDP) — the BIS credit-gap leg.

    BIS stats are unreachable from this network (501/404 on all probe URLs),
    so the board's credit-gap leg uses this keyless World Bank indicator
    (verified live 2026-08-10) as a real-data proxy: total credit relative
    to GDP is the same family as the BIS credit-to-GDP gap.
    """
    return fetch_indicator(config.WB_CREDIT_GAP_PROXY, years="2005:2026")

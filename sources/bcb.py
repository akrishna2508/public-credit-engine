"""Banco Central do Brasil SGS (keyless, free): Selic policy rate.

Brazil's 10Y government yield is NOT on FRED (IRLTLT01BRM156N does not
exist — verified 2026-08-10), so Brazil's rates coverage comes from the
BCB public SGS API: the Selic daily series (code 4189, verified live
2026-08-10, value 14.05% p.a. at that date). This gives the board a real
LatAm policy-rate reference without inventing a yield we cannot source.
"""
from __future__ import annotations

import pandas as pd
import requests

import config
from sources.registry import SourceUnavailable


def fetch_selic() -> pd.Series:
    """Daily Selic policy rate in percent p.a. (BCB SGS code 4189)."""
    url = config.BCB_SGS_URL.format(code=config.BCB_SELIC_CODE)
    try:
        resp = requests.get(url, timeout=30)
        resp.raise_for_status()
        rows = resp.json()
    except (requests.RequestException, ValueError) as e:
        raise SourceUnavailable("bcb", f"selic fetch failed: {e}",
                                "BCB SGS is free/keyless (api.bcb.gov.br)") from e
    if not rows:
        raise SourceUnavailable("bcb", "selic returned no rows")
    out = pd.Series(
        [float(r["valor"]) for r in rows],
        index=pd.to_datetime([r["data"] for r in rows], dayfirst=True, errors="coerce"),
        name="selic",
    ).dropna()
    if out.empty:
        raise SourceUnavailable("bcb", "selic returned no parseable rows")
    return out.sort_index().astype(float)
